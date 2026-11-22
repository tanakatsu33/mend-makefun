// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

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

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Successful move edits, [old, new], in order. */
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

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
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
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
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
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------------------------------------------------
// Section 5: files as lines, and matching lines at three tiers.

interface FileLines {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): FileLines {
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  if (text === '') return { lines: [], br, final: false };
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { lines, br, final };
}

function joinFile(lines: string[], br: string, final: boolean): string {
  return lines.length === 0 ? '' : lines.join(br) + (final ? br : '');
}

const norm = (tier: number, s: string): string =>
  tier === 0 ? s : tier === 1 ? s.replace(/[ \t]+$/, '') : s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');

function occurrences(lines: string[], o: string[], tier: number): number[] {
  const out: number[] = [];
  const no = o.map((l) => norm(tier, l));
  const nf = lines.map((l) => norm(tier, l));
  for (let i = 0; i + o.length <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < o.length; j += 1)
      if (nf[i + j] !== no[j]) {
        ok = false;
        break;
      }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs (keeping only positions `keep` accepts), with its positions; null: no-match. */
function findTier(lines: string[], o: string[], strict: boolean, keep: (i: number) => boolean = () => true): { tier: number; pos: number[] } | null {
  for (let tier = 0; tier <= (strict ? 0 : 2); tier += 1) {
    const pos = occurrences(lines, o, tier).filter(keep);
    if (pos.length > 0) return { tier, pos };
  }
  return null;
}

/** A body line: ' ' context (in O and N), '-' old (O only), '+' new (N only), '\\' a no-newline marker. */
interface BodyLine {
  k: string;
  t: string;
}

const oldOf = (body: BodyLine[]): string[] => body.filter((b) => b.k === ' ' || b.k === '-').map((b) => b.t);
const newOf = (body: BodyLine[]): string[] => body.filter((b) => b.k === ' ' || b.k === '+').map((b) => b.t);
const lead = (s: string): string => /^[ \t]*/.exec(s)![0];

/** The lines that replace O's k lines matched at `pos` and `tier` (section 5). */
function replacement(lines: string[], pos: number, tier: number, body: BodyLine[]): string[] {
  const o = oldOf(body);
  const f = lead(lines[pos] ?? '');
  const p = lead(o[0] ?? '');
  const out: string[] = [];
  let oi = 0;
  for (const b of body) {
    if (b.k === ' ') {
      out.push(lines[pos + oi]!);
      oi += 1;
    } else if (b.k === '-') oi += 1;
    else if (b.k === '+') {
      if (tier === 2 && b.t.trim() !== '' && b.t.startsWith(p)) out.push(f + b.t.slice(p.length));
      else out.push(b.t);
    }
  }
  return out;
}

const parseErr = (n: number): Exit2 => new Exit2(`error: parse ${n}`);

// ---------------------------------------------------------------------------------------------------------------------
// Section 6: unified diffs.

interface Hunk {
  a: number;
  body: BodyLine[];
}
interface USection {
  git: [string, string] | null;
  pair: [string | null, string | null] | null;
  renameFrom: string | null;
  renameTo: string | null;
  newMode: boolean;
  delMode: boolean;
  hunks: Hunk[];
}

function uPath(rest: string): string | null {
  const tab = rest.indexOf('\t');
  let s = (tab >= 0 ? rest.slice(0, tab) : rest).replace(/^ +/, '').replace(/ +$/, '');
  if (s === '/dev/null') return null;
  if (s.startsWith('a/') || s.startsWith('b/')) s = s.slice(2);
  return s;
}

function parseGit(line: string): [string, string] | null {
  const rest = line.slice('diff --git '.length);
  if (!rest.startsWith('a/')) return null;
  const cands: [string, string][] = [];
  for (let k = rest.indexOf(' b/'); k >= 0; k = rest.indexOf(' b/', k + 1)) cands.push([rest.slice(2, k), rest.slice(k + 3)]);
  if (cands.length === 0) return null;
  return cands.find(([x, y]) => x === y) ?? cands[0]!;
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: USection[] = [];
  let cur: USection | null = null;
  let inHeader = false;
  const isPair = (i: number): boolean => lines[i]!.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ');
  const fresh = (): USection => ({ git: null, pair: null, renameFrom: null, renameTo: null, newMode: false, delMode: false, hunks: [] });
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const g = parseGit(l);
      if (g === null) throw parseErr(i + 1);
      cur = fresh();
      cur.git = g;
      sections.push(cur);
      inHeader = true;
      i += 1;
      continue;
    }
    if (isPair(i)) {
      if (cur === null || !inHeader || cur.pair !== null) {
        cur = fresh();
        sections.push(cur);
        inHeader = true;
      }
      cur.pair = [uPath(l.slice(4)), uPath(lines[i + 1]!.slice(4))];
      i += 2;
      continue;
    }
    if (l.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(l);
      if (m === null || cur === null) throw parseErr(i + 1);
      inHeader = false;
      i += 1;
      const body: BodyLine[] = [];
      while (i < lines.length) {
        const b = lines[i]!;
        if (b.startsWith('diff --git ') || isPair(i)) break;
        if (b === '') body.push({ k: ' ', t: '' });
        else if (' -+\\'.includes(b[0]!)) body.push({ k: b[0]!, t: b.slice(1) });
        else break;
        i += 1;
      }
      let end = body.length;
      while (end > 0 && lines[i - body.length + end - 1] === '') end -= 1;
      cur.hunks.push({ a: Number(m[1]), body: body.slice(0, end) });
      continue;
    }
    if (cur !== null && inHeader) {
      if (l.startsWith('--- ')) throw parseErr(i + 2);
      if (l.startsWith('rename from ')) cur.renameFrom = l.slice('rename from '.length).trim();
      else if (l.startsWith('rename to ')) cur.renameTo = l.slice('rename to '.length).trim();
      else if (l.startsWith('new file mode')) cur.newMode = true;
      else if (l.startsWith('deleted file mode')) cur.delMode = true;
    }
    i += 1;
  }
  return sections.map((s) => unifiedEdit(s, strict));
}

