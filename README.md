# Swarm Rebuild · 群蜂建站

**AI 在写网页的时候，一群「多人协作光标」会从一张空白蓝图开始，把这一页一块一块重新建出来。**

## 这是做什么的

一个 DeepSeek Harness（DSH）的 Cordis 插件，由主机侧、客户端侧和一个注入页面的 runtime 脚本组成。当 AI 在 Harness 工作区里开发网页时，正在开发的页面会显示在右侧侧边栏的浏览器标签页里；在那张页面上，8–48 个光标开始「施工」，把这个页面从蓝图状态重新搭一遍，搭完退场，页面恢复成干净的原样。它不是一个独立的演示页，跑的就是 AI 正在改的那个文件。

## 效果

1. 页面整体淡成蓝图。
2. 顶部和左侧浮现深色标尺，带刻度与数字；站点图标停在画面正中。
3. 十八个光标绕着图标成群游动一圈，作为开场。
4. 光标散开，各自认领页面上的一个块。
5. 十字光标拖出 1px 蓝色选框，块随选框一起长大；选框下方浮出 `240 × 96` 这样的尺寸徽章，标尺上高亮被测的那一段，蓝色虚线参考线从标尺拉到选框上；红色测量参考线会吸附到位并闪一下。
6. 遇到文本，光标切换成 I 形，把真实文字一个字符一个字符打出来，带词间停顿和随机的「思考停顿」，末尾有一条闪烁的光标条；选框随每行落字而变高。
7. 钢笔画的线条、复制与换样式这类编辑动作也会出现；一个块画完就转成实心，露出它真正的颜色。
8. 同一时间有八到四十八个光标在工作，页面越繁忙，同时在飞的光标越多。
9. 收尾：最后一块建完，光标聚成一群绕一圈后飞出屏幕，蓝图淡出，只留下完全干净的成品页面——没有叠加层、没有标尺、也不会无限循环。
10. 只有下一次 AI 修改、新增或删除页面内容时，才会再播一遍。

同一个被服务出来的地址，在任意外部浏览器里打开也是同样的效果。

## 安装

这是一个本地 / git 插件，**目前没有发布到 npm**。安装方式是把仓库放进一个 DSH 工作区，再从该目录安装 bundle：

```bash
git clone https://github.com/lanyuxi/Multi-agent-development-dynamic-effect.git
# 也可以直接把已克隆的仓库复制进工作区

# 从仓库目录安装 bundle（或在 DSH 插件界面里选择同样的目录）
plugin_manager install_bundle /absolute/path/to/Multi-agent-development-dynamic-effect
```

装好后插件默认启用。打开任意一个 AI 会话，右侧侧边栏的浏览器标签页会自动打开预览；AI 写入 HTML 之后，动效就会在那边播放。

装好之后它还会自己出现在 **Plugins → Discover** 里：主机侧内置了一条
`/__dsh_swarm_rebuild__/market/index.json`（format-1 插件市场索引），客户端侧
从 `/__endpoint` 解析出真实端口后把它注册进 `pluginMarket.setIndexes()`，
所以不用手动加索引源，端口变了也会自动纠正。（官方目录的 PR 尚未提交，
因此别人还搜不到；见 [docs/PUBLISH.md](docs/PUBLISH.md)。）

**验证是否生效**：侧边栏标签页里能看到页面（或「正在等待 AI 生成网页…」的等待页），说明主机侧路由已经起来了；让 AI 写一个 HTML 文件，页面会自动刷新并开始搭建。

要求：需要一个暴露了 web server 服务（`ctx.webServer`）和侧边栏浏览器标签页的 Harness 构建。

## 工作原理

- **内存预览路由**：主机侧在 Harness 的 web server 上注册一条前缀路由 `/__dsh_swarm_rebuild__`，用它把工作区里的文件服务出来。HTML 响应在**内存里**注入一个指向 `runtime.js` 的 `<script>` 标签，**从不写盘**——所以既不会污染用户的源码，也不会破坏 AI 自己的文件版本守卫。
- **版本指纹**：`/__version` 是一份覆盖所有被监视 web 资源的指纹，AI 的任何一次编辑都会让它变化；页面里的 runtime 轮询它，因此改动后会自动重播。
- **备用端口**：`/__endpoint` 返回另一条 loopback 端口上的同一个预览地址。内置浏览器标签页会拦掉 GUI 同端口的地址，换个端口就能正常加载。
- **自动打开**：客户端侧在会话里打开一次侧边栏标签页（有成功闩锁，不会重复开），并重新注册本地服务的 market 索引，端口变了以后 URL 依然有效。
- **runtime**：零依赖，不使用任何 `chrome.*` API，也没有音频；快照方式是把当前 DOM 克隆下来，而不是截图。

## 目录结构

