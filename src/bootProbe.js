"use strict";

/* ---------------------------------------------------------------------------
 * Boot-time probe — measures how long the app takes to reach each startup
 * milestone, to separate "Windows spent 8 s verifying the unsigned binary"
 * from "Electron's GPU process took 8 s to initialise".
 *
 * WHY THIS FILE IS SO DEFENSIVE:
 * The thing being measured is *startup*. Every operation here — requiring a
 * module, reading the clock, touching the filesystem — costs time that would
 * otherwise be attributed to the app. So this module:
 *   - requires only `fs` and `path` (both built-ins, already loaded by main),
 *   - does NO work at require time except reading one env var and Date.now(),
 *   - never throws: a probe that crashes the app it is measuring is worse than
 *     no probe. Every entry point is wrapped.
 *   - writes once, at the end, and appends thereafter.
 *
 * INERT BY DEFAULT: with A2N_BOOT_LOG unset, `mark()` is a no-op that costs one
 * boolean test. The app behaves exactly as before.
 *
 * HOW TO READ THE OUTPUT (this is the whole point):
 *   The FIRST line is the elapsed time since the OS created this process, i.e.
 *   time that elapsed BEFORE any of our code ran — Electron/Chromium loading,
 *   DLL resolution, Defender/SmartScreen inspection of the exe. If that number
 *   is large (multi-second), the delay is OUTSIDE the app and no amount of
 *   app-code optimisation will help. If it is small and a later gap is large,
 *   the delay is inside the startup path we can actually see.
 * ------------------------------------------------------------------------- */

const fs = require("fs");
const path = require("path");

const ENABLED = process.env.A2N_BOOT_LOG === "1";

/* T0 = the process's own start time, which is EARLIER than this module loaded.
 * process.uptime() is seconds since process start; using it means the first
 * mark measures the true pre-app-code cost rather than just our own require. */
const T0 = Date.now();
const PROC_START = T0 - Math.round(process.uptime() * 1000);

const lines = [];
let logPath = null;
let lastError = null;

function resolveLogPath() {
  if (logPath) return logPath;
  try {
    // app.getPath("userData") is the documented location, but requiring
    // `electron` here would add startup cost and can throw in harnesses, so the
    // directory name is spelled out. Keep in sync with package.json "name".
    const base = process.env.APPDATA || process.env.HOME || process.cwd();
    const dir = path.join(base, "audio-to-notes");
    fs.mkdirSync(dir, { recursive: true });
    logPath = path.join(dir, "boot.log");
  } catch (err) {
    lastError = `mkdir failed: ${err && err.code}`;
    logPath = null;
  }
  return logPath;
}

/* Fallback target, used only if the real one is unwritable. $DSH-style sandboxes
 * deny creating NEW files under %APPDATA%; the shipped app runs unsandboxed and
 * will not hit this, but a silent probe is a useless probe, so the failure is
 * both reported on stderr AND retried next to the app so the data is not lost. */
function fallbackPath() {
  try {
    return path.join(__dirname, "..", "boot.log");
  } catch {
    return null;
  }
}

function stamp() {
  // ISO with milliseconds, offset from process start in ms — the readable part.
  return new Date().toISOString();
}

/**
 * Record a milestone. `label` is free text; `detail` is optional extra info.
 * Never throws, never blocks meaningfully.
 */
function mark(label, detail) {
  if (!ENABLED) return;
  try {
    const now = Date.now();
    const sinceProc = now - PROC_START;
    const sinceLoad = now - T0;
    const suffix = detail === undefined || detail === null ? "" : ` | ${detail}`;
    lines.push(
      `${stamp()} | sinceProcessStart=${sinceProc}ms | sinceProbeLoad=${sinceLoad}ms | ${label}${suffix}`
    );
  } catch {
    /* a probe must never break the app */
  }
  return undefined;
}

/** Flush everything buffered so far to disk. Safe to call repeatedly. */
function flush() {
  if (!ENABLED || lines.length === 0) return;
  const payload = lines.join("\n") + "\n";

  /* Try the documented location, then the fallback. A probe that silently
   * writes nothing is the failure mode this whole file exists to avoid, so a
   * total failure is announced on stderr rather than swallowed. */
  const targets = [resolveLogPath(), fallbackPath()].filter(Boolean);
  for (const target of targets) {
    try {
      fs.appendFileSync(target, payload);
      if (target !== logPath) {
        process.stderr.write(`[bootProbe] ${logPath || "(no path)"} unwritable; wrote to ${target}\n`);
      }
      lines.length = 0;
      return;
    } catch (err) {
      lastError = `${target}: ${err && err.code}`;
    }
  }
  process.stderr.write(`[bootProbe] could not write boot log (${lastError}); ${lines.length} line(s) buffered\n`);
}

/**
 * Convenience: measure a synchronous block and mark it. Returns whatever fn()
 * returns, and re-throws its error after recording the failure — swallowing
 * errors here would hide real startup faults.
 */
function measure(label, fn, detail) {
  if (!ENABLED) return fn();
  const t = Date.now();
  try {
    const out = fn();
    mark(label, `${detail ? detail + " | " : ""}took=${Date.now() - t}ms`);
    return out;
  } catch (err) {
    mark(`${label} FAILED`, `${detail ? detail + " | " : ""}took=${Date.now() - t}ms | ${err && err.message}`);
    throw err;
  }
}

module.exports = { enabled: ENABLED, mark, flush, measure, procStart: PROC_START, lastError: () => lastError };
