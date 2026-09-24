"use strict";
const $ = (id) => document.getElementById(id);

/* Translation alias for i18n.js. It is loaded before this file; if it ever is
 * not, this degrades to the Chinese source string instead of throwing. */
const T = (key, vars) => (window.I18N && window.I18N.t ? window.I18N.t(key, vars) : key);

let cfg = null;
let recording = false;
let timerInt = null;
let t0 = 0;
let currentDir = null;
let lastResult = null; // { notes, notesZh, chunks }
let lastPipeline = ""; // last raw pipeline message from the backend (translated for display)
let meetingParticipants = []; // roster of the open meeting — rename suggestions only (diarization order != roster order, never auto-assign)

/* ---- tabs ---- */
for (const id of ["record", "import", "history", "models", "settings"]) {
  $(`tab-${id}`).addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
    $(`tab-${id}`).classList.add("active");
    $(`panel-${id}`).classList.add("active");
    if (id === "history") loadHistory();
    if (id === "models") { loadModels(); loadLlmProviders().then(fillLlmFields); }
  });
}

/* ---- model list ---- */
const MODELS = [
  "Xenova/whisper-tiny.en", "Xenova/whisper-tiny",
  "Xenova/whisper-base.en", "Xenova/whisper-base",
  "Xenova/whisper-small.en", "Xenova/whisper-small",
];
const modelSel = $("cfg-model");
MODELS.forEach((m) => {
  const o = document.createElement("option");
  o.value = m;
  o.textContent = m.replace("Xenova/whisper-", "");
  modelSel.appendChild(o);
});

/* ---- archive presets (single source of truth: src/audioArchive.js, over IPC) ---- */
let ARCHIVE_PRESETS = [];
const archiveSel = $("cfg-archive-preset");

async function loadArchivePresets() {
  let list = [];
  try {
    const r = await window.a2n.archivePresets();
    list = (r && r.presets) || [];
  } catch (e) {
    console.error("archivePresets IPC failed:", e); // never degrade silently
  }
  if (!list.length) {
    console.error("archivePresets returned nothing — falling back to the built-in default");
    list = [{ id: "opus-32", label: T("Opus 32 kbps 单声道（推荐）"), codec: "libopus", bitrateKbps: 32, bytesPerHour: 14400000 }];
  }
  ARCHIVE_PRESETS = list;
  archiveSel.innerHTML = "";
  for (const p of list) {
    const o = document.createElement("option");
    o.value = p.id;
    o.textContent = T("${…} — 约 ${…} MB/小时", { "${…1}": p.label, "${…2}": (p.bytesPerHour / 1e6).toFixed(1) });
    archiveSel.appendChild(o);
  }
}

function selectedPreset() {
  return ARCHIVE_PRESETS.find((p) => p.id === archiveSel.value) || ARCHIVE_PRESETS[0] || { codec: "libopus", bitrateKbps: 32 };
}
function presetIdFor(a) {
  const hit = ARCHIVE_PRESETS.find(
    (p) => p.codec === (a.codec || "libopus") && p.bitrateKbps === Number(a.bitrateKbps || 32)
  );
  if (hit) return hit.id;
  return archiveSel.options.length ? archiveSel.options[0].value : "";
}

/* ---- settings ---- */

/** Installed Ollama models: a text model is recommended, vision models are marked. */
async function loadOllamaModels() {
  const sel = $("cfg-ollama-model-pick");
  if (!sel) return;
  try {
    const r = await window.a2n.notesModels();
    if (!r || r.error) {
      sel.innerHTML = T("<option value=\"\">（读取失败：${…}）</option>", { "${…1}": esc((r && r.error) || "unknown") });
      return;
    }
    const cur = ($("cfg-ollama-model").value || "").trim();
    sel.innerHTML = T('<option value="">（自动选择：优先文本模型，跳过视觉模型）</option>');
    for (const m of r.models || []) {
      const o = document.createElement("option");
      o.value = m.name;
      const tags = [];
      if (m.name === r.recommended) tags.push(T("推荐"));
      if (m.vlm) tags.push(T("视觉模型，摘要质量通常更差"));
      o.textContent = m.name + (m.paramSize ? ` · ${m.paramSize}` : "") + (tags.length ? `（${tags.join("，")}）` : "");
      sel.appendChild(o);
    }
    if (cur) sel.value = cur;
  } catch (e) {
    sel.innerHTML = T("<option value=\"\">（读取失败：${…}）</option>", { "${…1}": e.message });
  }
}

const ollamaPick = $("cfg-ollama-model-pick");
if (ollamaPick) {
  ollamaPick.addEventListener("change", () => {
    if (ollamaPick.value) $("cfg-ollama-model").value = ollamaPick.value;
  });
}

async function loadConfig() {
  cfg = await window.a2n.getConfig();
  if (cfg.configError) {
    // never let a broken settings.json look like "your settings were applied"
    $("save-status").textContent = "⚠️ " + cfg.configError;
    $("save-status").classList.add("warn");
  }
  modelSel.value = MODELS.includes(cfg.whisper.model) ? cfg.whisper.model : MODELS[2];
  $("cfg-provider").value = cfg.notes.provider;
  $("cfg-detail").value = cfg.notes.detailLevel || "standard";
  $("cfg-ollama-url").value = cfg.notes.ollama.baseUrl;
  $("cfg-ollama-model").value = cfg.notes.ollama.model;
  await loadOllamaModels();
  $("cfg-openai-url").value = cfg.notes.openai.baseUrl;
  $("cfg-openai-key").value = cfg.notes.openai.apiKey;
  $("cfg-openai-model").value = cfg.notes.openai.model;
  $("cfg-meetings-dir").value = cfg.meetingsDir || "";

  const arch = (cfg.audio && cfg.audio.archive) || {};
  $("cfg-archive-enabled").checked = arch.enabled !== false;
  $("cfg-archive-keepwav").checked = !!arch.keepWav;
  archiveSel.value = presetIdFor(arch);

  const lc = cfg.lifecycle || {};
  const as = lc.autoStop || {};
  $("cfg-notify-done").checked = lc.notifyOnDone !== false;
  $("cfg-autoquit").value = String(typeof lc.autoQuitAfterMin === "number" ? lc.autoQuitAfterMin : 15);
  $("cfg-confirm-busy").checked = lc.confirmWhileBusy !== false;
  $("cfg-autostop").checked = as.enabled !== false;
  $("cfg-silence-min").value = typeof as.silenceMin === "number" ? as.silenceMin : 2;
  $("cfg-forcestop-min").value = typeof as.forceStopAfterMin === "number" ? as.forceStopAfterMin : 3;
  $("cfg-mindisk-gb").value = typeof as.minFreeDiskGB === "number" ? as.minFreeDiskGB : 2;

  const md = lc.meetingDetect || {};
  $("cfg-meetdetect").checked = md.enabled !== false;
  $("cfg-meetdetect-stop").checked = md.autoStop !== false;
  $("cfg-meetdetect-start").checked = !!md.autoStart;
  $("cfg-meetdetect-apps").value = (md.apps || []).join(", ");
  refreshMeetingStatus();

  $("cfg-translate-enabled").checked = !!cfg.translation.enabled;
  $("cfg-translate-transcript").checked = !!cfg.translation.transcript;
  $("cfg-translate-engine").value = cfg.translation.engine || "ollama";
  $("cfg-trans-ollama-url").value = cfg.translation.ollama.baseUrl;
  $("cfg-trans-ollama-model").value = cfg.translation.ollama.model;
  $("cfg-trans-openai-url").value = cfg.translation.openai.baseUrl;
  $("cfg-trans-openai-key").value = cfg.translation.openai.apiKey;
  $("cfg-trans-openai-model").value = cfg.translation.openai.model;
  toggleProvider();
  toggleTransEngine();
}

$("cfg-provider").addEventListener("change", toggleProvider);
function toggleProvider() {
  const p = $("cfg-provider").value;
  $("ollama-settings").hidden = p !== "ollama";
  $("openai-settings").hidden = p !== "openai";
}
$("cfg-translate-engine").addEventListener("change", toggleTransEngine);
function toggleTransEngine() {
  const e = $("cfg-translate-engine").value;
  $("trans-ollama-settings").hidden = e !== "ollama";
  $("trans-openai-settings").hidden = e !== "openai";
}

$("btn-save").addEventListener("click", async () => {
  const partial = {
    whisper: { model: modelSel.value },
    notes: {
      provider: $("cfg-provider").value,
      detailLevel: $("cfg-detail").value,
      ollama: { baseUrl: $("cfg-ollama-url").value.trim(), model: $("cfg-ollama-model").value.trim() },
      openai: {
        baseUrl: $("cfg-openai-url").value.trim(),
        apiKey: $("cfg-openai-key").value.trim(),
        model: $("cfg-openai-model").value.trim(),
      },
    },
    translation: {
      enabled: $("cfg-translate-enabled").checked,
      transcript: $("cfg-translate-transcript").checked,
      engine: $("cfg-translate-engine").value,
      ollama: { baseUrl: $("cfg-trans-ollama-url").value.trim(), model: $("cfg-trans-ollama-model").value.trim() },
      openai: {
        baseUrl: $("cfg-trans-openai-url").value.trim(),
        apiKey: $("cfg-trans-openai-key").value.trim(),
        model: $("cfg-trans-openai-model").value.trim(),
      },
    },
    meetingsDir: $("cfg-meetings-dir").value.trim(),
    audio: {
      archive: {
        enabled: $("cfg-archive-enabled").checked,
        codec: selectedPreset().codec,
        bitrateKbps: selectedPreset().bitrateKbps,
        keepWav: $("cfg-archive-keepwav").checked,
      },
    },
    lifecycle: {
      notifyOnDone: $("cfg-notify-done").checked,
      autoQuitAfterMin: Number($("cfg-autoquit").value),
      confirmWhileBusy: $("cfg-confirm-busy").checked,
      autoStop: {
        enabled: $("cfg-autostop").checked,
        silenceMin: Number($("cfg-silence-min").value) || 2,
        forceStopAfterMin: Number($("cfg-forcestop-min").value) || 3,
        minFreeDiskGB: Number($("cfg-mindisk-gb").value) || 0,
      },
      meetingDetect: {
        enabled: $("cfg-meetdetect").checked,
        autoStop: $("cfg-meetdetect-stop").checked,
        autoStart: $("cfg-meetdetect-start").checked,
        apps: $("cfg-meetdetect-apps").value
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      },
    },
  };
  cfg = await window.a2n.setConfig(partial);
  $("save-status").textContent = "Saved ✓";
  setTimeout(() => ($("save-status").textContent = ""), 2500);
  await window.a2n.lifecycleTouch();
  loadDevices();
});

