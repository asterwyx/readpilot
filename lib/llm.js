// ReadPilot LLM 调用模块 —— 供 background 和 options 共用
// 默认兼容 OpenAI Chat Completions 格式；自定义 provider 可在此扩展

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
  const context = pageContext
    ? `\n\n--- 网页上下文 ---\n标题：${pageContext.title || "(无)"}\n周围文本：${pageContext.surroundingText || "(无)"}\n页面摘要：${pageContext.pageSummary || "(无)"}`
    : "";
  return `请解释以下选中的文本：\n\n"${selection}"${context}`;
}

// 调用 LLM API —— 真实发送 fetch 请求
// config: { endpoint, apiKey, model, systemPrompt }
// 返回: Promise<string> 解释文本
export async function callLLM(config, { selection, pageContext }) {
  const systemPrompt = buildSystemPrompt(config.systemPrompt);
  const userPrompt = buildUserPrompt(selection, pageContext);

  const body = {
    model: config.model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ],
    temperature: 0.7
  };

  const resp = await fetch(config.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${config.apiKey}`
    },
    body: JSON.stringify(body)
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw new Error(`LLM API 请求失败 (HTTP ${resp.status}): ${errText}`);
  }

  const data = await resp.json();

  // 兼容 OpenAI Chat Completions 响应格式
  if (data.choices && data.choices.length > 0) {
    return data.choices[0].message.content;
  }

  // 扩展点：自定义 provider 可在此处理不同响应结构
  throw new Error("LLM API 返回了无法解析的响应格式");
}
