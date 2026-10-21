/**
 * The link to HeyPCB's remote MCP server (Streamable HTTP): connect, list
 * its tools, forward a call with its progress and cancellation, and turn a
 * transport failure into a refusal the agent can act on. It never reads or
 * changes what a tool returns: a result — a refusal included — reaches the
 * agent exactly as the remote server sent it.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  CallToolResultSchema,
  ErrorCode,
  McpError,
  ToolListChangedNotificationSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type { Auth } from "./auth.ts";
import type { Config } from "./config.ts";
import { asRefusal, refusal, RefusalError, refusalResult, type Refusal } from "./refusal.ts";
import { VERSION } from "./version.ts";

export type Progress = { progress: number; total?: number; message?: string };

export type ForwardOptions = {
  signal?: AbortSignal;
  /** Called for each progress notification the remote server sends. */
  onProgress?: (p: Progress) => void;
  /** The caller's own `_meta`, passed on (its progress token is replaced by ours). */
  meta?: Record<string, unknown>;
};

/** How long a failed connect is remembered before a tools/list tries again. */
const RETRY_LIST_AFTER_MS = 5_000;
const CONNECT_TIMEOUT_MS = 20_000;

function errorText(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as Error & { cause?: unknown }).cause;
    const c = cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "";
    return c && !err.message.includes(c) ? `${err.message}: ${c}` : err.message;
  }
  return String(err);
}

/** The JSON body the transport folded into its error message, if any. */
function bodyOf(err: StreamableHTTPError): unknown {
  const i = err.message.indexOf("{");
  if (i < 0) return null;
  try {
    return JSON.parse(err.message.slice(i));
  } catch {
    return null;
  }
}

export class Remote {
  readonly config: Config;
  readonly auth: Auth;
  private client: Client | null = null;
  private connecting: Promise<Client> | null = null;
  private lastFailure: { at: number; refusal: Refusal } | null = null;
  /** The remote server's tools as last listed; null until it has answered. */
  tools: Tool[] | null = null;
  instructions: string | undefined;
  /** Told when `tools` changes (connect, reconnect, the server's own list_changed). */
  onToolsChanged: (() => void) | null = null;

  constructor(config: Config, auth: Auth) {
    this.config = config;
    this.auth = auth;
  }

  get connected(): boolean {
    return this.client !== null;
  }

  /** Connect if not connected. Throws RefusalError. */
  connect(): Promise<Client> {
    if (this.client) return Promise.resolve(this.client);
    if (this.connecting) return this.connecting;
    this.connecting = this.open()
      .then((c) => {
        this.lastFailure = null;
        return c;
      })
      .catch((err) => {
        const r = this.translate(err);
        this.lastFailure = { at: Date.now(), refusal: r };
        throw new RefusalError(r);
      })
      .finally(() => {
        this.connecting = null;
      });
    return this.connecting;
  }

  /** Try to connect for a tools/list, unless the last attempt failed a moment ago. Never throws. */
  async tryConnect(): Promise<boolean> {
    if (this.client) return true;
    if (this.lastFailure && Date.now() - this.lastFailure.at < RETRY_LIST_AFTER_MS) return false;
    try {
      await this.connect();
      return true;
    } catch {
      return false;
    }
  }

