const { contextBridge, ipcRenderer, webUtils } = require('electron');

const invoke = (ch, ...a) => ipcRenderer.invoke(ch, ...a);
const on = (ch, fn) => {
  const h = (_e, ...a) => fn(...a);
  ipcRenderer.on(ch, h);
  return () => ipcRenderer.removeListener(ch, h);
};

contextBridge.exposeInMainWorld('folio', {
  init: () => invoke('app:init'),
  flushed: () => ipcRenderer.send('app:flushed'),
  setSettings: (patch) => invoke('settings:set', patch),

  openFolderDialog: () => invoke('dialog:openFolder'),
  openFileDialog: () => invoke('dialog:openFile'),
  saveAsDialog: (opts) => invoke('dialog:saveAs', opts),
  pickImage: () => invoke('dialog:pickImage'),

  tree: (root) => invoke('fs:tree', root),
  read: (p) => invoke('fs:read', p),
  write: (p, content) => invoke('fs:write', { path: p, content }),
  exists: (p) => invoke('fs:exists', p),
  newFile: (dir, base, content) => invoke('fs:newFile', { dir, base, content }),
  newFolder: (dir, base) => invoke('fs:newFolder', { dir, base }),
  rename: (from, to) => invoke('fs:rename', { from, to }),
  trash: (p) => invoke('fs:trash', p),
  saveImage: (opts) => invoke('fs:saveImage', opts),

  watchFolder: (root) => invoke('watch:folder', root),
  watchFile: (p) => invoke('watch:file', p),

  openExternal: (url) => invoke('shell:openExternal', url),
  showInFolder: (p) => invoke('shell:showInFolder', p),
  openPath: (p) => invoke('shell:openPath', p),

  exportPdf: (defaultPath) => invoke('export:pdf', { defaultPath }),
  exportHtml: (defaultPath, html) => invoke('export:html', { defaultPath, html }),

  pathInfo: (p) => invoke('path:info', p),
  resolvePath: (from, rel) => invoke('path:resolve', { from, rel }),
  joinPath: (...parts) => invoke('path:join', parts),
  pathForFile: (file) => { try { return webUtils.getPathForFile(file); } catch { return ''; } },

  onFlush: (fn) => on('app:flush', fn),
  onOpenPath: (fn) => on('app:openPath', fn),
  onThemeChanged: (fn) => on('theme:changed', fn),
  onFolderChanged: (fn) => on('fs:folderChanged', fn),
  onFileChanged: (fn) => on('fs:fileChanged', fn),
});
