/**
 * A bound workspace: a KiCad project folder on this computer tied to ONE
 * HeyPCB project, which shadows it. HeyPCB's tools keep running on the
 * server; this module keeps the two copies in step around each call:
 *
 * - push, before a call: the tracked files (the set `upload_kicad_project`
 *   sends, see kicad-files.ts) whose bytes changed here since the last sync
 *   go up in one `PUT /v1/projects/{id}/files` that names the revision they
 *   were based on. If HeyPCB's copy moved on meanwhile (an edit on the web)
 *   the server answers 409 and nothing is overwritten on either side
 *   (`workspace_conflict`).
 * - pull, after a call that changed the design: the files whose hash on
 *   HeyPCB differs from the one last synced come down. The file here is
 *   copied to `.heypcb/backup/<revision>/` first and replaced atomically
 *   (temp file + rename). A file that was ALSO changed here since the push —
 *   saved in KiCad while the call ran — is never overwritten: HeyPCB's
 *   version is written beside it as `<file>.heypcb-new` and further syncs
 *   stop until the conflict is resolved (`open_kicad_project` with
 *   `on_conflict`).
 *
 * State lives in `<project>/.heypcb/workspace.json`. For each file it keeps
 * two hashes — the bytes here and the bytes on HeyPCB at the last sync —
 * because the server may store a file normalised; comparing each side with
 * its own last-seen hash never mistakes that for an edit.
 *
 * The server's file API, as this client uses it:
 *   GET  /v1/projects/{id}/files                 → { ok, revision, files: [{ path, sha256, bytes }] }
 *   GET  /v1/projects/{id}/files/content?path=…  → the file's bytes
 *   PUT  /v1/projects/{id}/files                 { baseRevision, files: [{ path, sha256, contentBase64 }], delete: [path] }
 *                                                → { ok, revision, files } | 409 { ok:false, code, revision }
 */
import { createHash, randomUUID } from "node:crypto";
import { promises as fsp } from "node:fs";
import path from "node:path";
import type { Auth } from "./auth.ts";
import type { Config } from "./config.ts";
import { anySignal, networkRefusal, responseRefusal } from "./http.ts";
import { collectProject } from "./kicad-files.ts";
import { refusal, RefusalError, type Refusal } from "./refusal.ts";
import { writeInside } from "./safe-path.ts";

export const WORKSPACE_DIR = ".heypcb";
export const WORKSPACE_FILE = "workspace.json";
export const NEW_SUFFIX = ".heypcb-new";

export type FileRecord = { local: string; remote: string };

export type WorkspaceState = {
  version: 1;
  projectId: string;
  apiBase: string;
  /** The KiCad project's file stem: `<stem>.kicad_pro`. */
  stem: string;
  /** HeyPCB's revision at the last sync. */
  revision: string | null;
  files: Record<string, FileRecord>;
  /** Files with a `<file>.heypcb-new` beside them, waiting to be resolved. */
  conflicts: string[];
  boundAt: string;
};

export type ApiContext = { config: Config; auth: Auth };

function sha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Run one task at a time per workspace: a pull must never interleave with another call's push. */
class Lock {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.catch(() => {});
    return next;
  }
}

export class Workspace {
  readonly root: string;
  state: WorkspaceState;
  readonly lock = new Lock();

  constructor(root: string, state: WorkspaceState) {
    this.root = root;
    this.state = state;
  }

  get dir(): string {
    return path.join(this.root, WORKSPACE_DIR);
  }

  static file(root: string): string {
    return path.join(root, WORKSPACE_DIR, WORKSPACE_FILE);
  }

  /** The binding in `root`, or null when the folder is not bound. A file that does not read as one is a refusal. */
  static async load(root: string): Promise<Workspace | null> {
    let text: string;
    try {
      text = await fsp.readFile(Workspace.file(root), "utf8");
    } catch {
      return null;
    }
    let s: WorkspaceState;
    try {
      s = JSON.parse(text);
    } catch {
      s = {} as WorkspaceState;
    }
    if (s?.version !== 1 || typeof s.projectId !== "string" || typeof s.apiBase !== "string" || typeof s.stem !== "string" || !s.files || typeof s.files !== "object") {
      throw new RefusalError(
        refusal("workspace_unreadable", `${path.join(WORKSPACE_DIR, WORKSPACE_FILE)} in ${root} is not a HeyPCB workspace file this version reads.`, "Call open_kicad_project again with `rebind: true` to bind the folder afresh (it uploads the project as a new HeyPCB project).")
      );
    }
    s.conflicts = Array.isArray(s.conflicts) ? s.conflicts : [];
    return new Workspace(root, s);
  }

