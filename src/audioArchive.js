"use strict";
/* Audio archiving: replace bulky meeting WAVs with compressed 16 kHz mono audio.
 *
 * 16 kHz mono is exactly Whisper's input format (see transcribe.js:29-37), so
 * re-transcribing an archived meeting loses nothing. Default = Opus 24 kbps
 * mono (~10.8 MB/hour vs ~691 MB/hour for a 48 kHz stereo capture WAV).
 *
 * Safety rule: an original WAV is ONLY deleted after its replacement passed
 * three checks — ffmpeg exit 0, output non-trivial (>1 KB), and a second
 * end-to-end decode pass. Any failure keeps the original and reports why. */

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const ffmpegPath = require("./ffmpegPath").ffmpegPath();

const PRESETS = [
  { id: "opus-16", label: "Opus 16 kbps 单声道（最小）", codec: "libopus", bitrateKbps: 16, ext: "opus" },
  { id: "opus-24", label: "Opus 24 kbps 单声道（推荐）", codec: "libopus", bitrateKbps: 24, ext: "opus" },
  { id: "opus-32", label: "Opus 32 kbps 单声道（更好听）", codec: "libopus", bitrateKbps: 32, ext: "opus" },
  { id: "opus-48", label: "Opus 48 kbps 单声道", codec: "libopus", bitrateKbps: 48, ext: "opus" },
  {
    id: "mp3-96",
    label: "MP3 96 kbps 单声道（兼容老软件）",
    codec: "libmp3lame",
    bitrateKbps: 96,
    ext: "mp3",
    sampleRate: 24000,
  },
];

const DEFAULT_PRESET_ID = "opus-24";

/** Preset for a settings object; never throws. */
function resolvePreset(opts = {}) {
  const codec = (opts && opts.codec) || "libopus";
  const kbps = Number((opts && opts.bitrateKbps) || 24) || 24;
  const exact = PRESETS.find((p) => p.codec === codec && p.bitrateKbps === kbps);
  if (exact) return exact;
  if (codec === "libmp3lame") return { id: `mp3-${kbps}`, label: `MP3 ${kbps} kbps`, codec, bitrateKbps: kbps, ext: "mp3", sampleRate: 24000 };
  if (codec === "libopus") return { id: `opus-${kbps}`, label: `Opus ${kbps} kbps`, codec, bitrateKbps: kbps, ext: "opus" };
  return PRESETS.find((p) => p.id === DEFAULT_PRESET_ID);
}

/** Bytes per hour of audio for a preset (kbps = 1000 bits/s, so ×1000). */
function estimateBytesPerHour(opts) {
  return Math.round((resolvePreset(opts).bitrateKbps * 1000 * 3600) / 8);
}

function runFfmpeg(args) {
  return new Promise((resolve) => {
    const p = spawn(ffmpegPath, args, { stdio: "ignore", windowsHide: true });
    p.on("error", () => resolve(false));
    p.on("close", (code) => resolve(code === 0));
  });
}

function encodeArgs(preset, src, out) {
  const head = ["-y", "-v", "error", "-i", src, "-vn", "-map", "0:a:0"];
  if (preset.codec === "libopus") {
    return [
      ...head,
      "-ar", "16000", "-ac", "1",
      "-c:a", "libopus", "-b:a", `${preset.bitrateKbps}k`,
      "-application", "voip", "-vbr", "on",
      out,
    ];
  }
  return [
    ...head,
    "-ar", String(preset.sampleRate || 24000), "-ac", "1",
    "-c:a", "libmp3lame", "-b:a", `${preset.bitrateKbps}k`,
    out,
  ];
}

/** Full decode pass — proves the container/stream is readable end to end. */
function verifyAudio(file) {
  return runFfmpeg(["-y", "-v", "error", "-i", file, "-f", "null", "-"]);
}

function isWavName(name) {
  return /\.wav$/i.test(name);
}

