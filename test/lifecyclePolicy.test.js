"use strict";
/* Verification for the lifecyclePolicy half of defect A + deliverable 5.
 * Run: node test/lifecyclePolicy.test.js */
const path = require("path");
const { evaluate } = require(path.join(__dirname, "..", "src", "lifecyclePolicy"));

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
const types = (r) => r.actions.map((a) => a.type);

// autoQuitAfterMin:-1 disables the idle branch so each scenario stays on the
// "recording" path. forceStopAfterMin is omitted ON PURPOSE on the first config:
// that pins the DEFAULT (must now be 3 => warn at 2 min, force-stop at 5 min).
const CFG_DEFAULT = { autoStop: { enabled: true, silenceMin: 2, minFreeDiskGB: 0, maxElapsedMin: 0 }, autoQuitAfterMin: -1 };

function tick(lastLoudAt, now, warnedAt, cfg) {
  return evaluate(
    { recording: true, recStartMs: 0, lastLoudAt, warnedAt, suppressed: false },
    cfg || CFG_DEFAULT,
    now
  );
}

check("policy 1. default forceStopAfterMin is 3 (warn 2 min, stop at 5 min total)", () => {
  const t0 = 1_000_000_000;
  const warn = tick(t0, t0 + 120_000, null);          // silentSec = 120 s = warnAfter
  eq(types(warn), ["warn-silence"], "actions at 120 s");
  eq(warn.actions[0].first, true, "first warning");
  eq(warn.actions[0].forceInSec, 180, "forceInSec (3 min grace, not 5)");
  const notYet = tick(t0, t0 + 299_000, warn.next.warnedAt); // 299 s < 300 s
  eq(types(notYet), ["warn-silence"], "actions at 299 s");
  const stop = tick(t0, t0 + 300_000, notYet.next.warnedAt); // 300 s = 2 + 3 min
  eq(types(stop), ["stop"], "actions at 300 s");
  eq(stop.actions[0].reason, "silence", "stop reason");
  return `120 s -> ${JSON.stringify(warn.actions[0])}\n      299 s -> warn-silence (grace NOT over)   300 s -> stop:silence`;
});

check("policy 2. silence-cleared fires ONLY on a real warning -> clear transition", () => {
  const t0 = 1_000_000_000;
  const warn = tick(t0, t0 + 120_000, null);
  eq(types(warn), ["warn-silence"], "warning");
  const stillSilent = tick(t0, t0 + 135_000, warn.next.warnedAt);
  eq(types(stillSilent), ["warn-silence"], "second tick while still silent (no silence-cleared)");
  const cleared = tick(t0, t0 + 135_000, stillSilent.next.warnedAt, undefined);
  // ... now sound came back: lifecycle.lastLoudAt is refreshed by the tracker
  const resumed = tick(t0 + 135_000, t0 + 135_500, stillSilent.next.warnedAt);
  eq(types(resumed), ["silence-cleared"], "warn -> clear transition");
  eq(resumed.next.warnedAt, null, "warnedAt cleared by the policy");
  const quietIdle = tick(t0 + 135_000, t0 + 136_000, resumed.next.warnedAt);
  eq(types(quietIdle), [], "no repeat event on the next idle tick");
  eq(cleared.next.warnedAt, stillSilent.next.warnedAt, "untouched when nothing changed");
  return `warn -> ${JSON.stringify(types(warn))}   still-silent -> ${JSON.stringify(types(stillSilent))}   sound back -> ${JSON.stringify(types(resumed))}   next tick -> ${JSON.stringify(types(quietIdle))}`;
});

check("policy 3. no silence-cleared when no warning was outstanding", () => {
  const t0 = 1_000_000_000;
  const idle = tick(t0, t0 + 5_000, null); // 5 s of silence, never warned
  eq(types(idle), [], "actions");
  eq(idle.next.warnedAt, null, "warnedAt");
  return `actions=${JSON.stringify(types(idle))} warnedAt=${idle.next.warnedAt}`;
});

console.log(failures ? `\n${failures} CHECK(S) FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
