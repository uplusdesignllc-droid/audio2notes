"use strict";
/* Shadow-mode live VAD (silero, via sherpa-onnx-node).
 *
 * WHY THIS EXISTS — and why it is INERT.
 * The "is this meeting still going" guard is driven by capture.exe's loudness
 * meter (LEVEL 0-100) through src/activityTracker.js. That meter cannot tell a
 * Windows notification chime from a human voice. An offline experiment
 * (.scratch/vad/, see SUMMARY.md and FINAL-REPORT.txt) proved that a real VAD
 * can: on one 797.2 s recording (2026-09-14_203332/system) with 7 known chimes,
 *   - at the documented default threshold 0.5, 5 of 7 chimes give EXACTLY zero
 *     detected speech and 2 leak a 0.67-0.70 s blip (349.50-350.21, 649.98-650.66);
 *   - at threshold >= 0.75 all 7 chimes are rejected, for a 6.6 % loss of real
 *     audio (83.78 s -> 78.22 s of the 117.0 s present);
 *   - with a >= 1.0 s continuous-speech requirement all 7 chimes are rejected at
 *     EVERY threshold from 0.3 to 0.9.
 * The validated operating point is therefore threshold 0.75, minSilenceDuration
 * 0.5, minSpeechDuration 1.0, windowSize 512 at 16 kHz.
 *
 * THIS MODULE DECIDES NOTHING. It is a measurement instrument: it observes audio
 * and counts speech intervals. It has no reference to lifecycle.lastLoudAt, no
 * IPC, no notification, no timer of its own, and no configuration key that could
 * make it enforce anything. The guard, the watchdog, the silence guard, the size
 * fuse and the pipeline do not read anything this file produces.
 *
 * WHY THE LOGIC IS SEPARATED FROM THE NATIVE CALL: everything below except
 * defaultVadFactory() is plain JS over Buffers, so the part that can actually be
 * wrong — block slicing, the sub-block remainder, run-length accumulation,
 * interval bookkeeping — is unit-testable under plain `node` with an injected
 * fake VAD (see .scratch/liveVad.test.js). The native binding is reached only
 * through `vadFactory`, and only lazily, so requiring this module never loads
 * the addon.
 *
 * Memory is bounded for an 8 h recording: the interval list is capped
 * (MAX_INTERVALS) and the number of dropped intervals is recorded, while
 * totalSpeechSec keeps accruing past the cap so the headline number never lies.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

/** SHA-256 of the bundled Silero VAD model. Verified after copying
 *  .scratch/vad/silero_vad.onnx -> assets/models/silero_vad.onnx (643854 bytes).
 *  A shadow run whose model does not hash to this is NOT RUN: the numbers it
 *  would produce are unverifiable against the offline reference, and a truncated
 *  or swapped ONNX could fail inside the native layer instead of cleanly. */
const MODEL_SHA256 = "9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6";
const MODEL_BYTES = 643854;

/** The offline experiment used these four numbers (and only these) to produce
 *  every reference JSON in .scratch/vad/*.vad-t*.json, so reproducing them is
 *  what makes a live number comparable to an offline one. */
const DEFAULT_CONFIG = {
  threshold: 0.75,
  minSilenceDuration: 0.5,
  minSpeechDuration: 1.0,
  windowSize: 512,
  sampleRate: 16000,
};

/** sherpa's internal ring buffer, in seconds. The offline runner used 60
 *  ("arbitrary > windowSize"); keeping the same value keeps the two paths
 *  byte-comparable, since a buffer smaller than one segment would truncate
 *  front()/pop() payloads (this module never calls either). */
const BUFFER_SECONDS = 60;

/** Hard ceiling on stored intervals. Bookkeeping is 2 numbers per interval, so
 *  10000 caps the list at well under 1 MB. The theoretical worst case for an 8 h
 *  recording is 57600 intervals (minSilenceDuration 0.5 allows at most 2 per
 *  second), i.e. the cap can only be reached by pathological audio; a real 13 min
 *  meeting produced 18 and a 155 min meeting produces far fewer than 10000.
 *  Past the cap, intervals are counted in droppedIntervals and totalSpeechSec
 *  still accrues, so the cap degrades resolution, never the total. */
