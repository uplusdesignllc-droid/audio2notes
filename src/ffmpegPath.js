"use strict";
/* Resolve the ffmpeg binary path.
 *
 * Two things this must get right (both have bitten this project):
 *  1. asar → asar.unpacked: binaries cannot be executed from inside an asar
 *     archive, so the packaged path is rewritten.
 *  2. THE BINARY MUST ACTUALLY EXIST. `require("ffmpeg-static")` only returns a
 *     computed path; with a pnpm layout the package directory can be a junction
 *     into the store, and if the postinstall download never ran (installs use
 *     --ignore-scripts here) the file is simply missing. Verified on 2026-09-11:
 *     the store copy had no ffmpeg.exe and every ffmpeg step failed with ENOENT
 *     while nothing in the UI explained why.
 *
 * So: try the package path, then known fallbacks, and report loudly if none work
 * instead of handing child_process a path that cannot exist. */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");

function candidates() {
  const list = [];
  const add = (p) => {
    if (p && !list.includes(p)) list.push(p);
  };

  try {
    let p = require("ffmpeg-static");
    if (typeof p === "string") {
      if (p.includes("app.asar" + path.sep)) p = p.replace("app.asar" + path.sep, "app.asar.unpacked" + path.sep);
      add(p);
    }
  } catch { /* package missing entirely */ }

  const exe = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  // dedicated safety copy kept by this project (mirrors ffmpeg-static's own binary,
  // so it is a drop-in replacement). This is the fallback that actually survives:
  // the copy inside node_modules/.pnpm has vanished before (installs run with
  // --ignore-scripts, so the postinstall download never happens).
  add(path.join(ROOT, ".tools", "ffmpeg-backup", exe));
  // parked by npm/pnpm when the package layout was replaced
  add(path.join(ROOT, "node_modules", ".ignored", "ffmpeg-static", exe));
  // a previously packaged build ships its own unpacked copy
  add(path.join(ROOT, "dist", "win-unpacked", "resources", "app.asar.unpacked", "node_modules", "ffmpeg-static", exe));
  // packaged app: extraResources
  if (process.resourcesPath) add(path.join(process.resourcesPath, "bin", exe));
  return list;
}

let cached = null;
let lastError = null;

function ffmpegPath() {
  if (cached) return cached;
  const tried = [];
  for (const p of candidates()) {
    tried.push(p);
    try {
      if (fs.statSync(p).size > 1024) {
        cached = p;
        return cached;
      }
    } catch { /* try the next one */ }
  }
  lastError = `找不到可用的 ffmpeg 可执行文件。已尝试：\n  ` + tried.join("\n  ") +
    `\n修复：npm.cmd install ffmpeg-static --ignore-scripts，然后执行 node node_modules/ffmpeg-static/install.js`;
  throw new Error(lastError);
}

/** Non-throwing probe for the UI/diagnostics. */
function ffmpegStatus() {
  try {
    const p = ffmpegPath();
    return { ok: true, path: p, bytes: fs.statSync(p).size };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { ffmpegPath, ffmpegStatus, candidates };
