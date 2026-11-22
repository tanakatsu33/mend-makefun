// main.ts is mend, the CLI SPEC.md specifies (MIT). It reads an edit an AI model wrote, in one of four formats (a
// unified diff, SEARCH/REPLACE blocks, a V4A patch, or text-editor tool calls as JSON), and applies it to the tree of
// text files in the working directory: every file is changed or nothing is. Node 22, the standard library alone; run
// it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below).

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const parseError = (n: number): Exit2 => new Exit2(`error: parse ${n}`);

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

function needSafe(...paths: string[]): void {
  for (const p of paths) if (!safe(p)) throw new Fail('unsafe', p);
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Moves made by edits that succeeded, as [old, new]. */
  readonly moves: [string, string][] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

let STRICT = false;

// ---------------------------------------------------------------------------------------------------------------
// Files as lines (section 3)

interface FileText {
  lines: string[];
  br: string;
  final: boolean;
}

function readFile(text: string): FileText {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  let final = false;
  if (text.endsWith(br)) {
    lines.pop();
    final = true;
  }
  return { lines, br, final };
}

function writeFile(f: FileText): string {
  return f.lines.length === 0 ? '' : f.lines.join(f.br) + (f.final ? f.br : '');
}

/** A created file: LF breaks, ending with one when `final`; no lines is empty. */
function created(lines: string[], final: boolean): string {
  return writeFile({ lines, br: '\n', final });
}

// ---------------------------------------------------------------------------------------------------------------
// Matching lines (section 5)

const NORM: ((s: string) => string)[] = [
  (s) => s,
  (s) => s.replace(/[ \t]+$/, ''),
  (s) => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, ''),
];

