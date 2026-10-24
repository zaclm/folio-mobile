// In-browser stand-in for FolioNativePlugin, so the phone UI can be tried and tested in a normal
// browser (`npm run dev:mobile`, then open it with the device toolbar on). Never used on a phone.
import { WebPlugin } from '@capacitor/core';

const ROOT = '/storage/emulated/0';
const DOCS = `${ROOT}/Documents`;
const NOTES = `${DOCS}/Notes`;

const SAMPLE = {
  [`${NOTES}/Welcome.md`]: `# Welcome to Folio

Folio on your phone reads and edits the **same .md files** as on your PC.

## What you can do

- Read pages with clean typography
- Switch to **Edit** to change them, like a Google Doc
- Type \`/\` for blocks

### A checklist

- [x] Install Folio
- [ ] Sync a folder with the PC

| Phone | PC |
|---|---|
| Folio APK | Folio.exe |

\`\`\`js
console.log('hello from Folio');
\`\`\`

> Files on disk are the source of truth.
`,
  [`${NOTES}/Ideas/Game ranking app.md`]: `# Game ranking app

Friends score games before and after playing.

## Next
1. Shared lists
2. Steam import
`,
  [`${NOTES}/Ideas/Hometown game.md`]: '# Hometown game\n\nOpen world, set at home.\n',
  [`${NOTES}/Shopping.md`]: '# Shopping\n\n- [ ] Coffee\n- [ ] Notebook\n',
};

function now() { return Date.now(); }
function parent(p) { return p.slice(0, p.lastIndexOf('/')) || '/'; }
function name(p) { return p.slice(p.lastIndexOf('/') + 1); }
const MD = /\.(md|markdown|mdown|mkd|mdx)$/i;

export class FolioNativeWeb extends WebPlugin {
  constructor() {
    super();
    this.files = new Map();
    this.dirs = new Set([ROOT, DOCS, NOTES]);
    for (const [p, c] of Object.entries(SAMPLE)) this._put(p, c);
    this.settings = '{}';
    this.access = true;
  }
  _mkdirs(d) { while (d && d !== '/' && !this.dirs.has(d)) { this.dirs.add(d); d = parent(d); } }
  _put(p, content) { this._mkdirs(parent(p)); this.files.set(p, { content, mtime: now() }); }
  _exists(p) { return this.files.has(p) || this.dirs.has(p); }
  _unique(dir, base, ext) { let p = `${dir}/${base}${ext}`; let i = 2; while (this._exists(p)) { p = `${dir}/${base} ${i}${ext}`; i++; } return p; }
  _kids(d) {
    const out = new Set();
    for (const p of [...this.files.keys(), ...this.dirs]) if (parent(p) === d && p !== d) out.add(p);
    return [...out];
  }
  _build(d) {
    const kids = this._kids(d);
    const coll = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
    const dirs = kids.filter((k) => this.dirs.has(k)).sort((a, b) => coll.compare(name(a), name(b)));
    const files = kids.filter((k) => this.files.has(k) && MD.test(k)).sort((a, b) => coll.compare(name(a), name(b)));
    return [
      ...dirs.map((p) => ({ type: 'dir', name: name(p), path: p, children: this._build(p) })),
      ...files.map((p) => ({ type: 'file', name: name(p), path: p })),
    ];
  }

  async getInfo() { return { hasAccess: this.access, sdk: 34, storage: ROOT, documents: DOCS, version: 'web' }; }
  async requestAccess() { this.access = true; return { hasAccess: true }; }
  async getSettings() { return { json: this.settings }; }
  async setSettings({ json }) { this.settings = json; }
  async setBars() {}
  async pickFolder() { return { path: NOTES }; }
  async pickFile({ kind }) {
    if (kind === 'image') return {};
    return { path: `${NOTES}/Welcome.md` };
  }
  async resolveUri() { return { path: `${NOTES}/Welcome.md` }; }
  async tree({ path }) { return this.dirs.has(path) ? { tree: { type: 'dir', name: name(path), path, children: this._build(path) } } : {}; }
  async signature({ path }) { return { sig: JSON.stringify(this._build(path)).length + ':' + this.files.size + ':' + this.dirs.size }; }
  async read({ path }) {
    const f = this.files.get(path);
    if (!f) throw new Error('Not a file.');
    return { content: f.content, mtime: f.mtime, eol: f.content.includes('\r\n') ? '\r\n' : '\n' };
  }
  async write({ path, content }) { this._put(path, content); return { mtime: this.files.get(path).mtime }; }
  async writeBase64({ path }) { this._put(path, ''); return { mtime: now() }; }
  async copyUri({ path }) { this._put(path, ''); }
  async stat({ path }) {
    const f = this.files.get(path);
    return { exists: this._exists(path), isDir: this.dirs.has(path), mtime: f ? f.mtime : 0, size: f ? f.content.length : 0 };
  }
  async mkdirs({ path }) { this._mkdirs(path); }
  async uniquePath({ dir, base, ext }) { return { path: this._unique(dir, base, ext) }; }
  async newFile({ dir, base, content }) { const p = this._unique(dir, base || 'Untitled', '.md'); this._put(p, content || ''); return { path: p }; }
  async newFolder({ dir, base }) { const p = this._unique(dir, base || 'New folder', ''); this._mkdirs(p); return { path: p }; }
  async rename({ from, to }) {
    if (this._exists(to) && from.toLowerCase() !== to.toLowerCase()) throw new Error('A file with that name already exists.');
    for (const [p, f] of [...this.files]) if (p === from || p.startsWith(`${from}/`)) { this.files.delete(p); this.files.set(to + p.slice(from.length), f); }
    for (const d of [...this.dirs]) if (d === from || d.startsWith(`${from}/`)) { this.dirs.delete(d); this.dirs.add(to + d.slice(from.length)); }
    return { path: to };
  }
  async trash({ path }) {
    for (const p of [...this.files.keys()]) if (p === path || p.startsWith(`${path}/`)) this.files.delete(p);
    for (const d of [...this.dirs]) if (d === path || d.startsWith(`${path}/`)) this.dirs.delete(d);
    return { path: '' };
  }
  async openUrl({ url }) { window.open(url, '_blank', 'noopener'); }
  async openFile() {}
  async share() {}
  async print() { window.print(); }
}