function unifiedEdit(s: USection, strict: boolean): Edit {
  let oldP: string | null;
  let newP: string | null;
  if (s.pair !== null) [oldP, newP] = s.pair;
  else {
    oldP = s.renameFrom ?? s.git?.[0] ?? null;
    newP = s.renameTo ?? s.git?.[1] ?? null;
  }
  if (s.pair === null && s.renameFrom === null && s.renameTo === null && s.git === null) oldP = newP = null;
  const creation = oldP === null || s.newMode;
  const deletion = !creation && (newP === null || s.delMode);
  if (creation) {
    const p = newP ?? '';
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const out: string[] = [];
      let noeol = false;
      for (const h of s.hunks)
        h.body.forEach((b, j) => {
          if (b.k === '+') {
            out.push(b.t);
            noeol = h.body[j + 1]?.k === '\\';
          }
        });
      tree.now.set(p, joinFile(out, '\n', !noeol));
    };
  }
  if (deletion) {
    const p = oldP!;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
    };
  }
  const from = oldP!;
  const to = newP!;
  const move = from !== to;
  return (tree) => {
    if (!safe(from)) throw new Fail('unsafe', from);
    if (move && !safe(to)) throw new Fail('unsafe', to);
    const text = tree.get(from);
    if (text === null) throw new Fail('missing', from);
    if (move && tree.get(to) !== null) throw new Fail('exists', to);
    const f = splitFile(text);
    let lines = f.lines;
    let final = f.final;
    let d = 0;
    for (const h of s.hunks) {
      const o = oldOf(h.body);
      const n = newOf(h.body);
      let pos: number;
      let repl: string[];
      if (o.length > 0) {
        const found = findTier(lines, o, strict);
        if (found === null) throw new Fail('no-match', from);
        const target = h.a - 1 + d;
        pos = found.pos[0]!;
        for (const q of found.pos) if (Math.abs(q - target) < Math.abs(pos - target)) pos = q;
        repl = replacement(lines, pos, found.tier, h.body);
      } else {
        pos = Math.max(0, Math.min(h.a + d, lines.length));
        repl = n;
      }
      if (pos + o.length === lines.length) {
        let last = -1;
        h.body.forEach((b, j) => {
          if (b.k === ' ' || b.k === '+') last = j;
        });
        final = !(last >= 0 && h.body[last + 1]?.k === '\\');
      }
      lines = [...lines.slice(0, pos), ...repl, ...lines.slice(pos + o.length)];
      d += n.length - o.length;
    }
    const out = joinFile(lines, f.br, final);
    if (move) {
      tree.now.set(from, null);
      tree.now.set(to, out);
      tree.moves.push([from, to]);
    } else tree.now.set(from, out);
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Section 7: SEARCH/REPLACE blocks.

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let lastEnd = -1;
  let prevPath: string | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') continue;
    let sep = -1;
    for (let j = i + 1; j < lines.length; j += 1)
      if (lines[j]!.trimEnd() === '=======') {
        sep = j;
        break;
      }
    let end = -1;
    if (sep >= 0)
      for (let j = sep + 1; j < lines.length; j += 1)
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          end = j;
          break;
        }
    let path: string | null = null;
    for (let j = i - 1; j > lastEnd; j -= 1) {
      const t = lines[j]!.trim();
      if (t !== '' && !t.startsWith('```')) {
        path = t;
        break;
      }
    }
    if (path === null) path = prevPath;
    if (path === null || end < 0) throw parseErr(i + 1);
    prevPath = path;
    edits.push(searchReplaceEdit(path, lines.slice(i + 1, sep), lines.slice(sep + 1, end), strict));
    lastEnd = end;
    i = end;
  }
  return edits;
}