function occurrences(lines: string[], old: string[], tier: number): number[] {
  const norm = NORM[tier]!;
  const o = old.map(norm);
  const f = lines.map(norm);
  const out: number[] = [];
  for (let i = 0; i + o.length <= f.length; i++) {
    let ok = true;
    for (let k = 0; k < o.length; k++) {
      if (f[i + k] !== o[k]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at an accepted position, with those positions; null when none. */
function find(lines: string[], old: string[], accept: (pos: number) => boolean = () => true): { tier: number; positions: number[] } | null {
  const tiers = STRICT ? 1 : 3;
  for (let tier = 0; tier < tiers; tier++) {
    const positions = occurrences(lines, old, tier).filter(accept);
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

/** A line of N: its text, and for a context line the index of its line in O (else -1). */
interface NewLine {
  text: string;
  ctx: number;
}

const leading = (s: string): string => /^[ \t]*/.exec(s)![0];

/** The lines that replace O matched at `pos` at `tier`. */
function replacement(lines: string[], pos: number, tier: number, old: string[], neu: NewLine[]): string[] {
  const f = tier === 2 ? leading(lines[pos]!) : '';
  const p = tier === 2 && old.length > 0 ? leading(old[0]!) : '';
  return neu.map((n) => {
    if (n.ctx >= 0) return lines[pos + n.ctx]!;
    if (tier === 2 && !blank(n.text) && n.text.startsWith(p)) return f + n.text.slice(p.length);
    return n.text;
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Format detection (section 4)

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// JSON edits (section 9)

/** One JSON edit object, or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    needSafe(p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      needSafe(p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const f = readFile(exists(tree));
      if (line < 0 || line > f.lines.length) throw new Fail('no-match', p);
      f.lines.splice(line, 0, ...add);
      tree.now.set(p, writeFile(f));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw parseError(1);
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw parseError(first + 1);
    }
    if (!Array.isArray(v)) throw parseError(first + 1);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw parseError(first + 1);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw parseError(i + 1);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------------------------------------------
// Unified diffs (section 6)

interface BodyLine {
  kind: ' ' | '-' | '+';
  text: string;
  noeol: boolean;
}
interface Hunk {
  a: number;
  body: BodyLine[];
}
interface Section {
  gitOld: string | null;
  gitNew: string | null;
  fromGit: boolean;
  hasPair: boolean;
  minus: string | null;
  plus: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  create: boolean;
  del: boolean;
  hunks: Hunk[];
}

function newSection(): Section {
  return { gitOld: null, gitNew: null, fromGit: false, hasPair: false, minus: null, plus: null, renameFrom: null, renameTo: null, create: false, del: false, hunks: [] };
}

/** The path of a `--- `/`+++ ` line: null for /dev/null. */
function pairPath(line: string): string | null {
  let s = line.slice(4);
  const tab = s.indexOf('\t');
  if (tab >= 0) s = s.slice(0, tab);
  s = s.replace(/^ +/, '').replace(/ +$/, '');
  if (s === '/dev/null') return null;
  if (s.startsWith('a/') || s.startsWith('b/')) s = s.slice(2);
  return s;
}

/** The two paths of a `diff --git a/<X> b/<Y>` line, or null when it is not of that form. */
function gitPaths(line: string): [string, string] | null {
  const rest = line.slice('diff --git '.length);
  if (!rest.startsWith('a/')) return null;
  const splits: [string, string][] = [];
  for (let k = rest.indexOf(' b/', 2); k >= 0; k = rest.indexOf(' b/', k + 1)) {
    const x = rest.slice(2, k);
    const y = rest.slice(k + 3);
    if (x !== '' && y !== '') splits.push([x, y]);
  }
  if (splits.length === 0) return null;
  return splits.find(([x, y]) => x === y) ?? splits[0]!;
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function unifiedSections(lines: string[]): Section[] {
  const sections: Section[] = [];
  let sec: Section | null = null;
  let inHeader = false;
  const isPair = (i: number): boolean => lines[i]!.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ');
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ') || l.trimEnd() === 'diff --git') {
      const g = gitPaths(l);
      if (g === null) throw parseError(i + 1);
      sec = newSection();
      sec.fromGit = true;
      [sec.gitOld, sec.gitNew] = g;
      sections.push(sec);
      inHeader = true;
      i += 1;
      continue;
    }
    if (isPair(i)) {
      if (!(sec !== null && inHeader && sec.fromGit && !sec.hasPair)) {
        sec = newSection();
        sections.push(sec);
      }
      sec.hasPair = true;
      sec.minus = pairPath(l);
      sec.plus = pairPath(lines[i + 1]!);
      inHeader = true;
      i += 2;
      continue;
    }
    if (l.startsWith('@@')) {
      const m = HUNK.exec(l);
      if (m === null || sec === null) throw parseError(i + 1);
      inHeader = false;
      const body: BodyLine[] = [];
      const raw: string[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const b = lines[j]!;
        if (b.startsWith('diff --git ') || isPair(j)) break;
        if (b !== '' && !' -+\\'.includes(b[0]!)) break;
        raw.push(b);
        j += 1;
      }
      while (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
      for (const b of raw) {
        if (b === '') body.push({ kind: ' ', text: '', noeol: false });
        else if (b[0] === '\\') {
          if (body.length > 0) body[body.length - 1]!.noeol = true;
        } else body.push({ kind: b[0] as ' ' | '-' | '+', text: b.slice(1), noeol: false });
      }
      sec.hunks.push({ a: Number(m[1]), body });
      i += 1 + raw.length;
      continue;
    }
    if (inHeader && sec !== null) {
      if (l.startsWith('--- ')) throw parseError(i + 2);
      if (l.startsWith('rename from ')) sec.renameFrom = l.slice('rename from '.length);
      else if (l.startsWith('rename to ')) sec.renameTo = l.slice('rename to '.length);
      else if (l.startsWith('new file mode')) sec.create = true;
      else if (l.startsWith('deleted file mode')) sec.del = true;
    }
    i += 1;
  }
  return sections;
}

function applyHunks(f: FileText, hunks: Hunk[], path: string): FileText {
  const lines = [...f.lines];
  let final = f.final;
  let d = 0;
  for (const h of hunks) {
    const old: string[] = [];
    const neu: NewLine[] = [];
    let lastNew = -1;
    h.body.forEach((b, k) => {
      if (b.kind === ' ') {
        neu.push({ text: b.text, ctx: old.length });
        old.push(b.text);
        lastNew = k;
      } else if (b.kind === '-') old.push(b.text);
      else {
        neu.push({ text: b.text, ctx: -1 });
        lastNew = k;
      }
    });
    const noeol = lastNew >= 0 && h.body[lastNew]!.noeol;
    if (old.length === 0) {
      const at = Math.min(Math.max(h.a + d, 0), lines.length);
      const atEnd = at === lines.length;
      lines.splice(at, 0, ...neu.map((n) => n.text));
      if (atEnd) final = !noeol;
    } else {
      const m = find(lines, old);
      if (m === null) throw new Fail('no-match', path);
      const want = h.a - 1 + d;
      let pos = m.positions[0]!;
      for (const q of m.positions) if (Math.abs(q - want) < Math.abs(pos - want)) pos = q;
      const repl = replacement(lines, pos, m.tier, old, neu);
      const atEnd = pos + old.length === lines.length;
      lines.splice(pos, old.length, ...repl);
      if (atEnd) final = !noeol;
    }
    d += neu.length - old.length;
  }
  return { lines, br: f.br, final };
}

function unifiedEdits(lines: string[]): Edit[] {
  return unifiedSections(lines).map((s): Edit => {
    const oldP = s.hasPair ? s.minus : (s.renameFrom ?? s.gitOld);
    const newP = s.hasPair ? s.plus : (s.renameTo ?? s.gitNew);
    const named = [oldP, newP].filter((x): x is string => x !== null);
    if (oldP === null || s.create) {
      const p = (newP ?? oldP)!;
      const plus = s.hunks.flatMap((h) => h.body.filter((b) => b.kind === '+'));
      const final = plus.length > 0 && !plus[plus.length - 1]!.noeol;
      return (tree) => {
        needSafe(...named);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, created(plus.map((b) => b.text), final));
      };
    }
    if (newP === null || s.del) {
      const p = oldP;
      return (tree) => {
        needSafe(...named);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      };
    }
    const move = oldP !== newP;
    return (tree) => {
      needSafe(oldP);
      if (move) needSafe(newP);
      const src = tree.get(oldP);
      if (src === null) throw new Fail('missing', oldP);
      if (move && tree.get(newP) !== null) throw new Fail('exists', newP);
      const out = writeFile(applyHunks(readFile(src), s.hunks, oldP));
      if (move) {
        tree.now.set(oldP, null);
        tree.now.set(newP, out);
        tree.moves.push([oldP, newP]);
      } else tree.now.set(oldP, out);
    };
  });
}

// ---------------------------------------------------------------------------------------------------------------
// SEARCH/REPLACE blocks (section 7)

function searchReplaceEdits(lines: string[]): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let regionStart = 0;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    let path: string | null = null;
    for (let k = i - 1; k >= regionStart; k--) {
      const t = lines[k]!.trim();
      if (t !== '' && !t.startsWith('```')) {
        path = t;
        break;
      }
    }
    path ??= prevPath;
    if (path === null) throw parseError(i + 1);
    let sep = -1;
    for (let k = i + 1; k < lines.length; k++) {
      if (lines[k]!.trimEnd() === '=======') {
        sep = k;
        break;
      }
    }
    let end = -1;
    if (sep >= 0) {
      for (let k = sep + 1; k < lines.length; k++) {
        if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
          end = k;
          break;
        }
      }
    }
    if (end < 0) throw parseError(i + 1);
    const old = lines.slice(i + 1, sep);
    const neu = lines.slice(sep + 1, end);
    const p = path;
    edits.push((tree) => {
      needSafe(p);
      const src = tree.get(p);
      if (old.length === 0) {
        if (src !== null) throw new Fail('exists', p);
        tree.now.set(p, created(neu, true));
        return;
      }
      if (src === null) throw new Fail('missing', p);
      const f = readFile(src);
      const m = find(f.lines, old);
      if (m === null) throw new Fail('no-match', p);
      if (m.positions.length > 1) throw new Fail('ambiguous', p);
      const pos = m.positions[0]!;
      const repl = replacement(f.lines, pos, m.tier, old, neu.map((text) => ({ text, ctx: -1 })));
      f.lines.splice(pos, old.length, ...repl);
      tree.now.set(p, writeFile(f));
    });
    prevPath = path;
    regionStart = end + 1;
    i = end + 1;
  }
  return edits;
}

// ---------------------------------------------------------------------------------------------------------------
// V4A patches (section 8)

interface Chunk {
  anchor: string | null;
  body: string[];
  eof: boolean;
}

function findAnchor(lines: string[], anchor: string, from: number): number {
  const tiers = STRICT ? 1 : 3;
  for (let tier = 0; tier < tiers; tier++) {
    const norm = NORM[tier]!;
    const a = norm(anchor);
    for (let i = from; i < lines.length; i++) if (norm(lines[i]!) === a) return i;
  }
  return -1;
}

function v4aEdits(lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw parseError(1);
  if (lines[first]!.trim() !== '*** Begin Patch') throw parseError(first + 1);
  let last = lines.length - 1;
  while (blank(lines[last]!)) last -= 1;
  if (last === first || lines[last]!.trim() !== '*** End Patch') throw parseError(lines.length + 1);

  interface Sec {
    kind: 'add' | 'delete' | 'update';
    path: string;
    line: number;
    body: { text: string; line: number }[];
  }
  const secs: Sec[] = [];
  let cur: Sec | null = null;
  const heads: [string, Sec['kind']][] = [
    ['*** Add File: ', 'add'],
    ['*** Delete File: ', 'delete'],
    ['*** Update File: ', 'update'],
  ];
  for (let i = first + 1; i < last; i++) {
    const l = lines[i]!;
    const h = heads.find(([prefix]) => l.startsWith(prefix));
    if (h !== undefined) {
      cur = { kind: h[1], path: l.slice(h[0].length).replace(/^ +| +$/g, ''), line: i + 1, body: [] };
      secs.push(cur);
      continue;
    }
    if (cur === null) {
      if (blank(l)) continue;
      throw parseError(i + 1);
    }
    cur.body.push({ text: l, line: i + 1 });
  }

  const edits: Edit[] = [];
  for (const s of secs) {
    while (s.body.length > 0 && blank(s.body[s.body.length - 1]!.text)) s.body.pop();
    const p = s.path;
    if (s.kind === 'add') {
      const content: string[] = [];
      for (const b of s.body) {
        if (b.text === '') content.push('');
        else if (b.text.startsWith('+')) content.push(b.text.slice(1));
        else throw parseError(b.line);
      }
      edits.push((tree) => {
        needSafe(p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, created(content, true));
      });
      continue;
    }
    if (s.kind === 'delete') {
      if (s.body.length > 0) throw parseError(s.body[0]!.line);
      edits.push((tree) => {
        needSafe(p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      });
      continue;
    }
    let k = 0;
    let move: string | null = null;
    if (s.body.length > 0 && s.body[0]!.text.startsWith('*** Move to: ')) {
      move = s.body[0]!.text.slice('*** Move to: '.length).replace(/^ +| +$/g, '');
      k = 1;
    }
    const chunks: Chunk[] = [];
    let open: Chunk | null = null;
    for (; k < s.body.length; k++) {
      const { text: t, line } = s.body[k]!;
      if (t.startsWith('@@')) {
        const anchor = t.slice(2).replace(/^ +| +$/g, '');
        open = { anchor: anchor === '' ? null : anchor, body: [], eof: false };
        chunks.push(open);
      } else if (t === '*** End of File') {
        if (open === null) throw parseError(line);
        open.eof = true;
        open = null;
      } else if (t === '' || ' -+'.includes(t[0]!)) {
        if (open === null) {
          if (chunks.length > 0) throw parseError(line);
          open = { anchor: null, body: [], eof: false };
          chunks.push(open);
        }
        open.body.push(t);
      } else throw parseError(line);
    }
    if (chunks.length === 0 && move === null) throw parseError(s.line);
    const to = move;
    edits.push((tree) => {
      needSafe(p);
      if (to !== null) needSafe(to);
      const src = tree.get(p);
      if (src === null) throw new Fail('missing', p);
      if (to !== null && tree.get(to) !== null) throw new Fail('exists', to);
      const f = readFile(src);
      const ls = f.lines;
      let cursor = 0;
      for (const c of chunks) {
        if (c.anchor !== null) {
          const at = findAnchor(ls, c.anchor, cursor);
          if (at < 0) throw new Fail('no-match', p);
          cursor = at + 1;
        }
        const old: string[] = [];
        const neu: NewLine[] = [];
        for (const b of c.body) {
          const kind = b === '' ? ' ' : b[0];
          const text = b.slice(1);
          if (kind === ' ') {
            neu.push({ text, ctx: old.length });
            old.push(text);
          } else if (kind === '-') old.push(text);
          else neu.push({ text, ctx: -1 });
        }
        if (old.length === 0) {
          const at = c.eof ? ls.length : cursor;
          ls.splice(at, 0, ...neu.map((n) => n.text));
          cursor = at + neu.length;
          continue;
        }
        const from = cursor;
        const m = find(ls, old, (q) => q >= from && (!c.eof || q + old.length === ls.length));
        if (m === null) throw new Fail('no-match', p);
        const pos = m.positions[0]!;
        const repl = replacement(ls, pos, m.tier, old, neu);
        ls.splice(pos, old.length, ...repl);
        cursor = pos + repl.length;
      }
      const out = writeFile(f);
      if (to !== null) {
        tree.now.set(p, null);
        tree.now.set(to, out);
        tree.moves.push([p, to]);
      } else tree.now.set(p, out);
    });
  }
  return edits;
}

// ---------------------------------------------------------------------------------------------------------------
// The command (sections 1, 2 and 10)

const byteOrder = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  STRICT = strict;
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines);
    else edits = v4aEdits(lines);
    if (edits.length === 0) throw parseError(1);
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const moves = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = moves;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };

  const rows = new Map<string, string>();
  const changed: string[] = [];
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    changed.push(p);
    rows.set(p, `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`);
  }
  for (const [from, to] of tree.moves) {
    if (rows.get(from) === `D ${from}` && rows.get(to) === `A ${to}`) {
      rows.delete(from);
      rows.set(to, `R ${from} -> ${to}`);
    }
  }
  const out = [...rows.keys()].sort(byteOrder).map((k) => rows.get(k)!);
  if (!check) {
    for (const p of changed) if (tree.now.get(p) === null) rmSync(p, { force: true });
    for (const p of changed) {
      const now = tree.now.get(p);
      if (typeof now !== 'string') continue;
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  return { code: 0, out: [...out, `ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
