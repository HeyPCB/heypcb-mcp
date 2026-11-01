/**
 * Which files of a local KiCad project `upload_kicad_project` sends — the
 * same set HeyPCB's KiCad plugin uploads and the server tracks for a
 * project, so a project an agent uploads holds what one synced from KiCad
 * holds (test/upload.test.ts walks the cases):
 *
 * - `<name>.kicad_pcb`, `<name>.kicad_pro`, `<name>.kicad_dru`;
 * - the root schematic `<name>.kicad_sch` and every sub-sheet reachable from
 *   it through `(sheet … (property "Sheetfile" …))`, resolved against the
 *   parent sheet's folder as KiCad does;
 * - `sym-lib-table`, `fp-lib-table`, and the PROJECT-LOCAL libraries they
 *   name (`${KIPRJMOD}/…`): `.kicad_sym` files, `.pretty` folders'
 *   `.kicad_mod` files, legacy `.lib`/`.dcm`.
 *
 * Never: 3D models, backups (`*-backups/`, `*.bak`, `*-bak`, `_autosave-*`),
 * `.history`, `.kicad_prl`, lock files, `fp-info-cache`, the `.heypcb/`
 * workspace folder, and whatever the project's `.heypcbignore` names (one
 * pattern a line, gitignore-style: `*`, `**`, a trailing `/` for a folder,
 * a pattern without `/` matching at any depth, `#` comments).
 *
 * Refused, nothing partial: a file or link that resolves outside the project
 * folder (`unsafe_path`), more than 50 MB in total (`project_too_large`, the
 * server's own import cap). Unlike the plugin, a project with no board yet
 * (only a schematic) is uploaded too: the import takes one.
 */
import { promises as fsp } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { refusal, RefusalError } from "./refusal.ts";
import { localLibraryUris, sheetFiles } from "./sexpr.ts";

