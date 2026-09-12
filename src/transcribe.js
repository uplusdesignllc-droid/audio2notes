"use strict";
/* Whisper transcription via @xenova/transformers (local, WASM).
 * ffmpeg decodes the wav to 16 kHz mono float32 raw (written to a file —
 * no stdio pipes, sandbox-safe). */
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ffmpegPath = require("./ffmpegPath").ffmpegPath();

const MODELS = [
  "Xenova/whisper-tiny.en",
  "Xenova/whisper-tiny",
  "Xenova/whisper-base.en",
  "Xenova/whisper-base",
  "Xenova/whisper-small.en",
  "Xenova/whisper-small",
];

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath, args, { stdio: "ignore", windowsHide: true });
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error("ffmpeg exit " + code))));
  });
}

async function decodeToRaw16k(wavFile, rawFile) {
  await runFfmpeg([
    "-y", "-v", "error",
    "-i", wavFile,
    "-ar", "16000", "-ac", "1",
    "-f", "f32le", rawFile,
  ]);
  return fs.readFileSync(rawFile);
}

let pipeCache = null;

async function getPipeline(model, cacheDir, onProgress, endpoint) {
  if (pipeCache && pipeCache.model === model && pipeCache.cacheDir === cacheDir && pipeCache.endpoint === endpoint) {
    return pipeCache.pipe;
  }
  const { pipeline, env } = require("@xenova/transformers");
  // Point the downloader at a mirror when huggingface.co is unreachable.
  if (endpoint) env.remoteHost = endpoint;
  const pipe = await pipeline("automatic-speech-recognition", model, {
    dtype: "q8",
    cache_dir: cacheDir,
    progress_callback: onProgress || undefined,
  });
  pipeCache = { model, cacheDir, endpoint, pipe };
  return pipe;
}

/**
 * Transcribe a wav file.
 * @returns {Promise<{text:string, chunks:Array}>}
 */
async function transcribeFile({ wavFile, model, cacheDir, onProgress, onPartial, endpoint }) {
  const rawFile = path.join(os.tmpdir(), `a2n-raw-${process.pid}-${Date.now()}.raw`);
  const bytes = await decodeToRaw16k(wavFile, rawFile);
  try { fs.rmSync(rawFile, { force: true }); } catch { /* ignore */ }
  const pcm = new Float32Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 4));

  const transcriber = await getPipeline(model, cacheDir, onProgress, endpoint);
  const out = await transcriber(pcm, {
    chunk_length_s: 30,
    stride_length_s: 4,
    return_timestamps: true,
    callback_function: (beams) => {
      if (onPartial && beams[0]) onPartial({ text: beams[0].output_token_ids, done: beams[0].done });
    },
  });
  const chunks = (out.chunks || []).map((c) => ({
    text: c.text,
    start: Array.isArray(c.timestamp) ? c.timestamp[0] : 0,
    end: Array.isArray(c.timestamp) ? c.timestamp[1] : 0,
  }));
  return { text: out.text || "", chunks };
}

module.exports = { MODELS, transcribeFile, getPipeline };
