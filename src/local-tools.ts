/**
 * The tools only a LOCAL server can offer, because they touch this
 * computer's files:
 *
 * - `open_kicad_project`  bind a KiCad project folder to one HeyPCB project
 *   and keep the two in step (workspace.ts); the usual way in.
 * - `upload_kicad_project` a one-off copy of a project on HeyPCB.
 * - `save_export`          a HeyPCB export saved to a folder here.
 * - `install_parts`        HeyPCB parts into the project's own libraries (library.ts).
 * - `check_local`, `export_local`  KiCad's own kicad-cli, free, no network (kicad-cli.ts).
 * - `restore_local`        put back files a sync backed up.
 *
 * The REST calls use the same bearer the proxy uses; none of these does any
 * design work itself.
 */
import { randomUUID } from "node:crypto";
import { promises as fsp } from "node:fs";
import path from "node:path";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { Auth } from "./auth.ts";
import { projectUrl, type Config } from "./config.ts";
import { anySignal, chunksOf, networkRefusal, neverSent, responseRefusal, sleep } from "./http.ts";
import { runCheck, runExport, LOCAL_EXPORT_KINDS, type LocalExportKind } from "./kicad-cli.ts";
import { collectProject, locateProject, MAX_PROJECT_BYTES, type Collection } from "./kicad-files.ts";
import { installParts } from "./library.ts";
import { okResult, refusal, RefusalError, refusalResult } from "./refusal.ts";
import { freeName, resolveTargetDir, safeFileName, writeAtomic } from "./safe-path.ts";
import { FileApi, ignoreInGit, keepLocal, listBackups, pull, push, restore, Workspace, WORKSPACE_DIR, Workspaces } from "./workspace.ts";
import { buildZip } from "./zip.ts";

export const EXPORT_KINDS = ["gerbers", "kicad", "bom", "cpl", "step"] as const;
type ExportKind = (typeof EXPORT_KINDS)[number];
const EXPORT_EXT: Record<ExportKind, string> = { gerbers: ".zip", kicad: ".zip", bom: ".csv", cpl: ".csv", step: ".step" };

const PATH_PROP = { type: "string", description: "The KiCad project's folder, or its .kicad_pro / .kicad_pcb / .kicad_sch file. Absolute, or starting with ~/." } as const;

