"use strict";
/* INTEGRATION test of the shadow WIRING (tracked suite).
 * Run: node test/liveVad-wiring.test.js
 *
 * Electron cannot be launched in this sandbox, so main.js cannot be required. The
 * two functions the shadow added to src/main.js are therefore lifted OUT OF THE
 * SHIPPED SOURCE TEXT (brace matching, no copy) and executed in a context with a
 * stubbed `app`/`config` and the REAL src/liveVad.js and the REAL model. That tests
 * the actual shipped code, not a paraphrase of it:
 *   - the report JSON has every required field, with the real model SHA-256;
 *   - one file per meeting, in <userData>/vad-shadow/, named after the meeting dir;
 *   - nothing is written into the meeting directory;
 *   - a missing model, and a model whose SHA-256 is wrong, are both INERT;
 *   - send()/notifyUser() are called ZERO times and rec.busy / rec.limitFired /
 *     lifecycle.lastLoudAt are untouched — measured, not asserted from a comment.
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");
const fx = require("./fixtures");

const ROOT = path.join(__dirname, "..");
const liveVad = require(path.join(ROOT, "src", "liveVad"));
/* Tracked, repo-owned asset: the clone always has it, so it is NOT resolved
 * through the fixture root (a suite must not start skipping because someone
 * pointed A2N_FIXTURE_ROOT at a directory of recordings). */
const MODEL = path.join(ROOT, "assets", "models", "silero_vad.onnx");
/* Everything written goes to the gitignored .scratch/vad-live/wiring sandbox —
 * never into the tracked test/ directory — and the real recording it slices is
 * read from .scratch/vad-live/ where it already is. */
const SANDBOX = fx.scratch("vad-live", "wiring");
const USERDATA = path.join(SANDBOX, "userdata");

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
function ok(cond, what) { if (!cond) throw new Error(what || "assertion failed"); }
function eq(a, b, what) {
  const x = JSON.stringify(a), y = JSON.stringify(b);
  if (x !== y) throw new Error(`${what || "value"}: expected ${y}, got ${x}`);
}

/* ------------------------------------------------ lift the shipped functions */
const mainSrc = fs.readFileSync(path.join(ROOT, "src", "main.js"), "utf8");
function functionSource(text, name) {
  const start = text.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`function ${name} not found in src/main.js`);
  const open = text.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") { depth--; if (depth === 0) return text.slice(start, i + 1); }
  }
  throw new Error(`unbalanced braces in ${name}`);
}
const START_SRC = functionSource(mainSrc, "startVadShadow");
const STOP_SRC = functionSource(mainSrc, "stopVadShadow");

/** Build the two functions against a stubbed environment and return the handles. */
function buildEnv(cfg, recSeed) {
  const log = [];
  const warns = [];
  const ipc = [];
  const lifecycle = { lastLoudAt: 123456, autoStopSuppressed: false, autoStopWarnedAt: null };
  const app = { getPath: () => USERDATA };
  const ctxConsole = {
    log: (...a) => log.push(a.join(" ")),
    warn: (...a) => warns.push(a.join(" ")),
    error: (...a) => log.push("ERROR " + a.join(" ")),
  };
  const ctxConfig = { load: () => cfg, meetingsDir: () => SANDBOX };
  const send = (...a) => ipc.push(["send", ...a]);
  const notifyUser = (...a) => ipc.push(["notifyUser", ...a]);
  const rec = Object.assign({ system: null, mic: null, busy: false, limitFired: false }, recSeed);

  const factory = new Function(
    "rec", "config", "liveVad", "fs", "path", "app", "console", "send", "notifyUser", "lifecycle", "Object",
    `"use strict";\n${START_SRC}\n${STOP_SRC}\nreturn { startVadShadow, stopVadShadow };`
  );
  const api = factory(rec, ctxConfig, liveVad, fs, path, app, ctxConsole, send, notifyUser, lifecycle, Object);
  return { ...api, rec, log, warns, ipc, lifecycle };
}

/* --------------------------------------------------------------- fixtures */
function writeWav(file, seconds, opts) {
  const o = opts || {};
  const n = Math.round(seconds * 16000);
  const buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(16000, 24); buf.writeUInt32LE(32000, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write("data", 36, "ascii"); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    // a loud 440 Hz tone for the first half, silence for the rest: enough to make
    // the VAD produce at least one interval, so the report has real content
    const v = i < n / 2 ? Math.round(12000 * Math.sin((2 * Math.PI * 440 * i) / 16000)) : 0;
    buf.writeInt16LE(v, 44 + i * 2);
  }
  fs.writeFileSync(file, buf);
}