/** Duration/format of a WAV without decoding it (for size projections). */
function wavInfo(file) {
  let fd = null;
  try {
    const size = fs.statSync(file).size;
    fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(Math.min(65536, size));
    fs.readSync(fd, buf, 0, buf.length, 0);
    let pos = 12;
    let fmt = null;
    let dataSize = null;
    while (pos + 8 <= buf.length) {
      const id = buf.toString("ascii", pos, pos + 4);
      const chunkSize = buf.readUInt32LE(pos + 4);
      if (id === "fmt " && pos + 20 <= buf.length) {
        fmt = {
          channels: buf.readUInt16LE(pos + 10),
          rate: buf.readUInt32LE(pos + 12),
          byteRate: buf.readUInt32LE(pos + 16),
        };
      } else if (id === "data") {
        dataSize = chunkSize;
        break;
      }
      pos += 8 + chunkSize + (chunkSize % 2);
    }
    if (!fmt || !fmt.byteRate) return null;
    const bytes = dataSize != null && dataSize > 0 ? dataSize : size - 44;
    return { durationSec: bytes / fmt.byteRate, rate: fmt.rate, channels: fmt.channels };
  } catch {
    return null;
  } finally {
    if (fd != null) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }
}

/**
 * Compress one WAV. Returns { from, to, before, after }. Throws on failure —
 * in which case the original is always still on disk.
 */
async function archiveFile(srcPath, opts = {}) {
  const preset = resolvePreset(opts);
  const before = fs.statSync(srcPath).size;
  const out = srcPath.replace(/\.wav$/i, "." + preset.ext);

  if (fs.existsSync(out)) {
    const st = fs.statSync(out);
    if (st.size > 1024 && (await verifyAudio(out))) {
      if (!opts.keepWav) fs.rmSync(srcPath, { force: true });
      return { from: srcPath, to: out, before, after: st.size, reused: true };
    }
    fs.rmSync(out, { force: true }); // unusable leftover — re-encode from scratch
  }

  const ok = await runFfmpeg(encodeArgs(preset, srcPath, out));
  if (!ok || !fs.existsSync(out)) {
    try { fs.rmSync(out, { force: true }); } catch { /* ignore */ }
    throw new Error("ffmpeg 编码失败");
  }
  const after = fs.statSync(out).size;
  if (after <= 1024) {
    fs.rmSync(out, { force: true });
    throw new Error(`输出异常（${after} 字节）`);
  }
  if (!(await verifyAudio(out))) {
    fs.rmSync(out, { force: true });
    throw new Error("输出校验失败（无法解码）");
  }
  if (!opts.keepWav) fs.rmSync(srcPath, { force: true });
  return { from: srcPath, to: out, before, after };
}

/**
 * Compress every WAV in one meeting directory.
 * @returns {Promise<{ok:boolean, files:Array, errors:Array, savedBytes:number}>}
 */
async function archiveDir(dir, opts = {}, onProgress) {
  const res = { ok: true, files: [], errors: [], savedBytes: 0 };
  let names;
  try {
    names = fs.readdirSync(dir).filter(isWavName);
  } catch (e) {
    return { ...res, ok: false, errors: [{ file: dir, message: e.message }] };
  }
  let i = 0;
  for (const name of names) {
    i++;
    if (onProgress) onProgress({ file: name, index: i, total: names.length, dir });
    try {
      const r = await archiveFile(path.join(dir, name), opts);
      res.files.push({
        name,
        to: path.basename(r.to),
        before: r.before,
        after: r.after,
        reused: !!r.reused,
      });
      if (!opts.keepWav) res.savedBytes += Math.max(0, r.before - r.after);
    } catch (e) {
      res.ok = false;
      res.errors.push({ file: name, message: e.message });
    }
  }
  return res;
}

/**
 * Encode ANY decodable audio file to the preset format at `outPath`.
 * Unlike archiveFile() this makes no .wav assumption and NEVER deletes the
 * source — used for imported files, where the user's original stays where it is
 * and the meeting folder only keeps a small 16 kHz mono copy.
 * Verifies the result before returning; throws otherwise.
 * @returns {Promise<{out:string, bytes:number, preset:object}>}
 */
