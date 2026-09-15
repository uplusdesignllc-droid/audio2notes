/* ============================================================================
 * NOT RUN BY 'npm test' — re-derived for the CURRENT meetingDetect contract,
 * pending the owner's review of the re-derivation (see run.js, "NOT RUN").
 *
 * PROVENANCE: this file is NOT the .scratch/ original. The original
 * (test/p2-5.stale.js, byte-identical to .scratch/p2-5-test.js) asserts the
 * PRE-eaf29dc latch rule and fails with exit 1 against the current
 * src/meetingDetect.js. This version was produced by re-deriving the affected
 * FIXTURES AND EXPECTED VALUES against the shipped rule (continuous-activity
 * debounce at src/meetingDetect.js:78, startAfterSec default 15 s, 8 s tick grid),
 * with the arithmetic written out in a comment at each changed check.
 *
 * WHY IT IS NOT IN THE RUN: editing assertions until a suite is green is precisely
 * the failure mode the .stale.js files exist to expose, so a re-derivation is a
 * CONTRACT DECISION and must be reviewed against the original before it re-enters
 * the safety net. Compare it with test/p2-5.stale.js check by check.
 *
 * MEASURED against the current src/meetingDetect.js: exits 0 (all checks pass).
 * HOW TO RUN IT MANUALLY:   node test/p2-5.rederived.js
 * TO PUT IT BACK IN THE RUN: rename it to test/p2-5.test.js — run.js appends every
 * other test/*.test.js it finds at run time, so no list needs editing.
 * ========================================================================== */
"use strict";
/* p2-5-test: meetingDetect.sawWatchedApp latch — drives evaluate() tick by tick
 * (8 s ticks, as the app's 8000 ms watcher does) and carries `next` forward. */
const { evaluate } = require("../src/meetingDetect.js");

const TICK = 8000;
let failures = 0;

function check(name, cond, detail) {
  console.log((cond ? "PASS " : "FAIL ") + name + (cond ? "" : " — " + detail));
  if (!cond) failures++;
}

/* Generic runner. opts: recording (bool or fn(now)), appFn(now)->sessions,
 * rule, ticks (count, t = i*TICK). If opts.startBecomesRecording is true, a
 * `start` action flips recording to true on later ticks (as main.js does). */
function run(opts) {
  const { recording, appFn, rule, ticks, state = null, startBecomesRecording = false } = opts;
  let s = state;
  let recordingNow = typeof recording === "function" ? recording(0) : recording;
  const actions = [];
  for (let i = 0; i < ticks; i++) {
    const now = i * TICK;
    const r = evaluate(s, {
      sessions: appFn(now),
      recording: recordingNow,
      now,
      rule,
    });
    s = r.next;
    for (const a of r.actions) actions.push({ i, t: now, a });
    if (startBecomesRecording && r.actions.some((a) => a.type === "start")) recordingNow = true;
  }
  return { actions, final: s };
}

const teamsActiveFn = (endMs) => (now) => (now <= endMs ? [{ state: "Active", name: "Teams.exe" }] : []);
const noAppFn = () => [];
const stops = (actions) => actions.filter((x) => x.a.type === "stop");
const starts = (actions) => actions.filter((x) => x.a.type === "start");
const TEN_MIN_TICKS = 76; // 0..600 s

/* 1. manual recording, no watched app ever — no stop in 10 min (the bug being fixed) */
{
  const r = run({ recording: true, appFn: noAppFn, rule: {}, ticks: TEN_MIN_TICKS });
  check("1  manual recording, never saw watched app: no stop in 10 min",
    stops(r.actions).length === 0, "got " + JSON.stringify(stops(r.actions)));
  check("1  state carries sawWatchedApp:false", r.final.sawWatchedApp === false, JSON.stringify(r.final));
}

/* 2. real call ending: teams.exe Active for t<=24 s, then quiet → stop at first
 * tick ≥ quietStart+90 s (32 s + 96 s = 128 s) */
{
  const r = run({ recording: true, appFn: teamsActiveFn(24000), rule: {}, ticks: 21 }); // 0..160 s
  const st = stops(r.actions);
  check("2  real call ending: exactly one meeting-app-quiet stop",
    st.length === 1 && st[0].a.reason === "meeting-app-quiet", JSON.stringify(st));
  if (st.length === 1) console.log("     stop fired at tick " + st[0].i + " (t = " + (st[0].t / 1000) + " s)");
}

