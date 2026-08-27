// ReadPilot content script —— 提取选中文本与页面上下文，注入浮层显示解释

// ==================== 上下文提取 ====================

// 判断元素是否为块级
function isBlockElement(el) {
  if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
  const display = getComputedStyle(el).display;
  return ["block", "flex", "grid", "table", "list-item"].includes(display);
}

// 取选中范围起始节点的最近块级祖先（避免 commonAncestorContainer 为 body/html）
function getSurroundingElement(range) {
  const container = range.commonAncestorContainer;
  let el;
  if (container.nodeType === Node.ELEMENT_NODE) {
    el = container;
  } else {
    el = container.parentElement;
  }

  // 若祖先过大（body/html），回退取起始节点的最近块级祖先
  if (el && (el === document.body || el === document.documentElement || el.tagName === "HTML")) {
    let startNode = range.startContainer;
    if (startNode.nodeType === Node.TEXT_NODE) startNode = startNode.parentElement;
    while (startNode && startNode !== document.body) {
      if (isBlockElement(startNode)) return startNode;
      startNode = startNode.parentElement;
    }
    return el; // 回退到 commonAncestorContainer
  }

  return el;
}

// 异步提取页面正文摘要：优先 requestIdleCallback，降级 setTimeout
function extractPageSummary() {
  return new Promise((resolve) => {
    const extract = () => {
      let summary = "";
      const article = document.querySelector("article, main, [role='main']");
      const root = article || document.body;
      if (root) {
        // 超大页面降级：若 innerText 过长则用 textContent
        try {
          const text = root.innerText;
          if (text.length > 100000) {
            // 超大页面：跳过 innerText 重排，用 textContent
            summary = (root.textContent || "").split("\n").join(" ").trim().slice(0, 1000);
          } else {
            summary = text.split("\n").join(" ").trim().slice(0, 1000);
          }
        } catch {
          summary = (root.textContent || "").split("\n").join(" ").trim().slice(0, 1000);
        }
      }
      resolve(summary);
    };

    // requestIdleCallback 50ms 超时降级
    const ric = window.requestIdleCallback || null;
    if (ric) {
      ric(extract, { timeout: 50 });
    } else {
      setTimeout(extract, 0);
    }
  });
}

// 去重：移除正文摘要中与周围文本重叠的段落
function deduplicateContext(surroundingText, pageSummary) {
  if (!surroundingText || !pageSummary) return pageSummary;
  // 将周围文本按句子分割，移除正文摘要中完全包含这些句子的段落
  const sentences = surroundingText.split(/[。！？\n.!?]/).filter((s) => s.trim().length > 10);
  let result = pageSummary;
  for (const sentence of sentences) {
    const trimmed = sentence.trim();
    if (trimmed && result.includes(trimmed)) {
      result = result.replace(trimmed, "").replace(/\s{2,}/g, " ").trim();
    }
  }
  return result;
}

// token 粗估：字符数 ÷ 4
function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

// 按 token 预算裁剪上下文
function trimByTokenBudget(ctx, budget) {
  const titleTokens = estimateTokens(ctx.title);
  const surroundingTokens = estimateTokens(ctx.surroundingText);
  const summaryTokens = estimateTokens(ctx.pageSummary);
  const total = titleTokens + surroundingTokens + summaryTokens;

  if (total <= budget) return ctx;

  // 按优先级裁剪：正文摘要 > 周围文本 > 标题
  let result = { ...ctx };
  let remaining = budget - titleTokens;

  // 先裁剪正文摘要
  if (surroundingTokens + Math.min(summaryTokens, remaining) <= remaining) {
    // 周围文本能全保留，裁剪摘要
    const summaryBudget = remaining - surroundingTokens;
    if (summaryBudget > 0) {
      result.pageSummary = result.pageSummary.slice(0, summaryBudget * 4);
    } else {
      result.pageSummary = "";
    }
  } else {
    // 都裁剪
    const half = Math.floor(remaining / 2);
    result.surroundingText = result.surroundingText.slice(0, half * 4);
    result.pageSummary = result.pageSummary.slice(0, (remaining - half) * 4);
  }

  return result;
}

