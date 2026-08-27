// ReadPilot 选项页逻辑 —— 配置保存至 chrome.storage
// apiKey 存 storage.local（不跨设备同步），其余存 storage.sync

import { callLLM, formatError, PROVIDER_PRESETS } from "./lib/llm.js";

const els = {
  provider: document.getElementById("provider"),
  endpoint: document.getElementById("endpoint"),
  apiKey: document.getElementById("apiKey"),
  model: document.getElementById("model"),
  systemPrompt: document.getElementById("systemPrompt"),
  streamEnabled: document.getElementById("streamEnabled"),
  contextTokenBudget: document.getElementById("contextTokenBudget"),
  saveBtn: document.getElementById("saveBtn"),
  testBtn: document.getElementById("testBtn"),
  status: document.getElementById("status"),
  endpointErr: document.getElementById("endpointErr"),
  apiKeyErr: document.getElementById("apiKeyErr"),
  modelErr: document.getElementById("modelErr"),
  contextTokenBudgetErr: document.getElementById("contextTokenBudgetErr")
};

// 读取已存配置并填充表单
async function loadConfig() {
  const syncData = await chrome.storage.sync.get([
    "provider", "endpoint", "model", "systemPrompt", "streamEnabled", "contextTokenBudget"
  ]);
  const localData = await chrome.storage.local.get(["apiKey"]);

  els.provider.value = syncData.provider || "openai";
  els.endpoint.value = syncData.endpoint || "";
  els.apiKey.value = localData.apiKey || "";
  els.model.value = syncData.model || "";
  els.systemPrompt.value = syncData.systemPrompt || "";
  els.streamEnabled.checked = syncData.streamEnabled !== false;
  els.contextTokenBudget.value = syncData.contextTokenBudget || 4000;
}

loadConfig();

// 预设切换：自动填充 endpoint 和 model
els.provider.addEventListener("change", () => {
  const preset = PROVIDER_PRESETS[els.provider.value];
  if (!preset) return;
  if (els.provider.value !== "custom") {
    // 自动填充（仅当用户未手动覆写或字段为空时）
    if (!els.endpoint.value || els.endpoint.value !== els.endpoint.dataset.lastPreset) {
      els.endpoint.value = preset.endpoint;
    }
    if (!els.model.value || els.model.value !== els.model.dataset.lastPreset) {
      els.model.value = preset.model;
    }
    els.endpoint.dataset.lastPreset = preset.endpoint;
    els.model.dataset.lastPreset = preset.model;
  } else {
    // Custom：清空预设自动填充值
    if (els.endpoint.dataset.lastPreset && els.endpoint.value === els.endpoint.dataset.lastPreset) {
      els.endpoint.value = "";
    }
    if (els.model.dataset.lastPreset && els.model.value === els.model.dataset.lastPreset) {
      els.model.value = "";
    }
    delete els.endpoint.dataset.lastPreset;
    delete els.model.dataset.lastPreset;
  }
});

// 收集表单配置
function getConfig() {
  return {
    provider: els.provider.value,
    endpoint: els.endpoint.value.trim(),
    apiKey: els.apiKey.value.trim(),
    model: els.model.value.trim(),
    systemPrompt: els.systemPrompt.value.trim(),
    streamEnabled: els.streamEnabled.checked,
    contextTokenBudget: parseInt(els.contextTokenBudget.value, 10) || 4000
  };
}

// 显示字段错误
function showFieldError(field, message) {
  const errEl = els[field + "Err"];
  const inputEl = els[field];
  if (errEl) {
    errEl.textContent = message;
    errEl.classList.add("show");
  }
  if (inputEl) {
    inputEl.classList.add("err");
  }
}

// 清除字段错误
function clearFieldErrors() {
  ["endpointErr", "apiKeyErr", "modelErr", "contextTokenBudgetErr"].forEach((id) => {
    els[id]?.classList.remove("show");
  });
  ["endpoint", "apiKey", "model", "contextTokenBudget"].forEach((id) => {
    els[id]?.classList.remove("err");
  });
}

// 校验配置
function validateConfig(config) {
  clearFieldErrors();
  let valid = true;
  const preset = PROVIDER_PRESETS[config.provider];
  const needKey = preset ? preset.apiKeyRequired : true;

  // endpoint：合法 URL，http/https
  if (!config.endpoint) {
    showFieldError("endpoint", "请填写 endpoint URL。");
    valid = false;
  } else {
    try {
      const url = new URL(config.endpoint);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        showFieldError("endpoint", "endpoint 必须以 http:// 或 https:// 开头。");
        valid = false;
      }
    } catch {
      showFieldError("endpoint", "endpoint 不是合法的 URL。");
      valid = false;
    }
  }

  // apiKey：非空（Ollama 除外）
  if (needKey && !config.apiKey) {
    showFieldError("apiKey", "请填写 API Key。");
    valid = false;
  }

  // model：非空
  if (!config.model) {
    showFieldError("model", "请填写模型名称。");
    valid = false;
  }

  // contextTokenBudget：500–16000
  const budget = config.contextTokenBudget;
  if (isNaN(budget) || budget < 500 || budget > 16000) {
    showFieldError("contextTokenBudget", "token 预算需为 500–16000 的整数。");
    valid = false;
  }

  return valid;
}

function showStatus(message, isError) {
  els.status.textContent = message;
  els.status.className = isError ? "err" : "ok";
}

// 保存配置
els.saveBtn.addEventListener("click", async () => {
  const config = getConfig();
  if (!validateConfig(config)) {
    showStatus("配置校验未通过，请修正标红字段。", true);
    return;
  }

  // 非敏感项存 sync，apiKey 存 local
  await chrome.storage.sync.set({
    provider: config.provider,
    endpoint: config.endpoint,
    model: config.model,
    systemPrompt: config.systemPrompt,
    streamEnabled: config.streamEnabled,
    contextTokenBudget: config.contextTokenBudget
  });
  await chrome.storage.local.set({ apiKey: config.apiKey });

  showStatus("配置已保存。", false);
});

// 测试连接：发一次极简请求验证配置
els.testBtn.addEventListener("click", async () => {
  const config = getConfig();
  if (!validateConfig(config)) {
    showStatus("配置校验未通过，请修正标红字段。", true);
    return;
  }

  showStatus("正在测试连接…", false);
  const start = performance.now();
  try {
    // 测试用非流式模式
    const testConfig = { ...config, streamEnabled: false };
    const result = await callLLM(testConfig, {
      selection: "你好",
      pageContext: { title: "测试", surroundingText: "", pageSummary: "" }
    });
    const latency = Math.round(performance.now() - start);
    showStatus(`✓ 连接成功（${latency}ms）。模型回复：${(result.content || "").slice(0, 80)}`, false);
  } catch (err) {
    showStatus(`连接失败：${formatError(err)}`, true);
  }
});
