"use strict";
/* Verification for src/liveVad.js (tracked suite).
 * Run: node test/liveVad.test.js
 *
 * Everything here runs with an INJECTED fake VAD: no native module, no model, no
 * Electron. The point is to prove the plain-JS half of liveVad — block slicing,
 * the sub-block remainder across feedS16 calls, run-length accumulation, interval
 * bookkeeping, the interval cap, and that a broken factory disables instead of
 * propagating. The native half is covered by test/liveVad-e2e.js against a
 * real recording and the offline reference numbers. */
const path = require("path");
const { createTrackVad, MAX_INTERVALS, DEFAULT_CONFIG } = require(path.join(__dirname, "..", "src", "liveVad"));

let failures = 0;
function check(name, fn) {
  try {
    const info = fn();
    console.log(`PASS  ${name}${info ? "\n      " + info : ""}`);
  } catch (e) {
    failures++;
    console.log(`FAIL  ${name}\n      ${e.message}`);
  }
}
function eq(actual, expected, what) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${what || "value"}: expected ${b}, got ${a}`);
}
function ok(cond, what) { if (!cond) throw new Error(what || "assertion failed"); }
function near(actual, expected, tol, what) {
  if (!(Math.abs(actual - expected) <= tol)) {
    throw new Error(`${what || "value"}: expected ${expected} +/-${tol}, got ${actual}`);
  }
}

/* ------------------------------------------------------------ fake VAD ---- */
/** Records what it is handed so slicing can be checked exactly. `detect(i)`
 *  decides the verdict for the i-th block. store:false keeps only counts, which
 *  the long-duration cases need so the test itself does not eat the memory the
 *  cap is supposed to bound. */
function makeFake(detect, opts) {
  const o = opts || {};
  const state = { blockCount: 0, blocks: [], detects: 0, resets: 0, thrown: false };
  const vad = {
    acceptWaveform(samples) {
      if (o.throwOn != null && state.blockCount === o.throwOn) {
        state.thrown = true;
        throw new Error("native boom");
      }
      if (o.store !== false) state.blocks.push(Float32Array.from(samples));
      state.blockCount++;
    },
    isDetected() {
      state.detects++;
      return !!(detect || (() => false))(state.blockCount - 1);
    },
    reset() { state.resets++; },
  };
  return { vad, state };
}

/** s16le bytes for a sample sequence. */
function s16(samples) {
  const b = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) b.writeInt16LE(samples[i], i * 2);
  return b;
}
/** Every block the fake kept, flattened, for sample-exact comparison. */
function flatten(state) {
  const out = [];
  for (const blk of state.blocks) for (const v of blk) out.push(v);
  return out;
}
function ramp(n, from) { return Array.from({ length: n }, (_, i) => from + i); }

/* ------------------------------------------------- A: block slicing ------- */
check("A. one feed of 3 blocks is sliced into exactly 3 windowSize blocks", () => {
  const f = makeFake(() => false);
  const v = createTrackVad({ modelPath: "x", windowSize: 8, sampleRate: 16000, vadFactory: () => f.vad });
  const samples = ramp(24, 0);
  v.feedS16(s16(samples));
  eq(f.state.blockCount, 3, "blocks fed");
  eq(f.state.blocks.map((b) => b.length), [8, 8, 8], "block sizes");
  eq(flatten(f.state), samples.map((s) => s / 32768), "samples in order");
  eq(v.stats().blocksFed, 3, "blocksFed");
  eq(v.stats().samplesFed, 24, "samplesFed");
  eq(v.stats().bytesFed, 48, "bytesFed");
  return "3 blocks x 8 samples, samplesFed=24, bytesFed=48";
});

check("B. a short feed produces no block (nothing to detect on)", () => {
  const f = makeFake(() => true);
  const v = createTrackVad({ modelPath: "x", windowSize: 8, sampleRate: 16000, vadFactory: () => f.vad });
  v.feedS16(s16(ramp(7, 0)));
  eq(f.state.blockCount, 0, "blocks fed");
  eq(v.stats().blocksFed, 0, "blocksFed");
  eq(v.stats().bytesFed, 14, "bytesFed (bytes ARE counted, they are held)");
  v.feedS16(s16(ramp(1, 7))); // the last sample completes the block
  eq(f.state.blockCount, 1, "blocks after completion");
  eq(Array.from(f.state.blocks[0]), ramp(8, 0).map((s) => s / 32768), "completed block contents");
  return "7 samples held, then completed by the 8th: no sample lost";
});

/* ------------------------------- C: remainder carry-over, odd split ------- */
check("C. ODD-SIZED SPLIT across feedS16 calls loses/duplicates NO sample", () => {
  /* 300 samples fed as 250 + 111 + 111 + 128 bytes = 600 bytes, none of the first
   * three a multiple of the 16-byte block (windowSize 8), so every cut lands
   * mid-sample and mid-block. */
  const N = 300, W = 8;
  const samples = ramp(N, -150); // includes negatives
  const all = s16(samples);
  const f = makeFake(() => false);
  const v = createTrackVad({ modelPath: "x", windowSize: W, sampleRate: 16000, vadFactory: () => f.vad });
  const cuts = [250, 111, 111, 128];
  let off = 0;
  for (const n of cuts) { v.feedS16(all.subarray(off, off + n)); off += n; }
  eq(off, all.length, "test fed the whole buffer");
  eq(f.state.blockCount, Math.floor(N / W), "whole blocks = floor(300/8)");
  v.close(); // the 4-sample remainder leaves via the padded tail block
  eq(f.state.blockCount, Math.floor(N / W) + 1, "close flushed the remainder");
  const flat = flatten(f.state);
  eq(flat.length, N + (W - (N % W)), "N samples + zero padding to the block edge");
  eq(flat.slice(0, N), samples.map((s) => s / 32768), "every sample identical, in order — none lost, none duplicated");
  eq(flat.slice(N), new Array(W - (N % W)).fill(0), "only zero padding after the real audio");
  eq(v.stats().samplesFed, N, "samplesFed");
  eq(v.stats().bytesFed, all.length, "bytesFed");
  return `${all.length} bytes as ${cuts.join("+")}: ${f.state.blockCount} blocks, ${N} real samples + ${W - (N % W)} pad, sample-exact`;
});

check("D. an odd BYTE count (mid-sample flush) is carried, not dropped", () => {
  const N = 20, W = 4; // 8 bytes/block
  const all = s16(ramp(N, 1));
  const f = makeFake(() => false);
  const v = createTrackVad({ modelPath: "x", windowSize: W, sampleRate: 16000, vadFactory: () => f.vad });
  v.feedS16(all.subarray(0, 9));   // odd: 4 samples + 1 stray byte
  v.feedS16(all.subarray(9));      // the rest
  eq(flatten(f.state), ramp(N, 1).map((s) => s / 32768), "all 20 samples, in order");
  eq(v.stats().bytesFed, all.length, "bytesFed");
  return "9 + 31 bytes across the call: stray odd byte carried, no sample lost";
});

/* ------------------------------------------ E: run length / bookkeeping --- */
check("E. run-length accumulation merges consecutive detected blocks", () => {
  /* windowSize 512 @16k => 0.032 s/block. Detected blocks 10..19 => one run
   * covering [0.320, 0.640). Then 30..34 => [0.960, 1.120). */
  const W = 512, blocks = 40;
  const detected = new Set([...Array(10).keys()].map((i) => i + 10).concat([30, 31, 32, 33, 34]));
  const f = makeFake((i) => detected.has(i));
  const v = createTrackVad({ modelPath: "x", windowSize: W, sampleRate: 16000, vadFactory: () => f.vad });
  v.feedS16(s16(ramp(W * blocks, 0)));
  const s = v.stats();
  eq(s.blocksFed, blocks, "blocksFed");
  eq(s.intervals, [[0.32, 0.64], [0.96, 1.12]], "intervals");
  near(s.totalSpeechSec, 0.48, 1e-9, "totalSpeechSec");
  near(s.audioSec, 1.28, 1e-9, "audioSec");
  near(s.speechFraction, 0.375, 1e-4, "speechFraction");
  eq(v.isSpeaking(), false, "isSpeaking after a quiet block");
  eq(v.speechRunSec(1), 0, "speechRunSec when no run is open");
  return `intervals=${JSON.stringify(s.intervals)} totalSpeechSec=${s.totalSpeechSec} fraction=${s.speechFraction}`;
});

check("F. isSpeaking() / speechRunSec() see the run in progress", () => {
  const W = 512;
  const f = makeFake((i) => i >= 20); // silent, then speaking to the end
  const v = createTrackVad({ modelPath: "x", windowSize: W, sampleRate: 16000, vadFactory: () => f.vad });
  const t = Date.now();
  v.feedS16(s16(ramp(W * 30, 0)));
  eq(v.isSpeaking(), true, "isSpeaking");
  const s = v.stats();
  eq(s.intervals, [[0.64, 0.96]], "the OPEN run is reported too (the offline runner pushed its tail the same way)");
  near(s.totalSpeechSec, 0.32, 1e-9, "totalSpeechSec includes the open run");
  near(v.speechRunSec(t), 0.32, 1e-9, "speechRunSec with no wall-clock tail");
  /* +5 s of wall clock is capped at MAX_TAIL_SEC (2 s): a stalled reader must not
   * be able to inflate the run. */
  near(v.speechRunSec(t + 5000), 0.32 + 2, 1e-9, "speechRunSec with a 5 s wall-clock tail");
  return "open run 0.32 s of audio, wall-clock tail capped at +2 s";
});

check("G. close() pads the trailing partial block and closes the open run", () => {
  const W = 512;                       // 1024 bytes/block, 0.032 s/block
  const N = W * 2 + 50;                // 2 whole blocks + 50 samples
  const f = makeFake((i) => i === 2);
  const v = createTrackVad({ modelPath: "x", windowSize: W, sampleRate: 16000, vadFactory: () => f.vad });
  v.feedS16(s16(ramp(N, 1)));
  eq(f.state.blockCount, 2, "2 whole blocks before close");
  v.close();
  eq(f.state.blockCount, 3, "close flushed one padded block");
  eq(Array.from(f.state.blocks[2]).slice(0, 3), ramp(3, 1 + W * 2).map((s) => s / 32768), "real samples first");
  eq(Array.from(f.state.blocks[2]).slice(50), new Array(W - 50).fill(0), "zero padding after");
  const s = v.stats();
  eq(s.samplesFed, N, "samplesFed excludes the zero-padding samples");
  near(s.audioSec, N / 16000, 5e-4, "audioSec is real audio only (audioSec itself is reported to 1 ms)");
  eq(s.blocksFed, 3, "blocksFed includes the padded block");
  eq(s.intervals, [[0.064, 0.096]], "the detected trailing block became an interval");
  eq(v.feedS16(s16(ramp(W, 0))), 0, "feedS16 after close is a no-op");
  return `padded block: ${Array.from(f.state.blocks[2]).slice(0, 3).map((x) => x.toFixed(6)).join(",")} ... 0 x${W - 50}`;
});

/* ------------------------------------------------ H: the cap is bounded --- */
check("H. the interval list is capped, drops are counted, the total survives", () => {
  /* windowSize 8 => 1 block = 0.0005 s. Alternate detected/quiet so every other
   * block closes a 1-block interval. */
  const W = 8;
  const f = makeFake((i) => i % 2 === 0, { store: false });
  const v = createTrackVad({ modelPath: "x", windowSize: W, sampleRate: 16000, vadFactory: () => f.vad });
  const blocksNeeded = MAX_INTERVALS * 2 + 50;
  const perCall = 400;
  const chunk = s16(ramp(W * perCall, 0));
  for (let i = 0; i < Math.ceil(blocksNeeded / perCall) + 1; i++) v.feedS16(chunk);
  v.close();
  const s = v.stats();
  eq(s.intervals.length, MAX_INTERVALS, "stored intervals == cap");
  eq(s.droppedIntervals, s.blocksFed / 2 - MAX_INTERVALS, "dropped intervals counted");
  const expectedSpeech = (s.blocksFed / 2) * (W / 16000);
  near(s.totalSpeechSec, expectedSpeech, 2e-3, "totalSpeechSec still counts every interval, dropped or not");
  const bytes = JSON.stringify(s.intervals).length;
  return `blocksFed=${s.blocksFed} stored=${s.intervals.length} dropped=${s.droppedIntervals} totalSpeechSec=${s.totalSpeechSec} (serialized intervals = ${bytes} B)`;
});

check("I. 8 h of pathological audio keeps the interval list bounded", () => {
  /* Worst realistic case: minSilenceDuration 0.5 allows at most 2 intervals/s, so
   * 8 h could produce 57600 interval slots. Feed a full 8 h stream with the
   * detector firing in bursts, and assert the stored list cannot pass the cap
   * while the total keeps counting. */
  const W = 512;
  const f = makeFake((i) => i % 32 < 16, { store: false }); // 16 detected / 16 quiet blocks
  const v = createTrackVad({ modelPath: "x", windowSize: W, sampleRate: 16000, vadFactory: () => f.vad });
  const perCall = 1000;
  const calls = Math.round(28800 / (perCall * W / 16000)); // 28800 s = 8 h
  const chunk = Buffer.alloc(W * perCall * 2, 0x10); // arbitrary s16 pattern, keeps the test cheap
  const t0 = Date.now();
  for (let i = 0; i < calls; i++) v.feedS16(chunk);
  v.close();
  const s = v.stats();
  const theoretical = Math.floor(s.audioSec / 0.5);
  ok(s.intervals.length <= MAX_INTERVALS, "stored intervals never exceed the cap");
  near(s.audioSec, 28800, 0.05, "8 h of audio fed");
  return `audioSec=${s.audioSec} (8 h) blocksFed=${s.blocksFed} stored=${s.intervals.length} cap=${MAX_INTERVALS} dropped=${s.droppedIntervals} (theoretical max slots at minSilence 0.5 = ${theoretical}) in ${Date.now() - t0} ms`;
});

/* ----------------------------------------------------------- J: failures --- */
check("J. a THROWING vadFactory disables the instance instead of propagating", () => {
  const warns = [];
  const orig = console.warn;
  console.warn = (...a) => warns.push(a.join(" "));
  let v;
  try {
    v = createTrackVad({ modelPath: "x", windowSize: 8, vadFactory: () => { throw new Error("no native module"); } });
  } finally { console.warn = orig; }
  eq(v.isFailed(), true, "failed flag");
  eq(v.feedS16(s16(ramp(8, 0))), 0, "feedS16 returns 0 (no throw)");
  eq(v.isSpeaking(), false, "isSpeaking");
  eq(v.speechRunSec(1), 0, "speechRunSec");
  eq(v.intervals(), [], "intervals");
  eq(v.stats().errors, 1, "errors");
  v.close(); // must not throw either
  eq(warns.length, 1, "reported EXACTLY once");
  ok(/disabled after construction/.test(warns[0]), "warning names the site: " + warns[0]);
  return `1 warning: ${warns[0]}`;
});

check("K. a factory returning garbage is treated the same way", () => {
  const orig = console.warn; console.warn = () => {};
  let v;
  try { v = createTrackVad({ modelPath: "x", windowSize: 8, vadFactory: () => ({ nope: true }) }); }
  finally { console.warn = orig; }
  eq(v.isFailed(), true, "failed flag");
  eq(v.feedS16(s16(ramp(8, 0))), 0, "feedS16 is inert");
  return "Vad-like duck typing checked at construction";
});

check("L. a native throw MID-STREAM fails once, then stays inert", () => {
  const warns = [];
  const orig = console.warn; console.warn = (...a) => warns.push(a.join(" "));
  const f = makeFake(() => false, { throwOn: 2 });
  let v;
  try {
    v = createTrackVad({ modelPath: "x", windowSize: 8, vadFactory: () => f.vad });
    v.feedS16(s16(ramp(8 * 5, 0))); // block #2 throws
    eq(f.state.thrown, true, "the fake threw");
    eq(v.isFailed(), true, "failed after the throw");
    eq(v.stats().blocksFed, 2, "blocksFed stops at the failure");
    v.feedS16(s16(ramp(8 * 5, 0)));
    v.feedS16(s16(ramp(8 * 5, 0)));
    v.close();
  } finally { console.warn = orig; }
  eq(warns.length, 1, "one warning across three further calls (no per-poll flood)");
  return `1 warning: ${warns[0]}`;
});

check("M. feedS16 survives junk arguments without throwing", () => {
  const f = makeFake(() => false);
  const v = createTrackVad({ modelPath: "x", windowSize: 8, sampleRate: 16000, vadFactory: () => f.vad });
  for (const junk of [null, undefined, "", new Uint8Array(0), 42, {}, []]) {
    eq(v.feedS16(junk), 0, "junk => 0");
  }
  eq(v.stats().errors, 0, "junk is not an error");
  return "null/undefined/string/number/object/array/Uint8Array(0) all no-ops";
});

check("N. reset() clears everything, and is honest about it", () => {
  const W = 8;
  const f = makeFake((i) => i % 2 === 0);
  const v = createTrackVad({ modelPath: "x", windowSize: W, sampleRate: 16000, vadFactory: () => f.vad });
  v.feedS16(s16(ramp(W * 4, 0)));
  ok(v.stats().intervals.length > 0, "something was recorded first");
  v.reset();
  const s = v.stats();
  eq(f.state.resets, 1, "the native detector was reset too");
  eq(s.intervals, [], "intervals cleared");
  eq(s.blocksFed, 0, "blocksFed");
  eq(s.bytesFed, 0, "bytesFed");
  eq(s.totalSpeechSec, 0, "totalSpeechSec");
  v.feedS16(s16(ramp(W * 4, 0)));
  eq(v.stats().blocksFed, 4, "usable again after reset");
  return "full reset: intervals dropped, detector reset, reusable";
});

check("O. the recorded config is the exact object handed to sherpa", () => {
  const f = makeFake(() => false);
  const v = createTrackVad({
    modelPath: "M.onnx", threshold: 0.75, minSilenceDuration: 0.5,
    minSpeechDuration: 1.0, windowSize: 512, sampleRate: 16000, vadFactory: () => f.vad,
  });
  eq(v.config, {
    sileroVad: { model: "M.onnx", threshold: 0.75, minSilenceDuration: 0.5, minSpeechDuration: 1.0, windowSize: 512 },
    sampleRate: 16000, numThreads: 1, debug: false,
  }, "config");
  return JSON.stringify(v.config.sileroVad);
});

check("P. defaults are the offline-validated operating point", () => {
  eq(DEFAULT_CONFIG, {
    threshold: 0.75, minSilenceDuration: 0.5, minSpeechDuration: 1.0, windowSize: 512, sampleRate: 16000,
  }, "DEFAULT_CONFIG");
  return JSON.stringify(DEFAULT_CONFIG);
});

console.log(`\n${failures === 0 ? "ALL PASS (16/16)" : failures + " FAILURE(S)"} — exit ${failures === 0 ? 0 : 1}`);
process.exit(failures === 0 ? 0 : 1);