/** A pure sine is NOT speech, and silero correctly refuses to call it speech — so
 *  the fixture has to be REAL audio for "the VAD produced an interval" to mean
 *  anything. Slice the first seconds of the decoded recording (which contains the
 *  real speech run [0.448, 7.072]). The tone fallback is kept for fidelity with the
 *  original suite but is unreachable: the missing fixture SKIPs and exits above. */
const REAL = fx.scratch("vad-live", "sys203332.wav");
/* DATA-DEPENDENT: without the decoded recording this suite cannot be degraded
 * honestly, so it SKIPS instead of running half of itself.
 *
 * Measured why the tone fallback below is not a degradation: check 2 requires the
 * report to carry `system.intervals` as [[start,end],...] pairs, and silero
 * correctly refuses to call a pure 440 Hz sine speech — so on a fixture-less run
 * the report comes back with `intervals: []` and that check fails with
 * "system.intervals must be [[start,end],...]" (exit 1). A missing private
 * recording must therefore never make `npm test` red: the fallback stays in the
 * code (the suite's logic is unchanged) but it is unreachable, because the skip
 * below exits first. */
if (!fs.existsSync(REAL)) {
  fx.skip("liveVad-wiring: real speech fixture — the whole suite measures against it", REAL);
  console.log("SKIP  liveVad-wiring: 0 checks measured — needs .scratch/vad-live/sys203332.wav (decoded meeting audio).");
  process.exit(0);
}

function writeSpeechWav(file, seconds) {
  if (fs.existsSync(REAL)) {
    const src = fs.readFileSync(REAL);
    const need = Math.min(44 + Math.round(seconds * 32000), src.length);
    fs.writeFileSync(file, src.subarray(0, need));
    return true;
  }
  writeWav(file, seconds);
  return false;
}

fs.rmSync(SANDBOX, { recursive: true, force: true });
const MEETING = path.join(SANDBOX, "meetings", "2026-01-02_030405");
fs.mkdirSync(MEETING, { recursive: true });
const CFG = {
  vad: {
    modelPath: "", threshold: 0.75, minSilenceDuration: 0.5, minSpeechDuration: 1.0, windowSize: 512,
  },
};

/* ------------------------------------------------ 1. the happy path, end to end */
check("1. startVadShadow + stopVadShadow write ONE report for the meeting", () => {
  const real = writeSpeechWav(path.join(MEETING, "system.wav"), 10);
  writeSpeechWav(path.join(MEETING, "mic.wav"), 10);
  const env = buildEnv(CFG, {
    system: { wavFile: path.join(MEETING, "system.wav") },
    mic: { wavFile: path.join(MEETING, "mic.wav") },
    dir: MEETING,
  });
  const started = env.startVadShadow(MEETING);
  eq(started, true, "startVadShadow returned");
  eq(Object.keys(env.rec.vadTracks), ["system", "mic"], "one VAD per track");
  eq(env.rec.vadTimers.length, 2, "two timers (one per track)");
  eq(env.rec.vadStartedAt > 0, true, "start time recorded");
  const file = env.stopVadShadow();
  eq(env.rec.vadTimers.length, 0, "timers cleared");
  eq(env.rec.vadTracks, null, "tracks cleared");
  // exactly one file per meeting, in <userData>/vad-shadow/
  eq(fs.readdirSync(path.join(USERDATA, "vad-shadow")), ["2026-01-02_030405.json"], "one report file");
  eq(path.dirname(file), path.join(USERDATA, "vad-shadow"), "report directory");
  // nothing leaked into the meeting directory
  eq(fs.readdirSync(MEETING).sort(), ["mic.wav", "system.wav"], "meeting dir unchanged");
  return `${file}  (meeting dir untouched: ${fs.readdirSync(MEETING).join(", ")})`;
});

