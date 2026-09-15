"use strict";
/* Does ONE recording's translate + notes phase really use ONE `num_ctx`?
 *
 * Regression harness for BACKLOG.md §11.4. Ollama reloads the whole 17.3 GB model
 * whenever the served context size changes, and `ctxFor()` used to choose a context
 * per request from [4096 … 131072]; `translate.js` sent none at all, so it ran at
 * Ollama's default. Measured live in %LOCALAPPDATA%\Ollama\server.log: a runner with
 * context_length = 8192, then a second one started with `-c 65536`.
 *
 * What this does: it replaces the global `fetch` (the only transport either module
 * uses — both go through their own `httpJson()`), so it records the `num_ctx` of
 * EVERY request a full simulated run would make: the transcript batches, every map
 * chunk, every merge, the final pass, and the notes translation. Then it asserts
 *
 *   (i)  all of them are identical — one model load for the run, and
 *   (ii) each is >= ctxFor(promptChars, numPredict) for THAT request — so the pin
 *        can never truncate a prompt (the failure mode that lost most of a
 *        224-minute meeting, see the summarize.js header),
 *   (iii) none is left at Ollama's default, and
 *   (iv) the pin never had to be raised mid-run (a raise = one extra reload).
 *
 * Checking only the first call is not enough: the whole point is that the map, the
 * merge and the final pass of the SAME run agree.
 *
 * Run: node test/numctx-pin.test.js        (exits 0 when everything holds)
 *      node .scratch/numctx-pin.harness.js (same harness; see that file)
 * No fixtures and no Ollama needed — the HTTP layer is faked. */

const path = require("path");
const ROOT = path.join(__dirname, "..");
const summarize = require(path.join(ROOT, "src", "summarize"));
const translate = require(path.join(ROOT, "src", "translate"));
const ctxPin = require(path.join(ROOT, "src", "ctxPin"));

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`PASS  ${name}`);
  else {
    failures++;
    console.log(`FAIL  ${name}\n      ${detail || ""}`);
  }
}

/* ---- fake HTTP layer ------------------------------------------------------ */

let seen = [];

/* The fake model's answer sizes are settable so one scenario can force the run to
 * its WORST-CASE shape: extracts big enough that the final pass really does hit the
 * 80 000-char input cap the pinned context is sized from. */
let answerSizes = { map: 2200, merge: 1200 };

const MAP_HEAD =
  "## Points\n- Alice: ship the archive rewrite and re-check the numbers before Friday; the 629 s recording took 9 minutes.\n" +
  "- Bob: the reload is caused by a context change, not by the prompt size.\n";
const MERGE_HEAD = "## Points\n- merged: pin one context per run\n";
const FINAL_ANSWER =
  "## Summary\nThe team pinned one context per run so the model stops reloading.\n\n" +
  "## Key Points\n- pin num_ctx once per recording\n\n## Decisions\n- pinned at the plan maximum\n\n" +
  "## Action Items\n- [ ] Alice: verify against server.log\n\n## Open Questions\n- None.\n";
const TRANSLATE_ANSWER = "1. 这是第一行翻译。\n2. 这是第二行翻译。\n";

function answerFor(stage) {
  if (stage === "translate") return TRANSLATE_ANSWER;
  if (stage === "map") return MAP_HEAD + "\n".padEnd(answerSizes.map, "x");
  if (stage === "merge") return MERGE_HEAD + "\n".padEnd(answerSizes.merge, "y");
  return FINAL_ANSWER;
}

/** Which stage sent this request — read off the system/user text, no guessing. */
function stageOf(system, user) {
  if (system.startsWith("You are a professional translator")) return "translate";
  if (system.includes("ONE part of a longer meeting transcript")) return "map";
  if (system.startsWith("You merge several sets of meeting notes")) return "merge";
  return "final";
}

