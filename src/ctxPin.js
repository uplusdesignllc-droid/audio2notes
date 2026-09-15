"use strict";
/* ONE `num_ctx` per recording's translate + notes phase — never a per-request choice.
 *
 * WHY (measured 2026-09-15, BACKLOG.md §11.4): the pipeline used to pick a context
 * per REQUEST (`ctxFor()`), and **Ollama reloads the whole 17.3 GB model whenever
 * the served context size changes**. Observed live in
 * `%LOCALAPPDATA%\Ollama\server.log`: a runner came up with `context_length = 8192`
 * at 08:50:31 and minutes later a second one started with `-c 65536 --flash-attn on`
 * (a full unload + reload). The pipeline for that 629 s recording ran
 * 08:48:04 → 08:56:59 (~9 minutes) against ~2 minutes for the 797 s recording the
 * day before. `translate.js` was worse still: it sent NO `num_ctx` at all, so it
 * ran at Ollama's default and forced a reload on both of its boundaries (transcript
 * translation before the notes, notes translation after them).
 *
 * WHAT: the whole phase shares one `ctxPin` state, keyed by the `cfg` object the
 * pipeline loads once per run (`config.load()` returns a fresh clone every call, so
 * one cfg object == one recording). Every Ollama call asks this module for the
 * context instead of computing its own, so the runner is loaded exactly once.
 *
 * WHY THE PINNED VALUE CAN NEVER BE TOO SMALL (the other half of the fix: a
 * too-small context silently truncates the prompt — see the summarize.js header
 * about the rewrite that lost most of a 224-minute meeting). The pin is not
 * "whatever the first call wanted"; it is the maximum `ctxFor()` over **every
 * request shape the phase can produce**, computed from the code's own ceilings:
 *
 *   shape                                prompt ceiling                num_predict
 *   -----------------------------------  ----------------------------  -----------
 *   map chunk (summarize)                2 × CHUNK_CHARS = 16 000      3 000
 *   merge group (summarize)              REDUCE_GROUP_CHARS + item     1 600
 *   final pass (summarize)               MAX_CHUNK_CHARS × 4 = 80 000  level (≤ 4 000)
 *   transcript batch (translate)         BATCH_CHARS + numbering       4 096
 *   notes translation (translate)        4 chars/token × 4 000 tokens  4 096  (guess)
 *
 * `splitTranscript()` flushes a chunk as soon as it reaches CHUNK_CHARS, so one
 * more full line can push it to just under 2 × CHUNK_CHARS; the final pass input is
 * hard-capped at MAX_CHUNK_CHARS × 4 inside `summarize()` and cannot exceed it; the
 * merge groups are capped at REDUCE_GROUP_CHARS plus one oversized item. So:
 *
 *   transcript ≤ 16 000 chars → no request body above 18 000 chars is possible
 *   transcript >  16 000 chars → a 80 000-char final pass is reachable
 *   both regimes → one 16 500-char notes-translation call (the 16 000-char bound is
 *                  a GUESS: 4 chars per output token, the largest num_predict in
 *                  LEVEL_OPTIONS being 4 000)
 *
 * and the pin is `ctxFor(max(those bodies), max(num_predict))`, i.e. 16 384 for a
 * transcript of ≤ 2 × CHUNK_CHARS and 32 768 above that — each ≥ every one of the
 * shapes in the table, so no call can ever be truncated by the pin. The harness
 * checks the boundary directly: its worst-case run ends on a final pass of 81 125
 * chars, which needs exactly 32 768 (`ctxFor` 32768, margin 1.00× — tight, by
 * design: the pin is the smallest step that still fits every shape).
 *
 * `numCtxFor()` still refuses to truncate: if a request ever needs more than the
 * plan (a shape this model missed, or notes far longer than the 4 chars/token
 * guess), it raises the pin LOUDLY and takes the extra reload rather than sending a
 * prompt the model cannot see in full. That path is asserted to be unreachable in
 * the harness (`.scratch/numctx-pin.harness.js`, tracked copy
 * `test/numctx-pin.test.js`). */

