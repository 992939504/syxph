#!/usr/bin/env node
/*
 * blog.js — 绝顶赵博客 · 命令行管理终端
 *
 * 定位：
 *   1) 给人用：无参数直接运行 → 全屏 TUI（方向键 + Enter 操作，零依赖）
 *   2) 给 AI 用：子命令 + 参数一步发文，所有命令支持 --json 机器可读输出
 *
 * 设计原则：
 *   - 零依赖（Node 14+，只用内置模块）
 *   - 不改动博客仓库的任何既有文件；草稿/备份/预览全部落在本 CLI 自己的目录
 *   - 发布管线与 admin/server.js 完全一致（同为 文章模板.html + md.js 驱动），
 *     _markdown 解析直接复用仓库自带的 admin/md.js，保证「CLI 发布 = 后台发布」
 *
 * 常用：
 *   ./blog.js                      启动交互式 TUI
 *   ./blog.js post --md a.md --push --json     AI 一步发文并推送
 *   ./blog.js list --json
 *   ./blog.js help
 */
'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { execFile, spawn } = require('child_process');

/* ============================================================
 * 常量 / 配置
 * ========================================================== */

const CLI_DIR = __dirname;
const CONFIG_FILE = path.join(CLI_DIR, 'config.json');
const DEFAULT_ROOT = '/root/workspace/syxph';

const CFG = {
    root: '',
    draftsDir: path.join(CLI_DIR, 'drafts'),
    backupsDir: path.join(CLI_DIR, 'backups'),
    tmpDir: path.join(CLI_DIR, 'tmp'),
    editor: process.env.EDITOR || 'vim',
    json: false,
};

let MD = null; // 仓库自带的解析器（admin/md.js）

function loadConfig() {
    let c = {};
    try { c = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch (e) { c = {}; }
    if (c.draftsDir) CFG.draftsDir = path.resolve(CLI_DIR, c.draftsDir);
    if (c.backupsDir) CFG.backupsDir = path.resolve(CLI_DIR, c.backupsDir);
    if (c.editor) CFG.editor = c.editor;
    CFG.__file = c;
    return c;
}

function saveConfig(patch) {
    const c = CFG.__file || {};
    Object.keys(patch || {}).forEach((k) => { c[k] = patch[k]; });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(c, null, 2) + '\n', 'utf8');
    CFG.__file = c;
}

function ensureDirs() {
    [CFG.draftsDir, CFG.backupsDir, CFG.tmpDir].forEach((d) => {
        if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
    });
}

/* 项目内路径 */
const P = {
    get template() { return path.join(CFG.root, '文章模板.html'); },
    get index() { return path.join(CFG.root, 'index.html'); },
    get column() { return path.join(CFG.root, '专栏'); },
    get md() { return path.join(CFG.root, 'admin', 'md.js'); },
    get adminData() { return path.join(CFG.root, 'admin', 'data'); },
};

function loadMd() {
    if (MD) return MD;
    if (!fs.existsSync(P.md)) {
        throw new Error('找不到 Markdown 解析器：' + P.md + '\n请用 --root 指定博客仓库根目录（含 admin/ 与 文章模板.html 的那个目录）。');
    }
    MD = require(P.md);
    return MD;
}

function checkRoot() {
    if (!CFG.root) throw new Error('未指定博客仓库根目录');
    if (!fs.existsSync(CFG.root)) throw new Error('仓库根目录不存在：' + CFG.root);
    if (!fs.existsSync(P.index)) throw new Error('根目录下找不到 index.html：' + CFG.root);
    if (!fs.existsSync(P.template)) throw new Error('根目录下找不到 文章模板.html：' + CFG.root);
    if (!fs.existsSync(P.column)) throw new Error('根目录下找不到 专栏/ 目录：' + CFG.root);
    loadMd();
    return true;
}

/* ============================================================
 * 小工具
 * ========================================================== */

function todayStr() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function timestamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 草稿 id：中文/字母/数字/下划线/连字符/全角括号/点/空格 */
function safeId(id) {
    let s = String(id || '').replace(/[\\/]/g, '-').replace(/\.\./g, '.').trim();
    s = s.replace(/[^\w\u4e00-\u9fa5()（）·、\-.\s]/g, '').slice(0, 80);
    if (!s) throw new Error('草稿名不能为空');
    return s;
}

