import { Editor, Extension, mergeAttributes } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import StarterKit from '@tiptap/starter-kit';
import { Placeholder } from '@tiptap/extensions';
import { TaskList, TaskItem } from '@tiptap/extension-list';
import { TableKit } from '@tiptap/extension-table';
import Image from '@tiptap/extension-image';
import Text from '@tiptap/extension-text';
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight';
import { BubbleMenu } from '@tiptap/extension-bubble-menu';
import { createLowlight, common } from 'lowlight';
import { Markdown } from 'tiptap-markdown';
import { $, $$, h, icon, escapeHtml, showMenu, promptDialog, resolveFrom, localUrl, isAbsolute, isWin, IS_MOBILE } from './util.js';
import { LANG_LABELS, normLang } from './markdown.js';

const lowlight = createLowlight(common);
const MOD = isWin ? 'Ctrl' : 'Ctrl';

// ---------- image node that shows local files but keeps the relative path ----------
function makeImage(getFilePath) {
  return Image.extend({
    addAttributes() {
      return {
        ...this.parent?.(),
        src: {
          default: null,
          parseHTML: (el) => el.getAttribute('data-src') || el.getAttribute('src'),
        },
      };
    },
    renderHTML({ HTMLAttributes }) {
      const raw = HTMLAttributes.src || '';
      let display = raw;
      const fp = getFilePath();
      if (fp && raw && !/^(https?:|data:|blob:|folio:)/i.test(raw)) {
        let p = raw;
        try { p = decodeURI(raw); } catch { /* keep */ }
        display = localUrl(isAbsolute(p) ? p : resolveFrom(fp, p));
      }
      return ['img', mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, { src: display, 'data-src': raw })];
    },
    addStorage() {
      return {
        markdown: {
          // block image: write it on its own line
          serialize(state, node) {
            const src = String(node.attrs.src || '').replace(/[()\s]/g, (c) => (c === ' ' ? '%20' : `\\${c}`));
            const title = node.attrs.title ? ` "${node.attrs.title.replace(/"/g, '\\"')}"` : '';
            state.write(`![${state.esc(node.attrs.alt || '')}](${src}${title})`);
            state.closeBlock(node);
          },
          parse: {},
        },
      };
    },
  }).configure({ inline: false, allowBase64: true });
}

// Text: keep math ($…$) and footnote refs ([^1]) exactly as typed, escape the rest
const RAW_SPANS = /\$\$[^$]+\$\$|\$(?=\S)(?:\\\$|[^$\n])+?(?<=\S)\$|\[\^[^\]\s]+\](?::)?/g;
const SafeText = Text.extend({
  addStorage() {
    return {
      markdown: {
        serialize(state, node) {
          const text = node.text || '';
          let last = 0;
          for (const m of text.matchAll(RAW_SPANS)) {
            if (m.index > last) state.text(text.slice(last, m.index).replace(/</g, '&lt;').replace(/>/g, '&gt;'));
            state.text(m[0], false);
            last = m.index + m[0].length;
          }
          if (last < text.length) state.text(text.slice(last).replace(/</g, '&lt;').replace(/>/g, '&gt;'));
        },
        parse: {},
      },
    };
  },
});

