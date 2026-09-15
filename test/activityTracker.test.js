"use strict";
/* Verification for src/activityTracker.js (tracked suite; moved out of .scratch/
 * so a fresh clone keeps it — the file itself needed no path change, `__dirname`
 * is still <root>/test and `../src` still resolves).
 * Run: node test/activityTracker.test.js
 * Every assertion below is checked against the measured ground truth in the task:
 * a beep is 2.0-3.0 s of loud windows, speech is 12.5-119.5 s. */
const path = require("path");
const { createActivityTracker } = require(path.join(__dirname, "..", "src", "activityTracker"));

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

const BASE = 1_700_000_000_000; // arbitrary epoch ms
const cfg = () => ({ windowSec: 12, loudSec: 4, sampleSec: 0.5, levelThreshold: 8 });

/* ---------------------------------------------------------------- A: beep */
check("A. REGRESSION: five samples LEVEL 27-31 (a 2.5 s beep) are NOT activity", () => {
  const t = createActivityTracker(cfg());
  t.pushBatch([27, 29, 31, 28, 30], BASE); // all five NEW lines seen in one 300 ms poll
  const s = t.stats(BASE);
  eq(s.active, false, "active");
  eq(s.loudMsInWindow, 2500, "loudMsInWindow");
  return `beep: loudMsInWindow=${s.loudMsInWindow} < loudSec*1000=${4 * 1000} -> active=${s.active}`;
});

/* ------------------------------------------------------------ B: sustained */
check("B. sustained 12 s of loud samples IS activity", () => {
  const t = createActivityTracker(cfg());
  const levels = Array.from({ length: 24 }, (_, i) => 40 + (i % 6)); // 12.0 s, peaks 40-45
  t.pushBatch(levels, BASE);
  const s = t.stats(BASE);
  eq(s.active, true, "active");
  eq(s.loudMsInWindow, 12000, "loudMsInWindow");
  return `24 samples / 12.0 s: loudMsInWindow=${s.loudMsInWindow} active=${s.active}`;
});

/* -------------------------------------------------------------- C: bursty */
check("C. bursty speech 2 s loud / 1 s quiet / 2 s loud (4 s accumulated) IS activity", () => {
  const t = createActivityTracker(cfg());
  // 10 samples, oldest at BASE-4500; the longest CONTIGUOUS loud run is only 2 s
  t.pushBatch([40, 40, 40, 40, 3, 3, 45, 45, 45, 45], BASE);
  const s = t.stats(BASE);
  eq(s.active, true, "active");
  eq(s.loudMsInWindow, 4000, "loudMsInWindow (exact boundary == loudSec*1000)");
  const t2 = createActivityTracker(cfg());
  t2.pushBatch([40, 40, 40, 40, 3, 3, 45, 45, 45, 45, 45, 45], BASE); // 2 s / 1 s / 3 s = 5 s
  const s2 = t2.stats(BASE);
  eq(s2.active, true, "active (2/1/3 s case)");
  eq(s2.loudMsInWindow, 5000, "loudMsInWindow (2/1/3 s case)");
  return (
    `2/1/2 s: loudMsInWindow=${s.loudMsInWindow} active=${s.active} (longest contiguous run = 2 s)\n` +
    `      2/1/3 s: loudMsInWindow=${s2.loudMsInWindow} active=${s2.active}`
  );
});

/* ------------------------------------------------------------ D: age-out */
check("D. the same samples are no longer active once they leave the window", () => {
  const t = createActivityTracker(cfg());
  t.pushBatch(new Array(8).fill(50), BASE); // exactly 4.0 s of loud, oldest at BASE-3500
  eq(t.isActive(BASE), true, "active at once");
  const curve = [];
  for (const off of [0, 5000, 8000, 10000, 11500, 12500]) {
    const p = createActivityTracker(cfg());
    p.pushBatch(new Array(8).fill(50), BASE);
    const s = p.stats(BASE + off);
    curve.push(`+${off}:loud=${s.loudMsInWindow}/kept=${s.samplesInWindow}/active=${s.active}`);
    if (off === 12500) {
      eq(s.active, false, "active 12.5 s later");
      eq(s.loudMsInWindow, 0, "loudMsInWindow 12.5 s later");
      eq(s.samplesInWindow, 0, "samples held 12.5 s later");
    }
    /* CHANGED 2026-09-15 (union measure) — reported, not quietly edited.
     * At +10000 the oldest loud interval reaches back exactly to `at - windowMs`,
     * so the OLD sum counted its full 500 ms (2500 total) although only the part
     * inside the window is visible; the union clips it to the window and reports
     * 2000. Both are "inside the window" answers, but only the clipped one is a
     * time measurement: the sum credited half a second of loudness to time that
     * had already left the window. (The +11500/+12500 assertions below are
     * unaffected — that is not an accident, they are the ones the guard acts on.) */
    if (off === 10000) {
      eq(s.loudMsInWindow, 2000, "loudMsInWindow at +10000 (window-clipped union, was 2500 as a sum)");
      eq(s.active, false, "active at +10000");
    }
  }
  return "decay: " + curve.join("  ");
});

