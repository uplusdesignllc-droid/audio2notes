"use strict";
const fs = require("fs");
const path = require("path");
const { app } = require("electron");

const DEFAULTS = {
  meetingsDir: "",            // empty => <userData>/meetings
  capture: { system: true, mic: true },
  whisper: {
    model: "Xenova/whisper-base.en", // tiny.en/tiny/base.en/base/small.en/small
    cacheDir: "",             // empty => <userData>/models
    // Where models are fetched from when they are not cached yet. Point this at a
    // mirror (e.g. https://hf-mirror.com/) when huggingface.co is unreachable.
    endpoint: "https://huggingface.co/",
    autoDownload: true,       // download a missing model on demand
  },
  notes: {
    provider: "ollama",       // ollama | openai | heuristic
    detailLevel: "standard",  // brief | standard | detailed
    ollama: { baseUrl: "http://127.0.0.1:11434", model: "" }, // model "" => auto-pick first
    openai: { baseUrl: "https://api.openai.com/v1", apiKey: "", model: "gpt-4o-mini" },
  },
  translation: {
    enabled: true,            // master switch: auto-translate the NOTES to Simplified Chinese
    /* Translate the whole transcript too? Default OFF, on measured grounds.
     * Measured on a real 155-minute meeting: 2663 segments / ~130k English chars
     * -> ~90k output tokens, which at this machine's 16.5 tok/s is a ~90 minute
     * floor (28.7 segments/min). The cost is generation-throughput bound, so
     * batching more aggressively does not fix it — it made transcript translation
     * the dominant cost of the whole pipeline (~44 min to transcribe 18 664 s of
     * audio, ~93 min to translate it). The notes (~7k chars) translate in ~4 min
     * instead, and translateNotes() still honours translation.enabled. */
    transcript: false,
    engine: "ollama",         // ollama | openai
    ollama: { baseUrl: "http://127.0.0.1:11434", model: "" },
    openai: { baseUrl: "https://api.openai.com/v1", apiKey: "", model: "gpt-4o-mini" },
  },
  audio: {
    archive: {
      enabled: true,          // compress meeting wavs after the pipeline finishes
      codec: "libopus",       // libopus | libmp3lame
      bitrateKbps: 32,        // Opus 32 kbps mono ≈ 14.4 MB/hour (measured; BACKLOG.md P3-2)
      keepWav: false,         // true = compress but keep the original wav
    },
  },
  lifecycle: {
    notifyOnDone: true,       // desktop notification when the notes are ready
    autoQuitAfterMin: 15,     // quit when idle this long (0 = right after done, -1 = never)
    confirmWhileBusy: true,   // never let a window close silently kill a recording/pipeline
    autoStop: {
      enabled: true,          // stop a forgotten recording
      silenceMin: 2,          // minutes without speech before WARNING (harmless: recording continues)
      forceStopAfterMin: 5,   // further minutes AFTER the warning before actually stopping (total 7)
      minFreeDiskGB: 2,       // stop recording when free space drops below this
      maxElapsedMin: 480,     // stop once a recording has run this long (0 = no time limit)
      levelThreshold: 8,      // LEVEL (0-100) counted as "speech" by capture.exe
    },
    meetingDetect: {
      enabled: true,
      autoStart: false,       // privacy: starting a recording by itself is opt-in
      autoStop: true,         // noticing a call ended is safe and solves "forgot to stop"
      apps: ["ms-teams.exe", "teams.exe", "zoom.exe", "webexmta.exe", "CptHost.exe", "slack.exe", "Discord.exe"],
      startAfterSec: 15,
      stopAfterSec: 90,
    },
  },
  power: {
    mode: "auto",             // auto | perf | eco | defer
    batteryPreference: "eco", // what "auto" uses on battery: eco | defer
    maxThreads: 0,            // 0 = decided by the mode
    maxModel: "",             // "" = decided by the mode (eco/defer cap at base)
  },
};

function file() {
  return path.join(app.getPath("userData"), "settings.json");
}

/** Last settings.json load problem, exposed so the UI can report it instead of
 *  silently running on defaults (a BOM or a stray comma used to do exactly that). */
let lastError = null;

function load() {
  const p = file();
  let text;
  try {
    text = fs.readFileSync(p, "utf8");
  } catch (e) {
    lastError = e.code === "ENOENT" ? null : `无法读取设置文件：${e.message}`;
    return structuredClone(DEFAULTS);
  }
  try {
    // strip a UTF-8 BOM: editors (and PowerShell's Set-Content -Encoding utf8) add
    // one, and JSON.parse rejects it — which silently discarded the whole file
    const raw = JSON.parse(text.replace(/^\uFEFF/, ""));
    lastError = null;
    return deepMerge(structuredClone(DEFAULTS), raw);
  } catch (e) {
    lastError = `设置文件解析失败（${e.message}），本次运行使用默认值；保存设置可覆盖它`;
    console.error("[config] " + lastError);
    return structuredClone(DEFAULTS);
  }
}

function loadError() {
  return lastError;
}

function save(cfg) {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(cfg, null, 2), "utf8");
}

function deepMerge(base, over) {
  if (over == null || typeof over !== "object") return base;
  for (const k of Object.keys(over)) {
    if (over[k] !== null && typeof over[k] === "object" && !Array.isArray(over[k])) {
      base[k] = deepMerge(base[k] && typeof base[k] === "object" ? base[k] : {}, over[k]);
    } else {
      base[k] = over[k];
    }
  }
  return base;
}

function meetingsDir(cfg) {
  return cfg.meetingsDir || path.join(app.getPath("userData"), "meetings");
}

function modelCacheDir(cfg) {
  return cfg.whisper.cacheDir || path.join(app.getPath("userData"), "models");
}

module.exports = { DEFAULTS, load, loadError, save, file, meetingsDir, modelCacheDir };
