# ReadPilot

选中网页文本，右键调用大模型结合网页上下文解释并补充相关知识的 Chrome 扩展。

## 功能特性

- **右键解释**：选中文本 → 右键菜单「用 ReadPilot 解释」→ 浮层展示结果
- **网页上下文**：自动提取页面标题、选中段落周围文本与正文摘要，一并送入 LLM
- **多 Provider**：内置 OpenAI 兼容、Ollama 本地、自定义三类预设，选中后自动填充 endpoint 与默认 model
- **流式响应**：SSE 逐 token 推送，浮层实时渲染；可在选项页关闭流式输出
- **Markdown 渲染**：精简 Markdown 渲染器（代码块、行内代码、列表、加粗、斜体、链接、标题）+ 白名单 XSS sanitize
- **历史记录**：弹出页查看历次解释，支持展开/折叠、清空
- **安全存储**：API Key 存于 `chrome.storage.local`（不跨设备同步），其余配置存于 `chrome.storage.sync`
- **隐私**：仅将选中文本与页面上下文发送至用户配置的 LLM 端点，不内置 analytics/telemetry/tracking，无第三方请求
- **健壮性**：30s 请求超时、429/5xx 自动重试 1 次、离线检测、用户取消中断底层 fetch

## 安装

### 方式一：从 Release 安装 CRX（推荐）

1. 前往 [GitHub Releases](https://github.com/asterwyx/readpilot/releases) 下载最新版本 `.crx` 文件
2. 打开 `chrome://extensions`
3. 将下载的 `.crx` 文件拖入扩展页面

> ⚠️ 自签名 CRX 可能被 Chrome 拦截。若拖入失败，请使用方式二加载已解压扩展。

### 方式二：开发者模式加载（源码）

1. 下载源码并解压
2. 打开 `chrome://extensions`
3. 右上角开启「开发者模式」
4. 点击「加载已解压的扩展程序」，选择项目根目录

## 配置

1. 安装后点击扩展图标 → 「设置」（或直接访问 `chrome://extensions` 中 ReadPilot 的「扩展程序选项」）
2. 选择 **LLM 提供商**：
   - **OpenAI** — 兼容 Chat Completions 格式，适用于 OpenAI、DeepSeek、Moonshot 等
   - **Ollama 本地** — 本地推理服务
   - **自定义** — 任意 OpenAI 兼容端点
3. 填写 **API Endpoint**（base URL，无需 `/chat/completions` 后缀）、**API Key**、**模型名称**
4. 可选：覆盖 **System Prompt**、切换**流式输出**、调整**上下文 Token 预算**（500–16000）
5. 点击 **保存**
6. 点击 **测试连接** 验证配置

## 使用

1. 在任意网页选中文本
2. 右键 → 「用 ReadPilot 解释」
3. 浮层弹出展示解释，支持：
   - 拖动标题栏移动位置
   - 右下角拖拽缩放
   - 复制内容
   - `Esc` 关闭

## 项目结构

```
readpilot/
├── manifest.json          # Chrome MV3 配置：权限、入口、图标
├── background.js          # Service Worker：右键菜单、消息转发、LLM 调用、历史存储
├── content.js             # Content Script：选中文本与上下文提取、Markdown 渲染、浮层管理
├── content.css            # 浮层样式（readpilot- 前缀 scoped）
├── lib/
│   └── llm.js             # LLM 调用模块：Provider 预设、prompt 组装、流式/超时/重试
├── options.html           # 选项页：Provider 配置表单
├── options.js             # 选项页逻辑：配置读写、预设切换、字段校验、测试连接
├── popup.html             # 弹出页：历史记录列表
├── popup.js               # 弹出页逻辑：历史渲染、展开折叠、清空
├── icons/                 # 16/48/128 PNG 图标
├── scripts/
│   └── release.sh         # 版本发布脚本
├── .github/workflows/
│   └── release.yml        # GitHub Actions 发布工作流
├── tests/                 # 单元与集成测试（vitest + jsdom）
│   ├── boundary.test.js
│   ├── content.test.js
│   ├── integration.test.js
│   ├── llm.test.js
│   └── ui.test.js
├── CHANGELOG.md           # 变更日志
└── package.json           # 开发依赖与测试脚本
```

## 开发

### 环境要求

- Node.js（用于运行测试）
- Chrome 浏览器（用于加载扩展）

### 常用命令

```bash
npm ci          # 安装开发依赖
npx vitest run  # 运行测试套件
```

### 代码结构

无构建工具链，原生 JavaScript + ES modules。`background.js`、`options.js` 直接 import `lib/llm.js`；`content.js` 因 Content Script 限制为独立脚本。修改后无需编译，在 `chrome://extensions` 点击刷新即可生效。

## 发布

```bash
./scripts/release.sh <version>   # 例如 0.2.0
```

脚本自动完成：

1. 校验语义化版本号（`MAJOR.MINOR.PATCH`）
2. 更新 `manifest.json` 的 `version` 字段
3. 将 `CHANGELOG.md` 中 `[Unreleased]` 转为正式版本条目
4. 创建 commit（`release: v<version>`）并打 tag `v<version>`
5. 推送至 origin，tag 推送触发 GitHub Actions 打包并发布 Release

## 技术栈

| 层 | 技术 |
|---|---|
| 扩展平台 | Chrome Extension Manifest V3 |
| 语言 | 原生 JavaScript（ES modules） |
| 测试 | vitest + jsdom（91 用例） |
| CI/CD | GitHub Actions |

## 许可证

MIT
