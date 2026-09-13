"use strict";
/* Whisper transcription via @xenova/transformers (local, WASM).
 * ffmpeg decodes the wav to 16 kHz mono float32 raw (written to a file —
 * no stdio pipes, sandbox-safe).
 *
 * LONG-SILENCE SKIPPING — MEASURED on the 2026-09-02 155.5 min meeting:
 *   system.opus   5.5% silent (LEVEL log)  -> almost all real speech
 *   mic.opus     98.3% silent (LEVEL log), 9203.5 s of digital silence measured
 * whisper-base.en runs at RTF 2.19x on CPU here, so the mic track alone burned
 * ~70 minutes of CPU transcribing silence. Every 0.5 s frame is therefore
 * measured in dBFS first (pure JS — no whisper, no ffmpeg, no new dependency)
 * and only LONG silent runs are cut before the pipeline is called.
 *
 * Nothing else changes: a track with nothing worth cutting still takes exactly
 * ONE pipeline call on the full array, and the chunk mapping is the same code
 * with an offset of 0.
 */
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ffmpegPath = require("./ffmpegPath").ffmpegPath();

const MODELS = [
  "Xenova/whisper-tiny.en",
  "Xenova/whisper-tiny",
  "Xenova/whisper-base.en",
  "Xenova/whisper-base",
  "Xenova/whisper-small.en",
  "Xenova/whisper-small",
];

/* ---- long-silence skipping ---------------------------------------------- */
const SAMPLE_RATE = 16000;
const SILENCE_FRAME_SEC = 0.5;        // RMS analysis window
const SILENCE_REF_PERCENTILE = 0.95;  // per-track reference level (adapts to each gain)
const SILENCE_REL_DB = 40;            // a frame is SILENT when this far below the reference
const SILENCE_SKIP_MIN_SEC = 20;      // only silent runs LONGER than this are candidates
const KEEP_PAD_SEC = 5;               // quiet lead-in/out kept around every cut
const SILENCE_FLOOR_PERCENTILE = 0.05; // the track's "quiet level" (its noise floor)
const SILENCE_FLOOR_BAND_DB = 3;      // frames this close to the quiet level ARE that floor
const DB_FLOOR = -200;                // digital silence, kept finite so percentiles stay arithmetic

const round1 = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : null);

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath, args, { stdio: "ignore", windowsHide: true });
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error("ffmpeg exit " + code))));
  });
}

async function decodeToRaw16k(wavFile, rawFile) {
  await runFfmpeg([
    "-y", "-v", "error",
    "-i", wavFile,
    "-ar", "16000", "-ac", "1",
    "-f", "f32le", rawFile,
  ]);
  return fs.readFileSync(rawFile);
}

/* ---- pure-JS audio analysis (no model, no ffmpeg) ------------------------ */

/**
 * Per-frame RMS in dBFS (0 dBFS = full scale 1.0). Digital silence is reported
 * as DB_FLOOR instead of -Infinity so percentile arithmetic stays finite.
 * @param {Float32Array} pcm 16 kHz mono
 * @returns {Float64Array} one value per whole frame (a trailing part-frame is dropped)
 */
function frameRmsDb(pcm, frameSec = SILENCE_FRAME_SEC, sampleRate = SAMPLE_RATE) {
  const step = Math.max(1, Math.round(frameSec * sampleRate));
  const n = Math.floor(pcm.length / step);
  const out = new Float64Array(n);
  for (let f = 0; f < n; f++) {
    const off = f * step;
    let sum = 0;
    for (let i = 0; i < step; i++) {
      const v = pcm[off + i];
      sum += v * v;
    }
    const rms = Math.sqrt(sum / step);
    out[f] = rms > 0 ? Math.max(DB_FLOOR, 20 * Math.log10(rms)) : DB_FLOOR;
  }
  return out;
}

