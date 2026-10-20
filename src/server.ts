/**
 * The local MCP server the agent talks to over stdio: the remote server's
 * tools 1:1 (or their names while it cannot be asked), plus the local
 * tools. A remote tool's call is forwarded with its progress and its
 * cancellation, and its result comes back as the remote server sent it —
 * with two additions only:
 *
 * - `_meta.heypcb.idempotencyKey` and `maxCost` on the way out (billing.ts);
 * - when the call's `project` is bound to a folder here (open_kicad_project),
 *   the folder is synced around it (workspace.ts): changes here pushed
 *   before; after a call the server marks as changing the design
 *   (`readOnlyHint: false`), HeyPCB's changes pulled back, and the parts an
 *   add_parts / add_block placed installed into the project's libraries.
 *   What changed here is added as `_meta.heypcb.local` and one text line.
 */
import path from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { Auth } from "./auth.ts";
import { heypcbMeta, Spend } from "./billing.ts";
import { OFFLINE_CATALOG } from "./catalog.ts";
import type { Config } from "./config.ts";
import { CredentialStore } from "./credentials.ts";
import { installParts, type InstallResult } from "./library.ts";
import { callLocalTool, LOCAL_TOOL_NAMES, LOCAL_TOOLS, projectId } from "./local-tools.ts";
import { RefusalError, refusalResult, type Refusal } from "./refusal.ts";
import { Remote, type Progress } from "./remote.ts";
import { VERSION } from "./version.ts";
import { FileApi, NEW_SUFFIX, pull, push, Workspace, WORKSPACE_DIR, Workspaces, type PullResult, type PushResult } from "./workspace.ts";

const LOCAL_NOTE =
  "This is HeyPCB's local MCP server (@heypcb/mcp). To work on a KiCad project on this computer, call open_kicad_project with its folder first and use the `project` id it returns: " +
  "every HeyPCB tool then keeps that folder in sync (your edits go up before a call, HeyPCB's come back after it, with backups). " +
  "It also adds upload_kicad_project (a one-off copy on HeyPCB), save_export (HeyPCB's files to a folder here), install_parts (parts into the project's own libraries), " +
  "check_local / export_local (KiCad's own DRC, ERC and exports via kicad-cli, free) and restore_local. " +
  "A tool that answers ok:false explains itself in `error` and says what to do in `fix`.";

/** Tools whose result names the parts it put on the board, to install locally. */
const PLACES_PARTS = new Set(["add_parts", "add_block"]);

export type ServeOptions = {
  config: Config | null;
  /** When the configuration itself is unusable, every tool answers this. */
  configRefusal?: Refusal;
  store: CredentialStore;
  /** How long to wait for the remote server before answering `initialize` (ms). */
  startupWaitMs?: number;
  /** The most this server process may spend (--max-spend); null for no cap. */
  maxSpend?: number | null;
  /** Test seams. */
  home?: string;
  cwd?: string;
  auth?: Auth;
  log?: (line: string) => void;
};

export type Running = { server: Server; remote: Remote | null; spend: Spend; close: () => Promise<void> };

type LocalReport = {
  root: string;
  pushed?: string[];
  local_files_changed?: string[];
  deleted_here?: string[];
  open_in_kicad?: string[];
  conflicts?: string[];
  kept?: string[];
  backup?: string | null;
  installed?: InstallResult["installed"];
  install_failed?: InstallResult["failed"];
  sync_error?: Refusal;
};

function report(ws: Workspace, pushed: PushResult | null, pulled: PullResult | null): LocalReport {
  const r: LocalReport = { root: ws.root };
  if (pushed?.pushed.length) r.pushed = pushed.pushed;
  if (pulled) {
    if (pulled.changed.length) r.local_files_changed = pulled.changed;
    if (pulled.deleted.length) r.deleted_here = pulled.deleted;
    if (pulled.openInKicad.length) r.open_in_kicad = pulled.openInKicad;
    if (pulled.conflicts.length) r.conflicts = pulled.conflicts;
    if (pulled.kept.length) r.kept = pulled.kept;
    if (pulled.backup) r.backup = pulled.backup;
  }
  return r;
}

