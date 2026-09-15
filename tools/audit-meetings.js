#!/usr/bin/env node
/*
 * tools/audit-meetings.js
 *
 * Read-only health check for the Audio2Notes meeting archive. Scans every
 * meeting directory under `meeting notes` and reports anomalies as findings
 * (ERROR / WARN / INFO). Intended to be run after the app has been in use for
 * a while, to catch regressions from a large round of changes.
 *
 * READ-ONLY: only uses fs.readFileSync / readdirSync / statSync / existsSync.
 * No child processes, no writes, no new dependencies. CommonJS.
 *
 * Usage:
 *   node tools/audit-meetings.js [--root <dir>] [--since <YYYY-MM-DD>] [--json]
 *
 *   --root   defaults to "meeting notes" relative to the repo root.
 *   --since  only meetings on/after this date (from dir name or mtime) are
 *            scanned; older ones are SKIPPED. Defaults to today, because
 *            meetings recorded before the recent changes legitimately lack
 *            newer meta fields and must not be reported as failures.
 *   --json   machine-readable output instead of the text report.
 *
 * Exit code: 0 when there are no ERROR/WARN findings, 1 when there are.
 */
'use strict';

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Small read-only filesystem helpers
// ---------------------------------------------------------------------------

function statOrNull(p) {
  try { return fs.statSync(p); } catch { return null; }
}
function fileExists(p) { const s = statOrNull(p); return s != null && s.isFile(); }
function fileStat(p) {
  const s = statOrNull(p);
  return s && s.isFile() ? s : null;
}
function readFileOrNull(p) {
  if (!fileExists(p)) return null;
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}
function readJsonOrNull(p) {
  const s = readFileOrNull(p);
  if (s == null) return null;
  try { return JSON.parse(s); } catch { return null; }
}
function listDir(dir) {
  try { return fs.readdirSync(dir); } catch { return []; }
}

// ---------------------------------------------------------------------------
// Date handling
// ---------------------------------------------------------------------------

function zeroPad2(n) { return String(n).padStart(2, '0'); }
function localDateStr(d) {
  return `${d.getFullYear()}-${zeroPad2(d.getMonth() + 1)}-${zeroPad2(d.getDate())}`;
}
// 10-char directory name prefix, e.g. "2026-09-13_224155" -> "2026-09-13".
function dateFromName(name) {
  const m = /^(\d{4}-\d{2}-\d{2})_/.exec(String(name || ''));
  return m ? m[1] : null;
}
function dateFromMtime(dir) {
  const s = statOrNull(dir);
  if (!s) return null;
  return localDateStr(new Date(s.mtimeMs));
}
function meetingDate(dir, name) {
  const fromName = dateFromName(name);
  if (fromName) return { date: fromName, source: 'name' };
  const fromMtime = dateFromMtime(dir);
  if (fromMtime) return { date: fromMtime, source: 'mtime' };
  return { date: null, source: 'none' };
}

// ---------------------------------------------------------------------------
// Status-file line parsing
// ---------------------------------------------------------------------------

function parseT0(content) {
  if (!content) return null;
  for (const line of String(content).split(/\r?\n/)) {
    const m = /^\s*T0\s+qpc=(\d+)\s+freq=(\d+)\s+unixms=(\d+)/.exec(line);
    if (m) return { qpc: parseInt(m[1], 10), freq: parseInt(m[2], 10), unixms: parseInt(m[3], 10) };
  }
  return null;
}
function parseFinished(content) {
  if (!content) return null;
  for (const line of String(content).split(/\r?\n/)) {
    const m = /\bFINISHED\s+bytes=\d+\s+dur=([\d.]+)/.exec(line);
    if (m) { const v = parseFloat(m[1]); return Number.isFinite(v) ? v : null; }
  }
  return null;
}
function hasLimitLine(content) {
  return !!content && /\bLIMIT\s+bytes=\d+\s+limit=\d+/m.test(String(content));
}

// ---------------------------------------------------------------------------
// Noise-chunk detection
// ---------------------------------------------------------------------------