/* --------------------------------------- E: pushBatch capture-time stamps */
check("E. pushBatch spreads 3 samples 0.5 s apart in CAPTURE time", () => {
  const mk = () => ({ windowSec: 2, loudSec: 1000, sampleSec: 0.5, levelThreshold: 8 }); // loudSec huge -> never active, only membership is probed
  const offsets = [0, 500, 1000, 1500, 2000, 2500];
  const table = offsets.map((off) => {
    const b = createActivityTracker(mk());
    b.pushBatch([50, 50, 50], BASE); // ONE poll delivering three lines
    return b.stats(BASE + off).samplesInWindow;
  });
  const ref = offsets.map((off) => {
    const r = createActivityTracker(mk());
    r.push(50, BASE - 1000);
    r.push(50, BASE - 500);
    r.push(50, BASE);
    return r.stats(BASE + off).samplesInWindow;
  });
  eq(table, [3, 3, 3, 2, 1, 0], "samplesInWindow at +0/+500/+1000/+1500/+2000/+2500");
  eq(table, ref, "batch must equal 3 explicit pushes at BASE-1000 / BASE-500 / BASE");
  return (
    "window membership probe (windowSec=2): " +
    offsets.map((o, i) => `+${o}ms:${table[i]}`).join("  ") +
    "\n      drops at +1500/+2000/+2500 ms => the three samples sit at BASE-1000, BASE-500, BASE" +
    "\n      identical to three explicit push() calls at those exact times => " + JSON.stringify(ref)
  );
});

/* ------------------------------------------------------- F: exact boundary */
check("F. loud time exactly == loudSec*1000 is active (>= not >)", () => {
  const t = createActivityTracker(cfg());
  t.pushBatch(new Array(8).fill(50), BASE); // 8 * 500 ms = 4000 ms == loudSec*1000
  const s = t.stats(BASE);
  eq(s.loudMsInWindow, 4000, "loudMsInWindow");
  eq(s.active, true, "active at the boundary");
  const u = createActivityTracker(cfg());
  u.pushBatch(new Array(7).fill(50), BASE); // 3500 ms, one sample short
  eq(u.stats(BASE).active, false, "active one sample short");
  return `8 samples (4000 ms): active=${s.active}   7 samples (${u.stats(BASE).loudMsInWindow} ms): active=${u.stats(BASE).active}`;
});

/* ------------------------------------------- F2: same instant, two tracks */
check("F2. NEW: two samples at the SAME timestamp do not double-count (union, not sum)", () => {
  /* The same instant, observed TWICE. Explicit push() is the right instrument
   * here: pushBatch() deliberately spreads its batch sampleSec apart (that is
   * the harness's contract), so pushBatch([50,50], BASE) is two DIFFERENT
   * instants 500 ms apart and legitimately measures 1000 ms — asserted below so
   * the distinction is on the record rather than assumed. */
  const t = createActivityTracker(cfg());
  t.push(50, BASE);          // system track
  t.push(50, BASE);          // mic track, identical capture-time stamp
  const s = t.stats(BASE);
  eq(s.loudMsInWindow, 500, "loudMsInWindow (same instant observed twice)");
  eq(s.active, false, "active");

  // ... and the batch form, which is one instant per sample by design:
  const b = createActivityTracker(cfg());
  b.pushBatch([50, 50], BASE); // second sample sits 500 ms earlier
  eq(b.stats(BASE).loudMsInWindow, 1000, "pushBatch([50,50]) = two instants 500 ms apart, not one");

  // three copies of one instant are still one interval
  const c = createActivityTracker(cfg());
  c.push(50, BASE); c.push(50, BASE); c.push(50, BASE);
  eq(c.stats(BASE).loudMsInWindow, 500, "three copies of one instant");
  return `2 x push(50, same ts) -> ${s.loudMsInWindow} ms (the old sum said 1000); 3 x -> ${c.stats(BASE).loudMsInWindow} ms; pushBatch([50,50]) -> ${b.stats(BASE).loudMsInWindow} ms (different instants)`;
});

/* ------------------------- F3: the both-track chime (the defect, measured) */
check("F3. NEW: a 2.5 s chime heard on BOTH tracks is rejected (< 4000 ms, isActive false)", () => {
  /* Both tracks observe the SAME 2.5 s chime (5 x 0.5 s windows each), but the
   * two capture processes do not share a poll phase: in this recording the mic
   * track's loud region began ~400 ms after the system track's (BACKLOG §11.4's
   * measured 8 s span shift is the same effect seen whole). Two interleaved
   * streams, one offset by 400 ms — exactly what the real tracks feed in. */
  const t = createActivityTracker(cfg());
  const OFFSET = 400;
  const sys = [0, 1, 2, 3, 4].map((k) => BASE - 2000 + k * 500);      // system stream
  const mic = [0, 1, 2, 3, 4].map((k) => BASE - 2000 + OFFSET + k * 500); // mic stream, +400 ms
  const all = sys.map((at) => [50, at]).concat(mic.map((at) => [50, at])).sort((a, b) => a[1] - b[1]);
  for (const [lv, at] of all) t.push(lv, at);
  const s = t.stats(BASE + 2000);
  if (!(s.loudMsInWindow < 4000)) throw new Error(`both-track chime measured ${s.loudMsInWindow} ms — the 4000 ms requirement is STILL met`);
  eq(s.active, false, "active (a 2.5 s chime heard on both tracks must not reset the silence clock)");
  // and the sum would have said 5000: state the improvement explicitly
  if (s.loudMsInWindow === 5000) throw new Error("sum behaviour still present (5000 ms)");
  return (
    `both-track chime = ${s.loudMsInWindow} ms (sum would be 5000, single-track is 2500, requirement is 4000) -> active=${s.active}` +
    `\n      remaining ${4000 - s.loudMsInWindow} ms of margin; the ${s.loudMsInWindow - 2500} ms above 2500 is the ${OFFSET} ms track offset seen as real cover, not double-counting`
  );
});

