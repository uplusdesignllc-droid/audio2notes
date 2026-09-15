"use strict";
/* THE test that decides whether the plumbing is real (tracked e2e — it keeps its
 * own name because it is not a unit suite).
 * Run: node test/liveVad-e2e.js
 *
 * It SKIPS (exit 0, a greppable `SKIP` line naming the missing path) unless the
 * decoded recording and the offline reference JSONs are present: neither is in
 * the repo (the audio is real private meeting data, and the .scratch/ offline
 * experiment is gitignored), so on a fresh clone this suite can only report that
 * it measured nothing. Point A2N_FIXTURE_ROOT at a directory holding
 * `meeting notes/` + `.scratch/vad/` + `.scratch/vad-live/` to run it for real.
 *
 * Decode first — PowerShell, and note the `-fflags +bitexact` (WITHOUT it ffmpeg
 * inserts a LIST/INFO chunk and the data area starts at 78, not 44, which shifts
 * every sample by 17 and silently changes the result):
 *   .tools\ffmpeg-backup\ffmpeg.exe -y -fflags +bitexact -i "meeting notes\2026-09-14_203332\system.opus" ^
 *       -ac 1 -ar 16000 -c:a pcm_s16le -fflags +bitexact .scratch\vad-live\sys203332.wav
 *
 * It feeds that recording through the LIVE path — createWavTailReader() +
 * createTrackVad() with the REAL native silero VAD, 1 s polls, the RIFF size
 * fields re-patched exactly like the writer does — and compares the result with
 * the offline experiment's own JSONs in .scratch/vad/.
 *
 * Offline references being reproduced:
 *   sys203332.vad-t0.5.json   18 intervals / 85.600 s / 24913 blocks / 0.1074
 *   sys203332.vad-t0.75.json  18 intervals / 78.656 s
 *   SUMMARY.md line 181       minSpeechDuration 1.0 at t0.5 -> 61.98 s
 *   SUMMARY.md line 173       threshold 0.75 -> 0 of 7 chimes detected
 */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const fx = require("./fixtures");
const { createTrackVad, createWavTailReader } = require(path.join(__dirname, "..", "src", "liveVad"));

const WAV = fx.scratch("vad-live", "sys203332.wav");
/* Tracked asset: always in the clone, so never routed through the fixture root. */
const MODEL = path.join(__dirname, "..", "assets", "models", "silero_vad.onnx");
/* The offline experiment (its runner, its Silero model copy and the reference
 * JSONs read below) is untracked scratch, and the run output belongs next to it:
 * all of it hangs off the fixture root. */
const OFFLINE = fx.scratch("vad");
const OUT = fx.scratch("vad-live");
const RUNNER = path.join(OFFLINE, "run-vad.js"); // the UNTOUCHED offline runner
/* Every fixture this suite needs before it can measure ANYTHING. Checked in one
 * place and up front, so the skip is one clear line instead of a half-run suite
 * that dies on the first missing file with a stack trace. */
const REQUIRED = [
  ["decoded recording", WAV],
  ["offline runner", RUNNER],
  ["offline Silero model", path.join(OFFLINE, "silero_vad.onnx")],
  ["offline reference", path.join(OFFLINE, "sys203332.vad-t0.5.json")],
  ["offline reference", path.join(OFFLINE, "sys203332.vad-t0.75.json")],
];

/* system.opus chime windows (seconds from the recording start), from the task. */
const CHIMES = [[242.1, 2.5], [348.1, 2.0], [439.1, 2.0], [537.1, 3.0], [563.1, 2.5], [649.1, 2.0], [783.1, 2.5]];
const REAL_AUDIO = [0.0, 119.5];

/* The offline reference configs, read off .scratch/vad/*.json (all windowSize 512,
 * sampleRate 16000, numThreads 1, bufferSizeInSeconds 60). */
const CONFIGS = [
  { tag: "t0.5-ms0.25", threshold: 0.5, minSilenceDuration: 0.5, minSpeechDuration: 0.25 },   // offline JSON: 18 / 85.600 s
  { tag: "t0.75-ms0.25", threshold: 0.75, minSilenceDuration: 0.5, minSpeechDuration: 0.25 }, // offline JSON: 18 / 78.656 s
  { tag: "t0.5-ms1.0", threshold: 0.5, minSilenceDuration: 0.5, minSpeechDuration: 1.0 },     // SUMMARY.md 181: 61.98 s
  { tag: "t0.75-ms1.0", threshold: 0.75, minSilenceDuration: 0.5, minSpeechDuration: 1.0 },   // OPERATING POINT: 0/7 chimes
];

