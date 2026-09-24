"use strict";
/* autoDiarize-test: automatic speaker recognition at the end of the recording
 * pipeline (src/config.js diarize.autoRun, src/diarize.js preflight, the shared
 * runDiarizationForDir + the automatic step in src/main.js).
 *
 * Run: node test/autoDiarize.test.js   (also picked up by test/run.js)
 * Exits 0 on all-pass, non-zero on any failure.
 *
 * WHAT IS EXECUTED AND WHAT IS ONLY READ AS TEXT — stated here on purpose:
 *   - EXECUTED: the config DEFAULTS check, every diarize.preflight() case (real
 *     module, real bundled segmentation model), and the error path of the SHIPPED
 *     runDiarizationForDir / diarizationSource, lifted out of src/main.js source
 *     text (brace-matched, no copy) and run with stubs.
 *   - STATIC (text of src/main.js with regex/indexOf): every wiring check. That is
 *     a deliberate limit, not a shortcut: src/main.js requires electron at its top
 *     and CANNOT be required under plain node (check 18 proves that and prints it).
 * NO NETWORK, no sherpa native module, no meeting audio is needed: preflight is
 * pure by contract and the diarization error path returns before any of that.
 */
const fs = require("fs");
const path = require("path");
const fx = require("./fixtures");

const ROOT = path.join(__dirname, "..");
const SRC = path.join(ROOT, "src");
const config = require(path.join(SRC, "config"));
const diarize = require(path.join(SRC, "diarize"));

const mainSrc = fs.readFileSync(path.join(SRC, "main.js"), "utf8");
const diarizeSrc = fs.readFileSync(path.join(SRC, "diarize.js"), "utf8");

let failures = 0;
/** Awaits the body, so an async check counts exactly once and a rejected promise
 *  is reported as FAIL instead of becoming an unhandled rejection. */
async function check(name, fn) {
  try {
    const info = await fn();
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
function once(needle) { return mainSrc.split(needle).length - 1; }

/* ---- static extractor for the SHIPPED functions ---------------------------
 * Naive brace counting would be fooled by a brace inside a string or a comment
 * (the shipped JSDoc contains `{Promise<{ok:boolean, ...}>}`, whose braces happen
 * to balance), so strings and comments are skipped explicitly. */
function functionSource(text, name) {
  let start = text.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`function ${name} not found in src/main.js`);
  // Keep the `async` keyword: slicing it off yields a body full of `await`.
  if (text.slice(Math.max(0, start - 6), start) === "async ") start -= 6;
  // Start at the brace that OPENS THE BODY, i.e. after the parameter list closes.
  // Taking the first "{" after the name would pick the bracket inside a parameter
  // default and lift a fragment (diarizationSource: nothing vs its for/of arrays).
  const paren = text.indexOf("(", start);
  let d = 0, afterParams = -1;
  for (let i = paren; i < text.length; i++) {
    if (text[i] === "(") d++;
    else if (text[i] === ")") { d--; if (d === 0) { afterParams = i; break; } }
  }
  if (afterParams < 0) throw new Error(`unbalanced parameter list for ${name}`);
  let i = afterParams;
  while (i < text.length && text[i] !== "{") i++;
  let depth = 0;
  for (; i < text.length; i++) {
    const ch = text[i];
    if (ch === "/" && text[i + 1] === "/") { i = text.indexOf("\n", i); if (i < 0) break; continue; }
    if (ch === "/" && text[i + 1] === "*") { i = text.indexOf("*/", i + 2); if (i < 0) break; i++; continue; }
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      for (i++; i < text.length; i++) {
        if (text[i] === "\\") { i++; continue; }
        if (text[i] === quote) break;
      }
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) return text.slice(start, i + 1); }
  }
  throw new Error(`unbalanced braces while lifting ${name}`);
}

/* The two SHIPPED functions, executed below with stubs. */
const runnerSrc = functionSource(mainSrc, "runDiarizationForDir");
const sourceSrc = functionSource(mainSrc, "diarizationSource");

/** Build a real callable from the shipped text. Only the names the shipped code
 *  references are injected; the error path below touches none of the stubs. */
function buildRunner() {
  const fn = new Function("path", "fs", "diarize", "config", "writeSpeakersMeta", "rewriteTranscript",
    "applySpeakerNames", "sherpaAvailable",
    `${sourceSrc}\n${runnerSrc}\nreturn runDiarizationForDir;`);
  return fn(
    path, fs, diarize,
    { modelCacheDir: () => path.join(fx.workRoot(), "autoDiarize-nonexistent-models") },
    () => {}, () => null, () => [], () => true
  );
}

/** An empty directory with nothing in it. NOT fx.workDir() alone: several checks
 *  assert that preflight/the runner create NOTHING, so the emptiness is the point. */
