import '@fontsource-variable/inter';
import '@fontsource-variable/source-serif-4';
import '@fontsource-variable/jetbrains-mono';
import 'katex/dist/katex.min.css';
import './styles/app.css';
import './styles/prose.css';
import './styles/code.css';

import { EditorState } from '@tiptap/pm/state';
import {
  $, $$, h, icon, escapeHtml, debounce, toast, promptDialog, confirmDialog, showMenu, closeMenu,
  basename, dirname, stripExt, extname, joinPath, samePath, isInside, resolveFrom, isAbsolute, countWords, formatNumber, SEP,
} from './util.js';
import { splitFrontMatter, detectUnsupported, outlineFromBody } from './markdown.js';
import { renderReader, toggleTaskInSource, buildOutline, updateOutlineActive } from './reader.js';
import {
  createEditor, getMarkdown, buildEditToolbar, updateEditToolbar, buildBubble, updateBubble, editLinkFlow, createContextBar,
} from './editor.js';
import { createSidebar } from './sidebar.js';
import { loadMarkdown, serializeSmart } from './mdsync.js';
import { createFind } from './find.js';

const api = window.folio;

// ---------------------------------------------------------------- state
const S = {
  settings: {},
  theme: 'light',
  folder: null,
  file: null,
  text: '',          // full current markdown (incl. front matter)
  savedText: '',     // what is on disk
  eol: '\n',
  mtime: 0,
  mode: 'read',
  editView: 'visual',
  editorDirty: false,  // editor changed since last serialization
  editorStale: true,   // editor content doesn't reflect S.text
  frontMatter: '',
  saveState: 'saved',
  unsupported: [],
  bannerDismissed: new Set(),
  outlineHeads: [],
  loadToken: 0,
};

// ---------------------------------------------------------------- DOM refs
const el = {
  app: $('#app'),
  sidebar: $('#sidebar'),
  crumb: $('#crumb'),
  modeSwitch: $('#mode-switch'),
  tbRead: $('#toolbar-read'),
  tbEdit: $('#toolbar-edit'),
  scroll: $('#scroll'),
  welcome: $('#welcome'),
  reader: $('#reader'),
  editorWrap: $('#editor-wrap'),
  editor: $('#editor'),
  source: $('#source'),
  outline: $('#outline'),
  banner: $('#banner'),
  findbar: $('#findbar'),
  bubble: $('#bubble'),
};

// ---------------------------------------------------------------- settings
const DEFAULTS = {
  theme: 'system', readFont: 'sans', fontSize: 16, wide: false, sidebar: true, outline: true,
  autosave: true, openIn: 'read', spellcheck: true, closeButton: true, recents: [], recentFolders: [], expanded: [],
};
function setting(k) { return S.settings[k] ?? DEFAULTS[k]; }
async function saveSetting(patch) {
  Object.assign(S.settings, patch);
  const r = await api.setSettings(patch);
  if ('theme' in patch) applyTheme(r.theme);
}
function applyTheme(t) {
  S.theme = t;
  document.documentElement.dataset.theme = t;
}
function applyLook() {
  const root = document.documentElement;
  root.style.setProperty('--read-size', `${setting('fontSize')}px`);
  root.dataset.font = setting('readFont');
  root.dataset.width = setting('wide') ? 'wide' : 'normal';
  el.app.classList.toggle('sidebar-hidden', !setting('sidebar'));
  el.app.classList.toggle('outline-off', !setting('outline'));
  el.app.classList.toggle('no-close', !setting('closeButton'));
  el.editor.querySelector('.ProseMirror')?.setAttribute('spellcheck', String(setting('spellcheck')));
  el.source.spellcheck = setting('spellcheck');
  renderReadToolbarState();
}

// ---------------------------------------------------------------- editor
let editor = null;
let ctxBar = null;
const editorActions = {
  insertImage: () => insertImageFromDisk(),
  editLink: () => editor && editLinkFlow(editor),
  openLink: (href) => openLink(href),
  saveAndInsertImageFile: async (file) => {
    if (!S.file) { toast('Save the page first to add images', 'error'); return; }
    try {
      const src = api.pathForFile(file);
      const rel = src
        ? await api.saveImage({ mdPath: S.file, sourcePath: src })
        : await api.saveImage({ mdPath: S.file, name: file.name || 'pasted-image.png', data: new Uint8Array(await file.arrayBuffer()) });
      editor.chain().focus().setImage({ src: encodeURI(rel), alt: stripExt(basename(rel)) }).run();
    } catch (e) { toast(`Couldn't add image: ${e.message}`, 'error'); }
  },
};

function initEditor() {
  buildBubble(el.bubble, () => editor, editorActions);
  const r = createEditor({
    element: el.editor,
    getFilePath: () => S.file,
    actions: editorActions,
    bubbleEl: el.bubble,
    onUpdate: () => {
      S.editorDirty = true;
      markUnsaved();
      scheduleSave();
      updateWordCountSoon();
      if (find.isOpen()) find.refresh();
    },
    onSelection: () => {
      updateEditToolbar(el.tbEdit, editor);
      updateBubble(el.bubble, editor);
      ctxBar?.update();
    },
  });
  editor = r.editor;
  ctxBar = createContextBar(() => editor);
  editor.on('blur', () => setTimeout(() => ctxBar.update(), 120));
  editor.on('focus', () => ctxBar.update());
  buildEditToolbar(el.tbEdit.querySelector('.tb-pill'), () => editor, editorActions);
}

function resetHistory() {
  // fresh state = fresh undo history (so Ctrl+Z can't go back to another file)
  const st = editor.state;
  editor.view.updateState(EditorState.create({ doc: st.doc, plugins: st.plugins, selection: undefined }));
}

function loadIntoEditor() {
  const { frontMatter, body } = splitFrontMatter(S.text);
  S.frontMatter = frontMatter;
  try {
    S.base = loadMarkdown(editor, body);
  } catch (e) {
    console.error('smart load failed, falling back', e);
    S.base = null;
    editor.commands.setContent(body, { emitUpdate: false });
  }
  S.bodyLead = body.match(/^\n*/)[0];
  resetHistory();
  if (S.base) {
    // resetHistory recreated the state; refresh node references
    const live = [];
    editor.state.doc.forEach((n) => live.push(n));
    if (live.length === S.base.nodes.length) S.base.nodes = live;
  }
  S.editorStale = false;
  S.editorDirty = false;
  S.unsupported = detectUnsupported(body);
  updateEditToolbar(el.tbEdit.querySelector('.tb-pill'), editor);
}

