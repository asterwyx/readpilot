// ReadPilot content script —— 提取选中文本与页面上下文，注入浮层显示解释

// 提取页面上下文：标题 + 选中段落周围文本 + 正文摘要
function extractPageContext() {
  const title = document.title || "";

  // 选中段落周围文本
  const selection = window.getSelection();
  let surroundingText = "";
  if (selection && selection.rangeCount > 0) {
    const range = selection.getRangeAt(0);
    const container = range.commonAncestorContainer;
    const parent =
      container.nodeType === Node.ELEMENT_NODE
        ? container
        : container.parentElement;
    if (parent) {
      surroundingText = parent.innerText.split("\n").join(" ").trim().slice(0, 500);
    }
  }

  // 页面正文摘要：取正文前 1000 字，避免全文 dump
  let pageSummary = "";
  const article = document.querySelector("article, main, [role='main']");
  const root = article || document.body;
  if (root) {
    pageSummary = root.innerText.split("\n").join(" ").trim().slice(0, 1000);
  }

  return {
    title,
    surroundingText,
    pageSummary,
    url: location.href
  };
}

// 注入浮层显示解释结果（使用 scoped class 前缀 readpilot-）
let overlay = null;

function showOverlay(content, isError = false) {
  removeOverlay();

  overlay = document.createElement("div");
  overlay.className = "readpilot-overlay";

  const header = document.createElement("div");
  header.className = "readpilot-overlay-header";

  const title = document.createElement("span");
  title.className = "readpilot-overlay-title";
  title.textContent = isError ? "ReadPilot 出错了" : "ReadPilot 解释";

  const closeBtn = document.createElement("button");
  closeBtn.className = "readpilot-overlay-close";
  closeBtn.textContent = "✕";
  closeBtn.addEventListener("click", removeOverlay);

  header.appendChild(title);
  header.appendChild(closeBtn);

  const body = document.createElement("div");
  body.className = "readpilot-overlay-body";
  // 使用 textContent 展示纯文本解释，自动保留换行
  body.textContent = content;

  overlay.appendChild(header);
  overlay.appendChild(body);
  document.body.appendChild(overlay);
}

function removeOverlay() {
  if (overlay && overlay.parentNode) {
    overlay.parentNode.removeChild(overlay);
  }
  overlay = null;
}

// 监听来自 background 的消息
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type !== "EXPLAIN_SELECTION") return;

  const selection = msg.selection || window.getSelection()?.toString() || "";
  if (!selection) {
    showOverlay("没有选中文本，请先选中再使用。", true);
    return;
  }

  const pageContext = extractPageContext();

  // 回传上下文给 background 请求 LLM
  showOverlay("正在生成解释…");

  chrome.runtime.sendMessage(
    { type: "LLM_REQUEST", selection, pageContext },
    (response) => {
      if (chrome.runtime.lastError) {
        showOverlay("通信失败：" + chrome.runtime.lastError.message, true);
        return;
      }
      if (response?.error) {
        showOverlay(response.error, true);
      } else if (response?.explanation) {
        showOverlay(response.explanation);
      } else {
        showOverlay("未收到有效响应。", true);
      }
    }
  );
});
