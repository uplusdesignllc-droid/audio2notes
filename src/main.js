"use strict";
const { app, BrowserWindow, ipcMain, shell, dialog, Notification, powerMonitor } = require("electron");

/* Boot-timing probe. Inert unless A2N_BOOT_LOG=1; required FIRST so that the
 * first mark captures the cost of loading electron itself. See src/bootProbe.js
 * for how to read the output. */
const bootProbe = require("./bootProbe");
bootProbe.mark("main.js entered", "electron required");

const path = require("path");
const fs = require("fs");

const config = require("./config");
const capture = require("./capture");
const liveVad = require("./liveVad");
const transcribe = require("./transcribe");
const summarize = require("./summarize");
const translate = require("./translate");
const meetings = require("./meetings");
const audioArchive = require("./audioArchive");
const diarize = require("./diarize");
const lifecyclePolicy = require("./lifecyclePolicy");
const activityTracker = require("./activityTracker");
const powerMode = require("./powerMode");
const jobQueue = require("./jobQueue");
const meetingDetect = require("./meetingDetect");
const participants = require("./participants");
const models = require("./models");
const llmProviders = require("./llmProviders");
const os = require("os");
bootProbe.mark("module requires done", "config/capture/transcribe/... loaded");

let win = null;
let rec = { system: null, mic: null, levelTimers: [], busy: false, limitFired: false, limitReached: null };
let gate = null;        // the single live participant gate (only one at a time)
let gateTimeoutMs = null;

/* One participant gate at a time. The timeout is re-read from the current
 * settings on every stop, so a changed timeoutMs takes effect WITHOUT a restart
 * — when it changes the gate is rebuilt (pending questions dropped first). */
function getGate(timeoutMs) {
  if (!gate || gateTimeoutMs !== timeoutMs) {
    if (gate) for (const id of gate.pending()) gate.abandon(id);
    gate = participants.createParticipantGate({ timeoutMs });
    gateTimeoutMs = timeoutMs;
  }
  return gate;
}

/* Build the three participants meta fields, or {} when the resolved roster is
 * empty/cancelled — never emit `[]` / null as if it were a real answer. */
function participantFields(names, source, askedAt) {
  if (!Array.isArray(names) || names.length === 0) return {};
  return {
    participants: names,
    participantsSource: source || null,
    participantsAskedAt: askedAt || null,
  };
}

/* Ask for the meeting roster at stop — before the slow mixing/transcription —
 * but ONLY when the user turned "ask on stop" on. The request is parked on
 * `rec` and resolved exactly once by whichever path (live or deferred) follows. */
function maybeRequestParticipants() {
  rec.participantReq = null;
  if (!rec.dir) return;
  let p = {};
  try { p = (config.load() && config.load().participants) || {}; } catch { return; }
  if (!p.askOnStop) return;
  const dir = rec.dir;
  const title = path.basename(dir);
  const g = getGate(p.timeoutMs);
  let req;
  try {
    req = g.request({ dir, title, suggested: [], reason: "stop" });
  } catch (e) {
    console.error("[participants] request failed:", e);
    return;
  }
  rec.participantReq = { id: req.id, dir, title, askedAt: new Date().toISOString() };
  send("participants", { id: req.id, dir, title, prefill: req.prefill, reason: "stop" });
}

/* ---- lifecycle state -----------------------------------------------------
 * `lastActivity` drives the idle auto-quit; `lastLoudAt` drives the
 * "forgot to stop recording" guard. Both are updated by pollLevels() and by
 * the record handlers. Nothing here ever quits while work is in flight. */
const lifecycle = {
  lastActivity: Date.now(),
  lastLoudAt: Date.now(),
  autoStopWarnedAt: null,
  autoStopSuppressed: false,
  idleWarned: false,
  diskWarned: false,
  forceQuit: false,
};

function lifecycleCfg() {
  const l = config.load().lifecycle || {};
  const a = l.autoStop || {};
  return {
    notifyOnDone: l.notifyOnDone !== false,
    autoQuitAfterMin: typeof l.autoQuitAfterMin === "number" ? l.autoQuitAfterMin : 15,
    confirmWhileBusy: l.confirmWhileBusy !== false,
    autoStop: {
      enabled: a.enabled !== false,
      silenceMin: typeof a.silenceMin === "number" ? a.silenceMin : 2,
      forceStopAfterMin: typeof a.forceStopAfterMin === "number" ? a.forceStopAfterMin : 3,
      minFreeDiskGB: typeof a.minFreeDiskGB === "number" ? a.minFreeDiskGB : 2,
      maxElapsedMin: typeof a.maxElapsedMin === "number" ? a.maxElapsedMin : 480,
      levelThreshold: typeof a.levelThreshold === "number" ? a.levelThreshold : 8,
      // named-field whitelist: a new autoStop field MUST be mirrored here or the
      // tracker silently falls back to its own defaults (this bit us before)
      activityWindowSec: typeof a.activityWindowSec === "number" ? a.activityWindowSec : 12,
      activityLoudSec: typeof a.activityLoudSec === "number" ? a.activityLoudSec : 4,
    },
  };
}

/* ---- activity tracker (forgotten-recording guard) ------------------------
 * ONE tracker, re-armed per recording; both tracks feed it, because the guard
 * asks "is this meeting still going", not "which track is talking".
 * The rule itself lives in src/activityTracker.js (pure, unit-tested): >= 4 s of
 * loud samples inside a 12 s window. A single loud 300 ms sample — a notification
 * beep measures 2.0-3.0 s of LEVEL 27-31 — must not reset the silence clock.
 */
let activity = null;      // null until the first recording starts
let activityOpts = null;  // the tunables `activity` was built with

/** Arm the forgotten-recording guard for a NEW recording: a fresh activity window
 *  AND a fresh silence clock, because nothing may leak from the previous
 *  recording. Both leaks are real, not theoretical:
 *   - `lastLoudAt` drives `silentSec = now - lastLoudAt`, so a recording started
 *     6 minutes after the previous one began already past its 5-minute silence
 *     budget and was force-stopped on the first watchdog tick (within 15 s).
 *   - a warning latch left set when the previous recording was stopped by hand
 *     makes the policy announce a bogus "silence-cleared" (warnedAt was truthy,
 *     silentSec back to ~0), which un-hides the banner of a recording that has
 *     only just started. */
function armRecordingGuard() {
  const as = lifecycleCfg().autoStop;
  const opts = {
    windowSec: as.activityWindowSec,
    loudSec: as.activityLoudSec,
    sampleSec: activityTracker.DEFAULT_SAMPLE_SEC, // capture.exe writes a LEVEL line every rate/2 frames
    levelThreshold: as.levelThreshold,
  };
  // Rebuild when the tunables changed (a hand-edited settings.json must take
  // effect on the NEXT recording — reset() alone would keep the old numbers).
  if (!activity || !activityOpts || Object.keys(opts).some((k) => activityOpts[k] !== opts[k])) {
    activity = activityTracker.createActivityTracker(opts);
    activityOpts = opts;
  }
  // reset() regardless: a new recording must never inherit the last one's samples.
  activity.reset();
  lifecycle.lastLoudAt = Date.now();
  lifecycle.autoStopWarnedAt = null;
}

function isRecording() {
  return !!(rec.system || rec.mic);
}
function touchActivity() {
  lifecycle.lastActivity = Date.now();
  lifecycle.idleWarned = false;
}

/** The volume that actually holds the recordings.
 *  This used to be the process cwd's volume, which is a different disk whenever
 *  meetingsDir points elsewhere (e.g. D:) — the guard then watched the wrong
 *  drive and could not stop a recording that was filling up the real one. */
function meetingsVolumeRoot() {
  try {
    const dir = config.meetingsDir(config.load());
    if (typeof dir === "string" && dir) return path.parse(dir).root || "C:\\";
  } catch { /* fall back to cwd below */ }
  return path.parse(process.cwd()).root || "C:\\";
}

function freeDiskGB() {
  try {
    const st = fs.statfsSync(meetingsVolumeRoot());
    return (st.bavail * st.bsize) / 1e9;
  } catch {
    return null;
  }
}

/** Desktop notification; click opens the meeting folder. Never throws.
 *  `opts.silent` mutes the notification's OWN chime. That matters for the silence
 *  warning: the chime plays through the default render endpoint, the loopback
 *  track records it, and the loudness buffer would then reset the very guard the
 *  notification is warning about (a chime measures 2.0-3.0 s of LEVEL 27-31 —
 *  short enough for the activity window to ignore, but there is no reason to feed
 *  the guard its own noise at all). */
function notifyUser(title, body, dir, opts) {
  try {
    const n = new Notification({ title, body, silent: !!(opts && opts.silent) });
    if (dir) n.on("click", () => shell.openPath(dir));
    n.show();
  } catch { /* notifications unavailable in this environment */ }
}

function notifyDone(dir) {
  const lc = lifecycleCfg();
  if (!lc.notifyOnDone) return;
  notifyUser("笔记已生成", `${path.basename(dir)} —— 点此打开会议文件夹`, dir);
}

