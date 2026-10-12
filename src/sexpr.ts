/**
 * A minimal S-expression READER for KiCad files — the reader half of the
 * one HeyPCB's KiCad plugin uses, ported, for the two facts an upload
 * needs: the sub-sheets a schematic names, and the libraries a library
 * table names. Iterative, so a deep file cannot overflow the stack.
 * A file that does not parse is an Error; callers decide what that means.
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
