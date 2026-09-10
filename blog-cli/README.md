# 绝顶赵博客 · 命令行发文工具（blog-cli）

> **本文档的第一读者是 AI。**
> 站长把发文这件事交给 AI：**Markdown 丢进来 → 网页生成 → 首页更新 → 推送上线**，全程一条命令。
> 人也能用（跑 `./blog.js` 进交互界面），但那是次要用法，见第 10 节。

---

## 0 · 一句话上手

```bash
node /root/workspace/syxph/blog-cli/blog.js post --md ./article.md --push --json
```

这一条命令会依次做完：

1. 把稿子存成草稿（`blog-cli/drafts/`，**不入库**）
2. 生成文章页 `专栏/xxx.html`
3. 更新首页 `index.html`：文章列表插到最前 + 归档筛选器月份篇数重算
4. `git add / commit / push` → Cloudflare Pages 自动部署（**约 1–2 分钟生效**）

---

## 1 · AI 标准工作流（照抄即可）

### 第 1 步：写稿

一个 Markdown 文件，**开头是可选的 frontmatter**：

````markdown
---
title: 文章标题              # 必填（没有会报错）
date: 2026-09-10            # 可选，默认今天
sub: 副标题                  # 可选
summary: 首页列表那行摘要      # 可选，默认取 sub 或 title
badge: 社群专享              # 可选，黄色标签
series: 获得执行力 · 中        # 可选，系列标识
file: 自定义文件名.html        # 可选，默认由 title 生成
prev: 专栏/上一篇.html        # 可选，系列导航
prevTitle: 上一篇标题
next: 专栏/下一篇.html
nextTitle: 下一篇标题
accent: 加粗强调的几个字        # 可选，标题里实心黄
---

正文从这里开始……

## 章节标题

正文内容。**加粗**、`行内代码`、==高亮==、++关键词++。

> 一句话金句 → 渲染成金句卡

```bash
echo "代码块会自动挂「复制」按钮"
```
````

### 第 2 步：发文上线

```bash
node /root/workspace/syxph/blog-cli/blog.js post --md ./article.md --push --json
```

### 第 3 步：校验（建议每次都做）

```bash
# 看首页文章列表里有没有它、编号对不对
node /root/workspace/syxph/blog-cli/blog.js list --json

# 看草稿状态（已发布 / 页面已生成 / 纯草稿）
node /root/workspace/syxph/blog-cli/blog.js drafts --json
```

上线后再抓一次线上页面确认渲染（Cloudflare 约 1–2 分钟）：

```bash
curl -sSL "https://www.363749768.xyz/专栏/你的文章.html" | head -40
```

> 中文文件名要 URL 编码；Cloudflare 会把 `.html` 308 重定向成 clean URL，所以 curl 记得加 `-L`。

### 第 4 步：出错怎么办

| 情况 | 处理 |
|---|---|
| 还没推送就发现稿子有问题 | 改稿后**重跑同一条 post 命令**即可（同名草稿与页面会被覆盖，首页不会重复插入） |
| 已经推送但内容要改 | 改草稿 → `publish <id> --push --json` |
| 要撤下首页（页面文件保留） | `unpublish --href 专栏/xxx.html --json` |
| 要彻底删掉（页面 + 首页条目 + 草稿） | `rm <id> --json` |
| 只想先看渲染效果、不碰仓库 | `preview <id> --out /tmp/x.html --json` |

---

## 2 · 命令总表

所有命令都支持 `--json`。别名写在括号里。

### 查看类

| 命令 | 说明 |
|---|---|
| `list`（`ls`） | 列出首页已发布文章（编号 / 标题 / 日期 / 路径 / 页面文件是否存在） |
| `drafts`（`d`） | 列出草稿箱，含每篇的状态：`已发布` / `页面已生成·未上首页` / `草稿` |
| `show <id>` | 查看草稿全文（元信息 + 正文），JSON 模式返回 `meta` 与 `body` |
| `status`（`st`） | 仓库状态：分支、远端、未提交文件、已发布篇数、草稿篇数 |
| `doctor` | 环境自检：仓库根目录 / index.html / 文章模板.html / 专栏/ / admin/md.js / git 远端 / 草稿目录 / 编辑器 |

### 写作类

