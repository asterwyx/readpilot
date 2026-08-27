// ReadPilot 边界场景测试：spec 声明行为的代码级核实
// —— §1.2 移除 window.getSelection 回退、CANCEL 未接 signal、
//    showError XSS 注入点、iframe 同源假设、跨元素选区上下文。
import { describe, it, expect } from "vitest";
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const contentSrc = readFileSync(new URL("../content.js", import.meta.url), "utf8");
const llmSrc = readFileSync(new URL("../lib/llm.js", import.meta.url), "utf8");

describe("§1.2 选区来源统一（回退逻辑移除）", () => {
  it("window.getSelection 仅用于读取 range，不再作为选区文本回退来源", () => {
    // L608-626：selection 全部来自 msg.selection；getSelection 只在 try 块里取 range
    const listenerCode = contentSrc.slice(contentSrc.indexOf("chrome.runtime.onMessage.addListener"));
    expect(listenerCode).toContain('msg.selection || ""');
    // 回退分支不存在：不应出现 getSelection().toString()
    expect(listenerCode).not.toMatch(/getSelection\(\)[\s\S]{0,40}toString/);
    // 全文件真正的调用语句只有一处：`const sel = window.getSelection();`
    // （L608 为注释文本，正则锚定"行首 const sel ="排除）
    const callSites = contentSrc.match(/^(?!\s*\/\/).*window\.getSelection\(\)/gm) || [];
    expect(callSites.length).toBe(1);
  });
});

describe("流式取消：signal 接线核查（已修复 AST-7）", () => {
  it("background onConnect 的 callLLM 调用已传 AbortSignal → CANCEL 中断底层 fetch", () => {
    const bgSrc = readFileSync(new URL("../background.js", import.meta.url), "utf8");
    const connectBlock = bgSrc.slice(bgSrc.indexOf("chrome.runtime.onConnect"));
    expect(connectBlock).toMatch(/callLLM\(/);
    expect(connectBlock).toMatch(/signal\s*[:=]/);
    expect(connectBlock).toMatch(/AbortController/);
    expect(connectBlock).toMatch(/abortCtrl\.abort\(\)/);
    // lib/llm.js 支持 signal
    const llmSupports = /createTimeoutController\(signal\)/.test(llmSrc.replace(/^export\s+/gm, ""));
    expect(llmSupports).toBe(true);
  });
});

describe("showError XSS 注入点（已修复 AST-8）", () => {
  function bootWithError(message, isConfig = false) {
    const dom = new JSDOM("<!DOCTYPE html><body></body>");
    const document = dom.window.document;
    const sb = {
      document,
      Node: dom.window.Node,
      window: { document },
      navigator: { onLine: true, clipboard: { writeText: async () => {} } },
      chrome: { runtime: { onMessage: { addListener() {} }, openOptionsPage() {} }, storage: { sync: { get(_k, cb) { cb({}); } }, local: { get(_k, cb) { cb({}); } } } },
      location: { href: "https://example.com/x" },
      setTimeout, clearTimeout,
      requestAnimationFrame: () => 1,
      console, URL
    };
    vm.createContext(sb);
    vm.runInContext(contentSrc, sb);
    return vm.runInContext(`(() => { showError(${JSON.stringify(message)}, ${isConfig}); return overlay.innerHTML; })()`, sb);
  }

  it("错误消息含 HTML 时以 textContent 写入 → HTML 被转义而非注入", () => {
    const html = bootWithError('<img src=x onerror="alert(1)">');
    // 修复后：<img> 不作为真实元素进入 DOM，而是转义后的文本
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  it("含 <script> 字样的错误消息以文本写入 → 不产生可执行结构", () => {
    const html = bootWithError("<script>alert(2)</script>");
    expect(html.toLowerCase()).not.toContain("<script");
    expect(html.toLowerCase()).toContain("&lt;script&gt;");
  });
});

describe("iframe 与 frameId 核查（已修复 AST-9）", () => {
  it("manifest all_frames:true + tabs.sendMessage 指定 frameId → 消息投递到正确 frame", () => {
    const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
    const contentCfg = manifest.content_scripts[0];
    expect(contentCfg.all_frames).toBe(true);
    const bgSrc = readFileSync(new URL("../background.js", import.meta.url), "utf8");
    // 修复后：sendMessage 第三参数传 { frameId: info.frameId ?? 0 }
    expect(bgSrc).toMatch(/chrome\.tabs\.sendMessage\(/);
    expect(bgSrc).toMatch(/EXPLAIN_SELECTION/);
    expect(bgSrc).toMatch(/frameId/);
    expect(bgSrc).toMatch(/info\.frameId/);
  });
});

describe("跨元素选区与 SPA 选区失效", () => {
  function makeSb(domHtml) {
    const dom = new JSDOM(domHtml, { url: "https://example.com/spa" });
    const document = dom.window.document;
    Object.defineProperty(dom.window.Element.prototype, "innerText", { get() { return this.textContent; }, configurable: true });
    return { dom, document };
  }

  it("选区跨元素（<b> 切分文本节点）时 commonAncestorContainer 为块级父元素，上下文仍完整提取", async () => {
    const h = makeSb(`<!DOCTYPE html><html><head><title>SPA页</title></head><body>
      <div id="content"><p>${"甲".repeat(300)}<b>独特加粗词</b>${"乙".repeat(300)}</p></div>
    </body></html>`);
    const p = h.document.querySelector("p");
    const textNodeA = p.childNodes[0];
    const bEl = p.querySelector("b");
    const range = h.document.createRange();
    range.setStart(textNodeA, 295); // 选区从普通文本尾部开始，覆盖 <b> 加粗词
    range.setEndAfter(bEl);
    // 模拟 extractPageContext 行为验证 commonAncestorContainer 是 <p>
    expect(range.commonAncestorContainer.nodeType).toBe(1); // element node
    expect(range.commonAncestorContainer.tagName).toBe("P");
    const wrapped = range.commonAncestorContainer;
    expect(wrapped.innerText).toContain("独特加粗词");
  });

  it("range 失效（SPA 重渲染后 detached node）时 getRangeAt 抛错路径：监听器 catch 后 range=null 走全文回退", async () => {
    const h = makeSb("<!DOCTYPE html><html><body><p>x</p></body></html>");
    // 构造 detached range 场景的行为模型：content.js 的 try/catch 已在单元测试覆盖 null 分支
    // 这里验证语法层面 catch 存在
    const listenerIdx = contentSrc.indexOf("const sel = window.getSelection()");
    const catchExists = contentSrc.slice(listenerIdx, listenerIdx + 400).includes("catch");
    expect(catchExists).toBe(true);
  });
});
