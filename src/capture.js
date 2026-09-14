"use strict";
/* Wraps .cap/capture.exe. Sandbox-safe: never uses stdio pipes; all results
 * come back through files (--status / -o). */
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

function exePath() {
  // packaged: <resources>/bin/capture.exe ; dev: <project>/.cap/capture.exe
  if (process.resourcesPath && fs.existsSync(path.join(process.resourcesPath, "bin", "capture.exe"))) {
    return path.join(process.resourcesPath, "bin", "capture.exe");
  }
  return path.join(__dirname, "..", ".cap", "capture.exe");
}

function spawnDetached(args, outFile) {
  return new Promise((resolve, reject) => {
    const child = spawn(exePath(), args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.on("error", reject);
    child.on("close", (code) => {
      let text = "";
      try { text = fs.readFileSync(outFile, "utf8"); } catch { /* ignore */ }
      resolve({ code, text });
    });
  });
}

async function listDevices() {
  const outFile = path.join(os.tmpdir(), `a2n-devices-${process.pid}.txt`);
  try { fs.rmSync(outFile, { force: true }); } catch { /* ignore */ }
  const { text } = await spawnDetached(["list", "-o", outFile], outFile);
  const devices = { system: [], mic: [] };
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^DEV\s+(system|mic)\t([^\t]*)\t(\S+)/);
    if (m) devices[m[1]].push({ name: m[2] || "(unnamed)", id: m[3] });
  }
  return devices;
}

/** Start a capture; returns { child, statusFile, stopFile, wavFile }. */
function startCapture(kind, wavFile, statusFile) {
  fs.rmSync(statusFile, { force: true });
  const stopFile = statusFile.replace(/\.status$/, ".stop");
  fs.rmSync(stopFile, { force: true });
  const child = spawn(exePath(), ["record", kind, wavFile, "--status", statusFile, "--stop", stopFile], {
    stdio: "ignore",
    windowsHide: true,
  });
  return { child, statusFile, stopFile, wavFile, kind };
}

/**
 * Signal a started capture to finalize: ONLY writes the stop file, never waits.
 * requestStop() on every track first, then stopCapture() on each (see
 * main.js's stopRecordingAndProcess) is what keeps the two track tails aligned.
 * Idempotent: writing the file again is harmless, and it never throws, even
 * when rec is not a live capture.
 */
function requestStop(rec) {
  if (!rec || typeof rec.stopFile !== "string") return;
  try { fs.writeFileSync(rec.stopFile, "stop"); } catch { /* ignore */ }
}

function stopCapture(rec) {
  return new Promise((resolve) => {
    if (!rec || !rec.child || rec.child.killed || rec.child.exitCode !== null) return resolve(0);
    // graceful: touch the stop file (idempotent via requestStop), then wait
    // for capture.exe to finalize the wav
    requestStop(rec);
    const timer = setTimeout(() => {
      try { rec.child.kill(); } catch { /* ignore */ }
    }, 4000);
    rec.child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code || 0);
    });
  });
}

/**
 * Which processes are producing audio on the default output right now.
 * Uses `capture.exe sessions`; file-based output, so it is sandbox-safe.
 * @returns {Promise<Array<{pid:number,state:string,name:string}>>}
 */
async function listSessions() {
  const outFile = path.join(os.tmpdir(), `a2n-sessions-${process.pid}.txt`);
  try { fs.rmSync(outFile, { force: true }); } catch { /* ignore */ }
  let text = "";
  try {
    const r = await spawnDetached(["sessions", "-o", outFile], outFile);
    text = r.text || "";
  } catch {
    return [];
  }
  const sessions = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^SESSION\s+pid=(\d+)\s+state=(\w+)\s+name=(\S+)/);
    if (m) sessions.push({ pid: Number(m[1]), state: m[2], name: m[3] });
  }
  return sessions;
}

module.exports = { exePath, listDevices, listSessions, startCapture, requestStop, stopCapture };