| 命令 | 说明 |
|---|---|
| `new --title "标题" [...]`（`n`） | 新建草稿（**只建草稿，不发布**）。加 `--edit` 会打开 `$EDITOR`（AI 不要用） |
| `edit <id>`（`e`） | 用 `$EDITOR` 编辑草稿正文（**AI 不要用**，会卡住） |
| `set <id> --badge "社群专享"` | 改草稿元信息；也可用 `--body "新正文"` 换正文 |
| `preview <id> [--out f.html]` | 渲染成 HTML 预览，**不写进仓库**（默认落在 `blog-cli/tmp/`） |

### 发布类

| 命令 | 说明 |
|---|---|
| `post --md 文章.md [--push]` | **一步发文**：建草稿 → 生成页面 → 更新首页 → 可选推送 |
| `publish <id> [--push]`（`pub`） | 发布已有草稿（重新发布会覆盖同名页面并在首页原位替换） |
| `unpublish --href 专栏/x.html`（`off`） | 从首页下线，**页面文件保留** |
| `rm <id>`（`remove`/`del`/`delete`） | 删除草稿 + 专栏页面 + 首页条目（**破坏性**） |
| `push [-m "提交信息"]`（`deploy`） | 手动 git add / commit / push（`post`/`publish` 自带 `--push`，一般不需要单独用） |
| `help` | 显示内置帮助 |

**`<id>` 支持模糊匹配**：精确 id → id 包含 → 标题包含。命中多篇会报错并列出候选，这时写精确一点。

---

## 3 · 参数详解

### 3.1 全局参数

| 参数 | 说明 |
|---|---|
| `--json`（`-j`） | 机器可读输出。**AI 一律加上** |
| `--root <目录>` | 指定博客仓库根目录（默认 `/root/workspace/syxph`；也认环境变量 `BLOG_ROOT`） |
| `-h` / `--help` | 显示帮助 |

> ⚠️ **`-h` 是 help，不是 href。** 下线文章要用 `--href`。

#### ⚠️ 参数解析陷阱（**AI 最容易踩**）

解析规则是 `--key value` 或 `--key=value`：**开关后面紧跟的第一个普通词会被当成它的值吞掉**。
所以「位置参数（草稿名 / 文件名）要写在选项前面」，开关建议一律写 `--key=value`。

实测（同一个 `show` 命令，三种写法）：

```bash
# ✅ 位置参数在前 —— 正常
node blog.js show 如何一键创建一个AI知识库 --json          # 退出码 0

# ✅ 开关写成 =true —— 也正常
node blog.js show --json=true 如何一键创建一个AI知识库      # 退出码 0

# ❌ 开关在前、裸位置参数在后 —— 草稿名被 --json 吞掉
node blog.js show --json 如何一键创建一个AI知识库
# → {"ok": false, "error": "缺少草稿名"}   退出码 1
```

同理 `post --push article.md` 会把 `article.md` 当成 `--push` 的值。
**安全习惯：`<命令> <位置参数> --选项=值`。**

### 3.2 正文来源（`post` / `new`）

| 参数 | 含义 |
|---|---|
| `--md <文件>` | Markdown 文件，**可带 frontmatter**（推荐） |
| `--body-file <文件>` | 纯正文文件（无 frontmatter） |
| `--body-stdin` | 从标准输入读正文 |
| `--body "文本"` | 直接把正文作为字符串 |

优先级：`--md` → `--body-file` → `--body-stdin` → `--body`（后者覆盖前者的正文部分）。

也支持**位置参数当标题**：`post "文章标题" --body-stdin --push --json`。

### 3.3 元信息参数（小写即可）

`--title` `--sub` `--badge` `--series` `--date` `--summary` `--file` `--accent` `--prev` `--prevtitle` `--next` `--nexttitle` `--id`

- `--id` = 草稿文件名（默认由标题生成）
- 命令行参数**覆盖** frontmatter 里的同名字段

### 3.4 命令专属参数

| 命令 | 参数 |
|---|---|
| `post` | `--md` / `--body-file` / `--body-stdin` / `--body` / 元信息 / `--id` / `--no-publish`（只存草稿不发）/ `--push` |
| `new` | 同上 + `--edit` |
| `publish` | `--push` |
| `unpublish` | `--href 专栏/x.html`（或 `--id <草稿id>`） |
| `preview` | `--out <文件>` |
| `push` | `-m "提交信息"` / `--message` |

---

## 4 · 输出契约（`--json`）

### 4.1 成功 / 失败