function installFakeOllama() {
  global.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    const msgs = body.messages || [];
    const systemChars = String((msgs[0] && msgs[0].content) || "").length;
    const userChars = String((msgs[1] && msgs[1].content) || "").length;
    const stage = stageOf(msgs[0] ? msgs[0].content : "", msgs[1] ? msgs[1].content : "");
    seen.push({
      stage,
      numCtx: body.options ? body.options.num_ctx : undefined,
      numPredict: body.options ? body.options.num_predict : undefined,
      promptChars: systemChars + userChars,
      systemChars,
      userChars,
    });
    const content = answerFor(stage);
    return {
      ok: true,
      status: 200,
      text: async () => "",
      json: async () => ({ message: { content }, done_reason: "stop", prompt_eval_count: 100, eval_count: 100 }),
    };
  };
}

/* ---- a config shaped like src/config.js DEFAULTS -------------------------- */
/* (src/config.js itself requires electron, which the sandbox cannot load, so the
 *  two blocks the pipeline reads are rebuilt here.) */
function makeCfg({ transcript, detailLevel = "standard", translateTranscript = false, translateNotes = true }) {
  return {
    notes: {
      provider: "ollama",
      detailLevel,
      ollama: { baseUrl: "http://127.0.0.1:11434", model: "test-model", think: false },
      openai: { baseUrl: "https://api.openai.com/v1", apiKey: "", model: "gpt-4o-mini" },
    },
    translation: {
      enabled: translateNotes,
      transcript: translateTranscript,
      engine: "ollama",
      ollama: { baseUrl: "http://127.0.0.1:11434", model: "test-model" },
      openai: { baseUrl: "https://api.openai.com/v1", apiKey: "", model: "gpt-4o-mini" },
    },
  };
}

function makeTranscript(chars) {
  const line = "[Alice] we should ship the archive rewrite and re-check the numbers before Friday 08:50.";
  const lines = [];
  let n = 0;
  while (n < chars) {
    lines.push(line);
    n += line.length + 1;
  }
  return lines.join("\n");
}

/** One recording's translate + notes phase, exactly as main.js orders it. */
async function runPhase(cfg, transcript, { translateTranscript }) {
  seen = [];
  const segments = transcript.split("\n").map((t, i) => ({ text: t, start: i, end: i + 1 }));
  if (translateTranscript) await translate.translateChunks(segments, cfg, () => {});
  const notes = await summarize.summarize(transcript, cfg, () => {});
  if (cfg.translation.enabled && !translate.looksChinese(notes.text)) await translate.translateText(notes.text, cfg);
  return { notes, stats: ctxPin.stats(cfg) };
}

/** Run-length-encode the recorded num_ctx sequence, e.g. "32768 ×21". */
function rle(values) {
  const out = [];
  for (const v of values) {
    const last = out[out.length - 1];
    if (last && last.v === v) last.n++;
    else out.push({ v, n: 1 });
  }
  return out.map((e) => `${e.v} ×${e.n}`).join(", ");
}

/** Per-stage view, so a 150-request scenario stays readable while still being
 *  complete: every request is counted, and the closest-to-its-limit one is shown. */
