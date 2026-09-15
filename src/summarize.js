"use strict";
/* Turns a transcript into structured notes.
 *
 * WHY THIS FILE WAS REWRITTEN (measured 2026-09-11 on a real 66-minute meeting):
 *   - the old code sent the WHOLE transcript in one request and hard-clipped it at
 *     90 000 characters, so long meetings silently lost everything past that point
 *   - it never set `num_ctx`, so Ollama truncated the prompt to its default context
 *   - any failure (timeout, HTTP error, empty reply) fell back to `heuristicSummarize`
 *     — a rule-based SENTENCE EXTRACTOR — and only wrote a console.warn. The user saw
 *     "the transcript with some sentences deleted" and had no way to know why.
 *
 * Now: map-reduce over ~8k-char chunks (nothing is dropped), an explicit num_ctx per
 * request, per-stage progress, and a LOUD, visible fallback banner if an LLM call
 * fails. The fallback reason is returned to the caller and stored in meta.json. */

const ctxPin = require("./ctxPin");

/* Chunking ceilings. They live in src/ctxPin.js because the run's pinned num_ctx
 * has to be proved big enough for every request shape these numbers produce — one
 * source of truth, so the chunker and the context planner cannot drift apart. */
const CHUNK_CHARS = ctxPin.CHUNK_CHARS;          // 8000: ~2 200 tokens per map request
const MAX_CHUNK_CHARS = ctxPin.MAX_CHUNK_CHARS;  // 20000: hard ceiling for a single request
const MAX_MAP_CHUNKS = 80;       // ≈640 000 chars of transcript; beyond this we warn
const REDUCE_GROUP_CHARS = 24000;
const MAP_PREDICT_CEIL = 3000;   // largest num_predict the map stage can ask for
const MAP_PREDICT_MIN = 1200;
const MERGE_PREDICT = 1600;      // num_predict of every merge call

const LEVEL_PROMPTS = {
  brief: `You convert meeting transcripts into VERY SHORT notes. Be terse.
Use markdown with exactly these sections (in order):
## Summary
ONE sentence (at most two) capturing the meeting's purpose and outcome.

## Decisions
Bullet list of decisions made. If none, write "- None recorded.".

## Action Items
Bullet list of the top action items, each starting with "- [ ] " and naming the owner when known.

Rules: no Key Points, no Open Questions sections. Stay factual, keep names/numbers, same language as the transcript.`,

  standard: `You convert meeting transcripts into concise structured notes.
Use markdown with exactly these sections (in order):
## Summary
A short paragraph (3-6 sentences) capturing the meeting's purpose and outcome.

## Key Points
Bullet list of the most important discussion points.

## Decisions
Bullet list of decisions made (if none, write "- None recorded.").

## Action Items
Bullet list, each starting with "- [ ] " and naming the owner when known, e.g. "- [ ] Alice: prepare Q3 report by Friday".

## Open Questions
Bullet list of unresolved questions or follow-ups (if none, write "- None.").

Rules: stay factual, do not invent details, keep original names and numbers, write in the same language as the transcript.`,

  detailed: `You convert meeting transcripts into thorough structured notes.
Use markdown with exactly these sections (in order):
## Summary
A longer paragraph (5-8 sentences): purpose, arc of the discussion, and outcome.

## Key Points
Detailed bullets; where useful include supporting context from the discussion.

## Decisions
Bullets that state the decision and, when mentioned, the rationale or who proposed it.

## Action Items
Bullets starting with "- [ ] ", naming owner, deadline, and any stated next step, e.g. "- [ ] Alice (by Friday): draft the Q3 report and share with Bob".

## Open Questions
Bullets for unresolved questions, concerns, and follow-ups. If none, write "- None.".

## Notable Quotes
2-4 short verbatim quotes that capture the tone or key moments, each prefixed with the speaker if known.

Rules: stay factual, never invent details or quotes, preserve names/numbers/language of the transcript.`,
};

