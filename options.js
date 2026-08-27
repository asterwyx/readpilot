// ReadPilot 选项页逻辑 —— 配置保存到 chrome.storage.sync

import { callLLM } from "./lib/llm.js";

const els = {
  provider: document.getElementById("provider"),
  endpoint: document.getElementById("endpoint"),
  apiKey: document.getElementById("apiKey"),
  model: document.getElementById("model"),
  systemPrompt: document.getElementById("systemPrompt"),
  saveBtn: document.getElementById("saveBtn"),
  testBtn: document.getElementById("testBtn"),
  status: document.getElementById("status")
};

// 读取已存配置并填充表单
chrome.storage.sync.get(["provider", "endpoint", "apiKey", "model", "systemPrompt"], (config) => {
  els.provider.value = config.provider || "openai";
  els.endpoint.value = config.endpoint || "";
  els.apiKey.value = config.apiKey || "";
  els.model.value = config.model || "";
  els.systemPrompt.value = config.systemPrompt || "";
});

// 收集表单配置
function getConfig() {
  return {
    provider: els.provider.value,
    endpoint: els.endpoint.value.trim(),
    apiKey: els.apiKey.value.trim(),
    model: els.model.value.trim(),
    systemPrompt: els.systemPrompt.value.trim()
  };
}

function showStatus(message, isError) {
  els.status.textContent = message;
  els.status.className = isError ? "err" : "ok";
}

// 保存配置
els.saveBtn.addEventListener("click", () => {
  const config = getConfig();
  chrome.storage.sync.set(config, () => {
    showStatus("配置已保存。", false);
  });
});

// 测试连接：发一次最小请求验证配置
els.testBtn.addEventListener("click", async () => {
  const config = getConfig();
  if (!config.endpoint || !config.apiKey || !config.model) {
    showStatus("请先填写 endpoint、apiKey 和 model。", true);
    return;
  }
  showStatus("正在测试连接…", false);
  try {
    const result = await callLLM(config, {
      selection: "你好",
      pageContext: { title: "测试", surroundingText: "", pageSummary: "" }
    });
    showStatus(`连接成功。模型回复：${result.slice(0, 80)}`, false);
  } catch (err) {
    showStatus(`连接失败：${err.message}`, true);
  }
});