const MAX_INTERVALS = 10000;

/** Wall-clock slack added by speechRunSec() while a run is open, in seconds.
 *  Bytes can sit on disk for up to one poll before they are fed, so an audio-time
 *  run length can understate "how long has this been going right now". The cap
 *  stops a stalled reader from inflating the run without bound. */
const MAX_TAIL_SEC = 2;

function positive(v, dflt) {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : dflt;
}

function positiveInt(v, dflt) {
  const n = positive(v, dflt);
  return Math.max(1, Math.round(n));
}

/** Bundled model, mapped out of asar when packaged — the native layer opens this
 *  path directly, so an asar-internal path would not be readable. Same pattern as
 *  src/diarize.js segmentationModelPath(). */
function defaultModelPath() {
  let p = path.join(__dirname, "..", "assets", "models", "silero_vad.onnx");
  if (p.includes("app.asar" + path.sep)) p = p.replace("app.asar" + path.sep, "app.asar.unpacked" + path.sep);
  return p;
}

/**
 * The exact `VadConfig` handed to sherpa. Exported separately so the config that
 * produced a set of numbers can be read out of them without re-deriving it from
 * the call site (the shadow JSON records this object verbatim).
 * @param {{modelPath:string, threshold?:number, minSilenceDuration?:number,
 *          minSpeechDuration?:number, windowSize?:number, sampleRate?:number}} o
 */
function vadConfig(o) {
  return {
    sileroVad: {
      model: o.modelPath,
      threshold: positive(o.threshold, DEFAULT_CONFIG.threshold),
      minSilenceDuration: positive(o.minSilenceDuration, DEFAULT_CONFIG.minSilenceDuration),
      minSpeechDuration: positive(o.minSpeechDuration, DEFAULT_CONFIG.minSpeechDuration),
      windowSize: positiveInt(o.windowSize, DEFAULT_CONFIG.windowSize),
    },
    sampleRate: positiveInt(o.sampleRate, DEFAULT_CONFIG.sampleRate),
    numThreads: 1,
    debug: false,
  };
}

/** The real factory. Kept lazy (require inside) so this module loads under plain
 *  node without the native addon present — that is what makes it testable. */
function defaultVadFactory(config) {
  const { Vad } = require("sherpa-onnx-node/vad.js");
  return new Vad(config, BUFFER_SECONDS);
}

/**
 * One VAD instance fed by one audio track.
 *
 * IMPORTANT — the polling granularity is NOT the analysis granularity. The caller
 * polls once per second, but feedS16() consumes whole windowSize blocks and calls
 * isDetected() after EVERY block, exactly like the offline runner
 * (.scratch/vad/run-vad.js). Feeding a whole second in one acceptWaveform() call
 * would make detection depend on the poll clock; per-block detection makes the
 * live result block-for-block comparable to the offline reference.
 *
 * @param {{modelPath:string, sampleRate?:number, threshold?:number,
 *          minSilenceDuration?:number, minSpeechDuration?:number,
 *          windowSize?:number, vadFactory?:Function,
 *          onError?:Function}} opts
 */