function searchReplaceEdit(p: string, o: string[], n: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const text = tree.get(p);
    if (o.length === 0) {
      if (text !== null) throw new Fail('exists', p);
      tree.now.set(p, joinFile(n, '\n', true));
      return;
    }
    if (text === null) throw new Fail('missing', p);
    const f = splitFile(text);
    const found = findTier(f.lines, o, strict);
    if (found === null) throw new Fail('no-match', p);
    if (found.pos.length > 1) throw new Fail('ambiguous', p);
    const pos = found.pos[0]!;
    const body = [...o.map((t) => ({ k: '-', t })), ...n.map((t) => ({ k: '+', t }))];
    const lines = [...f.lines.slice(0, pos), ...replacement(f.lines, pos, found.tier, body), ...f.lines.slice(pos + o.length)];
    tree.now.set(p, joinFile(lines, f.br, f.final));
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Section 8: V4A patches.

interface Chunk {
  anchor: string | null;
  body: BodyLine[];
  eof: boolean;
}

const v4aPath = (s: string): string => s.replace(/^ +/, '').replace(/ +$/, '');

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw parseErr(1);
  if (lines[first]!.trim() !== '*** Begin Patch') throw parseErr(first + 1);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last -= 1;
  if (last === first || lines[last]!.trim() !== '*** End Patch') throw parseErr(lines.length + 1);
  const ADD = '*** Add File: ';
  const DEL = '*** Delete File: ';
  const UPD = '*** Update File: ';
  const MOVE = '*** Move to: ';
  const isHead = (l: string): boolean => l.startsWith(ADD) || l.startsWith(DEL) || l.startsWith(UPD);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (!isHead(l)) {
      if (blank(l)) {
        i += 1;
        continue;
      }
      throw parseErr(i + 1);
    }
    const head = i;
    let end = i + 1;
    while (end < last && !isHead(lines[end]!)) end += 1;
    let stop = end;
    while (stop > head + 1 && blank(lines[stop - 1]!)) stop -= 1;
    i = end;
    if (l.startsWith(ADD)) {
      const p = v4aPath(l.slice(ADD.length));
      const out: string[] = [];
      for (let j = head + 1; j < stop; j += 1) {
        const b = lines[j]!;
        if (b === '') out.push('');
        else if (b.startsWith('+')) out.push(b.slice(1));
        else throw parseErr(j + 1);
      }
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, joinFile(out, '\n', true));
      });
    } else if (l.startsWith(DEL)) {
      const p = v4aPath(l.slice(DEL.length));
      if (stop > head + 1) throw parseErr(head + 2);
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      });
    } else {
      const p = v4aPath(l.slice(UPD.length));
      let j = head + 1;
      let to: string | null = null;
      if (j < stop && lines[j]!.startsWith(MOVE)) {
        to = v4aPath(lines[j]!.slice(MOVE.length));
        j += 1;
      }
      const chunks: Chunk[] = [];
      let open: Chunk | null = null;
      for (; j < stop; j += 1) {
        const b = lines[j]!;
        if (b.startsWith('@@')) {
          const a = b.slice(2).replace(/^ +/, '').replace(/ +$/, '');
          open = { anchor: a === '' ? null : a, body: [], eof: false };
          chunks.push(open);
        } else if (b.trim() === '*** End of File') {
          if (open === null) throw parseErr(j + 1);
          open.eof = true;
          open = null;
        } else if (b === '' || b[0] === ' ' || b[0] === '-' || b[0] === '+') {
          if (open === null) {
            if (chunks.length > 0) throw parseErr(j + 1);
            open = { anchor: null, body: [], eof: false };
            chunks.push(open);
          }
          open.body.push(b === '' ? { k: ' ', t: '' } : { k: b[0]!, t: b.slice(1) });
        } else throw parseErr(j + 1);
      }
      if (chunks.length === 0 && to === null) throw parseErr(head + 1);
      edits.push(v4aUpdate(p, to, chunks, strict));
    }
  }
  return edits;
}