  private async open(): Promise<Client> {
    if (!(await this.auth.hasCredentials())) throw new RefusalError(this.auth.missing());
    const client = new Client({ name: "heypcb-mcp", version: VERSION }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(this.config.mcpUrl, {
      fetch: (url, init) => this.auth.fetch(url, init),
      requestInit: { headers: { "user-agent": this.config.userAgent } },
    });
    client.onclose = () => {
      if (this.client === client) this.client = null;
    };
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      if (this.client === client) await this.refreshTools(client).catch(() => {});
    });
    try {
      await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
      this.instructions = client.getInstructions();
      await this.refreshTools(client);
    } catch (err) {
      await client.close().catch(() => {});
      throw err;
    }
    this.client = client;
    return client;
  }

  private async refreshTools(client: Client): Promise<void> {
    const all: Tool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 50; page++) {
      const res = await client.listTools(cursor ? { cursor } : undefined, { timeout: CONNECT_TIMEOUT_MS });
      all.push(...res.tools);
      cursor = res.nextCursor;
      if (!cursor) break;
    }
    const before = JSON.stringify(this.tools);
    this.tools = all;
    if (JSON.stringify(all) !== before) this.onToolsChanged?.();
  }

  /** Drop the connection (the next call reconnects). */
  async reset(): Promise<void> {
    const c = this.client;
    this.client = null;
    await c?.close().catch(() => {});
  }

  async close(): Promise<void> {
    await this.reset();
  }

  /**
   * Forward one tools/call. Returns the remote result untouched, a refusal
   * result for a transport failure, or rethrows a JSON-RPC error the remote
   * server answered (so the agent sees the same error) and a cancellation.
   */
  async callTool(name: string, args: Record<string, unknown> | undefined, opts: ForwardOptions = {}): Promise<CallToolResult> {
    for (let attempt = 0; ; attempt++) {
      let client: Client;
      try {
        client = await this.connect();
      } catch (err) {
        return refusalResult(this.translate(err));
      }
      const meta = { ...(opts.meta ?? {}) };
      delete meta.progressToken;
      try {
        const result = await client.request(
          { method: "tools/call", params: { name, ...(args !== undefined ? { arguments: args } : {}), ...(Object.keys(meta).length ? { _meta: meta } : {}) } },
          CallToolResultSchema,
          {
            signal: opts.signal,
            timeout: this.config.callTimeoutMs,
            resetTimeoutOnProgress: true,
            onprogress: (p) => opts.onProgress?.(p),
          }
        );
        return result as CallToolResult;
      } catch (err) {
        if (opts.signal?.aborted) throw err;
        if (err instanceof McpError) {
          if (err.code === ErrorCode.RequestTimeout) {
            return refusalResult(
              this.callFailure(name, args, err, refusal(
                "remote_timeout",
                `HeyPCB's ${name} did not answer within ${Math.round(this.config.callTimeoutMs / 60000)} minutes.`,
                "It may still be running on HeyPCB: read its state (for a turn, call wait_for_turn; for a board, get_board) before calling it again.",
                { retryable: true }
              ))
            );
          }
          if (err.code === ErrorCode.ConnectionClosed) {
            await this.reset();
            return refusalResult(this.callFailure(name, args, err));
          }
          throw err; // the remote server's own JSON-RPC error, passed through
        }
        // A stateful server forgot our session (it restarted): the call never ran, so it is safe to send once more.
        if (err instanceof StreamableHTTPError && err.code === 404 && attempt === 0 && (client.transport as StreamableHTTPClientTransport | undefined)?.sessionId) {
          await this.reset();
          continue;
        }
        // A 4xx is an answer (the connection is fine); anything else drops the link so the next call reconnects.
        const answered = err instanceof StreamableHTTPError && typeof err.code === "number" && err.code >= 400 && err.code < 500;
        if (!answered && !(err instanceof RefusalError)) await this.reset();
        return refusalResult(this.callFailure(name, args, err));
      }
    }
  }

  /** A dispatched write whose reply was lost may already have changed the board. */
  private callFailure(name: string, args: Record<string, unknown> | undefined, err: unknown, failure = this.translate(err)): Refusal {
    const readOnly = this.tools?.find((t) => t.name === name)?.annotations?.readOnlyHint === true;
    // The server's own refusal is an answer, as is an HTTP 4xx. Keep its
    // recovery verbatim. A gateway 5xx, disconnect or timeout proves nothing
    // about whether a tool executed, even when reconnecting is safe.
    const answered = err instanceof RefusalError || (err instanceof StreamableHTTPError && (
      asRefusal(bodyOf(err), err.code) !== null || (typeof err.code === "number" && err.code >= 400 && err.code < 500)
    ));
    if (readOnly || answered) return failure;
    const project = typeof args?.project === "string" ? args.project : null;
    const read = project
      ? { tool: "get_design_summary", args: { project } }
      : { tool: "list_projects", args: {} };
    return refusal(
      "write_outcome_unknown",
      `HeyPCB's reply to ${name} was lost; the call may already have changed the board or started a run.`,
      `Do not repeat ${name}. First call ${read.tool} with ${JSON.stringify(read.args)} to inspect what landed${project ? "; get_board reads the board's stage and checks" : " and find any project it created"}. If a run returned a turn, job or handle earlier, collect that same run. Only send a new write after its outcome is known.`,
      { tool: name, ...(project ? { project } : {}), cause: failure.code, inspectWith: read }
    );
  }

  /** A failure as a refusal the agent can act on. */
  translate(err: unknown): Refusal {
    if (err instanceof RefusalError) return err.refusal;
    const url = this.config.mcpUrl.href;
    if (err instanceof StreamableHTTPError) {
      const status = err.code ?? -1;
      const passed = asRefusal(bodyOf(err), status);
      if (passed) return passed;
      if (status === 404 || status === 405) {
        return refusal(
          "remote_unavailable",
          `HeyPCB's MCP server was not found at ${url} (HTTP ${status}).`,
          "If you set HEYPCB_MCP_URL, check it. Otherwise HeyPCB may be updating: call the tool again in a few minutes. upload_kicad_project and save_export work without it.",
          { retryable: true, status }
        );
      }
      if (status === 429) return refusal("rate_limited", "HeyPCB is asking for fewer requests for a moment.", "Wait a minute, then call the tool again.", { retryable: true, status });
      if (status >= 500) {
        return refusal("remote_unavailable", `HeyPCB's MCP server answered HTTP ${status}.`, "HeyPCB may be updating: call the tool again in a minute.", { retryable: true, status });
      }
      return refusal("remote_error", `HeyPCB's MCP server refused the request (HTTP ${status}).`, "Check the tool's arguments; if it keeps happening, update with `npx -y @heypcb/mcp@latest`.", { status });
    }
    if (err instanceof McpError) {
      if (err.code === ErrorCode.ConnectionClosed) {
        return refusal("remote_unreachable", "The connection to HeyPCB's MCP server closed.", "Call the tool again; it reconnects.", { retryable: true });
      }
      return refusal("remote_error", `HeyPCB's MCP server answered an error: ${err.message}`, "Check the tool's arguments, then call it again.");
    }
    return refusal("remote_unreachable", `HeyPCB's MCP server at ${url} could not be reached (${errorText(err)}).`, "Check this computer's internet connection, then call the tool again.", {
      retryable: true,
    });
  }
}
