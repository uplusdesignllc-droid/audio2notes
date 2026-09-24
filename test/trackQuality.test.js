"use strict";
/* trackQuality: the rules that decide whether a track recorded anything, and which
 * roster names may be offered for a speaker.
 *
 * WHY THIS SUITE EXISTS: the silent-microphone warning is a claim the app makes about
 * the user's own hardware. If it is too eager it cries wolf on every pause; if it is
 * too shy it stays silent through a meeting that recorded nothing (which happened:
 * a 10-minute meeting with a 0.7 %-active mic track). The rule is therefore kept pure,
 * in renderer/trackQuality.js, and pinned here from both sides.
 *
 * Plain node, no DOM, exits non-zero on failure.
 *   node test/trackQuality.test.js
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const TQ = require(path.join(ROOT, "renderer", "trackQuality.js"));

let failures = 0;
function check(name, cond, detail) {
  console.log((cond ? "PASS " : "FAIL ") + name + (cond ? "" : " — " + detail));
  if (!cond) failures++;
}

console.log("[test] trackQuality (silent-track detection + roster picking)\n");

/* ---- isSilentTrack ------------------------------------------------------- */
check("1 real audio is NOT silent", TQ.isSilentTrack({ peakDbfs: -1.1, activePercent: 49.3 }) === false);
check("2 a quiet but real recording is NOT silent",
  TQ.isSilentTrack({ peakDbfs: -33.4, activePercent: 12 }) === false,
  "a quiet room must not be called empty");
check("3 the observed failure IS silent (peak -33 dB, 0.7% active)",
  TQ.isSilentTrack({ peakDbfs: -33.4, activePercent: 0.7 }) === true,
  "this is the real 2026-08-26 mic track: quiet peak but almost no samples");
check("4 digital silence IS silent", TQ.isSilentTrack({ peakDbfs: -Infinity, activePercent: 0 }) === true);
check("5 ffmpeg's -91 dBFS floor IS silent", TQ.isSilentTrack({ peakDbfs: -91, activePercent: 0 }) === true);
check("6 exactly at the -90 dBFS boundary IS silent", TQ.isSilentTrack({ peakDbfs: -90, activePercent: 50 }) === true);
check("7 just above the peak boundary is NOT silent",
  TQ.isSilentTrack({ peakDbfs: -89.9, activePercent: 50 }) === false);
check("8 exactly 1% active is NOT silent (boundary is exclusive)",
  TQ.isSilentTrack({ peakDbfs: -20, activePercent: 1 }) === false, "1% must not trip the rule");
check("9 just under 1% active IS silent", TQ.isSilentTrack({ peakDbfs: -20, activePercent: 0.9 }) === true);
check("10 no numbers at all -> NOT silent (never cry wolf)",
  TQ.isSilentTrack({ track: "mic.wav" }) === false);
check("11 non-object input is NOT silent",
  TQ.isSilentTrack(null) === false && TQ.isSilentTrack(undefined) === false && TQ.isSilentTrack("mic.wav") === false);
check("12 only one usable number still works",
  TQ.isSilentTrack({ peakDbfs: -Infinity }) === true && TQ.isSilentTrack({ activePercent: 0.2 }) === true);

/* ---- micLooksDead (live watchdog) --------------------------------------- */
check("13 a pause shorter than the window does not fire",
  TQ.micLooksDead(5, 0) === false, "5 samples < 10 s window");
check("14 the full window with no signal fires", TQ.micLooksDead(10, 0) === true);
check("15 the full window WITH one loud sample does not fire",
  TQ.micLooksDead(10, 1) === false, "one sound is enough to be 'not dead'");
check("16 a long window with signal does not fire", TQ.micLooksDead(600, 400) === false);
check("17 a long window with no signal fires", TQ.micLooksDead(600, 0) === true);
check("18 malformed input does not fire",
  TQ.micLooksDead(undefined, undefined) === false && TQ.micLooksDead(null, 0) === false);