export const LOCAL_TOOLS: Tool[] = [
  {
    name: "open_kicad_project",
    title: "Open a KiCad project",
    description:
      "Work on a KiCad project on this computer with HeyPCB's tools, keeping it a normal KiCad project in its own folder. " +
      "The first call binds the folder to a new HeyPCB project: it UPLOADS the project's files (the board, every schematic sheet, the .kicad_pro, .kicad_dru, lib tables and project-local libraries — never 3D models, backups or anything .heypcbignore names) and writes .heypcb/workspace.json. Tell the user their files go to HeyPCB. " +
      "Later calls reuse the binding and sync both ways. From then on, every HeyPCB tool called with the returned `project` id syncs this folder: changes saved here go up before the call; files a call changes come back after it (the old ones backed up in .heypcb/backup/), and the result's local_files_changed says what to reload in KiCad. A file saved in KiCad while a call ran is never overwritten: HeyPCB's version lands beside it as <file>.heypcb-new and syncing waits for `on_conflict`. " +
      "Free. Returns `project` (use it as `project` in the other tools), the web link and what synced.",
    inputSchema: {
      type: "object",
      properties: {
        path: PATH_PROP,
        name: { type: "string", description: "The project's name on HeyPCB, when it is bound the first time. Default: the KiCad project's file name." },
        on_conflict: {
          type: "string",
          enum: ["take_heypcb", "keep_local"],
          description: "Only after a workspace_conflict, with the user's choice: take_heypcb (HeyPCB's copy replaces the files here, which are backed up first) or keep_local (the files here replace HeyPCB's).",
        },
        rebind: { type: "boolean", description: "Bind the folder to a NEW HeyPCB project even though it is bound already (uploads it again). Default false." },
      },
      required: ["path"],
      additionalProperties: false,
    },
    annotations: { title: "Open a KiCad project", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "upload_kicad_project",
    title: "Upload a KiCad project",
    description:
      "Upload a KiCad project from this computer to HeyPCB as a NEW, separate HeyPCB project (a copy: nothing syncs back). To work on a project in its folder, use open_kicad_project instead. " +
      "`path` is the project's folder (the one holding its .kicad_pro / .kicad_pcb) or the .kicad_pro / .kicad_pcb / .kicad_sch file itself; ~ is your home folder. " +
      "It sends the board, the root schematic and every sub-sheet it names, the .kicad_pro, .kicad_dru, sym-lib-table / fp-lib-table and the project-local libraries they name — " +
      "never 3D models, backups, .kicad_prl or what .heypcbignore names — at most 50 MB. Free. " +
      "Returns the new project's id (use it as `project` in the other tools), its web link, and the files sent. Each call makes a new project.",
    inputSchema: {
      type: "object",
      properties: {
        path: PATH_PROP,
        name: { type: "string", description: "The project's name on HeyPCB. Default: the KiCad project's file name." },
      },
      required: ["path"],
      additionalProperties: false,
    },
    annotations: { title: "Upload a KiCad project", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "save_export",
    title: "Save an export to disk",
    description:
      "Download a HeyPCB project's manufacturing or design files and save them into a folder on this computer. " +
      "kind: gerbers (fab zip with drill files), kicad (the KiCad project as a zip), bom (CSV), cpl (pick-and-place CSV), step (3D model). " +
      "`dir` is created if it is inside your home folder; a folder elsewhere must already exist and be writable. An existing file is kept: the new one gets -2, -3… unless `overwrite` is true. " +
      "Free (on a trial, design-file downloads count as on the web). Returns the saved file's absolute path.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "The HeyPCB project id (or its https://heypcb.ai/p/<id> link)." },
        kind: { type: "string", enum: [...EXPORT_KINDS], description: "What to export." },
        dir: { type: "string", description: "The folder to save into. Absolute, or starting with ~/." },
        overwrite: { type: "boolean", description: "Replace a file of the same name instead of saving beside it. Default false." },
      },
      required: ["project", "kind", "dir"],
      additionalProperties: false,
    },
    annotations: { title: "Save an export to disk", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "install_parts",
    title: "Install parts into the project's libraries",
    description:
      "Copy HeyPCB parts — symbol, footprint and 3D model — into the KiCad project's own libraries (heypcb.kicad_sym, heypcb.pretty/, heypcb.3dshapes/) and add a `heypcb` library to its sym-lib-table and fp-lib-table with ${KIPRJMOD} paths, so the project opens with every part resolved on a computer without HeyPCB. " +
      "Symbols merge by name (never duplicated); a part already installed is updated only when HeyPCB's files changed. On a folder bound with open_kicad_project, add_parts and add_block run this by themselves. " +
      "`parts`: LCSC codes (C2040) or HeyPCB part ids from search_parts / get_part. Returns each part's heypcb:<symbol> and heypcb:<footprint> ids.",
    inputSchema: {
      type: "object",
      properties: {
        path: PATH_PROP,
        parts: { type: "array", items: { type: "string", minLength: 1, maxLength: 64 }, minItems: 1, maxItems: 50, description: "LCSC codes or HeyPCB part ids." },
      },
      required: ["path", "parts"],
      additionalProperties: false,
    },
    annotations: { title: "Install parts into the project's libraries", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "check_local",
    title: "KiCad DRC / ERC here",
    description:
      "Run KiCad's own DRC (kind drc, on the .kicad_pcb) or ERC (kind erc, on the root .kicad_sch) on the project here with kicad-cli: free, no network, nothing uploaded. " +
      "A fast pre-check after edits; check_board on HeyPCB stays the full verification (placement, power, fab readiness). Needs KiCad 8 or newer installed. " +
      "Returns passed, counts {errors, warnings, unconnected} and findings [{severity, type, message, where:[{text, x, y}]}] (mm), errors first.",
    inputSchema: {
      type: "object",
      properties: { path: PATH_PROP, kind: { type: "string", enum: ["drc", "erc"], description: "drc (the board) or erc (the schematic)." } },
      required: ["path", "kind"],
      additionalProperties: false,
    },
    annotations: { title: "KiCad DRC / ERC here", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "export_local",
    title: "Export with KiCad here",
    description:
      "Make manufacturing files from the project here with KiCad's kicad-cli: free, no network. kind: gerbers (a zip of the Gerbers, with the board's own plot settings, and the drill files), bom (CSV from the schematic), cpl (pick-and-place CSV, mm, both sides), step (3D model). " +
      "`dir` defaults to the project's exports/ folder; an existing file is kept (the new one gets -2, -3…) unless `overwrite` is true. Needs KiCad 8 or newer. For HeyPCB's own fab-checked files use save_export.",
    inputSchema: {
      type: "object",
      properties: {
        path: PATH_PROP,
        kind: { type: "string", enum: [...LOCAL_EXPORT_KINDS], description: "What to export." },
        dir: { type: "string", description: "The folder to save into. Default: <project>/exports." },
        overwrite: { type: "boolean", description: "Replace a file of the same name. Default false." },
      },
      required: ["path", "kind"],
      additionalProperties: false,
    },
    annotations: { title: "Export with KiCad here", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "restore_local",
    title: "Restore files a sync replaced",
    description:
      "Put back the project files a sync backed up before HeyPCB's changes replaced them (.heypcb/backup/<revision>/). Without `revision` it lists the backups. " +
      "What is there now is backed up first, so a restore can be undone the same way; the restored files go to HeyPCB with the next sync. Free, local.",
    inputSchema: {
      type: "object",
      properties: { path: PATH_PROP, revision: { type: "string", description: "The backup to restore, from the list this tool returns without it." } },
      required: ["path"],
      additionalProperties: false,
    },
    annotations: { title: "Restore files a sync replaced", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
];

export const LOCAL_TOOL_NAMES = new Set(LOCAL_TOOLS.map((t) => t.name));

/** `workspaces` is the server's one registry (it holds each folder's lock); a caller without one gets its own. */
export type LocalContext = { config: Config; auth: Auth; workspaces?: Workspaces; home?: string; cwd?: string };

function registry(ctx: LocalContext): Workspaces {
  ctx.workspaces ??= new Workspaces(path.join(ctx.auth.store.dir, "workspaces.json"), ctx.config.apiBase);
  return ctx.workspaces;
}

type Imported = { id: string; name: string; revision: string | null; col: Collection; zipBytes: number };

/** Upload a project as a new HeyPCB project. Throws RefusalError. */
async function importProject(ctx: LocalContext, root: string, stem: string, nameArg: unknown, signal?: AbortSignal): Promise<Imported> {
  const col = await collectProject(root, stem);
  const zip = buildZip(col.files.map((f) => ({ path: f.path, data: f.data })));
  if (zip.length > MAX_PROJECT_BYTES) {
    throw new RefusalError(
      refusal("project_too_large", `This project zips to ${(zip.length / 1e6).toFixed(1)} MB; HeyPCB takes at most 50 MB.`, "Remove large files the project does not need from its folder (or name them in .heypcbignore), then call the tool again.", {
        zipBytes: zip.length,
      })
    );
  }
  const name = typeof nameArg === "string" && nameArg.trim() ? nameArg.trim().slice(0, 120) : stem;
  // One key for every attempt of THIS upload. Sent again only when the
  // first try certainly changed nothing — a connection that never opened,
  // or a 502/503 saying `written: false`. A timeout (504, 524, or no
  // answer) may have imported it: the server stores only definite answers,
  // so a resend could make a second project. That is the agent's call,
  // after list_projects.
  const key = randomUUID();
  let res: Response | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(zip)], { type: "application/zip" }), `${stem}.zip`);
    form.append("name", name);
    try {
      res = await ctx.auth.fetch(`${ctx.config.apiBase}/v1/projects/import`, {
        method: "POST",
        headers: { accept: "application/json", "idempotency-key": key },
        body: form,
        signal: signal ? anySignal(signal, 180_000) : AbortSignal.timeout(180_000),
      });
    } catch (err) {
      if (err instanceof RefusalError || signal?.aborted) throw err;
      if (attempt === 0 && neverSent(err)) {
        await sleep(2_000);
        continue;
      }
      const r = networkRefusal(err, "the upload");
      throw new RefusalError(neverSent(err) ? r : { ...r, retryable: false, fix: "It may have arrived: call list_projects and look for it before uploading again." });
    }
    if (attempt === 0 && (res.status === 502 || res.status === 503)) {
      const said = (await res.clone().json().catch(() => null)) as { written?: unknown } | null;
      if (said?.written === false) {
        await sleep(3_000);
        continue;
      }
    }
    break;
  }
  if (!res) throw new RefusalError(refusal("upload_failed", "The upload could not be sent.", "Call the tool again in a minute."));
  if (!res.ok) throw new RefusalError(await responseRefusal(res, "the upload"));
  const body = (await res.json().catch(() => null)) as { project?: { id?: unknown; name?: unknown; revision?: unknown } } | null;
  const id = typeof body?.project?.id === "string" ? body.project.id : "";
  if (!id) throw new RefusalError(refusal("upload_unconfirmed", "HeyPCB answered the upload without a project id.", "Call list_projects to see whether it arrived before uploading again."));
  return {
    id,
    name: typeof body?.project?.name === "string" ? body.project.name : name,
    revision: typeof body?.project?.revision === "string" ? body.project.revision : null,
    col,
    zipBytes: zip.length,
  };
}

/** A tool body that may throw RefusalError, as a tool result. */
async function guarded(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof RefusalError) return refusalResult(err.refusal);
    throw err;
  }
}

export function uploadKicadProject(ctx: LocalContext, args: Record<string, unknown>, signal?: AbortSignal): Promise<CallToolResult> {
  return guarded(async () => {
    await ctx.auth.bearer(); // signed in? (before any work)
    const { root, stem } = await locateProject(String(args.path ?? ""), ctx.home);
    const imp = await importProject(ctx, root, stem, args.name, signal);
    return okResult({
      project: { id: imp.id, name: imp.name, revision: imp.revision },
      webUrl: projectUrl(ctx.config, imp.id),
      uploaded: { root, files: imp.col.files.map((f) => f.path), bytes: imp.col.totalBytes, zipBytes: imp.zipBytes },
      skipped: imp.col.skipped,
      missing: imp.col.missing,
    });
  });
}

export function openKicadProject(ctx: LocalContext, args: Record<string, unknown>, signal?: AbortSignal): Promise<CallToolResult> {
  return guarded(async () => {
    await ctx.auth.bearer();
    const onConflict = args.on_conflict;
    if (onConflict !== undefined && onConflict !== "take_heypcb" && onConflict !== "keep_local") {
      return refusalResult(refusal("bad_on_conflict", "`on_conflict` must be take_heypcb or keep_local.", "Ask the user which copy to keep, then call open_kicad_project again."));
    }
    const { root, stem } = await locateProject(String(args.path ?? ""), ctx.home);
    const api = new FileApi(ctx);
    let ws = args.rebind === true ? null : await Workspace.load(root);
    if (ws && ws.state.apiBase !== ctx.config.apiBase) {
      return refusalResult(
        refusal("bound_elsewhere", `This folder is bound to a project on ${ws.state.apiBase}, not ${ctx.config.apiBase}.`, "Call open_kicad_project again with `rebind: true` to bind it to a new project here (it uploads the files again).", { root })
      );
    }
    if (ws && ws.state.stem !== stem) {
      return refusalResult(
        refusal("bound_to_other_project", `This folder is bound to the KiCad project ${ws.state.stem}, not ${stem}.`, `Pass ${ws.state.stem}.kicad_pro as \`path\`, or \`rebind: true\` to bind ${stem} instead.`, { root, bound: ws.state.stem })
      );
    }

    if (!ws) {
      const imp = await importProject(ctx, root, stem, args.name, signal);
      let listing;
      try {
        listing = await api.list(imp.id, signal);
      } catch (err) {
        if (err instanceof RefusalError && (err.refusal.status === 404 || err.refusal.status === 405)) {
          throw new RefusalError(
            refusal(
              "workspace_unsupported",
              `HeyPCB made the project ${imp.id} from this folder, but this HeyPCB server does not offer file sync yet, so the folder cannot be bound to it.`,
              "Use the project id with HeyPCB's tools as an uploaded copy (save_export brings files back), or update with `npx -y @heypcb/mcp@latest` and try again later.",
              { project: imp.id, webUrl: projectUrl(ctx.config, imp.id) }
            )
          );
        }
        throw err;
      }
      const remote = new Map(listing.files.map((f) => [f.path, f.sha256]));
      const files: Workspace["state"]["files"] = {};
      for (const f of imp.col.files) {
        const r = remote.get(f.path);
        if (r) files[f.path] = { local: f.sha256, remote: r };
      }
      ws = new Workspace(root, { version: 1, projectId: imp.id, apiBase: ctx.config.apiBase, stem, revision: listing.revision, files, conflicts: [], boundAt: new Date().toISOString() });
      await ws.save();
      const gitignored = await ignoreInGit(root);
      ws = await registry(ctx).adopt(ws);
      const bound = ws;
      // Whatever HeyPCB made on import (a board for a schematic-only project) comes down now.
      const pulled = await bound.lock.run(() => pull(bound, api, { full: true, signal }));
      return okResult({
        project: { id: imp.id, name: imp.name, revision: bound.state.revision },
        webUrl: projectUrl(ctx.config, imp.id),
        root,
        binding: "new",
        uploaded: { files: imp.col.files.map((f) => f.path), bytes: imp.col.totalBytes },
        local_files_changed: pulled.changed,
        skipped: imp.col.skipped,
        missing: imp.col.missing,
        ...(gitignored ? { gitignore: `added ${WORKSPACE_DIR}/ to .gitignore` } : {}),
      });
    }

    const bound = await registry(ctx).adopt(ws);
    return bound.lock.run(async () => {
      let pushed, pulled;
      if (onConflict === "keep_local") {
        pushed = await keepLocal(bound, api, signal);
        pulled = await pull(bound, api, { full: true, signal });
      } else if (onConflict === "take_heypcb") {
        pulled = await pull(bound, api, { takeHeypcb: true, signal });
        pushed = await push(bound, api, { signal });
      } else {
        pushed = await push(bound, api, { signal });
        pulled = await pull(bound, api, { signal });
      }
      return okResult({
        project: { id: bound.state.projectId, revision: bound.state.revision },
        webUrl: projectUrl(ctx.config, bound.state.projectId),
        root,
        binding: "existing",
        pushed: pushed.pushed,
        deleted_on_heypcb: pushed.deleted,
        local_files_changed: pulled.changed,
        deleted_here: pulled.deleted,
        open_in_kicad: pulled.openInKicad,
        conflicts: bound.state.conflicts,
        backup: pulled.backup,
      });
    });
  });
}

/** A project id, or the id inside a web link to it. */
export function projectId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let s = raw.trim();
  const m = /\/p\/([^/?#]+)/.exec(s);
  if (m && /^https?:\/\//.test(s)) s = decodeURIComponent(m[1]);
  return /^[A-Za-z0-9._-]{1,128}$/.test(s) ? s : null;
}

/** The file name a Content-Disposition header gives, or null. */
export function dispositionName(header: string | null): string | null {
  if (!header) return null;
  const star = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(header);
  if (star) {
    try {
      return decodeURIComponent(star[2].trim().replace(/^"|"$/g, ""));
    } catch {
      /* fall through to the plain form */
    }
  }
  const plain = /filename\s*=\s*("((?:[^"\\]|\\.)*)"|[^;]+)/i.exec(header);
  if (!plain) return null;
  return plain[2] !== undefined ? plain[2].replace(/\\(.)/g, "$1") : plain[1].trim();
}

export function saveExport(ctx: LocalContext, args: Record<string, unknown>, signal?: AbortSignal): Promise<CallToolResult> {
  return guarded(async () => {
    await ctx.auth.bearer();
    const id = projectId(args.project);
    if (!id) return refusalResult(refusal("bad_project", "`project` is not a HeyPCB project id.", "Pass the id list_projects or upload_kicad_project returned (or the project's https://heypcb.ai/p/<id> link)."));
    const kind = String(args.kind ?? "") as ExportKind;
    if (!EXPORT_KINDS.includes(kind)) return refusalResult(refusal("bad_kind", `\`kind\` must be one of ${EXPORT_KINDS.join(", ")}.`, "Call save_export again with one of those kinds."));
    const dir = await resolveTargetDir(args.dir, { home: ctx.home, cwd: ctx.cwd, protectedDirs: [ctx.auth.store.dir] });
    let res: Response;
    try {
      res = await ctx.auth.fetch(`${ctx.config.apiBase}/v1/projects/${encodeURIComponent(id)}/exports/${kind}`, {
        headers: { accept: "*/*" },
        signal: signal ? anySignal(signal, 600_000) : AbortSignal.timeout(600_000),
      });
    } catch (err) {
      if (err instanceof RefusalError || signal?.aborted) throw err;
      return refusalResult(networkRefusal(err, "the export"));
    }
    if (!res.ok) return refusalResult(await responseRefusal(res, `the ${kind} export`));
    let name = safeFileName(dispositionName(res.headers.get("content-disposition")), `${id}-${kind}${EXPORT_EXT[kind]}`);
    if (args.overwrite !== true) name = await freeName(dir, name);
    const saved = await writeAtomic(dir, name, chunksOf(res.body));
    return okResult({ path: saved.path, bytes: saved.bytes, kind, project: id, contentType: res.headers.get("content-type") });
  });
}

function partList(raw: unknown): string[] | null {
  if (!Array.isArray(raw) || !raw.length || raw.length > 50) return null;
  const out = raw.map((p) => (typeof p === "string" ? p.trim() : ""));
  return out.every((p) => /^[A-Za-z0-9._:-]{1,64}$/.test(p)) ? out : null;
}

export function installPartsTool(ctx: LocalContext, args: Record<string, unknown>, signal?: AbortSignal): Promise<CallToolResult> {
  return guarded(async () => {
    await ctx.auth.bearer();
    const parts = partList(args.parts);
    if (!parts) return refusalResult(refusal("bad_parts", "`parts` must be 1–50 LCSC codes or HeyPCB part ids.", "Pass the ids search_parts or get_part returned, e.g. [\"C2040\"]."));
    const { root } = await locateProject(String(args.path ?? ""), ctx.home);
    const r = await installParts(ctx, root, parts, signal);
    if (!r.installed.length) {
      return refusalResult(refusal("nothing_installed", "None of the parts could be installed.", "Check the ids with get_part, then call install_parts again.", { failed: r.failed }));
    }
    return okResult({ root, ...r });
  });
}

/** The board and root schematic of the project a path names. */
async function projectFiles(input: unknown, home?: string): Promise<{ root: string; stem: string; board: string | null; schematic: string | null }> {
  const { root, stem } = await locateProject(String(input ?? ""), home);
  const has = (p: string) =>
    fsp.stat(p).then(
      (s) => s.isFile(),
      () => false
    );
  const board = path.join(root, `${stem}.kicad_pcb`);
  const schematic = path.join(root, `${stem}.kicad_sch`);
  return { root, stem, board: (await has(board)) ? board : null, schematic: (await has(schematic)) ? schematic : null };
}

export function checkLocal(ctx: LocalContext, args: Record<string, unknown>, signal?: AbortSignal): Promise<CallToolResult> {
  return guarded(async () => {
    const kind = args.kind;
    if (kind !== "drc" && kind !== "erc") return refusalResult(refusal("bad_kind", "`kind` must be drc or erc.", "Call check_local again with kind drc (the board) or erc (the schematic)."));
    const p = await projectFiles(args.path, ctx.home);
    const file = kind === "drc" ? p.board : p.schematic;
    if (!file) {
      return refusalResult(refusal("nothing_to_check", kind === "drc" ? "This project has no board (.kicad_pcb) to run DRC on." : "This project has no schematic (.kicad_sch) to run ERC on.", kind === "drc" ? "Run ERC (kind erc) instead, or make the board first." : "Run DRC (kind drc) instead."));
    }
    const report = await runCheck(kind, file, signal);
    return okResult({ ...report, note: "KiCad's own check on the files here; run check_board on HeyPCB for the full verification." });
  });
}

const LOCAL_EXPORT_NAME: Record<LocalExportKind, (stem: string) => string> = {
  gerbers: (s) => `${s}-gerbers.zip`,
  bom: (s) => `${s}-bom.csv`,
  cpl: (s) => `${s}-cpl.csv`,
  step: (s) => `${s}.step`,
};

export function exportLocal(ctx: LocalContext, args: Record<string, unknown>, signal?: AbortSignal): Promise<CallToolResult> {
  return guarded(async () => {
    const kind = String(args.kind ?? "") as LocalExportKind;
    if (!LOCAL_EXPORT_KINDS.includes(kind)) return refusalResult(refusal("bad_kind", `\`kind\` must be one of ${LOCAL_EXPORT_KINDS.join(", ")}.`, "Call export_local again with one of those kinds."));
    const p = await projectFiles(args.path, ctx.home);
    const dir = await resolveTargetDir(typeof args.dir === "string" && args.dir.trim() ? args.dir : path.join(p.root, "exports"), { home: ctx.home, cwd: ctx.cwd, protectedDirs: [ctx.auth.store.dir] });
    const made = await runExport(kind, p, signal);
    try {
      let name = LOCAL_EXPORT_NAME[kind](p.stem);
      if (args.overwrite !== true) name = await freeName(dir, name);
      let chunks: AsyncIterable<Uint8Array>;
      if (kind === "gerbers") {
        const entries = await Promise.all(made.files.map(async (f) => ({ path: f, data: await fsp.readFile(path.join(made.dir, f)) })));
        const zip = buildZip(entries);
        chunks = (async function* () {
          yield zip;
        })();
      } else {
        const data = await fsp.readFile(path.join(made.dir, made.files[0]));
        chunks = (async function* () {
          yield data;
        })();
      }
      const saved = await writeAtomic(dir, name, chunks);
      return okResult({ path: saved.path, bytes: saved.bytes, kind, kicad: made.kicad, ...(kind === "gerbers" ? { files: made.files } : {}) });
    } finally {
      await fsp.rm(made.dir, { recursive: true, force: true });
    }
  });
}

export function restoreLocal(ctx: LocalContext, args: Record<string, unknown>): Promise<CallToolResult> {
  return guarded(async () => {
    const { root } = await locateProject(String(args.path ?? ""), ctx.home);
    const ws = await Workspace.load(root);
    if (!ws) return refusalResult(refusal("not_bound", "This folder is not bound to HeyPCB, so it has no sync backups.", "Bind it with open_kicad_project first."));
    const bound = await registry(ctx).adopt(ws);
    if (typeof args.revision !== "string" || !args.revision.trim()) return okResult({ root, backups: await listBackups(bound) });
    const revision = args.revision.trim();
    return bound.lock.run(async () => okResult({ root, ...(await restore(bound, revision)), note: "Reload the restored files in KiCad if they are open. They go to HeyPCB with the next sync." }));
  });
}

export async function callLocalTool(ctx: LocalContext, name: string, args: Record<string, unknown> | undefined, signal?: AbortSignal): Promise<CallToolResult> {
  const a = args ?? {};
  switch (name) {
    case "open_kicad_project":
      return openKicadProject(ctx, a, signal);
    case "upload_kicad_project":
      return uploadKicadProject(ctx, a, signal);
    case "save_export":
      return saveExport(ctx, a, signal);
    case "install_parts":
      return installPartsTool(ctx, a, signal);
    case "check_local":
      return checkLocal(ctx, a, signal);
    case "export_local":
      return exportLocal(ctx, a, signal);
    case "restore_local":
      return restoreLocal(ctx, a);
  }
  throw new Error(`not a local tool: ${name}`);
}