  async save(): Promise<void> {
    await writeInside(this.root, `${WORKSPACE_DIR}/${WORKSPACE_FILE}`, Buffer.from(JSON.stringify(this.state, null, 2) + "\n"));
  }

  abs(rel: string): string {
    return path.join(this.root, ...rel.split("/"));
  }
}

/** `.heypcb/` in the project's .gitignore when the folder is inside a git work tree. */
export async function ignoreInGit(root: string): Promise<boolean> {
  let dir = root;
  for (;;) {
    try {
      await fsp.lstat(path.join(dir, ".git"));
      break;
    } catch {
      const up = path.dirname(dir);
      if (up === dir) return false;
      dir = up;
    }
  }
  const file = path.join(root, ".gitignore");
  const text = await fsp.readFile(file, "utf8").catch(() => "");
  if (text.split(/\r?\n/).some((l) => /^\/?\.heypcb\/?$/.test(l.trim()))) return false;
  await fsp.writeFile(file, (text && !text.endsWith("\n") ? text + "\n" : text) + `${WORKSPACE_DIR}/\n`);
  return true;
}

export type RemoteFile = { path: string; sha256: string; bytes?: number };
export type Listing = { revision: string; files: RemoteFile[] };

function listingOf(body: unknown): Listing | null {
  const b = body as { revision?: unknown; files?: unknown } | null;
  if (!b || typeof b.revision !== "string" || !Array.isArray(b.files)) return null;
  const files = b.files.filter((f): f is RemoteFile => !!f && typeof f.path === "string" && typeof f.sha256 === "string");
  return { revision: b.revision, files };
}

/** The REST half of the file API. Every failure is a RefusalError. */
export class FileApi {
  constructor(private readonly ctx: ApiContext) {}

  private url(id: string, tail = ""): string {
    return `${this.ctx.config.apiBase}/v1/projects/${encodeURIComponent(id)}/files${tail}`;
  }

  private async fetch(url: string, init: RequestInit, what: string, signal?: AbortSignal, ms = 120_000): Promise<Response> {
    try {
      return await this.ctx.auth.fetch(url, { ...init, signal: signal ? anySignal(signal, ms) : AbortSignal.timeout(ms) });
    } catch (err) {
      if (err instanceof RefusalError || signal?.aborted) throw err;
      throw new RefusalError(networkRefusal(err, what));
    }
  }

  async list(id: string, signal?: AbortSignal): Promise<Listing> {
    const res = await this.fetch(this.url(id), { headers: { accept: "application/json" } }, "the project's file list", signal);
    if (!res.ok) throw new RefusalError(await responseRefusal(res, "the project's file list"));
    const listing = listingOf(await res.json().catch(() => null));
    if (!listing) throw new RefusalError(refusal("bad_answer", "HeyPCB answered the file list in a shape this version does not read.", "Update with `npx -y @heypcb/mcp@latest`, then call the tool again."));
    return listing;
  }

  async download(id: string, rel: string, signal?: AbortSignal): Promise<Buffer> {
    const res = await this.fetch(this.url(id, `/content?path=${encodeURIComponent(rel)}`), { headers: { accept: "*/*" } }, `${rel}`, signal, 300_000);
    if (!res.ok) throw new RefusalError(await responseRefusal(res, `the file ${rel}`));
    return Buffer.from(await res.arrayBuffer());
  }

  /** Upload changed files and deletions against `baseRevision`. A 409 comes back as `conflict`, not thrown. */
  async put(id: string, baseRevision: string | null, files: Array<{ path: string; data: Buffer; sha256: string }>, del: string[], signal?: AbortSignal): Promise<{ conflict: false; listing: Listing } | { conflict: true; revision: string | null }> {
    const body = JSON.stringify({
      baseRevision,
      files: files.map((f) => ({ path: f.path, sha256: f.sha256, contentBase64: f.data.toString("base64") })),
      delete: del,
    });
    const res = await this.fetch(this.url(id), { method: "PUT", headers: { "content-type": "application/json", accept: "application/json", "idempotency-key": randomUUID() }, body }, "the upload of your changes", signal, 300_000);
    if (res.status === 409) {
      const b = (await res.json().catch(() => null)) as { revision?: unknown } | null;
      return { conflict: true, revision: typeof b?.revision === "string" ? b.revision : null };
    }
    if (!res.ok) throw new RefusalError(await responseRefusal(res, "the upload of your changes"));
    const listing = listingOf(await res.json().catch(() => null));
    if (!listing) throw new RefusalError(refusal("bad_answer", "HeyPCB answered the upload of your changes in a shape this version does not read.", "Update with `npx -y @heypcb/mcp@latest`, then call the tool again."));
    return { conflict: false, listing };
  }
}

