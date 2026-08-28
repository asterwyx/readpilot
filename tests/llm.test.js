// ReadPilot lib/llm.js 单元测试 —— 覆盖请求组装、响应解析、错误处理、多 provider、流式
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { callLLM, formatError, PROVIDER_PRESETS } from "../lib/llm.js";

const baseConfig = {
  provider: "openai",
  endpoint: "https://api.example.com/v1",
  apiKey: "sk-test-123",
  model: "gpt-4o-mini",
  systemPrompt: "",
  streamEnabled: false,
  contextTokenBudget: 4000
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

function sseResponse(chunks) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    }
  });
  return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

beforeEach(() => {
  global.fetch = vi.fn();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("PROVIDER_PRESETS", () => {
  it("包含 openai/ollama/custom 预设且 endpoint/model 正确", () => {
    expect(PROVIDER_PRESETS.openai.endpoint).toBe("https://api.openai.com/v1");
    expect(PROVIDER_PRESETS.openai.model).toBe("gpt-4o-mini");
    expect(PROVIDER_PRESETS.openai.apiKeyRequired).toBe(true);
    expect(PROVIDER_PRESETS.ollama.endpoint).toBe("http://localhost:11434/v1");
    expect(PROVIDER_PRESETS.ollama.model).toBe("llama3");
    expect(PROVIDER_PRESETS.ollama.apiKeyRequired).toBe(false);
    expect(PROVIDER_PRESETS.custom.endpoint).toBe("");
  });
});

describe("请求组装", () => {
  it("POST 到 base URL + /chat/completions，携带 Bearer 头", async () => {
    global.fetch.mockResolvedValue(jsonResponse({ choices: [{ message: { content: "hi" } }] }));
    await callLLM(baseConfig, { selection: "x", pageContext: {} });
    const [url, init] = global.fetch.mock.calls[0];
    expect(url).toBe("https://api.example.com/v1/chat/completions");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer sk-test-123");
    expect(init.headers["Content-Type"]).toBe("application/json");
  });

  it("endpoint 已含 /chat/completions 时不重复拼接", async () => {
    global.fetch.mockResolvedValue(jsonResponse({ choices: [{ message: { content: "hi" } }] }));
    await callLLM({ ...baseConfig, endpoint: "https://api.example.com/v1/chat/completions" }, { selection: "x", pageContext: {} });
    expect(global.fetch.mock.calls[0][0]).toBe("https://api.example.com/v1/chat/completions");
  });

  it("endpoint 尾部斜杠被规范化", async () => {
    global.fetch.mockResolvedValue(jsonResponse({ choices: [{ message: { content: "hi" } }] }));
    await callLLM({ ...baseConfig, endpoint: "https://api.example.com/v1/" }, { selection: "x", pageContext: {} });
    expect(global.fetch.mock.calls[0][0]).toBe("https://api.example.com/v1/chat/completions");
  });

  it("body 含 model/messages/system+user/temperature，非流式时 stream=false", async () => {
    global.fetch.mockResolvedValue(jsonResponse({ choices: [{ message: { content: "ok" } }] }));
    await callLLM(baseConfig, { selection: "量子纠缠", pageContext: { title: "物理课", surroundingText: "前文", pageSummary: "摘要" } });
    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.model).toBe("gpt-4o-mini");
    expect(body.stream).toBe(false);
    expect(body.temperature).toBe(0.7);
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[1].role).toBe("user");
    // user prompt 包含选中文本与上下文字段
    const up = body.messages[1].content;
    expect(up).toContain("量子纠缠");
    expect(up).toContain("标题：物理课");
    expect(up).toContain("周围文本：前文");
    expect(up).toContain("页面摘要：摘要");
  });

  it("自定义 system prompt 覆盖默认 prompt", async () => {
    global.fetch.mockResolvedValue(jsonResponse({ choices: [{ message: { content: "ok" } }] }));
    await callLLM({ ...baseConfig, systemPrompt: "  你是法律顾问。  " }, { selection: "x", pageContext: {} });
    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.messages[0].content).toBe("你是法律顾问。"); // 已 trim
    expect(body.messages[0].content).not.toContain("阅读辅助助手");
  });

  it("systemPrompt 为空使用默认 prompt（含背景知识与语言一致性约束）", async () => {
    global.fetch.mockResolvedValue(jsonResponse({ choices: [{ message: { content: "ok" } }] }));
    await callLLM(baseConfig, { selection: "x", pageContext: {} });
    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.messages[0].content).toContain("阅读辅助助手");
    expect(body.messages[0].content).toContain("背景知识");
    expect(body.messages[0].content).toContain("语言必须与选中文本");
    expect(body.messages[0].content).toContain("不得随模型波动");
  });

  it("上下文全空时不输出上下文段落", async () => {
    global.fetch.mockResolvedValue(jsonResponse({ choices: [{ message: { content: "ok" } }] }));
    await callLLM(baseConfig, { selection: "x", pageContext: { title: "", surroundingText: "", pageSummary: "" } });
    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.messages[1].content).not.toContain("网页上下文");
  });

  it("Ollama 空 apiKey 仍发送 Bearer 空头（记录现状）", async () => {
    global.fetch.mockResolvedValue(jsonResponse({ choices: [{ message: { content: "ok" } }] }));
    await callLLM({ ...baseConfig, provider: "ollama", apiKey: "" }, { selection: "x", pageContext: {} });
    const init = global.fetch.mock.calls[0][1];
    expect(init.headers.Authorization).toBe("Bearer ");
  });
});

