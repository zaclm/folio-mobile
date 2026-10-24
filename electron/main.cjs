// Folio — main process
const { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme, protocol, net, screen, session, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const { pathToFileURL } = require('url');

const IS_DEV = !!process.env.FOLIO_DEV && !app.isPackaged;
const MD_EXT = new Set(['.md', '.markdown', '.mdown', '.mkd', '.mdx']);
const IMG_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.avif']);
const IGNORE_DIRS = new Set(['node_modules', '.git', '.svn', '.hg', '__pycache__', '.venv', 'venv', '.next', 'dist', 'build', '.cache']);
const MAX_READ_BYTES = 50 * 1024 * 1024; // refuse to load giant files into the editor

// ---------- link / path safety ----------
// Links inside a markdown file are untrusted: a file someone sends you must not be able to
// run programs or make Windows connect to a remote server just because you opened/clicked it.
// File types that open directly from a link (data formats with no macros/scripts):
const SAFE_OPEN_EXT = new Set([
  '.pdf', '.txt', '.log', '.csv', '.tsv', '.json', '.xml', '.yaml', '.yml',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.avif', '.svg', '.ico', '.heic',
  '.mp3', '.wav', '.m4a', '.flac', '.ogg', '.mp4', '.mov', '.webm', '.mkv', '.avi',
  '.docx', '.xlsx', '.pptx', '.odt', '.ods', '.odp', '.rtf',
]);
// Programs, scripts, shortcuts and installers: never launched from a link.
const BLOCKED_OPEN_EXT = new Set([
  '.exe', '.com', '.bat', '.cmd', '.ps1', '.psm1', '.psd1', '.ps1xml', '.vbs', '.vbe', '.js', '.jse', '.mjs', '.cjs',
  '.wsf', '.wsh', '.ws', '.wsc', '.hta', '.msi', '.msp', '.mst', '.msix', '.msixbundle', '.appx', '.appxbundle',
  '.appinstaller', '.application', '.appref-ms', '.scr', '.pif', '.lnk', '.url', '.website', '.reg', '.cpl', '.inf',
  '.jar', '.jnlp', '.gadget', '.msc', '.scf', '.chm', '.dll', '.ocx', '.sys', '.drv', '.iso', '.img', '.vhd', '.vhdx',
  '.diagcab', '.settingcontent-ms', '.library-ms', '.search-ms', '.searchconnector-ms', '.xll', '.xlam', '.ppam',
  '.docm', '.dotm', '.xlsm', '.xltm', '.xlsb', '.pptm', '.potm', '.ppsm', '.sldm', '.py', '.pyw', '.pyz', '.rb', '.pl',
  '.sh', '.bash', '.zsh', '.command', '.app', '.desktop', '.run', '.bin', '.elf', '.deb', '.rpm', '.pkg', '.dmg',
]);

/** \\server\share, //server/share, \\?\UNC\…, \\.\device — anything that is not a plain local path. */
function isRemotePath(p) {
  return /^[\\/]{2}/.test(String(p || ''));
}
/** "\\server\share" (lower-case) for a UNC path, else null. */
function shareRoot(p) {
  const m = String(p || '').replace(/\//g, '\\').match(/^\\\\(?:[?.]\\(?:UNC\\)?)?([^\\]+)\\([^\\]+)/i);
  return m ? `\\\\${m[1]}\\${m[2]}`.toLowerCase() : null;
}
// Network shares the user opened on purpose (a folder or file on a NAS) stay usable.
const trustedShares = new Set();
function trustShareOf(p) { const r = shareRoot(p); if (r) trustedShares.add(r); }
function remoteAllowed(p) {
  if (!isRemotePath(p)) return true;
  const r = shareRoot(p);
  return !!r && trustedShares.has(r);
}
function cleanExt(p) {
  // Windows ignores trailing dots/spaces ("evil.exe." runs evil.exe)
  return path.extname(String(p).replace(/[. ]+$/, '')).toLowerCase();
}

// test hooks (development builds only)
const TEST_MODE = !app.isPackaged;
if (TEST_MODE && process.env.FOLIO_USERDATA) app.setPath('userData', process.env.FOLIO_USERDATA);

// ---------- custom protocol for local images ----------
protocol.registerSchemesAsPrivileged([
  { scheme: 'folio', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

// ---------- settings ----------
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
let settings = {};
function loadSettings() {
  try { settings = JSON.parse(fs.readFileSync(settingsFile(), 'utf8')); } catch { settings = {}; }
}
function saveSettings() {
  try {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
  } catch (e) { console.error('settings save failed', e); }
}

// ---------- window ----------
let win = null;
let allowClose = false;
let pendingOpenPath = null;

const THEMES = {
  light: { color: '#FFFFFF', symbolColor: '#37352F', bg: '#FFFFFF' },
  dark: { color: '#232220', symbolColor: '#E6E3DD', bg: '#232220' },
};
function effectiveTheme() {
  const t = settings.theme || 'system';
  if (t === 'system') return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
  return t;
}

function findMdArg(argv) {
  for (const a of argv.slice(1)) {
    if (!a || a.startsWith('-')) continue;
    try {
      const p = path.resolve(a);
      if (MD_EXT.has(path.extname(p).toLowerCase()) && fs.existsSync(p)) return p;
    } catch { /* ignore */ }
  }
  return null;
}

function createWindow() {
  const theme = THEMES[effectiveTheme()];
  const b = settings.windowBounds;
  let bounds = { width: 1280, height: 820 };
  if (b && b.width && b.height) {
    const visible = screen.getAllDisplays().some((d) => {
      const a = d.workArea;
      return b.x >= a.x - 50 && b.y >= a.y - 50 && b.x < a.x + a.width && b.y < a.y + a.height;
    });
    bounds = visible ? b : { width: b.width, height: b.height };
  }

  win = new BrowserWindow({
    ...bounds,
    minWidth: 720,
    minHeight: 480,
    show: false,
    backgroundColor: theme.bg,
    title: 'Folio',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: theme.color, symbolColor: theme.symbolColor, height: 44 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
    },
  });
  if (settings.maximized) win.maximize();

  if (IS_DEV) win.loadURL('http://localhost:5173');
  else win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));

  win.once('ready-to-show', () => win.show());
  if (TEST_MODE && process.env.FOLIO_TEST_SCRIPT) {
    win.webContents.once('did-finish-load', () => require(path.resolve(process.env.FOLIO_TEST_SCRIPT))(win, app));
  }

  const remember = () => {
    if (!win || win.isDestroyed()) return;
    settings.maximized = win.isMaximized();
    if (!win.isMaximized() && !win.isMinimized()) settings.windowBounds = win.getBounds();
  };
  win.on('resize', remember);
  win.on('move', remember);

  // Never navigate the app window away; open web links in the browser.
  win.webContents.on('will-navigate', (e, url) => {
    e.preventDefault();
    if (/^https?:|^mailto:/i.test(url)) shell.openExternal(url);
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:|^mailto:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  // Developer tools only in development builds
  if (!app.isPackaged) {
    win.webContents.on('before-input-event', (e, input) => {
      if (input.type === 'keyDown' && input.key === 'F12' && input.control && input.shift) {
        win.webContents.toggleDevTools();
      }
    });
  } else {
    win.webContents.on('devtools-opened', () => win.webContents.closeDevTools());
  }
  win.webContents.on('will-attach-webview', (e) => e.preventDefault());

  // Make sure pending edits are written before closing.
  win.on('close', (e) => {
    remember();
    saveSettings();
    if (allowClose) return;
    e.preventDefault();
    win.webContents.send('app:flush');
    setTimeout(() => { allowClose = true; if (win && !win.isDestroyed()) win.close(); }, 2500);
  });
  win.on('closed', () => { win = null; });
}

// ---------- single instance + "Open with" ----------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const p = findMdArg(argv);
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
      if (p) { trustShareOf(p); win.webContents.send('app:openPath', p); }
    }
  });
}