/** A server path that is safe to write under the project: relative, no `..`, not into .heypcb/ or .git/. */
export function safeRel(rel: string): boolean {
  if (!rel || rel.length > 1024 || /[\0\\]/.test(rel) || rel.startsWith("/") || /^[A-Za-z]:/.test(rel)) return false;
  const parts = rel.split("/");
  if (parts.some((p) => p === "" || p === "." || p === "..")) return false;
  return parts[0] !== WORKSPACE_DIR && parts[0] !== ".git";
}

async function readIfFile(p: string): Promise<Buffer | null> {
  try {
    const st = await fsp.lstat(p);
    if (!st.isFile()) return null;
    return await fsp.readFile(p);
  } catch {
    return null;
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await fsp.lstat(p);
    return true;
  } catch {
    return false;
  }
}

/** KiCad holds `~<name>.lck` beside a file it has open. */
async function openInKicad(abs: string): Promise<boolean> {
  return exists(path.join(path.dirname(abs), `~${path.basename(abs)}.lck`));
}

function backupName(revision: string | null): string {
  return (revision ?? "unsynced").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 100) || "unsynced";
}

function conflictRefusal(ws: Workspace, what: string): Refusal {
  return refusal(
    "workspace_conflict",
    what,
    "Ask the user which copy to keep, then call open_kicad_project with this `path` and `on_conflict`: \"take_heypcb\" (HeyPCB's copy replaces the files here; they are backed up in .heypcb/backup/ first) or \"keep_local\" (the files here replace HeyPCB's).",
    { path: ws.root, conflicts: ws.state.conflicts }
  );
}

export type PushResult = { pushed: string[]; deleted: string[] };
export type PullResult = { changed: string[]; deleted: string[]; conflicts: string[]; openInKicad: string[]; kept: string[]; backup: string | null };

/** Send the files changed here. `force`: against HeyPCB's current revision, whatever changed there (keep_local). */
export async function push(ws: Workspace, api: FileApi, opts: { force?: boolean; signal?: AbortSignal } = {}): Promise<PushResult> {
  if (!opts.force && ws.state.conflicts.length) {
    throw new RefusalError(conflictRefusal(ws, `HeyPCB changed ${ws.state.conflicts.join(", ")} while the copy here changed too, so syncing waits until one of them is chosen (HeyPCB's copy is beside each as ${NEW_SUFFIX}).`));
  }
  const col = await collectProject(ws.root, ws.state.stem);
  const local = new Map(col.files.map((f) => [f.path, f]));
  const put = col.files.filter((f) => ws.state.files[f.path]?.local !== f.sha256);
  const del: string[] = [];
  for (const rel of Object.keys(ws.state.files)) if (!local.has(rel) && !(await exists(ws.abs(rel)))) del.push(rel);
  if (!put.length && !del.length && !opts.force) return { pushed: [], deleted: [] };
  const base = opts.force ? (await api.list(ws.state.projectId, opts.signal)).revision : ws.state.revision;
  if (opts.force && !put.length && !del.length) {
    ws.state.revision = base;
    await ws.save();
    return { pushed: [], deleted: [] };
  }
  const r = await api.put(ws.state.projectId, base, put.map((f) => ({ path: f.path, data: f.data, sha256: f.sha256 })), del, opts.signal);
  if (r.conflict) {
    throw new RefusalError(conflictRefusal(ws, `HeyPCB's copy of this project changed (revision ${r.revision ?? "?"}) since this folder last synced (${ws.state.revision ?? "?"}), and files here changed too: ${[...put.map((f) => f.path), ...del].join(", ")}. Nothing was overwritten.`));
  }
  const remote = new Map(r.listing.files.map((f) => [f.path, f.sha256]));
  for (const f of put) ws.state.files[f.path] = { local: f.sha256, remote: remote.get(f.path) ?? f.sha256 };
  for (const rel of del) delete ws.state.files[rel];
  ws.state.revision = r.listing.revision;
  await ws.save();
  return { pushed: put.map((f) => f.path), deleted: del };
}

