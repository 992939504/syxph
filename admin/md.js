/*
 * md.js — 绝顶赵博客专用 Markdown 解析器
 * 浏览器（window.md）与 Node（require）共用，保证「预览 = 发布成品」。
 *
 * 语法速查（详见后台「帮助」面板）：
 *   元信息        --- frontmatter（title/date/badge/series/sub/summary/file/prev/prevTitle/next/nextTitle）
 *   ##           章节标题（section-heading）      ###  分节（sub-heading）
 *   **加粗**     加粗                            ==高亮==  黄底黑字
 *   ++关键词++   黄色马克笔关键词                `代码`    行内代码
 *   > 金句       金句卡（quote-block）
 *   ::: quote / qa / case / framework / highlight / formula / note   站点专属卡片块
 *   ```lang      代码块（formula-block 样式）
 *   | 表格 |     Markdown 表格（自动包 article-table-wrap）
 *   ---          分隔线（divider）
 *   无序/有序列表、嵌套列表、链接、图片、行内 HTML（<svg> 等直接透传）
 */
(function (root, factory) {
    if (typeof module === 'object' && typeof module.exports === 'object') {
        module.exports = factory();
    } else {
        root.md = factory();
    }
})(typeof self !== 'undefined' ? self : globalThis, function () {
    'use strict';

    var KNOWN_KEYS = ['title', 'date', 'badge', 'series', 'sub', 'summary', 'file',
        'prev', 'prevTitle', 'next', 'nextTitle', 'accent'];

    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
    function escText(s) { // 公式/代码块内：保留换行，只转义关键字符
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    /* ---------------- 行内解析 ---------------- */
    function inline(src) {
        var stash = [];
        var s = String(src == null ? '' : src);
        // 1. 行内代码（保护）
        s = s.replace(/`([^`\n]+)`/g, function (m, c) {
            stash.push('<code>' + esc(c) + '</code>');
            return '\u0000' + (stash.length - 1) + '\u0000';
        });
        // 2. 行内原始 HTML 透传（保护：<svg> 图标、<strong class="keyword"> 等）
        s = s.replace(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<\/?[a-zA-Z][^>]*>/g, function (m) {
            stash.push(m);
            return '\u0000' + (stash.length - 1) + '\u0000';
        });
        // 3. 反斜杠转义
        s = s.replace(/\\([\\`*_[\]()#+\-.!>=~|])/g, '$1');
        // 4. 图片
        s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g, function (m, alt, url) {
            return '<img src="' + esc(url) + '" alt="' + esc(alt) + '">';
        });
        // 5. 链接（内部递归 inline，支持链接文字嵌套样式）
        s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, function (m, text, url) {
            return '<a href="' + esc(url) + '">' + inline(text) + '</a>';
        });
        // 6. 加粗 / 高亮 / 关键词 / 斜体
        s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
        s = s.replace(/==([^=\n]+)==/g, '<span class="highlight">$1</span>');
        s = s.replace(/\+\+([^+\n]+)\+\+/g, '<strong class="keyword">$1</strong>');
        s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
        s = s.replace(/(^|[^_\w])_([^_\n]+)_(?!_)/g, '$1<em>$2</em>');
        // 7. 换行（块内多行文本折成 <br>）
        s = s.replace(/\n/g, '<br>');
        // 8. 还原占位
        s = s.replace(/\u0000(\d+)\u0000/g, function (m, i) { return stash[+i] || ''; });
        return s;
    }

    function splitParagraphs(text) {
        return text.split(/\n\s*\n/).map(function (p) { return p.trim(); }).filter(Boolean);
    }

    /* ---------------- 列表 ---------------- */
    function renderList(lines) {
        // 收集 list 行与续行（比项目符号更深的缩进行）
        var items = [];
        var i = 0;
        while (i < lines.length) {
            var line = lines[i];
            var m = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
            if (!m) { i++; continue; }
            var indent = m[1].replace(/\t/g, '    ').length;
            var text = m[3];
            i++;
            // 续行：更深缩进、非空、不是其他块起始
            while (i < lines.length) {
                var cont = lines[i];
                if (/^\s*$/.test(cont)) break;
                var contIndent = cont.match(/^(\s*)/)[1].replace(/\t/g, '    ').length;
                var isNewItem = /^\s*([-*+]|\d+[.)])\s+/.test(cont);
                if (isNewItem || contIndent <= indent + 1) break;
                text += '\n' + cont.trim();
                i++;
            }
            items.push({ indent: indent, ordered: /^\d+[.)]/.test(m[2]), text: inline(text), children: [] });
        }
        // 按缩进建树
        var stack = [];
        var roots = [];
        items.forEach(function (it) {
            while (stack.length && stack[stack.length - 1].indent >= it.indent) stack.pop();
            if (stack.length) stack[stack.length - 1].children.push(it);
            else roots.push(it);
            stack.push(it);
        });
        function render(itemsArr) {
            if (!itemsArr.length) return '';
            var isOl = itemsArr[0].ordered;
            var html = '<' + (isOl ? 'ol' : 'ul') + '>\n';
            itemsArr.forEach(function (it) {
                html += '<li>' + it.text;
                var kids = it.children.filter(function (c) { return c.ordered === it.children[0].ordered; });
                if (kids.length) html += '\n' + render(kids);
                html += '</li>\n';
            });
            html += '</' + (isOl ? 'ol' : 'ul') + '>';
            return html;
        }
        // 同一层混用 ul/ol 时按第一项类型渲染
        return render(roots);
    }

    /* ---------------- 表格 ---------------- */
    function splitCells(line) {
        return line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(function (c) { return c.trim(); });
    }
    function renderTable(rows) {
        var head = splitCells(rows[0]);
        var bodyRows = rows.slice(2).map(splitCells);
        var html = '<div class="article-table-wrap">\n<table>\n<thead>\n<tr>' +
            head.map(function (c) { return '<th>' + inline(c) + '</th>'; }).join('') +
            '</tr>\n</thead>\n<tbody>\n';
        bodyRows.forEach(function (cells) {
            html += '<tr>' + cells.map(function (c) { return '<td>' + inline(c) + '</td>'; }).join('') + '</tr>\n';
        });
        html += '</tbody>\n</table>\n</div>';
        return html;
    }

    /* ---------------- 站点专属卡片块 ---------------- */
    function renderContainer(type, arg, contentLines) {
        var body = contentLines.join('\n').replace(/^\n+|\n+$/g, '');
        var ps, html;
        switch (type) {
            case 'quote': case 'quote-block': case '金句':
                if (!/\n\s*\n/.test(body)) {
                    html = '<div class="quote-block">\n<p><strong>' + inline(body.trim()) + '</strong></p>\n</div>';
                } else {
                    html = '<div class="quote-block">\n' + splitParagraphs(body).map(function (p) {
                        return '<p>' + inline(p) + '</p>';
                    }).join('\n') + '\n</div>';
                }
                return html;
            case 'qa': case '问答': {
                var qLines = contentLines.slice();
                var question = '';
                while (qLines.length && !qLines[0].trim()) qLines.shift();
                if (qLines.length) question = qLines.shift().trim();
                var answer = renderBody(qLines.join('\n').trim());
                return '<div class="qa-block">\n<span class="qa-label">' + esc(arg || 'Q & A') + '</span>\n' +
                    '<div class="qa-q">' + inline(question) + '</div>\n' + answer + '\n</div>';
            }
            case 'case': case '案例':
                return '<div class="case-block">\n<span class="case-label">' + esc(arg || '举个例子') + '</span>\n' +
                    renderBody(body) + '\n</div>';
            case 'framework': case '框架': {
                var itemsHtml = contentLines.map(function (l) {
                    var lm = l.trim().match(/^[-*+]\s+(.*)$/);
                    if (!lm) return '';
                    var tm = lm[1].match(/^(?:\*\*(.+?)\*\*|(.+?))(?:\s*[—–:：][—–]?\s*(.*))?$/);
                    var term = (tm && (tm[1] || tm[2])) || lm[1];
                    var rest = tm && tm[3] ? tm[3] : '';
                    return '<div class="fw-item"><span class="fw-term">' + inline(term) + '</span>' +
                        (rest ? ' —— ' + inline(rest) : '') + '</div>';
                }).filter(Boolean).join('\n');
                return '<div class="framework-block">\n<span class="fw-label">' + esc(arg || '框架') + '</span>\n' +
                    itemsHtml + '\n</div>';
            }
            case 'highlight': case 'highlight-block': case '重点':
                if (!/\n\s*\n/.test(body)) {
                    html = '<div class="highlight-block">\n<p><strong>' + inline(body.trim()) + '</strong></p>\n</div>';
                } else {
                    html = '<div class="highlight-block">\n' + splitParagraphs(body).map(function (p) {
                        return '<p>' + inline(p) + '</p>';
                    }).join('\n') + '\n</div>';
                }
                return html;
            case 'formula': case '公式': case 'code':
                return '<div class="formula-block">' +
                    (arg ? '<span class="fb-title">' + esc(arg) + '</span>\n' : '') +
                    escText(body) + '\n</div>';
            case 'note': case '预告': case 'footer-note':
                return '<div class="footer-note">\n<span class="label">' + esc(arg || '预告') + '</span>\n' +
                    splitParagraphs(body).map(function (p) { return '<p>' + inline(p) + '</p>'; }).join('\n') + '\n</div>';
            default:
                // 未知类型：按普通段落渲染
                return renderBody(body);
        }
    }

    /* ---------------- 块级解析 ---------------- */
    var BLOCK_START = /^(#{1,6}\s|:::\s|```|>\s?|[-*+]\s|\d+[.)]\s|\|\s|(-{3,}|\*{3,}|_{3,})\s*$)/;

    function renderBody(mdText) {
        var lines = String(mdText == null ? '' : mdText).replace(/\r\n?/g, '\n').split('\n');
        var out = [];
        var i = 0;
        var n = lines.length;
        var inBlock = false;

        while (i < n) {
            var line = lines[i];

            if (/^\s*$/.test(line)) { i++; continue; }

            // 卡片块容器 :::type arg
            var fm = line.match(/^:::\s*(\S+)(?:\s+(.*))?\s*$/);
            if (fm && fm[1] !== '::') {
                var type = fm[1];
                var arg = (fm[2] || '').trim();
                var content = [];
                i++;
                while (i < n && !/^:::\s*$/.test(lines[i])) { content.push(lines[i]); i++; }
                i++; // 跳过结束符
                out.push(renderContainer(type, arg, content));
                continue;
            }

            // 代码围栏
            if (/^```/.test(line)) {
                var lang = line.replace(/^```\s*/, '').trim();
                var code = [];
                i++;
                while (i < n && !/^```/.test(lines[i])) { code.push(lines[i]); i++; }
                i++;
                out.push(renderContainer('formula', lang, code));
                continue;
            }

            // 标题
            var h = line.match(/^(#{1,6})\s+(.*)$/);
            if (h) {
                var level = h[1].length;
                var hcls = level <= 2 ? 'section-heading' : 'sub-heading';
                out.push('<h' + (level <= 2 ? 2 : 3) + ' class="' + hcls + '">' + inline(h[2].trim()) + '</h' + (level <= 2 ? 2 : 3) + '>');
                i++;
                continue;
            }

            // 分隔线
            if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { out.push('<hr class="divider">'); i++; continue; }

            // 引用（金句卡）
            if (/^>\s?/.test(line)) {
                var q = [];
                while (i < n && /^>\s?/.test(lines[i])) { q.push(lines[i].replace(/^>\s?/, '')); i++; }
                var qbody = q.join('\n').trim();
                if (!/\n\s*\n/.test(qbody) && q.length === 1) {
                    out.push('<div class="quote-block">\n<p><strong>' + inline(qbody) + '</strong></p>\n</div>');
                } else {
                    out.push('<div class="quote-block">\n' + splitParagraphs(qbody).map(function (p) {
                        return '<p>' + inline(p) + '</p>';
                    }).join('\n') + '\n</div>');
                }
                continue;
            }

            // 表格
            if (/^\|.*\|\s*$/.test(line) && i + 1 < n && /^\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
                var trows = [];
                while (i < n && /^\|.*\|\s*$/.test(lines[i])) { trows.push(lines[i]); i++; }
                out.push(renderTable(trows));
                continue;
            }

            // 列表
            if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
                var llines = [];
                while (i < n && !/^\s*$/.test(lines[i])) {
                    if (!/^\s*([-*+]|\d+[.)])\s+/.test(lines[i]) && llines.length && !BLOCK_START.test(lines[i])) {
                        // 续行
                        llines.push(lines[i]);
                        i++;
                        continue;
                    }
                    if (!/^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) break;
                    llines.push(lines[i]);
                    i++;
                }
                out.push(renderList(llines));
                continue;
            }

            // 段落
            var p = [line];
            i++;
            while (i < n) {
                var next = lines[i];
                if (/^\s*$/.test(next)) break;
                if (BLOCK_START.test(next)) break;
                p.push(next);
                i++;
            }
            out.push('<p>' + inline(p.join('\n')) + '</p>');
        }
        void inBlock;
        return out.join('\n');
    }

    /* ---------------- frontmatter ---------------- */
    function parse(mdText) {
        var text = String(mdText == null ? '' : mdText).replace(/\r\n?/g, '\n');
        var meta = {};
        var body = text;
        var m = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
        if (m) {
            body = text.slice(m[0].length);
            m[1].split('\n').forEach(function (line) {
                var kv = line.match(/^([A-Za-z][\w-]*)\s*:\s*(.*)$/);
                if (kv) meta[kv[1]] = kv[2].trim();
            });
        }
        return { meta: meta, body: body };
    }

    function stringifyMeta(meta) {
        var out = '---\n';
        var keys = KNOWN_KEYS.filter(function (k) { return meta[k] !== undefined && String(meta[k]).trim() !== ''; });
        Object.keys(meta).forEach(function (k) {
            if (KNOWN_KEYS.indexOf(k) === -1 && String(meta[k]).trim() !== '') keys.push(k);
        });
        keys.forEach(function (k) {
            out += k + ': ' + String(meta[k]).replace(/\n/g, ' ').trim() + '\n';
        });
        out += '---\n';
        return out;
    }

    /* ---------------- 标题（accent 黄色部分） ---------------- */
    function buildTitle(meta) {
        var title = String((meta && meta.title) || '未命名文章');
        var m = title.match(/^(.*)\*\*(.+?)\*\*(.*)$/);
        if (m) {
            return esc(m[1]) + '<span class="accent">' + esc(m[2]) + '</span>' + esc(m[3]);
        }
        if (meta && meta.accent && title.indexOf(meta.accent) !== -1) {
            var idx = title.indexOf(meta.accent);
            return esc(title.slice(0, idx)) + '<span class="accent">' + esc(meta.accent) + '</span>' + esc(title.slice(idx + meta.accent.length));
        }
        return esc(title);
    }

    /* ---------------- 文章头部（hero） ---------------- */
    function buildHead(meta) {
        meta = meta || {};
        var m = '<div class="article-head-meta">\n';
        if (meta.badge) m += '<span class="badge-community">' + esc(meta.badge) + '</span>\n';
        if (meta.series) m += '<span class="article-series">' + esc(meta.series) + '</span>\n';
        m += '<time class="article-date" datetime="' + esc(meta.date || '') + '">' + esc(meta.date || '') + '</time>\n';
        m += '</div>\n';
        m += '<h1 class="article-head-title">' + buildTitle(meta) + '</h1>\n';
        m += '<p class="article-head-sub">' + esc(meta.sub || '') + '</p>\n';
        return '<header class="article-head reveal">\n' + m + '</header>';
    }

    /* ---------------- 系列导航 ---------------- */
    var ARROW_LEFT = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m12 19-7-7 7-7"/><path d="M19 12H5"/></svg>';
    var ARROW_RIGHT = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>';

    function buildSeriesNav(meta) {
        meta = meta || {};
        var prev, next;
        if (meta.prev) {
            prev = '<a class="series-card" href="' + esc(meta.prev) + '">\n' +
                '<span class="series-label">' + ARROW_LEFT + '上一篇</span>\n' +
                '<span class="series-title">' + esc(meta.prevTitle || '上一篇') + '</span>\n</a>';
        } else {
            prev = '<a class="series-card disabled" href="#" aria-disabled="true">\n' +
                '<span class="series-label">上一篇</span>\n' +
                '<span class="series-title">这是系列的第一篇</span>\n</a>';
        }
        if (meta.next) {
            next = '<a class="series-card next" href="' + esc(meta.next) + '">\n' +
                '<span class="series-label">下一篇\n' + ARROW_RIGHT + '</span>\n' +
                '<span class="series-title">' + esc(meta.nextTitle || '下一篇') + '</span>\n</a>';
        } else {
            next = '<a class="series-card next disabled" href="#" aria-disabled="true">\n' +
                '<span class="series-label">下一篇</span>\n' +
                '<span class="series-title">这是系列的最后一篇</span>\n</a>';
        }
        return '<nav class="series-nav">\n' + prev + '\n' + next + '\n</nav>';
    }

    /* ---------------- 文件名净化（遵守 README 踩坑约定：全角冒号/问号入文件名有 CDN 隐患） ---------------- */
    function slugify(name) {
        var s = String(name || '')
            .replace(/[：:?？/\\*"<>|#%&$@`~^+=\[\]]/g, '-')
            .replace(/-+/g, '-')
            .replace(/^-+|-+$/g, '')
            .replace(/\s+/g, '-')
            .trim();
        if (!s) s = '未命名文章';
        s = s.replace(/^\.+/, '').replace(/\.\./g, '.').slice(0, 60);
        return s;
    }

    return {
        esc: esc,
        inline: inline,
        renderBody: renderBody,
        parse: parse,
        stringifyMeta: stringifyMeta,
        buildTitle: buildTitle,
        buildHead: buildHead,
        buildSeriesNav: buildSeriesNav,
        slugify: slugify,
        KNOWN_KEYS: KNOWN_KEYS
    };
});