// task lists keep the same tight/loose spacing as the original markdown
const TightTaskLists = Extension.create({
  name: 'folioTightTaskLists',
  addGlobalAttributes() {
    return [{
      types: ['taskList'],
      attributes: {
        tight: {
          default: true,
          parseHTML: (el) => el.getAttribute('data-tight') === 'true' || !el.querySelector('p'),
          renderHTML: (attrs) => ({ 'data-tight': attrs.tight ? 'true' : null }),
        },
      },
    }];
  },
});
// ---------- slash command menu ----------
export const SLASH_ITEMS = [
  { id: 'text', title: 'Text', desc: 'Plain paragraph', icon: 'Pilcrow', keys: 'paragraph p normal', run: (e) => e.chain().focus().setParagraph().run() },
  { id: 'h1', title: 'Heading 1', desc: 'Big section title', icon: 'Heading1', keys: 'h1 title', run: (e) => e.chain().focus().setHeading({ level: 1 }).run() },
  { id: 'h2', title: 'Heading 2', desc: 'Medium section title', icon: 'Heading2', keys: 'h2 subtitle', run: (e) => e.chain().focus().setHeading({ level: 2 }).run() },
  { id: 'h3', title: 'Heading 3', desc: 'Small section title', icon: 'Heading3', keys: 'h3', run: (e) => e.chain().focus().setHeading({ level: 3 }).run() },
  { id: 'bullet', title: 'Bulleted list', desc: 'Simple list with bullets', icon: 'List', keys: 'ul unordered bullets', run: (e) => e.chain().focus().toggleBulletList().run() },
  { id: 'number', title: 'Numbered list', desc: 'List with numbers', icon: 'ListOrdered', keys: 'ol ordered numbers', run: (e) => e.chain().focus().toggleOrderedList().run() },
  { id: 'todo', title: 'To-do list', desc: 'Track tasks with checkboxes', icon: 'ListTodo', keys: 'task checkbox check', run: (e) => e.chain().focus().toggleTaskList().run() },
  { id: 'quote', title: 'Quote', desc: 'Highlight a quotation', icon: 'Quote', keys: 'blockquote citation', run: (e) => e.chain().focus().toggleBlockquote().run() },
  { id: 'code', title: 'Code block', desc: 'Code with syntax colors', icon: 'SquareCode', keys: 'pre snippet', run: (e) => e.chain().focus().toggleCodeBlock().run() },
  { id: 'divider', title: 'Divider', desc: 'Horizontal line', icon: 'Minus', keys: 'hr line separator rule', run: (e) => e.chain().focus().setHorizontalRule().run() },
  { id: 'table', title: 'Table', desc: '3 × 3 table', icon: 'Table', keys: 'grid', run: (e) => e.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() },
  { id: 'image', title: 'Image', desc: 'Upload from your computer', icon: 'Image', keys: 'picture photo', run: null },
  { id: 'link', title: 'Link', desc: 'Add a web link', icon: 'Link', keys: 'url href', run: null },
];

function slashExtension(ui) {
  const key = new PluginKey('folio-slash');
  return Extension.create({
    name: 'folioSlash',
    addProseMirrorPlugins() {
      const editor = this.editor;
      return [new Plugin({
        key,
        view: () => ({
          update: (view) => ui.update(editor, view),
          destroy: () => ui.hide(),
        }),
        props: {
          handleKeyDown: (_view, event) => ui.handleKey(editor, event),
        },
      })];
    },
  });
}

