"use strict";
/* Shared fixture plumbing for the tracked suites in test/.
 *
 * WHY THIS FILE EXISTS: `meeting notes/` (real, private recordings), the decoded
 * PCM under `.scratch/vad/`, the Silero model copy under `.scratch/vad/` and the
 * `.scratch/vad-live/` WAVs are all deliberately NOT in the repo (.gitignore keeps
 * `meeting notes/` private and `.scratch/` regenerable). So on a fresh clone the
 * data-dependent suites have nothing to measure. The rule those suites follow is:
 * print a greppable `SKIP` line naming the missing path and exit 0 — never fail,
 * and never report "all passed" while measuring nothing.
 *
 * The root those fixtures hang off is overridable so that skip path is testable
 * for real:
 *     A2N_FIXTURE_ROOT=<empty dir> npm test
 * must produce SKIP lines and still exit 0.
 *
 * NOTE the contract is deliberately the exact expression the task fixed:
 * a one-argument path.join, defaulting to the repo root. Do not "improve" it —
 * suites and reviewers rely on `<root>/meeting notes` resolving as it always has.
 */
const fs = require("fs");
const path = require("path");

/** The repo root: every tracked suite lives in <root>/test. */
const ROOT = path.join(__dirname, "..");

/** Fixture root: default = the repo root, `A2N_FIXTURE_ROOT=<dir>` moves every
 *  DATA fixture under <dir> instead. Everything untracked goes through this. */
const FIXTURE_ROOT = path.join(process.env.A2N_FIXTURE_ROOT || path.join(__dirname, ".."));

/** `<fixture root>/meeting notes[/...]` — the private meeting store. */
function meetingNotes(...parts) {
  return path.join(FIXTURE_ROOT, "meeting notes", ...parts);
}

/** `<fixture root>/.scratch[/...]` — decoded audio, model copies, capture WAVs.
 *  Use this for the fixtures that really live in .scratch/; do NOT use it for
 *  tracked, repo-owned assets (assets/models/*.onnx are always in the clone). */
function scratch(...parts) {
  return path.join(FIXTURE_ROOT, ".scratch", ...parts);
}

/** True when `p` exists — the guard every data-dependent suite runs before it
 *  measures anything. */
function have(p) {
  return fs.existsSync(p);
}

/** Print the ONE line a degraded suite must print. Greppable on purpose: the
 *  runner and CI both look for a leading `SKIP`, and the path is named so a
 *  reader can see exactly which fixture is missing and where it was looked for.
 *  Never call this and then assert anyway — that is the "0 tests, exit 0"
 *  failure mode this contract exists to prevent. */
function skip(what, p) {
  console.log(`SKIP  ${what}: missing ${p}`);
}

/** A scratch WRITE area for suites that need to create files: never inside the
 *  tracked test/ directory. `.scratch/` is gitignored, so output lands next to
 *  the other regenerable scratch (and is wiped with it).
 *
 *  Deliberately NOT under FIXTURE_ROOT: outputs are not fixtures, and a suite
 *  must not start writing into an A2N_FIXTURE_ROOT the caller only meant to READ
 *  (e.g. a read-only copy of the real meeting store).
 *
 *  `A2N_TEST_WORK_ROOT` overrides the parent directory. test/run.js sets it to a
 *  per-run directory (`<repo>/.scratch/test-work/run-<pid>`) because two suites
 *  share state through their work area — pollLevels' status file, test1-normal's
 *  WAV/opus pair — so two CONCURRENT `npm test` runs could otherwise fail each
 *  other. Measured: a second run of the runner mid-flight truncated a per-suite
 *  log under the first one's feet and its output was read back interleaved.
 *  Running a suite directly keeps the plain `<repo>/.scratch/test-work/<suite>`. */
/** The parent directory the suites' write areas are created in. Exported so
 *  test/run.js derives its per-run root from ONE place instead of repeating the
 *  path. */
function workRoot() {
  const base = process.env.A2N_TEST_WORK_ROOT || path.join(ROOT, ".scratch", "test-work");
  fs.mkdirSync(base, { recursive: true });
  return base;
}

function workDir(name) {
  const d = path.join(workRoot(), name);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

module.exports = { ROOT, FIXTURE_ROOT, meetingNotes, scratch, have, skip, workRoot, workDir };
