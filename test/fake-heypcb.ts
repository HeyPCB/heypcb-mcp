/**
 * A fake HeyPCB API host for the tests and the local smoke run: a real MCP
 * server on POST /mcp (the official SDK, stateless Streamable HTTP, as the
 * contract's remote server is), the device-code and token endpoints, and the
 * two REST routes the local tools call. Everything it receives is recorded.
 */
import http from "node:http";
import { AddressInfo } from "node:net";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { webcrypto } from "node:crypto";

// The SDK's SERVER transport (only this fake uses it) reads the global
// `crypto`, which Node 18 does not define without a flag.
if (!(globalThis as { crypto?: unknown }).crypto) (globalThis as { crypto?: unknown }).crypto = webcrypto;

export const REMOTE_TOOLS: Tool[] = [
  {
    name: "echo",
    title: "Echo",
    description: "Answers with what it was sent. Free.",
    inputSchema: { type: "object", properties: { text: { type: "string", description: "Anything." }, n: { type: "integer", minimum: 0 } }, required: ["text"] },
    annotations: { readOnlyHint: true },
  },
  {
    name: "slow",
    description: "Sends progress, then waits until it is cancelled or `finishAfterMs` passes.",
    inputSchema: { type: "object", properties: { steps: { type: "integer" }, finishAfterMs: { type: "integer" } } },
  },
  {
    name: "refuse",
    description: "Always answers a refusal.",
    inputSchema: { type: "object", properties: {} },
    outputSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
  },
  {
    name: "bad_params",
    description: "Always answers a JSON-RPC InvalidParams error.",
    inputSchema: { type: "object", properties: {} },
  },
];

export const REFUSAL = { ok: false, code: "wallet_empty", error: "Your HeyPCB balance is used up.", fix: "Add credit in Settings → Plan & billing, then call build_board again.", retryable: false };

export type Recorded = { method: string; path: string; headers: http.IncomingHttpHeaders; body: Buffer };

export type FakeOptions = {
  /** Bearers /mcp and /v1 accept. Anything else is 401 token_expired. */
  acceptTokens?: Set<string>;
  /** Answers for POST /oauth/token, in order (the last repeats). */
  tokenAnswers?: Array<{ status: number; body: Record<string, unknown> }>;
  deviceCodeAnswer?: { status: number; body: Record<string, unknown> };
  /** Answers for POST /v1/projects/import, in order (the last repeats). */
  importAnswers?: Array<{ status: number; body: Record<string, unknown> }>;
  exportAnswer?: { status: number; headers: Record<string, string>; body: Buffer | string };
  /** /mcp answers this status to everything (to test transport failures). */
  mcpStatus?: number;
};

export type Fake = {
  url: string;
  mcpUrl: string;
  requests: Recorded[];
  rpc: Array<{ method?: string; id?: unknown; params?: Record<string, unknown> }>;
  /** JSON-RPC ids of tools/call requests the fake saw cancelled. */
  cancelled: unknown[];
  opts: FakeOptions;
  close: () => Promise<void>;
};

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function json(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
  res.end(JSON.stringify(body));
}

