/**
 * A minimal S-expression reader for KiCad files — the reader half of the
 * one HeyPCB's KiCad plugin uses, ported, for the facts an upload needs:
 * the sub-sheets a schematic names, and the libraries a library table
 * names — plus the in-place edits `install_parts` makes (merge a symbol
 * into a library, add a library to a lib table). Iterative, so a deep file
 * cannot overflow the stack. A file that does not parse is an Error;
 * callers decide what that means.
 */
export type Atom = string;
export type Node = Array<Atom | Node>;

const TOKEN = /\s*(?:(\()|(\))|"((?:[^"\\]|\\.)*)"|([^\s()"]+))/sy;
const ESC: Record<string, string> = { n: "\n", t: "\t", r: "\r", "\\": "\\", '"': '"' };

function unescape(s: string): string {
  return s.replace(/\\(.)/gs, (_m, c: string) => ESC[c] ?? c);
}

export function parse(text: string): Node {
  const stack: Node[] = [];
  let root: Node | null = null;
  let pos = 0;
  const n = text.length;
  while (pos < n) {
    TOKEN.lastIndex = pos;
    const m = TOKEN.exec(text);
    if (!m) {
      if (text.slice(pos).trim() === "") break;
      throw new Error(`bad s-expression near offset ${pos}`);
    }
    pos = TOKEN.lastIndex;
    if (m[1]) {
      const node: Node = [];
      if (stack.length) stack[stack.length - 1].push(node);
      stack.push(node);
    } else if (m[2]) {
      if (!stack.length) throw new Error(`unbalanced ')' at offset ${pos}`);
      const done = stack.pop()!;
      if (!stack.length) {
        root = done;
        break;
      }
    } else if (!stack.length) {
      throw new Error(`an atom outside any list at offset ${pos}`);
    } else if (m[3] !== undefined) {
      stack[stack.length - 1].push(unescape(m[3]));
    } else {
      stack[stack.length - 1].push(m[4]);
    }
  }
  if (!root) throw new Error("no complete s-expression found");
  return root;
}

export function findAll(node: Node, head: string): Node[] {
  return node.slice(1).filter((c): c is Node => Array.isArray(c) && c.length > 0 && c[0] === head);
}

export function find(node: Node, head: string): Node | null {
  return findAll(node, head)[0] ?? null;
}

export function value(node: Node | null, idx = 1): string | null {
  if (!node || node.length <= idx) return null;
  const v = node[idx];
  return typeof v === "string" ? v : null;
}

function prop(node: Node, name: string): string | null {
  for (const p of findAll(node, "property")) {
    if (p.length > 2 && p[1] === name && typeof p[2] === "string") return p[2];
  }
  return null;
}

/** The `Sheetfile` of every `(sheet …)` in one schematic (older files say `Sheet file`). */
export function sheetFiles(text: string): string[] {
  const root = parse(text);
  if (root[0] !== "kicad_sch") throw new Error("not a kicad_sch file");
  const out: string[] = [];
  for (const sheet of findAll(root, "sheet")) {
    const name = prop(sheet, "Sheetfile") ?? prop(sheet, "Sheet file");
    if (name) out.push(name);
  }
  return out;
}

const KIPRJMOD = /^\$\{KIPRJMOD\}[\\/]?|^\$\(KIPRJMOD\)[\\/]?/;

/** (type, path under the project) of each library a lib table names with ${KIPRJMOD}. */
export function localLibraryUris(tableText: string): Array<[string, string]> {
  let root: Node;
  try {
    root = parse(tableText);
  } catch {
    return [];
  }
  const out: Array<[string, string]> = [];
  for (const lib of findAll(root, "lib")) {
    const uri = value(find(lib, "uri")) ?? "";
    const kind = value(find(lib, "type")) ?? "";
    const m = KIPRJMOD.exec(uri);
    if (m) out.push([kind, uri.slice(m[0].length).replace(/\\/g, "/")]);
  }
  return out;
}

/*
 * Editing in place. KiCad files are hand-diffed and kept in git, so an edit
 * splices text at the offsets of the nodes it changes and leaves every other
 * byte — formatting, comments-by-convention, unknown sections — as it was.
 */

export type SpanAtom = { start: number; end: number; value: string; quoted: boolean };
export type SpanNode = { start: number; end: number; items: Array<SpanAtom | SpanNode> };

export function isNode(x: SpanAtom | SpanNode | undefined): x is SpanNode {
  return !!x && "items" in x;
}

/** The first complete s-expression in `text`, with the offset of every node and atom. */
export function parseSpans(text: string): SpanNode {
  const stack: SpanNode[] = [];
  let pos = 0;
  const n = text.length;
  while (pos < n) {
    TOKEN.lastIndex = pos;
    const m = TOKEN.exec(text);
    if (!m) {
      if (text.slice(pos).trim() === "") break;
      throw new Error(`bad s-expression near offset ${pos}`);
    }
    const end = TOKEN.lastIndex;
    const start = end - m[0].trimStart().length;
    pos = end;
    if (m[1]) {
      const node: SpanNode = { start, end: -1, items: [] };
      if (stack.length) stack[stack.length - 1].items.push(node);
      stack.push(node);
    } else if (m[2]) {
      if (!stack.length) throw new Error(`unbalanced ')' at offset ${start}`);
      const done = stack.pop()!;
      done.end = end;
      if (!stack.length) return done;
    } else if (!stack.length) {
      throw new Error(`an atom outside any list at offset ${start}`);
    } else if (m[3] !== undefined) {
      stack[stack.length - 1].items.push({ start, end, value: unescape(m[3]), quoted: true });
    } else {
      stack[stack.length - 1].items.push({ start, end, value: m[4], quoted: false });
    }
  }
  throw new Error("no complete s-expression found");
}

