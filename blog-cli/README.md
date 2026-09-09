# 绝顶赵博客 · 命令行管理终端（blog-cli）

给 `syxph` 博客仓库配的一个**零依赖命令行工具**。同一个脚本两种用法：

- **给人**：直接跑 `./blog.js` → 全屏 TUI，方向键选菜单，不用记命令
- **给 AI**：`./blog.js post --md 文章.md --push --json` → 一步发文上线，输出 JSON 可直接解析

设计前提（重要）：

- **不改动博客仓库的任何既有文件**。草稿、备份、预览全部落在本目录（`drafts/`、`backups/`、`tmp/`）
- 发布管线与网页后台 `admin/server.js` **完全一致**（同一套 `文章模板.html` + `admin/md.js`），保证「CLI 发布 = 后台发布」，两边混用不会打架
- Markdown 解析器直接 `require` 仓库自带的 `admin/md.js`，不复制一份，永远跟仓库同步
- 零 npm 依赖，Node 14+ 即可（WSL 里 `/usr/bin/node` 或 nvm 的 node 都行）

---

## 一、给人用：交互式 TUI

```bash
cd /root/workspace/syxph/blog-cli
./blog.js                 # 或 node blog.js
```

```
┌─ 绝顶赵博客 · 管理终端 ─────────────────────────────┐
│                                                     │
│ ▸ 新建文章                                          │
│   草稿箱                                          1 │
│   已发布文章                                      7 │
│   Git 推送上线                                      │
│   仓库状态                                          │
│   环境自检 / 设置                                   │
│   退出                                              │
└─────────────────────────────────────────────────────┘
  ↑↓/jk 选择 · 数字键跳转 · Enter 进入 · q 退出
```

操作键位：

| 键 | 作用 |
|---|---|
| `↑` `↓` 或 `k` `j` | 上下移动 |
| `Enter` | 进入 / 编辑当前项 |
| `1`–`9` | 直接跳到第 N 项 |
| `q` 或 `Esc` | 返回上一级 |
| `Ctrl+C` | 退出 |

功能路径：

- **新建文章** → 填元信息表单（标题/副标题/标签/系列/日期/摘要/文件名/上下篇）→ 自动打开 `$EDITOR` 写正文 → 可选预览 / 发布
- **草稿箱** → 编辑正文 / 改元信息 / 生成预览 HTML / 发布 / 下线 / 删除
- **已发布文章** → 从首页下线、查看文件路径
- **Git 推送上线** → 显示未提交文件 → 填提交信息 → add/commit/push
- **仓库状态 / 环境自检 / 设置** → 分支、远端、未提交数、篇数；可改仓库根目录、草稿目录、编辑器

> 中文输入提示：TUI 表单在 raw 模式下工作，中文输入法能打但**预编辑（拼音）过程不回显**。中文元信息建议用命令行传参（`./blog.js set <id> --title "中文标题"`），或继续用网页后台。

---

## 二、给 AI 用：子命令

所有命令都支持 `--json`，建议 AI 一律带上，输出稳定可解析。出错时退出码为 `1`，并输出 `{"ok":false,"error":"..."}`。

### 一步发文（最常用）

```bash
./blog.js post --md ./article.md --push --json
```

`article.md` 可以是带 frontmatter 的完整稿：

```markdown
---
title: 为什么我们无法行动？
sub: 行动力缺失的真正根源
badge: 社群专享
series: 获得执行力 · 中
date: 2026-09-09
summary: 首页列表那行摘要
---

## 章节标题

正文，**加粗**、`代码`、==高亮==、++关键词++……

> 金句

::: qa 这里是问题？
这里是答案
:::
```

也可以不带 frontmatter，用参数补：

```bash
./blog.js post --body-file ./article.md --title "文章标题" --badge "社群专享" --push --json
cat article.md | ./blog.js post --title "文章标题" --body-stdin --push --json
```

返回：

```json
{
  "ok": true, "id": "文章标题", "published": true,
  "pushed": { "ok": true, "commit": "...", "push": "..." },
  "article": { "title": "...", "href": "专栏/xxx.html", "indexCount": 8, "backup": "..." }
}
```

### 命令表

