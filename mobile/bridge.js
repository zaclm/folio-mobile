// window.folio for the phone app — the same API electron/preload.cjs gives the desktop app,
// implemented on top of FolioNativePlugin (android/app/src/main/java/com/zac/folio).
// src/main.js doesn't know which one it is talking to.
import { Capacitor, registerPlugin } from '@capacitor/core';
import { App } from '@capacitor/app';
import { confirmDialog, toast, dirname, basename, joinPath, normalize, resolveFrom, extname } from '../src/util.js';

// On a phone this is android/.../FolioNativePlugin.java; in a desktop browser (for trying the
// phone UI) a small in-memory stand-in is used instead.
const Native = registerPlugin('FolioNative', {
  web: () => import('./dev/mock-native.js').then((m) => new m.FolioNativeWeb()),
});

const IMG_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.avif']);
// Same idea as electron/main.cjs: links in documents are untrusted, so they never install or run anything.
const SAFE_OPEN_EXT = new Set([
  '.pdf', '.txt', '.log', '.csv', '.tsv', '.json', '.xml', '.yaml', '.yml',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.avif', '.svg', '.ico', '.heic',
  '.mp3', '.wav', '.m4a', '.flac', '.ogg', '.mp4', '.mov', '.webm', '.mkv', '.avi',
  '.docx', '.xlsx', '.pptx', '.odt', '.ods', '.odp', '.rtf', '.epub',
]);
const BLOCKED_OPEN_EXT = new Set([
  '.apk', '.apks', '.apkm', '.xapk', '.aab', '.dex', '.so', '.jar', '.sh', '.bash', '.js', '.mjs', '.cjs', '.html', '.htm',
  '.svgz', '.exe', '.bat', '.cmd', '.ps1', '.vbs', '.msi', '.py', '.rb', '.pl', '.php', '.lnk', '.url', '.desktop',
  '.docm', '.xlsm', '.pptm', '.dotm', '.xltm', '.potm', '.ppsm', '.sldm', '.xlsb',
]);

const THEME_BG = { light: '#FFFFFF', dark: '#232220' };
const isAndroid = Capacitor.getPlatform() === 'android';

// ------------------------------------------------------------------ events
const listeners = { flush: [], openPath: [], theme: [], folder: [], file: [], back: [] };
const on = (name, fn) => { listeners[name].push(fn); return () => { listeners[name] = listeners[name].filter((f) => f !== fn); }; };
const emit = (name, ...a) => listeners[name].forEach((fn) => { try { fn(...a); } catch (e) { console.error(e); } });

// ------------------------------------------------------------------ settings + theme
let settings = {};
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
function effectiveTheme() {
  const t = settings.theme || 'system';
  return t === 'system' ? (darkQuery.matches ? 'dark' : 'light') : t;
}
function paintBars() {
  const t = effectiveTheme();
  if (isAndroid) Native.setBars({ color: THEME_BG[t], dark: t === 'dark' }).catch(() => {});
}
darkQuery.addEventListener('change', () => {
  if ((settings.theme || 'system') === 'system') emit('theme', effectiveTheme());
  paintBars();
});
let saveTimer = null;
function persistSettings() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => Native.setSettings({ json: JSON.stringify(settings) }).catch(() => {}), 150);
}

// ------------------------------------------------------------------ storage access
let info = { hasAccess: false, documents: '/storage/emulated/0/Documents', storage: '/storage/emulated/0', version: '' };
async function refreshInfo() {
  try { info = await Native.getInfo(); } catch { /* keep the defaults */ }
  return info;
}
/** Asks for "All files access" (Android 11+) or the storage permission (older) when it's missing. */
async function ensureAccess() {
  if ((await refreshInfo()).hasAccess) return true;
  const ok = await confirmDialog({
    title: 'Let Folio open your notes',
    message: info.sdk >= 30
      ? 'Folio reads and saves your .md files right where they are, so a folder you sync with your PC stays the same on both. On the next screen, turn on “Allow access to manage all files” for Folio, then come back.'
      : 'Folio reads and saves your .md files right where they are, so a folder you sync with your PC stays the same on both. Allow access to files on the next screen.',
    okLabel: 'Continue',
  });
  if (!ok) return false;
  try {
    const r = await Native.requestAccess();
    if (r.hasAccess) { info.hasAccess = true; return true; }
  } catch { /* fall through */ }
  toast('Folio needs file access to open your notes', 'error');
  return false;
}

// ------------------------------------------------------------------ watching (Android has no recursive fs.watch: poll)
let folderRoot = null;
let folderSig = null;
let filePath = null;
let fileMtime = null;
let pollTimer = null;
let uriListening = false;
let ticks = 0;

