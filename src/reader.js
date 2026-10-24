import { renderMarkdown, splitFrontMatter, parseFrontMatterPairs } from './markdown.js';
import { $, $$, icon, escapeHtml, resolveFrom, localUrl, isAbsolute } from './util.js';

let mermaidMod = null;
let mermaidSeq = 0;

async function renderMermaid(root, theme) {
  const blocks = $$('.mermaid-block', root);
  if (!blocks.length) return;
  try {
    if (!mermaidMod) mermaidMod = (await import('mermaid')).default;
    mermaidMod.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: theme === 'dark' ? 'dark' : 'neutral',
      fontFamily: 'Inter Variable, Segoe UI, sans-serif',
    });
    for (const b of blocks) {
      const src = decodeURIComponent(b.dataset.src || '');
      try {
        const { svg } = await mermaidMod.render(`mmd-${++mermaidSeq}`, src);
        b.innerHTML = svg;
        b.classList.add('rendered');
      } catch {
        b.classList.add('error');
      }
    }
  } catch (e) { console.warn('mermaid unavailable', e); }
}

/**
 * Render markdown into the reader element.
 * opts: { filePath, theme, onOpenLink(href), onToggleTask(index, checked) }
 */
export function renderReader(el, text, opts) {
  const { frontMatter, body } = splitFrontMatter(text);
  let html = '';
  if (frontMatter) {
    const pairs = parseFrontMatterPairs(frontMatter);
    if (pairs.length) {
      html += `<div class="props">${pairs.map((p) => `<div class="prop"><span class="prop-k">${escapeHtml(p.key)}</span><span class="prop-v">${escapeHtml(p.value)}</span></div>`).join('')}</div>`;
    }
  }
  html += renderMarkdown(body);
  el.innerHTML = html || '';
  if (!body.trim()) {
    el.innerHTML += `<div class="empty-doc">This page is empty. Switch to <b>Edit</b> to start writing.</div>`;
  }

  // copy buttons
  $$('.code-copy', el).forEach((btn) => {
    btn.innerHTML = `${icon('Copy', 14)}<span>Copy</span>`;
    btn.addEventListener('click', async () => {
      const code = btn.closest('.code-card').querySelector('code').innerText;
      await navigator.clipboard.writeText(code);
      btn.innerHTML = `${icon('Check', 14)}<span>Copied</span>`;
      btn.classList.add('done');
      setTimeout(() => { btn.innerHTML = `${icon('Copy', 14)}<span>Copy</span>`; btn.classList.remove('done'); }, 1600);
    });
  });

  // images: resolve relative paths against the file
  $$('img', el).forEach((img) => {
    const src = img.getAttribute('src') || '';
    if (opts.filePath && src && !/^(https?:|data:|blob:|folio:)/i.test(src)) {
      let p = decodeURI(src.split('#')[0].split('?')[0]);
      if (p.startsWith('file:///')) p = p.slice(8);
      img.dataset.orig = src; // keep the original (relative) src for HTML export
      img.src = localUrl(isAbsolute(p) ? p : resolveFrom(opts.filePath, p));
    }
    img.loading = 'lazy';
    img.addEventListener('error', () => img.classList.add('broken'), { once: true });
    img.addEventListener('click', () => openLightbox(img));
  });

  // links
  $$('a[href]', el).forEach((a) => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      const href = a.getAttribute('href');
      opts.onOpenLink?.(href);
    });
    const href = a.getAttribute('href') || '';
    if (/^https?:/i.test(href)) a.title = href;
  });

  // task list checkboxes
  $$('input.task-list-item-checkbox', el).forEach((cb, i) => {
    cb.removeAttribute('disabled');
    cb.addEventListener('change', () => opts.onToggleTask?.(i, cb.checked));
    // only the box itself toggles — clicking the text just selects it
    cb.closest('label')?.addEventListener('click', (e) => { if (e.target !== cb) e.preventDefault(); });
  });

  return renderMermaid(el, opts.theme);
}

function openLightbox(img) {
  const lb = document.createElement('div');
  lb.className = 'lightbox';
  const big = document.createElement('img'); // built with DOM APIs: never parse a URL as HTML
  big.src = img.src;
  big.alt = '';
  lb.appendChild(big);
  lb.addEventListener('click', () => lb.remove());
  document.addEventListener('keydown', function esc(e) { if (e.key === 'Escape') { lb.remove(); document.removeEventListener('keydown', esc); } });
  document.body.appendChild(lb);
}

/** Toggle the nth task checkbox in the source text. */
export function toggleTaskInSource(text, index, checked) {
  const lines = text.split(/(\r?\n)/);
  let inFence = false;
  let fence = '';
  let n = -1;
  for (let i = 0; i < lines.length; i += 2) {
    const line = lines[i];
    const f = line.match(/^\s*(```|~~~)/);
    if (f) {
      if (!inFence) { inFence = true; fence = f[1]; } else if (line.trim().startsWith(fence)) inFence = false;
      continue;
    }
    if (inFence) continue;
    const m = line.match(/^(\s*(?:>\s*)*(?:[-*+]|\d+[.)])\s+)\[( |x|X)\](\s|$)/);
    if (m) {
      n++;
      if (n === index) {
        lines[i] = m[1] + (checked ? '[x]' : '[ ]') + line.slice(m[1].length + 3);
        return lines.join('');
      }
    }
  }
  return text;
}

/** Build outline nav from rendered headings. Returns the heading elements. */
export function buildOutline(nav, scrollEl, sourceRoot) {
  const heads = $$('h1, h2, h3, h4', sourceRoot).filter((hd) => hd.textContent.trim());
  if (heads.length < 2) { nav.innerHTML = ''; nav.classList.add('empty'); return []; }
  nav.classList.remove('empty');
  const minLevel = Math.min(...heads.map((hd) => Number(hd.tagName[1])));
  nav.innerHTML = `<div class="outline-title">On this page</div>` + heads.map((hd, i) =>
    `<a class="ol-item lvl-${Number(hd.tagName[1]) - minLevel}" data-i="${i}" title="${escapeHtml(hd.textContent)}">${escapeHtml(hd.textContent)}</a>`).join('');
  $$('.ol-item', nav).forEach((a) => a.addEventListener('click', () => {
    const target = heads[Number(a.dataset.i)];
    const top = target.getBoundingClientRect().top - scrollEl.getBoundingClientRect().top + scrollEl.scrollTop - 16;
    scrollEl.scrollTo({ top, behavior: 'smooth' });
  }));
  return heads;
}

export function updateOutlineActive(nav, scrollEl, heads) {
  if (!heads.length) return;
  const topEdge = scrollEl.getBoundingClientRect().top + 80;
  let active = 0;
  heads.forEach((hd, i) => { if (hd.getBoundingClientRect().top <= topEdge) active = i; });
  $$('.ol-item', nav).forEach((a) => a.classList.toggle('active', Number(a.dataset.i) === active));
}