function createTrackVad(opts) {
  const o = opts || {};
  const sampleRate = positiveInt(o.sampleRate, DEFAULT_CONFIG.sampleRate);
  const windowSize = positiveInt(o.windowSize, DEFAULT_CONFIG.windowSize);
  const config = vadConfig({
    modelPath: o.modelPath,
    threshold: o.threshold,
    minSilenceDuration: o.minSilenceDuration,
    minSpeechDuration: o.minSpeechDuration,
    windowSize,
    sampleRate,
  });

  const bytesPerBlock = windowSize * 2; // s16le
  const secPerBlock = windowSize / sampleRate;

  let vad = null;
  let failed = false;
  let errors = 0;
  let closed = false;
  let pending = Buffer.alloc(0); // sub-block remainder, carried across calls
  let blocksFed = 0;             // blocks handed to the native VAD (incl. the zero-padded tail)
  let samplesFed = 0;            // REAL samples handed over (padding excluded) => the audio clock
  let bytesFed = 0;              // bytes accepted from callers, whether or not yet block-aligned
  let lastDetected = false;
  let lastFeedMs = null;
  let open = null;               // the speech run in progress, { start, end } in seconds
  let closedSpeechSec = 0;       // accrued when a run closes, so the cap cannot lose it
  const intervals = [];          // [[startSec, endSec], ...]
  let droppedIntervals = 0;

  /** Log the first native failure exactly once, then stay silent: a per-poll
   *  console line would flood the log of an 8 h recording (one line per second). */
  function fail(where, e) {
    errors++;
    if (failed) return;
    failed = true;
    console.warn(`[vad-shadow] disabled after ${where}: ${(e && e.message) || e}`);
    if (typeof o.onError === "function") {
      try { o.onError(e, where); } catch { /* a reporter that throws must not propagate */ }
    }
  }

  try {
    const factory = typeof o.vadFactory === "function" ? o.vadFactory : defaultVadFactory;
    vad = factory(config);
    if (!vad || typeof vad.acceptWaveform !== "function" || typeof vad.isDetected !== "function") {
      throw new Error("vadFactory did not return a Vad-like object");
    }
  } catch (e) {
    vad = null;
    fail("construction", e);
  }

  /** Feed ONE aligned block and fold the verdict into the run accumulator.
   *  Block i spans [i*secPerBlock, (i+1)*secPerBlock); end is set (not extended)
   *  on every detected block, so a run ends on the last detected block — the same
   *  rule as the offline runner's interval merge. */
  function acceptBlock(off, realBytes) {
    const samples = new Float32Array(windowSize);
    const n = Math.min(windowSize, Math.floor(realBytes / 2));
    for (let i = 0; i < n; i++) samples[i] = pending.readInt16LE(off + i * 2) / 32768;
    // A block shorter than windowSize (only the final one, on close) is zero-padded
    // so no sample is dropped — the offline runner padded its tail the same way and
    // the padded block is excluded from samplesFed below.
    vad.acceptWaveform(samples);
    const detected = !!vad.isDetected();
    blocksFed++;
    samplesFed += n;
    lastDetected = detected;
    if (detected) {
      const end = blocksFed * secPerBlock;
      const start = (blocksFed - 1) * secPerBlock;
      if (open === null) open = { start, end };
      else open.end = end;
    } else if (open !== null) {
      pushInterval(open);
      open = null;
    }
  }

  function pushInterval(run) {
    // The total accrues from the UNROUNDED run so it stays comparable to the
    // offline runner, which summed exact block times and rounded only the report
    // (rounding first would drift by up to 0.5 ms per interval, x18 intervals on
    // the reference recording — small, but it would show up in a 3-decimal diff).
    closedSpeechSec += run.end - run.start;
    if (intervals.length >= MAX_INTERVALS) { droppedIntervals++; return; }
    intervals.push([Math.round(run.start * 1000) / 1000, Math.round(run.end * 1000) / 1000]);
  }

  /** @param {Buffer} buffer s16le bytes appended to this track's WAV data area */
  function feedS16(buffer) {
    if (failed || closed || vad === null) return 0;
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) return 0;
    try {
      bytesFed += buffer.length;
      lastFeedMs = Date.now();
      // Copy the carried remainder instead of subarray()-ing it: a subarray would
      // pin the whole (up to ~32 KB) concatenated buffer until the next poll.
      pending = pending.length ? Buffer.concat([pending, buffer]) : buffer;
      let off = 0;
      while (pending.length - off >= bytesPerBlock) {
        acceptBlock(off, bytesPerBlock);
        off += bytesPerBlock;
      }
      pending = off > 0 ? Buffer.from(pending.subarray(off)) : pending;
      return blocksFed;
    } catch (e) {
      fail("feedS16", e);
      return 0;
    }
  }

  /** Is the VAD detecting speech in the most recently fed block? */
  function isSpeaking() {
    return !failed && !closed ? lastDetected : false;
  }

  /**
   * Length of the speech run in progress, in seconds (0 when not speaking).
   * Measured in AUDIO time (blocks actually fed), plus the wall-clock gap since
   * the last feed while a run is open — that gap is audio the recorder has
   * already written but the next poll has not handed over yet. The gap is capped
   * at MAX_TAIL_SEC so a stalled reader cannot inflate the run. Pass nowMs equal
   * to the last feed time for a purely deterministic audio-time answer.
   */
  function speechRunSec(nowMs) {
    if (failed || closed || open === null) return 0;
    let sec = open.end - open.start;
    if (typeof nowMs === "number" && Number.isFinite(nowMs) && lastFeedMs !== null) {
      sec += Math.min(MAX_TAIL_SEC, Math.max(0, (nowMs - lastFeedMs) / 1000));
    }
    return sec;
  }

  /** Closed speech intervals, plus the run still in progress (if any) as a final
   *  entry — the offline runner pushed its trailing open run the same way, so a
   *  recording that ends mid-sentence reports that sentence. */
  function listIntervals() {
    return open === null ? intervals.slice() : intervals.concat([[open.start, open.end]]);
  }

  /** Audio seconds actually handed to the VAD (padding excluded). This is the
   *  denominator for speechFraction and matches the offline runner's
   *  `totalSeconds = samples / sampleRate` to within one sample. */
  function audioSec() {
    return samplesFed / sampleRate;
  }

  function totalSpeechSec() {
    const openSec = open === null ? 0 : open.end - open.start;
    return Math.round((closedSpeechSec + openSec) * 1000) / 1000;
  }

  /** Everything the shadow JSON needs, in one place. */
  function stats() {
    const sec = audioSec();
    const speech = totalSpeechSec();
    return {
      intervals: listIntervals(),
      totalSpeechSec: speech,
      audioSec: Math.round(sec * 1000) / 1000,
      speechFraction: sec > 0 ? Math.round((speech / sec) * 10000) / 10000 : 0,
      blocksFed,
      samplesFed,
      bytesFed,
      droppedIntervals,
      errors,
      failed,
    };
  }

  /** Full stop: consume the sub-block remainder as a zero-padded final block (so
   *  the tail is not silently dropped), close the run in progress, then release
   *  the native handle. Recorded intervals survive close() — they are the point. */
  function close() {
    if (closed) return;
    try {
      if (!failed && vad !== null && pending.length > 0) {
        const rem = pending.length;
        const pad = Buffer.alloc(bytesPerBlock); // zero-filled
        pending.copy(pad, 0, 0, Math.min(rem, bytesPerBlock));
        pending = pad;
        acceptBlock(0, rem);
        pending = Buffer.alloc(0);
      }
      if (open !== null) { pushInterval(open); open = null; }
    } catch (e) {
      fail("close", e);
    }
    closed = true;
    vad = null;
  }

  /** Start over: drops EVERYTHING, including the intervals recorded so far. This
   *  means "this is a new recording", not "resume cleanly" — a half-cleared
   *  interval list would be worse than either. */
  function reset() {
    try { if (vad && typeof vad.reset === "function") vad.reset(); } catch (e) { fail("reset", e); }
    pending = Buffer.alloc(0);
    blocksFed = 0;
    samplesFed = 0;
    bytesFed = 0;
    lastDetected = false;
    lastFeedMs = null;
    open = null;
    closedSpeechSec = 0;
    intervals.length = 0;
    droppedIntervals = 0;
    closed = false;
  }

  return {
    feedS16,
    isSpeaking,
    speechRunSec,
    intervals: listIntervals,
    stats,
    isFailed: () => failed,
    reset,
    close,
    config,
  };
}

