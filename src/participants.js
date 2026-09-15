"use strict";
/* Participant roster gate.
 *
 * When a recording stops, the app asks the user (in a modal) to confirm who was
 * present on the call, so the notes can carry names instead of the anonymous
 * "你 / 远端" diarization labels. This is the BACKEND half of that: the main
 * process calls request() with the diarization's suggested speaker list, then
 * waits on wait() for the renderer to answer() (or to one-click dismiss as
 * "unchanged", or cancel). The renderer is the only thing that can answer, but
 * the gate owns the lifecycle: the promise it hands out ALWAYS resolves — under
 * every path (answered / unchanged / cancelled / timeout / abandoned) — so the
 * notes pipeline can never hang on a missing answer.
 *
 * Kept free of Electron and of node:fs / node:path on purpose: it must stay
 * drivable under plain `node` — only the main and renderer processes need it,
 * and neither needs this module to touch disk. The only injectable dependency
 * is the clock (opts.now), used to stamp a request at the moment it is created
 * so main.js can log how long the modal actually held the user, and — in tests —
 * so the gate is verifiable under a deterministic time base.
 *
 * Every timer is .unref()'d: in the Electron main process an uncleared timer
 * would keep the event loop (and the process) alive after the user is done.
 * unref() lets the OS exit when nothing else is pending, while the timer still
 * fires normally while the modal is genuinely waiting for the user. */

/**
 * Bound a diarization-suggested or user-typed speaker list.
 *
 * Why each rule: names flow into the notes as a display label and can reach the
 * LLM prompt, and diarization can report a large "voice" count. 80 chars and
 * 40 entries are hard bounds that keep the notes UI and the prompt sane
 * regardless of what the transcript reported or what the user typed. Trimming
 * and dropping empties / non-strings guards against malformed arrays; the
 * case-insensitive dedupe keeps "You" / "you" from producing two labels.
 *
 * @param {*} suggested array (or anything malformed); we accept it either way.
 * @returns {string[]} a fresh, bounded, trimmed, case-insensitively-deduped
 *     list of non-empty strings, preserving original order.
 */
function sanitize(suggested) {
  if (!Array.isArray(suggested)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of suggested) {
    if (typeof raw !== "string") continue; // non-string (number, null, …): drop, do not coerce
    const t = raw.trim();
    if (t.length === 0) continue;           // blank / whitespace-only: drop
    const key = t.toLowerCase();
    if (seen.has(key)) continue;            // case-insensitive duplicate: keep first
    seen.add(key);
    out.push(t.slice(0, 80));               // cap each name at 80 chars
    if (out.length >= 40) break;            // cap the roster at 40 entries
  }
  return out;
}

/**
 * Create a participant gate.
 *
 * The returned object owns the lifecycle of every request it has produced until
 * each is answered, dismissed, timed out, or abandoned. main.js may hold one
 * instance for the app's lifetime. None of the documented entry points
 * (request / wait / answer / pending / abandon) throw: failures surface as a
 * false return, an empty result, or a resolve — never an exception — because a
 * malformed payload from the renderer must not be able to crash the notes run.
 *
 * @param {Object} [opts]
 * @param {number} [opts.timeoutMs=300000] ms before an outstanding request is
 *     resolved with source:"timeout". 0 or a negative value means "never time
 *     out"; such a request can still be settled by answer() or abandon().
 * @param {() => number} [opts.now=Date.now] injectable clock, called once per
 *     request() to stamp the creation time (main.js logs the modal dwell time
 *     from it). Tests inject a fake to verify the gate does not hard-code a
 *     particular wall clock.
 * @returns {{
 *   request: (o:{dir?:*, title?:string, suggested?:*, reason?:string})=>{id:string|null, prefill:string[]},
 *   wait: (id:string)=>Promise<{names:string[], source:"answered"|"unchanged"|"timeout"|"cancelled"}>,
 *   answer: (id:string, payload:{names?:string[]}|{unchanged?:true}|{cancel?:true})=>boolean,
 *   pending: ()=>string[],
 *   abandon: (id:string)=>boolean
 * }}
 */