app.whenReady().then(() => {
  loadSettings();
  pendingOpenPath = findMdArg(process.argv);
  if (pendingOpenPath) trustShareOf(pendingOpenPath);

  // folio://local/<encoded absolute path> — serves local IMAGES only (what the editor needs).
  // Anything else (html, scripts, your documents, keys…) is refused, and remote/UNC paths are
  // refused unless they are on a network share the user opened themselves.
  protocol.handle('folio', async (request) => {
    try {
      const u = new URL(request.url);
      if (u.host !== 'local') return new Response('not found', { status: 404 });
      const p = decodeURIComponent(u.pathname.replace(/^\//, ''));
      if (!IMG_EXT.has(cleanExt(p)) || /[\0]/.test(p)) return new Response('forbidden', { status: 403 });
      if (!remoteAllowed(p)) return new Response('forbidden', { status: 403 });
      const fileUrl = pathToFileURL(p);
      if (fileUrl.host && !remoteAllowed(p)) return new Response('forbidden', { status: 403 });
      const res = await net.fetch(fileUrl.toString());
      const headers = new Headers(res.headers);
      headers.set('X-Content-Type-Options', 'nosniff');
      if (cleanExt(p) === '.svg') headers.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:");
      return new Response(res.body, { status: res.status, headers });
    } catch (e) {
      return new Response('not found', { status: 404 });
    }
  });

  // Catch-all against UNC/SMB leaks: a document can reference a network share through many HTML
  // attributes (srcset, <source>, <video poster>, style url(), <svg image>, <input type=image>…).
  // On Windows each of those becomes file://host/share/… and makes Windows send your login hash.
  // Block every file:// request that points at another machine, unless it's a share you opened.
  session.defaultSession.webRequest.onBeforeRequest((details, cb) => {
    if (!details.url.startsWith('file:')) return cb({});
    let u;
    try { u = new URL(details.url); } catch { return cb({ cancel: true }); }
    let pth = u.pathname;
    try { pth = decodeURIComponent(pth); } catch { /* keep raw */ }
    let unc = null;
    if (u.hostname && u.hostname.toLowerCase() !== 'localhost') unc = `\\\\${u.hostname}${pth}`;
    else if (/^[\\/]{2}/.test(pth)) unc = pth; // file:////host/share form
    cb({ cancel: !!unc && !remoteAllowed(unc.replace(/\//g, '\\')) });
  });

  // The app needs no camera/mic/location/notifications etc. Only allow writing to the clipboard (Copy buttons).
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => {
    cb(permission === 'clipboard-sanitized-write');
  });

  nativeTheme.themeSource = settings.theme || 'system';
  nativeTheme.on('updated', () => {
    applyOverlay();
    if (win) win.webContents.send('theme:changed', effectiveTheme());
  });

  // No app menu: its hidden shortcuts (Ctrl+W closes the window, Ctrl+R reloads) clash with Folio's own.
  Menu.setApplicationMenu(null);
  createWindow();
});

app.on('window-all-closed', () => app.quit());

// Never quit while a save is still being written (avoids half-written / empty files).
const pendingWrites = new Set();
let quitting = false;
app.on('will-quit', (e) => {
  if (!pendingWrites.size || quitting) return;
  e.preventDefault();
  quitting = true;
  Promise.allSettled([...pendingWrites]).then(() => app.quit());
});
function track(promise) {
  pendingWrites.add(promise);
  promise.finally(() => pendingWrites.delete(promise)).catch(() => {});
  return promise;
}

function applyOverlay() {
  if (!win || win.isDestroyed()) return;
  const t = THEMES[effectiveTheme()];
  try { win.setTitleBarOverlay({ color: t.color, symbolColor: t.symbolColor, height: 44 }); } catch { /* not supported */ }
  win.setBackgroundColor(t.bg);
}

// ---------- helpers ----------
function isMd(name) { return MD_EXT.has(path.extname(name).toLowerCase()); }

async function buildTree(dir, depth = 0, counter = { n: 0 }) {
  if (depth > 10 || counter.n > 8000) return { children: [], hasMd: false, hasOther: false };
  let entries = [];
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return { children: [], hasMd: false, hasOther: false }; }
  const folders = [];
  const files = [];
  let hasOther = false;
  let anyMd = false;
  for (const ent of entries) {
    if (ent.name.startsWith('.')) continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (IGNORE_DIRS.has(ent.name)) continue;
      const sub = await buildTree(full, depth + 1, counter);
      // show folders that contain markdown, or that are completely empty
      if (sub.hasMd || !sub.hasOther) {
        folders.push({ type: 'dir', name: ent.name, path: full, children: sub.children });
      }
      if (sub.hasMd) anyMd = true;
      if (sub.hasOther) hasOther = true;
    } else if (ent.isFile()) {
      if (isMd(ent.name)) { files.push({ type: 'file', name: ent.name, path: full }); counter.n++; }
      else hasOther = true;
    }
  }
  const coll = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  folders.sort((a, b) => coll.compare(a.name, b.name));
  files.sort((a, b) => coll.compare(a.name, b.name));
  const hasMd = files.length > 0 || anyMd;
  return { children: [...folders, ...files], hasMd, hasOther };
}

async function uniquePath(dir, base, ext) {
  let candidate = path.join(dir, `${base}${ext}`);
  let i = 2;
  while (fs.existsSync(candidate)) { candidate = path.join(dir, `${base} ${i}${ext}`); i++; }
  return candidate;
}

// ---------- file watching ----------
// On Windows, fs.watch emits an 'error' (EPERM) when the watched file/folder is renamed, moved,
// deleted, or briefly unavailable (OneDrive sync, USB drive unplugged, permission change).
// An FSWatcher without an 'error' listener turns that into an uncaught exception that crashes
// the main process, so every watcher handles its own errors and recovers.
let folderWatcher = null;
let folderRoot = null;
let folderTimer = null;
let folderRetries = [];
function notifyFolderChanged() {
  clearTimeout(folderTimer);
  folderTimer = setTimeout(() => { if (win && !win.isDestroyed()) win.webContents.send('fs:folderChanged'); }, 350);
}
function stopFolderWatch() {
  if (folderWatcher) { const w = folderWatcher; folderWatcher = null; try { w.close(); } catch { /* already closed */ } }
}
function watchFolder(root) {
  stopFolderWatch();
  folderRoot = root || null;
  if (!root) return;
  let w;
  try {
    w = fs.watch(root, { recursive: true }, (_evt, filename) => {
      if (filename && /(^|[\\/])(node_modules|\.git)([\\/]|$)/.test(filename)) return;
      notifyFolderChanged();
    });
  } catch (e) { console.warn('folder watch unavailable:', e.code || e.message); return; }
  folderWatcher = w;
  w.on('error', (err) => {
    if (folderWatcher !== w) return; // an old watcher we already replaced
    console.warn('folder watch error:', err.code || err.message);
    stopFolderWatch();
    notifyFolderChanged(); // the sidebar re-reads the folder (and closes it if it's gone)
    // Try to watch again shortly, at most 5 times a minute so a broken folder can't loop.
    const now = Date.now();
    folderRetries = folderRetries.filter((t) => now - t < 60000);
    if (folderRetries.length >= 5) return;
    folderRetries.push(now);
    setTimeout(() => {
      if (folderRoot === root && !folderWatcher && fs.existsSync(root)) watchFolder(root);
    }, 1500);
  });
}

let fileWatcher = null;
let filePath = null;
let fileTimer = null;
function stopFileWatch() {
  if (fileWatcher) { const w = fileWatcher; fileWatcher = null; try { w.close(); } catch { /* already closed */ } }
}
function reportFile(p) {
  clearTimeout(fileTimer);
  fileTimer = setTimeout(async () => {
    if (!win || win.isDestroyed()) return;
    try {
      const st = await fsp.stat(p);
      win.webContents.send('fs:fileChanged', { path: p, mtime: st.mtimeMs });
    } catch {
      win.webContents.send('fs:fileChanged', { path: p, deleted: true });
    }
  }, 250);
}
function watchFile(p) {
  stopFileWatch();
  filePath = p || null;
  if (!p) return;
  let w;
  try {
    w = fs.watch(p, () => reportFile(p));
  } catch (e) { console.warn('file watch unavailable:', e.code || e.message); return; }
  fileWatcher = w;
  w.on('error', (err) => {
    if (fileWatcher !== w) return;
    console.warn('file watch error:', err.code || err.message);
    stopFileWatch();
    reportFile(p); // tells the page whether the file changed or was moved/deleted
    // Some editors save by replacing the file: if it's back, keep watching it.
    setTimeout(() => {
      if (filePath === p && !fileWatcher && fs.existsSync(p)) watchFile(p);
    }, 1500);
  });
}
/** Stop watching paths Folio itself is about to rename/delete (avoids the Windows EPERM). */
function releaseWatchesUnder(target) {
  const t = path.resolve(target).toLowerCase();
  const inside = (p) => { if (!p) return false; const q = path.resolve(p).toLowerCase(); return q === t || q.startsWith(t + path.sep); };
  if (inside(filePath)) stopFileWatch();
  if (inside(folderRoot)) stopFolderWatch();
}

if (TEST_MODE) global.__folioWatch = () => ({ folderWatcher, fileWatcher, folderRoot, filePath });

// ---------- IPC ----------
ipcMain.handle('app:init', () => ({
  settings,
  theme: effectiveTheme(),
  openPath: pendingOpenPath,
  platform: process.platform,
  version: app.getVersion(),
  documents: app.getPath('documents'),
}));
ipcMain.on('app:flushed', () => {
  allowClose = true;
  if (win && !win.isDestroyed()) win.close();
});

ipcMain.handle('settings:set', (_e, patch) => {
  if (patch && typeof patch === 'object') {
    for (const [k, v] of Object.entries(patch)) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
      settings[k] = v;
    }
  }
  saveSettings();
  if (patch && 'theme' in patch) {
    nativeTheme.themeSource = patch.theme || 'system';
    applyOverlay();
  }
  return { settings, theme: effectiveTheme() };
});

ipcMain.handle('dialog:openFolder', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
  if (!r.canceled) trustShareOf(r.filePaths[0]);
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('dialog:openFile', async () => {
  const r = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: [{ name: 'Markdown', extensions: ['md', 'markdown', 'mdown', 'mkd', 'mdx'] }, { name: 'All files', extensions: ['*'] }],
  });
  if (!r.canceled) trustShareOf(r.filePaths[0]);
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('dialog:saveAs', async (_e, { defaultPath, filters }) => {
  const r = await dialog.showSaveDialog(win, {
    defaultPath,
    filters: filters || [{ name: 'Markdown', extensions: ['md'] }],
  });
  if (!r.canceled) trustShareOf(r.filePath);
  return r.canceled ? null : r.filePath;
});
ipcMain.handle('dialog:pickImage', async () => {
  const r = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: [...IMG_EXT].map((e) => e.slice(1)) }],
  });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('fs:tree', async (_e, root) => {
  if (!root || !fs.existsSync(root)) return null;
  const t = await buildTree(root);
  return { type: 'dir', name: path.basename(root), path: root, children: t.children };
});
ipcMain.handle('fs:read', async (_e, p) => {
  const st = await fsp.stat(p);
  if (!st.isFile()) throw new Error('Not a file.');
  if (st.size > MAX_READ_BYTES) throw new Error('This file is too large to open (over 50 MB).');
  const buf = await fsp.readFile(p);
  let text = buf.toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return { content: text, mtime: st.mtimeMs, eol: text.includes('\r\n') ? '\r\n' : '\n' };
});
ipcMain.handle('fs:write', async (_e, { path: p, content }) => {
  await track(fsp.writeFile(p, String(content ?? ''), 'utf8'));
  const st = await fsp.stat(p);
  return { mtime: st.mtimeMs };
});
ipcMain.handle('fs:exists', (_e, p) => (remoteAllowed(p) ? fs.existsSync(p) : false));
ipcMain.handle('fs:newFile', async (_e, { dir, base, content }) => {
  const p = await uniquePath(dir, base || 'Untitled', '.md');
  await track(fsp.writeFile(p, content || '', 'utf8'));
  return p;
});
ipcMain.handle('fs:newFolder', async (_e, { dir, base }) => {
  let p = path.join(dir, base || 'New folder');
  let i = 2;
  while (fs.existsSync(p)) { p = path.join(dir, `${base || 'New folder'} ${i}`); i++; }
  await fsp.mkdir(p, { recursive: true });
  return p;
});
ipcMain.handle('fs:rename', async (_e, { from, to }) => {
  if (fs.existsSync(to) && path.resolve(from).toLowerCase() !== path.resolve(to).toLowerCase()) {
    throw new Error('A file with that name already exists.');
  }
  releaseWatchesUnder(from);
  await fsp.rename(from, to);
  return to;
});
ipcMain.handle('fs:trash', async (_e, p) => { releaseWatchesUnder(p); await shell.trashItem(p); return true; });
ipcMain.handle('fs:saveImage', async (_e, { mdPath, name, data, sourcePath }) => {
  const dir = path.join(path.dirname(mdPath), 'assets');
  await fsp.mkdir(dir, { recursive: true });
  const ext = cleanExt(name || sourcePath || '.png') || '.png';
  if (!IMG_EXT.has(ext)) throw new Error('Only image files can be added.');
  const base = (path.basename(name || sourcePath || 'image', ext).replace(/[^\w\-]+/g, '-').replace(/^-+|-+$/g, '') || 'image').slice(0, 60);
  const target = await uniquePath(dir, base, ext.toLowerCase());
  if (sourcePath) await track(fsp.copyFile(sourcePath, target));
  else await track(fsp.writeFile(target, Buffer.from(data)));
  return path.relative(path.dirname(mdPath), target).split(path.sep).join('/');
});

// The renderer only watches what the user opened (dialog, drag & drop, recents, or a link that
// passed fs:exists — which refuses untrusted network paths), so these mark the share as trusted.
ipcMain.handle('watch:folder', (_e, root) => { trustShareOf(root); watchFolder(root); return true; });
ipcMain.handle('watch:file', (_e, p) => { trustShareOf(p); watchFile(p); return true; });

ipcMain.handle('shell:openExternal', (_e, url) => {
  if (/^https?:|^mailto:/i.test(url)) return shell.openExternal(url);
  return false;
});
ipcMain.handle('shell:showInFolder', (_e, p) => { shell.showItemInFolder(p); return true; });
// Opening a local file from a link in a document. Links are untrusted content, so:
// programs/scripts/shortcuts are never launched, unknown types need a confirmation,
// remote (UNC) paths are refused unless on a share the user opened.
ipcMain.handle('shell:openPath', async (_e, p) => {
  if (typeof p !== 'string' || !p) return 'Invalid path';
  const abs = path.resolve(p);
  if (!remoteAllowed(abs)) return 'Blocked: network path';
  if (/^[a-zA-Z]:.*:/.test(abs) || (!/^[a-zA-Z]:/.test(abs) && abs.includes(':'))) return 'Blocked: invalid path';
  let st;
  try { st = await fsp.stat(abs); } catch { return 'Not found'; }
  if (st.isDirectory()) return shell.openPath(abs);
  const ext = cleanExt(abs);
  const name = path.basename(abs);
  if (BLOCKED_OPEN_EXT.has(ext)) {
    const r = await dialog.showMessageBox(win, {
      type: 'warning',
      title: 'Folio',
      message: `Folio won't run “${name}” from a link`,
      detail: 'This link points to a program, script or shortcut. Links in documents can come from anyone, so Folio never runs them. If you trust this file, open it yourself from File Explorer.',
      buttons: ['OK', 'Show in folder'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (r.response === 1) shell.showItemInFolder(abs);
    return 'Blocked: executable';
  }
  if (!SAFE_OPEN_EXT.has(ext)) {
    const r = await dialog.showMessageBox(win, {
      type: 'question',
      title: 'Folio',
      message: `Open “${name}”?`,
      detail: `This link opens a file with another app:\n${abs}\n\nOnly continue if you trust where this document came from.`,
      buttons: ['Cancel', 'Open', 'Show in folder'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (r.response === 2) { shell.showItemInFolder(abs); return 'Revealed'; }
    if (r.response !== 1) return 'Cancelled';
  }
  return shell.openPath(abs);
});

ipcMain.handle('export:pdf', async (_e, { defaultPath }) => {
  const target = await dialog.showSaveDialog(win, { defaultPath, filters: [{ name: 'PDF', extensions: ['pdf'] }] });
  if (target.canceled || !target.filePath) return null;
  // page margins use the window's base color, so print on white
  win.setBackgroundColor('#FFFFFF');
  let data;
  try {
    data = await win.webContents.printToPDF({
      printBackground: true,
      pageSize: 'A4',
      margins: { marginType: 'custom', top: 0.6, bottom: 0.6, left: 0.6, right: 0.6 },
    });
  } finally {
    win.setBackgroundColor(THEMES[effectiveTheme()].bg);
  }
  await track(fsp.writeFile(target.filePath, data));
  return target.filePath;
});
ipcMain.handle('export:html', async (_e, { defaultPath, html }) => {
  const target = await dialog.showSaveDialog(win, { defaultPath, filters: [{ name: 'HTML', extensions: ['html'] }] });
  if (target.canceled || !target.filePath) return null;
  await track(fsp.writeFile(target.filePath, String(html ?? ''), 'utf8'));
  return target.filePath;
});

ipcMain.handle('path:info', (_e, p) => ({
  dir: path.dirname(p),
  base: path.basename(p),
  ext: path.extname(p),
  name: path.basename(p, path.extname(p)),
  sep: path.sep,
}));
ipcMain.handle('path:resolve', (_e, { from, rel }) => path.resolve(path.dirname(from), rel));
ipcMain.handle('path:join', (_e, parts) => path.join(...parts));
