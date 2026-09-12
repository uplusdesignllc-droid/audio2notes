"use strict";
/* Power modes: one switch that decides engine, model size, when work runs and
 * what gets deferred. Pure and testable — the UI and the main process only
 * render/serve what resolveProfile() decides.
 *
 * TRANSPARENCY RULE (non-negotiable): the profile always carries a human-readable
 * `engine.reason` describing what will ACTUALLY happen, including "falls back to
 * CPU because DirectML is not available in the installed onnxruntime-node". The
 * UI shows the resolved profile, never just the user's wish. */

const MODES = [
  { id: "perf", label: "性能优先", icon: "🔌", desc: "插电使用：允许独显、最大模型、立即转写" },
  { id: "eco", label: "省电优先", icon: "🔋", desc: "电池使用：优先省电，但仍立即出笔记" },
  { id: "defer", label: "续航优先", icon: "⏸", desc: "电池使用：只录音，回到插电再转写" },
  { id: "auto", label: "自动", icon: "🔄", desc: "插电用「性能优先」，电池用下面选的那个" },
];

const MODEL_LADDER = ["tiny.en", "tiny", "base.en", "base", "small.en", "small"];

/** Rank a Whisper model id on the small→large ladder (unknown ids sort last). */
function modelRank(model) {
  const short = String(model || "").replace(/^Xenova\/whisper-/, "");
  const i = MODEL_LADDER.indexOf(short);
  return i < 0 ? MODEL_LADDER.length : i;
}

/** Downgrade a model to at most `cap` on the ladder. Returns {model, changed}. */
function capModel(model, cap) {
  if (!cap) return { model, changed: false };
  const capIdx = MODEL_LADDER.indexOf(cap);
  if (capIdx < 0) return { model, changed: false };
  if (modelRank(model) <= capIdx) return { model, changed: false };
  const short = String(model || "").replace(/^Xenova\/whisper-/, "");
  if (MODEL_LADDER.indexOf(short) < 0) return { model, changed: false }; // unknown build: leave it alone
  // Preserve the language variant: a multilingual model must never be capped to
  // an English-only one (that would silently wreck a Chinese meeting).
  const wantEn = short.endsWith(".en");
  const tier = cap.endsWith(".en") ? cap.slice(0, -3) : cap;
  return { model: `Xenova/whisper-${tier}${wantEn ? ".en" : ""}`, changed: true };
}

/**
 * @param {Object} args
 * @param {string} args.mode             auto | perf | eco | defer
 * @param {boolean} args.onBattery
 * @param {string} [args.batteryPreference]  eco | defer (used by "auto")
 * @param {Object} [args.engines]        { directml:boolean, cuda:boolean, igpu:string|null, dgpu:string|null, npu:boolean }
 * @param {string} [args.model]          configured Whisper model
 * @param {string} [args.maxModel]       user override cap ("" = by mode)
 * @param {number} [args.maxThreads]     user override (0 = by mode)
 * @param {number} [args.cores]
 */
function resolveProfile(args = {}) {
  const mode = MODES.some((m) => m.id === args.mode) ? args.mode : "auto";
  const onBattery = !!args.onBattery;
  const batteryPreference = args.batteryPreference === "defer" ? "defer" : "eco";
  const engines = args.engines || {};
  const cores = args.cores || 8;

  const effective = mode === "auto" ? (onBattery ? batteryPreference : "perf") : mode;

  /* Engine: is there any GPU path at all? onnxruntime-node 1.14 ships CPU only,
   * so today this is always CPU — and we say so instead of pretending. */
  let engine;
  if (engines.directml) {
    engine = onBattery && engines.igpu
      ? { id: "dml-igpu", label: `核显（${engines.igpu}）`, reason: "DirectML 可用，电池模式优先用核显" }
      : engines.dgpu
        ? { id: "dml-dgpu", label: `独显（${engines.dgpu}）`, reason: "DirectML 可用，插电模式用独显" }
        : { id: "dml", label: "DirectML", reason: "DirectML 可用" };
  } else {
    engine = {
      id: "cpu",
      label: `CPU（${cores} 线程可用）`,
      reason: "DirectML 不可用：当前 onnxruntime-node 只有 CPU 执行提供器，GPU/NPU 加速尚未接入",
    };
  }

  const limits = { maxModel: "", maxThreads: 0, diarizeThreads: 4, ffmpegThreads: 0 };
  let runNow = true;
  let archiveNow = true;
  const notes = [];

  if (effective === "perf") {
    limits.maxModel = "";
    limits.maxThreads = 0;
    limits.diarizeThreads = Math.max(2, Math.min(8, Math.floor(cores / 3)));
  } else if (effective === "eco") {
    limits.maxModel = args.maxModel || "base.en";
    limits.maxThreads = args.maxThreads || Math.max(2, Math.min(6, Math.floor(cores / 4)));
    limits.diarizeThreads = Math.max(1, Math.min(4, Math.floor(cores / 6)));
    limits.ffmpegThreads = 2;
    // Be precise about what is actually enforced: the model cap and the
    // diarization/ffmpeg thread limits are applied, but Whisper itself runs
    // through transformers.js v2, which does not expose ORT session options —
    // claiming a Whisper thread cap would be a false statement.
    notes.push("省电模式：转写模型降档，说话人分离与 ffmpeg 限制线程数");
    notes.push("⚠️ Whisper 自身的线程数暂无法限制（transformers.js v2 不暴露该选项），所以省电主要来自模型降档与「不转写」");
  } else if (effective === "defer") {
    limits.maxModel = args.maxModel || "base.en";
    limits.maxThreads = args.maxThreads || Math.max(2, Math.min(6, Math.floor(cores / 4)));
    limits.diarizeThreads = Math.max(1, Math.min(4, Math.floor(cores / 6)));
    limits.ffmpegThreads = 2;
    runNow = false; // the whole point: do not run Whisper on battery
    notes.push("录音只落盘 + 压缩，转写排队等插电（这是唯一能量级上的省电手段）");
  }

  const capped = capModel(args.model, limits.maxModel);
  if (capped.changed) notes.push(`模型自动降档：${String(args.model).replace("Xenova/whisper-", "")} → ${capped.model.replace("Xenova/whisper-", "")}`);

  if (mode === "auto") notes.unshift(`自动模式：当前${onBattery ? "电池" : "插电"}，使用「${MODES.find((m) => m.id === effective).label}」`);

  return {
    requested: mode,
    effective,
    onBattery,
    engine,
    model: capped.model,
    modelChanged: capped.changed,
    limits,
    runNow,
    archiveNow,
    notes,
    label: MODES.find((m) => m.id === effective).label,
  };
}

/** One-line status for the UI badge. */
function describe(profile) {
  const parts = [
    `${profile.label}`,
    `引擎：${profile.engine.label}`,
    `模型：${String(profile.model || "").replace("Xenova/whisper-", "") || "?"}`,
    profile.runNow ? "录音后立即转写" : "排队等插电",
  ];
  return parts.join(" · ");
}

module.exports = { MODES, MODEL_LADDER, modelRank, capModel, resolveProfile, describe };
