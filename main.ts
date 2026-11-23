// mend applies unified diffs, SEARCH/REPLACE blocks, V4A patches and JSON edits (SPEC.md).
// Node 22, standard library only. Run as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmdirSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
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
  readonly moves: [oldPath: string, newPath: string][] = [];
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
  move(oldPath: string, newPath: string, text: string): void {
    this.now.set(oldPath, null);
    this.now.set(newPath, text);
    this.moves.push([oldPath, newPath]);
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

function parseFault(line: number): never {
  throw new Exit2(`error: parse ${line + 1}`);
}

function checkPaths(...paths: (string | null)[]): void {
  for (const path of paths) {
    if (path !== null && !safe(path)) throw new Fail('unsafe', path);
  }
}

function requireFile(tree: Tree, path: string): string {
  const text = tree.get(path);
  if (text === null) throw new Fail('missing', path);
  return text;
}

function requireAbsent(tree: Tree, path: string): void {
  if (tree.get(path) !== null) throw new Fail('exists', path);
}

function splitFile(text: string) {
  const firstLF = text.indexOf('\n');
  const br = firstLF > 0 && text[firstLF - 1] === '\r' ? '\r\n' : '\n';
  const final = text.endsWith(br);
  const lines = text === '' ? [] : text.split(br);
  if (final) lines.pop();
  return { lines, br, final };
}

function joinFile(lines: string[], br = '\n', final = true): string {
  return lines.length === 0 ? '' : lines.join(br) + (final ? br : '');
}

function replaceLines(lines: string[], at: number, count: number, added: string[]): string[] {
  return lines.slice(0, at).concat(added, lines.slice(at + count));
}

type MatchTier = 0 | 1 | 2;

const indent = (line: string): string => /^[ \t]*/.exec(line)![0];

function normalizeLine(line: string, tier: MatchTier): string {
  if (tier === 0) return line;
  const trimmed = line.replace(/[ \t]+$/, '');
  return tier === 1 ? trimmed : trimmed.slice(indent(trimmed).length);
}

/** Search only allowed positions before deciding which tier has any matches. */
function findLines(lines: string[], old: string[], strict: boolean, start = 0, endOfFile = false) {
  const last = lines.length - old.length;
  const first = endOfFile ? Math.max(start, last) : start;
  for (const tier of strict ? [0] as const : [0, 1, 2] as const) {
    const wanted = old.map((line) => normalizeLine(line, tier));
    const positions: number[] = [];
    for (let i = first; i <= last; i++) {
      if (wanted.every((line, offset) => line === normalizeLine(lines[i + offset]!, tier))) positions.push(i);
    }
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

type BodyLine = { kind: ' ' | '-' | '+'; text: string; noBreak?: boolean };
type NewLine = { text: string; context?: number };

function readBodyLine(line: string): BodyLine | null {
  if (line === '') return { kind: ' ', text: '' };
  const kind = line[0];
  return kind === ' ' || kind === '-' || kind === '+' ? { kind, text: line.slice(1) } : null;
}

function hunkLines(body: BodyLine[]) {
  const old: string[] = [];
  const added: NewLine[] = [];
  for (const line of body) {
    if (line.kind === ' ') added.push({ text: line.text, context: old.length });
    if (line.kind === '+') added.push({ text: line.text });
    if (line.kind !== '+') old.push(line.text);
  }
  return { old, added };
}

function replacement(added: NewLine[], old: string[], lines: string[], at: number, tier: MatchTier): string[] {
  const from = tier === 2 ? indent(old[0]!) : '';
  const to = tier === 2 ? indent(lines[at]!) : '';
  return added.map(({ text, context }) => {
    if (context !== undefined) return lines[at + context]!;
    if (tier === 2 && !blank(text) && text.startsWith(from)) return to + text.slice(from.length);
    return text;
  });
}

const SEARCH = '<<<<<<< SEARCH';
const SEPARATOR = '=======';
const REPLACE = '>>>>>>> REPLACE';

function findMarker(lines: string[], marker: string, start: number): number {
  for (let i = start; i < lines.length; i++) {
    if (lines[i]!.trimEnd() === marker) return i;
  }
  return -1;
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let path: string | undefined;
  let candidate: string | undefined;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trimEnd() !== SEARCH) {
      const name = line.trim();
      if (name !== '' && !name.startsWith('```')) candidate = name;
      continue;
    }
    path = candidate ?? path;
    if (path === undefined) parseFault(i);
    const separator = findMarker(lines, SEPARATOR, i + 1);
    const end = separator < 0 ? -1 : findMarker(lines, REPLACE, separator + 1);
    if (end < 0) parseFault(i);
    const file = path;
    const old = lines.slice(i + 1, separator);
    const added = lines.slice(separator + 1, end).map((text) => ({ text }));
    edits.push((tree) => {
      checkPaths(file);
      if (old.length === 0) {
        requireAbsent(tree, file);
        tree.now.set(file, joinFile(added.map(({ text }) => text)));
        return;
      }
      const before = splitFile(requireFile(tree, file));
      const match = findLines(before.lines, old, strict);
      if (match === null) throw new Fail('no-match', file);
      if (match.positions.length > 1) throw new Fail('ambiguous', file);
      const at = match.positions[0]!;
      const written = replacement(added, old, before.lines, at, match.tier);
      tree.now.set(file, joinFile(replaceLines(before.lines, at, old.length, written), before.br, before.final));
    });
    candidate = undefined;
    i = end;
  }
  return edits;
}

type UnifiedHunk = { start: number; body: BodyLine[] };
type UnifiedSection = {
  line: number;
  git?: [string, string];
  paths?: [string | null, string | null];
  renameFrom?: string;
  renameTo?: string;
  create?: boolean;
  delete?: boolean;
  hunks: UnifiedHunk[];
};

function unifiedPath(header: string): string | null {
  const name = header.slice(4).split('\t', 1)[0]!.trim();
  return name === '/dev/null' ? null : name.replace(/^[ab]\//, '');
}

function unifiedPair(lines: string[], i: number): boolean {
  return lines[i]!.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ');
}

function readUnifiedHunk(lines: string[], first: number): { hunk: UnifiedHunk; next: number } {
  const header = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(lines[first]!);
  if (header === null) parseFault(first);
  let next = first + 1;
  while (next < lines.length && !unifiedPair(lines, next)) {
    const line = lines[next]!;
    if (line !== '' && !' -+\\'.includes(line[0]!)) break;
    next++;
  }
  let end = next;
  while (end > first + 1 && lines[end - 1] === '') end--;
  const body: BodyLine[] = [];
  let previous: BodyLine | null = null;
  for (let i = first + 1; i < end; i++) {
    const line = lines[i]!;
    if (line.startsWith('\\') && previous !== null) previous.noBreak = true;
    previous = readBodyLine(line);
    if (previous !== null) body.push(previous);
  }
  return { hunk: { start: Number(header[1]), body }, next };
}

function applyUnifiedHunks(text: string, hunks: UnifiedHunk[], path: string, strict: boolean): string {
  let { lines, br, final } = splitFile(text);
  let delta = 0;
  for (const { start, body } of hunks) {
    const { old, added } = hunkLines(body);
    let at = Math.max(0, Math.min(lines.length, start + delta));
    let tier: MatchTier = 0;
    if (old.length > 0) {
      const match = findLines(lines, old, strict);
      if (match === null) throw new Fail('no-match', path);
      const target = Math.max(0, Math.min(lines.length - old.length, start - 1 + delta));
      at = match.positions[0]!;
      for (const position of match.positions) {
        if (Math.abs(position - target) < Math.abs(at - target)) at = position;
      }
      tier = match.tier;
    }
    if (at + old.length === lines.length) final = !body.findLast((line) => line.kind !== '-')?.noBreak;
    lines = replaceLines(lines, at, old.length, replacement(added, old, lines, at, tier));
    delta += added.length - old.length;
  }
  return joinFile(lines, br, final);
}

function unifiedEdit(section: UnifiedSection, strict: boolean): Edit {
  const [oldPath, newPath] = section.paths ?? [section.renameFrom ?? section.git![0], section.renameTo ?? section.git![1]];
  const create = oldPath === null || section.create;
  const remove = newPath === null || section.delete;
  if ((create && newPath === null) || (remove && oldPath === null)) parseFault(section.line);
  return (tree) => {
    checkPaths(oldPath, newPath);
    if (create) {
      requireAbsent(tree, newPath!);
      const added = section.hunks.flatMap(({ body }) => body.filter((line) => line.kind === '+'));
      tree.now.set(newPath!, joinFile(added.map(({ text }) => text), '\n', !added.at(-1)?.noBreak));
      return;
    }
    const text = requireFile(tree, oldPath!);
    if (remove) {
      tree.now.set(oldPath!, null);
      return;
    }
    if (oldPath !== newPath) requireAbsent(tree, newPath!);
    const out = applyUnifiedHunks(text, section.hunks, oldPath!, strict);
    if (oldPath !== newPath) tree.move(oldPath!, newPath!, out);
    else tree.now.set(oldPath!, out);
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: UnifiedSection[] = [];
  let section: UnifiedSection | undefined;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^diff --git(?:\s|$)/.test(line)) {
      const git = /^diff --git a\/(.*?) b\/(.*)$/s.exec(line);
      if (git === null) parseFault(i);
      section = { line: i, git: [git[1]!, git[2]!], hunks: [] };
      sections.push(section);
    } else if (unifiedPair(lines, i)) {
      if (section === undefined || section.paths !== undefined || section.hunks.length > 0) {
        section = { line: i, hunks: [] };
        sections.push(section);
      }
      section.paths = [unifiedPath(line), unifiedPath(lines[++i]!)];
    } else if (line.startsWith('@@')) {
      if (section === undefined) parseFault(i);
      const { hunk, next } = readUnifiedHunk(lines, i);
      section.hunks.push(hunk);
      i = next - 1;
    } else if (section !== undefined && section.hunks.length === 0) {
      if (line.startsWith('--- ')) parseFault(i + 1);
      if (line.startsWith('rename from ')) section.renameFrom = line.slice('rename from '.length).trim();
      if (line.startsWith('rename to ')) section.renameTo = line.slice('rename to '.length).trim();
      if (line === 'new file mode' || line.startsWith('new file mode ')) section.create = true;
      if (line === 'deleted file mode' || line.startsWith('deleted file mode ')) section.delete = true;
    }
  }
  return sections.map((s) => unifiedEdit(s, strict));
}

type V4AChunk = { anchor: string; body: BodyLine[]; eof: boolean };

function applyV4AChunks(text: string, chunks: V4AChunk[], path: string, strict: boolean): string {
  const before = splitFile(text);
  let lines = before.lines;
  let cursor = 0;
  for (const { anchor, body, eof } of chunks) {
    if (anchor !== '') {
      const match = findLines(lines, [anchor], strict, cursor);
      if (match === null) throw new Fail('no-match', path);
      cursor = match.positions[0]! + 1;
    }
    const { old, added } = hunkLines(body);
    let at = eof ? lines.length : cursor;
    let tier: MatchTier = 0;
    if (old.length > 0) {
      const match = findLines(lines, old, strict, cursor, eof);
      if (match === null) throw new Fail('no-match', path);
      at = match.positions[0]!;
      tier = match.tier;
    }
    const written = replacement(added, old, lines, at, tier);
    lines = replaceLines(lines, at, old.length, written);
    cursor = at + written.length;
  }
  return joinFile(lines, before.br, before.final);
}

function v4aUpdate(lines: string[], header: number, end: number, path: string, strict: boolean): Edit {
  const move = '*** Move to: ';
  let i = header + 1;
  const destination = i < end && lines[i]!.startsWith(move) ? lines[i++]!.slice(move.length).trim() : null;
  const chunks: V4AChunk[] = [];
  let chunk: V4AChunk | undefined;
  for (; i < end; i++) {
    const line = lines[i]!;
    if (line.startsWith('@@')) {
      chunk = { anchor: line.slice(2).trim(), body: [], eof: false };
      chunks.push(chunk);
    } else if (line === '*** End of File') {
      if (chunk === undefined) parseFault(i);
      chunk.eof = true;
      chunk = undefined;
    } else {
      const body = readBodyLine(line);
      if (body === null) parseFault(i);
      if (chunk === undefined) {
        if (chunks.length > 0) parseFault(i);
        chunk = { anchor: '', body: [], eof: false };
        chunks.push(chunk);
      }
      chunk.body.push(body);
    }
  }
  if (chunks.length === 0 && destination === null) parseFault(header);
  return (tree) => {
    checkPaths(path, destination);
    const before = requireFile(tree, path);
    if (destination !== null) requireAbsent(tree, destination);
    const out = applyV4AChunks(before, chunks, path, strict);
    if (destination !== null) tree.move(path, destination, out);
    else tree.now.set(path, out);
  };
}

const V4A_SECTION = /^\*\*\* (Add|Delete|Update) File: (.*)$/s;

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((line) => !blank(line));
  if (first < 0 || lines[first]!.trim() !== '*** Begin Patch') parseFault(Math.max(0, first));
  const last = lines.findLastIndex((line) => !blank(line));
  if (lines[last]!.trim() !== '*** End Patch') parseFault(lines.length);
  const edits: Edit[] = [];
  for (let i = first + 1; i < last;) {
    if (blank(lines[i]!)) {
      i++;
      continue;
    }
    const section = V4A_SECTION.exec(lines[i]!);
    if (section === null) parseFault(i);
    const [, kind, name] = section;
    const path = name!.trim();
    let next = i + 1;
    while (next < last && !V4A_SECTION.test(lines[next]!)) next++;
    let end = next;
    while (end > i + 1 && blank(lines[end - 1]!)) end--;
    if (kind === 'Add') {
      const added: string[] = [];
      for (let j = i + 1; j < end; j++) {
        const line = lines[j]!;
        if (line !== '' && !line.startsWith('+')) parseFault(j);
        added.push(line.slice(1));
      }
      edits.push((tree) => {
        checkPaths(path);
        requireAbsent(tree, path);
        tree.now.set(path, joinFile(added));
      });
    } else if (kind === 'Delete') {
      if (end > i + 1) parseFault(i + 1);
      edits.push((tree) => {
        checkPaths(path);
        requireFile(tree, path);
        tree.now.set(path, null);
      });
    } else {
      edits.push(v4aUpdate(lines, i, end, path, strict));
    }
    i = next;
  }
  return edits;
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

function writeChanges(changes: Map<string, string | null>): void {
  const emptyDirectories = new Set<string>();
  for (const [path, text] of changes) {
    if (text !== null) continue;
    rmSync(path, { force: true });
    // A file can replace the directories that used to hold a deleted file.
    const ancestors: string[] = [];
    for (let dir = dirname(path); dir !== '.'; dir = dirname(dir)) {
      ancestors.push(dir);
      if (typeof changes.get(dir) === 'string') {
        for (const ancestor of ancestors) emptyDirectories.add(ancestor);
      }
    }
  }
  for (const dir of [...emptyDirectories].sort((a, b) => b.length - a.length)) rmdirSync(dir);
  for (const [path, text] of changes) {
    if (text === null) continue;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
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
    switch (kind) {
      case 'unified': edits = unifiedEdits(lines, strict); break;
      case 'search-replace': edits = searchReplaceEdits(lines, strict); break;
      case 'v4a': edits = v4aEdits(lines, strict); break;
      default: edits = jsonEdits(text, lines);
    }
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
  const additionsByMove = new Map<string, string>();
  const deletionsByMove = new Set<string>();
  for (const [oldPath, newPath] of tree.moves) {
    if (deletionsByMove.has(oldPath) || additionsByMove.has(newPath)) continue;
    if (tree.original(oldPath) === null || tree.get(oldPath) !== null) continue;
    if (tree.original(newPath) !== null || tree.get(newPath) === null) continue;
    deletionsByMove.add(oldPath);
    additionsByMove.set(newPath, oldPath);
  }
  const rows: string[] = [];
  const changes = new Map<string, string | null>();
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    changes.set(p, now);
    const movedFrom = additionsByMove.get(p);
    if (movedFrom !== undefined) rows.push(`R ${movedFrom} -> ${p}`);
    else if (!deletionsByMove.has(p)) rows.push(`${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`);
  }
  if (!check) writeChanges(changes);
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
