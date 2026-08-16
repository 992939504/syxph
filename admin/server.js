/*
 * server.js — 绝顶赵博客 · 文章管理后台（零依赖，Node 18+）
 *
 * 功能：
 *   - 提供可视化编辑器（左预览 / 右 Markdown）
 *   - 草稿保存为 Markdown（admin/data/drafts，不入库）
 *   - 发布：由 文章模板.html 生成 专栏/xxx.html，并自动更新 index.html
 *     的文章列表与归档筛选器（改动前自动备份到 admin/data/backups）
 *   - 下线 / 删除 / Git 推送上线
 *
 * 启动：node admin/server.js   （默认 http://127.0.0.1:8618，PORT 环境变量可覆盖）
 */
'use strict';

const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { execFile } = require('child_process');

const md = require('./md.js');

const ROOT = path.resolve(__dirname, '..');
const ADMIN = __dirname;
const DATA = path.join(ADMIN, 'data');
const DRAFTS = path.join(DATA, 'drafts');
const BACKUPS = path.join(DATA, 'backups');
const TEMPLATE = path.join(ROOT, '文章模板.html');
const INDEX = path.join(ROOT, 'index.html');
const COLUMN = path.join(ROOT, '专栏');

const PORT = parseInt(process.env.PORT || '8618', 10);
const HOST = process.env.HOST || '127.0.0.1';
const MAX_BODY = 10 * 1024 * 1024;

for (const d of [DATA, DRAFTS, BACKUPS]) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

/* ================= 工具 ================= */