**成功**：stdout 一个 JSON 对象，含 `"ok": true`，退出码 `0`。

**失败**：stdout 输出 `{"ok": false, "error": "错误原因"}`，**退出码 `1`**。
（不加 `--json` 时错误走 stderr，前缀 `错误：`。）

未知命令 → 退出码 `1` + 打印帮助。

### 4.2 各命令返回结构

```jsonc
// post —— 一步发文
{
  "ok": true,
  "id": "文章标题",                    // 草稿 id
  "published": true,                  // false = 用了 --no-publish
  "pushed": {                         // 没加 --push 时为 null
    "ok": true,
    "commit": "git commit 输出",
    "push": "git push 输出",
    "nothing": false                  // true = 没有需要提交的改动
  },
  "article": {
    "id": "...", "title": "...",
    "file": "文章标题.html",
    "href": "专栏/文章标题.html",       // ← 首页里的链接
    "target": "/root/workspace/syxph/专栏/文章标题.html",
    "backup": "/root/workspace/syxph/blog-cli/backups/index-20260910-....html",
    "indexCount": 9                   // 更新后首页文章总数
  }
}

// publish —— 与 post 的 article 字段同级展开
{ "ok": true, "id": "...", "title": "...", "file": "...", "href": "专栏/x.html",
  "target": "...", "backup": "...", "indexCount": 9, "pushed": null }

// list
{ "ok": true, "count": 8, "articles": [ { "num":"01", "title":"...", "badge":"...",
  "series":"...", "date":"2026-09-09", "month":"2026-09", "href":"专栏/x.html",
  "summary":"...", "pageExists":true, "hasSource":true } ] }

// drafts
{ "ok": true, "count": 4, "drafts": [ { "id":"...", "title":"...", "date":"...",
  "badge":"...", "series":"...", "file":"...", "href":"专栏/x.html",
  "pageExists":true, "published":true, "bytes":28941 } ] }

// show
{ "ok": true, "id": "...", "meta": { ... }, "body": "正文 Markdown", "raw": "含 frontmatter 的原文" }

// preview
{ "ok": true, "id": "...", "preview": "/root/workspace/syxph/blog-cli/tmp/xxx.html" }

// set
{ "ok": true, "id": "...", "meta": { ...改完之后的全部元信息... } }

// unpublish —— unchanged 为 true 时表示首页本来就没有这篇（此时没有 backup/count）
{ "ok": true, "href": "专栏/x.html", "unchanged": false,
  "backup": "/root/workspace/syxph/blog-cli/backups/index-....html", "count": 8 }

// doctor —— checks 是逐项自检结果
{ "ok": true, "checks": [ { "name": "仓库根目录", "ok": true, "detail": "/root/workspace/syxph" },
  { "name": "index.html", "ok": true, "detail": "存在" }, /* ... */ ] }

// rm
{ "ok": true, "id": "...", "href": "专栏/x.html" }

// status
{ "ok": true, "root": "...", "branch": "master", "remote": "https://github.com/...",
  "dirty": [ "M index.html" ], "published": 8, "drafts": 4, "cliDir": "..." }

// push（无改动时）
{ "ok": true, "nothing": true, "branch": "master" }
```

### 4.3 退出码

| 码 | 含义 |
|---|---|
| `0` | 成功（`push` 遇到"没改动"也算成功，返回 `nothing: true`） |
| `1` | 任何错误：找不到草稿、缺标题、正文为空、git 失败、非交互环境跑了 TUI 等 |

---

## 5 · 副作用清单（它到底改了什么）

`post` / `publish` 只动这些地方：

| 路径 | 动作 | 入库？ |
|---|---|---|
| `blog-cli/drafts/<id>.md` | 写草稿（`post` 时） | 🚫 已 gitignore |
| `专栏/<file>.html` | 生成/覆盖文章页 | ✅ 入库 |
| `index.html` | ① `.article-list` 里**插到最前**（同 `href` 会先剔除再插，**不会重复**）② `#af-body` 归档筛选器重算月份与篇数 | ✅ 入库 |
| `blog-cli/backups/index-<时间戳>.html` | 改 `index.html` 前自动备份，**只留最近 30 份** | 🚫 已 gitignore |
| `blog-cli/tmp/<file>.html` | `preview` 的预览产物 | 🚫 已 gitignore |

