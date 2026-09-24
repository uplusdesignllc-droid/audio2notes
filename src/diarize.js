"use strict";
/* Speaker diarization + voice enrollment (local, no Python) via sherpa-onnx.
 *
 * MEASURED ON THIS MACHINE (2026-09-11, see .cache/speaker-test/*.md):
 *   - 5 min of real meeting audio: diarization 19.6 s (15.3x realtime), 33 ms/embedding
 *   - on labeled reference files the model recovers the CORRECT speaker count at
 *     clustering threshold 0.7 (2-speaker file -> 2, 4-speaker file -> 4)
 *   - enrollment on clean audio: 100% recall, 0 false positives at threshold 0.4
 *   - on hard real-world audio NO threshold gives both high recall and low false
 *     positives (threshold 0.3: 94% recall but 12 false positives)
 * => auto-labelling is never silent. The UI always exposes a 5 s audition sample
 *    per speaker, the real name is typed by the user, and results are editable.
 *
 * Models:
 *   segmentation (pyannote-3.0 int8, 1.5 MB)  — bundled with the app
 *   embedding (3D-Speaker CAM++ zh/en, 27 MB) — downloaded on first use
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const https = require("https");
const { spawn } = require("child_process");

const ffmpegPath = require("./ffmpegPath").ffmpegPath();

const DEFAULT_THRESHOLD = 0.7; // validated against known speaker counts
const EMBEDDING_MODEL = "3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx";
const EMBEDDING_URL =
  "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/" + EMBEDDING_MODEL;
/* 28 281 164 bytes — the size of the release asset this app actually ships and
 * downloads, verified by SHA-256 AA3CFC16…CEBA2 on 2026-09-22. (The old value
 * 29596978 was documentation-grade wrong; the check below is `* 0.9` either way.) */
const EMBEDDING_BYTES = 28281164;

/** Bundled segmentation model, mapped out of asar when packaged. */
function segmentationModelPath() {
  let p = path.join(__dirname, "..", "assets", "models", "pyannote-segmentation-3-0.int8.onnx");
  if (p.includes("app.asar" + path.sep)) p = p.replace("app.asar" + path.sep, "app.asar.unpacked" + path.sep);
  return p;
}

/** Where a downloaded voiceprint model is cached (per-user). */
function embeddingModelPath(modelDir) {
  return path.join(modelDir, "speaker", EMBEDDING_MODEL);
}

/**
 * The voiceprint model BUNDLED INSIDE the app, mapped out of asar when packaged.
 *
 * It ships with the app so speaker recognition needs no network access on first
 * use: the 27 MB download used to be a hard prerequisite for the very first
 * recording, which made the feature silently unavailable offline. Apache-2.0 —
 * see assets/models/LICENSE-3d-speaker-campplus.txt, shipped beside the model.
 */
function bundledEmbeddingModelPath() {
  let p = path.join(__dirname, "..", "assets", "models", EMBEDDING_MODEL);
  if (p.includes("app.asar" + path.sep)) p = p.replace("app.asar" + path.sep, "app.asar.unpacked" + path.sep);
  return p;
}

/**
 * Is this a usable voiceprint model file? Size is the test the loader relies on.
 * A partial `.part` download never reaches the real filename, so size is enough.
 */
function embeddingReady(p) {
  try { return fs.statSync(p).size > EMBEDDING_BYTES * 0.9; } catch { return false; }
}

/**
 * Resolve which voiceprint model to actually load.
 *
 * The per-user cache WINS over the bundled copy, deliberately: a user who clicked
 * 下载 in Settings expects to be running what they downloaded (and 删除 must mean
 * something), so the bundle is the fallback, not an override. An explicitly passed
 * `modelDir` that already holds the file is honoured as-is, which keeps callers and
 * tests that manage their own directory working.
 *
 * `opts.bundledModelPath` overrides where the bundled copy is looked for. That exists
 * so tests can exercise BOTH branches (bundle present / absent) without moving the
 * real 27 MB file around; production callers never pass it.
 * @returns {string} the path to load, even if the file does not exist — callers that
 *   care about existence use `embeddingReady`/`modelsStatus`. Never throws.
 */
