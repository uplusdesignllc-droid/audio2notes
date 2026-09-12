"use strict";
const $ = (id) => document.getElementById(id);

let cfg = null;
let recording = false;
let timerInt = null;
let t0 = 0;
let currentDir = null;
let lastResult = null; // { notes, notesZh, chunks }

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
    list = [{ id: "opus-24", label: "Opus 24 kbps 单声道（推荐）", codec: "libopus", bitrateKbps: 24, bytesPerHour: 10800000 }];
  }
  ARCHIVE_PRESETS = list;
  archiveSel.innerHTML = "";
  for (const p of list) {
    const o = document.createElement("option");
    o.value = p.id;
    o.textContent = `${p.label} — 约 ${(p.bytesPerHour / 1e6).toFixed(1)} MB/小时`;
    archiveSel.appendChild(o);
  }
}

function selectedPreset() {
  return ARCHIVE_PRESETS.find((p) => p.id === archiveSel.value) || ARCHIVE_PRESETS[0] || { codec: "libopus", bitrateKbps: 24 };
}
function presetIdFor(a) {
  const hit = ARCHIVE_PRESETS.find(
    (p) => p.codec === (a.codec || "libopus") && p.bitrateKbps === Number(a.bitrateKbps || 24)
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
      sel.innerHTML = `<option value="">（读取失败：${esc((r && r.error) || "unknown")}）</option>`;
      return;
    }
    const cur = ($("cfg-ollama-model").value || "").trim();
    sel.innerHTML = '<option value="">（自动选择：优先文本模型，跳过视觉模型）</option>';
    for (const m of r.models || []) {
      const o = document.createElement("option");
      o.value = m.name;
      const tags = [];
      if (m.name === r.recommended) tags.push("推荐");
      if (m.vlm) tags.push("视觉模型，摘要质量通常更差");
      o.textContent = m.name + (m.paramSize ? ` · ${m.paramSize}` : "") + (tags.length ? `（${tags.join("，")}）` : "");
      sel.appendChild(o);
    }
    if (cur) sel.value = cur;
  } catch (e) {
    sel.innerHTML = `<option value="">（读取失败：${e.message}）</option>`;
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
  $("cfg-silence-min").value = typeof as.silenceMin === "number" ? as.silenceMin : 10;
  $("cfg-forcestop-min").value = typeof as.forceStopAfterMin === "number" ? as.forceStopAfterMin : 5;
  $("cfg-mindisk-gb").value = typeof as.minFreeDiskGB === "number" ? as.minFreeDiskGB : 2;

  const md = lc.meetingDetect || {};
  $("cfg-meetdetect").checked = md.enabled !== false;
  $("cfg-meetdetect-stop").checked = md.autoStop !== false;
  $("cfg-meetdetect-start").checked = !!md.autoStart;
  $("cfg-meetdetect-apps").value = (md.apps || []).join(", ");
  refreshMeetingStatus();

  $("cfg-translate-enabled").checked = !!cfg.translation.enabled;
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
        silenceMin: Number($("cfg-silence-min").value) || 10,
        forceStopAfterMin: Number($("cfg-forcestop-min").value) || 5,
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
  $("archive-scan-status").textContent = "扫描中…";
  $("archive-dirlist").innerHTML = "";
  try {
    const s = await window.a2n.archiveScan();
    if (!s || s.error) {
      $("archive-scan-status").textContent = "扫描失败：" + ((s && s.error) || "unknown");
      return;
    }
    if (!s.fileCount) {
      $("archive-scan-status").textContent = "没有找到 WAV 文件（可能已经压缩过了）。";
      return;
    }
    $("archive-scan-status").textContent =
      `${s.fileCount} 个 WAV · ${fmtBytes(s.totalBytes)} → 预计 ${fmtBytes(s.estimatedBytesAfter)}` +
      `（可回收 ${fmtBytes(s.estimatedSavedBytes)}，按 ${s.preset.label}）`;
    const rows = s.dirs
      .sort((a, b) => b.totalBytes - a.totalBytes)
      .map(
        (d) =>
          `<div class="dirrow"><span>${esc(d.name)}</span><span>${d.files.length} 个 · ${fmtBytes(d.totalBytes)} → ${fmtBytes(
            d.estimatedBytesAfter
          )}</span></div>`
      );
    $("archive-dirlist").innerHTML = rows.join("");
    $("btn-archive-run").disabled = false;
  } finally {
    btn.disabled = false;
  }
});

