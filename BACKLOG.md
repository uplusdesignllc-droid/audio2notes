# Audio2Notes — Backlog (P0–P4)

> Created 2026-09-13. Companion to `BUILD-STATE.md` (which stays local / gitignored).
> Routing decision made with the user: **keep WAV during recording, convert to Opus afterwards.**
> Base commit is `db8207c`, working tree clean. **Nothing in this file is implemented yet.**

## 0. Decisions already made (do not re-litigate)

1. **Recording stays WAV.** Recording straight to Ogg/Opus was rejected: a WAV whose RIFF
   size is refreshed every 2 s (`capture.c:360-373`) survives a hard kill, whereas an
   Ogg/Opus stream that was never finalized is normally worthless. Writing Opus inside
   `capture.exe` would also make it depend on libopus, destroying its zero-dependency
   property (today it links only `ole32`/`uuid`/`propsys`).
2. **Archive stays Opus, 16 kHz mono**, `-ar 16000 -ac 1 -application voip -vbr on`
   (already implemented: `audioArchive.js:18-33,59-76`). Default preset `opus-24`
   (`config.js:41-42`, `audioArchive.js:33`).
3. **The archive bitrate stays 24 kbps until it is measured.** The user leaned toward
   16 kbps. Neither value has any measured basis: `audioArchive.js:4-6` claims
   re-transcription "loses nothing", and that is an assertion, not a result. The
   difference is **9.3 MB per 155-minute meeting** (18.6 MB at 16 kbps vs 27.9 MB at
   24 kbps) — noise next to a 1.79 GB recording — so this is purely a fidelity choice,
   and Opus is irreversible. **Run P3-2 before changing the default.**
4. **Option B = 16 kHz mono 16-bit capture** = 256 kbps, versus 1536 kbps today. This is
   the main lever: 6× smaller, and the discarded detail is exactly what the archive
   throws away anyway.
5. **No process loopback.** It is endpoint-independent (which would remove the
   device-switch failure class) but captures **all zeros for the Teams desktop app** —
   and Teams is one of the three target applications. See §1.7.

## 1. Facts established 2026-09-13 (cite these; do not re-derive)

### 1.1 Byte accounting — the 6× / 10.7× decomposition

| Stage | Format | Bitrate | Per hour |
|---|---|---|---|
| Recording today | 48 kHz / 2ch / 16-bit | **1536 kbps** | 192,000 B/s = 659 MiB/h (691 MB/h) |
| Recording after option B | 16 kHz / 1ch / 16-bit | **256 kbps** | 32,000 B/s = 110 MiB/h (115 MB/h) |
| Archive `opus-16` | Opus 16 kbps VBR | 16 kbps | 7.2 MB/h |
| Archive `opus-24` (default) | Opus 24 kbps VBR | 24 kbps | 10.8 MB/h |

- Format axis (48k/2ch → 16k/1ch) = **6×**; codec axis (16k mono PCM → Opus 24k) = **10.7×**;
  total 64×. Against `opus-16` the total is 96×.
- Trap worth remembering: **"16 kHz" (sample rate) and "16 kbps" (bitrate) are different
  axes** — 16,000 × 16 = 256 kbps. The coincidence of the number 16 is easy to misread
  as "the archive is bigger than the recording".
- The archive is **VBR** (`audioArchive.js:66`), so `scan()` / `estimateBytesPerHour`
  (constant-bitrate math at `:48,259,274`) **overestimate** reclaimable space.

### 1.2 RIFF 4 GiB wrap — unguarded silent corruption
`capture.c` writes the RIFF size fields as `DWORD` (`:213`, `:230`, `:233`, `:367`, `:370`)
while the accumulator `written` is `long long` (`:311`). Past 4 GiB the header wraps to a
small number and the file decodes as a few seconds. Ceilings: **6.21 h** at 48 kHz stereo,
**37.3 h** after option B. The only existing guards are `minFreeDiskGB: 2`
(`config.js:54`, `lifecyclePolicy.js:29-41`) and the forgotten-recording guard —
**there is no duration guard anywhere.**

### 1.3 Disk guard watches the wrong volume
`freeDiskGB()` (`main.js:64-71`) stats `path.parse(process.cwd()).root`, not the meeting
directory's volume. Currently benign only because `meetingsDir` and the app both live on
`C:`; it breaks the moment recordings go to another drive.

### 1.4 Archive verification cannot detect a truncated output
`verifyAudio()` (`audioArchive.js:78-81`) runs `ffmpeg -i <file> -f null -` and checks only
the exit code. Ogg/Opus is designed to be salvageable, so a truncated file still decodes
cleanly — and then the source WAV is deleted (`:155`). **This is a live silent-data-loss
path.** Related: `archiveFile()` encodes straight to the final name (`:130-141`), so a crash
mid-encode leaves a correctly-named partial file.

### 1.5 Pipeline order — ASR never reads the lossy file on the main path
`record:stop` (`main.js:632-746`): stop captures → mix (`:670-673`) → **transcribe from the
WAVs** (`:674-686`) → translate → summarize → `writeArtifacts` (`:715`) → **archive last**
(`:717-724`). The "lossy Opus hurts ASR" concern therefore applies only to re-runs:
`file:transcribe` (`:748`) and the `pick(["system.opus","system.wav"])` preference at
`:284-285`. Consequence: WAV peak residency ≈ recording + the whole pipeline
(a 155-minute meeting ≈ **3.2 h**), not merely the recording duration.

