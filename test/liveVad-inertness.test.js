"use strict";
/* MECHANICAL INERTNESS CHECK for the shadow VAD wiring (tracked suite).
 * Run: node test/liveVad-inertness.test.js
 *
 * The shadow VAD must change no behaviour. Reading the diff is the primary
 * evidence, but reading is not deterministic — this script extracts the two
 * functions the shadow added to src/main.js (by brace matching, not by line
 * numbers) and the call sites, then fails loudly if any of them touches the
 * guard, the watchdog, the fuse, the pipeline, IPC or the meeting directory.
 */
const fs = require("fs");
const path = require("path");

const MAIN = path.join(__dirname, "..", "src", "main.js");
const LIVEVAD = path.join(__dirname, "..", "src", "liveVad.js");
const src = fs.readFileSync(MAIN, "utf8");
const lines = src.split(/\r?\n/);

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
function eq(a, b, what) { if (a !== b) throw new Error(`${what || "value"}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }

/** Body of a top-level `function NAME(` declaration, by brace matching. */
function functionBody(text, name) {
  const start = text.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`function ${name} not found`);
  const open = text.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") { depth--; if (depth === 0) return { start, end: i + 1, body: text.slice(open, i + 1), line: text.slice(0, start).split("\n").length }; }
  }
  throw new Error(`unbalanced braces in ${name}`);
}
const countOccurrences = (text, needle) => text.split(needle).length - 1;

const shadowCode = functionBody(src, "startVadShadow").body + "\n" + functionBody(src, "stopVadShadow").body;
const shadowLines = shadowCode.split("\n");

console.log(`shadow region: startVadShadow + stopVadShadow = ${shadowLines.length} lines of src/main.js`);
console.log("");

/* ------------------------------------------------ forbidden inside the shadow */
const FORBIDDEN = [
  ["lifecycle.lastLoudAt", "the forgotten-recording guard's silence clock"],
  ["notifyUser", "desktop notifications"],
  ["send(", "IPC events to the renderer"],
  ["activity.", "the activity tracker"],
  ["rec.levelTimers", "the level-poll timers (own array required)"],
  ["stopPolling", "the level-poll teardown"],
  ["armRecordingGuard", "the recording guard"],
  ["lifecycle.autoStopSuppressed", "the silence guard"],
  ["rec.busy", "the pipeline's re-entrancy flag"],
  ["scanLimitLine", "the file-size fuse"],
  ["rec.limitFired", "the file-size fuse"],
  ["stopRecordingAndProcess", "the stop path (must not re-enter)"],
  ["ipcMain", "IPC registration"],
  ["webContents", "renderer access"],
  ["rec.dir =", "the meeting directory"],
  ["meetings.", "the meeting store"],
  ["capture.", "the recorder"],
];
for (const [needle, why] of FORBIDDEN) {
  check(`shadow code does not touch ${needle} (${why})`, () => {
    const n = countOccurrences(shadowCode, needle);
    eq(n, 0, `${needle} appears ${n}x inside the shadow functions`);
    return "0 occurrences";
  });
}

check("shadow code never writes INTO the meeting directory", () => {
  /* The only fs writes allowed are mkdirSync/writeFileSync of the report, and the
     report path must be built from app.getPath("userData"), never from rec.dir. */
  ok(/app\.getPath\("userData"\)/.test(shadowCode), "report path must come from app.getPath(\"userData\")");
  ok(/"vad-shadow"/.test(shadowCode), "report dir must be vad-shadow");
  const writes = shadowLines.filter((l) => /writeFileSync|mkdirSync|appendFileSync|createWriteStream/.test(l));
  eq(writes.length, 2, "exactly two write calls (mkdir + writeFile)");
  for (const w of writes) ok(/shadowDir|dir|file/.test(w), `unexpected write target: ${w.trim()}`);
  return `writes: ${writes.map((w) => w.trim()).join(" | ")}`;
});

/* --------------------------------------------------------- required behaviour */
/** Strip comments so a comment that merely NAMES the guard cannot fail a check. */
function stripComments(t) {
  return t.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|\s)\/\/[^\n]*/g, "$1 ");
}

check("shadow code calls nothing outside a known API whitelist", () => {
  /* Deterministic whitelist rather than a allow-list of shapes: every call in the
   * shadow region must be one of these, so any new side effect fails the check. */
  const WHITELIST = new Set([
    // own
    "startVadShadow", "stopVadShadow", "modelInfo", "createTrackVad", "createWavTailReader", "defaultModelPath", "feedS16", "readWavFormat",
    // the only app surface used
    "load", "getPath", "join", "basename",
    // node/JS built-ins that cannot act on the app
    "setInterval", "clearInterval", "log", "warn", "stringify", "round", "now", "Date", "keys", "isFinite", "ISOString", "toISOString",
    // fs, restricted to the two writes the report needs
    "mkdirSync", "writeFileSync",
    // object methods on the shadow's own state
    "isFailed", "close", "stats", "readNew", "push",
    // language keywords that take a paren
    "if", "for", "while", "catch", "switch", "return", "typeof", "function",
  ]);
  const calls = new Set();
  /* Strings are stripped first: a log message like "... read failed (mic)" would
   * otherwise register as a call to failed(). The forbidden-symbol checks above
   * run on the RAW text, so stripping here cannot hide a real reference. */
  const codeNoStrings = stripComments(shadowCode).replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g, '""');
  const re = /(?:^|[^\w$.])([A-Za-z_$][\w$]*)\s*\(|\.([A-Za-z_$][\w$]*)\s*\(/g;
  for (const m of codeNoStrings.matchAll(re)) calls.add(m[1] || m[2]);
  const bad = [...calls].filter((c) => !WHITELIST.has(c)).sort();
  console.log(`      calls used: ${[...calls].sort().join(", ")}`);
  ok(bad.length === 0, `calls outside the whitelist: ${bad.join(", ")}`);
  return `${calls.size} distinct calls, all whitelisted`;
});

check("liveVad.js requires nothing that could act on the app", () => {
  const t = fs.readFileSync(LIVEVAD, "utf8");
  const code = stripComments(t);
  const req = [...code.matchAll(/require\("([^"]+)"\)/g)].map((m) => m[1]);
  const bad = req.filter((r) => !["fs", "path", "crypto", "sherpa-onnx-node/vad.js"].includes(r));
  ok(bad.length === 0, `unexpected requires: ${bad.join(", ")}`);
  ok(!/require\("electron"\)/.test(code), "liveVad must not require electron (it must run under plain node)");
  ok(!/notifyUser|ipcMain|webContents|shell\./.test(code), "liveVad must not reference IPC or notifications");
  ok(!/lastLoudAt|lifecycle|autoStop|watchdog/.test(code), "liveVad must not reference the guard (comments naming it are stripped before this check)");
  return `requires: ${req.join(", ")}; no electron, no IPC, no guard symbols (in code)`;
});

/* ------------------------------------------------------------- the call sites */
check("startVadShadow is called exactly once, from record:start", () => {
  eq(countOccurrences(src, "startVadShadow("), 2, "1 declaration + 1 call");
  const callLine = lines.findIndex((l) => /^\s*startVadShadow\(dir\);/.test(l)) + 1;
  ok(callLine > 0, "call site with (dir) not found");
  const recordStart = lines.findIndex((l) => /ipcMain\.handle\("record:start"/.test(l)) + 1;
  const pollLevels = lines.findIndex((l) => /^\s*pollLevels\(\);$/.test(l)) + 1;
  ok(recordStart > 0 && callLine > recordStart, "call is not inside record:start");
  ok(callLine > pollLevels, "call must follow pollLevels() as the spec requires");
  const next = lines[callLine]; // the line after the call
  ok(/return \{ ok: true, dir \}/.test(next), "record:start must still return { ok: true, dir } unchanged");
  return `src/main.js:${callLine}, immediately after pollLevels() at ${pollLevels} (record:start at ${recordStart})`;
});

check("stopVadShadow is called exactly once, from stopRecordingAndProcess", () => {
  eq(countOccurrences(src, "stopVadShadow("), 2, "1 declaration + 1 call");
  const callLine = lines.findIndex((l) => /^\s*stopVadShadow\(\);/.test(l)) + 1;
  ok(callLine > 0, "call site not found");
  const stopFn = lines.findIndex((l) => /^async function stopRecordingAndProcess\(\)/.test(l)) + 1;
  ok(stopFn > 0 && callLine > stopFn, "call is not inside stopRecordingAndProcess");
  /* After every capture process has exited (else the WAV tail is incomplete), and
     before the first pipeline branch. */
  const lastStopCapture = lines.reduce((acc, l, i) => (/await capture\.stopCapture\(r\);/.test(l) ? i + 1 : acc), 0);
  const firstBranch = lines.findIndex((l, i) => i + 1 > callLine && /const profile = await currentProfile/.test(l)) + 1;
  ok(callLine > lastStopCapture, `call at ${callLine} precedes the last capture.stopCapture at ${lastStopCapture}`);
  ok(callLine < firstBranch, `call at ${callLine} must precede the pipeline branch at ${firstBranch}`);
  return `src/main.js:${callLine}, after capture.stopCapture() (${lastStopCapture}) and before the pipeline branch (${firstBranch})`;
});

check("stopPolling() itself is untouched and unaware of the shadow", () => {
  const b = functionBody(src, "stopPolling").body;
  ok(!/vad/i.test(b), "stopPolling must not know about the shadow: " + b.replace(/\s+/g, " "));
  const n = functionBody(src, "stopPolling").line;
  ok(n > 0, "stopPolling not found");
  return `src/main.js:${n}: ${b.replace(/\s+/g, " ").trim()}`;
});

check("the shadow timer array is separate from rec.levelTimers", () => {
  ok(/rec\.vadTimers = timers;/.test(src), "rec.vadTimers assignment missing");
  ok(/for \(const t of rec\.vadTimers \|\| \[\]\) clearInterval\(t\);/.test(src), "teardown missing");
  /* rec is reassigned by object spread on every record:start, so the shadow state
     must be set AFTER that spread (exactly what startVadShadow() does) — assert it
     is not part of the rec literal, which would silently leak across recordings. */
  const literal = src.slice(src.indexOf("rec = { ...rec, ...procs, dir"), src.indexOf("armRecordingGuard()"));
  ok(!/vad/i.test(literal), "shadow state must not ride the rec spread literal");
  return "rec.vadTimers / rec.vadTracks / rec.vadStartedAt / rec.vadModel, set inside startVadShadow()";
});

check("the rec spread in stopRecordingAndProcess still nulls only system/mic", () => {
  ok(/rec\.system = null; rec\.mic = null;/.test(src), "the existing process-handle clearing changed");
  return "rec.system = null; rec.mic = null;  (unchanged)";
});

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"} — exit ${failures === 0 ? 0 : 1}`);
process.exit(failures === 0 ? 0 : 1);
