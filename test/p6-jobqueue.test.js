"use strict";
/* Deterministic round-trip test for the jobQueue participants whitelist.
 * No test runner — run with: node test/p6-jobqueue.test.js
 * Prints PASS/FAIL per case and exits non-zero on any failure. */
const os = require("os");
const fs = require("fs");
const path = require("path");
const jq = require("../src/jobQueue");

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log("PASS: " + name);
  } else {
    failures++;
    console.log("FAIL: " + name + (detail ? "  -> " + detail : ""));
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "p6-jobqueue-"));

/* --- Case 1: the participants field survives add -> save -> load -> nextJob --- */
{
  const file = path.join(tmp, "queue.json");
  let q = jq.add(jq.emptyQueue(), {
    dir: "/m/one",
    reason: "defer",
    sources: ["system"],
    durationSec: 120,
    captureInfo: { system: { format: "raw" } },
    participants: ["张三", "李四"],
    participantsSource: "answered",
    participantsAskedAt: "2024-01-01T00:00:00.000Z",
  });
  jq.save(file, q);
  const res = jq.load(file);
  const job = jq.nextJob(res.queue);
  check("c1 load reports no error", res.error === null, String(res.error));
  check("c1 nextJob returns the meeting", !!job && job.dir === "/m/one");
  check("c1 participants survives add->save->load->nextJob",
    job && JSON.stringify(job.participants) === JSON.stringify(["张三", "李四"]),
    job ? JSON.stringify(job.participants) : "null job");
  check("c1 participantsSource survives", job && job.participantsSource === "answered",
    job ? String(job.participantsSource) : "null job");
  check("c1 participantsAskedAt survives", job && job.participantsAskedAt === "2024-01-01T00:00:00.000Z",
    job ? String(job.participantsAskedAt) : "null job");
  check("c1 pre-existing field (captureInfo) still preserved",
    job && !!job.captureInfo && job.captureInfo.system.format === "raw");
}

/* --- Case 2: absent field yields null fallback (no throw) --- */
{
  const file = path.join(tmp, "legacy.json");
  // Hand-write a queue.json in the OLD schema: NO participants* keys present at all.
  const handWritten = {
    version: 1,
    jobs: [{
      dir: "/m/legacy",
      createdAt: "2023-06-01T00:00:00.000Z",
      reason: "defer",
      sources: ["mic"],
      durationSec: 42,
      captureInfo: null,
      attempts: 0,
      lastError: null,
    }],
  };
  fs.writeFileSync(file, JSON.stringify(handWritten, null, 2), "utf8");
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  check("c2 precondition: on-disk job has NO participants keys",
    !("participants" in raw.jobs[0]) && !("participantsSource" in raw.jobs[0]) && !("participantsAskedAt" in raw.jobs[0]));

  const loaded = jq.load(file).queue;
  let next = null, threwLoad = false;
  try { next = jq.nextJob(loaded); } catch { threwLoad = true; }
  check("c2 pre-existing queue.json loads, nextJob() still returns it (no throw)",
    !threwLoad && loaded.jobs.length === 1 && next && next.dir === "/m/legacy",
    threwLoad ? "threw on load/nextJob" : next ? next.dir : "null");

  let refreshed = null, threwAdd = false;
  try {
    refreshed = jq.add(loaded, { dir: "/m/legacy", reason: "defer", sources: ["mic"], durationSec: 42, captureInfo: null });
  } catch { threwAdd = true; }
  check("c2 add() on a field-less job does not throw", !threwAdd);
  const rr = refreshed.jobs.find((j) => j.dir === "/m/legacy");
  check("c2 fallback: participants -> null", rr && rr.participants === null, rr ? String(rr.participants) : "no job");
  check("c2 fallback: participantsSource -> null", rr && rr.participantsSource === null, rr ? String(rr.participantsSource) : "no job");
  check("c2 fallback: participantsAskedAt -> null", rr && rr.participantsAskedAt === null, rr ? String(rr.participantsAskedAt) : "no job");
  check("c2 nextJob() still returns it after refresh", (jq.nextJob(refreshed) || {}).dir === "/m/legacy");
}

/* --- Case 3: empty roster is whitelisted but stored as null (never a bogus []) --- */
{
  const file = path.join(tmp, "empty.json");
  let q = jq.add(jq.emptyQueue(), {
    dir: "/m/empty", reason: "defer", sources: ["system"], durationSec: 5,
    participants: [], participantsSource: "timeout", participantsAskedAt: "2024-02-02T00:00:00.000Z",
  });
  const job = q.jobs[0];
  check("c3 empty roster normalized to null in the job", job.participants === null && job.participantsSource === null, JSON.stringify({ p: job.participants, s: job.participantsSource }));
  jq.save(file, q);
  const back = jq.nextJob(jq.load(file).queue);
  check("c3 empty roster still null after save/load", back.participants === null, String(back.participants));
}

fs.rmSync(tmp, { recursive: true, force: true });

if (failures === 0) {
  console.log("\nALL PASS");
  process.exit(0);
} else {
  console.log("\n" + failures + " FAILURE(S)");
  process.exit(1);
}