function emptyDir(name) {
  const d = path.join(fx.workRoot(), `autoDiarize-${name}-${process.pid}`);
  fs.rmSync(d, { recursive: true, force: true });
  fs.mkdirSync(d, { recursive: true });
  return d;
}
function entries(d) { return fs.readdirSync(d); }

/* ------------------------------------------------------------------ checks */
async function main() {
  console.log("[test] autoDiarize (automatic speaker recognition at the end of the pipeline)");

  await check("1. config.DEFAULTS.diarize.autoRun === true", () => {
    ok(config.DEFAULTS.diarize, "DEFAULTS.diarize is missing");
    eq(config.DEFAULTS.diarize.autoRun, true, "DEFAULTS.diarize.autoRun");
    return `DEFAULTS.diarize = ${JSON.stringify(config.DEFAULTS.diarize)}`;
  });

  await check("2. preflight: sherpaReady:false -> ok:false, missing:'sherpa', reason mentions sherpa", () => {
    const st = diarize.preflight({ sherpaReady: false });
    eq(st.ok, false, "ok");
    eq(st.missing, "sherpa", "missing (machine-readable)");
    ok(typeof st.reason === "string" && /sherpa/.test(st.reason), `reason must mention sherpa, got ${JSON.stringify(st.reason)}`);
    return `{ ok: ${st.ok}, missing: ${JSON.stringify(st.missing)}, reason: ${JSON.stringify(st.reason)} }`;
  });

  await check("3. preflight: no sherpaReady field at all -> missing:'sherpa', reason says 未检测", () => {
    const st = diarize.preflight({});
    eq(st.ok, false, "ok");
    eq(st.missing, "sherpa", "missing");
    ok(/sherpa/.test(st.reason) && /未检测/.test(st.reason), `reason: ${JSON.stringify(st.reason)}`);
    return `{ ok: ${st.ok}, missing: ${JSON.stringify(st.missing)}, reason: ${JSON.stringify(st.reason)} }`;
  });

  await check("4. preflight: nothing anywhere -> ok:false, missing:'embedding' (download path intact)", () => {
    // Since the voiceprint model SHIPS inside the app, an empty modelDir is no longer
    // "not ready" on its own — the bundled copy satisfies it. To exercise the
    // genuinely-absent case, point the bundled lookup at a path that does not exist.
    // This is what keeps the download fallback reachable and tested.
    const d = emptyDir("empty-modeldir");
    const st = diarize.preflight({ modelDir: d, sherpaReady: true, bundledModelPath: path.join(d, "no-such-bundled.onnx") });
    eq(st.ok, false, "ok");
    eq(st.missing, "embedding", "missing");
    eq(st.reason, "声纹模型尚未下载（首次识别需要下载约 27 MB）", "reason");
    ok(entries(d).length === 0, `nothing may be created, found ${JSON.stringify(entries(d))}`);
    return `dir ${d} (no bundled copy): { ok: ${st.ok}, missing: ${JSON.stringify(st.missing)}, reason: ${JSON.stringify(st.reason)} }`;
  });

  await check("4a. preflight: THE BUNDLED MODEL makes a fresh install ready with no cache", () => {
    // The real-world fresh install: no per-user cache, but the shipped model exists.
    // This is the behaviour that removes the first-run download requirement.
    const d = emptyDir("bundled-only");
    const st = diarize.preflight({ modelDir: d, sherpaReady: true });
    eq(st.ok, true, "ok (bundled model must satisfy preflight)");
    eq(st.missing, null, "missing");
    const bundled = diarize.bundledEmbeddingModelPath();
    ok(fs.existsSync(bundled), `the bundled voiceprint model must exist at ${bundled}`);
    const sz = fs.statSync(bundled).size;
    ok(sz > diarize.EMBEDDING_BYTES * 0.9, `bundled model too small: ${sz} vs EMBEDDING_BYTES ${diarize.EMBEDDING_BYTES}`);
    const ms = diarize.modelsStatus(d);
    eq(ms.embedding.source, "bundled", "modelsStatus.embedding.source");
    eq(ms.embedding.downloaded, false, "downloaded must be false (nothing in the per-user cache)");
    eq(ms.embedding.ready, true, "ready");
    eq(ms.embedding.resolvedPath, bundled, "resolvedPath must be the bundled file");
    return `bundled ${sz} bytes == EMBEDDING_BYTES ${diarize.EMBEDDING_BYTES}; { ok: ${st.ok}, source: ${ms.embedding.source}, downloaded: ${ms.embedding.downloaded} }`;
  });

  await check("4b. preflight: ok:true -> missing === null and reason === null", () => {
    // Reaching ok:true needs no network: a stand-in file of the right SIZE in the
    // documented modelDir layout satisfies the same statSync check as the real one.
    const d = emptyDir("full-modeldir");
    const emb = diarize.embeddingModelPath(d);
    fs.mkdirSync(path.dirname(emb), { recursive: true });
    fs.writeFileSync(emb, Buffer.alloc(diarize.EMBEDDING_BYTES)); // threshold is 0.9x
    const st = diarize.preflight({ modelDir: d, sherpaReady: true });
    eq(st.missing, null, `missing must be null when ok (reason=${JSON.stringify(st.reason)})`);
    eq(st.ok, true, "ok");
    eq(st.reason, null, "reason");
    return `{ ok: ${st.ok}, missing: ${JSON.stringify(st.missing)}, reason: ${JSON.stringify(st.reason)} }`;
  });

  await check("4c. preflight: the PER-USER CACHE wins over the bundled copy", () => {
    // Resolution order matters: a user who clicked 下载 must be running what they
    // downloaded, and 删除 must therefore mean something.
    const d = emptyDir("cache-beats-bundle");
    const fakeBundled = path.join(d, "bundled-standin.onnx");
    fs.writeFileSync(fakeBundled, Buffer.alloc(diarize.EMBEDDING_BYTES));
    const user = diarize.embeddingModelPath(d);
    fs.mkdirSync(path.dirname(user), { recursive: true });
    fs.writeFileSync(user, Buffer.alloc(diarize.EMBEDDING_BYTES));
    const ms = diarize.modelsStatus(d, { bundledModelPath: fakeBundled });
    eq(ms.embedding.source, "downloaded", "source");
    eq(ms.embedding.downloaded, true, "downloaded");
    eq(ms.embedding.resolvedPath, user, "resolvedPath must be the per-user copy");
    return `source=${ms.embedding.source}, resolved = per-user cache (not the bundle)`;
  });

  await check("5. preflight: missing embedding model -> ok:false, reason is the exact 声纹模型 one", () => {
    const d = emptyDir("no-embedding-modeldir");
    const st = diarize.preflight({ modelDir: d, sherpaReady: true, bundledModelPath: path.join(d, "absent.onnx") });
    eq(st.ok, false, "ok");
    // The automatic step routes on this EXACT string (src/main.js), so it must not drift.
    eq(st.reason, "声纹模型尚未下载（首次识别需要下载约 27 MB）", "reason");
    const seg = diarize.segmentationModelPath();
    ok(fs.existsSync(seg), `the bundled segmentation model must exist at ${seg}`);
    return `reason ${JSON.stringify(st.reason)}\n      bundled segmentation model present: ${fs.statSync(seg).size} bytes`;
  });

  await check("6. preflight NEVER throws (malformed modelDir degrades to a verdict)", () => {
    /* Contract: never throws. `modelDir` is documented as a string, but a malformed
     * value must not take the pipeline down with it — the automatic step runs inside
     * stopRecordingAndProcess(), where a throw would cost the user their notes. Since
     * resolution now runs through resolveEmbeddingModel/embeddingReady, a type error
     * from path.join is absorbed and reported as "missing" instead of propagating.
     * (This is STRONGER than the previous behaviour, which let `modelDir: 42` and
     * `null` escape as exceptions; those are asserted below as no-throw too.) */
    const cases = [undefined, {}, null, 42, "Z:\\no\\such\\dir",
      { modelDir: "Z:\\no\\such\\dir", sherpaReady: true },
      { modelDir: "", sherpaReady: true },
      { modelDir: 42, sherpaReady: true },
      { modelDir: null, sherpaReady: true },
      { sherpaReady: 0 }];
    const out = [];
    for (const c of cases) {
      let st = null, msg = null;
      try { st = diarize.preflight(c); } catch (e) { msg = e.message; }
      ok(msg === null, `preflight(${JSON.stringify(c)}) must not throw, threw: ${msg}`);
      ok(st && typeof st === "object", `preflight(${JSON.stringify(c)}) must return an object`);
      ok(typeof st.ok === "boolean", `preflight(${JSON.stringify(c)}).ok must be a boolean`);
      // every verdict must be actionable: ok, or a failure carrying both a
      // machine-readable class and a user-facing reason
      if (!st.ok) {
        ok(typeof st.missing === "string" && st.missing.length > 0, `a failed preflight needs \`missing\` (${JSON.stringify(c)})`);
        ok(typeof st.reason === "string" && st.reason.length > 0, `a failed preflight needs a reason (${JSON.stringify(c)})`);
      }
      out.push(`${JSON.stringify(c)} -> ok:${st.ok}${st.ok ? "" : "/" + st.missing}`);
    }
    /* Boot-path guard: the app's real boot call passes a NON-EXISTENT per-user cache
     * dir. That must resolve to the bundled model (ok:true) — not throw, and not join
     * a bogus value into a path. */
    const boot = diarize.preflight({ modelDir: path.join(fx.workRoot(), "autoDiarize-never-created"), sherpaReady: true });
    ok(boot.ok === true, `the boot-path call (non-existent cache dir) must resolve to the bundled model, got ${JSON.stringify(boot)}`);
    return out.join("   ") + "\n      boot path -> ok:" + boot.ok + " (bundled)";
  });

  await check("7. preflight does NOT create or download the embedding model (temp dir still empty)", () => {
    const d = emptyDir("no-download");
    // bundled path deliberately absent, so preflight reports "missing" — and, crucially,
    // must still fetch nothing and write nothing on its way to that verdict.
    const st = diarize.preflight({ modelDir: d, sherpaReady: true, bundledModelPath: path.join(d, "absent.onnx") });
    eq(st.ok, false, "ok (nothing is installed in the temp dir)");
    eq(entries(d), [], `modelDir must stay empty, found: ${JSON.stringify(entries(d))}`);
    const emb = diarize.embeddingModelPath(d);
    ok(!fs.existsSync(emb), `no embedding model may be written: ${emb}`);
    return `dir ${d} still empty; no .part file, no speaker/ subdir, no ${path.basename(emb)}`;
  });

  await check("8. STATIC: preflight never FETCHES a model", () => {
    const start = diarizeSrc.indexOf("function preflight(");
    const end = diarizeSrc.indexOf("\nfunction download(", start);
    ok(start >= 0 && end > start, "preflight body not found in src/diarize.js");
    const body = diarizeSrc.slice(start, end);
    /* The load-bearing invariant is "preflight performs no fetch". It legitimately
     * READS the per-user download location (embeddingModelPath) and the bundled copy,
     * so a blanket /download/ ban — the previous form of this check — now fails for a
     * correct implementation. Assert the real thing instead: no fetch call, and no
     * network module. */
    ok(!/ensureEmbeddingModel/.test(body), "preflight must NOT call ensureEmbeddingModel");
    ok(!/\bhttps\b|require\(.https.\)|\bfetch\s*\(/.test(body), "preflight must NOT touch the network");
    ok(/resolveEmbeddingModel/.test(body), "preflight must resolve through resolveEmbeddingModel (bundle-aware)");
    const outside = diarizeSrc.split("function preflight(")[1].split("\nfunction download(")[1];
    ok(/ensureEmbeddingModel/.test(outside), "diarize() must still own ensureEmbeddingModel");
    return `preflight body is ${body.split("\n").length} lines: resolves (incl. the bundle), fetches nothing`;
  });

  await check("9. STATIC/EXECUTED: preflight is exported and diarize() still owns the download", () => {
    eq(typeof diarize.preflight, "function", "module.exports.preflight");
    const diarizeFn = diarizeSrc.slice(diarizeSrc.indexOf("async function diarize("), diarizeSrc.indexOf("async function buildSamples("));
    ok(/await ensureEmbeddingModel\(modelDir, onProgress\)/.test(diarizeFn), "diarize() must still call ensureEmbeddingModel(modelDir, onProgress)");
    return "typeof preflight === 'function'; diarize() -> await ensureEmbeddingModel(modelDir, onProgress)";
  });

  await check("10. STATIC: runDiarizationForDir defined once, referenced 3x (decl + manual + auto)", () => {
    const defs = once("async function runDiarizationForDir(");
    const refs = once("runDiarizationForDir(");
    eq(defs, 1, "definitions of runDiarizationForDir");
    ok(refs >= 3, `expected the declaration + the manual handler + the automatic step, found ${refs} occurrences`);
    return `definitions=${defs}  references=${refs} (1 declaration + ${refs - 1} call sites)`;
  });

  await check("11. STATIC: the automatic step exists and is the LAST step before Done", () => {
    const iStart = mainSrc.indexOf("自动识别发言人（本地 CPU，长会议需要几分钟）…");
    const iSkip = mainSrc.indexOf("跳过自动识别发言人");
    const iDone = mainSrc.indexOf('send("pipeline", { phase: "done", message: "Done", dir });');
    const iArtifacts = mainSrc.indexOf("meetings.writeArtifacts(dir, { transcript, notes, meta });");
    ok(mainSrc.indexOf("自动识别发言人") >= 0, "the string 自动识别发言人 is missing from src/main.js");
    ok(iStart >= 0, 'the start message "自动识别发言人（本地 CPU，长会议需要几分钟）…" is missing');
    ok(iSkip >= 0, "the 跳过自动识别发言人 skip path is missing");
    ok(iArtifacts >= 0 && iDone >= 0, "writeArtifacts / Done anchors not found");
    ok(iArtifacts < iStart, "the diarization step must come AFTER meetings.writeArtifacts");
    ok(iStart < iDone, "the diarization step must come BEFORE the Done event");
    return `writeArtifacts@${iArtifacts} < 自动识别@${iStart} < Done@${iDone}, skip path@${iSkip}`;
  });

  await check("12. STATIC: the auto path announces the ~27 MB download instead of running it silently", () => {
    ok(mainSrc.indexOf("声纹模型") >= 0, "src/main.js must mention 声纹模型");
    const announce = "下载声纹模型（约 27 MB）";
    ok(mainSrc.indexOf(announce) >= 0, `src/main.js must contain ${announce}`);
    const cb = mainSrc.indexOf('p.phase === "download-start" || p.phase === "downloading"');
    ok(cb >= 0, 'the progress callback must handle "download-start" and "downloading"');
    return `announcement@${mainSrc.indexOf(announce)}, handles download-start + downloading@${cb}`;
  });

  await check("13. STATIC: a missing embedding model is a SKIP only when autoDownload is off", () => {
    const iPre = mainSrc.indexOf("const st = diarize.preflight({ modelDir: config.modelCacheDir(acfg), sherpaReady: sherpaAvailable() });");
    ok(iPre >= 0, "the automatic preflight call (with acfg) is missing");
    const iRunner = mainSrc.indexOf("await runDiarizationForDir(dir, acfg");
    ok(iRunner > iPre, "runDiarizationForDir(dir, acfg, ...) must be reached from the automatic step");
    const step = mainSrc.slice(iPre, iRunner);
    // THE EMBEDDING CASE IS DECIDED BY THE MACHINE-READABLE FIELD, not UI copy.
    ok(step.indexOf('st.missing !== "embedding"') >= 0, 'the auto step must branch on st.missing !== "embedding"');
    ok(step.indexOf("声纹模型尚未下载（首次识别需要下载约 27 MB）") < 0, "the auto step must NOT compare st.reason against the Chinese message");
    ok(/acfg\.whisper\.autoDownload === false/.test(step), "autoDownload === false must be checked before skipping");
    ok(/声纹模型尚未下载（自动下载已关闭）/.test(step), "the autoDownload-off skip reason is missing");
    ok(/声纹模型尚未下载，请在「模型与接口」页点下载/.test(step), "the autoDownload-off pipeline message is missing");
    return `preflight@${iPre} ... runDiarizationForDir@${iRunner}: routed via st.missing, autoDownload === false -> skip, else proceed`;
  });

  await check("13b. STATIC: every automatic skip records diarizationSkip (never a silent success)", () => {
    const iPre = mainSrc.indexOf("const st = diarize.preflight({ modelDir: config.modelCacheDir(acfg), sherpaReady: sherpaAvailable() });");
    const iRunner = mainSrc.indexOf("await runDiarizationForDir(dir, acfg");
    const step = mainSrc.slice(iPre, iRunner);
    // The download-disabled case used to send a message while leaving the return
    // value claiming nothing went wrong.
    const iSkipAssign = step.indexOf("diarizationSkip = skipReason;");
    const iAutoOff = step.indexOf("声纹模型尚未下载（自动下载已关闭）");
    ok(iAutoOff >= 0, "the autoDownload-off branch is missing");
    ok(iSkipAssign >= 0, "the automatic skip must set diarizationSkip");
    const iSend = step.indexOf("send(\"pipeline\", { phase: \"diarizing\", message: msg });");
    ok(iSend > iSkipAssign, "diarizationSkip must be set BEFORE the skip is announced");
    ok(/diarizationError: diarizationSkip \|\| null,/.test(mainSrc), "diarizationError must surface the skip in the return value");
    return `diarizationSkip set@${iSkipAssign}, announced@${iSend}; autoDownload-off reason@${iAutoOff}`;
  });

  await check("13c. STATIC: the manual handler still threads its threshold into the runner", () => {
    ok(mainSrc.indexOf("runDiarizationForDir(dir, config.load(), (p) => {") >= 0, "the manual call site changed shape");
    ok(mainSrc.indexOf("}, threshold);") >= 0, "the manual threshold argument is missing");
    ok(/async function runDiarizationForDir\(dir, cfg, onProgress, threshold\)/.test(mainSrc), "the runner must accept a threshold parameter");
    ok(/threshold: Number\(threshold\) \|\| diarize\.DEFAULT_THRESHOLD,/.test(mainSrc), "the runner must honour the caller threshold (falling back to the default)");
    // the automatic call site stays at three arguments, i.e. on the default
    ok(mainSrc.indexOf("await runDiarizationForDir(dir, acfg, (p) => {") >= 0, "the automatic call site must keep passing no threshold");
    return "manual: (dir, config.load(), onProgress, threshold) -> Number(threshold) || DEFAULT_THRESHOLD; automatic: default";
  });

  await check("14. STATIC: the autoRun switch is read once and gates the whole step", () => {
    const iSwitch = mainSrc.indexOf("if (!(acfg.diarize && acfg.diarize.autoRun))");
    ok(iSwitch >= 0, "the acfg.diarize.autoRun bail-out is missing");
    ok(mainSrc.indexOf('skipReason = "已关闭自动识别发言人";') > iSwitch, "the disabled reason (已关闭自动识别发言人) is missing");
    ok(mainSrc.split("const acfg = config.load();").length - 1 === 1, "acfg must be loaded exactly once");
    return `autoRun gate@${iSwitch}, acfg loaded once`;
  });

  await check("15. STATIC: closure variables are declared before the meta/return that uses them", () => {
    const iDecl = mainSrc.indexOf("let diarization = null;");
    const iSkipDecl = mainSrc.indexOf("let diarizationSkip = null;");
    ok(iDecl >= 0 && iSkipDecl >= 0, "let diarization / let diarizationSkip not found");
    const iWrite = mainSrc.indexOf("meetings.writeArtifacts(dir, { transcript, notes, meta });");
    ok(iDecl < iWrite, "diarization must be declared before writeArtifacts (it feeds meta)");
    return `let diarization@${iDecl}, let diarizationSkip@${iSkipDecl}, writeArtifacts@${iWrite}`;
  });

  await check("16. STATIC: the pipeline return object hands the panel its speakers + chunks", () => {
    // Anchor on the success return's OWN first line (the deferred/error returns
    // start differently), then take the slice that carries the three new keys.
    const fn = functionSource(mainSrc, "stopRecordingAndProcess");
    const anchor = "      ok: true, dir, notes: notes.text, notesZh: notes.zh || null,";
    const iAnchor = fn.indexOf(anchor);
    ok(iAnchor >= 0, "the success return object of stopRecordingAndProcess not found");
    const iSpeakers = fn.indexOf("      speakers: diarization ? diarization.speakers : [],", iAnchor);
    const iChunks = fn.indexOf("      chunks: diarization && diarization.chunks ? diarization.chunks : transcript.chunks,", iAnchor);
    const iErr = fn.indexOf("      diarizationError: diarizationSkip || null,", iAnchor);
    const iEnd = fn.indexOf("      participants: participantResult", iAnchor);
    ok(iEnd > iAnchor, "the end of the return object (participants:) was not found");
    ok(iSpeakers > iAnchor && iSpeakers < iEnd, "speakers: key missing from the return object");
    ok(iChunks > iAnchor && iChunks < iEnd, "chunks: key missing/not the diarization-aware one");
    /* audioStats must come BACK to the renderer, not only be written to meta.json.
     * The result panel uses it to report a track that recorded nothing (peakDbfs /
     * activePercent); without this key the warning silently never fires. Caught by
     * reading the return object rather than assuming the meta write was enough. */
    const iStats = fn.indexOf("      audioStats: transcript.audioStats || null,", iAnchor);
    ok(iStats > iAnchor && iStats < iEnd,
      "audioStats: missing from the renderer-facing return — the silent-track warning depends on it");
    ok(iErr > iAnchor && iErr < iEnd, "diarizationError: key missing");
    const body = fn.slice(iAnchor, iEnd);
    eq((body.match(/^\s*chunks:/gm) || []).length, 1, "the return object must carry exactly ONE chunks: key");
    ok(/      diarization: diarization \? \{ speakers: diarization\.speakers\.length, source: diarization\.source, threshold: diarization\.threshold \} : null,/.test(fn), "meta.diarization summary missing");
    return `return object @${iAnchor}: speakers ✓, chunks (single) ✓, diarizationError ✓; meta.diarization summary ✓`;
  });

  await check("17. STATIC: writeSpeakersMeta is called from runDiarizationForDir (skip => labels intact)", () => {
    ok(/writeSpeakersMeta\(dir, speakers\);/.test(runnerSrc), "runDiarizationForDir must call writeSpeakersMeta(dir, speakers)");
    eq(once("function writeSpeakersMeta("), 1, "writeSpeakersMeta definitions");
    const iRunnerDef = mainSrc.indexOf("async function runDiarizationForDir(");
    const iRunnerEnd = iRunnerDef + runnerSrc.length;
    ok(iRunnerDef >= 0, "the runDiarizationForDir definition was not found");
    // Layout-tolerant: the automatic skip announcement was reworded once already and
    // now sends a computed `msg`, so anchor on its PREFIX (the skip log line, which
    // is emitted on every skip path), never on one whole send(...) sentence.
    const iSkipBranch = mainSrc.search(/console\.log\("\[diarize\] 跳过自动识别发言人："/);
    ok(iSkipBranch >= 0, "the automatic skip announcement was not found");
    ok(iSkipBranch < iRunnerDef, "the skip path must sit BEFORE the runner it declines to call");
    // THE INVARIANT: the auto-path write is the one inside the runner body. The other
    // two call sites belong to user-initiated handlers (speakers:setName,
    // participants:edit) and cannot run as part of the automatic pipeline.
    // NOTE: the DEFINITION line (`function writeSpeakersMeta(dir, speakers) {`) also
    // matches the needle, so the scan starts after it.
    const iDef = mainSrc.indexOf("function writeSpeakersMeta(dir,");
    const iDefLineEnd = mainSrc.indexOf("\n", iDef);
    const sites = [];
    for (let i = mainSrc.indexOf("writeSpeakersMeta(dir,", iDefLineEnd); i >= 0; i = mainSrc.indexOf("writeSpeakersMeta(dir,", i + 1)) sites.push(i);
    eq(sites.length, 3, "expected 3 CALL sites (1 in the runner + 2 in user-initiated handlers)");
    const inRunner = sites.filter((i) => i > iRunnerDef && i < iRunnerEnd);
    eq(inRunner.length, 1, "exactly ONE auto-path write, and it is inside runDiarizationForDir");
    ok(sites[0] === inRunner[0], "the runner's write must be the first call site (the pipeline precedes the handlers)");
    // A skipped run never reaches the runner, so meta.speakerLabels keeps the
    // ["你", "远端"] pair written by writeArtifacts — no CALL site may lie between
    // the skip announcement and the runner. (The slice legitimately contains the
    // `function writeSpeakersMeta(...)` DEFINITION, which is why this scans for
    // call sites instead of grepping for the bare name.)
    const onSkipPath = sites.filter((i) => i > iSkipBranch && i < iRunnerDef);
    eq(onSkipPath.length, 0, `the skip path must not write speakers meta, found ${onSkipPath.length} call site(s)`);
    return `runner@${iRunnerDef}..${iRunnerEnd}, its write@${inRunner[0]}; skip announce@${iSkipBranch} (< runner, 0 call sites on the skip path); total call sites=${sites.length}, inside runner=${inRunner.length}`;
  });

  await check("18. EXECUTED: runDiarizationForDir(dir with no audio) -> { ok:false } + Chinese error", () => {
    const d = emptyDir("no-audio-meeting");
    const runner = buildRunner();
    // The shipped function is async; check() awaits whatever the body returns.
    return runner(d, config.DEFAULTS, undefined).then((res) => {
      eq(res.ok, false, "ok");
      eq(res.error, "找不到可用于声纹分析的音频（system/mixed 都不存在）", "error");
      eq(entries(d), [], `the meeting dir must stay untouched, found: ${JSON.stringify(entries(d))}`);
      return `empty dir -> ${JSON.stringify(res)}   (dir still empty: ${entries(d).length} entries)`;
    });
  });

  await check("19. prove src/main.js CANNOT be required here (so 10-17 stay static)", () => {
    let msg = null;
    try { require(path.join(SRC, "main.js")); } catch (e) { msg = e.message; }
    ok(msg !== null, "main.js was REQUIRED successfully — every static check above could be upgraded to a real call");
    return `require("src/main.js") throws as expected: ${String(msg).split("\n")[0]}`;
  });

  await check("20. BUNDLE: the voiceprint model ships inside the app and is packaged", () => {
    /* This is what removes the first-run network dependency. If any of these break,
     * a fresh install silently goes back to needing a 27 MB download. */
    const model = diarize.bundledEmbeddingModelPath();
    ok(fs.existsSync(model), `bundled model missing: ${model}`);
    const sz = fs.statSync(model).size;
    eq(sz, diarize.EMBEDDING_BYTES, "bundled model size must equal EMBEDDING_BYTES exactly");
    const pkg = JSON.parse(fs.readFileSync(path.join(SRC, "..", "package.json"), "utf8"));
    const files = (pkg.build && pkg.build.files) || [];
    const unpack = (pkg.build && pkg.build.asarUnpack) || [];
    ok(files.includes("assets/**"), `package.json build.files must include "assets/**", got ${JSON.stringify(files)}`);
    ok(unpack.some((g) => /assets\/models/.test(g)), `asarUnpack must cover assets/models, got ${JSON.stringify(unpack)}`);
    // Apache-2.0 §4(a) requires the licence to travel with the redistributed Work.
    const lic = path.join(path.dirname(model), "LICENSE-3d-speaker-campplus.txt");
    ok(fs.existsSync(lic), `the Apache-2.0 licence must ship beside the model: ${lic}`);
    const licText = fs.readFileSync(lic, "utf8");
    ok(/Apache License/.test(licText), "the licence file must contain the Apache License text");
    return `${sz} bytes bundled; files includes assets/**; asarUnpack covers assets/models; Apache-2.0 licence present (${licText.length} bytes)`;
  });

  await check("21. STATIC: deleteVoiceprint removes ONLY the per-user cache", () => {
    /* Guard against a real footgun introduced by bundling: voiceprintStatus().path
     * used to be the download location, but resolution now falls back to the BUNDLED
     * copy. If deleteVoiceprint ever targets the RESOLVED path again, 删除 would try
     * to remove the shipped model (inside app.asar.unpacked in a packaged build). */
    const src = fs.readFileSync(path.join(SRC, "models.js"), "utf8");
    const start = src.indexOf("function deleteVoiceprint(");
    ok(start >= 0, "deleteVoiceprint not found in src/models.js");
    const body = src.slice(start, src.indexOf("\n}", start));
    ok(/diarize\.embeddingModelPath\(cacheDir\)/.test(body), "deleteVoiceprint must use the UNRESOLVED per-user path");
    ok(!/resolvedPath/.test(body), "deleteVoiceprint must NOT use a resolved path (it can be the bundled model)");
    // and it must be executable logic, not just text: deleting a stand-in cache file
    // leaves the bundled model on disk untouched.
    const models = require(path.join(SRC, "models.js"));
    const d = emptyDir("delete-voiceprint");
    const user = diarize.embeddingModelPath(d);
    fs.mkdirSync(path.dirname(user), { recursive: true });
    fs.writeFileSync(user, Buffer.alloc(diarize.EMBEDDING_BYTES)); // a stand-in "downloaded" copy
    const r = models.deleteVoiceprint(d);
    eq(r.ok, true, "deleteVoiceprint().ok");
    ok(!fs.existsSync(user), "the per-user cache file must be gone");
    ok(fs.existsSync(diarize.bundledEmbeddingModelPath()), "the BUNDLED model must be untouched");
    return `removed ${path.basename(r.removed)}; bundled model intact`;
  });

  await check("22. STATIC: Chromium sandbox is disabled by default, with an opt-out", () => {
    /* Startup regression guard. On the owner's machine (Windows 11 26200) the packaged
     * app aborted during startup with 0x80000003 before any window; bisecting launch
     * flags showed --no-sandbox was the one that fixed it, i.e. Chromium's sandbox
     * could not initialise. The switch MUST be appended before the app is ready —
     * appending it later, or from the renderer, does nothing — so this pins both the
     * call and its position.
     *
     * The patterns deliberately avoid the bare word "no-sandbox": it appears in the
     * explanatory comment above the code, so a check that matched the comment would
     * still pass with the real call deleted. */
    /* Look for the call on a line that is NOT a comment. A plain regex search over
     * the whole file matches the explanatory comment above the code (and a
     * commented-out call), which a mutation test proved: commenting the real line out
     * still passed. So scan line by line and reject comment lines. */
    const mainLines = mainSrc.split(/\r?\n/);
    let appendLine = -1, appendOffset = -1, running = 0;
    for (let i = 0; i < mainLines.length; i++) {
      const raw = mainLines[i];
      const code = raw.replace(/\/\/.*$/, "");        // drop trailing line comments
      if (/^\s*(\/\/|\*|\/\*)/.test(raw)) { running += raw.length + 1; continue; }  // whole-line comment
      if (/app\.commandLine\.appendSwitch\(\s*"no-sandbox"\s*\)/.test(code)) { appendLine = i + 1; appendOffset = running; break; }
      running += raw.length + 1;
    }
    ok(appendLine > 0, "app.commandLine.appendSwitch for the sandbox must exist as UNCOMMENTED code (a commented-out line does not count)");
    ok(mainSrc.includes('process.env.A2N_SANDBOX === "1"'), "the A2N_SANDBOX=1 opt-out must be honoured");
    ok(mainSrc.includes('process.argv.includes("--enable-sandbox")'), "the --enable-sandbox opt-out must be honoured");
    const optIn = mainSrc.indexOf("SANDBOX_OPT_IN");
    const appRequire = mainSrc.indexOf('require("electron")');
    const readyHandler = mainSrc.indexOf("app.whenReady()");
    ok(optIn >= 0, "the SANDBOX_OPT_IN opt-out branch must exist");
    ok(appRequire >= 0 && readyHandler > 0, "electron require / whenReady anchors not found");
    ok(appendOffset > appRequire, "the switch must be appended after `app` is available");
    ok(appendOffset < readyHandler, "the switch must be appended BEFORE app.whenReady(), or it has no effect");
    ok(optIn < appendOffset, "the append must be guarded by the opt-out branch, so the opt-out can win");
    return `appendSwitch at main.js:${appendLine} (offset ${appendOffset}, between require@${appRequire} and whenReady@${readyHandler}); opt-out: A2N_SANDBOX=1 / --enable-sandbox`;
  });

  console.log(failures ? `\n${failures} CHECK(S) FAILED` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
}

main();