function stageTable() {
  const groups = new Map();
  for (const s of seen) {
    let g = groups.get(s.stage);
    if (!g) {
      g = { n: 0, ctx: new Set(), pMin: Infinity, pMax: 0, cMin: Infinity, cMax: 0, cfMax: 0, worst: null, worstMargin: Infinity };
      groups.set(s.stage, g);
    }
    const cf = ctxPin.ctxFor(s.promptChars, s.numPredict);
    g.n++;
    g.ctx.add(s.numCtx);
    g.pMin = Math.min(g.pMin, s.numPredict);
    g.pMax = Math.max(g.pMax, s.numPredict);
    g.cMin = Math.min(g.cMin, s.promptChars);
    g.cMax = Math.max(g.cMax, s.promptChars);
    g.cfMax = Math.max(g.cfMax, cf);
    const margin = typeof s.numCtx === "number" ? s.numCtx / ctxPin.ctxFor(s.promptChars, s.numPredict) : 0;
    if (margin < g.worstMargin) {
      g.worstMargin = margin;
      g.worst = s;
    }
  }
  console.log("  stage      req    num_ctx        num_predict     prompt chars        ctxFor(max)   tightest call (margin)");
  for (const [stage, g] of groups) {
    const tight = g.worst;
    console.log(
      `  ${stage.padEnd(9)}  ${String(g.n).padStart(3)}    ${[...g.ctx].join("/").padEnd(12)}  ` +
        `${(g.pMin === g.pMax ? String(g.pMin) : `${g.pMin}…${g.pMax}`).padEnd(13)}  ` +
        `${(g.cMin === g.cMax ? String(g.cMin) : `${g.cMin}…${g.cMax}`).padEnd(17)}  ` +
        `${String(g.cfMax).padStart(10)}   ${tight.promptChars} chars / ${tight.numPredict} predict → ${ctxPin.ctxFor(tight.promptChars, tight.numPredict)} (${g.worstMargin.toFixed(2)}×)`
    );
  }
}

function reportScenario(label, { stats }) {
  const ctxs = seen.map((s) => s.numCtx);
  const distinct = [...new Set(ctxs)];
  console.log(`\n--- ${label} ---`);
  console.log(`  requests: ${seen.length}   stages: ${[...new Set(seen.map((s) => s.stage))].join(", ")}`);
  console.log(`  pinned num_ctx: ${stats.ctx}   (${stats.plan})`);
  if (seen.length <= 24) {
    console.log("  #  stage      num_ctx   num_predict   prompt chars   ctxFor(prompt, predict)");
    seen.forEach((s, i) => {
      console.log(
        `  ${String(i + 1).padStart(2)}  ${s.stage.padEnd(9)}  ${String(s.numCtx === undefined ? "UNSET" : s.numCtx).padStart(7)}   ` +
          `${String(s.numPredict).padStart(11)}   ${String(s.promptChars).padStart(12)}   ${String(ctxPin.ctxFor(s.promptChars, s.numPredict)).padStart(8)}`
      );
    });
  } else {
    stageTable();
  }
  console.log(`  RECORDED num_ctx SEQUENCE (${seen.length} requests): [${rle(ctxs)}]`);

  check(`${label}: every request carries an explicit num_ctx (none left at Ollama's default)`, seen.every((s) => typeof s.numCtx === "number"), JSON.stringify(distinct));
  check(`${label}: all ${seen.length} requests share ONE num_ctx`, distinct.length === 1, `distinct = ${distinct.join(", ")}`);
  const truncated = seen.filter((s) => s.numCtx < ctxPin.ctxFor(s.promptChars, s.numPredict));
  check(
    `${label}: every num_ctx >= ctxFor(promptChars, numPredict) for that request (no prompt can be truncated)`,
    truncated.length === 0,
    JSON.stringify(truncated)
  );
  check(`${label}: the pin was never raised mid-run (a raise would be one extra model load)`, stats.raises === 0, `raises = ${stats.raises}`);

  /* Counterfactual: what the OLD code would have sent. translate.js sent no num_ctx
   * at all, summarize.js picked one per request. */
  const oldSeq = seen.map((s) => (s.stage === "translate" ? "ollama-default" : ctxPin.ctxFor(s.promptChars, s.numPredict)));
  const oldDistinct = [...new Set(oldSeq)];
  console.log(`  OLD code would have sent: [${rle(oldSeq)}] → ${oldDistinct.length} distinct context(s) = ${oldDistinct.length} model load(s)`);
  check(
    `${label}: counterfactual — the old per-request choice really did change context mid-run`,
    oldDistinct.length > 1,
    `old sequence was uniform (${oldDistinct.join(", ")}), so this scenario alone would not have shown the reload`
  );
}

/* ---- scenarios ------------------------------------------------------------ */

