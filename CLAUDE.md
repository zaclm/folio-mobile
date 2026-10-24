# Folio — guide for Claude Code

Folio is a Windows desktop Markdown reader/editor (Electron + Vite, plain JS, no framework).
Owner: Zac. Keep it clean, calm and Notion/Claude-like. Files on disk are the source of truth — no database, no cloud.

## Commands

- `npm install` — dependencies (everything is a devDependency; Vite bundles the renderer)
- `npm start` — build renderer + launch Electron
- `npm run dev` + `FOLIO_DEV=1 npx electron .` — live-reload renderer from Vite dev server
- `npm run dist:win` — Windows NSIS installer in `release/` (on Linux/macOS needs `wine` + 32-bit wine)

## Layout

```
electron/main.cjs      main process: window, file system IPC, watchers, folio:// protocol for local images, PDF export
electron/preload.cjs   window.folio API (contextIsolation, sandbox)
index.html             app shell (titlebar, sidebar, toolbars, content)
src/main.js            app state + wiring: open/save/rename/delete, Read/Edit switching, shortcuts, quick open, settings
src/reader.js          Read tab rendering (markdown-it), code copy buttons, images, links, outline, task toggling
src/markdown.js        markdown-it config for reading (katex, footnotes, anchors, highlight.js), front matter, HTML detection
src/editor.js          Tiptap editor, toolbar, slash menu, bubble menu, floating table/code context bar, link dialog
src/mdsync.js          LOSS-FREE SAVE: splits source into top-level blocks, writes untouched blocks back verbatim
src/sidebar.js         folder tree, filter, context menus, recents
src/find.js            find/replace using the CSS Custom Highlight API
src/util.js            icons (lucide), DOM helpers, Windows-safe path helpers, menus, modals, toast
src/styles/app.css     design tokens (light/dark), layout, components
src/styles/prose.css   shared document typography — Read and Edit MUST look identical
src/styles/code.css    syntax colors
build/                 icon.svg/png/ico, afterPack.cjs (sets exe icon + version via resedit, no rcedit/wine needed)
```

## Rules that matter

1. **Never rewrite what the user didn't edit.** Saving goes through `serializeSmart()` in `src/mdsync.js`. Unchanged blocks are copied from the original text. Opening a file and switching tabs must never change bytes on disk.
2. **Read and Edit share `prose.css`.** A change to typography goes there so both tabs stay pixel-aligned.
3. **Reading tools live in the Read toolbar, editing tools in the Edit toolbar.** Don't mix them.
4. Paths can be Windows (`C:\...`). Use the helpers in `util.js` (`dirname`, `resolveFrom`, `samePath`, `isInside`) — never split on `/` only.
5. Local images are served via `folio://local/<encoded absolute path>`; the editor keeps the original relative `src` in the markdown.
6. The app menu is removed (`Menu.setApplicationMenu(null)`) so Electron's hidden Ctrl+W/Ctrl+R don't close or reload the window. Shortcuts are handled in `initShortcuts()` in `src/main.js`; `closePage()` saves, then returns to the home screen (setting `closeButton`).
7. Every `fs.watch` watcher MUST have an `'error'` listener. On Windows a watched path that is renamed, deleted or briefly unavailable (OneDrive, USB) emits EPERM; without a listener that's an uncaught exception that crashes the app (bug fixed in 1.0.5). Call `releaseWatchesUnder()` before Folio renames/deletes a path.
8. No `prompt()`/`alert()` in Electron — use `promptDialog` / `confirmDialog` from `util.js`.
9. Keep the renderer sandboxed: new OS features go through an IPC handler in `main.cjs` + a method in `preload.cjs`.

## Security rules (keep these — see SECURITY-AUDIT.md)

Markdown files are **untrusted input** (people send them). Anything a document contains must not be able to run code, read other files, or reach the network beyond showing web images.

1. Never open a path from a document with `shell.openPath` directly — always go through the `shell:openPath` IPC handler, which blocks programs/scripts/shortcuts, asks before unknown types and refuses network (UNC) paths.
2. `folio://` serves image files only. Don't widen it to other types and never add `bypassCSP` back.
3. UNC paths (`\\server\share`, `//server/share`) are refused unless the share was opened by the user (`trustShareOf`). Windows sends the user's login hash to any SMB server it connects to. The `webRequest.onBeforeRequest` filter in `main.cjs` is the catch-all for this (it covers srcset, `<source>`, `<video poster>`, `style="url()"`, `<svg image>`, `<input type=image>`…) — never remove it or register a second `onBeforeRequest` listener on the default session (Electron keeps only one, so it would silently replace the filter).
4. Rendered markdown always goes through `DOMPurify.sanitize` in `markdown.js`. Never `innerHTML` a value that came from a document (build elements with DOM APIs instead).
5. Keep `contextIsolation`, `sandbox`, `nodeIntegration: false`, the CSP in `index.html` and the Electron fuses in `package.json` as they are. `grantFileProtocolExtraPrivileges` must stay on while the app loads from `file://`.
6. Writes go through `track()` in `main.cjs` so the app never quits mid-save.
7. Bump Electron to the latest patch release before every build (`npm i -D electron@44` for the newest 44.x, or move to the next major when it is stable).

## Installer and signing

- Installer branding lives in `build/installer/` (sidebar.bmp 164x314, header.bmp 150x57, made from the .svg files next to them with sharp + Pillow) and `build/installer.nsh` (welcome page, finish page, uninstaller welcome text). The license page is `build/license.txt`, also installed as `LICENSE.txt`.
- Signing uses `CSC_LINK` (path to the .pfx) and `CSC_KEY_PASSWORD`. See `signing/README-SIGNING.md`. Never commit a `.pfx`.
- Fuses are applied before signing (electron-builder does this). Don't add steps that edit `Folio.exe` after signing, or the signature breaks.
- Building on Linux with no internet timestamp server: also set `ELECTRON_BUILDER_OFFLINE=true` (signs without a timestamp).

## Testing

Security regression test: `npm run build:renderer` then run Electron with `FOLIO_TEST_SCRIPT=tests/security.test.cjs` (PowerShell: `$env:FOLIO_TEST_SCRIPT="tests/security.test.cjs"; npx electron .`). Every line must say PASS.


`window.__folio` is exposed for scripted tests (`openFile`, `setMode`, `roundTrip`, `getSmart`…).
`main.cjs` runs a test script if `FOLIO_TEST_SCRIPT=/path/test.cjs` is set (gets `(win, app)`), and uses
`FOLIO_USERDATA` as the settings folder. Round-trip test idea: for any .md file,
`__folio.roundTrip(text)` must return the body unchanged.

## Ideas backlog

- Tabs for several open pages
- Drag & drop to move files in the sidebar
- Backlinks / `[[wiki links]]`
- Version history (snapshots in `%APPDATA%/Folio/history`)
- Code-signing certificate so SmartScreen stops warning
- Auto-update via GitHub Releases (`electron-updater`)