async function transcodeTo(srcPath, outPath, opts = {}) {
  const preset = resolvePreset(opts);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const ok = await runFfmpeg(encodeArgs(preset, srcPath, outPath));
  const fail = (msg) => {
    try { fs.rmSync(outPath, { force: true }); } catch { /* ignore */ }
    throw new Error(msg);
  };
  if (!ok || !fs.existsSync(outPath)) fail("ffmpeg 编码失败");
  const bytes = fs.statSync(outPath).size;
  if (bytes <= 1024) fail(`输出异常（${bytes} 字节）`);
  if (!(await verifyAudio(outPath))) fail("输出校验失败（无法解码）");
  return { out: outPath, bytes, preset };
}

function meetingDirs(root) {  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => path.join(root, d.name));
  } catch {
    return [];
  }
}

/**
 * Read-only survey of reclaimable space. No writes, no ffmpeg.
 * @returns {Promise<{dirs:Array, fileCount:number, totalBytes:number,
 *                    totalDurationSec:number, estimatedBytesAfter:number,
 *                    estimatedSavedBytes:number, preset:object}>}
 */
async function scan(root, opts = {}) {
  const preset = resolvePreset(opts);
  const dirs = [];
  let fileCount = 0;
  let totalBytes = 0;
  let totalDurationSec = 0;

  for (const dir of meetingDirs(root)) {
    let names;
    try { names = fs.readdirSync(dir).filter(isWavName); } catch { continue; }
    if (!names.length) continue;

    const files = [];
    let dirBytes = 0;
    let dirDuration = 0;
    for (const name of names) {
      const full = path.join(dir, name);
      let bytes = 0;
      try { bytes = fs.statSync(full).size; } catch { continue; }
      const info = wavInfo(full);
      const durationSec = info ? info.durationSec : 0;
      files.push({ name, bytes, durationSec, rate: info ? info.rate : null, channels: info ? info.channels : null });
      dirBytes += bytes;
      dirDuration += durationSec;
    }
    if (!files.length) continue;

    const estimatedBytesAfter = Math.round((dirDuration * preset.bitrateKbps * 1000) / 8);
    dirs.push({
      dir,
      name: path.basename(dir),
      files,
      totalBytes: dirBytes,
      totalDurationSec: dirDuration,
      estimatedBytesAfter,
      estimatedSavedBytes: Math.max(0, dirBytes - estimatedBytesAfter),
    });
    fileCount += files.length;
    totalBytes += dirBytes;
    totalDurationSec += dirDuration;
  }

  const estimatedBytesAfter = Math.round((totalDurationSec * preset.bitrateKbps * 1000) / 8);
  return {
    dirs,
    fileCount,
    totalBytes,
    totalDurationSec,
    estimatedBytesAfter,
    estimatedSavedBytes: Math.max(0, totalBytes - estimatedBytesAfter),
    preset,
  };
}

/** Compress every meeting under root with one progress stream. */
async function archiveAll(root, opts = {}, onProgressAll) {
  const dirs = meetingDirs(root);
  const out = { dirs: [], files: [], errors: [], savedBytes: 0, before: 0, after: 0 };
  let dirIndex = 0;
  for (const dir of dirs) {
    let names;
    try { names = fs.readdirSync(dir).filter(isWavName); } catch { continue; }
    if (!names.length) continue;
    dirIndex++;
    const r = await archiveDir(dir, opts, (p) => {
      if (onProgressAll) onProgressAll({ ...p, dir, dirName: path.basename(dir), dirIndex });
    });
    out.dirs.push({ dir, name: path.basename(dir), files: r.files, errors: r.errors, savedBytes: r.savedBytes });
    out.files.push(...r.files.map((f) => ({ ...f, dir })));
    out.errors.push(...r.errors.map((e) => ({ ...e, dir })));
    out.savedBytes += r.savedBytes;
    out.before += r.files.reduce((a, f) => a + f.before, 0);
    out.after += r.files.reduce((a, f) => a + f.after, 0);
  }
  return out;
}

module.exports = {
  PRESETS,
  DEFAULT_PRESET_ID,
  resolvePreset,
  estimateBytesPerHour,
  archiveFile,
  transcodeTo,
  archiveDir,
  archiveAll,
  scan,
  wavInfo,
};