function resolveEmbeddingModel(modelDir, opts) {
  const bundled = (opts && opts.bundledModelPath) || bundledEmbeddingModelPath();
  try {
    const user = embeddingModelPath(modelDir);
    if (embeddingReady(user)) return user;
  } catch { /* fall through to the bundled copy */ }
  return bundled;
}

function modelsStatus(modelDir, opts) {
  const seg = segmentationModelPath();
  const user = embeddingModelPath(modelDir);
  const bundled = (opts && opts.bundledModelPath) || bundledEmbeddingModelPath();
  const has = (p, min) => {
    try { return fs.statSync(p).size > min; } catch { return false; }
  };
  const userReady = embeddingReady(user);
  const bundledReady = embeddingReady(bundled);
  const resolved = resolveEmbeddingModel(modelDir, opts);
  return {
    segmentation: { path: seg, ready: has(seg, 200000) },
    /* `path` stays the per-user download location so the Settings card keeps
     * offering 下载/删除 against it; `resolvedPath`/`source` say what will really be
     * loaded, which can now be the bundled copy. */
    embedding: {
      path: user,
      ready: userReady || bundledReady,
      downloaded: userReady,
      bundled: { path: bundled, ready: bundledReady },
      resolvedPath: resolved,
      source: userReady ? "downloaded" : bundledReady ? "bundled" : null,
    },
  };
}

/**
 * Pure preflight for automatic diarization: is every native/model prerequisite
 * present? Never throws, never downloads, never spawns anything — the caller uses
 * it to decide whether to skip with an honest reason instead of failing mid-pipeline.
 * `reason` is user-facing copy; `missing` is the MACHINE-READABLE classification
 * (null | "sherpa" | "segmentation" | "embedding") callers must branch on, so
 * editing the message can never silently change what the pipeline does.
 */
function preflight(o) {
  // Destructured from `o || {}` rather than in the parameter list: a destructuring
  // parameter throws on null before any guard can run, and this is called from inside
  // the recording pipeline, where a throw costs the user their notes.
  const { modelDir, sherpaReady, bundledModelPath } = o || {};
  if (!sherpaReady) {
    return { ok: false, missing: "sherpa", reason: "sherpa-onnx 不可用：" + String(sherpaReady === undefined ? "未检测" : sherpaReady) };
  }
  const seg = segmentationModelPath();
  let segOk = false;
  try { segOk = fs.statSync(seg).size > 200000; } catch { segOk = false; }
  if (!segOk) return { ok: false, missing: "segmentation", reason: "缺少分割模型" };
  /* Uses the same resolution as the real run, so the BUNDLED copy counts and a fresh
   * install is ready immediately instead of reporting "not downloaded". Never
   * downloads: a model that is absent everywhere is reported, not fetched. */
  const emb = resolveEmbeddingModel(modelDir, { bundledModelPath });
  if (!embeddingReady(emb)) {
    return { ok: false, missing: "embedding", reason: "声纹模型尚未下载（首次识别需要下载约 27 MB）" };
  }
  return { ok: true, missing: null, reason: null };
}

function download(url, dest, onProgress, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 8) return reject(new Error("重定向过多"));
    const req = https.get(url, { headers: { "User-Agent": "audio2notes" } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(download(new URL(res.headers.location, url).toString(), dest, onProgress, redirects + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`下载失败 HTTP ${res.statusCode}`));
      }
      const total = Number(res.headers["content-length"] || 0);
      let got = 0;
      const tmp = dest + ".part";
      const ws = fs.createWriteStream(tmp);
      res.on("data", (c) => {
        got += c.length;
        if (onProgress && total) onProgress({ received: got, total, percent: Math.floor((got / total) * 100) });
      });
      res.pipe(ws);
      ws.on("finish", () => {
        try { fs.renameSync(tmp, dest); } catch (e) { return reject(e); }
        resolve(dest);
      });
      ws.on("error", (e) => { try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ } reject(e); });
    });
    req.on("error", reject);
    req.setTimeout(120000, () => req.destroy(new Error("下载超时")));
  });
}