function createSlashUI(actions) {
  const el = h('<div class="slash-menu" role="listbox"></div>');
  document.body.appendChild(el);
  let state = { active: false, from: 0, to: 0, query: '', items: [], index: 0 };
  let dismissedAt = -1;

  function filter(q) {
    const s = q.toLowerCase();
    if (!s) return SLASH_ITEMS;
    return SLASH_ITEMS.filter((it) => it.title.toLowerCase().includes(s) || it.keys.includes(s) || it.id.startsWith(s));
  }
  function render() {
    if (!state.items.length) {
      el.innerHTML = '<div class="slash-empty">No results</div>';
      return;
    }
    el.innerHTML = '<div class="slash-head">Basic blocks</div>' + state.items.map((it, i) =>
      `<button class="slash-item ${i === state.index ? 'active' : ''}" data-i="${i}">
        <span class="slash-ic">${icon(it.icon, 18, 1.6)}</span>
        <span class="slash-txt"><span class="slash-title">${escapeHtml(it.title)}</span><span class="slash-desc">${escapeHtml(it.desc)}</span></span>
      </button>`).join('');
    $$('.slash-item', el).forEach((b) => {
      b.addEventListener('mousedown', (e) => { e.preventDefault(); choose(Number(b.dataset.i)); });
      b.addEventListener('mousemove', () => {
        const i = Number(b.dataset.i);
        if (i !== state.index) { state.index = i; $$('.slash-item', el).forEach((x, j) => x.classList.toggle('active', j === i)); }
      });
    });
    const act = $('.slash-item.active', el);
    if (act) act.scrollIntoView({ block: 'nearest' });
  }
  let editorRef = null;
  function choose(i) {
    const it = state.items[i];
    if (!it || !editorRef) return;
    const ed = editorRef;
    ed.chain().focus().deleteRange({ from: state.from, to: state.to }).run();
    hide();
    if (it.run) it.run(ed);
    else if (it.id === 'image') actions.insertImage();
    else if (it.id === 'link') actions.editLink();
  }
  function hide() {
    state.active = false;
    el.classList.remove('show');
  }
  function update(editor, view) {
    editorRef = editor;
    const { selection } = view.state;
    const $from = selection.$from;
    if (!selection.empty || !$from.parent.isTextblock || $from.parent.type.name === 'codeBlock' || !editor.isEditable) { hide(); return; }
    const before = $from.parent.textBetween(Math.max(0, $from.parentOffset - 40), $from.parentOffset, null, '￼');
    const m = before.match(/(?:^|\s)\/([\p{L}\p{N}-]{0,20})$/u);
    if (!m) { hide(); dismissedAt = -1; return; }
    const from = $from.pos - m[1].length - 1;
    if (from === dismissedAt) { hide(); return; }
    const query = m[1];
    const items = filter(query);
    if (!items.length && query.length > 3) { hide(); return; }
    const changed = query !== state.query || !state.active;
    state = { active: true, from, to: $from.pos, query, items, index: changed ? 0 : Math.min(state.index, items.length - 1) };
    render();
    const c = view.coordsAtPos(from);
    el.classList.add('show');
    const r = el.getBoundingClientRect();
    let top = c.bottom + 6;
    if (top + r.height > window.innerHeight - 10) top = c.top - r.height - 6;
    el.style.left = `${Math.min(c.left, window.innerWidth - r.width - 10)}px`;
    el.style.top = `${Math.max(10, top)}px`;
  }
  function handleKey(editor, e) {
    if (!state.active) return false;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!state.items.length) return false;
      state.index = (state.index + (e.key === 'ArrowDown' ? 1 : -1) + state.items.length) % state.items.length;
      render();
      return true;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      if (!state.items.length) { hide(); return false; }
      choose(state.index);
      return true;
    }
    if (e.key === 'Escape') {
      dismissedAt = state.from;
      hide();
      return true;
    }
    return false;
  }
  return { update, handleKey, hide, el };
}