$("btn-archive-run").addEventListener("click", async () => {
  const ok = confirm(
    "将把会议目录里的 WAV 转成压缩音频，并在校验通过后删除原始 WAV。\n" +
      "此操作对原始 WAV 不可撤销（转写结果 unaffected）。确定继续？"
  );
  if (!ok) return;
  const btn = $("btn-archive-run");
  btn.disabled = true;
  $("btn-archive-scan").disabled = true;
  $("archive-scan-status").textContent = "压缩中…";
  try {
    const r = await window.a2n.archiveRun();
    if (!r || r.error) {
      $("archive-scan-status").textContent = "失败：" + ((r && r.error) || "unknown");
      return;
    }
    const fail = (r.errors || []).length;
    $("archive-scan-status").textContent =
      `已完成 ✓ 压缩 ${r.files.length} 个文件，回收 ${fmtBytes(r.savedBytes)}` +
      `（${fmtBytes(r.before)} → ${fmtBytes(r.after)}）` +
      (fail ? ` · ${fail} 个失败（原文件已保留）` : "");
    const rows = (r.dirs || [])
      .filter((d) => d.files.length || d.errors.length)
      .map(
        (d) =>
          `<div class="dirrow"><span>${esc(d.name)}</span><span>${d.files.length} 个 · 回收 ${fmtBytes(
            d.savedBytes
          )}${d.errors.length ? ` · ${d.errors.length} 失败` : ""}</span></div>`
      );
    $("archive-dirlist").innerHTML = rows.join("");
    $("btn-archive-run").disabled = true; // re-scan before running again
  } finally {
    $("btn-archive-scan").disabled = false;
  }
});