/**
 * Tail reader for a WAV that another process is still writing.
 *
 * `readNew()` returns only the s16le DATA bytes appended since the previous call
 * (empty Buffer when there are none) and never throws.
 *
 * Why the cursor follows the BYTE COUNT RETURNED by fs.readSync and not
 * stat.size: the writer holds the file open and flushes asynchronously, so
 * stat.size can lag or misreport what is actually readable. readSync is the only
 * thing that knows how many bytes truly exist; advancing by anything else would
 * either skip audio (cursor past the data) or duplicate it (cursor behind it).
 *
 * Offset 44 is not a guess. Verified on real capture.exe output
 * (.scratch/t1.wav, first 44 bytes):
 *   52 49 46 46 | 24 dc 05 00 | 57 41 56 45          "RIFF" size "WAVE"
 *   66 6d 74 20 | 10 00 00 00 | 01 00 01 00 | 80 3e 00 00 | 00 7d 00 00 | 02 00 10 00
 *   64 61 74 61 | 00 dc 05 00                            "data" <size>
 * i.e. the canonical 44-byte PCM header: fmt (16) + data (16) + 12 bytes of
 * RIFF/WAVE = 44, data at 44. capture.exe re-patches the RIFF size (offset 4)
 * and the data size (offset 40) as it grows; both live BELOW 44, so a patch
 * cannot shift the data start.
 *
 * 44 is right for the app but NOT universal, and getting it wrong is silent:
 * `ffmpeg -i x.opus -ac 1 -ar 16000 -c:a pcm_s16le out.wav` (without
 * `-fflags +bitexact`) inserts a 34-byte LIST/INFO chunk and puts the data area at
 * 78, so a reader assuming 44 reads 34 header bytes and shifts every sample by 17
 * samples (0.001 s). Measured while building the end-to-end test: that mistake
 * alone moved the result from 85.696 s to 85.664 s without any error. Hence
 * dataOffset is a parameter, and any writer other than capture.exe must be checked
 * before the default is trusted (.scratch/liveVad-reader.test.js case G covers
 * both offsets).
 *
 * @param {{wavFile:string, dataOffset?:number}} opts
 */
