"use strict";
/* Plain-node test runner for the tracked suites in test/ — `npm test`.
 *
 * WHY A HAND-ROLLED RUNNER: the repo has no test framework and the task forbids
 * adding one, but the suites already exist and each already exits non-zero on
 * failure (that is the contract they were written to). So the runner only has to
 * launch them one at a time and aggregate exit codes.
 *
 * Each suite runs in its OWN child process: an uncaught throw, a native-module
 * crash or an `process.exit()` inside one suite must not be able to take the rest
 * of the safety net down with it.
 *
 * AUTO-DISCOVERY: the KNOWN list below is the explicit order (slowest and
 * data-heaviest last, so a typo in a fast unit suite is reported in the first
 * second rather than after a two-minute e2e); every other `test/*.test.js` on
 * disk is appended at RUN TIME, so dropping a new file into test/ is enough to
 * get it run — there is no list to remember to update.
 *
 * Usage:
 *   npm test
 *   A2N_FIXTURE_ROOT=<dir> npm test      # data-dependent suites must SKIP, exit 0
 *   A2N_TEST_TIMEOUT_MS=... npm test     # per-suite kill timeout
 */
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { workRoot } = require("./fixtures");
const TEST_DIR = __dirname;
const ROOT = path.join(TEST_DIR, "..");

/* Explicit run order. The three at the end are the slow / data-heavy ones
 * (pollLevels drives real 300 ms timers and two 16 s watchdog ticks; liveVad-e2e
 * feeds ~85 s of real audio through the native VAD four times). */
const KNOWN = [
  // fast unit suites (no I/O beyond requiring src/)
  "activityTracker.test.js",
  "lifecyclePolicy.test.js",
  "liveVad.test.js",
  "liveVad-reader.test.js",
  "p6-participants.test.js",
  "p6-jobqueue.test.js",
  /* p2-5-test.js / p2-5-verify.js are deliberately NOT in this list and NOT named
   * *.test.js any more: they assert a SUPERSEDED meetingDetect contract and fail
   * (exit 1) against the current src/meetingDetect.js. They are tracked as
   * p2-5.stale.js / p2-5-verify.stale.js and reported under NOT_RUN below — the
   * hole in the safety net is made visible rather than papered over. */
  "limit-scan.test.js",
  // static source checks
  "check-ids.test.js",
  "check-a2n-surface.test.js",
  "resolve-ids.test.js",
  // source-text / integration suites (read the live src/main.js)
  "liveVad-inertness.test.js",
  "liveVad-wiring.test.js",
  "test1-normal.test.js",
  // slow / data-dependent
  "pollLevels.harness.js",
  "liveVad-e2e.js",
];

/** KNOWN plus every other *.test.js actually present — read from disk at run
 *  time, so a suite added by someone else is picked up without editing this. */
function suites() {
  const onDisk = fs.readdirSync(TEST_DIR).filter((f) => f.endsWith(".test.js"));
  const extra = onDisk.filter((f) => !KNOWN.includes(f)).sort();
  const missing = KNOWN.filter((f) => !onDisk.includes(f) && f !== "pollLevels.harness.js" && f !== "liveVad-e2e.js");
  return { list: KNOWN.concat(extra), extra, missing };
}

/** A suite that hangs would otherwise hang the whole run, so each child gets a
 *  generous wall-clock cap. 15 min is a GUESS with margin: the slowest suite
 *  measured here is liveVad-e2e at ~50 s and pollLevels at ~40 s, both of which
 *  are bounded by sleeps and native-VAD throughput, not by machine speed alone. */
const TIMEOUT_MS = Number(process.env.A2N_TEST_TIMEOUT_MS || 900_000);

/* One work root per RUN, handed to the suites through A2N_TEST_WORK_ROOT (see
 * fixtures.workDir). Suites share state through their work areas — pollLevels'
 * status file, test1-normal's WAV/opus pair — so a second concurrent `npm test`
 * could otherwise fail the first one, and its own per-suite logs would land on top
 * of the first run's (measured: a mid-flight second run truncated a log and the
 * first run read back a mix of both). Logs live under the same per-run root. */
const RUN_WORK = path.join(workRoot(), `run-${process.pid}`);
const LOG_DIR = path.join(RUN_WORK, "logs");
fs.mkdirSync(LOG_DIR, { recursive: true });

function runSuite(file) {
  const started = Date.now();
  const log = path.join(LOG_DIR, file.replace(/[^\w.-]/g, "_") + ".log");
  /* Output goes to a FILE descriptor rather than a pipe: the stdout/stderr of a
   * child captured through a pipe is exactly the thing that is unavailable in the
   * confined sandbox this runs in, and a file also keeps the output readable
   * afterwards. It is printed below either way. */
  const fd = fs.openSync(log, "w");
  let res;
  try {
    res = spawnSync(process.execPath, [path.join(TEST_DIR, file)], {
      cwd: ROOT,           // suites use repo-relative paths next to their __dirname ones
      stdio: ["ignore", fd, fd],
      timeout: TIMEOUT_MS,
      /* A2N_FIXTURE_ROOT passes straight through; A2N_TEST_WORK_ROOT is pinned to
       * THIS run's root so concurrent runs cannot share a status file or a log. */
      env: Object.assign({}, process.env, { A2N_TEST_WORK_ROOT: RUN_WORK }),
    });
  } finally {
    fs.closeSync(fd);
  }
  const out = fs.readFileSync(log, "utf8").replace(/\s+$/, "");
  const ms = Date.now() - started;
  const timedOut = res.error && res.error.code === "ETIMEDOUT";
  const code = timedOut ? null : res.status;
  /* A suite is judged by its exit code alone. The line scan below is only for
   * the SUMMARY: a suite that bails out early prints `SKIP ...` and exits 0, and
   * calling that "passed" would hide the fact that it measured nothing. */
  const skips = (out.match(/^SKIP\b/gm) || []).length;
  const passes = (out.match(/^(?:PASS|OK)\b/gm) || []).length +
    (out.match(/^(?:all checks passed|ALL PASS|ALL INDEPENDENT CHECKS PASS)/gm) || []).length;
  const skipped = code === 0 && skips > 0 && passes === 0;
  return { file, code, ms, out, skips, skipped, timedOut, signal: res.signal };
}