/** One sentence for the agent: what changed in the folder, and what the user must do in KiCad. */
function localLine(r: LocalReport): string | null {
  const parts: string[] = [];
  const changed = [...(r.local_files_changed ?? []), ...(r.deleted_here ?? [])];
  if (changed.length) {
    parts.push(`HeyPCB updated ${changed.join(", ")} in ${r.root} (the old copies are in ${path.join(WORKSPACE_DIR, "backup")}).`);
    parts.push(r.open_in_kicad?.length ? `${r.open_in_kicad.join(", ")} ${r.open_in_kicad.length === 1 ? "is" : "are"} open in KiCad: tell the user to reload (File → Revert) before editing, or a save there will overwrite these changes.` : "Tell the user to reload them in KiCad if they are open.");
  }
  if (r.installed?.length) parts.push(`Installed ${r.installed.length} part${r.installed.length === 1 ? "" : "s"} into the project's heypcb libraries.`);
  if (r.install_failed?.length) parts.push(`Could not install ${r.install_failed.map((f) => f.part).join(", ")} locally (call install_parts to retry).`);
  if (r.sync_error) parts.push(`The folder was not synced after the call: ${r.sync_error.error} ${r.sync_error.fix}`);
  return parts.length ? parts.join(" ") : null;
}

function withMeta(result: CallToolResult, add: Record<string, unknown>, line: string | null): CallToolResult {
  const meta = (result._meta ?? {}) as Record<string, unknown>;
  return {
    ...result,
    content: line ? [...(result.content ?? []), { type: "text", text: line }] : result.content,
    _meta: { ...meta, heypcb: { ...heypcbMeta(meta), ...add } },
  };
}

function partsOf(result: CallToolResult): string[] {
  const p = heypcbMeta(result._meta).parts;
  return Array.isArray(p) ? p.filter((x): x is string => typeof x === "string" && /^[A-Za-z0-9._:-]{1,64}$/.test(x)) : [];
}