export const MAX_PROJECT_BYTES = 50 * 1024 * 1024;
const MAX_SHEETS = 512;
const MODEL_EXTENSIONS = [".step", ".stp", ".wrl", ".wrz", ".iges", ".igs", ".glb", ".gltf", ".stl", ".vrml", ".x_t", ".3ds", ".obj", ".u3d", ".3mf"];
const BACKUP_DIR = /(-backups|^\.history|^#auto_saved_files#|^\.heypcb)$/i;
const BACKUP_FILE = /(^_autosave-|\.bak$|-bak$|\.lck$|^~|\.kicad_prl$|^fp-info-cache$|^#auto_saved_files#)/i;

const SYMLINK_FIX = "Replace the link with the file itself (copy it into the project folder), then call upload_kicad_project again.";
const TOO_LARGE_FIX = "Remove large files the project does not need from its folder (old exports, images), then call upload_kicad_project again.";

export type ProjectFile = { path: string; abspath: string; bytes: number; sha256: string; kind: string; data: Buffer };
export type Collection = {
  root: string;
  stem: string;
  files: ProjectFile[];
  totalBytes: number;
  skipped: Array<{ path: string; reason: string }>;
  missing: Array<{ path: string; kind: string }>;
};

export function expandHome(p: string, home: string = os.homedir()): string {
  if (p === "~") return home;
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(home, p.slice(2));
  return p;
}

/** Why a project-relative POSIX path is never uploaded, or null when it may be. */
export function excluded(rel: string): string | null {
  const parts = rel.split("/");
  for (const part of parts.slice(0, -1)) if (BACKUP_DIR.test(part)) return "backup";
  const name = parts[parts.length - 1];
  const lower = name.toLowerCase();
  if (MODEL_EXTENSIONS.some((e) => lower.endsWith(e))) return "3d_model";
  if (BACKUP_FILE.test(name)) return "backup";
  return null;
}

export const IGNORE_FILE = ".heypcbignore";

function globPart(glob: string): string {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      out += glob[i + 2] === "/" ? "(?:.*/)?" : ".*";
      i += glob[i + 2] === "/" ? 2 : 1;
    } else if (c === "*") out += "[^/]*";
    else if (c === "?") out += "[^/]";
    else out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return out;
}

/** A test for project-relative POSIX paths from `.heypcbignore`'s text. */
export function ignoreMatcher(text: string): (rel: string) => boolean {
  const res: RegExp[] = [];
  for (let line of text.split(/\r?\n/)) {
    line = line.trim();
    if (!line || line.startsWith("#")) continue;
    const dir = line.endsWith("/");
    if (dir) line = line.slice(0, -1);
    const anchored = line.includes("/");
    if (line.startsWith("/")) line = line.slice(1);
    const body = globPart(line);
    res.push(new RegExp(`^${anchored ? "" : "(?:.*/)?"}${body}${dir ? "/" : "(?:/|$)"}`));
  }
  return (rel) => res.some((r) => r.test(rel));
}

function tilde(p: string): string {
  const home = os.homedir();
  return p.startsWith(home) ? "~" + p.slice(home.length) : p;
}

async function lexists(p: string): Promise<boolean> {
  try {
    await fsp.lstat(p);
    return true;
  } catch {
    return false;
  }
}

class Walker {
  readonly root: string;
  realRoot = "";
  files = new Map<string, ProjectFile>();
  skipped: Array<{ path: string; reason: string }> = [];
  missing: Array<{ path: string; kind: string }> = [];
  ignored: (rel: string) => boolean = () => false;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  async init(): Promise<void> {
    this.realRoot = await fsp.realpath(this.root);
    const text = await fsp.readFile(path.join(this.root, IGNORE_FILE), "utf8").catch(() => null);
    if (text) this.ignored = ignoreMatcher(text);
  }

  rel(p: string): string {
    const full = path.resolve(p);
    const rel = path.relative(this.root, full);
    if (rel === "" || rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) {
      throw new RefusalError(refusal("unsafe_path", `${tilde(p)} is outside the project folder, so HeyPCB does not upload it.`, SYMLINK_FIX, { path: path.basename(p) }));
    }
    return rel.split(path.sep).join("/");
  }

  /** A link (the file or any folder above it) must land inside the project. */
  async checkReal(p: string, rel: string): Promise<boolean> {
    let real: string;
    try {
      real = await fsp.realpath(p);
    } catch {
      this.skipped.push({ path: rel, reason: "broken_link" });
      return false;
    }
    if (real !== this.realRoot && !real.startsWith(this.realRoot + path.sep)) {
      throw new RefusalError(refusal("unsafe_path", `${rel} is a link to a file outside the project folder, so HeyPCB does not upload it.`, SYMLINK_FIX, { path: rel }));
    }
    return true;
  }

  async add(p: string, kind: string): Promise<string | null> {
    const rel = this.rel(p);
    const why = excluded(rel) ?? (this.ignored(rel) ? "heypcbignore" : null);
    if (why) {
      this.skipped.push({ path: rel, reason: why });
      return null;
    }
    if (this.files.has(rel)) return rel;
    if (!(await lexists(p))) {
      this.missing.push({ path: rel, kind });
      return null;
    }
    if (!(await this.checkReal(p, rel))) return null;
    const st = await fsp.stat(p);
    if (!st.isFile()) {
      this.skipped.push({ path: rel, reason: "not_a_file" });
      return null;
    }
    if (st.size > MAX_PROJECT_BYTES) throw tooLarge(st.size, [{ path: rel, bytes: st.size }]);
    let data: Buffer;
    try {
      data = await fsp.readFile(p);
    } catch (err) {
      throw new RefusalError(
        refusal("project_file_unreadable", `HeyPCB could not read ${rel} (${(err as NodeJS.ErrnoException).code ?? (err as Error).message}).`, "Check that the file is readable and not locked by another program, then call upload_kicad_project again.", { path: rel })
      );
    }
    this.files.set(rel, { path: rel, abspath: path.resolve(p), bytes: data.length, sha256: createHash("sha256").update(data).digest("hex"), kind, data });
    return rel;
  }
}

function tooLarge(total: number, largest: Array<{ path: string; bytes: number }>): RefusalError {
  return new RefusalError(
    refusal("project_too_large", `This project's files add up to ${(total / 1e6).toFixed(1)} MB; HeyPCB takes at most ${MAX_PROJECT_BYTES / (1024 * 1024)} MB.`, TOO_LARGE_FIX, {
      totalBytes: total,
      largest,
    })
  );
}

async function walkSheets(w: Walker, rootSch: string): Promise<void> {
  const queue = [rootSch];
  const seen = new Set<string>();
  while (queue.length) {
    const current = queue.shift()!;
    const rel = w.rel(current);
    if (seen.has(rel)) continue;
    seen.add(rel);
    if (seen.size > MAX_SHEETS) throw new RefusalError(refusal("project_too_large", `This schematic names more than ${MAX_SHEETS} sheets.`, TOO_LARGE_FIX));
    const added = await w.add(current, "schematic");
    if (!added) continue;
    let children: string[];
    try {
      children = sheetFiles(w.files.get(added)!.data.toString("utf8"));
    } catch {
      continue; // KiCad will say so when it opens it; the file goes up as it is
    }
    const base = path.dirname(current);
    for (const raw of children) {
      const name = raw.replace(/\\/g, "/");
      const target = path.isAbsolute(name) || /^[A-Za-z]:\//.test(name) ? name : path.join(base, ...name.split("/"));
      queue.push(path.normalize(target));
    }
  }
}

async function addLibrary(w: Walker, relUri: string): Promise<void> {
  const p = path.normalize(path.join(w.root, ...relUri.split("/").filter(Boolean)));
  const rel = w.rel(p); // refuses a ${KIPRJMOD}/../ escape
  let isDir = false;
  try {
    isDir = (await fsp.stat(p)).isDirectory();
  } catch {
    isDir = false;
  }
  if (isDir) {
    if (!(await w.checkReal(p, rel))) return;
    for (const name of (await fsp.readdir(p)).sort()) {
      const full = path.join(p, name);
      const lower = name.toLowerCase();
      if (!(lower.endsWith(".kicad_mod") || lower.endsWith(".kicad_sym"))) continue;
      try {
        if (!(await fsp.stat(full)).isFile()) continue;
      } catch {
        continue;
      }
      await w.add(full, lower.endsWith(".kicad_mod") ? "footprint" : "symbol_library");
    }
    return;
  }
  await w.add(p, "symbol_library");
  if (p.toLowerCase().endsWith(".lib")) {
    const dcm = p.slice(0, -4) + ".dcm";
    if (await lexists(dcm)) await w.add(dcm, "symbol_library");
  }
}

/** The tracked files of the project `<root>/<stem>.*`. */
export async function collectProject(root: string, stem: string): Promise<Collection> {
  const w = new Walker(root);
  await w.init();
  await w.add(path.join(w.root, stem + ".kicad_pcb"), "board");
  await w.add(path.join(w.root, stem + ".kicad_pro"), "project");
  await w.add(path.join(w.root, stem + ".kicad_dru"), "rules");
  const rootSch = path.join(w.root, stem + ".kicad_sch");
  if (await lexists(rootSch)) await walkSheets(w, rootSch);
  for (const [table, kind] of [
    ["sym-lib-table", "sym_lib_table"],
    ["fp-lib-table", "fp_lib_table"],
  ] as const) {
    const rel = await w.add(path.join(w.root, table), kind);
    if (!rel) continue;
    for (const [, relUri] of localLibraryUris(w.files.get(rel)!.data.toString("utf8"))) await addLibrary(w, relUri);
  }
  const files = [...w.files.values()].sort((a, b) => (a.kind === "board" ? 0 : 1) - (b.kind === "board" ? 0 : 1) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (!files.some((f) => f.kind === "board" || f.kind === "schematic")) {
    throw new RefusalError(
      refusal("no_board", `${tilde(path.join(w.root, stem))} has no .kicad_pcb and no .kicad_sch to upload.`, "Save the board or schematic in KiCad first, then call upload_kicad_project again with the project folder.")
    );
  }
  // Only a missing sheet or library is news: the .kicad_pro, .kicad_dru and lib tables are optional.
  const missing = w.missing.filter((m) => !["project", "rules", "sym_lib_table", "fp_lib_table", "board"].includes(m.kind));
  const total = files.reduce((n, f) => n + f.bytes, 0);
  if (total > MAX_PROJECT_BYTES) {
    throw tooLarge(
      total,
      [...files].sort((a, b) => b.bytes - a.bytes).slice(0, 3).map((f) => ({ path: f.path, bytes: f.bytes }))
    );
  }
  return { root: w.root, stem, files, totalBytes: total, skipped: w.skipped, missing };
}

const PROJECT_EXTS = [".kicad_pro", ".kicad_pcb", ".kicad_sch"];
const SKIP_DIRS = /^(node_modules|\..*|.*-backups|#auto_saved_files#)$/i;

async function listByExt(dir: string, ext: string): Promise<string[]> {
  try {
    const names = await fsp.readdir(dir, { withFileTypes: true });
    return names.filter((d) => (d.isFile() || d.isSymbolicLink()) && d.name.toLowerCase().endsWith(ext) && !excluded(d.name)).map((d) => path.join(dir, d.name)).sort();
  } catch {
    return [];
  }
}

/** `.kicad_pro` files at most `depth` folders below `dir` (hidden folders, backups and node_modules skipped). */
async function findDeep(dir: string, ext: string, depth: number, budget = { left: 5000 }): Promise<string[]> {
  const out = await listByExt(dir, ext);
  if (depth <= 0) return out;
  let entries: import("node:fs").Dirent[] = [];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const d of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (--budget.left < 0) break;
    if (!d.isDirectory() || SKIP_DIRS.test(d.name)) continue;
    out.push(...(await findDeep(path.join(dir, d.name), ext, depth - 1, budget)));
  }
  return out;
}

function several(found: string[], base: string, what: string): RefusalError {
  const list = found.slice(0, 10).map((f) => path.relative(base, f) || path.basename(f));
  return new RefusalError(
    refusal("several_projects", `${tilde(base)} holds ${found.length} ${what} files, so HeyPCB cannot tell which project you mean.`, "Call upload_kicad_project again with `path` set to the .kicad_pro (or .kicad_pcb) file of the project you mean.", {
      candidates: list,
    })
  );
}

/** The project a path names: its folder and file stem. */
export async function locateProject(input: string, home: string = os.homedir()): Promise<{ root: string; stem: string }> {
  if (typeof input !== "string" || !input.trim()) {
    throw new RefusalError(refusal("bad_path", "`path` is empty.", "Pass the KiCad project's folder, or its .kicad_pro file, as `path`."));
  }
  const abs = path.resolve(expandHome(input.trim(), home));
  let st: import("node:fs").Stats;
  try {
    st = await fsp.stat(abs);
  } catch {
    throw new RefusalError(refusal("not_found", `${tilde(abs)} does not exist on this computer.`, "Check the path (an absolute path is safest), then call upload_kicad_project again."));
  }
  if (st.isFile()) {
    const lower = abs.toLowerCase();
    const ext = PROJECT_EXTS.find((e) => lower.endsWith(e));
    if (!ext) {
      throw new RefusalError(refusal("not_kicad", `${tilde(abs)} is not a KiCad project file.`, "Pass the project's folder, or its .kicad_pro, .kicad_pcb or .kicad_sch file."));
    }
    return { root: path.dirname(abs), stem: path.basename(abs).slice(0, -ext.length) };
  }
  if (!st.isDirectory()) throw new RefusalError(refusal("not_kicad", `${tilde(abs)} is neither a folder nor a KiCad file.`, "Pass the KiCad project's folder, or its .kicad_pro file."));
  const stemOf = (f: string, ext: string) => ({ root: path.dirname(f), stem: path.basename(f).slice(0, -ext.length) });
  for (const ext of [".kicad_pro", ".kicad_pcb"]) {
    const top = await listByExt(abs, ext);
    if (top.length === 1) return stemOf(top[0], ext);
    if (top.length > 1) throw several(top, abs, ext);
  }
  for (const ext of [".kicad_pro", ".kicad_pcb"]) {
    const deep = await findDeep(abs, ext, 3);
    if (deep.length === 1) return stemOf(deep[0], ext);
    if (deep.length > 1) throw several(deep, abs, ext);
  }
  const sch = await listByExt(abs, ".kicad_sch");
  if (sch.length === 1) return stemOf(sch[0], ".kicad_sch");
  throw new RefusalError(
    refusal("no_project", `HeyPCB found no KiCad project (.kicad_pro or .kicad_pcb) in ${tilde(abs)}.`, "Pass the folder that holds the project's .kicad_pro, or the .kicad_pro / .kicad_pcb file itself.")
  );
}
