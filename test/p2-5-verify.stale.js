/* ============================================================================
 * STALE SUITE — TRACKED FOR THE RECORD, NOT RUN BY 'npm test'.
 * run.js lists it under "NOT RUN — stale suite, asserts a superseded contract".
 *
 * WHAT IT ASSERTS: the PRE-eaf29dc latch rule (any single Active tick latches) and
 * that the stop fires EXACTLY ONCE ("C real call ending -> exactly one stop").
 *
 * WHY THAT IS NO LONGER THE CONTRACT: commit eaf29dc ("meetingDetect: a
 * notification sound must not latch the auto-stop", 2026-09-14 10:11 -0400)
 * changed two things in src/meetingDetect.js:
 *   - the latch needs CONTINUOUS activity before it is earned —
 *     src/meetingDetect.js:78
 *         } else if (s.activeSince != null && now - s.activeSince >= rule.startAfterSec * 1000) {
 *     with startAfterSec defaulting to 15 s (src/meetingDetect.js:29). On this
 *     suite's 8 s tick grid a latch needs three ticks (~16 s); the two ticks
 *     checks D and E give (8 s) cannot earn it.
 *   - the stop RE-ARMS (next.inactiveSince = now after emitting it), so a stop is
 *     emitted again every stopAfterSec while the recording continues. "Exactly
 *     one" was never a property of this rule, only of a caller that acts on the
 *     first stop — its own commit message calls the repeats "the pre-existing
 *     re-arm, which cannot repeat in the app because the first stop ends the
 *     recording".
 *
 * MEASURED against the CURRENT src/meetingDetect.js: it does NOT pass —
 *
 *     $ node test/p2-5-verify.stale.js
 *     FAIL  C real call ending -> exactly one stop  [{"type":"stop","reason":"meeting-app-quiet","tSec":129},{"type":"stop","reason":"meeting-app-quiet","tSec":225}]
 *     FAIL  D uppercase TEAMS.EXE latches
 *     FAIL  E ms-teams.exe -> stop fires
 *     FAIL  E teams.exe -> stop fires
 *     FAIL  E zoom.exe -> stop fires
 *     FAIL  E webexmta.exe -> stop fires
 *     FAIL  E CptHost.exe -> stop fires
 *     FAIL  E slack.exe -> stop fires
 *     FAIL  E Discord.exe -> stop fires
 *     9 CHECK(S) FAILED
 *     exit=1
 *
 * HOW TO RUN IT MANUALLY:   node test/p2-5-verify.stale.js   (expected: exit 1)
 *
 * DO NOT "FIX" IT BY CHANGING src/ — nothing under src/ may be edited to satisfy
 * a stale test. The only legitimate fix is to RE-DERIVE what the current contract
 * should assert (>= three Active ticks before the latch, the FIRST stop at the
 * stopAfterSec threshold, every stop carrying the meeting-app-quiet reason, and
 * no claim of "exactly one"). Such a re-derivation exists as
 * test/p2-5-verify.rederived.js; it is kept out of the run as well until whoever
 * owns the meetingDetect contract accepts it.
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
{
  const { acts } = drive(fresh(), (i) => (i < 4 ? [{ state: "Active", name: "ms-teams.exe" }] : []), () => true, 40);
  const stops = acts.filter(a => a.type === "stop");
  check("C real call ending -> exactly one stop", stops.length === 1, JSON.stringify(stops));
  check("C reason is meeting-app-quiet", stops[0] && stops[0].reason === "meeting-app-quiet");
}
// D) case-insensitivity of the allowlist
{
  const { state } = drive(fresh(), () => [{ state: "Active", name: "TEAMS.EXE" }], () => true, 2);
  check("D uppercase TEAMS.EXE latches", state.sawWatchedApp === true);
}
// E) every allowlisted app latches and can stop
for (const exe of R.apps) {
  const { acts } = drive(fresh(), (i) => (i < 2 ? [{ state: "Active", name: exe }] : []), () => true, 40);
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