async function pollFile() {
  if (!filePath) return;
  const p = filePath;
  let st;
  try { st = await Native.stat({ path: p }); } catch { return; }
  if (p !== filePath) return;
  if (!st.exists) {
    if (fileMtime !== -1) { fileMtime = -1; emit('file', { path: p, deleted: true }); }
    return;
  }
  if (fileMtime !== null && st.mtime !== fileMtime) emit('file', { path: p, mtime: st.mtime });
  fileMtime = st.mtime;
}
async function pollFolder() {
  if (!folderRoot) return;
  const root = folderRoot;
  let sig;
  try { sig = (await Native.signature({ path: root })).sig; } catch { return; }
  if (root !== folderRoot) return;
  if (folderSig !== null && sig !== folderSig) emit('folder');
  folderSig = sig;
}
function startPolling() {
  clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    ticks++;
    pollFile();
    if (ticks % 3 === 0) pollFolder();
  }, 2000);
}
function pollNow() { pollFile(); pollFolder(); }

// ------------------------------------------------------------------ helpers
async function uniquePath(dir, base, ext) {
  return (await Native.uniquePath({ dir, base, ext })).path;
}
function cleanExt(p) { return extname(basename(String(p).replace(/[. ]+$/, ''))).toLowerCase(); }
function bytesToBase64(bytes) {
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  return btoa(s);
}
function relativeTo(fromDir, target) {
  const a = normalize(fromDir).split('/').filter(Boolean);
  const b = normalize(target).split('/').filter(Boolean);
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return [...a.slice(i).map(() => '..'), ...b.slice(i)].join('/');
}
function folioDir() { return joinPath(info.documents, 'Folio'); }

async function openUri(uri) {
  if (!(await ensureAccess())) return;
  try {
    const r = await Native.resolveUri({ uri });
    if (!r.path) return;
    if (r.imported) toast('Opened a copy in Documents/Folio/Imported');
    emit('openPath', r.path);
  } catch (e) {
    toast(`Couldn't open that file: ${e.message}`, 'error');
  }
}