export function headOf(node: SpanNode): string | null {
  const h = node.items[0];
  return h && !isNode(h) ? h.value : null;
}

/** The atom at `idx` of a node, or null. */
export function atomAt(node: SpanNode | null, idx: number): SpanAtom | null {
  const a = node?.items[idx];
  return a && !isNode(a) ? a : null;
}

export function childrenNamed(node: SpanNode, head: string): SpanNode[] {
  return node.items.filter((c): c is SpanNode => isNode(c) && headOf(c) === head);
}

/** A string as KiCad writes it: always quoted, `\` and `"` escaped, newlines as \n. */
export function quote(s: string): string {
  return '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n") + '"';
}

export type Splice = { start: number; end: number; text: string };

/** Apply non-overlapping splices (any order). */
export function applySplices(text: string, splices: Splice[]): string {
  let out = text;
  for (const s of [...splices].sort((a, b) => b.start - a.start)) out = out.slice(0, s.start) + s.text + out.slice(s.end);
  return out;
}

/** Text inserted as the last child of `node`, on its own line, indented like its other children. */
export function appendChild(text: string, node: SpanNode, child: string): Splice {
  const close = node.end - 1;
  const last = node.items[node.items.length - 1];
  const lineStart = last ? text.lastIndexOf("\n", last.start) + 1 : -1;
  const indent = last && lineStart > node.start ? /^[\t ]*/.exec(text.slice(lineStart))![0] : "  ";
  const before = text.slice(0, close).replace(/[\t ]*$/, "");
  const trimmed = close - before.length;
  return { start: close - trimmed, end: close, text: (before.endsWith("\n") ? "" : "\n") + indent + child + "\n" };
}

/**
 * Merge `(symbol "NAME" …)` entries into a `.kicad_sym` library: a new name
 * is appended, a name already there is replaced only when its text differs.
 * Never duplicates a name.
 */
export function mergeSymbols(libText: string, symbols: Array<{ name: string; text: string }>): { text: string; added: string[]; updated: string[]; unchanged: string[] } {
  const added: string[] = [];
  const updated: string[] = [];
  const unchanged: string[] = [];
  let text = libText;
  for (const sym of symbols) {
    const root = parseSpans(text);
    if (headOf(root) !== "kicad_symbol_lib") throw new Error("not a kicad_symbol_lib file");
    const existing = childrenNamed(root, "symbol").find((s) => atomAt(s, 1)?.value === sym.name);
    if (existing) {
      if (text.slice(existing.start, existing.end) === sym.text) {
        unchanged.push(sym.name);
        continue;
      }
      text = applySplices(text, [{ start: existing.start, end: existing.end, text: sym.text }]);
      updated.push(sym.name);
    } else {
      text = applySplices(text, [appendChild(text, root, sym.text)]);
      added.push(sym.name);
    }
  }
  return { text, added, updated, unchanged };
}

/** Set a `(property "NAME" "VALUE" …)` child's value in place; null when the node has no such property. */
export function setProperty(text: string, node: SpanNode, name: string, value: string): string | null {
  const p = childrenNamed(node, "property").find((c) => atomAt(c, 1)?.value === name);
  const v = p ? atomAt(p, 2) : null;
  if (!v) return null;
  return applySplices(text, [{ start: v.start, end: v.end, text: quote(value) }]);
}

/** The libraries a lib table names: name, uri, and the node itself. */
export function tableLibs(text: string): Array<{ name: string; uri: string; node: SpanNode }> {
  const root = parseSpans(text);
  return childrenNamed(root, "lib").map((lib) => ({
    name: atomAt(childrenNamed(lib, "name")[0] ?? null, 1)?.value ?? "",
    uri: atomAt(childrenNamed(lib, "uri")[0] ?? null, 1)?.value ?? "",
    node: lib,
  }));
}

/** A lib table with `name` → `uri` in it: added when missing, left alone when a library of that name is already there. */
export function ensureTableLib(
  text: string | null,
  table: "sym_lib_table" | "fp_lib_table",
  lib: { name: string; uri: string; descr: string }
): { text: string; status: "added" | "present" | "name_taken"; uri?: string } {
  const entry = `(lib (name ${quote(lib.name)})(type "KiCad")(uri ${quote(lib.uri)})(options "")(descr ${quote(lib.descr)}))`;
  if (text === null || !text.trim()) return { text: `(${table}\n  (version 7)\n  ${entry}\n)\n`, status: "added" };
  const root = parseSpans(text);
  if (headOf(root) !== table) throw new Error(`not a ${table} file`);
  const same = tableLibs(text).find((l) => l.name === lib.name);
  if (same) return { text, status: same.uri === lib.uri ? "present" : "name_taken", uri: same.uri };
  return { text: applySplices(text, [appendChild(text, root, entry)]), status: "added" };
}

/** The `(version N)` of a KiCad file's root, or null. */
export function fileVersion(text: string): number | null {
  const m = /^\s*\(\s*[a-z_]+\s[\s\S]{0,200}?\(version\s+(\d+)\)/.exec(text);
  return m ? Number(m[1]) : null;
}
