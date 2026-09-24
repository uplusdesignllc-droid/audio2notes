/* Audio2Notes UI language layer (phase 1: chrome, buttons, labels, dialogs, status).
 *
 * Design: THE CHINESE SOURCE STRING IS THE KEY. DICT.zh maps every source string
 * to itself (identity) and DICT.en maps it to natural product English. So the
 * dictionary doubles as the migration map, and an as-yet-untranslated string
 * degrades to correct Chinese instead of a blank or a "key.not.found" token.
 *
 * Two key shapes:
 *   - plain strings  -> keyed source-exact:            "已合并。"
 *   - interpolated   -> keyed with collapsed holes:     "已 {n1} 分钟没有声音。{n2} 秒后…"
 *     and called as t(key, { n1: mins, n2: left }). The English side uses the
 *     same {nK} holes, so the values supplied by the caller are substituted into
 *     whichever language is active.
 *
 * Phase 2 (long-form Settings help prose in index.html + the user-visible backend
 * strings in src/) is IN: every backend string that reaches the UI is a key here.
 * Those strings are built from template literals in the main process, so the text
 * the renderer receives already has its values interpolated ("CPU（8 线程可用）"
 * where the key is "CPU（${cores} 线程可用）") and can never match a key exactly.
 * resolve() handles them by SHAPE — see shapeResolve() below — and a string that
 * matches nothing still passes through I18N.resolve() unchanged.
 *
 * Plain browser script, no modules, no dependencies. Loaded before app.js.
 */
