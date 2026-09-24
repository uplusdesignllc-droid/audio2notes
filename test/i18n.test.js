"use strict";
/* i18n-test: checks the renderer's language layer (renderer/i18n.js) plus the
 * agreement between the dictionary and the markup/code that uses it. No test
 * runner in this repo — runs under plain node:
 *   node test\i18n.test.js
 * Exits 0 on all-pass, non-zero on any failure (precedent: p6-participants.test.js).
 *
 * renderer/i18n.js only touches `window`, so it is loaded in a vm context rather
 * than require()d.
 *
 * Cases 10 and 8c are SWEEPS, not consistency checks: they enumerate the raw
 * markup/source and fail on any phase-1 string that was never wrapped at all. A
 * check that only inspects strings someone remembered to wrap cannot notice a
 * string that was never wrapped — that was this suite's original blind spot, and
 * these two cases exist so it cannot come back.
 *
 * Case 13 is the same idea pointed at the MAIN process: the strings a user reads
 * in an English UI can equally come from backend copy that no renderer-side sweep
 * can see (send("pipeline"), notifyUser(), a label/desc/note/reason field, an
 * { error } return). 101 such strings reached the UI untranslated because nothing
 * checked src/. Case 13 checks src/. */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

let failures = 0;
function check(name, cond, detail) {
  console.log((cond ? "PASS " : "FAIL ") + name + (cond ? "" : " — " + detail));
  if (!cond) failures++;
}

const root = path.join(__dirname, "..");
const i18nSrc = fs.readFileSync(path.join(root, "renderer", "i18n.js"), "utf8");
const appSrc = fs.readFileSync(path.join(root, "renderer", "app.js"), "utf8");
const htmlSrc = fs.readFileSync(path.join(root, "renderer", "index.html"), "utf8");

const sandbox = { window: {} };
vm.runInNewContext(i18nSrc, sandbox);
const I18N = sandbox.window.I18N;

const CJK = /[\u4e00-\u9fff]/;
/* "Chinese text" for coverage purposes must include CJK PUNCTUATION and fullwidth
 * forms, not just the ideograph block: a leftover "。" or "，" is just as visible in
 * an English sentence, and U+3002 is not in U+4E00-U+9FFF. ZH is therefore the test for
 * "a visible leftover is in this string". Whether a LABEL is Chinese is a DIFFERENT
 * question: every English label ends with the fullwidth colon, which ZH matches, so the
 * label test has to look for an IDEOGRAPH only — that is what CJK above is for. */
const ZH = /[\u3000-\u303f\uff00-\uffef\u4e00-\u9fff]/;
const en = I18N.DICT.en;
const zh = I18N.DICT.zh;
const enKeys = Object.keys(en).sort();
const zhKeys = Object.keys(zh).sort();
const has = (k) => Object.prototype.hasOwnProperty.call(en, k);

/* Deliberate exemptions, as EXACT strings with a stated reason. Adding an entry here
 * is a reviewable act; nothing is exempted by a length or shape heuristic, so a new
 * miss cannot hide behind one. EMPTY today: every phase-1 and phase-2 string in
 * index.html is translated. Keep the mechanism — it is how a future deliberate
 * exemption gets reviewed instead of silently skipped. */
const PHASE2_PROSE = [];
/* app.js strings that legitimately stay Chinese without a T(...) wrapper. */
const SOURCE_EXEMPT = [];

const norm = (s) => s.replace(/\s+/g, " ").trim();
const decode = (s) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");

/* 1 — same key set in en and zh */
{
  const onlyEn = enKeys.filter((k) => !Object.prototype.hasOwnProperty.call(zh, k));
  const onlyZh = zhKeys.filter((k) => !Object.prototype.hasOwnProperty.call(en, k));
  check(
    "1 dictionary key sets match (en vs zh)",
    onlyEn.length === 0 && onlyZh.length === 0,
    "only en: " + JSON.stringify(onlyEn.slice(0, 8)) + " | only zh: " + JSON.stringify(onlyZh.slice(0, 8))
  );
}

/* 2 — zh is the identity map */
{
  const bad = zhKeys.filter((k) => zh[k] !== k);
  check("2 DICT.zh is the identity map", bad.length === 0, "offenders: " + JSON.stringify(bad.slice(0, 8)));
}

/* 3 — no empty English, and no English left in Chinese (ideographs OR CJK
 *     punctuation / fullwidth forms).
 *     "中文" is the language selector's own label, so it is intentionally identical. */
{
  const empty = enKeys.filter((k) => typeof en[k] !== "string" || en[k].length === 0);
  const untranslated = enKeys.filter((k) => ZH.test(en[k]) && en[k] !== "中文");
  check("3a no empty en value", empty.length === 0, "offenders: " + JSON.stringify(empty.slice(0, 8)));
  check(
    "3b no en value still contains CJK text or CJK punctuation (except the 中文 label)",
    untranslated.length === 0,
    "offenders: " + JSON.stringify(untranslated.map((k) => [k, en[k]]).slice(0, 8))
  );
}