function createWavTailReader(opts) {
  const o = opts || {};
  const wavFile = o.wavFile;
  const dataOffset = Number.isFinite(o.dataOffset) ? Math.max(0, o.dataOffset) : 44;
  let pos = dataOffset;
  let errors = 0;
  let shorterReads = 0;

  /** @returns {Buffer} new s16le bytes, or an empty Buffer on any problem */
  function readNew() {
    if (!wavFile) return Buffer.alloc(0);
    let fd = null;
    try {
      fd = fs.openSync(wavFile, "r");
    } catch {
      // The file may not exist yet (the writer creates it a moment after the
      // process starts) or may be locked for reading. Either way: no bytes yet.
      return Buffer.alloc(0);
    }
    try {
      const size = fs.fstatSync(fd).size;
      if (size < pos) {
        // stat reports FEWER bytes than we have already handed over. The cursor
        // is deliberately NOT rewound: the observed cause is a lagging/misreported
        // stat for a file another process holds open, and rewinding would feed the
        // same audio to the VAD twice, shifting every later interval on the
        // timeline. Returning empty costs nothing while the size catches up.
        // UNTESTED ASSUMPTION, labelled as such: if a writer ever genuinely
        // truncated and rewrote the data area, this would skip the rewritten part
        // instead of duplicating it. capture.exe cannot do that (it opens its WAV
        // "wb" exactly once per recording, and only ever patches the two size
        // fields below dataOffset), so the case is counted, not handled.
        shorterReads++;
        return Buffer.alloc(0);
      }
      if (size <= pos) return Buffer.alloc(0);
      const want = size - pos;
      const buf = Buffer.allocUnsafe(want);
      let got = 0;
      while (got < want) {
        const n = fs.readSync(fd, buf, got, want - got, pos + got);
        if (n <= 0) break; // EOF: never read past what the file actually contains
        got += n;
      }
      if (got === 0) return Buffer.alloc(0);
      pos += got; // advance by the byte count ACTUALLY returned, never by stat.size
      return got === want ? buf : buf.subarray(0, got);
    } catch {
      errors++;
      return Buffer.alloc(0);
    } finally {
      try { fs.closeSync(fd); } catch { /* already gone */ }
    }
  }

  return {
    readNew,
    /** Bytes consumed so far, i.e. how much of the data area has been handed over. */
    bytesRead: () => pos - dataOffset,
    stats: () => ({ bytesRead: pos - dataOffset, errors, shorterReads }),
  };
}