| 命令 | 说明 |
|---|---|
| `list` | 列出首页已发布文章 |
| `drafts` | 列出草稿箱 |
| `show <id>` | 查看草稿（元信息 + 正文） |
| `new --title "标题" [--edit]` | 新建草稿 |
| `edit <id>` | 用 `$EDITOR` 编辑正文 |
| `set <id> --badge "社群专享" ...` | 修改草稿元信息 |
| `post --md f.md [--push]` | 建草稿 + 生成页面 + 更新首页 + 可选推送 |
| `publish <id> [--push]` | 发布已有草稿 |
| `unpublish --href 专栏/x.html` | 从首页下线（页面文件保留） |
| `rm <id>` | 删除草稿 + 专栏页面 + 首页条目 |
| `preview <id> [--out f.html]` | 渲染成 HTML 预览，**不写进仓库** |
| `push [-m "提交信息"]` | git add / commit / push |
| `status` | 分支、远端、未提交文件、篇数 |
| `doctor` | 环境自检 |
| `help` | 帮助 |

`<id>` 支持**模糊匹配**：写草稿名或标题的一部分即可，比如 `./blog.js publish "执行力"`。

### 正文来源（post / new 通用）

| 参数 | 含义 |
|---|---|
| `--md <file>` | Markdown 文件，可带 frontmatter |
| `--body-file <f>` | 纯正文文件（无 frontmatter） |
| `--body-stdin` | 从标准输入读 |
| `--body "文本"` | 直接给字符串 |

### 元信息参数

`--title` `--sub` `--badge` `--series` `--date` `--summary` `--file` `--accent`
`--prev` `--prevTitle` `--next` `--nextTitle` `--id`（指定草稿名）

### 全局参数

`--json`（机器可读输出）· `--root <目录>`（指定仓库根目录）· `-h`

---

## 三、从 Windows 侧让 AI 调用

```bash
wsl.exe -d Ubuntu-D -- bash -lc 'cd /root/workspace/syxph/blog-cli && node blog.js post --md /tmp/article.md --push --json'
```

或先把文章写进 WSL 再执行：

```bash
wsl.exe -d Ubuntu-D -- bash -lc 'cd /root/workspace/syxph/blog-cli && node blog.js drafts --json'
```

---

## 四、Markdown 语法速查（站点专属）

| 写法 | 渲染 |
|---|---|
| `## 章节` / `### 分节` | section-heading / sub-heading |
| `**加粗**` `==高亮==` `++关键词++` `` `代码` `` | 对应站点样式 |
| `> 一句话` | quote-block 金句卡 |
| `::: quote / qa / case / framework / highlight / formula / note` … `:::` | 站点卡片块 |
| ` ```lang ` | formula-block 代码块 |
| `\| 表格 \|` | article-table-wrap 表格 |
| `---` | 分隔线 |
| `- 列表` / `1. 编号` | 黄方块 / 黄角标列表 |

正文可直接写 HTML（Lucide 图标等会原样透传）。**禁止 emoji**（仓库约定）。

---

## 五、目录与配置

```
blog-cli/
├── blog.js        # 主程序（单文件，零依赖）
├── config.json    # 配置（仓库根目录 / 草稿目录 / 编辑器）
├── drafts/        # 草稿 Markdown（不进仓库）
├── backups/       # 每次改 index.html 前的自动备份（留最近 30 份）
└── tmp/           # preview 生成的预览 HTML
```

`config.json` 示例：

```json
{
  "root": "/root/workspace/syxph",
  "draftsDir": "drafts",
  "editor": "vim"
}
```

想和网页后台（`admin/`）共用同一批草稿，把 `draftsDir` 改成绝对路径
`/root/workspace/syxph/admin/data/drafts` 即可（该目录已在 `.gitignore` 里，不会入库）。

---

## 六、注意事项

1. **发布会自动备份 `index.html`** 到 `backups/`，出问题直接拷回去覆盖。
2. 文件名里的**全角冒号「：」和全角问号「？」会被自动替换**（CDN clean URL 踩过坑）。
3. 新文章**默认不加付费推广块**（仓库约定），末尾只保留 `footer-note` 预告。
4. `post` / `publish` 只写仓库里的 `专栏/xxx.html` 和 `index.html`；其余文件一律不动。
5. 想让 AI 全程无交互，记得所有命令都带 `--json`，并且不要让它跑不带参数的 `./blog.js`（会进 TUI 卡住）。
