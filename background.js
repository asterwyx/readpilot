// ReadPilot background service worker
import { callLLM } from "./lib/llm.js";

// 安装时创建右键菜单
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "explainSelection",
    title: "用 ReadPilot 解释",
    contexts: ["selection"]
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

// 监听 content script 回传的上下文，调用 LLM
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type !== "LLM_REQUEST") return;

  handleExplain(msg.selection, msg.pageContext, sender.tab?.id)
    .then(sendResponse)
    .catch((err) => sendResponse({ error: err.message }));

  // 返回 true 表示异步响应
  return true;
});

async function handleExplain(selection, pageContext, tabId) {
  // 读取 provider 配置
  const config = await chrome.storage.sync.get([
    "provider",
    "endpoint",
    "apiKey",
    "model",
    "systemPrompt"
  ]);

  // 配置缺失 → 打开 options 页提示配置
  if (!config.endpoint || !config.apiKey || !config.model) {
    chrome.runtime.openOptionsPage();
    return { error: "尚未配置 LLM 提供商，已打开设置页，请填写配置后重试。" };
  }

  try {
    const result = await callLLM(
      {
        endpoint: config.endpoint,
        apiKey: config.apiKey,
        model: config.model,
        systemPrompt: config.systemPrompt
      },
      { selection, pageContext }
    );

    // 存入最近一次解释
    const entry = {
      selection,
      explanation: result,
      pageUrl: pageContext?.url || "",
      pageTitle: pageContext?.title || "",
      timestamp: Date.now()
    };
    await chrome.storage.local.set({ lastExplanation: entry });

    return { explanation: result };
  } catch (err) {
    return { error: err.message };
  }
}