// 提取页面上下文：标题 + 选中段落周围文本 + 正文摘要
async function extractPageContext(selection, range) {
  const title = document.title || "";

  // 选中段落周围文本：选中文本前后各 ≤250 字
  let surroundingText = "";
  if (range) {
    const el = getSurroundingElement(range);
    if (el) {
      const fullText = (el.innerText || "").split("\n").join(" ").trim();
      const selText = selection;
      const selIdx = fullText.indexOf(selText);
      if (selIdx >= 0) {
        // 前后各 250 字
        const beforeStart = Math.max(0, selIdx - 250);
        const afterEnd = Math.min(fullText.length, selIdx + selText.length + 250);
        surroundingText = fullText.slice(beforeStart, afterEnd);
      } else {
        // 找不到选中文本，取前 500 字
        surroundingText = fullText.slice(0, 500);
      }
    }
  }

  // 异步提取正文摘要
  let pageSummary = await extractPageSummary();

  // 去重
  pageSummary = deduplicateContext(surroundingText, pageSummary);

  return {
    title,
    surroundingText,
    pageSummary,
    url: location.href
  };
}

// ==================== Markdown 渲染（精简版） ====================

// 精简 Markdown → HTML 渲染器，支持：代码块、行内代码、列表、加粗、斜体、链接、标题
function renderMarkdown(md) {
  if (!md) return "";
  let html = md;

  // 转义 HTML 特殊字符（防 XSS 第一步）
  html = html.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  // 代码块 ```
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    return `<pre><code class="language-${lang || 'text'}">${code.trim()}</code></pre>`;
  });

  // 行内代码 `code`
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");

  // 标题 ### / ## / #
  html = html.replace(/^### (.+)$/gm, "<h3>$1</h3>");
  html = html.replace(/^## (.+)$/gm, "<h2>$1</h2>");
  html = html.replace(/^# (.+)$/gm, "<h1>$1</h1>");

  // 加粗 **text** 和 __text__
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/__([^_]+)__/g, "<strong>$1</strong>");

  // 斜体 *text* 和 _text_
  html = html.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  html = html.replace(/_([^_]+)_/g, "<em>$1</em>");

  // 链接 [text](url)
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');

  // 无序列表 - item 或 * item
  html = html.replace(/^(?:- |\* )(.+)$/gm, "<li>$1</li>");
  html = html.replace(/(<li>[\s\S]*?<\/li>)/g, (match) => "<ul>" + match + "</ul>");
  // 合并连续 <ul>
  html = html.replace(/<\/ul>\s*<ul>/g, "");

  // 有序列表 1. item
  html = html.replace(/^\d+\.\s(.+)$/gm, "<li>$1</li>");

  // 段落：双换行 → 段落分隔
  html = html.replace(/\n\n/g, "</p><p>");
  // 单换行 → <br>
  html = html.replace(/\n/g, "<br>");

  // 修复：避免 pre/code 内的 <br> 和 <p>
  html = html.replace(/<pre>([\s\S]*?)<\/pre>/g, (_, content) => {
    return "<pre>" + content.replace(/<br>/g, "\n").replace(/<\/?p>/g, "") + "</pre>";
  });

  return `<p>${html}</p>`;
}

// XSS 防护：白名单 sanitize
function sanitizeHTML(html) {
  const allowed = {
    tags: ["P", "BR", "PRE", "CODE", "H1", "H2", "H3", "UL", "OL", "LI", "STRONG", "EM", "A", "B", "I"],
    attrs: { A: ["href", "target", "rel"], CODE: ["class"] }
  };

  const tmp = document.createElement("div");
  tmp.innerHTML = html;

  function walk(node) {
    const children = Array.from(node.childNodes);
    for (const child of children) {
      if (child.nodeType === Node.TEXT_NODE) continue;
      if (child.nodeType === Node.ELEMENT_NODE) {
        const tag = child.tagName;
        if (!allowed.tags.includes(tag)) {
          // 不允许的标签：用其文本内容替代
          const text = document.createTextNode(child.textContent || "");
          child.parentNode.replaceChild(text, child);
          continue;
        }
        // 清理属性
        const allowedAttrs = allowed.attrs[tag] || [];
        Array.from(child.attributes).forEach((attr) => {
          if (!allowedAttrs.includes(attr.name)) {
            child.removeAttribute(attr.name);
          }
          // href 只允许 http/https
          if (attr.name === "href") {
            const val = attr.value.toLowerCase();
            if (!val.startsWith("http://") && !val.startsWith("https://")) {
              child.removeAttribute("href");
            }
          }
        });
        walk(child);
      } else {
        // 注释等非文本/元素节点：移除
        child.remove();
      }
    }
  }

  walk(tmp);
  return tmp.innerHTML;
}

// ==================== 浮层管理 ====================

let overlay = null;
let currentSelection = "";
let currentContext = null;
let currentPort = null;

// 浮层状态
const overlayState = {
  offsetX: 0,
  offsetY: 0,
  width: 420,
  height: 0, // 0 = auto
  dragging: false,
  dragStartX: 0,
  dragStartY: 0
};

function createOverlay() {
  removeOverlay();

  overlay = document.createElement("div");
  overlay.className = "readpilot-overlay";
  overlay.dataset.readpilot = "true";

  // 标题栏（可拖动）
  const header = document.createElement("div");
  header.className = "readpilot-overlay-header";

  const titleEl = document.createElement("span");
  titleEl.className = "readpilot-overlay-title";
  titleEl.textContent = "ReadPilot 解释";

  const actions = document.createElement("div");
  actions.className = "readpilot-overlay-actions";

  const copyBtn = document.createElement("button");
  copyBtn.className = "readpilot-btn readpilot-copy";
  copyBtn.textContent = "复制";
  copyBtn.title = "复制解释内容";
  copyBtn.addEventListener("click", copyContent);

  const closeBtn = document.createElement("button");
  closeBtn.className = "readpilot-btn readpilot-close";
  closeBtn.textContent = "✕";
  closeBtn.title = "关闭";
  closeBtn.addEventListener("click", closeOverlay);

  actions.appendChild(copyBtn);
  actions.appendChild(closeBtn);

  header.appendChild(titleEl);
  header.appendChild(actions);

  // 内容区
  const body = document.createElement("div");
  body.className = "readpilot-overlay-body";

  overlay.appendChild(header);
  overlay.appendChild(body);

  // 缩放手柄
  const resizeHandle = document.createElement("div");
  resizeHandle.className = "readpilot-resize-handle";
  overlay.appendChild(resizeHandle);

  document.body.appendChild(overlay);

  // 拖动
  header.addEventListener("mousedown", startDrag);
  // 缩放
  resizeHandle.addEventListener("mousedown", startResize);
  // Esc 关闭
  document.addEventListener("keydown", onKeyDown);
  // 点击外部关闭
  setTimeout(() => {
    document.addEventListener("mousedown", onOutsideClick);
  }, 100);

  return body;
}

function showLoading() {
  const body = createOverlay();
  overlay.querySelector(".readpilot-overlay-title").textContent = "ReadPilot 解释";
  body.innerHTML = `
    <div class="readpilot-loading">
      <div class="readpilot-spinner"></div>
      <span>正在生成解释…</span>
      <button class="readpilot-cancel-btn">取消</button>
    </div>
  `;
  body.querySelector(".readpilot-cancel-btn").addEventListener("click", cancelRequest);
}

function showStreamingContent() {
  const body = createOverlay();
  body.innerHTML = '<div class="readpilot-stream-content"></div><div class="readpilot-stream-status">生成中…</div>';
  return body;
}

function showResult(content) {
  if (!overlay) {
    createOverlay();
  }
  const body = overlay.querySelector(".readpilot-overlay-body");
  const html = sanitizeHTML(renderMarkdown(content));
  body.innerHTML = `<div class="readpilot-result">${html}</div>`;
  overlay.querySelector(".readpilot-overlay-title").textContent = "ReadPilot 解释";
}

function showError(message, isConfigError = false) {
  if (!overlay) {
    createOverlay();
  }
  const body = overlay.querySelector(".readpilot-overlay-body");
  overlay.classList.add("readpilot-error");
  overlay.querySelector(".readpilot-overlay-title").textContent = "ReadPilot 出错了";

  let actions = "";
  if (isConfigError) {
    actions = '<button class="readpilot-action-btn" data-action="settings">去设置</button>';
  } else {
    actions = '<button class="readpilot-action-btn" data-action="retry">重试</button>';
  }

  body.innerHTML = `
    <div class="readpilot-error-content">
      <p class="readpilot-error-msg"></p>
      <div class="readpilot-error-actions">${actions}</div>
    </div>
  `;

  // message 来自上游（err.message 等），不可信，用 textContent 写入避免 HTML 注入
  body.querySelector(".readpilot-error-msg").textContent = message;

  const settingsBtn = body.querySelector('[data-action="settings"]');
  const retryBtn = body.querySelector('[data-action="retry"]');
  if (settingsBtn) {
    settingsBtn.addEventListener("click", () => chrome.runtime.openOptionsPage());
  }
  if (retryBtn) {
    retryBtn.addEventListener("click", () => {
      if (currentSelection) {
        requestExplanation(currentSelection, currentContext);
      }
    });
  }
}

function copyContent() {
  const body = overlay?.querySelector(".readpilot-overlay-body");
  if (!body) return;
  const text = body.innerText || "";
  navigator.clipboard.writeText(text).then(() => {
    const btn = overlay.querySelector(".readpilot-copy");
    if (btn) {
      btn.textContent = "已复制";
      setTimeout(() => { btn.textContent = "复制"; }, 1500);
    }
  });
}

function closeOverlay() {
  cancelRequest();
  removeOverlay();
}

function removeOverlay() {
  if (overlay && overlay.parentNode) {
    overlay.parentNode.removeChild(overlay);
  }
  overlay = null;
  document.removeEventListener("keydown", onKeyDown);
  document.removeEventListener("mousedown", onOutsideClick);
}

function onKeyDown(e) {
  if (e.key === "Escape") closeOverlay();
}

function onOutsideClick(e) {
  if (overlay && !overlay.contains(e.target)) {
    closeOverlay();
  }
}

// 拖动
function startDrag(e) {
  if (e.target.classList.contains("readpilot-btn")) return;
  e.preventDefault();
  overlayState.dragging = true;
  overlayState.dragStartX = e.clientX;
  overlayState.dragStartY = e.clientY;
  const rect = overlay.getBoundingClientRect();
  overlayState.offsetX = rect.left;
  overlayState.offsetY = rect.top;
  overlay.style.right = "auto";
  overlay.style.left = rect.left + "px";
  overlay.style.top = rect.top + "px";
  document.addEventListener("mousemove", onDrag);
  document.addEventListener("mouseup", stopDrag);
}

function onDrag(e) {
  if (!overlayState.dragging) return;
  const dx = e.clientX - overlayState.dragStartX;
  const dy = e.clientY - overlayState.dragStartY;
  let newX = overlayState.offsetX + dx;
  let newY = overlayState.offsetY + dy;
  // 不超出视口
  const maxX = window.innerWidth - overlay.offsetWidth;
  const maxY = window.innerHeight - 40;
  newX = Math.max(0, Math.min(newX, maxX));
  newY = Math.max(0, Math.min(newY, maxY));
  overlay.style.left = newX + "px";
  overlay.style.top = newY + "px";
}

function stopDrag() {
  overlayState.dragging = false;
  document.removeEventListener("mousemove", onDrag);
  document.removeEventListener("mouseup", stopDrag);
}

// 缩放
function startResize(e) {
  e.preventDefault();
  e.stopPropagation();
  const startX = e.clientX;
  const startY = e.clientY;
  const startW = overlay.offsetWidth;
  const startH = overlay.offsetHeight;

  function onMove(ev) {
    let w = startW + (ev.clientX - startX);
    let h = startH + (ev.clientY - startY);
    w = Math.max(300, Math.min(800, w));
    h = Math.max(200, Math.min(600, h));
    overlay.style.width = w + "px";
    overlay.style.maxHeight = h + "px";
  }

  function onUp() {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
  }

  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
}

// ==================== 请求 LLM ====================

function cancelRequest() {
  if (currentPort) {
    currentPort.postMessage({ type: "CANCEL" });
    currentPort.disconnect();
    currentPort = null;
  }
}

async function requestExplanation(selection, pageContext) {
  currentSelection = selection;
  currentContext = pageContext;

  // 离线检测
  if (!navigator.onLine) {
    showLoading(); // 先显示浮层
    showError("无网络连接，请检查网络后重试。");
    return;
  }

  showLoading();

  // 使用 Port 建立流式连接
  currentPort = chrome.runtime.connect({ name: "readpilot-stream" });

  let bodyEl = null;
  let streamContentEl = null;
  let statusEl = null;
  let hasStreamed = false;

  currentPort.onMessage.addListener((msg) => {
    if (msg.chunk) {
      if (!hasStreamed) {
        // 首次收到 chunk，切换为流式展示
        hasStreamed = true;
        bodyEl = showStreamingContent();
        streamContentEl = bodyEl.querySelector(".readpilot-stream-content");
        statusEl = bodyEl.querySelector(".readpilot-stream-status");
      }
      if (streamContentEl) {
        // 使用 RAF 批量更新，避免逐 token reflow
        if (!streamContentEl._rafPending) {
          streamContentEl._rafPending = true;
          streamContentEl._pendingText = msg.chunk;
          requestAnimationFrame(() => {
            streamContentEl.innerHTML = sanitizeHTML(renderMarkdown(streamContentEl._pendingText));
            streamContentEl._rafPending = false;
            // 滚动到底部
            bodyEl.scrollTop = bodyEl.scrollHeight;
          });
        } else {
          streamContentEl._pendingText = msg.chunk;
        }
      }
    }
    if (msg.done) {
      if (hasStreamed && statusEl) {
        statusEl.textContent = "已完成";
        statusEl.classList.add("readpilot-done");
      }
      if (msg.explanation) {
        showResult(msg.explanation);
      }
      currentPort = null;
    }
    if (msg.error) {
      const isConfig = msg.needConfig === true;
      // 如果已开始流式展示，在 body 内展示错误
      if (hasStreamed && bodyEl) {
        showError(msg.error, isConfig);
      } else {
        showError(msg.error, isConfig);
      }
      currentPort = null;
    }
  });

  currentPort.onDisconnect.addListener(() => {
    currentPort = null;
  });

  currentPort.postMessage({
    type: "START_STREAM",
    selection,
    pageContext
  });
}

// ==================== 消息监听 ====================

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type !== "EXPLAIN_SELECTION") return;

  // 统一选区传递路径：直接使用 background 传来的 info.selectionText，不再回退 window.getSelection()
  const selection = msg.selection || "";
  if (!selection) {
    showLoading();
    showError("没有选中文本，请先选中再使用。");
    return;
  }

  // 提取上下文：尝试获取当前 Selection 的 range（可能已失效）
  let range = null;
  try {
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0) {
      range = sel.getRangeAt(0);
    }
  } catch {
    // DOM 已失效，range 置空
    range = null;
  }

  // 异步提取上下文后请求 LLM
  extractPageContext(selection, range).then((pageContext) => {
    // 按 token 预算裁剪（从 storage.sync 读取 budget，默认 4000）
    chrome.storage.sync.get("contextTokenBudget", (data) => {
      const budget = data.contextTokenBudget || 4000;
      const trimmed = trimByTokenBudget(pageContext, budget);
      requestExplanation(selection, trimmed);
    });
  });
});