/* 4 — default language and the language list */
{
  const ids = (I18N.LANGS || []).map((l) => l.id);
  check("4a DEFAULT_LANG is en", I18N.DEFAULT_LANG === "en", "got " + JSON.stringify(I18N.DEFAULT_LANG));
  check("4b LANGS has en and zh", ids.includes("en") && ids.includes("zh"), "got " + JSON.stringify(ids));
  check("4c current lang is the default", I18N.lang === I18N.DEFAULT_LANG, "got " + JSON.stringify(I18N.lang));
}

/* 5 — defensive behaviour */
{
  let threw = null;
  let a, b, c, d;
  try { a = I18N.t(""); b = I18N.t(undefined); c = I18N.resolve("some untranslated backend text"); d = I18N.resolve(null); }
  catch (e) { threw = e && e.message; }
  check("5a t('')/t(undefined) do not throw", threw === null, String(threw));
  check("5b resolve(unknown) returns it unchanged", c === "some untranslated backend text", JSON.stringify(c));
  check("5c resolve(null) returns ''", d === "", JSON.stringify(d));
  check("5d t('') returns ''", a === "", JSON.stringify(a));
  check("5e t(undefined) returns ''", b === "", JSON.stringify(b));
}

/* 6 — placeholder substitution ({name} convention) */
{
  const savedEn = I18N.DICT.en;
  I18N.DICT.en = Object.assign({}, savedEn, { "（n = {n}）": "(n = {n})" });
  const got = I18N.t("（n = {n}）", { n: 5 });
  I18N.DICT.en = savedEn;
  check("6 t(key, {n:5}) replaces {n}", got === "(n = 5)", JSON.stringify(got));
}

/* helper — scan one quoted/template literal, returning its end index (exclusive).
 * Template expressions are scanned recursively so a nested template literal cannot
 * end the scan early. Returns 0 when the literal is unterminated. */
function scanLit(src, i) {
  const q = src[i];
  if (q === "`") {
    let j = i + 1;
    while (j < src.length) {
      if (src[j] === "\\") { j += 2; continue; }
      if (src[j] === "`") return j + 1;
      if (src[j] === "$" && src[j + 1] === "{") {
        let depth = 1;
        let k = j + 2;
        while (k < src.length && depth > 0) {
          const c = src[k];
          if (c === "\\") { k += 2; continue; }
          if (c === "{") depth++;
          else if (c === "}") depth--;
          else if (c === "`") { const e = scanLit(src, k); if (!e) return 0; k = e; continue; }
          k++;
        }
        j = k;
        continue;
      }
      j++;
    }
    return 0;
  }
  let j = i + 1;
  while (j < src.length) {
    if (src[j] === "\\") { j += 2; continue; }
    if (src[j] === q) return j + 1;
    if (src[j] === "\n") return 0;
    j++;
  }
  return 0;
}