/** 专栏页面文件名：禁全角冒号/问号（README 踩坑约定），强制 .html 结尾 */
function safeFile(file) {
    let s = String(file || '').replace(/[\\/]/g, '-').replace(/\.\./g, '.').trim();
    s = s.replace(/[：:?？*"<>|]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    s = s.replace(/[^\w\u4e00-\u9fa5()（）·、\-.]/g, '').slice(0, 80);
    if (!s) throw new Error('文件名不能为空');
    if (!s.endsWith('.html')) s += '.html';
    return s;
}

function monthOf(date) {
    const m = String(date || '').match(/^(\d{4})-(\d{2})/);
    return m ? m[0] : todayStr().slice(0, 7);
}

function stripBold(s) { return String(s || '').replace(/\*\*/g, ''); }

/* ============================================================
 * 草稿
 * ========================================================== */

function draftPath(id) { return path.join(CFG.draftsDir, safeId(id) + '.md'); }

function draftIdOf(file) { return file.replace(/\.md$/, ''); }

async function listDraftFiles() {
    if (!fs.existsSync(CFG.draftsDir)) return [];
    return (await fsp.readdir(CFG.draftsDir)).filter((f) => f.endsWith('.md')).sort();
}

async function readDraftRaw(id) {
    const p = draftPath(id);
    if (!fs.existsSync(p)) throw new Error('草稿不存在：' + id);
    return fsp.readFile(p, 'utf8');
}

async function readDraft(id) {
    const md = loadMd();
    const text = await readDraftRaw(id);
    const parsed = md.parse(text);
    return { id: safeId(id), meta: parsed.meta, body: parsed.body };
}

async function writeDraft(id, meta, body) {
    const md = loadMd();
    const clean = {};
    md.KNOWN_KEYS.forEach((k) => {
        const v = meta[k];
        if (v !== undefined && String(v).trim() !== '') clean[k] = String(v).trim();
    });
    Object.keys(meta).forEach((k) => {
        if (md.KNOWN_KEYS.indexOf(k) === -1 && String(meta[k]).trim() !== '') clean[k] = String(meta[k]).trim();
    });
    const out = md.stringifyMeta(clean) + String(body || '');
    const p = draftPath(id);
    await fsp.writeFile(p, out, 'utf8');
    return { id: safeId(id), path: p };
}

async function listDrafts() {
    const md = loadMd();
    const files = await listDraftFiles();
    const idxRows = fs.existsSync(P.index) ? parseIndexRows(fs.readFileSync(P.index, 'utf8')) : [];
    const out = [];
    for (const f of files) {
        const id = draftIdOf(f);
        try {
            const parsed = md.parse(await fsp.readFile(path.join(CFG.draftsDir, f), 'utf8'));
            const meta = parsed.meta || {};
            const file = safeFile(meta.file || md.slugify(meta.title || id));
            const href = '专栏/' + file;
            out.push({
                id,
                title: stripBold(meta.title || id),
                date: meta.date || '',
                badge: meta.badge || '',
                series: meta.series || '',
                file,
                href,
                pageExists: fs.existsSync(path.join(P.column, file)),
                published: idxRows.some((r) => r.href === href),
                bytes: (await fsp.stat(path.join(CFG.draftsDir, f))).size,
            });
        } catch (e) {
            out.push({ id, title: id, broken: true, error: e.message });
        }
    }
    return out;
}

/** 支持模糊匹配：精确 id > id 包含 > 标题包含 */
async function resolveDraft(query) {
    if (!query) throw new Error('缺少草稿名');
    const all = await listDrafts();
    const q = String(query).toLowerCase();
    let hit = all.find((d) => d.id === query);
    if (!hit) hit = all.find((d) => d.id.toLowerCase() === q);
    if (!hit) {
        const fuzzy = all.filter((d) => d.id.toLowerCase().indexOf(q) !== -1 || String(d.title).toLowerCase().indexOf(q) !== -1);
        if (fuzzy.length > 1) {
            throw new Error('匹配到多篇草稿，请写得更精确：\n  ' + fuzzy.map((d) => d.id).join('\n  '));
        }
        if (fuzzy.length === 1) hit = fuzzy[0];
    }
    if (!hit) throw new Error('找不到草稿：' + query);
    // listDrafts() 的条目只有 id/title/href 等轻量字段，没有 meta / body。
    // 这里补全，否则 show（读 d.meta 崩）、set（d.body 为 undefined，会把正文写没）、
    // preview（渲染成空文章）三条命令都会踩坑。
    const full = await readDraft(hit.id);
    return Object.assign({}, hit, { meta: full.meta, body: full.body });
}

/* ============================================================
 * 首页（index.html）解析与重建 —— 与 admin/server.js 保持一致
 * ========================================================== */

const ROW_RE = /<a class="article-row" href="([^"]+)" data-month="([^"]*)">([\s\S]*?)<\/a>/g;

function parseIndexRows(html) {
    const rows = [];
    let m;
    ROW_RE.lastIndex = 0;
    while ((m = ROW_RE.exec(html)) !== null) {
        const inner = m[3];
        const get = (re, i) => { const mm = inner.match(re); return mm ? mm[i].trim() : ''; };
        const dateRaw = get(/<time class="ar-date" datetime="([^"]*)">/, 1) || get(/<time class="ar-date"[^>]*>([^<]*)</, 1);
        rows.push({
            href: m[1].trim(),
            month: m[2].trim(),
            badge: get(/<span class="ar-badge">([\s\S]*?)<\/span>/, 1),
            series: get(/<span class="ar-series">([\s\S]*?)<\/span>/, 1),
            date: dateRaw,
            title: get(/<span class="m ar-title">([\s\S]*?)<\/span>/, 1),
            summary: get(/<span class="m ar-summary">([\s\S]*?)<\/span>/, 1),
        });
    }
    return rows;
}

const ARROW_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>';

function renderRow(r, num) {
    const e = MD.esc;
    return `            <a class="article-row" href="${e(r.href)}" data-month="${e(r.month)}">
                <span class="mask-box"><span class="m ar-num">${String(num).padStart(2, '0')}</span></span>
                <div class="ar-main">
                    <div class="mask-box"><span class="m ar-meta"><span class="ar-badge">${e(r.badge)}</span><span class="ar-series">${e(r.series)}</span><time class="ar-date" datetime="${e(r.date)}">${e(r.date)}</time></span></div>
                    <div class="mask-box"><span class="m ar-title">${e(r.title)}</span></div>
                    <div class="mask-box"><span class="m ar-summary">${e(r.summary)}</span></div>
                </div>
                <span class="ar-arrow">
                    ${ARROW_SVG}
                </span>
            </a>`;
}

function renderAfBody(rows) {
    const e = MD.esc;
    const counts = new Map();
    for (const r of rows) {
        if (r.month) counts.set(r.month, (counts.get(r.month) || 0) + 1);
    }
    const months = [...counts.keys()].sort().reverse();
    let html = `                    <button type="button" class="af-btn active" data-month="all"><span>全部文章</span><span class="af-count">${rows.length} 篇</span></button>`;
    for (const mon of months) {
        const parts = mon.split('-');
        const y = parts[0];
        const m = parts[1];
        const label = `${y} 年 ${parseInt(m, 10)} 月`;
        html += `\n                    <button type="button" class="af-btn" data-month="${e(mon)}"><span>${label}</span><span class="af-count">${counts.get(mon)} 篇</span></button>`;
    }
    return html;
}

async function backupIndex() {
    const file = path.join(CFG.backupsDir, `index-${timestamp()}.html`);
    await fsp.copyFile(P.index, file);
    const files = (await fsp.readdir(CFG.backupsDir)).filter((f) => f.startsWith('index-')).sort();
    while (files.length > 30) {
        const gone = files.shift();
        await fsp.unlink(path.join(CFG.backupsDir, gone)).catch(() => {});
    }
    return file;
}

async function updateIndex(rows) {
    const html = await fsp.readFile(P.index, 'utf8');
    if (!html.includes('<div class="article-list">')) throw new Error('index.html 中找不到文章列表容器');
    const listRe = /<div class="article-list">[\s\S]*?(?=<div id="articles-empty")/;
    const afRe = /<div class="af-body" id="af-body">[\s\S]*?<\/div>/;

    const newList = `<div class="article-list">\n${rows.map((r, i) => renderRow(r, i + 1)).join('\n\n')}\n        </div>\n\n                `;
    const newAf = `<div class="af-body" id="af-body">\n${renderAfBody(rows)}\n                </div>`;

    let out = html.replace(listRe, () => newList);
    if (out === html) throw new Error('文章列表替换失败');
    out = out.replace(afRe, () => newAf);
    if (out === html || !out.includes('id="af-body"')) throw new Error('归档筛选器替换失败');

    const backup = await backupIndex();
    await fsp.writeFile(P.index, out, 'utf8');
    return { backup: backup, count: rows.length };
}

/* ============================================================
 * 文章页生成 / 发布 / 下线 / 删除
 * ========================================================== */

async function buildPageHtml(meta, bodyHtml) {
    const tpl = await fsp.readFile(P.template, 'utf8');
    const title = stripBold(meta.title || '未命名文章');
    let out = tpl.replace(/<title>[\s\S]*?<\/title>/, () => `<title>${MD.esc(title)} · __SITE__</title>`);
    out = out.replace(/<header class="article-head reveal">[\s\S]*?<\/header>/, () => MD.buildHead(meta));
    out = out.replace(/<!-- =+ 从这里开始写 =+ -->[\s\S]*?<!-- =+ 写到这里结束 =+ -->/,
        () => `<!-- ============ 从这里开始写 ============ -->\n        <div class="article-body">\n\n${bodyHtml}\n\n        </div>\n        <!-- ============ 写到这里结束 ============ -->`);
    out = out.replace(/<nav class="series-nav">[\s\S]*?<\/nav>/, () => MD.buildSeriesNav(meta));
    return out;
}

async function publishDraft(id, opts) {
    opts = opts || {};
    const draft = await readDraft(id);
    const meta = Object.assign({}, draft.meta);
    if (!meta.title) throw new Error('缺少文章标题（title）');
    if (!meta.date) meta.date = todayStr();
    if (!meta.summary) meta.summary = meta.sub || stripBold(meta.title);

    const bodyHtml = MD.renderBody(draft.body);
    const file = safeFile(meta.file || MD.slugify(meta.title));
    const html = await buildPageHtml(meta, bodyHtml);
    const href = '专栏/' + file;

    let backup = null;
    let indexCount = 0;
    if (!opts.noIndex) {
        const target = path.join(P.column, file);
        await fsp.writeFile(target, html, 'utf8');
        const indexHtml = await fsp.readFile(P.index, 'utf8');
        const rows = parseIndexRows(indexHtml).filter((r) => r.href !== href);
        rows.unshift({
            href: href,
            month: monthOf(meta.date),
            badge: meta.badge || '',
            series: meta.series || '',
            date: meta.date,
            title: stripBold(meta.title),
            summary: meta.summary,
        });
        const info = await updateIndex(rows);
        backup = info.backup;
        indexCount = info.count;
    }
    return { id: draft.id, title: stripBold(meta.title), file: file, href: href, target: path.join(P.column, file), backup: backup, indexCount: indexCount };
}

async function unpublish(href) {
    if (!href) throw new Error('缺少 href（形如 专栏/xxx.html）');
    const indexHtml = await fsp.readFile(P.index, 'utf8');
    const before = parseIndexRows(indexHtml);
    const rows = before.filter((r) => r.href !== href);
    if (rows.length === before.length) return { unchanged: true };
    const info = await updateIndex(rows);
    return { unchanged: false, backup: info.backup, count: info.count };
}

async function removeDraft(id, opts) {
    opts = opts || {};
    let href = null;
    const dp = draftPath(id);
    let meta = null;
    if (fs.existsSync(dp)) {
        try { meta = MD.parse(await fsp.readFile(dp, 'utf8')).meta; } catch (e) { meta = null; }
        href = '专栏/' + safeFile((meta && meta.file) || MD.slugify((meta && meta.title) || id));
        await fsp.unlink(dp);
    }
    if (opts.href) href = opts.href;
    if (href) {
        const indexHtml = await fsp.readFile(P.index, 'utf8');
        const before = parseIndexRows(indexHtml);
        const rows = before.filter((r) => r.href !== href);
        if (rows.length !== before.length) await updateIndex(rows);
        const target = path.join(P.column, href.replace(/^专栏\//, ''));
        if (target.indexOf(P.column + path.sep) === 0 && fs.existsSync(target)) await fsp.unlink(target);
    }
    return { removedDraft: true, href: href };
}

/* ============================================================
 * Git
 * ========================================================== */

function git(args) {
    const run = (finalArgs) => new Promise((resolve) => {
        execFile('git', finalArgs, { cwd: CFG.root, maxBuffer: 8 * 1024 * 1024, timeout: 180000 }, (err, stdout, stderr) => {
            resolve({ code: err ? (err.code || 1) : 0, out: (stdout || '') + (stderr || ''), failed: !!err });
        });
    });
    return run(args).then((r) => {
        if (r.failed && /dubious ownership/i.test(r.out)) {
            return run(['-c', 'safe.directory=*'].concat(args));
        }
        return r;
    });
}

async function gitStatus() {
    const s = await git(['status', '--porcelain']);
    const b = await git(['branch', '--show-current']);
    const r = await git(['remote', 'get-url', 'origin']);
    return {
        dirty: s.out.split('\n').filter(Boolean),
        branch: b.out.trim(),
        remote: r.out.trim(),
    };
}

async function gitPush(message) {
    const s1 = await git(['add', '-A']);
    const s2 = await git(['status', '--porcelain']);
    let commit = { code: 0, out: '没有需要提交的改动', failed: false };
    let push = { code: 0, out: '', failed: false };
    if (s2.out.trim()) {
        commit = await git(['commit', '-m', message || '更新站点']);
        if (!commit.failed) push = await git(['push']);
    }
    return {
        ok: !s1.failed && !commit.failed && !push.failed,
        add: s1.out.trim(),
        commit: commit.out.trim(),
        push: push.out.trim(),
        nothing: !s2.out.trim(),
    };
}

/* ============================================================
 * 输出（人读 / 机器读）
 * ========================================================== */

const C = {
    reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m', rev: '\x1b[7m',
    yellow: '\x1b[33m', brightYellow: '\x1b[93m', gray: '\x1b[90m',
    green: '\x1b[32m', red: '\x1b[31m', cyan: '\x1b[36m', white: '\x1b[97m',
};

function useColor() { return process.stdout.isTTY && !process.env.NO_COLOR; }
function paint(code, s) { return useColor() ? code + s + C.reset : s; }

function out(data, human) {
    if (CFG.json) {
        process.stdout.write(JSON.stringify(data, null, 2) + '\n');
    } else if (typeof human === 'function') {
        human(data);
    } else if (human !== undefined) {
        process.stdout.write(human + '\n');
    }
}

function fail(err, code) {
    const msg = err && err.message ? err.message : String(err);
    if (CFG.json) {
        process.stdout.write(JSON.stringify({ ok: false, error: msg }, null, 2) + '\n');
    } else {
        process.stderr.write(paint(C.red, '错误：') + msg + '\n');
    }
    process.exit(code === undefined ? 1 : code);
}

/* ============================================================
 * 参数解析
 * ========================================================== */

function parseArgs(argv) {
    const res = { _: [], f: {} };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--') { res._ = res._.concat(argv.slice(i + 1)); break; }
        if (a.indexOf('--') === 0) {
            let key = a.slice(2);
            let val = true;
            const eq = key.indexOf('=');
            if (eq >= 0) { val = key.slice(eq + 1); key = key.slice(0, eq); }
            else if (argv[i + 1] !== undefined && String(argv[i + 1]).indexOf('--') !== 0) { val = argv[i + 1]; i++; }
            res.f[key] = val;
        } else {
            res._.push(a);
        }
    }
    return res;
}

function val(f, name, def) {
    if (Object.prototype.hasOwnProperty.call(f, name)) {
        const v = f[name];
        if (v === true) return def === undefined ? true : def;
        return v;
    }
    return def;
}

function bool(f, name, def) {
    if (Object.prototype.hasOwnProperty.call(f, name)) {
        const v = f[name];
        if (v === true || v === 'true' || v === '1' || v === '') return true;
        if (v === 'false' || v === '0') return false;
        return true;
    }
    return def;
}

const META_KEYS = ['title', 'date', 'badge', 'series', 'sub', 'summary', 'file',
    'prev', 'prevTitle', 'next', 'nextTitle', 'accent'];

function metaFromFlags(f) {
    const m = {};
    META_KEYS.forEach((k) => {
        const v = val(f, k.toLowerCase(), undefined);
        if (v !== undefined && v !== true && String(v).trim() !== '') m[k] = String(v).trim();
    });
    if (m.prevtitle) { m.prevTitle = m.prevtitle; delete m.prevtitle; }
    if (m.nexttitle) { m.nextTitle = m.nexttitle; delete m.nexttitle; }
    return m;
}

/* ============================================================
 * 命令实现
 * ========================================================== */

async function cmdList() {
    checkRoot();
    const rows = parseIndexRows(fs.readFileSync(P.index, 'utf8'));
    const drafts = await listDrafts();
    const items = rows.map((r, i) => ({
        num: String(i + 1).padStart(2, '0'),
        title: r.title, badge: r.badge, series: r.series, date: r.date,
        month: r.month, href: r.href, summary: r.summary,
        pageExists: fs.existsSync(path.join(CFG.root, r.href)),
        hasSource: drafts.some((d) => d.href === r.href),
    }));
    out({ ok: true, count: items.length, articles: items }, () => {
        process.stdout.write('\n' + paint(C.bold, `  已发布文章（${items.length} 篇）`) + '\n\n');
        if (!items.length) process.stdout.write(paint(C.gray, '  （首页暂无文章）') + '\n\n');
        items.forEach((a) => {
            const tag = a.badge ? paint(C.yellow, '[' + a.badge + '] ') : '';
            const warn = a.pageExists ? '' : paint(C.red, ' [文件缺失!]');
            process.stdout.write(`  ${paint(C.gray, a.num)}  ${tag}${paint(C.bold, a.title)}${warn}\n`);
            process.stdout.write(`      ${paint(C.gray, a.date + '  ' + a.href)}\n`);
        });
        process.stdout.write('\n');
    });
    return items;
}

async function cmdDrafts() {
    checkRoot();
    const list = await listDrafts();
    out({ ok: true, count: list.length, drafts: list }, () => {
        process.stdout.write('\n' + paint(C.bold, `  草稿箱（${list.length} 篇）`) + '\n\n');
        if (!list.length) process.stdout.write(paint(C.gray, '  （空。用 ./blog.js new --title "标题" 新建）') + '\n\n');
        list.forEach((d) => {
            const st = d.published ? paint(C.green, '已发布') : (d.pageExists ? paint(C.yellow, '页面已生成·未上首页') : paint(C.gray, '草稿'));
            process.stdout.write(`  ${paint(C.bold, d.title)}  ${st}\n`);
            process.stdout.write(`      ${paint(C.gray, 'id=' + d.id + '  → ' + d.href + '  ' + (d.date || '未设日期'))}\n`);
        });
        process.stdout.write('\n');
    });
    return list;
}

async function cmdNew(f, args) {
    checkRoot();
    let meta = {};
    let body = '';
    const mdFile = val(f, 'md', null) || val(f, 'file-md', null);
    if (mdFile) {
        const text = await fsp.readFile(resolveInput(mdFile), 'utf8');
        const parsed = MD.parse(text);
        meta = parsed.meta || {};
        body = parsed.body;
    }
    const bodyFile = val(f, 'body-file', null);
    if (bodyFile) body = await fsp.readFile(resolveInput(bodyFile), 'utf8');
    if (bool(f, 'body-stdin', false)) body = await readStdin();
    if (typeof f.body === 'string') body = f.body;

    meta = Object.assign(meta, metaFromFlags(f));
    if (!meta.title && args._[1]) meta.title = args._[1];
    if (!meta.title) meta.title = '未命名文章';
    if (!meta.date) meta.date = todayStr();

    const id = safeId(val(f, 'id', null) || MD.slugify(meta.title));
    await writeDraft(id, meta, body);

    if (bool(f, 'edit', false) && process.stdin.isTTY) await openEditor(draftPath(id));

    const d = (await listDrafts()).find((x) => x.id === id);
    out({ ok: true, id: id, path: draftPath(id), draft: d }, () => {
        process.stdout.write('\n' + paint(C.green, '  草稿已创建：') + paint(C.bold, id) + '\n');
        process.stdout.write(paint(C.gray, '  ' + draftPath(id)) + '\n\n');
    });
    return id;
}

async function cmdShow(idOrQuery) {
    checkRoot();
    const d = await resolveDraft(idOrQuery);
    const raw = await readDraftRaw(d.id);
    out({ ok: true, id: d.id, meta: d.meta, body: d.body, raw: raw }, () => {
        process.stdout.write('\n' + paint(C.bold, '  ' + d.title) + '\n');
        process.stdout.write(paint(C.gray, '  id: ' + d.id + '   → ' + d.href) + '\n\n');
        Object.keys(d.meta).forEach((k) => {
            process.stdout.write('  ' + paint(C.gray, (k + '        ').slice(0, 10)) + d.meta[k] + '\n');
        });
        process.stdout.write('\n' + paint(C.gray, '  ── 正文 ' + d.body.split('\n').length + ' 行 ──') + '\n\n');
        process.stdout.write(d.body.replace(/^/gm, '  ') + '\n\n');
    });
}

async function cmdEdit(idOrQuery) {
    checkRoot();
    const d = await resolveDraft(idOrQuery);
    const p = draftPath(d.id);
    const code = await openEditor(p);
    out({ ok: code === 0, id: d.id, path: p, editor: CFG.editor }, `  已用 ${CFG.editor} 打开：${p}`);
}

async function cmdSet(idOrQuery, f) {
    checkRoot();
    const d = await resolveDraft(idOrQuery);
    const patch = metaFromFlags(f);
    const meta = Object.assign({}, d.meta, patch);
    const body = (typeof f.body === 'string') ? f.body : d.body;
    await writeDraft(d.id, meta, body);
    out({ ok: true, id: d.id, meta: meta }, () => {
        process.stdout.write('\n' + paint(C.green, '  已更新元信息：') + d.id + '\n');
        Object.keys(patch).forEach((k) => process.stdout.write('  ' + paint(C.gray, k) + ' = ' + patch[k] + '\n'));
        process.stdout.write('\n');
    });
}

async function cmdPublish(idOrQuery, f) {
    checkRoot();
    const d = await resolveDraft(idOrQuery);
    const res = await publishDraft(d.id, {});
    let pushed = null;
    if (bool(f, 'push', false)) {
        pushed = await gitPush('发布文章：' + res.title);
    }
    const payload = Object.assign({ ok: true }, res, { pushed: pushed });
    out(payload, () => {
        process.stdout.write('\n' + paint(C.green, '  已发布：') + paint(C.bold, res.title) + '\n');
        process.stdout.write(paint(C.gray, '  页面：' + res.href) + '\n');
        process.stdout.write(paint(C.gray, '  首页备份：' + res.backup) + '\n');
        process.stdout.write(paint(C.gray, '  首页文章数：' + res.indexCount) + '\n');
        if (pushed) {
            process.stdout.write(pushed.nothing ? paint(C.gray, '  Git：无改动') + '\n'
                : paint(C.green, '  Git：已推送') + '\n');
        }
        process.stdout.write('\n');
    });
    return payload;
}

/** AI 一步发文：post --md a.md [--title ..] [--push] */
async function cmdPost(f, args) {
    checkRoot();
    let meta = {};
    let body = '';
    const mdFile = val(f, 'md', null);
    if (mdFile) {
        const text = await fsp.readFile(resolveInput(mdFile), 'utf8');
        const parsed = MD.parse(text);
        meta = parsed.meta || {};
        body = parsed.body;
    }
    const bodyFile = val(f, 'body-file', null);
    if (bodyFile) body = await fsp.readFile(resolveInput(bodyFile), 'utf8');
    if (bool(f, 'body-stdin', false)) body = await readStdin();
    if (typeof f.body === 'string') body = f.body;

    meta = Object.assign(meta, metaFromFlags(f));
    if (!meta.title && args._[1]) meta.title = args._[1];
    if (!meta.title) throw new Error('缺少标题：用 --title "标题" 或在 --md 文件里写 frontmatter title');
    if (!body || !String(body).trim()) throw new Error('正文为空：用 --md / --body-file / --body-stdin / --body 提供正文');
    if (!meta.date) meta.date = todayStr();

    const id = safeId(val(f, 'id', null) || MD.slugify(meta.title));
    await writeDraft(id, meta, body);

    const doPublish = !bool(f, 'no-publish', false);
    let res = null;
    let pushed = null;
    if (doPublish) {
        res = await publishDraft(id, {});
        if (bool(f, 'push', false)) pushed = await gitPush('发布文章：' + res.title);
    }
    const payload = { ok: true, id: id, published: !!res, pushed: pushed, article: res };
    out(payload, () => {
        process.stdout.write('\n' + paint(C.green, '  完成：') + paint(C.bold, stripBold(meta.title)) + '\n');
        process.stdout.write(paint(C.gray, '  草稿：' + draftPath(id)) + '\n');
        if (res) {
            process.stdout.write(paint(C.gray, '  页面：' + res.href + '   首页文章数：' + res.indexCount) + '\n');
            process.stdout.write(paint(C.gray, '  备份：' + res.backup) + '\n');
        } else {
            process.stdout.write(paint(C.yellow, '  仅存草稿（--no-publish）') + '\n');
        }
        if (pushed) {
            process.stdout.write(pushed.nothing ? paint(C.gray, '  Git：无改动') + '\n'
                : (pushed.ok ? paint(C.green, '  Git：已推送上线') + '\n' : paint(C.red, '  Git：推送失败') + '\n' + pushed.push + '\n'));
        }
        process.stdout.write('\n');
    });
    return payload;
}

async function cmdUnpublish(f) {
    checkRoot();
    let href = val(f, 'href', null) || val(f, 'h', null);
    if (!href && f.id) {
        const d = await resolveDraft(f.id);
        href = d.href;
    }
    const res = await unpublish(href);
    const payload = Object.assign({ ok: true, href: href }, res);
    out(payload, () => {
        process.stdout.write('\n' + (res.unchanged
            ? paint(C.yellow, '  首页本来就没有这篇：') + href
            : paint(C.green, '  已从首页下线：') + href + '\n' + paint(C.gray, '  备份：' + res.backup)) + '\n\n');
    });
}

async function cmdRemove(idOrQuery) {
    checkRoot();
    const d = await resolveDraft(idOrQuery);
    const res = await removeDraft(d.id, { href: d.href });
    out({ ok: true, id: d.id, href: res.href }, () => {
        process.stdout.write('\n' + paint(C.green, '  已删除草稿及其站点条目：') + d.id + '\n');
        process.stdout.write(paint(C.gray, '  ' + (res.href || '（无页面）')) + '\n\n');
    });
}

async function cmdPreview(idOrQuery, f) {
    checkRoot();
    const d = await resolveDraft(idOrQuery);
    const meta = Object.assign({}, d.meta);
    if (!meta.date) meta.date = todayStr();
    const html = await buildPageHtml(meta, MD.renderBody(d.body));
    const destArg = val(f, 'out', null);
    const dest = destArg ? resolveInput(destArg) : path.join(CFG.tmpDir, safeFile(meta.file || MD.slugify(meta.title || d.id)));
    await fsp.writeFile(dest, html, 'utf8');
    out({ ok: true, id: d.id, preview: dest }, () => {
        process.stdout.write('\n' + paint(C.green, '  预览已生成：') + dest + '\n');
        process.stdout.write(paint(C.gray, '  （在 CLI 的 tmp/ 目录，不进仓库、不影响线上）') + '\n\n');
    });
}

async function cmdStatus() {
    checkRoot();
    const g = await gitStatus();
    const rows = parseIndexRows(fs.readFileSync(P.index, 'utf8'));
    const drafts = await listDrafts();
    const payload = {
        ok: true,
        root: CFG.root,
        branch: g.branch,
        remote: g.remote,
        dirty: g.dirty,
        published: rows.length,
        drafts: drafts.length,
        cliDir: CLI_DIR,
    };
    out(payload, () => {
        process.stdout.write('\n' + paint(C.bold, '  仓库状态') + '\n\n');
        process.stdout.write('  ' + paint(C.gray, '路径    ') + CFG.root + '\n');
        process.stdout.write('  ' + paint(C.gray, '分支    ') + (g.branch || '?') + '    ' + paint(C.gray, g.remote || '（无远端）') + '\n');
        process.stdout.write('  ' + paint(C.gray, '已发布  ') + rows.length + ' 篇     草稿 ' + drafts.length + ' 篇\n');
        process.stdout.write('  ' + paint(C.gray, '未提交  ') + (g.dirty.length ? paint(C.yellow, g.dirty.length + ' 个文件') : paint(C.green, '干净')) + '\n');
        if (g.dirty.length) g.dirty.slice(0, 20).forEach((x) => process.stdout.write('    ' + paint(C.gray, x) + '\n'));
        process.stdout.write('\n');
    });
}

async function cmdPush(f) {
    checkRoot();
    const msg = val(f, 'm', null) || val(f, 'message', null) || null;
    const g = await gitStatus();
    if (!g.dirty.length) {
        out({ ok: true, nothing: true, branch: g.branch }, paint(C.gray, '\n  没有需要提交的改动\n'));
        return { nothing: true };
    }
    const res = await gitPush(msg);
    const payload = Object.assign({ ok: res.ok }, res);
    out(payload, () => {
        process.stdout.write('\n' + (res.ok ? paint(C.green, '  已推送') : paint(C.red, '  推送未完成')) + '\n');
        if (res.commit) process.stdout.write(paint(C.gray, '  ' + res.commit.split('\n')[0]) + '\n');
        if (res.push) process.stdout.write(paint(C.gray, '  ' + res.push.split('\n').slice(-1)[0]) + '\n');
        process.stdout.write('\n');
    });
    return payload;
}

async function cmdDoctor() {
    const checks = [];
    const add = (name, ok, detail) => checks.push({ name: name, ok: ok, detail: detail });
    add('CLI 目录', fs.existsSync(CLI_DIR), CLI_DIR);
    add('仓库根目录', !!CFG.root && fs.existsSync(CFG.root), CFG.root || '（未指定）');
    if (CFG.root && fs.existsSync(CFG.root)) {
        add('index.html', fs.existsSync(P.index), P.index);
        add('文章模板.html', fs.existsSync(P.template), P.template);
        add('专栏/', fs.existsSync(P.column), P.column);
        add('admin/md.js', fs.existsSync(P.md), P.md);
        const gh = await git(['remote', 'get-url', 'origin']);
        add('git 远端', !gh.failed && !!gh.out.trim(), gh.out.trim() || gh.out.trim());
        const gb = await git(['branch', '--show-current']);
        add('git 分支', !gb.failed, gb.out.trim());
    }
    add('草稿目录', fs.existsSync(CFG.draftsDir), CFG.draftsDir);
    add('备份目录', fs.existsSync(CFG.backupsDir), CFG.backupsDir);
    add('编辑器', !!(CFG.editor), CFG.editor);
    add('Node', true, process.version);

    let mdOk = true;
    try { loadMd(); } catch (e) { mdOk = false; }
    const bad = checks.filter((c) => !c.ok);
    out({ ok: bad.length === 0 && mdOk, checks: checks }, () => {
        process.stdout.write('\n' + paint(C.bold, '  自检') + '\n\n');
        checks.forEach((c) => {
            process.stdout.write('  ' + (c.ok ? paint(C.green, '✓') : paint(C.red, '✗')) + ' ' + c.name + '  ' + paint(C.gray, c.detail || '') + '\n');
        });
        process.stdout.write('\n  ' + (bad.length ? paint(C.red, bad.length + ' 项异常') : paint(C.green, '全部正常')) + '\n\n');
    });
    return checks;
}

function cmdHelp() {
    const t = `
${paint(C.bold, '绝顶赵博客 · 命令行管理终端')}  ${paint(C.gray, 'v1.0 · 零依赖')}

${paint(C.yellow, '用法')}
  ./blog.js                     启动交互式 TUI（默认）
  ./blog.js <命令> [选项]       直接执行，供 AI / 脚本调用

${paint(C.yellow, '查看')}
  list                          列出首页已发布文章
  drafts                        列出草稿箱
  show <id>                     查看草稿（元信息 + 正文）
  status                        仓库状态（分支 / 未提交 / 篇数）
  doctor                        环境自检

${paint(C.yellow, '写作')}
  new --title "标题" [...]      新建草稿（--edit 立即打开编辑器）
  edit <id>                     用 $EDITOR 编辑草稿正文
  set <id> --badge "社群专享"    修改草稿元信息
  preview <id> [--out f.html]   渲染成 HTML 预览（不写入仓库）

${paint(C.yellow, '发布')}
  post --md 文章.md [--push]    一步发文：建草稿 → 生成页面 → 更新首页 → 可选推送
  publish <id> [--push]         发布已有草稿
  unpublish --href 专栏/x.html  从首页下线（页面文件保留）
  rm <id>                       删除草稿 + 专栏页面 + 首页条目
  push [-m "提交信息"]          git add / commit / push

${paint(C.yellow, '正文来源（post / new）')}
  --md <file>        Markdown 文件，可带 frontmatter（title/date/badge/series/sub/summary/file/prev/next…）
  --body-file <f>    纯正文文件（无 frontmatter）
  --body-stdin       从标准输入读正文
  --body "文本"       直接给正文字符串

${paint(C.yellow, '元信息选项')}
  --title --sub --badge --series --date --summary --file --accent
  --prev --prevTitle --next --nextTitle
  --id <草稿名>      指定草稿文件名（默认由标题生成）

${paint(C.yellow, '全局选项')}
  --json             机器可读输出（AI 强烈建议加）
  --root <目录>      指定博客仓库根目录
  -h / --help        显示本帮助

${paint(C.yellow, 'AI 典型调用')}
  ./blog.js post --md ./article.md --push --json
  ./blog.js drafts --json
  ./blog.js publish "文章标题关键词" --push --json
`;
    process.stdout.write(t + '\n');
}

function readStdin() {
    return new Promise((resolve, reject) => {
        let data = '';
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', (c) => { data += c; });
        process.stdin.on('end', () => resolve(data));
        process.stdin.on('error', reject);
    });
}

function openEditor(file) {
    return new Promise((resolve) => {
        const parts = String(CFG.editor || 'vim').split(/\s+/);
        const cmd = parts[0];
        const args = parts.slice(1).concat([file]);
        suspendTui();
        const p = spawn(cmd, args, { stdio: 'inherit' });
        p.on('exit', (code) => { resumeTui(); resolve(code === null ? 1 : code); });
        p.on('error', (err) => {
            resumeTui();
            process.stderr.write(paint(C.red, '无法启动编辑器 ') + CFG.editor + '：' + err.message + '\n');
            resolve(1);
        });
    });
}

/* ============================================================
 * TUI
 * ========================================================== */

let TUI_ON = false;

function suspendTui() {
    if (TUI_ON && process.stdin.isTTY) {
        try { process.stdin.setRawMode(false); process.stdin.pause(); } catch (e) { /* ignore */ }
        process.stdout.write('\x1b[?25h');
    }
}

function resumeTui() {
    if (TUI_ON && process.stdin.isTTY) {
        process.stdout.write('\x1b[?25l');
        try { process.stdin.setRawMode(true); process.stdin.resume(); } catch (e) { /* ignore */ }
    }
}

function termWidth() {
    const w = (process.stdout.columns || 80);
    return Math.max(60, Math.min(w, 100));
}

/** 输入路径：绝对路径原样用，相对路径按当前工作目录解析 */
function resolveInput(p) {
    if (!p) return p;
    if (path.isAbsolute(p)) return p;
    return path.resolve(process.cwd(), p);
}

const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;
function stripAnsi(s) { return String(s).replace(ANSI_RE, ''); }

function dw(s) {
    let w = 0;
    for (const ch of stripAnsi(s)) {
        const c = ch.codePointAt(0);
        w += (c >= 0x1100 && (
            c <= 0x115f || c === 0x2329 || c === 0x232a ||
            (c >= 0x2e80 && c <= 0xa4cf && c !== 0x303f) ||
            (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) ||
            (c >= 0xfe30 && c <= 0xfe6f) || (c >= 0xff00 && c <= 0xff60) ||
            (c >= 0xffe0 && c <= 0xffe6) || (c >= 0x20000 && c <= 0x3fffd)
        )) ? 2 : 1;
    }
    return w;
}

function pad(s, n) { return String(s) + ' '.repeat(Math.max(0, n - dw(String(s)))); }
function padL(s, n) { return ' '.repeat(Math.max(0, n - dw(String(s)))) + String(s); }
function truncate(s, n) {
    const plain = stripAnsi(s);
    if (dw(plain) <= n) return String(s);
    let w = 0; let r = '';
    for (const ch of plain) {
        const cw = dw(ch);
        if (w + cw > n - 1) return r + '…';
        w += cw; r += ch;
    }
    return r;
}

/** 左右分栏：左侧截断，右侧右对齐，总宽固定为 width */
function makeRow(left, right, width) {
    const gap = 2;
    const maxLeft = Math.max(4, width - (right ? dw(right) + gap : 0));
    const l = truncate(left, maxLeft);
    return l + ' '.repeat(Math.max(0, maxLeft - dw(l))) + (right ? ' '.repeat(gap) + right : '');
}

function line(text) { process.stdout.write(text + '\n'); }

function frame(title, bodyLines, footerLines) {
    const W = termWidth();
    const head = '┌─ ' + title + ' ' + '─'.repeat(Math.max(0, W - dw(title) - 5)) + '┐';
    const foot = '└' + '─'.repeat(W - 2) + '┘';
    const buf = [];
    buf.push(paint(C.bold + C.yellow, head));
    bodyLines.forEach((l) => buf.push('│' + pad(l, W - 2) + '│'));
    buf.push(paint(C.bold + C.yellow, foot));
    (footerLines || []).forEach((l) => buf.push(l));
    return buf.join('\n');
}

function clear() { process.stdout.write('\x1b[2J\x1b[H'); }

function readKey() {
    return new Promise((resolve) => {
        const onData = (buf) => {
            process.stdin.removeListener('data', onData);
            resolve(buf.toString('utf8'));
        };
        process.stdin.on('data', onData);
    });
}

const K = {
    up: ['\u001b[A', 'k', 'K'],
    down: ['\u001b[B', 'j', 'J'],
    enter: ['\r', '\n'],
    quit: ['q', 'Q', '\u001b'],
    ctrlC: ['\u0003'],
};

async function pickMenu(title, items, footer) {
    let idx = 0;
    const W = termWidth();
    for (;;) {
        clear();
        const body = [];
        body.push('');
        items.forEach((it, i) => {
            const sel = i === idx;
            const label = typeof it === 'string' ? it : it.label;
            const right = (typeof it === 'object' && it.right) ? it.right : '';
            let txt = makeRow((sel ? ' ▸ ' : '   ') + label, right, W - 4);
            body.push(sel ? paint(C.rev + C.bold, txt) : txt);
        });
        body.push('');
        const f = footer || '↑↓/jk 选择 · Enter 进入 · q 返回';
        process.stdout.write(frame(title, body, ['  ' + paint(C.gray, f)]) + '\n');
        const k = await readKey();
        if (K.ctrlC.indexOf(k) !== -1) { tuiExit(0); }
        if (K.up.indexOf(k) !== -1) idx = (idx - 1 + items.length) % items.length;
        else if (K.down.indexOf(k) !== -1) idx = (idx + 1) % items.length;
        else if (K.enter.indexOf(k) !== -1) return (typeof items[idx] === 'string') ? items[idx] : items[idx].value;
        else if (K.quit.indexOf(k) !== -1) return null;
        else if (/^[1-9]$/.test(k)) {
            const n = parseInt(k, 10) - 1;
            if (n < items.length) idx = n;
        }
    }
}

async function inputLine(title, label, def) {
    let buf = String(def == null ? '' : def);
    for (;;) {
        clear();
        const W = termWidth();
        const body = ['', '  ' + label, '', '  ' + paint(C.bold, buf) + paint(C.yellow, '█'), ''];
        process.stdout.write(frame(title, body, ['  ' + paint(C.gray, 'Enter 确认 · Esc 取消 · Ctrl+U 清空')]) + '\n');
        const k = await readKey();
        if (k === '\r' || k === '\n') return buf;
        if (k === '\u001b') return null;
        if (k === '\u0003') tuiExit(0);
        if (k === '\u007f' || k === '\b') buf = buf.slice(0, -1);
        else if (k === '\u0015') buf = '';
        else if (k.length === 1 && k >= ' ') buf += k;
    }
}

const META_FIELDS = [
    ['title', '标题', '必填；用 **双星** 包裹的字变实心黄'],
    ['sub', '副标题', '一句话说明这篇文章解决什么问题'],
    ['badge', '标签', '如：社群专享 / 核心理论 / AI 实操'],
    ['series', '系列', '如：获得执行力 · 上'],
    ['date', '日期', 'YYYY-MM-DD，默认今天'],
    ['summary', '首页摘要', '首页列表那行小字'],
    ['file', '文件名', '默认由标题生成，全角冒号/问号会被替换'],
    ['prev', '上一篇链接', '如 专栏/获得执行力（上）.html'],
    ['prevTitle', '上一篇标题', ''],
    ['next', '下一篇链接', ''],
    ['nextTitle', '下一篇标题', ''],
    ['accent', '标题黄字', '标题中要变黄的连续片段'],
];

async function formScreen(fields, title) {
    let idx = 0;
    let editing = false;
    let buf = '';
    const total = fields.length + 1; // 最后一行是「保存」
    for (;;) {
        clear();
        const W = termWidth();
        const body = [];
        body.push('');
        fields.forEach((f, i) => {
            const sel = i === idx;
            const val0 = (editing && i === idx) ? buf : String(f.value == null ? '' : f.value);
            const label = pad(f.label, 10);
            const vw = W - 4 - dw(label) - 4;
            let txt = '  ' + paint(C.gray, label) + truncate(val0, vw);
            if (editing && i === idx) txt += paint(C.yellow, '█');
            body.push(sel ? paint(C.bold + C.yellow, pad(txt, W - 4)) : txt);
        });
        body.push('');
        const saveSel = idx === fields.length;
        const saveTxt = '  ' + (saveSel ? paint(C.rev + C.bold, '  ✔ 保存并返回  ') : '  ✔ 保存并返回  ');
        body.push(saveSel ? pad(saveTxt, W - 4) : saveTxt);
        body.push('');
        const hint = editing
            ? '输入中：Enter 确认 · Esc 取消本项'
            : '↑↓ 切换 · Enter 编辑 · q 取消';
        process.stdout.write(frame(title || '编辑', body, ['  ' + paint(C.gray, hint)]) + '\n');
        const k = await readKey();
        if (K.ctrlC.indexOf(k) !== -1) tuiExit(0);
        if (editing) {
            if (k === '\r' || k === '\n') { fields[idx].value = buf; editing = false; }
            else if (k === '\u001b') { editing = false; }
            else if (k === '\u007f' || k === '\b') { buf = buf.slice(0, -1); }
            else if (k === '\u0015') { buf = ''; }
            else if (k.length === 1 && k >= ' ') { buf += k; }
            continue;
        }
        if (K.up.indexOf(k) !== -1) idx = (idx - 1 + total) % total;
        else if (K.down.indexOf(k) !== -1) idx = (idx + 1) % total;
        else if (K.enter.indexOf(k) !== -1) {
            if (idx === fields.length) {
                const res = {};
                fields.forEach((f) => { res[f.key] = f.value; });
                return res;
            }
            buf = String(fields[idx].value == null ? '' : fields[idx].value);
            editing = true;
        } else if (K.quit.indexOf(k) !== -1) return null;
        else if (k.length === 1 && k > ' ' && !/[1-9]/.test(k)) {
            // 直接敲可见字符 = 就地开始编辑（j/k/q 与数字键保留给导航）
            buf = k;
            editing = true;
        }
    }
}

async function flash(msg, isErr) {
    clear();
    const W = termWidth();
    const lines = String(msg).split('\n').map((l) => '  ' + l);
    const body = [''].concat(lines).concat(['']);
    process.stdout.write(frame(isErr ? '出错了' : '完成', body, ['  ' + paint(C.gray, '按任意键继续')]) + '\n');
    await readKey();
}

async function confirmScreen(title, msg) {
    return pickMenu(title, [
        { label: '确认执行', value: true },
        { label: '取消', value: false },
    ], msg);
}

/* ---------- TUI 各屏 ---------- */

async function screenMain() {
    for (;;) {
        const rows = parseIndexRows(fs.readFileSync(P.index, 'utf8'));
        const drafts = await listDrafts();
        const pick = await pickMenu('绝顶赵博客 · 管理终端', [
            { label: '新建文章', value: 'new', right: '' },
            { label: '草稿箱', value: 'drafts', right: String(drafts.length) },
            { label: '已发布文章', value: 'published', right: String(rows.length) },
            { label: 'Git 推送上线', value: 'push' },
            { label: '仓库状态', value: 'status' },
            { label: '环境自检 / 设置', value: 'config' },
            { label: '退出', value: 'exit' },
        ], '↑↓/jk 选择 · 数字键跳转 · Enter 进入 · q 退出');
        if (pick === null || pick === 'exit') return;
        try {
            if (pick === 'new') await screenNew();
            else if (pick === 'drafts') await screenDrafts();
            else if (pick === 'published') await screenPublished();
            else if (pick === 'push') await screenPush();
            else if (pick === 'status') await screenStatus();
            else if (pick === 'config') await screenConfig();
        } catch (e) {
            await flash(e.message, true);
        }
    }
}

async function screenNew() {
    const fields = META_FIELDS.map((f) => ({ key: f[0], label: f[1], value: f[0] === 'date' ? todayStr() : '' }));
    const res = await formScreen(fields, '新建文章 · 元信息');
    if (!res) return;
    if (!res.title || !String(res.title).trim()) {
        await flash('标题不能为空', true);
        return;
    }
    const id = safeId(MD.slugify(res.title));
    const draftFile = draftPath(id);
    if (fs.existsSync(draftFile)) {
        const go = await confirmScreen('草稿已存在', 'id=' + id + ' 已存在，要覆盖它吗？');
        if (!go) return;
    }
    await writeDraft(id, res, '\n在这里写正文（Markdown）\n\n## 章节标题\n\n正文段落……\n');
    await openEditor(draftFile);
    const after = await pickMenu('已保存：' + id, [
        { label: '继续编辑正文', value: 'edit' },
        { label: '修改元信息', value: 'meta' },
        { label: '生成预览 HTML', value: 'preview' },
        { label: '发布（写入专栏 + 更新首页）', value: 'publish' },
        { label: '返回主菜单', value: 'back' },
    ]);
    if (after === 'edit') { await openEditor(draftFile); }
    else if (after === 'meta') {
        const cur = await readDraft(id);
        const fs2 = META_FIELDS.map((f) => ({ key: f[0], label: f[1], value: cur.meta[f[0]] || (f[0] === 'date' ? todayStr() : '') }));
        const r2 = await formScreen(fs2, '修改元信息');
        if (r2) { await writeDraft(id, r2, cur.body); await flash('已保存元信息'); }
    } else if (after === 'preview') {
        const d = await readDraft(id);
        const html = await buildPageHtml(Object.assign({ date: todayStr() }, d.meta), MD.renderBody(d.body));
        const dest = path.join(CFG.tmpDir, safeFile(d.meta.file || MD.slugify(d.meta.title || id)));
        await fsp.writeFile(dest, html, 'utf8');
        await flash('预览已生成：\n' + dest);
    } else if (after === 'publish') {
        const r = await publishDraft(id, {});
        await flash('已发布：' + r.title + '\n' + r.href + '\n首页文章数：' + r.indexCount);
    }
}

async function screenDrafts() {
    for (;;) {
        const drafts = await listDrafts();
        if (!drafts.length) {
            await flash('草稿箱是空的。先在主菜单选「新建文章」。');
            return;
        }
        const items = drafts.map((d) => ({
            label: d.title,
            value: d.id,
            right: d.published ? '已发布' : (d.pageExists ? '未上首页' : '草稿'),
        })).concat([{ label: '返回主菜单', value: null }]);
        const id = await pickMenu('草稿箱（' + drafts.length + '）', items);
        if (id === null) return;
        const act = await pickMenu('草稿：' + id, [
            { label: '编辑正文（' + CFG.editor + '）', value: 'edit' },
            { label: '修改元信息', value: 'meta' },
            { label: '生成预览 HTML', value: 'preview' },
            { label: '发布', value: 'publish' },
            { label: '从首页下线', value: 'unpublish' },
            { label: '删除（草稿 + 页面 + 首页条目）', value: 'rm' },
            { label: '返回', value: null },
        ]);
        if (act === null) continue;
        if (act === 'edit') await openEditor(draftPath(id));
        else if (act === 'meta') {
            const cur = await readDraft(id);
            const fs2 = META_FIELDS.map((f) => ({ key: f[0], label: f[1], value: cur.meta[f[0]] || '' }));
            const r2 = await formScreen(fs2, '修改元信息');
            if (r2) { await writeDraft(id, r2, cur.body); await flash('已保存'); }
        } else if (act === 'preview') {
            const d = await readDraft(id);
            const html = await buildPageHtml(Object.assign({ date: todayStr() }, d.meta), MD.renderBody(d.body));
            const dest = path.join(CFG.tmpDir, safeFile(d.meta.file || MD.slugify(d.meta.title || id)));
            await fsp.writeFile(dest, html, 'utf8');
            await flash('预览已生成：\n' + dest);
        } else if (act === 'publish') {
            const r = await publishDraft(id, {});
            await flash('已发布：' + r.title + '\n' + r.href + '\n首页文章数：' + r.indexCount);
        } else if (act === 'unpublish') {
            const d = (await listDrafts()).find((x) => x.id === id);
            const r = await unpublish(d.href);
            await flash(r.unchanged ? '首页本来就没有这篇' : '已从首页下线：' + d.href);
        } else if (act === 'rm') {
            const d = (await listDrafts()).find((x) => x.id === id);
            const ok2 = await confirmScreen('确认删除', '将删除草稿与 ' + d.href + '\n此操作不可撤销。');
            if (ok2) { await removeDraft(id, { href: d.href }); await flash('已删除：' + id); }
        }
    }
}

async function screenPublished() {
    for (;;) {
        const rows = parseIndexRows(fs.readFileSync(P.index, 'utf8'));
        if (!rows.length) { await flash('首页暂无文章'); return; }
        const items = rows.map((r, i) => ({
            label: String(i + 1).padStart(2, '0') + '  ' + r.title,
            value: r.href,
            right: r.date,
        })).concat([{ label: '返回主菜单', value: null }]);
        const href = await pickMenu('已发布文章（' + rows.length + '）', items);
        if (href === null) return;
        const row = rows.find((r) => r.href === href);
        const act = await pickMenu(row.title, [
            { label: '从首页下线（页面文件保留）', value: 'unpublish' },
            { label: '查看页面文件路径', value: 'path' },
            { label: '返回', value: null },
        ]);
        if (act === 'unpublish') {
            const ok2 = await confirmScreen('确认下线', '将从首页移除：' + href);
            if (ok2) { const r = await unpublish(href); await flash(r.unchanged ? '首页本来就没有这篇' : '已下线：' + href + '\n备份：' + r.backup); }
        } else if (act === 'path') {
            await flash(path.join(CFG.root, href));
        }
    }
}

async function screenPush() {
    const g = await gitStatus();
    if (!g.dirty.length) { await flash('没有需要提交的改动，仓库是干净的。'); return; }
    const msg = await inputLine('Git 推送上线', '提交信息（留空用默认）', '发布文章：' + (parseIndexRows(fs.readFileSync(P.index, 'utf8'))[0] || {}).title);
    if (msg === null) return;
    const res = await gitPush(msg.trim() || null);
    await flash(res.ok
        ? '已推送到 ' + (g.remote || 'origin') + '\n' + (res.push || '').split('\n').slice(-1)[0]
        : '推送未完成：\n' + (res.push || res.commit || ''), !res.ok);
}

async function screenStatus() {
    const g = await gitStatus();
    const rows = parseIndexRows(fs.readFileSync(P.index, 'utf8'));
    const drafts = await listDrafts();
    const body = [
        '  仓库     ' + CFG.root,
        '  分支     ' + (g.branch || '?') + '   ' + (g.remote || '（无远端）'),
        '  已发布   ' + rows.length + ' 篇',
        '  草稿     ' + drafts.length + ' 篇',
        '  未提交   ' + (g.dirty.length ? g.dirty.length + ' 个文件' : '干净'),
        '',
    ].concat(g.dirty.slice(0, 15).map((x) => '    ' + x));
    clear();
    process.stdout.write(frame('仓库状态', body.map((l) => l.slice(0, termWidth() - 4)), ['  ' + paint(C.gray, '按任意键返回')]) + '\n');
    await readKey();
}

async function screenConfig() {
    for (;;) {
        const act = await pickMenu('自检 / 设置', [
            { label: '仓库根目录：' + CFG.root, value: 'root' },
            { label: '草稿目录：' + CFG.draftsDir, value: 'drafts' },
            { label: '编辑器：' + CFG.editor, value: 'editor' },
            { label: '运行自检', value: 'doctor' },
            { label: '返回主菜单', value: null },
        ]);
        if (act === null) return;
        if (act === 'root') {
            const v = await inputLine('设置', '博客仓库根目录', CFG.root);
            if (v) {
                const old = CFG.root;
                try {
                    CFG.root = path.resolve(v);
                    checkRoot();
                    saveConfig({ root: CFG.root });
                    MD = null; loadMd();
                    await flash('已切换到：' + CFG.root);
                } catch (e) {
                    CFG.root = old;
                    await flash(e.message, true);
                }
            }
        } else if (act === 'drafts') {
            const v = await inputLine('设置', '草稿目录（绝对路径；填 ' + P.adminData + '/drafts 可与网页后台共用草稿）', CFG.draftsDir);
            if (v) {
                CFG.draftsDir = path.resolve(v);
                ensureDirs();
                saveConfig({ draftsDir: CFG.draftsDir });
                await flash('草稿目录：' + CFG.draftsDir);
            }
        } else if (act === 'editor') {
            const v = await inputLine('设置', '编辑器命令（如 vim / nano / code -w）', CFG.editor);
            if (v) { CFG.editor = v; saveConfig({ editor: v }); await flash('编辑器：' + v); }
        } else if (act === 'doctor') {
            const checks = await cmdDoctorRaw();
            const body = checks.map((c) => '  ' + (c.ok ? '✓' : '✗') + ' ' + c.name + '  ' + (c.detail || ''));
            clear();
            process.stdout.write(frame('自检结果', body.map((l) => l.slice(0, termWidth() - 4)), ['  ' + paint(C.gray, '按任意键返回')]) + '\n');
            await readKey();
        }
    }
}

async function cmdDoctorRaw() {
    const checks = [];
    const add = (n, ok, d) => checks.push({ name: n, ok: ok, detail: d });
    add('仓库根目录', !!CFG.root && fs.existsSync(CFG.root), CFG.root);
    add('index.html', fs.existsSync(P.index), '存在');
    add('文章模板.html', fs.existsSync(P.template), '存在');
    add('专栏/', fs.existsSync(P.column), '存在');
    add('admin/md.js', fs.existsSync(P.md), '存在');
    const gh = await git(['remote', 'get-url', 'origin']);
    add('git 远端', !gh.failed && !!gh.out.trim(), gh.out.trim() || '（无）');
    add('草稿目录', fs.existsSync(CFG.draftsDir), CFG.draftsDir);
    add('编辑器', !!CFG.editor, CFG.editor);
    return checks;
}

function tuiExit(code) {
    process.stdout.write('\x1b[?25h\x1b[0m');
    clear();
    process.exit(code || 0);
}

async function runTui() {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
        cmdHelp();
        process.stderr.write(paint(C.yellow, '当前不是交互式终端，已显示帮助。非交互场景请用子命令，例如：') + '\n');
        process.stderr.write('  ./blog.js post --md article.md --push --json\n\n');
        process.exit(1);
    }
    TUI_ON = true;
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    process.stdout.write('\x1b[?25l');
    const bye = () => tuiExit(0);
    process.on('SIGINT', bye);
    try {
        checkRoot();
        await screenMain();
    } catch (e) {
        process.stdout.write('\x1b[?25h');
        clear();
        process.stderr.write(paint(C.red, '错误：') + e.message + '\n');
        process.exit(1);
    }
    tuiExit(0);
}

/* ============================================================
 * 主入口
 * ========================================================== */

async function main() {
    const argv = process.argv.slice(2);
    const args = parseArgs(argv);
    const f = args.f;

    CFG.json = bool(f, 'json', false) || bool(f, 'j', false);

    if (bool(f, 'help', false) || bool(f, 'h', false)) { cmdHelp(); return; }

    loadConfig();
    const rootArg = val(f, 'root', null);
    CFG.root = path.resolve(rootArg || process.env.BLOG_ROOT || CFG.__file.root || DEFAULT_ROOT);

    // 默认根目录不存在时，尝试常见位置
    if (!fs.existsSync(CFG.root)) {
        const guess = [DEFAULT_ROOT, path.resolve(CLI_DIR, '..'), path.resolve(process.cwd()), path.resolve(process.cwd(), 'syxph')];
        for (const g of guess) {
            if (fs.existsSync(path.join(g, 'index.html')) && fs.existsSync(path.join(g, '文章模板.html'))) { CFG.root = g; break; }
        }
    }
    ensureDirs();

    const cmd = (args._[0] || '').toLowerCase();
    const target = args._[1] !== undefined ? args._[1] : val(f, 'id', null);

    switch (cmd) {
        case '': case 'tui': case 'ui':
            await runTui(); return;
        case 'help': cmdHelp(); return;
        case 'list': case 'ls': await cmdList(); return;
        case 'drafts': case 'd': await cmdDrafts(); return;
        case 'new': case 'n': await cmdNew(f, args); return;
        case 'show': await cmdShow(target); return;
        case 'edit': case 'e': await cmdEdit(target); return;
        case 'set': await cmdSet(target, f); return;
        case 'post': await cmdPost(f, args); return;
        case 'publish': case 'pub': await cmdPublish(target, f); return;
        case 'unpublish': case 'off': await cmdUnpublish(f); return;
        case 'rm': case 'remove': case 'del': case 'delete': await cmdRemove(target); return;
        case 'preview': case 'prev': await cmdPreview(target, f); return;
        case 'status': case 'st': await cmdStatus(); return;
        case 'push': case 'deploy': await cmdPush(f); return;
        case 'doctor': await cmdDoctor(); return;
        default:
            process.stderr.write(paint(C.red, '未知命令：') + cmd + '\n');
            cmdHelp();
            process.exit(1);
    }
}

main().catch((e) => fail(e));