describe("响应解析", () => {
  it("解析 choices[0].message.content 与 usage", async () => {
    global.fetch.mockResolvedValue(
      jsonResponse({ choices: [{ message: { content: "解释内容" } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })
    );
    const r = await callLLM(baseConfig, { selection: "x", pageContext: {} });
    expect(r.content).toBe("解释内容");
    expect(r.usage.total_tokens).toBe(15);
  });

  it("usage 缺失返回 null 不报错", async () => {
    global.fetch.mockResolvedValue(jsonResponse({ choices: [{ message: { content: "ok" } }] }));
    const r = await callLLM(baseConfig, { selection: "x", pageContext: {} });
    expect(r.usage).toBeNull();
  });

  it("choices 为空/缺失抛 parse 错误", async () => {
    global.fetch.mockResolvedValue(jsonResponse({}));
    await expect(callLLM(baseConfig, { selection: "x", pageContext: {} })).rejects.toMatchObject({ type: "parse" });
  });

  it("非法 JSON 响应体触发异常", async () => {
    global.fetch.mockResolvedValue(new Response("not json{", { status: 200 }));
    await expect(callLLM(baseConfig, { selection: "x", pageContext: {} })).rejects.toThrow();
  });
});

describe("错误处理", () => {
  it.each([400, 401, 403, 404, 429, 500, 503])("HTTP %i 抛出含 status 的错误", async (status) => {
    global.fetch.mockResolvedValue(jsonResponse({ error: "e" }, status));
    await expect(callLLM(baseConfig, { selection: "x", pageContext: {} })).rejects.toMatchObject({ status });
  });

  it("fetch reject（网络错误）抛 network 类型", async () => {
    global.fetch.mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(callLLM(baseConfig, { selection: "x", pageContext: {} })).rejects.toMatchObject({ type: "network" });
  });

  it("401/403 不重试（仅调用一次）", async () => {
    global.fetch.mockResolvedValue(jsonResponse({}, 401));
    await expect(callLLM(baseConfig, { selection: "x", pageContext: {} })).rejects.toBeTruthy();
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("429 自动重试 1 次成功则返回结果", async () => {
    global.fetch
      .mockResolvedValueOnce(jsonResponse({}, 429))
      .mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: "retry-ok" } }] }));
    const r = await callLLM(baseConfig, { selection: "x", pageContext: {} });
    expect(r.content).toBe("retry-ok");
    expect(global.fetch).toHaveBeenCalledTimes(2);
  }, 10000);

  it("500 重试后仍失败则抛出（共调用 2 次）", async () => {
    global.fetch.mockResolvedValue(jsonResponse({}, 500));
    await expect(callLLM(baseConfig, { selection: "x", pageContext: {} })).rejects.toMatchObject({ status: 500 });
    expect(global.fetch).toHaveBeenCalledTimes(2);
  }, 10000);

  it("400 这类客户端错误不重试", async () => {
    global.fetch.mockResolvedValue(jsonResponse({}, 400));
    await expect(callLLM(baseConfig, { selection: "x", pageContext: {} })).rejects.toBeTruthy();
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});