let failures = 0;
let pending = [];
function check(name, fn) {
  pending = [];
  let info = null;
  try { info = fn(); } catch (e) { pending.push(e.message); }
  if (pending.length) {
    failures++;
    console.log(`FAIL  ${name}\n      ${pending.join("\n      ")}`);
  } else {
    console.log(`PASS  ${name}${info ? "\n      " + info : ""}`);
  }
}
/** Prints the comparison and records a mismatch for the enclosing check() when
 *  the difference exceeds tol. Never throws, so one mismatch still leaves the
 *  rest of the diagnostics on screen. */
function near(actual, expected, tol, what) {
  const d = Math.abs(actual - expected);
  const good = d <= tol;
  console.log(`      ${good ? "OK      " : "MISMATCH"}  ${what}: live=${actual}  offline=${expected}  diff=${d.toFixed(3)}  tol=${tol}`);
  if (!good) pending.push(`${what}: live ${actual} vs offline ${expected} (diff ${d.toFixed(3)} > ${tol})`);
  return good;
}

/** Rewrite the two RIFF size fields for a data area of `dataBytes` bytes. What
 *  capture.exe actually writes in them is a GUESS (I never measured it); it does
 *  not matter here because the reader never reads below offset 44 — the point is
 *  only that those bytes change under it while it is tailing the file. */
function patchedHeaderSizes(dataBytes) {
  const h = Buffer.alloc(8);
  h.writeUInt32LE(36 + dataBytes, 0); // RIFF size (offset 4)
  h.writeUInt32LE(dataBytes, 4);      // data size (offset 40)
  return h;
}

/** The full live path: a growing WAV on disk, 1 s polls, reader -> feedS16. */
function runLive(wavPath, cfg, tag) {
  const src = fs.readFileSync(wavPath);
  const dst = path.join(OUT, `live-${tag}.wav`);
  const head = Buffer.from(src.subarray(0, 44));
  head.writeUInt32LE(0, 4);   // sizes zeroed, like a writer that just created the file
  head.writeUInt32LE(0, 40);
  fs.writeFileSync(dst, head);

  const reader = createWavTailReader({ wavFile: dst });
  const vad = createTrackVad({ modelPath: MODEL, sampleRate: 16000, ...cfg });
  const chunk = 32000; // exactly 1 s of 16 kHz s16le
  let off = 44, polls = 0;
  while (off < src.length) {
    const n = Math.min(chunk, src.length - off);
    fs.appendFileSync(dst, src.subarray(off, off + n));
    off += n;
    polls++;
    if (polls % 2 === 0) { // capture.exe patches both size fields every ~2 s
      const sizes = patchedHeaderSizes(off - 44);
      const fd = fs.openSync(dst, "r+");
      fs.writeSync(fd, sizes, 4, 4, 4);
      fs.writeSync(fd, sizes, 0, 4, 40);
      fs.closeSync(fd);
    }
    const b = reader.readNew();
    if (b.length) vad.feedS16(b);
  }
  vad.close();
  const s = vad.stats();
  const r = reader.stats();
  fs.unlinkSync(dst);
  return { tag, cfg, stats: s, reader: r, polls };
}

/** Same audio, no reader: whole file sliced into 1 s feeds. Isolates the VAD from
 *  the reader, so a mismatch can be attributed to one of them. */
function runDirect(wavPath, cfg) {
  const src = fs.readFileSync(wavPath);
  const vad = createTrackVad({ modelPath: MODEL, sampleRate: 16000, ...cfg });
  for (let off = 44; off < src.length; off += 32000) {
    vad.feedS16(src.subarray(off, Math.min(off + 32000, src.length)));
  }
  vad.close();
  return vad.stats();
}

function overlapSec(intervals, winStart, winDur) {
  const a = winStart, b = winStart + winDur;
  let sum = 0;
  for (const [s, e] of intervals) sum += Math.max(0, Math.min(e, b) - Math.max(s, a));
  return Math.round(sum * 1000) / 1000;
}