window.a2n.onArchive((p) => {
  $("archive-scan-status").textContent = p.message || "压缩中…";
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
    ? `● 检测到 ${autoApp} 在播放声音，已自动开始录音…`
    : "Recording… (file: " + res.dir + ")";
  $("pipeline").textContent = "Recording in progress…";
  setProgress(0);
  t0 = Date.now();
  timerInt = setInterval(() => {
    const s = Math.floor((Date.now() - t0) / 1000);
    $("timer").textContent = `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  }, 500);
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
        $("pipeline").textContent = "会议软件已停止播放声音，自动停止录音…";
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
    reason === "silence" ? "长时间无人声，自动停止并处理…"
    : reason === "disk" ? "磁盘空间不足，自动停止并处理…"
    : reason === "meeting-app" ? "会议软件已停止播放声音，自动停止并处理…"
    : "Stopping…";
  $("pipeline").textContent = "Finalizing recording…";
  hideLifecycleBanner();
  const res = await window.a2n.stopRecord();
  clearInterval(timerInt);
  recording = false;
  $("btn-record").disabled = false;
  if (res.error) {
    $("record-status").textContent = "Error: " + res.error;
    $("pipeline").textContent = "Failed.";
    return;
  }
  if (res.queued) {
    // defer mode: nothing was transcribed yet, the audio is compressed and queued
    currentDir = res.dir;
    const saved = res.archive && res.archive.savedBytes ? `，音频已压缩回收 ${fmtBytes(res.archive.savedBytes)}` : "";
    $("record-status").textContent = `⏸ 已排队（续航优先模式）${saved} —— 插电后自动转写，也可以点「立即处理」。`;
    $("pipeline").textContent = "已排队，等待电源。";
    loadPower();
    window.a2n.lifecycleTouch();
    return;
  }
  $("record-status").textContent = "Done ✓ saved to " + res.dir;
  currentDir = res.dir;
  if (res.archive && res.archive.savedBytes) {
    $("record-status").textContent += ` · 音频已压缩（${res.archive.bitrateKbps} kbps），回收 ${fmtBytes(res.archive.savedBytes)}`;
  }
  if (res.archiveError) {
    $("record-status").textContent += ` · ⚠️ 音频压缩失败：${res.archiveError}（原始 WAV 已保留）`;
  }
  showResult(res);
  window.a2n.lifecycleTouch();
}

$("btn-stop").addEventListener("click", () => stopAndProcess("manual"));

/* ---- lifecycle: silence warning, auto-stop, low disk -------------------- */
function hideLifecycleBanner() {
  const b = $("lifecycle-banner");
  if (b) b.hidden = true;
}

function showLifecycleBanner(text) {
  const b = $("lifecycle-banner");
  if (!b) return;
  $("lifecycle-text").textContent = text;
  b.hidden = false;
}

if (window.a2n.onLifecycle) {
  window.a2n.onLifecycle((e) => {
    if (!e) return;
    if (e.type === "silence-warning") {
      const m = Math.floor(e.silentSec / 60);
      showLifecycleBanner(
        `已 ${m} 分钟没有声音。${e.forceInSec} 秒后将自动停止并生成笔记（录音仍在继续）。`
      );
    } else if (e.type === "auto-stop-request" || e.type === "stop-request") {
      if (recording) stopAndProcess(e.reason);
    } else if (e.type === "disk-low") {
      showLifecycleBanner(`磁盘剩余 ${e.freeGB.toFixed(1)} GB（低于 ${e.limitGB} GB），已停止录音以免写满。`);
    }
  });
}

const keepAliveBtn = $("btn-keepalive");
if (keepAliveBtn) {
  keepAliveBtn.addEventListener("click", async () => {
    await window.a2n.lifecycleKeepAlive();
    hideLifecycleBanner();
    $("record-status").textContent = "继续录音（已取消自动停止，直到再次长时间无声）。";
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
    $("import-status").textContent += ` · 会议目录只存压缩副本（${fmtBytes(res.archive.archivedBytes)}），原文件仍在你原来的位置（${fmtBytes(
      res.archive.sourceBytes
    )}）`;
  } else if (res.archive && res.archive.savedBytes) {
    $("import-status").textContent += ` · 音频已压缩，回收 ${fmtBytes(res.archive.savedBytes)}`;
  }
  if (res.archiveError) {
    $("import-status").textContent += ` · ⚠️ 压缩副本生成失败：${res.archiveError}`;
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
      ? `检测到 ${st.activeApp} 正在播放声音`
      : `当前没有会议软件在播放声音（监听 ${n} 个音频会话）`;
  } catch (e) {
    console.error("meetingStatus IPC failed:", e);
    el.textContent = "会议软件检测不可用：" + e.message;
  }
}
setInterval(refreshMeetingStatus, 20000);

/* ---- history: reopen a meeting recorded earlier ------------------------- */
async function loadHistory() {
  const box = $("history-list");
  if (!box) return;
  box.innerHTML = '<div class="hint">读取中…</div>';
  try {
    const r = await window.a2n.meetingsList();
    if (!r || r.error) {
      box.innerHTML = `<div class="hint">读取失败：${esc((r && r.error) || "unknown")}</div>`;
      return;
    }
    if (!r.items.length) {
      box.innerHTML = '<div class="hint">还没有可打开的会议（录音或导入一次就会出现）。</div>';
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
      if (it.durationSec) bits.push(`${Math.round(it.durationSec / 60)} 分钟`);
      if (it.hasSpeakers) bits.push("有发言人");
      if (it.hasAudio) bits.push("音频可试听");
      bits.push(fmtBytes(it.bytes));
      if (it.notesFallbackReason) bits.push("⚠️ 笔记降级");
      right.textContent = bits.join(" · ");
      const open = document.createElement("button");
      open.className = "ghost";
      open.textContent = "打开";
      open.addEventListener("click", () => openMeeting(it.dir));
      const spacer = document.createElement("span");
      spacer.style.flex = "1";
      row.append(left, spacer, right, open);
      box.appendChild(row);
    }
    $("history-status").textContent = `${r.items.length} 个会议 · ${r.root}`;
  } catch (e) {
    console.error("meetingsList IPC failed:", e);
    box.innerHTML = `<div class="hint">读取失败：${esc(e.message)}</div>`;
  }
}

async function openMeeting(dir) {
  $("history-status").textContent = "打开中…";
  const r = await window.a2n.meetingsOpen({ dir });
  if (r.error) {
    $("history-status").textContent = "打开失败：" + r.error;
    return;
  }
  currentDir = r.dir;
  // reuse the normal result view (it also loads the 发言人 panel for this dir)
  showResult({
    notes: r.notes || "(这个会议没有 notes.md)",
    notesZh: r.notesZh || null,
    chunks: r.chunks || [],
    provider: r.provider || "",
    notesFallbackReason: r.notesFallbackReason || null,
  });
  $("tab-record").click();
  $("record-status").textContent = "已打开历史会议：" + dir;
  $("history-status").textContent = "已打开：" + dir;
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
    $("models-status").textContent = "模型状态读取失败：" + e.message;
    return;
  }
  const st = modelsState;
  $("cfg-model-endpoint").value = st.endpoint || "";
  $("cfg-auto-download").checked = st.autoDownload !== false;
  $("models-total").textContent = `已占用 ${fmtBytes(st.totalBytes)}`;

  const box = $("whisper-rows");
  box.innerHTML = "";
  for (const w of st.whisper) {
    const busy = modelBusy && modelBusy.kind === "whisper" && modelBusy.id === w.id;
    const state = busy
      ? modelBusy.message || "下载中…"
      : w.ready
        ? `已下载 ${fmtBytes(w.bytes)}${w.current ? " · 当前使用" : ""}`
        : `未下载（约 ${w.approxMB} MB）${w.current ? " · 当前使用" : ""}`;

    const use = document.createElement("button");
    use.className = "ghost";
    use.textContent = w.current ? "使用中" : "使用";
    use.disabled = !!w.current || !!modelBusy;
    use.title = "把这个档位设为转写模型";
    use.addEventListener("click", async () => {
      await window.a2n.setConfig({ whisper: { model: w.id } });
      await loadConfig();
      await loadModels();
    });

    const act = document.createElement("button");
    act.className = w.ready ? "ghost" : "primary";
    act.textContent = w.ready ? "删除" : "下载";
    act.disabled = !!modelBusy;
    act.addEventListener("click", async () => {
      if (w.ready) {
        if (!confirm(`删除 ${w.short}？下次使用会需要重新下载。`)) return;
        modelBusy = { kind: "whisper", id: w.id, message: "删除中…" };
        await loadModels();
        const r = await window.a2n.modelsDelete({ kind: "whisper", id: w.id });
        modelBusy = null;
        $("models-status").textContent = r.error ? "删除失败：" + r.error : `已删除 ${w.short}`;
      } else {
        modelBusy = { kind: "whisper", id: w.id, message: "准备下载…" };
        await loadModels();
        const r = await window.a2n.modelsDownload({ kind: "whisper", id: w.id });
        modelBusy = null;
        $("models-status").textContent = r.error ? "下载失败：" + r.error : `${w.short} 下载完成（${fmtBytes(r.bytes)}）`;
      }
      await loadModels();
    });
    box.appendChild(modelRow(w.label, state, [use, act]));
  }

  const sbox = $("speaker-rows");
  sbox.innerHTML = "";
  const vp = st.voiceprint;
  const vBusy = modelBusy && modelBusy.kind === "voiceprint";
  const vState = vBusy
    ? modelBusy.message || "下载中…"
    : vp.ready
      ? `已下载 ${fmtBytes(vp.bytes)}`
      : `未下载（约 ${vp.approxMB} MB）——「识别发言人」也需要它`;
  const vAct = document.createElement("button");
  vAct.className = vp.ready ? "ghost" : "primary";
  vAct.textContent = vp.ready ? "删除" : "下载";
  vAct.disabled = !!modelBusy;
  vAct.addEventListener("click", async () => {
    if (vp.ready) {
      if (!confirm("删除声纹模型？下次识别发言人会重新下载。")) return;
      modelBusy = { kind: "voiceprint", message: "删除中…" };
      await loadModels();
      const r = await window.a2n.modelsDelete({ kind: "voiceprint" });
      modelBusy = null;
      $("models-status").textContent = r.error ? "删除失败：" + r.error : "已删除声纹模型";
    } else {
      modelBusy = { kind: "voiceprint", message: "准备下载…" };
      await loadModels();
      const r = await window.a2n.modelsDownload({ kind: "voiceprint" });
      modelBusy = null;
      $("models-status").textContent = r.error ? "下载失败：" + r.error : `声纹模型下载完成（${fmtBytes(r.bytes)}）`;
    }
    await loadModels();
  });
  sbox.appendChild(modelRow("声纹模型（3D-Speaker CAM++ 中英）", vState, [vAct]));
  sbox.appendChild(
    modelRow(
      "声纹分割模型（随程序分发）",
      st.segmentation.ready ? `已随包 ${fmtBytes(st.segmentation.bytes)}` : "缺失（打包异常）",
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
    $("models-status").textContent = r.error ? "保存失败：" + r.error : `已保存下载地址：${r.endpoint}`;
  });
}
const autoDl = $("cfg-auto-download");
if (autoDl) {
  autoDl.addEventListener("change", async () => {
    const r = await window.a2n.modelsSetEndpoint({ autoDownload: autoDl.checked });
    $("models-status").textContent = r.error
      ? "保存失败：" + r.error
      : autoDl.checked ? "缺模型时将自动下载。" : "缺模型时将直接报错，不再自动下载。";
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
    (p.probe ? `　（本机探测：${p.probe}）` : "") +
    ((p.models || []).length ? " 示例模型可能已更新，点「测试连接」可拉取真实列表。" : "");
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
    $("llm-test-status").textContent = "测试中…";
    $("llm-model-list").innerHTML = "";
    try {
      const r = await window.a2n.llmTest({
        provider: $("llm-provider").value,
        baseUrl: $("llm-baseurl").value.trim(),
        apiKey: $("llm-apikey").value.trim(),
        model: $("llm-model").value.trim(),
      });
      if (!r.ok) {
        $("llm-test-status").textContent = `✗ 连接失败：${r.error}${r.ms ? `（${r.ms}ms）` : ""}`;
        $("llm-test-status").classList.add("warn");
        return;
      }
      const warn = r.modelPresent === false ? " ⚠️ 填写的模型不在已安装列表里" : "";
      $("llm-test-status").textContent = `✓ ${r.note}（${r.ms}ms）${warn}`;
      if (r.modelPresent === false) $("llm-test-status").classList.add("warn");
      if (r.models && r.models.length) {
        $("llm-model-list").innerHTML = r.models
          .slice(0, 30)
          .map((m) => `<div class="dirrow"><span>${esc(m)}</span><button class="ghost pick" data-m="${esc(m)}">用这个</button></div>`)
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
    $("llm-test-status").textContent = "✓ 已保存为笔记接口";
  });
}

if (window.a2n.onModels) {
  window.a2n.onModels((p) => {
    if (!p || !modelBusy || p.kind !== modelBusy.kind) return;
    modelBusy.message =
      p.message || (p.percent != null ? `下载中 ${p.percent}%${p.file ? " · " + String(p.file).split("/").pop() : ""}` : "下载中…");
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
    if (el) el.textContent = "电源模式读取失败：" + e.message;
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
      b.textContent = m.icon + " " + m.label;
      b.title = m.desc;
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
    for (const b of box.querySelectorAll("button")) b.classList.toggle("active", b.dataset.mode === st.requested);
  }
  const pref = $("power-batt-pref");
  if (pref) {
    pref.value = st.batteryPreference || "eco";
    pref.hidden = st.requested !== "auto";
  }
  const p = st.profile || {};
  const lines = [`${st.onBattery ? "🔋 电池供电" : "🔌 插电"} · ${st.describe || ""}`];
  if (p.engine && p.engine.reason) lines.push("⚠️ " + p.engine.reason);
  if (p.notes && p.notes.length) lines.push(...p.notes.map((n) => "· " + n));
  const el = $("power-status");
  el.textContent = lines.join("\n");
  el.style.whiteSpace = "pre-line";

  const jobs = st.queue || [];
  $("queue-box").hidden = jobs.length === 0;
  if (jobs.length) {
    $("queue-list").innerHTML = jobs
      .map(
        (j) =>
          `<div class="dirrow"><span>${esc(String(j.dir).split(/[\\/]/).pop())}</span><span>${
            j.durationSec ? Math.round(j.durationSec / 60) + " 分钟 · " : ""
          }${esc(j.reason || "")}${j.attempts ? " · 重试 " + j.attempts : ""}</span></div>`
      )
      .join("");
    $("btn-queue-run").textContent = st.queueRunning ? "处理中…" : "立即处理";
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
    queueRunBtn.textContent = "处理中…";
    await window.a2n.queueRunNow();
    await loadPower();
  });
}
if (window.a2n.onPower) window.a2n.onPower(() => loadPower());
if (window.a2n.onQueue) {
  window.a2n.onQueue((e) => {
    if (e && e.type === "start") {
      $("pipeline").textContent = `处理排队会议：${String(e.dir).split(/[\\/]/).pop()}…`;
    }
    loadPower();
  });
}

/* ---- results: notes + chunked transcript + translation toggles ---------- */
function showResult(res) {
  $("result-card").hidden = false;
  lastResult = { notes: res.notes, notesZh: res.notesZh || null, chunks: res.chunks || [] };
  $("notes-provider").textContent = res.provider || "";
  $("detail-level").value = cfg && cfg.notes.detailLevel || "standard";
  updateNotes();
  renderChunks();
  loadSpeakers();

  // Surface degradation loudly: a failed LLM call must never look like a real summary.
  const warn = [];
  if (res.notesFallbackReason) {
    warn.push(`⚠️ 摘要降级为规则提取（原因：${res.notesFallbackReason}）—— 笔记顶部已标注，点「重新生成」可重试`);
  }
  if (res.notesWarnings && res.notesWarnings.length) warn.push(...res.notesWarnings);
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
  $("btn-diarize").title = st && st.hasSource ? "" : "这个会议没有可用的音频（system/mixed）";
  renderSpeakerRows();
}

function renderSpeakerRows() {
  const box = $("speaker-rows");
  box.innerHTML = "";
  if (!speakers.length) {
    box.innerHTML =
      '<div class="hint">还没有识别发言人——点「识别发言人」按声音把他们分开（本地运行，首次会下载 27 MB 声纹模型）。</div>';
    return;
  }
  for (const s of speakers) {
    const row = document.createElement("div");
    row.className = "speaker-row";

    const play = document.createElement("button");
    play.className = "play";
    play.textContent = auditionId === s.id ? "■" : "▶";
    play.title = s.sample
      ? `试听 ${(s.sample.durationSec || 0).toFixed(1)} 秒样本` + (s.lowConfidence ? "（样本偏短，可能不准）" : "")
      : "没有样本";
    play.disabled = !s.sample;
    if (s.lowConfidence) play.classList.add("lowconf");
    play.addEventListener("click", () => toggleAudition(s));

    const label = document.createElement("span");
    label.className = "spk-label";
    label.textContent = s.id.replace(/^spk/, "发言人");

    const input = document.createElement("input");
    input.type = "text";
    input.className = "spk-name";
    input.placeholder = "填名字…";
    input.value = s.name || "";
    const commit = async () => {
      const v = input.value.trim();
      if (v === (s.name || "")) return;
      const res = await window.a2n.speakersSetName({ dir: currentDir, speakerId: s.id, name: v });
      if (res.error) {
        $("diarize-status").textContent = "改名失败：" + res.error;
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
            lastResult.notes = m.notes;
            lastResult.notesZh = m.notesZh || null;
            updateNotes();
          }
        } catch (e) {
          console.error("notes refresh after rename failed:", e);
        }
      }
      $("diarize-status").textContent = res.notesPatched
        ? `已更新：转写全部生效，笔记里 ${res.notesPatched} 处旧名字也一起改了`
        : "已更新：转写全部生效（笔记里没有出现旧名字）";
    };
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") input.blur(); });
    input.addEventListener("blur", commit);

    const meta = document.createElement("span");
    meta.className = "spk-meta";
    meta.textContent = `${s.segments} 段 · ${fmtDur(s.durationSec)}` + (s.lowConfidence ? " · ⚠样本短" : "");

    row.append(play, label, input, meta);

    if (speakers.length > 1) {
      const merge = document.createElement("select");
      merge.className = "spk-merge compact";
      merge.title = "把这一行合并到另一个发言人（修正过度切分）";
      const o0 = document.createElement("option");
      o0.value = "";
      o0.textContent = "合并到…";
      merge.appendChild(o0);
      for (const t of speakers) {
        if (t.id === s.id) continue;
        const o = document.createElement("option");
        o.value = t.id;
        o.textContent = t.name || t.id.replace(/^spk/, "发言人");
        merge.appendChild(o);
      }
      merge.addEventListener("change", async () => {
        const into = merge.value;
        if (!into) return;
        if (!confirm(`把「${s.name || s.id}」的所有片段合并到「${(speakers.find((x) => x.id === into) || {}).name || into}」？`)) {
          merge.value = "";
          return;
        }
        const res = await window.a2n.speakersMerge({ dir: currentDir, fromId: s.id, intoId: into });
        if (res.error) { $("diarize-status").textContent = "合并失败：" + res.error; return; }
        speakers = res.speakers;
        lastResult.chunks = res.chunks;
        renderChunks();
        renderSpeakerRows();
        $("diarize-status").textContent = "已合并。";
      });
      row.appendChild(merge);
    }
    box.appendChild(row);
  }
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
    $("diarize-status").textContent = "试听失败：" + r.error;
    return;
  }
  auditionAudio = new Audio(r.dataUrl);
  auditionId = s.id;
  auditionAudio.onended = () => { auditionAudio = null; auditionId = null; renderSpeakerRows(); };
  await auditionAudio.play().catch((e) => { $("diarize-status").textContent = "播放失败：" + e.message; });
  renderSpeakerRows();
}

$("btn-diarize").addEventListener("click", async () => {
  if (!currentDir) return;
  const btn = $("btn-diarize");
  btn.disabled = true;
  $("diarize-status").textContent = "识别中…（本地 CPU，长会议需要几分钟）";
  try {
    const res = await window.a2n.speakersDiarize({ dir: currentDir });
    if (res.error) {
      $("diarize-status").textContent = "失败：" + res.error;
      return;
    }
    speakers = res.speakers;
    lastResult.chunks = res.chunks || lastResult.chunks;
    renderChunks();
    renderSpeakerRows();
    const lowConf = res.speakers.filter((s) => s.lowConfidence).length;
    $("diarize-status").textContent =
      `识别到 ${res.speakers.length} 个发言人（按 ${res.source} 分析）` +
      (lowConf ? ` · ${lowConf} 个样本偏短` : "") +
      " —— 请逐个试听确认，填名字即可全场生效。";
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
    badge.textContent = c.speakerName || "说话人";
    badge.title = "点击改名";
    badge.addEventListener("click", async () => {
      const name = prompt(`为「${badge.textContent}」设置名字：`, badge.textContent);
      if (!name || !name.trim() || name.trim() === badge.textContent) return;
      // prefer the STABLE id when the chunk has one: renaming by id never breaks,
      // renaming by display string loses the link after the first change
      const byId = typeof c.speaker === "string" && /^spk\d+$/.test(c.speaker);
      const res = byId
        ? await window.a2n.speakersSetName({ dir: currentDir, speakerId: c.speaker, name: name.trim() })
        : await window.a2n.renameSpeaker({ dir: currentDir, from: badge.textContent, to: name.trim() });
      if (res.ok) {
        lastResult.chunks = res.chunks;
        if (byId && res.speakers) { speakers = res.speakers; renderSpeakerRows(); }
        renderChunks();
        $("regen-status").textContent = "说话人已更新 — 点「重新生成」刷新笔记里的归属。";
      } else {
        $("regen-status").textContent = "改名失败：" + (res.error || "unknown");
      }
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
      tr.textContent = (c.translated && c.translated.trim()) ? c.translated : "（无译文）";
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
  $("regen-status").textContent = "重新生成中…";
  try {
    const res = await window.a2n.regenerateNotes({
      dir: currentDir,
      detailLevel: $("detail-level").value,
    });
    if (res.error) {
      $("regen-status").textContent = "失败：" + res.error;
    } else {
      lastResult.notes = res.notes;
      lastResult.notesZh = res.notesZh || null;
      $("notes-provider").textContent = res.provider || "";
      updateNotes();
      $("regen-status").textContent = "已重新生成 ✓";
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
});
window.a2n.onPipeline((p) => {
  $("pipeline").textContent = p.message || p.phase || "";
  if (typeof p.progress === "number") setProgress(p.progress);
  if (p.phase === "done" || p.phase === "error") setProgress(p.phase === "done" ? 100 : 0);
});
window.a2n.onTranscript((t) => {
  if (lastResult) {
    lastResult.chunks = t.chunks || [];
    renderChunks();
  }
});

function setProgress(p) {
  $("progress-fill").style.width = Math.max(0, Math.min(100, p)) + "%";
}

/* ---- init ---- */
(async () => {
  await loadArchivePresets(); // must precede loadConfig (it selects a preset)
  await loadConfig();
  await loadPower();
  await loadModels(); // also surfaces a broken model cache at start-up
  await loadDevices();
  fillLlmFields();
})();