describe("formatError", () => {
  it("映射各错误类型到用户可读消息", () => {
    expect(formatError({ type: "timeout" })).toContain("超时");
    expect(formatError({ type: "network" })).toContain("网络错误");
    expect(formatError({ type: "parse" })).toContain("无法解析");
    expect(formatError({ status: 401 })).toContain("API Key");
    expect(formatError({ status: 403 })).toContain("API Key");
    expect(formatError({ status: 429 })).toContain("频繁");
    expect(formatError({ status: 502 })).toContain("服务端");
    expect(formatError(null)).toBe("未知错误");
  });

  it("普通 error 返回其 message；不明对象 String 化", () => {
    expect(formatError(new Error("boom"))).toBe("boom");
    expect(formatError("raw")).toBe("raw");
  });
});

describe("流式调用（SSE）", () => {
  it("逐 chunk 回调累积内容并完成", async () => {
    const sse =
      'data: {"choices":[{"delta":{"content":"你"}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":"好"}}]}\n\n' +
      "data: [DONE]\n\n";
    global.fetch.mockResolvedValue(sseResponse([sse]));
    const chunks = [];
    const r = await callLLM({ ...baseConfig, streamEnabled: true }, { selection: "x", pageContext: {} }, { onChunk: (t) => chunks.push(t) });
    // callStream 的 onChunk 收到的是累积全文（非增量 delta）
    expect(chunks).toEqual(["你", "你好"]);
    expect(r.content).toBe("你好");
  });

  it("流式结束时读取 usage（include_usage）", async () => {
    const sse =
      'data: {"choices":[{"delta":{"content":"a"}}]}\n\n' +
      'data: {"choices":[],"usage":{"total_tokens":42}}\n\n' +
      "data: [DONE]\n\n";
    global.fetch.mockResolvedValue(sseResponse([sse]));
    const r = await callLLM({ ...baseConfig, streamEnabled: true }, { selection: "x", pageContext: {} }, { onChunk: () => {} });
    expect(r.usage.total_tokens).toBe(42);
  });

  it("畸形 SSE 行被忽略不崩溃", async () => {
    const sse = 'data: not-json{{\n\ndata: {"choices":[{"delta":{"content":"ok"}}]}\n\n' + "data: [DONE]\n\n";
    global.fetch.mockResolvedValue(sseResponse([sse]));
    const r = await callLLM({ ...baseConfig, streamEnabled: true }, { selection: "x", pageContext: {} }, { onChunk: () => {} });
    expect(r.content).toBe("ok");
  });

  it("流式 HTTP 错误同样带 status 抛出并可重试", async () => {
    global.fetch
      .mockResolvedValueOnce(sseResponse([]).clone ? new Response("rate limited", { status: 429 }) : null)
      .mockResolvedValueOnce(
        sseResponse(['data: {"choices":[{"delta":{"content":"done"}}]}\n\n', "data: [DONE]\n\n"])
      );
    const r = await callLLM({ ...baseConfig, streamEnabled: true }, { selection: "x", pageContext: {} }, { onChunk: () => {} });
    expect(r.content).toBe("done");
    expect(global.fetch).toHaveBeenCalledTimes(2);
  }, 10000);

  it("跨行 TCP 分片的 SSE 数据正确缓冲解析", async () => {
    // 一个 JSON 被切到两次 enqueue 中间
    global.fetch.mockResolvedValue(sseResponse([
      'data: {"choices":[{"delta":{"cont',
      'ent":"分段"}}]}\n\ndata: [DONE]\n\n'
    ]));
    const r = await callLLM({ ...baseConfig, streamEnabled: true }, { selection: "x", pageContext: {} }, { onChunk: () => {} });
    expect(r.content).toBe("分段");
  });
});

