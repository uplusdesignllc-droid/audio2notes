"use strict";
/* Meeting-app detection: decide whether a call is starting or has ended, from
 * the WASAPI session list that capture.exe reports.
 *
 * Verified on this machine (2026-09-11): while a process plays audio its session
 * reports state=Active, and Inactive once it stops — e.g. powershell.exe playing
 * a WAV was Active for the whole playback and Inactive before/after.
 *
 * Pure by design (no timers, no Electron) so the start/stop rules are testable.
 *
 * Defaults are deliberately asymmetric:
 *   autoStop  = on   — the recording was started by a human; noticing the call
 *                      ended simply avoids recording silence for hours.
 *                      Precondition: auto-stop only applies if a watched app was
 *                      seen ACTIVE FOR AT LEAST startAfterSec (15 s) during this
 *                      recording — not merely glimpsed. A recording that never
 *                      heard one (in-person meeting, browser call, voice memo) is
 *                      never stopped by this rule, and a one-second notification
 *                      sound from a chat app on the watched list cannot fake one.
 *                      The silence watchdog covers the "nobody spoke" case.
 *   autoStart = off  — starting to record a meeting by itself is a privacy
 *                      decision, so it must be switched on explicitly. */

const DEFAULT_RULE = {
  enabled: true,
  autoStart: false,
  autoStop: true,
  apps: ["ms-teams.exe", "teams.exe", "zoom.exe", "webexmta.exe", "CptHost.exe", "slack.exe", "Discord.exe"],
  startAfterSec: 15,   // watched app must be Active this long before auto-start
  stopAfterSec: 90,    // and quiet this long before auto-stop
};

function normalizeRule(rule) {
  const r = Object.assign({}, DEFAULT_RULE, rule || {});
  r.apps = (r.apps || DEFAULT_RULE.apps).map((a) => String(a).toLowerCase());
  return r;
}

/** Is a watched meeting app currently producing audio? */
function activeMeetingApp(sessions, rule) {
  const r = normalizeRule(rule);
  const hit = (sessions || []).find(
    (s) => s && s.state === "Active" && r.apps.includes(String(s.name || "").toLowerCase())
  );
  return hit ? hit.name : null;
}

/**
 * @param {Object} state  { activeSince:number|null, inactiveSince:number|null }
 * @param {Object} input  { sessions, recording, recordingAutoStarted, now, rule }
 * @returns {{actions:Array<{type:string,app?:string}>, next:Object, activeApp:string|null}}
 */
function evaluate(state, input) {
  const s = Object.assign({ activeSince: null, inactiveSince: null, sawWatchedApp: false }, state || {});
  const rule = normalizeRule(input.rule);
  const now = input.now;
  const actions = [];
  const activeApp = activeMeetingApp(input.sessions, rule);
  const next = Object.assign({}, s);

  if (!rule.enabled) return { actions, next: { activeSince: null, inactiveSince: null, sawWatchedApp: false }, activeApp };

  if (activeApp) {
    next.inactiveSince = null;
    /* The latch must not be set by a BLIP. Two chat apps are on the watched list
     * (slack.exe, Discord.exe), and a single notification sound makes their
     * session Active for a second or two. Under the old rule that alone latched
     * the recording, after which 90 s of quiet would stop it — i.e. a Slack ping
     * could truncate a recording of something else entirely, which is exactly the
     * false stop the latch was added to prevent.
     * So require the app to have been CONTINUOUSLY active for startAfterSec (the
     * same debounce autoStart already uses) before it counts as evidence that a
     * call happened. A real call is active for minutes, so this costs nothing; a
     * ping cannot reach it. activeSince is reset whenever no watched app is
     * active, so pings can never accumulate toward the threshold either. */
    if (!input.recording) {
      next.sawWatchedApp = false;
    } else if (s.activeSince != null && now - s.activeSince >= rule.startAfterSec * 1000) {
      next.sawWatchedApp = true; // once earned, the latch holds for this recording
    } // otherwise: keep whatever the latch already was
    if (s.activeSince == null) {
      next.activeSince = now;
    } else if (
      !input.recording &&
      rule.autoStart &&
      now - s.activeSince >= rule.startAfterSec * 1000
    ) {
      actions.push({ type: "start", app: activeApp });
      next.activeSince = now; // do not re-fire while the same call continues
    }
  } else {
    next.activeSince = null;
    if (input.recording) {
      if (s.inactiveSince == null) {
        next.inactiveSince = now;
      } else if (rule.autoStop && s.sawWatchedApp && now - s.inactiveSince >= rule.stopAfterSec * 1000) {
        actions.push({ type: "stop", reason: "meeting-app-quiet" });
        next.inactiveSince = now;
      }
    } else {
      next.inactiveSince = null;
      next.sawWatchedApp = false; // self-closing latch: a new recording starts clean
    }
  }

  return { actions, next, activeApp };
}

module.exports = { DEFAULT_RULE, normalizeRule, activeMeetingApp, evaluate };
