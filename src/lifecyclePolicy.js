"use strict";
/* Pure decision function behind the lifecycle watchdog.
 *
 * Kept free of timers and Electron so the rules can be unit-tested: these are the
 * rules that decide whether the app stops a recording or quits by itself, so a
 * mistake here is expensive (silently killing a two-hour meeting's processing).
 *
 * main.js builds `state`, calls evaluate(), then performs the returned actions.
 */

/** @returns {{actions:Array<Object>, next:Object}} */
function evaluate(state, cfg, now) {
  const s = Object.assign(
    {
      recording: false,
      busy: false,
      lastActivity: now,
      lastLoudAt: now,
      warnedAt: null,     // when the silence warning was first raised
      idleWarned: false,
      diskWarned: false,
      suppressed: false,  // user pressed "继续录音"
    },
    state || {}
  );
  const as = (cfg && cfg.autoStop) || {};
  const silenceMin = typeof as.silenceMin === "number" ? as.silenceMin : 10;
  const forceStopAfterMin = typeof as.forceStopAfterMin === "number" ? as.forceStopAfterMin : 5;
  const minFreeDiskGB = typeof as.minFreeDiskGB === "number" ? as.minFreeDiskGB : 2;
  const autoStopEnabled = as.enabled !== false;
  const autoQuitAfterMin = typeof cfg.autoQuitAfterMin === "number" ? cfg.autoQuitAfterMin : 15;

  const actions = [];
  const next = Object.assign({}, s);

  /* ---- recording: it is ALWAYS "activity", so the app can never idle-quit here */
  if (s.recording) {
    next.lastActivity = now;

    if (minFreeDiskGB > 0 && typeof s.diskFreeGB === "number" && s.diskFreeGB < minFreeDiskGB) {
      if (!s.diskWarned) actions.push({ type: "warn-disk", freeGB: s.diskFreeGB, limitGB: minFreeDiskGB });
      next.diskWarned = true;
      actions.push({ type: "stop", reason: "disk" });
      return { actions, next };
    }

    if (autoStopEnabled && !s.suppressed) {
      const silentSec = (now - s.lastLoudAt) / 1000;
      const warnAfter = silenceMin * 60;
      const forceAfter = warnAfter + forceStopAfterMin * 60;
      if (silentSec >= forceAfter) {
        next.warnedAt = null;
        actions.push({ type: "stop", reason: "silence", silentSec: Math.round(silentSec) });
        return { actions, next };
      }
      if (silentSec >= warnAfter) {
        if (!s.warnedAt) {
          next.warnedAt = now;
          actions.push({ type: "warn-silence", silentSec: Math.round(silentSec), forceInSec: Math.round(forceAfter - silentSec), first: true });
        } else {
          actions.push({ type: "warn-silence", silentSec: Math.round(silentSec), forceInSec: Math.round(forceAfter - silentSec), first: false });
        }
      } else {
        next.warnedAt = null;
      }
    }
    return { actions, next };
  }

  /* ---- not recording: idle auto-quit, but never while work is in flight */
  if (s.busy || autoQuitAfterMin < 0) return { actions, next };

  const threshold = autoQuitAfterMin === 0 ? 0.5 : autoQuitAfterMin; // 0 = shortly after done
  const idleMin = (now - s.lastActivity) / 60000;
  if (idleMin >= threshold) {
    actions.push({ type: "quit", idleMin, threshold });
    return { actions, next };
  }
  // Only pre-announce when the wait is long enough for a warning to be useful:
  // "quit right after done" (0) must not nag at start-up.
  const warnAt = threshold - 1;
  if (threshold >= 2 && !s.idleWarned && idleMin >= warnAt) {
    next.idleWarned = true;
    actions.push({ type: "warn-idle", idleMin, threshold });
  }
  return { actions, next };
}

module.exports = { evaluate };
