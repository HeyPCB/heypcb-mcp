/**
 * A fake HeyPCB API host for the tests and the local smoke run: a real MCP
 * server on POST /mcp (the official SDK, stateless Streamable HTTP, as the
 * contract's remote server is), the device-code and token endpoints, and the
 * REST routes the local tools call — the import, exports, the project file
 * API (revisions, 409 on a stale base), part assets — and a charge ledger
 * keyed by idempotency key. Everything it receives is recorded.
 */
import http from "node:http";
import { AddressInfo } from "node:net";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { createHash, webcrypto } from "node:crypto";
import { readZip } from "./helpers.ts";

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

/** Tools that work on a project's files in the fake: they change the board and report the revision, parts and charge. */
export const DESIGN_TOOLS: Tool[] = [
  {
    name: "edit_board",
    description: "Appends `text` to the project's board on HeyPCB (a design change).",
    inputSchema: { type: "object", properties: { project: { type: "string" }, text: { type: "string" } }, required: ["project"] },
    annotations: { readOnlyHint: false },
  },
  {
    name: "add_parts",
    description: "Adds parts to the board; names them in _meta.heypcb.parts.",
    inputSchema: { type: "object", properties: { project: { type: "string" }, parts: { type: "array", items: { type: "string" } } }, required: ["project"] },
    annotations: { readOnlyHint: false },
  },
  {
    name: "read_board",
    description: "Reads the project's board as HeyPCB has it.",
    inputSchema: { type: "object", properties: { project: { type: "string" } }, required: ["project"] },
    annotations: { readOnlyHint: true },
  },
  {
    name: "whoami",
    description: "Your account and balance.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
  },
];

/** Everything the fake's MCP server lists. */
export const FAKE_TOOLS: Tool[] = [...REMOTE_TOOLS, ...DESIGN_TOOLS];

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
  /** Offer the project file API (default true). */
  filesApi?: boolean;
  /** Price per tool call (the ledger charges once per idempotency key). */
  prices?: Record<string, number>;
  /** Leave `_meta.heypcb.revision` out of results (the client then asks the file list). */
  omitRevision?: boolean;
  /** Called while a design tool runs, before it answers (to act "during the call"). */
  duringCall?: (tool: string) => Promise<void> | void;
};

export type FakeProject = { revision: number; files: Map<string, Buffer>; stem: string };

