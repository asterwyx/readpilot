// ReadPilot background service worker
import { callLLM, formatError, PROVIDER_PRESETS } from "./lib/llm.js";

// 安装时创建右键菜单
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "explainSelection",
    title: "用 ReadPilot 解释",
    contexts: ["selection"]
  });

  // 迁移逻辑：首次升级时检查 storage.sync.apiKey → 迁移至 storage.local
  chrome.storage.sync.get("apiKey", (syncData) => {
    if (syncData.apiKey) {
      chrome.storage.local.get("apiKey", (localData) => {
        // 仅当 local 中尚无 apiKey 时迁移
        if (!localData.apiKey) {
          chrome.storage.local.set({ apiKey: syncData.apiKey }, () => {
            chrome.storage.sync.remove("apiKey");
          });
        } else {
          chrome.storage.sync.remove("apiKey");
        }
      });
    }
  });
});

// 右键菜单点击 → 向当前 tab 的 content script 发消息
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== "explainSelection" || !tab) return;

  chrome.tabs.sendMessage(tab.id, {
    type: "EXPLAIN_SELECTION",
    selection: info.selectionText || ""
  });
});

// 读取完整配置：sync �非敏感项，local 存 apiKey
async function getConfig() {
  const syncConfig = await chrome.storage.sync.get([
    "provider",
    "endpoint",
    "model",
    "systemPrompt",
    "streamEnabled",
    "contextTokenBudget"
  ]);
  const localConfig = await chrome.storage.local.get(["apiKey"]);
  return {
    provider: syncConfig.provider || "openai",
    endpoint: syncConfig.endpoint || "",
    apiKey: localConfig.apiKey || "",
    model: syncConfig.model || "",
    systemPrompt: syncConfig.systemPrompt || "",
    streamEnabled: syncConfig.streamEnabled !== false,
    contextTokenBudget: syncConfig.contextTokenBudget || 4000
  };
}

// 保存解释至历史记录
async function saveToHistory(entry) {
  const data = await chrome.storage.local.get("explanationHistory");
  const history = data.explanationHistory || [];
  history.unshift(entry);
  // 保留最近 50 条
  if (history.length > 50) history.length = 50;
  await chrome.storage.local.set({ explanationHistory: history });
  // 兼容旧版 popup 读 lastExplanation
  await chrome.storage.local.set({ lastExplanation: entry });
}

// 监听 content script 回传的上下文，调用 LLM
// 流式模式下通过 message 通道逐段推送
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type !== "LLM_REQUEST") return;

  // 流式模式：content script 创建 Port 用于实时推送
  if (msg.stream) {
    handleExplainStream(msg.selection, msg.pageContext, sender.tab?.id);
    return false; // 不使用 sendResponse，通过 port 通信
  }

  // 非流式模式
  handleExplain(msg.selection, msg.pageContext)
    .then(sendResponse)
    .catch((err) => sendResponse({ error: formatError(err) }));

  return true; // 异步响应
});

// 非流式处理
async function handleExplain(selection, pageContext) {
  const config = await getConfig();

  // 配置缺失 → 提示打开设置
  if (!config.endpoint || !config.model) {
    return { error: "尚未配置 LLM 提供商，请在设置页填写配置后重试。", needConfig: true };
  }
  // apiKey 校验：Ollama 预设允许空
  const preset = PROVIDER_PRESETS[config.provider];
  const needKey = preset ? preset.apiKeyRequired : true;
  if (needKey && !config.apiKey) {
    return { error: "尚未配置 API Key，请在设置页填写后重试。", needConfig: true };
  }

  try {
    const result = await callLLM(config, { selection, pageContext });

    const entry = {
      selection,
      explanation: result.content,
      pageUrl: pageContext?.url || "",
      pageTitle: pageContext?.title || "",
      timestamp: Date.now(),
      usage: result.usage || null
    };
    await saveToHistory(entry);

    return { explanation: result.content };
  } catch (err) {
    return { error: formatError(err), status: err.status };
  }
}

// 流式处理：通过 chrome.runtime.connect 的 Port 推送
async function handleExplainStream(selection, pageContext, tabId) {
  // content script 在发消息前会建立 Port，这里通过 onConnect 处理
  // 实际流式推送在 onConnect 中实现
}

// 监听 content script 建立 Port 连接（流式模式）
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "readpilot-stream") return;

  let aborted = false;
  const abortController = new AbortController();

  port.onMessage.addListener(async (msg) => {
    if (msg.type === "START_STREAM") {
      const config = await getConfig();

      // 配置检查
      if (!config.endpoint || !config.model) {
        port.postMessage({ error: "尚未配置 LLM 提供商，请在设置页填写配置后重试。", needConfig: true });
        port.disconnect();
        return;
      }
      const preset = PROVIDER_PRESETS[config.provider];
      const needKey = preset ? preset.apiKeyRequired : true;
      if (needKey && !config.apiKey) {
        port.postMessage({ error: "尚未配置 API Key，请在设置页填写后重试。", needConfig: true });
        port.disconnect();
        return;
      }

      try {
        const result = await callLLM(
          config,
          { selection: msg.selection, pageContext: msg.pageContext },
          {
            onChunk: (text) => {
              if (!aborted) port.postMessage({ chunk: text });
            },
            signal: abortController.signal
          }
        );

        if (!aborted) {
          // 保存至历史
          const entry = {
            selection: msg.selection,
            explanation: result.content,
            pageUrl: msg.pageContext?.url || "",
            pageTitle: msg.pageContext?.title || "",
            timestamp: Date.now(),
            usage: result.usage || null
          };
          await saveToHistory(entry);

          port.postMessage({ done: true, explanation: result.content });
        }
      } catch (err) {
        if (!aborted && err.type !== "abort") {
          port.postMessage({ error: formatError(err), status: err.status });
        }
      }
      port.disconnect();
    } else if (msg.type === "CANCEL") {
      aborted = true;
      abortController.abort();
      port.disconnect();
    }
  });

  port.onDisconnect.addListener(() => {
    aborted = true;
    abortController.abort();
  });
});