/**
 * Walk a WAV's chunk headers and report the stream format, INCLUDING where the
 * data area actually starts.
 *
 * WHY: the shadow VAD hardcodes sampleRate 16000 because both capture tracks are
 * documented as `READY fmt=16000:1:16`, and dataOffset 44 because that is what
 * capture.exe writes. Both are assumptions about audio it never inspects — and a
 * wrong one would make every number in the report silently wrong (a 48 kHz WAV
 * read as 16 kHz reports intervals at a third of their true position). This
 * function turns each assumption into something the report RECORDS, so a mismatch
 * is visible after the fact instead of invisible.
 *
 * Real chunk walking rather than a fixed offset, because the two headers actually
 * seen in this repo differ: capture.exe writes the canonical 44-byte header (data
 * at 44, verified on .scratch/t1.wav) while ffmpeg's muxer inserts a LIST/INFO
 * chunk (data at 78). Reads at most `maxBytes` from the front of the file.
 *
 * @param {string} file
 * @param {number} [maxBytes=4096]
 * @returns {{sampleRate:number, channels:number, bits:number, audioFormat:number,
 *            dataOffset:number, size:number}|null} null when it cannot be read
 */
function readWavFormat(file, maxBytes) {
  let buf = null;
  try {
    const size = fs.statSync(file).size;
    const n = Math.min(size, Number.isFinite(maxBytes) ? maxBytes : 4096);
    const fd = fs.openSync(file, "r");
    try {
      buf = Buffer.alloc(n);
      const got = fs.readSync(fd, buf, 0, n, 0);
      buf = buf.subarray(0, got);
    } finally { fs.closeSync(fd); }
  } catch {
    return null;
  }
  try {
    if (buf.length < 44 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") return null;
    const out = { sampleRate: 0, channels: 0, bits: 0, audioFormat: 0, dataOffset: -1, size: fs.statSync(file).size };
    let off = 12;
    while (off + 8 <= buf.length) {
      const id = buf.toString("ascii", off, off + 4);
      const len = buf.readUInt32LE(off + 4);
      const body = off + 8;
      if (id === "fmt " && body + 16 <= buf.length) {
        out.audioFormat = buf.readUInt16LE(body);
        out.channels = buf.readUInt16LE(body + 2);
        out.sampleRate = buf.readUInt32LE(body + 4);
        out.bits = buf.readUInt16LE(body + 14);
      } else if (id === "data") {
        out.dataOffset = body;
        return out;
      }
      off = body + len + (len % 2); // chunks are word-aligned
    }
    return out.dataOffset >= 0 ? out : null;
  } catch {
    return null;
  }
}

/**
 * Resolve SHA-256 + presence of the VAD model, once per process.
 *
 * Returns `{ path, exists, bytes, sha256, ok, reason, expectedSha256 }`. `ok` is
 * the only thing a caller may act on: on any doubt (missing file, unreadable,
 * hash mismatch) `ok` is false and the shadow must stay INERT rather than run a
 * model whose output cannot be checked against the offline reference. Hashing
 * 643854 bytes costs a few ms and happens once, cached by path+size+mtime.
 */
let modelInfoCache = null;
function modelInfo(modelPath) {
  const p = modelPath || defaultModelPath();
  const out = { path: p, exists: false, bytes: 0, sha256: null, ok: false, reason: "", expectedSha256: MODEL_SHA256 };
  if (!p) {
    out.reason = "no model path configured";
    return out;
  }
  let st = null;
  try {
    st = fs.statSync(p);
  } catch {
    out.reason = "model file not found";
    return out;
  }
  out.exists = true;
  out.bytes = st.size;
  const key = `${p}|${st.size}|${st.mtimeMs}`;
  if (modelInfoCache && modelInfoCache.key === key) {
    out.sha256 = modelInfoCache.sha256;
  } else {
    try {
      out.sha256 = crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
      modelInfoCache = { key, sha256: out.sha256 };
    } catch {
      out.reason = "model file could not be read";
      return out;
    }
  }
  if (out.sha256 !== MODEL_SHA256) {
    out.reason = `model sha256 mismatch (got ${out.sha256})`;
    return out;
  }
  out.ok = true;
  return out;
}

module.exports = {
  MODEL_SHA256,
  MODEL_BYTES,
  DEFAULT_CONFIG,
  BUFFER_SECONDS,
  MAX_INTERVALS,
  defaultModelPath,
  vadConfig,
  createTrackVad,
  createWavTailReader,
  readWavFormat,
  modelInfo,
  resetModelInfoCache: () => { modelInfoCache = null; },
};