(function () {
  "use strict";

  var LANGS = [
    { id: "en", label: "English" },
    { id: "zh", label: "中文" },
  ];
  var DEFAULT_LANG = "en";

  function normLang(id) {
    if (typeof id !== "string") return null;
    var s = id.trim().toLowerCase();
    if (s === "zh" || s === "zh-cn" || s === "zh-hans" || s === "cn" || s === "chinese" || s === "中文") return "zh";
    if (s === "en" || s === "en-us" || s === "english") return "en";
    return null;
  }

  var current = DEFAULT_LANG;

  var DICT = {
 "en": {
  " · ${…} 个失败（原文件已保留）": " · ${…} failed (originals kept)",
  " · ${…} 个样本偏短": " · ${…} short samples",
  " · ${…} 失败": " · ${…} failed",
  " · ⚠样本短": " · ⚠ short sample",
  " · ⚠️ 压缩副本生成失败：${…}": " · ⚠️ Could not create the compressed copy: ${…}",
  " · ⚠️ 音频压缩失败：${…}（原始 WAV 已保留）": " · ⚠️ Audio compression failed: ${…} (original WAV files kept)",
  " · 会议目录只存压缩副本（${…}），原文件仍在你原来的位置（${…}）": " · the meeting folder now holds only the compressed copy (${…}); the original files stay where they were (${…})",
  " · 当前使用": " · in use",
  " · 重试 ": " · retry ",
  " · 音频已压缩（${…} kbps），回收 ${…}": " · audio compressed (${…} kbps), reclaimed ${…}",
  " · 音频已压缩，回收 ${…}": " · audio compressed, reclaimed ${…}",
  " —— 请逐个试听确认，填名字即可全场生效。": " — preview each one to confirm, then enter a name to apply it everywhere.",
  " ⚠️ 填写的模型不在已安装列表里": " ⚠️ The model you entered is not in the installed list",
  " 分钟 · ": " min · ",
  " 示例模型可能已更新，点「测试连接」可拉取真实列表。": " The sample models may be out of date — click “Test connection” to fetch the real list.",
  "${a.app} —— 已自动开始录音（可在设置里关闭）": "${…} — recording started automatically (can be turned off in Settings)",
  "${jobQueue.size(readQueue())} 个会议等待转写，开始处理…": "${…} meetings are waiting to be transcribed — starting now…",
  "${path.basename(dir)} —— 插电后自动转写": "${…} — transcribes automatically once plugged in",
  "${path.basename(dir)} —— 点此打开会议文件夹": "${…} — click to open the meeting folder",
  "${r.kind} 轨道录音已到达文件大小上限，正在自动停止并完成转写…": "The ${…} track reached the file-size limit — stopping automatically and finishing transcription…",
  "${…} · ${…}": "${…} · ${…}",
  "${…} — 约 ${…} MB/小时": "${…} — about ${…} MB/hour",
  "${…} 下载完成（${…}）": "${…} downloaded (${…})",
  "${…} 个 WAV · ${…} → 预计 ${…}": "${…} WAV files · ${…} → estimated ${…}",
  "${…} 个会议 · ${…}": "${…} meetings · ${…}",
  "${…} 分钟": "${…} min",
  "${…} 段 · ${…}": "${…} segments · ${…}",
  "(点说话人标签改名)": "(click a speaker label to rename)",
  "(这个会议没有 notes.md)": "(this meeting has no notes.md)",
  "15 分钟": "15 minutes",
  "16 / 24 kbps 会整句丢失并改错人名": "16 / 24 kbps dropped whole sentences and mangled names",
  "16 kHz 单声道": "16 kHz mono",
  "30 分钟": "30 minutes",
  "4 分钟": "4 minutes",
  "5 分钟": "5 minutes",
  "90 分钟": "90 minutes",
  "<div class=\"dirrow\"><span>${…}</span><button class=\"ghost pick\" data-m=\"${…}\">用这个</button></div>": "<div class=\"dirrow\"><span>${…}</span><button class=\"ghost pick\" data-m=\"${…}\">Use this</button></div>",
  "<div class=\"dirrow\"><span>${…}</span><span>${…} 个 · ${…} → ${…}</span></div>": "<div class=\"dirrow\"><span>${…}</span><span>${…} files · ${…} → ${…}</span></div>",
  "<div class=\"dirrow\"><span>${…}</span><span>${…} 个 · 回收 ${…}${…}</span></div>": "<div class=\"dirrow\"><span>${…}</span><span>${…} files · reclaimed ${…}${…}</span></div>",
  "<div class=\"dirrow\"><span>${…}</span><span>${…}${…}${…}</span></div>": "<div class=\"dirrow\"><span>${…}</span><span>${…}${…}${…}</span></div>",
  "<div class=\"hint\">读取中…</div>": "<div class=\"hint\">Loading…</div>",
  "<div class=\"hint\">读取失败：${…}</div>": "<div class=\"hint\">Load failed: ${…}</div>",
  "<div class=\"hint\">还没有可打开的会议（录音或导入一次就会出现）。</div>": "<div class=\"hint\">No meetings to open yet (one appears after you record or import).</div>",
  "<div class=\"hint\">还没有识别发言人——点「识别发言人」按声音把他们分开（本地运行，首次会下载 27 MB 声纹模型）。</div>": "<div class=\"hint\">No speakers identified yet — click “Identify speakers” to separate them by voice (runs locally; the first run downloads a 27 MB voiceprint model).</div>",
  "<option value=\"\">（自动选择：优先文本模型，跳过视觉模型）</option>": "<option value=\"\">(Auto-select: prefers text models, skips vision models)</option>",
  "<option value=\"\">（读取失败：${…}）</option>": "<option value=\"\">(Load failed: ${…})</option>",
  "API Key（OpenAI 兼容时需要）": "API key (required for OpenAI-compatible)",
  "Anthropic Claude（兼容层）": "Anthropic Claude (compatibility layer)",
  "Audio2Notes 即将自动退出": "Audio2Notes is about to quit automatically",
  "CPU（${cores} 线程可用）": "CPU (${…} threads available)",
  "DeepSeek（深度求索）": "DeepSeek",
  "DirectML 不可用：当前 onnxruntime-node 只有 CPU 执行提供器，GPU/NPU 加速尚未接入": "DirectML unavailable: the installed onnxruntime-node ships only the CPU execution provider, so GPU/NPU acceleration is not wired up yet",
  "DirectML 可用": "DirectML available",
  "DirectML 可用，插电模式用独显": "DirectML available — AC mode uses the dedicated GPU",
  "DirectML 可用，电池模式优先用核显": "DirectML available — battery mode prefers the integrated GPU",
  "ECONNREFUSED（本机未安装/未启动）": "ECONNREFUSED (not installed or not running on this machine)",
  "Google Gemini（OpenAI 兼容，路径待核实）": "Google Gemini (OpenAI-compatible, path unverified)",
  "Groq（极快推理）": "Groq (very fast inference)",
  "HTTP 200（本机已在运行）": "HTTP 200 (already running on this machine)",
  "HTTP 404（探测路径不对，需实测）": "HTTP 404 (wrong probe path — needs a live test)",
  "LM Studio（本地，OpenAI 兼容）": "LM Studio (local, OpenAI-compatible)",
  "Loading Whisper model…": "Loading Whisper model…",
  "MP3 96 kbps 单声道（兼容老软件）": "MP3 96 kbps mono (compatible with older software)",
  "Mixing audio…": "Mixing audio…",
  "Ollama（本地）": "Ollama (local)",
  "Ollama（本地，推荐）": "Ollama (local, recommended)",
  "Ollama（本地，无需 key）": "Ollama (local, no API key needed)",
  "OpenAI 兼容接口": "OpenAI-compatible API",
  "OpenRouter（聚合多家）": "OpenRouter (many providers in one)",
  "Opus 16 kbps 单声道（最小；实测会丢句）": "Opus 16 kbps mono (smallest; measured to drop whole sentences)",
  "Opus 24 kbps 单声道（省空间；实测会丢句、改人名）": "Opus 24 kbps mono (saves space; measured to drop sentences and mangle names)",
  "Opus 32 kbps ≈ 14.4 MB/小时": "Opus 32 kbps ≈ 14.4 MB/hour",
  "Opus 32 kbps 单声道（推荐）": "Opus 32 kbps mono (recommended)",
  "Opus 48 kbps 单声道": "Opus 48 kbps mono",
  "Transcribing with local Whisper…": "Transcribing with local Whisper…",
  "Writing notes…": "Writing notes…",
  "base.en（推荐，仅英文）": "base.en (recommended, English only)",
  "base（推荐，多语言）": "base (recommended, multilingual)",
  "sherpa-onnx 不可用：": "sherpa-onnx unavailable: ",
  "small.en（更准，更慢）": "small.en (more accurate, slower)",
  "small（更准，更慢，多语言）": "small (more accurate, slower, multilingual)",
  "tiny.en（最快，仅英文）": "tiny.en (fastest, English only)",
  "tiny（最快，多语言）": "tiny (fastest, multilingual)",
  "——采样率与声道数正合 Whisper 输入，这部分不损失任何东西；": " — the sample rate and channel count match Whisper's input exactly, so nothing is lost there;",
  "⏸ 已排队（续航优先模式）${…} —— 插电后自动转写，也可以点「立即处理」。": "⏸ Queued (battery-saver mode)${…} — transcription starts automatically once plugged in, or click “Process now”.",
  "● 检测到 ${…} 在播放声音，已自动开始录音…": "● ${…} is playing audio — recording started automatically…",
  "⚠️ ${…} 轨没有录到声音（峰值 ${…} dBFS，有效样本 ${…}%）——检查默认输入设备或静音开关": "⚠️ The ${…} track recorded no sound (peak ${…} dBFS, ${…}% active samples) — check the default input device and any mute switch",
  "⚠️ Whisper 自身的线程数暂无法限制（transformers.js v2 不暴露该选项），所以省电主要来自模型降档与「不转写」": "⚠️ Whisper's own thread count cannot be limited yet (transformers.js v2 does not expose that option), so power saving comes mainly from stepping the model down and from not transcribing at all",
  "⚠️ 勾选后压缩不省空间：一条 155 分钟、16 kHz 单声道的录音约": "⚠️ With this checked, compression saves no space: a 155-minute, 16 kHz mono recording is about",
  "⚠️ 摘要降级为规则提取（原因：${…}）—— 笔记顶部已标注，点「重新生成」可重试": "⚠️ Summary fell back to rule-based extraction (reason: ${…}) — this is marked at the top of the notes; click “Regenerate” to retry",
  "⚠️ 笔记降级": "⚠️ Notes degraded",
  "⚠️ 麦克风一直没有声音——检查默认输入设备或耳机上的静音开关": "⚠️ The microphone has produced no sound at all — check the default input device and any mute switch on your headset",
  "✓ 已保存为笔记接口": "✓ Saved as the notes endpoint",
  "✗ 连接失败：${…}${…}": "✗ Connection failed: ${…}${…}",
  "　（本机探测：${…}）": " (probe: ${…})",
  "。": ".",
  "。只在需要留原始 WAV 时勾选。": ". Check this only if you need to keep the original WAV files.",
  "一个 key 访问多家模型；模型名形如 厂商/模型。": "One key for many providers' models; the model name looks like vendor/model.",
  "下载": "Download",
  "下载中 ${…}%${…}": "Downloading ${…}%${…}",
  "下载中…": "Downloading…",
  "下载声纹模型 ${p.percent}%…": "Downloading the voiceprint model ${…}%…",
  "下载声纹模型（约 27 MB）": "Downloading the voiceprint model (about 27 MB)",
  "下载失败 HTTP ${res.statusCode}": "Download failed: HTTP ${res.statusCode}",
  "下载失败：": "Download failed: ",
  "下载源与缓存": "Download source & cache",
  "不需要更改参会人": "No participant changes needed",
  "中文": "中文",
  "中断处理并退出": "Interrupt processing and quit",
  "为「${…}」设置名字：": "Set a name for “${…}”:",
  "从不自动退出": "Never quit automatically",
  "从参会人名单里选一个名字": "Pick a name from the attendee list",
  "以后停止时不要再问我": "Do not ask me again when stopping",
  "任何 /chat/completions 兼容的接口（vLLM、one-api、自建中转等）。": "Any /chat/completions-compatible endpoint (vLLM, one-api, your own proxy, and so on).",
  "会写明": "records",
  "会议似乎结束了": "The meeting seems to be over",
  "会议目录不存在": "Meeting folder does not exist",
  "会议软件停止播放声音后，自动停止录音并出笔记": "Stop recording and generate notes automatically when a meeting app stops playing audio",
  "会议软件已停止播放声音，正在停止录音并生成笔记": "The meeting app stopped playing audio — stopping the recording and generating notes",
  "会议软件已停止播放声音，自动停止并处理…": "The meeting app stopped playing audio — stopping automatically and processing…",
  "会议软件已停止播放声音，自动停止录音…": "The meeting app stopped playing audio — recording stopped automatically…",
  "会议软件开始播放声音时，自动开始录音（涉及隐私，默认关闭）": "Start recording automatically when a meeting app starts playing audio (privacy-sensitive; off by default)",
  "会议软件检测不可用：": "Meeting-app detection unavailable: ",
  "会议软件检测（WASAPI 音频会话）": "Meeting-app detection (WASAPI audio sessions)",
  "但编码是有损的，实测（120 秒真实语音 + base 模型）": "the encoding is lossy, though, and in a real test (120 seconds of speech + the base model) ",
  "你": "You",
  "使用": "Use",
  "使用中": "In use",
  "保存": "Save",
  "保存中…": "Saving…",
  "保存为笔记接口": "Save as notes endpoint",
  "保存失败：": "Save failed: ",
  "保留原始 WAV（压缩但不再省空间）": "Keep original WAV files (compress without saving space)",
  "关闭": " off",
  "关闭会中断当前的转写/摘要。已保存的音频不会丢失，可以之后重新处理。": "Closing interrupts the current transcription or summary. Saved audio is not lost and can be processed again later.",
  "写入失败：": "Write failed: ",
  "准备下载…": "Preparing download…",
  "删除": "Delete",
  "删除 ${…}？下次使用会需要重新下载。": "Delete ${…}? It will need to be downloaded again next time.",
  "删除中…": "Deleting…",
  "删除前会做四重校验（编码成功 + 体积正常 + 二次解码通过 + 时长一致），任何一步失败都保留原文件。": "Before deleting anything, four checks are run (encode succeeded + size looks right + decode again + duration matches); if any step fails, the original file is kept.",
  "删除失败：": "Delete failed: ",
  "删除已下载的声纹模型？程序内置的那份仍然可用，识别发言人不会中断。": "Delete the downloaded voiceprint model? The copy bundled with the app stays available, so identifying speakers keeps working.",
  "刷新": "Refresh",
  "剩余 ${a.freeGB.toFixed(1)} GB，已自动停止录音以免写满磁盘。": "${…} GB free — recording stopped automatically so the disk cannot fill up.",
  "历史会议": "History",
  "压缩 ${p.dirName}/${p.file}（${p.index}/${p.total}）…": "Compressing ${p.dirName}/${p.file} (${p.index}/${p.total})…",
  "压缩 ${p.file}（${p.index}/${p.total}）…": "Compressing ${…} (${…}/${…})…",
  "压缩中…": "Compressing…",
  "压缩已有会议音频": "Compress existing meeting audio",
  "压缩档位": "Compression preset",
  "压缩音频（${preset.label}）…": "Compressing audio (${…})…",
  "原文": "Original",
  "参会人": "Participants",
  "参会人名字…": "Participant name…",
  "双语": "Bilingual",
  "发言人": "Speakers",
  "取消": "Cancel",
  "只有视觉模型可用": "Only vision models are available",
  "合并到…": "Merge into…",
  "合并失败：": "Merge failed: ",
  "合并要点 ${round}/${i + 1}…": "Merging key points, round ${round}, part ${i + 1}…",
  "同等语音质量下 Opus 比 MP3 小约 3 倍；只有需要把录音丢给老软件时才建议选 MP3。": "At the same speech quality Opus is about 3× smaller than MP3; choose MP3 only if you need to feed recordings to older software.",
  "名单没有保存：这次询问已经超时。稍后停止录音时如果还需要名单，会再问你。": "The list was not saved: the prompt timed out. If the list is still needed when recording stops, you will be asked again.",
  "填名字…": "Enter a name…",
  "声纹分割模型（随程序分发）": "Speaker segmentation model (bundled)",
  "声纹模型下载不完整": "The voiceprint model download is incomplete",
  "声纹模型下载完成（${…}）": "Voiceprint model downloaded (${…})",
  "声纹模型尚未下载（自动下载已关闭）": "The voiceprint model is not downloaded yet (automatic download is off)",
  "声纹模型尚未下载（首次识别需要下载约 27 MB）": "The voiceprint model is not downloaded yet (the first identification run downloads about 27 MB)",
  "声纹模型（3D-Speaker CAM++ 中英）": "Voiceprint model (3D-Speaker CAM++ zh/en)",
  "声音已恢复，仍在监控。": "Audio is back — still monitoring.",
  "处理中…": "Processing…",
  "处理完立即退出": "Quit as soon as processing finishes",
  "处理排队会议：${…}…": "Processing queued meeting: ${…}…",
  "失败：": "Failed: ",
  "完全本地，隐私最好；模型用 ollama pull 安装后会自动出现在列表里。": "Fully local and the most private option; models installed with ollama pull show up in the list automatically.",
  "官方兼容层地址可达；若报错请改用 OpenRouter 走 Claude。": "The official compatibility endpoint is reachable; if it errors, use OpenRouter to reach Claude instead.",
  "官方兼容层存在，但探测未通过——用之前请点「测试连接」确认。": "The official compatibility layer exists, but the probe did not pass — click “Test connection” to confirm before relying on it.",
  "将把会议目录里的 WAV 转成压缩音频，并在校验通过后删除原始 WAV。": "This converts the WAV files in your meeting folder to compressed audio and deletes the originals once verification passes.",
  "已 ${Math.round(a.silentSec / 60)} 分钟没有声音，${lc.autoStop.forceStopAfterMin} 分钟后将自动停止并处理。": "No audio for ${…} minutes; stopping and processing in ${…} minutes.",
  "已 ${…} 分钟没有声音。${…} 秒后将自动停止并生成笔记（录音仍在继续）。": "No audio for ${…} minutes. Stopping and generating notes in ${…} seconds (recording continues).",
  "已下载 ${…}": "Downloaded ${…}",
  "已下载 ${…}${…}": "Downloaded ${…}${…}",
  "已保存下载地址：${…}": "Download endpoint saved: ${…}",
  "已删除 ${…}": "Deleted ${…}",
  "已删除声纹模型": "Voiceprint model deleted",
  "已删除已下载的声纹模型（继续使用内置那份）": "Deleted the downloaded voiceprint model (still using the bundled copy)",
  "已占用 ${…}": "${…} used",
  "已取消本次自动停止，直到再次长时间无声。": "Auto-stop cancelled — it will not trigger again until the next long silence.",
  "已合并。": "Merged.",
  "已安装的模型": "Installed models",
  "已完成 ✓ 压缩 ${…} 个文件，回收 ${…}": "Done ✓ compressed ${…} files, reclaimed ${…}",
  "已录音 ${a.elapsedMin} 分钟，达到最大录音时长，正在自动停止并完成处理…": "Recorded ${…} minutes, the maximum recording length — stopping automatically and finishing processing…",
  "已打开历史会议：": "Opened past meeting: ",
  "已打开：": "Opened: ",
  "已排队（续航优先模式）": "Queued (battery-life-first mode)",
  "已排队，插电后自动转写": "Queued — transcription starts once plugged in",
  "已排队，等待电源。": "Queued, waiting for power.",
  "已接通电源": "Plugged in",
  "已更新：转写全部生效（笔记里没有出现旧名字）": "Updated: applied to the whole transcript (the old name did not appear in the notes)",
  "已更新：转写全部生效，笔记里 ${…} 处旧名字也一起改了": "Updated: applied to the whole transcript, and ${…} old name(s) in the notes were replaced too",
  "已跳过视觉模型": "Skipped vision models",
  "已重新生成 ✓": "Regenerated ✓",
  "已随包 ${…}": "Bundled ${…}",
  "已随程序分发 ${…}（无需下载）": "Bundled with the app — ${…} (no download needed)",
  "常用提供方（选中会自动填地址与示例模型）": "Common providers (selecting one fills in the endpoint and sample model)",
  "开始下载 ${model.replace(\"Xenova/\", \"\")}…": "Starting download: ${model.replace(\"Xenova/\", \"\")}…",
  "开始下载声纹模型…": "Starting the voiceprint model download…",
  "开始压缩并删除 WAV": "Compress and delete WAV files",
  "开始处理排队的会议…": "Starting to process queued meetings…",
  "引擎：": "Engine: ",
  "当前模式下不自动转写": "Not transcribing automatically in the current mode",
  "当前没有会议软件在播放声音（监听 ${…} 个音频会话）": "No meeting app is playing audio right now (monitoring ${…} audio sessions)",
  "录音似乎已经结束": "The recording seems to have ended",
  "录音只落盘 + 压缩，转写排队等插电（这是唯一能量级上的省电手段）": "Recording is written to disk and compressed only; transcription is queued until you plug in (the only power saving that really matters)",
  "录音后立即转写": "Transcribes as soon as recording stops",
  "录音已到达时长上限": "Recording reached the time limit",
  "录音文件已达大小上限": "The recording reached the file-size limit",
  "录音期间以约 1.5 GB/小时写盘，所以磁盘保护是默认开启的。": "Recording writes about 1.5 GB/hour, so disk protection is on by default.",
  "性能优先": "Performance first",
  "打开": "Open",
  "打开中…": "Opening…",
  "打开以前录好的会议 —— 笔记、转写和": "Open a meeting you recorded earlier — its notes, transcript and",
  "打开失败：": "Open failed: ",
  "打开文件夹": "Open folder",
  "打开缓存目录": "Open cache folder",
  "扫描中…": "Scanning…",
  "扫描可回收空间": "Scan for reclaimable space",
  "扫描失败：": "Scan failed: ",
  "找不到发言人 ": "Speaker not found ",
  "找不到可用于声纹分析的音频（system/mixed 都不存在）": "No audio usable for voiceprint analysis (neither system nor mixed exists)",
  "找到 ${names.length} 个已安装模型": "Found ${…} installed models",
  "把「${…}」的所有片段合并到「${…}」？": "Merge all segments of “${…}” into “${…}”?",
  "把这一行合并到另一个发言人（修正过度切分）": "Merge this row into another speaker (fixes over-segmentation)",
  "把这个档位设为转写模型": "Make this the transcription model",
  "排队中的会议": "Queued meetings",
  "排队会议已转写完成": "Queued meetings finished transcribing",
  "排队失败：": "Queueing failed: ",
  "排队等插电": "Queued until plugged in",
  "接口可用（未返回模型列表）": "Endpoint reachable (no model list returned)",
  "接口可用，列出 ${names.length} 个模型": "Endpoint reachable, ${…} models listed",
  "接口地址": "Endpoint URL",
  "推荐": "Recommended",
  "提供方类型": "Provider type",
  "提醒后多少分钟强制停止": "Force stop this many minutes after the warning",
  "插电": "AC power",
  "插电使用：允许独显、最大模型、立即转写": "On AC power: dedicated GPU allowed, largest model, transcribe immediately",
  "插电用「性能优先」，电池用下面选的那个": "“Performance first” on AC power, and whichever option you pick below on battery",
  "摘要详细程度": "Summary detail level",
  "摘要详细程度（默认档）": "Summary detail (default)",
  "播放失败：": "Playback failed: ",
  "改名失败：": "Rename failed: ",
  "整理成最终笔记…": "Assembling the final notes…",
  "整理结果…": "Organizing results…",
  "无声多少分钟后提醒": "Warn after this many minutes of silence",
  "无效的合并": "Invalid merge",
  "智谱 GLM": "Zhipu GLM",
  "月之暗面 Kimi": "Moonshot Kimi",
  "有发言人": "has speakers",
  "有排队的会议": "Meetings are queued",
  "服务在跑，但一个模型都没装": "The service is running, but no models are installed",
  "未下载（约 ${…} MB）${…}": "Not downloaded (about ${…} MB)${…}",
  "未下载（约 ${…} MB）——「识别发言人」也需要它": "Not downloaded (about ${…} MB) — “Identify speakers” needs it too",
  "未检测": "not checked",
  "未知的模型类型：": "Unknown model type: ",
  "未知错误": "unknown error",
  "未配置 LLM（当前为内置规则抽取模式）": "No LLM configured (currently using the built-in rule-based extraction mode)",
  "本机跑其他开源模型时用这个；启动 LM Studio 的本地服务器即可。": "Use this to run other open models locally; just start LM Studio's local server.",
  "标准": "Standard",
  "样本文件不存在": "Sample file does not exist",
  "核显（${engines.igpu}）": "Integrated GPU (${…})",
  "检测会议软件的音频会话（本地实现，不联网、不读窗口内容）": "Detect meeting apps' audio sessions (implemented locally; no network access, no window contents read)",
  "检测到 ${…} 正在播放声音": "${…} is playing audio",
  "检测到会议软件在播放声音": "A meeting app is playing audio",
  "模型": "Model",
  "模型下载地址（huggingface.co 不通时改成镜像）": "Model download endpoint (use a mirror if huggingface.co is unreachable)",
  "模型名要填你在方舟控制台创建的「推理接入点」ID（形如 ep-xxxxxxxx）。": "For the model name, enter the inference endpoint ID you created in the Ark console (it looks like ep-xxxxxxxx).",
  "模型存在缓存目录里，拷到另一台机器即可离线使用。": "Models live in a cache directory — copy it to another machine for offline use.",
  "模型状态读取失败：": "Could not read model status: ",
  "模型自动降档：${…} → ${…}": "Model stepped down automatically: ${…} → ${…}",
  "模型：": "Model: ",
  "正在处理": "Processing",
  "正在录音": "Recording in progress",
  "正在录音/处理时关闭窗口要先确认（防止误关丢掉整场会议的处理）": "Confirm before closing the window while recording/processing (protects against losing a whole meeting's processing by accident)",
  "此操作对原始 WAV 不可撤销（转写结果 unaffected）。确定继续？": "This cannot be undone for the original WAV files (transcripts are unaffected). Continue?",
  "没有找到 WAV 文件（可能已经压缩过了）。": "No WAV files found (they may already be compressed).",
  "没有样本": "no sample",
  "测试中…": "Testing…",
  "测试连接": "Test connection",
  "添加一位": "Add one",
  "火山方舟（豆包）": "Volcano Ark (Doubao)",
  "点击改名": "Click to rename",
  "独显（${engines.dgpu}）": "Dedicated GPU (${…})",
  "生命周期与后台": "Lifecycle & background",
  "生成压缩副本（原文件保持不动）…": "Creating compressed copy (original files untouched)…",
  "生成笔记…": "Writing notes…",
  "用于「生成笔记」的模型接口；翻译引擎在 Settings 页单独配置。": "The model endpoint used to generate notes; the translation engine is configured separately on the Settings tab.",
  "电池": "On battery",
  "电池使用：优先省电，但仍立即出笔记": "On battery: save power, but still produce notes right away",
  "电池使用：只录音，回到插电再转写": "On battery: record only; transcribe once plugged in again",
  "电池时：省电优先": "On battery: save power",
  "电池时：续航优先（排队）": "On battery: battery life first (queue)",
  "电源模式": "Power mode",
  "电源模式读取失败：": "Could not read power mode: ",
  "监控的进程名（逗号分隔）": "Process names to watch (comma-separated)",
  "直接关闭会停止录音。已录制的音频仍会保存在会议文件夹里。": "Closing now stops the recording. Audio recorded so far is kept in the meeting folder.",
  "省电优先": "Power saving first",
  "省电模式：转写模型降档，说话人分离与 ffmpeg 限制线程数": "Power-saving mode: the transcription model is stepped down, and speaker separation and ffmpeg are thread-limited",
  "硅基流动 SiliconFlow": "SiliconFlow",
  "磁盘剩余 ${…} GB（低于 ${…} GB），已停止录音以免写满。": "Only ${…} GB free (below ${…} GB) — recording stopped to avoid filling the disk.",
  "磁盘剩余低于 (GB) 就停止": "Stop when free disk space drops below (GB)",
  "磁盘空间不足": "Not enough disk space",
  "磁盘空间不足，自动停止并处理…": "Low disk space — stopping automatically and processing…",
  "移除": "Remove",
  "移除这一位": "Remove this one",
  "空闲 ${a.threshold} 分钟后自动退出（可在设置里关闭）。现在仍可继续使用。": "Quits automatically after ${…} minutes idle (can be turned off in Settings). You can keep using it for now.",
  "空闲多久后自动退出": "Quit automatically after this much idle time",
  "立即处理": "Process now",
  "笔记完成": "Notes complete",
  "笔记已生成": "Notes are ready",
  "笔记接口（LLM）": "Notes endpoint (LLM)",
  "笔记生成完成后弹通知（点击打开会议文件夹）": "Show a notification when notes are ready (click to open the meeting folder)",
  "笔记（摘要）自动翻译成中文（总开关）": "Automatically translate notes (summaries) into Chinese (master switch)",
  "等待参会人确认（选择后继续处理）…": "Waiting for participant confirmation (processing continues after you choose)…",
  "简要": "Brief",
  "继续录音": "Keep recording",
  "继续录音（已取消自动停止，直到再次长时间无声）。": "Recording resumed (auto-stop cancelled until the next long silence).",
  "续航优先": "Battery life first",
  "编码器缺失：此 ffmpeg 未提供“${codec}”编码器，无法压缩（请检查捆绑的 ffmpeg）": "Encoder missing: this ffmpeg build has no “${codec}” encoder, so compression is not possible (check the bundled ffmpeg)",
  "缺失（打包异常）": "Missing (packaging problem)",
  "缺少会议目录": "Meeting folder missing",
  "缺少分割模型": "Missing segmentation model",
  "缺少分割模型（assets/models/pyannote-segmentation-3-0.int8.onnx）": "Missing the segmentation model (assets/models/pyannote-segmentation-3-0.int8.onnx)",
  "缺模型时将直接报错，不再自动下载。": "Missing models now raise an error instead of downloading automatically.",
  "缺模型时将自动下载。": "Missing models are downloaded automatically.",
  "缺模型时自动下载（关闭后缺模型会直接报错并说明）": "Download missing models automatically (when off, a missing model raises a clear error)",
  "翻译引擎": "Translation engine",
  "翻译整篇转写稿（很慢：155 分钟的会议约需 90 分钟；只翻摘要约 4 分钟）": "Translate the whole transcript (very slow: about 90 minutes for a 155-minute meeting; summaries alone take about 4 minutes)",
  "翻译（自动转成中文）": "Translation (auto-translate into Chinese)",
  "自动": "Auto",
  "自动下载": " downloaded automatically ",
  "自动停止前会先弹系统通知，并在录音面板显示倒计时，你可以点「继续录音」取消。": "A system notification appears before the auto-stop, with a countdown on the recording panel; click “Keep recording” to cancel.",
  "自动模式下，电池时采用哪个模式": "Which mode to use on battery in auto mode",
  "自动模式：当前${…}，使用「${…}」": "Auto mode: currently on ${…}, using “${…}”",
  "自动识别发言人失败：": "Automatic speaker identification failed: ",
  "自动识别发言人（本地 CPU，长会议需要几分钟）…": "Auto-identifying speakers (local CPU; a few minutes for long meetings)…",
  "自定义（手填地址）": "Custom (enter the endpoint yourself)",
  "视觉模型，摘要质量通常更差": "Vision model — summaries are usually worse",
  "解码音频…": "Decoding audio…",
  "识别中…（本地 CPU，长会议需要几分钟）": "Identifying… (local CPU; a few minutes for long meetings)",
  "识别到 ${res.speakers.length} 个发言人": "Found ${…} speakers",
  "识别到 ${…} 个发言人（按 ${…} 分析）": "Found ${…} speakers (analyzed by ${…})",
  "识别发言人": "Identify speakers",
  "识别发言人…": "Identifying speakers…",
  "识别发言人失败：": "Speaker identification failed: ",
  "识别发言人（首次使用会下载 27 MB 声纹模型）…": "Identifying speakers (the first run downloads a 27 MB voiceprint model)…",
  "识别说话人…": "Separating speakers…",
  "试听 ${…} 秒样本": "Preview ${…} s sample",
  "试听失败：": "Preview failed: ",
  "该会议还没有发言人信息（先点「识别发言人」）": "This meeting has no speaker information yet (click “Identify speakers” first)",
  "详细": "Detailed",
  "说话人": "Speaker",
  "说话人已更新 — 点「重新生成」刷新笔记里的归属。": "Speaker updated — click “Regenerate” to refresh speaker attribution in the notes.",
  "说话人识别模型": "Speaker identification models",
  "跳过自动识别发言人：": "Skipping automatic speaker identification: ",
  "跳过自动识别发言人：声纹模型尚未下载，请在「模型与接口」页点下载": "Skipping speaker identification: the voiceprint model is not downloaded yet — click Download on the “Models & Interfaces” tab",
  "跳过转写稿翻译：保留原文以节省时间（155 分钟的会议约需 90 分钟）。如需中文转写稿，请在「设置 → 翻译」勾选「翻译整篇转写稿」后重新处理。": "Skipped transcript translation to save time (a 155-minute meeting takes about 90 minutes). For a Chinese transcript, turn on “Translate the whole transcript” under “Settings → Translation” and process the meeting again.",
  "跳过长静音 ${audioStats.silenceSkippedSec}s（${audioStats.cutRuns} 段），送入模型 ${audioStats.speechKeptSec}s / 共 ${audioStats.totalSec}s": "Skipped ${…}s of long silence (${…} runs); sent ${…}s of speech out of ${…}s to the model",
  "转写中…": "Transcribing…",
  "转写完成后自动压缩音频（原始 WAV 在校验通过后才会删除）": "Compress audio automatically after transcription (original WAV files are deleted only after verification passes)",
  "转写排队的会议（${profile.model.replace(\"Xenova/whisper-\", \"\")}）…": "Transcribing queued meetings (${…})…",
  "转写模型（Whisper）": "Transcription model (Whisper)",
  "转写稿翻译默认": "By default, transcript translation is",
  "还没有识别发言人——点「识别发言人」按声音把他们分开（本地运行，首次会下载 27 MB 声纹模型）。": "No speakers identified yet — click “Identify speakers” to separate them by voice (runs locally; the first run downloads a 27 MB voiceprint model).",
  "这个会议没有可用的音频（system/mixed）": "This meeting has no usable audio (system/mixed)",
  "这个发言人没有样本": "This speaker has no sample",
  "这些名字会和这场会议的笔记一起保存（笔记里的「你 / 远端」会变成具体人名）。": "These names are saved with this meeting's notes (the “You / Remote” labels in the notes become real names).",
  "远端": "Remote",
  "选参会人…": "Pick an attendee…",
  "逐段提炼 ${i + 1}/${chunks.length}…": "Summarising section ${i + 1} of ${chunks.length}…",
  "重定向过多": "Too many redirects",
  "重新生成": "Regenerate",
  "重新生成中…": "Regenerating…",
  "重新编辑这场会议已保存的参会人名单。": "Edit the participant list saved for this meeting.",
  "长会议会自动分段提炼再合并（map-reduce），不会像以前那样被截断。摘要失败时会**明确标注**为规则提取，不会伪装成摘要。": "Long meetings are distilled in chunks and merged (map-reduce), so nothing is truncated the way it used to be. If summarization fails it is **clearly marked** as rule-based extraction instead of pretending to be a summary.",
  "长时间无人声时自动停止录音（防\"忘了按停止\"）": "Stop recording automatically after a long silence (in case you forget to press Stop)",
  "长时间无人声，自动停止并处理…": "No speech for a long time — stopping automatically and processing…",
  "阿里云百炼 / 通义千问": "Alibaba Cloud Bailian / Qwen",
  "需要中文转写稿时再勾选它；不勾选时会议记录里的": "Turn this on only when you need a Chinese transcript. When it is off,",
  "面板都会加载出来，可以对过去的会议逐个试听 5 秒样本、填上真实姓名。": "panel are loaded, so you can preview 5-second samples and enter real names for past meetings.",
  "音频可试听": "audio preview available",
  "音频归档": "Audio archiving",
  "音频统一转成 ": "Audio is normalized to ",
  "首次使用某个档位会": "The first time you use a model it is",
  "🔋 电池供电": "🔋 On battery",
  "🔌 插电": "🔌 Plugged in",
  "（加大批量没有用，瓶颈是生成速度）。只翻摘要约 ": " (larger batches do not help; generation speed is the bottleneck). Summaries alone take about ",
  "（可回收 ${…}，按 ${…}）": "(can reclaim ${…}, using ${…})",
  "（带进度）。也可以在这里提前下载、切换档位，或删掉不再需要的以释放空间。": "(with progress). You can also download ahead of time, switch models, or delete the ones you no longer need to free up space.",
  "（无译文）": "(no translation)",
  "（样本偏短，可能不准）": "(sample is short — may be inaccurate)",
  "（点 ▶ 试听 5 秒样本，输入框填名字，回车保存）": "(click ▶ to preview a 5-second sample, type a name, press Enter to save)",
  "（留空 = 自动挑选）": "(blank = pick automatically)",
  "（自动选择：优先文本模型，跳过视觉模型）": "(auto-select: prefers text models, skips vision models)",
  "（采集 WAV 约 691 MB/小时）。": " (captured WAV is about 691 MB/hour).",
  "，Opus 32 kbps 压缩副本约": ", and the Opus 32 kbps copy is about",
  "，因为它实测是整条流水线里最慢的一步：155 分钟的会议有 2663 段、约 13 万字符英文，产出约 9 万 token，受本机 16.5 token/s 的生成速度限制约需 ": ", because it is measurably the slowest step in the pipeline: a 155-minute meeting has 2663 segments (~130k characters of English), produces ~90k tokens, and takes about ",
  "，并且流水线里会明确提示，不会默默跳过。": ", and the pipeline says so explicitly instead of silently skipping.",
  "，故默认 ": ", so the default is ",
  "，音频已压缩回收 ${…}": ", audio compressed, reclaimed ${…}",
 },
 "zh": {
  " · ${…} 个失败（原文件已保留）": " · ${…} 个失败（原文件已保留）",
  " · ${…} 个样本偏短": " · ${…} 个样本偏短",
  " · ${…} 失败": " · ${…} 失败",
  " · ⚠样本短": " · ⚠样本短",
  " · ⚠️ 压缩副本生成失败：${…}": " · ⚠️ 压缩副本生成失败：${…}",
  " · ⚠️ 音频压缩失败：${…}（原始 WAV 已保留）": " · ⚠️ 音频压缩失败：${…}（原始 WAV 已保留）",
  " · 会议目录只存压缩副本（${…}），原文件仍在你原来的位置（${…}）": " · 会议目录只存压缩副本（${…}），原文件仍在你原来的位置（${…}）",
  " · 当前使用": " · 当前使用",
  " · 重试 ": " · 重试 ",
  " · 音频已压缩（${…} kbps），回收 ${…}": " · 音频已压缩（${…} kbps），回收 ${…}",
  " · 音频已压缩，回收 ${…}": " · 音频已压缩，回收 ${…}",
  " —— 请逐个试听确认，填名字即可全场生效。": " —— 请逐个试听确认，填名字即可全场生效。",
  " ⚠️ 填写的模型不在已安装列表里": " ⚠️ 填写的模型不在已安装列表里",
  " 分钟 · ": " 分钟 · ",
  " 示例模型可能已更新，点「测试连接」可拉取真实列表。": " 示例模型可能已更新，点「测试连接」可拉取真实列表。",
  "${a.app} —— 已自动开始录音（可在设置里关闭）": "${a.app} —— 已自动开始录音（可在设置里关闭）",
  "${jobQueue.size(readQueue())} 个会议等待转写，开始处理…": "${jobQueue.size(readQueue())} 个会议等待转写，开始处理…",
  "${path.basename(dir)} —— 插电后自动转写": "${path.basename(dir)} —— 插电后自动转写",
  "${path.basename(dir)} —— 点此打开会议文件夹": "${path.basename(dir)} —— 点此打开会议文件夹",
  "${r.kind} 轨道录音已到达文件大小上限，正在自动停止并完成转写…": "${r.kind} 轨道录音已到达文件大小上限，正在自动停止并完成转写…",
  "${…} · ${…}": "${…} · ${…}",
  "${…} — 约 ${…} MB/小时": "${…} — 约 ${…} MB/小时",
  "${…} 下载完成（${…}）": "${…} 下载完成（${…}）",
  "${…} 个 WAV · ${…} → 预计 ${…}": "${…} 个 WAV · ${…} → 预计 ${…}",
  "${…} 个会议 · ${…}": "${…} 个会议 · ${…}",
  "${…} 分钟": "${…} 分钟",
  "${…} 段 · ${…}": "${…} 段 · ${…}",
  "(点说话人标签改名)": "(点说话人标签改名)",
  "(这个会议没有 notes.md)": "(这个会议没有 notes.md)",
  "15 分钟": "15 分钟",
  "16 / 24 kbps 会整句丢失并改错人名": "16 / 24 kbps 会整句丢失并改错人名",
  "16 kHz 单声道": "16 kHz 单声道",
  "30 分钟": "30 分钟",
  "4 分钟": "4 分钟",
  "5 分钟": "5 分钟",
  "90 分钟": "90 分钟",
  "<div class=\"dirrow\"><span>${…}</span><button class=\"ghost pick\" data-m=\"${…}\">用这个</button></div>": "<div class=\"dirrow\"><span>${…}</span><button class=\"ghost pick\" data-m=\"${…}\">用这个</button></div>",
  "<div class=\"dirrow\"><span>${…}</span><span>${…} 个 · ${…} → ${…}</span></div>": "<div class=\"dirrow\"><span>${…}</span><span>${…} 个 · ${…} → ${…}</span></div>",
  "<div class=\"dirrow\"><span>${…}</span><span>${…} 个 · 回收 ${…}${…}</span></div>": "<div class=\"dirrow\"><span>${…}</span><span>${…} 个 · 回收 ${…}${…}</span></div>",
  "<div class=\"dirrow\"><span>${…}</span><span>${…}${…}${…}</span></div>": "<div class=\"dirrow\"><span>${…}</span><span>${…}${…}${…}</span></div>",
  "<div class=\"hint\">读取中…</div>": "<div class=\"hint\">读取中…</div>",
  "<div class=\"hint\">读取失败：${…}</div>": "<div class=\"hint\">读取失败：${…}</div>",
  "<div class=\"hint\">还没有可打开的会议（录音或导入一次就会出现）。</div>": "<div class=\"hint\">还没有可打开的会议（录音或导入一次就会出现）。</div>",
  "<div class=\"hint\">还没有识别发言人——点「识别发言人」按声音把他们分开（本地运行，首次会下载 27 MB 声纹模型）。</div>": "<div class=\"hint\">还没有识别发言人——点「识别发言人」按声音把他们分开（本地运行，首次会下载 27 MB 声纹模型）。</div>",
  "<option value=\"\">（自动选择：优先文本模型，跳过视觉模型）</option>": "<option value=\"\">（自动选择：优先文本模型，跳过视觉模型）</option>",
  "<option value=\"\">（读取失败：${…}）</option>": "<option value=\"\">（读取失败：${…}）</option>",
  "API Key（OpenAI 兼容时需要）": "API Key（OpenAI 兼容时需要）",
  "Anthropic Claude（兼容层）": "Anthropic Claude（兼容层）",
  "Audio2Notes 即将自动退出": "Audio2Notes 即将自动退出",
  "CPU（${cores} 线程可用）": "CPU（${cores} 线程可用）",
  "DeepSeek（深度求索）": "DeepSeek（深度求索）",
  "DirectML 不可用：当前 onnxruntime-node 只有 CPU 执行提供器，GPU/NPU 加速尚未接入": "DirectML 不可用：当前 onnxruntime-node 只有 CPU 执行提供器，GPU/NPU 加速尚未接入",
  "DirectML 可用": "DirectML 可用",
  "DirectML 可用，插电模式用独显": "DirectML 可用，插电模式用独显",
  "DirectML 可用，电池模式优先用核显": "DirectML 可用，电池模式优先用核显",
  "ECONNREFUSED（本机未安装/未启动）": "ECONNREFUSED（本机未安装/未启动）",
  "Google Gemini（OpenAI 兼容，路径待核实）": "Google Gemini（OpenAI 兼容，路径待核实）",
  "Groq（极快推理）": "Groq（极快推理）",
  "HTTP 200（本机已在运行）": "HTTP 200（本机已在运行）",
  "HTTP 404（探测路径不对，需实测）": "HTTP 404（探测路径不对，需实测）",
  "LM Studio（本地，OpenAI 兼容）": "LM Studio（本地，OpenAI 兼容）",
  "Loading Whisper model…": "Loading Whisper model…",
  "MP3 96 kbps 单声道（兼容老软件）": "MP3 96 kbps 单声道（兼容老软件）",
  "Mixing audio…": "Mixing audio…",
  "Ollama（本地）": "Ollama（本地）",
  "Ollama（本地，推荐）": "Ollama（本地，推荐）",
  "Ollama（本地，无需 key）": "Ollama（本地，无需 key）",
  "OpenAI 兼容接口": "OpenAI 兼容接口",
  "OpenRouter（聚合多家）": "OpenRouter（聚合多家）",
  "Opus 16 kbps 单声道（最小；实测会丢句）": "Opus 16 kbps 单声道（最小；实测会丢句）",
  "Opus 24 kbps 单声道（省空间；实测会丢句、改人名）": "Opus 24 kbps 单声道（省空间；实测会丢句、改人名）",
  "Opus 32 kbps ≈ 14.4 MB/小时": "Opus 32 kbps ≈ 14.4 MB/小时",
  "Opus 32 kbps 单声道（推荐）": "Opus 32 kbps 单声道（推荐）",
  "Opus 48 kbps 单声道": "Opus 48 kbps 单声道",
  "Transcribing with local Whisper…": "Transcribing with local Whisper…",
  "Writing notes…": "Writing notes…",
  "base.en（推荐，仅英文）": "base.en（推荐，仅英文）",
  "base（推荐，多语言）": "base（推荐，多语言）",
  "sherpa-onnx 不可用：": "sherpa-onnx 不可用：",
  "small.en（更准，更慢）": "small.en（更准，更慢）",
  "small（更准，更慢，多语言）": "small（更准，更慢，多语言）",
  "tiny.en（最快，仅英文）": "tiny.en（最快，仅英文）",
  "tiny（最快，多语言）": "tiny（最快，多语言）",
  "——采样率与声道数正合 Whisper 输入，这部分不损失任何东西；": "——采样率与声道数正合 Whisper 输入，这部分不损失任何东西；",
  "⏸ 已排队（续航优先模式）${…} —— 插电后自动转写，也可以点「立即处理」。": "⏸ 已排队（续航优先模式）${…} —— 插电后自动转写，也可以点「立即处理」。",
  "● 检测到 ${…} 在播放声音，已自动开始录音…": "● 检测到 ${…} 在播放声音，已自动开始录音…",
  "⚠️ ${…} 轨没有录到声音（峰值 ${…} dBFS，有效样本 ${…}%）——检查默认输入设备或静音开关": "⚠️ ${…} 轨没有录到声音（峰值 ${…} dBFS，有效样本 ${…}%）——检查默认输入设备或静音开关",
  "⚠️ Whisper 自身的线程数暂无法限制（transformers.js v2 不暴露该选项），所以省电主要来自模型降档与「不转写」": "⚠️ Whisper 自身的线程数暂无法限制（transformers.js v2 不暴露该选项），所以省电主要来自模型降档与「不转写」",
  "⚠️ 勾选后压缩不省空间：一条 155 分钟、16 kHz 单声道的录音约": "⚠️ 勾选后压缩不省空间：一条 155 分钟、16 kHz 单声道的录音约",
  "⚠️ 摘要降级为规则提取（原因：${…}）—— 笔记顶部已标注，点「重新生成」可重试": "⚠️ 摘要降级为规则提取（原因：${…}）—— 笔记顶部已标注，点「重新生成」可重试",
  "⚠️ 笔记降级": "⚠️ 笔记降级",
  "⚠️ 麦克风一直没有声音——检查默认输入设备或耳机上的静音开关": "⚠️ 麦克风一直没有声音——检查默认输入设备或耳机上的静音开关",
  "✓ 已保存为笔记接口": "✓ 已保存为笔记接口",
  "✗ 连接失败：${…}${…}": "✗ 连接失败：${…}${…}",
  "　（本机探测：${…}）": "　（本机探测：${…}）",
  "。": "。",
  "。只在需要留原始 WAV 时勾选。": "。只在需要留原始 WAV 时勾选。",
  "一个 key 访问多家模型；模型名形如 厂商/模型。": "一个 key 访问多家模型；模型名形如 厂商/模型。",
  "下载": "下载",
  "下载中 ${…}%${…}": "下载中 ${…}%${…}",
  "下载中…": "下载中…",
  "下载声纹模型 ${p.percent}%…": "下载声纹模型 ${p.percent}%…",
  "下载声纹模型（约 27 MB）": "下载声纹模型（约 27 MB）",
  "下载失败 HTTP ${res.statusCode}": "下载失败 HTTP ${res.statusCode}",
  "下载失败：": "下载失败：",
  "下载源与缓存": "下载源与缓存",
  "不需要更改参会人": "不需要更改参会人",
  "中文": "中文",
  "中断处理并退出": "中断处理并退出",
  "为「${…}」设置名字：": "为「${…}」设置名字：",
  "从不自动退出": "从不自动退出",
  "从参会人名单里选一个名字": "从参会人名单里选一个名字",
  "以后停止时不要再问我": "以后停止时不要再问我",
  "任何 /chat/completions 兼容的接口（vLLM、one-api、自建中转等）。": "任何 /chat/completions 兼容的接口（vLLM、one-api、自建中转等）。",
  "会写明": "会写明",
  "会议似乎结束了": "会议似乎结束了",
  "会议目录不存在": "会议目录不存在",
  "会议软件停止播放声音后，自动停止录音并出笔记": "会议软件停止播放声音后，自动停止录音并出笔记",
  "会议软件已停止播放声音，正在停止录音并生成笔记": "会议软件已停止播放声音，正在停止录音并生成笔记",
  "会议软件已停止播放声音，自动停止并处理…": "会议软件已停止播放声音，自动停止并处理…",
  "会议软件已停止播放声音，自动停止录音…": "会议软件已停止播放声音，自动停止录音…",
  "会议软件开始播放声音时，自动开始录音（涉及隐私，默认关闭）": "会议软件开始播放声音时，自动开始录音（涉及隐私，默认关闭）",
  "会议软件检测不可用：": "会议软件检测不可用：",
  "会议软件检测（WASAPI 音频会话）": "会议软件检测（WASAPI 音频会话）",
  "但编码是有损的，实测（120 秒真实语音 + base 模型）": "但编码是有损的，实测（120 秒真实语音 + base 模型）",
  "你": "你",
  "使用": "使用",
  "使用中": "使用中",
  "保存": "保存",
  "保存中…": "保存中…",
  "保存为笔记接口": "保存为笔记接口",
  "保存失败：": "保存失败：",
  "保留原始 WAV（压缩但不再省空间）": "保留原始 WAV（压缩但不再省空间）",
  "关闭": "关闭",
  "关闭会中断当前的转写/摘要。已保存的音频不会丢失，可以之后重新处理。": "关闭会中断当前的转写/摘要。已保存的音频不会丢失，可以之后重新处理。",
  "写入失败：": "写入失败：",
  "准备下载…": "准备下载…",
  "删除": "删除",
  "删除 ${…}？下次使用会需要重新下载。": "删除 ${…}？下次使用会需要重新下载。",
  "删除中…": "删除中…",
  "删除前会做四重校验（编码成功 + 体积正常 + 二次解码通过 + 时长一致），任何一步失败都保留原文件。": "删除前会做四重校验（编码成功 + 体积正常 + 二次解码通过 + 时长一致），任何一步失败都保留原文件。",
  "删除失败：": "删除失败：",
  "删除已下载的声纹模型？程序内置的那份仍然可用，识别发言人不会中断。": "删除已下载的声纹模型？程序内置的那份仍然可用，识别发言人不会中断。",
  "刷新": "刷新",
  "剩余 ${a.freeGB.toFixed(1)} GB，已自动停止录音以免写满磁盘。": "剩余 ${a.freeGB.toFixed(1)} GB，已自动停止录音以免写满磁盘。",
  "历史会议": "历史会议",
  "压缩 ${p.dirName}/${p.file}（${p.index}/${p.total}）…": "压缩 ${p.dirName}/${p.file}（${p.index}/${p.total}）…",
  "压缩 ${p.file}（${p.index}/${p.total}）…": "压缩 ${p.file}（${p.index}/${p.total}）…",
  "压缩中…": "压缩中…",
  "压缩已有会议音频": "压缩已有会议音频",
  "压缩档位": "压缩档位",
  "压缩音频（${preset.label}）…": "压缩音频（${preset.label}）…",
  "原文": "原文",
  "参会人": "参会人",
  "参会人名字…": "参会人名字…",
  "双语": "双语",
  "发言人": "发言人",
  "取消": "取消",
  "只有视觉模型可用": "只有视觉模型可用",
  "合并到…": "合并到…",
  "合并失败：": "合并失败：",
  "合并要点 ${round}/${i + 1}…": "合并要点 ${round}/${i + 1}…",
  "同等语音质量下 Opus 比 MP3 小约 3 倍；只有需要把录音丢给老软件时才建议选 MP3。": "同等语音质量下 Opus 比 MP3 小约 3 倍；只有需要把录音丢给老软件时才建议选 MP3。",
  "名单没有保存：这次询问已经超时。稍后停止录音时如果还需要名单，会再问你。": "名单没有保存：这次询问已经超时。稍后停止录音时如果还需要名单，会再问你。",
  "填名字…": "填名字…",
  "声纹分割模型（随程序分发）": "声纹分割模型（随程序分发）",
  "声纹模型下载不完整": "声纹模型下载不完整",
  "声纹模型下载完成（${…}）": "声纹模型下载完成（${…}）",
  "声纹模型尚未下载（自动下载已关闭）": "声纹模型尚未下载（自动下载已关闭）",
  "声纹模型尚未下载（首次识别需要下载约 27 MB）": "声纹模型尚未下载（首次识别需要下载约 27 MB）",
  "声纹模型（3D-Speaker CAM++ 中英）": "声纹模型（3D-Speaker CAM++ 中英）",
  "声音已恢复，仍在监控。": "声音已恢复，仍在监控。",
  "处理中…": "处理中…",
  "处理完立即退出": "处理完立即退出",
  "处理排队会议：${…}…": "处理排队会议：${…}…",
  "失败：": "失败：",
  "完全本地，隐私最好；模型用 ollama pull 安装后会自动出现在列表里。": "完全本地，隐私最好；模型用 ollama pull 安装后会自动出现在列表里。",
  "官方兼容层地址可达；若报错请改用 OpenRouter 走 Claude。": "官方兼容层地址可达；若报错请改用 OpenRouter 走 Claude。",
  "官方兼容层存在，但探测未通过——用之前请点「测试连接」确认。": "官方兼容层存在，但探测未通过——用之前请点「测试连接」确认。",
  "将把会议目录里的 WAV 转成压缩音频，并在校验通过后删除原始 WAV。": "将把会议目录里的 WAV 转成压缩音频，并在校验通过后删除原始 WAV。",
  "已 ${Math.round(a.silentSec / 60)} 分钟没有声音，${lc.autoStop.forceStopAfterMin} 分钟后将自动停止并处理。": "已 ${Math.round(a.silentSec / 60)} 分钟没有声音，${lc.autoStop.forceStopAfterMin} 分钟后将自动停止并处理。",
  "已 ${…} 分钟没有声音。${…} 秒后将自动停止并生成笔记（录音仍在继续）。": "已 ${…} 分钟没有声音。${…} 秒后将自动停止并生成笔记（录音仍在继续）。",
  "已下载 ${…}": "已下载 ${…}",
  "已下载 ${…}${…}": "已下载 ${…}${…}",
  "已保存下载地址：${…}": "已保存下载地址：${…}",
  "已删除 ${…}": "已删除 ${…}",
  "已删除声纹模型": "已删除声纹模型",
  "已删除已下载的声纹模型（继续使用内置那份）": "已删除已下载的声纹模型（继续使用内置那份）",
  "已占用 ${…}": "已占用 ${…}",
  "已取消本次自动停止，直到再次长时间无声。": "已取消本次自动停止，直到再次长时间无声。",
  "已合并。": "已合并。",
  "已安装的模型": "已安装的模型",
  "已完成 ✓ 压缩 ${…} 个文件，回收 ${…}": "已完成 ✓ 压缩 ${…} 个文件，回收 ${…}",
  "已录音 ${a.elapsedMin} 分钟，达到最大录音时长，正在自动停止并完成处理…": "已录音 ${a.elapsedMin} 分钟，达到最大录音时长，正在自动停止并完成处理…",
  "已打开历史会议：": "已打开历史会议：",
  "已打开：": "已打开：",
  "已排队（续航优先模式）": "已排队（续航优先模式）",
  "已排队，插电后自动转写": "已排队，插电后自动转写",
  "已排队，等待电源。": "已排队，等待电源。",
  "已接通电源": "已接通电源",
  "已更新：转写全部生效（笔记里没有出现旧名字）": "已更新：转写全部生效（笔记里没有出现旧名字）",
  "已更新：转写全部生效，笔记里 ${…} 处旧名字也一起改了": "已更新：转写全部生效，笔记里 ${…} 处旧名字也一起改了",
  "已跳过视觉模型": "已跳过视觉模型",
  "已重新生成 ✓": "已重新生成 ✓",
  "已随包 ${…}": "已随包 ${…}",
  "已随程序分发 ${…}（无需下载）": "已随程序分发 ${…}（无需下载）",
  "常用提供方（选中会自动填地址与示例模型）": "常用提供方（选中会自动填地址与示例模型）",
  "开始下载 ${model.replace(\"Xenova/\", \"\")}…": "开始下载 ${model.replace(\"Xenova/\", \"\")}…",
  "开始下载声纹模型…": "开始下载声纹模型…",
  "开始压缩并删除 WAV": "开始压缩并删除 WAV",
  "开始处理排队的会议…": "开始处理排队的会议…",
  "引擎：": "引擎：",
  "当前模式下不自动转写": "当前模式下不自动转写",
  "当前没有会议软件在播放声音（监听 ${…} 个音频会话）": "当前没有会议软件在播放声音（监听 ${…} 个音频会话）",
  "录音似乎已经结束": "录音似乎已经结束",
  "录音只落盘 + 压缩，转写排队等插电（这是唯一能量级上的省电手段）": "录音只落盘 + 压缩，转写排队等插电（这是唯一能量级上的省电手段）",
  "录音后立即转写": "录音后立即转写",
  "录音已到达时长上限": "录音已到达时长上限",
  "录音文件已达大小上限": "录音文件已达大小上限",
  "录音期间以约 1.5 GB/小时写盘，所以磁盘保护是默认开启的。": "录音期间以约 1.5 GB/小时写盘，所以磁盘保护是默认开启的。",
  "性能优先": "性能优先",
  "打开": "打开",
  "打开中…": "打开中…",
  "打开以前录好的会议 —— 笔记、转写和": "打开以前录好的会议 —— 笔记、转写和",
  "打开失败：": "打开失败：",
  "打开文件夹": "打开文件夹",
  "打开缓存目录": "打开缓存目录",
  "扫描中…": "扫描中…",
  "扫描可回收空间": "扫描可回收空间",
  "扫描失败：": "扫描失败：",
  "找不到发言人 ": "找不到发言人 ",
  "找不到可用于声纹分析的音频（system/mixed 都不存在）": "找不到可用于声纹分析的音频（system/mixed 都不存在）",
  "找到 ${names.length} 个已安装模型": "找到 ${names.length} 个已安装模型",
  "把「${…}」的所有片段合并到「${…}」？": "把「${…}」的所有片段合并到「${…}」？",
  "把这一行合并到另一个发言人（修正过度切分）": "把这一行合并到另一个发言人（修正过度切分）",
  "把这个档位设为转写模型": "把这个档位设为转写模型",
  "排队中的会议": "排队中的会议",
  "排队会议已转写完成": "排队会议已转写完成",
  "排队失败：": "排队失败：",
  "排队等插电": "排队等插电",
  "接口可用（未返回模型列表）": "接口可用（未返回模型列表）",
  "接口可用，列出 ${names.length} 个模型": "接口可用，列出 ${names.length} 个模型",
  "接口地址": "接口地址",
  "推荐": "推荐",
  "提供方类型": "提供方类型",
  "提醒后多少分钟强制停止": "提醒后多少分钟强制停止",
  "插电": "插电",
  "插电使用：允许独显、最大模型、立即转写": "插电使用：允许独显、最大模型、立即转写",
  "插电用「性能优先」，电池用下面选的那个": "插电用「性能优先」，电池用下面选的那个",
  "摘要详细程度": "摘要详细程度",
  "摘要详细程度（默认档）": "摘要详细程度（默认档）",
  "播放失败：": "播放失败：",
  "改名失败：": "改名失败：",
  "整理成最终笔记…": "整理成最终笔记…",
  "整理结果…": "整理结果…",
  "无声多少分钟后提醒": "无声多少分钟后提醒",
  "无效的合并": "无效的合并",
  "智谱 GLM": "智谱 GLM",
  "月之暗面 Kimi": "月之暗面 Kimi",
  "有发言人": "有发言人",
  "有排队的会议": "有排队的会议",
  "服务在跑，但一个模型都没装": "服务在跑，但一个模型都没装",
  "未下载（约 ${…} MB）${…}": "未下载（约 ${…} MB）${…}",
  "未下载（约 ${…} MB）——「识别发言人」也需要它": "未下载（约 ${…} MB）——「识别发言人」也需要它",
  "未检测": "未检测",
  "未知的模型类型：": "未知的模型类型：",
  "未知错误": "未知错误",
  "未配置 LLM（当前为内置规则抽取模式）": "未配置 LLM（当前为内置规则抽取模式）",
  "本机跑其他开源模型时用这个；启动 LM Studio 的本地服务器即可。": "本机跑其他开源模型时用这个；启动 LM Studio 的本地服务器即可。",
  "标准": "标准",
  "样本文件不存在": "样本文件不存在",
  "核显（${engines.igpu}）": "核显（${engines.igpu}）",
  "检测会议软件的音频会话（本地实现，不联网、不读窗口内容）": "检测会议软件的音频会话（本地实现，不联网、不读窗口内容）",
  "检测到 ${…} 正在播放声音": "检测到 ${…} 正在播放声音",
  "检测到会议软件在播放声音": "检测到会议软件在播放声音",
  "模型": "模型",
  "模型下载地址（huggingface.co 不通时改成镜像）": "模型下载地址（huggingface.co 不通时改成镜像）",
  "模型名要填你在方舟控制台创建的「推理接入点」ID（形如 ep-xxxxxxxx）。": "模型名要填你在方舟控制台创建的「推理接入点」ID（形如 ep-xxxxxxxx）。",
  "模型存在缓存目录里，拷到另一台机器即可离线使用。": "模型存在缓存目录里，拷到另一台机器即可离线使用。",
  "模型状态读取失败：": "模型状态读取失败：",
  "模型自动降档：${…} → ${…}": "模型自动降档：${…} → ${…}",
  "模型：": "模型：",
  "正在处理": "正在处理",
  "正在录音": "正在录音",
  "正在录音/处理时关闭窗口要先确认（防止误关丢掉整场会议的处理）": "正在录音/处理时关闭窗口要先确认（防止误关丢掉整场会议的处理）",
  "此操作对原始 WAV 不可撤销（转写结果 unaffected）。确定继续？": "此操作对原始 WAV 不可撤销（转写结果 unaffected）。确定继续？",
  "没有找到 WAV 文件（可能已经压缩过了）。": "没有找到 WAV 文件（可能已经压缩过了）。",
  "没有样本": "没有样本",
  "测试中…": "测试中…",
  "测试连接": "测试连接",
  "添加一位": "添加一位",
  "火山方舟（豆包）": "火山方舟（豆包）",
  "点击改名": "点击改名",
  "独显（${engines.dgpu}）": "独显（${engines.dgpu}）",
  "生命周期与后台": "生命周期与后台",
  "生成压缩副本（原文件保持不动）…": "生成压缩副本（原文件保持不动）…",
  "生成笔记…": "生成笔记…",
  "用于「生成笔记」的模型接口；翻译引擎在 Settings 页单独配置。": "用于「生成笔记」的模型接口；翻译引擎在 Settings 页单独配置。",
  "电池": "电池",
  "电池使用：优先省电，但仍立即出笔记": "电池使用：优先省电，但仍立即出笔记",
  "电池使用：只录音，回到插电再转写": "电池使用：只录音，回到插电再转写",
  "电池时：省电优先": "电池时：省电优先",
  "电池时：续航优先（排队）": "电池时：续航优先（排队）",
  "电源模式": "电源模式",
  "电源模式读取失败：": "电源模式读取失败：",
  "监控的进程名（逗号分隔）": "监控的进程名（逗号分隔）",
  "直接关闭会停止录音。已录制的音频仍会保存在会议文件夹里。": "直接关闭会停止录音。已录制的音频仍会保存在会议文件夹里。",
  "省电优先": "省电优先",
  "省电模式：转写模型降档，说话人分离与 ffmpeg 限制线程数": "省电模式：转写模型降档，说话人分离与 ffmpeg 限制线程数",
  "硅基流动 SiliconFlow": "硅基流动 SiliconFlow",
  "磁盘剩余 ${…} GB（低于 ${…} GB），已停止录音以免写满。": "磁盘剩余 ${…} GB（低于 ${…} GB），已停止录音以免写满。",
  "磁盘剩余低于 (GB) 就停止": "磁盘剩余低于 (GB) 就停止",
  "磁盘空间不足": "磁盘空间不足",
  "磁盘空间不足，自动停止并处理…": "磁盘空间不足，自动停止并处理…",
  "移除": "移除",
  "移除这一位": "移除这一位",
  "空闲 ${a.threshold} 分钟后自动退出（可在设置里关闭）。现在仍可继续使用。": "空闲 ${a.threshold} 分钟后自动退出（可在设置里关闭）。现在仍可继续使用。",
  "空闲多久后自动退出": "空闲多久后自动退出",
  "立即处理": "立即处理",
  "笔记完成": "笔记完成",
  "笔记已生成": "笔记已生成",
  "笔记接口（LLM）": "笔记接口（LLM）",
  "笔记生成完成后弹通知（点击打开会议文件夹）": "笔记生成完成后弹通知（点击打开会议文件夹）",
  "笔记（摘要）自动翻译成中文（总开关）": "笔记（摘要）自动翻译成中文（总开关）",
  "等待参会人确认（选择后继续处理）…": "等待参会人确认（选择后继续处理）…",
  "简要": "简要",
  "继续录音": "继续录音",
  "继续录音（已取消自动停止，直到再次长时间无声）。": "继续录音（已取消自动停止，直到再次长时间无声）。",
  "续航优先": "续航优先",
  "编码器缺失：此 ffmpeg 未提供“${codec}”编码器，无法压缩（请检查捆绑的 ffmpeg）": "编码器缺失：此 ffmpeg 未提供“${codec}”编码器，无法压缩（请检查捆绑的 ffmpeg）",
  "缺失（打包异常）": "缺失（打包异常）",
  "缺少会议目录": "缺少会议目录",
  "缺少分割模型": "缺少分割模型",
  "缺少分割模型（assets/models/pyannote-segmentation-3-0.int8.onnx）": "缺少分割模型（assets/models/pyannote-segmentation-3-0.int8.onnx）",
  "缺模型时将直接报错，不再自动下载。": "缺模型时将直接报错，不再自动下载。",
  "缺模型时将自动下载。": "缺模型时将自动下载。",
  "缺模型时自动下载（关闭后缺模型会直接报错并说明）": "缺模型时自动下载（关闭后缺模型会直接报错并说明）",
  "翻译引擎": "翻译引擎",
  "翻译整篇转写稿（很慢：155 分钟的会议约需 90 分钟；只翻摘要约 4 分钟）": "翻译整篇转写稿（很慢：155 分钟的会议约需 90 分钟；只翻摘要约 4 分钟）",
  "翻译（自动转成中文）": "翻译（自动转成中文）",
  "自动": "自动",
  "自动下载": "自动下载",
  "自动停止前会先弹系统通知，并在录音面板显示倒计时，你可以点「继续录音」取消。": "自动停止前会先弹系统通知，并在录音面板显示倒计时，你可以点「继续录音」取消。",
  "自动模式下，电池时采用哪个模式": "自动模式下，电池时采用哪个模式",
  "自动模式：当前${…}，使用「${…}」": "自动模式：当前${…}，使用「${…}」",
  "自动识别发言人失败：": "自动识别发言人失败：",
  "自动识别发言人（本地 CPU，长会议需要几分钟）…": "自动识别发言人（本地 CPU，长会议需要几分钟）…",
  "自定义（手填地址）": "自定义（手填地址）",
  "视觉模型，摘要质量通常更差": "视觉模型，摘要质量通常更差",
  "解码音频…": "解码音频…",
  "识别中…（本地 CPU，长会议需要几分钟）": "识别中…（本地 CPU，长会议需要几分钟）",
  "识别到 ${res.speakers.length} 个发言人": "识别到 ${res.speakers.length} 个发言人",
  "识别到 ${…} 个发言人（按 ${…} 分析）": "识别到 ${…} 个发言人（按 ${…} 分析）",
  "识别发言人": "识别发言人",
  "识别发言人…": "识别发言人…",
  "识别发言人失败：": "识别发言人失败：",
  "识别发言人（首次使用会下载 27 MB 声纹模型）…": "识别发言人（首次使用会下载 27 MB 声纹模型）…",
  "识别说话人…": "识别说话人…",
  "试听 ${…} 秒样本": "试听 ${…} 秒样本",
  "试听失败：": "试听失败：",
  "该会议还没有发言人信息（先点「识别发言人」）": "该会议还没有发言人信息（先点「识别发言人」）",
  "详细": "详细",
  "说话人": "说话人",
  "说话人已更新 — 点「重新生成」刷新笔记里的归属。": "说话人已更新 — 点「重新生成」刷新笔记里的归属。",
  "说话人识别模型": "说话人识别模型",
  "跳过自动识别发言人：": "跳过自动识别发言人：",
  "跳过自动识别发言人：声纹模型尚未下载，请在「模型与接口」页点下载": "跳过自动识别发言人：声纹模型尚未下载，请在「模型与接口」页点下载",
  "跳过转写稿翻译：保留原文以节省时间（155 分钟的会议约需 90 分钟）。如需中文转写稿，请在「设置 → 翻译」勾选「翻译整篇转写稿」后重新处理。": "跳过转写稿翻译：保留原文以节省时间（155 分钟的会议约需 90 分钟）。如需中文转写稿，请在「设置 → 翻译」勾选「翻译整篇转写稿」后重新处理。",
  "跳过长静音 ${audioStats.silenceSkippedSec}s（${audioStats.cutRuns} 段），送入模型 ${audioStats.speechKeptSec}s / 共 ${audioStats.totalSec}s": "跳过长静音 ${audioStats.silenceSkippedSec}s（${audioStats.cutRuns} 段），送入模型 ${audioStats.speechKeptSec}s / 共 ${audioStats.totalSec}s",
  "转写中…": "转写中…",
  "转写完成后自动压缩音频（原始 WAV 在校验通过后才会删除）": "转写完成后自动压缩音频（原始 WAV 在校验通过后才会删除）",
  "转写排队的会议（${profile.model.replace(\"Xenova/whisper-\", \"\")}）…": "转写排队的会议（${profile.model.replace(\"Xenova/whisper-\", \"\")}）…",
  "转写模型（Whisper）": "转写模型（Whisper）",
  "转写稿翻译默认": "转写稿翻译默认",
  "还没有识别发言人——点「识别发言人」按声音把他们分开（本地运行，首次会下载 27 MB 声纹模型）。": "还没有识别发言人——点「识别发言人」按声音把他们分开（本地运行，首次会下载 27 MB 声纹模型）。",
  "这个会议没有可用的音频（system/mixed）": "这个会议没有可用的音频（system/mixed）",
  "这个发言人没有样本": "这个发言人没有样本",
  "这些名字会和这场会议的笔记一起保存（笔记里的「你 / 远端」会变成具体人名）。": "这些名字会和这场会议的笔记一起保存（笔记里的「你 / 远端」会变成具体人名）。",
  "远端": "远端",
  "选参会人…": "选参会人…",
  "逐段提炼 ${i + 1}/${chunks.length}…": "逐段提炼 ${i + 1}/${chunks.length}…",
  "重定向过多": "重定向过多",
  "重新生成": "重新生成",
  "重新生成中…": "重新生成中…",
  "重新编辑这场会议已保存的参会人名单。": "重新编辑这场会议已保存的参会人名单。",
  "长会议会自动分段提炼再合并（map-reduce），不会像以前那样被截断。摘要失败时会**明确标注**为规则提取，不会伪装成摘要。": "长会议会自动分段提炼再合并（map-reduce），不会像以前那样被截断。摘要失败时会**明确标注**为规则提取，不会伪装成摘要。",
  "长时间无人声时自动停止录音（防\"忘了按停止\"）": "长时间无人声时自动停止录音（防\"忘了按停止\"）",
  "长时间无人声，自动停止并处理…": "长时间无人声，自动停止并处理…",
  "阿里云百炼 / 通义千问": "阿里云百炼 / 通义千问",
  "需要中文转写稿时再勾选它；不勾选时会议记录里的": "需要中文转写稿时再勾选它；不勾选时会议记录里的",
  "面板都会加载出来，可以对过去的会议逐个试听 5 秒样本、填上真实姓名。": "面板都会加载出来，可以对过去的会议逐个试听 5 秒样本、填上真实姓名。",
  "音频可试听": "音频可试听",
  "音频归档": "音频归档",
  "音频统一转成 ": "音频统一转成 ",
  "首次使用某个档位会": "首次使用某个档位会",
  "🔋 电池供电": "🔋 电池供电",
  "🔌 插电": "🔌 插电",
  "（加大批量没有用，瓶颈是生成速度）。只翻摘要约 ": "（加大批量没有用，瓶颈是生成速度）。只翻摘要约 ",
  "（可回收 ${…}，按 ${…}）": "（可回收 ${…}，按 ${…}）",
  "（带进度）。也可以在这里提前下载、切换档位，或删掉不再需要的以释放空间。": "（带进度）。也可以在这里提前下载、切换档位，或删掉不再需要的以释放空间。",
  "（无译文）": "（无译文）",
  "（样本偏短，可能不准）": "（样本偏短，可能不准）",
  "（点 ▶ 试听 5 秒样本，输入框填名字，回车保存）": "（点 ▶ 试听 5 秒样本，输入框填名字，回车保存）",
  "（留空 = 自动挑选）": "（留空 = 自动挑选）",
  "（自动选择：优先文本模型，跳过视觉模型）": "（自动选择：优先文本模型，跳过视觉模型）",
  "（采集 WAV 约 691 MB/小时）。": "（采集 WAV 约 691 MB/小时）。",
  "，Opus 32 kbps 压缩副本约": "，Opus 32 kbps 压缩副本约",
  "，因为它实测是整条流水线里最慢的一步：155 分钟的会议有 2663 段、约 13 万字符英文，产出约 9 万 token，受本机 16.5 token/s 的生成速度限制约需 ": "，因为它实测是整条流水线里最慢的一步：155 分钟的会议有 2663 段、约 13 万字符英文，产出约 9 万 token，受本机 16.5 token/s 的生成速度限制约需 ",
  "，并且流水线里会明确提示，不会默默跳过。": "，并且流水线里会明确提示，不会默默跳过。",
  "，故默认 ": "，故默认 ",
  "，音频已压缩回收 ${…}": "，音频已压缩回收 ${…}",
 }
};

  /* Substitute the holes in order: vars is keyed by hole marker and the Nth hole in
   * the key takes the Nth value, so repeated values line up. {name} holes also work. */
  function t(key, vars) {
    if (key === undefined || key === null) return "";
    var table = DICT[current] || {};
    var out = table[key];
    if (typeof out !== "string") out = key;
    if (!vars || typeof out !== "string") return out;
    var i = 0;
    var vals = Object.keys(vars).sort().map(function (k) { return vars[k]; });
    return out.replace(/\{(\w+)\}|\$\{…\d*\}/g, function (m, name) {
      if (name !== undefined) {
        if (Object.prototype.hasOwnProperty.call(vars, name)) {
          var rv = vars[name];
          return rv === undefined || rv === null ? "" : String(rv);
        }
        if (Object.prototype.hasOwnProperty.call(vars, "{" + name + "}")) return String(vars["{" + name + "}"]);
        return m;
      }
      return i < vals.length ? (vals[i] === undefined || vals[i] === null ? "" : String(vals[i++])) : m;
    });
  }

  /* ---- shape matching for INTERPOLATED backend strings ---------------------
   * A backend message is assembled from a template literal before it is sent, so
   * what arrives is "CPU（8 线程可用）" while the dictionary key is
   * "CPU（${cores} 线程可用）" (src/powerMode.js). The values are already inside the
   * string, so an exact lookup cannot hit. resolve() therefore falls back to
   * matching the SHAPE of a key: every ${…} token in the key becomes a capture
   * group, the literal text between tokens is matched verbatim, and the captures
   * are substituted into the English template's own ${…} holes, in order.
   *
   * Guards, cheapest first:
   *   - only the "en" table is searched (DICT.zh is the identity map, so a shape
   *     match there could only ever rebuild the input);
   *   - the caller must contain CJK — the templates are all Chinese, so an ASCII
   *     string can never be one, and this keeps the cost off the ASCII path;
   *   - keys whose literal text is shorter than MIN_SHAPE_LITERAL are skipped: a
   *     1-2 character literal turns "(.+?)" into a match-anything pattern, and the
   *     short keys ("${…} 分钟", "${…} · ${…}") are renderer-built fragments that
   *     go through t() anyway;
   *   - a key is only usable when its hole count matches its English value's, and
   *     its literal prefix/suffix must line up before the regex is ever run.
   * The index holds only keys that contain a token and is built once per table, so
   * the cost is O(placeholder keys) — and never a regex over the whole dictionary.
   * A malformed pattern is dropped at build time; nothing here can throw or return
   * a non-string. */
  var HOLE = /\$\{[^}]*\}/;
  var HOLE_ALL = /\$\{[^}]*\}/g;
  var SHAPE_CJK = /[\u3000-\u303f\uff00-\uffef\u4e00-\u9fff]/;
  var MIN_SHAPE_LITERAL = 3;

  function escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  /* The badge/note keyword the main process supplies as RAW DATA rather than as a key.
   * powerMode.js (src/) builds the auto-mode note as
   *   `自动模式：当前${onBattery ? "电池" : "插电"}，使用「${…}」`
   * so the first hole of "自动模式：当前${…}，使用「${…}」" arrives as the bare word
   * "插电"/"电池" while the badge keys are the longer "🔌 插电"/"🔋 电池供电". Those two
   * words are therefore keys in their own right (below), so the existing capture
   * substitution in shapeResolve() — a captured value that is an exact key is
   * translated — resolves them with no extra mechanism. A src/ change would also work;
   * the parent owns src/, so the i18n layer carries them instead. */

  var shapeCache = null;

  function shapeEntries(table) {
    if (shapeCache && shapeCache.table === table) return shapeCache.entries;
    var entries = [];
    var keys = table && typeof table === "object" ? Object.keys(table) : [];
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      if (!HOLE.test(key)) continue;
      var out = table[key];
      if (typeof out !== "string" || !HOLE.test(out)) continue;
      var parts = key.split(HOLE_ALL);
      if (parts.length !== out.split(HOLE_ALL).length) continue; /* hole parity: a mismatch would strand a ${…} */
      var src = "";
      var literal = "";
      for (var p = 0; p < parts.length; p++) {
        literal += parts[p];
        src += escapeRe(parts[p]);
        if (p < parts.length - 1) src += "(.+?)";
      }
      if (literal.replace(/\s+/g, "").length < MIN_SHAPE_LITERAL) continue;
      var re;
      try { re = new RegExp("^" + src + "$"); } catch (e) { continue; }
      entries.push({ re: re, out: out, prefix: parts[0], suffix: parts[parts.length - 1], weight: literal.length });
    }
    /* Longest literal first, so the most specific key wins. */
    entries.sort(function (a, b) { return b.weight - a.weight; });
    shapeCache = { table: table, entries: entries };
    return entries;
  }

  function shapeResolve(table, s) {
    var entries = shapeEntries(table);
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      if (e.prefix && s.indexOf(e.prefix) !== 0) continue;
      if (e.suffix && s.slice(-e.suffix.length) !== e.suffix) continue;
      var m = e.re.exec(s);
      if (!m) continue;
      var n = 0;
      return e.out.replace(HOLE_ALL, function () {
        n++;
        var v = m[n];
        if (v === undefined) return "";
        /* A captured value is itself a raw backend string, and a few templates
         * interpolate a label that is a KEY in its own right ("压缩音频（Opus 32
         * kbps 单声道（推荐））…", preset.label; "自动模式：当前${…}…" with the bare
         * word "插电"/"电池"). Translate it when it is an exact key with no holes of
         * its own; otherwise it is data (a folder name, a model id, a number) and is
         * pasted in untouched. Shape matching is deliberately NOT applied here, so
         * user data is never pattern-rewritten. */
        var sub = table && Object.prototype.hasOwnProperty.call(table, v) ? table[v] : null;
        if (typeof sub === "string" && !HOLE.test(sub)) return sub;
        return v;
      });
    }
    return null;
  }

  /* ---- prefix pass for LABEL + VALUE backend strings -----------------------
   * src/main.js does not always send a key and a value separately: it sends the two
   * already JOINED, e.g. "识别发言人失败：" + st.reason. The renderer therefore
   * receives "识别发言人失败：boom", which is not a key and has no ${…} hole, so both
   * the exact lookup and the shape match miss and the Chinese label survives into the
   * English UI.
   *
   * The labels that behave this way are exactly the dictionary keys that END with the
   * fullwidth colon "：" and carry no hole of their own — a label, not a sentence ("排队
   * 失败：" is one, "识别发言人失败：" is one, "自动模式：当前${…}…" is not). For an input
   * that STARTS with such a key and is STRICTLY longer than it, the key's English is
   * emitted and the remainder is appended BYTE-FOR-BYTE. Only the label is translated:
   * the remainder is an error message, a file path or a model id, and rewriting any
   * part of it would corrupt data the user needs to read or paste.
   *
   * Guards, cheapest first:
   *   - the pass runs only after the exact lookup AND the shape match have both missed;
   *   - the input must contain CJK (every candidate label is Chinese, so an ASCII
   *     string — including the English this pass produces — can never be one). This is
   *     what keeps the pass from re-matching its own output on the next call;
   *   - candidates are sorted longest-first, so a more specific label always beats a
   *     shorter one ("跳过自动识别发言人：" over "失败："); the sort is total, so the
   *     winner is deterministic;
   *   - the match is anchored at index 0 and must leave at least one character over, so
   *     a bare label is never expanded into a sentence it did not come from.
   * The list is built once per table, exactly like the shape index. */
  var prefixCache = null;

  function prefixEntries(table) {
    if (prefixCache && prefixCache.table === table) return prefixCache.entries;
    var entries = [];
    var keys = table && typeof table === "object" ? Object.keys(table) : [];
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      if (key.charAt(key.length - 1) !== "：") continue;
      if (HOLE.test(key)) continue;
      var out = table[key];
      if (typeof out !== "string" || out.length === 0 || HOLE.test(out)) continue;
      entries.push({ key: key, out: out });
    }
    /* Longest label first; the key itself is the tiebreaker, so the order (and hence
     * the winner) cannot depend on the dictionary's insertion order. */
    entries.sort(function (a, b) {
      return b.key.length - a.key.length || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
    });
    prefixCache = { table: table, entries: entries };
    return entries;
  }

  function prefixResolve(table, s) {
    var entries = prefixEntries(table);
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      if (s.length <= e.key.length) continue;
      if (s.slice(0, e.key.length) !== e.key) continue;
      return e.out + s.slice(e.key.length);
    }
    return null;
  }

  /* A backend-produced string: exact dictionary hit when we have one, otherwise a
   * shape match against the interpolated keys, otherwise a label+value split against
   * the colon-terminated labels, otherwise the text unchanged. */
  function resolve(text) {
    try {
      if (text === undefined || text === null) return "";
      var s = String(text);
      var table = DICT[current];
      if (table && Object.prototype.hasOwnProperty.call(table, s)) return table[s];
      if (current === "en" && SHAPE_CJK.test(s)) {
        var hit = shapeResolve(table, s);
        if (typeof hit === "string") return hit;
        var pref = prefixResolve(table, s);
        if (typeof pref === "string") return pref;
      }
      return s;
    } catch (e) {
      return text === undefined || text === null ? "" : String(text);
    }
  }

  function setLang(id) {
    var n = normLang(id);
    if (n) current = n;
    return current;
  }

  function applyStatic(root) {
    var scope = root || (typeof document !== "undefined" ? document : null);
    if (!scope || typeof scope.querySelectorAll !== "function") return;
    function each(sel, fn) {
      var nodes = scope.querySelectorAll(sel);
      for (var i = 0; i < nodes.length; i++) {
        try { fn(nodes[i]); } catch (e) { /* never throw */ }
      }
    }
    each("[data-i18n]", function (el) {
      var key = el.getAttribute("data-i18n");
      if (key !== null) el.textContent = t(key);
    });
    each("[data-i18n-title]", function (el) {
      var key = el.getAttribute("data-i18n-title");
      if (key !== null) el.setAttribute("title", t(key));
    });
    each("[data-i18n-placeholder]", function (el) {
      var key = el.getAttribute("data-i18n-placeholder");
      if (key !== null) el.setAttribute("placeholder", t(key));
    });
    each("[data-i18n-value]", function (el) {
      var key = el.getAttribute("data-i18n-value");
      if (key !== null) el.textContent = t(key);
    });
  }

  if (typeof window !== "undefined") {
    window.I18N = {
      LANGS: LANGS,
      DEFAULT_LANG: DEFAULT_LANG,
      get lang() { return current; },
      t: t,
      resolve: resolve,
      setLang: setLang,
      applyStatic: applyStatic,
      DICT: DICT,
    };
  }
  if (typeof module !== "undefined" && module.exports) module.exports = { t: t };
})();