/* 3. not recording: no actions, latch false */
{
  const r = run({ recording: false, appFn: noAppFn, rule: {}, ticks: 30 });
  check("3  not recording: no actions and sawWatchedApp:false",
    r.actions.length === 0 && r.final.sawWatchedApp === false, JSON.stringify({ r: r.actions, s: r.final }));
}

/* 4. auto-start still works: exactly one start at startAfterSec, no repeats */
{
  const r = run({ recording: false, appFn: () => [{ state: "Active", name: "Teams.exe" }],
    rule: { autoStart: true, startAfterSec: 16 }, ticks: 7 /* 0..48 s */, startBecomesRecording: true });
  const st = starts(r.actions);
  check("4  auto-start: exactly one start at 16 s",
    st.length === 1 && st[0].t === 16000 && st[0].a.app === "Teams.exe", JSON.stringify(st));
}

/* 5. enabled:false → no actions, state (incl. latch) cleared */
{
  const r = run({ recording: true, appFn: noAppFn, rule: { enabled: false }, ticks: 5,
    state: { activeSince: null, inactiveSince: 1000, sawWatchedApp: true } });
  check("5  enabled:false: no actions, state cleared incl. sawWatchedApp:false",
    r.actions.length === 0 && r.final.activeSince === null && r.final.inactiveSince === null && r.final.sawWatchedApp === false,
    JSON.stringify(r.final));
}

/* 6. boundary: stop fires at the stopAfterSec threshold once the latch is EARNED.
 * startAfterSec stays at its DEFAULT 15 s, and src/meetingDetect.js now requires a
 * watched app to be CONTINUOUSLY active for that long before the latch is earned
 * (the chat-app notification false-stop fix — BACKLOG §12.7). On this 8 s tick grid
 * the app must therefore be Active for ticks 0..2 (t = 0, 8, 16 s) before going quiet
 * at t = 24 s; with stopAfterSec 16 that puts the first stop at t = 40000 ms.
 * The old fixture held it Active for t <= 0 only, which a single observation used to
 * latch; under the current rule it measures `stops=[]` — no stop at all, which is a
 * fixture that no longer reaches the behaviour, not a boundary at the wrong time. */
{
  const r = run({ recording: true, appFn: teamsActiveFn(16000), rule: { stopAfterSec: 16 }, ticks: 7 /* 0..48 s */ });
  const st = stops(r.actions);
  check("6  boundary: no stop before 40 s, first stop at exactly quietStart+16 s (>=)",
    st.length >= 1 && st[0].t === 40000 && st[0].a.reason === "meeting-app-quiet" && st.every((x, j) => j === 0 || x.t > 40000),
    JSON.stringify(st)); // (re-arms per design; ticks end at 48 s, before the next one)
}

/* 7. latch resets between recordings */
{
  const a = run({ recording: true, appFn: () => [{ state: "Active", name: "Teams.exe" }], rule: {}, ticks: 3 });
  check("7a recording 1 saw watched app: latch true", a.final.sawWatchedApp === true, JSON.stringify(a.final));
  const b = run({ recording: false, appFn: noAppFn, rule: {}, ticks: 3, state: a.final });
  check("7b not-recording gap clears the latch", b.final.sawWatchedApp === false, JSON.stringify(b.final));
  const c = run({ recording: true, appFn: noAppFn, rule: {}, ticks: TEN_MIN_TICKS, state: b.final });
  check("7c recording 2, no app: no stop in 10 min", stops(c.actions).length === 0, JSON.stringify(stops(c.actions)));
}

/* 8. call that starts mid-recording → stop still fires */
{
  const r = run({ recording: true, appFn: teamsActiveFn(24000), rule: {}, ticks: 21 });
  const st = stops(r.actions);
  check("8  call starting mid-recording: stop still fires (~stopAfterSec after quiet)",
    st.length === 1 && st[0].a.reason === "meeting-app-quiet", JSON.stringify(st));
}

console.log(failures === 0 ? "ALL PASS (8 scenarios)" : failures + " FAILURE(S)");
process.exit(failures === 0 ? 0 : 1);