export type Fake = {
  url: string;
  mcpUrl: string;
  requests: Recorded[];
  rpc: Array<{ method?: string; id?: unknown; params?: Record<string, unknown> }>;
  /** JSON-RPC ids of tools/call requests the fake saw cancelled. */
  cancelled: unknown[];
  opts: FakeOptions;
  projects: Map<string, FakeProject>;
  /** Idempotency key → amount charged. */
  ledger: Map<string, number>;
  /** Change a file on HeyPCB's side, as an edit on the web would. */
  editFile: (id: string, path: string, data: string | Buffer) => void;
  revisionOf: (id: string) => string;
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
  const projects = new Map<string, FakeProject>();
  const ledger = new Map<string, number>();
  let balance = 100;
  const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
  const rev = (p: FakeProject) => `r${p.revision}`;
  const listing = (p: FakeProject) => ({ ok: true, revision: rev(p), files: [...p.files].map(([path, data]) => ({ path, sha256: sha(data), bytes: data.length })) });
  const editFile = (id: string, path: string, data: string | Buffer) => {
    const p = projects.get(id)!;
    p.files.set(path, Buffer.from(data));
    p.revision++;
  };

  const bearerOk = (req: http.IncomingMessage) => {
    const h = req.headers.authorization ?? "";
    const tok = h.startsWith("Bearer ") ? h.slice(7) : "";
    return !opts.acceptTokens || opts.acceptTokens.has(tok);
  };
  const unauthorized = (res: http.ServerResponse) =>
    json(res, 401, { ok: false, code: "token_expired", error: "This access token has expired.", fix: "Refresh it.", retryable: false }, { "www-authenticate": 'Bearer error="invalid_token"' });

  function mcpServer(): Server {
    const s = new Server({ name: "fake-heypcb", version: "0.0.0" }, { capabilities: { tools: {} }, instructions: "Fake HeyPCB remote: use echo." });
    s.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: FAKE_TOOLS }));
    s.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
      const args = (req.params.arguments ?? {}) as Record<string, unknown>;
      const name = req.params.name;
      if (DESIGN_TOOLS.some((t) => t.name === name)) return designTool(name, args, (req.params._meta ?? {}) as Record<string, unknown>);
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

  async function designTool(name: string, args: Record<string, unknown>, meta: Record<string, unknown>) {
    const h = (meta.heypcb ?? {}) as { maxCost?: number; idempotencyKey?: string };
    const price = opts.prices?.[name] ?? 0;
    const key = h.idempotencyKey ?? "";
    const replay = key !== "" && ledger.has(key);
    if (!replay && typeof h.maxCost === "number" && price > h.maxCost) {
      const r = { ok: false, code: "over_max_cost", error: `${name} costs ${price}, more than maxCost ${h.maxCost}.`, fix: "Raise the cap.", retryable: false };
      return { isError: true, content: [{ type: "text", text: JSON.stringify(r) }], structuredContent: r, _meta: { heypcb: { billing: { charged: 0, balance, unit: "USD" } } } };
    }
    const billing = () => {
      let charged = 0;
      if (!replay && price > 0) {
        ledger.set(key, price);
        balance -= price;
        charged = price;
      }
      return { charged, balance, unit: "USD" };
    };
    if (name === "whoami") return { content: [{ type: "text", text: JSON.stringify({ ok: true, balance }) }], structuredContent: { ok: true, balance }, _meta: { heypcb: { billing: billing() } } };
    const p = projects.get(String(args.project ?? ""));
    if (!p) {
      const r = { ok: false, code: "not_found", error: "no such project", fix: "", retryable: false };
      return { isError: true, content: [{ type: "text", text: JSON.stringify(r) }], structuredContent: r };
    }
    await opts.duringCall?.(name);
    const board = `${p.stem}.kicad_pcb`;
    if (name === "edit_board" || name === "add_parts") {
      if (!replay) {
        const text = name === "edit_board" ? String(args.text ?? "(edited)") : `(parts ${(args.parts as string[] | undefined)?.join(" ") ?? ""})`;
        const cur = (p.files.get(board) ?? Buffer.from("(kicad_pcb\n)\n")).toString("utf8");
        editFile(String(args.project), board, cur.replace(/\)\s*$/, `  ${text}\n)\n`));
      }
    }
    const heypcb: Record<string, unknown> = { billing: billing() };
    if (!opts.omitRevision) heypcb.revision = rev(p);
    if (name === "add_parts") heypcb.parts = args.parts ?? [];
    const out = { ok: true, board: p.files.get(board)?.toString("utf8") ?? null };
    return { content: [{ type: "text", text: JSON.stringify(out) }], structuredContent: out, _meta: { heypcb } };
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
        const list = opts.importAnswers ?? [{ status: 200, body: { ok: true, project: { id: `prj_${123 + projects.size}`, name: "fake", revision: "r1" } } }];
        const a = list[Math.min(importIdx++, list.length - 1)];
        const id = (a.body.project as { id?: string } | undefined)?.id;
        if (a.status === 200 && id) {
          // Keep what was uploaded, as the server's copy of the project.
          const zip = parseZipUpload(body, String(req.headers["content-type"] ?? ""));
          const files = zip ? readZip(zip) : new Map<string, Buffer>();
          const pro = [...files.keys()].find((f) => /\.kicad_(pro|pcb|sch)$/.test(f) && !f.includes("/"));
          projects.set(id, { revision: 1, files, stem: pro ? pro.replace(/\.kicad_(pro|pcb|sch)$/, "") : "board" });
        }
        return json(res, a.status, a.body);
      }
      const ex = /^\/v1\/projects\/([^/]+)\/exports\/([a-z]+)$/.exec(url.pathname);
      if (ex && req.method === "GET") {
        if (!bearerOk(req)) return unauthorized(res);
        const a = opts.exportAnswer ?? { status: 200, headers: { "content-type": "application/zip", "content-disposition": `attachment; filename="${ex[1]}-${ex[2]}.zip"` }, body: Buffer.from("PK-fake-export") };
        res.writeHead(a.status, a.headers);
        return res.end(a.body);
      }
      const fm = /^\/v1\/projects\/([^/]+)\/files(\/content)?$/.exec(url.pathname);
      if (fm && opts.filesApi !== false) {
        if (!bearerOk(req)) return unauthorized(res);
        const p = projects.get(decodeURIComponent(fm[1]));
        if (!p) return json(res, 404, { ok: false, code: "not_found", error: "no such project", fix: "", retryable: false });
        if (fm[2] && req.method === "GET") {
          const data = p.files.get(url.searchParams.get("path") ?? "");
          if (!data) return json(res, 404, { ok: false, code: "not_found", error: "no such file", fix: "", retryable: false });
          res.writeHead(200, { "content-type": "application/octet-stream" });
          return res.end(data);
        }
        if (!fm[2] && req.method === "GET") return json(res, 200, listing(p));
        if (!fm[2] && req.method === "PUT") {
          const b = JSON.parse(body.toString("utf8")) as { baseRevision: string | null; files: Array<{ path: string; sha256: string; contentBase64: string }>; delete: string[] };
          if (b.baseRevision !== rev(p)) return json(res, 409, { ok: false, code: "revision_conflict", error: "HeyPCB's copy changed.", fix: "", retryable: false, revision: rev(p) });
          for (const f of b.files) {
            const data = Buffer.from(f.contentBase64, "base64");
            if (sha(data) !== f.sha256) return json(res, 400, { ok: false, code: "bad_sha", error: f.path, fix: "", retryable: false });
            p.files.set(f.path, data);
          }
          for (const d of b.delete) p.files.delete(d);
          p.revision++;
          return json(res, 200, listing(p));
        }
      }
      const pa = /^\/v1\/parts\/([^/]+)\/assets$/.exec(url.pathname);
      if (pa && req.method === "GET") {
        if (!bearerOk(req)) return unauthorized(res);
        const a = PART_ASSETS[decodeURIComponent(pa[1])];
        if (!a) return json(res, 404, { ok: false, code: "part_not_found", error: "no such part", fix: "", retryable: false });
        return json(res, 200, { ok: true, ...a });
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
    projects,
    ledger,
    editFile,
    revisionOf: (id) => rev(projects.get(id)!),
    close: () =>
      new Promise<void>((r) => {
        for (const c of inflight.values()) c.abort();
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  };
}

/** The `file` part of a multipart upload. */
function parseZipUpload(body: Buffer, contentType: string): Buffer | null {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType);
  if (!m) return null;
  const boundary = Buffer.from(`--${m[1] ?? m[2]}`);
  let at = body.indexOf(boundary);
  while (at >= 0) {
    const next = body.indexOf(boundary, at + boundary.length);
    if (next < 0) break;
    const part = body.subarray(at + boundary.length, next);
    const headEnd = part.indexOf("\r\n\r\n");
    if (headEnd >= 0 && /name="file"/.test(part.subarray(0, headEnd).toString("utf8"))) return part.subarray(headEnd + 4, part.length - 2);
    at = next;
  }
  return null;
}