/* Request-shape ceilings. CHUNK_CHARS / MAX_CHUNK_CHARS are imported by
 * src/summarize.js from here, so the planner and the chunker cannot drift apart. */
const CHUNK_CHARS = 8000;        // ~2 200 tokens per map request
const MAX_CHUNK_CHARS = 20000;   // hard ceiling for a single request
const FINAL_INPUT_MULTIPLIER = 4; // summarize(): joined extracts are sliced to MAX_CHUNK_CHARS * 4

const SINGLE_PASS_CEIL_CHARS = CHUNK_CHARS * 2;                    // 16 000
const FINAL_INPUT_CEIL_CHARS = MAX_CHUNK_CHARS * FINAL_INPUT_MULTIPLIER; // 80 000
/* System prompt + user-prompt wrapper attached to those bodies. Measured lengths
 * (node, 2026-09-15): buildSystemPrompt is 747 / 949 / 1142 chars for
 * brief / standard / detailed, the map prompt is ~1170 with its wrapper, the merge
 * prompt ~330, SYSTEM_TRANSLATOR 422 — so the largest wrapper is ~1330 chars and
 * 2000 leaves room for a prompt edit without silently invalidating the plan. */
const PLAN_OVERHEAD_CHARS = 2000;
const NOTES_TRANSLATE_CEIL_CHARS = 16000; // GUESS: 4 chars/token × the largest num_predict (4000)
const NOTES_TRANSLATE_OVERHEAD_CHARS = 500; // SYSTEM_TRANSLATOR is 422 chars
const TRANSLATE_NUM_PREDICT = 4096; // src/translate.js sends this on every call

const CTX_STEPS = [4096, 8192, 16384, 32768, 65536, 131072];

/** num_ctx big enough for prompt + answer + margin, rounded to a common size.
 *  Same arithmetic as `summarize.estimateTokens()` (ceil(chars / 3.2)) but
 *  allocation-free, because the planner evaluates it over an 82 000-char ceiling. */
function ctxFor(promptChars, numPredict) {
  const need = Math.ceil(Number(promptChars) / 3.2) + Number(numPredict) + 512;
  for (const c of CTX_STEPS) if (c >= need) return c;
  return CTX_STEPS[CTX_STEPS.length - 1];
}

/** The largest num_ctx any request of this phase can need. Pure; see the table above. */
function planForRun(transcriptChars, numPredictMax) {
  const bodyCeilChars =
    Number(transcriptChars) <= SINGLE_PASS_CEIL_CHARS
      ? SINGLE_PASS_CEIL_CHARS + PLAN_OVERHEAD_CHARS
      : FINAL_INPUT_CEIL_CHARS + PLAN_OVERHEAD_CHARS;
  const notesCeilChars = NOTES_TRANSLATE_CEIL_CHARS + NOTES_TRANSLATE_OVERHEAD_CHARS;
  return ctxFor(
    Math.max(bodyCeilChars, notesCeilChars),
    Math.max(Number(numPredictMax) || 0, TRANSLATE_NUM_PREDICT)
  );
}

/* ---- per-run pin state ---------------------------------------------------- */
/* Keyed by the cfg object: `config.load()` hands the pipeline one freshly cloned
 * cfg per recording and main.js passes that same object to translateTranscript(),
 * summarize() and translateNotes(), so one cfg object is exactly one phase. */
const runs = new WeakMap();
const UNKEYED = {}; // defensive: a cfg-less caller still shares one pin

function stateFor(cfg) {
  const key = cfg && typeof cfg === "object" ? cfg : UNKEYED;
  let st = runs.get(key);
  if (!st) {
    st = { ctx: 0, requests: 0, raises: 0, transcriptChars: 0, plan: null };
    runs.set(key, st);
  }
  return st;
}

function pinTo(st, ctx, why) {
  st.ctx = ctx;
  st.plan = why;
  // Logged once per run so the chosen value is traceable in the app log:
  // "which context did this recording actually load?" is the question §11.4 asked.
  console.log(`[ctxPin] num_ctx pinned to ${ctx} for this run — ${why} (one model load for the whole translate+notes phase)`);
}