/** Prompt used for the per-chunk (map) stage: compact and lossless-ish. */
const MAP_PROMPT = `You are given ONE part of a longer meeting transcript (part {i} of {n}).
Extract everything that matters from THIS PART ONLY. Do not summarize the meeting as a whole,
do not invent anything, and do not mention that this is a part.

Output markdown with exactly these headings (omit a heading only if it has no content):
## Points
- the substantive discussion points, each a single self-contained line; include who said it, names, numbers, dates and decisions verbatim where they matter
## Decisions
- decisions actually made in this part (omit the heading if none)
## Actions
- commitments, owners and deadlines mentioned in this part (omit if none)
## Questions
- open questions, objections or follow-ups raised in this part (omit if none)
## Quotes
- at most 2 short verbatim lines that capture tone or key moments (omit if none)

Keep the same language as the transcript. Be complete rather than brief: this is the only
place where this part of the transcript is read.`;

const LEVEL_OPTIONS = {
  brief: { temperature: 0.2, num_predict: 600, max_tokens: 600 },
  standard: { temperature: 0.3, num_predict: 1800, max_tokens: 1800 },
  detailed: { temperature: 0.4, num_predict: 4000, max_tokens: 4000 },
};

function buildSystemPrompt(level) {
  const base = LEVEL_PROMPTS[level] || LEVEL_PROMPTS.standard;
  return (
    base +
    `\n\nSpeaker convention: transcript lines may start with "[Name]" or "[你]" or "[远端]".` +
    ` Attribute decisions and action items to the named speaker when the line makes it clear.` +
    ` If no name is given, never invent one — write the owner as "—".`
  );
}

/* ---- chunking ----------------------------------------------------------- */

/** Rough token estimate; deliberately conservative (Chinese is denser per char).
 *  src/ctxPin.js evaluates the same arithmetic inline when it sizes the run's
 *  pinned num_ctx — keep the 3.2 divisor and the +512 margin in sync. */
function estimateTokens(s) {
  return Math.ceil(String(s || "").length / 3.2);
}

/** Split a transcript on line boundaries into ~chunkChars pieces with a small overlap. */
function splitTranscript(text, chunkChars = CHUNK_CHARS) {
  const lines = String(text || "").split(/\r?\n/);
  const chunks = [];
  let cur = [];
  let size = 0;
  for (const line of lines) {
    // a single pathological line longer than the limit gets hard-split
    if (line.length > chunkChars) {
      if (cur.length) { chunks.push(cur.join("\n")); cur = []; size = 0; }
      for (let i = 0; i < line.length; i += chunkChars) chunks.push(line.slice(i, i + chunkChars));
      continue;
    }
    cur.push(line);
    size += line.length + 1;
    if (size >= chunkChars) { chunks.push(cur.join("\n")); cur = []; size = 0; }
  }
  if (cur.length) chunks.push(cur.join("\n"));
  return chunks.filter((c) => c.trim().length);
}

/** num_ctx big enough for prompt + answer + margin, rounded to a common size.
 *  Kept here (and re-exported) as the per-request estimator; the RUN's context is
 *  the pinned maximum computed by src/ctxPin.js — see the note on ollamaChat. */
const ctxFor = ctxPin.ctxFor;

/* ---- transports --------------------------------------------------------- */

function httpJson(url, body, headers = {}, timeoutMs = 300000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal: ctrl.signal,
  }).finally(() => clearTimeout(t));
}

/** One Ollama chat call with an EXPLICIT num_ctx (the old code never set it).
 *
 * `think: false` matters: qwen3.x-style models emit a separate thinking channel,
 * and a hard prompt can burn the whole num_predict budget thinking, returning an
 * EMPTY content with done_reason=length. That is exactly how a 224-minute meeting
 * lost its final merge call. Thinking is off by default for summarization; set
 * `notes.ollama.think = true` to re-enable it.
 *
 * `ctxForRun` is the run's PINNED context (src/ctxPin.js). Picking a context per
 * request is what made Ollama reload the 17.3 GB model mid-pipeline (BACKLOG.md
 * §11.4: context_length 8192 → `-c 65536` between two runners of one run), so the
 * phase pins one value up front and every call — map, merge, final, translate —
 * reads it through here. The pin is the maximum ctxFor() over every request shape
 * the run can produce, so it can never be smaller than a request needs; ctxFor()
 * is only the fallback for callers with no run (standalone use and tests). */
