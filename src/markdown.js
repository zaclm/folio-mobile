import MarkdownIt from 'markdown-it';
import taskLists from 'markdown-it-task-lists';
import anchor from 'markdown-it-anchor';
import footnote from 'markdown-it-footnote';
import katexPlugin from '@vscode/markdown-it-katex';
import hljs from 'highlight.js/lib/common';
import DOMPurify from 'dompurify';
import { escapeHtml } from './util.js';

// ---------- front matter ----------
const FM_RE = /^(---|\+\+\+)[ \t]*\r?\n([\s\S]*?)\r?\n\1[ \t]*(\r?\n|$)/;
export function splitFrontMatter(text) {
  const m = text.match(FM_RE);
  if (!m) return { frontMatter: '', body: text };
  return { frontMatter: m[0], body: text.slice(m[0].length) };
}
export function parseFrontMatterPairs(fm) {
  // light YAML: show simple key: value pairs
  const inner = fm.replace(/^(---|\+\+\+)[ \t]*\r?\n/, '').replace(/\r?\n(---|\+\+\+)[ \t]*(\r?\n)?$/, '');
  const out = [];
  let cur = null;
  for (const line of inner.split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_\-. ]+)\s*[:=]\s*(.*)$/);
    if (kv && !line.startsWith(' ')) {
      cur = { key: kv[1].trim(), value: kv[2].trim().replace(/^\[(.*)\]$/, '$1').replace(/^["']|["']$/g, '') };
      out.push(cur);
    } else if (cur && /^\s+-\s+/.test(line)) {
      cur.value = (cur.value ? cur.value + ', ' : '') + line.replace(/^\s+-\s+/, '').replace(/^["']|["']$/g, '');
    }
  }
  return out;
}

// ---------- slug (same for reader + outline) ----------
export function slugify(s) {
  return String(s).trim().toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-');
}

// ---------- reader markdown-it ----------
export const LANG_ALIASES = {
  js: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript', py: 'python', sh: 'bash', shell: 'bash',
  zsh: 'bash', ps: 'powershell', ps1: 'powershell', yml: 'yaml', md: 'markdown', rb: 'ruby', rs: 'rust', 'c++': 'cpp',
  cs: 'csharp', 'c#': 'csharp', kt: 'kotlin', html: 'xml', htm: 'xml', svg: 'xml', vue: 'xml', golang: 'go', console: 'bash',
};
export const LANG_LABELS = {
  javascript: 'JavaScript', typescript: 'TypeScript', python: 'Python', bash: 'Bash', powershell: 'PowerShell', json: 'JSON',
  yaml: 'YAML', markdown: 'Markdown', xml: 'HTML', css: 'CSS', scss: 'SCSS', sql: 'SQL', java: 'Java', csharp: 'C#',
  cpp: 'C++', c: 'C', go: 'Go', rust: 'Rust', ruby: 'Ruby', php: 'PHP', kotlin: 'Kotlin', swift: 'Swift', diff: 'Diff',
  plaintext: 'Text', text: 'Text', ini: 'INI', makefile: 'Makefile', lua: 'Lua', r: 'R', perl: 'Perl', graphql: 'GraphQL',
  mermaid: 'Mermaid', dockerfile: 'Dockerfile',
};
export function normLang(l) {
  const k = String(l || '').trim().toLowerCase();
  return LANG_ALIASES[k] || k;
}
export function highlight(code, lang) {
  const l = normLang(lang);
  try {
    if (l && hljs.getLanguage(l)) return hljs.highlight(code, { language: l, ignoreIllegals: true }).value;
  } catch { /* fall through */ }
  return escapeHtml(code);
}

const md = new MarkdownIt({
  html: true,
  linkify: true,
  typographer: false,
  breaks: false,
  highlight: (code, lang) => highlight(code, lang),
});
md.use(taskLists, { enabled: true, label: true });
md.use(footnote);
md.use(katexPlugin.default || katexPlugin, { throwOnError: false });
md.use(anchor.default || anchor, { slugify, tabIndex: false });

// Code blocks: Claude-style card with header (language + copy)
md.renderer.rules.fence = (tokens, idx, options) => {
  const token = tokens[idx];
  const info = (token.info || '').trim();
  const rawLang = info.split(/\s+/)[0] || '';
  const lang = normLang(rawLang);
  const code = token.content;
  if (lang === 'mermaid') {
    return `<div class="mermaid-block" data-src="${escapeHtml(encodeURIComponent(code))}"><pre class="mermaid-fallback"><code>${escapeHtml(code)}</code></pre></div>`;
  }
  const label = LANG_LABELS[lang] || rawLang || '';
  const body = options.highlight(code, rawLang);
  return `<div class="code-card"><div class="code-head"><span class="code-lang">${escapeHtml(label)}</span><button class="code-copy" type="button" title="Copy code"></button></div><pre><code class="hljs${lang ? ` language-${escapeHtml(lang)}` : ''}">${body}</code></pre></div>`;
};
md.renderer.rules.code_block = (tokens, idx) =>
  `<div class="code-card"><div class="code-head"><span class="code-lang"></span><button class="code-copy" type="button" title="Copy code"></button></div><pre><code class="hljs">${escapeHtml(tokens[idx].content)}</code></pre></div>`;

// Tables: wrap for horizontal scrolling & rounded border
md.renderer.rules.table_open = () => '<div class="table-wrap"><table>';
md.renderer.rules.table_close = () => '</table></div>';

export function renderMarkdown(body) {
  const html = md.render(body);
  return DOMPurify.sanitize(html, {
    ADD_TAGS: ['semantics', 'annotation', 'mrow', 'mi', 'mo', 'mn', 'msup', 'msub', 'mfrac', 'math', 'mspace', 'mtext', 'msqrt', 'mroot', 'mover', 'munder', 'mtable', 'mtr', 'mtd', 'mstyle', 'mpadded', 'menclose', 'mphantom'],
    ADD_ATTR: ['target', 'data-src', 'encoding', 'aria-hidden', 'checked', 'disabled'],
    FORBID_TAGS: ['style', 'script', 'iframe', 'object', 'embed', 'form'],
    ALLOW_UNKNOWN_PROTOCOLS: false,
  });
}

export function getTokens(body) { return md.parse(body, {}); }

// ---------- content the visual editor can't represent ----------
export function detectUnsupported(body) {
  const noCode = body.replace(/(^|\n)(```|~~~)[\s\S]*?\n\2/g, '\n').replace(/`[^`\n]*`/g, '');
  const reasons = [];
  if (/<\/?(div|details|summary|span|table|tr|td|th|p|br|img|a|kbd|sup|sub|center|font|video|iframe|u|mark|small|figure|picture|section|aside)\b[^>]*>/i.test(noCode)) reasons.push('HTML');
  return reasons;
}

export function outlineFromBody(body) {
  const tokens = md.parse(body, {});
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === 'heading_open') {
      const level = Number(t.tag.slice(1));
      const inline = tokens[i + 1];
      const text = (inline?.children || []).filter((c) => c.type === 'text' || c.type === 'code_inline').map((c) => c.content).join('');
      out.push({ level, text });
    }
  }
  return out;
}