export async function startFakeHeypcb(opts: FakeOptions = {}): Promise<Fake> {
  const requests: Recorded[] = [];
  const rpc: Fake["rpc"] = [];
  const cancelled: unknown[] = [];
  const inflight = new Map<string, AbortController>();
  let tokenIdx = 0;
  let importIdx = 0;

  const bearerOk = (req: http.IncomingMessage) => {
    const h = req.headers.authorization ?? "";
    const tok = h.startsWith("Bearer ") ? h.slice(7) : "";
    return !opts.acceptTokens || opts.acceptTokens.has(tok);
  };
  const unauthorized = (res: http.ServerResponse) =>
    json(res, 401, { ok: false, code: "token_expired", error: "This access token has expired.", fix: "Refresh it.", retryable: false }, { "www-authenticate": 'Bearer error="invalid_token"' });

  function mcpServer(): Server {
    const s = new Server({ name: "fake-heypcb", version: "0.0.0" }, { capabilities: { tools: {} }, instructions: "Fake HeyPCB remote: use echo." });
    s.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: REMOTE_TOOLS }));
    s.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
      const args = (req.params.arguments ?? {}) as Record<string, unknown>;
      switch (req.params.name) {
        case "echo":
          return { content: [{ type: "text", text: JSON.stringify(args) }], structuredContent: { echoed: args, meta: req.params._meta ?? null } };
        case "refuse":
          return { isError: true, content: [{ type: "text", text: JSON.stringify(REFUSAL) }], structuredContent: REFUSAL };
        case "bad_params":
          throw new McpError(ErrorCode.InvalidParams, "brief is required");
        case "slow": {
          const ctl = new AbortController();
          inflight.set(String(extra.requestId), ctl);
          const token = req.params._meta?.progressToken;
          const steps = Number(args.steps ?? 3);
          for (let i = 1; i <= steps; i++) {
            if (token !== undefined) await extra.sendNotification({ method: "notifications/progress", params: { progressToken: token, progress: i, total: steps, message: `step ${i}` } });
          }
          const finish = Number(args.finishAfterMs ?? 0);
          await new Promise<void>((resolve) => {
            ctl.signal.addEventListener("abort", () => resolve(), { once: true });
            if (finish > 0) setTimeout(resolve, finish);
          });
          inflight.delete(String(extra.requestId));
          return { content: [{ type: "text", text: ctl.signal.aborted ? "cancelled" : "done" }] };
        }
        default:
          throw new McpError(ErrorCode.MethodNotFound, `no tool ${req.params.name}`);
      }
    });
    return s;
  }

  const server = http.createServer(async (req, res) => {
    const body = await readBody(req);
    const url = new URL(req.url ?? "/", "http://x");
    requests.push({ method: req.method ?? "", path: url.pathname, headers: req.headers, body });
    try {
      if (url.pathname === "/mcp") {
        if (opts.mcpStatus) return json(res, opts.mcpStatus, { ok: false, code: "not_found", error: "There's nothing at this address.", fix: "HeyPCB is at https://heypcb.ai.", retryable: false });
        if (!bearerOk(req)) return unauthorized(res);
        if (req.method !== "POST") {
          res.writeHead(405, { allow: "POST" });
          return res.end();
        }
        const parsed = JSON.parse(body.toString("utf8"));
        for (const m of Array.isArray(parsed) ? parsed : [parsed]) {
          rpc.push(m);
          if (m.method === "notifications/cancelled") {
            cancelled.push(m.params?.requestId);
            inflight.get(String(m.params?.requestId))?.abort();
          }
        }
        const s = mcpServer();
        const t = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        res.on("close", () => {
          t.close().catch(() => {});
          s.close().catch(() => {});
        });
        await s.connect(t);
        await t.handleRequest(req, res, parsed);
        return;
      }
      if (url.pathname === "/oauth/device/code" && req.method === "POST") {
        const a = opts.deviceCodeAnswer ?? {
          status: 200,
          body: { device_code: "hpcb_dc_fake", user_code: "BCDF-GHJK", verification_uri: "http://x/connect", verification_uri_complete: "http://x/connect?code=BCDF-GHJK", expires_in: 900, interval: 5 },
        };
        return json(res, a.status, a.body);
      }
      if (url.pathname === "/oauth/token" && req.method === "POST") {
        const list = opts.tokenAnswers ?? [{ status: 400, body: { error: "invalid_grant" } }];
        const a = list[Math.min(tokenIdx++, list.length - 1)];
        if (a.status === 200 && typeof a.body.access_token === "string") opts.acceptTokens?.add(a.body.access_token);
        return json(res, a.status, a.body);
      }
      if (url.pathname === "/oauth/revoke" && req.method === "POST") return json(res, 200, {});
      if (url.pathname === "/v1/me") {
        if (!bearerOk(req)) return unauthorized(res);
        return json(res, 200, { ok: true, user: { id: "u1", email: "ada@example.com", name: "Ada" }, plan: { id: "pro", name: "Pro" } });
      }
      if (url.pathname === "/v1/projects/import" && req.method === "POST") {
        if (!bearerOk(req)) return unauthorized(res);
        const list = opts.importAnswers ?? [{ status: 200, body: { ok: true, project: { id: "prj_123", name: "fake", revision: "r_0123456789abcdef" } } }];
        const a = list[Math.min(importIdx++, list.length - 1)];
        return json(res, a.status, a.body);
      }
      const ex = /^\/v1\/projects\/([^/]+)\/exports\/([a-z]+)$/.exec(url.pathname);
      if (ex && req.method === "GET") {
        if (!bearerOk(req)) return unauthorized(res);
        const a = opts.exportAnswer ?? { status: 200, headers: { "content-type": "application/zip", "content-disposition": `attachment; filename="${ex[1]}-${ex[2]}.zip"` }, body: Buffer.from("PK-fake-export") };
        res.writeHead(a.status, a.headers);
        return res.end(a.body);
      }
      json(res, 404, { ok: false, code: "not_found", error: "nothing here", fix: "", retryable: false });
    } catch (err) {
      if (!res.headersSent) json(res, 500, { ok: false, code: "fake_error", error: String(err), fix: "", retryable: true });
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  const url = `http://127.0.0.1:${port}`;
  return {
    url,
    mcpUrl: `${url}/mcp`,
    requests,
    rpc,
    cancelled,
    opts,
    close: () =>
      new Promise<void>((r) => {
        for (const c of inflight.values()) c.abort();
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  };
}