describe("超时", () => {
  it("非流式请求挂起 120s 后 abort 抛 timeout 错误", async () => {
    vi.useFakeTimers();
    global.fetch.mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => {
        const e = new Error("aborted");
        e.name = "AbortError";
        reject(e);
      });
    }));
    const p = callLLM(baseConfig, { selection: "x", pageContext: {} });
    const assertion = expect(p).rejects.toMatchObject({ type: "timeout" });
    // 30s 不应触发，120s 后才超时
    await vi.advanceTimersByTimeAsync(30000);
    await expect(Promise.race([p, Promise.resolve("still-pending")])).resolves.toBe("still-pending");
    await vi.advanceTimersByTimeAsync(90001);
    await assertion;
    vi.useRealTimers();
  });

  // 构造响应式对象：body.getReader() 返回的 reader 在 abort 信号触发时以 AbortError reject
  // 模拟真实 fetch 响应体被 abort 取消的行为（本地 ReadableStream 不自动响应 fetch signal）
  function makeStreamResponse(chunks, signal) {
    const encoder = new TextEncoder();
    const encoded = chunks.map((c) => encoder.encode(c));
    let idx = 0;
    const pending = [];
    if (signal) {
      signal.addEventListener("abort", () => {
        const e = new Error("aborted");
        e.name = "AbortError";
        for (const rej of pending) rej(e);
        pending.length = 0;
      }, { once: true });
    }
    const reader = {
      read() {
        if (idx < encoded.length) {
          return Promise.resolve({ done: false, value: encoded[idx++] });
        }
        // 数据耗尽后挂起（模拟流未结束）；若无数据则立即挂起
        return new Promise((_resolve, reject) => pending.push(reject));
      },
      releaseLock() {}
    };
    return { status: 200, ok: true, body: { getReader: () => reader }, text: () => Promise.resolve("") };
  }

  it("流式请求首字节超时：120s 内未收到任何 chunk 则 abort", async () => {
    vi.useFakeTimers();
    global.fetch.mockImplementation((_url, init) =>
      Promise.resolve(makeStreamResponse([], init.signal)));
    const p = callLLM({ ...baseConfig, streamEnabled: true }, { selection: "x", pageContext: {} }, { onChunk: () => {} });
    const assertion = expect(p).rejects.toMatchObject({ type: "timeout" });
    await vi.advanceTimersByTimeAsync(120001);
    await assertion;
    vi.useRealTimers();
  });

  it("流式收到首个 chunk 后清除超时：之后 120s 不再触发整体超时", async () => {
    vi.useFakeTimers();
    // 仅首 chunk，之后流挂起（模拟慢速持续流，但已有首字节）
    global.fetch.mockImplementation((_url, init) =>
      Promise.resolve(makeStreamResponse(['data: {"choices":[{"delta":{"content":"首"}}]}\n\n'], init.signal)));
    const chunks = [];
    const p = callLLM({ ...baseConfig, streamEnabled: true }, { selection: "x", pageContext: {} }, { onChunk: (t) => chunks.push(t) });
    // 让首字节被读取
    await vi.advanceTimersByTimeAsync(0);
    expect(chunks).toEqual(["首"]);
    // 推进超过 120s —— 不应触发 timeout（超时已在首字节时清除）
    await vi.advanceTimersByTimeAsync(130000);
    await expect(Promise.race([p.then(() => "done", () => "rejected"), Promise.resolve("still-pending")])).resolves.toBe("still-pending");
    // 清理：让流以 abort 结束（无 signal 传入，直接拒绝所有 pending）
    vi.useRealTimers();
  });

  it("流式中途用户取消仍生效（AbortController.abort）", async () => {
    vi.useFakeTimers();
    global.fetch.mockImplementation((_url, init) =>
      Promise.resolve(makeStreamResponse(['data: {"choices":[{"delta":{"content":"a"}}]}\n\n'], init.signal)));
    const userSignal = new AbortController();
    const p = callLLM({ ...baseConfig, streamEnabled: true }, { selection: "x", pageContext: {} }, { onChunk: () => {}, signal: userSignal.signal });
    // 读取首字节（超时被清除）
    await vi.advanceTimersByTimeAsync(0);
    // 用户取消 —— signal 联动 ctrl.abort()，reader.read() 以 AbortError reject
    userSignal.abort();
    await expect(p).rejects.toMatchObject({ type: "aborted" });
    vi.useRealTimers();
  });

  it("流式正常完成不触发超时", async () => {
    vi.useFakeTimers();
    const sse =
      'data: {"choices":[{"delta":{"content":"完"}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":"成"}}]}\n\n' +
      "data: [DONE]\n\n";
    global.fetch.mockResolvedValue(sseResponse([sse]));
    const r = await callLLM({ ...baseConfig, streamEnabled: true }, { selection: "x", pageContext: {} }, { onChunk: () => {} });
    expect(r.content).toBe("完成");
    vi.useRealTimers();
  });

  it("config.timeout 可自定义超时时间（非流式）", async () => {
    vi.useFakeTimers();
    global.fetch.mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => {
        const e = new Error("aborted");
        e.name = "AbortError";
        reject(e);
      });
    }));
    const customConfig = { ...baseConfig, timeout: 5000 };
    const p = callLLM(customConfig, { selection: "x", pageContext: {} });
    const assertion = expect(p).rejects.toMatchObject({ type: "timeout" });
    await vi.advanceTimersByTimeAsync(5001);
    await assertion;
    vi.useRealTimers();
  });
});