/** Suites that are TRACKED in test/ but deliberately NOT run, with the reason.
 *
 *  These are not in KNOWN and their names do not end in `.test.js`, so neither the
 *  explicit list nor the auto-discovery glob can pick them up — renaming is the
 *  only reliable switch, because "out of the run" must not depend on remembering a
 *  list. Listing them here is on purpose: a safety net with a hole in it has to
 *  SHOW the hole. These lines never affect the exit code.
 *
 *  The .stale.js pair asserts a contract that commit eaf29dc replaced (see their
 *  file headers for the exact FAIL lines): they fail, so they must not run, and
 *  they must not be "fixed" by editing src/ either. The .rederived.js pair is the
 *  same two scenarios re-derived for the current contract (it passes) and stays out
 *  until whoever owns meetingDetect accepts that re-derivation, because editing
 *  assertions until they are green is exactly what the .stale.js files record. */
const NOT_RUN = [
  {
    why: "stale suite, asserts a superseded contract (see file header)",
    files: ["p2-5.stale.js", "p2-5-verify.stale.js"],
  },
  {
    why: "re-derived for the current contract, pending owner review (see file header)",
    files: ["p2-5.rederived.js", "p2-5-verify.rederived.js"],
  },
];

function reportNotRun() {
  for (const group of NOT_RUN) {
    const present = group.files.filter((f) => fs.existsSync(path.join(TEST_DIR, f)));
    if (!present.length) {
      console.log(`[test] WARNING: NOT-RUN file(s) deleted or renamed away: ${group.files.join(", ")}`);
      continue;
    }
    console.log(`[test] NOT RUN — ${group.why}: ${present.join(", ")}`);
    const gone = group.files.filter((f) => !present.includes(f));
    if (gone.length) console.log(`[test] WARNING: NOT-RUN file(s) missing: ${gone.join(", ")}`);
  }
}

function main() {
  const { list, extra, missing } = suites();
  if (missing.length) {
    /* Loud, but not fatal-by-itself: an explicit KNOWN entry deleting itself is a
     * real regression in the safety net and must not pass unnoticed. */
    console.log(`[test] WARNING: KNOWN suites not found on disk: ${missing.join(", ")}`);
  }
  console.log(`[test] node ${process.version}, cwd ${ROOT}`);
  if (process.env.A2N_FIXTURE_ROOT) {
    console.log(`[test] A2N_FIXTURE_ROOT=${process.env.A2N_FIXTURE_ROOT} (data-dependent suites must SKIP)`);
  } else {
    console.log(`[test] fixture root = repo root (A2N_FIXTURE_ROOT unset)`);
  }
  console.log(`[test] ${list.length} suite(s)${extra.length ? " (" + extra.length + " auto-discovered: " + extra.join(", ") + ")" : ""}`);
  reportNotRun();

  const results = [];
  for (const file of list) {
    console.log("");
    console.log("=".repeat(72));
    console.log(`[test] ${file}`);
    console.log("=".repeat(72));
    const r = runSuite(file);
    if (r.out) console.log(r.out);
    results.push(r);
  }

  const failed = results.filter((r) => r.code !== 0);
  const skipped = results.filter((r) => r.skipped);

  console.log("");
  console.log("=".repeat(72));
  console.log("[test] summary");
  console.log("=".repeat(72));
  for (const r of results) {
    const status = r.code !== 0
      ? (r.timedOut ? "TIMEOUT" : "FAIL")
      : (r.skipped ? "SKIP" : "PASS");
    const note = r.code === 0 && r.skips > 0 && !r.skipped ? ` (${r.skips} SKIP line(s))` : "";
    console.log(`  ${status.padEnd(7)} ${(r.ms / 1000).toFixed(1).padStart(7)} s  ${r.file}${note}` +
      (r.code !== 0 ? `  exit=${r.code}${r.signal ? " signal=" + r.signal : ""}` : ""));
  }
  console.log("");
  console.log(`[test] ${results.length} suites: ${results.length - failed.length - skipped.length} passed, ` +
    `${skipped.length} skipped, ${failed.length} failed`);
  /* Repeated here on purpose: the summary is the part a reader skims, and a hole
   * in the safety net must be impossible to skim past. */
  reportNotRun();
  if (failed.length) {
    console.log(`[test] FAILED: ${failed.map((r) => r.file).join(", ")}`);
    console.log(`[test] (full output of each suite is kept in ${LOG_DIR})`);
  }
  process.exit(failed.length ? 1 : 0);
}

main();