/* helper — the span of every T(...) call's FIRST argument literal. */
function keyArgumentSpans(src) {
  const spans = [];
  const re = /(?<![A-Za-z0-9_$.])T\(/g;
  let m;
  while ((m = re.exec(src))) {
    let i = m.index + 2;
    while (i < src.length && /\s/.test(src[i])) i++;
    const q = src[i];
    if (q !== '"' && q !== "'" && q !== "`") continue;
    const end = scanLit(src, i);
    if (end) spans.push([i, end]);
  }
  return spans;
}
function commentSpans(src) {
  const spans = [];
  for (const m of src.matchAll(/\/\*[\s\S]*?\*\//g)) spans.push([m.index, m.index + m[0].length]);
  for (const m of src.matchAll(/(^|[^:\\])\/\/[^\n]*/g)) spans.push([m.index + m[1].length, m.index + m[0].length]);
  return spans;
}

/* 8 — every T(...) call's literal argument is a dictionary key, and no CJK string
 *     literal in app.js escapes translation. Arguments are evaluated with vm, i.e.
 *     exactly as JS would, so an escape can never make a lookup silently miss. */
const keyArgs = keyArgumentSpans(appSrc);
const appLiteralCalls = keyArgs.map(([a, b]) => appSrc.slice(a, b));
{
  const missing = [];
  const unevaluable = [];
  for (const lit of appLiteralCalls) {
    let value;
    try { value = vm.runInNewContext("(" + lit + ")"); } catch (e) { unevaluable.push(lit); continue; }
    if (typeof value === "string") value = value.replace(/\$\{[^{}]*\}/g, "${…}");
    if (!has(value)) missing.push(value);
  }
  check("8a every T() argument evaluates to a dictionary key", unevaluable.length === 0, "unevaluable: " + JSON.stringify(unevaluable.slice(0, 5)));
  check(
    "8b every T() first argument exists in the dictionary",
    missing.length === 0,
    "missing (" + missing.length + "): " + JSON.stringify(missing.slice(0, 10))
  );
}

/* 8c — sweep: every CJK-bearing string literal in app.js must itself be a T() first
 *      argument. Literals inside a vars object are user-visible too (they get
 *      substituted into the translated string), so containing them is not enough. */
{
  const cSpans = commentSpans(appSrc);
  const inComment = (i) => cSpans.some(([a, b]) => i >= a && i < b);
  const isKeyArg = (i, end) => keyArgs.some(([a, b]) => a === i && b === end);
  const unwrapped = [];
  for (let i = 0; i < appSrc.length; i++) {
    const q = appSrc[i];
    if (q !== '"' && q !== "'" && q !== "`") continue;
    if (inComment(i)) continue;
    const end = scanLit(appSrc, i);
    if (!end) continue;
    const body = appSrc.slice(i + 1, end - 1);
    if (CJK.test(body) && !isKeyArg(i, end) && !SOURCE_EXEMPT.some((x) => body === x.text)) {
      unwrapped.push("line " + appSrc.slice(0, i).split("\n").length + ": " + JSON.stringify(body).slice(0, 90));
    }
    i = end - 1;
  }
  check(
    "8c no CJK string literal in app.js escapes a T(...) call",
    unwrapped.length === 0,
    "unwrapped (" + unwrapped.length + "):\n      " + unwrapped.slice(0, 10).join("\n      ")
  );
}

/* 7 — every data-i18n* value in the markup is a dictionary key.
 *     HTML entities are decoded first: the DOM attribute value (and therefore the
 *     lookup key at runtime) holds the decoded text. */
const markupKeys = [];
for (const m of htmlSrc.matchAll(/data-i18n(?:-title|-placeholder|-value)?="([^"]*)"/g)) markupKeys.push(decode(m[1]));
{
  const missing = [...new Set(markupKeys)].filter((k) => !has(k));
  check(
    "7 every data-i18n value exists in the dictionary",
    missing.length === 0,
    "missing (" + missing.length + "): " + JSON.stringify(missing.slice(0, 10))
  );
  /* A value containing a bare " would terminate the attribute early, so the key the
   * DOM actually holds would differ from the one this file appears to declare.
   * An unterminated value is always followed by ordinary text rather than by the end
   * of the tag, so the character after the closing quote is the tell. */
  const badAttr = [];
  for (const m of htmlSrc.matchAll(/data-i18n(?:-title|-placeholder|-value)?="([^"<>]*)"/g)) {
    const next = htmlSrc[m.index + m[0].length];
    if (next === undefined || !(next === ">" || next === "/" || /\s/.test(next))) {
      badAttr.push({ value: m[1], next: next });
    }
  }
  check(
    "7b every data-i18n attribute is well formed (quotes escaped, value terminated)",
    badAttr.length === 0,
    "offenders: " + JSON.stringify(badAttr.slice(0, 5))
  );
  const badAmp = markupKeys.filter((k) => /&(?!(amp|lt|gt|quot|#39);)/.test(k));
  check("7c no unescaped & in a data-i18n value", badAmp.length === 0, JSON.stringify(badAmp.slice(0, 5)));
}

/* 10 — sweep: no CJK visible in index.html may go unwrapped. Lines inside HTML
 *      comments are skipped; the language-switcher block and its labels are
 *      excluded; everything else must either be covered by a data-i18n* value on
 *      that line or be an allowlisted phase-2 paragraph. */
{
  const lines = htmlSrc.split(/\r?\n/);
  const inComment = [];
  let openComment = false;
  for (const l of lines) {
    const s = l.indexOf("<!--");
    const e = l.indexOf("-->");
    if (openComment) { inComment.push(true); if (e >= 0) openComment = false; continue; }
    if (s >= 0 && e < 0) { openComment = true; inComment.push(true); continue; }
    inComment.push(s >= 0 && e > s);
  }
  const inLangBlock = [];
  let lang = false;
  for (const l of lines) {
    if (l.indexOf('id="ui-lang"') >= 0) lang = true;
    inLangBlock.push(lang);
    if (lang && l.indexOf("</div>") >= 0) lang = false;
  }
  const LANG_LABELS = new Set(["中文", "原文", "双语"]);
  const allow = new Set(PHASE2_PROSE.map((p) => norm(p.text)));
  const strip = (l) => norm(l.replace(/<[^>]*>/g, ""));

  let zhLines = 0;
  let wrapped = 0;
  let allowed = 0;
  const misses = [];
  lines.forEach((l, i) => {
    if (inComment[i]) return;
    const text = strip(l);
    if (!ZH.test(text)) return;
    zhLines++;
    if (inLangBlock[i] || LANG_LABELS.has(text)) return;
    /* Remove every value this line declares — one occurrence each, in document order.
     * Global removal would be wrong for a punctuation-only key (case 11's line-271 key
     * ends in "。", and a global strip of "。" would also eat the earlier one). Values
     * are whitespace-normalised because the visible text has been collapsed too. */
    let residue = text;
    for (const m of l.matchAll(/data-i18n(?:-title|-placeholder|-value)?="([^"]*)"/g)) {
      const v = norm(decode(m[1]));
      const at = v ? residue.indexOf(v) : -1;
      if (at >= 0) residue = residue.slice(0, at) + residue.slice(at + v.length);
    }
    if (!ZH.test(residue)) { wrapped++; return; }
    if (allow.has(text)) { allowed++; return; }
    misses.push("line " + (i + 1) + ": " + JSON.stringify(residue.slice(0, 110)));
  });
  check(
    "10 every CJK text node in index.html is wrapped (or an allowlisted phase-2 paragraph)",
    misses.length === 0,
    "unwrapped (" + misses.length + "):\n      " + misses.slice(0, 12).join("\n      ")
  );
  console.log(
    "     markup sweep: CJK lines=" + zhLines + " | wrapped=" + wrapped + " | allowlisted phase-2=" + allowed +
      " (allowlist has " + PHASE2_PROSE.length + " entr" + (PHASE2_PROSE.length === 1 ? "y" : "ies") + ")"
  );
}

/* 11 — ALL-OR-NOTHING per block. Any <p>/<label>/<h3> that declares even one
 *      data-i18n* key must have NO Chinese left in its visible text once all declared
 *      keys are subtracted. This is the rule that stops a half-translated paragraph:
 *      case 10 is per line, so it cannot see a block whose first sentence is Chinese
 *      and second sentence English. */
{
  const blocks = [];
  for (const m of htmlSrc.matchAll(/<(p|label|h3)\b[^>]*>[\s\S]*?<\/\1>/g)) {
    blocks.push({ tag: m[1], src: m[0], line: htmlSrc.slice(0, m.index).split("\n").length });
  }
  let checked = 0;
  const mixed = [];
  for (const b of blocks) {
    if (!/data-i18n(?:-title|-placeholder|-value)?="/.test(b.src)) continue;
    checked++;
    /* a comment inside the block is not visible text */
    const live = b.src.replace(/<!--[\s\S]*?-->/g, "");
    let residue = norm(live.replace(/<[^>]*>/g, ""));
    for (const m of live.matchAll(/data-i18n(?:-title|-placeholder|-value)?="([^"]*)"/g)) {
      const v = norm(decode(m[1]));
      const at = v ? residue.indexOf(v) : -1;
      if (at >= 0) residue = residue.slice(0, at) + residue.slice(at + v.length);
    }
    if (ZH.test(residue)) mixed.push("<" + b.tag + "> at line " + b.line + ": " + JSON.stringify(residue.slice(0, 120)));
  }
  check(
    "11 all-or-nothing: no <p>/<label>/<h3> block mixes translated and untranslated text",
    mixed.length === 0,
    "mixed blocks (" + mixed.length + "):\n      " + mixed.slice(0, 8).join("\n      ")
  );
  console.log("     block sweep: translatable blocks checked=" + checked + " | mixed=" + mixed.length);
}

/* 12 — PLACEHOLDER_KEYS is the visible register of keys that can never match at
 *      runtime. A few backend strings are built from a template literal, so the
 *      main process substitutes its values BEFORE the renderer resolves anything:
 *      the text that arrives is "CPU（8 线程可用）" while the key is
 *      "CPU（${cores} 线程可用）", and an exact lookup cannot hit it. These keys are
 *      listed here, by hand, so that the set cannot silently grow (a new template
 *      reaching the UI without a reviewer noticing) and cannot silently shrink (a
 *      key deleted while the template that needs it stays). resolve() covers them by
 *      shape — see case 15 — which is why they are safe to keep in the dictionary. */
const PLACEHOLDER_KEYS = [
  "${a.app} —— 已自动开始录音（可在设置里关闭）",
  "${jobQueue.size(readQueue())} 个会议等待转写，开始处理…",
  "${path.basename(dir)} —— 插电后自动转写",
  "${path.basename(dir)} —— 点此打开会议文件夹",
  "${r.kind} 轨道录音已到达文件大小上限，正在自动停止并完成转写…",
  "CPU（${cores} 线程可用）",
  "下载声纹模型 ${p.percent}%…",
  "下载失败 HTTP ${res.statusCode}",
  "剩余 ${a.freeGB.toFixed(1)} GB，已自动停止录音以免写满磁盘。",
  "压缩 ${p.dirName}/${p.file}（${p.index}/${p.total}）…",
  "压缩 ${p.file}（${p.index}/${p.total}）…",
  "压缩音频（${preset.label}）…",
  "合并要点 ${round}/${i + 1}…",
  "已 ${Math.round(a.silentSec / 60)} 分钟没有声音，${lc.autoStop.forceStopAfterMin} 分钟后将自动停止并处理。",
  "已录音 ${a.elapsedMin} 分钟，达到最大录音时长，正在自动停止并完成处理…",
  "开始下载 ${model.replace(\"Xenova/\", \"\")}…",
  "找到 ${names.length} 个已安装模型",
  "接口可用，列出 ${names.length} 个模型",
  "核显（${engines.igpu}）",
  "独显（${engines.dgpu}）",
  "空闲 ${a.threshold} 分钟后自动退出（可在设置里关闭）。现在仍可继续使用。",
  "编码器缺失：此 ffmpeg 未提供“${codec}”编码器，无法压缩（请检查捆绑的 ffmpeg）",
  "识别到 ${res.speakers.length} 个发言人",
  "跳过长静音 ${audioStats.silenceSkippedSec}s（${audioStats.cutRuns} 段），送入模型 ${audioStats.speechKeptSec}s / 共 ${audioStats.totalSec}s",
  "转写排队的会议（${profile.model.replace(\"Xenova/whisper-\", \"\")}）…",
  "逐段提炼 ${i + 1}/${chunks.length}…",
];
{
  /* "${…}" is the dictionary's own collapsed-hole convention (see the header of
   * renderer/i18n.js) and is NOT what this case is about: those keys are built by the
   * renderer and resolved with t(). What matters here is a key carrying a real JS
   * expression, i.e. a template literal the main process interpolated. */
  const templated = enKeys.filter((k) => /\$\{(?!…\})[^}]*\}/.test(k));
  const unlisted = templated.filter((k) => !PLACEHOLDER_KEYS.includes(k));
  const absent = PLACEHOLDER_KEYS.filter((k) => !has(k));
  const notTemplated = PLACEHOLDER_KEYS.filter((k) => !templated.includes(k));
  const duplicated = PLACEHOLDER_KEYS.filter((k, i) => PLACEHOLDER_KEYS.indexOf(k) !== i);
  check(
    "12a every ${…}-templated backend key is listed in PLACEHOLDER_KEYS",
    unlisted.length === 0,
    "unlisted (" + unlisted.length + "): " + JSON.stringify(unlisted)
  );
  check(
    "12b every PLACEHOLDER_KEYS entry is a templated dictionary key (once)",
    absent.length === 0 && notTemplated.length === 0 && duplicated.length === 0,
    "absent: " + JSON.stringify(absent) + " | not templated: " + JSON.stringify(notTemplated) + " | duplicate: " + JSON.stringify(duplicated)
  );
  console.log("     placeholder register: templated keys=" + templated.length + " | listed=" + PLACEHOLDER_KEYS.length);
}

/* 13 — SWEEP (USER-VISIBLE backend strings). Every CJK string literal that sits at a
 *      user-visible site in src/ must be a dictionary key. This is the regression
 *      guard for the gap that caused this work: backend copy reaches the UI through
 *      send("pipeline"), notifyUser(), a returned { error }, and label/desc/note/
 *      reason/probe fields — sites no renderer-side sweep (cases 8c/10) can see — and
 *      101 of those strings rendered Chinese in the English UI because nothing
 *      looked at src/.
 *      Deliberately tolerant of src/ changing: it fails on MISSING KEYS only and
 *      never asserts a count, so adding a file or a translated string is fine while
 *      adding an untranslated string is not. Keys are compared in the dictionary's
 *      collapsed-hole form ("${cores}" -> "${…}") so a template literal and its key
 *      agree. `[prefix]` log lines are skipped: those are diagnostics, not UI copy.
 *
 *      KNOWN LIMIT of this case, stated rather than hidden: it checks the LITERAL, so
 *      a key that src/ CONCATENATES with a runtime value still passes here even though
 *      the renderer receives the already-joined string and resolve() can only match a
 *      whole string. src/main.js does that with the error labels ("识别发言人失败：" +
 *      st.reason, "写入失败：" + e.message, "排队失败：", "未知的模型类型："), so those
 *      prefixes stay Chinese at runtime until resolve() grows prefix support or src/
 *      sends the parts separately. A resolve() prefix pass is NOT assumed here. */
{
  const SITE_MARKERS = [
    'send("pipeline"', "notifyUser(", "return { error:", "label:", "desc:", "note:", "reason:", "probe:", "lines.push(", "diag(",
  ];
  const canon = (s) => s.replace(/\$\{[^{}]*\}/g, "${…}");
  const dictKeys = new Set(enKeys.map(canon));
  const srcDir = path.join(root, "src");
  const files = fs.readdirSync(srcDir).filter((f) => f.endsWith(".js")).sort();
  let scanned = 0;
  const missing = [];
  for (const f of files) {
    const s = fs.readFileSync(path.join(srcDir, f), "utf8");
    /* One pass over the file so a quote inside a comment and a comment inside a
     * literal cannot be mistaken for one another. */
    const lits = [];
    const comments = [];
    for (let i = 0; i < s.length; i++) {
      if (s[i] === "/" && s[i + 1] === "/") { const e = s.indexOf("\n", i); const end = e < 0 ? s.length : e; comments.push([i, end]); i = end; continue; }
      if (s[i] === "/" && s[i + 1] === "*") { const e = s.indexOf("*/", i + 2); const end = e < 0 ? s.length : e + 2; comments.push([i, end]); i = end; continue; }
      const q = s[i];
      if (q === '"' || q === "'" || q === "`") {
        const end = scanLit(s, i);
        if (end) { lits.push([i, end]); i = end - 1; }
      }
    }
    const inComment = (i) => comments.some(([a, b]) => i >= a && i < b);
    const starts = [0];
    for (let i = 0; i < s.length; i++) if (s[i] === "\n") starts.push(i + 1);
    const lineOf = (i) => {
      let lo = 0;
      let hi = starts.length - 1;
      while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= i) lo = mid; else hi = mid - 1; }
      return lo;
    };
    const text = s.split(/\r?\n/);
    for (const [a, b] of lits) {
      if (inComment(a)) continue;
      const body = s.slice(a + 1, b - 1);
      if (!CJK.test(body)) continue;
      const ln = lineOf(a);
      /* The literal counts when its own line, or a nearby line of the same statement
       * (backend copy is routinely a chained ternary broken over several lines before
       * the send()/return that carries it), sits at a user-visible site. The walk is
       * capped at 7 lines and stops at a finished statement or a comment block, so a
       * literal from an unrelated statement is not dragged in. */
      let site = null;
      for (let l = ln; l >= 0 && ln - l <= 7; l--) {
        const hit = SITE_MARKERS.find((m) => text[l].includes(m));
        if (hit) { site = hit; break; }
        if (l !== ln && /;\s*$/.test(text[l])) break;
        if (l !== ln && /^\s*(\/\/|\*|\/\*)/.test(text[l])) break;
      }
      if (!site) continue;
      if (/^\s*\[[a-z0-9-]+\]/i.test(body)) continue;
      scanned++;
      if (!dictKeys.has(canon(body))) {
        missing.push(f + ":" + (ln + 1) + " [" + site + "] " + JSON.stringify(body).slice(0, 110));
      }
    }
  }
  check(
    "13 every USER-VISIBLE CJK backend string in src/ is in the dictionary",
    missing.length === 0,
    "missing (" + missing.length + "):\n      " + missing.slice(0, 12).join("\n      ")
  );
  console.log(
    "     src sweep (USER-VISIBLE backend strings): files=" + files.length +
      " | CJK literals at user-visible sites scanned=" + scanned + " | missing=" + missing.length
  );
}