// ------------------------------------------------------------------ the API main.js uses
const api = {
  mobile: true,

  async init() {
    await refreshInfo();
    try { settings = JSON.parse((await Native.getSettings()).json || '{}') || {}; } catch { settings = {}; }
    paintBars();
    startPolling();
    return {
      settings,
      theme: effectiveTheme(),
      openPath: null,
      platform: 'android',
      version: info.version,
      documents: info.documents,
    };
  },
  flushed() {},
  async setSettings(patch) {
    if (patch && typeof patch === 'object') {
      for (const [k, v] of Object.entries(patch)) {
        if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
        settings[k] = v;
      }
    }
    persistSettings();
    if (patch && 'theme' in patch) paintBars();
    return { settings, theme: effectiveTheme() };
  },

  async openFolderDialog() {
    if (!(await ensureAccess())) return null;
    const r = await Native.pickFolder().catch((e) => { toast(e.message, 'error'); return {}; });
    if (r.error) toast('Pick a folder on the phone storage or SD card (not Drive or another app)', 'error');
    return r.path || null;
  },
  async openFileDialog() {
    if (!(await ensureAccess())) return null;
    try {
      const r = await Native.pickFile({ kind: 'markdown' });
      if (r.imported) toast('Opened a copy in Documents/Folio/Imported');
      return r.path || null;
    } catch (e) { toast(e.message, 'error'); return null; }
  },
  // New page with no folder open: phones have no "Save as" dialog, so it goes to Documents/Folio.
  async saveAsDialog({ defaultPath } = {}) {
    if (!(await ensureAccess())) return null;
    const dir = folioDir();
    await Native.mkdirs({ path: dir });
    const name = basename(defaultPath || 'Untitled.md') || 'Untitled.md';
    const ext = extname(name) || '.md';
    return uniquePath(dir, name.slice(0, name.length - ext.length) || 'Untitled', ext);
  },
  async pickImage() {
    const r = await Native.pickFile({ kind: 'image' }).catch(() => ({}));
    if (!r.uri) return null;
    return `${r.uri}#name=${encodeURIComponent(r.name || 'image.png')}`;
  },

  async tree(root) {
    if (!root) return null;
    const r = await Native.tree({ path: root }).catch(() => ({}));
    return r.tree || null;
  },
  read: (p) => Native.read({ path: p }),
  write: (p, content) => Native.write({ path: p, content: String(content ?? '') }),
  exists: async (p) => !!p && (await Native.stat({ path: p }).catch(() => ({}))).exists === true,
  newFile: async (dir, base, content) => (await Native.newFile({ dir, base, content: content || '' })).path,
  newFolder: async (dir, base) => (await Native.newFolder({ dir, base })).path,
  rename: async (from, to) => (await Native.rename({ from, to })).path,
  trash: async (p) => { await Native.trash({ path: p }); return true; },
  async saveImage({ mdPath, name, data, sourcePath }) {
    let srcName = name || 'image';
    let uri = null;
    if (sourcePath) {
      const [u, frag] = String(sourcePath).split('#name=');
      uri = u;
      if (frag) srcName = decodeURIComponent(frag);
    }
    const ext = cleanExt(srcName) || '.png';
    if (!IMG_EXT.has(ext)) throw new Error('Only image files can be added.');
    const base = (basename(srcName).slice(0, -ext.length).replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '') || 'image').slice(0, 60);
    const dir = joinPath(dirname(mdPath), 'assets');
    await Native.mkdirs({ path: dir });
    const target = await uniquePath(dir, base, ext);
    if (uri) await Native.copyUri({ uri, path: target });
    else await Native.writeBase64({ path: target, data: bytesToBase64(data instanceof Uint8Array ? data : new Uint8Array(data)) });
    return relativeTo(dirname(mdPath), target);
  },

  async watchFolder(root) { folderRoot = root || null; folderSig = null; pollFolder(); return true; },
  async watchFile(p) { filePath = p || null; fileMtime = null; pollFile(); return true; },

  async openExternal(url) {
    if (!/^https?:|^mailto:/i.test(url)) return false;
    try { await Native.openUrl({ url }); } catch (e) { toast(e.message, 'error'); }
    return true;
  },
  async showInFolder() { return false; },
  async openPath(p) {
    const name = basename(p);
    const ext = cleanExt(p);
    if (BLOCKED_OPEN_EXT.has(ext)) {
      toast(`Folio won't open “${name}” from a link`, 'error');
      return 'Blocked: executable';
    }
    if (!SAFE_OPEN_EXT.has(ext)) {
      const ok = await confirmDialog({
        title: `Open “${name}”?`,
        message: 'This link opens a file with another app. Only continue if you trust where this document came from.',
        okLabel: 'Open',
      });
      if (!ok) return 'Cancelled';
    }
    try { await Native.openFile({ path: p }); return ''; } catch (e) { toast(e.message, 'error'); return e.message; }
  },
  async share(p) {
    try { await Native.share({ path: p, title: basename(p) }); } catch (e) { toast(`Couldn't share: ${e.message}`, 'error'); }
  },

  async exportPdf(defaultPath) {
    // Android's print dialog has "Save as PDF"
    await Native.print({ name: basename(defaultPath || 'Folio.pdf').replace(/\.pdf$/i, '') });
    return null;
  },
  async exportHtml(defaultPath, html) {
    const dir = dirname(defaultPath);
    const name = basename(defaultPath);
    const ext = extname(name) || '.html';
    const target = await uniquePath(dir, name.slice(0, name.length - ext.length), ext);
    await Native.write({ path: target, content: String(html ?? '') });
    toast(`Saved ${basename(target)} next to the page`);
    return target;
  },

  pathInfo: async (p) => ({ dir: dirname(p), base: basename(p), ext: extname(basename(p)), name: basename(p).replace(/\.[^.]*$/, ''), sep: '/' }),
  resolvePath: async (from, rel) => resolveFrom(from, rel),
  joinPath: async (...parts) => joinPath(...parts),
  pathForFile: () => '',

  // local images in documents: Capacitor serves files from https://localhost/_capacitor_file_/…
  localUrl(absPath) {
    if (!IMG_EXT.has(cleanExt(absPath))) return 'about:blank';
    return Capacitor.convertFileSrc(normalize(absPath));
  },

  onFlush: (fn) => on('flush', fn),
  onOpenPath(fn) {
    const off = on('openPath', fn);
    // "Open with Folio": start listening once the app can open pages (Capacitor keeps the
    // launch intent until someone listens, so a file that started the app isn't lost)
    if (isAndroid && !uriListening) { uriListening = true; Native.addListener('openUri', ({ uri }) => openUri(uri)); }
    return off;
  },
  onThemeChanged: (fn) => on('theme', fn),
  onFolderChanged: (fn) => on('folder', fn),
  onFileChanged: (fn) => on('file', fn),
  /** fn() returns true when it handled the Android back gesture. */
  onBack: (fn) => on('back', fn),
};

window.folio = api;

// ------------------------------------------------------------------ app lifecycle
if (isAndroid) {
  // save when the app goes to the background (it may never come back)
  App.addListener('pause', () => emit('flush'));
  App.addListener('resume', () => { refreshInfo(); pollNow(); });
  App.addListener('backButton', () => {
    for (const fn of [...listeners.back].reverse()) {
      try { if (fn()) return; } catch (e) { console.error(e); }
    }
    App.minimizeApp();
  });
}