/* Missing fixtures are a SKIP, not a failure and not a silent pass. The suite can
 * measure NOTHING without them, so it must say so in one greppable line and exit
 * 0 — the old `process.exit(2)` made a fresh clone's `npm test` red for a
 * deliberate absence of private data. Note this exits BEFORE any assertion runs,
 * so nothing below can be reported as having passed. */
const absent = REQUIRED.filter(([, p]) => !fs.existsSync(p));
if (absent.length) {
  for (const [what, p] of absent) fx.skip(`liveVad-e2e: ${what}`, p);
  console.log("SKIP  liveVad-e2e: 0 checks measured — see the header of this file for how to decode the fixtures.");
  process.exit(0);
}
/* TRAP, MEASURED: ffmpeg's WAV muxer writes a LIST/INFO metadata chunk between
 * "fmt " and "data", pushing the data area to offset 78 — a reader that assumes 44
 * then reads 34 header bytes and shifts every sample by 17 (0.001 s). The first
 * version of this test did exactly that and reported 85.664 s / 18 intervals
 * instead of 85.696 s. Re-decoding with `-fflags +bitexact` restores the canonical
 * 44-byte header that capture.exe writes. ASSERT it rather than trust it. */
const head = fs.readFileSync(WAV).subarray(0, 44);
if (head.subarray(36, 40).toString("ascii") !== "data") {
  /* The fixture EXISTS but is unusable (a LIST/INFO chunk shifted the data area).
   * Nothing about the product can be concluded from it either, so this is the same
   * class as a missing fixture: SKIP with the reason, and keep `npm test` honest
   * rather than red on a stale decode. */
  fx.skip(`liveVad-e2e: decoded recording with the canonical 44-byte header (offset 36 = "${head.subarray(36, 40).toString("ascii")}" — re-decode with -fflags +bitexact)`, WAV);
  process.exit(0);
}
const offlineJson = (tag) => JSON.parse(fs.readFileSync(path.join(OFFLINE, `sys203332.vad-${tag}.json`), "utf8"));
const off05 = offlineJson("t0.5");
const off075 = offlineJson("t0.75");

const wavBytes = fs.statSync(WAV).size;
console.log("=== live path over the real recording (meeting notes/2026-09-14_203332/system.opus) ===");
console.log(`wav bytes=${wavBytes} data bytes=${wavBytes - 44} => ${((wavBytes - 44) / 2 / 16000).toFixed(3)} s`);
console.log(`model=${MODEL} (${fs.statSync(MODEL).size} B)`);
console.log("");

/* --------------------------------------------------------- 1) run all configs */
const results = {};
for (const c of CONFIGS) {
  const t0 = Date.now();
  const live = runLive(WAV, c, c.tag);
  const direct = runDirect(WAV, c);
  results[c.tag] = { live, direct, ms: Date.now() - t0 };
  console.log(`--- ${c.tag}: threshold=${c.threshold} minSilence=${c.minSilenceDuration} minSpeech=${c.minSpeechDuration}`);
  console.log(`      live  : intervals=${live.stats.intervals.length} totalSpeechSec=${live.stats.totalSpeechSec} fraction=${live.stats.speechFraction} blocksFed=${live.stats.blocksFed} samplesFed=${live.stats.samplesFed} bytesFed=${live.stats.bytesFed} errors=${live.stats.errors} failed=${live.stats.failed}`);
  console.log(`      direct: intervals=${direct.intervals.length} totalSpeechSec=${direct.totalSpeechSec} fraction=${direct.speechFraction} blocksFed=${direct.blocksFed} samplesFed=${direct.samplesFed}`);
  console.log(`      reader: bytesRead=${live.reader.bytesRead} errors=${live.reader.errors} shorterReads=${live.reader.shorterReads}; polls=${live.polls}; ${Date.now() - t0} ms`);
  console.log("");
}