check("2. the report contains everything needed to prove which model produced it", () => {
  const realAudio = fs.existsSync(REAL);
  const doc = JSON.parse(fs.readFileSync(path.join(USERDATA, "vad-shadow", "2026-01-02_030405.json"), "utf8"));
  const missing = ["version", "mode", "enforcement", "meeting", "meetingDir", "startedAt", "stoppedAt",
    "shadowElapsedSec", "pollIntervalMs", "bufferSizeInSeconds", "model", "vadConfig", "tracks"]
    .filter((k) => !(k in doc));
  eq(missing, [], "missing top-level keys");
  for (const k of ["path", "sha256", "expectedSha256", "bytes", "ok"]) ok(k in doc.model, `model.${k} missing`);
  eq(doc.model.sha256, liveVad.MODEL_SHA256, "model sha256");
  eq(doc.model.bytes, 643854, "model bytes");
  eq(doc.model.ok, true, "model.ok");
  eq(doc.enforcement, false, "enforcement must be false — this is a measurement");
  eq(doc.mode, "shadow", "mode");
  eq(doc.meeting, "2026-01-02_030405", "meeting name = the meeting dir basename");
  eq(doc.vadConfig, {
    sileroVad: { model: MODEL, threshold: 0.75, minSilenceDuration: 0.5, minSpeechDuration: 1.0, windowSize: 512 },
    sampleRate: 16000, numThreads: 1, debug: false,
  }, "vadConfig is the exact object handed to sherpa");
  for (const track of ["system", "mic"]) {
    const t = doc.tracks[track];
    ok(t, `tracks.${track} missing`);
    const miss = ["intervals", "totalSpeechSec", "speechFraction", "blocksFed", "bytesFed", "errors", "failed"]
      .filter((k) => !(k in t));
    eq(miss, [], `tracks.${track} missing keys`);
    ok(Array.isArray(t.intervals) && Array.isArray(t.intervals[0]), `${track}.intervals must be [[start,end],...]`);
    eq(t.bytesFed, fs.statSync(path.join(MEETING, `${track}.wav`)).size - 44, `${track}.bytesFed == the data area size`);
    eq(t.formatMatchesAssumption, true, `${track}.formatMatchesAssumption (fixture is 16000:1:16 @44)`);
    eq(t.wavFormat.sampleRate, 16000, `${track}.wavFormat.sampleRate`);
    eq(t.wavFormat.dataOffset, 44, `${track}.wavFormat.dataOffset`);
    eq(t.failed, false, `${track}.failed`);
    eq(t.errors, 0, `${track}.errors`);
    if (realAudio) {
      ok(t.totalSpeechSec > 0, `${track}: the real speech in the fixture must be detected (got ${t.totalSpeechSec} s)`);
    }
  }
  console.log(`      system: ${JSON.stringify(doc.tracks.system.intervals)} totalSpeechSec=${doc.tracks.system.totalSpeechSec} fraction=${doc.tracks.system.speechFraction} blocks=${doc.tracks.system.blocksFed}`);
  console.log(`      mic   : ${JSON.stringify(doc.tracks.mic.intervals)} totalSpeechSec=${doc.tracks.mic.totalSpeechSec}`);
  return `sha256=${doc.model.sha256.slice(0, 16)}... config and both tracks complete`;
});

check("3. NO IPC, NO notifyUser, and the guard/state sentinels are untouched", () => {
  /* Re-run with recording sentinels and spies; this is the dynamic version of the
     inertness claim. */
  const env = buildEnv(CFG, {
    system: { wavFile: path.join(MEETING, "system.wav") },
    mic: { wavFile: path.join(MEETING, "mic.wav") },
    dir: MEETING,
    busy: false, limitFired: false, limitReached: null, stopReason: "manual",
  });
  const snapshot = () => JSON.stringify({
    busy: env.rec.busy, limitFired: env.rec.limitFired, limitReached: env.rec.limitReached,
    stopReason: env.rec.stopReason, dir: env.rec.dir, system: env.rec.system, mic: env.rec.mic,
    lifecycle: env.lifecycle,
  });
  const before = snapshot();
  env.startVadShadow(MEETING);
  env.stopVadShadow();
  const after = snapshot();
  eq(after, before, "rec's existing fields and the lifecycle object changed");
  eq(env.ipc, [], "send()/notifyUser() were called");
  eq(env.lifecycle.lastLoudAt, 123456, "lifecycle.lastLoudAt");
  return `rec + lifecycle byte-identical before/after; 0 IPC/notification calls; log lines: ${env.log.length}`;
});

/* ------------------------------------------------------------ 4. inert paths */
check("4. a MISSING model makes the shadow inert: no VAD, no file, ONE log line", () => {
  const env = buildEnv({ vad: { ...CFG.vad, modelPath: path.join(SANDBOX, "nope.onnx") } }, {
    system: { wavFile: path.join(MEETING, "system.wav") },
    dir: MEETING,
    busy: false,
  });
  const files = fs.readdirSync(path.join(USERDATA, "vad-shadow"));
  const r = env.startVadShadow(MEETING);
  eq(r, false, "startVadShadow must report inert");
  eq(env.rec.vadTracks, null, "no tracks");
  eq(env.rec.vadTimers, [], "no timers");
  eq(env.log.length + env.warns.length, 1, "exactly one log line at record:start");
  env.stopVadShadow();
  eq(fs.readdirSync(path.join(USERDATA, "vad-shadow")), files, "no report was written");
  eq(env.ipc, [], "no IPC");
  return `inert: "${env.log[0]}" (no file written)`;
});