**其它任何文件都不动。** 页面正文只替换模板里 `<!-- 从这里开始写 -->` 到 `<!-- 写到这里结束 -->` 之间的内容，系列导航整块替换，其余（导航、联系区、样式、脚本）原样保留。

**幂等性**：同一篇文章重复 `post` / `publish`，首页里始终只有一条（按 `href` 去重），编号会整体重排。

---

## 6 · Markdown 语法（站点专属）

解析器是仓库自带的 `admin/md.js`，**CLI 发布 = 网页后台发布**，两边产物完全一致。

### 6.1 块与行内

| 写法 | 渲染成 |
|---|---|
| `## 章节` / `### 分节` | section-heading / sub-heading |
| `**加粗**` `==高亮==` `++关键词++` `\`代码\`` | 对应站点样式 |
| `> 一句话` | quote-block 金句卡 |
| `::: quote / qa / case / framework / highlight / formula / note` … `:::` | 站点卡片块（`note` 渲染成结尾预告 footer-note） |
| `\`\`\`` + 内容 + `\`\`\`` | formula-block 代码块 |
| `| 表格 |` | article-table-wrap 表格（黄表头，移动端横向滚动） |
| `---` | 分隔线 |
| `- 列表` / `1. 编号` | 黄方块列表 / 黄角标编号列表 |

正文里可以直接写 HTML（Lucide 图标等原样透传）。

### 6.2 「复制」按钮规则（**重点**）

只有 `formula-block` 这一类块会挂右上角「复制」按钮，**引用块 / 金句卡 / 问答卡 / 框架卡从来不挂**。

| 写法 | 输出 | 复制按钮 |
|---|---|---|
| `\`\`\`安装命令` | `formula-block` | ✅ 挂 |
| `\`\`\`安装命令 nocopy` | `formula-block no-copy` | ❌ 不挂 |
| `::: code 标题` | `formula-block` | ✅ 挂 |
| `::: formula 公式` / `::: 公式` | `formula-block no-copy` | ❌ 不挂 |
| `> 金句` / `::: quote` / `::: 金句` | `quote-block` | ❌ 从不挂 |

**判据**：默认「挂」，因为它默认是**拿来用的**东西；下列内容请**主动加 `nocopy`**：

- 目录树、文件结构示意（`安装包结构`）
- 只是给人看的片段（例如"方案 A / 方案 B 二选一"里的 JSON 片段 —— 整段粘进文件会坏）
- 任何"看着像代码、其实不该被整段拿走"的内容

**复制内容 = 块正文，不含块标题**（标题只是页面上的标签，不会进剪贴板）。

### 6.3 硬性约定

1. **禁止 emoji**（全站约定，任何新内容都不许出现 emoji 字符）
2. **新文章默认不加付费推广块**（`promo-block` 锦囊妙计 / 微信引导 / "请联系我"这类话术一律不加）；联系方式在首页联系区，读者自己会找。`footer-note` 预告可以留
3. **文件名里不要用全角冒号「：」和全角问号「？」**——CDN clean URL 会出问题（踩过坑）。CLI 会自动替换成 `-`，但别依赖它
4. 文章正文只写在该写的地方，不要给正文加 `reveal` 动画类（长文首屏会全透明，历史事故）

---

## 7 · 排错手册

| 报错 / 现象 | 原因 | 处理 |
|---|---|---|
| `缺少标题：用 --title ... ` | frontmatter 没有 `title`，命令行也没给 | 补 `title` 或加 `--title "..."` |
| `正文为空：...` | 四个正文来源都没给到内容 | 检查 `--md` 路径（相对路径按**当前工作目录**解析） |
| `找不到草稿：xxx` | id 写错 | `drafts --json` 看真实 id |
| `匹配到多篇草稿，请写得更精确` | 模糊匹配命中多篇 | 用完整 id |
| `根目录下找不到 文章模板.html` / `index.html 中找不到文章列表容器` | `--root` 指错，或 index.html 结构被改坏 | 用 `doctor --json` 定位 |
| `index.html 中找不到文章列表容器` | 首页的 `.article-list` 或 `#af-body` 被改名/删除 | 从 `blog-cli/backups/` 拷一份回来 |
| 推送失败（TLS / gnutls / unexpected eof） | **网络抖动**，不是配置错 | 重跑一次；连续失败再看 `git remote -v` |
| `当前不是交互式终端，已显示帮助` | 不带子命令跑了 `./blog.js` | 改用子命令（AI 永远别跑裸 `./blog.js`） |
| 线上还是旧版 | Cloudflare 还在部署 | 等 1–2 分钟重试；中文路径记得 URL 编码 + `curl -L` |

