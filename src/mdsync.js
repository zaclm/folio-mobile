/**
 * Loss-free markdown <-> editor sync.
 *
 * The visual editor can't remember every formatting detail of the original file
 * (table dash style, escapes, math, HTML, spacing…). To never rewrite parts of a
 * file the user didn't touch, the source is split into top-level blocks ("chunks").
 * Each chunk is parsed separately, so we know exactly which editor nodes came from
 * which lines. On save, unchanged chunks are written back byte-for-byte and only
 * edited blocks are re-serialized.
 */
import MarkdownIt from 'markdown-it';
import { createDocument } from '@tiptap/core';

const blockMd = new MarkdownIt({ html: true });
const joinGap = (a, gap, b) => `${a}\n${gap.map((l) => `${l}\n`).join('')}${b}`;
const REF_DEF = /^ {0,3}\[(?!\^)[^\]]+\]:\s*\S/;

export function patchParser(editor) {
  const md = editor.storage.markdown.parser.md;
  if (md.__folioPatched) return;
  const used = new Set();
  const orig = md.use.bind(md);
  md.use = (plugin, ...args) => {
    if (used.has(plugin)) return md;
    used.add(plugin);
    return orig(plugin, ...args);
  };
  // tiptap-markdown strips a newline that follows an inline element, which glues
  // words together ("**bold**\nnext" -> "boldnext"). Render soft breaks as spaces.
  md.renderer.rules.softbreak = () => ' ';
  md.__folioPatched = true;
}

function splitChunks(body) {
  const lines = body.split('\n');
  const tokens = blockMd.parse(body, {});
  const ranges = [];
  for (const t of tokens) {
    if (t.level !== 0 || t.nesting === -1 || !t.map) continue;
    ranges.push([t.map[0], t.map[1]]);
  }
  // reference definitions are not tokens; collect them so every chunk can resolve links
  const refDefs = lines.filter((l) => REF_DEF.test(l)).join('\n');

  const chunks = [];
  let cursor = 0;
  let pendingPrefix = null; // non-blank gap lines that belong to the next chunk
  for (const [a, b] of ranges) {
    if (a < cursor) continue;
    const gap = lines.slice(cursor, a);
    let start = a;
    if (gap.some((l) => l.trim())) {
      // invisible content (comments, ref defs) → glue to this chunk
      const firstNonBlank = gap.findIndex((l) => l.trim());
      start = cursor + firstNonBlank;
    }
    chunks.push({ start, end: b, gap: lines.slice(cursor, start) });
    cursor = b;
  }
  const tail = lines.slice(cursor);
  if (chunks.length && tail.some((l) => l.trim())) {
    // trailing invisible content → glue to last chunk
    let lastNonBlank = tail.length - 1;
    while (lastNonBlank >= 0 && !tail[lastNonBlank].trim()) lastNonBlank--;
    chunks[chunks.length - 1].end = cursor + lastNonBlank + 1;
  } else if (!chunks.length && tail.some((l) => l.trim())) {
    chunks.push({ start: 0, end: lines.length, gap: [] });
  }
  for (const c of chunks) c.src = lines.slice(c.start, c.end).join('\n');
  return { chunks, refDefs, lines };
}

function parseToNodes(editor, text) {
  const html = editor.storage.markdown.parser.parse(text);
  if (!html || !html.trim()) return [];
  const doc = createDocument(html, editor.schema, { preserveWhitespace: false });
  const out = [];
  doc.forEach((n) => out.push(n));
  // an "empty" chunk (e.g. an HTML comment) parses to one empty paragraph
  if (out.length === 1 && out[0].type.name === 'paragraph' && out[0].childCount === 0) return [];
  return out;
}

/** Load markdown body into the editor and return the base used for smart saving. */
export function loadMarkdown(editor, body) {
  patchParser(editor);
  const { chunks, refDefs } = splitChunks(body);
  const all = [];
  const owner = [];
  // merge chunks that produce no nodes into the following chunk
  const merged = [];
  let carry = null;
  for (const c of chunks) {
    const parseText = refDefs && !REF_DEF.test(c.src) ? `${c.src}\n\n${refDefs}` : c.src;
    const nodes = parseToNodes(editor, parseText);
    if (!nodes.length) {
      if (carry) { carry.src = joinGap(carry.src, c.gap, c.src); carry.end = c.end; }
      else carry = { ...c };
      continue;
    }
    if (carry) {
      c.src = joinGap(carry.src, c.gap, c.src);
      c.gap = carry.gap;
      c.start = carry.start;
      carry = null;
    }
    c.nodes = nodes;
    merged.push(c);
  }
  if (carry) {
    if (merged.length) {
      const last = merged[merged.length - 1];
      last.src = joinGap(last.src, carry.gap, carry.src);
      last.end = carry.end;
    } else {
      // whole document is invisible to the editor (e.g. only a comment)
      merged.push({ ...carry, nodes: [] });
    }
  }
  merged.forEach((c, j) => c.nodes.forEach((n) => { all.push(n); owner.push(j); }));

  if (!all.length) {
    editor.commands.setContent({ type: 'doc', content: [{ type: 'heading', attrs: { level: 1 } }] }, { emitUpdate: false });
  } else {
    const doc = editor.schema.topNodeType.create(null, all);
    editor.commands.setContent(doc.toJSON(), { emitUpdate: false });
  }
  // keep the actual node objects now in the editor (structural sharing makes eq() cheap)
  const live = [];
  editor.state.doc.forEach((n) => live.push(n));
  const ok = live.length === all.length;
  return {
    chunks: merged,
    nodes: ok ? live : all,
    owner,
    lead: '',
    hiddenOnly: !all.length && merged.length ? merged.map((c) => c.src).join('\n\n') : '',
  };
}

