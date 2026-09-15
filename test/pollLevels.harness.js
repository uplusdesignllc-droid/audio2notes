"use strict";
/* Runs the REAL pollLevels()/watchdog from src/main.js under a stubbed
 * `electron`, with no GUI and no capture.exe (tracked suite).
 * Run: node test/pollLevels.harness.js
 *
 * main.js exports nothing, so the source is compiled with a small test tail
 * appended to reach its internals. Nothing in the repo is modified.
 *
 * CAVEAT for a reader of a failure here: this reads the LIVE src/main.js, which
 * other work edits concurrently, so a red run may be a half-applied edit rather
 * than a regression — re-run it before believing it. */
const fs = require("fs");
const path = require("path");
const Module = require("module");
const fx = require("./fixtures");

const ROOT = path.join(__dirname, "..");
/* Work area. This suite needs a status file to append to and a userData path for
 * the stubbed app; both used to be __dirname-relative (tmp/, userdata/), which
 * from test/ would write into the TRACKED directory. .scratch/ is gitignored, so
 * the scratch stays scratch. Deliberately NOT under the fixture root: this is
 * output, and a reviewer may point A2N_FIXTURE_ROOT at a read-only copy of the
 * real meeting store. */
const WORK = fx.workDir("pollLevels");
const TMP = path.join(WORK, "tmp");
const USERDATA = path.join(WORK, "userdata");
fs.mkdirSync(TMP, { recursive: true });
fs.mkdirSync(USERDATA, { recursive: true });

/* ---- electron stub ------------------------------------------------------ */
const notifications = [];
const sent = [];
class NotificationStub {
  constructor(opts) {
    notifications.push(opts);
  }
  on() {}
  show() {}
}
const electronStub = {
  app: {
    getPath: () => USERDATA,
    whenReady: () => new Promise(() => {}), // never resolves => no window, no spawns
    on() {},
    quit() {},
    getGPUInfo: async () => ({ gpuDevice: [] }),
  },
  ipcMain: { handle() {}, on() {} },
  BrowserWindow: class {},
  shell: { openPath() {} },
  dialog: { showMessageBoxSync: () => 0 },
  Notification: NotificationStub,
  powerMonitor: { on() {} },
};
const realRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === "electron") return electronStub;
  return realRequire.apply(this, arguments);
};

/* ---- compile main.js with an appended test surface ---------------------- */
const mainPath = path.join(ROOT, "src", "main.js");
const src =
  fs.readFileSync(mainPath, "utf8") +
  "\nmodule.exports.__test = { pollLevels, stopPolling, armRecordingGuard, startLifecycleWatchdog, lifecycle, notifyUser, createActivityTracker: activityTracker.createActivityTracker, getRec: () => rec, setRec: (r) => { rec = r; }, getActivity: () => activity, setWin: (w) => { win = w; } };\n";
const m = new Module(mainPath, null);
m.filename = mainPath;
m.paths = Module._nodeModulePaths(path.dirname(mainPath));
m._compile(src, mainPath);
const T = m.exports.__test;