/* --------------------------------------------------------------- G: reset */check("G. reset() clears state", () => {
  const t = createActivityTracker(cfg());
  t.pushBatch(new Array(10).fill(50), BASE);
  eq(t.isActive(BASE), true, "active before reset");
  eq(typeof t.lastActiveMs(), "number", "lastActiveMs before reset");
  t.reset();
  const s = t.stats(BASE);
  eq(s.active, false, "active after reset");
  eq(s.loudMsInWindow, 0, "loudMsInWindow after reset");
  eq(s.samplesInWindow, 0, "samplesInWindow after reset");
  eq(t.lastActiveMs(), null, "lastActiveMs after reset");
  return `after reset: ${JSON.stringify(s)} lastActiveMs=${t.lastActiveMs()}`;
});

/* ------------------------------------------------------ H: bounded memory */
check("H. 100 000 pushes do not grow the buffer without bound", () => {
  const t = createActivityTracker(cfg());
  for (let i = 0; i < 100000; i++) t.push(i % 2 ? 50 : 1, BASE + i * 500); // 13.9 hours
  const last = BASE + 99999 * 500;
  const s = t.stats(last);
  if (s.samplesInWindow > 26) throw new Error(`buffer grew to ${s.samplesInWindow} (cap is ceil(12000/500)+2 = 26)`);
  eq(s.samplesInWindow, 25, "samplesInWindow (12 s window / 0.5 s = 25 samples)");
  eq(s.active, true, "active at the end");
  eq(t.lastActiveMs(), last, "lastActiveMs");
  const b = createActivityTracker(cfg());
  for (let i = 0; i < 20000; i++) b.pushBatch([50, 50, 50, 50, 50], BASE + i * 2500); // same 100k, in batches
  const sb = b.stats(BASE + 19999 * 2500);
  if (sb.samplesInWindow > 26) throw new Error(`batch buffer grew to ${sb.samplesInWindow}`);
  return (
    `100 000 push(): samplesInWindow=${s.samplesInWindow} loudMsInWindow=${s.loudMsInWindow}\n` +
    `      100 000 samples via 20 000 x pushBatch(5): samplesInWindow=${sb.samplesInWindow}`
  );
});

/* ------------------------------------------------------ I: nonsense input */
check("I. nonsense input never throws", () => {
  const t = createActivityTracker({});
  t.push(-5, BASE);            // negative level
  t.push(NaN, BASE);           // NaN level
  t.push(50, NaN);             // NaN timestamp -> dropped
  t.push(50, undefined);
  t.pushBatch([], BASE);       // empty batch
  t.pushBatch(null, BASE);     // not an array
  t.pushBatch([50, 50], "nope");
  t.push(60, BASE - 10_000_000); // clock jumped backwards
  t.push(60, BASE + 10_000_000); // ... and forwards
  eq(t.isActive(NaN), false, "isActive(NaN)");
  eq(t.isActive(undefined), false, "isActive(undefined)");
  t.stats(undefined);
  t.stats(null);
  const s = t.stats(BASE);
  eq(s.samplesInWindow <= 26, true, "buffer still bounded");
  return `survived; buffer=${s.samplesInWindow} active=${s.active} loudMsInWindow=${s.loudMsInWindow}`;
});

/* ------------------------------------------- J: out-of-order arrival order */
check("J. a batch delivering OLDER stamps than the buffer holds is still pruned", () => {
  const t = createActivityTracker({ windowSec: 2, loudSec: 1000, sampleSec: 0.5, levelThreshold: 8 });
  t.push(60, BASE);                  // poll saw only the newest line first
  t.pushBatch([60, 60], BASE - 3000); // a later poll delivers two lines written 3 s earlier
  const s = t.stats(BASE);
  // both older samples are outside the 2 s window: they must be GONE, not merely
  // uncounted (a stale entry behind a fresh front would linger until the cap hit)
  eq(s.samplesInWindow, 1, "samplesInWindow (stale samples truly pruned)");
  eq(s.loudMsInWindow, 500, "loudMsInWindow");
  eq(s.active, false, "active");
  return `after an out-of-order batch: ${JSON.stringify(s)}`;
});

console.log(failures ? `\n${failures} CHECK(S) FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