async function ollamaChat({ base, model, system, user, temperature, numPredict, timeoutMs, think = false, ctxForRun }) {
  const promptChars = (system || "").length + (user || "").length;
  const num_ctx = typeof ctxForRun === "function" ? ctxForRun(promptChars, numPredict) : ctxFor(promptChars, numPredict);
  const t0 = Date.now();
  const res = await httpJson(
    base + "/api/chat",
    {
      model,
      stream: false,
      think: !!think,
      // without num_ctx Ollama silently truncates the prompt to its default context
      options: { temperature, num_predict: numPredict, num_ctx },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    },
    {},
    timeoutMs
  );
  const ms = Date.now() - t0;
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Ollama HTTP ${res.status}${body ? " — " + body.slice(0, 200) : ""}`);
  }
  const j = await res.json();
  const msg = (j && j.message) || {};
  const text = msg.content || "";
  const thinking = msg.thinking || "";
  if (!text.trim()) {
    // Say WHY it was empty — an empty reply caused by an exhausted thinking
    // channel needs a different fix than a real model error.
    if (thinking.trim()) {
      throw new Error(`模型只产出了思考内容（${thinking.length} 字，done_reason=${j.done_reason}）`);
    }
    throw new Error(`Ollama 返回空内容（done_reason=${j.done_reason}，eval_count=${j.eval_count}）`);
  }
  return {
    text,
    meta: {
      numCtx: num_ctx,
      promptEvalCount: j.prompt_eval_count,
      evalCount: j.eval_count,
      doneReason: j.done_reason,
      ms,
      think: !!think,
      thinkingChars: thinking.length,
      truncated: j.done_reason === "length",
    },
  };
}

async function openaiChat({ base, apiKey, model, system, user, temperature, maxTokens, timeoutMs }) {
  const t0 = Date.now();
  const res = await httpJson(
    base + "/chat/completions",
    {
      model,
      max_tokens: maxTokens,
      temperature,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    },
    { Authorization: "Bearer " + apiKey },
    timeoutMs
  );
  const ms = Date.now() - t0;
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}${body ? " — " + body.slice(0, 200) : ""}`);
  }
  const j = await res.json();
  const text = (j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || "";
  if (!text.trim()) throw new Error("接口返回空内容");
  return { text, meta: { ms, finishReason: j.choices[0] && j.choices[0].finish_reason } };
}

/** Build a per-provider `call(system, user, {temperature, numPredict})` function.
 *  The model name is read from `state.model` at CALL time so that auto-picking a
 *  model later (see summarize()) actually reaches the request — capturing the
 *  configured value in the closure caused HTTP 400 "model is required". */
function makeCaller(cfg) {
  const provider = cfg.notes.provider;
  if (provider === "ollama") {
    const base = String(cfg.notes.ollama.baseUrl || "").replace(/\/+$/, "");
    const state = { name: "ollama", model: cfg.notes.ollama.model || "", think: cfg.notes.ollama.think === true };
    state.call = (system, user, o) =>
      ollamaChat({
        base,
        model: state.model,
        system,
        user,
        temperature: o.temperature,
        numPredict: o.numPredict,
        timeoutMs: o.timeoutMs || 600000,
        think: o.think === undefined ? state.think : o.think,
        // ONE context for the whole run: every call of every stage shares this pin.
        ctxForRun: (chars, predict) => ctxPin.numCtxFor(cfg, chars, predict),
      });
    return state;
  }
  const n = cfg.notes.openai;
  const base = String(n.baseUrl || "").replace(/\/+$/, "");
  const state = { name: "openai", model: n.model || "" };
  state.call = (system, user, o) =>
    openaiChat({
      base,
      apiKey: n.apiKey,
      model: state.model,
      system,
      user,
      temperature: o.temperature,
      maxTokens: o.numPredict,
      timeoutMs: o.timeoutMs || 300000,
    });
  return state;
}

/* ---- heuristic fallback (extractive — never presented as a summary) ------ */