function json(res, code, obj) {
    const body = JSON.stringify(obj, null, 2);
    res.writeHead(code, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', (c) => {
            size += c.length;
            if (size > MAX_BODY) { reject(new Error('请求体过大')); req.destroy(); return; }
            chunks.push(c);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

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

function safeId(id) {
    // 草稿文件名：中文/字母/数字/下划线/连字符/全角括号/点/空格，禁路径穿越
    let s = String(id || '').replace(/[\\/]/g, '-').replace(/\.\./g, '.').trim();
    s = s.replace(/[^\w\u4e00-\u9fa5()（）·、\-.\s]/g, '').slice(0, 80);
    if (!s) throw new Error('草稿名不能为空');
    return s;
}

function safeFile(file) {
    // 专栏页面文件名：只留安全字符，全角冒号/问号一律替换（README 踩坑约定）
    let s = String(file || '').replace(/[\\/]/g, '-').replace(/\.\./g, '.').trim();
    s = s.replace(/[：:?？*"<>|]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    s = s.replace(/[^\w\u4e00-\u9fa5()（）·、\-.]/g, '').slice(0, 80);
    if (!s) throw new Error('文件名不能为空');
    if (!s.endsWith('.html')) s += '.html';
    return s;
}

/* ================= 首页（index.html）解析与重建 ================= */

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
    const e = md.esc;
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

function renderRows(rows) {
    return rows.map((r, i) => renderRow(r, i + 1)).join('\n\n');
}

function renderAfBody(rows) {
    const e = md.esc;
    const counts = new Map();
    for (const r of rows) {
        if (r.month) counts.set(r.month, (counts.get(r.month) || 0) + 1);
    }
    const months = [...counts.keys()].sort().reverse();
    let html = `                    <button type="button" class="af-btn active" data-month="all"><span>全部文章</span><span class="af-count">${rows.length} 篇</span></button>`;
    for (const mon of months) {
        const [y, m] = mon.split('-');
        const label = `${y} 年 ${parseInt(m, 10)} 月`;
        html += `\n                    <button type="button" class="af-btn" data-month="${e(mon)}"><span>${label}</span><span class="af-count">${counts.get(mon)} 篇</span></button>`;
    }
    return html;
}

async function backupIndex() {
    const file = path.join(BACKUPS, `index-${timestamp()}.html`);
    await fsp.copyFile(INDEX, file);
    // 只保留最近 30 份备份
    const files = (await fsp.readdir(BACKUPS)).filter((f) => f.startsWith('index-')).sort();
    while (files.length > 30) {
        await fsp.unlink(path.join(BACKUPS, files.shift())).catch(() => {});
    }
    return file;
}

async function updateIndex(rows) {
    const html = await fsp.readFile(INDEX, 'utf8');
    if (!html.includes('<div class="article-list">')) throw new Error('index.html 中找不到文章列表容器');
    const listRe = /<div class="article-list">[\s\S]*?(?=<div id="articles-empty")/;
    const afRe = /<div class="af-body" id="af-body">[\s\S]*?<\/div>/;

    const newList = `<div class="article-list">\n${renderRows(rows)}\n        </div>\n\n                `;
    const newAf = `<div class="af-body" id="af-body">\n${renderAfBody(rows)}\n                </div>`;

    let out = html.replace(listRe, () => newList);
    if (out === html) throw new Error('文章列表替换失败');
    out = out.replace(afRe, () => newAf);
    if (out === html || !out.includes('id="af-body"')) throw new Error('归档筛选器替换失败');

    const backup = await backupIndex();
    await fsp.writeFile(INDEX, out, 'utf8');
    return { backup, count: rows.length };
}

function monthOf(date) {
    const m = String(date || '').match(/^(\d{4})-(\d{2})/);
    return m ? m[0] : todayStr().slice(0, 7);
}

/* ================= 文章页面生成 ================= */

async function buildPage(meta, bodyHtml) {
    const tpl = await fsp.readFile(TEMPLATE, 'utf8');
    const file = safeFile(meta.file || md.slugify(meta.title || '未命名文章'));
    const title = String(meta.title || '未命名文章').replace(/\*\*/g, '');

    // <title>
    let out = tpl.replace(/<title>[\s\S]*?<\/title>/, `<title>${md.esc(title)} · __SITE__</title>`);
    // hero 头部
    out = out.replace(/<header class="article-head reveal">[\s\S]*?<\/header>/, () => md.buildHead(meta));
    // 正文（两个注释标记之间）
    out = out.replace(/<!-- =+ 从这里开始写 =+ -->[\s\S]*?<!-- =+ 写到这里结束 =+ -->/,
        () => `<!-- ============ 从这里开始写 ============ -->\n        <div class="article-body">\n\n${bodyHtml}\n\n        </div>\n        <!-- ============ 写到这里结束 ============ -->`);
    // 系列导航
    out = out.replace(/<nav class="series-nav">[\s\S]*?<\/nav>/, () => md.buildSeriesNav(meta));

    const target = path.join(COLUMN, file);
    await fsp.writeFile(target, out, 'utf8');
    return { file, target };
}

/* ================= 草稿 ================= */

function draftPath(id) {
    return path.join(DRAFTS, safeId(id) + '.md');
}

async function readDraft(id) {
    const p = draftPath(id);
    if (!fs.existsSync(p)) throw new Error('草稿不存在：' + id);
    const parsed = md.parse(await fsp.readFile(p, 'utf8'));
    return { id: safeId(id), meta: parsed.meta, body: parsed.body };
}

async function listDrafts(indexRows) {
    const files = (await fsp.readdir(DRAFTS)).filter((f) => f.endsWith('.md')).sort();
    const drafts = [];
    for (const f of files) {
        const id = f.slice(0, -3);
        try {
            const parsed = md.parse(await fsp.readFile(path.join(DRAFTS, f), 'utf8'));
            const file = safeFile(parsed.meta.file || md.slugify(parsed.meta.title || id));
            const href = `专栏/${file}`;
            drafts.push({
                id,
                title: (parsed.meta.title || id).replace(/\*\*/g, ''),
                date: parsed.meta.date || '',
                badge: parsed.meta.badge || '',
                series: parsed.meta.series || '',
                file,
                href,
                pageExists: fs.existsSync(path.join(COLUMN, file)),
                published: indexRows.some((r) => r.href === href),
            });
        } catch (_) { /* 跳过损坏的草稿 */ }
    }
    return drafts;
}

/* ================= Git ================= */

function runGit(args) {
    return new Promise((resolve) => {
        execFile('git', args, { cwd: ROOT, maxBuffer: 8 * 1024 * 1024, timeout: 120000 }, (err, stdout, stderr) => {
            resolve({ code: err ? (err.code || 1) : 0, out: (stdout || '') + (stderr || ''), failed: !!err });
        });
    });
}

/* ================= HTTP 路由 ================= */

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.md': 'text/markdown; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.jfif': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2',
};

async function serveStatic(req, res, urlPath) {
    if (req.method !== 'GET' && req.method !== 'HEAD') { json(res, 405, { error: 'method not allowed' }); return; }
    let rel;
    try {
        rel = decodeURIComponent(urlPath.split('?')[0]);
    } catch (_) {
        json(res, 400, { error: '非法路径' });
        return;
    }
    if (rel === '/' || rel === '') rel = '/admin/editor.html';
    if (rel.startsWith('/')) rel = rel.slice(1);
    const abs = path.resolve(ROOT, rel);
    if (!abs.startsWith(ROOT + path.sep) && abs !== ROOT) { json(res, 403, { error: '禁止访问' }); return; }
    try {
        const st = await fsp.stat(abs);
        if (st.isDirectory()) { json(res, 404, { error: 'not found' }); return; }
        const data = await fsp.readFile(abs);
        res.writeHead(200, {
            'Content-Type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream',
            'Content-Length': data.length,
        });
        res.end(req.method === 'HEAD' ? undefined : data);
    } catch (_) {
        json(res, 404, { error: 'not found' });
    }
}

async function handleApi(req, res, urlPath) {
    const seg = urlPath.split('?')[0].replace(/^\/api\/?/, '');
    try {
        if (req.method === 'GET' && seg === 'articles') {
            const indexHtml = await fsp.readFile(INDEX, 'utf8');
            const rows = parseIndexRows(indexHtml);
            const drafts = await listDrafts(rows);
            const site = rows.map((r) => ({
                ...r,
                hasSource: drafts.some((d) => d.href === r.href),
            }));
            json(res, 200, { ok: true, drafts, site });
            return;
        }

        if (req.method === 'GET' && seg.startsWith('article')) {
            const id = new URLSearchParams(urlPath.split('?')[1] || '').get('id');
            if (!id) { json(res, 400, { error: '缺少 id' }); return; }
            json(res, 200, { ok: true, ...(await readDraft(id)) });
            return;
        }

        if (req.method === 'POST') {
            const payload = JSON.parse(await readBody(req));

            if (seg === 'save') {
                const id = safeId(payload.id || md.slugify(payload.meta?.title || '新文章'));
                const meta = payload.meta || {};
                const metaOut = {};
                for (const k of md.KNOWN_KEYS) {
                    const v = meta[k];
                    if (v !== undefined && String(v).trim() !== '') metaOut[k] = String(v).trim();
                }
                await fsp.writeFile(draftPath(id), md.stringifyMeta(metaOut) + (payload.body || ''), 'utf8');
                json(res, 200, { ok: true, id });
                return;
            }

            if (seg === 'publish') {
                const { id } = payload;
                const draft = await readDraft(id);
                const meta = draft.meta;
                if (!meta.title) { json(res, 400, { error: '缺少文章标题（title）' }); return; }
                if (!meta.date) meta.date = todayStr();
                if (!meta.summary) meta.summary = meta.sub || meta.title.replace(/\*\*/g, '');

                const bodyHtml = md.renderBody(draft.body);
                const { file, target } = await buildPage(meta, bodyHtml);
                const href = `专栏/${file}`;

                const indexHtml = await fsp.readFile(INDEX, 'utf8');
                const rows = parseIndexRows(indexHtml).filter((r) => r.href !== href);
                rows.unshift({
                    href,
                    month: monthOf(meta.date),
                    badge: meta.badge || '',
                    series: meta.series || '',
                    date: meta.date,
                    title: meta.title.replace(/\*\*/g, ''),
                    summary: meta.summary,
                });
                const info = await updateIndex(rows);
                json(res, 200, { ok: true, file, href, target, backup: info.backup, indexCount: info.count });
                return;
            }

            if (seg === 'unpublish') {
                let href = payload.href;
                if (!href && payload.id) {
                    const d = await readDraft(payload.id);
                    href = `专栏/${safeFile(d.meta.file || md.slugify(d.meta.title || payload.id))}`;
                }
                if (!href) { json(res, 400, { error: '缺少 href 或 id' }); return; }
                const indexHtml = await fsp.readFile(INDEX, 'utf8');
                const rows = parseIndexRows(indexHtml).filter((r) => r.href !== href);
                if (rows.length === parseIndexRows(indexHtml).length) {
                    json(res, 200, { ok: true, unchanged: true });
                    return;
                }
                const info = await updateIndex(rows);
                json(res, 200, { ok: true, backup: info.backup });
                return;
            }

            if (seg === 'delete') {
                const { id } = payload;
                let href = payload.href;
                if (id) {
                    const dp = draftPath(id);
                    if (fs.existsSync(dp)) {
                        if (!href) {
                            try {
                                const d = md.parse(await fsp.readFile(dp, 'utf8'));
                                href = `专栏/${safeFile(d.meta.file || md.slugify(d.meta.title || id))}`;
                            } catch (_) { /* 草稿损坏时仅删文件 */ }
                        }
                        await fsp.unlink(dp);
                    }
                }
                if (href) {
                    // 移除首页条目
                    const indexHtml = await fsp.readFile(INDEX, 'utf8');
                    const rows = parseIndexRows(indexHtml).filter((r) => r.href !== href);
                    if (rows.length !== parseIndexRows(indexHtml).length) await updateIndex(rows);
                    // 删除专栏页面
                    const file = href.replace(/^专栏\//, '');
                    const target = path.join(COLUMN, file);
                    if (target.startsWith(COLUMN + path.sep) && fs.existsSync(target)) await fsp.unlink(target);
                }
                json(res, 200, { ok: true });
                return;
            }

            if (seg === 'git') {
                const action = payload.action || 'status';
                if (action === 'push') {
                    const title = String(payload.title || '更新文章').replace(/\*\*/g, '');
                    const s1 = await runGit(['add', '-A']);
                    const s2 = await runGit(['status', '--porcelain']);
                    let commitRes = { code: 0, out: '没有需要提交的改动', failed: false };
                    if (s2.out.trim()) {
                        commitRes = await runGit(['commit', '-m', `发布文章：${title}`]);
                    }
                    let pushRes = { code: 0, out: '', failed: false };
                    if (!commitRes.failed && s2.out.trim()) {
                        pushRes = await runGit(['push']);
                    }
                    json(res, 200, {
                        ok: true,
                        steps: { add: s1.out, commit: commitRes.out, push: pushRes.out },
                        failed: s1.failed || commitRes.failed || pushRes.failed,
                    });
                    return;
                }
                const s = await runGit(['status', '--porcelain']);
                const b = await runGit(['branch', '--show-current']);
                const r = await runGit(['remote', 'get-url', 'origin']);
                json(res, 200, { ok: true, dirty: s.out.split('\n').filter(Boolean).slice(0, 50), branch: b.out.trim(), remote: r.out.trim() });
                return;
            }
        }

        json(res, 404, { error: '未知接口：' + seg });
    } catch (err) {
        json(res, 400, { error: err.message || String(err) });
    }
}

const server = http.createServer((req, res) => {
    const urlPath = (req.url || '/');
    if (urlPath.startsWith('/api/')) {
        handleApi(req, res, urlPath).catch((err) => json(res, 500, { error: err.message || String(err) }));
        return;
    }
    serveStatic(req, res, urlPath).catch((err) => json(res, 500, { error: err.message || String(err) }));
});

server.listen(PORT, HOST, () => {
    console.log('');
    console.log('  绝顶赵 · 文章管理后台已启动');
    console.log(`  地址：http://${HOST}:${PORT}`);
    console.log('  按 Ctrl+C 停止服务');
    console.log('');
});
