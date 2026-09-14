"use strict";
/* Audio archiving: replace bulky meeting WAVs with compressed 16 kHz mono audio.
 *
 * 16 kHz mono is exactly Whisper's input format (see transcribe.js:29-37), so the
 * sample rate and channel count cost nothing — but the codec is lossy and that is
 * NOT free. MEASURED (120 s of real speech, whisper-base.en, the project default;
 * method and full table in BACKLOG.md P3-2): 16 kbps and 24 kbps each dropped a
 * contiguous ~20-word sentence and mangled proper nouns (24 kbps = 8.1% word error
 * rate), whereas 32 kbps decoded at 1.45% with the names intact. Default = Opus
 * 32 kbps mono (~14.4 MB/hour vs ~691 MB/hour for a 48 kHz stereo capture WAV).
 *
 * Safety rule: an original WAV is ONLY deleted after its replacement passed
 * four checks — ffmpeg exit 0, output non-trivial (>1 KB), a second
 * end-to-end decode pass (yielding a duration via `-progress`), and a
 * source-vs-output duration match within max(1% of source, 0.5 s). Any failure
 * keeps the original and reports why. Encode output always lands in a
 * `.tmp` sibling first and is only `fs.rename`d to the final name once every
 * check has passed, so a crash mid-encode can never leave a file with the
 * final name but partial contents. */

const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ffmpegPath = require("./ffmpegPath").ffmpegPath();