| 文件 | 说明 |
| --- | --- |
| `index.js` | 主机侧。注册 `/__dsh_swarm_rebuild__` 前缀路由，服务工作区文件；对 HTML 只在内存里注入 runtime 脚本；另外提供 `/__endpoint`、`/__version`、`/__runtime.js` 和 `/market/index.json`（format-1 插件市场索引，让插件能列出自己）。 |
| `client.js` | 客户端侧。在右侧侧边栏的浏览器标签页里打开预览（每个会话默认开启），并重新注册本地服务的市场索引，端口变化后 URL 仍然有效。 |
| `runtime.js` | 注入到被开发页面里的 runtime。用 `captureModel()` 快照页面、清空、用光标群重建、再恢复真实页面。零依赖，无 `chrome.*`，无音频。 |
| `cordis.patch.yml` | Bundle patch，把插件插进 DSH profile。 |
| `locale/en.json`、`locale/zh.json` | Harness UI 与插件市场里显示的标题、描述。 |
| `icon.svg`、`assets/icon-180.png` | 插件图标（应用内用 SVG，商店用 180px PNG）。 |
| `package.json` | `dsh-swarm-rebuild`，版本 3.2.0，声明 `dsh.bundle.patch` 与 `dsh.client`。 |

## 配置

| 项 | 说明 |
| --- | --- |
| `SWARM_REBUILD_ROOT` | 可选环境变量，指定要预览的网页所在目录。默认取已安装插件目录的上一级（也就是工作区根目录）。 |
| 开关 | 动效默认开启，装好即生效，不需要逐会话手动启用。 |

## 常见问题

- **侧边栏只显示「正在等待 AI 生成网页…」**：工作区里还没有 HTML 文件。等 AI 写出第一个页面即可，页面会自动刷新。
- **标签页显示端口已停止 / 页面加载失败**：预览端口变了。重新打开一次预览（或重新安装 / 重启 Harness），客户端侧会重新拿 `/__endpoint` 并打开新地址。
- **完全看不到动效**：预览里必须允许 JavaScript 运行；runtime 是被注入的脚本，禁用了 JS 的预览只会显示静态页面。
- **改了页面但没重播**：版本指纹约每几秒轮询一次，稍等一下；确保改的是被监视的 web 资源（HTML / CSS / JS / 图片）。

## 致谢