/* 14 — the inventory itself. .scratch/backend-ui-strings.json is the list of the
 *      backend strings that rendered Chinese in the English UI; every entry must be
 *      a key. Loudly skipped when the file is absent (.scratch is working material,
 *      not tracked tree), so this file stays usable in a clean checkout. */
{
  const listPath = path.join(root, ".scratch", "backend-ui-strings.json");
  if (!fs.existsSync(listPath)) {
    console.log("     SKIP case 14: " + path.relative(root, listPath) + " is not present");
  } else {
    const list = JSON.parse(fs.readFileSync(listPath, "utf8"));
    const missing = list.filter((k) => !has(k));
    check(
      "14 every string in .scratch/backend-ui-strings.json is a dictionary key",
      missing.length === 0,
      "missing (" + missing.length + " of " + list.length + "): " + JSON.stringify(missing.slice(0, 10))
    );
    console.log("     backend string inventory: listed=" + list.length + " | missing=" + missing.length);
  }
}

/* 15 — shape matching for interpolated backend strings. The values are substituted by
 *      the main process before the renderer runs, so a templated key can only be
 *      reached by matching its SHAPE; resolve() does that and substitutes the captured
 *      values into the English. Whatever it does, it must never throw and never return
 *      a non-string, and every PLACEHOLDER_KEYS entry must actually be reachable. */
{
  const saved = I18N.lang;
  const samples = [
    ["CPU（8 线程可用）", "CPU (8 threads available)"],
    ["识别到 3 个发言人", "Found 3 speakers"],
    ["压缩 rec.wav（1/3）…", "Compressing rec.wav (1/3)…"],
    ["压缩音频（Opus 32 kbps 单声道（推荐））…", "Compressing audio (Opus 32 kbps mono (recommended))…"],
    ["rec —— 点此打开会议文件夹", "rec — click to open the meeting folder"],
  ];
  const bad = [];
  const unreachable = [];
  let threw = null;
  try {
    I18N.setLang("en");
    for (const [input, want] of samples) {
      const got = I18N.resolve(input);
      if (got !== want) bad.push(JSON.stringify(input) + " -> " + JSON.stringify(got) + " (want " + JSON.stringify(want) + ")");
    }
    const unknown = "完全未知的中文文本，谁也没见过";
    if (I18N.resolve(unknown) !== unknown) bad.push("unknown CJK text was rewritten");
    if (typeof I18N.resolve(42) !== "string") bad.push("resolve(42) is not a string");
    if (typeof I18N.resolve({}) !== "string") bad.push("resolve({}) is not a string");
    /* every registered template must be reachable once its holes are filled in */
    for (const key of PLACEHOLDER_KEYS) {
      const filled = key.replace(/\$\{[^}]*\}/g, "7");
      const got = I18N.resolve(filled);
      if (got === filled || ZH.test(got)) unreachable.push(JSON.stringify(key) + " -> " + JSON.stringify(got));
    }
    I18N.setLang("zh");
    if (I18N.resolve("CPU（8 线程可用）") !== "CPU（8 线程可用）") bad.push("zh must stay an identity pass-through");
  } catch (e) {
    threw = e && e.message;
  }
  I18N.setLang(saved);
  check(
    "15a resolve() shape-matches interpolated backend strings (never throws, never non-string)",
    bad.length === 0 && threw === null,
    (threw ? "threw: " + threw + " | " : "") + bad.slice(0, 4).join(" | ")
  );
  check(
    "15b every PLACEHOLDER_KEYS template is reachable through shape matching",
    unreachable.length === 0,
    "unreachable (" + unreachable.length + "):\n      " + unreachable.slice(0, 8).join("\n      ")
  );
  console.log("     shape matching: " + samples.length + " concrete forms translated | templates reachable=" + (PLACEHOLDER_KEYS.length - unreachable.length) + "/" + PLACEHOLDER_KEYS.length);
}