/**
 * Bring HeyPCB's changes here. `knownRevision`: the revision a tool result
 * reported; when it is the one already synced, nothing is asked. `full`:
 * compare every file even when the revision is the synced one (after a
 * forced push, which moves the revision past changes not yet pulled).
 * `takeHeypcb`: HeyPCB's copy wins over edits here too (they are backed up).
 */
export async function pull(ws: Workspace, api: FileApi, opts: { knownRevision?: string | null; full?: boolean; takeHeypcb?: boolean; signal?: AbortSignal } = {}): Promise<PullResult> {
  const out: PullResult = { changed: [], deleted: [], conflicts: [], openInKicad: [], kept: [], backup: null };
  const full = opts.full || opts.takeHeypcb;
  if (!full && opts.knownRevision && opts.knownRevision === ws.state.revision) return out;
  const listing = await api.list(ws.state.projectId, opts.signal);
  if (!full && listing.revision === ws.state.revision) return out;

  const backupRel = `${WORKSPACE_DIR}/backup/${backupName(ws.state.revision)}`;
  const backup = async (rel: string, data: Buffer) => {
    await writeInside(ws.root, `${backupRel}/${rel}`, data);
    out.backup = path.join(ws.root, ...backupRel.split("/"));
  };
  const conflicts = new Set(opts.takeHeypcb ? [] : ws.state.conflicts);
  const onServer = new Set<string>();

  for (const f of listing.files) {
    if (!safeRel(f.path)) continue;
    onServer.add(f.path);
    const rec = ws.state.files[f.path];
    const abs = ws.abs(f.path);
    const cur = await readIfFile(abs);
    const curSha = cur ? sha256(cur) : null;
    if (curSha === f.sha256) {
      ws.state.files[f.path] = { local: f.sha256, remote: f.sha256 };
      continue;
    }
    if (rec && rec.remote === f.sha256 && !opts.takeHeypcb) continue; // unchanged on HeyPCB
    const data = await api.download(ws.state.projectId, f.path, opts.signal);
    if (sha256(data) !== f.sha256) {
      throw new RefusalError(refusal("download_corrupt", `${f.path} arrived from HeyPCB with different bytes than HeyPCB listed.`, "Call the tool again; nothing here was overwritten.", { retryable: true }));
    }
    // Changed here since the last sync (a save in KiCad while the call ran, or before it): never overwrite.
    const editedHere = cur !== null && (!rec || curSha !== rec.local);
    if (editedHere && !opts.takeHeypcb) {
      await writeInside(ws.root, f.path + NEW_SUFFIX, data);
      ws.state.files[f.path] = { local: rec?.local ?? "", remote: f.sha256 };
      conflicts.add(f.path);
      out.conflicts.push(f.path);
      continue;
    }
    if (cur) await backup(f.path, cur);
    await writeInside(ws.root, f.path, data);
    if (await openInKicad(abs)) out.openInKicad.push(f.path);
    ws.state.files[f.path] = { local: f.sha256, remote: f.sha256 };
    conflicts.delete(f.path);
    out.changed.push(f.path);
  }

  for (const rel of Object.keys(ws.state.files)) {
    if (onServer.has(rel)) continue;
    const rec = ws.state.files[rel];
    delete ws.state.files[rel];
    const cur = await readIfFile(ws.abs(rel));
    if (!cur) continue;
    if (sha256(cur) !== rec.local && !opts.takeHeypcb) {
      out.kept.push(rel); // HeyPCB removed a file that changed here: the file stays, and the next push sends it again
      continue;
    }
    await backup(rel, cur);
    await fsp.rm(ws.abs(rel), { force: true });
    out.deleted.push(rel);
  }

  if (opts.takeHeypcb) for (const rel of ws.state.conflicts) await fsp.rm(ws.abs(rel) + NEW_SUFFIX, { force: true });
  ws.state.conflicts = [...conflicts].sort();
  ws.state.revision = listing.revision;
  await ws.save();
  return out;
}

/** Drop the `.heypcb-new` copies and send the files here over HeyPCB's (keep_local). */
export async function keepLocal(ws: Workspace, api: FileApi, signal?: AbortSignal): Promise<PushResult> {
  for (const rel of ws.state.conflicts) await fsp.rm(ws.abs(rel) + NEW_SUFFIX, { force: true });
  // A conflicted file's `local` hash is stale on purpose: forget it so the file goes up.
  for (const rel of ws.state.conflicts) if (ws.state.files[rel]) ws.state.files[rel].local = "";
  ws.state.conflicts = [];
  await ws.save();
  return push(ws, api, { force: true, signal });
}