function syncFromEditor() {
  if (!S.editorDirty || !editor) return;
  let md;
  try { md = serializeSmart(editor, S.base); } catch (e) {
    console.error('smart save failed, using full serializer', e);
    md = getMarkdown(editor);
  }
  // keep a single trailing newline
  md = md.replace(/\s+$/, '');
  if (md === '#') md = '';
  if (S.frontMatter && md && !md.startsWith('\n')) md = (S.bodyLead || '') + md;
  S.text = S.frontMatter + md + (md ? '\n' : '');
  S.editorDirty = false;
}

// ---------------------------------------------------------------- saving
function markUnsaved() { setSaveState('unsaved'); }
function setSaveState(s) {
  S.saveState = s;
  const st = $('#save-state');
  if (!st) return;
  const map = {
    saved: [icon('Check', 14), 'Saved'],
    saving: [icon('RefreshCw', 13), 'Saving…'],
    unsaved: ['<span class="dot"></span>', setting('autosave') ? 'Editing' : 'Unsaved'],
    error: [icon('CircleAlert', 14), 'Not saved'],
  };
  st.dataset.state = s;
  st.innerHTML = `${map[s][0]}<span>${map[s][1]}</span>`;
  el.crumb.classList.toggle('dirty', s === 'unsaved' || s === 'error');
}

let saving = null;
async function save({ force = false } = {}) {
  if (!S.file) return true;
  syncFromEditor();
  if (S.text === S.savedText && !force) { setSaveState('saved'); return true; }
  if (saving) { await saving; return save({ force }); }
  setSaveState('saving');
  const text = S.text;
  const out = S.eol === '\r\n' ? text.replace(/\r?\n/g, '\r\n') : text;
  saving = (async () => {
    try {
      const r = await api.write(S.file, out);
      S.mtime = r.mtime;
      S.savedText = text;
      setSaveState(S.text === S.savedText && !S.editorDirty ? 'saved' : 'unsaved');
      await maybeAutoRename();
      return true;
    } catch (e) {
      setSaveState('error');
      toast(`Couldn't save: ${e.message}`, 'error');
      return false;
    } finally { saving = null; }
  })();
  return saving;
}
const scheduleSave = debounce(() => { if (setting('autosave')) save(); }, 800);

async function flushSave() {
  scheduleSave.cancel();
  if (S.mode === 'edit' || S.text !== S.savedText || S.editorDirty) await save();
}

