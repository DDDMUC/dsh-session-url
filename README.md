# dsh-session-url

**一个对话，一个链接。** DSH Web GUI 的地址栏永远指向主视图那个对话：切对话时地址栏跟着变，把 `#/session/<id>` 链接粘进地址栏就能打开相应对话。只有浏览器半区，没有宿主行为；**侧栏每一行本身就是链接**：在行上右键就是浏览器原生的「复制链接 / 在新标签页中打开链接」，中键或 Cmd+点击直接开新标签，而左键单击仍然只是切到那个对话。零依赖、零构建、不发网络请求。

[中文](#中文) · [English](#english)

---

## 中文

## 功能

- **视图 → 链接**：主视图在哪个对话，fragment 就变成 `#/session/<id>`。用 `history.replaceState` 写，**不新增历史记录**（返回键仍然是"离开 GUI"，不会被自己的跳转吃掉）。
- **链接 → 视图**：打开或粘贴 `#/session/<id>` 会打开那个对话。解析宽容：`#/sessions/<id>`、缺前导斜杠、URL 编码、尾部斜杠都认。
- **列表 → 链接**：**侧栏每一行本身就是链接**——一个覆盖整行的透明真锚点（`<a href="#/session/<id>" target="_blank">`）：右键就是浏览器原生菜单（在新标签页打开链接 / 复制链接 / 链接另存为），中键或 Cmd/Ctrl+点击直接开新标签；**左键单击仍然只是切到那个对话**（不新增历史记录）。行内官方控件被抬到锚点之上，不受影响。
- 只改 fragment：路径与查询串原样保留，启动 `?token=` 不会被破坏。

## 为什么用 fragment，而非路径或查询串

- 宿主的静态回退只对**解析到 dist 根**的路径返回 `index.html`，`/s/<id>` 会 404 —— 路径式深链起不来。
- 带启动 `?token=` 的请求会被 303 到干净的 `./`，多余查询串一律丢弃。fragment 不发给宿主，所以应用内跳转不会毁掉链接。

## 安装

```sh
dsh plugin --profile web add link:$PWD
# 或发布后：dsh plugin --profile web add dsh-session-url
```

浏览器半区在下一次页面刷新生效；行本身在宿主启动时生效（profile 设了 `patchReload: live` 时热加载）。

## 已知限制

- **8 秒权威窗口**：页面加载后 8 秒内，链接优先于"本地保存的选择"的恢复；这期间用户点击可能被链接抢回一次。窗口内目录还没列出的对话会被保留等待（没列出不等于死），窗口到期才丢弃并打一条 `[session-url]` 诊断。
- 已归档对话的链接**立即**拒绝，并打一条诊断。
- 只支持 fragment；带登录凭据的入口链接不可分享（token 在查询串里，不会写进链接）。
- 服务形态变化（`sessions` / `workspaces` / `uiWorkspace` 任一面不匹配）时插件自我禁用、只打一条诊断，不触碰官方行为。

- 整行链接依赖官方侧栏的行结构（`div[data-row-key="session:<id>"]`）：官方改了行标签或这个属性，链接会**静默消失**（地址栏同步不受影响）；不匹配的行一律不碰。

## 安全与隐私

浏览器半区只读目录快照、只调用官方 `openSession`；**不发网络请求、不打点、不写盘**（本仓没有家族单仓版本里的每日心跳遥测）。

## English

## Features

- **View to link**: the conversation the main view is in becomes the fragment `#/session/<id>`. It is written with `history.replaceState`, so **no history entry is added** (Back still leaves the GUI; it is not eaten by our own jumps).
- **Link to view**: opening or pasting `#/session/<id>` opens that conversation. Parsing is tolerant: `#/sessions/<id>`, a missing leading slash, URL encoding and a trailing slash are all accepted.
- **List to link**: **every sidebar row is itself the link** — a transparent real anchor covering the row (`<a href="#/session/<id>" target="_blank">`): right click gives the browser's native menu (open link in new tab / copy link / save link as), middle or Cmd/Ctrl click opens a new tab, while a plain left click still only switches to that conversation (no history entry). The row's own controls are lifted above the anchor, so they keep working.
- Only the fragment changes: path and query are preserved as they are, so a launch `?token=` is not damaged.

## Why the fragment, and not a path or query

- The host's static fallback serves `index.html` only for a path that resolves to the dist root; `/s/<id>` is a 404 — a path-style deep link cannot boot the GUI.
- A request that still carries the launch `?token=` is answered with a 303 to the clean `./`, and every extra query parameter is dropped. The fragment is not sent to the host, so in-app navigation cannot destroy the link.

## Install

```sh
dsh plugin --profile web add link:$PWD
# or, once published: dsh plugin --profile web add dsh-session-url
```

The browser half takes effect on the next page load; the row itself loads at host start (or hot-loads when the profile sets `patchReload: live`).

## Known limitations

- **Eight-second authority window**: for 8 s after a page load a link outranks the restore of the locally saved selection, so a click during boot can be overridden once. A linked conversation the catalog has not listed yet is kept waiting (unlisted is not death) and dropped only at expiry, with one `[session-url]` diagnostic.
- A link to an archived conversation is refused **immediately**, with one diagnostic.
- Fragment only; an entry link carrying credentials is not shareable (the token lives in the query and is never written into the link).
- If the service shape changes (any of `sessions` / `workspaces` / `uiWorkspace` no longer matches), the plugin disables itself with a single diagnostic and leaves the official behavior untouched.

- The row-wide link depends on the official sidebar row markup (`div[data-row-key="session:<id>"]`): if the row tag or that attribute changes, the link silently disappears (the address-bar sync is unaffected), and unmatched rows are never touched.

## Security and privacy

The browser half only reads catalog snapshots and calls the official `openSession`. It sends **no network request, no telemetry, and writes nothing to disk** (the family monorepo build's daily heartbeat is not part of this repository).

## 开发日志 / Dev log

跨机改动记录在私有库 [DDDMUC/repo-devlogs](https://github.com/DDDMUC/repo-devlogs) 的 `dsh-session-url/` 文件夹；见本仓 `AGENTS.md`。

## License

MIT