function createParticipantGate(opts) {
  // 0 / negative / non-finite all collapse to "no timeout"; only a positive,
  // finite ms value arms a real timer. (The spec names 0 and negative; this
  // also keeps NaN / Infinity / null from ever producing a live setTimeout.)
  const timeoutMs = (opts && typeof opts.timeoutMs === "number" && Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0)
    ? opts.timeoutMs
    : Infinity;
  const now = (opts && typeof opts.now === "function") ? opts.now : Date.now;

  let seq = 0;
  const byId = new Map();    // id -> entry, LIVE requests only (cleared on settle)
  const byDir = new Map();   // dir -> id, LIVE requests only (drives the one-per-dir dedupe)
  const settled = new Map(); // id -> outcome, kept so a LATE wait() can still
                             // recover the real result instead of hanging/lying

  // entry = { dir, title, reason, prefill, createdAt, timer, promise, resolve }
  // createdAt stamps opts.now() at request time (bookkeeping for dwell-time logs;
  // the timeout itself fires on the real setTimeout so the test clock does not
  // need to advance for the fire to actually happen).

  /**
   * Settle a live request. Record the outcome for late waiters, clear the
   * timer, drop it from both live indexes, and resolve its awaited promise if
   * one exists. Guarded: whichever of (timeout-timer, answer, abandon) arrives
   * first settles; the others hit the `byId.get(id) === undefined` check and
   * return false without throwing.
   */
  function settle(id, outcome) {
    const entry = byId.get(id);
    if (!entry) return false;
    settled.set(id, outcome);
    byId.delete(id);
    if (entry.dir !== undefined && byDir.get(entry.dir) === id) byDir.delete(entry.dir);
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    if (entry.resolve) entry.resolve(outcome);
    return true;
  }

  /**
   * Register one outstanding request for `dir`.
   *
   * One outstanding request per dir: if `dir` already has a LIVE request, return
   * that same id (and the same prefill) instead of creating a second — the
   * modal for dir A must not be replaced by a second modal for the same dir,
   * and a second wait() for that dir must resolve the same single promise. That
   * is the dedupe contract. A missing/null/non-string dir is still accepted:
   * main.js may not have the final notes directory when the modal is first
   * offered — we only require a unique id and a resolvable promise, not a real
   * directory string.
   */
  function request(o) {
    o = o || {};
    const dir = o.dir;
    if (dir !== undefined) {
      const existing = byDir.get(dir);
      if (existing !== undefined) return { id: existing, prefill: byId.get(existing).prefill };
    }

    seq += 1;
    const id = "p" + seq; // opaque and unique; the renderer only echoes it back
    const entry = {
      dir,
      title: o.title,
      reason: o.reason,
      prefill: sanitize(o.suggested),
      createdAt: now(),   // bookkeeping (dwell-time log); the timeout below is a real
                          // setTimeout so it does not depend on the test clock
      timer: null,
      promise: null,
      resolve: null,
    };
    byId.set(id, entry);
    if (dir !== undefined) byDir.set(dir, id);

    // Arm a timeout only when a real positive budget exists (see the
    // normalisation above). 0 / negative / NaN mean "never", so no timer is
    // created; the request stays live until answer() or abandon() settles it.
    if (timeoutMs !== Infinity) {
      const t = setTimeout(() => settle(id, { names: [], source: "timeout" }), timeoutMs);
      if (t.unref) t.unref(); // never hold the process open on this
      entry.timer = t;
    }
    return { id, prefill: entry.prefill };
  }

  /**
   * Await the outcome of a request. Must never reject and must never hang:
   *   - live request       -> its promise (fresh on the first wait, shared after)
   *   - already settled    -> the stored outcome (a wait that arrives AFTER
   *                           settle still gets the real result)
   *   - unknown id         -> a resolved marker fallback, source "timeout"
   * "source: timeout" is the least-harm marker for "no live request by that id";
   * main.js should branch on source and treat it as "proceed anyway".
   */
  function wait(id) {
    const entry = byId.get(id);
    if (!entry) {
      if (settled.has(id)) return Promise.resolve(settled.get(id));
      return Promise.resolve({ names: [], source: "timeout" });
    }
    if (!entry.promise) {
      entry.promise = new Promise((resolve) => {
        entry.resolve = resolve;
      });
    }
    return entry.promise;
  }

  /**
   * Accept the renderer's answer for a live request.
   *
   * Recognised payloads are checked in this order; the first recognised field
   * wins, so a combined/malformed object deterministically lands in the first
   * matching branch and never throws:
   *   { names: [...] }    — user edited the roster; sanitised exactly like the
   *                         suggested prefill (bounded, trimmed, deduped).
   *   { unchanged: true } — the one-click "no change"; resolves with the stored
   *                         prefill so the original diarization labels survive.
   *   { cancel: true }    — dismiss; resolves with empty names.
   * Unknown ids, already-answered ids, and payloads with none of these fields
   * all return false and never throw.
   */
  function answer(id, payload) {
    const entry = byId.get(id);
    if (!entry) return false;
    if (!payload || typeof payload !== "object") return false;

    if (Array.isArray(payload.names)) {
      return settle(id, { names: sanitize(payload.names), source: "answered" });
    }
    if (payload.unchanged) {
      return settle(id, { names: entry.prefill.slice(), source: "unchanged" });
    }
    if (payload.cancel) {
      return settle(id, { names: [], source: "cancelled" });
    }
    return false;
  }

  /** Snapshot of the ids still awaiting an answer, in first-request order. */
  function pending() {
    return Array.from(byId.keys());
  }

  /**
   * Force-settle a live request (e.g. the modal is torn down, the app is being
   * quit). Returns true iff it actually settled something, false otherwise, and
   * never throws.
   *
   * Intentionally distinct from answer({cancel:true}) even though they share
   * the settle path and the "cancelled" source: this is "WE stopped waiting for
   * the user" rather than "the USER clicked dismiss", so main.js can keep the
   * two apart in logs without inventing a new source value.
   */
  function abandon(id) {
    return settle(id, { names: [], source: "cancelled" });
  }

  return { request, wait, answer, pending, abandon };
}

module.exports = { createParticipantGate, sanitize };
