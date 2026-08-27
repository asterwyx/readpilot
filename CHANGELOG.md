# Changelog

本文件记录 ReadPilot 的所有版本变更，格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 新增

- （待记录）

## [0.0.1] - 2026-08-27

### 修复

- 流式取消现在中断底层 fetch 请求（`background.js` 将 `AbortController` 接线至 `callLLM` 的 `signal`），取消后底层连接立即中止，不再继续消耗 token
- `lib/llm.js` 区分用户主动取消（`type: "aborted"`）与超时（`type: "timeout"`），取消错误不再上报或重试

### 新增

- GitHub Actions 自动发布工作流（`.github/workflows/release.yml`），推送 `v*` tag 时触发打包与发布
- 版本发布脚本 `scripts/release.sh`，一键完成版本号更新、CHANGELOG 记录、提交、打 tag 并推送

## [0.1.0] - 2026-08-27

### 基线架构

- `manifest.json`：Chrome MV3 配置，`contextMenus`/`activeTab`/`storage` 权限，service worker 后台
- `background.js`：右键菜单创建、消息转发、LLM 调用、结果存储
- `content.js`：选中文本与页面上下文提取、浮层注入显示
- `content.css`：浮层样式（`readpilot-` 前缀 scoped）
- `lib/llm.js`：LLM 调用模块，兼容 OpenAI Chat Completions 格式
- `options.html` / `options.js`：provider 配置页，含测试连接
- `popup.html` / `popup.js`：最近一次解释查看 + 设置入口
- `icons/`：16/48/128 透明 PNG 占位图标

### P0 功能

- 流式 SSE 响应：逐 token 推送，前端实时渲染
- 30s 请求超时与 429/5xx 自动重试
- 多 Provider 预设：选中 provider 后自动填充 endpoint 与默认 model
- `buildFullEndpoint` / `formatError` 辅助方法

### P1 功能

- Markdown 渲染 + XSS sanitize，拖拽移动与缩放浮层
- 上下文前后 250 字裁剪、去重、token 预算裁剪
- iframe 同源注入、离线检测、RAF 批量更新
- 历史记录多条存储与展开折叠、清空
- apiKey 迁移至 `storage.local`（不跨设备同步），配置完整性校验
- options 页安全提示与隐私声明、逐字段校验与预设自动填充
