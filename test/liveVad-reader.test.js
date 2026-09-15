"use strict";
/* Verification for createWavTailReader() in src/liveVad.js (tracked suite).
 * Run: node test/liveVad-reader.test.js
 *
 * The reader is the half of the live path that can silently destroy the
 * measurement: a cursor that runs ahead skips audio, a cursor that falls behind
 * duplicates it, and reading a header byte shifts every sample's meaning. So this
 * test writes a WAV the way capture.exe does — header first, then data appended in
 * irregular chunks, with the two RIFF size fields re-patched every "2 s" — and
 * asserts the concatenation of everything readNew() returned is BYTE-IDENTICAL to
 * the file's data area. */
const fs = require("fs");
const path = require("path");
const fx = require("./fixtures");
const { createWavTailReader } = require(path.join(__dirname, "..", "src", "liveVad"));

/* This suite WRITES WAVs it then tails. They must not land in the tracked test/
 * directory, and the real `.scratch/vad-live/*` fixtures it also reads live in
 * .scratch/ — so input and output share that gitignored directory, exactly as
 * they did before the move (the suite recreates its own files on every run). */
const OUT = fx.scratch("vad-live");
const WAV = path.join(OUT, "growing-test.wav");
const MISSING = path.join(OUT, "does-not-exist-yet.wav");

