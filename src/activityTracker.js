"use strict";
/* Pure activity tracker behind the "forgot to stop recording" guard.
 *
 * Why this exists — all numbers measured on a real test recording:
 * the guard used to treat a SINGLE 300 ms LEVEL sample >= levelThreshold (8) as
 * "someone is talking" and reset the silence clock. That makes the app's own
 * Windows notification beep indistinguishable from a human: a beep shows up as
 * 2.0-3.0 s of loud windows (4-6 samples, peaks LEVEL 27-31), while real speech
 * shows up as runs of 12.5 s / 15.5 s / 30.0 s (mic) and 119.5 s (system) with
 * peaks 36-82. "This meeting is still happening" therefore has to be a decision
 * about ACCUMULATED loud time inside a sliding window, not about one sample.
 *
 * Two details that a naive version gets wrong:
 *  - The capture helper writes a LEVEL line every rate/2 frames (0.5 s at the
 *    rates in use) but the main process polls every 300 ms, so one poll sees 0,
 *    1 or several NEW lines. Only pushBatch() can place those on a capture-time
 *    timeline; feeding the poll clock instead would make a late poll look like a
 *    longer loud run and smear the duty cycle.
 *  - Both tracks feed ONE tracker: the guard asks "is this meeting still going",
 *    not "which track is talking". In the measured recording every beep landed on
 *    the system track only because the user was on headphones.
 *
 * Kept free of Electron and timers, in the style of src/lifecyclePolicy.js, so
 * the rule can be unit-tested under plain node. main.js feeds LEVEL samples here;
 * lifecyclePolicy.js owns the warn/stop timing.
 */

/** LEVEL lines are written every rate/2 frames => 0.5 s of audio per sample at
 *  the capture rates in use, so one loud sample is worth 0.5 s of loud time. */
const DEFAULT_SAMPLE_SEC = 0.5;

/** Positive finite number or the default: 0/NaN/negative/absent would silently
 *  produce a tracker that never fires (or never prunes), which is worse than a
 *  visible fallback. */
function positive(v, dflt) {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : dflt;
}

/**
 * @param {{windowSec?:number, loudSec?:number, sampleSec?:number, levelThreshold?:number}} [opts]
 * @returns {{
 *   push: (level:number, atMs:number) => void,
 *   pushBatch: (levels:number[], atMs:number) => void,
 *   isActive: (atMs:number) => boolean,
 *   lastActiveMs: () => (number|null),
 *   stats: (atMs:number) => {windowSec:number, loudSec:number, loudMsInWindow:number, samplesInWindow:number, active:boolean},
 *   reset: () => void,
 * }}
 */
function createActivityTracker(opts) {
  const o = opts || {};
  const windowSec = positive(o.windowSec, 12);
  const loudSec = positive(o.loudSec, 4);
  const sampleSec = positive(o.sampleSec, DEFAULT_SAMPLE_SEC);
  const levelThreshold = typeof o.levelThreshold === "number" && Number.isFinite(o.levelThreshold) ? o.levelThreshold : 8;

  const sampleMs = sampleSec * 1000;
  const windowMs = windowSec * 1000;
  const loudMsNeeded = loudSec * 1000;
  /* Hard ceiling on the buffer. The window cannot possibly hold more samples than
   * it has room for, so anything beyond that is dead weight — and without the cap
   * a caller pushing with a frozen clock (or a huge backlog in one batch) could
   * grow the array for the whole 8-hour recording. */
  const maxSamples = Math.ceil(windowMs / sampleMs) + 2;

  /** @type {Array<{at:number, loud:boolean}>} chronological, pruned on every call */
  let buf = [];
  let lastActive = null;

  /** Insert keeping `buf` chronological. The date-prune below only ever inspects
   *  the FRONT of the buffer, so an out-of-order arrival must not be appended
   *  blindly: polling two files (or a poll that delivers lines written before the
   *  previous batch) can legitimately hand us an older timestamp after a newer
   *  one, and a stale sample sitting *behind* a fresh front would then never be
   *  pruned (it would only be ignored by loudMsIn, i.e. it would sit in memory
   *  until the cap pushed it out). The common case is an append. */
  function insert(sample) {
    let i = buf.length;
    while (i > 0 && buf[i - 1].at > sample.at) i--;
    if (i === buf.length) buf.push(sample);
    else buf.splice(i, 0, sample);
  }

  /** Drop everything older than the window, then enforce the cap (oldest first:
   *  the newest samples are the ones that decide "is it still active"). */
  function prune(at) {
    while (buf.length && at - buf[0].at > windowMs) buf.shift();
    while (buf.length > maxSamples) buf.shift();
  }

  /** Loud time inside [at - windowMs, at]. Samples from the future (a clock that
   *  jumped backwards) are ignored rather than counted. */
  function loudMsIn(at) {
    let ms = 0;
    for (const s of buf) {
      const age = at - s.at;
      if (s.loud && age >= 0 && age <= windowMs) ms += sampleMs;
    }
    return ms;
  }

  function activeAt(at) {
    prune(at);
    return loudMsIn(at) >= loudMsNeeded;
  }

  function noteActive(at) {
    if (lastActive === null || at > lastActive) lastActive = at;
  }

  /** Record one sample. Nonsense input must never throw: a non-finite level is
   *  treated as silence, a non-finite timestamp is dropped (it cannot be placed
   *  on the timeline at all), and a backwards timestamp is simply stored — the
   *  cap in prune() keeps that bounded. */
  function push(level, atMs) {
    const at = Number(atMs);
    if (!Number.isFinite(at)) return;
    const lv = Number(level);
    insert({ at, loud: Number.isFinite(lv) && lv >= levelThreshold });
    if (activeAt(at)) noteActive(at);
  }

  /**
   * Record several newly observed samples that all arrived in the SAME poll and
   * were written sampleSec apart in CAPTURE time: sample k of n happened at
   * `atMs - (n - 1 - k) * sampleSec * 1000`. The caller is responsible for
   * feeding each file line exactly once (that is the dedupe); this function only
   * places them, it never invents extra samples.
   * @param {number[]} levels chronological (oldest first)
   * @param {number} atMs timestamp of the NEWEST line
   */
  function pushBatch(levels, atMs) {
    if (!Array.isArray(levels) || levels.length === 0) return;
    const at = Number(atMs);
    if (!Number.isFinite(at)) return;
    const n = levels.length;
    for (let k = 0; k < n; k++) push(levels[k], at - (n - 1 - k) * sampleMs);
  }

  function isActive(atMs) {
    const at = Number(atMs);
    if (!Number.isFinite(at)) return false;
    const act = activeAt(at);
    if (act) noteActive(at);
    return act;
  }

  function lastActiveMs() {
    return lastActive;
  }

  function stats(atMs) {
    const at = Number.isFinite(Number(atMs)) ? Number(atMs) : buf.length ? buf[buf.length - 1].at : 0;
    const active = activeAt(at);
    if (active) noteActive(at);
    return {
      windowSec,
      loudSec,
      loudMsInWindow: loudMsIn(at),
      // the buffer IS the window's memory; the cap keeps this bounded even when
      // the caller's clock misbehaves, so it is the honest "how big is it" number
      samplesInWindow: buf.length,
      active,
    };
  }

  /** A new recording must not inherit the previous one's history. */
  function reset() {
    buf = [];
    lastActive = null;
  }

  return { push, pushBatch, isActive, lastActiveMs, stats, reset };
}

module.exports = { createActivityTracker, DEFAULT_SAMPLE_SEC };