// ---------- editor factory ----------
export function createEditor({ element, getFilePath, onUpdate, onSelection, actions, bubbleEl }) {
  const slashUI = createSlashUI(actions);

  const editor = new Editor({
    element,
    extensions: [
      StarterKit.configure({
        codeBlock: false,
        text: false,
        underline: false,
        link: { openOnClick: false, autolink: true, linkOnPaste: true, HTMLAttributes: { rel: null, target: null } },
        heading: { levels: [1, 2, 3, 4, 5, 6] },
        undoRedo: { depth: 300 },
        dropcursor: { width: 2, class: 'drop-cursor' },
      }),
      SafeText,
      CodeBlockLowlight.configure({ lowlight, defaultLanguage: null, HTMLAttributes: { class: 'hljs' } }),
      TaskList,
      TaskItem.configure({ nested: true }),
      TightTaskLists,
      TableKit.configure({ table: { resizable: false } }),
      makeImage(getFilePath),
      Placeholder.configure({
        includeChildren: false,
        showOnlyCurrent: true,
        placeholder: ({ node, pos, editor: ed }) => {
          if (node.type.name === 'heading') return pos === 0 ? 'Untitled' : `Heading ${node.attrs.level}`;
          if (ed.isEmpty) return "Start writing, or press '/' for blocks…";
          return "Press '/' for blocks";
        },
      }),
      Markdown.configure({
        html: true,
        tightLists: true,
        tightListClass: 'tight',
        bulletListMarker: '-',
        linkify: false,
        breaks: false,
        transformPastedText: true,
        transformCopiedText: false,
      }),
      slashExtension(slashUI),
      BubbleMenu.configure({
        element: bubbleEl,
        pluginKey: 'folioBubble',
        appendTo: () => document.body,
        updateDelay: 120,
        // on phones Android's own copy/paste bar sits above the selection, so Folio's goes below it
        options: IS_MOBILE
          ? { strategy: 'fixed', placement: 'bottom', offset: 34, flip: true, shift: { padding: 8 } }
          : { strategy: 'fixed', placement: 'top', offset: 8, flip: true, shift: { padding: 8 } },
        shouldShow: ({ editor: ed, state, from, to }) => {
          if (!ed.isEditable || from === to) return false;
          if (ed.isActive('codeBlock') || ed.isActive('image')) return false;
          const { selection } = state;
          if (selection.node) return false;
          if (selection.constructor?.name === 'CellSelection') return false;
          return !!state.doc.textBetween(from, to).trim();
        },
      }),
    ],
    editorProps: {
      attributes: { class: 'prose ProseMirror-folio', spellcheck: 'true' },
      handlePaste: (view, event) => {
        const files = [...(event.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
        if (!files.length) return false;
        event.preventDefault();
        files.forEach((f) => actions.saveAndInsertImageFile(f));
        return true;
      },
      handleDrop: (view, event, _slice, moved) => {
        if (moved) return false;
        const files = [...(event.dataTransfer?.files || [])];
        const imgs = files.filter((f) => f.type.startsWith('image/'));
        if (!imgs.length) return false;
        event.preventDefault();
        const pos = view.posAtCoords({ left: event.clientX, top: event.clientY });
        if (pos) editor.commands.setTextSelection(pos.pos);
        imgs.forEach((f) => actions.saveAndInsertImageFile(f));
        return true;
      },
      handleClickOn: (view, pos, node, nodePos, event) => {
        // Ctrl+click opens links while editing
        if ((event.ctrlKey || event.metaKey) && event.target.closest('a')) {
          actions.openLink(event.target.closest('a').getAttribute('href'));
          return true;
        }
        return false;
      },
    },
    onUpdate: ({ transaction }) => { if (transaction.docChanged) onUpdate(); },
    onSelectionUpdate: () => onSelection(),
    onTransaction: () => onSelection(),
  });

  return { editor, slashUI };
}

export function getMarkdown(editor) {
  return editor.storage.markdown.getMarkdown();
}

// ---------- toolbar ----------
export const BLOCK_STYLES = [
  { id: 'p', label: 'Normal text', cls: 'st-p', run: (e) => e.chain().focus().setParagraph().run(), active: (e) => e.isActive('paragraph') },
  { id: 'h1', label: 'Heading 1', cls: 'st-h1', run: (e) => e.chain().focus().setHeading({ level: 1 }).run(), active: (e) => e.isActive('heading', { level: 1 }) },
  { id: 'h2', label: 'Heading 2', cls: 'st-h2', run: (e) => e.chain().focus().setHeading({ level: 2 }).run(), active: (e) => e.isActive('heading', { level: 2 }) },
  { id: 'h3', label: 'Heading 3', cls: 'st-h3', run: (e) => e.chain().focus().setHeading({ level: 3 }).run(), active: (e) => e.isActive('heading', { level: 3 }) },
  { id: 'h4', label: 'Heading 4', cls: 'st-h4', run: (e) => e.chain().focus().setHeading({ level: 4 }).run(), active: (e) => e.isActive('heading', { level: 4 }) },
  { id: 'code', label: 'Code block', cls: 'st-code', run: (e) => e.chain().focus().toggleCodeBlock().run(), active: (e) => e.isActive('codeBlock') },
];

const CODE_LANGS = ['plaintext', 'javascript', 'typescript', 'python', 'bash', 'powershell', 'json', 'yaml', 'xml', 'css', 'sql', 'java', 'csharp', 'cpp', 'c', 'go', 'rust', 'php', 'ruby', 'kotlin', 'swift', 'markdown', 'diff', 'mermaid'];

export function buildEditToolbar(root, getEditor, actions) {
  const btn = (id, ic, title, kbd = '') =>
    `<button class="tb-btn" data-id="${id}" data-tip="${escapeHtml(title)}${kbd ? ` (${kbd})` : ''}" aria-label="${escapeHtml(title)}">${icon(ic, 17)}</button>`;
  root.innerHTML = `
    <div class="tb-group">
      ${btn('undo', 'Undo2', 'Undo', `${MOD}+Z`)}
      ${btn('redo', 'Redo2', 'Redo', `${MOD}+Y`)}
    </div>
    <div class="tb-sep"></div>
    <div class="tb-group">
      <button class="tb-select" data-id="style" data-tip="Text style"><span class="tb-select-label">Normal text</span>${icon('ChevronDown', 14)}</button>
    </div>
    <div class="tb-sep"></div>
    <div class="tb-group">
      ${btn('bold', 'Bold', 'Bold', `${MOD}+B`)}
      ${btn('italic', 'Italic', 'Italic', `${MOD}+I`)}
      ${btn('strike', 'Strikethrough', 'Strikethrough', `${MOD}+Shift+S`)}
      ${btn('code', 'Code', 'Inline code', `${MOD}+E`)}
      ${btn('link', 'Link', 'Link', `${MOD}+K`)}
    </div>
    <div class="tb-sep"></div>
    <div class="tb-group">
      ${btn('bullet', 'List', 'Bulleted list', `${MOD}+Shift+8`)}
      ${btn('number', 'ListOrdered', 'Numbered list', `${MOD}+Shift+7`)}
      ${btn('todo', 'ListTodo', 'To-do list', `${MOD}+Shift+9`)}
      ${btn('outdent', 'IndentDecrease', 'Decrease indent', 'Shift+Tab')}
      ${btn('indent', 'IndentIncrease', 'Increase indent', 'Tab')}
    </div>
    <div class="tb-sep"></div>
    <div class="tb-group">
      ${btn('quote', 'Quote', 'Quote', `${MOD}+Shift+B`)}
      ${btn('codeblock', 'SquareCode', 'Code block', `${MOD}+Alt+C`)}
      ${btn('hr', 'Minus', 'Divider')}
      ${btn('image', 'Image', 'Insert image')}
      ${btn('table', 'Table', 'Insert table')}
    </div>
    <div class="tb-sep"></div>
    <div class="tb-group">
      ${btn('clear', 'RemoveFormatting', 'Clear formatting')}
    </div>
  `;

  const run = {
    undo: (e) => e.chain().focus().undo().run(),
    redo: (e) => e.chain().focus().redo().run(),
    bold: (e) => e.chain().focus().toggleBold().run(),
    italic: (e) => e.chain().focus().toggleItalic().run(),
    strike: (e) => e.chain().focus().toggleStrike().run(),
    code: (e) => e.chain().focus().toggleCode().run(),
    link: () => actions.editLink(),
    bullet: (e) => e.chain().focus().toggleBulletList().run(),
    number: (e) => e.chain().focus().toggleOrderedList().run(),
    todo: (e) => e.chain().focus().toggleTaskList().run(),
    indent: (e) => {
      const ok = e.chain().focus().sinkListItem('listItem').run() || e.chain().focus().sinkListItem('taskItem').run();
      if (!ok) e.chain().focus().run();
    },
    outdent: (e) => e.chain().focus().liftListItem('listItem').run() || e.chain().focus().liftListItem('taskItem').run(),
    quote: (e) => e.chain().focus().toggleBlockquote().run(),
    codeblock: (e) => e.chain().focus().toggleCodeBlock().run(),
    hr: (e) => e.chain().focus().setHorizontalRule().run(),
    image: () => actions.insertImage(),
    table: (e) => e.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
    clear: (e) => e.chain().focus().unsetAllMarks().clearNodes().run(),
    rowAbove: (e) => e.chain().focus().addRowBefore().run(),
    rowBelow: (e) => e.chain().focus().addRowAfter().run(),
    colLeft: (e) => e.chain().focus().addColumnBefore().run(),
    colRight: (e) => e.chain().focus().addColumnAfter().run(),
    delRow: (e) => e.chain().focus().deleteRow().run(),
    delCol: (e) => e.chain().focus().deleteColumn().run(),
    delTable: (e) => e.chain().focus().deleteTable().run(),
  };

  root.addEventListener('mousedown', (ev) => {
    // keep editor selection when clicking toolbar buttons
    if (ev.target.closest('.tb-btn, .tb-select')) ev.preventDefault();
  });
  root.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-id]');
    if (!b || b.disabled) return;
    const e = getEditor();
    if (!e) return;
    const id = b.dataset.id;
    if (id === 'style') {
      showMenu(BLOCK_STYLES.map((s) => ({
        label: s.label, checked: s.active(e), action: () => s.run(e),
      })), { anchor: b, minWidth: 190, className: 'style-menu' });
      return;
    }
    run[id]?.(e);
  });
}

