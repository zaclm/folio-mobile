import { $, icon } from './util.js';

const HL_ALL = 'folio-find';
const HL_CUR = 'folio-find-current';

export function createFind(bar, ctx) {
  // ctx: { getMode(): 'read'|'visual'|'source', getRoot(), getEditor(), getTextarea(), scrollEl }
  bar.innerHTML = `
    <div class="find-row">
      <div class="find-input">${icon('Search', 14)}<input class="find-q" type="text" placeholder="Find" spellcheck="false" /></div>
      <span class="find-count">0/0</span>
      <button class="icon-btn sm" data-act="case" data-tip="Match case">${icon('CaseSensitive', 16)}</button>
      <button class="icon-btn sm" data-act="prev" data-tip="Previous (Shift+Enter)">${icon('ArrowUp', 15)}</button>
      <button class="icon-btn sm" data-act="next" data-tip="Next (Enter)">${icon('ArrowDown', 15)}</button>
      <button class="icon-btn sm" data-act="close" data-tip="Close (Esc)">${icon('X', 15)}</button>
    </div>
    <div class="find-row replace-row">
      <div class="find-input">${icon('Replace', 14)}<input class="find-r" type="text" placeholder="Replace with" spellcheck="false" /></div>
      <button class="btn xs" data-act="replace">Replace</button>
      <button class="btn xs" data-act="replaceAll">Replace all</button>
    </div>`;
  const q = $('.find-q', bar);
  const r = $('.find-r', bar);
  const countEl = $('.find-count', bar);
  let ranges = [];
  let cur = -1;
  let matchCase = false;
  let srcMatches = [];

  function clearHighlights() {
    if (CSS.highlights) { CSS.highlights.delete(HL_ALL); CSS.highlights.delete(HL_CUR); }
  }

  function textNodes(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.parentElement && !n.parentElement.closest('.code-head, .mermaid-block svg, .katex-mathml') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
    });
    const out = [];
    let n;
    while ((n = walker.nextNode())) out.push(n);
    return out;
  }

  function search(keepIndex = false) {
    const term = q.value;
    ranges = [];
    srcMatches = [];
    clearHighlights();
    const mode = ctx.getMode();
    if (!term) { cur = -1; updateCount(); return; }
    const needle = matchCase ? term : term.toLowerCase();
    if (mode === 'source') {
      const ta = ctx.getTextarea();
      const hay = matchCase ? ta.value : ta.value.toLowerCase();
      let i = hay.indexOf(needle);
      while (i !== -1 && srcMatches.length < 5000) { srcMatches.push(i); i = hay.indexOf(needle, i + needle.length); }
    } else {
      const root = ctx.getRoot();
      if (!root) return;
      for (const node of textNodes(root)) {
        const hay = matchCase ? node.data : node.data.toLowerCase();
        let i = hay.indexOf(needle);
        while (i !== -1 && ranges.length < 5000) {
          const rg = new Range();
          rg.setStart(node, i);
          rg.setEnd(node, i + needle.length);
          ranges.push(rg);
          i = hay.indexOf(needle, i + needle.length);
        }
      }
      if (CSS.highlights && ranges.length) CSS.highlights.set(HL_ALL, new Highlight(...ranges));
    }
    const total = mode === 'source' ? srcMatches.length : ranges.length;
    if (!keepIndex || cur >= total) cur = total ? 0 : -1;
    if (total && cur < 0) cur = 0;
    show(false);
  }

  function updateCount() {
    const total = ctx.getMode() === 'source' ? srcMatches.length : ranges.length;
    countEl.textContent = total ? `${cur + 1}/${total}` : (q.value ? 'No results' : '0/0');
    countEl.classList.toggle('none', !!q.value && !total);
  }

  function show(scroll = true) {
    updateCount();
    if (cur < 0) return;
    if (ctx.getMode() === 'source') {
      const ta = ctx.getTextarea();
      const start = srcMatches[cur];
      if (scroll) {
        ta.focus();
        ta.setSelectionRange(start, start + q.value.length);
        q.focus();
      }
      return;
    }
    const rg = ranges[cur];
    if (!rg) return;
    if (CSS.highlights) CSS.highlights.set(HL_CUR, new Highlight(rg));
    const rect = rg.getBoundingClientRect();
    const sc = ctx.scrollEl.getBoundingClientRect();
    if (rect.top < sc.top + 60 || rect.bottom > sc.bottom - 40) {
      ctx.scrollEl.scrollTo({ top: ctx.scrollEl.scrollTop + rect.top - sc.top - sc.height / 3, behavior: scroll ? 'smooth' : 'auto' });
    }
  }

  function step(d) {
    const total = ctx.getMode() === 'source' ? srcMatches.length : ranges.length;
    if (!total) return;
    cur = (cur + d + total) % total;
    show();
  }

  function pmRange(rg) {
    const ed = ctx.getEditor();
    const from = ed.view.posAtDOM(rg.startContainer, rg.startOffset);
    const to = ed.view.posAtDOM(rg.endContainer, rg.endOffset);
    return { from, to };
  }

  function replaceOne() {
    const mode = ctx.getMode();
    if (cur < 0) return;
    if (mode === 'visual') {
      const ed = ctx.getEditor();
      const { from, to } = pmRange(ranges[cur]);
      ed.view.dispatch(ed.state.tr.insertText(r.value, from, to));
      search(true);
    } else if (mode === 'source') {
      ctx.replaceInSource(srcMatches[cur], q.value.length, r.value);
      search(true);
    }
  }
  function replaceAll() {
    const mode = ctx.getMode();
    if (mode === 'visual') {
      const ed = ctx.getEditor();
      const pos = ranges.map(pmRange);
      let tr = ed.state.tr;
      for (let i = pos.length - 1; i >= 0; i--) tr = tr.insertText(r.value, pos[i].from, pos[i].to);
      ed.view.dispatch(tr);
    } else if (mode === 'source') {
      for (let i = srcMatches.length - 1; i >= 0; i--) ctx.replaceInSource(srcMatches[i], q.value.length, r.value, i !== 0);
    }
    search();
  }

  q.addEventListener('input', () => search());
  q.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); step(e.shiftKey ? -1 : 1); }
    if (e.key === 'Escape') { e.preventDefault(); api.close(); }
  });
  r.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); replaceOne(); }
    if (e.key === 'Escape') { e.preventDefault(); api.close(); }
  });
  bar.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const a = b.dataset.act;
    if (a === 'next') step(1);
    if (a === 'prev') step(-1);
    if (a === 'close') api.close();
    if (a === 'case') { matchCase = !matchCase; b.classList.toggle('active', matchCase); search(); }
    if (a === 'replace') replaceOne();
    if (a === 'replaceAll') replaceAll();
  });

  const api = {
    isOpen: () => bar.classList.contains('show'),
    open(withReplace = false) {
      const mode = ctx.getMode();
      const canReplace = mode !== 'read';
      bar.classList.add('show');
      bar.classList.toggle('with-replace', canReplace && withReplace);
      const sel = window.getSelection()?.toString();
      if (sel && sel.length < 80 && !sel.includes('\n')) q.value = sel;
      q.focus();
      q.select();
      search();
    },
    close() {
      bar.classList.remove('show');
      clearHighlights();
      ranges = [];
      ctx.onClose?.();
    },
    refresh() { if (api.isOpen()) search(true); },
  };
  return api;
}
