"use strict";
/* Model status / download / delete for everything the app needs locally.
 *
 * Why this exists: transcription and speaker diarization both download their
 * models on first use, but the UI only ever showed a fleeting line in the
 * pipeline log — no way to see what is present, pre-download, free space, or
 * point the downloader at a mirror. This module is the single source of truth
 * for that, and it never throws at the caller.
 *
 * Layout (all under the app's model cache dir, overridable in settings):
 *   <cache>/Xenova/<whisper-model>/…            Whisper (transformers.js layout)
 *   <cache>/speaker/<embedding-model>.onnx      speaker voiceprints
 *   <bundle>/assets/models/…                    segmentation model, shipped with the app
 */

const fs = require("fs");
const path = require("path");
const diarize = require("./diarize");

/** Whisper variants with rough download sizes (MB) for the UI. */
const WHISPER = [
  { id: "Xenova/whisper-tiny.en", label: "tiny.en（最快，仅英文）", approxMB: 41 },
  { id: "Xenova/whisper-tiny", label: "tiny（最快，多语言）", approxMB: 41 },
  { id: "Xenova/whisper-base.en", label: "base.en（推荐，仅英文）", approxMB: 75 },
  { id: "Xenova/whisper-base", label: "base（推荐，多语言）", approxMB: 75 },
  { id: "Xenova/whisper-small.en", label: "small.en（更准，更慢）", approxMB: 250 },
  { id: "Xenova/whisper-small", label: "small（更准，更慢，多语言）", approxMB: 250 },
];

const REQUIRED_ONNX = [
  path.join("onnx", "encoder_model_quantized.onnx"),
  path.join("onnx", "decoder_model_merged_quantized.onnx"),
];

function shortName(model) {
  return String(model || "").replace(/^Xenova\//, "");
}

function dirSize(dir) {
  let total = 0;
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else {
        try { total += fs.statSync(p).size; } catch { /* ignore */ }
      }
    }
  };
  walk(dir);
  return total;
}

/* ---- Whisper ------------------------------------------------------------- */

function whisperDir(cacheDir, model) {
  return path.join(cacheDir, "Xenova", shortName(model));
}

/** Ready = every required ONNX file is present and non-trivial. */
function whisperStatus(cacheDir, model) {
  const dir = whisperDir(cacheDir, model);
  const files = REQUIRED_ONNX.map((rel) => {
    const p = path.join(dir, rel);
    let bytes = 0;
    try { bytes = fs.statSync(p).size; } catch { /* missing */ }
    return { rel, bytes, present: bytes > 1024 * 1024 };
  });
  const ready = files.every((f) => f.present);
  return {
    id: model,
    short: shortName(model),
    dir,
    ready,
    bytes: ready ? dirSize(dir) : files.reduce((a, f) => a + f.bytes, 0),
    files,
  };
}

/** Download a Whisper model into the cache (transformers.js does the fetching). */
async function downloadWhisper({ model, cacheDir, endpoint, onProgress }) {
  const { pipeline, env } = require("@xenova/transformers");
  if (endpoint) env.remoteHost = endpoint;
  fs.mkdirSync(path.join(cacheDir, "Xenova", shortName(model)), { recursive: true });
  const progress = (p) => {
    if (!onProgress || !p) return;
    if (p.status === "progress" && p.file) {
      onProgress({ file: p.file, percent: Math.round(p.progress || 0), loaded: p.loaded, total: p.total });
    } else if (p.status === "done" && p.file) {
      onProgress({ file: p.file, percent: 100, done: true });
    }
  };
  const pipe = await pipeline("automatic-speech-recognition", model, {
    dtype: "q8",
    cache_dir: cacheDir,
    progress_callback: progress,
  });
  try { if (typeof pipe.dispose === "function") await pipe.dispose(); } catch { /* ignore */ }
  return whisperStatus(cacheDir, model);
}

function deleteWhisper(cacheDir, model) {
  const dir = whisperDir(cacheDir, model);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    return { ok: true, removed: dir };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/* ---- speaker embedding + segmentation ----------------------------------- */

function voiceprintStatus(cacheDir) {
  const st = diarize.modelsStatus(cacheDir);
  // `path` stays the PER-USER download location: the Settings card's 下载/删除 act on
  // it. `bundled`/`source` say whether a usable model ships with the app, and
  // `bytes` reports the copy that would actually be loaded.
  let bytes = 0;
  try { bytes = fs.statSync(st.embedding.resolvedPath).size; } catch { /* missing */ }
  return {
    id: diarize.EMBEDDING_MODEL,
    ready: st.embedding.ready,                  // usable from EITHER source
    downloaded: st.embedding.downloaded,        // present in the per-user cache
    source: st.embedding.source,                // "downloaded" | "bundled" | null
    bundled: st.embedding.bundled,
    bytes,
    approxMB: 28,
    path: st.embedding.path,
    resolvedPath: st.embedding.resolvedPath,
    url: diarize.EMBEDDING_URL,
  };
}

function segmentationStatus() {
  const st = diarize.modelsStatus("");
  let bytes = 0;
  try { bytes = fs.statSync(st.segmentation.path).size; } catch { /* missing */ }
  return { ready: st.segmentation.ready, bytes, path: st.segmentation.path, bundled: true };
}

async function downloadVoiceprint({ cacheDir, onProgress }) {
  await diarize.ensureEmbeddingModel(cacheDir, (p) => {
    if (onProgress && p && p.phase === "downloading") onProgress({ percent: p.percent, loaded: p.received, total: p.total });
  });
  return voiceprintStatus(cacheDir);
}

/**
 * Delete the PER-USER voiceprint cache only.
 *
 * Uses the unresolved cache path on purpose: resolution now falls back to the model
 * BUNDLED inside the app, so deleting the resolved path would try to remove the
 * shipped copy (and in a packaged build, a file inside app.asar.unpacked). Removing
 * the user cache is correct — the bundled fallback keeps speaker recognition working.
 */
function deleteVoiceprint(cacheDir) {
  const p = diarize.embeddingModelPath(cacheDir);
  try {
    fs.rmSync(p, { force: true });
    return { ok: true, removed: p };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/* ---- aggregate ----------------------------------------------------------- */

function status(cacheDir, currentModel) {
  const whisper = WHISPER.map((w) => {
    const s = whisperStatus(cacheDir, w.id);
    return { ...w, ...s, current: w.id === currentModel };
  });
  return {
    cacheDir,
    whisper,
    current: currentModel,
    voiceprint: voiceprintStatus(cacheDir),
    segmentation: segmentationStatus(),
    totalBytes: whisper.reduce((a, w) => a + (w.ready ? w.bytes : 0), 0) + voiceprintStatus(cacheDir).bytes,
  };
}

/** Guard used before transcription: refuses to start when the model is missing and
 *  automatic downloading has been switched off, instead of letting the downloader
 *  quietly fetch it anyway (which would make the toggle a lie). */
function assertReady({ cacheDir, model, autoDownload }) {
  const st = whisperStatus(cacheDir, model);
  if (st.ready || autoDownload !== false) return st;
  throw new Error(
    `转写模型 ${shortName(model)} 尚未下载，且「缺模型时自动下载」已关闭。` +
      `请在「模型与接口」页点「下载」，或重新打开自动下载。`
  );
}

module.exports = {
  WHISPER,
  shortName,
  whisperDir,
  whisperStatus,
  downloadWhisper,
  deleteWhisper,
  assertReady,
  voiceprintStatus,
  downloadVoiceprint,
  deleteVoiceprint,
  segmentationStatus,
  status,
};
