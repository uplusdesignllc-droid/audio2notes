// Test 1: normal case — archiveFile on a 20s sine WAV.
// The suite GENERATES its own 20 s input (a local ffmpeg sine, no fixture needed)
// and then deletes it as the thing under test, so its work area must be a
// regenerable, gitignored one: `.scratch/test-work/` rather than the tracked test/.
"use strict";
const fs = require("fs");
const path = require("path");
const fx = require("./fixtures");
const arch = require("../src/audioArchive.js");

const scratch = fx.workDir("test1-normal");
const srcName = "t1-source.wav";
const srcPath = path.join(scratch, srcName);
const outExpect = srcPath.replace(/\.wav$/i, ".opus");
const tmpExpect = outExpect + ".tmp";

(async () => {
  /* IDEMPOTENCE (work-area plumbing; no assertion changes): the input below is
   * regenerated whenever it is missing, and archiveFile DELETES it once archived —
   * so on a second run the regenerated WAV sits next to the .opus the previous run
   * produced, archiveFile correctly REUSES that good archive, and the "reused is
   * present (false for fresh encode)" assertion fails with reused:true. Measured:
   * run 1 exit 0 (`reused: false`), run 2 exit 1 (`reused: true`) on the same
   * directory. This suite exists to exercise the FRESH-ENCODE path, so it starts
   * from a directory with no archive of its own and clears only its own two
   * outputs — the source WAV is not touched (it is what gets regenerated). */
  fs.rmSync(outExpect, { force: true });
  fs.rmSync(tmpExpect, { force: true });

  // Ensure a known-good 20s sine WAV (16 kHz mono) is present.
  if (!fs.existsSync(srcPath)) {
    const { spawn } = require("child_process");
    const ffmpeg = path.join(fx.ROOT, "node_modules", "ffmpeg-static", "ffmpeg.exe");
    await new Promise((res, rej) => {
      const p = spawn(ffmpeg, [
        "-y", "-v", "error",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=20",
        "-ar", "16000", "-ac", "1", srcPath,
      ], { stdio: "ignore", windowsHide: true });
      p.on("error", rej);
      p.on("close", (c) => (c === 0 ? res() : rej(new Error("ffmpeg exit " + c))));
    });
  }
  const before = fs.statSync(srcPath).size;

  let r;
  try {
    r = await arch.archiveFile(srcPath, {});
  } catch (e) {
    console.error("FAIL: archiveFile threw:", e.message);
    process.exit(1);
  }

  const checks = [];
  checks.push(["output exists at FINAL name", fs.existsSync(outExpect)]);
  checks.push(["no .tmp sibling left behind", !fs.existsSync(tmpExpect)]);
  checks.push(["source WAV deleted (keepWav unset)", !fs.existsSync(srcPath)]);
  const expectedKeys = ["from", "to", "before", "after"];
  for (const k of expectedKeys) checks.push([`returned object has key "${k}"`, k in r]);
  checks.push(["reused is present (false for fresh encode)", "reused" in r && r.reused === false]);
  checks.push(["to matches expected final path", r.to === outExpect]);
  checks.push(["before is the source size in bytes", r.before === before]);
  checks.push(["after is the output size in bytes", r.after === fs.statSync(outExpect).size]);
  checks.push(["output > 1 KB", r.after > 1024]);

  // Also probe the durations to show the tolerance in action.
  const outDur = await arch.probeDurationSec(outExpect);
  checks.push(["probe of output returns finite duration", outDur !== null && Number.isFinite(outDur)]);
  if (outDur !== null) {
    const tol = arch.durationTolerance(20);
    checks.push([`duration ${outDur.toFixed(2)}s within ±${tol.toFixed(2)}s of 20s`, Math.abs(outDur - 20) <= tol]);
  }

  let ok = true;
  for (const [label, pass] of checks) {
    console.log((pass ? "PASS  " : "FAIL  ") + label);
    if (!pass) ok = false;
  }
  console.log("---");
  console.log("archiveFile returned:", JSON.stringify(r, null, 2));
  console.log("probed output duration:", outDur, "s");
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error("UNEXPECTED:", e); process.exit(1); });