**回滚**：`blog-cli/backups/` 里是每次改首页前的快照，直接拷回去覆盖 `index.html` 即可。

---

## 8 · 给 AI 的安全规程

**必须遵守：**

1. **永远带子命令 + `--json`**；绝不要跑不带参数的 `./blog.js`（会进 TUI，非交互环境下报错退出）
2. **不要用 `edit` / `new --edit`**（会打开 `$EDITOR` 卡住）
3. **破坏性命令先确认**：`rm`（删草稿+页面+首页条目）、`unpublish`（撤下首页）—— 除非用户明确要求，不要主动跑
4. **不确定就先 `preview`**，它在 `blog-cli/tmp/` 出 HTML，不碰仓库
5. **`--push` 是上线动作**：它会把改动推到 GitHub，Cloudflare 随即部署到公网。内容检查无误再推
6. **布尔开关放最后**，或写成 `--flag=true`（避免吞掉位置参数）
7. 一次只改一篇文章；改完用 `list --json` 复核首页条目与编号

---

## 9 · 目录与配置

```
blog-cli/
├── blog.js        # 主程序（单文件，零依赖，Node 14+）
├── config.json    # 配置（入库）
├── README.md      # 本文档（入库）
├── drafts/        # 草稿 Markdown（不入库）
├── backups/       # 首页快照，留最近 30 份（不入库）
└── tmp/           # preview 产物（不入库）
```

`config.json`：

```json
{
  "root": "/root/workspace/syxph",
  "draftsDir": "drafts",
  "editor": "vim"
}
```

- `root` 也可以用 `--root` 或环境变量 `BLOG_ROOT` 覆盖；都没给时会自动在几个常见位置探测（找同时含 `index.html` 和 `文章模板.html` 的目录）
- 想让 CLI 和网页后台 `admin/` 共用同一批草稿，把 `draftsDir` 设成 `/root/workspace/syxph/admin/data/drafts`

**设计前提**：CLI 不改动博客仓库的任何既有文件（除了 `专栏/` 与 `index.html`），发布管线与 `admin/server.js` 共用同一套 `文章模板.html` + `admin/md.js`，所以「CLI 发布 = 后台发布」，两边混用不会打架。

---

## 10 · 给人用：交互式 TUI（AI 请跳过本节）

```bash
cd /root/workspace/syxph/blog-cli && ./blog.js
```

```
┌─ 绝顶赵博客 · 管理终端 ─────────────────┐
│ ▸ 新建文章      草稿箱              1 │
│   已发布文章     Git 推送上线          │
│   仓库状态       环境自检 / 设置        │
└────────────────────────────────────────┘
  ↑↓/jk 选择 · 数字键跳转 · Enter 进入 · q 退出
```

| 键 | 作用 |
|---|---|
| `↑` `↓` / `k` `j` | 上下移动 |
| `Enter` | 进入 / 编辑 |
| `1`–`9` | 跳到第 N 项 |
| `q` / `Esc` | 返回上一级 |
| `Ctrl+C` | 退出 |

> 中文输入提示：TUI 表单在 raw 模式下工作，中文输入法的**预编辑（拼音）过程不回显**。中文元信息建议用命令行传参，或直接用网页后台。

---

## 11 · 从 Windows 侧调用（WSL）

```bash
wsl.exe -d Ubuntu-D -- bash -lc 'cd /root/workspace/syxph/blog-cli && node blog.js post --md /tmp/article.md --push --json'
wsl.exe -d Ubuntu-D -- bash -lc 'cd /root/workspace/syxph/blog-cli && node blog.js drafts --json'
```

---

## 12 · 已知行为与边界

- `set` 改写草稿时会**规整正文开头的空行**（内容无损，只是排版归一化）
- `post` 不带 `--push` 时只改本地仓库，**不会上线**；带 `--no-publish` 则连页面都不生成，只存草稿
- `publishDraft` 里若缺 `summary`，会用 `sub` 兜底，再没有就用标题
- 文章页的归档月份取自 `date` 的 `YYYY-MM`；没写 `date` 时默认今天
- `preview` 用的是**当前草稿 + 仓库模板**渲染，与 `publish` 产物同源，可放心当"发布前预演"