export function updateEditToolbar(root, e) {
  if (!e) return;
  const act = {
    bold: e.isActive('bold'), italic: e.isActive('italic'), strike: e.isActive('strike'), code: e.isActive('code'),
    link: e.isActive('link'), bullet: e.isActive('bulletList'), number: e.isActive('orderedList'), todo: e.isActive('taskList'),
    quote: e.isActive('blockquote'), codeblock: e.isActive('codeBlock'),
  };
  $$('.tb-btn', root).forEach((b) => {
    const id = b.dataset.id;
    b.classList.toggle('active', !!act[id]);
  });
  const undo = $('[data-id=undo]', root);
  const redo = $('[data-id=redo]', root);
  if (undo) undo.disabled = !e.can().undo();
  if (redo) redo.disabled = !e.can().redo();
  const inList = e.isActive('listItem') || e.isActive('taskItem');
  $('[data-id=indent]', root).disabled = !inList;
  $('[data-id=outdent]', root).disabled = !inList;
  const style = BLOCK_STYLES.find((s) => s.active(e));
  $('[data-id=style] .tb-select-label', root).textContent = style ? style.label : (e.isActive('heading') ? `Heading ${e.getAttributes('heading').level}` : 'Normal text');
}

// ---------- floating context bar (tables + code blocks) ----------
export function createContextBar(getEditor) {
  const bar = h('<div class="ctxbar" role="toolbar"></div>');
  document.body.appendChild(bar);
  const b = (id, ic, tip) => `<button class="tb-btn sm" data-c="${id}" data-tip="${escapeHtml(tip)}">${icon(ic, 16)}</button>`;
  const tableHtml = `<span class="ctx-label">${icon('Table', 14)} Table</span><div class="tb-sep"></div>
    ${b('rowAbove', 'BetweenHorizontalStart', 'Insert row above')}${b('rowBelow', 'BetweenHorizontalEnd', 'Insert row below')}
    <div class="tb-sep"></div>
    ${b('colLeft', 'BetweenVerticalStart', 'Insert column left')}${b('colRight', 'BetweenVerticalEnd', 'Insert column right')}
    <div class="tb-sep"></div>
    ${b('delRow', 'Rows2', 'Delete row')}${b('delCol', 'Columns2', 'Delete column')}${b('delTable', 'Trash2', 'Delete table')}`;
  let kind = null;
  let anchorDom = null;
  const run = {
    rowAbove: (e) => e.chain().focus().addRowBefore().run(),
    rowBelow: (e) => e.chain().focus().addRowAfter().run(),
    colLeft: (e) => e.chain().focus().addColumnBefore().run(),
    colRight: (e) => e.chain().focus().addColumnAfter().run(),
    delRow: (e) => e.chain().focus().deleteRow().run(),
    delCol: (e) => e.chain().focus().deleteColumn().run(),
    delTable: (e) => e.chain().focus().deleteTable().run(),
  };
  bar.addEventListener('mousedown', (ev) => ev.preventDefault());
  bar.addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-c]');
    const e = getEditor();
    if (!btn || !e) return;
    const id = btn.dataset.c;
    if (id === 'lang') {
      const cur = normLang(e.getAttributes('codeBlock').language || 'plaintext');
      showMenu(CODE_LANGS.map((l) => ({
        label: LANG_LABELS[l] || l, checked: cur === l,
        action: () => e.chain().focus().updateAttributes('codeBlock', { language: l === 'plaintext' ? null : l }).run(),
      })), { anchor: btn, align: 'right', minWidth: 170, className: 'lang-menu' });
      return;
    }
    run[id]?.(e);
  });

  function findDom(e, typeName) {
    const { $from } = e.state.selection;
    for (let d = $from.depth; d > 0; d--) {
      if ($from.node(d).type.name === typeName) {
        const dom = e.view.nodeDOM($from.before(d));
        return dom && dom.nodeType === 1 ? dom : null;
      }
    }
    return null;
  }
  function position() {
    if (!kind || !anchorDom || !anchorDom.isConnected) { bar.classList.remove('show'); return; }
    const r = anchorDom.getBoundingClientRect();
    const scroller = anchorDom.closest('.content') || document.body;
    const sr = scroller.getBoundingClientRect();
    const br = bar.getBoundingClientRect();
    let top = r.top - br.height - 8;
    const visible = r.bottom > sr.top + 20 && r.top < sr.bottom - 20;
    if (!visible) { bar.classList.add('offscreen'); return; }
    bar.classList.remove('offscreen');
    top = Math.max(sr.top + 6, top);
    const left = kind === 'code' ? r.right - br.width - 8 : r.left;
    bar.style.top = `${top}px`;
    bar.style.left = `${Math.max(sr.left + 6, left)}px`;
  }
  function update() {
    const e = getEditor();
    const interacting = bar.matches(':hover') || !!document.querySelector('.menu');
    if (!e || !e.isEditable || !e.view.dom.isConnected || e.view.dom.offsetParent === null || (!e.isFocused && !interacting)) {
      kind = null; bar.classList.remove('show'); return;
    }
    let next = null;
    if (e.isActive('table')) { next = 'table'; anchorDom = findDom(e, 'table'); }
    else if (e.isActive('codeBlock')) { next = 'code'; anchorDom = findDom(e, 'codeBlock'); }
    if (!next || !anchorDom) { kind = null; bar.classList.remove('show'); return; }
    if (next !== kind) {
      bar.innerHTML = next === 'table' ? tableHtml
        : `<button class="tb-select sm" data-c="lang" data-tip="Code language"><span class="tb-select-label"></span>${icon('ChevronDown', 13)}</button>`;
      bar.className = `ctxbar show ctx-${next}`;
    }
    kind = next;
    if (kind === 'code') {
      const l = normLang(e.getAttributes('codeBlock').language || 'plaintext');
      bar.querySelector('.tb-select-label').textContent = LANG_LABELS[l] || l;
    }
    bar.classList.add('show');
    position();
  }
  return { update, position, hide: () => { kind = null; bar.classList.remove('show'); } };
}

