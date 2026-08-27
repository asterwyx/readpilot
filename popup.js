// ReadPilot popup —— 显示最近一次解释，底部链接打开设置

const selectionEl = document.getElementById("selectionText");
const explanationEl = document.getElementById("explanationText");
const settingsLink = document.getElementById("settingsLink");

// 从 chrome.storage.local 读取最近一次解释
chrome.storage.local.get("lastExplanation", (data) => {
  const entry = data.lastExplanation;
  if (entry && entry.selection) {
    selectionEl.textContent = entry.selection;
    explanationEl.textContent = entry.explanation || "(无解释内容)";
  } else {
    selectionEl.innerHTML = '<span class="empty">暂无</span>';
    explanationEl.innerHTML = '<span class="empty">暂无</span>';
  }
});

// 打开设置页
settingsLink.addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});
