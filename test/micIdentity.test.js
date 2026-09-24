"use strict";
/* mic-identity regression suite.
 *
 * WHY THIS EXISTS (measured defect, found 2026-09-22 on a real 240 s recording):
 * The transcript is ONE interleaved array — meetings.mergeTracks() tags mic chunks
 * `speaker: "you"` and system chunks `"remote"` and sorts them together — while
 * diarization only ever analyses the SYSTEM track. assignToChunks() used to rewrite
 * `speaker` on every element, so a mic chunk overlapping a remote speaker's segment
 * (or merely following one, via its `last` fallback) was relabelled as that remote
 * `spkN`: the user's OWN speech was attributed to someone else in the transcript,
 * the notes prompt and the 发言人 panel. Observed: 2/2 mic chunks relabelled.
 *
 * The guard is `assignToChunks(chunks, segments, fallbackId, skipId = "you")`. This
 * suite pins the behaviour from both sides, so neither removing the guard nor
 * loosening it can pass silently. Runs under plain node:
 *   node test/micIdentity.test.js
 * Exits 0 on all-pass, non-zero on any failure (precedent: p6-participants.test.js).
 */
const path = require("path");
const fs = require("fs");
const diarize = require(path.join(__dirname, "..", "src", "diarize.js"));

let failures = 0;
function check(name, cond, detail) {
  console.log((cond ? "PASS " : "FAIL ") + name + (cond ? "" : " — " + detail));
  if (!cond) failures++;
}

const ROOT = path.join(__dirname, "..");
const mainSrc = fs.readFileSync(path.join(ROOT, "src", "main.js"), "utf8");
const diarizeSrc = fs.readFileSync(path.join(ROOT, "src", "diarize.js"), "utf8");

/** The exact chunk shape meetings.mergeTracks() produces. */
function mergeTracksLike() {
  return [
    { text: "remote a", start: 1, end: 9, speaker: "remote", speakerName: "远端" },
    { text: "mic a", start: 2, end: 9, speaker: "you", speakerName: "你" },
    { text: "remote b", start: 20, end: 28, speaker: "remote", speakerName: "远端" },
    { text: "mic b", start: 60, end: 68, speaker: "you", speakerName: "你" },
    { text: "remote c", start: 70, end: 78, speaker: "remote", speakerName: "远端" },
  ];
}
const SEGS = [
  { start: 0, end: 10, speakerId: "spk1" },
  { start: 19, end: 29, speakerId: "spk2" },
  { start: 69, end: 79, speakerId: "spk2" },
];
const micOf = (chunks) => chunks.filter((c) => c.text.startsWith("mic"));
const remoteOf = (chunks) => chunks.filter((c) => c.text.startsWith("remote"));

console.log("[test] mic identity is preserved through speaker assignment\n");

// 1. THE DEFECT: mic chunks must keep `speaker: "you"` by default.
{
  const chunks = mergeTracksLike();
  diarize.assignToChunks(chunks, SEGS, "spk1");
  const mic = micOf(chunks);
  const wrong = mic.filter((c) => c.speaker !== "you").map((c) => c.text + "->" + c.speaker);
  check("1 mic chunks keep speaker 'you' (default guard)", wrong.length === 0, wrong.join(", ") || `${mic.length} mic chunk(s)`);
}
// 2. ...and the display name must stay 你, not a 发言人N label.
{
  const chunks = mergeTracksLike();
  diarize.assignToChunks(chunks, SEGS, "spk1");
  const wrong = micOf(chunks).filter((c) => c.speakerName !== "你").map((c) => c.text + "->" + c.speakerName);
  check("2 mic chunks keep speakerName 你", wrong.length === 0, wrong.join(", "));
}
// 3. The mic chunk that FOLLOWS a remote speaker must not inherit it via `last`.
{
  const chunks = mergeTracksLike();
  diarize.assignToChunks(chunks, SEGS, "spk1");
  const micB = chunks.find((c) => c.text === "mic b");
  check("3 a mic chunk does not inherit the preceding remote speaker", micB && micB.speaker === "you",
    micB ? `${micB.speaker}/${micB.speakerName}` : "mic b missing");
}
// 4. Remote chunks must STILL be assigned — the guard must not neuter the feature.
{
  const chunks = mergeTracksLike();
  diarize.assignToChunks(chunks, SEGS, "spk1");
  const got = remoteOf(chunks).map((c) => c.speaker).join(",");
  check("4 remote chunks are still assigned spk ids", got === "spk1,spk2,spk2", got);
}
// 5. A chunk array with no mic at all behaves exactly as before.
{
  const chunks = [
    { text: "remote a", start: 1, end: 9, speaker: "remote" },
    { text: "remote b", start: 20, end: 28, speaker: "remote" },
  ];
  diarize.assignToChunks(chunks, SEGS, "spk1");
  check("5 remote-only arrays are unaffected by the guard",
    chunks[0].speaker === "spk1" && chunks[1].speaker === "spk2", chunks.map((c) => c.speaker).join(","));
}
// 6. The OLD behaviour is still reachable explicitly — proving the guard, not luck.
{
  const chunks = mergeTracksLike();
  diarize.assignToChunks(chunks, SEGS, "spk1", null);
  const relabelled = micOf(chunks).filter((c) => c.speaker !== "you").length;
  check("6 skipId:null restores the old (defective) relabelling — the guard is what protects us",
    relabelled === micOf(chunks).length, `${relabelled}/${micOf(chunks).length} relabelled`);
}
// 7. `last` must not be advanced BY a skipped mic chunk either.
{
  const chunks = [
    { text: "remote a", start: 1, end: 9, speaker: "remote" },   // -> spk1
    { text: "mic a", start: 40, end: 48, speaker: "you" },       // no segment overlap
    { text: "remote d", start: 100, end: 108, speaker: "remote" }, // no overlap either
  ];
  diarize.assignToChunks(chunks, SEGS, "spk1");
  check("7 a skipped mic chunk leaves the fallback chain at spk1",
    chunks[2].speaker === "spk1", chunks.map((c) => c.text + "=" + c.speaker).join(" "));
}
// 8. STATIC: the signature really carries the default and the runner does not disable it.
{
  const sigOk = /function assignToChunks\(chunks,\s*segments,\s*fallbackId\s*=\s*null,\s*skipId\s*=\s*"you"\)/.test(diarizeSrc);
  check("8a assignToChunks declares skipId = \"you\" by default", sigOk,
    (diarizeSrc.match(/function assignToChunks\([^)]*\)/) || ["(not found)"])[0]);
  const call = mainSrc.match(/diarize\.assignToChunks\([^;]*\)/);
  const callOk = !!call && !/,\s*null\s*\)/.test(call[0]) && !/skipId\s*:/.test(call[0]);
  check("8b runDiarizationForDir does not disable the mic guard", callOk, call ? call[0] : "call site not found");
}
// 9. The mic path is genuinely one interleaved array (the premise of the whole fix).
{
  const m = fs.readFileSync(path.join(ROOT, "src", "meetings.js"), "utf8");
  const ok = /speaker:\s*"you"/.test(m) && /speaker:\s*"remote"/.test(m) && /kept\.sort\(/.test(m);
  check("9 mergeTracks still interleaves mic + remote into one sorted array", ok,
    "if this ever becomes two arrays, revisit the guard");
}

console.log(`\n${failures === 0 ? "all checks passed" : failures + " CHECK(S) FAILED"}`);
process.exitCode = failures ? 1 : 0;