/* 16 — the power badge pieces (src/powerMode.js describeParts) and the power-mode
 *      notes. In the English UI the badge and every note under it rendered Chinese:
 *      the parts had no keys at all, and one note is built from a template whose values
 *      the main process substitutes before the renderer sees it. Key presence is
 *      checked here; case 17 checks that the CONCRETE strings actually resolve. */
const BADGE_KEYS = ["引擎：", "模型：", "录音后立即转写", "排队等插电", "性能优先", "🔋 电池供电", "🔌 插电"];
const NOTE_KEYS = [
  "省电模式：转写模型降档，说话人分离与 ffmpeg 限制线程数",
  "⚠️ Whisper 自身的线程数暂无法限制（transformers.js v2 不暴露该选项），所以省电主要来自模型降档与「不转写」",
  "录音只落盘 + 压缩，转写排队等插电（这是唯一能量级上的省电手段）",
  "模型自动降档：${…} → ${…}",
  "自动模式：当前${…}，使用「${…}」",
];
/* The two keywords powerMode.js interpolates into the auto-mode note. They are RAW
 * DATA in the template, not labels chosen by the renderer, so without their own keys
 * the note stays half-Chinese however well the template is translated. */
const BARE_VALUE_KEYS = ["电池", "插电"];
{
  const want = BADGE_KEYS.concat(NOTE_KEYS, BARE_VALUE_KEYS);
  const absent = want.filter((k) => !has(k) || !Object.prototype.hasOwnProperty.call(zh, k));
  const cjkEn = want.filter((k) => has(k) && ZH.test(en[k]));
  check(
    "16a every badge / power-mode-note key exists in both dictionaries",
    absent.length === 0,
    "absent (" + absent.length + "): " + JSON.stringify(absent)
  );
  check(
    "16b every en value for those keys is CJK-free",
    cjkEn.length === 0,
    "offenders: " + JSON.stringify(cjkEn.map((k) => [k, en[k]]))
  );
}