/** Download the embedding model if missing. */
async function ensureEmbeddingModel(modelDir, onProgress) {
  const dest = embeddingModelPath(modelDir);
  const st = modelsStatus(modelDir);
  if (st.embedding.ready) return dest;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (onProgress) onProgress({ phase: "download-start", percent: 0 });
  await download(EMBEDDING_URL, dest, (p) => onProgress && onProgress({ phase: "downloading", ...p }));
  if (!modelsStatus(modelDir).embedding.ready) throw new Error("声纹模型下载不完整");
  return dest;
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath, args, { stdio: "ignore", windowsHide: true });
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error("ffmpeg exit " + code))));
  });
}

/** Decode any audio file to 16 kHz mono float32 samples. */
async function decodeToSamples(audioPath, workDir) {
  const raw = path.join(workDir, `diarize-${process.pid}-${Date.now()}.raw`);
  await runFfmpeg(["-y", "-v", "error", "-i", audioPath, "-ar", "16000", "-ac", "1", "-f", "f32le", raw]);
  const buf = fs.readFileSync(raw);
  try { fs.rmSync(raw, { force: true }); } catch { /* ignore */ }
  return new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
}

function loadSherpa() {
  // resolved lazily so a missing native module never breaks app start-up
  return require("sherpa-onnx-node");
}

/**
 * Diarize an audio file.
 * @returns {Promise<{sampleRate:number, threshold:number, segments:Array, speakers:Array}>}
 *   segments: [{ start, end, speakerId }]  with speakerId = "spk1", "spk2" … ordered by speech time
 */