const SYMBOL = (name: string) =>
  `(symbol "${name}" (in_bom yes) (on_board yes)\n    (property "Reference" "U" (at 0 0 0) (effects (font (size 1.27 1.27))))\n    (property "Footprint" "" (at 0 0 0) (effects (font (size 1.27 1.27)) hide))\n    (symbol "${name}_1_1" (pin passive line (at 0 0 0) (length 2.54) (name "A") (number "1")))\n  )`;

/** Part assets the fake serves on GET /v1/parts/{id}/assets. */
export const PART_ASSETS: Record<string, unknown> = {
  C2040: {
    part: { id: "C2040", lcsc: "C2040" },
    symbol: { name: "RP2040", text: `(kicad_symbol_lib (version 20241209) (generator "heypcb")\n  ${SYMBOL("RP2040")}\n)` },
    footprint: { name: "QFN-56_7x7mm", text: `(footprint "QFN-56" (layer "F.Cu")\n  (pad "1" smd rect (at 0 0) (size 0.2 0.8) (layers "F.Cu"))\n  (model "\${KICAD9_3DMODEL_DIR}/Package_DFN_QFN.3dshapes/QFN-56.step" (offset (xyz 0 0 0)))\n)` },
    model: { name: "QFN-56_7x7mm.step", contentBase64: Buffer.from("ISO-10303-21; fake step").toString("base64") },
  },
  C1525: {
    part: { id: "C1525", lcsc: "C1525" },
    symbol: { name: "C_100nF", text: SYMBOL("C_100nF") },
    footprint: { name: "C_0402", text: `(footprint "C_0402" (layer "F.Cu")\n  (pad "1" smd rect (at -0.5 0) (size 0.5 0.5) (layers "F.Cu"))\n)` },
    model: null,
  },
};