/* 17 — the END-TO-END proof for the badge and the notes: the concrete strings the
 *      renderer actually receives, with the templates filled in as src/powerMode.js
 *      fills them, must resolve to English with NO CJK left. Key presence (case 16) is
 *      not enough: a key that exists but cannot be reached from the concrete form (the
 *      template case) is exactly the bug this whole pass exists to close. */
{
  const saved = I18N.lang;
  const BADGE_CONCRETE = ["引擎：", "模型：", "录音后立即转写", "排队等插电", "性能优先", "🔋 电池供电", "🔌 插电"];
  const NOTE_CONCRETE = [
    "省电模式：转写模型降档，说话人分离与 ffmpeg 限制线程数",
    "⚠️ Whisper 自身的线程数暂无法限制（transformers.js v2 不暴露该选项），所以省电主要来自模型降档与「不转写」",
    "录音只落盘 + 压缩，转写排队等插电（这是唯一能量级上的省电手段）",
    "模型自动降档：base.en → base", /* the concrete runtime form of 模型自动降档：${…} → ${…} */
    "模型自动降档：small.en → base.en",
    "自动模式：当前插电，使用「性能优先」", /* the concrete runtime form of 自动模式：当前${…}，使用「${…}」 */
    "自动模式：当前电池，使用「省电优先」",
    "自动模式：当前电池，使用「续航优先」",
  ];
  const BADGE_PIECES = BADGE_CONCRETE.concat(["CPU（24 线程可用）", "CPU（8 线程可用）"]);
  const bad = [];
  const zhBad = [];
  let threw = null;
  try {
    I18N.setLang("en");
    for (const s of BADGE_PIECES.concat(NOTE_CONCRETE)) {
      const got = I18N.resolve(s);
      if (typeof got !== "string") bad.push(JSON.stringify(s) + " -> non-string");
      else if (ZH.test(got)) bad.push(JSON.stringify(s) + " -> " + JSON.stringify(got) + " (CJK left)");
    }
    /* the pieces must still compose the way app.js composes them */
    const joined = ["性能优先", "引擎：", "CPU（8 线程可用）", "模型：", "base.en", "录音后立即转写"].map((s) => I18N.resolve(s)).join(" · ");
    if (ZH.test(joined)) bad.push("composed badge has CJK: " + JSON.stringify(joined));
    /* zh must stay an identity pass-through for the same strings */
    I18N.setLang("zh");
    for (const s of BADGE_PIECES.concat(NOTE_CONCRETE)) {
      if (I18N.resolve(s) !== s) zhBad.push(s);
    }
  } catch (e) {
    threw = e && e.message;
  }
  I18N.setLang(saved);
  check(
    "17a the concrete badge pieces and power-mode notes resolve to CJK-free English",
    bad.length === 0 && threw === null,
    (threw ? "threw: " + threw + " | " : "") + bad.slice(0, 6).join(" | ")
  );
  check(
    "17b the same strings stay byte-identical under zh (identity pass-through)",
    zhBad.length === 0,
    "rewritten (" + zhBad.length + "): " + JSON.stringify(zhBad.slice(0, 6))
  );
  console.log("     power badge/notes: concrete forms checked=" + (BADGE_PIECES.length + NOTE_CONCRETE.length) + " | CJK left=" + bad.length);
}

