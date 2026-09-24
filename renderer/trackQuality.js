"use strict";
/* Pure helpers for judging whether a recorded track actually captured anything.
 *
 * WHY THESE ARE PURE AND SEPARATE: the rule is load-bearing — it decides whether the
 * user is told their microphone recorded nothing — and it must be testable without a
 * DOM or ffmpeg. The renderer loads this as a plain script (it defines
 * window.trackQuality); the test suite loads it with vm and calls it directly.
 *
 * THE FAILURE THIS EXISTS FOR (measured): a 10-minute meeting whose mic track was
 * 0.7 % active / peak -33 dBFS. The pipeline succeeded, only the system audio
 * transcribed, and nothing anywhere said the microphone had recorded silence. The
 * level meter was on screen the whole time and nothing acted on it.
 *
 * Thresholds are deliberately blunt and conservative: they must fire on "this track
 * holds nothing", never on "this person paused for a while".
 */
(function () {
  /* Peak at or below this is digital silence, not quiet audio. A real room recording
   * with a muted mic measures -Infinity; -91 dBFS is the floor ffmpeg reports. */
  var SILENT_PEAK_DBFS = -90;
  /* Below this share of samples being non-zero, the track is effectively empty. A real
   * but quiet recording still has thousands of non-zero samples (room tone, noise
   * floor), so 1 % is far below anything genuine. */
  var SILENT_ACTIVE_PERCENT = 1;
  /* Live watchdog: "never once above the noise floor" for this long. The floor matches
   * the recorder's own default speech detector (lifecycle.autoStop.levelThreshold = 8
   * on a 0-100 scale), so this agrees with the app's other notion of "sound". */
  var MIC_WATCHDOG_WINDOW_SEC = 10;
  var MIC_LEVEL_FLOOR = 8;

  /**
   * Is one track's audio absent?
   * @param {{peakDbfs?:number, activePercent?:number}} track from meta.audioStats.tracks
   * @returns {boolean} true only when the numbers positively show an empty track; a
   *   track with no usable numbers is NOT reported as silent (never cry wolf).
   */
  function isSilentTrack(track) {
    if (!track || typeof track !== "object") return false;
    var peak = typeof track.peakDbfs === "number" ? track.peakDbfs : null;
    var active = typeof track.activePercent === "number" ? track.activePercent : null;
    if (peak === null && active === null) return false;
    // -Infinity is a legitimate value (ffmpeg reports it for pure silence) and compares
    // correctly with <=, so no special-casing is needed.
    if (peak !== null && peak <= SILENT_PEAK_DBFS) return true;
    if (active !== null && active < SILENT_ACTIVE_PERCENT) return true;
    return false;
  }

  /**
   * The live watchdog's verdict, given how many level samples have been seen.
   * @param {number} totalSamples  level samples observed while recording
   * @param {number} loudSamples   how many of them were >= MIC_LEVEL_FLOOR
   * @returns {boolean} true when the window has elapsed with no signal at all
   */
  function micLooksDead(totalSamples, loudSamples) {
    if (typeof totalSamples !== "number" || typeof loudSamples !== "number") return false;
    if (totalSamples < MIC_WATCHDOG_WINDOW_SEC) return false;
    return loudSamples <= 0;
  }

  /** Which names may be offered for one speaker, given who already holds what. */
  function pickableNames(roster, speakers, speakerId) {
    // Guard every element: this runs against data that came back over IPC, and a
    // malformed entry must not throw inside a render pass. (Found by the test that
    // asserts a [null, {}] speakers list is tolerated.)
    var list = [];
    for (var g = 0; g < (speakers || []).length; g++) {
      var sp = speakers[g];
      if (sp && typeof sp === "object") list.push(sp);
    }
    var mine = "";
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === speakerId) { mine = String(list[i].name || "").trim(); break; }
    }
    var taken = {};
    for (var j = 0; j < list.length; j++) {
      var s = list[j];
      if (s.id === speakerId || !s.name) continue;
      taken[String(s.name).trim().toLowerCase()] = true;
    }
    var out = [];
    for (var k = 0; k < (roster || []).length; k++) {
      var n = roster[k];
      if (typeof n !== "string" || !n.trim()) continue;
      var t = n.trim();
      var lower = t.toLowerCase();
      if (lower !== mine.toLowerCase() && taken[lower]) continue; // already someone else's
      if (out.indexOf(t) === -1) out.push(t);
    }
    return out;
  }

  var api = {
    SILENT_PEAK_DBFS: SILENT_PEAK_DBFS,
    SILENT_ACTIVE_PERCENT: SILENT_ACTIVE_PERCENT,
    MIC_WATCHDOG_WINDOW_SEC: MIC_WATCHDOG_WINDOW_SEC,
    MIC_LEVEL_FLOOR: MIC_LEVEL_FLOOR,
    isSilentTrack: isSilentTrack,
    micLooksDead: micLooksDead,
    pickableNames: pickableNames,
  };
  if (typeof window !== "undefined") window.trackQuality = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
