# AGENTS.md — dsh-session-url

本仓是一个独立的 DeepSeek Harness Web GUI 插件仓（**只有浏览器半区**）。它不属于 `zhu1090093659/dsh-web` 单仓，也不随那个单仓发版：源在这里。

## 形态约束

- **手写 JS，直接进 `lib/`**：没有构建步骤，`lib/index.js`（宿主半区，空操作）与 `lib/client.js`（浏览器半区，交付产物）既是源也是产物。
- **`lib/client.js` 必须守住模块加载器合同**：`window.__ModuleLoader__.load({ id: 'dsh-session-url', factory })`，工厂返回 `{ apply, inject }`；`inject` 是服务名 `['sessions','workspaces','uiWorkspace']`，包 `dsh.client.inject` 声明的是三个官方客户端模块 id。改这两处会让浏览器半区静默不加载。
- **零依赖**：没有 dependencies/devDependencies，也没有遥测与网络请求；不要为了顺手而引入包。
- **测试用 `node --test`**：`npm test`。测试**直接加载交付产物**（`node:vm` 里假 loader + 假 window + 手动时钟），不复制实现、不 mock 模块图；行为变化必须带测试。

- **行链接**：`[data-row-key^="session:"]` 的会话行会被挂上真锚点（`data-dsh-part="session-link"`），点=新标签页打开、右键=浏览器原生复制链接。行选择器/属性一旦改动，必须同步改 `test/client.test.js` 里的假 DOM；找不到 DOM 或属性不匹配时一律静默 no-op，绝不改官方行、绝不抛错。

## 行为边界（改之前先读）

- 只写 fragment，用 `replaceState`；路径与查询串原样保留。
- 8 秒权威窗口（`LINK_ENFORCE_WINDOW_MS`）、归档链接立即拒绝、未列出链接窗口到期才丢 —— 这三条是产品契约，改动必须同步改 README 与本文件的测试。
- 服务形态不匹配时自我禁用（一条诊断），绝不抛错、绝不触碰官方行为。

## 跨机开发日志

改动记录在私有库 [DDDMUC/repo-devlogs](https://github.com/DDDMUC/repo-devlogs) 的 **`dsh-session-url/`** 文件夹（`HANDOFF.md` 最新一轮在最上面；macOS 端写 `WORKLOG-macos.md`，条目以 `[macOS]` 开头）。按该库规矩，每条先写 `**运行环境**`（设备 / 应用 / 服务商与模型），再写做了什么、动了哪些文件、怎么验证、遗留问题。