// Untitled.md → renamed after its first heading (like Notion)
async function maybeAutoRename() {
  if (!S.file || !/^Untitled( \d+)?\.md$/i.test(basename(S.file))) return;
  const { body } = splitFrontMatter(S.text);
  const m = body.match(/^#\s+(.+?)\s*#*\s*$/m);
  if (!m) return;
  const title = m[1].replace(/[\\/:*?"<>|#]+/g, ' ').replace(/[*_`~[\]]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80);
  if (!title || /^untitled$/i.test(title)) return;
  // only rename once the user has paused typing the title
  if (editor && S.mode === 'edit' && editor.isFocused && editor.state.selection.$from.parent.type.name === 'heading' && editor.state.selection.$from.index(0) === 0) return;
  let target = joinPath(dirname(S.file), `${title}.md`);
  let i = 2;
  while (await api.exists(target)) { target = joinPath(dirname(S.file), `${title} ${i}.md`); i++; }
  try {
    await api.rename(S.file, target);
    replaceRecent(S.file, target);
    S.file = target;
    api.watchFile(target);
    updateCrumb();
    await refreshTree();
    sidebar.setActive(target);
  } catch { /* keep the name */ }
}

// ---------------------------------------------------------------- open / render
async function openFile(p, { mode, keepScroll = false, silent = false } = {}) {
  if (!p) return;
  if (S.file && !samePath(S.file, p)) await flushSave();
  const token = ++S.loadToken;
  let r;
  try { r = await api.read(p); } catch (e) {
    if (!silent) toast(`Couldn't open ${basename(p)}`, 'error');
    forgetRecent(p);
    return;
  }
  if (token !== S.loadToken) return;
  const prevScroll = el.scroll.scrollTop;
  const same = samePath(S.file, p);
  S.file = p;
  S.text = r.content.replace(/\r\n/g, '\n');
  S.savedText = S.text;
  S.eol = r.eol;
  S.mtime = r.mtime;
  S.editorStale = true;
  S.editorDirty = false;
  if (!same) S.bannerDismissed.clear();
  hideBanner();
  if (find.isOpen()) find.close();
  addRecent(p);
  api.watchFile(p);
  sidebar.setActive(p);
  updateCrumb();
  setSaveState('saved');
  el.app.classList.add('has-file');
  const target = mode || (same ? S.mode : (setting('openIn') === 'last' ? S.mode : setting('openIn')));
  await setMode(target, { force: true });
  el.scroll.scrollTop = keepScroll ? prevScroll : 0;
  updateWordCount();
  saveSetting({ lastFile: p });
}

function closeFile() {
  S.file = null;
  S.text = S.savedText = '';
  S.editorStale = true;
  el.app.classList.remove('has-file');
  api.watchFile(null);
  sidebar.setActive(null);
  updateCrumb();
  hideBanner();
  renderWelcome();
  saveSetting({ lastFile: null });
}

// Close the current page (after saving) and go back to the home page.
async function closePage() {
  if (!S.file) return;
  await flushSave();
  if (find.isOpen()) find.close();
  closeMenu();
  ctxBar?.hide();
  editor?.commands.blur();
  closeFile();
  el.scroll.scrollTop = 0;
}

function renderRead(themeOverride) {
  const done = renderReader(el.reader, S.text, {
    filePath: S.file,
    theme: themeOverride || S.theme,
    onOpenLink: openLink,
    onToggleTask: (i, checked) => {
      S.text = toggleTaskInSource(S.text, i, checked);
      S.editorStale = true;
      save();
    },
  });
  S.outlineHeads = buildOutline(el.outline, el.scroll, el.reader);
  updateOutlineActive(el.outline, el.scroll, S.outlineHeads);
  return done;
}

async function setMode(mode, { force = false } = {}) {
  if (!force && mode === S.mode) return;
  const prev = S.mode;
  if (prev === 'edit' && mode === 'read') {
    syncFromEditor();
    scheduleSave.cancel();
    save();
  }
  S.mode = mode;
  el.app.dataset.mode = mode;
  $$('#mode-switch [data-mode]').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  $$('#mode-switch [data-mode]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.mode === mode)));
  if (find.isOpen()) find.close();
  closeMenu();
  ctxBar?.hide();
  if (!S.file) { renderWelcome(); return; }
  // scroll sync: remember relative position
  const ratio = el.scroll.scrollHeight > el.scroll.clientHeight ? el.scroll.scrollTop / (el.scroll.scrollHeight - el.scroll.clientHeight) : 0;
  if (mode === 'read') {
    renderRead();
    hideBanner();
  } else {
    el.outline.classList.toggle('empty', outlineFromBody(splitFrontMatter(S.text).body).filter((x) => x.level <= 4).length < 2);
    if (S.editorStale) loadIntoEditor();
    setEditView(S.editView, { initial: true });
    if (S.unsupported.length && S.editView === 'visual') {
      showBanner('unsupported', 'This page has some HTML that the visual editor shows as plain text. It stays exactly as it is unless you edit those lines — to change the HTML itself, use <b>Markdown</b> view.', [
        { label: 'Markdown view', action: () => setEditView('source') },
        { label: 'Got it', primary: true, action: () => { S.bannerDismissed.add('unsupported'); hideBanner(); } },
      ]);
    } else hideBanner();
  }
  requestAnimationFrame(() => {
    if (!force) el.scroll.scrollTop = ratio * (el.scroll.scrollHeight - el.scroll.clientHeight);
    if (mode === 'edit' && S.editView === 'visual' && !force) editor.commands.focus(null, { scrollIntoView: false });
  });
  updateWordCount();
}

function setEditView(v, { initial = false } = {}) {
  if (!initial && v === S.editView) return;
  if (!initial) {
    if (v === 'source') { syncFromEditor(); }
    else if (S.editorStale || el.source.dataset.changed === '1') { loadIntoEditor(); }
  }
  S.editView = v;
  el.app.dataset.editview = v;
  $$('#view-switch [data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === v));
  if (v === 'source') {
    el.source.value = S.text;
    el.source.dataset.changed = '0';
    autosizeSource();
    if (S.bannerKind === 'unsupported') hideBanner();
    if (!initial) el.source.focus();
  } else if (!initial) {
    editor.commands.focus();
  }
  if (find.isOpen()) find.refresh();
}

function autosizeSource() {
  el.source.style.height = 'auto';
  el.source.style.height = `${el.source.scrollHeight + 4}px`;
}

// ---------------------------------------------------------------- links
async function openLink(href) {
  if (!href) return;
  if (href.startsWith('#')) {
    const id = decodeURIComponent(href.slice(1));
    const root = S.mode === 'read' ? el.reader : el.editor;
    const target = root.querySelector(`[id="${CSS.escape(id)}"]`) || $$('h1,h2,h3,h4,h5,h6', root).find((x) => x.textContent.trim().toLowerCase().replace(/\s+/g, '-') === id.toLowerCase());
    if (target) el.scroll.scrollTo({ top: target.offsetTop - 20, behavior: 'smooth' });
    return;
  }
  if (/^(https?:|mailto:)/i.test(href)) { api.openExternal(href); return; }
  if (!S.file) return;
  const [rawPath, hash] = href.split('#');
  let p = rawPath;
  try { p = decodeURIComponent(rawPath); } catch { /* keep */ }
  if (p.startsWith('file:///')) p = p.slice(8);
  const abs = isAbsolute(p) ? p : resolveFrom(S.file, p);
  if (/\.(md|markdown|mdown|mkd|mdx)$/i.test(abs)) {
    if (await api.exists(abs)) {
      await openFile(abs);
      if (hash) setTimeout(() => openLink(`#${hash}`), 50);
    } else toast(`Couldn't find ${basename(abs)}`, 'error');
  } else if (await api.exists(abs)) {
    api.openPath(abs);
  } else if (/^[\w-]+(\.[\w-]+)+(\/|$)/.test(href)) {
    api.openExternal(`https://${href}`);
  }
}

// ---------------------------------------------------------------- images
async function insertImageFromDisk() {
  if (!S.file) return;
  const choice = await new Promise((resolve) => {
    showMenu([
      { label: 'Upload from computer…', icon: 'Image', action: () => resolve('file') },
      { label: 'From a web link…', icon: 'Link', action: () => resolve('url') },
    ], { anchor: $('[data-id=image]', el.tbEdit) || el.tbEdit, minWidth: 220 });
    setTimeout(() => document.addEventListener('mousedown', () => setTimeout(() => resolve(null), 50), { once: true, capture: true }), 0);
  });
  if (choice === 'file') {
    const p = await api.pickImage();
    if (!p) return;
    try {
      const rel = await api.saveImage({ mdPath: S.file, sourcePath: p });
      editor.chain().focus().setImage({ src: encodeURI(rel), alt: stripExt(basename(p)) }).run();
    } catch (e) { toast(`Couldn't add image: ${e.message}`, 'error'); }
  } else if (choice === 'url') {
    const url = await promptDialog({ title: 'Insert image from link', label: 'Image address', placeholder: 'https://…/picture.png', okLabel: 'Insert' });
    if (url) editor.chain().focus().setImage({ src: url }).run();
  }
}

// ---------------------------------------------------------------- folder / tree
async function openFolder(p, { silent = false } = {}) {
  if (!p) return;
  const t = await api.tree(p);
  if (!t) { if (!silent) toast('That folder no longer exists', 'error'); return; }
  S.folder = p;
  sidebar.setTree(t);
  api.watchFolder(p);
  const rf = [p, ...setting('recentFolders').filter((x) => !samePath(x, p))].slice(0, 10);
  await saveSetting({ lastFolder: p, recentFolders: rf });
  sidebar.setRecents(setting('recents'), rf);
  if (!S.file) renderWelcome();
}
async function refreshTree() {
  if (!S.folder) return;
  const t = await api.tree(S.folder);
  if (!t) { closeFolder(); return; }
  sidebar.setTree(t);
  sidebar.setActive(S.file);
}
function closeFolder() {
  S.folder = null;
  api.watchFolder(null);
  sidebar.setTree(null);
  saveSetting({ lastFolder: null });
  if (!S.file) renderWelcome();
}

async function chooseFolder() {
  const p = await api.openFolderDialog();
  if (p) openFolder(p);
}
async function chooseFile() {
  const p = await api.openFileDialog();
  if (p) openFile(p);
}

async function newFile(dir) {
  await flushSave();
  let p;
  if (dir || S.folder) {
    p = await api.newFile(dir || S.folder, 'Untitled', '');
    await refreshTree();
  } else {
    p = await api.saveAsDialog({ defaultPath: joinPath(setting('lastSaveDir') || '', 'Untitled.md') });
    if (!p) return;
    if (!/\.(md|markdown)$/i.test(p)) p += '.md';
    await api.write(p, '');
    saveSetting({ lastSaveDir: dirname(p) });
  }
  await openFile(p, { mode: 'edit' });
  S.editView = 'visual';
  setEditView('visual', { initial: true });
  requestAnimationFrame(() => editor.commands.focus('start'));
}

async function newFolder(dir) {
  const target = dir || S.folder;
  if (!target) return;
  const name = await promptDialog({ title: 'New folder', label: 'Folder name', value: 'New folder', okLabel: 'Create' });
  if (!name) return;
  try {
    await api.newFolder(target, name.replace(/[\\/:*?"<>|]+/g, '-'));
    await refreshTree();
  } catch (e) { toast(e.message, 'error'); }
}

async function renamePath(p, isDir) {
  const old = basename(p);
  const name = await promptDialog({ title: isDir ? 'Rename folder' : 'Rename page', label: 'Name', value: isDir ? old : old, selectBaseName: !isDir, okLabel: 'Rename' });
  if (!name || name === old) return;
  let nn = name.replace(/[\\/:*?"<>|]+/g, '-');
  if (!isDir && !extname(nn)) nn += extname(old) || '.md';
  const target = joinPath(dirname(p), nn);
  try {
    if (S.file && (samePath(S.file, p) || (isDir && isInside(S.file, p)))) await flushSave();
    await api.rename(p, target);
    if (S.file && samePath(S.file, p)) { replaceRecent(p, target); S.file = target; api.watchFile(target); }
    else if (S.file && isDir && isInside(S.file, p)) {
      const nf = target + S.file.slice(p.length);
      replaceRecent(S.file, nf); S.file = nf; api.watchFile(nf);
    }
    updateCrumb();
    await refreshTree();
  } catch (e) { toast(e.message, 'error'); }
}

async function deletePath(p, isDir) {
  const ok = await confirmDialog({
    title: isDir ? `Delete folder “${basename(p)}”?` : `Delete “${stripExt(basename(p))}”?`,
    message: isDir ? 'The folder and everything inside it will be moved to the Recycle Bin.' : 'The file will be moved to the Recycle Bin. You can restore it from there.',
    okLabel: 'Move to Recycle Bin', danger: true,
  });
  if (!ok) return;
  try {
    const affectsCurrent = S.file && (samePath(S.file, p) || (isDir && isInside(S.file, p)));
    if (affectsCurrent) { scheduleSave.cancel(); S.savedText = S.text; S.editorDirty = false; }
    await api.trash(p);
    forgetRecent(p);
    if (affectsCurrent) closeFile();
    await refreshTree();
    toast('Moved to Recycle Bin');
  } catch (e) { toast(e.message, 'error'); }
}

async function duplicatePath(p) {
  try {
    const r = await api.read(p);
    const np = await api.newFile(dirname(p), `${stripExt(basename(p))} copy`, r.content);
    await refreshTree();
    openFile(np);
  } catch (e) { toast(e.message, 'error'); }
}

// ---------------------------------------------------------------- recents
function addRecent(p) {
  const list = [p, ...setting('recents').filter((x) => !samePath(x, p))].slice(0, 20);
  saveSetting({ recents: list });
  sidebar.setRecents(list, setting('recentFolders'));
}
function forgetRecent(p) {
  const list = setting('recents').filter((x) => !samePath(x, p) && !isInside(x, p));
  saveSetting({ recents: list });
  sidebar.setRecents(list, setting('recentFolders'));
}
function replaceRecent(a, b) {
  const list = setting('recents').map((x) => (samePath(x, a) ? b : x));
  saveSetting({ recents: list });
  sidebar.setRecents(list, setting('recentFolders'));
}

// ---------------------------------------------------------------- titlebar
function updateCrumb() {
  if (!S.file) {
    el.crumb.innerHTML = `<span class="crumb-app">Folio</span>`;
    document.title = 'Folio';
    return;
  }
  const parts = [];
  if (S.folder && isInside(S.file, S.folder)) {
    const rel = S.file.slice(S.folder.length + 1).split(/[\\/]/);
    parts.push(basename(S.folder), ...rel.slice(0, -1));
  } else {
    parts.push(basename(dirname(S.file)));
  }
  const shown = parts.length > 3 ? [parts[0], '…', ...parts.slice(-1)] : parts;
  el.crumb.innerHTML = shown.map((x) => `<span class="crumb-part">${escapeHtml(x)}</span><span class="crumb-sep">/</span>`).join('') +
    `<button class="crumb-file" data-tip="Rename">${escapeHtml(stripExt(basename(S.file)))}</button><span class="crumb-dot"></span>`;
  document.title = `${stripExt(basename(S.file))} — Folio`;
  $('.crumb-file', el.crumb).onclick = () => renamePath(S.file, false);
}

// ---------------------------------------------------------------- word count
function updateWordCount() {
  const wc = $('#word-count');
  const wc2 = $('#word-count-edit');
  if (!S.file) return;
  syncFromEditor();
  const { body } = splitFrontMatter(S.text);
  const n = countWords(body);
  const min = Math.max(1, Math.round(n / 230));
  if (wc) wc.textContent = `${formatNumber(n)} words · ${min} min read`;
  if (wc2) wc2.textContent = `${formatNumber(n)} words`;
}
const updateWordCountSoon = debounce(updateWordCount, 600);

// ---------------------------------------------------------------- banner
function showBanner(kind, html, buttons = []) {
  if (S.bannerDismissed.has(kind)) return;
  S.bannerKind = kind;
  el.banner.innerHTML = `<div class="banner-inner">${icon('CircleAlert', 16)}<div class="banner-text">${html}</div><div class="banner-actions"></div></div>`;
  const acts = $('.banner-actions', el.banner);
  buttons.forEach((b) => {
    const btn = h(`<button class="btn xs ${b.primary ? 'primary' : ''}">${escapeHtml(b.label)}</button>`);
    btn.onclick = b.action;
    acts.appendChild(btn);
  });
  el.banner.classList.add('show');
}
function hideBanner() { S.bannerKind = null; el.banner.classList.remove('show'); }

// ---------------------------------------------------------------- welcome
function renderWelcome() {
  if (S.file) return;
  const recents = setting('recents').slice(0, 6);
  el.welcome.innerHTML = `
    <div class="welcome-inner">
      <div class="welcome-logo">${logoSvg()}</div>
      <h1 class="welcome-title">Folio</h1>
      <p class="welcome-sub">A calm place to read and write markdown.</p>
      <div class="welcome-actions">
        <button class="welcome-card" data-w="folder">${icon('FolderOpen', 20, 1.6)}<span class="wc-t">Open folder</span><span class="wc-d">Browse all notes in a folder</span><kbd>Ctrl Shift O</kbd></button>
        <button class="welcome-card" data-w="file">${icon('FileText', 20, 1.6)}<span class="wc-t">Open file</span><span class="wc-d">Read or edit a single .md file</span><kbd>Ctrl O</kbd></button>
        <button class="welcome-card" data-w="new">${icon('FilePlus', 20, 1.6)}<span class="wc-t">New page</span><span class="wc-d">${S.folder ? `In ${escapeHtml(basename(S.folder))}` : 'Start from a blank page'}</span><kbd>Ctrl N</kbd></button>
      </div>
      ${recents.length ? `<div class="welcome-recents"><div class="wr-title">Recent</div>${recents.map((p) =>
        `<button class="wr-item" data-p="${escapeHtml(p)}">${icon('FileText', 15)}<span class="wr-name">${escapeHtml(stripExt(basename(p)))}</span><span class="wr-path">${escapeHtml(dirname(p))}</span></button>`).join('')}</div>` : ''}
    </div>`;
  $$('[data-w]', el.welcome).forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.w === 'folder') chooseFolder();
    if (b.dataset.w === 'file') chooseFile();
    if (b.dataset.w === 'new') newFile();
  }));
  $$('[data-p]', el.welcome).forEach((b) => b.addEventListener('click', () => openFile(b.dataset.p)));
}

function logoSvg() {
  return `<svg width="56" height="56" viewBox="0 0 64 64" fill="none" aria-hidden="true">
    <rect x="6" y="6" width="52" height="52" rx="14" fill="var(--accent)"/>
    <path d="M22 18h16l8 8v20a4 4 0 0 1-4 4H22a4 4 0 0 1-4-4V22a4 4 0 0 1 4-4Z" fill="#fff" fill-opacity=".96"/>
    <path d="M38 18v6a2 2 0 0 0 2 2h6" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round"/>
    <path d="M24 33h16M24 39h16M24 45h10" stroke="var(--accent)" stroke-width="2.6" stroke-linecap="round"/>
  </svg>`;
}

// ---------------------------------------------------------------- read toolbar
function buildReadToolbar() {
  const pill = el.tbRead.querySelector('.tb-pill');
  const b = (id, ic, tip) => `<button class="tb-btn" data-r="${id}" data-tip="${escapeHtml(tip)}">${icon(ic, 17)}</button>`;
  pill.innerHTML = `
    <div class="tb-group">${b('outline', 'TableOfContents', 'Show outline')}</div>
    <div class="tb-sep"></div>
    <div class="tb-group seg" data-seg="font">
      <button class="seg-btn" data-font="sans" data-tip="Sans-serif font">Sans</button>
      <button class="seg-btn serif" data-font="serif" data-tip="Serif font">Serif</button>
    </div>
    <div class="tb-sep"></div>
    <div class="tb-group">
      ${b('smaller', 'AArrowDown', 'Smaller text (Ctrl -)')}
      <span class="tb-num" id="size-label">16</span>
      ${b('bigger', 'AArrowUp', 'Larger text (Ctrl +)')}
    </div>
    <div class="tb-sep"></div>
    <div class="tb-group">${b('width', 'MoveHorizontal', 'Wide page')}</div>
    <div class="tb-sep"></div>
    <div class="tb-group">
      ${b('find', 'Search', 'Find in page (Ctrl F)')}
      ${b('copy', 'Copy', 'Copy as Markdown')}
      ${b('export', 'Download', 'Export / print')}
    </div>
  `;
  pill.addEventListener('click', async (e) => {
    // button[...] — <html> also carries data-font, so a bare [data-font] matched every click
    const fb = e.target.closest('button[data-font]');
    if (fb) { await saveSetting({ readFont: fb.dataset.font }); applyLook(); return; }
    const t = e.target.closest('[data-r]');
    if (!t) return;
    const a = t.dataset.r;
    if (a === 'outline') { await saveSetting({ outline: !setting('outline') }); applyLook(); }
    if (a === 'smaller') changeSize(-1);
    if (a === 'bigger') changeSize(1);
    if (a === 'width') { await saveSetting({ wide: !setting('wide') }); applyLook(); }
    if (a === 'find') find.open();
    if (a === 'copy') { await navigator.clipboard.writeText(S.text); toast('Markdown copied to clipboard'); }
    if (a === 'export') {
      showMenu([
        { label: 'Export as PDF…', icon: 'FileText', action: exportPdf },
        { label: 'Export as HTML…', icon: 'FileCode', action: exportHtml },
        { label: 'Print…', icon: 'Printer', action: () => window.print() },
      ], { anchor: t, align: 'right', minWidth: 200 });
    }
  });
}
function renderReadToolbarState() {
  const pill = el.tbRead.querySelector('.tb-pill');
  if (!pill) return;
  $$('[data-font]', pill).forEach((b) => b.classList.toggle('active', b.dataset.font === setting('readFont')));
  $('[data-r=outline]', pill)?.classList.toggle('active', !!setting('outline'));
  $('[data-r=width]', pill)?.classList.toggle('active', !!setting('wide'));
  const sl = $('#size-label');
  if (sl) sl.textContent = setting('fontSize');
}
async function changeSize(d) {
  const v = d === 0 ? 16 : Math.max(12, Math.min(26, setting('fontSize') + d));
  await saveSetting({ fontSize: v });
  applyLook();
}

async function exportPdf() {
  if (S.mode !== 'read') await setMode('read');
  const scrollTop = el.scroll.scrollTop;
  // diagrams are drawn for paper (light) even in dark mode
  if (S.theme === 'dark') await renderRead('light');
  await new Promise((r) => setTimeout(r, 120));
  try {
    const p = await api.exportPdf(joinPath(dirname(S.file), `${stripExt(basename(S.file))}.pdf`));
    if (p) toast('PDF exported');
  } catch (e) { toast(`Export failed: ${e.message}`, 'error'); }
  if (S.theme === 'dark') { await renderRead(); el.scroll.scrollTop = scrollTop; }
}
async function exportHtml() {
  if (S.mode !== 'read') await setMode('read');
  const css = [...document.styleSheets].map((s) => { try { return [...s.cssRules].map((r) => r.cssText).join('\n'); } catch { return ''; } }).join('\n');
  // local images: write the original relative paths back (folio:// only works inside the app)
  const doc = el.reader.cloneNode(true);
  doc.querySelectorAll('img[data-orig]').forEach((img) => { img.setAttribute('src', img.dataset.orig); img.removeAttribute('data-orig'); });
  doc.querySelectorAll('img').forEach((img) => img.classList.remove('broken'));
  const csp = "default-src 'none'; img-src * data: blob:; style-src 'unsafe-inline'; font-src data:";
  const html = `<!doctype html><html data-theme="light" data-font="${escapeHtml(setting('readFont'))}"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(stripExt(basename(S.file)))}</title><style>${css}
body{background:var(--bg);margin:0}.export-wrap{max-width:760px;margin:0 auto;padding:48px 24px}.code-copy{display:none}</style></head><body><div class="export-wrap"><article class="prose doc">${doc.innerHTML}</article></div></body></html>`;
  const p = await api.exportHtml(joinPath(dirname(S.file), `${stripExt(basename(S.file))}.html`), html);
  if (p) toast('HTML exported');
}

// ---------------------------------------------------------------- edit toolbar extras
function buildEditExtras() {
  const right = el.tbEdit.querySelector('.tb-right');
  right.innerHTML = `
    <div class="seg small" id="view-switch">
      <button class="seg-btn" data-view="visual" data-tip="Visual editor">Visual</button>
      <button class="seg-btn" data-view="source" data-tip="Raw Markdown (Ctrl Shift M)">Markdown</button>
    </div>`;
  right.addEventListener('click', (e) => {
    const b = e.target.closest('[data-view]');
    if (b) setEditView(b.dataset.view);
  });
  el.tbEdit.querySelector('.tb-left').innerHTML = `<span class="save-state" id="save-state"></span><span class="tb-meta" id="word-count-edit"></span>`;
  el.tbRead.querySelector('.tb-left').innerHTML = `<span class="tb-meta" id="word-count"></span>`;
  setSaveState('saved');
}

// ---------------------------------------------------------------- source textarea
function initSource() {
  el.source.addEventListener('input', () => {
    S.text = el.source.value;
    el.source.dataset.changed = '1';
    S.editorStale = true;
    markUnsaved();
    scheduleSave();
    autosizeSource();
    updateWordCountSoon();
  });
  el.source.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const { selectionStart: s, selectionEnd: en, value } = el.source;
      if (s === en && !e.shiftKey) {
        el.source.setRangeText('  ', s, en, 'end');
      } else {
        const ls = value.lastIndexOf('\n', s - 1) + 1;
        const block = value.slice(ls, en);
        const out = e.shiftKey ? block.replace(/^ {1,2}/gm, '') : block.replace(/^/gm, '  ');
        el.source.setRangeText(out, ls, en, 'select');
      }
      el.source.dispatchEvent(new Event('input'));
    }
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && ['b', 'i'].includes(e.key.toLowerCase())) {
      e.preventDefault();
      const mark = e.key.toLowerCase() === 'b' ? '**' : '*';
      const { selectionStart: s, selectionEnd: en, value } = el.source;
      const sel = value.slice(s, en);
      el.source.setRangeText(`${mark}${sel}${mark}`, s, en, 'select');
      if (!sel) el.source.setSelectionRange(s + mark.length, s + mark.length);
      el.source.dispatchEvent(new Event('input'));
    }
  });
  window.addEventListener('resize', debounce(() => { if (S.editView === 'source') autosizeSource(); }, 100));
}

// ---------------------------------------------------------------- quick open
function quickOpen() {
  const files = sidebar.allFiles();
  const recents = setting('recents');
  const all = [...new Set([...recents, ...files])];
  if (!all.length) { toast('Open a folder first'); return; }
  const m = h(`<div class="modal-backdrop top"><div class="palette">
    <div class="pal-input">${icon('Search', 16)}<input type="text" placeholder="Search pages…" spellcheck="false"></div>
    <div class="pal-list"></div>
    <div class="pal-foot"><span><kbd>↑</kbd><kbd>↓</kbd> to navigate</span><span><kbd>Enter</kbd> to open</span><span><kbd>Esc</kbd> to close</span></div>
  </div></div>`);
  document.body.appendChild(m);
  const input = $('input', m);
  const list = $('.pal-list', m);
  let items = [];
  let idx = 0;
  const score = (p, q) => {
    const name = stripExt(basename(p)).toLowerCase();
    if (!q) return 1;
    if (name.startsWith(q)) return 100 - name.length / 100;
    if (name.includes(q)) return 50 - name.length / 100;
    // subsequence
    let i = 0;
    for (const c of name) if (c === q[i]) i++;
    if (i === q.length) return 10;
    return p.toLowerCase().includes(q) ? 5 : 0;
  };
  const render = () => {
    const q = input.value.trim().toLowerCase();
    items = all.map((p) => ({ p, s: score(p, q) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, 50);
    idx = Math.min(idx, Math.max(0, items.length - 1));
    list.innerHTML = items.length ? items.map((x, i) => {
      const rel = S.folder && isInside(x.p, S.folder) ? dirname(x.p).slice(S.folder.length).replace(/^[\\/]/, '') : dirname(x.p);
      return `<button class="pal-item ${i === idx ? 'active' : ''}" data-i="${i}">${icon('FileText', 16)}<span class="pal-name">${escapeHtml(stripExt(basename(x.p)))}</span><span class="pal-path">${escapeHtml(rel)}</span></button>`;
    }).join('') : '<div class="pal-empty">No pages found</div>';
    $('.pal-item.active', list)?.scrollIntoView({ block: 'nearest' });
  };
  const done = (p) => { m.remove(); if (p) openFile(p); };
  input.addEventListener('input', () => { idx = 0; render(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); idx = Math.min(items.length - 1, idx + 1); render(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); idx = Math.max(0, idx - 1); render(); }
    if (e.key === 'Enter') { e.preventDefault(); done(items[idx]?.p); }
    if (e.key === 'Escape') { e.preventDefault(); done(null); }
  });
  list.addEventListener('click', (e) => { const b = e.target.closest('.pal-item'); if (b) done(items[Number(b.dataset.i)].p); });
  m.addEventListener('mousedown', (e) => { if (e.target === m) done(null); });
  render();
  input.focus();
}

// ---------------------------------------------------------------- settings menu
function openSettings(anchor) {
  const t = setting('theme');
  showMenu([
    { header: 'Appearance' },
    { label: 'System theme', icon: 'Monitor', checked: t === 'system', action: () => saveSetting({ theme: 'system' }).then(rerenderForTheme) },
    { label: 'Light', icon: 'Sun', checked: t === 'light', action: () => saveSetting({ theme: 'light' }).then(rerenderForTheme) },
    { label: 'Dark', icon: 'Moon', checked: t === 'dark', action: () => saveSetting({ theme: 'dark' }).then(rerenderForTheme) },
    'sep',
    { header: 'When opening a page' },
    { label: 'Open in Read', icon: 'BookOpen', checked: setting('openIn') === 'read', action: () => saveSetting({ openIn: 'read' }) },
    { label: 'Open in Edit', icon: 'PenLine', checked: setting('openIn') === 'edit', action: () => saveSetting({ openIn: 'edit' }) },
    { label: 'Keep last tab', icon: 'Clock', checked: setting('openIn') === 'last', action: () => saveSetting({ openIn: 'last' }) },
    'sep',
    { header: 'Page' },
    { label: 'Close button (Ctrl W)', icon: 'X', checked: setting('closeButton'), action: () => saveSetting({ closeButton: !setting('closeButton') }).then(applyLook) },
    'sep',
    { header: 'Editing' },
    { label: 'Auto-save', icon: 'Save', checked: setting('autosave'), action: () => saveSetting({ autosave: !setting('autosave') }).then(() => setSaveState(S.saveState)) },
    { label: 'Spell check', icon: 'Type', checked: setting('spellcheck'), action: () => saveSetting({ spellcheck: !setting('spellcheck') }).then(applyLook) },
    'sep',
    { label: 'Keyboard shortcuts', icon: 'Command', action: showShortcuts },
  ], { anchor, minWidth: 230, className: 'settings-menu' });
}
function rerenderForTheme() { if (S.file && S.mode === 'read') renderRead(); }

function showShortcuts() {
  const rows = [
    ['Read / Edit tab', 'Ctrl 1 / Ctrl 2'], ['Switch tab', 'Ctrl Shift E'], ['Save', 'Ctrl S'], ['New page', 'Ctrl N'], ['Close page', 'Ctrl W'],
    ['Open file', 'Ctrl O'], ['Open folder', 'Ctrl Shift O'], ['Quick open', 'Ctrl P'], ['Find', 'Ctrl F'],
    ['Find & replace', 'Ctrl H'], ['Toggle sidebar', 'Ctrl \\'], ['Text size', 'Ctrl + / Ctrl −'],
    ['Markdown view', 'Ctrl Shift M'], ['Block menu', '/'], ['Bold / Italic', 'Ctrl B / Ctrl I'], ['Inline code', 'Ctrl E'],
    ['Link', 'Ctrl K'], ['Heading 1–3', 'Ctrl Alt 1–3'], ['Checklist', 'Ctrl Shift 9'],
  ];
  const m = h(`<div class="modal-backdrop"><div class="modal wide"><div class="modal-title">Keyboard shortcuts</div>
    <div class="shortcuts">${rows.map(([a, k]) => `<div class="sc-row"><span>${escapeHtml(a)}</span><span class="sc-k">${k.split(' / ').map((x) => `<span>${x.split(' ').map((y) => `<kbd>${escapeHtml(y)}</kbd>`).join('')}</span>`).join('<i>or</i>')}</span></div>`).join('')}</div>
    <div class="modal-actions"><button class="btn primary">Done</button></div></div></div>`);
  document.body.appendChild(m);
  const close = () => m.remove();
  $('.btn', m).onclick = close;
  m.addEventListener('mousedown', (e) => { if (e.target === m) close(); });
  $('.btn', m).focus();
  m.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
}

// ---------------------------------------------------------------- tooltips
function initTooltips() {
  const tip = h('<div class="tooltip"></div>');
  document.body.appendChild(tip);
  let timer;
  document.addEventListener('mouseover', (e) => {
    const t = e.target.closest('[data-tip]');
    clearTimeout(timer);
    if (!t) { tip.classList.remove('show'); return; }
    timer = setTimeout(() => {
      tip.textContent = t.dataset.tip;
      tip.classList.add('show');
      const r = t.getBoundingClientRect();
      const tr = tip.getBoundingClientRect();
      let top = r.bottom + 8;
      if (top + tr.height > window.innerHeight - 8) top = r.top - tr.height - 8;
      tip.style.left = `${Math.max(6, Math.min(window.innerWidth - tr.width - 6, r.left + r.width / 2 - tr.width / 2))}px`;
      tip.style.top = `${top}px`;
    }, 450);
  });
  document.addEventListener('mousedown', () => { clearTimeout(timer); tip.classList.remove('show'); }, true);
}

// ---------------------------------------------------------------- shortcuts
function initShortcuts() {
  window.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (!mod) return;
    const k = e.key.toLowerCase();
    const inModal = !!document.querySelector('.modal-backdrop');
    if (inModal) return;
    const handled = () => { e.preventDefault(); e.stopPropagation(); };
    if (k === 's' && !e.shiftKey) { handled(); save({ force: false }).then((ok) => ok && toast('Saved')); return; }
    if (k === 'o' && e.shiftKey) { handled(); chooseFolder(); return; }
    if (k === 'o') { handled(); chooseFile(); return; }
    if (k === 'n') { handled(); newFile(); return; }
    if (k === 'w' && !e.shiftKey) { handled(); if (setting('closeButton')) closePage(); return; }
    if (k === 'p') { handled(); quickOpen(); return; }
    if (k === '1' && !e.altKey) { handled(); setMode('read'); return; }
    if (k === '2' && !e.altKey) { handled(); setMode('edit'); return; }
    if (k === 'e' && e.shiftKey) { handled(); setMode(S.mode === 'read' ? 'edit' : 'read'); return; }
    if (k === 'm' && e.shiftKey && S.mode === 'edit') { handled(); setEditView(S.editView === 'visual' ? 'source' : 'visual'); return; }
    if (k === '\\') { handled(); saveSetting({ sidebar: !setting('sidebar') }).then(applyLook); return; }
    if (k === 'f' && !e.shiftKey && S.file) { handled(); find.open(false); return; }
    if (k === 'h' && S.file && S.mode === 'edit') { handled(); find.open(true); return; }
    if (k === 'k' && S.mode === 'edit' && S.editView === 'visual' && editor?.isFocused) { handled(); editorActions.editLink(); return; }
    if ((k === '=' || k === '+') && !e.altKey) { handled(); changeSize(1); return; }
    if (k === '-' && !e.altKey) { handled(); changeSize(-1); return; }
    if (k === '0' && !e.altKey) { handled(); changeSize(0); }
  }, true);
}

// ---------------------------------------------------------------- drag & drop .md files
function initDrop() {
  document.addEventListener('dragover', (e) => {
    if ([...(e.dataTransfer?.items || [])].some((i) => i.kind === 'file')) e.preventDefault();
  });
  document.addEventListener('drop', async (e) => {
    const files = [...(e.dataTransfer?.files || [])];
    const md = files.find((f) => /\.(md|markdown|mdown|mkd|mdx)$/i.test(f.name));
    if (!md) {
      // a dropped folder?
      if (files.length === 1 && !files[0].type && !extname(files[0].name)) {
        const p = api.pathForFile(files[0]);
        if (p) { e.preventDefault(); openFolder(p); }
      }
      return;
    }
    e.preventDefault();
    const p = api.pathForFile(md);
    if (p) openFile(p);
  });
}

// ---------------------------------------------------------------- external changes
function initWatchers() {
  api.onFolderChanged(() => refreshTree());
  api.onFileChanged(async (info) => {
    if (!S.file || !samePath(info.path, S.file)) return;
    if (info.deleted) {
      if (await api.exists(S.file)) return;
      showBanner('deleted', 'This file was moved or deleted outside Folio. Your text is still here — press <b>Ctrl S</b> to save it again.', [
        { label: 'Close page', action: closeFile },
      ]);
      return;
    }
    if (Math.abs(info.mtime - S.mtime) < 5 || saving) return;
    const r = await api.read(S.file).catch(() => null);
    if (!r) return;
    const disk = r.content.replace(/\r\n/g, '\n');
    if (disk === S.savedText) { S.mtime = r.mtime; return; }
    syncFromEditor();
    const dirty = S.text !== S.savedText;
    if (!dirty) {
      openFile(S.file, { mode: S.mode, keepScroll: true, silent: true });
    } else {
      showBanner('conflict', 'This file was changed by another program.', [
        { label: 'Load their version', primary: true, action: () => { S.text = S.savedText; S.editorDirty = false; openFile(S.file, { mode: S.mode, keepScroll: true }); } },
        { label: 'Keep mine', action: () => { S.mtime = r.mtime; hideBanner(); save({ force: true }); } },
      ]);
    }
  });
}

// ---------------------------------------------------------------- boot
let sidebar;
let find;

async function boot() {
  const init = await api.init();
  S.settings = { ...DEFAULTS, ...(init.settings || {}) };
  applyTheme(init.theme);
  el.app.classList.add(`platform-${init.platform}`);

  // mode switch
  el.modeSwitch.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-mode]'); // #app also has data-mode
    if (b) setMode(b.dataset.mode);
  });
  $('#btn-close').addEventListener('click', () => closePage());
  $('#btn-sidebar').addEventListener('click', () => saveSetting({ sidebar: !setting('sidebar') }).then(applyLook));
  $('#btn-theme').addEventListener('click', () => {
    const next = S.theme === 'dark' ? 'light' : 'dark';
    saveSetting({ theme: next }).then(rerenderForTheme);
  });

  sidebar = createSidebar(el.sidebar, {
    getExpanded: () => setting('expanded'),
    setExpanded: (list) => saveSetting({ expanded: list.slice(-300) }),
    onOpenFile: (p) => openFile(p),
    onOpenFolder: chooseFolder,
    onOpenFolderPath: (p) => openFolder(p),
    onOpenFileDialog: chooseFile,
    onCloseFolder: closeFolder,
    onNewFile: (d) => newFile(d),
    onNewFolder: (d) => newFolder(d),
    // New page / New folder clicked with no folder open: pick one first, then carry on
    onNeedFolder: async (act) => {
      const p = await api.openFolderDialog();
      if (!p) return;
      await openFolder(p);
      if (act === 'newfile') newFile(p); else newFolder(p);
    },
    onRename: renamePath,
    onDelete: deletePath,
    onDuplicate: duplicatePath,
    onReveal: (p) => api.showInFolder(p),
    onForgetRecent: forgetRecent,
    onSettings: openSettings,
    onQuickOpen: quickOpen,
  });

  find = createFind(el.findbar, {
    getMode: () => (S.mode === 'read' ? 'read' : S.editView),
    getRoot: () => (S.mode === 'read' ? el.reader : el.editor.querySelector('.ProseMirror')),
    getEditor: () => editor,
    getTextarea: () => el.source,
    scrollEl: el.scroll,
    replaceInSource: (start, len, rep, batch) => {
      el.source.setRangeText(rep, start, start + len, 'end');
      if (!batch) el.source.dispatchEvent(new Event('input'));
    },
  });

  buildReadToolbar();
  buildEditExtras();
  // mouse wheel scrolls the toolbar sideways when the window is narrow
  $$('.tb-pill').forEach((p) => p.addEventListener('wheel', (e) => {
    if (p.scrollWidth > p.clientWidth && Math.abs(e.deltaY) > Math.abs(e.deltaX)) { p.scrollLeft += e.deltaY; e.preventDefault(); }
  }, { passive: false }));
  initEditor();
  initSource();
  initTooltips();
  initShortcuts();
  initDrop();
  initWatchers();
  applyLook();
  sidebar.setRecents(setting('recents'), setting('recentFolders'));

  el.scroll.addEventListener('scroll', () => {
    if (S.mode === 'read') updateOutlineActive(el.outline, el.scroll, S.outlineHeads);
    else ctxBar?.position();
  }, { passive: true });
  window.addEventListener('resize', debounce(() => ctxBar?.position(), 50));
  // clicking empty space below the page focuses the editor
  el.editorWrap.addEventListener('mousedown', (e) => {
    if (e.target !== el.editorWrap || S.editView !== 'visual') return;
    const pm = el.editor.querySelector('.ProseMirror');
    if (pm && e.clientY > pm.getBoundingClientRect().bottom) { e.preventDefault(); editor.commands.focus('end'); }
  });

  api.onThemeChanged((t) => { applyTheme(t); rerenderForTheme(); });
  api.onOpenPath((p) => openFile(p));
  api.onFlush(async () => {
    try { await flushSave(); } finally { api.flushed(); }
  });

  el.app.dataset.mode = 'read';
  updateCrumb();
  if (setting('lastFolder')) await openFolder(setting('lastFolder'), { silent: true });
  if (init.openPath) {
    await openFile(init.openPath);
  } else if (setting('lastFile') && await api.exists(setting('lastFile'))) {
    await openFile(setting('lastFile'), { silent: true });
  } else {
    renderWelcome();
  }
  document.documentElement.classList.add('ready');
}

boot();

// expose for tests
window.__folio = {
  S, get editor() { return editor; }, openFile, closePage, setMode, setEditView, save, openFolder, newFile,
  getMarkdown: () => getMarkdown(editor),
  getSmart: () => serializeSmart(editor, S.base),
  roundTrip: (text) => { const { body } = splitFrontMatter(text); const b = loadMarkdown(editor, body); return serializeSmart(editor, b); },
  fullRoundTrip: (text) => { const { body } = splitFrontMatter(text); loadMarkdown(editor, body); return getMarkdown(editor); },
};