check("5. a model with the WRONG SHA-256 is inert and warns", () => {
  const bad = path.join(SANDBOX, "corrupt.onnx");
  const bytes = fs.readFileSync(MODEL);
  bytes[bytes.length - 1] ^= 0xff; // one flipped bit, same size
  fs.writeFileSync(bad, bytes);
  liveVad.resetModelInfoCache(); // the cache is keyed by path+size+mtime
  const env = buildEnv({ vad: { ...CFG.vad, modelPath: bad } }, {
    system: { wavFile: path.join(MEETING, "system.wav") },
    dir: MEETING,
  });
  const r = env.startVadShadow(MEETING);
  eq(r, false, "startVadShadow must report inert");
  eq(env.rec.vadTracks, null, "no tracks");
  eq(env.warns.length, 1, "exactly one WARNING");
  ok(/sha256 mismatch/.test(env.warns[0]), `warning must name the cause: ${env.warns[0]}`);
  env.stopVadShadow();
  return `inert: "${env.warns[0].slice(0, 90)}..."`;
});

check("6. an inert recording cannot re-report a PREVIOUS recording's tracks", () => {
  /* rec is rebuilt by object spread on every record:start, so stale shadow state
     would ride along. Sequence: a good recording, then a recording with no model. */
  liveVad.resetModelInfoCache();
  const good = buildEnv(CFG, {
    system: { wavFile: path.join(MEETING, "system.wav") }, dir: MEETING,
  });
  good.startVadShadow(MEETING);
  good.stopVadShadow();
  const filesAfterGood = fs.readdirSync(path.join(USERDATA, "vad-shadow")).length;
  // Same `rec` object carried into the next record:start (the spread in main.js),
  // then the model disappears.
  const rec2 = Object.assign({}, good.rec, { vadTracks: null, vadTimers: [] });
  rec2.dir = MEETING;
  const inert = buildEnv({ vad: { ...CFG.vad, modelPath: path.join(SANDBOX, "gone.onnx") } }, rec2);
  eq(inert.rec.vadTracks, null, "precondition: nothing carried");
  eq(inert.startVadShadow(MEETING), false, "inert");
  eq(inert.rec.vadTracks, null, "stale tracks cleared by the inert path");
  entry: {
    // and a second stop must not write anything
    const r = inert.stopVadShadow();
    eq(r, null, "stopVadShadow must not write when nothing ran");
  }
  eq(fs.readdirSync(path.join(USERDATA, "vad-shadow")).length, filesAfterGood, "no extra file");
  return `2 stops, ${filesAfterGood} report(s): a stale track object is never re-reported`;
});

/* -------------------------------- 7. the real tail: a growing file during a recording */
check("7. the 1 s poll actually picks up a file that grows during the recording", () => {
  /* Slows the wall clock down to a single 1 s poll: the timer must read the file
     while it grows and the final drain must catch the rest. */
  const grow = path.join(SANDBOX, "grow.wav");
  writeWav(grow, 1.2); // a tone is fine here: this checks BYTES, not detection
  const env = buildEnv(CFG, { system: { wavFile: grow }, dir: MEETING });
  env.startVadShadow(MEETING);
  const size0 = fs.statSync(grow).size;
  // "recording continues": append 1 s of audio, then wait for one poll to fire
  const extra = Buffer.alloc(32000);
  for (let i = 0; i < 16000; i++) extra.writeInt16LE(Math.round(9000 * Math.sin((2 * Math.PI * 440 * i) / 16000)), i * 2);
  const fd = fs.openSync(grow, "a"); fs.writeSync(fd, extra); fs.closeSync(fd);
  const t = Date.now();
  execFileSync(process.execPath, ["-e", "setTimeout(()=>{},1100)"], { stdio: "ignore" }); // let one poll fire
  const doc = JSON.parse((() => { env.stopVadShadow(); return fs.readFileSync(path.join(USERDATA, "vad-shadow", "2026-01-02_030405.json"), "utf8"); })());
  const s = doc.tracks.system;
  eq(s.bytesFed, fs.statSync(grow).size - 44, "every byte of the grown file was fed");
  eq(s.bytesFed, size0 - 44 + extra.length, "the appended second was picked up");
  /* blocksFed counts the zero-padded final block (close() must not drop the tail),
     so it is ceil(bytes/1024), not floor. */
  eq(s.blocksFed, Math.ceil(s.bytesFed / 1024), "blocksFed = ceil(bytesFed / 1024) including the padded tail");
  return `${s.bytesFed} bytes fed (${size0 - 44} before + ${extra.length} appended), ${s.blocksFed} blocks, ${s.totalSpeechSec} s speech, poll waited ${Date.now() - t} ms`;
});

console.log(`\n${failures === 0 ? "ALL PASS (7/7)" : failures + " FAILURE(S)"} — exit ${failures === 0 ? 0 : 1}`);
process.exit(failures === 0 ? 0 : 1);
