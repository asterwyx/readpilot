// ReadPilot content.js 单元测试 —— 用 jsdom 提取纯逻辑函数并验证上下文/裁剪/渲染/sanitize 行为
// content.js 无模块导出，采用读取源码 + vm 加载的方式在 jsdom 环境中执行
import { describe, it, expect, beforeAll } from "vitest";
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const src = readFileSync(new URL("../content.js", import.meta.url), "utf8");

const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", { url: "https://example.com/doc" });
global.document = dom.window.document;
global.Node = dom.window.Node;
global.window = dom.window;
global.getComputedStyle = dom.window.getComputedStyle;
Object.defineProperty(global, "navigator", { value: { onLine: true }, configurable: true });
global.chrome = {
  runtime: {
    onMessage: { addListener: () => {} },
    connect: () => ({ postMessage: () => {}, onMessage: { addListener: () => {} }, onDisconnect: { addListener: () => {} }, disconnect: () => {} })
  },
  storage: { sync: { get: (_k, cb) => cb({}) } }
};

// jsdom 不实现 innerText，用 textContent 等价替换（保留换行差异可忽略）
Object.defineProperty(dom.window.Element.prototype, "innerText", {
  get() { return this.textContent; },
  configurable: true
});

// 剥离顶层 chrome.runtime.onMessage 监听注册（已在 global.chrome 打桩），直接执行源码
let api;
beforeAll(() => {
  const sandbox = {
    document: global.document,
    Node: global.Node,
    window: {
      document: global.document,
      requestIdleCallback: null,
      innerWidth: 1024,
      innerHeight: 768,
      getSelection: () => null
    },
    getComputedStyle: global.getComputedStyle,
    navigator: global.navigator,
    chrome: global.chrome,
    setTimeout,
    clearTimeout,
    location: { href: "https://example.com/doc" },
    console
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  // 从沙箱提取内部函数：通过 eval 暴露
  api = vm.runInContext(
    "({ isBlockElement, getSurroundingElement, deduplicateContext, estimateTokens, trimByTokenBudget, extractPageSummary, renderMarkdown, sanitizeHTML, extractPageContext })",
    sandbox
  );
});

describe("estimateTokens", () => {
  it("空文本返回 0", () => {
    expect(api.estimateTokens("")).toBe(0);
    expect(api.estimateTokens(null)).toBe(0);
  });
  it("字符数除以 4 向上取整", () => {
    expect(api.estimateTokens("abcd")).toBe(1);
    expect(api.estimateTokens("abcde")).toBe(2);
    expect(api.estimateTokens("a".repeat(401))).toBe(101);
  });
});

describe("deduplicateContext", () => {
  it("移除正文摘要中与周围文本重复的句子", () => {
    const surrounding = "量子纠缠是量子力学中的重要现象。它描述了两个粒子的关联。";
    const summary = "量子纠缠是量子力学中的重要现象。本页面还有其他内容补充说明。";
    const r = api.deduplicateContext(surrounding, summary);
    expect(r).not.toContain("量子纠缠是量子力学中的重要现象");
    expect(r).toContain("本页面还有其他内容");
  });
  it("短句（≤10 字）不参与去重", () => {
    const summary = "保留这句短句。其余内容完整保留不动。";
    expect(api.deduplicateContext("你好。好的。", summary)).toBe(summary);
  });
  it("周围文本为空时原样返回摘要", () => {
    expect(api.deduplicateContext("", "summary")).toBe("summary");
  });
  it("摘要为空时返回空", () => {
    expect(api.deduplicateContext("一些很长的句子内容超过十个字。", "")).toBe("");
  });
});

describe("trimByTokenBudget", () => {
  it("总量未超预算时不裁剪", () => {
    const ctx = { title: "t", surroundingText: "s".repeat(100), pageSummary: "p".repeat(100) };
    const r = api.trimByTokenBudget(ctx, 4000);
    expect(r.pageSummary).toHaveLength(100);
    expect(r.surroundingText).toHaveLength(100);
  });

  it("超预算时标题保留，摘要被大幅裁剪", () => {
    const ctx = {
      title: "t",
      surroundingText: "s".repeat(400), // 100 tokens
      pageSummary: "p".repeat(30000) // ~7500 tokens
    };
    const budget = 1200;
    // 新算法优先保周围文本（100 tokens），余量 1099 tokens 给摘要 → 1099*4≈4396 字符
    const r = api.trimByTokenBudget(ctx, budget);
    expect(r.title).toBe("t");
    expect(r.surroundingText).toHaveLength(400); // 短于自身份额，实际未截
    expect(r.pageSummary.length).toBeLessThan(30000); // 确实被裁剪
    // 裁剪后总 token 数必须收敛到预算内
    const totalTokens = Math.ceil(1 / 4) + Math.ceil(r.surroundingText.length / 4) + Math.ceil(r.pageSummary.length / 4);
    expect(totalTokens).toBeLessThanOrEqual(budget);
  });

  it("极小预算下两者都裁剪", () => {
    const ctx = {
      title: "t",
      surroundingText: "s".repeat(8000),
      pageSummary: "p".repeat(8000)
    };
    const r = api.trimByTokenBudget(ctx, 500);
    expect(r.title).toBe("t"); // 标题最后裁剪
    expect(r.surroundingText.length).toBeLessThan(8000);
    expect(r.pageSummary.length).toBeLessThan(8000);
  });
});

describe("renderMarkdown", () => {
  it("转义 HTML 特殊字符防注入", () => {
    const html = api.renderMarkdown('<script>alert(1)<\/script> & <b>');
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
  });

  it("代码块渲染为 pre/code", () => {
    const html = api.renderMarkdown("```python\nprint('hi')\n```");
    expect(html).toContain('<pre><code class="language-python">');
    expect(html).toContain("print('hi')");
  });

  it("行内代码、加粗、斜体、链接", () => {
    const html = api.renderMarkdown("`code` **bold** *it* [link](https://a.com)");
    expect(html).toContain("<code>code</code>");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>it</em>");
    expect(html).toContain('<a href="https://a.com"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it("标题 h1-h3", () => {
    const html = api.renderMarkdown("# A\n## B\n### C");
    expect(html).toContain("<h1>A</h1>");
    expect(html).toContain("<h2>B</h2>");
    expect(html).toContain("<h3>C</h3>");
  });

  it("无序与有序列表", () => {
    const ul = api.renderMarkdown("- a\n- b");
    expect(ul).toContain("<li>a</li>");
    expect(ul).toContain("<ul>");
    const ol = api.renderMarkdown("1. one\n2. two");
    expect(ol).toContain("<li>one</li>");
  });
});

describe("sanitizeHTML 白名单", () => {
  it("script/style 标签被替换为文本", () => {
    const out = api.sanitizeHTML('<p>ok</p><script>alert(1)<\/script>');
    expect(out).not.toMatch(/<script/i);
    expect(out).toContain("<p>ok</p>");
  });

  it("img/iframe 不在白名单，降级为其文本内容", () => {
    const out = api.sanitizeHTML('<p>x</p><iframe src="https://evil.com"></iframe><img src=x onerror=alert(1)>');
    expect(out).not.toMatch(/<iframe|<img/i);
  });

  it("事件属性被移除", () => {
    const out = api.sanitizeHTML('<p onclick="alert(1)">click</p>');
    expect(out).not.toContain("onclick");
    expect(out).toContain("click");
  });

  it("href 仅允许 http/https（防 javascript: URI）", () => {
    const out = api.sanitizeHTML('<a href="javascript:alert(1)">bad</a><a href="https://good.com">good</a>');
    expect(out).not.toContain("javascript:");
    expect(out).toContain('href="https://good.com"');
  });

  it("onerror 内联事件即便属性也在白名单外被清理", () => {
    const out = api.sanitizeHTML('<a href="https://x.com" onclick="evil()">t</a>');
    expect(out).not.toContain("onclick");
  });
});

describe("extractPageContext", () => {
  function setBody(html) {
    document.body.innerHTML = html;
  }

  it("提取标题与 URL", async () => {
    document.title = "测试页";
    setBody("<article><p>" + "主内容。".repeat(200) + "</p></article>");
    const ctx = await api.extractPageContext("选中文本", null);
    expect(ctx.title).toBe("测试页");
    expect(ctx.url).toBe("https://example.com/doc");
    expect(ctx.pageSummary.length).toBeGreaterThan(0);
  });

  it("正文摘要优先 article/main/[role=main]，回退 body", async () => {
    document.title = "T";
    setBody('<div>导航栏不属于正文。</div><main><p>' + "这是主区域内容。".repeat(100) + "</p></main>");
    const ctx = await api.extractPageContext("x", null);
    expect(ctx.pageSummary).toContain("这是主区域内容");
    expect(ctx.pageSummary).not.toContain("导航栏");

    setBody("<p>" + "没有语义标签时的正文。".repeat(80) + "</p>");
    const ctx2 = await api.extractPageContext("x", null);
    expect(ctx2.pageSummary).toContain("没有语义标签时的正文");
  });

  it("正文摘要截取前 1000 字", async () => {
    document.title = "T";
    setBody("<article><p>" + "很长的内容。".repeat(5000) + "</p></article>");
    const ctx = await api.extractPageContext("x", null);
    expect(ctx.pageSummary.length).toBeLessThanOrEqual(1000);
  });

  it("周围文本：selIdx 命中时前后各 ≤250 字且包含选中文本", async () => {
    document.title = "T";
    const para = ("前".repeat(400)) + "独特标记词" + ("后".repeat(400));
    setBody(`<article><p>${para}</p></article>`);
    // 构造真实 Range：选中"独特标记词"，commonAncestorContainer 为该 <p>
    const p = document.querySelector("p");
    const textNode = p.firstChild;
    const range = document.createRange();
    range.setStart(textNode, 400);
    range.setEnd(textNode, 405);
    const ctx = await api.extractPageContext("独特标记词", range);
    expect(ctx.surroundingText).toContain("独特标记词");
    expect(ctx.surroundingText.length).toBeLessThanOrEqual(500 + 5);
  });

  it("选区未命中时回退取前 500 字", async () => {
    document.title = "T";
    setBody("<article><p>" + "全页文本内容。".repeat(200) + "</p></article>");
    const p = document.querySelector("p");
    const range = document.createRange();
    range.selectNodeContents(p);
    // 选中文本不在元素 innerText 中 → 走 slice(0,500) 分支
    const ctx = await api.extractPageContext("不存在的选中文本zzz", range);
    expect(ctx.surroundingText.length).toBeLessThanOrEqual(500);
  });
});