// ---------- bubble menu ----------
export function buildBubble(el, getEditor, actions) {
  const b = (id, ic, title) => `<button class="bb-btn" data-id="${id}" title="${escapeHtml(title)}">${icon(ic, 16)}</button>`;
  el.innerHTML = `
    <button class="bb-btn bb-style" data-id="turn" title="Turn into">${'<span>Text</span>'}${icon('ChevronDown', 13)}</button>
    <div class="bb-sep"></div>
    ${b('bold', 'Bold', 'Bold')}${b('italic', 'Italic', 'Italic')}${b('strike', 'Strikethrough', 'Strikethrough')}${b('code', 'Code', 'Inline code')}
    <div class="bb-sep"></div>
    ${b('link', 'Link', 'Link')}
  `;
  el.addEventListener('mousedown', (ev) => ev.preventDefault());
  el.addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-id]');
    const e = getEditor();
    if (!btn || !e) return;
    const id = btn.dataset.id;
    if (id === 'turn') {
      showMenu([
        ...BLOCK_STYLES.filter((s) => s.id !== 'code').map((s) => ({ label: s.label, checked: s.active(e), action: () => s.run(e) })),
        'sep',
        { label: 'Bulleted list', icon: 'List', checked: e.isActive('bulletList'), action: () => e.chain().focus().toggleBulletList().run() },
        { label: 'Numbered list', icon: 'ListOrdered', checked: e.isActive('orderedList'), action: () => e.chain().focus().toggleOrderedList().run() },
        { label: 'To-do list', icon: 'ListTodo', checked: e.isActive('taskList'), action: () => e.chain().focus().toggleTaskList().run() },
        { label: 'Quote', icon: 'Quote', checked: e.isActive('blockquote'), action: () => e.chain().focus().toggleBlockquote().run() },
      ], { anchor: btn, minWidth: 180 });
      return;
    }
    if (id === 'bold') e.chain().focus().toggleBold().run();
    if (id === 'italic') e.chain().focus().toggleItalic().run();
    if (id === 'strike') e.chain().focus().toggleStrike().run();
    if (id === 'code') e.chain().focus().toggleCode().run();
    if (id === 'link') actions.editLink();
  });
}