/* 18 — the PREFIX pass. src/main.js concatenates a label with a value and sends the
 *      JOINED string ("识别发言人失败：" + st.reason), and renderer/app.js does the same
 *      for its own errors (T("试听失败：") + err). No key can match the joined result, so
 *      the Chinese prefix used to survive into the English UI. resolve() now splits it:
 *      the label is translated and the remainder is appended UNTOUCHED — the remainder
 *      can be a file path, a model name or an English error, and rewriting any part of
 *      it would corrupt something the user has to read or paste. */
{
  const saved = I18N.lang;
  /* Every colon-terminated, hole-free key whose label is Chinese is rewriteable. A key
   * whose label is already ASCII ("sherpa-onnx 不可用：") is not, because the pass is
   * gated on the input containing CJK — the gate that also stops the pass from
   * re-matching the English it just produced. */
  const candidates = enKeys.filter((k) => k.charAt(k.length - 1) === "：" && !/\$\{[^}]*\}/.test(k) && CJK.test(k.slice(0, -1)));
  const malformed = candidates.filter((k) => !/:\s$/.test(en[k]));
  /* A label whose en value still holds an ideograph would not clean the prefix at all. */
  const stillChinese = candidates.filter((k) => CJK.test(en[k]));
  const prefixed = candidates.map((k) => k + "boom");
  const badRemainder = [];
  const badPrefix = [];
  const negative = [];
  let threw = null;
  try {
    I18N.setLang("en");
    for (const k of candidates) {
      const FULL = k + "boom";
      const got = I18N.resolve(FULL);
      /* the remainder must come back byte-identical … */
      if (got.slice(en[k].length) !== "boom") badRemainder.push(JSON.stringify(k) + " -> " + JSON.stringify(got));
      /* … and the translated part must be the en value, with no Chinese left in it */
      if (got.slice(0, en[k].length) !== en[k] || ZH.test(en[k])) badPrefix.push(JSON.stringify(k) + " -> " + JSON.stringify(got));
    }
    /* the longest label must win over a shorter one that also matches the tail */
    const longest = I18N.resolve("跳过自动识别发言人：no model");
    if (longest !== "Skipping automatic speaker identification: no model") {
      negative.push("longest-first failed: " + JSON.stringify(longest));
    }
    /* NEGATIVE CONTROL: the label merely CONTAINING the input is not a prefix — only a
     * match at index 0 may rewrite, so mid-string text keeps the label and the value. */
    const middle = "这是 识别发言人失败：boom 中间出现，不应被改写";
    if (I18N.resolve(middle) !== middle) negative.push("mid-string rewrite: " + JSON.stringify(I18N.resolve(middle)));
    const unknown = "完全未知的中文文本，谁也没见过";
    if (I18N.resolve(unknown) !== unknown) negative.push("unknown text rewritten: " + JSON.stringify(I18N.resolve(unknown)));
    /* an exact label is its own key: no value, nothing to append */
    if (I18N.resolve("排队失败：") !== "Queueing failed: ") negative.push("exact label broken");
    if (I18N.resolve("") !== "") negative.push("empty input broken");
    if (typeof I18N.resolve(7) !== "string") negative.push("resolve(7) is not a string");
    I18N.setLang("zh");
    if (I18N.resolve("识别发言人失败：boom") !== "识别发言人失败：boom") negative.push("zh is not an identity pass-through");
  } catch (e) {
    threw = e && e.message;
  }
  I18N.setLang(saved);
  check(
    "18a every colon-terminated label resolves as a prefix and keeps the remainder byte-identical",
    badRemainder.length === 0 && threw === null,
    (threw ? "threw: " + threw + " | " : "") + badRemainder.slice(0, 6).join(" | ")
  );
  check(
    "18b the translated prefix is the en value, CJK-free, and no label is malformed",
    badPrefix.length === 0 && malformed.length === 0 && stillChinese.length === 0,
    "bad: " + JSON.stringify(badPrefix.slice(0, 4)) + " | not ': '-terminated: " + JSON.stringify(malformed) + " | en value still holds CJK: " + JSON.stringify(stillChinese)
  );
  check(
    "18c longest-first wins, and a label only matches at index 0 (no mid-string rewrite)",
    negative.length === 0,
    negative.join(" | ")
  );
  console.log("     prefix pass: colon labels=" + candidates.length + " | probed=" + prefixed.length + " | remainder mismatches=" + badRemainder.length + " | negative-control failures=" + negative.length);
}

/* 9 — totals */
console.log(
  "totals: dictionary keys=" + enKeys.length +
    " | data-i18n occurrences=" + markupKeys.length +
    " | T(...) calls=" + (appSrc.match(/(?<![A-Za-z0-9_$.])T\(/g) || []).length +
    " | T() key arguments=" + appLiteralCalls.length
);

console.log(failures ? "FAIL (" + failures + " case(s))" : "OK: i18n dictionary, API and coverage sweeps all pass");
process.exitCode = failures ? 1 : 0;