check("19 the floor is the same 0-100 value the recorder uses", TQ.MIC_LEVEL_FLOOR === 8,
  "kept in step with lifecycle.autoStop.levelThreshold's default");

/* ---- pickableNames ------------------------------------------------------- */
const roster = ["Alice", "Bob", "Carol"];
check("20 every roster name is offered when nothing is assigned",
  JSON.stringify(TQ.pickableNames(roster, [], "spk1")) === JSON.stringify(roster));
check("21 a name taken by ANOTHER speaker is not offered",
  JSON.stringify(TQ.pickableNames(roster, [{ id: "spk2", name: "Bob" }], "spk1")) === JSON.stringify(["Alice", "Carol"]),
  "one person must not be assignable to two voices");
check("22 a speaker's OWN name is still offered (so it shows as selected)",
  TQ.pickableNames(roster, [{ id: "spk1", name: "Carol" }, { id: "spk2", name: "Bob" }], "spk1").includes("Carol") === true);
check("23 matching is case- and whitespace-insensitive",
  TQ.pickableNames(roster, [{ id: "spk2", name: "  bob " }], "spk1").includes("Bob") === false,
  "'  bob ' must still exclude 'Bob'");
check("24 blanks and non-strings are dropped",
  JSON.stringify(TQ.pickableNames(["Alice", "", "   ", null, 42, "Bob"], [], "spk1")) === JSON.stringify(["Alice", "Bob"]));
check("25 duplicates collapse", JSON.stringify(TQ.pickableNames(["A", "A", "B"], [], "spk1")) === JSON.stringify(["A", "B"]));
check("26 an empty roster yields nothing", TQ.pickableNames([], [], "spk1").length === 0);
check("27 malformed speakers list does not throw",
  TQ.pickableNames(roster, null, "spk1").length === 3 && TQ.pickableNames(roster, [null, {}], "spk1").length === 3);

/* ---- wiring: the renderer must actually load and use it ------------------ */
const html = fs.readFileSync(path.join(ROOT, "renderer", "index.html"), "utf8");
const app = fs.readFileSync(path.join(ROOT, "renderer", "app.js"), "utf8");
check("28 index.html loads trackQuality.js BEFORE app.js", (() => {
  const a = html.indexOf("trackQuality.js"), b = html.indexOf("app.js");
  return a > -1 && b > -1 && a < b;
})(), "otherwise window.trackQuality is undefined when app.js runs");
check("29 app.js uses the tested helpers",
  app.includes("TQ.isSilentTrack(") && app.includes("TQ.pickableNames(") && app.includes("TQ.micLooksDead("),
  "the rules must live in one place, not be re-implemented inline");
check("30 the older inline threshold copy is gone",
  !/active\s*<\s*1\b/.test(app) && !app.includes("takenElsewhere"),
  "a second copy of the rule would drift from the tested one");
check("31 the watchdog is stopped when recording stops",
  /recording = false;\s*\n\s*stopMicWatchdog\(\)/.test(app),
  "a watchdog that outlives the recording would warn about nothing");
check("32 the watchdog commits its input listener safely",
  app.includes('input.addEventListener("blur", () => commit())'),
  "passing commit directly would feed the event object in as the name");

/* ---- the file must also work as a plain browser script ------------------- */
const sandbox = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(ROOT, "renderer", "trackQuality.js"), "utf8"), sandbox);
check("33 it defines window.trackQuality for the renderer",
  sandbox.window.trackQuality && typeof sandbox.window.trackQuality.isSilentTrack === "function");
check("34 the browser copy and the require()-able copy agree",
  sandbox.window.trackQuality.isSilentTrack({ peakDbfs: -Infinity, activePercent: 0 }) === true &&
  sandbox.window.trackQuality.MIC_LEVEL_FLOOR === TQ.MIC_LEVEL_FLOOR);

console.log(`\n${failures === 0 ? "all checks passed" : failures + " CHECK(S) FAILED"}`);
process.exitCode = failures ? 1 : 0;
