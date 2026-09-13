"use strict";
/* Translation to Simplified Chinese.
 * Engine: ollama (default, local) | openai (OpenAI-compatible).
 * Strategy: numbered-line batching so translations align back to transcript chunks. */

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

async function ollamaTranslate(prompt, cfg) {
  const base = cfg.translation.ollama.baseUrl.replace(/\/+$/, "");
  let model = cfg.translation.ollama.model;
  if (!model) {
    const r = await fetch(base + "/api/tags", { signal: AbortSignal.timeout(5000) });
    const j = await r.json();
    model = (j.models || [])[0]?.name;
    if (!model) throw new Error("Ollama has no models installed");
  }
  const res = await httpJson(base + "/api/chat", {
    model,
    stream: false,
    options: { temperature: 0.1, num_predict: 4096 },
    messages: [
      { role: "system", content: SYSTEM_TRANSLATOR },
      { role: "user", content: prompt },
    ],
  });
  if (!res.ok) throw new Error("Ollama translate HTTP " + res.status);
  const j = await res.json();
  const text = j?.message?.content || "";
  if (!text) throw new Error("Ollama returned an empty translation");
  return text;
}

async function openaiTranslate(prompt, cfg) {
  const n = cfg.translation.openai;
  const base = n.baseUrl.replace(/\/+$/, "");
  const res = await httpJson(
    base + "/chat/completions",
    {
      model: n.model,
      max_tokens: 4096,
      temperature: 0.1,
      messages: [
        { role: "system", content: SYSTEM_TRANSLATOR },
        { role: "user", content: prompt },
      ],
    },
    { Authorization: "Bearer " + n.apiKey },
    300000
  );
  if (!res.ok) throw new Error("OpenAI translate HTTP " + res.status);
  const j = await res.json();
  const text = j?.choices?.[0]?.message?.content || "";
  if (!text) throw new Error("Empty translation");
  return text;
}

async function translatePrompt(prompt, cfg) {
  const engine = cfg.translation.engine;
  if (engine === "openai") return openaiTranslate(prompt, cfg);
  try {
    return await ollamaTranslate(prompt, cfg);
  } catch (e) {
    console.warn("ollama translate failed:", e.message);
    if (cfg.translation.engine !== "ollama") {
      // explicit openai already handled above; fall back to heuristic no-op
      throw e;
    }
    throw e;
  }
}

/* ---- chunked transcript translation with numbered-line alignment ---------- */

/** Chinese detection: ratio of CJK ideographs among letters. */
function looksChinese(text) {
  const t = String(text || "");
  const cjk = (t.match(/[\u4e00-\u9fff]/g) || []).length;
  const letters = (t.match(/[\p{L}\p{N}]/gu) || []).length;
  return letters > 0 && cjk / letters > 0.15;
}

/**
 * Why transcript translation will not run — null when it will.
 * Single source of truth for the gate, so main.js cannot drift from it, and the
 * reason is machine-readable because a skipped translation must never be silent:
 *   translation-disabled  translation.enabled (master switch) is off
 *   transcript-disabled   translation.transcript is off — the default, because
 *                         translating a 155-minute transcript measured ~90 min
 *   already-chinese       the transcript is already Simplified Chinese
 * Flags are checked before content, and a disabled flag means NO network call is
 * made at all (measured: 0 fetch calls).
 * @param {object} cfg         config (translation.*)
 * @param {{text?:string}} transcript
 * @returns {"translation-disabled"|"transcript-disabled"|"already-chinese"|null}
 */
function transcriptSkipReason(cfg, transcript) {
  const t = (cfg && cfg.translation) || {};
  if (!t.enabled) return "translation-disabled";
  if (!t.transcript) return "transcript-disabled";
  if (looksChinese(transcript && transcript.text)) return "already-chinese";
  return null;
}

function parseNumbered(res) {
  const map = new Map();
  const re = /^\s*(\d{1,4})\s*[.)、:：]?\s*(.+)$/m;
  for (const raw of String(res || "").split(/\r?\n/)) {
    const m = raw.match(re);
    if (m) {
      const n = parseInt(m[1], 10);
      if (!map.has(n)) map.set(n, m[2].trim());
    }
  }
  return map;
}

/**
 * Translate transcript chunks in batches; each chunk gets a `.translated` field.
 * @param {Array} chunks  [{text,start,end,speaker,speakerName}]
 * @param {object} cfg    config (translation.*)
 * @param {(p:{done:number,total:number})=>void} onBatch
 */
async function translateChunks(chunks, cfg, onBatch) {
  const BATCH_CHARS = 2400;
  const out = [];
  let i = 0;
  const total = chunks.length;
  while (i < total) {
    let chars = 0, j = i;
    while (j < total && chars < BATCH_CHARS) {
      chars += (chunks[j].text || "").length + 8;
      j++;
    }
    const group = chunks.slice(i, j);
    const lines = group.map((c, k) => `${k + 1}. ${c.text}`);
    let mapped = new Map();
    try {
      const res = await translatePrompt(lines.join("\n"), cfg);
      mapped = parseNumbered(res);
    } catch (e) {
      console.warn("batch translate failed:", e.message);
    }
    group.forEach((c, k) => {
      c.translated = mapped.get(k + 1) || "";
    });
    out.push(...group);
    i = j;
    if (onBatch) onBatch({ done: Math.min(i, total), total });
  }
  return out;
}

/** Translate a single block of text (used for the notes). */
async function translateText(text, cfg) {
  return translatePrompt(String(text || "").trim(), cfg);
}

const SYSTEM_TRANSLATOR = `You are a professional translator. Translate the user's text into natural Simplified Chinese.
If the text is already Chinese, output it unchanged.
If the input contains numbered lines (e.g. "1. ..."), translate each line and output the same numbers, one translated line per number, with no extra text, no explanations, no headers.
Keep names, numbers, and technical terms in their original form where that is more natural.`;

module.exports = { translateChunks, translateText, looksChinese, transcriptSkipReason, parseNumbered, SYSTEM_TRANSLATOR };
