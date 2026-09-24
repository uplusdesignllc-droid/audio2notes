"use strict";
/* bootProbe: the startup-timing probe must be INERT unless asked for, and must
 * never be the reason the app fails to start.
 *
 * WHY THIS SUITE EXISTS: the probe is required at the very top of src/main.js —
 * it runs before anything else in the app, so a fault in it breaks startup
 * outright, and a *timing* fault in it corrupts the very measurement it exists
 * to produce. Two properties therefore have to hold and are pinned here:
 *
 *   1. INERT BY DEFAULT. With A2N_BOOT_LOG unset, nothing is buffered and
 *      nothing is written. If a future edit made mark() write unconditionally,
 *      every user would pay disk I/O at startup for a diagnostic they never
 *      asked for.
 *   2. NO STARTUP COST WHEN ON. The probe deliberately avoids requiring
 *      `electron` (see the file header); requiring it here would both add cost
 *      and throw in this harness. Pinned statically below.
 *
 * Plain node, no DOM, exits non-zero on failure.
 *   node test/bootProbe.test.js
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const PROBE_SRC = path.join(ROOT, "src", "bootProbe.js");
const MAIN_SRC = path.join(ROOT, "src", "main.js");

let failures = 0;
function check(name, cond, detail) {
  console.log((cond ? "PASS " : "FAIL ") + name + (cond ? "" : " — " + detail));
  if (!cond) failures++;
}

console.log("[test] bootProbe (startup timing probe inertness)\n");

const source = fs.readFileSync(PROBE_SRC, "utf8");

/* ---- 1. inert by default ------------------------------------------------- */
delete process.env.A2N_BOOT_LOG;
delete require.cache[require.resolve(PROBE_SRC)];
const off = require(PROBE_SRC);

check("1 probe reports itself disabled when A2N_BOOT_LOG is unset", off.enabled === false,
  "enabled must be false without the env var");
check("2 mark() returns undefined and buffers nothing when disabled",
  off.mark("should be ignored") === undefined,
  "mark must be a no-op");
check("3 flush() is safe when disabled", (() => { off.flush(); return true; })(),
  "flush must not throw when disabled");
check("4 measure() still runs the callback when disabled",
  off.measure("ignored", () => 7) === 7,
  "measure must pass the value through even when not logging");
check("5 measure() propagates errors when disabled", (() => {
  try { off.measure("ignored", () => { throw new Error("boom"); }); return false; }
  catch (e) { return e.message === "boom"; }
})(), "a disabled probe must not swallow a real startup error");

/* ---- 2. active mode ------------------------------------------------------ */
process.env.A2N_BOOT_LOG = "1";
delete require.cache[require.resolve(PROBE_SRC)];
const on = require(PROBE_SRC);
check("6 probe reports itself enabled with A2N_BOOT_LOG=1", on.enabled === true, "");
check("7 active mark() returns undefined (never throws)", on.mark("test line") === undefined, "");
check("8 procStart is not after now", on.procStart <= Date.now(),
  "process start must be in the past — it anchors the first measurement");
check("9 procStart reflects process uptime, not module load",
  Date.now() - on.procStart >= 0,
  "a negative elapsed time would mean the clock is being misused");
delete process.env.A2N_BOOT_LOG;

/* ---- 3. static guards on the source ------------------------------------- */
check("10 bootProbe does NOT require electron",
  !/require\(\s*["']electron["']\s*\)/.test(source),
  "requiring electron at startup would add cost and throw in harnesses");
check("11 bootProbe requires only built-ins",
  (() => {
    const reqs = [...source.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]);
    return reqs.every((r) => r === "fs" || r === "path");
  })(),
  "only fs and path may be required — anything else costs startup time");

const mainSource = fs.readFileSync(MAIN_SRC, "utf8");
check("12 main.js requires the probe before the heavy modules",
  mainSource.indexOf('require("./bootProbe")') < mainSource.indexOf('require("./config")'),
  "the probe must load first or the first mark misattributes time");
check("13 main.js marks the ready milestone",
  mainSource.includes('bootProbe.mark("app.whenReady resolved"'),
  "without this mark the Electron-init time is invisible");
check("14 main.js flushes on renderer ready-to-show",
  /ready-to-show[\s\S]{0,400}bootProbe\.flush\(\)/.test(mainSource),
  "an unflushed buffer is lost if the app is killed or crashes before exit");

console.log("");
if (failures) {
  console.log(`[test] bootProbe: ${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("[test] bootProbe: all checks passed");
