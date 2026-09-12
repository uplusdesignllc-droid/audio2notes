# 🎙️ Audio2Notes

A **local, private desktop app for Windows** that records meetings (the audio you hear +
your microphone) and automatically produces **structured meeting notes** — Summary, Key
Points, Decisions, Action Items, Open Questions.

It works **independently of your meeting app** (Zoom, Teams, Meet, Slack Huddles, phone calls,
anything). You just click **Start**, record the call, click **Stop & Process**, and get notes.

No audio ever leaves your machine unless you choose an online notes provider: transcription is
**local Whisper** (WASM), and notes default to a **local Ollama** LLM.

---

## Features

- 🎧 Captures **system audio (loopback)** + **microphone**, mixed into one track
- 🧠 **Local Whisper** transcription (tiny / base / small; EN or multilingual)
- 📝 **Notes generation** via Ollama (local) or any OpenAI-compatible API, with a
  built-in heuristic fallback so it always produces something
- 📁 Each meeting saved to its own folder:
  `system.wav`, `mic.wav`, `mixed.wav`, `transcript.txt/.md/.json`, `notes.md`, `meta.json`
- 📥 Import existing audio files (meeting exports, voice memos) — same pipeline
- ⚡ Live input-level meters, pipeline progress, one-click "Open folder"

## Requirements