(async () => {
  installFakeOllama();

  /* A: the DEFAULT config (transcript translation off, notes translation on) on a
   * long recording — map stage, one merge round, final pass, notes translation. */
  const big = makeTranscript(130000);
  const cfgA = makeCfg({ transcript: big });
  reportScenario("A. default config, 130 000-char transcript (map + merge + final + notes translation)", await runPhase(cfgA, big, { translateTranscript: false }));

  /* B: everything on — transcript translation runs BEFORE the notes, so it is the
   * first caller and must already size the pin for the summarizer behind it. */
  const cfgB = makeCfg({ transcript: big, translateTranscript: true });
  reportScenario("B. transcript translation ON, same 130 000-char transcript (translate first, then notes)", await runPhase(cfgB, big, { translateTranscript: true }));

  /* C: a short recording — single-pass summarization. Level `detailed` is the
   * largest num_predict in the plan. */
  const small = makeTranscript(9000);
  const cfgC = makeCfg({ transcript: small, detailLevel: "detailed" });
  reportScenario("C. short 9 000-char transcript, detailLevel=detailed (single pass + notes translation)", await runPhase(cfgC, small, { translateTranscript: false }));

  /* D: the pin really is one value per cfg/run — a second run with a fresh cfg
   * (which is what config.load() hands the pipeline) is a separate load. */
  const cfgD = makeCfg({ transcript: big });
  await runPhase(cfgD, big, { translateTranscript: false });
  const cfgD2 = makeCfg({ transcript: big });
  await runPhase(cfgD2, big, { translateTranscript: false });
  check(
    "D. two fresh cfg objects (two recordings) get independent pins, each of them internally uniform",
    ctxPin.stats(cfgD).ctx === ctxPin.stats(cfgD2).ctx && ctxPin.stats(cfgD).raises === 0 && ctxPin.stats(cfgD2).raises === 0,
    JSON.stringify([ctxPin.stats(cfgD), ctxPin.stats(cfgD2)])
  );

  /* E: ADVERSARIAL — a realistic worst case, not a contrived one. The extracts are
   * as long as the map stage's own num_predict ceiling allows (3000 tokens ≈ 12 000
   * chars) and the transcript is long enough to fill MAX_MAP_CHUNKS (80 chunks), so
   * after the three reduce rounds the final pass really does hit summarize()'s
   * 80 000-char input cap. That cap is the shape that decides between a 16384 pin
   * and a 32768 pin, so it has to be exercised rather than assumed. */
  const huge = makeTranscript(640000); // ≈80 chunks of CHUNK_CHARS
  answerSizes = { map: 12000, merge: 12000 };
  const cfgE = makeCfg({ transcript: huge });
  const rE = await runPhase(cfgE, huge, { translateTranscript: false });
  answerSizes = { map: 2200, merge: 1200 };
  const finalReq = seen.filter((s) => s.stage === "final");
  check(
    "E. the final pass really did reach the plan's 80 000-char ceiling (worst-case shape exercised, not assumed)",
    finalReq.length === 1 && finalReq[0].promptChars > ctxPin.FINAL_INPUT_CEIL_CHARS,
    `final prompt = ${finalReq.length ? finalReq[0].promptChars : "none"} chars, cap = ${ctxPin.FINAL_INPUT_CEIL_CHARS}`
  );
  check(
    "E. no request body exceeds the ceiling the pin was sized from (final cap + wrapper overhead)",
    finalReq.every((s) => s.promptChars <= ctxPin.FINAL_INPUT_CEIL_CHARS + ctxPin.PLAN_OVERHEAD_CHARS),
    JSON.stringify(finalReq)
  );
  check(
    "E. the pin for that worst case is the 32 768 bucket, not the 16 384 one",
    rE.stats.ctx === 32768,
    `pinned ${rE.stats.ctx}`
  );
  reportScenario("E. adversarial: 80 map chunks at the map num_predict ceiling, 3 reduce rounds, final pass at the 80 000-char cap", rE);

  console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error("harness crashed:", e && e.stack ? e.stack : e);
  process.exit(1);
});