/* ------------------- 0) the decisive cross-check: same input, same intervals - */
check("0. LIVE path == the UNTOUCHED offline runner on the SAME s16 audio", () => {
  /* The archived JSONs were produced from f32 input. To separate CODE from INPUT,
   * run .scratch/vad/run-vad.js (never modified) over f32 built from my s16 WAV,
   * and require interval-for-interval identity with the live path. Spawned with
   * stdio:"inherit" — a piped stdout from a child is EPERM in this sandbox. */
  const wav = fs.readFileSync(WAV);
  const n = (wav.length - 44) / 2;
  const s = new Int16Array(wav.buffer, wav.byteOffset + 44, n);
  const buf = Buffer.alloc(n * 4);
  const f32 = new Float32Array(buf.buffer, buf.byteOffset, n);
  for (let i = 0; i < n; i++) f32[i] = s[i] / 32768;
  const f32Path = path.join(OUT, "fromwav.f32");
  fs.writeFileSync(f32Path, buf);
  console.log("      running the untouched offline runner (its own stdout follows):");
  execFileSync(process.execPath, [RUNNER, f32Path, path.join(OFFLINE, "silero_vad.onnx"), "0.5", "0.5", "0.25", "512", "512"], { stdio: "inherit" });
  const off = JSON.parse(fs.readFileSync(f32Path.replace(/\.f32$/, ".vad-t0.5.json"), "utf8"));
  const mine = results["t0.5-ms0.25"].live.stats;
  const a = JSON.stringify(off.intervals.map((x) => [x.start, x.end]));
  const b = JSON.stringify(mine.intervals);
  console.log(`      offline runner: ${off.intervalCount} intervals / ${off.detectedSeconds} s`);
  console.log(`      live path     : ${mine.intervals.length} intervals / ${mine.totalSpeechSec} s`);
  if (a !== b) throw new Error(`intervals differ:\n      offline=${a}\n      live   =${b}`);
  return `IDENTICAL interval list (${off.intervalCount}) and total (${off.detectedSeconds} s): the live path IS the offline code path`;
});

/* ------------------------- 1) the archived offline reference, f32 input ----- */
check("1. t0.5 vs the ARCHIVED offline JSON (f32 input): 18 intervals / 85.600 s", () => {
  const l = results["t0.5-ms0.25"].live.stats;
  console.log(`      intervalCount: live=${l.intervals.length}  offline=${off05.intervalCount}`);
  console.log(`      totalSeconds : live=${l.audioSec}  offline=${off05.totalSeconds}`);
  console.log(`      blocks       : live=${l.blocksFed}  offline=${off05.blocks}`);
  if (l.intervals.length !== off05.intervalCount) pending.push(`intervalCount live=${l.intervals.length} offline=${off05.intervalCount}`);
  if (l.blocksFed !== off05.blocks) pending.push(`blocksFed live=${l.blocksFed} offline=${off05.blocks}`);
  near(l.totalSpeechSec, off05.detectedSeconds, 0.15, "detectedSeconds (residual == the s16 quantisation, see below)");
  console.log("      interval boundaries (live vs offline, seconds):");
  let exact = 0, worst = 0;
  for (let i = 0; i < Math.max(l.intervals.length, off05.intervals.length); i++) {
    const x = l.intervals[i], y = off05.intervals[i];
    const sa = x ? x[0] : NaN, ea = x ? x[1] : NaN, sb = y ? y.start : NaN, eb = y ? y.end : NaN;
    const d = x && y ? Math.max(Math.abs(sa - sb), Math.abs(ea - eb)) : Infinity;
    if (d <= 1e-9) exact++; else worst = Math.max(worst, d);
    console.log(`        #${String(i + 1).padStart(2)} live=[${sa.toFixed(3)},${ea.toFixed(3)}] offline=[${sb.toFixed(3)},${eb.toFixed(3)}] diff=${d.toFixed(3)}${d <= 1e-9 ? "  exact" : "  <-- DIFFERS"}`);
  }
  console.log(`      ${exact}/${off05.intervalCount} intervals byte-exact; worst deviation ${worst.toFixed(3)} s (${Math.round(worst / 0.032)} block(s))`);
  if (exact < off05.intervalCount - 1) pending.push(`only ${exact}/${off05.intervalCount} intervals exact`);
  if (l.failed || l.errors) pending.push(`failed=${l.failed} errors=${l.errors}`);
  /* WHY A RESIDUAL IS EXPECTED AND BOUNDED: the archive was measured on float32
   * input, the live path reads the s16le the recorder actually writes
   * (READY fmt=16000:1:16). max|f32 - s16/32768| = 1.526e-05 = half an LSB. The
   * offline runner fed THE SAME s16 audio (check 0) gives exactly the live
   * numbers, and the live path fed the archived f32 quantised to s16 gives exactly
   * the live numbers too (.scratch/liveVad-attrib2.js) — so the residual is the
   * input format, not the code. */
  if (pending.length) throw new Error("see above");
  return `${exact}/${off05.intervalCount} intervals identical to the ms, total ${l.totalSpeechSec} s vs ${off05.detectedSeconds} s (+${(l.totalSpeechSec - off05.detectedSeconds).toFixed(3)} s) — residual fully attributed to 16-bit input (check 0)`;
});

