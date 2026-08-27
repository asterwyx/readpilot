// ReadPilot LLM 调用模块 —— 供 background 和 options 共用
// 兼容 OpenAI Chat Completions 格式；支持流式/超时/重试

// Provider 预设：选中后自动填充 endpoint 和默认 model
export const PROVIDER_PRESETS = {
  openai: {
    label: "OpenAI",
    endpoint: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    apiKeyRequired: true
  },
  ollama: {
    label: "Ollama 本地",
    endpoint: "http://localhost:11434/v1",
    model: "llama3",
    apiKeyRequired: false
  },
  custom: {
    label: "自定义",
    endpoint: "",
    model: "",
    apiKeyRequired: true
  }
};

// 组装 system prompt：强调结合网页上下文解释并补充相关知识
function buildSystemPrompt(customPrompt) {
  if (customPrompt && customPrompt.trim()) {
    return customPrompt.trim();
  }
  return [
    "你是一个阅读辅助助手。用户在网页中选中了一段文本，请结合当前网页上下文对其进行解释。",
    "要求：",
    "1. 不仅要解释选中文本的字面含义，还要补充相关背景知识，帮助读者真正理解其内容。",
    "2. 解释应简洁、准确、有条理，使用与选中文本相同的语言。",
    "3. 若选中文本是专业术语或缩写，请展开说明其所属领域和常见用法。"
  ].join("");
}

// 组装 user prompt：包含选中文本和页面上下文
function buildUserPrompt(selection, pageContext) {
  const ctx = pageContext || {};
  const lines = [`请解释以下选中的文本：`, ``, `"${selection}"`];
  if (ctx.title || ctx.surroundingText || ctx.pageSummary) {
    lines.push(``, `--- 网页上下文 ---`);
    if (ctx.title) lines.push(`标题：${ctx.title}`);
    if (ctx.surroundingText) lines.push(`周围文本：${ctx.surroundingText}`);
    if (ctx.pageSummary) lines.push(`页面摘要：${ctx.pageSummary}`);
  }
  return lines.join("\n");
}

// 构建请求体
function buildRequestBody(config, selection, pageContext) {
  return {
    model: config.model,
    messages: [
      { role: "system", content: buildSystemPrompt(config.systemPrompt) },
      { role: "user", content: buildUserPrompt(selection, pageContext) }
    ],
    temperature: 0.7,
    stream: config.streamEnabled !== false
  };
}

// 构建完整 endpoint URL：用户填的是 base URL，自动拼接 /chat/completions
function buildFullEndpoint(endpoint) {
  const base = endpoint.replace(/\/+$/, "");
  if (base.endsWith("/chat/completions")) return base;
  return `${base}/chat/completions`;
}

// 创建超时 AbortController：30s 超时
function createTimeoutController(signal) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  // 若外部传入 signal（如用户取消），联动 abort
  if (signal) {
    signal.addEventListener("abort", () => ctrl.abort(), { once: true });
  }
  // 清理计时器
  ctrl.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
  return { ctrl, timer };
}

// 解析 SSE 流：逐行读取，提取 data: 行的 JSON content
async function* parseSSEStream(reader) {
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    // 最后一段可能不完整，保留
    buffer = lines.pop() || "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (data === "[DONE]") return;
      try {
        const json = JSON.parse(data);
        const delta = json.choices?.[0]?.delta?.content;
        if (delta) yield delta;
        // 流式最后可能含 usage（stream_options.include_usage）
        if (json.usage) yield { usage: json.usage };
      } catch {
        // 忽略无法解析的行
      }
    }
  }
}

// 非流式调用：一次性请求，返回完整文本
async function callOnce(config, selection, pageContext, signal) {
  const body = buildRequestBody(config, selection, pageContext);
  body.stream = false;

  const { ctrl, timer } = createTimeoutController(signal);
  const url = buildFullEndpoint(config.endpoint);

  let resp;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`
      },
      body: JSON.stringify(body),
      signal: ctrl.signal
    });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === "AbortError") {
      throw { type: signal?.aborted ? "aborted" : "timeout" };
    }
    throw { type: "network", message: "网络错误：无法连接到 LLM 端点" };
  }
  clearTimeout(timer);

  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw { status: resp.status, body: errText };
  }

  const data = await resp.json();
  if (data.choices && data.choices.length > 0) {
    return {
      content: data.choices[0].message.content,
      usage: data.usage || null
    };
  }
  throw { type: "parse", message: "LLM API 返回了无法解析的响应格式" };
}

// 流式调用：SSE 逐 token 返回
// onChunk(text) 回调每收到新内容时调用
async function callStream(config, selection, pageContext, signal, onChunk) {
  const body = buildRequestBody(config, selection, pageContext);
  body.stream = true;
  // 请求 usage 信息（OpenAI 支持）
  body.stream_options = { include_usage: true };

  const { ctrl, timer } = createTimeoutController(signal);
  const url = buildFullEndpoint(config.endpoint);

  let resp;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`
      },
      body: JSON.stringify(body),
      signal: ctrl.signal
    });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === "AbortError") {
      throw { type: signal?.aborted ? "aborted" : "timeout" };
    }
    throw { type: "network", message: "网络错误：无法连接到 LLM 端点" };
  }

  if (!resp.ok) {
    clearTimeout(timer);
    const errText = await resp.text().catch(() => "");
    throw { status: resp.status, body: errText };
  }

  const reader = resp.body.getReader();
  let fullContent = "";
  let usage = null;

  try {
    for await (const chunk of parseSSEStream(reader)) {
      if (typeof chunk === "string") {
        fullContent += chunk;
        onChunk?.(fullContent);
      } else if (chunk.usage) {
        usage = chunk.usage;
      }
    }
  } catch (err) {
    if (err.name === "AbortError") {
      throw { type: signal?.aborted ? "aborted" : "timeout" };
    }
    throw { type: "network", message: "LLM 响应流读取中断" };
  } finally {
    clearTimeout(timer);
  }

  return { content: fullContent, usage };
}

// 带重试的调用：429/5xx 重试 1 次
// 非流式：返回 { content, usage }
// 流式：通过 onChunk 回调实时返回
export async function callLLM(config, { selection, pageContext }, options = {}) {
  const { signal, onChunk } = options;
  const useStream = config.streamEnabled !== false && typeof onChunk === "function";

  async function attempt() {
    if (useStream) {
      return callStream(config, selection, pageContext, signal, onChunk);
    }
    return callOnce(config, selection, pageContext, signal);
  }

  try {
    return await attempt();
  } catch (err) {
    // 用户取消或超时：不重试
    if (err.type === "aborted" || err.type === "timeout") {
      throw err;
    }
    // 判断是否需要重试（429 或 5xx）
    if (err.status === 429 || (err.status >= 500 && err.status < 600)) {
      // 等待 2s 后重试 1 次
      await new Promise((resolve) => setTimeout(resolve, 2000));
      return attempt();
    }
    throw err;
  }
}

// 将原始错误对象转为用户可读的消息
export function formatError(err) {
  if (err.type === "aborted") return "请求已取消";
  if (err.type === "timeout") return "请求超时，请重试";
  if (err.type === "network") return "网络错误：无法连接到 LLM 端点";
  if (err.type === "parse") return "LLM API 返回了无法解析的响应格式";
  if (err.status === 401 || err.status === 403) return "API Key 无效或权限不足";
  if (err.status === 429) return "请求过于频繁，请稍后重试";
  if (err.status >= 500) return "LLM 服务端暂时不可用，请稍后重试";
  if (err.message) return err.message;
  return String(err);
}