- Windows 10/11 x64
- Node.js ≥ 20 (for running from source)
- [Ollama](https://ollama.com) with at least one model pulled (recommended; optional)

## Run from source

```powershell
npm install            # use: npm.cmd install --ignore-scripts if needed
npm start              # opens the app
```

First transcription downloads the selected Whisper model (~40–300 MB) from Hugging Face and
caches it locally.

## Build a portable .exe

The WASAPI capture tool is **not** committed as a binary — build it first (needs msys2 gcc):

```powershell
npm run capture:build   # .cap/capture.c -> .cap/capture.exe
npm run package         # output: dist/Audio2Notes 1.0.0.exe (portable)
```

Packaging traps that cost real debugging time (worth knowing before you hit them):

- **`capture.exe` must exist first** — `package.json` copies it via `extraResources`, so a
  missing binary fails the build. `npm run prepackage` now checks for it and says so.
- **Electron extraction can fail with `EPERM` on a directory rename.** electron-builder
  unpacks Electron to `<out>.tmp` then renames it; on Windows that rename can be refused
  right after ~200 MB of DLLs are written. Workaround: build against an already extracted
  Electron with `--config.electronDist=<path to an unpacked electron dist>`.
- **`packageManager` must be declared.** With a stray `node_modules/.pnpm` present,
  electron-builder assumes pnpm and dies with `spawn EPERM` while collecting the module
  list. `"packageManager": "npm@11.17.0"` in `package.json` pins the correct collector.
- **`node_modules/ffmpeg-static/ffmpeg.exe` can be missing** when installs run with
  `--ignore-scripts` (the binary comes from its postinstall). `src/ffmpegPath.js` verifies
  the file exists, falls back through several known locations, and reports clearly if none
  work — instead of handing a nonexistent path to `spawn`.

## How it works

1. **Capture** — `.cap/capture.exe` (a small C program, compiled with mingw gcc) records via
   Windows WASAPI: loopback on the default render device (system audio) and capture on the
   default mic. No meeting-app integration, no virtual audio cables.
2. **Mix** — ffmpeg (`amix`, `normalize=0`) combines the two sources into a 16 kHz mono track.
3. **Transcribe** — `@xenova/transformers` runs Whisper locally (ONNX/WASM) with timestamps.
4. **Notes** — the transcript goes to your configured LLM:
   - **Ollama** (default): `http://127.0.0.1:11434/api/chat` — model auto-picked or set in Settings.
   - **OpenAI-compatible**: any `/v1/chat/completions` endpoint (OpenAI, Azure, Groq, Together…).
   - **Heuristic**: rule-based extraction, no LLM needed.

## Settings

- **Model**: Whisper variant (tiny.en / tiny / base.en / base / small.en / small).
- **Provider**: ollama | openai | heuristic, with URL/model/key.
- **Meetings folder**: default is the app-data `meetings` directory; override anywhere.
- **音频归档**: compress each meeting's audio after the pipeline finishes (see below).

## Audio archiving (saving disk space)

A 48 kHz stereo capture WAV costs **~691 MB per hour**, and each meeting writes three of
them (`system.wav`, `mic.wav`, `mixed.wav`) — a few long meetings reach several GB.

After transcription the app archives them to **16 kHz mono Opus 24 kbps (~10.8 MB/hour)**,
roughly **30–60× smaller**, and deletes the WAVs. 16 kHz mono is exactly Whisper's input
format (`src/transcribe.js`), so **re-transcribing an archived meeting loses nothing**.
Opus is chosen over MP3 because it is ~3× smaller at equal speech quality; MP3 96 kbps is
offered for recordings you hand to older software.

Safety: an original WAV is deleted **only** after its replacement passes three checks —
ffmpeg exit 0, non-trivial output size, and a second end-to-end decode pass. Any failure
keeps the original and reports why. Set `audio.archive.keepWav = true` to compress without
deleting anything.

Settings → **音频归档** also has **扫描可回收空间** / **开始压缩并删除 WAV** for meetings
recorded before this feature existed. The scan is read-only and shows the exact reclaimable
size per meeting folder before you confirm.

## Project layout

```
src/main.js            Electron main: window, IPC, pipeline orchestration
src/preload.js         contextBridge API
src/config.js          settings persistence
src/capture.js         wraps .cap/capture.exe (device list, record, stop)
src/transcribe.js      local Whisper via @xenova/transformers
src/summarize.js       Ollama / OpenAI-compatible / heuristic notes
src/meetings.js        folder layout, ffmpeg mixing, artifact writing
src/ffmpegPath.js      asar-aware ffmpeg path
renderer/              UI (plain HTML/CSS/JS)
.cap/capture.c         WASAPI capture tool (build: npm run capture:build)
```

## Speaker identification, notes quality, lifecycle and power modes

Everything below is implemented, locally verified, and reports honestly when a capability is
unavailable (no silent fallbacks anywhere).

**Speakers — "who said this?"**
Diarization via `sherpa-onnx` (local, no Python): `src/diarize.js`. It finds the distinct
voices on the remote track, then the app cuts a **5-second audition clip per speaker**
(`samples/spk1.opus`, ~15 KB) that doubles as the voiceprint source. In the transcript panel a
**发言人** card lists one row per speaker: press **▶** to hear them, **type a name** and the
whole meeting relabels instantly. Chunks carry a **stable id** (`speaker: "spk1"`) and a
display name, so renaming never breaks the link and two people may share a name. Rows can also
be merged to fix over-segmentation.
Measured here: 15× realtime (5 min of audio in 19.6 s); correct speaker counts on known-2 and
known-4 reference files at clustering threshold 0.7. On hard real-world audio no threshold
gives both high recall and low false positives — which is why nothing is auto-named: you always
audition and confirm. Model: 1.5 MB segmentation model bundled, 27 MB embedding model
downloaded on first use.

**Notes quality — fixed the "it just deleted some words" problem**
`src/summarize.js` was rewritten: the old code clipped the transcript at 90 000 characters and
never set `num_ctx`, so long meetings were silently truncated, and any LLM failure fell back to
a rule-based sentence extractor with only a `console.warn`. Now: **map-reduce** over ~8k-char
chunks (nothing is dropped), an **explicit `num_ctx`** per request, hierarchical merging for very
long meetings, progress reporting, a **model dropdown that skips vision models**, and a **loud
banner** in the notes if a call fails (plus the reason in `meta.json`).
Verified on a real 17-minute meeting: 3 chunks, 6 994 prompt tokens (the whole transcript), no
degradation, 5 466 characters of real notes vs ~2 000 characters of copied sentences before.

**Lifecycle — never lose work, and it does not linger**
Desktop notification when the notes are ready, **idle auto-quit** (default 15 min, 0 = right
after finishing, -1 = never), a **confirmation when closing while recording or processing**
(previously the close silently killed the pipeline), and a **forgotten-recording guard**:
after 10 quiet minutes a notification + in-app countdown, then auto-stop (with a
"继续录音" escape), plus a **disk guard** that stops recording below 2 GB free.
The rules live in `src/lifecyclePolicy.js` and are unit-tested (22 checks); idle auto-quit was
also verified end-to-end (the app really exits).

**Power modes — one switch, four profiles**
`🔌 性能优先` / `🔋 省电优先` / `⏸ 续航优先` / `🔄 自动` (`src/powerMode.js`, 19 unit checks).
The app always shows the **resolved** profile, including why: on this machine it currently
resolves to CPU because the installed `onnxruntime-node` ships only the CPU execution provider
(GPU/NPU acceleration is not wired up). Eco caps the model to base and the threads; **defer**
records without transcribing and parks the meeting in a **persistent queue**
(`src/jobQueue.js`) that resumes automatically when AC power returns — quitting the app never
loses a queued meeting.

**Meeting-app detection (WASAPI sessions)**
`capture.exe sessions` reports which processes are producing audio on the default output and
whether their session is `Active` (verified live: a process playing audio reports Active).
The app therefore notices a Teams/Zoom/Webex call ending and **stops recording by itself**
(`autoStop`, on by default). **Auto-starting** a recording is deliberately **off by default** —
that is a privacy decision you opt into.

**Build notes for this version**
`assets/models/**` and `node_modules/sherpa-onnx-*/**` are `asarUnpack`ed (native code cannot
read inside asar); `sherpa-onnx-node` is a runtime dependency. Rebuild with
`npm run package`, and rebuild the capture tool with `npm run capture:build` if you change
`.cap/capture.c`.

## Privacy

- Audio never leaves the machine.
- Transcript → LLM: with Ollama, fully local. With OpenAI, the transcript is sent to your
  configured endpoint — pick what fits your meeting sensitivity.