/* ---- assertions --------------------------------------------------------- */
let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`PASS  ${name}${detail ? "\n      " + detail : ""}`);
  else {
    failures++;
    console.log(`FAIL  ${name}\n      ${detail || ""}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  /* --- 0. notifyUser actually passes `silent` through (deliverable 3) ----- */
  T.notifyUser("t", "b");
  T.notifyUser("t", "b", null, { silent: true });
  check(
    "notifyUser: silent defaults to false, opts.silent:true reaches the Notification",
    notifications[0].silent === false && notifications[1].silent === true,
    JSON.stringify(notifications.slice(0, 2))
  );

  /* --- 1. the real pollLevels, against a real status file ----------------
   * FIXTURE FIXED 2026-09-15: the anchor used to be the literal
   * `T0 qpc=1 freq=2 unixms=3`, i.e. a capture start in the year 1970. That was
   * harmless while samples were stamped with the poll clock, but pollLevels()
   * now stamps them in CAPTURE time (`T0.unixms + i*500`, BACKLOG §11.3 defect
   * 1(a)), and every sample of a 1970 recording lies in the FUTURE — which the
   * tracker drops, so the suite measured 0 samples for every check. A fixture
   * has to look like the thing it stands in for: this is a real-shaped anchor
   * now, and the mic track gets its own anchor 400 ms later, which is the
   * measured cross-track start offset (BACKLOG §11.4). */
  const now = Date.now();
  const t0System = now - 5000;          // system capture started 5 s ago
  const t0Mic = t0System + 400;         // mic process, spawned second: +400 ms
  const statusFile = path.join(TMP, "system.status");
  const micStatusFile = path.join(TMP, "mic.status");
  fs.writeFileSync(statusFile, `READY fmt=16000:1:16\nT0 qpc=1 freq=2 unixms=${t0System}\n`, "utf8");
  fs.writeFileSync(micStatusFile, `READY fmt=16000:1:16\nT0 qpc=9 freq=2 unixms=${t0Mic}\n`, "utf8");
  const append = (lines) => fs.appendFileSync(statusFile, lines.map((l) => `LEVEL ${l}\n`).join(""), "utf8");

  T.setWin({ isDestroyed: () => false, webContents: { send: (ch, d) => sent.push([ch, d]) } });
  T.setRec({
    system: { kind: "system", statusFile, stopFile: statusFile.replace(/\.status$/, ".stop"), wavFile: "x.wav" },
    mic: { kind: "mic", statusFile: micStatusFile, stopFile: micStatusFile.replace(/\.status$/, ".stop"), wavFile: "y.wav" },
    levelTimers: [],
    busy: false,
    limitFired: false,
    limitReached: null,
    startTime: Date.now(),
  });
  T.armRecordingGuard();
  T.pollLevels();

  /* --- 0b. arming a new recording must not inherit the old guard state ---- */
  T.lifecycle.lastLoudAt = Date.now() - 400_000; // previous recording's last sound, 6.7 min ago
  T.lifecycle.autoStopWarnedAt = 12345;          // warning latch left over from it
  T.armRecordingGuard();
  const rearmed = T.getActivity().stats(Date.now());
  check(
    "armRecordingGuard(): fresh silence clock + cleared warning latch + empty tracker",
    T.lifecycle.lastLoudAt > Date.now() - 1000 && T.lifecycle.autoStopWarnedAt === null && rearmed.samplesInWindow === 0,
    `lastLoudAt=${T.lifecycle.lastLoudAt} (now-400000 was inherited: false) warnedAt=${T.lifecycle.autoStopWarnedAt} samples=${rearmed.samplesInWindow}`
  );

  const quietStart = T.lifecycle.lastLoudAt;

  // A 2.5 s notification beep: 5 lines at LEVEL 27-31, written 500 ms apart while
  // the 300 ms poller runs underneath (i.e. some polls see 0, some 1 line).
  for (let i = 0; i < 5; i++) {
    append([27 + i]);
    await sleep(500);
  }
  await sleep(600);
  const afterBeep = T.lifecycle.lastLoudAt;
  const st1 = T.getActivity().stats(Date.now());
  check(
    "REGRESSION: a 2.5 s beep (5 x LEVEL 27-31) does NOT move lifecycle.lastLoudAt",
    afterBeep === quietStart,
    `lastLoudAt unchanged=${afterBeep === quietStart}; tracker=${JSON.stringify(st1)}`
  );

  /* Dedupe, measured in an UNSATURATED buffer (5 samples against a cap of 26):
   * at the cap the count cannot grow, so a saturated buffer would prove nothing. */
  check(
    "5 written LEVEL lines produced exactly 5 samples (each line observed once)",
    st1.samplesInWindow === 5,
    `samplesInWindow=${st1.samplesInWindow} after 5 lines and ~8 polls`
  );
  await sleep(1000);
  const idle = T.getActivity().stats(Date.now()).samplesInWindow;
  check(
    "a 300 ms poll against a 500 ms writer re-observes nothing (~3 polls, no new lines)",
    idle === 5,
    `samplesInWindow 5 -> ${idle} over ~3 polls with no new lines`
  );
  append([42]);
  await sleep(1000);
  const oneMore = T.getActivity().stats(Date.now()).samplesInWindow;
  check(
    "one new LEVEL line adds exactly one sample (no double counting)",
    oneMore === 6,
    `samplesInWindow 5 -> ${oneMore} after appending 1 line`
  );

  /* --- 1b. the fix from BACKLOG §11.3, measured through the REAL pollLevels --
   * (a) the two tracks carry the SAME anchor-true stamps, not two poll clocks;
   * (b) a 2.5 s chime reaching BOTH tracks is rejected (<4000 ms), where the old
   *     poll-clock stamps + summing counter measured 5000 ms and accepted it. */
  const rSystem = T.getRec().system;
  check(
    "capture-time stamping: system pollLevels() is anchored to T0.unixms, not to the poll clock",
    rSystem.levelSeen > 0 && rSystem.levelMs === t0System + (rSystem.levelSeen - 1) * 500 && rSystem.levelMs - t0System > 1000,
    `levelSeen=${rSystem.levelSeen} levelMs=${rSystem.levelMs} == T0.unixms + (levelSeen-1)*500 = ${t0System + (rSystem.levelSeen - 1) * 500}` +
    `  (a poll-clock stamp would be ~${Date.now()}, i.e. ${Date.now() - rSystem.levelMs} ms later)`
  );

  // The same 2.5 s chime, this time reaching the mic track as well.
  // A 2.5 s chime is FIVE 0.5 s samples. (The first version of this check marked
  // TEN samples loud — 5 s — and then reported that 5 s of sustained sound was
  // accepted; it was accepted because by this rule 5 s genuinely IS activity.)
  const N = 20;
  const levels = Array.from({ length: N }, (_, i) => (i >= 10 && i < 15 ? 45 : 2));
  /* Model what actually happens: the mic's capture process is spawned ~400 ms
   * after the system's (measured 156-460 ms across the two real recordings), so its
   * 500 ms sample grid sits less than one step away — one index EARLIER puts both
   * tracks within 100 ms of the same instant, which is the scenario the union fix
   * exists for. (The first version of this check used `2 + N - 1` = 21, placing the
   * mic's samples 10.5 s AFTER the system's and then measuring the union of two
   * DIFFERENT sounds; that is not a chime heard on both tracks.) */
  const firstMic = 1;
  const sysTs = levels.map((_, i) => t0System + (2 + i) * 500);
  /* What the OLD code stamped: each track's batch carried the wall-clock time of its
   * OWN 300 ms poll, and the two pollers run out of phase, so one sound landing on
   * both tracks was recorded ~400 ms apart — "the same instant" then looked like two
   * different instants to the summing counter, which counted it twice. Sample spacing
   * inside a batch is the writer's real 500 ms cadence, not the poll interval. */
  const pollSys = levels.map((_, i) => now + i * 500);
  const pollMic = levels.map((_, i) => now + 400 + i * 500);
  const micTs = levels.map((_, i) => t0Mic + (firstMic + i) * 500);
  const sum = T.createActivityTracker({ windowSec: 12, loudSec: 4, sampleSec: 0.5, levelThreshold: 8 });
  const uni = T.createActivityTracker({ windowSec: 12, loudSec: 4, sampleSec: 0.5, levelThreshold: 8 });
  for (let i = 0; i < N; i++) {
    sum.push(levels[i], pollSys[i]); sum.push(levels[i], pollMic[i]);
    uni.push(levels[i], sysTs[i]); uni.push(levels[i], micTs[i]);
  }
  const measureAt = Math.max(t0Mic + (firstMic + N - 1) * 500, now + 400 + (N - 1) * 500);
  const sSum = sum.stats(measureAt);
  const sUni = uni.stats(measureAt);
  check(
    "both-track 2.5 s chime: capture-time stamps + union measure REJECT it (isActive false)",
    sUni.active === false && sUni.loudMsInWindow < 4000,
    `union=${sUni.loudMsInWindow} ms active=${sUni.active}  <= the fix;  poll-time stamps + sum=${sSum.loudMsInWindow} ms active=${sSum.active}  <= the defect`
  );
  check(
    "the two tracks' capture-time stamps agree within one sample step (the poll phases do not leak)",
    Math.abs(sysTs[0] - micTs[0]) <= 2000 && new Set(sysTs.concat(micTs)).size === sysTs.length + micTs.length,
    `system t=${sysTs[0]} mic t=${micTs[0]} (${Math.abs(sysTs[0] - micTs[0])} ms apart = the ${t0Mic - t0System} ms capture start offset), poll-clock spread was ${Math.abs(pollSys[0] - (now + 400))} ms`
  );

  // Sustained speech: 24 lines (12 s of loud) land while the poller keeps running
  // => several polls see several NEW lines each.
  append(Array.from({ length: 24 }, () => 42));
  await sleep(1000);
  const afterSpeech = T.lifecycle.lastLoudAt;
  const st2 = T.getActivity().stats(Date.now());
  check(
    "sustained 12 s of loud lines DOES move lifecycle.lastLoudAt",
    // The claim this check NAMES is "sustained loud is activity", not an exact
    // millisecond total. The fixture appends 24 lines instantly, so under
    // CAPTURE-time stamping their stamps land ~9.5 s ahead of the wall clock and the
    // tracker correctly ignores the ones still in its future — the measured 9195 ms
    // is the fixture's timebase, not a defect. The exact arithmetic (24 contiguous
    // samples -> 12000 ms) is pinned by the unit test instead, on a fixture that can
    // express it: activityTracker check B.
    afterSpeech > quietStart && st2.active === true && st2.loudMsInWindow >= 4000,
    `lastLoudAt moved=${afterSpeech > quietStart}; tracker=${JSON.stringify(st2)} (buffer is at its 26-sample cap here)`
  );

  /* --- 2. the real watchdog: silent notification + silence-cleared -------- */
  T.stopPolling();
  T.lifecycle.lastLoudAt = Date.now() - 121_000; // 121 s of silence: warn (2 min) not stop (5 min)
  T.lifecycle.autoStopWarnedAt = null;
  T.lifecycle.autoStopSuppressed = false;
  T.setRec({ ...T.getRec(), startTime: Date.now(), limitFired: true });
  sent.length = 0;
  notifications.length = 0;
  T.startLifecycleWatchdog();
  console.log("      ... waiting 16 s for the watchdog tick");
  await sleep(16_000);
  const warn = notifications.find((n) => n.title === "录音似乎已经结束");
  const warnEvent = sent.find(([ch, d]) => ch === "lifecycle" && d.type === "silence-warning");
  check(
    "watchdog: silence warning is SILENT (silent:true) and says 3 minutes",
    !!warn && warn.silent === true && /3 分钟/.test(warn.body),
    `notification=${JSON.stringify(warn)}`
  );
  check(
    "watchdog: sends lifecycle/silence-warning to the renderer",
    !!warnEvent,
    JSON.stringify(warnEvent)
  );

  // Sound comes back: the tracker refreshes lastLoudAt, the policy must now emit
  // silence-cleared exactly once (defect A).
  sent.length = 0;
  T.lifecycle.lastLoudAt = Date.now();
  console.log("      ... waiting 16 s for the next watchdog tick");
  await sleep(16_000);
  const cleared = sent.filter(([ch, d]) => ch === "lifecycle" && d.type === "silence-cleared");
  const stops = sent.filter(([, d]) => d.type === "auto-stop-request");
  check(
    "watchdog: silence-ended sends lifecycle/silence-cleared exactly once",
    cleared.length === 1 && stops.length === 0,
    `silence-cleared=${cleared.length} auto-stop-request=${stops.length} all=${JSON.stringify(sent)}`
  );

  console.log(failures ? `\n${failures} CHECK(S) FAILED` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error("HARNESS ERROR:", e && e.stack ? e.stack : e);
  process.exit(2);
});