async function diarize({ audioPath, modelDir, threshold = DEFAULT_THRESHOLD, numThreads = 4, workDir, onProgress } = {}) {
  const st = modelsStatus(modelDir);
  if (!st.segmentation.ready) throw new Error("缺少分割模型（assets/models/pyannote-segmentation-3-0.int8.onnx）");
  /* A usable model — a previously downloaded copy, else the one bundled inside the
   * app — is used as-is. Only when NEITHER exists is anything fetched, so shipping
   * the model really does remove the first-run network dependency. */
  const embPath = st.embedding.ready ? st.embedding.resolvedPath : await ensureEmbeddingModel(modelDir, onProgress);
  const sherpa = loadSherpa();
  const wd = workDir || os.tmpdir();
  if (onProgress) onProgress({ phase: "decoding" });
  const samples = await decodeToSamples(audioPath, wd);

  if (onProgress) onProgress({ phase: "diarizing" });
  const sd = new sherpa.OfflineSpeakerDiarization({
    segmentation: { pyannote: { model: segmentationModelPath() }, numThreads, provider: "cpu" },
    embedding: { model: embPath, numThreads, provider: "cpu" },
    clustering: { numClusters: -1, threshold },
    minDurationOn: 0.3,
    minDurationOff: 0.5,
  });

  const raw = sd.process(samples);
  if (onProgress) onProgress({ phase: "labelling" });

  // stable ids ordered by how much each cluster speaks (spk1 = the main speaker)
  const dur = new Map();
  for (const s of raw) dur.set(s.speaker, (dur.get(s.speaker) || 0) + Math.max(0, s.end - s.start));
  const order = [...dur.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
  const idOf = new Map(order.map((k, i) => [k, `spk${i + 1}`]));

  const segments = raw
    .map((s) => ({ start: s.start, end: s.end, speakerId: idOf.get(s.speaker) }))
    .sort((a, b) => a.start - b.start);

  const speakers = order.map((k) => ({
    id: idOf.get(k),
    durationSec: Math.round((dur.get(k) || 0) * 10) / 10,
    segmentCount: segments.filter((s) => s.speakerId === idOf.get(k)).length,
  }));

  return { sampleRate: sd.sampleRate, threshold, segments, speakers, audioDurationSec: samples.length / sd.sampleRate };
}

/**
 * Pick one clean audition sample per speaker and cut it from the source audio.
 * The SAME clip doubles as the voiceprint source, so what the user hears is
 * exactly what the matcher uses.
 * @returns {Promise<Object>} sample info keyed by speakerId
 */
async function buildSamples({ audioPath, speakers, segments, outDir, targetSec = 5, minSec = 3 } = {}) {
  const samplesDir = path.join(outDir, "samples");
  fs.mkdirSync(samplesDir, { recursive: true });
  const out = {};
  for (const sp of speakers) {
    const own = segments.filter((s) => s.speakerId === sp.id).sort((a, b) => (b.end - b.start) - (a.end - a.start));
    if (!own.length) continue;
    const best = own.find((s) => s.end - s.start >= minSec) || own[0];
    const dur = Math.min(targetSec, Math.max(0.5, best.end - best.start));
    const file = path.join(samplesDir, `${sp.id}.opus`);
    await runFfmpeg([
      "-y", "-v", "error",
      "-ss", best.start.toFixed(3), "-t", dur.toFixed(3),
      "-i", audioPath,
      "-ar", "16000", "-ac", "1",
      "-c:a", "libopus", "-b:a", "24k", "-application", "voip", "-vbr", "on",
      // short fades avoid clicks when the cut lands mid-syllable
      "-af", "afade=t=in:st=0:d=0.05,afade=t=out:st=" + Math.max(0, dur - 0.05).toFixed(3) + ":d=0.05",
      file,
    ]);
    out[sp.id] = {
      file: path.join("samples", `${sp.id}.opus`),
      start: Math.round(best.start * 100) / 100,
      end: Math.round((best.start + dur) * 100) / 100,
      durationSec: Math.round(dur * 100) / 100,
      sourceSec: Math.round((best.end - best.start) * 100) / 100,
    };
  }
  return out;
}

/**
 * Give every transcript chunk the speaker of the diarization segment it overlaps most.
 *
 * `skipId` (default "you") marks the chunk identity that diarization must NOT touch.
 * This is load-bearing, not a nicety: the transcript is a SINGLE interleaved array in
 * which mic chunks are tagged `speaker: "you"` and system chunks `"remote"`
 * (meetings.mergeTracks), while diarization only ever analyses the SYSTEM track. So
 * without the guard, every mic chunk that overlaps a remote speaker's segment — or
 * merely follows one, via the `last` fallback below — has its `"you"` identity
 * overwritten with a remote `spkN`, i.e. the user's own speech is attributed to
 * someone else in the transcript, the notes prompt and the 发言人 panel. Measured on
 * a real 240 s recording: 2/2 mic chunks were relabelled this way.
 * Pass `skipId: null` only if the chunk array is known to contain remote audio only.
 */
function assignToChunks(chunks, segments, fallbackId = null, skipId = "you") {
  let last = fallbackId;
  for (const c of chunks || []) {
    // A chunk from the physically separate microphone path keeps its own identity:
    // it is not part of the audio diarization looked at, so it has no spkN to map to.
    if (skipId && c.speaker === skipId) continue;
    let best = null;
    let bestOverlap = 0;
    for (const s of segments) {
      const ov = Math.min(c.end, s.end) - Math.max(c.start, s.start);
      if (ov > bestOverlap) { bestOverlap = ov; best = s; }
    }
    // require a meaningful overlap, otherwise keep the previous speaker
    const cDur = Math.max(0.01, c.end - c.start);
    if (best && bestOverlap / cDur >= 0.25) {
      c.speaker = best.speakerId;
      last = best.speakerId;
    } else if (last) {
      c.speaker = last;
    }
  }
  return chunks;
}

/* ---- persisted speaker record per meeting (speakers.json) ---------------- */

function speakersFile(dir) {
  return path.join(dir, "speakers.json");
}

function loadSpeakers(dir) {
  try {
    return JSON.parse(fs.readFileSync(speakersFile(dir), "utf8"));
  } catch {
    return null;
  }
}

function saveSpeakers(dir, obj) {
  fs.writeFileSync(speakersFile(dir), JSON.stringify(obj, null, 2), "utf8");
  return obj;
}

/** Display name for a stable speaker id (falls back to 发言人N / 你 / 远端). */
function displayName(speakerId, speakers) {
  const s = (speakers || []).find((x) => x.id === speakerId);
  if (s && s.name) return s.name;
  if (speakerId === "you") return "你";
  if (speakerId === "remote") return "远端";
  if (typeof speakerId === "string" && /^spk\d+$/.test(speakerId)) return "发言人" + speakerId.slice(3);
  return speakerId || "说话人";
}

/**
 * Replace a speaker's old display name inside generated TEXT (notes.md /
 * notes.zh.md). Those files are LLM snapshots, so unlike the transcript they are
 * NOT re-derived from the chunks when a speaker is renamed.
 *
 * Boundary care for fallback names: "发言人1" must not match inside "发言人10",
 * so a fallback name is only replaced when it is not followed by a digit.
 * @returns {{text:string, count:number}}
 */
function replaceSpeakerName(text, oldName, newName) {
  const src = String(text == null ? "" : text);
  const from = String(oldName == null ? "" : oldName).trim();
  const to = String(newName == null ? "" : newName).trim();
  // An empty target is a NO-OP: substituting "" would silently delete the
  // speaker's name out of the notes. Callers pass a display name, which falls
  // back to 发言人N when the user clears the field — never an empty string.
  if (!src || !from || !to || from === to) return { text: src, count: 0 };
  const esc = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const isFallback = /^发言人\d+$/.test(from);
  const re = new RegExp(esc + (isFallback ? "(?!\\d)" : ""), "g");
  const count = (src.match(re) || []).length;
  return { text: src.replace(re, to), count };
}

/** Stamp speakerName on every chunk from its STABLE id. Mutates and returns chunks. */
function applyNames(speakers, chunks) {
  for (const c of chunks || []) {
    if (!c.speaker) continue;
    c.speakerName = displayName(c.speaker, speakers);
  }
  return chunks;
}

/** Set (or clear) one speaker's name. Mutates the record. */
function renameInRecord(rec, speakerId, name) {
  const s = (rec.speakers || []).find((x) => x.id === speakerId);
  if (!s) return null;
  const clean = String(name == null ? "" : name).trim();
  s.name = clean || null;
  return s;
}

/** Merge one speaker into another (fixes over-segmentation). Mutates the record. */
function mergeInRecord(rec, fromId, intoId) {
  const from = (rec.speakers || []).find((x) => x.id === fromId);
  const into = (rec.speakers || []).find((x) => x.id === intoId);
  if (!from || !into || from === into) return null;
  into.segments += from.segments;
  into.durationSec = Math.round((into.durationSec + from.durationSec) * 10) / 10;
  if (from.name && !into.name) into.name = from.name;
  into.lowConfidence = !!(into.lowConfidence && from.lowConfidence);
  rec.speakers = rec.speakers.filter((x) => x !== from);
  for (const seg of rec.segments || []) if (seg.speakerId === fromId) seg.speakerId = intoId;
  return { from, into };
}

module.exports = {
  DEFAULT_THRESHOLD,
  EMBEDDING_MODEL,
  EMBEDDING_URL,
  EMBEDDING_BYTES,
  segmentationModelPath,
  embeddingModelPath,
  bundledEmbeddingModelPath,
  resolveEmbeddingModel,
  modelsStatus,
  preflight,
  ensureEmbeddingModel,
  diarize,
  buildSamples,
  assignToChunks,
  loadSpeakers,
  saveSpeakers,
  speakersFile,
  decodeToSamples,
  displayName,
  applyNames,
  renameInRecord,
  mergeInRecord,
  replaceSpeakerName,
};