export type Backup = { revision: string; path: string; files: number; savedAt: string };

export async function listBackups(ws: Workspace): Promise<Backup[]> {
  const dir = path.join(ws.dir, "backup");
  const out: Backup[] = [];
  for (const name of await fsp.readdir(dir).catch(() => [] as string[])) {
    const p = path.join(dir, name);
    const st = await fsp.stat(p).catch(() => null);
    if (!st?.isDirectory()) continue;
    out.push({ revision: name, path: p, files: (await filesUnder(p)).length, savedAt: st.mtime.toISOString() });
  }
  return out.sort((a, b) => (a.savedAt < b.savedAt ? 1 : -1));
}

async function filesUnder(dir: string, prefix = ""): Promise<string[]> {
  const out: string[] = [];
  for (const d of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const rel = prefix ? `${prefix}/${d.name}` : d.name;
    if (d.isDirectory()) out.push(...(await filesUnder(path.join(dir, d.name), rel)));
    else if (d.isFile()) out.push(rel);
  }
  return out;
}

/**
 * Copy a backup back over the project's files. What is there now is backed
 * up first (as `before-restore-<time>`), so a restore can itself be undone.
 * The restored files reach HeyPCB with the next sync, like any edit here.
 */
export async function restore(ws: Workspace, revision: string): Promise<{ restored: string[]; savedCurrentAs: string | null }> {
  const name = backupName(revision);
  const src = path.join(ws.dir, "backup", name);
  const files = (await filesUnder(src)).filter(safeRel);
  if (!files.length) {
    const have = (await listBackups(ws)).map((b) => b.revision);
    throw new RefusalError(refusal("no_backup", `There is no backup "${revision}" in ${path.join(ws.dir, "backup")}.`, have.length ? `Pass one of: ${have.slice(0, 10).join(", ")}.` : "Nothing has been backed up yet: HeyPCB backs files up before it overwrites them.", { backups: have }));
  }
  const stamp = `before-restore-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  let saved = false;
  for (const rel of files) {
    const cur = await readIfFile(ws.abs(rel));
    if (cur) {
      await writeInside(ws.root, `${WORKSPACE_DIR}/backup/${stamp}/${rel}`, cur);
      saved = true;
    }
    await writeInside(ws.root, rel, await fsp.readFile(path.join(src, ...rel.split("/"))));
  }
  return { restored: files, savedCurrentAs: saved ? stamp : null };
}

/**
 * Which workspace a project id is bound to: the ones opened in this process,
 * then an index beside the sign-in (`workspaces.json`), so a binding made
 * in an earlier session still syncs. An index entry is trusted only when the
 * folder's own workspace.json still names that project on this API host.
 */
export class Workspaces {
  private readonly open = new Map<string, Workspace>();
  constructor(
    private readonly indexFile: string,
    private readonly apiBase: string
  ) {}

  private key(id: string): string {
    return `${this.apiBase} ${id}`;
  }

  private async index(): Promise<Record<string, string>> {
    try {
      const j = JSON.parse(await fsp.readFile(this.indexFile, "utf8"));
      return j && typeof j === "object" ? j : {};
    } catch {
      return {};
    }
  }

  async forProject(id: string): Promise<Workspace | null> {
    const known = this.open.get(id);
    if (known) return known;
    const root = (await this.index())[this.key(id)];
    if (typeof root !== "string") return null;
    const ws = await Workspace.load(root).catch(() => null);
    if (!ws || ws.state.projectId !== id || ws.state.apiBase !== this.apiBase) return null;
    this.open.set(id, ws);
    return ws;
  }

  /** The same Workspace object for a folder this process already opened (so its lock is shared). */
  async adopt(ws: Workspace): Promise<Workspace> {
    const known = this.open.get(ws.state.projectId);
    if (known && known.root === ws.root) {
      known.state = ws.state;
      return known;
    }
    this.open.set(ws.state.projectId, ws);
    const idx = await this.index();
    if (idx[this.key(ws.state.projectId)] !== ws.root) {
      idx[this.key(ws.state.projectId)] = ws.root;
      await fsp.mkdir(path.dirname(this.indexFile), { recursive: true, mode: 0o700 });
      await fsp.writeFile(this.indexFile, JSON.stringify(idx, null, 2) + "\n", { mode: 0o600 });
    }
    return ws;
  }

  forget(id: string): void {
    this.open.delete(id);
  }
}