动效的设计与引擎来自 DhvanilPatel 的开源项目 **swarm-cursors**（[github.com/DhvanilPatel/swarm-cursors](https://github.com/DhvanilPatel/swarm-cursors)），而它本身是对 Joel Califa 的 **Swarm** 的致敬。本仓库是这套编排的忠实移植，自己的贡献只有四件事：

1. 让它作为 DSH 插件运行，完全不依赖 Chrome 扩展 API；
2. 内存预览服务器（不写盘地注入脚本）；
3. 自动打开侧边栏、自动重播的接线；
4. 合成出来的参考线，让本身没有对齐关系的页面也能出现标尺和红色测量线。

本项目**不包含音频**（原项目的音效没有被移植）。

## 许可证

MIT。见 [LICENSE](LICENSE)。

---

## English

### What it is

A Cordis plugin for the DeepSeek Harness (DSH): a host half, a client half and an in-page runtime script. While an AI agent builds a webpage inside the workspace, the developing page is shown in the Harness right-hand sidebar browser tab, and on that page a swarm of 8–48 multiplayer-style cursors rebuilds the page from a blank blueprint. When the last block is done the cursors leave and the page is left completely clean. It is not a standalone demo — it runs on the exact file the AI is writing.

### The effect

1. The page fades to a blueprint.
2. A dark ruler strip appears along the top and left edges, with tick marks and numbers; the site icon sits in the middle.
3. Eighteen cursors swirl around the icon in flocking curves as an opening move.
4. They scatter and each claims one block of the page.
5. A crosshair drags a 1px blue selection frame out and the block grows with it; a size badge such as `240 × 96` floats under the frame while the ruler highlights the measured span, blue dashed guides run from the rulers to the frame, and red measurement guides snap into place and flash.
6. Text blocks switch the cursor to an I-beam, which types the real words character by character with word pauses and occasional thinking pauses, a caret blinking at the end, the frame growing taller as each line lands.
7. Pen-drawn lines, duplicate and restyle edits show up too, and a finished block turns solid with its real colour.
8. Eight to forty-eight cursors are in flight at once; the busier the page, the more cursors.
9. Closing: the last block done, the cursors gather into a flock, swirl once, fly off, and the blueprint fades, leaving the real page completely clean — no overlay, no rulers, no loop.
10. It replays only when the AI modifies, adds or deletes page content.

The same served URL shows the same effect in any external browser.

### Install

This is a **local / git plugin, not published to npm yet**. Copy the repository into a DSH workspace and install the bundle from that directory:

```bash
git clone https://github.com/lanyuxi/Multi-agent-development-dynamic-effect.git

# install the bundle from the repository directory (or pick the same directory
# in the DSH plugin UI)
plugin_manager install_bundle /absolute/path/to/Multi-agent-development-dynamic-effect
```

After installation the plugin is enabled by default: open any AI session and the sidebar browser tab opens with the effect, which plays as soon as the AI writes an HTML file.

It also lists itself under **Plugins → Discover**: the host half serves a format-1
market index at `/__dsh_swarm_rebuild__/market/index.json`, and the client half
resolves the real port from `/__endpoint` and registers it via
`pluginMarket.setIndexes()`, so no manual index source is needed and a port change
self-corrects. (The upstream catalog PR has not been filed yet, so other people
cannot find it there — see [docs/PUBLISH.md](docs/PUBLISH.md).) To verify, check that the sidebar tab shows the page (or the "waiting for the AI" screen) — that means the host route is up.

Requires a Harness build that exposes the web server service (`ctx.webServer`) and the sidebar browser tab.

### How it works

- **In-memory preview route**: the host half registers one prefix route, `/__dsh_swarm_rebuild__`, on the Harness web server and serves workspace files through it. HTML responses get a `<script>` tag for `runtime.js` injected **in memory only** — never written to disk, so it cannot pollute the user's source or break the AI's file-version guards.
- **Version fingerprint**: `/__version` is a fingerprint over every watched web asset, so any AI edit bumps it; the in-page runtime polls it and replays.
- **Alternate port**: `/__endpoint` returns the same preview on a second loopback port, because the built-in browser tab refuses the GUI's own port.
- **Auto-open**: the client half opens the sidebar tab once (with a success latch, so it does not pile up tabs) and re-registers the locally served market index so the URL stays valid if the port changes.
- **Runtime**: zero dependencies, no `chrome.*` APIs, no audio; it snapshots the page by cloning the live DOM instead of screenshotting.

### Repository layout

| File | Purpose |
| --- | --- |
| `index.js` | Host half. Registers the `/__dsh_swarm_rebuild__` prefix route and serves workspace files, injecting the runtime script into HTML in memory; also serves `/__endpoint`, `/__version`, `/__runtime.js` and `/market/index.json` (a format-1 plugin-market index so the plugin can list itself). |
| `client.js` | Client half. Opens the preview in the right sidebar's browser tab (default-on for every session) and re-registers the locally served market index so the URL stays valid if the port changes. |
| `runtime.js` | The in-page runtime delivered to the developing page. Snapshots the page with `captureModel()`, blanks it, rebuilds it with the cursor swarm, then restores the real page. Zero dependencies, no `chrome.*` APIs, no audio. |
| `cordis.patch.yml` | Bundle patch that inserts the plugin into a DSH profile. |
| `locale/en.json`, `locale/zh.json` | Plugin title and description shown in the Harness UI and plugin market. |
| `icon.svg`, `assets/icon-180.png` | Plugin icon (SVG for the app, 180px PNG for the storefront). |
| `package.json` | `dsh-swarm-rebuild`, version 3.2.0, declares `dsh.bundle.patch` and `dsh.client`. |

### Configuration

| Item | Meaning |
| --- | --- |
| `SWARM_REBUILD_ROOT` | Optional environment variable that pins the directory whose web pages are previewed (defaults to the grandparent of the installed plugin directory, i.e. the workspace root). |
| Default state | The effect is default-on; installation is all it takes, no per-session switch. |

### Troubleshooting

- **The tab only shows "waiting for the AI to build a webpage"**: there is no HTML file in the workspace yet. It refreshes by itself once the AI writes one.
- **The tab shows a stopped port / failed to load**: the preview port changed. Reopen the preview (or restart the install / Harness) and the client half fetches `/__endpoint` again and opens the new address.
- **No effect at all**: JavaScript must be enabled in the preview; the runtime is an injected script, and a JS-less preview shows a static page.
- **Edited a page but it did not replay**: the fingerprint is polled every few seconds — wait a moment, and make sure the edit touched a watched web asset (HTML / CSS / JS / image).

### Credits

The animation design and engine come from the open-source **swarm-cursors** project by DhvanilPatel ([github.com/DhvanilPatel/swarm-cursors](https://github.com/DhvanilPatel/swarm-cursors)), itself a tribute to **Swarm** by Joel Califa. This repository is a faithful port of that choreography; its own contribution is only: (a) making it run as a DSH plugin with no Chrome extension APIs, (b) the in-memory preview server, (c) the auto-open and auto-replay wiring, and (d) the synthesized guides that let rulers and red guides appear even on pages with no natural alignment. **No audio is included** — the original sound design was not ported.

### License

MIT. See [LICENSE](LICENSE).