/* ---- archive: scan / run ------------------------------------------------ */
function fmtBytes(n) {
  if (!n && n !== 0) return "—";
  if (n >= 1e9) return (n / 1e9).toFixed(2) + " GB";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + " MB";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + " KB";
  return n + " B";
}

$("btn-archive-scan").addEventListener("click", async () => {
  const btn = $("btn-archive-scan");
  btn.disabled = true;
  $("archive-scan-status").textContent = T("扫描中…");
  $("archive-dirlist").innerHTML = "";
  try {
    const s = await window.a2n.archiveScan();
    if (!s || s.error) {
      $("archive-scan-status").textContent = T("扫描失败：") + ((s && s.error) || "unknown");
      return;
    }
    if (!s.fileCount) {
      $("archive-scan-status").textContent = T("没有找到 WAV 文件（可能已经压缩过了）。");
      return;
    }
    $("archive-scan-status").textContent =
      T("${…} 个 WAV · ${…} → 预计 ${…}", { "${…1}": s.fileCount, "${…2}": fmtBytes(s.totalBytes), "${…3}": fmtBytes(s.estimatedBytesAfter) }) +
      T("（可回收 ${…}，按 ${…}）", { "${…1}": fmtBytes(s.estimatedSavedBytes), "${…2}": s.preset.label });
    const rows = s.dirs
      .sort((a, b) => b.totalBytes - a.totalBytes)
      .map(
        (d) =>
          T("<div class=\"dirrow\"><span>${…}</span><span>${…} 个 · ${…} → ${…}</span></div>", { "${…1}": esc(d.name), "${…2}": d.files.length, "${…3}": fmtBytes(d.totalBytes), "${…4}": fmtBytes( d.estimatedBytesAfter ) })
      );
    $("archive-dirlist").innerHTML = rows.join("");
    $("btn-archive-run").disabled = false;
  } finally {
    btn.disabled = false;
  }
});

$("btn-archive-run").addEventListener("click", async () => {
  const ok = confirm(
    T("将把会议目录里的 WAV 转成压缩音频，并在校验通过后删除原始 WAV。") + "\n" +
      T("此操作对原始 WAV 不可撤销（转写结果 unaffected）。确定继续？")
  );
  if (!ok) return;
  const btn = $("btn-archive-run");
  btn.disabled = true;
  $("btn-archive-scan").disabled = true;
  $("archive-scan-status").textContent = T("压缩中…");
  try {
    const r = await window.a2n.archiveRun();
    if (!r || r.error) {
      $("archive-scan-status").textContent = T("失败：") + ((r && r.error) || "unknown");
      return;
    }
    const fail = (r.errors || []).length;
    $("archive-scan-status").textContent =
      T("已完成 ✓ 压缩 ${…} 个文件，回收 ${…}", { "${…1}": r.files.length, "${…2}": fmtBytes(r.savedBytes) }) +
      `（${fmtBytes(r.before)} → ${fmtBytes(r.after)}）` +
      (fail ? T(" · ${…} 个失败（原文件已保留）", { "${…1}": fail }) : "");
    const rows = (r.dirs || [])
      .filter((d) => d.files.length || d.errors.length)
      .map(
        (d) =>
          T("<div class=\"dirrow\"><span>${…}</span><span>${…} 个 · 回收 ${…}${…}</span></div>", { "${…1}": esc(d.name), "${…2}": d.files.length, "${…3}": fmtBytes( d.savedBytes ), "${…4}": d.errors.length ? T(" · ${…} 失败", { "${…1}": d.errors.length }) : "" })
      );
    $("archive-dirlist").innerHTML = rows.join("");
    $("btn-archive-run").disabled = true; // re-scan before running again
  } finally {
    $("btn-archive-scan").disabled = false;
  }
});

window.a2n.onArchive((p) => {
  $("archive-scan-status").textContent = p.message || T("压缩中…");
});

$("btn-choose-dir").addEventListener("click", async () => {
  const dir = await window.a2n.chooseDir();
  if (dir) $("cfg-meetings-dir").value = dir;
});