check("2. direct-feed (no reader) gives the identical t0.5 result", () => {
  const l = results["t0.5-ms0.25"];
  const a = JSON.stringify(l.live.stats.intervals), b = JSON.stringify(l.direct.intervals);
  if (a !== b) throw new Error(`reader path != direct path:\n live  =${a}\n direct=${b}`);
  return `both paths: ${l.direct.intervals.length} intervals / ${l.direct.totalSpeechSec} s — the reader introduces no shift`;
});

check("3. t0.75/ms0.25 does NOT reproduce on 16-bit input: chime 3 leaks (19 vs 18)", () => {
  /* REPORTED AS A DEVIATION, NOT HIDDEN. The offline JSON has 18 intervals; the
   * live path finds 19. The extra one is [349.536, 350.176] — chime 3, which the
   * offline f32 run rejected at 0.75. SUMMARY.md line 159 puts that rejection
   * boundary at "0.72 < t <= 0.75", i.e. ZERO margin at 0.75, so half an LSB of
   * quantisation is enough to flip it back. Threshold alone is not a safe gate on
   * 16-bit audio; the 1.0 s duration rule is (check 5). */
  const l = results["t0.75-ms0.25"].live.stats;
  const mine = l.intervals, off = off075.intervals.map((x) => [x.start, x.end]);
  console.log(`      intervalCount: live=${mine.length}  offline=${off.length}`);
  console.log(`      detectedSeconds: live=${l.totalSpeechSec}  offline=${off075.detectedSeconds}  diff=${(l.totalSpeechSec - off075.detectedSeconds).toFixed(3)}`);
  near(l.totalSpeechSec, off075.detectedSeconds, 0.7, "detectedSeconds");
  /* Classify: exact (same to the ms), near (within one 0.032 s block), new. */
  const used = new Set();
  const exact = [], shifted = [], unmatched = [];
  for (const iv of mine) {
    let best = -1, bestD = Infinity;
    off.forEach((o, i) => {
      if (used.has(i)) return;
      const d = Math.max(Math.abs(o[0] - iv[0]), Math.abs(o[1] - iv[1]));
      if (d < bestD) { bestD = d; best = i; }
    });
    if (best >= 0 && bestD <= 0.032 + 1e-9) {
      used.add(best);
      (bestD <= 1e-9 ? exact : shifted).push([iv, off[best], bestD]);
    } else {
      unmatched.push(iv);
    }
  }
  console.log(`      intervals identical to the ms : ${exact.length}/${off.length}`);
  console.log(`      intervals shifted <= 1 block  : ${shifted.length}${shifted.length ? " " + JSON.stringify(shifted.map(([a, b, d]) => [`${a[0]}-${a[1]}`, `offline ${b[0]}-${b[1]}`, `diff ${d.toFixed(3)}`])) : ""}`);
  console.log(`      offline intervals with no live match: ${off.length - used.size}`);
  console.log(`      intervals present live but NOT offline: ${JSON.stringify(unmatched)}`);
  if (off.length - used.size !== 0) pending.push(`${off.length - used.size} offline interval(s) missing from the live result`);
  if (unmatched.length !== 1) pending.push(`expected exactly 1 new interval, got ${unmatched.length}`);
  for (const [s, e] of unmatched) {
    const inChime3 = s >= 348.1 && e <= 350.1 + 0.2;
    console.log(`        [${s},${e}] (${(e - s).toFixed(3)} s) inside the chime 3 window [348.1,350.1]: ${inChime3}`);
    if (!inChime3) pending.push(`unexplained extra interval [${s},${e}] is not chime 3`);
  }
  if (pending.length) throw new Error("the extra interval is not the known chime-3 leak");
  return `DEVIATION CONFIRMED AND EXPLAINED: ${exact.length} intervals identical, ${shifted.length} shifted by 1 block, ${off.length - used.size} missing, and the single new interval is chime 3 (349.536-350.176, 0.640 s) — at t0.75/ms0.25 the offline "0 of 7 chimes" claim does NOT hold on s16 input`;
});