function heuristicSummarize(transcript, level) {
  const sents = transcript
    .split(/(?<=[.!?。！？])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 3);
  const actions = sents.filter((s) =>
    /\b(will|must|should|need to|to do|todo|action|assign|owner|follow up|send|prepare|schedule|submit|provide|check)\b/i.test(s) ||
    /(please|pls|请|需要|安排|跟进|负责|提交|准备|发送|确认)/.test(s)
  ).slice(0, 12);
  const decisions = sents.filter((s) =>
    /\b(decided|agreed|approved|confirmed|we will|we'll|goal|final|确定|同意|批准|决定|达成)\b/i.test(s)
  ).slice(0, 10);
  const questions = sents.filter((s) => s.includes("?") || s.includes("？")).slice(0, 8);
  const md = [];
  if (level === "brief") {
    md.push("## Summary", (sents.slice(0, 2).join(" ") || transcript.slice(0, 300)) || "", "");
    md.push("## Decisions", ...(decisions.length ? decisions.map((s) => "- " + s) : ["- None recorded."]), "");
    md.push("## Action Items", ...(actions.length ? actions.map((s) => "- [ ] " + s) : ["- None detected."]), "");
  } else {
    md.push("## Summary", (sents.slice(0, 4).join(" ") || transcript.slice(0, 500)) || "", "");
    md.push("## Key Points", ...sents.slice(0, 8).map((s) => "- " + s), "");
    md.push("## Decisions", ...(decisions.length ? decisions.map((s) => "- " + s) : ["- None recorded."]), "");
    md.push("## Action Items", ...(actions.length ? actions.map((s) => "- [ ] " + s) : ["- None detected."]), "");
    md.push("## Open Questions", ...(questions.length ? questions.map((s) => "- " + s) : ["- None."]), "");
  }
  return { text: md.join("\n"), provider: "heuristic" };
}

/** Visible banner so a degraded result can never masquerade as a real summary. */
function fallbackBanner(reason) {
  return (
    `> ⚠️ **本地 LLM 摘要失败** —— 原因：${reason}\n` +
    `> 以下内容是**规则提取的原文句子，不是摘要**。修好 LLM 后点「重新生成」即可得到真正的笔记。\n\n`
  );
}

/* ---- map-reduce orchestration ------------------------------------------- */

async function summarize(transcript, cfg, onProgress = () => {}) {
  if (!transcript || !transcript.trim()) {
    return { text: "*(No speech transcribed — nothing to summarize.)*", provider: "none" };
  }
  const level = cfg.notes.detailLevel || "standard";
  const opt = LEVEL_OPTIONS[level] || LEVEL_OPTIONS.standard;
  const provider = cfg.notes.provider;

  if (provider !== "ollama" && provider !== "openai") {
    const h = heuristicSummarize(transcript, level);
    return { ...h, fallbackReason: "未配置 LLM（当前为内置规则提取模式）", mapReduce: false, warnings: [] };
  }

  const warnings = [];
  let chunks = splitTranscript(transcript);
  let dropped = 0;
  if (chunks.length > MAX_MAP_CHUNKS) {
    dropped = chunks.length - MAX_MAP_CHUNKS;
    chunks = chunks.slice(0, MAX_MAP_CHUNKS);
    warnings.push(`转写过长：只处理了前 ${MAX_MAP_CHUNKS} 段（约 ${(MAX_MAP_CHUNKS * CHUNK_CHARS / 1000).toFixed(0)}k 字符），末尾 ${dropped} 段未纳入摘要`);
  }

  /* Pin the run's num_ctx BEFORE the first request. Ollama reloads the entire
   * model when the served context size changes, and this phase also gets calls from
   * translate.js (transcript batches before us, the notes translation after us), so
   * the pin is declared from the transcript length and shared through cfg —
   * `cfg.translation`'s calls land on the same number instead of forcing their own
   * reload. See src/ctxPin.js for why the pinned value cannot be too small. */
  if (provider === "ollama") {
    ctxPin.declareRun(cfg, {
      transcriptChars: transcript.length,
      numPredictMax: Math.max(opt.num_predict, MAP_PREDICT_CEIL, MERGE_PREDICT),
      label: "notes",
    });
  }

  const caller = makeCaller(cfg);
  // With no explicit model configured, pick one from Ollama (never a vision model).
  if (caller.name === "ollama" && !caller.model) {
    try {
      const picked = await pickOllamaModel(String(cfg.notes.ollama.baseUrl || "").replace(/\/+$/, ""));
      caller.model = picked.model;
      warnings.push(`未指定模型，自动选用 ${picked.model}${picked.reason ? "（" + picked.reason + "）" : ""}`);
    } catch (e) {
      const h = heuristicSummarize(transcript, level);
      return {
        text: fallbackBanner(e.message) + h.text,
        provider: "heuristic",
        fallbackReason: e.message,
        mapReduce: false,
        warnings,
      };
    }
  }

  // Per-call telemetry: proves whether the prompt was truncated (promptEvalCount
  // vs chars sent) and which num_ctx each request actually used.
  const calls = [];
  const rawCall = caller.call;
  caller.call = async (system, user, o) => {
    try {
      const r = await rawCall(system, user, o);
      calls.push({ chars: (user || "").length, ok: true, ...(r.meta || {}) });
      return r;
    } catch (e) {
      // One safety-net retry with the thinking channel flipped: an empty reply
      // usually means the budget went into "thinking", and vice versa a model
      // that refuses without reasoning often answers with it enabled.
      calls.push({ chars: (user || "").length, ok: false, error: e.message, retry: true });
      if (process.env.A2N_DEBUG_SUMMARIZE) console.log(`[summarize] call failed (${e.message}) — retrying with think=${!o.think}`);
      const r2 = await rawCall(system, user, { ...o, think: !(o.think === undefined ? caller.think : o.think) });
      calls.push({ chars: (user || "").length, ok: true, afterRetry: true, ...(r2.meta || {}) });
      return r2;
    }
  };

  const started = Date.now();
  try {
    let parts;
    let mapReduce = false;

    if (chunks.length === 1) {
      onProgress({ phase: "summarizing", message: "生成笔记…" });
      const r = await caller.call(buildSystemPrompt(level), "TRANSCRIPT:\n\n" + chunks[0], {
        temperature: opt.temperature,
        numPredict: opt.num_predict,
      });
      parts = [r.text];
      if (r.meta && r.meta.truncated) warnings.push("模型到达 num_predict 上限，输出可能被截断（可用更小的详细程度或更大的 num_predict）");
    } else {
      mapReduce = true;
      const summaries = [];
      const truncatedParts = [];
      for (let i = 0; i < chunks.length; i++) {
        onProgress({
          phase: "summarizing",
          message: `逐段提炼 ${i + 1}/${chunks.length}…`,
          progress: Math.round(((i + 1) / chunks.length) * 70),
        });
        const sys = MAP_PROMPT.replace("{i}", String(i + 1)).replace("{n}", String(chunks.length));
        // Scale the extract budget with the part's size: a flat 1500 was hit by
        // 7 of 10 parts of a 224-minute meeting, which silently thinned the notes.
        const mapPredict = Math.min(MAP_PREDICT_CEIL, Math.max(MAP_PREDICT_MIN, Math.round(chunks[i].length / 3)));
        const r = await caller.call(sys, "TRANSCRIPT PART:\n\n" + chunks[i], {
          temperature: 0.2,
          numPredict: mapPredict,
        });
        // A map call that hit num_predict means THAT PART of the meeting was cut —
        // report it instead of silently producing thinner notes.
        if (r.meta && r.meta.truncated) truncatedParts.push(i + 1);
        summaries.push(`### Part ${i + 1}/${chunks.length}\n${r.text.trim()}`);
      }
      if (truncatedParts.length) {
        warnings.push(
          `第 ${truncatedParts.join("、")} 段提炼达到输出上限，该部分细节可能不全（可降低"详细程度"或改用更大的模型）`
        );
      }

      // hierarchical reduce if the collected summaries are still too big
      let current = summaries;
      let round = 0;
      while (current.join("\n\n").length > REDUCE_GROUP_CHARS && round < 3) {
        round++;
        const groups = [];
        let buf = [];
        let size = 0;
        for (const s of current) {
          buf.push(s);
          size += s.length;
          if (size >= REDUCE_GROUP_CHARS) { groups.push(buf.join("\n\n")); buf = []; size = 0; }
        }
        if (buf.length) groups.push(buf.join("\n\n"));
        const merged = [];
        for (let i = 0; i < groups.length; i++) {
          onProgress({
            phase: "summarizing",
            message: `合并要点 ${round}/${i + 1}…`,
            progress: 70 + Math.round(((i + 1) / groups.length) * 20),
          });
          const r = await caller.call(
            `You merge several sets of meeting notes into one de-duplicated set. Keep every distinct fact, name, number and decision; drop duplicates and merge overlapping bullets. Output the same markdown headings you were given (## Points, ## Decisions, ## Actions, ## Questions, ## Quotes). Same language as the input.`,
            groups[i],
            { temperature: 0.2, numPredict: MERGE_PREDICT }
          );
          merged.push(r.text.trim());
        }
        if (merged.length === current.length) break;
        current = merged;
      }

      // final pass: turn the collected extracts into the user's requested format
      onProgress({ phase: "summarizing", message: "整理成最终笔记…", progress: 92 });
      const joined = current.join("\n\n");
      // This cap is the largest prompt the run can produce; src/ctxPin.js sizes the
      // pinned num_ctx from it, so keep the multiplier in sync with
      // ctxPin.FINAL_INPUT_CEIL_CHARS (= MAX_CHUNK_CHARS × FINAL_INPUT_MULTIPLIER).
      const input = joined.length > MAX_CHUNK_CHARS * 4 ? joined.slice(0, MAX_CHUNK_CHARS * 4) : joined;
      if (input.length < joined.length) warnings.push("最终合并阶段输入被截断（仍覆盖会议全部内容的分段提炼结果）");
      const r = await caller.call(
        buildSystemPrompt(level),
        "These are structured extracts from consecutive parts of ONE meeting, in order. " +
          "Write the final meeting notes from them. Nothing outside these extracts exists — do not invent.\n\n" +
          input,
        { temperature: opt.temperature, numPredict: opt.num_predict }
      );
      parts = [r.text];
      if (r.meta && r.meta.truncated) warnings.push("最终输出到达 num_predict 上限，可能被截断");
    }

    const text = parts.join("\n\n").trim();
    onProgress({ phase: "summarizing", message: "笔记完成", progress: 100 });
    return {
      text,
      provider: caller.name + ":" + caller.model,
      fallbackReason: null,
      mapReduce,
      chunks: chunks.length,
      warnings,
      calls,
      elapsedMs: Date.now() - started,
    };
  } catch (e) {
    // LOUD failure: the extractive fallback is labelled as such, never silent.
    const h = heuristicSummarize(transcript, level);
    return {
      text: fallbackBanner(e.message) + h.text,
      provider: "heuristic",
      fallbackReason: e.message,
      mapReduce: true,
      chunks: chunks.length,
      warnings,
      calls,
      elapsedMs: Date.now() - started,
    };
  }
}

/* ---- model discovery ---------------------------------------------------- */

const VLM_HINTS = /(^|[-_:])(vl|vision|llava|minicpm-v|moondream|bakllava|gemma3?n?e?)([-_:]|$)|vl[-_:]/i;

/** List installed Ollama models with a text/vision classification. */
async function listOllamaModels(baseUrl) {
  const base = String(baseUrl || "http://127.0.0.1:11434").replace(/\/+$/, "");
  const r = await fetch(base + "/api/tags", { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error("Ollama HTTP " + r.status);
  const j = await r.json();
  return (j.models || []).map((m) => ({
    name: m.name,
    size: m.size,
    paramSize: (m.details && m.details.parameter_size) || "",
    family: (m.details && m.details.family) || "",
    vlm: VLM_HINTS.test(m.name) || /clip|vision/i.test((m.details && m.details.families || []).join(",")),
  }));
}

/** Pick a text (non-vision) model, preferring the largest parameter count. */
async function pickOllamaModel(baseUrl) {
  const models = await listOllamaModels(baseUrl);
  if (!models.length) throw new Error("Ollama 没有安装任何模型");
  const text = models.filter((m) => !m.vlm);
  const pool = text.length ? text : models;
  const score = (m) => {
    const n = parseFloat(String(m.paramSize).replace(/[^\d.]/g, "")) || 0;
    return n * 1e9 + (m.size || 0) / 1000;
  };
  pool.sort((a, b) => score(b) - score(a));
  const best = pool[0];
  return {
    model: best.name,
    reason: best.vlm ? "只有视觉模型可用" : text.length < models.length ? "已跳过视觉模型" : "",
    models,
  };
}

module.exports = {
  summarize,
  heuristicSummarize,
  buildSystemPrompt,
  splitTranscript,
  ctxFor,
  estimateTokens,
  listOllamaModels,
  pickOllamaModel,
  LEVEL_PROMPTS,
  CHUNK_CHARS,
  MAX_CHUNK_CHARS,
  MAX_MAP_CHUNKS,
};