/* ---- devices ---- */
async function loadDevices() {
  const box = $("devices");
  const d = await window.a2n.listDevices();
  if (!d || d.error) {
    box.innerHTML = `<div class="hint">Could not enumerate devices: ${esc((d && d.error) || "unknown")}</div>`;
    return;
  }
  const ul = (list) =>
    `<ul>${list.length ? list.map((x) => `<li>${esc(x.name)}</li>`).join("") : "<li>(none found)</li>"}</ul>`;
  box.innerHTML = `
    <b>System audio (default device is recorded):</b>${ul(d.system)}
    <b>Microphones (default device is recorded):</b>${ul(d.mic)}`;
}
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* ---- recording ---- */
async function startRecording(autoApp) {
  if (recording) return;
  const res = await window.a2n.startRecord({
    system: $("src-system").checked,
    mic: $("src-mic").checked,
  });
  if (res.error) {
    $("record-status").textContent = "Error: " + res.error;
    return;
  }
  recording = true;
  currentDir = res.dir;
  hideLifecycleBanner();
  window.a2n.lifecycleTouch();
  $("btn-record").disabled = true;
  $("btn-stop").disabled = false;
  $("record-status").textContent = autoApp
    ? T("● 检测到 ${…} 在播放声音，已自动开始录音…", { "${…1}": autoApp })
    : "Recording… (file: " + res.dir + ")";
  $("pipeline").textContent = "Recording in progress…";
  setProgress(0);
  t0 = Date.now();
  timerInt = setInterval(() => {
    const s = Math.floor((Date.now() - t0) / 1000);
    $("timer").textContent = `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  }, 500);
  startMicWatchdog();
}

/* ---- microphone silence watchdog ----------------------------------------
 * WHY: the app records whatever Windows has as the default input device, and if that
 * device is muted — a USB headset's hardware switch, another app holding it
 * exclusively — the recording is pure silence with NO error anywhere. Observed on this
 * machine: a 10-minute meeting whose mic track was 0.7 % active, discovered only
 * afterwards. The level meter was already on screen; nothing acted on it.
 *
 * A pause in speech must NOT trigger this, so it looks for "never once got above the
 * noise floor" over a sustained window rather than "silent right now". The rule itself
 * lives in renderer/trackQuality.js so it is unit-testable without a DOM. */
const TQ = window.trackQuality || { MIC_WATCHDOG_WINDOW_SEC: 10, MIC_LEVEL_FLOOR: 8, micLooksDead: () => false, isSilentTrack: () => false, pickableNames: () => [] };
const MIC_WATCHDOG_WINDOW = TQ.MIC_WATCHDOG_WINDOW_SEC;
const MIC_LEVEL_FLOOR = TQ.MIC_LEVEL_FLOOR;
let micWatchTimer = null;
let micLoudSamples = 0;
let micTotalSamples = 0;

function stopMicWatchdog() {
  if (micWatchTimer) { clearInterval(micWatchTimer); micWatchTimer = null; }
}

function startMicWatchdog() {
  stopMicWatchdog();
  micLoudSamples = 0;
  micTotalSamples = 0;
  micWatchTimer = setInterval(() => {
    if (!recording) { stopMicWatchdog(); return; }
    if (!TQ.micLooksDead(micTotalSamples, micLoudSamples)) return;
    const note = T("⚠️ 麦克风一直没有声音——检查默认输入设备或耳机上的静音开关");
    if (!$("record-status").textContent.includes(note)) {
      $("record-status").textContent += " · " + note;
    }
    stopMicWatchdog(); // report once; a persistent nag would be worse than useless
  }, 1000);
}

$("btn-record").addEventListener("click", () => startRecording(null));

/* ---- meeting-app detection events (WASAPI sessions) --------------------- */
if (window.a2n.onMeeting) {
  window.a2n.onMeeting((e) => {
    if (!e) return;
    if (e.type === "auto-start-request") {
      if (!recording) startRecording(e.app);
    } else if (e.type === "auto-stop-request") {
      if (recording) {
        $("pipeline").textContent = T("会议软件已停止播放声音，自动停止录音…");
        stopAndProcess("meeting-app");
      }
    }
  });
}

/** Stop & process. Also used by the lifecycle auto-stop (silence / disk full). */
async function stopAndProcess(reason) {
  if (!recording) return;
  $("btn-stop").disabled = true;
  $("btn-record").disabled = true;
  $("record-status").textContent =
    reason === "silence" ? T("长时间无人声，自动停止并处理…")
    : reason === "disk" ? T("磁盘空间不足，自动停止并处理…")
    : reason === "meeting-app" ? T("会议软件已停止播放声音，自动停止并处理…")
    : "Stopping…";
  $("pipeline").textContent = "Finalizing recording…";
  hideLifecycleBanner();
  const res = await window.a2n.stopRecord(reason); // forward the stop reason verbatim (main maps anything unrecognized itself)
  clearInterval(timerInt);
  recording = false;
  stopMicWatchdog(); // no watchdog may outlive the recording
  $("btn-record").disabled = false;
  if (res.error) {
    $("record-status").textContent = "Error: " + res.error;
    $("pipeline").textContent = "Failed.";
    return;
  }
  if (res.queued) {
    // defer mode: nothing was transcribed yet, the audio is compressed and queued
    currentDir = res.dir;
    const saved = res.archive && res.archive.savedBytes ? T("，音频已压缩回收 ${…}", { "${…1}": fmtBytes(res.archive.savedBytes) }) : "";
    $("record-status").textContent = T("⏸ 已排队（续航优先模式）${…} —— 插电后自动转写，也可以点「立即处理」。", { "${…1}": saved });
    $("pipeline").textContent = T("已排队，等待电源。");
    loadPower();
    window.a2n.lifecycleTouch();
    return;
  }
  $("record-status").textContent = "Done ✓ saved to " + res.dir;
  currentDir = res.dir;
  if (res.archive && res.archive.savedBytes) {
    $("record-status").textContent += T(" · 音频已压缩（${…} kbps），回收 ${…}", { "${…1}": res.archive.bitrateKbps, "${…2}": fmtBytes(res.archive.savedBytes) });
  }
  if (res.archiveError) {
    $("record-status").textContent += T(" · ⚠️ 音频压缩失败：${…}（原始 WAV 已保留）", { "${…1}": res.archiveError });
  }
  showResult(res);
  window.a2n.lifecycleTouch();
}

$("btn-stop").addEventListener("click", () => stopAndProcess("manual"));

/* ---- lifecycle: silence warning, auto-stop, low disk --------------------
 * The banner is NEVER hidden when the silence ends: the 「继续录音」 button lives
 * inside it, so hiding it would take away the user's ONLY way to cancel a pending
 * auto-stop. It stays visible once shown and only its TEXT changes state:
 *   silence warning -> counted-down "Y 秒后将自动停止…"
 *   silence cleared -> "声音已恢复，仍在监控。"
 *   keep-alive      -> "已取消本次自动停止，直到再次长时间无声。"
 * The warning text used to be a frozen snapshot ("N 秒后" that never moved,
 * because main only re-pushed on a NEW warning and any sound reset silentSec to
 * 0), so the countdown is recomputed once a second from an absolute deadline. */
let bannerTimer = null;   // the 1 s countdown ticker (never more than one)
let bannerDeadline = 0;   // epoch ms at which main will force-stop

function hideLifecycleBanner() {
  const b = $("lifecycle-banner");
  if (b) b.hidden = true;
  stopSilenceCountdown(); // no leaked interval once the banner is gone
}

function showLifecycleBanner(text) {
  const b = $("lifecycle-banner");
  if (!b) return;
  $("lifecycle-text").textContent = text;
  b.hidden = false;
}

function stopSilenceCountdown() {
  if (bannerTimer) {
    clearInterval(bannerTimer);
    bannerTimer = null;
  }
}

/** Paint the silence warning; `forceInSec` is re-synced on EVERY push from main
 *  (every 15 s while the silence continues), so the deadline can never sit
 *  stale for the rest of the recording. */
function showSilenceCountdown(silentSec, forceInSec) {
  const b = $("lifecycle-banner");
  if (!b) return;
  const mins = Math.floor((Number(silentSec) || 0) / 60);
  bannerDeadline = Date.now() + (Number(forceInSec) || 0) * 1000;
  const paint = () => {
    const left = Math.max(0, Math.round((bannerDeadline - Date.now()) / 1000));
    $("lifecycle-text").textContent =
      T("已 ${…} 分钟没有声音。${…} 秒后将自动停止并生成笔记（录音仍在继续）。", { "${…1}": mins, "${…2}": left });
  };
  b.hidden = false;
  paint();
  stopSilenceCountdown(); // one ticker only
  bannerTimer = setInterval(paint, 1000);
}

if (window.a2n.onLifecycle) {
  window.a2n.onLifecycle((e) => {
    if (!e) return;
    if (e.type === "silence-warning") {
      showSilenceCountdown(e.silentSec, e.forceInSec);
    } else if (e.type === "silence-cleared") {
      // keep the banner (and its keep-alive button), drop only the countdown
      stopSilenceCountdown();
      showLifecycleBanner(T("声音已恢复，仍在监控。"));
    } else if (e.type === "auto-stop-request" || e.type === "stop-request") {
      if (recording) stopAndProcess(e.reason);
    } else if (e.type === "disk-low") {
      stopSilenceCountdown();
      showLifecycleBanner(T("磁盘剩余 ${…} GB（低于 ${…} GB），已停止录音以免写满。", { "${…1}": e.freeGB.toFixed(1), "${…2}": e.limitGB }));
    }
  });
}

const keepAliveBtn = $("btn-keepalive");
if (keepAliveBtn) {
  keepAliveBtn.addEventListener("click", async () => {
    await window.a2n.lifecycleKeepAlive();
    // do NOT hide the banner here: the button the user just pressed is inside it
    stopSilenceCountdown();
    showLifecycleBanner(T("已取消本次自动停止，直到再次长时间无声。"));
    $("record-status").textContent = T("继续录音（已取消自动停止，直到再次长时间无声）。");
  });
}

/* ---- import ---- */
$("btn-pick").addEventListener("click", async () => {
  const f = await window.a2n.pickFile({});
  if (!f) return;
  $("import-status").textContent = "Transcribing " + f + "…";
  setProgress(0);
  const res = await window.a2n.transcribeFile(f);
  if (res.error) {
    $("import-status").textContent = "Error: " + res.error;
    $("pipeline").textContent = "Failed.";
    return;
  }
  $("import-status").textContent = "Done ✓";
  currentDir = res.dir;
  if (res.archive && res.archive.imported) {
    // the original file was never copied — do not imply that space was reclaimed
    $("import-status").textContent += T(" · 会议目录只存压缩副本（${…}），原文件仍在你原来的位置（${…}）", { "${…1}": fmtBytes(res.archive.archivedBytes), "${…2}": fmtBytes( res.archive.sourceBytes ) });
  } else if (res.archive && res.archive.savedBytes) {
    $("import-status").textContent += T(" · 音频已压缩，回收 ${…}", { "${…1}": fmtBytes(res.archive.savedBytes) });
  }
  if (res.archiveError) {
    $("import-status").textContent += T(" · ⚠️ 压缩副本生成失败：${…}", { "${…1}": res.archiveError });
  }
  showResult(res);
});

/* ---- meeting-app detection status --------------------------------------- */
async function refreshMeetingStatus() {
  const el = $("meetdetect-status");
  if (!el) return;
  try {
    const st = await window.a2n.meetingStatus();
    const n = (st.sessions || []).length;
    el.textContent = st.activeApp
      ? T("检测到 ${…} 正在播放声音", { "${…1}": st.activeApp })
      : T("当前没有会议软件在播放声音（监听 ${…} 个音频会话）", { "${…1}": n });
  } catch (e) {
    console.error("meetingStatus IPC failed:", e);
    el.textContent = T("会议软件检测不可用：") + e.message;
  }
}
setInterval(refreshMeetingStatus, 20000);

/* ---- history: reopen a meeting recorded earlier ------------------------- */
async function loadHistory() {
  const box = $("history-list");
  if (!box) return;
  box.innerHTML = T('<div class="hint">读取中…</div>');
  try {
    const r = await window.a2n.meetingsList();
    if (!r || r.error) {
      box.innerHTML = T("<div class=\"hint\">读取失败：${…}</div>", { "${…1}": esc((r && r.error) || "unknown") });
      return;
    }
    if (!r.items.length) {
      box.innerHTML = T('<div class="hint">还没有可打开的会议（录音或导入一次就会出现）。</div>');
      return;
    }
    box.innerHTML = "";
    for (const it of r.items) {
      const row = document.createElement("div");
      row.className = "dirrow";
      const left = document.createElement("span");
      left.textContent = it.name;
      const right = document.createElement("span");
      const bits = [];
      if (it.durationSec) bits.push(T("${…} 分钟", { "${…1}": Math.round(it.durationSec / 60) }));
      if (it.hasSpeakers) bits.push(T("有发言人"));
      if (it.hasAudio) bits.push(T("音频可试听"));
      bits.push(fmtBytes(it.bytes));
      if (it.notesFallbackReason) bits.push(T("⚠️ 笔记降级"));
      right.textContent = bits.join(" · ");
      const open = document.createElement("button");
      open.className = "ghost";
      open.textContent = T("打开");
      open.addEventListener("click", () => openMeeting(it.dir));
      const spacer = document.createElement("span");
      spacer.style.flex = "1";
      row.append(left, spacer, right, open);
      box.appendChild(row);
    }
    $("history-status").textContent = T("${…} 个会议 · ${…}", { "${…1}": r.items.length, "${…2}": r.root });
  } catch (e) {
    console.error("meetingsList IPC failed:", e);
    box.innerHTML = T("<div class=\"hint\">读取失败：${…}</div>", { "${…1}": esc(e.message) });
  }
}

async function openMeeting(dir) {
  $("history-status").textContent = T("打开中…");
  const r = await window.a2n.meetingsOpen({ dir });
  if (r.error) {
    $("history-status").textContent = T("打开失败：") + r.error;
    return;
  }
  currentDir = r.dir;
  // reuse the normal result view (it also loads the 发言人 panel for this dir)
  showResult({
    notes: r.notes || T("(这个会议没有 notes.md)"),
    notesZh: r.notesZh || null,
    chunks: r.chunks || [],
    provider: r.provider || "",
    notesFallbackReason: r.notesFallbackReason || null,
  });
  // this meeting's roster becomes the name suggestions in the 发言人 rename inputs
  meetingParticipants = r.participants || [];
  $("tab-record").click();
  $("record-status").textContent = T("已打开历史会议：") + dir;
  $("history-status").textContent = T("已打开：") + dir;
}

const histRefresh = $("btn-history-refresh");
if (histRefresh) histRefresh.addEventListener("click", loadHistory);

/* ---- models & interfaces ------------------------------------------------ */
let modelsState = null;
let modelBusy = null; // { kind, id, message } while downloading/deleting

function modelRow(left, state, buttons) {
  const row = document.createElement("div");
  row.className = "dirrow";
  const l = document.createElement("span");
  l.textContent = left;
  const s = document.createElement("span");
  s.className = "spk-meta";
  s.textContent = state;
  row.append(l, s, ...buttons);
  return row;
}

async function loadModels() {
  try {
    modelsState = await window.a2n.modelsStatus();
  } catch (e) {
    console.error("modelsStatus IPC failed:", e);
    $("models-status").textContent = T("模型状态读取失败：") + e.message;
    return;
  }
  const st = modelsState;
  $("cfg-model-endpoint").value = st.endpoint || "";
  $("cfg-auto-download").checked = st.autoDownload !== false;
  $("models-total").textContent = T("已占用 ${…}", { "${…1}": fmtBytes(st.totalBytes) });

  const box = $("whisper-rows");
  box.innerHTML = "";
  for (const w of st.whisper) {
    const busy = modelBusy && modelBusy.kind === "whisper" && modelBusy.id === w.id;
    const state = busy
      ? modelBusy.message || T("下载中…")
      : w.ready
        ? T("已下载 ${…}${…}", { "${…1}": fmtBytes(w.bytes), "${…2}": w.current ? T(" · 当前使用") : "" })
        : T("未下载（约 ${…} MB）${…}", { "${…1}": w.approxMB, "${…2}": w.current ? T(" · 当前使用") : "" });

    const use = document.createElement("button");
    use.className = "ghost";
    use.textContent = w.current ? T("使用中") : T("使用");
    use.disabled = !!w.current || !!modelBusy;
    use.title = T("把这个档位设为转写模型");
    use.addEventListener("click", async () => {
      await window.a2n.setConfig({ whisper: { model: w.id } });
      await loadConfig();
      await loadModels();
    });

    const act = document.createElement("button");
    act.className = w.ready ? "ghost" : "primary";
    act.textContent = w.ready ? T("删除") : T("下载");
    act.disabled = !!modelBusy;
    act.addEventListener("click", async () => {
      if (w.ready) {
        if (!confirm(T("删除 ${…}？下次使用会需要重新下载。", { "${…1}": w.short }))) return;
        modelBusy = { kind: "whisper", id: w.id, message: T("删除中…") };
        await loadModels();
        const r = await window.a2n.modelsDelete({ kind: "whisper", id: w.id });
        modelBusy = null;
        $("models-status").textContent = r.error ? T("删除失败：") + r.error : T("已删除 ${…}", { "${…1}": w.short });
      } else {
        modelBusy = { kind: "whisper", id: w.id, message: T("准备下载…") };
        await loadModels();
        const r = await window.a2n.modelsDownload({ kind: "whisper", id: w.id });
        modelBusy = null;
        $("models-status").textContent = r.error ? T("下载失败：") + r.error : T("${…} 下载完成（${…}）", { "${…1}": w.short, "${…2}": fmtBytes(r.bytes) });
      }
      await loadModels();
    });
    box.appendChild(modelRow(w.label, state, [use, act]));
  }

  const sbox = $("speaker-model-rows"); // this is the 模型与接口 card — its old duplicated id was the first match of the meeting panel's
  sbox.innerHTML = "";
  const vp = st.voiceprint;
  const vBusy = modelBusy && modelBusy.kind === "voiceprint";
  const vState = vBusy
    ? modelBusy.message || T("下载中…")
    : vp.downloaded
      ? T("已下载 ${…}", { "${…1}": fmtBytes(vp.bytes) })
      // the model ships INSIDE the app, so "not downloaded" would be misleading:
      // the copy that actually loads is the bundled one.
      : vp.ready
        ? T("已随程序分发 ${…}（无需下载）", { "${…1}": fmtBytes(vp.bytes) })
        : T("未下载（约 ${…} MB）——「识别发言人」也需要它", { "${…1}": vp.approxMB });
  const vAct = document.createElement("button");
  vAct.className = vp.downloaded ? "ghost" : "primary";
  vAct.textContent = vp.downloaded ? T("删除") : T("下载");
  vAct.disabled = !!modelBusy;
  vAct.addEventListener("click", async () => {
    if (vp.downloaded) {
      if (!confirm(T("删除已下载的声纹模型？程序内置的那份仍然可用，识别发言人不会中断。"))) return;
      modelBusy = { kind: "voiceprint", message: T("删除中…") };
      await loadModels();
      const r = await window.a2n.modelsDelete({ kind: "voiceprint" });
      modelBusy = null;
      $("models-status").textContent = r.error ? T("删除失败：") + r.error : T("已删除已下载的声纹模型（继续使用内置那份）");
    } else {
      modelBusy = { kind: "voiceprint", message: T("准备下载…") };
      await loadModels();
      const r = await window.a2n.modelsDownload({ kind: "voiceprint" });
      modelBusy = null;
      $("models-status").textContent = r.error ? T("下载失败：") + r.error : T("声纹模型下载完成（${…}）", { "${…1}": fmtBytes(r.bytes) });
    }
    await loadModels();
  });
  sbox.appendChild(modelRow(T("声纹模型（3D-Speaker CAM++ 中英）"), vState, [vAct]));
  sbox.appendChild(
    modelRow(
      T("声纹分割模型（随程序分发）"),
      st.segmentation.ready ? T("已随包 ${…}", { "${…1}": fmtBytes(st.segmentation.bytes) }) : T("缺失（打包异常）"),
      []
    )
  );
}

const saveEndpointBtn = $("btn-save-endpoint");
if (saveEndpointBtn) {
  saveEndpointBtn.addEventListener("click", async () => {
    const r = await window.a2n.modelsSetEndpoint({
      endpoint: $("cfg-model-endpoint").value.trim(),
      autoDownload: $("cfg-auto-download").checked,
    });
    $("models-status").textContent = r.error ? T("保存失败：") + r.error : T("已保存下载地址：${…}", { "${…1}": r.endpoint });
  });
}
const autoDl = $("cfg-auto-download");
if (autoDl) {
  autoDl.addEventListener("change", async () => {
    const r = await window.a2n.modelsSetEndpoint({ autoDownload: autoDl.checked });
    $("models-status").textContent = r.error
      ? T("保存失败：") + r.error
      : autoDl.checked ? T("缺模型时将自动下载。") : T("缺模型时将直接报错，不再自动下载。");
  });
}
const openModelsBtn = $("btn-open-models");
if (openModelsBtn) openModelsBtn.addEventListener("click", () => window.a2n.modelsOpenDir());

/* ---- LLM interface test ------------------------------------------------- */
let llmPresets = [];

async function loadLlmProviders() {
  try {
    const r = await window.a2n.llmProviders();
    llmPresets = r.providers || [];
    const sel = $("llm-preset");
    sel.innerHTML = "";
    for (const p of llmPresets) {
      const o = document.createElement("option");
      o.value = p.id;
      o.textContent = p.label + (p.probe ? `　[${p.probe}]` : "");
      sel.appendChild(o);
    }
    sel.value = r.matched || (r.current.provider === "ollama" ? "ollama" : "custom");
  } catch (e) {
    console.error("llmProviders IPC failed:", e);
  }
}

/** Selecting a preset fills the address, the key-field state and model hints. */
function applyLlmPreset(id) {
  const p = llmPresets.find((x) => x.id === id);
  if (!p) return;
  $("llm-provider").value = p.style === "ollama" ? "ollama" : "openai";
  $("llm-baseurl").value = p.baseUrl || "";
  $("llm-model-suggest").innerHTML = (p.models || []).map((m) => `<option value="${esc(m)}"></option>`).join("");
  if ((p.models || []).length && !$("llm-model").value.trim()) $("llm-model").value = p.models[0];
  $("llm-apikey").disabled = p.style === "ollama";
  $("llm-preset-note").textContent =
    (p.note || "") +
    (p.probe ? T("　（本机探测：${…}）", { "${…1}": p.probe }) : "") +
    ((p.models || []).length ? T(" 示例模型可能已更新，点「测试连接」可拉取真实列表。") : "");
}

const llmPresetSel = $("llm-preset");
if (llmPresetSel) {
  llmPresetSel.addEventListener("change", () => {
    applyLlmPreset(llmPresetSel.value);
    $("llm-test-status").textContent = "";
    $("llm-model-list").innerHTML = "";
  });
}

function fillLlmFields() {
  if (!cfg) return;
  $("llm-provider").value = cfg.notes.provider === "openai" ? "openai" : "ollama";
  const isO = $("llm-provider").value === "ollama";
  $("llm-baseurl").value = isO ? cfg.notes.ollama.baseUrl : cfg.notes.openai.baseUrl;
  $("llm-apikey").value = isO ? "" : cfg.notes.openai.apiKey;
  $("llm-model").value = isO ? cfg.notes.ollama.model : cfg.notes.openai.model;
  $("llm-apikey").disabled = isO;
}

const llmProvider = $("llm-provider");
if (llmProvider) llmProvider.addEventListener("change", fillLlmFields);

const llmTestBtn = $("btn-llm-test");
if (llmTestBtn) {
  llmTestBtn.addEventListener("click", async () => {
    llmTestBtn.disabled = true;
    $("llm-test-status").classList.remove("warn");
    $("llm-test-status").textContent = T("测试中…");
    $("llm-model-list").innerHTML = "";
    try {
      const r = await window.a2n.llmTest({
        provider: $("llm-provider").value,
        baseUrl: $("llm-baseurl").value.trim(),
        apiKey: $("llm-apikey").value.trim(),
        model: $("llm-model").value.trim(),
      });
      if (!r.ok) {
        $("llm-test-status").textContent = T("✗ 连接失败：${…}${…}", { "${…1}": r.error, "${…2}": r.ms ? `（${r.ms}ms）` : "" });
        $("llm-test-status").classList.add("warn");
        return;
      }
      const warn = r.modelPresent === false ? T(" ⚠️ 填写的模型不在已安装列表里") : "";
      $("llm-test-status").textContent = `✓ ${r.note}（${r.ms}ms）${warn}`;
      if (r.modelPresent === false) $("llm-test-status").classList.add("warn");
      if (r.models && r.models.length) {
        $("llm-model-list").innerHTML = r.models
          .slice(0, 30)
          .map((m) => T("<div class=\"dirrow\"><span>${…}</span><button class=\"ghost pick\" data-m=\"${…}\">用这个</button></div>", { "${…1}": esc(m) }))
          .join("");
        for (const b of $("llm-model-list").querySelectorAll("button.pick")) {
          b.addEventListener("click", () => { $("llm-model").value = b.dataset.m; });
        }
      }
    } finally {
      llmTestBtn.disabled = false;
    }
  });
}

const llmSaveBtn = $("btn-llm-save");
if (llmSaveBtn) {
  llmSaveBtn.addEventListener("click", async () => {
    const provider = $("llm-provider").value;
    const partial = { notes: { provider } };
    if (provider === "ollama") {
      partial.notes.ollama = { baseUrl: $("llm-baseurl").value.trim(), model: $("llm-model").value.trim() };
    } else {
      partial.notes.openai = {
        baseUrl: $("llm-baseurl").value.trim(),
        apiKey: $("llm-apikey").value.trim(),
        model: $("llm-model").value.trim(),
      };
    }
    await window.a2n.setConfig(partial);
    await loadConfig();
    $("llm-test-status").classList.remove("warn");
    $("llm-test-status").textContent = T("✓ 已保存为笔记接口");
  });
}

if (window.a2n.onModels) {
  window.a2n.onModels((p) => {
    if (!p || !modelBusy || p.kind !== modelBusy.kind) return;
    modelBusy.message =
      p.message || (p.percent != null ? T("下载中 ${…}%${…}", { "${…1}": p.percent, "${…2}": p.file ? " · " + String(p.file).split("/").pop() : "" }) : T("下载中…"));
    if (modelsState) loadModels();
  });
}

/* ---- power modes + deferred queue --------------------------------------- */
let powerState = null;

async function loadPower() {
  try {
    powerState = await window.a2n.powerStatus();
    renderPower();
  } catch (e) {
    console.error("powerStatus IPC failed:", e); // never degrade silently
    const el = $("power-status");
    if (el) el.textContent = T("电源模式读取失败：") + e.message;
  }
}

function renderPower() {
  if (!powerState) return;
  const st = powerState;
  const box = $("power-modes");
  if (box && !box.dataset.built) {
    for (const m of st.modes || []) {
      const b = document.createElement("button");
      b.dataset.mode = m.id;
      b.dataset.label = m.label || "";
      b.dataset.desc = m.desc || "";
      b.dataset.icon = m.icon || "";
      b.textContent = b.dataset.icon + " " + (window.I18N ? window.I18N.resolve(b.dataset.label) : b.dataset.label);
      b.title = window.I18N ? window.I18N.resolve(b.dataset.desc) : b.dataset.desc;
      b.addEventListener("click", async () => {
        const r = await window.a2n.powerSetMode({ mode: m.id });
        powerState = { ...powerState, profile: r.profile, requested: m.id, describe: r.describe, queue: r.queue };
        renderPower();
      });
      box.appendChild(b);
    }
    box.dataset.built = "1";
  }
  if (box) {
    for (const b of box.querySelectorAll("button")) {
      b.classList.toggle("active", b.dataset.mode === st.requested);
      // labels come from the backend in Chinese: re-resolve them on every pass so a
      // language switch updates these chips too
      b.textContent = b.dataset.icon + " " + (window.I18N ? window.I18N.resolve(b.dataset.label) : b.dataset.label);
      b.title = window.I18N ? window.I18N.resolve(b.dataset.desc) : b.dataset.desc;
    }
  }
  const pref = $("power-batt-pref");
  if (pref) {
    pref.value = st.batteryPreference || "eco";
    pref.hidden = st.requested !== "auto";
  }
  const p = st.profile || {};
  /* EVERY line here comes from the MAIN process (powerMode.js), so each has to go
   * through I18N.resolve() — t() would be wrong because these are raw backend
   * strings, not dictionary keys the renderer chose.
   *
   * The badge itself used to be one pre-joined " · " line (describe), which NO
   * dictionary key can match, so it rendered Chinese in the English UI — that is the
   * "引擎: CPU" in the reported screenshot. describeParts supplies the pieces
   * instead; fall back to the joined string if an older backend sends only that. */
  const R = (s) => (window.I18N && s ? window.I18N.resolve(s) : s);
  const dp = st.describeParts;
  const badge = dp
    ? [dp.label, `${R(dp.enginePrefix)}${R(dp.engine)}`, `${R(dp.modelPrefix)}${R(dp.model)}`, R(dp.runNow)]
        .map(R)
        .join(" · ")
    : R(st.describe || "");
  const lines = [T("${…} · ${…}", { "${…1}": st.onBattery ? T("🔋 电池供电") : T("🔌 插电"), "${…2}": badge })];
  if (p.engine && p.engine.reason) lines.push("⚠️ " + R(p.engine.reason));
  if (p.notes && p.notes.length) lines.push(...p.notes.map((n) => "· " + R(n)));
  const el = $("power-status");
  el.textContent = lines.join("\n");
  el.style.whiteSpace = "pre-line";

  const jobs = st.queue || [];
  $("queue-box").hidden = jobs.length === 0;
  if (jobs.length) {
    $("queue-list").innerHTML = jobs
      .map(
        (j) =>
          T("<div class=\"dirrow\"><span>${…}</span><span>${…}${…}${…}</span></div>", { "${…1}": esc(String(j.dir).split(/[\\/]/).pop()), "${…2}": j.durationSec ? Math.round(j.durationSec / 60) + T(" 分钟 · ") : "", "${…3}": esc(R(j.reason || "")), "${…4}": j.attempts ? T(" · 重试 ") + j.attempts : "" })
      )
      .join("");
    $("btn-queue-run").textContent = st.queueRunning ? T("处理中…") : T("立即处理");
    $("btn-queue-run").disabled = !!st.queueRunning;
  }
}

const battPref = $("power-batt-pref");
if (battPref) {
  battPref.addEventListener("change", async () => {
    const r = await window.a2n.powerSetMode({ batteryPreference: battPref.value });
    powerState = { ...powerState, batteryPreference: battPref.value, describe: r.describe, profile: r.profile };
    renderPower();
  });
}
const queueRunBtn = $("btn-queue-run");
if (queueRunBtn) {
  queueRunBtn.addEventListener("click", async () => {
    queueRunBtn.disabled = true;
    queueRunBtn.textContent = T("处理中…");
    await window.a2n.queueRunNow();
    await loadPower();
  });
}
if (window.a2n.onPower) window.a2n.onPower(() => loadPower());
if (window.a2n.onQueue) {
  window.a2n.onQueue((e) => {
    if (e && e.type === "start") {
      $("pipeline").textContent = T("处理排队会议：${…}…", { "${…1}": String(e.dir).split(/[\\/]/).pop() });
    }
    loadPower();
  });
}

/* ---- participants modal --------------------------------------------------
   Shown at the moment the roster is actually needed (recording stop / re-editing
   an existing meeting). Deliberately no "cancel" — a recording must not silently
   lose its roster, so the only outcomes are "save these names" or "keep what we have". */
let participantsPending = null; // the participants event while the modal is open
let participantsBusy = false;   // idempotency guard: a double-click must not send two answers
const pRows = $("participants-rows");

/* Idle button labels, captured once at load. An in-flight submit swaps its own
 * label to 「保存中…」: under CPU starvation the IPC round-trip takes long enough
 * that a merely dimmed button reads as "my click did nothing" — and the user then
 * clicks again. Restored on open AND on close, so a cancelled or timed-out submit
 * can never leave the pending label stuck on screen. */
/* Bug fixed here: these two were captured with `textContent` at load time, which is
 * BEFORE the language is applied (applyStatic runs later in the init block). The
 * captured value was therefore the Chinese FALLBACK text from index.html, and
 * resetParticipantsButtons() wrote it back on every modal open — silently undoing
 * the English that applyStatic had put there. Seen in a real run: the 保存 /
 * 不需要更改参会人 buttons stayed Chinese in an otherwise-English modal.
 * Translate the fallback text instead, so the idle label follows the language. */
const SAVE_IDLE_LABEL = T($("participants-save").textContent);
const UNCHANGED_IDLE_LABEL = T($("participants-unchanged").textContent);
const SAVE_PENDING_LABEL = T("保存中…");

function resetParticipantsButtons() {
  const save = $("participants-save");
  const keep = $("participants-unchanged");
  save.disabled = false;
  keep.disabled = false;
  save.textContent = SAVE_IDLE_LABEL;
  keep.textContent = UNCHANGED_IDLE_LABEL;
  /* Re-apply the declarative translations for the whole modal. Writing textContent
   * above destroys nothing else, but this also covers the 「以后停止时不要再问我」
   * checkbox and any data-i18n added to the modal later. */
  const overlay = $("participants-overlay");
  if (overlay && window.I18N) window.I18N.applyStatic(overlay);
}

function participantRow(name) {
  const row = document.createElement("div");
  row.className = "participant-row";
  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = T("参会人名字…");
  input.value = name || "";
  // Enter on a row must not blur/commit just that row — the modal's keydown
  // handler turns Enter into "save the whole roster"
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") e.preventDefault(); });
  const rm = document.createElement("button");
  rm.className = "ghost";
  rm.textContent = T("移除");
  rm.title = T("移除这一位");
  rm.addEventListener("click", () => row.remove());
  row.append(input, rm);
  return row;
}

function seedParticipantRows(names) {
  pRows.innerHTML = "";
  const list = (names || []).filter((n) => typeof n === "string" && n.trim());
  (list.length ? list : [""]).forEach((n) => pRows.appendChild(participantRow(n)));
}

function openParticipantsModal(e) {
  // an event while the modal is already open: take over its id and re-seed the
  // rows instead of stacking a second modal on top
  participantsPending = e;
  participantsBusy = false;
  $("participants-title").textContent = e.title || T("参会人");
  $("participants-note").textContent =
    e.reason === "manual"
      ? T("重新编辑这场会议已保存的参会人名单。")
      : T("这些名字会和这场会议的笔记一起保存（笔记里的「你 / 远端」会变成具体人名）。");
  $("participants-noask").checked = false;
  seedParticipantRows(e.prefill);
  $("participants-overlay").hidden = false;
  resetParticipantsButtons();
  const first = pRows.querySelector("input");
  if (first) first.focus();
}

function closeParticipantsModal() {
  participantsPending = null;
  participantsBusy = false;
  $("participants-overlay").hidden = true;
  $("participants-noask").checked = false;
  // also restores the 「保存中…」 label: no submit path may leave it behind
  resetParticipantsButtons();
}

function readParticipantNames() {
  // main already bounds and sanitises — just trim and drop the empty rows
  return [...pRows.querySelectorAll("input")].map((i) => i.value.trim()).filter(Boolean);
}

async function participantsSubmit(unchanged) {
  if (participantsBusy) return; // second click of the same action is a no-op
  participantsBusy = true;
  // Freeze BOTH buttons and say so on the one that was pressed: a merely dimmed
  // button reads as "my click did nothing" while the machine is busy, and the
  // natural reaction is to click again.
  const acted = unchanged ? $("participants-unchanged") : $("participants-save");
  $("participants-save").disabled = true;
  $("participants-unchanged").disabled = true;
  acted.textContent = SAVE_PENDING_LABEL; // restored by closeParticipantsModal()

  const e = participantsPending;
  let answeredOk = false;
  if (e && window.a2n.participantsAnswer) {
    const payload = unchanged
      ? { id: e.id, unchanged: true }
      : { id: e.id, names: readParticipantNames() };
    try {
      const res = await window.a2n.participantsAnswer(payload);
      answeredOk = !!(res && res.ok);
    } catch (err) {
      console.error("participantsAnswer IPC failed:", err);
    }
  }
  // "don't ask me again" is best-effort: its failure must never block the answer
  // above from being sent, nor keep the modal open
  if ($("participants-noask").checked && window.a2n.setConfig) {
    try {
      await window.a2n.setConfig({ participants: { askOnStop: false } });
    } catch (err) {
      console.error("setConfig(askOnStop) failed:", err);
    }
  }
  closeParticipantsModal();
  if (!answeredOk) {
    // the server may have timed out this request — still close, but be loud
    $("record-status").textContent = T("名单没有保存：这次询问已经超时。稍后停止录音时如果还需要名单，会再问你。");
  }
}

if (window.a2n.onParticipants) {
  window.a2n.onParticipants((e) => {
    if (!e) return;
    openParticipantsModal(e);
  });
}

// Enter = save; Escape = 「不需要更改参会人」(NOT a cancel — a recording must not
// silently lose its roster). A focused button keeps its own Enter/click.
$("participants-overlay").addEventListener("keydown", (ev) => {
  if (ev.key === "Escape") {
    ev.preventDefault();
    participantsSubmit(true);
  } else if (ev.key === "Enter" && ev.target.tagName !== "BUTTON") {
    ev.preventDefault();
    participantsSubmit(false);
  }
});
$("participants-save").addEventListener("click", () => participantsSubmit(false));
$("participants-unchanged").addEventListener("click", () => participantsSubmit(true));
$("participants-add").addEventListener("click", () => {
  const row = participantRow("");
  pRows.appendChild(row);
  // Make the new row unmistakable. Under CPU starvation the paint can lag for
  // seconds, so an unacknowledged click invites a second (and third) click — each
  // one appending another empty row, which then looked like the button was
  // duplicated rather than registered. The flash + scrollIntoView are that
  // acknowledgement, and both are purely presentational.
  row.classList.add("participant-row-new");
  // animationend is the normal path; the timer is the belt for when the animation
  // never runs at all (prefers-reduced-motion, or a hidden overlay at append time).
  row.addEventListener("animationend", () => row.classList.remove("participant-row-new"), { once: true });
  setTimeout(() => row.classList.remove("participant-row-new"), 1200);
  row.querySelector("input").focus();
  // after focus(), so the row is on screen even if the focus scroll did nothing
  row.scrollIntoView({ block: "nearest" });
});

/* ---- results: notes + chunked transcript + translation toggles ---------- */
function showResult(res) {
  $("result-card").hidden = false;
  // a fresh recording has no roster yet; openMeeting() re-fills it from its own meetingsOpen call
  meetingParticipants = res.participants || [];
  lastResult = { notes: res.notes, notesZh: res.notesZh || null, chunks: res.chunks || [] };
  $("notes-provider").textContent = res.provider || "";
  $("detail-level").value = cfg && cfg.notes.detailLevel || "standard";
  updateNotes();
  renderChunks();
  loadSpeakers();

  // Surface degradation loudly: a failed LLM call must never look like a real summary.
  const warn = [];
  if (res.notesFallbackReason) {
    warn.push(T("⚠️ 摘要降级为规则提取（原因：${…}）—— 笔记顶部已标注，点「重新生成」可重试", { "${…1}": res.notesFallbackReason }));
  }
  if (res.notesWarnings && res.notesWarnings.length) warn.push(...res.notesWarnings);
  /* A track that recorded nothing is reported HERE, in the result, not only during
   * recording. Observed failure: a meeting whose mic track was 0.7 % active across ten
   * minutes — the pipeline succeeded, only the system audio transcribed, and nothing
   * said so anywhere. meta.json now carries peakDbfs/activePercent per track, so this
   * can name the track and the number instead of the user having to guess. */
  const tracks = (res.audioStats && res.audioStats.tracks) || [];
  for (const tr of tracks) {
    if (!TQ.isSilentTrack(tr)) continue;   // rule lives in renderer/trackQuality.js
    const peak = typeof tr.peakDbfs === "number" ? tr.peakDbfs : null;
    const active = typeof tr.activePercent === "number" ? tr.activePercent : null;
    warn.push(T("⚠️ ${…} 轨没有录到声音（峰值 ${…} dBFS，有效样本 ${…}%）——检查默认输入设备或静音开关", {
      "${…1}": tr.track,
      "${…2}": peak === null ? "?" : peak.toFixed(1),
      "${…3}": active === null ? "?" : active.toFixed(1),
    }));
  }
  if (warn.length) {
    $("regen-status").textContent = warn.join(" · ");
    $("regen-status").classList.add("warn");
  } else {
    $("regen-status").classList.remove("warn");
  }
}

/* ---- speakers: diarization, 5 s audition, manual naming ---------------- */
let speakers = [];
let auditionAudio = null;
let auditionId = null;
/* Meeting dirs whose post-recording naming modal has already auto-opened during THIS
 * app run. One meeting must not re-ask every time a pipeline "done" event arrives
 * (re-transcribe, regenerate, …). There is deliberately no manual way to reopen the
 * modal: the inline 发言人 panel is the fallback for naming a speaker afterwards. */
const speakerConfirmShown = new Set();
/* speakerId -> { el, commit } for the rows currently mounted in #speaker-confirm-rows,
 * so 保存 can commit exactly what is on screen even if a row re-rendered in between. */
let confirmRowsById = new Map();

function fmtDur(sec) {
  const m = Math.floor((sec || 0) / 60);
  const s = Math.round((sec || 0) % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

async function loadSpeakers() {
  if (!currentDir) return;
  const st = await window.a2n.speakersStatus({ dir: currentDir });
  speakers = (st && st.speakers) || [];
  $("btn-diarize").disabled = !(st && st.hasSource);
  $("btn-diarize").title = st && st.hasSource ? "" : T("这个会议没有可用的音频（system/mixed）");
  renderSpeakerRows();
}

function renderSpeakerRows() {
  const box = $("speaker-rows");
  box.innerHTML = "";
  if (!speakers.length) {
    box.innerHTML =
      T('<div class="hint">还没有识别发言人——点「识别发言人」按声音把他们分开（本地运行，首次会下载 27 MB 声纹模型）。</div>');
    return;
  }
  // the meeting's roster is a <datalist> suggestion only — diarization order is not
  // roster order, so we never guess which speaker is which person
  if (meetingParticipants.length) {
    const list = document.createElement("datalist");
    list.id = "speaker-name-suggest";
    for (const p of meetingParticipants) {
      const opt = document.createElement("option");
      opt.value = p;
      list.appendChild(opt);
    }
    box.appendChild(list);
  }

  for (const s of speakers) {
    box.appendChild(buildSpeakerRow(s).el);
  }
}

/* Build ONE speaker row: placeholder label + ▶ 5 s audition + name input (+ the roster
 * picker and merge dropdown the panel shows when they apply). Returns
 * `{ el, commit }`, where commit(value?) pushes a value through the existing
 * speakersSetName path. renderSpeakerRows (the panel) and openSpeakerConfirm (the
 * post-recording modal) both go through this, so the row exists in exactly one place. */
function buildSpeakerRow(s) {
  const row = document.createElement("div");
  row.className = "speaker-row";

  const play = document.createElement("button");
  play.className = "play";
  play.textContent = auditionId === s.id ? "■" : "▶";
  play.title = s.sample
    ? T("试听 ${…} 秒样本", { "${…1}": (s.sample.durationSec || 0).toFixed(1) }) + (s.lowConfidence ? T("（样本偏短，可能不准）") : "")
    : T("没有样本");
  play.disabled = !s.sample;
  if (s.lowConfidence) play.classList.add("lowconf");
  play.addEventListener("click", () => toggleAudition(s));

  const label = document.createElement("span");
  label.className = "spk-label";
  label.textContent = s.id.replace(/^spk/, T("发言人"));

  const input = document.createElement("input");
  input.type = "text";
  input.className = "spk-name";
  input.placeholder = T("填名字…");
  input.value = s.name || "";
  if (meetingParticipants.length) input.list = "speaker-name-suggest"; // suggestions only
  /* `value` lets the roster picker below reuse this commit path, and lets it commit a
   * name that is already in the input (the typed-equals-current early return would
   * otherwise swallow a dropdown pick of the same value). */
  const commit = async (value) => {
    const v = (value !== undefined ? String(value) : input.value).trim();
    if (v === (s.name || "")) return;
    input.value = v; // keep the visible field in step when committed by the picker
    const res = await window.a2n.speakersSetName({ dir: currentDir, speakerId: s.id, name: v });
    if (res.error) {
      if ($("diarize-status")) $("diarize-status").textContent = T("改名失败：") + res.error;
      return;
    }
    speakers = res.speakers;
    lastResult.chunks = res.chunks;
    renderChunks();
    renderSpeakerRows();
    // the notes were patched on disk — pull the updated text back into the panel
    if (res.notesPatched) {
      try {
        const m = await window.a2n.meetingsOpen({ dir: currentDir });
        if (m && !m.error && m.notes) {
          if (Array.isArray(m.participants)) meetingParticipants = m.participants;
          lastResult.notes = m.notes;
          lastResult.notesZh = m.notesZh || null;
          updateNotes();
        }
      } catch (e) {
        console.error("notes refresh after rename failed:", e);
      }
    }
    if ($("diarize-status")) {
      $("diarize-status").textContent = res.notesPatched
        ? T("已更新：转写全部生效，笔记里 ${…} 处旧名字也一起改了", { "${…1}": res.notesPatched })
        : T("已更新：转写全部生效（笔记里没有出现旧名字）");
    }
  };
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") input.blur(); });
  // NOT `commit` directly: addEventListener passes the EVENT as the first argument,
  // and commit()'s first parameter is a value — the event object would be read as the
  // name and coerced to "[object FocusEvent]".
  input.addEventListener("blur", () => commit());

  /* Roster picker.
   *
   * WHY: the attendee names are typed once in the participants modal, and then the
   * speaker rows asked for them AGAIN with no connection between the two lists — you
   * had to retype names you had just entered. This is a dropdown of the roster, so
   * naming a voice is one click.
   *
   * It still does NOT auto-assign: diarization order is not roster order, and a wrong
   * guess would misattribute everything that person said. You choose which name goes
   * with the voice you just heard on ▶.
   * Names already given to another speaker are not offered, so one person cannot be
   * assigned to two rows by accident. */
  const roster = (meetingParticipants || []).filter((n) => typeof n === "string" && n.trim());
  if (roster.length) {
    // rule lives in renderer/trackQuality.js (names already given to another speaker
    // are not offered, so one person cannot be assigned to two rows by accident)
    const options = TQ.pickableNames(roster, speakers, s.id);
    const mine = String(s.name || "").trim();
    if (options.length) {
      const pick = document.createElement("select");
      pick.className = "spk-pick compact";
      pick.title = T("从参会人名单里选一个名字");
      const ph = document.createElement("option");
      ph.value = "";
      ph.textContent = T("选参会人…");
      pick.appendChild(ph);
      for (const n of options) {
        const o = document.createElement("option");
        o.value = n;
        o.textContent = n;
        if (mine && n.trim().toLowerCase() === mine.toLowerCase()) o.selected = true;
        pick.appendChild(o);
      }
      pick.addEventListener("change", () => { if (pick.value) commit(pick.value); });
      row.append(pick);
    }
  }

  const meta = document.createElement("span");
  meta.className = "spk-meta";
  meta.textContent = T("${…} 段 · ${…}", { "${…1}": s.segments, "${…2}": fmtDur(s.durationSec) }) + (s.lowConfidence ? T(" · ⚠样本短") : "");

  row.append(play, label, input, meta);

  if (speakers.length > 1) {
    const merge = document.createElement("select");
    merge.className = "spk-merge compact";
    merge.title = T("把这一行合并到另一个发言人（修正过度切分）");
    const o0 = document.createElement("option");
    o0.value = "";
    o0.textContent = T("合并到…");
    merge.appendChild(o0);
    for (const t of speakers) {
      if (t.id === s.id) continue;
      const o = document.createElement("option");
      o.value = t.id;
      o.textContent = t.name || t.id.replace(/^spk/, T("发言人"));
      merge.appendChild(o);
    }
    merge.addEventListener("change", async () => {
      const into = merge.value;
      if (!into) return;
      if (!confirm(T("把「${…}」的所有片段合并到「${…}」？", { "${…1}": s.name || s.id, "${…2}": (speakers.find((x) => x.id === into) || {}).name || into }))) {
        merge.value = "";
        return;
      }
      const res = await window.a2n.speakersMerge({ dir: currentDir, fromId: s.id, intoId: into });
      if (res.error) { if ($("diarize-status")) $("diarize-status").textContent = T("合并失败：") + res.error; return; }
      speakers = res.speakers;
      lastResult.chunks = res.chunks;
      renderChunks();
      renderSpeakerRows();
      if ($("diarize-status")) $("diarize-status").textContent = T("已合并。");
    });
    row.appendChild(merge);
  }

  return { el: row, commit };
}

async function toggleAudition(s) {
  if (auditionId === s.id && auditionAudio) {
    auditionAudio.pause();
    auditionAudio = null;
    auditionId = null;
    renderSpeakerRows();
    return;
  }
  if (auditionAudio) { auditionAudio.pause(); auditionAudio = null; }
  const r = await window.a2n.speakersAudition({ dir: currentDir, speakerId: s.id });
  if (r.error) {
    $("diarize-status").textContent = T("试听失败：") + r.error;
    return;
  }
  auditionAudio = new Audio(r.dataUrl);
  auditionId = s.id;
  auditionAudio.onended = () => { auditionAudio = null; auditionId = null; renderSpeakerRows(); };
  await auditionAudio.play().catch((e) => { if ($("diarize-status")) $("diarize-status").textContent = T("播放失败：") + e.message; });
  renderSpeakerRows();
}

/* ---- post-recording naming modal ---------------------------------------
 * After the pipeline finishes with voices detected, this card lists every speaker
 * with its ▶ 5-second clip and a name field, at the moment the user still remembers
 * who was in the room. It is a convenience, not a gate: Escape / 「取消」 close it and
 * change nothing, and the inline panel keeps working exactly as before. */
/* Commit every row's CURRENT input value, then rewrite the notes so they carry the
 * real names. A commit re-renders the inline panel on the way out, so the handles are
 * re-collected from the live DOM each pass instead of once at open time; a row whose
 * value did not change early-returns inside its own commit, so this stays cheap. */
async function saveSpeakerConfirm() {
  const btn = $("speaker-confirm-save");
  if (btn) btn.disabled = true;
  for (const s of speakers.slice()) {
    confirmRowsById = collectConfirmRows();
    const r = confirmRowsById.get(s.id);
    if (r) await r.commit();
  }
  // reuses the Regenerate button's own status slot, so no new user-visible string
  if ($("regen-status")) $("regen-status").textContent = T("重新生成中…");
  const err = await regenNotesWithCurrentNames();
  closeSpeakerConfirm();
  renderChunks();
  renderSpeakerRows();
  if ($("regen-status")) {
    $("regen-status").classList.toggle("warn", !!err);
    $("regen-status").textContent = err ? T("失败：") + err : T("已重新生成 ✓");
  }
  if (!err) setTimeout(() => { if ($("regen-status")) $("regen-status").textContent = ""; }, 3000);
}

/* Shared by the modal's 保存 and the panel's 重新生成 button: the summarizer reads
 * transcript.json, which speakersSetName rewrites, so renaming must be followed by a
 * real regeneration for the names to appear in the notes. Returns an error string, or
 * null on success. */
async function regenNotesWithCurrentNames() {
  const res = await window.a2n.regenerateNotes({
    dir: currentDir,
    detailLevel: $("detail-level").value,
  });
  if (res.error) return res.error;
  if (lastResult) {
    lastResult.notes = res.notes;
    lastResult.notesZh = res.notesZh || null;
  }
  if ($("notes-provider")) $("notes-provider").textContent = res.provider || "";
  updateNotes();
  return null;
}

/* The rows currently mounted in #speaker-confirm-rows: speakerId -> built row. Rebuilt
 * from the live DOM rather than cached, because a commit re-renders the inline panel and
 * would otherwise leave the map pointing at detached nodes. */
function collectConfirmRows() {
  const map = new Map();
  const box = $("speaker-confirm-rows");
  if (!box) return map;
  const els = [...box.querySelectorAll(".speaker-row")];
  speakers.forEach((s, i) => {
    const el = els[i];
    if (el) map.set(s.id, { el, commit: () => commitRowValue(s, el) });
  });
  return map;
}

/* Fallback of the builder's own commit closure: commits the CURRENT value of a row that
 * is still mounted, through the same speakersSetName path (the closure captured its
 * input at build time, so a rebuilt row needs this one to be read live). */
async function commitRowValue(s, el) {
  const input = el.querySelector(".spk-name");
  if (!input) return;
  const v = String(input.value).trim();
  if (v === (s.name || "")) return;
  const res = await window.a2n.speakersSetName({ dir: currentDir, speakerId: s.id, name: v });
  if (res.error) {
    if ($("diarize-status")) $("diarize-status").textContent = T("改名失败：") + res.error;
    return;
  }
  speakers = res.speakers;
  if (lastResult) lastResult.chunks = res.chunks;
  renderChunks();
  renderSpeakerRows();
}

function openSpeakerConfirm() {
  const box = $("speaker-confirm-rows");
  box.innerHTML = "";
  if (!speakers.length) return; // nothing detected — never show an empty card
  for (const s of speakers) box.appendChild(buildSpeakerRow(s).el);
  confirmRowsById = collectConfirmRows();
  /* Save disables itself while the regeneration runs. Reset it on every open, or the
   * next meeting's card comes up with a dead Save button — the auto-open guard is
   * per-dir, so a second meeting in one app run does reopen this card. */
  $("speaker-confirm-save").disabled = false;
  $("speaker-confirm-overlay").hidden = false;
  const first = box.querySelector(".spk-name");
  if (first) first.focus();
}

function closeSpeakerConfirm() {
  $("speaker-confirm-overlay").hidden = true;
  confirmRowsById = new Map();
  // hand focus back to the panel that owns this data, so the card never traps it
  if ($("btn-diarize")) $("btn-diarize").focus();
}

$("speaker-confirm-save").addEventListener("click", saveSpeakerConfirm);
$("speaker-confirm-skip").addEventListener("click", closeSpeakerConfirm);
/* Escape = Skip (change nothing). A focused input is included on purpose — there is
 * nothing to lose in this card, so any Escape closes it. */
$("speaker-confirm-overlay").addEventListener("keydown", (ev) => {
  if (ev.key !== "Escape") return;
  ev.preventDefault();
  closeSpeakerConfirm();
});

$("btn-diarize").addEventListener("click", async () => {
  if (!currentDir) return;
  const btn = $("btn-diarize");
  btn.disabled = true;
  if ($("diarize-status")) $("diarize-status").textContent = T("识别中…（本地 CPU，长会议需要几分钟）");
  try {
    const res = await window.a2n.speakersDiarize({ dir: currentDir });
    if (res.error) {
      $("diarize-status").textContent = T("失败：") + res.error;
      return;
    }
    speakers = res.speakers;
    lastResult.chunks = res.chunks || lastResult.chunks;
    renderChunks();
    renderSpeakerRows();
    const lowConf = res.speakers.filter((s) => s.lowConfidence).length;
    $("diarize-status").textContent =
      T("识别到 ${…} 个发言人（按 ${…} 分析）", { "${…1}": res.speakers.length, "${…2}": res.source }) +
      (lowConf ? T(" · ${…} 个样本偏短", { "${…1}": lowConf }) : "") +
      T(" —— 请逐个试听确认，填名字即可全场生效。");
  } finally {
    btn.disabled = false;
  }
});

function updateNotes() {
  const zh = $("notes-lang").querySelector(".active").dataset.lang === "zh";
  $("notes").textContent = zh && lastResult.notesZh ? lastResult.notesZh : lastResult.notes;
  // hide the 中文 toggle if there is no translation
  const hasZh = !!lastResult.notesZh;
  $("notes-lang").style.visibility = hasZh ? "visible" : "hidden";
}

function renderChunks() {
  const box = $("chunk-list");
  box.innerHTML = "";
  if (!lastResult.chunks.length) {
    box.innerHTML = '<div class="hint">(no transcript)</div>';
    return;
  }
  const mode = $("transcript-lang").querySelector(".active").dataset.lang;
  for (const c of lastResult.chunks) {
    const row = document.createElement("div");
    row.className = "chunk";

    const badge = document.createElement("button");
    badge.className = "speaker";
    badge.textContent = c.speakerName || T("说话人");
    badge.title = T("点击改名");
    /* Rename in place: Electron implements no window.prompt dialog, so the badge is swapped for a
     * text input in the same slot. Enter commits, Escape/blur cancels, and the badge is
     * restored either way. The input reuses the Speakers-panel `.spk-name` style — no
     * new CSS and no new i18n key. */
    badge.addEventListener("click", () => {
      if (!badge.isConnected) return;
      const oldName = badge.textContent;
      const input = document.createElement("input");
      input.type = "text";
      input.className = "spk-name";
      input.value = oldName;
      let done = false;
      const restore = () => { if (input.isConnected) input.replaceWith(badge); };
      /* Restores the badge on EVERY terminal outcome and reports the failure, so a rejected
       * IPC call cannot leave a bare input where the speaker label used to be. */
      const settle = async (res) => {
        restore();
        $("regen-status").textContent = T("改名失败：") + ((res && res.error) || "unknown");
      };
      const commit = async () => {
        if (done) return;
        done = true;
        const name = input.value;
        if (!name || !name.trim() || name.trim() === oldName) { restore(); return; }
        // prefer the STABLE id when the chunk has one: renaming by id never breaks,
        // renaming by display string loses the link after the first change
        const byId = typeof c.speaker === "string" && /^spk\d+$/.test(c.speaker);
        let res;
        try {
          res = byId
            ? await window.a2n.speakersSetName({ dir: currentDir, speakerId: c.speaker, name: name.trim() })
            : await window.a2n.renameSpeaker({ dir: currentDir, from: oldName, to: name.trim() });
        } catch (e) { await settle({ error: e && e.message }); return; }
        /* `ok` covers both IPC shapes: speakersSetName answers ok:true, renameSpeaker
         * answers a bare {error} with no `ok` at all — so a missing `ok` means failure. */
        if (res && res.ok) {
          lastResult.chunks = res.chunks;
          if (byId && res.speakers) { speakers = res.speakers; renderSpeakerRows(); }
          renderChunks();
          $("regen-status").textContent = T("说话人已更新 — 点「重新生成」刷新笔记里的归属。");
        } else {
          await settle(res);
        }
      };
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); commit(); }
        else if (e.key === "Escape") { done = true; restore(); }
      });
      input.addEventListener("blur", () => { if (!done) { done = true; restore(); } });
      badge.replaceWith(input);
      input.focus();
      input.select();
    });

    const time = document.createElement("span");
    time.className = "chunk-time";
    time.textContent = fmtTime(c.start);

    const text = document.createElement("span");
    text.className = "chunk-text";
    if (mode === "both") {
      text.textContent = c.text;
      const tr = document.createElement("span");
      tr.className = "translated";
      tr.textContent = (c.translated && c.translated.trim()) ? c.translated : T("（无译文）");
      text.appendChild(tr);
    } else if (mode === "zh") {
      text.textContent = (c.translated && c.translated.trim()) ? c.translated : c.text;
    } else {
      text.textContent = c.text;
    }

    row.append(badge, time, text);
    box.appendChild(row);
  }
}

/* segmented toggles */
for (const [selId, fn] of [
  ["transcript-lang", renderChunks],
  ["notes-lang", updateNotes],
]) {
  $(selId).addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    $(selId).querySelectorAll("button").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    fn();
  });
}

/* re-generate notes at a chosen detail level */
$("btn-regen").addEventListener("click", async () => {
  const btn = $("btn-regen");
  btn.disabled = true;
  $("regen-status").textContent = T("重新生成中…");
  try {
    const res = await window.a2n.regenerateNotes({
      dir: currentDir,
      detailLevel: $("detail-level").value,
    });
    if (res.error) {
      $("regen-status").textContent = T("失败：") + res.error;
    } else {
      lastResult.notes = res.notes;
      lastResult.notesZh = res.notesZh || null;
      $("notes-provider").textContent = res.provider || "";
      updateNotes();
      $("regen-status").textContent = T("已重新生成 ✓");
      setTimeout(() => ($("regen-status").textContent = ""), 3000);
    }
  } finally {
    btn.disabled = false;
  }
});

$("btn-open-dir").addEventListener("click", () => {
  if (currentDir) window.a2n.openDir(currentDir);
});

function fmtTime(sec) {
  if (sec == null || isNaN(sec)) return "00:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/* ---- live events ---- */
window.a2n.onLevel(({ source, level }) => {
  const el = $(`level-${source}`);
  if (el) el.style.width = level + "%";
  // feed the silence watchdog (see startMicWatchdog)
  if (recording && source === "mic") {
    micTotalSamples++;
    if (Number(level) >= MIC_LEVEL_FLOOR) micLoudSamples++;
  }
});
window.a2n.onPipeline((p) => {
  lastPipeline = p.message || p.phase || "";
  // backend messages are Chinese (or already English); resolve() leaves unknown ones alone
  $("pipeline").textContent = window.I18N ? window.I18N.resolve(lastPipeline) : lastPipeline;
  if (typeof p.progress === "number") setProgress(p.progress);
  if (p.phase === "done" || p.phase === "error") setProgress(p.phase === "done" ? 100 : 0);
  /* Post-recording naming: diarization is already on disk by the time the pipeline
   * reports "done", so this is the one moment the user is looking at the result AND
   * still remembers who spoke. Auto-open at most ONCE per meeting per app run (a
   * re-transcribe fires "done" again), and only when there are voices and none of them
   * has a name yet — never re-ask a meeting that has been named. */
  if (p.phase === "done" && p.dir && !speakerConfirmShown.has(p.dir)) {
    speakerConfirmShown.add(p.dir); // added before the await: a second event cannot race in
    const dir = p.dir;
    loadSpeakers().then(() => {
      if (dir !== currentDir) return; // the user opened another meeting while we loaded
      if (speakers.length >= 1 && !speakers.some((s) => String(s.name || "").trim())) {
        openSpeakerConfirm();
      }
    }).catch((e) => console.error("speaker naming prompt failed:", e));
  }
});
window.a2n.onTranscript((t) => {
  if (lastResult) {
    lastResult.chunks = t.chunks || [];
    renderChunks();
  }
});

/* ---- UI language ---- */
function setLangButtons(lang) {
  const seg = $("ui-lang");
  if (!seg) return;
  seg.querySelectorAll("button[data-lang]").forEach((b) => b.classList.toggle("active", b.dataset.lang === lang));
}

/* Re-render everything that was built from translated strings. Each step is
 * guarded: several areas only exist once a config/result has loaded. */
function refreshUiLanguage() {
  if (window.I18N) window.I18N.applyStatic(document);
  setLangButtons(window.I18N ? window.I18N.lang : "en");
  if ($("pipeline") && lastPipeline) $("pipeline").textContent = window.I18N ? window.I18N.resolve(lastPipeline) : lastPipeline;
  if (typeof renderPower === "function") renderPower();
  if (typeof loadPower === "function") loadPower(); // also re-renders the deferred queue
  if (typeof loadHistory === "function") loadHistory();
  if (typeof loadModels === "function") loadModels();
  if (typeof loadDevices === "function") loadDevices();
  if (typeof fillLlmFields === "function") fillLlmFields();
  if (typeof loadArchivePresets === "function") loadArchivePresets();
  if (typeof renderChunks === "function") renderChunks();
  if (lastResult) {
    if (typeof renderSpeakerRows === "function") renderSpeakerRows();
    if (typeof updateNotes === "function") updateNotes();
  }
}

async function switchLang(id) {
  if (!window.I18N) return;
  if (window.I18N.lang !== id) {
    window.I18N.setLang(id);
    refreshUiLanguage();
  }
  setLangButtons(window.I18N.lang);
  try {
    await window.a2n.setConfig({ ui: { lang: window.I18N.lang } }); // deep-merges a partial config
  } catch (e) {
    console.error("could not persist ui.lang:", e); // never fail silently
  }
}

const uiLang = $("ui-lang");
if (uiLang) {
  uiLang.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-lang]");
    if (btn) switchLang(btn.dataset.lang);
  });
}
function setProgress(p) {
  $("progress-fill").style.width = Math.max(0, Math.min(100, p)) + "%";
}

/* ---- init ---- */
(async () => {
  await loadArchivePresets(); // must precede loadConfig (it selects a preset)
  await loadConfig();
  // Language next: every loader below renders translated text. `ui.lang` is an
  // optional config key, so an absent one falls back to I18N.DEFAULT_LANG ("en").
  window.I18N.setLang((cfg && cfg.ui && cfg.ui.lang) || window.I18N.DEFAULT_LANG);
  setLangButtons(window.I18N.lang);
  window.I18N.applyStatic(document);
  await loadPower();
  await loadModels(); // also surfaces a broken model cache at start-up
  await loadDevices();
  fillLlmFields();
})();
