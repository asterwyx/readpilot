// ReadPilot background.js 单元测试 —— 覆盖 getConfig() 读取与默认值回退
// 采用读取源码 + vm 加载的方式，stub chrome.* API，仅暴露被测函数 getConfig
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const backgroundSrc = readFileSync(new URL("../background.js", import.meta.url), "utf8")
  .replace(/^import .*$/gm, ""); // 剥离 ES import（PROVIDER_PRESETS/callLLM/formatError 由 llm.js 源码注入）
const llmSrc = readFileSync(new URL("../lib/llm.js", import.meta.url), "utf8").replace(/^export\s+/gm, "");

// storage 数据由各用例独立设置；get 返回 Promise（与 background.js await 用法匹配）
function makeChromeStub(syncData, localData) {
  const syncGet = (keys) => {
    const ks = Array.isArray(keys) ? keys : [keys];
    return Promise.resolve(Object.fromEntries(ks.map((k) => [k, syncData[k]])));
  };
  const localGet = (keys) => {
    const ks = Array.isArray(keys) ? keys : [keys];
    return Promise.resolve(Object.fromEntries(ks.map((k) => [k, localData[k]])));
  };
  return {
    storage: { sync: { get: syncGet }, local: { get: localGet } },
    runtime: {
      onInstalled: { addListener: () => {} },
      onMessage: { addListener: () => {} },
      onConnect: { addListener: () => {} }
    },
    contextMenus: {
      removeAll: () => {},
      create: () => {},
      onClicked: { addListener: () => {} }
    },
    tabs: { sendMessage: () => {} }
  };
}

function boot(syncData, localData) {
  const sandbox = {
    chrome: makeChromeStub(syncData, localData),
    console,
    URL,
    AbortController,
    setTimeout, clearTimeout
  };
  vm.createContext(sandbox);
  vm.runInContext(llmSrc, sandbox);          // 定义 PROVIDER_PRESETS/callLLM/formatError
  vm.runInContext(backgroundSrc, sandbox);   // 注册监听器 + 定义 getConfig
  return vm.runInContext("getConfig", sandbox);
}

describe("background.js getConfig()", () => {
  it("读取已保存的 contextTokenBudget 而非静默回退 4000", async () => {
    const getConfig = boot({ contextTokenBudget: 8000 }, { apiKey: "sk-1" });
    const config = await getConfig();
    expect(config.contextTokenBudget).toBe(8000);
  });

  it("contextTokenBudget 缺失时回退默认 4000", async () => {
    const getConfig = boot({}, {});
    const config = await getConfig();
    expect(config.contextTokenBudget).toBe(4000);
  });

  it("读取 explainLanguage，缺失时回退 browser", async () => {
    const getConfig = boot({ explainLanguage: "zh" }, {});
    const config = await getConfig();
    expect(config.explainLanguage).toBe("zh");
    const getConfig2 = boot({}, {});
    expect((await getConfig2()).explainLanguage).toBe("browser");
  });

  it("读取其余配置字段与默认值", async () => {
    const getConfig = boot(
      { provider: "ollama", endpoint: "http://localhost:11434/v1", model: "llama3", timeout: 30000, streamEnabled: false },
      { apiKey: "local-key" }
    );
    const config = await getConfig();
    expect(config.provider).toBe("ollama");
    expect(config.endpoint).toBe("http://localhost:11434/v1");
    expect(config.model).toBe("llama3");
    expect(config.apiKey).toBe("local-key");
    expect(config.timeout).toBe(30000);
    expect(config.streamEnabled).toBe(false);
  });
});
