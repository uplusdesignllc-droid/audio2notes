/* ============================================================================
 * NOT RUN BY 'npm test' — re-derived for the CURRENT meetingDetect contract,
 * pending the owner's review of the re-derivation (see run.js, "NOT RUN").
 *
 * PROVENANCE: this file is NOT the .scratch/ original. The original
 * (test/p2-5-verify.stale.js, byte-identical to .scratch/p2-5-verify.js) asserts
 * the PRE-eaf29dc latch rule plus "exactly one stop", and fails 9 checks with
 * exit 1 against the current src/meetingDetect.js. This version was produced by
 * re-deriving the affected fixtures and expectations against the shipped rule
 * (>= three Active ticks before the latch, the first stop at the stopAfterSec
 * threshold, every stop carrying the meeting-app-quiet reason), with the
 * arithmetic written out in a comment at each changed check.
 *
 * WHY IT IS NOT IN THE RUN: editing assertions until a suite is green is precisely
 * the failure mode the .stale.js files exist to expose, so a re-derivation is a
 * CONTRACT DECISION and must be reviewed against the original before it re-enters
 * the safety net. Compare it with test/p2-5-verify.stale.js check by check.
 *
 * MEASURED against the current src/meetingDetect.js: exits 0 (all checks pass).
 * HOW TO RUN IT MANUALLY:   node test/p2-5-verify.rederived.js
 * TO PUT IT BACK IN THE RUN: rename it to test/p2-5-verify.test.js — run.js
 * appends every other test/*.test.js it finds at run time.
 * ========================================================================== */
const md = require("../src/meetingDetect.js");
const TICK = 8000;
const R = md.DEFAULT_RULE;
let fails = 0;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
  if (!cond) fails++;
};
const fresh = () => ({ activeSince: null, inactiveSince: null, sawWatchedApp: false });
function step(state, sessions, recording, now, rule = R) {
  return md.evaluate(state, { sessions, recording, now, rule });
}
function drive(state, sessionsFn, recordingFn, ticks, rule = R) {
  let s = state, acts = [];
  for (let i = 0; i < ticks; i++) {
    const now = i * TICK + 500;
    const r = step(s, sessionsFn(i), recordingFn(i), now, rule);
    s = r.next; acts.push(...r.actions.map(a => ({ ...a, tSec: Math.round(now / 1000) })));
  }
  return { state: s, acts };
}

// A) the realistic browser-meeting case: a NON-allowlisted app is playing audio
{
  const { state, acts } = drive(fresh(), () => [{ state: "Active", name: "chrome.exe" }], () => true, 80);
  check("A non-allowlisted app (chrome.exe) active 640 s -> no stop", acts.length === 0, `actions=${acts.length}`);
  check("A latch stays false", state.sawWatchedApp === false);
}
// A2) other common non-allowlisted apps
for (const exe of ["msedge.exe", "wemeetapp.exe", "feishu.exe", "DingTalk.exe", "Skype.exe", "QQ.exe"]) {
  const { acts } = drive(fresh(), () => [{ state: "Active", name: exe }], () => true, 80);
  check(`A2 ${exe} -> no stop`, acts.length === 0, `actions=${acts.length}`);
}
// B) a watched app whose session is INACTIVE must not latch
{
  const { state, acts } = drive(fresh(), () => [{ state: "Inactive", name: "Teams.exe" }], () => true, 80);
  check("B Inactive Teams -> no latch, no stop", acts.length === 0 && state.sawWatchedApp === false);
}
// C) the real call-ending case still works
/* The rule RE-ARMS while the recording continues: it clears inactiveSince when it
 * emits a stop, the next tick sets it again (no app is active), and ~stopAfterSec
 * later a second stop is emitted. That is harmless in production because the caller
 * stops the recording on the FIRST one, so isRecording() goes false and the latch is
 * cleared — and the assertion "exactly one" was therefore never an invariant of this
 * rule, only of a caller that acts on it. What matters here is when the first stop
 * lands and that every stop carries the right reason. */
{
  const { acts } = drive(fresh(), (i) => (i < 4 ? [{ state: "Active", name: "ms-teams.exe" }] : []), () => true, 40);
  const stops = acts.filter(a => a.type === "stop");
  check("C real call ending -> a stop fires, the first at the stopAfterSec threshold",
    stops.length >= 1 && stops[0].tSec === 129, JSON.stringify(stops));
  check("C reason is meeting-app-quiet", stops[0] && stops.every(a => a.reason === "meeting-app-quiet"));
}
// D) case-insensitivity of the allowlist
// The latch now requires startAfterSec (15 s) of CONTINUOUS activity before it is
// earned — a single Active observation no longer latches, because that is exactly how
// a chat app's notification blip used to fake a meeting (see meetingDetect.js and
// BACKLOG §12.7). TICK is 8 s, so two ticks give only 8 s of coverage and cannot
// latch; three give 16 s and can.
{
  const { state } = drive(fresh(), () => [{ state: "Active", name: "TEAMS.EXE" }], () => true, 3);
  check("D uppercase TEAMS.EXE latches", state.sawWatchedApp === true);
}
// E) every allowlisted app latches and can stop. Same 15 s requirement: hold the app
// Active for 3 ticks, then let it go quiet.
for (const exe of R.apps) {
  const { acts } = drive(fresh(), (i) => (i < 3 ? [{ state: "Active", name: exe }] : []), () => true, 40);
  check(`E ${exe} -> stop fires`, acts.some(a => a.type === "stop"));
}
// F) 40 minutes of a manual recording with nothing at all -> still no stop
{
  const { acts } = drive(fresh(), () => [], () => true, 300);
  check("F manual recording, 40 min, empty sessions -> no stop", acts.length === 0, `actions=${acts.length}`);
}
// G) autoStop disabled explicitly
{
  const rule = md.normalizeRule(Object.assign({}, R, { autoStop: false }));
  const { acts } = drive(fresh(), (i) => (i < 2 ? [{ state: "Active", name: "zoom.exe" }] : []), () => true, 40, rule);
  check("G autoStop:false -> no stop", acts.filter(a => a.type === "stop").length === 0);
}
// H) a watched app seen while NOT recording must not latch
{
  let { state } = drive(fresh(), () => [{ state: "Active", name: "Teams.exe" }], () => false, 3);
  check("H1 not recording -> latch false even with an app active", state.sawWatchedApp === false);
  const r2 = drive(state, () => [], () => true, 80);
  check("H2 then a manual recording with no app -> no stop", r2.acts.length === 0, `actions=${r2.acts.length}`);
}
console.log(fails === 0 ? "\nALL INDEPENDENT CHECKS PASS" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