let failures = 0;
function check(name, fn) {
  try {
    const info = fn();
    console.log(`PASS  ${name}${info ? "\n      " + info : ""}`);
  } catch (e) {
    failures++;
    console.log(`FAIL  ${name}\n      ${e.message}`);
  }
}
function eq(actual, expected, what) {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${what || "value"}: expected ${b}, got ${a}`);
}
function ok(cond, what) { if (!cond) throw new Error(what || "assertion failed"); }

/** A 44-byte canonical PCM WAV header (what capture.exe writes: verified byte for
 *  byte against .scratch/t1.wav). The size fields are patched later, which is the
 *  behaviour the reader has to tolerate. */
function header(dataBytes, sizeFields) {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0, "ascii");
  h.writeUInt32LE(sizeFields ? 36 + dataBytes : 0, 4);
  h.write("WAVE", 8, "ascii");
  h.write("fmt ", 12, "ascii");
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);          // PCM
  h.writeUInt16LE(1, 22);          // mono
  h.writeUInt32LE(16000, 24);      // 16 kHz
  h.writeUInt32LE(32000, 28);      // byte rate
  h.writeUInt16LE(2, 32);          // block align
  h.writeUInt16LE(16, 34);         // bits
  h.write("data", 36, "ascii");
  h.writeUInt32LE(sizeFields ? dataBytes : 0, 40);
  return h;
}

/** Deterministic, position-sensitive payload: a byte's value depends on its
 *  index, so ANY skipped or duplicated byte shifts the rest and fails equals(). */
function payload(n) {
  const b = Buffer.alloc(n);
  for (let i = 0; i < n; i++) b[i] = (i * 31 + (i >> 8) * 7 + (i >> 16) * 3) & 0xff;
  return b;
}

fs.mkdirSync(OUT, { recursive: true });
try { fs.unlinkSync(WAV); } catch { /* first run */ }

/* ---------------------------------------------- A: growing WAV, live reads --- */
check("A. growing WAV: readNew() concatenation is byte-identical to the data area", () => {
  const data = payload(200000);
  const chunks = [1, 999, 1000, 333, 32000, 7, 65536, 4096, 61, 1000, 32768, 5, 60000, 2194];
  const sum = chunks.reduce((a, b) => a + b, 0);
  if (sum !== data.length) throw new Error(`test chunks sum to ${sum}, need ${data.length}`);

  // Header FIRST, with size fields still zero — the writer patches them later.
  fs.writeFileSync(WAV, header(0, false));
  const reader = createWavTailReader({ wavFile: WAV });

  eq(reader.readNew(), Buffer.alloc(0), "no data bytes yet => empty Buffer (not an error)");

  const got = [];
  let off = 0, patched = 0, readsWithData = 0, emptyReads = 0;
  for (let i = 0; i < chunks.length; i++) {
    const fd = fs.openSync(WAV, "a");
    fs.writeSync(fd, data.subarray(off, off + chunks[i]));
    fs.closeSync(fd);
    off += chunks[i];
    // capture.exe patches the RIFF (offset 4) and data (offset 40) sizes roughly
    // every 2 s. Re-patching them must never move the data start.
    if (i % 3 === 0) {
      const fd2 = fs.openSync(WAV, "r+");
      fs.writeSync(fd2, header(off, true).subarray(4, 8), 0, 4, 4);
      fs.writeSync(fd2, header(off, true).subarray(40, 44), 0, 4, 40);
      fs.closeSync(fd2);
      patched++;
    }
    const b = reader.readNew();
    if (b.length) readsWithData++; else emptyReads++;
    got.push(b);
  }
  const feed = Buffer.concat(got);
  const onDisk = fs.readFileSync(WAV);
  const dataArea = onDisk.subarray(44);

  ok(Buffer.isBuffer(feed), "readNew returned Buffers");
  eq(feed.length, data.length, "total bytes read");
  ok(feed.equals(dataArea), "MISMATCH: concatenated reads != file data area");
  ok(feed.equals(data), "MISMATCH: concatenated reads != the bytes written");
  eq(reader.bytesRead(), data.length, "bytesRead");
  ok(!feed.subarray(0, 4).equals(Buffer.from("RIFF")), "NO header bytes leaked into the feed");
  eq(onDisk.length, 44 + data.length, "file length = header + data");
  return `${chunks.length} appends (${chunks.join(",")}) + ${patched} size patches, ${readsWithData} non-empty / ${emptyReads} empty reads, ${feed.length} bytes byte-identical (Buffer.equals === true)`;
});

check("B. a WAV written in ONE go is read in one piece", () => {
  const f2 = path.join(OUT, "growing-test-once.wav");
  const data = payload(50000);
  fs.writeFileSync(f2, Buffer.concat([header(data.length, true), data]));
  const r = createWavTailReader({ wavFile: f2 });
  const got = r.readNew();
  ok(got.equals(data), "one read == the whole data area");
  eq(r.readNew(), Buffer.alloc(0), "second read: nothing new");
  eq(r.bytesRead(), data.length, "bytesRead");
  return "50000 bytes in 1 read, then empty (no duplicates on re-read)";
});

check("C. reading in small steps never skips or duplicates (1000 B x 20)", () => {
  const f3 = path.join(OUT, "growing-test-steps.wav");
  const data = payload(20000);
  fs.writeFileSync(f3, header(0, false));
  const r = createWavTailReader({ wavFile: f3 });
  const got = [];
  for (let off = 0; off < data.length; off += 1000) {
    const fd = fs.openSync(f3, "a");
    fs.writeSync(fd, data.subarray(off, off + 1000));
    fs.closeSync(fd);
    got.push(r.readNew());
    r.readNew(); // a second poll with nothing new must not re-emit anything
  }
  const feed = Buffer.concat(got);
  ok(feed.equals(data), "MISMATCH after 20 incremental reads");
  return `${feed.length} bytes over 20 steps + 20 empty re-polls: byte-identical`;
});

/* --------------------------------------------------------- D: missing file --- */
check("D. a file that does not exist yet is an empty Buffer, not a throw", () => {
  try { fs.unlinkSync(MISSING); } catch { /* fine */ }
  const r = createWavTailReader({ wavFile: MISSING });
  eq(r.readNew(), Buffer.alloc(0), "missing file");
  /* Deliberately NOT counted as an error: on every real recording the reader is
   * created before capture.exe has opened its WAV, so ENOENT is the normal first
   * poll, not a fault. errors would otherwise start at 1 on every meeting. */
  eq(r.stats(), { bytesRead: 0, errors: 0, shorterReads: 0 }, "no error counted for 'not created yet'");
  // and it starts working as soon as the file appears
  const data = payload(100);
  fs.writeFileSync(MISSING, Buffer.concat([header(data.length, true), data]));
  ok(r.readNew().equals(data), "reads normally once the file appears");
  return "ENOENT swallowed, NOT counted as an error, zero bytes; recovers when the file appears";
});

check("E. no wavFile at all is inert", () => {
  const r = createWavTailReader({});
  eq(r.readNew(), Buffer.alloc(0), "no path");
  return "returns an empty Buffer";
});

/* --------------------------------------------- F: transient shorter file ---- */
check("F. a transiently SHORTER file (stat lag) returns empty, keeps the cursor", () => {
  const f6 = path.join(OUT, "growing-test-short.wav");
  const data = payload(5000);
  // Header + the first 1000 bytes only, like a writer caught mid-flush.
  fs.writeFileSync(f6, Buffer.concat([header(0, false), data.subarray(0, 1000)]));
  const r = createWavTailReader({ wavFile: f6 });
  eq(r.readNew().length, 1000, "first read: the 1000 bytes that exist");
  // Simulate a stat that LAGS the real file size (the observed failure mode for a
  // file another process holds open) by patching fs.fstatSync for one call.
  const realFstat = fs.fstatSync;
  let faked = 0;
  fs.fstatSync = (fd, ...rest) => {
    const st = realFstat(fd, ...rest);
    if (faked++ === 0) return { ...st, size: 44 + 400 }; // 400 < the 1000 already read
    return st;
  };
  let short;
  try { short = r.readNew(); } finally { fs.fstatSync = realFstat; }
  eq(short, Buffer.alloc(0), "shorter than the cursor => empty");
  eq(r.stats().shorterReads, 1, "counted as a shorter-than-cursor read");
  eq(r.bytesRead(), 1000, "cursor NOT rewound (a rewind would duplicate audio)");
  const fd = fs.openSync(f6, "a");
  fs.writeSync(fd, data.subarray(1000));
  fs.closeSync(fd);
  const rest = r.readNew();
  ok(rest.equals(data.subarray(1000)), "MISMATCH: the rest of the data after the stat glitch");
  eq(r.bytesRead(), data.length, "cursor ends exactly at the end of the data area");
  return "stat lag: empty read, cursor preserved, all 5000 bytes delivered exactly once";
});

/* ----------------------------------- G: a header with a LIST chunk (78, not 44) */
check("G. a LIST/INFO header (data at 78, as ffmpeg writes) needs dataOffset=78", () => {
  /* MEASURED TRAP: `ffmpeg -i x.opus -ac 1 -ar 16000 -c:a pcm_s16le out.wav` WITHOUT
   * `-fflags +bitexact` writes a LIST/INFO metadata chunk between "fmt " and "data",
   * so the data area starts at 78. Reading it with the default 44 shifts every
   * sample by 17 (0.001 s) and silently produces a slightly different VAD result
   * (85.664 s instead of 85.696 s) — which is exactly what the first version of the
   * end-to-end test reported. capture.exe writes the canonical 44-byte header
   * (verified on .scratch/t1.wav), so 44 is the right DEFAULT; anything else must
   * pass dataOffset explicitly, and this test proves the parameter works. */
  const f7 = path.join(OUT, "growing-test-list.wav");
  const data = payload(4000);
  const list = Buffer.alloc(8 + 26);
  list.write("LIST", 0, "ascii");
  list.writeUInt32LE(26, 4);
  list.write("INFO", 8, "ascii"); // 26 bytes of INFO payload, contents irrelevant
  const head = header(data.length, true);
  const withList = Buffer.concat([head.subarray(0, 36), list, head.subarray(36)]);
  // sanity: the data chunk really did move
  const dataAt = withList.indexOf(Buffer.from("data", "ascii"));
  eq(dataAt, 70, "the 'data' chunk id moved to offset 70 (payload at 78)");
  fs.writeFileSync(f7, Buffer.concat([withList, data]));

  const wrong = createWavTailReader({ wavFile: f7 }); // default 44
  const gotWrong = wrong.readNew();
  eq(gotWrong.length, data.length + 34, "the default offset reads 34 header bytes too");
  ok(!gotWrong.equals(data), "and therefore is NOT byte-identical (this is the trap)");

  const right = createWavTailReader({ wavFile: f7, dataOffset: 78 });
  const gotRight = right.readNew();
  ok(gotRight.equals(data), "MISMATCH: dataOffset=78 must be byte-identical");
  eq(right.bytesRead(), data.length, "bytesRead");
  return `default 44 -> ${gotWrong.length} bytes (34 header bytes + shifted data, wrong); dataOffset 78 -> ${gotRight.length} bytes byte-identical`;
});

/* ------------------------------------- H: readWavFormat confirms the assumptions */
check("H. readWavFormat finds the real data offset (44 for capture.exe, 78 for the LIST WAV)", () => {
  /* This turns the two hardcoded assumptions — 16000:1:16 and dataOffset 44 — into
   * something checked against REAL files rather than a hexdump read by eye. */
  const { readWavFormat } = require(path.join(__dirname, "..", "src", "liveVad"));
  const realCapture = fx.scratch("t1.wav"); // a real capture.exe recording (untracked fixture)
  if (fs.existsSync(realCapture)) {
    const f = readWavFormat(realCapture);
    eq(f, { sampleRate: 16000, channels: 1, bits: 16, audioFormat: 1, dataOffset: 44, size: fs.statSync(realCapture).size },
      "real capture.exe WAV");
    console.log(`      real capture.exe recording ${path.basename(realCapture)}: 16000 Hz / 1 ch / 16 bit, data at 44 — the default is confirmed on real output`);
  } else {
    fx.skip("liveVad-reader: real capture.exe WAV (.scratch/t1.wav) — its header assertion is not measured", realCapture);
  }
  const f2 = readWavFormat(WAV.replace(/growing-test\.wav$/, "growing-test-list.wav"));
  eq(f2.dataOffset, 78, "ffmpeg LIST WAV data offset");
  eq(readWavFormat(MISSING.replace(/does-not-exist-yet\.wav$/, "definitely-absent.wav")), null, "missing file => null");
  const f3 = readWavFormat(WAV);
  eq(f3.dataOffset, 44, "canonical WAV data offset");
  return `capture.exe=44, ffmpeg+LIST=78, canonical=44, missing=null`;
});

console.log(`\n${failures === 0 ? "ALL PASS (8/8)" : failures + " FAILURE(S)"} — exit ${failures === 0 ? 0 : 1}`);
process.exit(failures === 0 ? 0 : 1);