const PRESETS = [
  { id: "opus-16", label: "Opus 16 kbps 单声道（最小；实测会丢句）", codec: "libopus", bitrateKbps: 16, ext: "opus" },
  { id: "opus-24", label: "Opus 24 kbps 单声道（省空间；实测会丢句、改人名）", codec: "libopus", bitrateKbps: 24, ext: "opus" },
  { id: "opus-32", label: "Opus 32 kbps 单声道（推荐）", codec: "libopus", bitrateKbps: 32, ext: "opus" },
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

const DEFAULT_PRESET_ID = "opus-32";

/** Preset for a settings object; never throws. */
function resolvePreset(opts = {}) {
  const codec = (opts && opts.codec) || "libopus";
  /* NOTE: this literal — not DEFAULT_PRESET_ID — is what an empty opts resolves to,
   * because the exact-match lookup below hits it first. Keep the two in step. */
  const kbps = Number((opts && opts.bitrateKbps) || 32) || 32;
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
  // `-f <ext>` forces the muxer — required when `out` does not carry the
  // canonical extension (e.g. the atomic `.tmp` sibling).
  const head = ["-y", "-v", "error", "-i", src, "-vn", "-map", "0:a:0"];
  if (preset.codec === "libopus") {
    return [
      ...head,
      "-ar", "16000", "-ac", "1",
      "-c:a", "libopus", "-b:a", `${preset.bitrateKbps}k`,
      "-application", "voip", "-vbr", "on",
      "-f", preset.ext,
      out,
    ];
  }
  const { sampleRate } = outputFormat(preset);
  return [
    ...head,
    "-ar", String(sampleRate), "-ac", "1",
    "-c:a", "libmp3lame", "-b:a", `${preset.bitrateKbps}k`,
    "-f", preset.ext,
    out,
  ];
}

/**
 * Actual output format (sample rate / channel count) the encoder args use —
 * single source of truth shared by encodeArgs() and the main-process meta
 * patch, so what we record in meta.json matches what actually gets encoded.
 */
function outputFormat(preset) {
  if ((preset && preset.codec) === "libopus") return { sampleRate: 16000, channels: 1 };
  return { sampleRate: (preset && preset.sampleRate) || 24000, channels: 1 };
}

/* ---- querying the bundled ffmpeg (version / encoder list) ---------------
 * Sandbox constraint: a spawned process's stdout CANNOT be captured through
 * a pipe (EPERM). Work around it by passing an open file descriptor as the
 * stdio entry — ffmpeg writes into the file itself, we read it back after
 * the process exits, and delete it. No `child_process.exec`, no pipes. */

/**
 * Run `ffmpegPath` with `args`, capturing its combined stdout/stderr into a
 * temp file via an open fd. Resolves the output text, or `null` on spawn
 * failure / non-zero exit / unreadable output. The temp file is deleted.
 */
async function captureFfmpegOutput(args) {
  const tag = Date.now().toString(36) + "-" + Math.floor(Math.random() * 1e9).toString(36);
  const tmp = path.join(os.tmpdir(), "dsh-ffmpeg-probe-" + tag + ".txt");
  let fd = null;
  let code = -1;
  try {
    fd = fs.openSync(tmp, "w");
    code = await new Promise((resolve) => {
      let settled = false;
      const settle = (v) => { if (!settled) { settled = true; resolve(v); } };
      try {
        const p = spawn(ffmpegPath, args, { stdio: ["ignore", fd, fd], windowsHide: true });
        p.on("error", () => settle(-1));
        p.on("close", (c) => settle(c));
      } catch { settle(-1); }
    });
  } catch { code = -1; }
  if (fd != null) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  let content = null;
  if (code === 0) { try { content = fs.readFileSync(tmp, "utf8"); } catch { content = null; } }
  try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  return content;
}

let versionCache = null;
/**
 * First line of `ffmpeg -version`, e.g. "ffmpeg version 7.1-full_build …".
 * Cached after the first call. `null` when the probe cannot be run.
 */
async function ffmpegVersion() {
  if (versionCache != null) return versionCache;
  const out = await captureFfmpegOutput(["-hide_banner", "-version"]);
  const first = out ? String(out).split(/\r?\n/)[0].trim() : null;
  versionCache = first || null;
  return versionCache;
}

let encoderNameCache = null;
/**
 * Whether the bundled ffmpeg advertises an encoder by name (e.g. "libopus").
 * `ffmpeg -encoders` is run once and the encoder-name column is cached;
 * a failed probe behaves as "no encoders" so callers fail clearly.
 * @returns {Promise<boolean>}
 */
async function hasEncoder(name) {
  if (encoderNameCache == null) {
    const set = new Set();
    const out = await captureFfmpegOutput(["-hide_banner", "-encoders"]);
    if (out != null) {
      for (const line of String(out).split(/\r?\n/)) {
        // Flag column is one of A/V/S followed by dots/letters, then the name
        const m = line.match(/^\s*([AVS][.A-Z0-9]{0,6})[ \t]+(\S+)/);
        if (m) set.add(m[2].toLowerCase());
      }
    }
    encoderNameCache = set;
  }
  return encoderNameCache.has(String(name).toLowerCase());
}

/**
 * Single decode pass that BOTH proves the file is end-to-end decodable
 * (ffmpeg exit 0) AND returns the decoded length in seconds. Returns `null`
 * on any failure (spawn error, non-zero exit, or missing/unparseable
 * progress output). Reads the final `out_time_us=` value from the
 * `-progress` file, falling back to `out_time=HH:MM:SS.micro` if the
 * microsecond field is absent. The progress file is a caller-scoped name in
 * the same directory (guaranteed same volume), cleaned up on every exit.
 */
async function probeDurationSec(file) {
  const tag = Date.now().toString(36) + "-" + Math.floor(Math.random() * 1e9).toString(36);
  let progress = null;
  try { progress = path.join(path.dirname(file) || ".", ".probe-" + tag + ".txt"); }
  catch { return null; }

  const ok = await new Promise((resolve) => {
    let settled = false;
    const settle = (v) => { if (!settled) { settled = true; resolve(v); } };
    try {
      const p = spawn(
        ffmpegPath,
        ["-y", "-v", "error", "-i", file, "-f", "null", "-", "-progress", progress],
        { stdio: "ignore", windowsHide: true },
      );
      p.on("error", () => settle(false));
      p.on("close", (code) => settle(code === 0));
    } catch { settle(false); }
  });

  let content = null;
  if (ok) {
    try { content = fs.readFileSync(progress, "utf-8"); } catch { content = null; }
  }
  try { fs.unlinkSync(progress); } catch { /* ignore */ }
  if (!ok || !content) return null;

  let lastUs = null;
  let lastTimeSec = null;
  for (const line of content.split(/\r?\n/)) {
    const mUs = line.match(/^out_time_us=(\d+)\s*$/);
    if (mUs) { lastUs = parseInt(mUs[1], 10); continue; }
    const mT = line.match(/^out_time=(\d+):(\d+):(\d+)[.;](\d+)\s*$/);
    if (mT) {
      const digits = mT[4].length;
      const frac = digits ? parseInt(mT[4], 10) / Math.pow(10, digits) : 0;
      lastTimeSec = parseInt(mT[1], 10) * 3600 + parseInt(mT[2], 10) * 60 + parseInt(mT[3], 10) + frac;
    }
  }
  if (lastUs !== null && Number.isFinite(lastUs) && lastUs >= 0) return lastUs / 1e6;
  if (lastTimeSec !== null && Number.isFinite(lastTimeSec) && lastTimeSec >= 0) return lastTimeSec;
  return null;
}

/**
 * Tolerance for the source-vs-output duration match. A truncated Opus that
 * still decodes is shorter than its source; anything beyond this slack is a
 * data-loss signal and must block the delete.
 */
function durationTolerance(sourceSec) {
  const s = (sourceSec != null && Number.isFinite(sourceSec) && sourceSec > 0) ? sourceSec : 0;
  return Math.max(0.01 * s, 0.5);
}

/** true iff both durations are finite and their difference is within tolerance. */
function durationsMatch(sourceSec, outputSec) {
  if (sourceSec == null || outputSec == null) return false;
  if (!Number.isFinite(sourceSec) || !Number.isFinite(outputSec)) return false;
  if (sourceSec < 0 || outputSec < 0) return false;
  return Math.abs(sourceSec - outputSec) <= durationTolerance(sourceSec);
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
 * Compress one WAV atomically. Returns { from, to, before, after, reused }.
 * Throws on failure — the original is always still on disk, and no `.tmp`
 * sibling is left behind.
 *
 * Reuse: if the final file already exists, it is reused only when ALL four
 * checks pass — size > 1 KB, end-to-end decodable, and a duration that
 * matches the source within max(1% of source, 0.5 s). Otherwise the stale
 * file is deleted and a fresh encode is produced from the source.
 *
 * Fresh encode: output is written to `<out>.tmp` (same directory as `out`
 * so `fs.renameSync` is atomic on the same volume). Every check runs against
 * the `.tmp`. Only after ALL checks pass is the file renamed to the final
 * name and the source deleted (unless `opts.keepWav`). Any failure removes
 * the `.tmp` and leaves the source untouched.
 */
async function archiveFile(srcPath, opts = {}) {
  const preset = resolvePreset(opts);
  const before = fs.statSync(srcPath).size;
  const out = srcPath.replace(/\.wav$/i, "." + preset.ext);

  let sourceDur = null;
  if (isWavName(path.basename(srcPath))) {
    const info = wavInfo(srcPath);
    if (info && Number.isFinite(info.durationSec)) sourceDur = info.durationSec;
  }
  if (sourceDur == null) sourceDur = await probeDurationSec(srcPath);

  if (fs.existsSync(out)) {
    const st = fs.statSync(out);
    let outDur = null;
    if (st.size > 1024) outDur = await probeDurationSec(out);
    const passes = st.size > 1024
      && outDur !== null
      && (sourceDur === null || durationsMatch(sourceDur, outDur));
    if (passes) {
      if (!opts.keepWav) fs.rmSync(srcPath, { force: true });
      return { from: srcPath, to: out, before, after: st.size, reused: true };
    }
    fs.rmSync(out, { force: true }); // unusable leftover — re-encode from scratch
  }

  const tmp = out + ".tmp";
  try {
    if (!(await hasEncoder(preset.codec))) {
      throw new Error(`编码器缺失：此 ffmpeg 未提供“${preset.codec}”编码器，无法压缩（请检查捆绑的 ffmpeg）`);
    }
    const ok = await runFfmpeg(encodeArgs(preset, srcPath, tmp));
    if (!ok || !fs.existsSync(tmp)) throw new Error("ffmpeg 编码失败");
    const after = fs.statSync(tmp).size;
    if (after <= 1024) throw new Error(`输出异常（${after} 字节）`);
    const outDur = await probeDurationSec(tmp);
    if (outDur === null) throw new Error("输出校验失败（无法解码）");
    if (sourceDur !== null && !durationsMatch(sourceDur, outDur)) {
      throw new Error(
        `输出校验失败（时长不一致：源 ${sourceDur.toFixed(2)} s，输出 ${outDur.toFixed(2)} s，`
        + `容忍 ±${durationTolerance(sourceDur).toFixed(2)} s）`
      );
    }
    try { fs.rmSync(out, { force: true }); } catch { /* ignore */ }
    fs.renameSync(tmp, out);
    if (!opts.keepWav) fs.rmSync(srcPath, { force: true });
    return { from: srcPath, to: out, before, after, reused: false };
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    throw e;
  }
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
  /* Pre-flight: if the bundled ffmpeg lacks the target encoder, fail here with
   * one clear error instead of one mystery failure per file. */
  if (names.length && !(await hasEncoder(resolvePreset(opts).codec))) {
    const codec = resolvePreset(opts).codec;
    return {
      ...res,
      ok: false,
      errors: [{ file: dir, message: `编码器缺失：此 ffmpeg 未提供“${codec}”编码器，无法压缩（请检查捆绑的 ffmpeg）` }],
    };
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
 * Verifies the result before returning; throws otherwise. The source-vs-
 * output duration check uses the same tolerance as archiveFile
 * (max(1% of source, 0.5 s)). Output is written atomically via
 * `<outPath>.tmp` and renamed to the final name only after every check
 * passes; any failure removes the temp and leaves the final name untouched.
 * @returns {Promise<{out:string, bytes:number, preset:object}>}
 */
async function transcodeTo(srcPath, outPath, opts = {}) {
  const preset = resolvePreset(opts);
  const outDir = path.dirname(outPath);
  if (outDir) fs.mkdirSync(outDir, { recursive: true });
  const sourceDur = await probeDurationSec(srcPath); // may be null
  const tmp = outPath + ".tmp";
  try {
    if (!(await hasEncoder(preset.codec))) {
      throw new Error(`编码器缺失：此 ffmpeg 未提供“${preset.codec}”编码器，无法编码（请检查捆绑的 ffmpeg）`);
    }
    const ok = await runFfmpeg(encodeArgs(preset, srcPath, tmp));
    if (!ok || !fs.existsSync(tmp)) throw new Error("ffmpeg 编码失败");
    const bytes = fs.statSync(tmp).size;
    if (bytes <= 1024) throw new Error(`输出异常（${bytes} 字节）`);
    const outDur = await probeDurationSec(tmp);
    if (outDur === null) throw new Error("输出校验失败（无法解码）");
    if (sourceDur !== null && !durationsMatch(sourceDur, outDur)) {
      throw new Error(
        `输出校验失败（时长不一致：源 ${sourceDur.toFixed(2)} s，输出 ${outDur.toFixed(2)} s，`
        + `容忍 ±${durationTolerance(sourceDur).toFixed(2)} s）`
      );
    }
    try { fs.rmSync(outPath, { force: true }); } catch { /* ignore */ }
    fs.renameSync(tmp, outPath);
    return { out: outPath, bytes, preset };
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    throw e;
  }
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
  outputFormat,
  captureFfmpegOutput,
  ffmpegVersion,
  hasEncoder,
  estimateBytesPerHour,
  archiveFile,
  transcodeTo,
  archiveDir,
  archiveAll,
  scan,
  wavInfo,
  probeDurationSec,
  durationTolerance,
  durationsMatch,
};
