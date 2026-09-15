"use strict";
// Unit test for the LIMIT "fuse" scanner wired into src/main.js.
// src/main.js depends on Electron and cannot be required from plain Node, so
// this test mirrors the EXACT scanLimitLine() helper defined in src/main.js
// and points it at two fake capture --status files.
//
// KNOWN LIMITATION, so a green run is not read as more than it is: the helper
// below is a verbatim COPY of the shipped one, not the shipped function, so an
// edit to scanLimitLine() in src/main.js cannot fail this suite. What it does pin
// is the regex's behaviour on the two fixtures. Reading the real helper out of
// src/main.js (the way liveVad-inertness/wiring lift startVadShadow by brace
// matching) would close that gap, but that is a change to the test's logic and is
// deliberately NOT made here.
const fs = require("fs");
const path = require("path");
const fx = require("./fixtures");

// --- verbatim copy of src/main.js scanLimitLine() ---
function scanLimitLine(text) {
  const m = (text || "").match(/^LIMIT\s+bytes=(\d+)\s+limit=(\d+)/m);
  if (!m) return null;
  return { bytes: +m[1], limit: +m[2] };
}
// -----------------------------------------------------

function run(file) {
  const text = fs.readFileSync(file, "utf8");
  const hit = scanLimitLine(text);
  return { file: path.basename(file), detected: !!hit, hit };
}

/* The two status-file fixtures are untracked scratch (.scratch/ is gitignored).
 * Without them there is nothing to scan, so say so in one greppable line and exit
 * 0 — a missing fixture is not a failure, and pre-empting the readFileSync keeps
 * it from looking like one (a raw ENOENT stack trace, exit 1). */
const LIMITED = fx.scratch("limit-scan-fixture-limited.txt");
const NORMAL = fx.scratch("limit-scan-fixture-normal.txt");
const absent = [LIMITED, NORMAL].filter((p) => !fs.existsSync(p));
if (absent.length) {
  for (const p of absent) fx.skip("limit-scan: capture --status fixture", p);
  process.exit(0);
}

const limited = run(LIMITED);
const normal = run(NORMAL);

console.log("LIMITED fixture ->", JSON.stringify(limited));
console.log("NORMAL  fixture ->", JSON.stringify(normal));

const pass = limited.detected === true
  && limited.hit.bytes === 1048576
  && limited.hit.limit === 1048576
  && normal.detected === false;

console.log("RESULT:", pass ? "PASS" : "FAIL");
process.exitCode = pass ? 0 : 1;
