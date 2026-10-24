import { createElement, icons } from 'lucide';

// ---------- icons ----------
const iconCache = new Map();
export function icon(name, size = 16, stroke = 1.75) {
  const key = `${name}:${size}:${stroke}`;
  if (iconCache.has(key)) return iconCache.get(key);
  const def = icons[name];
  if (!def) return '';
  const svg = createElement(def, { width: size, height: size, 'stroke-width': stroke, 'aria-hidden': 'true', class: 'ic' });
  const html = svg.outerHTML;
  iconCache.set(key, html);
  return html;
}

// ---------- DOM ----------
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export function h(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}
export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
export function debounce(fn, ms) {
  let t;
  const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  d.cancel = () => clearTimeout(t);
  d.flush = (...a) => { clearTimeout(t); return fn(...a); };
  return d;
}

// ---------- platform ----------
// true in the phone build (vite.mobile.config.js defines __FOLIO_MOBILE__), false on desktop
// eslint-disable-next-line no-undef
export const IS_MOBILE = typeof __FOLIO_MOBILE__ !== 'undefined' && __FOLIO_MOBILE__ === true;

// ---------- paths (works with \ and /) ----------
export const isWin = navigator.userAgent.includes('Windows');
export const SEP = isWin ? '\\' : '/';
export function dirname(p) {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i <= 0 ? p : p.slice(0, i);
}
export function basename(p) {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return p.slice(i + 1);
}
export function stripExt(name) {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(0, i) : name;
}
export function extname(name) {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i) : '';
}
export function joinPath(...parts) {
  return parts.filter(Boolean).join(SEP).replace(/[\\/]+/g, SEP);
}
export function isAbsolute(p) {
  return /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('/') || p.startsWith('\\\\');
}
export function normalize(p) {
  const lead = p.startsWith('\\\\') ? '\\\\' : (p.startsWith('/') ? '/' : '');
  const parts = p.split(/[\\/]+/).filter(Boolean);
  const out = [];
  for (const part of parts) {
    if (part === '.') continue;
    if (part === '..') { if (out.length && out[out.length - 1] !== '..') out.pop(); continue; }
    out.push(part);
  }
  return lead + out.join(SEP);
}
export function resolveFrom(filePath, rel) {
  if (isAbsolute(rel)) return normalize(rel);
  return normalize(dirname(filePath) + SEP + rel);
}
export function samePath(a, b) {
  if (!a || !b) return false;
  const na = normalize(a); const nb = normalize(b);
  return isWin ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}
export function isInside(child, parent) {
  const c = normalize(child) + SEP; const p = normalize(parent) + SEP;
  return isWin ? c.toLowerCase().startsWith(p.toLowerCase()) : c.startsWith(p);
}
export function localUrl(absPath) {
  // the phone app serves local images through its own bridge (see mobile/bridge.js)
  if (window.folio?.localUrl) return window.folio.localUrl(absPath);
  return 'folio://local/' + encodeURIComponent(absPath);
}

// ---------- toast ----------
let toastTimer;
export function toast(msg, kind = 'info') {
  let t = $('#toast');
  if (!t) { t = h('<div id="toast" class="toast"></div>'); document.body.appendChild(t); }
  t.className = `toast show ${kind}`;
  t.innerHTML = `${icon(kind === 'error' ? 'CircleAlert' : 'Check', 15)}<span>${escapeHtml(msg)}</span>`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), kind === 'error' ? 4500 : 2200);
}

// ---------- modal dialogs (Electron has no prompt()) ----------
export function promptDialog({ title, label = '', value = '', placeholder = '', okLabel = 'OK', selectBaseName = false, extra = '' }) {
  return new Promise((resolve) => {
    const m = h(`
      <div class="modal-backdrop">
        <div class="modal" role="dialog" aria-modal="true">
          <div class="modal-title">${escapeHtml(title)}</div>
          ${label ? `<label class="modal-label">${escapeHtml(label)}</label>` : ''}
          <input class="modal-input" type="text" spellcheck="false" placeholder="${escapeHtml(placeholder)}" />
          ${extra}
          <div class="modal-actions">
            <button class="btn" data-act="cancel">Cancel</button>
            <button class="btn primary" data-act="ok">${escapeHtml(okLabel)}</button>
          </div>
        </div>
      </div>`);
    document.body.appendChild(m);
    const input = $('.modal-input', m);
    input.value = value;
    requestAnimationFrame(() => {
      input.focus();
      if (selectBaseName && value.lastIndexOf('.') > 0) input.setSelectionRange(0, value.lastIndexOf('.'));
      else input.select();
    });
    const done = (v) => { m.remove(); resolve(v); };
    m.addEventListener('mousedown', (e) => { if (e.target === m) done(null); });
    $('[data-act=cancel]', m).onclick = () => done(null);
    $('[data-act=ok]', m).onclick = () => done(input.value.trim());
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); done(input.value.trim()); }
      if (e.key === 'Escape') { e.preventDefault(); done(null); }
    });
    m._root = m;
  });
}

