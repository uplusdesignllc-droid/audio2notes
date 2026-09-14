"use strict";
const { app, BrowserWindow, ipcMain, shell, dialog, Notification, powerMonitor } = require("electron");
const path = require("path");
const fs = require("fs");

const config = require("./config");
const capture = require("./capture");
const transcribe = require("./transcribe");
const summarize = require("./summarize");
const translate = require("./translate");
const meetings = require("./meetings");
const audioArchive = require("./audioArchive");
const diarize = require("./diarize");
const lifecyclePolicy = require("./lifecyclePolicy");
const powerMode = require("./powerMode");
const jobQueue = require("./jobQueue");
const meetingDetect = require("./meetingDetect");
const models = require("./models");
const llmProviders = require("./llmProviders");
const os = require("os");

let win = null;
let rec = { system: null, mic: null, levelTimers: [], busy: false, limitFired: false, limitReached: null };

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
      forceStopAfterMin: typeof a.forceStopAfterMin === "number" ? a.forceStopAfterMin : 5,
      minFreeDiskGB: typeof a.minFreeDiskGB === "number" ? a.minFreeDiskGB : 2,
      maxElapsedMin: typeof a.maxElapsedMin === "number" ? a.maxElapsedMin : 480,
      levelThreshold: typeof a.levelThreshold === "number" ? a.levelThreshold : 8,
    },
  };
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

/** Desktop notification; click opens the meeting folder. Never throws. */
function notifyUser(title, body, dir) {
  try {
    const n = new Notification({ title, body });
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
  win.loadFile(path.join(__dirname, "..", "renderer", "index.html"));

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
          notifyUser("录音似乎已经结束", `已 ${Math.round(a.silentSec / 60)} 分钟没有声音，${lc.autoStop.forceStopAfterMin} 分钟后将自动停止并处理。`);
        }
        send("lifecycle", { type: "silence-warning", silentSec: a.silentSec, forceInSec: a.forceInSec });
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
async function enqueueMeeting(dir, sources, durationSec, cfg, captureInfo) {
  let archive = null;
  try { archive = await archiveMeeting(dir, cfg); } catch (e) { console.error("archive failed:", e); }
  // keep the audio we will need later; the wavs are gone after archiving
  const q = jobQueue.add(readQueue(), {
    dir,
    reason: "defer",
    sources: Object.keys(sources || {}),
    durationSec,
    captureInfo: captureInfo || null,
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

/* ---- level polling (reads --status files; sandbox-safe) ------------------ */
function pollLevels() {
  for (const key of ["system", "mic"]) {
    const r = rec[key];
    if (!r) continue;
    const timer = setInterval(() => {
      let level = null;
      try {
        const text = fs.readFileSync(r.statusFile, "utf8");
        const lines = text.split(/\r?\n/).filter(Boolean);
        const last = lines[lines.length - 1];
        const m = last && last.match(/^LEVEL\s+(\d+)/);
        if (m) level = Math.max(0, Math.min(100, +m[1]));
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
      if (level != null) {
        send("level", { source: r.kind, level });
        // any audible level counts as "this meeting is still going" — drives the
        // forgotten-recording guard in startLifecycleWatchdog()
        if (level >= lifecycleCfg().autoStop.levelThreshold) {
          lifecycle.lastLoudAt = Date.now();
          lifecycle.autoStopWarnedAt = null;
          if (lifecycle.autoStopSuppressed) lifecycle.autoStopSuppressed = false;
        }
      }
    }, 300);
    rec.levelTimers.push(timer);
  }
}

function stopPolling() {
  for (const t of rec.levelTimers) clearInterval(t);
  rec.levelTimers = [];
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
    mic = await transcribe.transcribeFile({ wavFile: sources.mic, model, cacheDir, onProgress, endpoint });
  }
  if (sources.system) {
    send("pipeline", { phase: "transcribing", message: "Transcribing system-audio track…" });
    sys = await transcribe.transcribeFile({ wavFile: sources.system, model, cacheDir, onProgress, endpoint });
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
  pollLevels();
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
  rec.system = null; rec.mic = null;
  const dir = rec.dir;

  /* Power mode decides whether we transcribe now at all. In "defer" mode the
   * recording is only archived + queued, so a battery session never runs Whisper. */
  const profile = await currentProfile().catch(() => null);
  if (profile && !profile.runNow) {
    try {
      const q = await enqueueMeeting(dir, sources, durationSec, config.load(), rec.captureInfo || null);
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

    send("pipeline", { phase: "summarizing", message: "Writing notes…" });
    const notes = await summarize.summarize(transcript.text, cfg, (p) =>
      send("pipeline", { phase: "summarizing", message: p.message || "Writing notes…", progress: p.progress })
    );
    await translateNotes(notes, cfg);

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
      capture: rec.captureInfo || null,
      limitReached: rec.limitReached || null,
      stopReason: rec.stopReason || null,
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

    send("pipeline", { phase: "done", message: "Done", dir });
    notifyDone(dir);
    touchActivity();
    rec.busy = false;
    return {
      ok: true, dir, notes: notes.text, notesZh: notes.zh || null,
      transcript: transcript.text, zh: transcript.zh || null,
      chunks: transcript.chunks, provider: notes.provider, durationSec,
      notesFallbackReason: notes.fallbackReason || null,
      notesWarnings: notes.warnings || [],
      notesMapReduce: !!notes.mapReduce,
      notesChunks: notes.chunks || 1,
      archive, archiveError,
      limitReached: rec.limitReached || null,
      stopReason: rec.stopReason || null,
    };
  } catch (e) {
    console.error("pipeline error:", e);
    send("pipeline", { phase: "error", message: e.message });
    rec.busy = false;
    return { error: e.message, dir };
  }
}

ipcMain.handle("record:stop", async () => stopRecordingAndProcess());

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
  const cfg = config.load();
  try {
    send("pipeline", { phase: "diarizing", message: "识别发言人（首次使用会下载 27 MB 声纹模型）…" });
    const r = await diarize.diarize({
      audioPath: src,
      modelDir: config.modelCacheDir(cfg),
      threshold: Number(threshold) || diarize.DEFAULT_THRESHOLD,
      numThreads: 4,
      onProgress: (p) => {
        const msg =
          p.phase === "downloading" ? `下载声纹模型 ${p.percent}%…` :
          p.phase === "decoding" ? "解码音频…" :
          p.phase === "diarizing" ? "识别说话人…" :
          p.phase === "labelling" ? "整理结果…" : "识别发言人…";
        send("pipeline", { phase: "diarizing", message: msg, progress: p.percent });
      },
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

    const record = diarize.saveSpeakers(dir, {
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

    send("pipeline", { phase: "done", message: `识别到 ${speakers.length} 个发言人`, dir });
    return { ok: true, speakers, chunks, segments: r.segments, source: path.basename(src), threshold: r.threshold };
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
  return { ok: true, profile, describe: powerMode.describe(profile), queue: readQueue().jobs };
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

app.whenReady().then(() => {
  createWindow();
  startLifecycleWatchdog();
  startPowerWatchers();
  startMeetingWatcher();
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
