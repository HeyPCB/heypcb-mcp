/**
 * The local MCP server the agent talks to over stdio: the remote server's
 * tools 1:1 (or their names while it cannot be asked), plus the two local
 * tools. A remote tool's call is forwarded with its progress and its
 * cancellation; its result comes back untouched.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { Auth } from "./auth.ts";
import { OFFLINE_CATALOG } from "./catalog.ts";
import type { Config } from "./config.ts";
import { CredentialStore } from "./credentials.ts";
import { callLocalTool, LOCAL_TOOL_NAMES, LOCAL_TOOLS } from "./local-tools.ts";
import { refusalResult, type Refusal } from "./refusal.ts";
import { Remote, type Progress } from "./remote.ts";
import { VERSION } from "./version.ts";

const LOCAL_NOTE =
  "This is HeyPCB's local MCP server (@heypcb/mcp). Besides HeyPCB's own tools it adds upload_kicad_project " +
  "(send a KiCad project folder from this computer to HeyPCB) and save_export (save Gerbers, BOM, CPL, STEP or the KiCad project to a folder here). " +
  "A tool that answers ok:false explains itself in `error` and says what to do in `fix`.";

export type ServeOptions = {
  config: Config | null;
  /** When the configuration itself is unusable, every tool answers this. */
  configRefusal?: Refusal;
  store: CredentialStore;
  /** How long to wait for the remote server before answering `initialize` (ms). */
  startupWaitMs?: number;
  /** Test seams. */
  home?: string;
  cwd?: string;
  auth?: Auth;
  log?: (line: string) => void;
};

export type Running = { server: Server; remote: Remote | null; close: () => Promise<void> };

export async function startServer(transport: Transport, opts: ServeOptions): Promise<Running> {
  const log = opts.log ?? ((line: string) => process.stderr.write(`[heypcb-mcp] ${line}\n`));
  const config = opts.config;
  const auth = config ? (opts.auth ?? new Auth(config, opts.store)) : null;
  const remote = config && auth ? new Remote(config, auth) : null;

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
    if (!config || !auth || !remote) return refusalResult(opts.configRefusal!);
    if (LOCAL_TOOL_NAMES.has(name)) return callLocalTool({ config, auth, home: opts.home, cwd: opts.cwd }, name, args, extra.signal);
    const token = req.params._meta?.progressToken;
    const relay = (p: Progress) => {
      if (token === undefined) return;
      extra
        .sendNotification({ method: "notifications/progress", params: { progressToken: token, progress: p.progress, ...(p.total !== undefined ? { total: p.total } : {}), ...(p.message !== undefined ? { message: p.message } : {}) } })
        .catch(() => {});
    };
    const result = await remote.callTool(name, args, { signal: extra.signal, onProgress: relay, meta: req.params._meta as Record<string, unknown> | undefined });
    // A call that reached the remote server may have shown it has (other) tools now.
    notifyIfChanged();
    return result;
  });

  await server.connect(transport);
  return {
    server,
    remote,
    close: async () => {
      await remote?.close();
      await server.close();
    },
  };
}
