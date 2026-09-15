"use strict";
/* p6-participants-test: unit tests for src/participants.js (the participant
 * roster gate). No test runner in this repo — runs under plain node:
 *   node test\p6-participants.test.js
 * Exits 0 on all-pass, non-zero on any failure (precedent: p2-5-test.js). */
const { createParticipantGate } = require("../src/participants.js");

let failures = 0;
function check(name, cond, detail) {
  console.log((cond ? "PASS " : "FAIL ") + name + (cond ? "" : " — " + detail));
  if (!cond) failures++;
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Await p, but never let it hang or reject unobserved: returns p's value, or a
// sentinel {__hung} / {__rejected} so the check() below can flag a hang or a
// rejection. wait()'s contract says "never rejects, never hangs", so either
// sentinel is a bug.
function awaitGuarded(p, ms, label) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve({ __hung: true, label }), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); resolve({ __rejected: e && e.message ? e.message : String(e) }); }
    );
  });
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function main() {
  /* 1 — answer {names}: resolves wait with source "answered" + sanitised names */
  {
    const g = createParticipantGate();
    const r = g.request({ dir: "d1", suggested: ["Bob", "Alice"] });
    check("1a request -> id + prefill", r.id === "p1" && same(r.prefill, ["Bob", "Alice"]), JSON.stringify(r));
    const p = g.wait(r.id);
    const ok1 = g.answer(r.id, { names: ["  ", "alice", "Alice", 42, "  bob  "] });
    const out = await awaitGuarded(p, 500, "t1");
    check("1b answer(names) returns true first", ok1 === true, String(ok1));
    check("1c resolves (no hang/reject) with source=answered", !out.__hung && !out.__rejected && out.source === "answered", JSON.stringify(out));
    check("1d names sanitised: trimmed, 42 dropped, 'Alice' deduped", same(out.names, ["alice", "bob"]), JSON.stringify(out.names));
  }

  /* 2 — {unchanged:true}: one-click dismissal resolves with the PREFILL, source "unchanged" */
  {
    const g = createParticipantGate();
    const r = g.request({ dir: "d2", suggested: ["  Carol  ", "Dan"] });
    const p = g.wait(r.id);
    const ok = g.answer(r.id, { unchanged: true });
    const out = await awaitGuarded(p, 500, "t2");
    check("2a unchanged -> true", ok === true, String(ok));
    check("2b source=unchanged", out.source === "unchanged", JSON.stringify(out));
    check("2c names = prefill (sanitised at request time)", same(out.names, ["Carol", "Dan"]), JSON.stringify(out.names));
  }

  /* 3 — {cancel:true}: resolves with empty names, source "cancelled" */
  {
    const g = createParticipantGate();
    const r = g.request({ dir: "d3", suggested: ["X"] });
    const p = g.wait(r.id);
    const ok = g.answer(r.id, { cancel: true });
    const out = await awaitGuarded(p, 500, "t3");
    check("3a cancel -> true", ok === true, String(ok));
    check("3b source=cancelled, names empty", out.source === "cancelled" && same(out.names, []), JSON.stringify(out));
  }

  /* 4 — timeout (tiny real timeoutMs): resolves with source "timeout", NEVER rejects/hangs */
  {
    const g = createParticipantGate({ timeoutMs: 40 });
    const r = g.request({ dir: "t1" });
    const p = g.wait(r.id);
    const out = await awaitGuarded(p, 1000, "t4");
    check("4a timeout resolves (no hang, no reject)", !out.__hung && !out.__rejected, JSON.stringify(out));
    check("4b source=timeout, names empty", out.source === "timeout" && same(out.names, []), JSON.stringify(out));
    check("4c no longer pending after timeout", g.pending().length === 0, JSON.stringify(g.pending()));
  }

  /* 5 — answer on unknown id -> false, no throw; answering twice -> second false */
  {
    const g = createParticipantGate();
    let threw = false, unknown;
    try { unknown = g.answer("no-such-id", { names: ["A"] }); }
    catch (e) { threw = true; unknown = "(threw " + e.message + ")"; }
    check("5a unknown id answer -> false, no throw", threw === false && unknown === false, String(unknown));

    const r = g.request({ dir: "dv" });
    g.wait(r.id);
    const a1 = g.answer(r.id, { names: ["A"] });
    const a2 = g.answer(r.id, { names: ["B"] }); // second: already answered
    check("5b first answer true, second answer false (no throw)", a1 === true && a2 === false, "a1=" + a1 + " a2=" + a2);
  }

  /* 6 — a second request() for the same dir returns the SAME id/prefill (one-per-dir) */
  {
    const g = createParticipantGate();
    const a = g.request({ dir: "dup", suggested: ["A", "B"] });
    const b = g.request({ dir: "dup", suggested: ["C"] });
    check("6a same dir -> same id", a.id === b.id, "a=" + a.id + " b=" + b.id);
    check("6b second request returns the ORIGINAL prefill", same(b.prefill, ["A", "B"]), JSON.stringify(b.prefill));
    check("6c exactly one outstanding request", g.pending().length === 1, JSON.stringify(g.pending()));
    check("6d two request()s, two distinct dirs -> two ids",
      (() => { const g2 = createParticipantGate(); return g2.request({ dir: "x" }).id !== g2.request({ dir: "y" }).id; })(), "");
  }

  /* 7 — abandon() settles a pending wait (source "cancelled") and clears pending() */
  {
    const g = createParticipantGate();
    const r = g.request({ dir: "ab", suggested: ["A"] });
    const p = g.wait(r.id);
    const listed = g.pending().includes(r.id);
    const ok = g.abandon(r.id);
    const out = await awaitGuarded(p, 500, "t7");
    check("7a was listed pending before abandon", listed === true, JSON.stringify(g.pending()));
    check("7b abandon returns true", ok === true, String(ok));
    check("7c wait resolves with source=cancelled", out.source === "cancelled" && same(out.names, []), JSON.stringify(out));
    check("7d no longer pending after abandon", g.pending().length === 0, JSON.stringify(g.pending()));
    check("7e abandon(unknown)/abandon(again) -> false, no throw",
      g.abandon("nope") === false && g.abandon(r.id) === false, "");
  }

  /* 8 — sanitisation bounds: 40-entry cap, 80-char cap, drop non-string/empty, ci-dedupe */
  {
    const g = createParticipantGate();
    const cap45 = g.request({ dir: "s1", suggested: Array.from({ length: 45 }, (_, i) => "n" + i) });
    check("8a 45 names capped to 40", cap45.prefill.length === 40, "len=" + cap45.prefill.length);

    const capLong = g.request({ dir: "s2", suggested: ["z".repeat(100)] });
    check("8b 100-char name capped to 80", capLong.prefill.length === 1 && capLong.prefill[0].length === 80, JSON.stringify(capLong.prefill));

    const drop = g.request({ dir: "s3", suggested: ["  Keep  ", "", "   ", 7, null, [], "keep", "KEEP"] });
    check("8c drop empties & non-strings, ci-dedupe, trim", same(drop.prefill, ["Keep"]), JSON.stringify(drop.prefill));

    const missing = g.request({ dir: "s4", suggested: null });
    check("8d missing/null suggested -> []", same(missing.prefill, []), JSON.stringify(missing.prefill));
  }

  /* 9 — wait() on an unknown id: resolves quickly with the fallback, never hangs or rejects */
  {
    const g = createParticipantGate();
    const p = g.wait("not-a-real-id");
    const out = await awaitGuarded(p, 500, "t9");
    check("9a wait(unknown) resolves (no hang/reject)", !out.__hung && !out.__rejected, JSON.stringify(out));
    check("9b documented fallback {names:[],source:'timeout'}", out.source === "timeout" && same(out.names, []), JSON.stringify(out));
  }

  /* 10 — timeoutMs:0 means "never time out", yet still answerable and abandonable */
  {
    const g = createParticipantGate({ timeoutMs: 0 });
    const r = g.request({ dir: "z1", suggested: ["A"] });
    const p = g.wait(r.id);
    await sleep(120); // well past a (clamped) 0/1ms timer: nothing should have fired
    check("10a timeoutMs:0 keeps the request outstanding (no auto-settle)", g.pending().includes(r.id), JSON.stringify(g.pending()));
    const ok = g.answer(r.id, { names: ["Zed"] });
    const out = await awaitGuarded(p, 500, "t10a");
    check("10b still answerable -> source=answered", ok === true && out.source === "answered" && same(out.names, ["Zed"]), JSON.stringify(out));
    check("10c cleared from pending", g.pending().length === 0, JSON.stringify(g.pending()));

    const r2 = g.request({ dir: "z2" });
    const p2 = g.wait(r2.id);
    await sleep(120);
    const ok2 = g.abandon(r2.id);
    const out2 = await awaitGuarded(p2, 500, "t10b");
    check("10d still abandonable -> source=cancelled", ok2 === true && out2.source === "cancelled", JSON.stringify(out2));
  }

  /* 11 — answer BEFORE wait: a late wait still recovers the real outcome (no hang, no 'timeout' lie) */
  {
    const g = createParticipantGate({ timeoutMs: 40 });
    const r = g.request({ dir: "aw", suggested: ["A", "B"] });
    const ok = g.answer(r.id, { names: ["Later"] }); // settle before anyone waited
    const p = g.wait(r.id);                          // wait() arrives AFTER settle
    const out = await awaitGuarded(p, 500, "t11");
    check("11a answer-before-wait: true", ok === true, String(ok));
    check("11b late wait recovers real outcome (answered)", !out.__hung && !out.__rejected && out.source === "answered" && same(out.names, ["Later"]), JSON.stringify(out));
  }

  /* 12 — injectable clock: gate honours a fake now() and still works end-to-end */
  {
    let calls = 0;
    const fakeNow = () => { calls += 1; return 42; };
    const g = createParticipantGate({ now: fakeNow, timeoutMs: 0 });
    g.request({ dir: "clk" });
    check("12a injected now() invoked at request time", calls >= 1, "calls=" + calls);
    const r = g.request({ dir: "clk2", suggested: ["Sam"] });
    const p = g.wait(r.id);
    g.answer(r.id, { unchanged: true });
    const out = await awaitGuarded(p, 500, "t12");
    check("12b gate behaves under an injected fake clock", out.source === "unchanged" && same(out.names, ["Sam"]), JSON.stringify(out));
  }

  console.log((failures === 0 ? "ALL PASS (12 scenarios)" : failures + " FAILURE(S)"));
}

main().then(
  () => { process.exitCode = failures === 0 ? 0 : 1; },
  (e) => { console.error("\nUNCAUGHT EXCEPTION:", e && e.stack ? e.stack : e); process.exitCode = 1; }
);