check("4. t0.5/ms1.0 vs the offline measured 61.98 s (SUMMARY.md line 181)", () => {
  const l = results["t0.5-ms1.0"].live.stats;
  near(l.totalSpeechSec, 61.98, 0.15, "detectedSeconds (offline, minSpeechDuration=1.0)");
  if (pending.length) throw new Error("see above");
  return `${l.intervals.length} intervals / ${l.totalSpeechSec} s`;
});

/* ------------------------------------------- 2) the chime check (0 of 7) --- */
check("5. OPERATING POINT t0.75/ms1.0: 0 of the 7 known chimes detected", () => {
  const l = results["t0.75-ms1.0"].live.stats;
  console.log("      chime windows (system.opus) vs live detected speech:");
  let tripped = 0, total = 0;
  CHIMES.forEach(([start, dur], i) => {
    const ov = overlapSec(l.intervals, start, dur);
    total += ov;
    if (ov > 0) tripped++;
    console.log(`        chime ${i + 2}  [${start.toFixed(1)} +${dur.toFixed(1)}s] -> detected ${ov.toFixed(3)} s  ${ov > 0 ? "TRIPPED" : "rejected"}`);
  });
  const real = overlapSec(l.intervals, REAL_AUDIO[0], REAL_AUDIO[1]);
  console.log(`      real audio [0.0 +119.5s] -> detected ${real.toFixed(3)} s in this config`);
  console.log(`      (offline, for orientation: 83.78 s at t0.5/ms0.25, 78.22 s at t0.75/ms0.25, 61.98 s at t0.5/ms1.0)`);
  console.log(`      total chime overlap = ${total.toFixed(3)} s; chimes tripped = ${tripped}/7`);
  if (tripped !== 0) pending.push(`${tripped}/7 chimes tripped at the operating point`);
  if (total !== 0) pending.push(`total chime overlap ${total} s != 0`);
  if (pending.length) throw new Error("see above");
  return `0/7 chimes, total chime overlap ${total.toFixed(3)} s, ${l.intervals.length} intervals / ${l.totalSpeechSec} s of speech kept (t0.75/ms0.25 on the same audio would have leaked chime 3)`;
});

check("6. t0.5 reproduces the offline CHIME LEAK intervals EXACTLY (349.504-350.208, 649.984-650.656)", () => {
  const l = results["t0.5-ms0.25"].live.stats;
  const want = off05.intervals.map((x) => [x.start, x.end]).filter((iv) => iv[0] > 300); // the 2 chime blips
  console.log(`      offline chime blips: ${JSON.stringify(want)}`);
  const got = l.intervals.filter((iv) => iv[0] > 300);
  console.log(`      live    chime blips: ${JSON.stringify(got)}`);
  if (JSON.stringify(want) !== JSON.stringify(got)) pending.push("the chime blip intervals differ");
  console.log("      chime windows vs live detected speech at t0.5 (informational: the task's");
  console.log("      windows are wider than the offline report's, so overlaps are not comparable):");
  let tripped = 0;
  CHIMES.forEach(([start, dur], i) => {
    const ov = overlapSec(l.intervals, start, dur);
    if (ov > 0) tripped++;
    console.log(`        chime ${i + 2}  [${start.toFixed(1)} +${dur.toFixed(1)}s] -> detected ${ov.toFixed(3)} s  ${ov > 0 ? "TRIPPED" : "rejected"}`);
  });
  if (pending.length) throw new Error("see above");
  return `2/7 chimes leak at t0.5, at exactly the offline positions and durations (0.704 s and 0.672 s)`;
});

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"} — exit ${failures === 0 ? 0 : 1}`);
process.exit(failures === 0 ? 0 : 1);