function serializeNodes(editor, nodes) {
  nodes = nodes.filter((nd) => !(nd.type.name === 'heading' && nd.childCount === 0));
  if (!nodes.length) return '';
  const doc = editor.schema.topNodeType.create(null, nodes);
  return editor.storage.markdown.serializer.serialize(doc).replace(/\s+$/, '');
}

function lcs(a, b, eq) {
  const n = a.length; const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = eq(a[i], b[j]) ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const pairs = [];
  let i = 0; let j = 0;
  while (i < n && j < m) {
    if (eq(a[i], b[j])) { pairs.push([i, j]); i++; j++; } else if (dp[i + 1][j] >= dp[i][j + 1]) i++; else j++;
  }
  return pairs;
}

/** Serialize the editor, reusing original text for every block that wasn't edited. */
export function serializeSmart(editor, base) {
  const cur = [];
  editor.state.doc.forEach((n) => cur.push(n));
  if (!base) return serializeNodes(editor, cur);
  const O = base.nodes;
  const n = cur.length; const m = O.length;
  const match = new Array(n).fill(-1);
  const eq = (x, y) => x === y || x.eq(y);

  let p = 0;
  while (p < n && p < m && eq(cur[p], O[p])) { match[p] = p; p++; }
  let s = 0;
  while (s < n - p && s < m - p && eq(cur[n - 1 - s], O[m - 1 - s])) { match[n - 1 - s] = m - 1 - s; s++; }
  const midN = cur.slice(p, n - s);
  const midO = O.slice(p, m - s);
  if (midN.length && midO.length && midN.length * midO.length <= 400000) {
    for (const [oi, ni] of lcs(midO, midN, eq)) match[p + ni] = p + oi;
  }

  // a chunk is intact if all its nodes matched, in order, back to back
  const chunkStartO = [];
  base.owner.forEach((j, oi) => { if (chunkStartO[j] === undefined) chunkStartO[j] = oi; });
  const chunkFirstN = new Map();
  const intact = base.chunks.map(() => true);
  const counts = base.chunks.map(() => 0);
  for (let i = 0; i < n; i++) {
    const oi = match[i];
    if (oi < 0) continue;
    const j = base.owner[oi];
    counts[j]++;
    if (!chunkFirstN.has(j)) chunkFirstN.set(j, i);
    const k = oi - chunkStartO[j];
    if (chunkFirstN.get(j) + k !== i) intact[j] = false;
  }
  base.chunks.forEach((c, j) => { if (counts[j] !== c.nodes.length) intact[j] = false; });

  const pieces = []; // {text, chunk?: j}
  let dirty = [];
  const flush = () => { if (dirty.length) { pieces.push({ text: serializeNodes(editor, dirty) }); dirty = []; } };
  for (let i = 0; i < n;) {
    const oi = match[i];
    const j = oi >= 0 ? base.owner[oi] : -1;
    if (j >= 0 && intact[j] && chunkFirstN.get(j) === i) {
      flush();
      pieces.push({ text: base.chunks[j].src, chunk: j });
      i += base.chunks[j].nodes.length;
    } else {
      dirty.push(cur[i]);
      i++;
    }
  }
  flush();

  let out = '';
  pieces.forEach((pc, k) => {
    if (!pc.text && pc.chunk === undefined) return;
    if (k === 0) {
      out += pc.chunk === 0 ? base.chunks[0].gap.map((l) => `${l}\n`).join('') : '';
      out += pc.text;
      return;
    }
    const prev = pieces[k - 1];
    if (prev.chunk !== undefined && pc.chunk === prev.chunk + 1) out = joinGap(out, base.chunks[pc.chunk].gap, pc.text);
    else out += `\n\n${pc.text}`;
  });
  if (base.hiddenOnly) out = out.trim() ? `${base.hiddenOnly}\n\n${out}` : base.hiddenOnly;
  return out;
}
