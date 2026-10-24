# Folio

A clean, calm Markdown reader and editor for Windows — styled like a document opened in Claude's side panel, edited like Notion or Google Docs.

## Install

1. Run `Folio-Setup-1.0.0.exe`.
2. Windows SmartScreen may say "Windows protected your PC" because the app isn't code-signed. Click **More info → Run anyway**.
3. Pick "Only for me" (no admin needed) and finish. Folio opens automatically.

To open `.md` files with a double-click: right-click any `.md` file → **Open with → Choose another app → Folio → Always**.

## How it works

**Two tabs at the top: Read and Edit.** Each has its own toolbar, so reading tools and editing tools never mix.

| Read tab | Edit tab |
|---|---|
| Clean rendered page (tables, code with Copy buttons, task lists, math, Mermaid diagrams, images) | Type and see formatting live — no `#` or `**` symbols |
| Outline of headings ("On this page") | Google Docs-style toolbar: text style, bold, italic, lists, checklists, quotes, code, tables, images, links |
| Sans / Serif font, text size, wide page | Type `/` for the block menu (Notion-style) |
| Find in page, copy as Markdown | Select text for a quick formatting bubble |
| Export to PDF / HTML, print | Click inside a table or code block for table tools / language picker |
| Tick checkboxes directly | **Markdown** view to edit the raw file |

**Sidebar:** open a folder and all its `.md` files appear. Filter by name, create pages and folders, right-click for rename / duplicate / delete (to Recycle Bin) / show in Explorer.

**Saving:** automatic (about a second after you stop typing) and on close. Folio only rewrites the parts of a file you actually edited — everything else stays byte-for-byte the same.

**Closing a page:** the **Close** button at the top right (or Ctrl W) saves the page and takes you back to the home screen. You can turn this off in **Settings → Page → Close button**.

**New pages** start as `Untitled.md`; type a title in the first heading and the file renames itself.

**Images:** paste or drag an image into the editor — it's saved to an `assets` folder next to the page.

## Keyboard shortcuts

| Action | Shortcut |
|---|---|
| Read / Edit tab | Ctrl 1 / Ctrl 2 (or Ctrl Shift E to switch) |
| Save now | Ctrl S |
| New page | Ctrl N |
| Close page (back to home) | Ctrl W |
| Open file / folder | Ctrl O / Ctrl Shift O |
| Quick open a page | Ctrl P |
| Find / Find & replace | Ctrl F / Ctrl H |
| Toggle sidebar | Ctrl \ |
| Text size | Ctrl + / Ctrl − / Ctrl 0 |
| Markdown view (in Edit) | Ctrl Shift M |
| Block menu | / |
| Link | Ctrl K |

## Build it yourself

Requires Node.js 20+.

```
npm install
npm start            # run the app in development
npm run dist:win     # build release/Folio-Setup-x.y.z.exe
```

See `CLAUDE.md` for the architecture and how to change things with Claude Code.
