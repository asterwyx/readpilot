// ReadPilot popup —— 显示历史记录列表，支持展开/清空

const historyList = document.getElementById("historyList");
const settingsLink = document.getElementById("settingsLink");
const clearBtn = document.getElementById("clearBtn");

// 格式化时间
function formatTime(timestamp) {
  const date = new Date(timestamp);
  const now = new Date();
  const diff = now - date;
  if (diff < 60000) return "刚刚";
  if (diff < 3600000) return Math.floor(diff / 60000) + " 分钟前";
  if (diff < 86400000) return Math.floor(diff / 3600000) + " 小时前";
  return date.toLocaleDateString("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

// 渲染历史列表
function renderHistory(history) {
  if (!history || history.length === 0) {
    historyList.innerHTML = '<span class="empty">暂无历史记录</span>';
    return;
  }

  historyList.innerHTML = "";
  history.forEach((entry, index) => {
    const item = document.createElement("div");
    item.className = "history-item";

    const header = document.createElement("div");
    header.className = "history-item-header";

    const selection = document.createElement("div");
    selection.className = "history-selection";
    // 截断 50 字
    const selText = entry.selection || "";
    selection.textContent = selText.length > 50 ? selText.slice(0, 50) + "…" : selText;
    selection.title = entry.selection || "";

    const time = document.createElement("span");
    time.className = "history-time";
    time.textContent = formatTime(entry.timestamp);

    header.appendChild(selection);
    header.appendChild(time);

    // 展开后的解释内容
    const explanation = document.createElement("div");
    explanation.className = "history-explanation";
    explanation.textContent = entry.explanation || "(无解释内容)";

    // 元数据
    const meta = document.createElement("div");
    meta.className = "history-meta";
    const metaParts = [];
    if (entry.pageTitle) metaParts.push(entry.pageTitle);
    if (entry.pageUrl) {
      try {
        metaParts.push(new URL(entry.pageUrl).hostname);
      } catch {
        // 忽略无效 URL
      }
    }
    if (entry.usage && entry.usage.total_tokens) {
      metaParts.push(`${entry.usage.total_tokens} tokens`);
    }
    meta.textContent = metaParts.join(" · ");

    item.appendChild(header);
    item.appendChild(explanation);
    item.appendChild(meta);

    // 点击展开/收起
    item.addEventListener("click", () => {
      item.classList.toggle("expanded");
    });

    historyList.appendChild(item);
  });
}

// 从 chrome.storage.local 读取历史记录
chrome.storage.local.get("explanationHistory", (data) => {
  renderHistory(data.explanationHistory || []);
});

// 清空历史
clearBtn.addEventListener("click", () => {
  if (confirm("确定清空所有历史记录？")) {
    chrome.storage.local.remove("explanationHistory", () => {
      chrome.storage.local.remove("lastExplanation", () => {
        renderHistory([]);
      });
    });
  }
});

// 打开设置页
settingsLink.addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});
