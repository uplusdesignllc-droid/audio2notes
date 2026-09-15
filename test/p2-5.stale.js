/* ============================================================================
 * STALE SUITE — TRACKED FOR THE RECORD, NOT RUN BY 'npm test'.
 * run.js lists it under "NOT RUN — stale suite, asserts a superseded contract".
 *
 * WHAT IT ASSERTS: the PRE-eaf29dc latch rule — that ONE tick with a watched app
 * Active is enough for sawWatchedApp to latch, so the quiet-to-stop countdown
 * starts from the very first quiet tick.
 *
 * WHY THAT IS NO LONGER THE CONTRACT: commit eaf29dc ("meetingDetect: a
 * notification sound must not latch the auto-stop", 2026-09-14 10:11 -0400)
 * made the latch require CONTINUOUS activity — src/meetingDetect.js:78:
 *     } else if (s.activeSince != null && now - s.activeSince >= rule.startAfterSec * 1000) {
 * with startAfterSec defaulting to 15 s (src/meetingDetect.js:29). On the 8 s tick
 * grid this suite drives, a latch therefore needs THREE ticks (~16 s of covered
 * time); one tick (8 s) can no longer earn it. The debounce exists because
 * slack.exe/Discord.exe are on the watched list and a single notification sound
 * used to arm the auto-stop, which then truncated a recording of something else.
 *
 * MEASURED against the CURRENT src/meetingDetect.js (which this suite does not and
 * must not modify): it does NOT pass —
 *
 *     $ node test/p2-5.stale.js
 *     FAIL 6  boundary: no stop before 24 s, first stop at exactly quietStart+16 s (>=) — []
 *     1 FAILURE(S)
 *     exit=1
 *
 * i.e. check 6 holds the app Active for a single tick, the latch is never earned
 * under the current rule, and no stop is emitted at all (stops = []). Checks
 * 1-5, 7 and 8 still pass, which is why this is a stale test rather than noise.
 *
 * HOW TO RUN IT MANUALLY:   node test/p2-5.stale.js      (expected: exit 1)
 *
 * DO NOT "FIX" IT BY CHANGING src/ — nothing under src/ may be edited to satisfy
 * a stale test. The only legitimate fix is to RE-DERIVE what the current contract
 * should assert (hold the app Active long enough to earn the latch, then expect
 * the stop at quietStart + stopAfterSec, with the arithmetic written out). Such a
 * re-derivation of this scenario exists as test/p2-5.rederived.js; it is kept out
 * of the run as well until whoever owns the meetingDetect contract accepts it.
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

/* 6. boundary: stop fires exactly at stopAfterSec (>=) */
{
  const r = run({ recording: true, appFn: teamsActiveFn(0), rule: { stopAfterSec: 16 }, ticks: 7 /* 0..48 s */ });
  const st = stops(r.actions);
  check("6  boundary: no stop before 24 s, first stop at exactly quietStart+16 s (>=)",
    st.length >= 1 && st[0].t === 24000 && st[0].a.reason === "meeting-app-quiet" && st.every((x, j) => j === 0 || x.t > 24000),
    JSON.stringify(st)); // (re-arms per design: further stops at 40 s etc. are expected)
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