/**
 * Pin the run's context from the request plan. Idempotent and monotone: the first
 * caller (translate, when transcript translation is on; otherwise summarize) fixes
 * the value, and a later caller can only RAISE it.
 * @param {object} cfg
 * @param {{transcriptChars:number, numPredictMax:number, label:string}} o
 * @returns {number} the pinned num_ctx
 */
function declareRun(cfg, { transcriptChars, numPredictMax, label }) {
  const st = stateFor(cfg);
  const chars = Math.max(0, Math.ceil(Number(transcriptChars) || 0));
  st.transcriptChars = Math.max(st.transcriptChars, chars);
  const want = planForRun(chars, numPredictMax);
  if (!st.ctx) {
    // The regime names the CEILING the plan is sized from, not the path this run
    // happened to take: a transcript of ≤ 2 × CHUNK_CHARS cannot produce a body
    // bigger than SINGLE_PASS_CEIL + overhead, while anything longer can reach the
    // final pass cap. Both regimes cover the map/merge/translate shapes as well.
    const bodyCeil = chars <= SINGLE_PASS_CEIL_CHARS ? SINGLE_PASS_CEIL_CHARS + PLAN_OVERHEAD_CHARS : FINAL_INPUT_CEIL_CHARS + PLAN_OVERHEAD_CHARS;
    pinTo(
      st,
      want,
      `${label}: transcript ${chars} chars (${chars <= SINGLE_PASS_CEIL_CHARS ? `≤ ${SINGLE_PASS_CEIL_CHARS}` : `> ${SINGLE_PASS_CEIL_CHARS}`}), ` +
        `largest request body ${bodyCeil} chars, num_predict ≤ ${Math.max(Number(numPredictMax) || 0, TRANSLATE_NUM_PREDICT)}`
    );
  } else if (want > st.ctx) {
    raise(st, want, `${label} measured a larger plan (transcript ${chars} chars) than the pin`);
  }
  return st.ctx;
}

/** Raise the pin. Loud on purpose: it costs one extra model reload, which is the
 *  thing this module exists to avoid — but a truncated prompt is worse. */
function raise(st, ctx, why) {
  const before = st.ctx;
  st.ctx = Math.max(st.ctx, ctx);
  st.raises++;
  console.warn(
    `[ctxPin] num_ctx raised ${before || "(unset)"} → ${st.ctx}: ${why}. ` +
      `This should be unreachable (the pin already covers every planned request shape); ` +
      `Ollama will reload the model once more, which is preferable to silently truncating the prompt.`
  );
}

/**
 * The num_ctx for one request: always the run's pinned value, never a per-request
 * choice. Raises the pin (loudly) if the request would not fit, because a context
 * smaller than the prompt makes Ollama truncate it silently.
 */
function numCtxFor(cfg, promptChars, numPredict) {
  const st = stateFor(cfg);
  const need = ctxFor(promptChars, numPredict);
  st.requests++;
  if (!st.ctx) {
    pinTo(st, need, `first request of the run (${Math.round(promptChars)} chars, num_predict ${numPredict}; no plan declared)`);
  } else if (need > st.ctx) {
    raise(st, need, `a request of ${Math.round(promptChars)} chars / num_predict ${numPredict} exceeded the pinned plan`);
  }
  return st.ctx;
}

/** Read-only snapshot for logs, harnesses and tests. */
function stats(cfg) {
  const st = stateFor(cfg);
  return { ctx: st.ctx, requests: st.requests, raises: st.raises, transcriptChars: st.transcriptChars, plan: st.plan };
}

module.exports = {
  ctxFor,
  planForRun,
  declareRun,
  numCtxFor,
  stats,
  CHUNK_CHARS,
  MAX_CHUNK_CHARS,
  SINGLE_PASS_CEIL_CHARS,
  FINAL_INPUT_CEIL_CHARS,
  PLAN_OVERHEAD_CHARS,
  NOTES_TRANSLATE_CEIL_CHARS,
  TRANSLATE_NUM_PREDICT,
  CTX_STEPS,
};
