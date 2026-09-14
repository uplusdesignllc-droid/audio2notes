"use strict";
/* Persistent queue of recordings waiting to be transcribed ("defer" mode).
 *
 * Rationale: on battery the only lever that really saves the battery is NOT
 * running Whisper at all. So a recording can be parked here and picked up when
 * the machine is back on AC power — and because the queue is on disk, quitting
 * the app (or the idle auto-quit) never loses a meeting. */

const fs = require("fs");
const path = require("path");

function emptyQueue() {
  return { version: 1, jobs: [] };
}

/** Read the queue; a corrupt file yields an empty queue plus an error string. */
function load(file) {
  try {
    const raw = fs.readFileSync(file, "utf8");
    const j = JSON.parse(raw.replace(/^\uFEFF/, ""));
    return { queue: { version: 1, jobs: Array.isArray(j.jobs) ? j.jobs : [] }, error: null };
  } catch (e) {
    if (e.code === "ENOENT") return { queue: emptyQueue(), error: null };
    return { queue: emptyQueue(), error: `队列文件损坏（${e.message}），已按空队列处理` };
  }
}

function save(file, queue) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(queue, null, 2), "utf8");
  return queue;
}

/** Add (or refresh) a job. Duplicate dirs are merged, never duplicated. */
function add(queue, job) {
  const next = { version: 1, jobs: (queue.jobs || []).filter((j) => j.dir !== job.dir) };
  next.jobs.push({
    dir: job.dir,
    createdAt: job.createdAt || new Date().toISOString(),
    reason: job.reason || "deferred",
    sources: job.sources || [],
    durationSec: job.durationSec || 0,
    /* Per-track capture provenance (capture.exe's READY format + T0 anchor). It
     * MUST be whitelisted here: `add` rebuilds the job from named fields, so any
     * field not listed is silently dropped — which is exactly how the deferred
     * path lost the metadata the live pipeline records. */
    captureInfo: job.captureInfo || null,
    attempts: job.attempts || 0,
    lastError: job.lastError || null,
  });
  return next;
}

function remove(queue, dir) {
  return { version: 1, jobs: (queue.jobs || []).filter((j) => j.dir !== dir) };
}

function markAttempt(queue, dir, error) {
  const jobs = (queue.jobs || []).map((j) =>
    j.dir === dir ? { ...j, attempts: (j.attempts || 0) + 1, lastError: error || null } : j
  );
  return { version: 1, jobs };
}

function size(queue) {
  return (queue.jobs || []).length;
}

/** Entry point: the oldest job that has not burned through its retries. */
function nextJob(queue, maxAttempts = 3) {
  const jobs = (queue.jobs || []).filter((j) => (j.attempts || 0) < maxAttempts);
  if (!jobs.length) return null;
  return jobs.slice().sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))[0];
}

module.exports = { emptyQueue, load, save, add, remove, markAttempt, size, nextJob };