### 1.6 ffmpeg: the capture wall is upstream and permanent
Verified against `node_modules\ffmpeg-static\ffmpeg.exe` (6.1.1): `-devices` lists only
`dshow gdigrab lavfi vfwcap` — **no wasapi**; `-f dshow -list_devices true` reports only
"HP 5MP Camera" and then `Could not enumerate audio only devices (or none found)`;
`--enable-libopus` is in the configure line and both the `libopus` encoder and the
`opus` (Ogg Opus) muxer are present. Upstream FFmpeg still has no WASAPI input device
([trac #9408](https://www.ffmpeg.org/pipermail/ffmpeg-trac/2025-May/073534.html) is still
`new`; [#11270](https://ffmpeg.org/pipermail/ffmpeg-trac/2024-October/071445.html) was
closed) → **no Windows build has it, so "upgrade ffmpeg" is not a path.** The blocker is on
the input side and is codec-independent: MP3/AAC/FLAC hit the same wall. This is the accurate
version of BUILD-STATE §8's heading "Direct-to-Opus capture has no off-the-shelf option".

### 1.7 Process loopback: endpoint-independent, but broken for Teams desktop
`ActivateAudioInterfaceAsync` + `AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK` captures only
a given process tree, and per Microsoft's sample documentation the capture "is **not tied to
a specific audio endpoint**" — which would eliminate the device-switch failure class
entirely. Requires Windows 10 build 20348+ (this machine: **26200.9106**, satisfied).
However, a 2025-11 report
([SO 79832526](https://stackoverflow.com/questions/79832526/wasapi-application-loopback-is-unable-to-record-ms-teams))
shows it records **all zeros for `ms-teams.exe`** while working for Slack, Zoom,
Meet-in-browser and Teams-in-browser; endpoint loopback hears Teams fine, and OBS /
win-capture-audio per-app capture also fails on new Teams. That same report used
`IAudioSessionManager2` + `IAudioMeterInformation` and **observed non-zero peak levels on
Teams' render sessions** → **detection works for Teams even though per-process capture does
not.**

### 1.8 Capture-side issues known but not yet scheduled
- `capture.c:275` hardcodes the `eConsole` role; there is no `--device` option
  (`:410-414`), and the device name/ID is never recorded (not in `READY`, not in `meta.json`).
- `capture.c:146` (`sessions`) only enumerates the **default render** endpoint's sessions.
- `capture.c:117` documents a `peak=<0..1>` field that `:176` never emits.
- `capture.c:269` is STA and the record loop never pumps messages → `IMMNotificationClient`
  callbacks would never be delivered (switch to MTA, or poll the default endpoint instead).
- Two independent capture processes, spawned **sequentially** (`main.js:618,621`), share no
  timebase; stop is a sequential `await` (`main.js:638-649`), so the tracks can differ by up
  to 4 s at the tail.
- `emit()` writes to stdout **and** the `--status` file (`capture.c:42-54`).
- `pollLevels()` reads only the **last** line of the status file, every 300 ms
  (`main.js:455-482`).

### 1.9 Documentation drift found
- `BUILD-STATE.md` §2/§6b name `.tools/ffmpeg-master-latest-win64-gpl/bin/ffmpeg.exe`; that
  directory no longer exists. `src/ffmpegPath.js` actually uses
  `.tools/ffmpeg-backup/ffmpeg.exe`, which **does** exist — the code is fine, only the
  documented path is stale.
- BUILD-STATE §8's heading reads as though the codec were the problem; its own body states
  the correct reason ("ffmpeg *can* encode Opus but cannot capture"). Reword the heading.

### 1.10 CPU instrumentation on this machine — CORRECTED 2026-09-13 by calibration
**Earlier claim withdrawn.** I first wrote that "Task Manager's CPU % is unreliable on this
box". That generalisation was wrong; here is the measured picture.

A calibration run pinned **12 of 24 threads** (ground truth = 50%, baseline 5-11%, so an
expected ~55-61%):

| instrument | reading under the known load | verdict |
|---|---|---|
| `\Processor(_Total)\% Processor Time` | 57.1 / 62.6 / 62.8 % | **accurate** |
| per-process CPU-time delta sum | 55.6 % | **accurate** |
| `\Processor Information(_Total)\% Processor Utility` | **101.8 / 107.1 %** | **broken** |

So the counters used throughout this project are trustworthy, and the **broken metric is
`% Processor Utility`** — the very one earlier invoked here as "Task Manager's own metric".
That makes the original anomaly (Task Manager showing **53 % at idle** while two now-calibrated
instruments said 3-20 %) most likely a bad reading on Task Manager's side, not a bad
measurement on mine. How Task Manager derives its number could not be determined from here,
and the case is not fully closed.

What is definitely true and worth keeping:
- **Task Manager is not generally inflated** — under real load it reads correctly. During a
  measured local generation (49.5 % CPU / 70-77 % GPU by instrumentation) it showed ~50-55 %,
  matching. The 53 %-at-idle reading was a one-off, and the machine's CPU+GPU graphs rising
  and falling together is meaningful, not an artefact.
- **One real load signature:** GPU 70-77 % **and** CPU ~50 % (llama-server alone measured
  **1,189 % of one core ≈ 12 cores**) = the local model actively generating. That CPU cost is
  genuine, not a display artefact, because this build uses MTP speculative decoding
  (`draft-mtp`, `draft_num_predict 4`).
- **GPU ~0 % with a sustained high CPU reading** is the combination that deserves a look — that
  was the unexplained case.
- `% Idle Time` also returned an impossible >100 % value, so the *utility/idle* family of
  counters is the unreliable part of this platform, not the time-based ones.
- Still prefer core-seconds (e.g. §8's 31,153 core-s) for judging Audio2Notes' own cost.

### 1.11 Why local-model inference burns ~12 CPU cores — measured, and fixed
**The cause is layers that do not fit in VRAM, not the context length.** Context size only
matters indirectly: it sizes the KV cache, which decides how many layers fit on the GPU, and
whatever does not fit runs on the CPU for **every** token.

Causal A/B, same model, same prompt (a 500-token essay), only the context changed:

| config | layers on GPU | KV cache | llama-server CPU | gen speed | GPU |
|---|---|---|---|---|---|
| 64k ctx (as shipped) | 64/66 — **2 on CPU** | 4096 MiB (f16) | **1,189 % of one core ≈ 11.9 cores ≈ 49.5 % of the machine** | ~23 tok/s | 74 % |
| 8k ctx (diagnostic) | **66/66** | 512 MiB | **101 % of one core ≈ 4.2 %** | 39.0 tok/s | 96 % |

The mechanism is in the log: `llama threadpool init, n_threads = 12`. llama.cpp runs the
CPU-resident layers with a **12-thread pool per token** and then synchronises back to the GPU,
so the CPU cost is both large and proportional to the number of tokens — and it also caps
throughput, because every token waits on those layers. A 529-token generation and a
48,529-token one cost the same CPU, which is what rules context size out as the driver.

**Fix applied 2026-09-13 — keep the full 64k context and get full offload:**
`OLLAMA_FLASH_ATTENTION=1` and `OLLAMA_KV_CACHE_TYPE=q8_0` (User env vars). The KV cache drops
4096 -> **2176 MiB**, which is enough for **66/66 layers**, and:

| | before | after |
|---|---|---|
| llama-server CPU | 1,189 % of one core (~11.9 cores) | **100 % of one core (1 core)** |
| generation | ~23 tok/s | **36.7 tok/s** |
| prompt processing | 52.6 tok/s | **99.5 tok/s** |
| `size_vram` / `size` | 16.998 / 18.366 GB | **17.536 / 17.536 GB — fully resident** |

Note flash attention was **already on by default** (`resolve_fused_ops: Flash Attention
enabled`); only the KV quantisation was needed. Revert by removing the two User env vars and
restarting Ollama.

**Trap found while applying it (generalises beyond Ollama):**
`[Environment]::SetEnvironmentVariable(name, value, "User")` writes the registry but does
**not** update the calling process, and a child inherits the **parent process's** environment —
so launching the app from that same shell silently starts it with the OLD variables. Set
`$env:NAME` in the shell *before* launching (and keep the registry copy for future logins).
The first attempt failed exactly this way: the server logged `OLLAMA_FLASH_ATTENTION:false` and
no `OLLAMA_KV_CACHE_TYPE`, while the llama.cpp side still reported flash attention enabled —
a confusing combination that only the server-config dump resolved.

Diagnostic to keep: `GET /api/ps` -> if `size_vram < size`, part of the model is on the CPU.
And the log line `load_tensors: offloaded N/M layers to GPU` is the authoritative answer.

## 2. Task list

### P0 — fuses (roughly half a day; the only items that stop silent data loss)
- **P0-1 `capture.c`: RIFF size fuse.** Default limit 3.5 GiB (3,758,096,384), overridable
  with `--limit-bytes <n>` (parsed in `main()` next to `--seconds`/`--status`/`--stop`, and
  added to the usage string). Enforce **before** each audio `fwrite`: if
  `written + (long long)frames * fi.channels * 2 > limit`, drop that packet, break the loop
  and stop gracefully. Make all three size sites (initial header, `finalize_wav`, the
  2-second refresh) explicitly 64-bit, narrowing to `DWORD` only after the guard proves it
  is in range. Wire contract: §5.
- **P0-2 `main.js`: disk guard volume.** `freeDiskGB()` must stat
  `path.parse(config.meetingsDir(config.load())).root`; keep the `try/catch`→`null`
  behaviour and the `(bavail * bsize) / 1e9` arithmetic; also include the resolved root in
  the diagnostics payload sent at `main.js:1536` so the UI can show which volume is watched.
- **P0-3 `audioArchive.js`: duration verification.** Add `probeDurationSec(file)` — one full
  decode (`-v error -i <file> -f null -` plus `-progress <tempfile>`, parsing the final
  `out_time_us=`, falling back to `out_time=`) that both proves readability via the exit code
  and yields the duration. Compare output against source with tolerance `max(1%, 0.5 s)`, in
  **both** `archiveFile()` and `transcodeTo()`. On failure: delete the output, keep the
  source, throw a Chinese error in the existing style.
- **P0-4 `audioArchive.js`: atomic output.** Encode to `<out>.tmp`, run every check against
  the temporary file, then `fs.renameSync` onto `<out>`. Never leave a `.tmp` behind; the
  existing "reuse a valid output" path (`:132-139`) must also pass the duration check before
  the source WAV is deleted. Keep the `{from,to,before,after,reused}` contract (used by
  `main.js:437` and `archiveDir`/`archiveAll`).
- **P0-5 `main.js`: consume the `LIMIT` event.** `pollLevels()` must scan the **whole**
  status text for `/^LIMIT\b/m` (the last line is `FINISHED`), fire once per recording
  (guard reset in `record:start`), call `notifyUser(...)`, store
  `rec.limitReached = {track, bytes, limit}`, add it to `meta` (`:696-714`) and to the
  `record:stop` return value, and stop through the same path as the Stop button — by
  extracting the `record:stop` handler body into `async function stopRecordingAndProcess()`
  called by both, with `rec.busy` as the re-entrancy guard.

### P1 — option B: 16 kHz mono capture (the main win; one compile, one packaging pass)
- **P1-1 thread a `rec_fi`.** `FmtInfo` must describe the format actually delivered:
  `convert_to_s16`, the `malloc`/`fwrite` sizes (`capture.c:332-335`), `write_wav_header`
  (`:306`), `frames_per_level` (`:313`) and the periodic refresh (`:367-371`) all key off the
  mix format today. Requesting 16 kHz mono at `Initialize` while leaving those alone causes a
  **heap over-read and a lying header** — a corrupt recording, worse than the LEVEL trap.
  Keep the mix format as `mix_fi` for the fallback path and diagnostics.
- **P1-2 move the LEVEL calculation onto the converted s16 buffer** (`capture.c:337` is
  currently `if (fi.is_float)`). Otherwise `LEVEL` reads 0 on any non-float (PCM) endpoint →
  the watchdog sees "silence" → **auto-stops a perfectly good recording**. Moving it also
  fixes the latent bug for every existing PCM endpoint.
- **P1-3 `AUTOCONVERTPCM` with a mandatory fallback.** Request
  `AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY` with a
  16 kHz/mono/16-bit `WAVEFORMATEX`; on failure fall back to today's mix-format behaviour,
  and record which format was actually used in `READY` and in `meta.json`.
- **Acceptance:** `READY fmt=16000:1:16`; byte count ≈ 32 kB/s × seconds; ffmpeg decodes real
  speech (not silence, not noise); `LEVEL` still moves; duration matches wall clock.
  Gains: 6× size, 4 GiB ceiling 6.21 h → 37.3 h, 6× less write I/O and peak residency, and
  the archive step stops resampling.

### P2 — harden the WAV safety net
- **P2-1 application-level maximum recording duration** (suggested default 8 h) with a clear
  notification — the forgotten-recording guard is not a duration guard.
- **P2-2 shared timebase between the two tracks:** each process emits an anchor
  (`T0 qpc=… freq=… unixms=…`, via `GetSystemTimePreciseAsFileTime`) used to align at merge
  time; and change stop from a sequential `await` (`main.js:638-649`) to "signal both first,
  then await both".
- **P2-3 prove crash recoverability by test, not by assumption:** kill `capture.exe`
  mid-recording and assert the WAV still decodes and its duration ≈ elapsed recording. This
  *should* hold today because of the 2-second header refresh, but it has never been verified.
- **P2-4 write-path tuning:** larger `setvbuf`, separate "data flush" from "header refresh",
  make the refresh interval configurable (default 2 s; 5–10 s trades crash window for fewer
  small writes). Document the tradeoff in the settings help.

### P3 — Opus-side fidelity and traceability
- **P3-1 record archive parameters in `meta.json`:** codec, bitrate, sample rate,
  `-application voip`, **ffmpeg version**, archive time, per-file before/after. Today the
  `meta` object (`main.js:696-714`) holds **no archive information at all** — the result
  exists only in the IPC return value.
- **P3-2 archive bitrate — MEASURED 2026-09-13; the default should move 24 → 32 kbps.**
  Method: 120 s of real speech captured losslessly (`capture.exe record system`, 16 kHz mono),
  then encoded through the production `transcodeTo` at 16/24/32/48 kbps and each variant
  transcribed with the app's own `transcribeFile` (`Xenova/whisper-base.en`, which is what
  `settings.json` uses). `silenceSkip: false` for every variant, so the **only** variable is the
  codec — with skip enabled the codec's noise floor would change the silence detector's frame
  decisions and inject differences unrelated to recognition. An input gate (0.5 s frame RMS,
  p95 taken over non-floor frames) verified the source first: 113.0 s of speech in 120 s.

  | variant | effective | WER | SUB | DEL | INS | edits |
  |---|---|---|---|---|---|---|
  | WAV lossless (reference) | — | 0.00 % | — | — | — | 0 |
  | opus-16 | 15.8 kbps | 9.86 % | 10 | **22** | 2 | 34 |
  | opus-24 | 23.9 kbps | 8.12 % | 9 | **18** | 1 | 28 |
  | opus-32 | 31.9 kbps | **1.45 %** | 4 | 1 | 0 | **5** |
  | opus-48 | 47.9 kbps | 2.90 % | 4 | 0 | 6 | 10 |

  Findings:
  - **Run-to-run noise floor is exactly 0.00 %** — transcribing the same lossless file twice
    produced byte-identical text. The model is deterministic here, so **every** difference is
    codec-caused. (This refuted the earlier "the non-monotonic 32 vs 48 result is jitter"
    guess; the 5-vs-10 edit difference at 32/48 is a small-sample effect on 345 words, not a
    trend.)
  - **The 16/24 kbps errors are dominated by deletions**, and the edit backtrace shows one
    **contiguous ~20-word run** — an entire sentence dropped — not scattered degradation.
    opus-24's hypothesis text even inserts "you know" and then loses the following sentence.
  - **Proper nouns are mangled at 16/24 and intact at 32/48**: `bristol → crystal`,
    `at → peric`/`favorite`, `writing → riding`, `company's → companies`,
    `restalwest → restylwest`, while `bristol west` survives at 32/48.
  - **Effective bitrate ≈ target** (15.8 / 23.9 / 31.9 / 47.9 kbps on speech-dominant content),
    which **retires the earlier worry** that `estimateBytesPerHour`'s constant-bitrate maths
    would be materially optimistic. (It may still overestimate material that is mostly
    silence — see the first, invalid run, where a speechless 150 s file encoded to ~2-4 kbps.)
  - `transcodeTo`'s new duration verification (P0-3) ran on all four real 120 s encodes without
    complaint.

  Recommendation: **default `opus-32`.** 155-minute meeting ≈ 37 MB vs 28 MB at 24 kbps — a
  9 MB difference against ~298 MB of recording — in exchange for not dropping a sentence and
  not mangling names, on an irreversible format.

  Caveats: one 120 s sample; the ASR is `whisper-base.en` (weak, and it is the project default,
  so it is the relevant model); a stronger model might be more robust to codec artefacts and
  could change the verdict.
- **P3-3 `keepWav` — DONE ALREADY; the backlog entry was wrong (corrected 2026-09-13).**
  This item claimed "expose `keepWav` in settings … just not exposed". That was an unverified
  inference and it was false: the checkbox was already fully wired —
  `renderer/index.html:294` (`id="cfg-archive-keepwav"`, label "保留原始 WAV（压缩但不再省空间）"),
  loaded at `renderer/app.js:130`, saved at `renderer/app.js:205` through the normal `config:set`
  path, and `src/main.js:451` passes the whole `cfg.audio.archive` object to
  `audioArchive.archiveDir(dir, opts, …)` so `keepWav` reaches the encoder unmodified.
  The only real gap was documentation: a hint line was added at `renderer/index.html:295`
  giving the disk trade-off (a 155-minute 16 kHz mono recording ≈ 298 MB vs an Opus 24 kbps
  copy ≈ 28 MB). The optional "auto-keep for recordings longer than N hours" rule is still
  unimplemented and remains open.
  **Lesson (third instance of this pattern):** an inference about this codebase has now been
  wrong three times (this item; the `.tools` ffmpeg fallback, which I nearly called dead code;
  and the "Task Manager CPU is inflated" generalization). Verify against the file itself
  before writing a claim — including into this document.
- **P3-5 the deferred/queue path loses capture provenance — FIXED 2026-09-13.**
  `captureInfo` (per-track `READY` format + `T0` anchor) is stashed on `rec` and written into
  `meta.capture` only by `stopRecordingAndProcess()`. In "续航优先模式" the recording is queued
  via `enqueueMeeting()` and processed later, so those meetings got `meta.audio` (patched by
  `archiveMeeting`) but no `meta.capture`.
  **The real mechanism was one level deeper than it looked:** `jobQueue.add()` rebuilds every job
  from a *named-field whitelist*, so a `captureInfo` handed to it is silently dropped — carrying
  the value through `enqueueMeeting()` alone would have changed nothing. Fixed in four places:
  whitelist it in `jobQueue.add()` (with a comment saying why that list is load-bearing), take it
  as a parameter in `enqueueMeeting()`, pass `rec.captureInfo` from the sole call site, and write
  `capture: job.captureInfo || null` into the queued `meta`.
  Verified by a unit test: `add` / `save`+`load` / `markAttempt` all preserve it, an absent field
  yields `null`, and a pre-existing `queue.json` without the field still loads and is still
  returned by `nextJob()` (`meta.capture` falls back to null rather than throwing).
- **P2-6 (NEW, found and fixed 2026-09-13): a stale LEVEL line defeats the silence watchdog.**
  `capture.exe` advanced its LEVEL odometer only inside the packet loop, and the silence-padding
  path did not touch it. During a silence long enough that no packets arrive, the `--status`
  file's **last line stays frozen at the last loud `LEVEL`**; `main.js`'s `pollLevels()` reads
  that last line every 300 ms and refreshes `lifecycle.lastLoudAt` whenever it is at or above the
  speech threshold — so the 10-minute silence watchdog ("forgot to stop the recording") **never
  fired**. Pre-existing (the old code had the same staleness whenever the endpoint went idle),
  not introduced by the padding work.
  Fix: the padding path advances the odometer by the frames it wrote and emits one LEVEL line per
  completed window, reusing the existing computation verbatim, with the window count and
  remainder computed in 64-bit before narrowing. Padded frames are real elapsed time — and since
  padded samples are silence, the existing smoothing decays the reported level to 0 by itself.
  Verified: **12 s with nothing playing now yields 24 LEVEL lines where it yielded 0 before**,
  `bytes=384000` exactly, file 384044, decodes clean. A 12 s capture in which a tone starts 6 s in
  yields exactly 24 lines whose **first 13 are `LEVEL 0` followed by 14,13,12,…** — the transition
  lands precisely where the audio begins, which is what makes LEVEL a wall-clock signal again.
  Real audio still reports non-zero levels; the fuse still emits `LIMIT` before `FINISHED`; a run
  without `--limit-bytes` still emits none.
- **P3-4 pre-flight ffmpeg capability:** require `libopus` in `-encoders` before archiving;
  otherwise skip, keep the WAV and say so (today only a missing binary is reported, and
  BUILD-STATE §6b records that this binary has gone missing before).

### P4 — sequencing and polish
- **P4-1** (BUILD-STATE §8 OPEN ITEM 2) scan before announcing: `archiveMeeting()`
  (`main.js:423-430`) says "压缩音频…" before it knows there is anything to compress;
  already-Opus meetings should say 无需压缩.
- **P4-2 archive earlier / in parallel:** `translateNotes` and `summarize` do not need the
  audio, so archiving can begin as soon as transcription finishes, cutting the ~3.2 h peak
  residency to recording + transcription. Only the re-run path needs the audio.
- **P4-3 mixed-container consistency:** `main.js:284-285` prefers `.opus`. If one track was
  archived and the other was not, the mix combines containers and Opus' pre-skip
  (≈312 samples @ 48 kHz ≈ 6.5 ms) applies to only one track. Fix by decoding both to PCM
  before mixing, or detect and record it. Low priority (negligible for word-level dedupe) but
  it belongs in the list.

### P5 — dependency audit (do this deliberately, before the repo is made public)
- **P5-1 the Dependabot alerts.** GitHub reports **14 vulnerabilities (1 critical, 8 high,
  5 moderate)** on the default branch — the same count as BUILD-STATE §8 recorded, unchanged
  by this work because no dependency version was touched. Run `npm audit` (with
  `npm_config_cache` set — see BUILD-STATE §7) and clear what is genuinely clearable, one
  dependency at a time, re-running the app and the packaging verification after each.
- **P5-2 `sharp` — DO NOT merge the bump blindly.** Two Dependabot branches now exist on
  origin: `dependabot/npm_and_yarn/js-yaml-4.3.2` (low risk) and
  **`dependabot/npm_and_yarn/sharp-0.35.4` (high risk)**. `sharp` is load-bearing and BUILD-STATE
  §6b documents exactly why: `@xenova/transformers` pins `sharp@^0.32.6`, so npm kept a *nested*
  copy that never fetched its native binary under `--ignore-scripts`, and that surfaced only as
  `Cannot find module sharp-win32-x64.node` **in the packaged app**. It was fixed by three things
  acting together: npm `"overrides": { "sharp": "0.33.5" }`, the direct dependency pinned to the
  *exact* same version (npm rejects an override that differs from the direct spec), and
  `asarUnpack: ["node_modules/@img/**"]` so the `.node`/libvips DLLs live outside asar. Bumping
  sharp moves all three. The danger is that a broken sharp is **invisible in development** and
  only shows up in the packaged exe, so this must be done as its own task with the full
  verification: update `overrides` and the direct spec together, confirm `@xenova/transformers`
  still resolves to the intended sharp, confirm the nested copy is still absent, then **rebuild
  the portable exe and launch it for real** (BUILD-STATE §6b, including the EPERM workaround:
  `--config.electronDist=dist/electron-dist-44.3.0`).
- **P5-3 note:** `@xenova/transformers` 2.x is superseded by `@huggingface/transformers`. That is
  a migration with its own verification burden, not an audit fix — keep it out of P5-1/P5-2.

### P6 — participant naming (NEW REQUEST 2026-09-14; a feature, not a bug)
The owner went looking for "a menu to type in the meeting participants" and could not find one.
It does not exist. What DOES exist is post-hoc per-speaker renaming, in the meeting detail view:

- `renderer/app.js:961-1124` — one row per diarized speaker with a name field, a **5 s audition**
  (`speakersAudition`), **merge two speakers** (`speakersMerge`) and **re-diarize**
  (`speakersDiarize`). Rows only appear once that meeting has speakers, i.e. after diarization.
- `speakersSetName({dir, speakerId, name})` renames by **stable id** and refreshes the notes
  (`src/main.js:~1034`); the transcript view also renames by clicking a speaker badge
  (`renderer/app.js:1161-1167`).
- `meta.speakerLabels` records the names (`src/main.js:1057`, `:1094`).

Why the owner saw nothing: the block lives in the meeting detail view and needs a meeting whose
diarization has already run — the meeting recorded immediately before this request was still
mid-pipeline, so there was nothing to show.

What is missing is an explicit participant list. Diarization only clusters voices; it cannot
produce names, so the notes carry 「你 / 远端」 or `spk1…spkN` until each one is renamed by hand.
Three options, cheapest first:

1. **A participant list the user types** (before or after recording), stored in `meta.json`, used
   to populate the naming rows directly instead of renaming speakers one at a time.
2. **Feed those names to Whisper as `initial_prompt`** ⭐ — Whisper biases toward prompt text, so a
   participant list should improve the spelling of names and company names. Highest value for the
   lowest cost: it targets exactly the words the 24 kbps measurement showed being mangled
   (`bristol → crystal`, `restalwest → restylwest`, see P3-2), and it improves ASR quality for
   every meeting rather than only the labelling UI.
3. **A cross-meeting voice-print library** so a known person is suggested automatically. The
   natural extension of `diarize.js`, and by far the largest piece — its own phase.

Separate, small bug found while looking: **`speaker-rows` appears twice as an id** in
`renderer/index.html` (lines 93 and 167). Duplicate ids are invalid HTML and `$("speaker-rows")`
silently returns only the first; one of the two needs a different id.

## 3. Investigated and rejected (with the real reasons)
- **Recording straight to Ogg/Opus** — loses "a hard kill still yields a decodable file" and
  makes `capture.exe` depend on libopus. The only genuine route would be encoding inside
  `capture.exe` ourselves (static libopus via `pacman -S mingw-w64-ucrt-x86_64-opus`),
  because FFmpeg cannot capture at all (§1.6).
- **RF64 / Wave64 to beat the 4 GiB ceiling** — `audioArchive.wavInfo()` (`:88-121`) parses
  only RIFF's `fmt `/`data` chunks and would need matching changes, and RF64 requires
  rewriting the `RF64` marker back to `RIFF` when a file stays under 4 GiB. Option B moves
  the ceiling to 37.3 h for far less work.
- **Process loopback** — §1.7: all zeros for Teams desktop, which is a target app.
- **"Just upgrade ffmpeg / use a full build"** — no Windows build has a WASAPI input device;
  it is not a build-configuration problem (§1.6).
- **Lowering the archive bitrate to 14 kbps** — `resolvePreset` would accept it
  (`audioArchive.js:42`), but at 16 kHz mono that is close to where Opus falls back to
  narrowband, and it saves only ~2.3 MB per 155-minute meeting versus `opus-16`.

## 4. Still open (decide before starting the relevant item)
1. **P0-1 fuse threshold** — suggested 3.5 GiB. (P1 makes this near-moot: 37.3 h.)
2. **P2-1 maximum recording duration** — suggested 8 h.
3. **P0-3/P0-4 tolerances** — implemented as `max(1%, 0.5 s)`; confirm.
4. **P3-2 experiment** — run it before changing any default bitrate. Nobody has questioned the
   24 kbps default with data.
5. **Segmentation (15-minute files)** — proposed, deferred. Its value is *pipeline overlap*
   (notes minutes after a meeting instead of ~38 min) and bounding pipeline failures,
   **not** crash safety: the 2-second header refresh already caps loss at ≤2 s, so unpatched
   15-minute segments would be *worse*. If pursued it needs (a) silence-aligned rotation
   using the existing RMS map rather than a fixed 15 min, (b) two-track boundary alignment,
   and (c) a diarization identity decision — per-segment clustering would fragment one
   speaker into several IDs. Independent phase; do not bundle it with option B.

## 5. Wire contract for P0 (both sides specified — do not renegotiate)

`capture.exe record <kind> <out.wav> ... [--limit-bytes <n>]`

- On reaching the limit it stops gracefully, finalizes the WAV, and emits — through the
  shared `emit()` helper, so it lands in stdout **and** the `--status` file — exactly:
  `LIMIT bytes=<n> limit=<n>` (plain decimal integers), **immediately before** the usual
  `FINISHED` line.
- A stop caused by `--seconds` or the `--stop` file must **not** emit `LIMIT`.
- Consumer side: `main.js` scans the whole status text for `/^LIMIT\b/m`; the last-line check
  is insufficient because `FINISHED` follows it.
- `--limit-bytes` exists primarily so the fuse can be tested in seconds; it is also the
  override for unusually long or unusually short recordings.

## 6. Command cheat-sheet (verified 2026-09-13)
- Rebuild capture (must be warning-free, run from the repo root):
  `& "C:\Users\lma\msys64\ucrt64\bin\gcc.exe" -O2 -Wall -DINITGUID -o .cap\capture.exe .cap\capture.c -lole32 -luuid -lpropsys`
- Bundled ffmpeg: `node_modules\ffmpeg-static\ffmpeg.exe`
- Decode check: `ffmpeg -v error -i <file> -f null -`
- Syntax check: `node --check src\main.js`
- Sandbox constraints: no piped stdio from Node (EPERM) — use `--status` / `-o` files and
  `-progress <file>`; Electron cannot be launched here (named pipes → "Access is denied
  (0x5)").
- There is no test runner (`package.json` has no `test` script); verification is by direct
  execution.
- Launching the app: `npm.cmd start` or `.\node_modules\electron\dist\electron.exe .` from
  the repo root. **Do not prefix with `node`** (see §7.4). `electron.exe` is a GUI-subsystem
  binary, so the shell returns immediately and the terminal looks idle — the window is
  elsewhere, and that terminal is where the main-process console output appears.
- Capture that console output to a file so a run can be diagnosed afterwards (works for the
  dev instance; §8 records that the portable exe flushes unreliably):
  `npm.cmd start *> .scratch\app-run.log`
- Post-change health check over every meeting directory (read-only, no child processes):
  `node tools\audit-meetings.js` — `--since YYYY-MM-DD` scans further back, `--json` for
  machine output, exit code 1 means ERROR/WARN findings exist.
- **Push: `git -c http.sslBackend=openssl push`, and it NEEDS full access.** The workspace
  sandbox denies the named pipe git's credential helper needs (through sh/bash) — without
  escalation it dies with `couldn't create signal pipe, Win32 error 5` / `failed to execute
  prompt script (exit code 66)` / `could not read Username for 'https://github.com'`, exit 128.
  The `sslBackend=openssl` flag is also required (schannel gives `SEC_E_NO_CREDENTIALS`).
  Verified 2026-09-14: `db8207c..dcd3326  main -> main`, exit 0, re-checked with `git fetch`
  (`main...origin/main`, no "ahead"). Never write credentials into git config, remotes or files;
  the Windows credential manager supplies auth.

## 7. P0 completion + findings from the real-recording test (2026-09-13)

### 7.1 P0 — all five items done and verified in a real recording
Base `db8207c`; **not committed**. `.cap/capture.c` (+44/−12), `src/audioArchive.js`
(+191/−33), `src/main.js` (+65/−13). Each item was verified by the main agent rather than
accepted from a self-report:

- **P0-1** fuse: a real recording tripped it — `LIMIT bytes=318720 limit=320000` appeared
  **before** `FINISHED`, file length 318764 = 44-byte header + 318720 data exactly; the
  negative case (no `--limit-bytes`) contained zero `LIMIT` matches; an independent
  recompile produced zero warnings.
- **P0-2** disk guard: `meetingsVolumeRoot()` resolves the meetings volume; `path.parse`
  confirmed `…\meeting notes → "C:\\"` and `D:\meetings\x → "D:\\"`; `diskRoot` added to the
  `lifecycle:status` payload.
- **P0-3/P0-4** archive: the 191-line diff was reviewed; `probeDurationSec` independently
  reproduced at **19.9935 s** for a real `.opus`, `null` for an undecodable file, a
  truncated Opus correctly rejected; no `.tmp`/`.probe-*` leftovers.
- **P0-5** LIMIT consumption: the consumer regex was tested against **real capture.exe
  output** (not a synthetic fixture) and parsed `{bytes:318720, limit:320000}`.

Three non-obvious catches, none of which were in the original plan:
1. **`-f preset.ext` is mandatory** for the atomic write (found by the implementing agent):
   encoding to `<out>.tmp` makes ffmpeg infer the muxer from the extension, so without it
   the whole tmp+rename scheme fails outright.
2. **`--limit-bytes` had to be clamped to the RIFF ceiling** (`0xFFFFFFFF − 36`): above it
   the three narrowing sites silently clamped to `0xFFFFFFFF` and the header lied again —
   the same silent-corruption class the fuse exists to prevent.
3. **`stopRecordingAndProcess()` is called fire-and-forget from a 300 ms timer** and sets
   `rec.busy = true` before its own `try`. An early throw leaked `busy` forever, and
   `record:start` rejects while busy — the app would have been unable to record or stop
   until restarted. Fixed with `.catch()` + `busy` reset at the call site.

**Real-app verification** (meeting `meeting notes/2026-09-13_210809`, recording 16 s):
no `.wav` left, no `.tmp` left, `system.opus`/`mic.opus`/`mixed.opus` present,
`system.status` contains zero `LIMIT` lines (fuse did not misfire), `meta.json` has
`limitReached: null`, and the full pipeline produced `notes.md` + `notes.zh.md` +
transcripts. The P0 code had never run inside the app before this test.

### 7.2 VERIFIED FACT: loopback emits nothing while the endpoint has no active render stream
This replaces the "loopback silence semantics — must verify" question in §1.

| Track | Wall clock | Data in file | Behaviour |
|---|---|---|---|
| mic | 16.19 s | **16.16 s** (68 % of it silence) | writes silence continuously |
| system | 16.34 s | **8.06 s** | **elides the time with no active stream** |

Reconciliation with §8's apparently contradictory measurement: in the 155-minute call the
system track was 9332 s **and contained a measurable 8.3 % silence**, so packets did flow
during quiet moments there. The difference is whether *any* stream is active on the
endpoint:
- a meeting app holding a render stream for the whole call keeps the engine producing
  packets — including silence — so the timeline stays intact;
- with no active stream at all (in the test, the first ~8 s before playback started) the
  loopback produces nothing and that wall-clock time simply vanishes from the file.

**Consequence (silent):** the system track's timeline is compressed by the total duration of
those gaps, so everything after the first gap is placed *early*. `amix` takes the longer
track (`mixed.opus` = 16.17 s = the mic length), anchoring system audio at t=0 and padding
silence after it. This corrupts `mergeTracks()` echo dedupe (which matches on time overlap —
it can now delete the user's own speech), diarization alignment, and every timestamp shown
to the user. It triggers in ordinary situations: starting the recording before the call
begins, browser-based meetings, or any long quiet stretch.

**Fix (do it with P1):** in `capture.c`, when `GetNextPacketSize` returns nothing for longer
than one buffer period, write silent frames for the wall-clock time actually elapsed
(`QueryPerformanceCounter`). Then the WAV timeline is always wall-clock-faithful and every
downstream consumer (amix, dedupe, diarization) becomes correct with **no changes**. The
cost is writing zeros, and `transcribe.js`'s silence skipping already removes long silences
before ASR — so the pipeline cost is zero. Bonus: the fuse's byte count then grows linearly
with wall clock (192 kB/s → the 3.5 GiB fuse ≈ 5.4 h), which is far more predictable than
today's "only while audio plays".

Rejected alternative: recording a gap map instead of padding. Cheaper on disk, but it
requires amix, echo dedupe and diarization to all learn about the mapping — a much larger
blast radius.

### 7.3 ENVIRONMENT TRAP: an orphaned `llama-server` steals VRAM and silently wrecks speed
Ollama runs a server plus **one runner process per loaded model**, and that runner's image is
`llama-server.exe` — **its name does not start with "ollama"**. Restarting Ollama with
`Get-Process | Where-Object { $_.ProcessName -like 'ollama*' } | Stop-Process` therefore
leaves the runner alive. Worse, the verification used *the same filter*, so it printed
"0 ollama processes remain" and could not fail.

Measured damage: the orphan held **5,285 MiB** of VRAM (23,810 → 18,525 MiB after killing
it), which forced the fitter down from 64/66 to 60/66 layers on the GPU and collapsed
generation from ~36 tok/s to **7.25 tok/s**. Of note, 50/66 (16 CPU layers) ran *faster*
(12.3 tok/s) than 60/66 (6 CPU layers), so layer count alone does not explain it — the
decisive factor was VRAM over-commitment at 97.3 % (23,810/24,463 MiB), where the driver
starts evicting and paging. `/api/ps` cannot see orphans: it only reports models the
*current* server manages.

Correct restart recipe:
```powershell
ollama stop <model>                                    # let the server reap its runner first
Get-Process | Where-Object { $_.ProcessName -match '^(ollama|ollama app|llama-server)$' } | Stop-Process -Force
(Get-Process llama-server -ErrorAction SilentlyContinue | Measure-Object).Count   # MUST be 0
Start-Process "$env:LOCALAPPDATA\Programs\Ollama\ollama app.exe"                  # needs full access: AppData
```
Lesson: **verify with a different predicate than the one you acted on**, otherwise the check
is自-confirming. Also: killing only `ollama.exe` from Task Manager leaves the same orphan, so
this is not specific to scripting.

### 7.4 Documentation drift (extends §1.9)
- **BUILD-STATE §6's run command `node node_modules\electron\dist\electron.exe .` is wrong.**
  `node` parses the PE binary as JavaScript and dies with
  `SyntaxError: Invalid or unexpected token` (`MZ… This program cannot be run in DOS mode`).
  Use the exe directly or `npm.cmd start`.
- Starting a second instance while one is running produces
  `Unable to move the cache: Access is denied. (0x5)` / `Unable to create cache` in stderr —
  that is Chromium failing to share one `userData` cache between instances, **not** a sandbox
  denial. Only one instance should ever be running.

### 7.5 Backlog items added or changed
- **P1-4 (new, folded into P1): system-track timeline honesty** — silence padding as
  described in §7.2. Same loop as the rest of P1, so one compile and one verification.
- **P4-4 (new): meeting-directory hygiene** — real meeting folders retain `system.status`,
  `mic.status`, `system.stop` and `mic.stop` (the `--status` and stop-signal files) after the
  pipeline finishes; they are never cleaned up. Seen in every directory under `meeting notes/`.
- **P2-5 (NEW — highest-priority remaining correctness bug; silently truncates recordings).**
  Meeting detection auto-stops **any** recording. `meetingDetect.js:68-80`: when no app from
  the 7-item allowlist (`ms-teams`, `teams`, `zoom`, `webexmta`, `CptHost`, `slack`, `Discord`)
  is producing audio, and `input.recording` is true, a `stop` action fires after
  `stopAfterSec = 90`. This is **not** gated on the recording having been auto-started — the
  input field `recordingAutoStarted` exists only in the JSDoc at `meetingDetect.js:43` and is
  read by no code, and `main.js` never passes it. Consequently a manually started recording is
  killed ~90-98 s in whenever the audio does not come from a watched app:
  an **in-person meeting**, **Google Meet in a browser** (`chrome.exe`/`msedge.exe` are not on
  the list), **腾讯会议 / 飞书 / 钉钉 / 微信 / Skype**, or a plain voice memo. This directly
  breaks the product's own goal ("fully independent of meeting apps"). The 155-minute meeting
  in §8 never exposed it because a watched app was playing audio for the whole call.
  Correct fix: gate the auto-stop on **this recording having previously seen a watched app
  active** (track it in `meetingState` per recording), keeping the "the call ended" behaviour
  while never killing an in-person recording. The existing LEVEL-based silence watchdog
  (`lifecycle.autoStop.silenceMin: 10`) already covers the "nobody said anything for ages"
  case app-independently, so the meeting-based stop is redundant for that purpose.
  Verified live on 2026-09-13 while designing the P1 test: with `autoStop` left at its default
  the planned 150 s test recording would have been cut short, and it only ran because
  `lifecycle.meetingDetect.autoStop` was temporarily set to `false` (restored afterwards).
  **FIXED 2026-09-13** by adding a `sawWatchedApp` latch to the meeting state in
  `meetingDetect.js`: it is set only while a watched app is seen **and** a recording is in
  progress, preserved for the rest of that recording, and cleared whenever no recording is
  running (so the latch is self-closing and `main.js` needs no reset — its only change is one
  token in the `meetingState` initializer). The auto-stop now additionally requires
  `s.sawWatchedApp`.
  Verified by a pure-function test suite (`.scratch/p2-5-test.js`, 8 scenarios) plus an
  independent adversarial suite (`.scratch/p2-5-verify.js`) and a before/after comparison
  against the HEAD version (`.scratch/p2-5-compare.js`): a manual recording with a
  **browser** meeting playing was stopped at **t=97 s** by the original code and is **never
  stopped** by the fixed code; all seven allowlisted apps still latch and still stop
  ~`stopAfterSec` after the call goes quiet; `Inactive` sessions and non-allowlisted apps
  (`msedge`, `wemeetapp`, `feishu`, `DingTalk`, `Skype`, `QQ`) never latch; a 40-minute manual
  recording with empty sessions produces no stop; `autoStop: false` produces no stop; a watched
  app seen *before* a recording does not latch.
  Known pre-existing quirk (unchanged by this fix, confirmed identical on both versions): if a
  stop request is ignored and the recording somehow keeps running, the re-arm
  (`next.inactiveSince = now`) makes the stop fire again every `stopAfterSec`. In the app the
  first stop ends the recording, so this cannot normally happen — and a repeat would act as a
  retry. Also note the fix loses no coverage: browser meetings were previously killed *during*
  the call, not tidied up after it.
- **P0 note:** the fuse threshold and the maximum-duration guard (§4 items 1 and 2) are still
  unconfirmed decisions; P1's padding makes the fuse's trigger time wall-clock-predictable.