export async function startServer(transport: Transport, opts: ServeOptions): Promise<Running> {
  const log = opts.log ?? ((line: string) => process.stderr.write(`[heypcb-mcp] ${line}\n`));
  const config = opts.config;
  const auth = config ? (opts.auth ?? new Auth(config, opts.store)) : null;
  const remote = config && auth ? new Remote(config, auth) : null;
  const spend = new Spend(opts.maxSpend ?? null);
  const workspaces = config ? new Workspaces(path.join(opts.store.dir, "workspaces.json"), config.apiBase) : null;
  const api = config && auth ? new FileApi({ config, auth }) : null;

  if (remote) {
    // Ask the remote server for its tools before answering `initialize`, for a
    // moment only: a slow network must not stall the agent's startup.
    const first = remote.connect().catch((err) => {
      log(`not connected to ${config!.mcpUrl.href} yet: ${remote.translate(err).error}`);
    });
    await Promise.race([first, new Promise((r) => setTimeout(r, opts.startupWaitMs ?? 4000))]);
  }

  const instructions = [remote?.instructions, LOCAL_NOTE].filter(Boolean).join("\n\n");
  const server = new Server({ name: "heypcb", version: VERSION }, { capabilities: { tools: { listChanged: true } }, instructions });

  let initialized = false;
  let advertised = "";
  const toolList = (): Tool[] => {
    const remoteTools = (remote?.tools ?? OFFLINE_CATALOG).filter((t) => !LOCAL_TOOL_NAMES.has(t.name));
    return [...remoteTools, ...LOCAL_TOOLS];
  };
  const notifyIfChanged = () => {
    const now = JSON.stringify(toolList());
    if (initialized && now !== advertised) {
      advertised = now;
      server.sendToolListChanged().catch(() => {});
    }
  };
  server.oninitialized = () => {
    initialized = true;
  };
  if (remote) remote.onToolsChanged = notifyIfChanged;

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    if (remote && !remote.connected) await remote.tryConnect();
    const tools = toolList();
    advertised = JSON.stringify(tools);
    return { tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req, extra): Promise<CallToolResult> => {
    const { name } = req.params;
    const args = req.params.arguments as Record<string, unknown> | undefined;
    if (!config || !auth || !remote || !workspaces || !api) return refusalResult(opts.configRefusal!);
    if (LOCAL_TOOL_NAMES.has(name)) return callLocalTool({ config, auth, workspaces, home: opts.home, cwd: opts.cwd }, name, args, extra.signal);
    const token = req.params._meta?.progressToken;
    const relay = (p: Progress) => {
      if (token === undefined) return;
      extra
        .sendNotification({ method: "notifications/progress", params: { progressToken: token, progress: p.progress, ...(p.total !== undefined ? { total: p.total } : {}), ...(p.message !== undefined ? { message: p.message } : {}) } })
        .catch(() => {});
    };
    const prepared = spend.prepare(name, req.params._meta as Record<string, unknown> | undefined);
    if ("refusal" in prepared) return refusalResult(prepared.refusal);
    const meta = prepared.meta;
    const forward = () => remote.callTool(name, args, { signal: extra.signal, onProgress: relay, meta });

    const id = projectId(args?.project);
    const ws = id ? await workspaces.forProject(id) : null;
    let result: CallToolResult;
    if (!ws) {
      result = await forward();
      await spend.record(result, name, meta);
    } else {
      // The server's own word on whether this tool changes the design; unknown (offline catalog) counts as changing.
      const tool = remote.tools?.find((t) => t.name === name);
      const mutating = tool ? tool.annotations?.readOnlyHint === false : true;
      const usageLog = path.join(ws.dir, "usage.log");
      const run = async (): Promise<CallToolResult> => {
        let pushed: PushResult;
        const doPush = () => push(ws, api, { signal: extra.signal });
        try {
          pushed = mutating ? await doPush() : await ws.lock.run(doPush);
        } catch (err) {
          if (err instanceof RefusalError) return refusalResult(err.refusal);
          throw err;
        }
        const res = await forward();
        await spend.record(res, name, meta, usageLog);
        if (!mutating || res.isError) return pushed.pushed.length ? withMeta(res, { local: report(ws, pushed, null) }, null) : res;
        let pulled: PullResult | null = null;
        const local = report(ws, pushed, null);
        try {
          pulled = await pull(ws, api, { knownRevision: typeof heypcbMeta(res._meta).revision === "string" ? (heypcbMeta(res._meta).revision as string) : null, signal: extra.signal });
          Object.assign(local, report(ws, pushed, pulled));
          const parts = PLACES_PARTS.has(name) ? partsOf(res) : [];
          if (parts.length) {
            const inst = await installParts({ config, auth }, ws.root, parts, extra.signal);
            local.installed = inst.installed;
            if (inst.failed.length) local.install_failed = inst.failed;
          }
        } catch (err) {
          if (!(err instanceof RefusalError)) throw err;
          local.sync_error = err.refusal;
        }
        if (pulled?.conflicts.length) {
          // HeyPCB's change landed beside the user's own save: the call did its work, but the folder needs a decision.
          return refusalResult({
            ok: false,
            code: "kicad_saved_during_call",
            error: `${name} finished on HeyPCB, but ${pulled.conflicts.join(", ")} ${pulled.conflicts.length === 1 ? "was" : "were"} also saved here (in KiCad?) while it ran, so HeyPCB's version was written beside ${pulled.conflicts.length === 1 ? "it" : "them"} as ${NEW_SUFFIX} instead of overwriting.`,
            fix: "Ask the user which to keep, then call open_kicad_project with this folder and on_conflict \"take_heypcb\" (use HeyPCB's version; theirs is backed up) or \"keep_local\" (keep theirs; HeyPCB's change is replaced). Until then the folder does not sync.",
            retryable: false,
            local,
            result: res.structuredContent ?? res.content,
          });
        }
        return withMeta(res, { local }, localLine(local));
      };
      // A changing call holds the folder for its whole length; a read only for its push.
      result = mutating ? await ws.lock.run(run) : await run();
    }

    if (name === "whoami" && !result.isError) result = withMeta(result, { session: spend.summary() }, spend.line());
    // A call that reached the remote server may have shown it has (other) tools now.
    notifyIfChanged();
    return result;
  });

  await server.connect(transport);
  return {
    server,
    remote,
    spend,
    close: async () => {
      await remote?.close();
      await server.close();
    },
  };
}