export function confirmDialog({ title, message, okLabel = 'OK', danger = false, cancelLabel = 'Cancel', thirdLabel = null }) {
  return new Promise((resolve) => {
    const m = h(`
      <div class="modal-backdrop">
        <div class="modal" role="alertdialog" aria-modal="true">
          <div class="modal-title">${escapeHtml(title)}</div>
          ${message ? `<div class="modal-message">${escapeHtml(message)}</div>` : ''}
          <div class="modal-actions">
            ${thirdLabel ? `<button class="btn" data-act="third" style="margin-right:auto">${escapeHtml(thirdLabel)}</button>` : ''}
            <button class="btn" data-act="cancel">${escapeHtml(cancelLabel)}</button>
            <button class="btn ${danger ? 'danger' : 'primary'}" data-act="ok">${escapeHtml(okLabel)}</button>
          </div>
        </div>
      </div>`);
    document.body.appendChild(m);
    const ok = $('[data-act=ok]', m);
    requestAnimationFrame(() => ok.focus());
    const done = (v) => { m.remove(); document.removeEventListener('keydown', onKey, true); resolve(v); };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(false); }
    };
    document.addEventListener('keydown', onKey, true);
    m.addEventListener('mousedown', (e) => { if (e.target === m) done(false); });
    $('[data-act=cancel]', m).onclick = () => done(false);
    ok.onclick = () => done(true);
    const third = $('[data-act=third]', m);
    if (third) third.onclick = () => done('third');
  });
}

// ---------- context menu / dropdown ----------
let openMenu = null;
export function closeMenu() {
  if (openMenu) { openMenu.el.remove(); openMenu.cleanup(); openMenu = null; }
}
/**
 * items: [{label, icon, kbd, action, danger, checked, disabled} | 'sep' | {header}]
 */
export function showMenu(items, { x, y, anchor, align = 'left', minWidth = 200, className = '' } = {}) {
  closeMenu();
  const el = h(`<div class="menu ${className}" role="menu" style="min-width:${minWidth}px"></div>`);
  items.forEach((it) => {
    if (it === 'sep') { el.appendChild(h('<div class="menu-sep"></div>')); return; }
    if (it.header) { el.appendChild(h(`<div class="menu-header">${escapeHtml(it.header)}</div>`)); return; }
    const b = h(`<button class="menu-item ${it.danger ? 'danger' : ''} ${it.checked ? 'checked' : ''}" role="menuitem" ${it.disabled ? 'disabled' : ''}>
      <span class="mi-icon">${it.icon ? icon(it.icon, 15) : ''}</span>
      <span class="mi-label">${escapeHtml(it.label)}</span>
      ${it.checked ? `<span class="mi-check">${icon('Check', 14)}</span>` : ''}
      ${it.kbd ? `<span class="mi-kbd">${escapeHtml(it.kbd)}</span>` : ''}
    </button>`);
    b.addEventListener('click', (e) => { e.stopPropagation(); closeMenu(); it.action && it.action(); });
    el.appendChild(b);
  });
  // phones: tapping a menu item must not steal focus from the editor (that would close the keyboard)
  if (IS_MOBILE) el.addEventListener('mousedown', (e) => e.preventDefault());
  document.body.appendChild(el);
  const r = el.getBoundingClientRect();
  let left = x; let top = y;
  if (anchor) {
    const a = anchor.getBoundingClientRect();
    left = align === 'right' ? a.right - r.width : (align === 'center' ? a.left + a.width / 2 - r.width / 2 : a.left);
    top = a.bottom + 6;
  }
  left = Math.max(8, Math.min(left, window.innerWidth - r.width - 8));
  if (top + r.height > window.innerHeight - 8) top = Math.max(8, (anchor ? anchor.getBoundingClientRect().top - r.height - 6 : y - r.height));
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
  const items$ = $$('.menu-item:not([disabled])', el);
  let idx = -1;
  const onDown = (e) => { if (!el.contains(e.target)) closeMenu(); };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); closeMenu(); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      idx = (idx + (e.key === 'ArrowDown' ? 1 : -1) + items$.length) % items$.length;
      items$[idx].focus();
    }
  };
  setTimeout(() => {
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', closeMenu);
  });
  openMenu = {
    el,
    cleanup: () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', closeMenu);
    },
  };
  return el;
}

export function formatNumber(n) { return new Intl.NumberFormat().format(n); }

export function countWords(text) {
  const t = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#>*_`~|\-]+/g, ' ');
  const m = t.match(/[\p{L}\p{N}][\p{L}\p{N}'’]*/gu);
  return m ? m.length : 0;
}