export function updateBubble(el, e) {
  if (!e || !el.isConnected) return;
  for (const id of ['bold', 'italic', 'strike', 'code', 'link']) {
    const b = el.querySelector(`[data-id=${id}]`);
    if (b) b.classList.toggle('active', e.isActive(id));
  }
  const style = BLOCK_STYLES.find((s) => s.active(e));
  const span = el.querySelector('.bb-style span');
  if (span) span.textContent = style ? (style.id === 'p' ? 'Text' : style.label) : 'Text';
}

// ---------- link editing ----------
export async function editLinkFlow(e) {
  const prev = e.getAttributes('link').href || '';
  const { empty } = e.state.selection;
  const url = await promptDialog({
    title: prev ? 'Edit link' : 'Add link',
    label: 'Link address',
    value: prev,
    placeholder: 'https://example.com or other-note.md',
    okLabel: prev ? 'Update' : 'Add link',
    extra: prev ? '<div class="modal-hint">Leave empty and press Update to remove the link.</div>' : '',
  });
  if (url === null) { e.commands.focus(); return; }
  if (!url) { e.chain().focus().extendMarkRange('link').unsetLink().run(); return; }
  const href = /^(https?:|mailto:|#|\.{0,2}\/|[\w\-. %]+\.(md|markdown)(#.*)?$)/i.test(url) ? url : (/^[\w-]+(\.[\w-]+)+/.test(url) ? `https://${url}` : url);
  if (empty && !prev) {
    e.chain().focus()
      .insertContent({ type: 'text', text: url, marks: [{ type: 'link', attrs: { href } }] })
      .unsetMark('link')
      .insertContent({ type: 'text', text: ' ' })
      .run();
  } else {
    e.chain().focus().extendMarkRange('link').setLink({ href }).run();
  }
}