/** Linear-interpolated percentile (the numpy.percentile default convention). */
function percentile(values, p) {
  if (!values.length) return DB_FLOOR;
  const sorted = Float64Array.from(values).sort();
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.min(sorted.length - 1, lo + 1);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/**
 * Silence map for one already-decoded track. Pure JS: this is what lets a
 * 155-minute track be analysed in seconds instead of hours of whisper.
 *
 * Reference level = 95th percentile of the frame RMS, so the detector adapts to
 * the recording's own gain. A frame is silent when it sits more than
 * SILENCE_REL_DB below that reference. Consecutive silent frames are merged into
 * runs; only runs longer than SILENCE_SKIP_MIN_SEC are cut, and only the inside
 * of such a run is removed (KEEP_PAD_SEC stays at each end so no speech onset is
 * clipped). Runs of SILENCE_SKIP_MIN_SEC or less are never cut.
 *
 * WHY THE PERCENTILE IS TAKEN OVER THE SIGNAL FRAMES — MEASURED, twice:
 * On a normal track (system.opus: 8.3% of frames silent by dBFS) the plain 95th
 * percentile of ALL frames is a speech-level estimate, -18.6 dBFS, and the 40 dB
 * gate below it works exactly as designed (773.5 s silent, 1 run over 20 s,
 * 12.0 s cut). On a muted-mic track the same rule is DEGENERATE: mic.opus has
 * 96.91% of its frames sitting on one single noise floor (18088 of 18664 frames
 * within 0.001 dB of each other at -100.0 dBFS), so the 95th percentile IS that
 * floor, the 40 dB gate lands at -140 dBFS, nothing is ever silent and the whole
 * 2.6 h track goes to whisper — the exact waste this feature exists to remove.
 * The reference is therefore taken over the frames that are NOT sitting on the
 * track's quiet floor (the 5th percentile, +/- SILENCE_FLOOR_BAND_DB). On
 * system.opus that band holds 6% of the frames and the reference moves only
 * -18.6 -> -18.5 dBFS (same 12.0 s cut); on mic.opus it recovers the speech
 * level and the measured 9203.5 s of silence is found. Floor frames are never
 * "signal" by this rule, so a quiet-but-real track is still judged on its own
 * quiet speech rather than on a lone loud click.
 *
 * @param {Float32Array} pcm
 * @returns {{frameSec:number, frames:number, totalSec:number, refDbfs:number,
 *   thresholdDbfs:number, floorDbfs:number, floorFramePct:number, refBasis:string,
 *   silentSec:number, silentPct:number, allSilent:boolean,
 *   runs:Array, longRuns:Array, cuts:Array, segments:Array,
 *   silenceSkippedSec:number, speechKeptSec:number}}
 */
function analyzeSilence(pcm, opts = {}) {
  const frameSec = opts.frameSec || SILENCE_FRAME_SEC;
  const minRunSec = opts.minRunSec == null ? SILENCE_SKIP_MIN_SEC : opts.minRunSec;
  const padSec = opts.padSec == null ? KEEP_PAD_SEC : opts.padSec;
  const relDb = opts.relDb == null ? SILENCE_REL_DB : opts.relDb;
  const totalSec = pcm.length / SAMPLE_RATE;

  const frames = frameRmsDb(pcm, frameSec);
  const floorDbfs = percentile(frames, SILENCE_FLOOR_PERCENTILE);
  const floorCeilDbfs = floorDbfs + SILENCE_FLOOR_BAND_DB;

  /* The quiet floor is excluded from the reference population — see the header
   * comment for the measured reason (a 96.91%-silent mic track otherwise makes
   * the 95th percentile the floor itself and cuts nothing). */
  let signalFrames = 0;
  for (let i = 0; i < frames.length; i++) if (frames[i] > floorCeilDbfs) signalFrames++;
  const allSilent = signalFrames === 0; // every frame sits on one floor level
  const plainP95 = percentile(frames, SILENCE_REF_PERCENTILE);

  let refDbfs = plainP95;
  let refBasis = "p95-of-all-frames";
  if (allSilent) {
    // A fully muted track: no percentile can describe it, so all of it is silence.
    refDbfs = floorDbfs;
    refBasis = "all-silent";
  } else if (signalFrames < frames.length) {
    const signal = new Float64Array(signalFrames);
    let k = 0;
    for (let i = 0; i < frames.length; i++) if (frames[i] > floorCeilDbfs) signal[k++] = frames[i];
    refDbfs = percentile(signal, SILENCE_REF_PERCENTILE);
    refBasis = "p95-of-signal-frames";
  }
  const thresholdDbfs = refDbfs - relDb;

  let silentFrames = 0;
  const silent = new Uint8Array(frames.length);
  for (let i = 0; i < frames.length; i++) {
    const isSilent = allSilent || frames[i] < thresholdDbfs;
    silent[i] = isSilent ? 1 : 0;
    if (isSilent) silentFrames++;
  }

  // merge consecutive silent frames into runs (seconds, clamped to the track)
  const runs = [];
  let runStart = -1;
  for (let i = 0; i <= frames.length; i++) {
    if (i < frames.length && silent[i]) {
      if (runStart < 0) runStart = i;
      continue;
    }
    if (runStart >= 0) {
      const startSec = runStart * frameSec;
      const endSec = Math.min(i * frameSec, totalSec);
      runs.push({ startSec, endSec, sec: Math.max(0, endSec - startSec) });
      runStart = -1;
    }
  }

  const longRuns = runs.filter((r) => r.sec > minRunSec);
  const cuts = [];
  for (const r of longRuns) {
    const a = Math.max(0, r.startSec + padSec);
    const b = Math.min(totalSec, r.endSec - padSec);
    if (b > a) cuts.push({ startSec: a, endSec: b, runSec: round1(r.sec) });
  }
  const segments = buildSegments(totalSec, cuts);

  const speechKeptSec = segments.reduce((s, g) => s + (g.endSec - g.startSec), 0);
  return {
    frameSec,
    frames: frames.length,
    totalSec,
    refDbfs,
    refBasis,
    thresholdDbfs,
    floorDbfs,
    floorFramePct: frames.length ? ((frames.length - signalFrames) / frames.length) * 100 : 0,
    silentSec: silentFrames * frameSec,
    silentPct: totalSec ? (silentFrames * frameSec) / totalSec * 100 : 0,
    allSilent,
    runs,
    longRuns,
    cuts,
    segments,
    silenceSkippedSec: Math.max(0, totalSec - speechKeptSec),
    speechKeptSec,
  };
}

/**
 * Surviving [startSec, endSec) segments covering the whole track with the cut
 * regions removed. Cuts are non-overlapping by construction; the clamp keeps
 * odd option combinations from producing negative or duplicated ranges.
 */
function buildSegments(totalSec, cuts) {
  const sorted = (cuts || [])
    .map((c) => ({ startSec: Math.max(0, c.startSec), endSec: Math.min(totalSec, c.endSec) }))
    .filter((c) => c.endSec > c.startSec)
    .sort((a, b) => a.startSec - b.startSec);
  const segs = [];
  let cursor = 0;
  for (const c of sorted) {
    const a = Math.max(cursor, c.startSec);
    if (a > cursor) segs.push({ startSec: cursor, endSec: a });
    cursor = Math.max(cursor, c.endSec);
  }
  if (cursor < totalSec) segs.push({ startSec: cursor, endSec: totalSec });
  return segs;
}

let pipeCache = null;

async function getPipeline(model, cacheDir, onProgress, endpoint) {
  if (pipeCache && pipeCache.model === model && pipeCache.cacheDir === cacheDir && pipeCache.endpoint === endpoint) {
    return pipeCache.pipe;
  }
  const { pipeline, env } = require("@xenova/transformers");
  // Point the downloader at a mirror when huggingface.co is unreachable.
  if (endpoint) env.remoteHost = endpoint;
  const pipe = await pipeline("automatic-speech-recognition", model, {
    dtype: "q8",
    cache_dir: cacheDir,
    progress_callback: onProgress || undefined,
  });
  pipeCache = { model, cacheDir, endpoint, pipe };
  return pipe;
}

/**
 * Transcribe a wav file.
 *
 * Long silent runs are cut before the model is called. When nothing is cut the
 * call is exactly the pre-existing one on the full array; when something is cut
 * the pipeline runs once per surviving segment and each returned timestamp is
 * shifted by that segment's start second.
 *
 * @param {object} o
 * @param {boolean} [o.silenceSkip=true] false = pre-change behaviour (one call, no analysis)
 * @returns {Promise<{text:string, chunks:Array, audio:object, silenceSkippedSec:number,
 *   speechKeptSec:number, totalSec:number, segments:number}>}
 */
async function transcribeFile({ wavFile, model, cacheDir, onProgress, onPartial, endpoint, silenceSkip = true }) {
  const rawFile = path.join(os.tmpdir(), `a2n-raw-${process.pid}-${Date.now()}.raw`);
  const bytes = await decodeToRaw16k(wavFile, rawFile);
  try { fs.rmSync(rawFile, { force: true }); } catch { /* ignore */ }
  const pcm = new Float32Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 4));

  const totalSec = pcm.length / SAMPLE_RATE;
  const analysis = silenceSkip ? analyzeSilence(pcm) : null;
  const segments = analysis && analysis.cuts.length
    ? analysis.segments
    : [{ startSec: 0, endSec: totalSec }];
  const cutting = !!(analysis && analysis.cuts.length);

  const transcriber = await getPipeline(model, cacheDir, onProgress, endpoint);

  const call = (audio) => transcriber(audio, {
    chunk_length_s: 30,
    stride_length_s: 4,
    return_timestamps: true,
    callback_function: (beams) => {
      if (onPartial && beams[0]) onPartial({ text: beams[0].output_token_ids, done: beams[0].done });
    },
  });

  /* `offsetSec` 0 reproduces the old mapping exactly: a numeric timestamp is
   * shifted, anything else (null at the end of audio) is passed through. */
  const mapChunks = (out, offsetSec) => (out.chunks || []).map((c) => ({
    text: c.text,
    start: Array.isArray(c.timestamp) && typeof c.timestamp[0] === "number" ? c.timestamp[0] + offsetSec : (Array.isArray(c.timestamp) ? c.timestamp[0] : 0),
    end: Array.isArray(c.timestamp) && typeof c.timestamp[1] === "number" ? c.timestamp[1] + offsetSec : (Array.isArray(c.timestamp) ? c.timestamp[1] : 0),
  }));

  let text = "";
  const chunks = [];
  if (!cutting) {
    /* NOTHING TO CUT: byte-for-byte the original single call on the whole array. */
    const out = await call(pcm);
    text = out.text || "";
    chunks.push(...mapChunks(out, 0));
  } else {
    /* One call per surviving segment, concatenated in order. Progress is
     * weighted by audio seconds so the caller's bar still reaches 100 %. */
    const keptSec = segments.reduce((s, g) => s + (g.endSec - g.startSec), 0) || totalSec;
    let doneSec = 0;
    for (let i = 0; i < segments.length; i++) {
      const g = segments[i];
      const a = Math.max(0, Math.round(g.startSec * SAMPLE_RATE));
      const b = Math.min(pcm.length, Math.round(g.endSec * SAMPLE_RATE));
      if (b <= a) continue;
      if (onProgress) {
        onProgress({
          status: "progress",
          progress: Math.min(99, Math.round((doneSec / keptSec) * 100)),
          segment: i + 1,
          segments: segments.length,
          audioSecDone: round1(doneSec),
          audioSecTotal: round1(keptSec),
        });
      }
      const out = await call(pcm.subarray(a, b));
      const part = (out.text || "").trim();
      if (part) text = text ? text + " " + part : part;
      chunks.push(...mapChunks(out, g.startSec));
      doneSec += g.endSec - g.startSec;
    }
    if (onProgress) {
      onProgress({
        status: "progress",
        progress: 100,
        segments: segments.length,
        audioSecDone: round1(keptSec),
        audioSecTotal: round1(keptSec),
      });
    }
  }

  /* NO SILENT DEGRADATION: every number that describes what was skipped is
   * reported, logged, and handed to the caller for the meeting record. */
  const silenceSkippedSec = analysis ? analysis.silenceSkippedSec : 0;
  const keptTotalSec = analysis ? analysis.speechKeptSec : totalSec;
  const audio = {
    track: path.basename(wavFile),
    totalSec: round1(totalSec),
    refDbfs: round1(analysis ? analysis.refDbfs : NaN),
    refBasis: analysis ? analysis.refBasis : "silence-skip-off",
    thresholdDbfs: round1(analysis ? analysis.thresholdDbfs : NaN),
    floorDbfs: round1(analysis ? analysis.floorDbfs : NaN),
    floorFramePct: round1(analysis ? analysis.floorFramePct : 0),
    silentSec: round1(analysis ? analysis.silentSec : 0),
    silentPct: round1(analysis ? analysis.silentPct : 0),
    longRuns: analysis ? analysis.longRuns.length : 0,
    cutRuns: analysis ? analysis.cuts.length : 0,
    silenceSkippedSec: round1(silenceSkippedSec),
    speechKeptSec: round1(keptTotalSec),
    segments: segments.length,
    silenceSkip: cutting ? "cut" : (silenceSkip ? "none" : "off"),
  };
  console.log(
    `[transcribe] ${audio.track} 音频 ${totalSec.toFixed(1)}s：跳过长静音 ${silenceSkippedSec.toFixed(1)}s（${audio.cutRuns} 段），实际送入模型 ${keptTotalSec.toFixed(1)}s`
  );

  return {
    text,
    chunks,
    audio,
    silenceSkippedSec: audio.silenceSkippedSec,
    speechKeptSec: audio.speechKeptSec,
    totalSec: audio.totalSec,
    segments: audio.segments,
  };
}

module.exports = {
  MODELS,
  transcribeFile,
  getPipeline,
  analyzeSilence,
  buildSegments,
  frameRmsDb,
  percentile,
  SILENCE_FRAME_SEC,
  SILENCE_REF_PERCENTILE,
  SILENCE_REL_DB,
  SILENCE_SKIP_MIN_SEC,
  SILENCE_FLOOR_PERCENTILE,
  SILENCE_FLOOR_BAND_DB,
  KEEP_PAD_SEC,
};