// Denoise a chunk: trim, lowercase, drop punctuation/brackets, collapse spaces.
function denoise(text) {
  let s = String(text == null ? '' : text).trim().toLowerCase();
  s = s.replace(/[^0-9a-z ]+/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}
const NOISE_TOKENS = new Set([
  'blank audio', 'blank_audio', 'silence', 'music', 'applause', 'laughter',
  'clapping', 'noise', 'background', 'ambient', 'room tone',
]);

// ---------------------------------------------------------------------------
// Per-meeting audit
// ---------------------------------------------------------------------------

function auditMeeting(rootDir, name, since) {
  const dir = path.join(rootDir, name);
  const files = listDir(dir);
  const set = new Set(files);
  const findings = [];

  const add = (severity, check, message) =>
    findings.push({ severity, check, message });

  /* A meeting whose directory was touched moments ago is almost certainly still
   * being processed — mixing, transcribing, summarizing — so the "artifact is
   * missing" checks below would be false alarms. This tool exists to look at a
   * FINISHED meeting; crying wolf while the pipeline is mid-flight is worse than
   * useless, because it trains the reader to ignore the output. */
  const IN_FLIGHT_MS = 20 * 60 * 1000;
  let newestMtime = 0;
  for (const f of files) {
    try {
      const st = fs.statSync(path.join(dir, f));
      if (st.mtimeMs > newestMtime) newestMtime = st.mtimeMs;
    } catch { /* ignore */ }
  }
  const inFlight = newestMtime > 0 && Date.now() - newestMtime < IN_FLIGHT_MS;
  const inFlightNote = inFlight
    ? ` — the directory was modified ${Math.round((Date.now() - newestMtime) / 1000)} s ago, so the pipeline looks like it is still running`
    : '';

  // ---- meta.json ----------------------------------------------------------
  const hasMetaFile = set.has('meta.json');
  let meta = null;
  if (hasMetaFile) {
    meta = readJsonOrNull(path.join(dir, 'meta.json'));
    if (meta == null) add('ERROR', 'meta-missing', 'meta.json is present but not valid JSON');
  } else {
    add(inFlight ? 'INFO' : 'ERROR', 'meta-missing', `meta.json is missing${inFlightNote}`);
  }

  // ---- required artifacts -------------------------------------------------
  if (!set.has('transcript.json')) add(inFlight ? 'INFO' : 'ERROR', 'transcript-missing', `transcript.json is missing${inFlightNote}`);
  if (!set.has('notes.md')) add(inFlight ? 'INFO' : 'ERROR', 'notes-missing', `notes.md is missing${inFlightNote}`);

  // ---- check 2: tiny .opus ------------------------------------------------
  for (const f of files) {
    if (!/\.opus$/i.test(f)) continue;
    const s = fileStat(path.join(dir, f));
    if (s && s.size < 1024) {
      add('ERROR', 'opus-size', `${f} is ${s.size} bytes (<1024) — likely a failed/empty encode`);
    }
  }

  // ---- check 3: audio.errors ---------------------------------------------
  if (meta && meta.audio && Array.isArray(meta.audio.errors) && meta.audio.errors.length > 0) {
    add('ERROR', 'audio-errors', `meta.audio.errors has ${meta.audio.errors.length} entries: ${meta.audio.errors.map((e) => JSON.stringify(e)).join('; ')}`);
  }

  // ---- status file contents (shared by 4,5,6,7,14) -------------------------
  const statusFiles = files.filter((f) => /\.status$/i.test(f));
  const status = {};
  for (const f of statusFiles) status[f] = readFileOrNull(path.join(dir, f));

  // ---- check 4: the capture format actually delivered ----------------------
  // The PRODUCER's own READY line is the authoritative evidence that the
  // requested 16 kHz mono really engaged: capture.exe emits it after
  // Initialize, so it reports the format the client was actually given.
  // meta.capture is only a copy of that, and it is absent for every meeting
  // recorded before that field existed — so it must NOT be the source of truth.
  // A disagreement between the two is worth reporting on its own: it would mean
  // the parser that fills meta.capture is wrong.
  const readyFmt = {};
  for (const track of ['system', 'mic']) {
    const txt = status[`${track}.status`];
    const m = txt && txt.match(/^READY fmt=(\d+:\d+:\d+)/m);
    if (m) readyFmt[track] = m[1];
  }
  const tracksSeen = Object.keys(readyFmt);
  if (!tracksSeen.length) {
    add('INFO', 'capture', 'no READY line found (status files absent) — capture format unknown');
  } else {
    for (const track of tracksSeen) {
      if (readyFmt[track] !== '16000:1:16') {
        add('WARN', 'capture', `${track}.status reports READY fmt=${readyFmt[track]} (expected 16000:1:16 — AUTOCONVERTPCM fell back to the mix format)`);
      }
    }
    const cap = meta && meta.capture;
    if (cap == null) {
      add('INFO', 'capture', `meta.json has no capture field (either recorded before it existed, or meta is not written yet); status files report ${tracksSeen.map((t) => `${t}=${readyFmt[t]}`).join(', ')}`);
    } else if (typeof cap !== 'object' || Array.isArray(cap)) {
      add('WARN', 'capture', `meta.capture has unexpected shape: ${JSON.stringify(cap)}`);
    } else {
      for (const track of tracksSeen) {
        const t = cap[track];
        if (t && typeof t === 'object' && typeof t.format === 'string' && t.format !== readyFmt[track]) {
          add('WARN', 'capture', `meta.capture.${track}.format="${t.format}" disagrees with ${track}.status READY fmt=${readyFmt[track]} (the parser filling meta is wrong)`);
        }
      }
    }
  }

  // ---- check 5: T0 start-time skew ---------------------------------------
  const sysT0 = parseT0(status['system.status']);
  const micT0 = parseT0(status['mic.status']);
  if (sysT0 && micT0) {
    const freq = (sysT0.freq || micT0.freq) || 0;
    if (freq > 0) {
      const skewMs = ((micT0.qpc - sysT0.qpc) / freq) * 1000;
      const unixMsDiff = micT0.unixms - sysT0.unixms;
      if (Math.abs(skewMs) > 500) {
        const disagree = Math.abs(unixMsDiff - skewMs);
        const cross = disagree > 5
          ? `qpc-based ${skewMs.toFixed(1)} ms vs unixms-based ${unixMsDiff} ms (disagree by ${disagree.toFixed(1)} ms)`
          : `qpc-based ${skewMs.toFixed(1)} ms (unixms-based ${unixMsDiff} ms, consistent)`;
        add('WARN', 't0-skew', `track start-time skew ${skewMs.toFixed(1)} ms (>500 ms); ${cross}`);
      }
    }
  }

  // ---- check 6: cross-track duration divergence ---------------------------
  const sysDur = parseFinished(status['system.status']);
  const micDur = parseFinished(status['mic.status']);
  if (sysDur != null && micDur != null) {
    const diff = Math.abs(sysDur - micDur);
    if (diff > 1.0) {
      add('WARN', 'dur-divergence', `system dur=${sysDur}s vs mic dur=${micDur}s (diff ${diff.toFixed(2)}s > 1.0s — timeline divergence)`);
    }
  }

  // ---- check 7: LIMIT / limitReached / stopReason -------------------------
  for (const f of statusFiles) {
    if (hasLimitLine(status[f])) {
      add('INFO', 'limit-line', `a LIMIT line appears in ${f} (capture was length-limited)`);
    }
  }
  if (meta && meta.limitReached != null) add('INFO', 'limit-reached', `meta.limitReached = ${JSON.stringify(meta.limitReached)}`);
  if (meta && meta.stopReason != null) add('INFO', 'stop-reason', `meta.stopReason = "${meta.stopReason}"`);

  // ---- check 8: effective bitrate ----------------------------------------
  /* Per TRACK. This check used to add every non-mixed .opus file together and then
   * compare that TOTAL against the per-track preset, which is dimensionally wrong:
   * two parallel tracks each encoded at ~32 kbps sum to ~64 kbps, so any recording
   * where both tracks carry real audio measured about twice the preset and warned.
   * Measured 2026-09-15_104952 (39.27 s): mic 118 434 B + system 158 579 B =
   * 277 013 B -> 56.4 kbps vs a 32 kbps preset, "+76%".
   * It stayed hidden for days because the earlier meetings were almost entirely
   * silent: VBR collapsed each track well below the preset, so the sum happened to
   * land near it. The severity ORDER is left exactly as it was (ratio < 0.5 -> INFO
   * because VBR legitimately collapses on silent material, otherwise > 35 % deviation
   * -> WARN); whether those two branches are ordered sensibly is a separate open
   * question recorded in BACKLOG §9.5. */
  if (meta &&
      typeof meta.durationSec === 'number' && meta.durationSec > 0 &&
      meta.audio && typeof meta.audio.bitrateKbps === 'number' && meta.audio.bitrateKbps > 0 &&
      Array.isArray(meta.audio.files)) {
    const preset = meta.audio.bitrateKbps;
    const measured = meta.audio.files
      .filter((f) => f && typeof f.to === 'string' && /\.opus$/i.test(f.to) &&
        !/mixed\.opus$/i.test(f.to) && typeof f.after === 'number')
      .map((f) => ({ name: f.to, kbps: (f.after * 8) / meta.durationSec / 1000 }));
    const fmt = (t) => `${t.name} ${t.kbps.toFixed(1)} kbps`;
    const deviating = measured.filter((t) => Math.abs(t.kbps / preset - 1) > 0.35);
    const collapsed = deviating.filter((t) => t.kbps / preset < 0.5);
    const suspicious = deviating.filter((t) => t.kbps / preset >= 0.5);
    if (suspicious.length) {
      add('WARN', 'effective-bitrate', `${suspicious.map(fmt).join(', ')} deviates from preset ${preset} kbps by more than 35% (per-track)`);
    }
    if (collapsed.length) {
      add('INFO', 'effective-bitrate', `${collapsed.map(fmt).join(', ')} vs preset ${preset} kbps (<50% — VBR legitimately drops on silent material)`);
    }
  }

  // ---- check 9: .wav remains although archived ----------------------------
  const wavFiles = files.filter((f) => /\.wav$/i.test(f));
  const archived = !!(meta && meta.audio && Array.isArray(meta.audio.files) && meta.audio.files.length > 0);
  if (wavFiles.length > 0 && archived) {
    const keepWav = !!(meta && meta.audio && meta.audio.keepWav === true);
    add(keepWav ? 'INFO' : 'WARN', 'wav-remains',
      `${wavFiles.length} .wav file(s) remain although files were archived${keepWav ? ' (keepWav=true — expected)' : ''}: ${wavFiles.join(', ')}`);
  }

  // ---- check 10: leftover .tmp / .probe-* --------------------------------
  /* A `.tmp` file is part of the DESIGNED archive write: ffmpeg encodes to
   * `<out>.tmp`, the result is verified, and only then is it renamed over the real
   * file. So while the archive is running one is *expected* to be present, and this
   * check used to fire WARN during every healthy archive — observed twice on
   * 2026-09-15, first on mic.opus.tmp and then on mixed.opus.tmp minutes later.
   * It therefore gets the same in-flight exemption as the missing-artifact checks
   * above (see the comment at IN_FLIGHT_MS). A `.tmp` in a STALE directory is still
   * real evidence of a crashed run, so it stays a WARN there. */
  const tempFiles = files.filter((f) => /\.tmp$/i.test(f) || /\.probe-[^\s]+$/i.test(f));
  if (tempFiles.length > 0) {
    add(inFlight ? 'INFO' : 'WARN', 'tmp-probe',
      `leftover temp/progress file(s): ${tempFiles.join(', ')}${inFlightNote}`);
  }

  // ---- check 11: notes fallback / translation skipped ---------------------
  if (meta && meta.notesFallbackReason != null) add('WARN', 'notes-fallback', `meta.notesFallbackReason = ${JSON.stringify(meta.notesFallbackReason)}`);
  if (meta && meta.translationSkipped != null) add('INFO', 'translation-skipped', `meta.translationSkipped = ${JSON.stringify(meta.translationSkipped)}`);

  // ---- check 12: noise-only transcript chunks -----------------------------
  const transcript = readJsonOrNull(path.join(dir, 'transcript.json'));
  if (transcript && Array.isArray(transcript.chunks)) {
    const hits = [];
    for (const c of transcript.chunks) {
      if (!c || typeof c.text !== 'string') continue;
      if (NOISE_TOKENS.has(denoise(c.text))) hits.push(c.text.trim());
    }
    if (hits.length > 0) {
      const ex = hits.slice(0, 2).map((h) => JSON.stringify(h)).join(', ');
      add('INFO', 'noise-chunks', `${hits.length} noise-only chunk(s) (e.g. ${ex})`);
    }
  }

  // ---- check 13: silence-skip did not engage on a long recording ----------
  if (meta &&
      meta.audioStats &&
      typeof meta.audioStats.silenceSkippedSec === 'number' &&
      meta.audioStats.silenceSkippedSec === 0 &&
      typeof meta.durationSec === 'number' && meta.durationSec > 600) {
    add('INFO', 'silence-skip-idle', `silenceSkippedSec=0 on a ${meta.durationSec}s recording (silence-skip did not engage)`);
  }

  // ---- check 14: stray status/stop files ---------------------------------
  const stray = files.filter((f) => f === 'system.stop' || f === 'mic.stop' || /\.status$/i.test(f));
  if (stray.length > 0) {
    add('INFO', 'stray-status', `${stray.length} leftover status/stop file(s) (known, P4-4): ${stray.join(', ')}`);
  }

  // ---- check 15: no audio at all -----------------------------------------
  const audioFiles = files.filter((f) => /\.opus$/i.test(f) || /\.wav$/i.test(f));
  if (audioFiles.length === 0) {
    add('INFO', 'no-audio', 'no audio files (.opus/.wav) present in this meeting directory');
  }

  // ---- duration for display ----------------------------------------------
  let durationSec = null;
  if (meta && typeof meta.durationSec === 'number' && meta.durationSec > 0) durationSec = meta.durationSec;
  else if (sysDur != null) durationSec = sysDur;

  return { name, durationSec, findings };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { root: null, since: null, json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') args.root = argv[++i];
    else if (a === '--since') args.since = argv[++i];
    else if (a === '--json') args.json = true;
    else if (a === '--help' || a === '-h') args.help = true;
  }
  if (args.since) args.since = String(args.since).slice(0, 10);
  return args;
}

function fmtDuration(n) {
  if (n == null) return '?s';
  return `${Math.round(n * 10) / 10}s`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    process.stdout.write(
      'Usage: node tools/audit-meetings.js [--root <dir>] [--since <YYYY-MM-DD>] [--json]\n' +
      '  Read-only health check over the Audio2Notes meeting archive.\n' +
      '  --root   (default: "meeting notes" relative to the repo root)\n' +
      '  --since  only scan meetings on/after this date (default: today); older are SKIPPED\n' +
      '  --json   machine-readable output\n'
    );
    process.exitCode = 0;
    return;
  }

  const repoRoot = path.resolve(__dirname, '..');
  const rootDir = args.root ? path.resolve(args.root) : path.join(repoRoot, 'meeting notes');
  const since = args.since || localDateStr(new Date());

  const rootStat = statOrNull(rootDir);
  if (!rootStat || !rootStat.isDirectory()) {
    process.stderr.write(`audit-meetings: root not found: ${rootDir}\n`);
    process.exitCode = 2;
    return;
  }

  const meetingNames = fs.readdirSync(rootDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();

  const meetings = [];
  let scanned = 0;
  let skipped = 0;

  for (const name of meetingNames) {
    const dir = path.join(rootDir, name);
    const { date, source } = meetingDate(dir, name);

    if (since != null && date != null && date < since) {
      skipped += 1;
      meetings.push({ name, date, dateSource: source, skipped: true, findings: [] });
      continue;
    }

    const res = auditMeeting(rootDir, name, since);
    scanned += 1;
    meetings.push({
      name,
      durationSec: res.durationSec,
      date,
      dateSource: source,
      skipped: false,
      findings: res.findings,
    });
  }

  const counts = { ERROR: 0, WARN: 0, INFO: 0 };
  for (const m of meetings) for (const f of m.findings) counts[f.severity] = (counts[f.severity] || 0) + 1;
  const exitCode = (counts.ERROR > 0 || counts.WARN > 0) ? 1 : 0;

  const report = {
    root: rootDir,
    since,
    generatedAt: new Date().toISOString(),
    scanned,
    skipped,
    counts,
    exitCode,
    meetings,
  };

  if (args.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    const out = [];
    out.push('Audio2Notes meeting audit');
    out.push(`root   : ${rootDir}`);
    out.push(`since  : ${since} (meetings before this date are SKIPPED)`);
    out.push('');
    for (const m of meetings) {
      out.push(`${m.name}   (${fmtDuration(m.durationSec)})`);
      if (m.skipped) {
        out.push(`  SKIPPED  before since=${since} (recorded before the audited changes)`);
        continue;
      }
      if (m.findings.length === 0) {
        out.push('  OK');
        continue;
      }
      for (const f of m.findings) {
        out.push(`  ${f.severity.padEnd(5)} ${f.check}: ${f.message}`);
      }
    }
    out.push('');
    out.push('----');
    out.push(`Summary: ERROR ${counts.ERROR}  WARN ${counts.WARN}  INFO ${counts.INFO}`);
    out.push(`meetings scanned: ${scanned}   skipped (before ${since}): ${skipped}`);
    out.push(`exit code 1 = ERROR/WARN findings exist (got ${exitCode})`);
    process.stdout.write(out.join('\n') + '\n');
  }

  process.exitCode = exitCode;
}

try {
  main();
} catch (err) {
  process.stderr.write(`audit-meetings: ${err && err.message ? err.message : String(err)}\n`);
  process.exitCode = 2;
}