function v4aUpdate(p: string, to: string | null, chunks: Chunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    if (to !== null && !safe(to)) throw new Fail('unsafe', to);
    const text = tree.get(p);
    if (text === null) throw new Fail('missing', p);
    if (to !== null && tree.get(to) !== null) throw new Fail('exists', to);
    const f = splitFile(text);
    let lines = f.lines;
    let cursor = 0;
    for (const c of chunks) {
      if (c.anchor !== null) {
        const cur = cursor;
        const found = findTier(lines, [c.anchor], strict, (q) => q >= cur);
        if (found === null) throw new Fail('no-match', p);
        cursor = found.pos[0]! + 1;
      }
      const o = oldOf(c.body);
      const n = newOf(c.body);
      let pos: number;
      let repl: string[];
      if (o.length === 0) {
        pos = c.eof ? lines.length : Math.min(cursor, lines.length);
        repl = n;
      } else {
        const cur = cursor;
        const len = lines.length;
        const found = findTier(lines, o, strict, (q) => q >= cur && (!c.eof || q + o.length === len));
        if (found === null) throw new Fail('no-match', p);
        pos = found.pos[0]!;
        repl = replacement(lines, pos, found.tier, c.body);
      }
      lines = [...lines.slice(0, pos), ...repl, ...lines.slice(pos + o.length)];
      cursor = pos + repl.length;
    }
    const out = joinFile(lines, f.br, f.final);
    if (to !== null) {
      tree.now.set(p, null);
      tree.now.set(to, out);
      tree.moves.push([p, to]);
    } else tree.now.set(p, out);
  };
}

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
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? searchReplaceEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const byBytes = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));
  const changed = new Map<string, string>();
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    changed.set(p, `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`);
  }
  const entries: [string, string][] = [];
  const paired = new Set<string>();
  for (const [from, to] of tree.moves) {
    if (paired.has(from) || paired.has(to)) continue;
    if (changed.get(from) !== `D ${from}` || changed.get(to) !== `A ${to}`) continue;
    paired.add(from);
    paired.add(to);
    entries.push([to, `R ${from} -> ${to}`]);
  }
  for (const [p, line] of changed) if (!paired.has(p)) entries.push([p, line]);
  entries.sort((a, b) => byBytes(a[0], b[0]));
  const rows = entries.map((e) => e[1]);
  if (!check) {
    const paths = [...changed.keys()].sort(byBytes);
    for (const p of paths) if (tree.now.get(p) === null) rmSync(p, { force: true });
    for (const p of paths) {
      const now = tree.now.get(p);
      if (now === null || now === undefined) continue;
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
