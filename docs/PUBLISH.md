# 把 Swarm Rebuild 发布到 dsh-market 插件市场（让别人也能装）

当前工作区里装的是本地链接版 `@local/swarm-rebuild`（`source: link:...`）——它是从
`个人工作区/swarm-rebuild-plugin/` 软链进 profile 的，**只有这台机器能用**。
要"让别人也能装"，必须把它变成一个真实的公开包，并让官方目录收录它。

本目录 `swarm-rebuild-publish/` 已经是一份**可直接 `git push` 的公开版**：
代码与本机插件完全一致，只是把包名改成了 `dsh-swarm-rebuild`、去掉了 `private:true`、
补了 `description` / `repository` / `license`，并附上了提 PR 用的 yml 与商店图标。
你只需要把 `OWNER` 换成自己的 GitHub 用户名。

> 当前 GUI 端口是 `http://127.0.0.1:50993`（会随会话变化）；插件自动用
> `GUI 端口 + 1` 作为预览端口，不依赖任何写死的端口。代码里残留的 `50993`
> 只是"拿不到运行时端口时"的最后兜底，对别人机器没有影响。

---

## 第 0 步：替换占位符（必做）

把本目录里以下位置的 `OWNER` 全部换成你的 GitHub 用户名（例如 `zhangsan`）：

| 文件 | 字段 |
| --- | --- |
| `package.json` | `repository.url` |
| `data/plugins/OWNER__dsh-swarm-rebuild.yml` | `url`、`name`、`icon` 三处 |
| `data/plugins/OWNER__dsh-swarm-rebuild.yml` | **文件名本身**改为 `zhangsan__dsh-swarm-rebuild.yml` |

一次性替换（在 `swarm-rebuild-publish/` 目录执行）：

```bash
OWNER=zhangsan   # 改成你自己的
grep -rl OWNER . | xargs sed -i '' "s/OWNER/$OWNER/g"
mv data/plugins/OWNER__dsh-swarm-rebuild.yml data/plugins/${OWNER}__dsh-swarm-rebuild.yml
```

---

## 第 1 步：建公开 GitHub 仓库并推上去

```bash
cd swarm-rebuild-publish
git init
git add .
git commit -m "Swarm Rebuild: multi-cursor 'AI builds the page' effect"
git branch -M main
git remote add origin https://github.com/OWNER/dsh-swarm-rebuild.git
git push -u origin main
```

在 GitHub 仓库设置里：

- 设为 **Public**；
- 加 topic：**`dsh-plugin`**（CI 会检查，没有会被打回）；
- 仓库必须**创建满 1 天**才能通过 CI（防刷，等一天再提 PR）。

---

## 第 2 步：确认包"可安装"（最常见被拒原因）

`package.json` 必须**同时**声明 `dsh.bundle` 和 `dsh.client`——本目录已经带好：

```json
{
  "name": "dsh-swarm-rebuild",
  "version": "3.2.0",
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "platform": "web", "immediately": true, "inject": [ ... ] }
  }
}
```

`cordis.patch.yml`：

```yaml
- insert:
    - id: swarm-rebuild
      name: 'dsh-swarm-rebuild'
```

**只写 `dsh.client` 而没写 `dsh.bundle` = 不可安装，会被直接打回**（官方贡献指南
明确说这是最常见的拒因）。本包两者齐全，CI 第一关能过。

---

## 第 3 步（可选）：同时发到 npm

```bash
npm publish --access public
```

这一步**不是必须的**：官方 `contributing.md` 原文是 "listing is unaffected either
way, and plugins install from GitHub exactly as before" —— 不发 npm，别人一样能从
GitHub 安装，只是商店里没有下载量数字。

如果发了 npm：

- `package.json` 的 `repository` 必须指回第 1 步的 GitHub 仓库（已填好，改 OWNER 即可）；
- **不要在 yml 里手写 `npm:` 键**（会被拒，系统会自动关联）；
- 好处只是商店能显示/排序下载量。

---

## 第 4 步：提 PR 到官方目录（只加 1 个文件）

官方目录仓库：<https://github.com/awesome-dsh-plugin/awesome-dsh-plugin>
权威规则见它的 `contributing.md`。**README 是自动生成的，不要手改**。

fork 之后，**只新增** `data/plugins/OWNER__dsh-swarm-rebuild.yml`（本目录已经写好，
直接拷进去即可）：

