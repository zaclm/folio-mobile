import { $, $$, h, icon, escapeHtml, stripExt, basename, samePath, showMenu, isInside, dirname } from './util.js';

export function createSidebar(el, cb) {
  let tree = null;
  let active = null;
  let filter = '';
  let expanded = new Set(cb.getExpanded() || []);
  let recents = [];
  let recentFolders = [];
  let selectedDir = null;

  el.innerHTML = `
    <div class="sb-head">
      <button class="sb-workspace" data-tip="Switch folder">
        <span class="sb-ws-icon">${icon('Folder', 15)}</span>
        <span class="sb-ws-name">No folder open</span>
        ${icon('ChevronDown', 14)}
      </button>
    </div>
    <div class="sb-tools">
      <div class="sb-search" data-tip-off="Open a folder to filter its files">
        ${icon('Search', 14)}
        <input type="text" placeholder="Filter files" spellcheck="false" />
      </div>
      <button class="icon-btn" data-act="newfile" data-tip="New page (Ctrl+N)">${icon('FilePlus', 16)}</button>
      <button class="icon-btn" data-act="newfolder" data-tip="New folder">${icon('FolderPlus', 16)}</button>
    </div>
    <div class="sb-scroll">
      <div class="sb-tree" role="tree"></div>
      <div class="sb-empty"></div>
      <div class="sb-section sb-recents"></div>
    </div>
    <div class="sb-foot">
      <button class="sb-foot-btn" data-act="quick">${icon('Search', 15)}<span>Quick open</span><kbd>Ctrl P</kbd></button>
      <button class="sb-foot-btn" data-act="settings">${icon('Settings', 15)}<span>Settings</span></button>
    </div>
  `;
  const treeEl = $('.sb-tree', el);
  const emptyEl = $('.sb-empty', el);
  const recentsEl = $('.sb-recents', el);
  const input = $('.sb-search input', el);

  input.addEventListener('input', () => { filter = input.value.trim().toLowerCase(); render(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { input.value = ''; filter = ''; render(); input.blur(); }
    if (e.key === 'Enter') { const first = $('.tr-file', treeEl); if (first) cb.onOpenFile(first.dataset.path); }
  });

  $('.sb-workspace', el).addEventListener('click', (e) => {
    const items = [
      { label: 'Open folder…', icon: 'FolderOpen', kbd: 'Ctrl+Shift+O', action: cb.onOpenFolder },
      { label: 'Open file…', icon: 'FileText', kbd: 'Ctrl+O', action: cb.onOpenFileDialog },
    ];
    const others = recentFolders.filter((f) => !tree || !samePath(f, tree.path)).slice(0, 6);
    if (others.length) {
      items.push('sep', { header: 'Recent folders' });
      others.forEach((f) => items.push({ label: basename(f) || f, icon: 'Folder', action: () => cb.onOpenFolderPath(f) }));
    }
    if (tree) {
      items.push('sep',
        { label: 'Show in File Explorer', icon: 'ExternalLink', action: () => cb.onReveal(tree.path) },
        { label: 'Close folder', icon: 'X', action: cb.onCloseFolder });
    }
    showMenu(items, { anchor: e.currentTarget, minWidth: 240 });
  });

  el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const act = b.dataset.act;
    if ((act === 'newfile' || act === 'newfolder') && !tree) { cb.onNeedFolder(act); return; }
    if (act === 'newfile') cb.onNewFile(targetDir());
    if (act === 'newfolder') cb.onNewFolder(targetDir());
    if (act === 'settings') cb.onSettings(b);
    if (act === 'quick') cb.onQuickOpen();
    if (act === 'openfolder') cb.onOpenFolder();
    if (act === 'openfile') cb.onOpenFileDialog();
  });

  function targetDir() {
    if (!tree) return null;
    if (selectedDir && isInside(selectedDir + '/x', tree.path)) return selectedDir;
    if (active && isInside(active, tree.path)) return dirname(active);
    return tree.path;
  }

  function matches(node) {
    if (!filter) return true;
    if (node.type === 'file') return stripExt(node.name).toLowerCase().includes(filter);
    return node.children.some(matches);
  }

  function renderNode(node, depth) {
    if (!matches(node)) return '';
    const pad = 10 + depth * 14;
    if (node.type === 'dir') {
      const open = filter ? true : expanded.has(node.path);
      return `<div class="tr-dir ${open ? 'open' : ''}" data-path="${escapeHtml(node.path)}">
        <div class="tr-row tr-dir-row" style="padding-left:${pad}px" data-path="${escapeHtml(node.path)}" data-type="dir" role="treeitem" aria-expanded="${open}">
          <span class="tr-caret">${icon('ChevronRight', 14)}</span>
          <span class="tr-ic">${icon(open ? 'FolderOpen' : 'Folder', 15)}</span>
          <span class="tr-name">${escapeHtml(node.name)}</span>
          <button class="tr-more" data-more="1" tabindex="-1">${icon('Ellipsis', 15)}</button>
        </div>
        <div class="tr-children">${open ? node.children.map((c) => renderNode(c, depth + 1)).join('') : ''}</div>
      </div>`;
    }
    const isActive = samePath(node.path, active);
    return `<div class="tr-row tr-file ${isActive ? 'active' : ''}" style="padding-left:${pad + 18}px" data-path="${escapeHtml(node.path)}" data-type="file" role="treeitem" title="${escapeHtml(node.name)}">
      <span class="tr-ic">${icon('FileText', 15)}</span>
      <span class="tr-name">${escapeHtml(stripExt(node.name))}</span>
      <button class="tr-more" data-more="1" tabindex="-1">${icon('Ellipsis', 15)}</button>
    </div>`;
  }

  function render() {
    $('.sb-ws-name', el).textContent = tree ? tree.name : 'No folder open';
    $('.sb-tools', el).classList.toggle('disabled', !tree);
    // with no folder open the buttons stay hoverable and explain what to do first
    const tips = tree
      ? { newfile: 'New page (Ctrl+N)', newfolder: 'New folder' }
      : { newfile: 'Choose a folder first: new pages are saved inside it. Click to pick one.', newfolder: 'Choose a folder first. Click to pick one.' };
    $('[data-act=newfile]', el).dataset.tip = tips.newfile;
    $('[data-act=newfolder]', el).dataset.tip = tips.newfolder;
    const search = $('.sb-search', el);
    if (tree) delete search.dataset.tip; else search.dataset.tip = search.dataset.tipOff;
    $('input', search).disabled = !tree;
    if (!tree) {
      treeEl.innerHTML = '';
      emptyEl.innerHTML = `
        <div class="sb-empty-box">
          <div class="sb-empty-title">Open a folder to see your notes</div>
          <button class="btn primary sm" data-act="openfolder">${icon('FolderOpen', 15)} Open folder</button>
          <button class="btn sm" data-act="openfile">${icon('FileText', 15)} Open file</button>
        </div>`;
      emptyEl.style.display = '';
    } else {
      emptyEl.style.display = 'none';
      const html = tree.children.map((c) => renderNode(c, 0)).join('');
      treeEl.innerHTML = html || `<div class="sb-none">${filter ? 'No matching files' : 'No markdown files yet. Create one with +'}</div>`;
    }
    renderRecents();
  }

  function renderRecents() {
    const list = recents.filter((p) => !tree || !isInside(p, tree.path)).slice(0, 8);
    if (!list.length || filter) { recentsEl.innerHTML = ''; return; }
    recentsEl.innerHTML = `<div class="sb-section-title">${tree ? 'Other recent files' : 'Recent files'}</div>` +
      list.map((p) => `<div class="tr-row tr-file tr-recent ${samePath(p, active) ? 'active' : ''}" style="padding-left:10px" data-path="${escapeHtml(p)}" data-type="file" data-recent="1" title="${escapeHtml(p)}">
        <span class="tr-ic">${icon('Clock', 15)}</span><span class="tr-name">${escapeHtml(stripExt(basename(p)))}</span>
      </div>`).join('');
  }

  function rowFromEvent(e) { return e.target.closest('.tr-row'); }

  el.addEventListener('click', (e) => {
    const row = rowFromEvent(e);
    if (!row) return;
    const p = row.dataset.path;
    if (e.target.closest('[data-more]')) { openCtx(row, e.target.closest('[data-more]')); return; }
    if (row.dataset.type === 'dir') {
      selectedDir = p;
      if (expanded.has(p)) expanded.delete(p); else expanded.add(p);
      cb.setExpanded([...expanded]);
      render();
    } else {
      selectedDir = null;
      cb.onOpenFile(p);
    }
  });
  el.addEventListener('contextmenu', (e) => {
    const row = rowFromEvent(e);
    if (!row) {
      if (tree && e.target.closest('.sb-scroll')) {
        e.preventDefault();
        showMenu([
          { label: 'New page', icon: 'FilePlus', action: () => cb.onNewFile(tree.path) },
          { label: 'New folder', icon: 'FolderPlus', action: () => cb.onNewFolder(tree.path) },
        ], { x: e.clientX, y: e.clientY });
      }
      return;
    }
    e.preventDefault();
    openCtx(row, null, e);
  });

  function openCtx(row, anchor, ev) {
    const p = row.dataset.path;
    const isDir = row.dataset.type === 'dir';
    const items = isDir ? [
      { label: 'New page here', icon: 'FilePlus', action: () => cb.onNewFile(p) },
      { label: 'New folder here', icon: 'FolderPlus', action: () => cb.onNewFolder(p) },
      'sep',
      { label: 'Rename', icon: 'Pencil', action: () => cb.onRename(p, true) },
      { label: 'Show in File Explorer', icon: 'ExternalLink', action: () => cb.onReveal(p) },
      'sep',
      { label: 'Delete folder', icon: 'Trash2', danger: true, action: () => cb.onDelete(p, true) },
    ] : [
      { label: 'Open', icon: 'FileText', action: () => cb.onOpenFile(p) },
      ...(row.dataset.recent ? [{ label: 'Remove from recent', icon: 'X', action: () => cb.onForgetRecent(p) }] : [
        { label: 'Rename', icon: 'Pencil', action: () => cb.onRename(p, false) },
        { label: 'Duplicate', icon: 'Copy', action: () => cb.onDuplicate(p) },
      ]),
      { label: 'Copy path', icon: 'Copy', action: () => navigator.clipboard.writeText(p) },
      { label: 'Show in File Explorer', icon: 'ExternalLink', action: () => cb.onReveal(p) },
      ...(row.dataset.recent ? [] : ['sep', { label: 'Delete', icon: 'Trash2', danger: true, action: () => cb.onDelete(p, false) }]),
    ];
    if (anchor) showMenu(items, { anchor, align: 'left', minWidth: 210 });
    else showMenu(items, { x: ev.clientX, y: ev.clientY, minWidth: 210 });
  }

  render(); // apply the "no folder open" state right away

  return {
    setTree(t) { tree = t; render(); },
    getTree() { return tree; },
    setActive(p) {
      active = p;
      // make sure the active file's folders are expanded
      if (tree && p && isInside(p, tree.path)) {
        let d = dirname(p);
        let changed = false;
        while (d && isInside(d + '/x', tree.path) && !samePath(d, tree.path)) {
          if (!expanded.has(d)) { expanded.add(d); changed = true; }
          const nd = dirname(d);
          if (nd === d) break;
          d = nd;
        }
        if (changed) cb.setExpanded([...expanded]);
      }
      render();
      const a = $('.tr-file.active', treeEl);
      if (a) a.scrollIntoView({ block: 'nearest' });
    },
    setRecents(list, folders) { recents = list || []; recentFolders = folders || []; renderRecents(); },
    focusFilter() { input.focus(); input.select(); },
    allFiles() {
      const out = [];
      const walk = (n) => n.children.forEach((c) => (c.type === 'file' ? out.push(c.path) : walk(c)));
      if (tree) walk(tree);
      return out;
    },
  };
}
