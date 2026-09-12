"use strict";
/* Preset list of mainstream LLM endpoints (all OpenAI-compatible unless noted).
 *
 * Every baseUrl below was probed from this machine on 2026-09-12 — the result
 * column records what the probe returned, so nothing here is a guess:
 *   401/403 = the address is right and it only wants an API key
 *   200     = reachable without a key (e.g. OpenRouter's public model list)
 *   ECONNREFUSED = a local server that simply is not running
 *
 * Model names go stale fast, so they are listed as SUGGESTIONS only: the
 * "测试连接" button asks the provider for its real model list and lets the user
 * pick from it, which is always current.
 */

const PROVIDERS = [
  {
    id: "ollama",
    label: "Ollama（本地，无需 key）",
    style: "ollama",
    baseUrl: "http://127.0.0.1:11434",
    probe: "HTTP 200（本机已在运行）",
    models: [],
    note: "完全本地，隐私最好；模型用 ollama pull 安装后会自动出现在列表里。",
  },
  {
    id: "lmstudio",
    label: "LM Studio（本地，OpenAI 兼容）",
    style: "openai",
    baseUrl: "http://127.0.0.1:1234/v1",
    probe: "ECONNREFUSED（本机未安装/未启动）",
    models: [],
    note: "本机跑其他开源模型时用这个；启动 LM Studio 的本地服务器即可。",
  },
  {
    id: "openai",
    label: "OpenAI",
    style: "openai",
    baseUrl: "https://api.openai.com/v1",
    probe: "HTTP 401 ✓",
    models: ["gpt-4o-mini", "gpt-4o", "gpt-4.1", "gpt-4.1-mini", "o4-mini"],
  },
  {
    id: "deepseek",
    label: "DeepSeek（深度求索）",
    style: "openai",
    baseUrl: "https://api.deepseek.com/v1",
    probe: "HTTP 401 ✓",
    models: ["deepseek-chat", "deepseek-reasoner"],
  },
  {
    id: "dashscope",
    label: "阿里云百炼 / 通义千问",
    style: "openai",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    probe: "HTTP 401 ✓",
    models: ["qwen-plus", "qwen-max", "qwen-turbo", "qwen-long"],
  },
  {
    id: "moonshot",
    label: "月之暗面 Kimi",
    style: "openai",
    baseUrl: "https://api.moonshot.cn/v1",
    probe: "HTTP 401 ✓",
    models: ["moonshot-v1-8k", "moonshot-v1-32k", "moonshot-v1-128k"],
  },
  {
    id: "zhipu",
    label: "智谱 GLM",
    style: "openai",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    probe: "HTTP 401 ✓",
    models: ["glm-4-plus", "glm-4-air", "glm-4-flash", "glm-4-long"],
  },
  {
    id: "volcengine",
    label: "火山方舟（豆包）",
    style: "openai",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    probe: "HTTP 401 ✓",
    models: [],
    note: "模型名要填你在方舟控制台创建的「推理接入点」ID（形如 ep-xxxxxxxx）。",
  },
  {
    id: "siliconflow",
    label: "硅基流动 SiliconFlow",
    style: "openai",
    baseUrl: "https://api.siliconflow.cn/v1",
    probe: "HTTP 401 ✓",
    models: ["deepseek-ai/DeepSeek-V3", "Qwen/Qwen2.5-72B-Instruct", "THUDM/glm-4-9b-chat"],
  },
  {
    id: "openrouter",
    label: "OpenRouter（聚合多家）",
    style: "openai",
    baseUrl: "https://openrouter.ai/api/v1",
    probe: "HTTP 200 ✓",
    models: ["openai/gpt-4o-mini", "anthropic/claude-3.5-sonnet", "google/gemini-flash-1.5", "deepseek/deepseek-chat"],
    note: "一个 key 访问多家模型；模型名形如 厂商/模型。",
  },
  {
    id: "anthropic",
    label: "Anthropic Claude（兼容层）",
    style: "openai",
    baseUrl: "https://api.anthropic.com/v1",
    probe: "HTTP 401 ✓",
    models: [],
    note: "官方兼容层地址可达；若报错请改用 OpenRouter 走 Claude。",
  },
  {
    id: "groq",
    label: "Groq（极快推理）",
    style: "openai",
    baseUrl: "https://api.groq.com/openai/v1",
    probe: "HTTP 401 ✓",
    models: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"],
  },
  {
    id: "together",
    label: "Together AI",
    style: "openai",
    baseUrl: "https://api.together.xyz/v1",
    probe: "HTTP 401 ✓",
    models: ["meta-llama/Llama-3.3-70B-Instruct-Turbo", "Qwen/Qwen2.5-72B-Instruct-Turbo"],
  },
  {
    id: "mistral",
    label: "Mistral",
    style: "openai",
    baseUrl: "https://api.mistral.ai/v1",
    probe: "HTTP 401 ✓",
    models: ["mistral-large-latest", "mistral-small-latest", "open-mistral-nemo"],
  },
  {
    id: "xai",
    label: "xAI Grok",
    style: "openai",
    baseUrl: "https://api.x.ai/v1",
    probe: "HTTP 401 ✓",
    models: ["grok-2-latest"],
  },
  {
    id: "gemini",
    label: "Google Gemini（OpenAI 兼容，路径待核实）",
    style: "openai",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    probe: "HTTP 404（探测路径不对，需实测）",
    models: ["gemini-2.0-flash", "gemini-1.5-pro"],
    note: "官方兼容层存在，但探测未通过——用之前请点「测试连接」确认。",
  },
  {
    id: "custom",
    label: "自定义（手填地址）",
    style: "openai",
    baseUrl: "",
    probe: "—",
    models: [],
    note: "任何 /chat/completions 兼容的接口（vLLM、one-api、自建中转等）。",
  },
];

function byId(id) {
  return PROVIDERS.find((p) => p.id === id) || PROVIDERS[PROVIDERS.length - 1];
}

/** Guess which preset a saved baseUrl belongs to (for re-opening settings). */
function matchByBaseUrl(baseUrl) {
  const b = String(baseUrl || "").replace(/\/+$/, "").toLowerCase();
  if (!b) return null;
  const hit = PROVIDERS.find((p) => p.baseUrl && p.baseUrl.replace(/\/+$/, "").toLowerCase() === b);
  return hit ? hit.id : "custom";
}

module.exports = { PROVIDERS, byId, matchByBaseUrl };