```yaml
url: https://github.com/OWNER/dsh-swarm-rebuild
name: OWNER/dsh-swarm-rebuild
category: ui
description:
  en: 'Rebuilds a developing webpage with a swarm of multiplayer cursors, like a team of agents coding it together: eight to sixteen named cursors fly in from both edges, each drags a 1px selection frame out over a real block, types its text character by character with an I-beam cursor, then drifts on in curving flocking flight; the finished page is left completely clean and everything replays once on every change.'
  zh: '用一群「多人协作光标」重建正在开发的网页，像多个智能体协同开发：八到十六个带名字的光标从屏幕两侧飞入，各自拉出 1px 选框框住真实元素、切换成 I 形光标逐字打出文字，然后继续成群沿弧线游走；建完只留下干净的成品页面，每次改动重播一次。'
icon: https://raw.githubusercontent.com/OWNER/dsh-swarm-rebuild/main/assets/icon-180.png
```

规则要点：

- `category` 必须是：`agi ui usage theme model identity session memory tools wsl
  browser vision voice docs skill workflow git notify dev security remote market fun`
  之一（本插件用 `ui`）；
- 只有 `description.en` **必填**，且**以句号结尾**；描述里含 `: ` 时必须用引号包住；
- `description` 必须与代码**实际行为一致**（官方会核对，夸大是主要拒因）；
- `icon` 只能是 GitHub 托管的 **png/jpg/jpeg/webp** 位图。本目录已用 `sips` 把
  `icon.svg` 转成 `assets/icon-180.png`（180×180 PNG）——**直接用它**；SVG 或第三方
  图床会被拒；不写这行则回退到你的头像；
- 一个 PR **最多加 3 个条目**；被打上 `held: author` 只是要求修改，**不是拒绝**，
  在原分支补提交 + 留一条评论即可。

CI 检查顺序：条目数 ≤3 → `dsh.bundle` 存在 → 仓库满 1 天 → `awesome-lint` + 站点构建。

---

## 第 5 步：合并后别人怎么装

合并后网站自动重建，所有人就能在 **dshmarket / Plugins → Discover** 里搜到并安装：

```
dsh plugin add dsh-swarm-rebuild
```

或在 Discover → **Index sources** 里加官方公开索引（任选其一）：

```
https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json
https://awesome-dsh-plugin.com/index.json
https://dshmarket.com/index.json
```

---

## 关于"别人机器上根目录怎么找"（已处理，重要）

本地链接版靠 `import.meta.url` 的祖父目录 = 工作区根目录来定位要预览的网页。
但**市场安装是把包真实拷贝进 `profile/node_modules/dsh-swarm-rebuild/`**，祖父目录是
`node_modules`，不是项目根目录。为此本版做了两件事（都已在本机模拟市场安装验证通过）：

1. `discoverRoot()` 会**跳过 `node_modules` 祖父目录**，并支持环境变量
   `SWARM_REBUILD_ROOT=<项目根目录>` 显式指定；
2. 启动后若初始根目录里没有 HTML，`fs/observed` 收到 AI 的**第一次 HTML 写入**时，
   会自动向上找最近的、含 HTML 页面的祖先目录，把它采纳为项目根目录——
   所以别人在自己的项目里写 `index.html` 时，插件会自动"跟到"那个项目，无需配置。

若想完全跳过自动探测，可在启动 Harness 前设置：

```bash
SWARM_REBUILD_ROOT=/path/to/your/project dsh web
```

---

## 路线 B：只发自己的 format-1 索引（不进官方目录）

只想让团队内部装的话，可以自己托管一个 format-1 `index.json`，让别人在
**Plugins → Discover → Index sources** 加这个 URL。本包 `index.js` 已内置
`GET /__dsh_swarm_rebuild__/market/index.json` 路由（把地址换成那台机器的
http(s) 地址即可）。缺点：得自己维护一个公网可访问的地址。

### 你本机现有的"本地市场"条目（仅本机可见）

`/Users/xixi/.dsh/profiles/desktop/cordis.patch.yml` 的
`- id: plugin-market / config.indexes` 下已经加过：

```
http://127.0.0.1:50994/__dsh_swarm_rebuild__/market/index.json
```

注意这里用的是**预览端口**（`GUI 端口 + 1`），不是 GUI 自己的端口；插件把
market 索引挂在同一条 `__dsh_swarm_rebuild__` 路由上，两个端口都能访问。
它证明"上架 → Discover 可见"这条链路是通的，但别人访问不到 `127.0.0.1`，
所以真正公开仍要走第 1–5 步。port 若变不用手改：`client.js` 会从
`/__endpoint` 重新解析真实端口并自动把旧端口条目从索引列表里清掉。

---

## 改包名后的兼容性说明

- 公开版包名 `dsh-swarm-rebuild`，本地链接版 `@local/swarm-rebuild`，**两者可共存**，互不冲突；
- `SKIP` 集合里残留的字面量 `'swarm-rebuild-plugin'` 只会在扫描 HTML 时跳过同名目录，
  无害；
- 本机正在用的那份不受影响，无需重装（除非你也在本机改了 `index.js` 的移植性逻辑）。