function createWindow() {
  bootProbe.mark("createWindow entered");
  win = new BrowserWindow({
    width: 980,
    height: 760,
    minWidth: 760,
    minHeight: 560,
    title: "Audio2Notes",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  bootProbe.mark("BrowserWindow constructed", "this is the point the native window exists");

  /* First paint of the renderer. 'ready-to-show' fires when the page is rendered
   * and the window can be shown without a white flash — the closest in-app
   * signal to "the user can see something", which is what the ~10 s report is
   * about. did-finish-load follows the full DOM load. */
  win.once("ready-to-show", () => {
    bootProbe.mark("renderer ready-to-show", "window can be painted");
    bootProbe.flush();
  });
  win.webContents.once("did-finish-load", () => {
    bootProbe.mark("renderer did-finish-load");
    bootProbe.flush();
  });
  win.webContents.once("did-fail-load", (_e, code, desc) => {
    bootProbe.mark("renderer did-fail-load", `code=${code} ${desc}`);
    bootProbe.flush();
  });

  win.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
  bootProbe.mark("loadFile called", "async: returns before the renderer paints");

  // A roster question may be pending when the window closes; abandon it so the
  // in-flight wait() resolves ("cancelled") instead of blocking notes forever.
  // Hooked on THIS window (not app shutdown) so it is tied to the actual UI.
  win.on("closed", () => {
    if (gate) for (const id of gate.pending()) gate.abandon(id);
  });

  /* Closing the window must never silently discard work: before this existed,
   * before-quit() only stopped capture, so closing during a 2-hour meeting's
   * transcription killed the pipeline with no warning. */
  win.on("close", (e) => {
    if (lifecycle.forceQuit) return;
    const lc = lifecycleCfg();
    const recording = isRecording();
    if (!lc.confirmWhileBusy || (!recording && !rec.busy)) return;
    e.preventDefault();
    const buttons = recording
      ? ["取消", "停止录音并处理", "放弃录音并退出"]
      : ["取消", "中断处理并退出"];
    const idx = dialog.showMessageBoxSync(win, {
      type: "warning",
      message: recording ? "正在录音" : "正在处理",
      detail: recording
        ? "直接关闭会停止录音。已录制的音频仍会保存在会议文件夹里。"
        : "关闭会中断当前的转写/摘要。已保存的音频不会丢失，可以之后重新处理。",
      buttons,
      defaultId: 0,
      cancelId: 0,
    });
    if (idx === 0) return;
    if (recording && idx === 1) {
      // let the renderer run the normal "Stop & Process" flow instead of killing it
      send("lifecycle", { type: "stop-request", reason: "window-close" });
      return;
    }
    lifecycle.forceQuit = true;
    app.quit();
  });
  win.on("focus", touchActivity);
}

/** Watchdog: idle auto-quit + forgotten-recording guard + disk guard.
 *  The rules themselves live in src/lifecyclePolicy.js (pure, unit-tested);
 *  this function only gathers state and performs the decided actions. */
function startLifecycleWatchdog() {
  setInterval(() => {
    const lc = lifecycleCfg();
    const recording = isRecording();
    const now = Date.now();

    const { actions, next } = lifecyclePolicy.evaluate(
      {
        recording,
        busy: !!rec.busy,
        lastActivity: lifecycle.lastActivity,
        lastLoudAt: lifecycle.lastLoudAt,
        warnedAt: lifecycle.autoStopWarnedAt,
        idleWarned: lifecycle.idleWarned,
        diskWarned: lifecycle.diskWarned,
        suppressed: lifecycle.autoStopSuppressed,
        diskFreeGB: recording ? freeDiskGB() : null,
        recStartMs: recording ? rec.startTime : null,
      },
      lc,
      now
    );

    lifecycle.lastActivity = next.lastActivity;
    lifecycle.autoStopWarnedAt = next.warnedAt;
    lifecycle.idleWarned = next.idleWarned;
    lifecycle.diskWarned = next.diskWarned;

    if (process.env.A2N_DEBUG_LIFECYCLE) {
      console.log(
        `[lifecycle] recording=${recording} busy=${rec.busy} idleMin=${((now - lifecycle.lastActivity) / 60000).toFixed(2)} ` +
          `silentSec=${Math.round((now - lifecycle.lastLoudAt) / 1000)} actions=${actions.map((a) => a.type + (a.reason ? ":" + a.reason : "")).join(",") || "none"}`
      );
    }

    for (const a of actions) {
      if (a.type === "warn-disk") {
        notifyUser("磁盘空间不足", `剩余 ${a.freeGB.toFixed(1)} GB，已自动停止录音以免写满磁盘。`);
        send("lifecycle", { type: "disk-low", freeGB: a.freeGB, limitGB: a.limitGB });
      } else if (a.type === "warn-silence") {
        if (a.first) {
          // silent: the chime would be recorded by the loopback track and reset
          // the silence clock this warning is about
          notifyUser("录音似乎已经结束", `已 ${Math.round(a.silentSec / 60)} 分钟没有声音，${lc.autoStop.forceStopAfterMin} 分钟后将自动停止并处理。`, null, { silent: true });
        }
        send("lifecycle", { type: "silence-warning", silentSec: a.silentSec, forceInSec: a.forceInSec });
      } else if (a.type === "silence-cleared") {
        /* The renderer's banner is never hidden on this transition (its
         * 「继续录音」 button is the only way to cancel a pending auto-stop) — this
         * only tells it to swap the frozen countdown for the "monitoring again"
         * text. Emitted by the policy on a real warn -> clear transition only. */
        send("lifecycle", { type: "silence-cleared" });
      } else if (a.type === "warn-idle") {
        notifyUser("Audio2Notes 即将自动退出", `空闲 ${a.threshold} 分钟后自动退出（可在设置里关闭）。现在仍可继续使用。`);
      } else if (a.type === "stop") {
        if (a.reason === "max-duration") {
          // Hard ceiling, enforced directly here (the watchdog already has the
          // full context — and the user cannot negotiate away a time fuse), and
          // leaving a non-silent trace on the artifacts
          rec.stopReason = "max-duration";
          notifyUser("录音已到达时长上限",
            `已录音 ${a.elapsedMin} 分钟，达到最大录音时长，正在自动停止并完成处理…`, rec.dir || null);
          stopRecordingAndProcess().catch((e) => {
            console.error("[duration] auto-stop failed:", (e && e.message) || e);
            rec.busy = false;
          });
        } else {
          send("lifecycle", { type: "auto-stop-request", reason: a.reason, silentSec: a.silentSec });
        }
      } else if (a.type === "quit") {
        lifecycle.forceQuit = true;
        app.quit();
        return;
      }
    }
  }, 15000);
}

/* ---- power modes + deferred-transcription queue -------------------------
 * Capability probe + profile resolution live in src/powerMode.js (pure and
 * unit-tested). This section only gathers the FACTS and serves the queue. */

function enginesProbe() {
  let ortVersion = null;
  let directml = false;
  try { ortVersion = require("onnxruntime-node/package.json").version; } catch { /* not installed */ }
  if (ortVersion) {
    const [maj, min] = ortVersion.split(".").map((x) => parseInt(x, 10));
    const dll = path.join(__dirname, "..", "node_modules", "onnxruntime-node", "bin", "napi-v3", "win32", "x64", "DirectML.dll");
    directml = (maj > 1 || (maj === 1 && min >= 20)) && fs.existsSync(dll);
  }
  let cuda = false;
  try {
    const bin = path.join(__dirname, "..", "node_modules", "onnxruntime-node", "bin", "napi-v3", "win32", "x64");
    cuda = fs.existsSync(path.join(bin, "onnxruntime_providers_cuda.dll"));
  } catch { /* ignore */ }
  return { directml, cuda, ortVersion, igpu: null, dgpu: null, npu: null };
}

/** GPU adapters as Chrome sees them (vendorId is enough to name the vendor). */
async function gpuAdapters() {
  const VENDORS = { "0x8086": "Intel", "0x10de": "NVIDIA", "0x1002": "AMD", "0x1022": "AMD", "0x5143": "Qualcomm" };
  try {
    const info = await app.getGPUInfo("basic");
    const devs = (info && info.gpuDevice) || [];
    return devs.map((d) => {
      const v = VENDORS[String(d.vendorId).toLowerCase()] || String(d.vendorId);
      return { vendor: v, deviceId: d.deviceId, name: `${v} GPU (${d.deviceId})` };
    });
  } catch {
    return [];
  }
}

let cachedEngines = null;
async function engines() {
  if (cachedEngines) return cachedEngines;
  const base = enginesProbe();
  const adapters = await gpuAdapters();
  const igpu = (adapters.find((a) => a.vendor === "Intel") || {}).name || null;
  const dgpu = (adapters.find((a) => a.vendor === "NVIDIA" || a.vendor === "AMD") || {}).name || null;
  cachedEngines = { ...base, igpu, dgpu, adapters, npu: false };
  return cachedEngines;
}

function isOnBattery() {
  try { return powerMonitor.isOnBatteryPower(); } catch { return false; }
}

async function currentProfile() {
  const cfg = config.load();
  const p = cfg.power || {};
  return powerMode.resolveProfile({
    mode: p.mode,
    batteryPreference: p.batteryPreference,
    maxThreads: p.maxThreads || 0,
    maxModel: p.maxModel || "",
    onBattery: isOnBattery(),
    engines: await engines(),
    model: cfg.whisper.model,
    cores: (os.cpus() || []).length || 8,
  });
}

function queueFile() {
  return path.join(app.getPath("userData"), "queue.json");
}
function readQueue() {
  const r = jobQueue.load(queueFile());
  if (r.error) console.error("[queue] " + r.error);
  return r.queue;
}
function writeQueue(q) {
  return jobQueue.save(queueFile(), q);
}

/** Transcribe + summarize a meeting directory that was parked earlier. */
async function processQueuedDir(job) {
  const cfg = config.load();
  const profile = await currentProfile();
  const dir = job.dir;
  const pick = (names) => names.map((n) => path.join(dir, n)).find((p) => fs.existsSync(p) && fs.statSync(p).size > 4096);

  // Keep the SAME two-track pipeline the recorder uses: transcribing system and
  // mic separately (then merging with echo de-duplication) is what produces the
  // 你 / 远端 speaker split. Mixing them down first would silently lose it.
  const systemAudio = pick(["system.opus", "system.wav"]);
  const micAudio = pick(["mic.opus", "mic.wav"]);
  const hasTwoTracks = !!(systemAudio && micAudio);

  send("pipeline", { phase: "transcribing", message: `转写排队的会议（${profile.model.replace("Xenova/whisper-", "")}）…`, progress: 0 });
  models.assertReady({ cacheDir: config.modelCacheDir(cfg), model: profile.model, autoDownload: cfg.whisper.autoDownload });

  let chunks;
  let text;
  let audioStats = null;
  if (hasTwoTracks) {
    const t = await transcribeSources({ system: systemAudio, mic: micAudio }, cfg, (p) => {
      if (p && p.status === "progress" && typeof p.progress === "number") {
        send("pipeline", { phase: "transcribing", progress: p.progress, message: "转写中…" });
      }
    });
    chunks = t.chunks;
    text = t.text;
    audioStats = t.audioStats || null;
  } else {
    let audioPath = pick(["mixed.opus", "mixed.wav"]);
    if (!audioPath) {
      const only = systemAudio || micAudio;
      if (!only) throw new Error("找不到音频文件");
      audioPath = path.join(dir, "mixed.wav");
      await meetings.mixToTranscription(systemAudio ? { system: only } : { mic: only }, audioPath);
    }
    const t = await transcribe.transcribeFile({
      wavFile: audioPath,
      model: profile.model,
      cacheDir: config.modelCacheDir(cfg),
      endpoint: cfg.whisper.endpoint || "https://huggingface.co/",
      tempDir: path.dirname(audioPath),
    });
    chunks = (t.chunks || []).map((c) => ({ ...c, speaker: "unknown", speakerName: "说话人" }));
    text = t.text || meetings.transcriptText(chunks);
    audioStats = audioStatsOf(t.audio);
  }

  const transcript = { chunks, text, durationSec: job.durationSec || 0, audioStats };
  send("transcript", transcript);
  const translated = await translateTranscript(transcript, cfg);
  const notes = await summarize.summarize(transcript.text, cfg, (p) =>
    send("pipeline", { phase: "summarizing", message: p.message, progress: p.progress })
  );
  await translateNotes(notes, cfg);
  meetings.writeArtifacts(dir, {
    transcript,
    notes,
    meta: {
      createdAt: new Date().toISOString(),
      durationSec: job.durationSec || 0,
      queued: true,
      queuedAt: job.createdAt,
      whisperModel: profile.model,
      audioStats,
      notesProvider: notes.provider,
      notesFallbackReason: notes.fallbackReason || null,
      notesMapReduce: !!notes.mapReduce,
      notesWarnings: notes.warnings || [],
      detailLevel: cfg.notes.detailLevel || "standard",
      translated,
      // why the transcript is not in Chinese (null when it was translated):
      // "transcript-disabled" | "translation-disabled" | "already-chinese"
      translationSkipped: translated ? null : transcript.translationSkipped || null,
      translationEngine: translated ? cfg.translation.engine : null,
      powerMode: profile.effective,
      engine: profile.engine.id,
      // the same provenance the live pipeline records: capture.exe's READY format
      // and T0 anchor per track, carried through the queue instead of dropped
      capture: job.captureInfo || null,
      // roster resolved at stop rode the queued job; {} (absent) when empty
      ...participantFields(job.participants, job.participantsSource, job.participantsAskedAt),
    },
  });
  let archive = null;
  try { archive = await archiveMeeting(dir, cfg); } catch (e) { console.error("archive failed:", e); }
  return { dir, notes: notes.text, notesZh: notes.zh || null, transcript: transcript.text, chunks, provider: notes.provider, archive };
}

let queueRunning = false;
async function runQueue(reason) {
  if (queueRunning) return { error: "busy" };
  const profile = await currentProfile();
  if (!profile.runNow && reason === "auto") return { skipped: "当前模式下不自动转写", profile };

  queueRunning = true;
  /* A long backfill must count as "busy" for the whole run: otherwise the
   * lifecycle watchdog sees an idle app and quits ~15 minutes in, killing the
   * transcription mid-flight (found by actually queueing a 155-minute meeting).
   * It also makes record:start / file:transcribe refuse to run concurrently. */
  rec.busy = true;
  touchActivity();
  const results = [];
  try {
    for (;;) {
      const q = readQueue();
      const job = jobQueue.nextJob(q, 3);
      if (!job) break;
      touchActivity();
      send("queue", { type: "start", dir: job.dir, remaining: jobQueue.size(q) });
      try {
        const r = await processQueuedDir(job);
        writeQueue(jobQueue.remove(readQueue(), job.dir));
        results.push({ dir: job.dir, ok: true });
        notifyUser("排队会议已转写完成", path.basename(job.dir), job.dir);
        send("queue", { type: "done", dir: job.dir, result: r });
      } catch (e) {
        writeQueue(jobQueue.markAttempt(readQueue(), job.dir, e.message));
        results.push({ dir: job.dir, ok: false, error: e.message });
        send("queue", { type: "error", dir: job.dir, error: e.message });
      }
    }
  } finally {
    queueRunning = false;
    rec.busy = false;
    touchActivity();
    send("queue", { type: "idle", queue: readQueue().jobs });
  }
  return { ok: true, results, queue: readQueue().jobs };
}

/** Park a finished recording instead of transcribing it now (defer mode). */
async function enqueueMeeting(dir, sources, durationSec, cfg, captureInfo,
  participants, participantsSource, participantsAskedAt) {
  let archive = null;
  try { archive = await archiveMeeting(dir, cfg); } catch (e) { console.error("archive failed:", e); }
  // keep the audio we will need later; the wavs are gone after archiving
  // A roster only means something with names: gate all three fields on a
  // non-empty list so a timeout/cancel never leaves a dangling source in the job.
  const roster = Array.isArray(participants) && participants.length ? participants : null;
  const q = jobQueue.add(readQueue(), {
    dir,
    reason: "defer",
    sources: Object.keys(sources || {}),
    durationSec,
    captureInfo: captureInfo || null,
    participants: roster,
    participantsSource: roster ? participantsSource : null,
    participantsAskedAt: roster ? participantsAskedAt : null,
  });
  writeQueue(q);
  send("queue", { type: "added", queue: q.jobs });
  return { queued: true, dir, queue: q.jobs, archive };
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

/* ---- audio archiving (16 kHz mono Opus by default) ----------------------
 * Never throws: a failure to compress must not fail the meeting. The original
 * WAV is only removed by audioArchive once the replacement verifies. */
async function archiveMeeting(dir, cfg) {
  const opts = (cfg.audio && cfg.audio.archive) || {};
  if (!opts.enabled) return null;
  const preset = audioArchive.resolvePreset(opts);
  send("pipeline", { phase: "archiving", message: `压缩音频（${preset.label}）…` });
  const r = await audioArchive.archiveDir(dir, opts, (p) => {
    send("pipeline", {
      phase: "archiving",
      message: `压缩 ${p.file}（${p.index}/${p.total}）…`,
      progress: Math.round((p.index / p.total) * 100),
    });
  });
  const fmt = audioArchive.outputFormat(preset);
  const info = {
    presetId: preset.id,
    codec: preset.codec,
    bitrateKbps: preset.bitrateKbps,
    sampleRate: fmt.sampleRate,
    channels: fmt.channels,
    keepWav: !!opts.keepWav,
    files: r.files,
    savedBytes: r.savedBytes,
    errors: r.errors,
    archivedAt: new Date().toISOString(),
    // provenance: which encoder build produced the output (null when the
    // probe cannot run)
    ffmpeg: await audioArchive.ffmpegVersion(),
  };
  try {
    const metaPath = path.join(dir, "meta.json");
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    meta.audio = info;
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf8");
  } catch { /* meta is optional */ }
  return info;
}

/**
 * Pure scan: does this capture --status text contain a file-size "fuse" line?
 * capture.exe writes `LIMIT bytes=<n> limit=<n>` (both plain decimal integers)
 * into the status file immediately before the usual FINISHED line when a
 * recording WAV is about to exceed its byte limit. Returns { bytes, limit } or
 * null. Kept pure so the detection logic is trivially unit-testable.
 */
function scanLimitLine(text) {
  const m = (text || "").match(/^LIMIT\s+bytes=(\d+)\s+limit=(\d+)/m);
  if (!m) return null;
  return { bytes: +m[1], limit: +m[2] };
}

/* ---- level polling (reads --status files; sandbox-safe) ------------------
 * Each track gets its own 300 ms timer, but the writer emits a LEVEL line only
 * every ~0.5 s, so a poll sees 0, 1 or several NEW lines. `r.levelSeen` counts
 * the LEVEL lines already fed to the tracker, so a line is observed exactly once;
 * the new ones go in as ONE batch with capture-time timestamps (pushBatch),
 * keeping the duty cycle in capture time instead of poll time.
 *
 * WHY CAPTURE TIME AND NOT Date.now() (measured 2026-09-15, BACKLOG §11.3):
 * stamping with the poll clock gives every track the wall-clock time of its OWN
 * poll, and the two tracks' 300 ms timers run out of phase, so one sound arriving
 * on both tracks landed at two timestamps up to ~300 ms apart — the same instant
 * then looked like two different instants to the tracker, which is what let a
 * chime heard on both tracks count twice. The writer already publishes its exact
 * timebase: `T0 qpc=<n> freq=<n> unixms=<n>` is emitted once, right after Start,
 * and LEVEL line i is written i * rate/2 frames after that anchor (0.5 s at the
 * rates in use). So sample i happened at `t0.unixms + i * 500` ms — a timebase the
 * codebase already trusts for cross-track alignment to well under a millisecond
 * (tools/audit-meetings.js check 5 compares the two T0 anchors directly). Both
 * tracks then place one sound at (nearly) the same timestamp.
 *
 * Fallback: T0 is emitted after READY, so a poll that arrives before the anchor
 * is on disk (or a status file that was rewritten without one) must not DROP
 * samples — it stamps them from the last known capture time, and only the very
 * first such poll falls back to the poll clock. */
function pollLevels() {
  for (const key of ["system", "mic"]) {
    const r = rec[key];
    if (!r) continue;
    r.levelSeen = 0; // per recording: the status file starts empty
    /* Capture-time bookkeeping, per recording (rec[key] is rebuilt by
     * record:start): t0Ms is the writer's unix-ms anchor, levelMs the newest
     * capture timestamp handed to the tracker so far. */
    r.t0Ms = null;
    r.levelMs = null;
    const timer = setInterval(() => {
      let level = null;
      let fresh = null;
      try {
        const text = fs.readFileSync(r.statusFile, "utf8");
        const lines = text.split(/\r?\n/).filter(Boolean);
        const last = lines[lines.length - 1];
        const m = last && last.match(/^LEVEL\s+(\d+)/);
        if (m) level = Math.max(0, Math.min(100, +m[1]));
        // Count LEVEL lines instead of trusting the poll clock: a poll may see
        // several, or (after a stall/sleep) a whole backlog.
        let count = 0;
        for (const ln of lines) if (ln.startsWith("LEVEL ")) count++;
        /* Parse the T0 anchor once, while no LEVEL line has been fed yet. It is
         * written before every LEVEL line, so a file that already has lines on
         * the very first poll still carries it. */
        if (count > 0 && r.levelSeen === 0 && r.t0Ms === null) {
          const t0 = parseCaptureStatus(text).t0;
          if (t0) {
            const ms = Number(t0.unixms);
            if (Number.isFinite(ms) && ms > 0) r.t0Ms = ms;
          }
        }
        if (count > r.levelSeen) {
          fresh = [];
          for (let i = lines.length - 1; i >= 0 && fresh.length < count - r.levelSeen; i--) {
            const lm = lines[i].match(/^LEVEL\s+(\d+)/);
            if (lm) fresh.push(Math.max(0, Math.min(100, +lm[1])));
          }
          fresh.reverse(); // chronological: oldest first, newest last
          /* Stamp the batch in CAPTURE time: LEVEL line `count - 1` (the newest
           * one in the file) is written (count - 1) * 0.5 s after the anchor —
           * pushBatch walks the rest of the batch backwards from there. With no
           * anchor (first poll before T0 is on disk, or a rewritten file) the
           * newest stamp stays the poll clock, exactly as it always was: a
           * missing anchor must degrade the timestamps, never drop samples. */
          r.levelMs = r.t0Ms === null ? Date.now() : r.t0Ms + (count - 1) * 500;
          r.levelSeen = count;
        } else if (count < r.levelSeen) {
          r.levelSeen = count; // status file rewritten/truncated: resync, never stall
        }
        // FINISHED is written AFTER the fuse line, so a "last line == LEVEL"
        // check would miss it — scan the whole file for a LIMIT line instead.
        // rec.limitFired makes this fire exactly once per recording; it resets
        // on the next record:start. rec.busy re-entrancy is enforced inside
        // stopRecordingAndProcess(), so no second stop path can race this one.
        if (!rec.limitFired) {
          const lim = scanLimitLine(text);
          if (lim) {
            rec.limitFired = true;
            rec.limitReached = { track: key, bytes: lim.bytes, limit: lim.limit };
            notifyUser("录音文件已达大小上限",
              `${r.kind} 轨道录音已到达文件大小上限，正在自动停止并完成转写…`, rec.dir || null);
            // Fire-and-forget from a timer: stopRecordingAndProcess() sets
            // rec.busy = true before its own try block, so an early throw would
            // leak busy=true — and record:start rejects while busy, which would
            // block every later recording until the app restarts. Catch it here.
            stopRecordingAndProcess().catch((e) => {
              console.error("[limit] auto-stop failed:", (e && e.message) || e);
              rec.busy = false;
            });
          }
        }
      } catch { /* not ready yet */ }
      // The meter must still see EVERY sample, not only the ones that count as
      // activity — send() is unconditional by design.
      if (level != null) send("level", { source: r.kind, level });
      if (fresh && fresh.length && activity) activity.pushBatch(fresh, r.levelMs !== null ? r.levelMs : Date.now());

      /* The forgotten-recording guard asks "is this meeting still going", not
       * "was this one sample loud": a 2.5 s notification beep (peaks 27-31) must
       * not reset it when real speech runs 12.5-119.5 s (peaks 36-82). Only a
       * tracker verdict refreshes lastLoudAt, so the existing
       * `silentSec = now - lastLoudAt` arithmetic in the watchdog is unchanged.
       * autoStopWarnedAt is deliberately NOT cleared here: the policy has to see
       * the warning -> clear transition to emit "silence-cleared" (defect A). */
      if (activity && activity.isActive(Date.now())) {
        lifecycle.lastLoudAt = Date.now();
        if (lifecycle.autoStopSuppressed) lifecycle.autoStopSuppressed = false;
      }
    }, 300);
    rec.levelTimers.push(timer);
  }
}

function stopPolling() {
  for (const t of rec.levelTimers) clearInterval(t);
  rec.levelTimers = [];
}

/* ---- shadow VAD (EXPERIMENT: measurement only, decides nothing) -----------
 * The loudness meter behind the "is this meeting still going" guard cannot tell a
 * Windows notification chime from speech. This block runs a real VAD
 * (src/liveVad.js, silero via the sherpa-onnx-node dependency that is already
 * installed) alongside the level meter and writes ONE JSON per meeting to
 * <userData>/vad-shadow/, so the live result can be compared against the offline
 * experiment in .scratch/vad/ on real recordings.
 *
 * INERT BY CONSTRUCTION, and a reviewer should be able to check every claim:
 *  - it never writes lifecycle.lastLoudAt, never affects rec.busy / the watchdog
 *    / the silence guard / the size fuse / the disk guard / the pipeline;
 *  - it sends no IPC ("level", "pipeline") and never calls notifyUser();
 *  - it writes nothing into the meeting directory (the meeting dir must stay
 *    free of experiment artifacts);
 *  - every failure is swallowed: bad model, unreadable WAV, native throw — the
 *    shadow disables itself and logs, at most once per recording;
 *  - there is no config key anywhere that turns it into enforcement.
 * Cost is bounded and small: ~2.5 ms of VAD CPU per second of audio (measured
 * offline: 24913 blocks / 797 s in 1996 ms) and 32 KB/s read per track. */
function startVadShadow(dir) {
  const cfg = config.load();
  const info = liveVad.modelInfo((cfg.vad && cfg.vad.modelPath) || liveVad.defaultModelPath());
  if (!info.ok) {
    // Inert, silently. A hash mismatch is a WARNING rather than a log line
    // because it means the on-disk model is not the one the offline numbers were
    // measured with, and nothing about this recording can then be trusted.
    if (info.exists) console.warn(`[vad-shadow] inert: ${info.reason} (${info.path})`);
    else console.log(`[vad-shadow] inert: ${info.reason} (${info.path})`);
    // Clear the shadow state explicitly: `rec` is rebuilt by object spread on
    // every record:start, so an earlier recording's tracks would otherwise ride
    // along and could be reported a second time at the next stop.
    rec.vadTimers = [];
    rec.vadTracks = null;
    rec.vadStartedAt = null;
    rec.vadModel = null;
    rec.vadMeetingDir = null;
    return false;
  }
  const vcfg = cfg.vad || {};
  const tracks = {};
  const timers = [];
  for (const key of ["system", "mic"]) {
    const r = rec[key];
    if (!r) continue;
    const vad = liveVad.createTrackVad({
      modelPath: info.path,
      sampleRate: 16000,
      threshold: vcfg.threshold,
      minSilenceDuration: vcfg.minSilenceDuration,
      minSpeechDuration: vcfg.minSpeechDuration,
      windowSize: vcfg.windowSize,
    });
    const st = { vad, reader: liveVad.createWavTailReader({ wavFile: r.wavFile }), wavFile: r.wavFile, timer: null };
    /* 1 s poll, the same shape as pollLevels(). The poll interval does NOT set
     * the analysis granularity — feedS16() slices whatever it is given into
     * whole 512-sample blocks and calls isDetected() after each one, so the poll
     * only bounds how far behind the audio clock the VAD can be (at most one
     * second), never what it decides. */
    st.timer = setInterval(() => {
      if (st.vad.isFailed()) {
        // Failed => permanently inert for THIS recording (liveVad logs the
        // reason once). The timer is dropped rather than left ticking.
        if (st.timer) clearInterval(st.timer);
        st.timer = null;
        return;
      }
      const buf = st.reader.readNew(); // empty Buffer when nothing was appended
      if (buf.length) st.vad.feedS16(buf);
    }, 1000);
    tracks[key] = st;
    timers.push(st.timer);
  }
  rec.vadTimers = timers;
  rec.vadTracks = tracks;
  rec.vadStartedAt = Date.now();
  rec.vadModel = info;
  // The report's provenance comes from the dir handed in by record:start, not from
  // rec.dir, so a later change to rec cannot mislabel the file.
  rec.vadMeetingDir = dir || rec.dir || null;
  return true;
}

/**
 * Stop the shadow VAD and write its report. Called from the same place the
 * capture processes have already exited, so the WAV data areas are final.
 * Never throws: a broken shadow must not be able to break a stop.
 */
function stopVadShadow() {
  const tracks = rec.vadTracks || {};
  for (const t of rec.vadTimers || []) clearInterval(t);
  rec.vadTimers = [];
  rec.vadTracks = null;
  const keys = Object.keys(tracks);
  if (!keys.length) return null;
  const startedAt = rec.vadStartedAt || Date.now();
  const info = rec.vadModel || { path: null, sha256: null, bytes: 0, ok: false };
  const meetingDir = rec.vadMeetingDir || rec.dir || null;
  rec.vadModel = null;
  rec.vadStartedAt = null;
  rec.vadMeetingDir = null;
  const now = Date.now();
  const doc = {
    version: 1,
    mode: "shadow",         // measurement, not enforcement
    enforcement: false,
    /* Provenance: which recording, which model (path + SHA-256), which exact VAD
     * config produced these numbers. Without all three the numbers are not
     * comparable to the offline reference in .scratch/vad/. */
    meeting: meetingDir ? path.basename(meetingDir) : null,
    meetingDir,
    startedAt: new Date(startedAt).toISOString(),
    stoppedAt: new Date(now).toISOString(),
    shadowElapsedSec: Math.round((now - startedAt) / 100) / 10,
    pollIntervalMs: 1000,
    bufferSizeInSeconds: liveVad.BUFFER_SECONDS,
    model: {
      path: info.path, sha256: info.sha256, expectedSha256: liveVad.MODEL_SHA256,
      bytes: info.bytes, ok: info.ok,
    },
    vadConfig: tracks[keys[0]].vad.config,
    tracks: {},
  };
  for (const key of keys) {
    const st = tracks[key];
    try {
      // Drain whatever the last poll did not see (the writer's final flush).
      const buf = st.reader.readNew();
      if (buf.length) st.vad.feedS16(buf);
    } catch (e) { console.warn(`[vad-shadow] final read failed (${key}):`, (e && e.message) || e); }
    st.vad.close(); // pads the trailing partial block and closes an open run
    const s = st.vad.stats();
    /* The VAD was configured for 16 kHz mono s16 and dataOffset 44 WITHOUT
     * inspecting the audio (both tracks are documented as READY fmt=16000:1:16).
     * Record what the file actually is, so a wrong assumption shows up in the
     * report instead of quietly scaling every interval. The stream is already over
     * by this point, so this only annotates — it cannot change the measurement. */
    const fmt = liveVad.readWavFormat(st.wavFile);
    const formatOk = !!fmt && fmt.sampleRate === 16000 && fmt.channels === 1 && fmt.bits === 16 && fmt.dataOffset === 44;
    if (!formatOk) {
      console.warn(`[vad-shadow] ${key}: audio format is not the assumed 16000:1:16 @44 — ${JSON.stringify(fmt)}`);
    }
    doc.tracks[key] = {
      intervals: s.intervals,
      totalSpeechSec: s.totalSpeechSec,
      audioSec: s.audioSec,
      speechFraction: s.speechFraction,
      blocksFed: s.blocksFed,
      samplesFed: s.samplesFed,
      bytesFed: s.bytesFed,
      droppedIntervals: s.droppedIntervals,
      errors: s.errors,
      failed: s.failed,
      wav: st.wavFile,
      reader: st.reader.stats(),
      wavFormat: fmt,             // { sampleRate, channels, bits, audioFormat, dataOffset, size }
      formatMatchesAssumption: formatOk,
    };
  }
  try {
    const dir = path.join(app.getPath("userData"), "vad-shadow");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${doc.meeting || "recording"}.json`);
    fs.writeFileSync(file, JSON.stringify(doc, null, 2), "utf8");
    console.log(`[vad-shadow] wrote ${file}`);
    return file;
  } catch (e) {
    console.warn("[vad-shadow] report not written:", (e && e.message) || e);
    return null;
  }
}

/* ---- transcription of the captured sources ------------------------------- */

/**
 * Fold the per-track long-silence numbers reported by transcribe.transcribeFile
 * into one record-shaped object. NO SILENT DEGRADATION: whatever audio was cut
 * must be visible in the meeting record, not only in a console line.
 */
function audioStatsOf(...tracks) {
  const list = (tracks || []).filter((a) => a && typeof a === "object" && a.track);
  if (!list.length) return null;
  const sum = (k) => Math.round(list.reduce((s, a) => s + (Number(a[k]) || 0), 0) * 10) / 10;
  return {
    totalSec: sum("totalSec"),
    silentSec: sum("silentSec"),
    silenceSkippedSec: sum("silenceSkippedSec"),
    speechKeptSec: sum("speechKeptSec"),
    segments: list.reduce((s, a) => s + (Number(a.segments) || 0), 0),
    cutRuns: list.reduce((s, a) => s + (Number(a.cutRuns) || 0), 0),
    tracks: list,
  };
}

async function transcribeSources(sources, cfg, onProgress) {
  const model = cfg.whisper.model;
  const cacheDir = config.modelCacheDir(cfg);
  const endpoint = cfg.whisper.endpoint || "https://huggingface.co/";
  // honour the "auto download" switch instead of fetching anyway
  models.assertReady({ cacheDir, model, autoDownload: cfg.whisper.autoDownload });
  let mic = null, sys = null;
  if (sources.mic) {
    send("pipeline", { phase: "transcribing", message: "Transcribing microphone track…" });
    // tempDir: retry the decode beside the meeting audio if the system temp dir is
    // refused (see transcribe.transcribeFile — a bare `ffmpeg exit -13` there used to
    // kill the pipeline after mixing had already succeeded).
    mic = await transcribe.transcribeFile({ wavFile: sources.mic, model, cacheDir, onProgress, endpoint, tempDir: path.dirname(sources.mic) });
  }
  if (sources.system) {
    send("pipeline", { phase: "transcribing", message: "Transcribing system-audio track…" });
    sys = await transcribe.transcribeFile({ wavFile: sources.system, model, cacheDir, onProgress, endpoint, tempDir: path.dirname(sources.system) });
  }
  const chunks = meetings.mergeTracks(mic && mic.chunks, sys && sys.chunks);
  if (!chunks.length) {
    const any = mic || sys;
    for (const c of (any && any.chunks) || []) {
      chunks.push({ text: c.text, start: c.start, end: c.end, speaker: "unknown", speakerName: "说话人" });
    }
  }
  /* Long-silence skipping is reported per track and folded into the record, so
   * the meeting folder states exactly how much audio never reached the model. */
  const audioStats = audioStatsOf(mic && mic.audio, sys && sys.audio);
  if (audioStats && audioStats.silenceSkippedSec > 0) {
    send("pipeline", {
      phase: "transcribing",
      message: `跳过长静音 ${audioStats.silenceSkippedSec}s（${audioStats.cutRuns} 段），送入模型 ${audioStats.speechKeptSec}s / 共 ${audioStats.totalSec}s`,
    });
  }
  return { chunks, text: meetings.transcriptText(chunks), audioStats };
}

/* ---- translation helper -------------------------------------------------- */

async function translateTranscript(transcript, cfg) {
  /* Transcript translation needs BOTH flags. It defaults OFF because it is the
   * dominant cost of the pipeline: on a real 155-minute meeting, translating the
   * 2663 segments measured ~93 minutes (28.7 segments/min, ~90k output tokens at
   * 16.5 tok/s) versus ~44 minutes to transcribe 18 664 s of audio and ~4 minutes
   * to translate the notes. Generation-throughput bound, so batching harder does
   * not help. When it is skipped the reason is recorded on the transcript (which
   * the callers copy into meta.json) and announced — never silently dropped. */
  const skip = translate.transcriptSkipReason(cfg, transcript);
  if (skip) {
    transcript.translationSkipped = skip;
    if (skip === "transcript-disabled") {
      send("pipeline", {
        phase: "translating",
        message: "跳过转写稿翻译：保留原文以节省时间（155 分钟的会议约需 90 分钟）。如需中文转写稿，请在「设置 → 翻译」勾选「翻译整篇转写稿」后重新处理。",
      });
    }
    return false;
  }
  send("pipeline", { phase: "translating", message: "Translating transcript to Chinese…" });
  await translate.translateChunks(transcript.chunks, cfg, (p) => {
    send("pipeline", {
      phase: "translating",
      progress: Math.round((p.done / p.total) * 100),
      message: `Translating ${p.done}/${p.total} segments…`,
    });
  });
  transcript.zh = meetings.transcriptZhText(transcript.chunks);
  return true;
}

async function translateNotes(notes, cfg) {
  if (!cfg.translation.enabled || translate.looksChinese(notes.text)) return;
  try {
    notes.zh = await translate.translateText(notes.text, cfg);
  } catch (e) {
    console.warn("notes translation failed:", e.message);
  }
}

/* ---- IPC ---------------------------------------------------------------- */
ipcMain.handle("config:get", () => {
  const c = config.load();
  const err = config.loadError();
  return err ? { ...c, configError: err } : c;
});
ipcMain.handle("config:set", (_e, partial) => {
  const cfg = config.load();
  const merged = Object.assign(cfg, JSON.parse(JSON.stringify(partial)));
  config.save(merged);
  return merged;
});

ipcMain.handle("devices:list", async () => {
  try {
    return await capture.listDevices();
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle("record:start", async (_e, opts = {}) => {
  if (rec.system || rec.mic || rec.busy) return { error: "already recording" };
  const cfg = config.load();
  const root = config.meetingsDir(cfg);
  const dir = meetings.newMeetingDir(root);
  const want = { system: opts.system !== false, mic: opts.mic !== false };

  const procs = {};
  try {
    if (want.system) {
      procs.system = capture.startCapture("system", path.join(dir, "system.wav"), path.join(dir, "system.status"));
    }
    if (want.mic) {
      procs.mic = capture.startCapture("mic", path.join(dir, "mic.wav"), path.join(dir, "mic.status"));
    }
  } catch (e) {
    for (const r of Object.values(procs)) capture.stopCapture(r);
    return { error: e.message };
  }
  rec = { ...rec, ...procs, dir, startTime: Date.now(), limitFired: false, limitReached: null, stopReason: null, captureInfo: null };
  armRecordingGuard(); // fresh activity window + fresh silence clock: nothing leaks from the previous recording
  pollLevels();
  // Shadow VAD, started the same way pollLevels() is: per track, torn down on
  // stop. It observes only — its result never reaches `rec`, the guard or the UI.
  startVadShadow(dir);
  return { ok: true, dir };
});

/**
 * Parse the capture process's `--status` text into provenance metadata:
 * the format triple from `READY fmt=<rate>:<ch>:<bits>` and the
 * `T0 qpc=<n> freq=<n> unixms=<n>` reference timestamp. Missing pieces are
 * null, never invented. NOTE: qpc/freq/unixms are kept as STRINGS — they can
 * be large integers, and strings guarantee no float rounding in JSON.
 */
function parseCaptureStatus(text) {
  const info = { format: null, t0: null };
  if (typeof text !== "string") return info;
  const rm = text.match(/READY fmt=(\d+):(\d+):(\d+)/);
  if (rm) info.format = `${rm[1]}:${rm[2]}:${rm[3]}`;
  const tm = text.match(/T0 qpc=(\d+) freq=(\d+) unixms=(\d+)/);
  if (tm) info.t0 = { qpc: tm[1], freq: tm[2], unixms: tm[3] };
  return info;
}

async function stopRecordingAndProcess() {
  if (!rec.system && !rec.mic) return { error: "not recording" };
  if (rec.busy) return { error: "already processing" };
  rec.busy = true;
  stopPolling();
  const sources = {};
  let durationSec = 0;
  /* Signal both tracks at the same instant — a sequential shutdown lets the
   * second track keep recording for the first track's whole exit (up to the
   * 4 s kill), which skews the tail and corrupts cross-track alignment. */
  for (const key of ["system", "mic"]) {
    const r = rec[key];
    if (r) capture.requestStop(r);
  }
  for (const key of ["system", "mic"]) {
    const r = rec[key];
    if (r) await capture.stopCapture(r);
  }
  /* Only after every process has exited are the --status files final, so the
   * dur= reads happen here. durationSec is still the max across tracks. */
  const captureInfo = {};
  for (const key of ["system", "mic"]) {
    const r = rec[key];
    if (!r) continue;
    if (fs.existsSync(r.wavFile) && fs.statSync(r.wavFile).size > 44) sources[key] = r.wavFile;
    try {
      const text = fs.readFileSync(r.statusFile, "utf8");
      const m = text.match(/dur=([\d.]+)/);
      if (m) durationSec = Math.max(durationSec, parseFloat(m[1]));
      captureInfo[key] = parseCaptureStatus(text);
    } catch { /* ignore */ }
  }
  /* Stash the per-track capture provenance on `rec` — the process handles are
   * cleared just below, but `rec.captureInfo` survives for the meta object. */
  rec.captureInfo = captureInfo;
  /* Shadow VAD stops here: both capture processes have exited, so every byte of
   * both WAV data areas is on disk and the final read sees all of it. Placed
   * before the pipeline branches so exactly one report is written per meeting on
   * every stop path (queued, deferred or normal). It cannot throw, and it does
   * not touch `sources`, `durationSec`, `rec.busy` or the pipeline. */
  stopVadShadow();
  // Ask for the roster now, at stop (before mixing/transcription) — gated on
  // askOnStop inside. No-op when the setting is off; nothing leaks into meta.
  maybeRequestParticipants();
  rec.system = null; rec.mic = null;
  const dir = rec.dir;

  /* Power mode decides whether we transcribe now at all. In "defer" mode the
   * recording is only archived + queued, so a battery session never runs Whisper. */
  const profile = await currentProfile().catch(() => null);
  if (profile && !profile.runNow) {
    try {
      // Resolve the roster question BEFORE parking the job, so the answer rides
      // in the job (bounded by the gate timeout) rather than being asked after.
      let partNames = null, partSource = null, partAsked = null;
      if (rec.participantReq) {
        const pr = await gate.wait(rec.participantReq.id);
        partNames = pr.names; partSource = pr.source; partAsked = rec.participantReq.askedAt;
      }
      const q = await enqueueMeeting(dir, sources, durationSec, config.load(), rec.captureInfo || null,
        partNames, partSource, partAsked);
      notifyUser("已排队（续航优先模式）", `${path.basename(dir)} —— 插电后自动转写`, dir);
      rec.busy = false;
      touchActivity();
      send("pipeline", { phase: "done", message: "已排队，插电后自动转写", dir });
      return { ok: true, queued: true, dir, queue: q.queue, archive: q.archive, powerNote: profile.notes, limitReached: rec.limitReached || null, stopReason: rec.stopReason || null };
    } catch (e) {
      rec.busy = false;
      return { error: "排队失败：" + e.message, dir };
    }
  }

  /* Resolve the roster question BEFORE the first heavy step.
   * The modal is still REQUESTED at exactly the same instant (maybeRequestParticipants()
   * just above, right after the recording stopped), but the CPU-heavy work — ffmpeg
   * mix -> Whisper transcription (in THIS process) -> Ollama notes — must not run
   * while the user is typing in it. That overlap was the structural defect: the
   * modal is requested the moment a recording stops, and the pipeline used to
   * saturate every core for the next ~2 minutes, which is why typing lagged and
   * clicks looked like they did nothing (they did register).
   * The wait is kept in ONE place per path: the deferred branch above already
   * awaited before enqueueMeeting (the answer rides inside the queued job and must
   * NOT be awaited again inside the job itself, where no modal is ever shown).
   * Nothing here can hang the pipeline: answer / unchanged / cancel / timeout /
   * abandon (the window was closed) all resolve this same promise. */
  let participantResult = null;
  if (rec.participantReq) {
    send("pipeline", { phase: "participants", message: "等待参会人确认（选择后继续处理）…" });
    participantResult = await gate.wait(rec.participantReq.id);
  }

  send("pipeline", { phase: "mixing", message: "Mixing audio…" });
  try {
    const mixedWav = path.join(dir, "mixed.wav");
    await meetings.mixToTranscription(sources, mixedWav);
    send("pipeline", { phase: "transcribing", message: "Transcribing with local Whisper…" });
    const cfg = config.load();
    // the resolved profile may cap the model (eco/defer) — apply for this run only
    if (profile && profile.model) cfg.whisper.model = profile.model;
    const t0 = Date.now();
    const transcript = await transcribeSources(sources, cfg, (p) => {
      if (p && p.status === "progress" && typeof p.progress === "number") {
        send("pipeline", { phase: "transcribing", progress: p.progress, message: "Loading Whisper model…" });
      }
    });
    transcript.durationSec = durationSec;
    send("pipeline", { phase: "transcribing", progress: 100, message: `Transcribed in ${((Date.now() - t0) / 1000).toFixed(1)}s` });
    send("transcript", transcript);

    const translated = await translateTranscript(transcript, cfg);

    // The roster was already resolved BEFORE the mix (see the single gate.wait()
    // above): participantResult is in hand here, and a second wait() would only
    // see an already-settled gate. Keeping the answer that early also means the
    // notes step never has to wait on the user again.

    send("pipeline", { phase: "summarizing", message: "Writing notes…" });
    const notes = await summarize.summarize(transcript.text, cfg, (p) =>
      send("pipeline", { phase: "summarizing", message: p.message || "Writing notes…", progress: p.progress })
    );
    await translateNotes(notes, cfg);

    // Automatic speaker recognition runs at the END of the pipeline (after
    // writeArtifacts + archive) so the 发言人 panel is populated the moment the
    // notes appear. It NEVER fails the pipeline: a skip or an error is reported to
    // the UI and recorded in meta/return as diarizationError.
    let diarization = null;
    let diarizationSkip = null;

    const meta = {
      createdAt: new Date().toISOString(),
      durationSec,
      sources: Object.keys(sources),
      audioStats: transcript.audioStats || null,
      whisperModel: cfg.whisper.model,
      notesProvider: notes.provider,
      notesFallbackReason: notes.fallbackReason || null,
      notesMapReduce: !!notes.mapReduce,
      notesChunks: notes.chunks || 1,
      notesWarnings: notes.warnings || [],
      detailLevel: cfg.notes.detailLevel || "standard",
      translated,
      // see translate.transcriptSkipReason — a skipped transcript translation is
      // recorded, never silent
      translationSkipped: translated ? null : transcript.translationSkipped || null,
      translationEngine: translated ? cfg.translation.engine : null,
      speakerLabels: ["你", "远端"],
      diarization: diarization ? { speakers: diarization.speakers.length, source: diarization.source, threshold: diarization.threshold } : null,
      capture: rec.captureInfo || null,
      limitReached: rec.limitReached || null,
      stopReason: rec.stopReason || null,
      // roster resolved at stop; {} (absent) when empty — never written as []
      ...participantFields(
        participantResult ? participantResult.names : null,
        participantResult ? participantResult.source : null,
        rec.participantReq ? rec.participantReq.askedAt : null
      ),
    };
    meetings.writeArtifacts(dir, { transcript, notes, meta });

    let archive = null;
    let archiveError = null;
    try {
      archive = await archiveMeeting(dir, cfg);
    } catch (e) {
      archiveError = e.message;
      console.error("archive failed:", e);
    }

    /* Automatic speaker recognition — the LAST step of the pipeline on purpose:
     * runDiarizationForDir rewrites transcript.json/.md/.txt, so it must come after
     * meetings.writeArtifacts above. When it is skipped or fails the pipeline still
     * finishes normally and says why (diarizationError) instead of failing. */
    try {
      const acfg = config.load();
      let skipReason = null;
      if (!(acfg.diarize && acfg.diarize.autoRun)) {
        skipReason = "已关闭自动识别发言人";
      } else {
        /* preflight never downloads, so a missing 声纹模型 is handled HERE, keyed on
         * the machine-readable `missing` field — never on the Chinese reason copy,
         * which is free to be reworded without changing what the pipeline does. */
        const st = diarize.preflight({ modelDir: config.modelCacheDir(acfg), sherpaReady: sherpaAvailable() });
        if (!st.ok && st.missing !== "embedding") {
          skipReason = st.reason; // sherpa or segmentation missing: nothing this step can do
        } else if (!st.ok && acfg.whisper.autoDownload === false) {
          // the user opted out of downloads, so proceed no further — but say so
          skipReason = "声纹模型尚未下载（自动下载已关闭）";
        } else if (!st.ok) {
          // autoDownload on: proceed and let diarize() fetch the model itself
          skipReason = null;
        }
      }
      if (skipReason) {
        diarizationSkip = skipReason; // a skip is ALWAYS reported, never silently "fine"
        console.log("[diarize] 跳过自动识别发言人：" + skipReason);
        // the pipelined copy is actionable; diarizationError keeps the short reason
        const msg = skipReason === "声纹模型尚未下载（自动下载已关闭）"
          ? "跳过自动识别发言人：声纹模型尚未下载，请在「模型与接口」页点下载"
          : "跳过自动识别发言人：" + skipReason;
        send("pipeline", { phase: "diarizing", message: msg });
      } else {
        send("pipeline", { phase: "diarizing", message: "自动识别发言人（本地 CPU，长会议需要几分钟）…" });
        const res = await runDiarizationForDir(dir, acfg, (p) => {
          const msg =
            p.phase === "download-start" || p.phase === "downloading"
              ? "下载声纹模型（约 27 MB）" + (typeof p.percent === "number" ? " " + p.percent + "%…" : "…") :
            p.phase === "decoding" ? "解码音频…" :
            p.phase === "diarizing" ? "识别说话人…" :
            p.phase === "labelling" ? "整理结果…" : "识别发言人…";
          send("pipeline", { phase: "diarizing", message: msg, progress: p.percent });
        });
        if (res && res.ok) {
          diarization = res;
          diarizationSkip = null;
        } else {
          const reason = (res && res.error) || "未知错误";
          diarizationSkip = reason;
          console.error("[diarize] 自动识别发言人失败：", reason);
          send("pipeline", { phase: "diarizing", message: "自动识别发言人失败：" + reason });
        }
      }
    } catch (e) {
      diarizationSkip = e.message;
      console.error("[diarize] 自动识别发言人异常（不影响笔记）：", e);
      send("pipeline", { phase: "diarizing", message: "自动识别发言人失败：" + e.message });
    }

    send("pipeline", { phase: "done", message: "Done", dir });
    notifyDone(dir);
    touchActivity();
    rec.busy = false;
    return {
      ok: true, dir, notes: notes.text, notesZh: notes.zh || null,
      transcript: transcript.text, zh: transcript.zh || null,
      provider: notes.provider, durationSec,
      notesFallbackReason: notes.fallbackReason || null,
      notesWarnings: notes.warnings || [],
      notesMapReduce: !!notes.mapReduce,
      notesChunks: notes.chunks || 1,
      /* Per-track level summary (peakDbfs / activePercent, plus the silence-skip
       * numbers). The renderer needs THIS one back, not just the copy written into
       * meta.json: it is what lets showResult() say "the mic track recorded nothing"
       * in the result panel, instead of the user discovering it after the fact. */
      audioStats: transcript.audioStats || null,
      archive, archiveError,
      // The speaker panel is populated from THIS result, so the renderer needs no
      // second IPC call after a recording. diarizationError is why it is empty.
      speakers: diarization ? diarization.speakers : [],
      chunks: diarization && diarization.chunks ? diarization.chunks : transcript.chunks,
      diarizationError: diarizationSkip || null,
      limitReached: rec.limitReached || null,
      stopReason: rec.stopReason || null,
      // Hand the confirmed roster back to the renderer so the speaker-naming rows
      // can offer these names immediately after THIS recording. Without it the
      // suggestions would be empty exactly in the main flow, because showResult()
      // resets its copy and the roster only comes back from meetings:open later.
      participants: participantResult && Array.isArray(participantResult.names) ? participantResult.names : [],
    };
  } catch (e) {
    console.error("pipeline error:", e);
    send("pipeline", { phase: "error", message: e.message });
    /* PERSIST THE FAILURE. Until now a pipeline error went only to console.error and
     * the UI status line, so a user hit by a failure had nothing to send and no way
     * to see what happened (observed: `ffmpeg exit -13` killed the run and left the
     * meeting folder holding nothing but the raw .wav files). notes.failed.md already
     * sets the precedent of writing a diagnostics artifact into the meeting folder.
     * Written to the meeting folder, and to userData if THAT write fails — a
     * permission error in the meeting folder is itself a plausible cause. */
    const when = new Date().toISOString();
    const body = [
      "Audio2Notes pipeline failure",
      "time        : " + when,
      "meeting dir : " + (dir || "(unknown)"),
      "stop reason : " + (rec.stopReason || "(none)"),
      "duration    : " + (durationSec != null ? durationSec + "s" : "(unknown)"),
      "",
      "error       : " + e.message,
      "",
      "stack:",
      String(e.stack || "(no stack)"),
      "",
      "environment:",
      "  electron  : " + process.versions.electron,
      "  chrome    : " + process.versions.chrome,
      "  node      : " + process.versions.node,
      "  platform  : " + process.platform + " " + process.arch,
      "  userData  : " + app.getPath("userData"),
      "  temp      : " + os.tmpdir(),
    ].join("\n");
    let wrote = null;
    for (const target of [dir ? path.join(dir, "pipeline-error.log") : null,
                          path.join(app.getPath("userData"), "pipeline-error.log")]) {
      if (!target) continue;
      try { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, body, "utf8"); wrote = target; break; }
      catch { /* try the next location */ }
    }
    if (wrote) send("pipeline", { phase: "error", message: e.message + " — details written to " + wrote });
    else console.error("pipeline error: could not write pipeline-error.log to any location");
    rec.busy = false;
    return { error: e.message, dir };
  }
}

ipcMain.handle("record:stop", async (_e, opts = {}) => {
  // The renderer knows why it stopped ("silence" | "disk" | "meeting-app"); pass
  // it through so meta.stopReason is honest. Only known reasons are accepted; an
  // unknown or absent value falls back to "user". The "max-duration" fuse is set by
  // the watchdog before stopRecordingAndProcess and is preserved, never clobbered.
  const reason = opts && typeof opts.reason === "string" ? opts.reason : null;
  if (reason === "silence" || reason === "disk" || reason === "meeting-app") {
    rec.stopReason = reason;
  } else if (rec.stopReason !== "max-duration") {
    rec.stopReason = "user";
  }
  return stopRecordingAndProcess();
});

ipcMain.handle("participants:answer", async (_e, payload = {}) => {
  const { id, ...rest } = payload || {};
  if (!id) return { ok: false };
  return { ok: gate ? !!gate.answer(id, rest) : false };
});

ipcMain.handle("participants:edit", async (_e, opts = {}) => {
  const dir = opts && opts.dir;
  if (!dir) return { error: "缺少会议目录" };
  // Bound the names exactly like gate.answer() does — this path bypasses the gate,
  // and an unbounded list would go straight into meta.json and from there into the
  // notes UI. Sanitising here keeps ONE rule for both ways a roster can be set.
  const names = participants.sanitize(Array.isArray(opts.names) ? opts.names : []);
  const metaPath = path.join(dir, "meta.json");
  // Read the existing meta (tolerating missing/corrupt), then merge. An empty
  // names list means "clear the roster" — the three keys are removed, never written [].
  let meta = {};
  try {
    const raw = fs.readFileSync(metaPath, "utf8");
    const j = JSON.parse(raw.replace(/^\uFEFF/, ""));
    if (j && typeof j === "object" && !Array.isArray(j)) meta = j;
  } catch { /* missing or corrupt meta.json -> start from {} */ }
  if (names.length === 0) {
    delete meta.participants;
    delete meta.participantsSource;
    delete meta.participantsAskedAt;
  } else {
    meta.participants = names;
    meta.participantsSource = "manual";
    meta.participantsAskedAt = new Date().toISOString();
  }
  try {
    fs.mkdirSync(path.dirname(metaPath), { recursive: true });
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf8");
  } catch (e) {
    return { error: "写入失败：" + e.message };
  }
  return { ok: true };
});

ipcMain.handle("participants:status", async () => {
  const p = (config.load() && config.load().participants) || {};
  return {
    askOnStop: !!p.askOnStop,
    timeoutMs: p.timeoutMs || 300000,
    pending: (gate && gate.pending()) || [],
  };
});

ipcMain.handle("file:transcribe", async (_e, filePath) => {
  if (rec.busy) return { error: "busy" };
  rec.busy = true;
  const cfg = config.load();
  const root = config.meetingsDir(cfg);
  const dir = meetings.newMeetingDir(root);
  /* NOTE: the source file is NOT copied into the meeting folder any more.
   * Copying meant an imported 1 GB mp3 left a permanent 1 GB duplicate (the
   * archiving step only ever compressed *.wav). We now transcribe straight from
   * the original path and keep only a small 16 kHz mono Opus copy in the meeting
   * folder, so the original can stay wherever the user keeps it. */
  const originalBytes = (() => {
    try { return fs.statSync(filePath).size; } catch { return 0; }
  })();
  send("pipeline", { phase: "transcribing", message: "Transcribing imported audio…" });
  try {
    models.assertReady({
      cacheDir: config.modelCacheDir(cfg),
      model: cfg.whisper.model,
      autoDownload: cfg.whisper.autoDownload,
    });
    const r = await transcribe.transcribeFile({
      wavFile: filePath, // any ffmpeg-decodable file: wav, opus, mp3, m4a, …
      model: cfg.whisper.model,
      cacheDir: config.modelCacheDir(cfg),
      endpoint: cfg.whisper.endpoint || "https://huggingface.co/",
      // an imported file lives outside the meeting folder; use its own directory as
      // the decode fallback (skipped automatically when it equals the temp dir)
      tempDir: path.dirname(filePath),
    });
    const chunks = (r.chunks || []).map((c) => ({ ...c, speaker: "unknown", speakerName: "说话人" }));
    const audioStats = audioStatsOf(r.audio);
    const transcript = { chunks, text: meetings.transcriptText(chunks), durationSec: 0, audioStats };
    send("transcript", transcript);
    const translated = await translateTranscript(transcript, cfg);
    send("pipeline", { phase: "summarizing", message: "Writing notes…" });
    const notes = await summarize.summarize(transcript.text, cfg, (p) =>
      send("pipeline", { phase: "summarizing", message: p.message || "Writing notes…", progress: p.progress })
    );
    await translateNotes(notes, cfg);
    meetings.writeArtifacts(dir, {
      transcript,
      notes,
      meta: {
        createdAt: new Date().toISOString(),
        source: filePath,
        audioStats,
        whisperModel: cfg.whisper.model,
        notesProvider: notes.provider,
        notesFallbackReason: notes.fallbackReason || null,
        notesMapReduce: !!notes.mapReduce,
        notesChunks: notes.chunks || 1,
        notesWarnings: notes.warnings || [],
        detailLevel: cfg.notes.detailLevel || "standard",
        translated,
        // see translate.transcriptSkipReason — a skipped transcript translation is
        // recorded, never silent
        translationSkipped: translated ? null : transcript.translationSkipped || null,
        translationEngine: translated ? cfg.translation.engine : null,
      },
    });
    // The original file is left alone; the meeting folder gets one small Opus
    // copy so history / speaker diarization / audition still have audio to work with.
    let archive = null;
    let archiveError = null;
    try {
      send("pipeline", { phase: "archiving", message: "生成压缩副本（原文件保持不动）…" });
      const t = await audioArchive.transcodeTo(filePath, path.join(dir, "mixed.opus"), (cfg.audio && cfg.audio.archive) || {});
      archive = {
        codec: t.preset.codec,
        bitrateKbps: t.preset.bitrateKbps,
        sampleRate: 16000,
        channels: 1,
        imported: true,
        sourcePath: filePath,
        sourceBytes: originalBytes,
        archivedBytes: t.bytes,
        files: [{ name: path.basename(filePath), to: "mixed.opus", before: originalBytes, after: t.bytes }],
        // deliberately NOT counted as "saved": the original was never copied, so
        // nothing was reclaimed — the meeting folder just stays small
        savedBytes: 0,
        errors: [],
        archivedAt: new Date().toISOString(),
      };
      try {
        const metaPath = path.join(dir, "meta.json");
        const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
        meta.audio = archive;
        fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf8");
      } catch { /* meta optional */ }
    } catch (e) {
      archiveError = e.message;
      console.error("import archive failed:", e);
    }
    send("pipeline", { phase: "done", message: "Done", dir });
    notifyDone(dir);
    touchActivity();
    rec.busy = false;
    return {
      ok: true, dir, notes: notes.text, notesZh: notes.zh || null,
      transcript: transcript.text, zh: transcript.zh || null,
      chunks: transcript.chunks, provider: notes.provider,
      notesFallbackReason: notes.fallbackReason || null,
      notesWarnings: notes.warnings || [],
      archive, archiveError,
    };
  } catch (e) {
    console.error("import error:", e);
    send("pipeline", { phase: "error", message: e.message });
    rec.busy = false;
    return { error: e.message, dir };
  }
});

/** Re-run notes generation from the saved transcript (no re-transcription). */
ipcMain.handle("notes:regenerate", async (_e, { dir, detailLevel } = {}) => {
  const tfPath = path.join(dir, "transcript.json");
  if (!fs.existsSync(tfPath)) return { error: "no transcript.json in " + dir };
  const tf = JSON.parse(fs.readFileSync(tfPath, "utf8"));
  const cfg = config.load();
  if (detailLevel) {
    cfg.notes.detailLevel = detailLevel;
    config.save(cfg);
  }
  const notes = await summarize.summarize(meetings.transcriptText(tf.chunks), cfg, (p) =>
    send("pipeline", { phase: "summarizing", message: p.message || "Writing notes…", progress: p.progress })
  );
  await translateNotes(notes, cfg);

  /* Never let a failed regeneration destroy notes that are already there: a
   * fallback result goes to notes.failed.md and the existing notes.md survives. */
  const notesPath = path.join(dir, "notes.md");
  const hadNotes = fs.existsSync(notesPath) && fs.statSync(notesPath).size > 0;
  if (notes.fallbackReason && hadNotes) {
    fs.writeFileSync(path.join(dir, "notes.failed.md"), notes.text, "utf8");
    console.error(`[notes] regeneration failed (${notes.fallbackReason}); kept the existing notes.md`);
    return {
      ok: false,
      error: `摘要失败：${notes.fallbackReason} —— 已保留原来的 notes.md，失败结果写在 notes.failed.md`,
      notesFallbackReason: notes.fallbackReason,
      notesWarnings: notes.warnings || [],
    };
  }

  fs.writeFileSync(notesPath, notes.text, "utf8");
  if (notes.zh) fs.writeFileSync(path.join(dir, "notes.zh.md"), notes.zh, "utf8");
  const metaPath = path.join(dir, "meta.json");
  try {
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    meta.notesProvider = notes.provider;
    meta.notesFallbackReason = notes.fallbackReason || null;
    meta.notesMapReduce = !!notes.mapReduce;
    meta.notesChunks = notes.chunks || 1;
    meta.notesWarnings = notes.warnings || [];
    meta.detailLevel = cfg.notes.detailLevel || "standard";
    if (notes.zh) { meta.translated = true; meta.translationEngine = cfg.translation.engine; }
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf8");
  } catch { /* meta optional */ }
  return {
    ok: true, notes: notes.text, notesZh: notes.zh || null, provider: notes.provider,
    notesFallbackReason: notes.fallbackReason || null,
    notesWarnings: notes.warnings || [],
  };
});

/** Installed Ollama models + a recommendation, for the settings dropdown. */
ipcMain.handle("notes:models", async () => {
  const cfg = config.load();
  try {
    const models = await summarize.listOllamaModels(cfg.notes.ollama.baseUrl);
    let recommended = null;
    try { recommended = (await summarize.pickOllamaModel(cfg.notes.ollama.baseUrl)).model; } catch { /* ignore */ }
    return { ok: true, models, recommended };
  } catch (e) {
    return { error: e.message, models: [] };
  }
});

/** Rename a speaker across the transcript (persisted). */
ipcMain.handle("transcript:renameSpeaker", async (_e, { dir, from, to }) => {
  const tfPath = path.join(dir, "transcript.json");
  if (!fs.existsSync(tfPath)) return { error: "no transcript.json" };
  const tf = JSON.parse(fs.readFileSync(tfPath, "utf8"));
  let changed = 0;
  for (const c of tf.chunks || []) {
    if ((c.speakerName || "") === from) { c.speakerName = to; changed++; }
  }
  if (changed === 0) return { error: "speaker not found: " + from };
  tf.text = meetings.transcriptText(tf.chunks);
  if (tf.zh) tf.zh = meetings.transcriptZhText(tf.chunks);
  fs.writeFileSync(tfPath, JSON.stringify(tf, null, 2), "utf8");
  fs.writeFileSync(path.join(dir, "transcript.md"), meetings.transcriptMarkdown(tf), "utf8");
  fs.writeFileSync(path.join(dir, "transcript.txt"), tf.text, "utf8");
  if (tf.zh) {
    fs.writeFileSync(path.join(dir, "transcript.zh.md"), meetings.transcriptMarkdown(tf, true), "utf8");
    fs.writeFileSync(path.join(dir, "transcript.zh.txt"), tf.zh, "utf8");
  }
  const metaPath = path.join(dir, "meta.json");
  try {
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    meta.speakerLabels = [...new Set((tf.chunks || []).map((c) => c.speakerName))];
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf8");
  } catch { /* meta optional */ }
  return { ok: true, chunks: tf.chunks, text: tf.text };
});

/* ---- speakers: diarization + naming -------------------------------------
 * Contract: a chunk carries `speaker` = STABLE id ("spk1", "you", "spk2") and
 * `speakerName` = the display name. Renaming always matches on the id, so a
 * name can be changed any number of times without breaking the link, and two
 * different speakers may share a name without being merged. */
function rewriteTranscript(dir) {
  const tfPath = path.join(dir, "transcript.json");
  if (!fs.existsSync(tfPath)) return null;
  const tf = JSON.parse(fs.readFileSync(tfPath, "utf8"));
  tf.text = meetings.transcriptText(tf.chunks);
  if (tf.zh || (tf.chunks || []).some((c) => c.translated)) tf.zh = meetings.transcriptZhText(tf.chunks);
  fs.writeFileSync(tfPath, JSON.stringify(tf, null, 2), "utf8");
  fs.writeFileSync(path.join(dir, "transcript.md"), meetings.transcriptMarkdown(tf), "utf8");
  fs.writeFileSync(path.join(dir, "transcript.txt"), tf.text, "utf8");
  if (tf.zh) {
    fs.writeFileSync(path.join(dir, "transcript.zh.md"), meetings.transcriptMarkdown(tf, true), "utf8");
    fs.writeFileSync(path.join(dir, "transcript.zh.txt"), meetings.transcriptZhText(tf.chunks), "utf8");
  }
  return tf;
}

/** Apply speakers.json names onto chunks (id -> display name). */
function applySpeakerNames(dir, speakers, chunks) {
  return diarize.applyNames(speakers, chunks);
}

function writeSpeakersMeta(dir, speakers) {
  try {
    const metaPath = path.join(dir, "meta.json");
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    meta.speakers = speakers;
    meta.speakerLabels = [...new Set(speakers.map((s) => s.name).filter(Boolean))];
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf8");
  } catch { /* meta optional */ }
}

/** Source track used for diarization: the remote/system side, else the mix. */
function diarizationSource(dir) {
  for (const n of ["system.opus", "system.wav", "mixed.opus", "mixed.wav"]) {
    const p = path.join(dir, n);
    if (fs.existsSync(p) && fs.statSync(p).size > 4096) return p;
  }
  return null;
}

/**
 * Run speaker diarization for one meeting folder and persist the result
 * (samples/ + speakers.json + rewritten transcript + meta.speakers).
 * Shared by the manual 「识别发言人」 button and the automatic pipeline step, so both
 * paths produce exactly the same artifacts.
 * @returns {Promise<{ok:boolean, speakers?:Array, chunks?:Array, source?:string,
 *                    threshold?:number, segments?:Array, error?:string}>}
 */
async function runDiarizationForDir(dir, cfg, onProgress, threshold) {
  const src = diarizationSource(dir);
  if (!src) return { ok: false, error: "找不到可用于声纹分析的音频（system/mixed 都不存在）" };
  const r = await diarize.diarize({
    audioPath: src,
    modelDir: config.modelCacheDir(cfg),
    threshold: Number(threshold) || diarize.DEFAULT_THRESHOLD,
    numThreads: 4,
    onProgress,
    /* Work in the meeting folder, NOT os.tmpdir(). decodeToSamples writes a large
     * raw PCM temp file, and a decode into the system temp dir has already failed on
     * one machine with `ffmpeg exit -13` (EACCES). This directory is one the app has
     * demonstrably written to (the meeting audio is there), so the raw file is safe
     * here — and it is deleted immediately after being read. */
    workDir: dir,
  });

  const samples = await diarize.buildSamples({
    audioPath: src, speakers: r.speakers, segments: r.segments, outDir: dir,
  });

  const speakers = r.speakers.map((s) => ({
    id: s.id,
    name: null, // display falls back to 发言人N until the user types a name
    segments: s.segmentCount,
    durationSec: s.durationSec,
    sample: samples[s.id] || null,
    lowConfidence: !samples[s.id] || (samples[s.id].durationSec || 0) < 2,
  }));

  const tfPath = path.join(dir, "transcript.json");
  let chunks = [];
  if (fs.existsSync(tfPath)) {
    const tf = JSON.parse(fs.readFileSync(tfPath, "utf8"));
    diarize.assignToChunks(tf.chunks, r.segments, speakers.length ? speakers[0].id : null);
    // the mic track stays "你" — a physically separate voice path
    for (const c of tf.chunks) if (c.speaker === "you") c.speakerName = "你";
    applySpeakerNames(dir, speakers, tf.chunks);
    for (const c of tf.chunks) if (c.speaker === "you") c.speakerName = "你";
    fs.writeFileSync(tfPath, JSON.stringify(tf, null, 2), "utf8");
    chunks = tf.chunks;
  }

  diarize.saveSpeakers(dir, {
    version: 1,
    createdAt: new Date().toISOString(),
    model: diarize.EMBEDDING_MODEL,
    threshold: r.threshold,
    source: path.basename(src),
    audioDurationSec: r.audioDurationSec,
    segments: r.segments,
    speakers,
  });
  writeSpeakersMeta(dir, speakers);
  const tf2 = rewriteTranscript(dir);
  if (tf2) chunks = tf2.chunks;

  return { ok: true, speakers, chunks, segments: r.segments, source: path.basename(src), threshold: r.threshold };
}

function sherpaAvailable() {
  try { require("sherpa-onnx-node"); return true; } catch (e) { return e.message; }
}

ipcMain.handle("speakers:status", async (_e, { dir } = {}) => {
  const cfg = config.load();
  const rec = dir ? diarize.loadSpeakers(dir) : null;
  return {
    models: diarize.modelsStatus(config.modelCacheDir(cfg)),
    sherpa: sherpaAvailable(),
    speakers: rec ? rec.speakers : null,
    hasSource: dir ? !!diarizationSource(dir) : false,
    threshold: diarize.DEFAULT_THRESHOLD,
  };
});

ipcMain.handle("speakers:diarize", async (_e, { dir, threshold } = {}) => {
  if (!dir) return { error: "no dir" };
  const src = diarizationSource(dir);
  if (!src) return { error: "找不到可用于声纹分析的音频（system/mixed 都不存在）" };
  try {
    send("pipeline", { phase: "diarizing", message: "识别发言人（首次使用会下载 27 MB 声纹模型）…" });
    const st = diarize.preflight({ modelDir: config.modelCacheDir(config.load()), sherpaReady: sherpaAvailable() });
    if (!st.ok) {
      send("pipeline", { phase: "error", message: "识别发言人失败：" + st.reason });
      return { error: st.reason };
    }
    const res = await runDiarizationForDir(dir, config.load(), (p) => {
      const msg =
        p.phase === "downloading" ? `下载声纹模型 ${p.percent}%…` :
        p.phase === "decoding" ? "解码音频…" :
        p.phase === "diarizing" ? "识别说话人…" :
        p.phase === "labelling" ? "整理结果…" : "识别发言人…";
      send("pipeline", { phase: "diarizing", message: msg, progress: p.percent });
    }, threshold);
    if (!res.ok) {
      send("pipeline", { phase: "error", message: "识别发言人失败：" + res.error });
      return { error: res.error };
    }
    send("pipeline", { phase: "done", message: `识别到 ${res.speakers.length} 个发言人`, dir });
    return { ok: true, ...res };
  } catch (e) {
    console.error("diarize error:", e);
    send("pipeline", { phase: "error", message: "识别发言人失败：" + e.message });
    return { error: e.message };
  }
});

/** Rename by STABLE id — never by display string. */
ipcMain.handle("speakers:setName", async (_e, { dir, speakerId, name } = {}) => {
  const rec = diarize.loadSpeakers(dir);
  if (!rec) return { error: "该会议还没有发言人信息（先点「识别发言人」）" };
  const before = diarize.displayName(speakerId, rec.speakers); // old display name
  if (!diarize.renameInRecord(rec, speakerId, name)) return { error: "找不到发言人 " + speakerId };
  diarize.saveSpeakers(dir, rec);
  const after = diarize.displayName(speakerId, rec.speakers);

  const tfPath = path.join(dir, "transcript.json");
  if (!fs.existsSync(tfPath)) return { error: "no transcript.json" };
  const tf = JSON.parse(fs.readFileSync(tfPath, "utf8"));
  applySpeakerNames(dir, rec.speakers, tf.chunks);
  fs.writeFileSync(tfPath, JSON.stringify(tf, null, 2), "utf8");
  writeSpeakersMeta(dir, rec.speakers);
  const out = rewriteTranscript(dir);
  // notes.md is an LLM snapshot: it is not re-derived from the chunks, so the old
  // name is substituted here too — otherwise the notes would keep saying 发言人1.
  const patched = patchNotesNames(dir, before, after);
  return { ok: true, speakers: rec.speakers, chunks: out ? out.chunks : tf.chunks, notesPatched: patched };
});

/** Merge `fromId` into `intoId` — fixes over-segmentation. */
ipcMain.handle("speakers:merge", async (_e, { dir, fromId, intoId } = {}) => {
  const rec = diarize.loadSpeakers(dir);
  if (!rec) return { error: "no speakers.json" };
  const m = diarize.mergeInRecord(rec, fromId, intoId);
  if (!m) return { error: "无效的合并" };
  diarize.saveSpeakers(dir, rec);

  const tfPath = path.join(dir, "transcript.json");
  if (!fs.existsSync(tfPath)) return { error: "no transcript.json" };
  const tf = JSON.parse(fs.readFileSync(tfPath, "utf8"));
  for (const c of tf.chunks) if (c.speaker === fromId) c.speaker = intoId;
  applySpeakerNames(dir, rec.speakers, tf.chunks);
  fs.writeFileSync(tfPath, JSON.stringify(tf, null, 2), "utf8");
  try { if (m.from.sample) fs.rmSync(path.join(dir, m.from.sample.file), { force: true }); } catch { /* ignore */ }
  writeSpeakersMeta(dir, rec.speakers);
  const out = rewriteTranscript(dir);
  const patched = patchNotesNames(dir, diarize.displayName(m.from.id, [m.from]), diarize.displayName(m.into.id, rec.speakers));
  return { ok: true, speakers: rec.speakers, chunks: out ? out.chunks : tf.chunks, notesPatched: patched };
});

/** Substitute a speaker's name inside the generated notes (they are LLM snapshots
 *  and are otherwise never re-derived). Returns how many occurrences changed. */
function patchNotesNames(dir, oldName, newName) {
  if (!oldName || !newName || oldName === newName) return 0;
  let total = 0;
  for (const f of ["notes.md", "notes.zh.md"]) {
    const p = path.join(dir, f);
    if (!fs.existsSync(p)) continue;
    try {
      const r = diarize.replaceSpeakerName(fs.readFileSync(p, "utf8"), oldName, newName);
      if (r.count) {
        fs.writeFileSync(p, r.text, "utf8");
        total += r.count;
      }
    } catch (e) {
      console.error(`[speakers] notes patch failed for ${f}:`, e.message);
    }
  }
  return total;
}

/** Audition clip for one speaker, as a data URL the renderer can play. */
ipcMain.handle("speakers:audition", async (_e, { dir, speakerId } = {}) => {
  const rec = diarize.loadSpeakers(dir);
  const s = rec && rec.speakers.find((x) => x.id === speakerId);
  if (!s || !s.sample) return { error: "这个发言人没有样本" };
  const f = path.join(dir, s.sample.file);
  if (!fs.existsSync(f)) return { error: "样本文件不存在" };
  const b = fs.readFileSync(f);
  const mime = /\.mp3$/i.test(f) ? "audio/mpeg" : "audio/ogg";
  return { ok: true, dataUrl: `data:${mime};base64,${b.toString("base64")}`, durationSec: s.sample.durationSec };
});

/* ---- audio archiving: survey + bulk cleanup of existing meetings --------- */
ipcMain.handle("archive:presets", () => {
  const cfg = config.load();
  return {
    current: audioArchive.resolvePreset((cfg.audio && cfg.audio.archive) || {}),
    presets: audioArchive.PRESETS.map((p) => ({
      ...p,
      bytesPerHour: audioArchive.estimateBytesPerHour(p),
    })),
  };
});

ipcMain.handle("archive:scan", async () => {
  const cfg = config.load();
  return audioArchive.scan(config.meetingsDir(cfg), (cfg.audio && cfg.audio.archive) || {});
});

let archiveBusy = false;
ipcMain.handle("archive:run", async () => {
  if (archiveBusy) return { error: "busy" };
  archiveBusy = true;
  try {
    const cfg = config.load();
    const opts = (cfg.audio && cfg.audio.archive) || {};
    const preset = audioArchive.resolvePreset(opts);
    const r = await audioArchive.archiveAll(config.meetingsDir(cfg), opts, (p) =>
      send("archive", {
        dirName: p.dirName,
        file: p.file,
        dirIndex: p.dirIndex,
        index: p.index,
        total: p.total,
        message: `压缩 ${p.dirName}/${p.file}（${p.index}/${p.total}）…`,
      })
    );
    return { ok: true, ...r, preset };
  } finally {
    archiveBusy = false;
  }
});

ipcMain.handle("app:openDir", (_e, dir) => {
  if (dir) shell.openPath(dir);
  return true;
});

ipcMain.handle("app:chooseDir", async () => {
  const r = await dialog.showOpenDialog(win, { properties: ["openDirectory"] });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle("app:pickFile", async (_e, { filters }) => {
  const r = await dialog.showOpenDialog(win, {
    properties: ["openFile"],
    filters:
      filters || [
        // "opus" MUST be here: it is the format this app's own archiving produces.
        // Anything ffmpeg can decode works, so "All files" is offered too.
        { name: "音频（含本应用归档的 opus）", extensions: ["wav", "opus", "ogg", "mp3", "m4a", "aac", "flac", "webm", "wma", "mp4", "mkv"] },
        { name: "所有文件", extensions: ["*"] },
      ],
  });
  return r.canceled ? null : r.filePaths[0];
});

/* ---- history: open a meeting that was recorded earlier -------------------
 * Without this, anything recorded in a previous session (and therefore its
 * 发言人 panel) was unreachable — only the most recent result existed. */
ipcMain.handle("meetings:list", async () => {
  const cfg = config.load();
  const root = config.meetingsDir(cfg);
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return { ok: true, root, items: [], error: "会议目录不可读：" + root };
  }
  const items = [];
  for (const e of entries) {
    const dir = path.join(root, e.name);
    const has = (n) => fs.existsSync(path.join(dir, n));
    let meta = null;
    try { meta = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8")); } catch { /* optional */ }
    const hasTranscript = has("transcript.json");
    const hasNotes = has("notes.md");
    if (!hasTranscript && !hasNotes) continue; // nothing to show
    let bytes = 0;
    try {
      for (const f of fs.readdirSync(dir)) bytes += fs.statSync(path.join(dir, f)).size;
    } catch { /* ignore */ }
    items.push({
      dir,
      name: e.name,
      createdAt: (meta && meta.createdAt) || e.name,
      durationSec: (meta && meta.durationSec) || 0,
      notesProvider: (meta && meta.notesProvider) || null,
      notesFallbackReason: (meta && meta.notesFallbackReason) || null,
      hasTranscript,
      hasNotes,
      hasSpeakers: has("speakers.json"),
      hasAudio: ["system.opus", "system.wav", "mixed.opus", "mixed.wav", "mic.opus", "mic.wav"].some(has),
      bytes,
      speakerNames: ((meta && meta.speakers) || []).map((s) => s.name || s.id),
    });
  }
  items.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return { ok: true, root, items };
});

ipcMain.handle("meetings:open", async (_e, { dir } = {}) => {
  if (!dir || !fs.existsSync(dir)) return { error: "会议目录不存在" };
  const out = { ok: true, dir };
  try {
    const tf = JSON.parse(fs.readFileSync(path.join(dir, "transcript.json"), "utf8"));
    out.chunks = tf.chunks || [];
    out.transcript = tf.text || "";
    out.zh = tf.zh || null;
  } catch { out.chunks = []; out.transcript = ""; }
  try { out.notes = fs.readFileSync(path.join(dir, "notes.md"), "utf8"); } catch { out.notes = ""; }
  try { out.notesZh = fs.readFileSync(path.join(dir, "notes.zh.md"), "utf8"); } catch { out.notesZh = null; }
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8"));
    out.provider = m.notesProvider;
    out.durationSec = m.durationSec;
    out.notesFallbackReason = m.notesFallbackReason || null;
    // The roster the user confirmed at stop (P6). Surfaced to the renderer so the
    // speaker-naming rows can offer these names as datalist suggestions — the whole
    // point of asking at stop is that the names are on hand when speakers are named.
    out.participants = Array.isArray(m.participants) ? m.participants : [];
  } catch { /* optional */ }
  touchActivity();
  return out;
});

/* ---- power mode + queue IPC --------------------------------------------- */
ipcMain.handle("power:status", async () => {
  const cfg = config.load();
  const profile = await currentProfile();
  const eng = await engines();
  return {
    ok: true,
    onBattery: isOnBattery(),
    requested: cfg.power && cfg.power.mode,
    batteryPreference: (cfg.power && cfg.power.batteryPreference) || "eco",
    modes: powerMode.MODES,
    profile,
    describe: powerMode.describe(profile),
    /* The same badge as separate pieces. The renderer cannot translate the joined
     * string above (no dictionary key can match a " · "-joined line whose values
     * vary), so it resolves these parts individually. */
    describeParts: powerMode.describeParts(profile),
    engines: eng,
    queue: readQueue().jobs,
    queueRunning,
  };
});

ipcMain.handle("power:setMode", async (_e, { mode, batteryPreference } = {}) => {
  const cfg = config.load();
  if (mode && powerMode.MODES.some((m) => m.id === mode)) cfg.power.mode = mode;
  if (batteryPreference === "eco" || batteryPreference === "defer") cfg.power.batteryPreference = batteryPreference;
  config.save(cfg);
  const profile = await currentProfile();
  touchActivity();
  return { ok: true, profile, describe: powerMode.describe(profile), describeParts: powerMode.describeParts(profile), queue: readQueue().jobs };
});

ipcMain.handle("queue:list", () => ({ ok: true, queue: readQueue().jobs, running: queueRunning }));

ipcMain.handle("queue:runNow", async () => {
  const r = await runQueue("manual");
  return r;
});

ipcMain.handle("queue:remove", (_e, { dir } = {}) => {
  writeQueue(jobQueue.remove(readQueue(), dir));
  return { ok: true, queue: readQueue().jobs };
});

function startPowerWatchers() {
  try {
    powerMonitor.on("on-ac", async () => {
      const profile = await currentProfile();
      send("power", { onBattery: false, describe: powerMode.describe(profile), profile });
      touchActivity();
      if (profile.runNow && jobQueue.size(readQueue())) {
        notifyUser("已接通电源", "开始处理排队的会议…");
        runQueue("auto");
      }
    });
    powerMonitor.on("on-battery", async () => {
      const profile = await currentProfile();
      send("power", { onBattery: true, describe: powerMode.describe(profile), profile });
      touchActivity();
    });
  } catch (e) {
    console.error("[power] powerMonitor unavailable:", e.message);
  }
}

/* ---- meeting-app detection (WASAPI sessions) ----------------------------
 * capture.exe sessions tells us which processes are playing audio; the rules
 * live in src/meetingDetect.js. Starting a recording by itself is opt-in
 * (privacy); noticing that the call ended is on by default. */
let meetingState = { activeSince: null, inactiveSince: null, sawWatchedApp: false };
let lastSessions = [];

function meetingRule() {
  return ((config.load().lifecycle || {}).meetingDetect) || {};
}

function startMeetingWatcher() {
  setInterval(async () => {
    const rule = meetingDetect.normalizeRule(meetingRule());
    if (!rule.enabled) return;
    let sessions = [];
    try {
      sessions = await capture.listSessions();
    } catch {
      return;
    }
    lastSessions = sessions;
    const { actions, next, activeApp } = meetingDetect.evaluate(meetingState, {
      sessions,
      recording: isRecording(),
      now: Date.now(),
      rule,
    });
    meetingState = next;
    if (process.env.A2N_DEBUG_MEETING) {
      console.log(`[meeting] sessions=${sessions.length} activeApp=${activeApp || "-"} actions=${actions.map((a) => a.type).join(",") || "none"}`);
    }
    for (const a of actions) {
      if (a.type === "start") {
        notifyUser("检测到会议软件在播放声音", `${a.app} —— 已自动开始录音（可在设置里关闭）`);
        send("meeting", { type: "auto-start-request", app: a.app });
      } else if (a.type === "stop") {
        notifyUser("会议似乎结束了", "会议软件已停止播放声音，正在停止录音并生成笔记");
        send("meeting", { type: "auto-stop-request", reason: a.reason });
      }
    }
  }, 8000);
}

ipcMain.handle("meeting:status", async () => {
  const rule = meetingDetect.normalizeRule(meetingRule());
  let sessions = lastSessions;
  try {
    sessions = await capture.listSessions();
    lastSessions = sessions;
  } catch { /* keep the last known list */ }
  return {
    ok: true,
    rule,
    recording: isRecording(),
    activeApp: meetingDetect.activeMeetingApp(sessions, rule),
    sessions,
  };
});

/* ---- model management + interface test ---------------------------------- */
ipcMain.handle("llm:providers", () => {
  const cfg = config.load();
  const isOllama = cfg.notes.provider !== "openai";
  return {
    ok: true,
    providers: llmProviders.PROVIDERS,
    matched: llmProviders.matchByBaseUrl(isOllama ? cfg.notes.ollama.baseUrl : cfg.notes.openai.baseUrl),
    current: { provider: cfg.notes.provider, ollama: cfg.notes.ollama, openai: cfg.notes.openai },
  };
});

ipcMain.handle("models:status", async () => {
  const cfg = config.load();
  const cacheDir = config.modelCacheDir(cfg);
  const st = models.status(cacheDir, cfg.whisper.model);
  return {
    ok: true,
    ...st,
    endpoint: cfg.whisper.endpoint || "https://huggingface.co/",
    autoDownload: cfg.whisper.autoDownload !== false,
    cacheDir,
  };
});

ipcMain.handle("models:download", async (_e, { kind, id } = {}) => {
  const cfg = config.load();
  const cacheDir = config.modelCacheDir(cfg);
  try {
    if (kind === "whisper") {
      const model = id || cfg.whisper.model;
      send("models", { kind, id: model, percent: 0, message: `开始下载 ${model.replace("Xenova/", "")}…` });
      return { ok: true, ...(await models.downloadWhisper({
        model,
        cacheDir,
        endpoint: cfg.whisper.endpoint,
        onProgress: (p) => send("models", { kind, id: model, ...p }),
      })) };
    }
    if (kind === "voiceprint") {
      send("models", { kind, percent: 0, message: "开始下载声纹模型…" });
      return { ok: true, ...(await models.downloadVoiceprint({
        cacheDir,
        onProgress: (p) => send("models", { kind, ...p }),
      })) };
    }
    return { error: "未知的模型类型：" + kind };
  } catch (e) {
    console.error("[models] download failed:", e);
    return { error: e.message };
  }
});

ipcMain.handle("models:delete", async (_e, { kind, id } = {}) => {
  const cfg = config.load();
  const cacheDir = config.modelCacheDir(cfg);
  if (kind === "whisper") return models.deleteWhisper(cacheDir, id || cfg.whisper.model);
  if (kind === "voiceprint") return models.deleteVoiceprint(cacheDir);
  return { error: "未知的模型类型：" + kind };
});

ipcMain.handle("models:endpoint", async (_e, { endpoint, autoDownload } = {}) => {
  const cfg = config.load();
  if (typeof endpoint === "string") {
    cfg.whisper.endpoint = endpoint.trim() || "https://huggingface.co/";
    if (!/^https?:\/\//.test(cfg.whisper.endpoint)) return { error: "下载地址必须以 http:// 或 https:// 开头" };
  }
  if (typeof autoDownload === "boolean") cfg.whisper.autoDownload = autoDownload;
  config.save(cfg);
  touchActivity();
  return { ok: true, endpoint: cfg.whisper.endpoint, autoDownload: cfg.whisper.autoDownload };
});

ipcMain.handle("models:openDir", async () => {
  const cfg = config.load();
  const cacheDir = config.modelCacheDir(cfg);
  fs.mkdirSync(cacheDir, { recursive: true });
  shell.openPath(cacheDir);
  return { ok: true, cacheDir };
});

/** Connectivity test for the notes/translation LLM interfaces. */
ipcMain.handle("llm:test", async (_e, { provider, baseUrl, apiKey, model } = {}) => {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  const t0 = Date.now();
  try {
    if (provider === "ollama") {
      const r = await fetch(base + "/api/tags", { signal: AbortSignal.timeout(8000) });
      if (!r.ok) return { ok: false, error: `HTTP ${r.status}`, ms: Date.now() - t0 };
      const j = await r.json();
      const names = (j.models || []).map((m) => m.name);
      return {
        ok: true,
        ms: Date.now() - t0,
        models: names,
        note: names.length ? `找到 ${names.length} 个已安装模型` : "服务在跑，但一个模型都没装",
        modelPresent: model ? names.includes(model) : null,
      };
    }
    if (provider === "openai") {
      const r = await fetch(base + "/models", {
        headers: apiKey ? { Authorization: "Bearer " + apiKey } : {},
        signal: AbortSignal.timeout(10000),
      });
      if (!r.ok) return { ok: false, error: `HTTP ${r.status}${r.status === 401 ? "（API key 无效）" : ""}`, ms: Date.now() - t0 };
      const j = await r.json().catch(() => ({}));
      const names = (j.data || []).map((m) => m.id);
      return { ok: true, ms: Date.now() - t0, models: names.slice(0, 40), note: names.length ? `接口可用，列出 ${names.length} 个模型` : "接口可用（未返回模型列表）" };
    }
    return { ok: false, error: "未配置 LLM（当前为内置规则抽取模式）" };
  } catch (e) {
    return { ok: false, error: e.message, ms: Date.now() - t0 };
  }
});

/* ---- lifecycle IPC ------------------------------------------------------- */
ipcMain.handle("lifecycle:status", () => {
  const lc = lifecycleCfg();
  return {
    recording: isRecording(),
    busy: !!rec.busy,
    idleMin: Math.round(((Date.now() - lifecycle.lastActivity) / 60000) * 10) / 10,
    silentSec: isRecording() ? Math.round((Date.now() - lifecycle.lastLoudAt) / 1000) : 0,
    autoQuitAfterMin: lc.autoQuitAfterMin,
    autoStop: lc.autoStop,
    freeDiskGB: freeDiskGB(),
    diskRoot: meetingsVolumeRoot(),
    forceQuitArmed: lifecycle.forceQuit,
  };
});

/** "I'm still here" — cancels a pending auto-stop until the next silence period. */
ipcMain.handle("lifecycle:keepAlive", () => {
  lifecycle.autoStopSuppressed = true;
  lifecycle.autoStopWarnedAt = null;
  lifecycle.lastLoudAt = Date.now();
  touchActivity();
  return { ok: true };
});

/** Called by the renderer when it finished the stop-and-process flow. */
ipcMain.handle("lifecycle:touch", () => {
  touchActivity();
  lifecycle.autoStopSuppressed = false;
  return { ok: true };
});

/* The gap between "module requires done" and this line is Electron/Chromium
 * bringing itself up (GPU process, app ready). If the ~10 s lives anywhere
 * inside the app, it is here or in createWindow below. */
bootProbe.mark("app.whenReady resolved", "Electron finished initialising");
bootProbe.flush();

app.whenReady().then(() => {
  bootProbe.mark("whenReady callback entered");
  createWindow();
  bootProbe.mark("createWindow returned");
  startLifecycleWatchdog();
  startPowerWatchers();
  startMeetingWatcher();
  bootProbe.mark("watchers started");
  bootProbe.flush();
  // pick up anything that was parked while the app was closed
  setTimeout(async () => {
    const profile = await currentProfile();
    if (profile.runNow && jobQueue.size(readQueue())) {
      notifyUser("有排队的会议", `${jobQueue.size(readQueue())} 个会议等待转写，开始处理…`);
      runQueue("auto");
    }
  }, 4000);
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  for (const key of ["system", "mic"]) {
    if (rec[key]) capture.stopCapture(rec[key]);
  }
});
