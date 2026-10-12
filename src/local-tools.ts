/**
 * The two tools only a LOCAL server can offer, because they touch this
 * computer's files: `upload_kicad_project` and `save_export`. Both call the
 * public REST API (`POST /v1/projects/import`, `GET /v1/projects/{id}/exports/{kind}`)
 * with the same bearer the proxy uses; neither does any design work itself.
 */
import { randomUUID } from "node:crypto";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { Auth } from "./auth.ts";
import { projectUrl, type Config } from "./config.ts";
import { collectProject, locateProject, MAX_PROJECT_BYTES } from "./kicad-files.ts";
import { asRefusal, okResult, refusal, RefusalError, refusalResult, type Refusal } from "./refusal.ts";
import { freeName, resolveTargetDir, safeFileName, writeAtomic } from "./safe-path.ts";
import { buildZip } from "./zip.ts";

export const EXPORT_KINDS = ["gerbers", "kicad", "bom", "cpl", "step"] as const;
type ExportKind = (typeof EXPORT_KINDS)[number];
const EXPORT_EXT: Record<ExportKind, string> = { gerbers: ".zip", kicad: ".zip", bom: ".csv", cpl: ".csv", step: ".step" };

export const LOCAL_TOOLS: Tool[] = [
  {
    name: "upload_kicad_project",
    title: "Upload a KiCad project",
    description:
      "Upload a KiCad project from this computer to HeyPCB as a NEW HeyPCB project, so the other HeyPCB tools can check, route, edit or export it. " +
      "`path` is the project's folder (the one holding its .kicad_pro / .kicad_pcb) or the .kicad_pro / .kicad_pcb / .kicad_sch file itself; ~ is your home folder. " +
      "It sends the board, the root schematic and every sub-sheet it names, the .kicad_pro, .kicad_dru, sym-lib-table / fp-lib-table and the project-local libraries they name — " +
      "never 3D models, backups or .kicad_prl — at most 50 MB. Free. " +
      "Returns the new project's id (use it as `project` in the other tools), its web link, and the files sent. Each call makes a new project: to update one, use the remote tools on its id instead.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "The KiCad project's folder, or its .kicad_pro / .kicad_pcb / .kicad_sch file. Absolute, or starting with ~/." },
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
];

export const LOCAL_TOOL_NAMES = new Set(LOCAL_TOOLS.map((t) => t.name));

export type LocalContext = { config: Config; auth: Auth; home?: string; cwd?: string };

/** A refusal from a response that was not ok: the API's own when it sent one. */
async function responseRefusal(res: Response, what: string): Promise<Refusal> {
  const body = await res.json().catch(() => null);
  const passed = asRefusal(body, res.status);
  if (passed) return passed;
  if (res.status === 401 || res.status === 403) {
    return refusal("not_allowed", `HeyPCB refused ${what} (HTTP ${res.status}).`, "Check that this sign-in may use HeyPCB's API (Settings → Devices & API keys), then call the tool again.", { status: res.status });
  }
  if (res.status === 404) return refusal("not_found", `HeyPCB has no ${what.replace(/^the /, "")} for that project.`, "Check the project id with list_projects, then call the tool again.", { status: 404 });
  if (res.status === 429) return refusal("rate_limited", "HeyPCB is asking for fewer requests for a moment.", "Wait a minute, then call the tool again.", { retryable: true, status: 429 });
  if (res.status >= 500) return refusal("server_unavailable", `HeyPCB could not finish ${what} (HTTP ${res.status}).`, "Call the tool again in a minute.", { retryable: true, status: res.status });
  return refusal("refused", `HeyPCB refused ${what} (HTTP ${res.status}).`, "Check the tool's arguments, then call it again.", { status: res.status });
}

function networkRefusal(err: unknown, what: string): Refusal {
  const timedOut = (err as Error)?.name === "TimeoutError" || (err as Error)?.name === "AbortError";
  return refusal(
    timedOut ? "timed_out" : "network_error",
    timedOut ? `${what} took too long.` : `HeyPCB could not be reached for ${what} (${(err as Error)?.message ?? String(err)}).`,
    "Check this computer's internet connection, then call the tool again.",
    { retryable: true }
  );
}

/** A request that failed before a connection opened sent nothing. */
function neverSent(err: unknown): boolean {
  const code = ((err as { cause?: { code?: unknown } })?.cause?.code ?? (err as { code?: unknown })?.code) as string | undefined;
  return code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "UND_ERR_CONNECT_TIMEOUT";
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function uploadKicadProject(ctx: LocalContext, args: Record<string, unknown>, signal?: AbortSignal): Promise<CallToolResult> {
  try {
    await ctx.auth.bearer(); // signed in? (before any work)
    const { root, stem } = await locateProject(String(args.path ?? ""), ctx.home);
    const col = await collectProject(root, stem);
    const zip = buildZip(col.files.map((f) => ({ path: f.path, data: f.data })));
    if (zip.length > MAX_PROJECT_BYTES) {
      return refusalResult(
        refusal("project_too_large", `This project zips to ${(zip.length / 1e6).toFixed(1)} MB; HeyPCB takes at most 50 MB.`, "Remove large files the project does not need from its folder, then call upload_kicad_project again.", {
          zipBytes: zip.length,
        })
      );
    }
    const name = typeof args.name === "string" && args.name.trim() ? args.name.trim().slice(0, 120) : stem;
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
        return refusalResult(neverSent(err) ? r : { ...r, retryable: false, fix: "It may have arrived: call list_projects and look for it before uploading again." });
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
    if (!res) return refusalResult(refusal("upload_failed", "The upload could not be sent.", "Call upload_kicad_project again in a minute."));
    if (!res.ok) return refusalResult(await responseRefusal(res, "the upload"));
    const body = (await res.json().catch(() => null)) as { project?: { id?: unknown; name?: unknown; revision?: unknown } } | null;
    const id = typeof body?.project?.id === "string" ? body.project.id : "";
    if (!id) {
      return refusalResult(refusal("upload_unconfirmed", "HeyPCB answered the upload without a project id.", "Call list_projects to see whether it arrived before uploading again."));
    }
    return okResult({
      project: { id, name: typeof body?.project?.name === "string" ? body.project.name : name, revision: body?.project?.revision ?? null },
      webUrl: projectUrl(ctx.config, id),
      uploaded: { root, files: col.files.map((f) => f.path), bytes: col.totalBytes, zipBytes: zip.length },
      skipped: col.skipped,
      missing: col.missing,
    });
  } catch (err) {
    if (err instanceof RefusalError) return refusalResult(err.refusal);
    throw err;
  }
}

/** A project id, or the id inside a web link to it. */
export function projectId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let s = raw.trim();
  const m = /\/p\/([^/?#]+)/.exec(s);
  if (m && /^https?:\/\//.test(s)) s = decodeURIComponent(m[1]);
  return /^[A-Za-z0-9_-]{1,128}$/.test(s) ? s : null;
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

async function* chunksOf(body: ReadableStream<Uint8Array> | null): AsyncIterable<Uint8Array> {
  if (!body) return;
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

export async function saveExport(ctx: LocalContext, args: Record<string, unknown>, signal?: AbortSignal): Promise<CallToolResult> {
  try {
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
  } catch (err) {
    if (err instanceof RefusalError) return refusalResult(err.refusal);
    throw err;
  }
}

/** `signal` or a timeout, whichever comes first (AbortSignal.any is Node 20+). */
function anySignal(signal: AbortSignal, ms: number): AbortSignal {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(new DOMException("The operation timed out.", "TimeoutError")), ms);
  const stop = () => {
    clearTimeout(timer);
    ctl.abort(signal.reason);
  };
  if (signal.aborted) stop();
  else signal.addEventListener("abort", stop, { once: true });
  timer.unref?.();
  return ctl.signal;
}

export async function callLocalTool(ctx: LocalContext, name: string, args: Record<string, unknown> | undefined, signal?: AbortSignal): Promise<CallToolResult> {
  if (name === "upload_kicad_project") return uploadKicadProject(ctx, args ?? {}, signal);
  if (name === "save_export") return saveExport(ctx, args ?? {}, signal);
  throw new Error(`not a local tool: ${name}`);
}
