/**
 * The proxy against a fake remote MCP server (the official SDK's own server,
 * stateless Streamable HTTP): tools re-exposed 1:1, calls, results, refusals,
 * JSON-RPC errors, progress and cancellation forwarded, and the sign-in
 * refusal when there is nothing to sign in with.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ErrorCode, McpError, ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { CredentialStore } from "../src/credentials.ts";
import { startServer, type Running } from "../src/server.ts";
import { LOCAL_TOOLS } from "../src/local-tools.ts";
import { OFFLINE_CATALOG } from "../src/catalog.ts";
import { FAKE_TOOLS, REFUSAL, startFakeHeypcb, type Fake, type FakeOptions } from "./fake-heypcb.ts";
import { configFor, TEST_KEY, tmpDir, until } from "./helpers.ts";

const cleanups: Array<() => Promise<void>> = [];
after(async () => {
  for (const c of cleanups.reverse()) await c().catch(() => {});
});

async function setup(env: Record<string, string>, fakeOpts: FakeOptions = {}, fake?: Fake) {
  const f = fake ?? (await startFakeHeypcb(fakeOpts));
  if (!fake) cleanups.push(f.close);
  const config = configFor(f.mcpUrl, env);
  const dir = tmpDir();
  const store = new CredentialStore(path.join(dir, "credentials.json"));
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const running: Running = await startServer(serverSide, { config, store, startupWaitMs: 5000, log: () => {}, home: dir });
  const client = new Client({ name: "test-agent", version: "1.0.0" }, { capabilities: {} });
  let listChanged = 0;
  client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
    listChanged++;
  });
  await client.connect(clientSide);
  cleanups.push(async () => {
    await client.close();
    await running.close();
  });
  return { fake: f, client, store, config, running, listChangedCount: () => listChanged };
}

test("lists the remote tools 1:1 (names, schemas, descriptions) and adds the local tools", async () => {
  const { client } = await setup({ HEYPCB_API_KEY: TEST_KEY }, { acceptTokens: new Set([TEST_KEY]) });
  const { tools } = await client.listTools();
  for (const remote of FAKE_TOOLS) {
    assert.deepEqual(
      tools.find((t) => t.name === remote.name),
      remote,
      `${remote.name} is re-exposed exactly`
    );
  }
  assert.deepEqual(
    tools.map((t) => t.name),
    [...FAKE_TOOLS.map((t) => t.name), ...LOCAL_TOOLS.map((t) => t.name)]
  );
  const instructions = client.getInstructions() ?? "";
  assert.match(instructions, /Fake HeyPCB remote: use echo\./, "the remote server's instructions are passed on");
  assert.match(instructions, /upload_kicad_project/);
});

test("forwards a call with the bearer and returns the result untouched", async () => {
  const { client, fake } = await setup({ HEYPCB_API_KEY: TEST_KEY }, { acceptTokens: new Set([TEST_KEY]) });
  const res = await client.callTool({ name: "echo", arguments: { text: "hi", n: 2 } });
  assert.equal(res.isError, undefined);
  assert.deepEqual((res.structuredContent as { echoed: unknown }).echoed, { text: "hi", n: 2 });
  assert.deepEqual(res.content, [{ type: "text", text: JSON.stringify({ text: "hi", n: 2 }) }]);
  const mcpCalls = fake.requests.filter((r) => r.path === "/mcp" && r.method === "POST");
  assert.ok(mcpCalls.length >= 3, "initialize, initialized, tools/list and the call went to /mcp");
  for (const r of mcpCalls) {
    assert.equal(r.headers.authorization, `Bearer ${TEST_KEY}`);
    assert.match(String(r.headers["user-agent"]), /^heypcb-mcp\/\d+\.\d+\.\d+ \(node /);
  }
});

test("passes a refusal through exactly as the remote server sent it", async () => {
  const { client } = await setup({ HEYPCB_API_KEY: TEST_KEY }, { acceptTokens: new Set([TEST_KEY]) });
  const res = await client.callTool({ name: "refuse", arguments: {} });
  assert.equal(res.isError, true);
  assert.deepEqual(res.structuredContent, REFUSAL);
  assert.deepEqual(res.content, [{ type: "text", text: JSON.stringify(REFUSAL) }]);
});

for (const status of [undefined, 502]) {
  test(`a lost write reply (${status ?? "disconnect"}) requires readback and is never replayed`, async () => {
    const { client, fake } = await setup({ HEYPCB_API_KEY: TEST_KEY }, { acceptTokens: new Set([TEST_KEY]), mcpCallFault: { name: "slow", status } });
    const res = await client.callTool({ name: "slow", arguments: { project: "prj_1" } });
    const r = res.structuredContent as { code: string; retryable: boolean; written?: boolean; fix: string; inspectWith: unknown };
    assert.equal(r.code, "write_outcome_unknown");
    assert.equal(r.retryable, false);
    assert.equal(r.written, undefined, "the caller cannot claim the write did not happen");
    assert.match(r.fix, /Do not repeat slow/);
    assert.deepEqual(r.inspectWith, { tool: "get_design_summary", args: { project: "prj_1" } });
    assert.equal(fake.rpc.filter((m) => m.method === "tools/call" && m.params?.name === "slow").length, 1);
  });
}

test("a lost read reply remains retryable", async () => {
  const { client } = await setup({ HEYPCB_API_KEY: TEST_KEY }, { acceptTokens: new Set([TEST_KEY]), mcpCallFault: { name: "echo" } });
  const res = await client.callTool({ name: "echo", arguments: { text: "read" } });
  const r = res.structuredContent as { code: string; retryable: boolean };
  assert.equal(r.code, "remote_unreachable");
  assert.equal(r.retryable, true);
});

test("a write timeout requires readback even though the transport cancels its wait", async () => {
  const { client, fake } = await setup({ HEYPCB_API_KEY: TEST_KEY, HEYPCB_MCP_TIMEOUT_MS: "1000" }, { acceptTokens: new Set([TEST_KEY]) });
  const res = await client.callTool({ name: "slow", arguments: { project: "prj_1", steps: 0 } });
  const r = res.structuredContent as { code: string; cause: string; retryable: boolean };
  assert.equal(r.code, "write_outcome_unknown");
  assert.equal(r.cause, "remote_timeout");
  assert.equal(r.retryable, false);
  assert.equal(fake.rpc.filter((m) => m.method === "tools/call" && m.params?.name === "slow").length, 1);
});

test("a lost project-creating call says to find the project before creating another", async () => {
  const { client } = await setup({ HEYPCB_API_KEY: TEST_KEY }, { acceptTokens: new Set([TEST_KEY]), mcpCallFault: { name: "slow" } });
  const res = await client.callTool({ name: "slow", arguments: {} });
  const r = res.structuredContent as { code: string; fix: string; inspectWith: unknown };
  assert.equal(r.code, "write_outcome_unknown");
  assert.match(r.fix, /find any project it created/);
  assert.deepEqual(r.inspectWith, { tool: "list_projects", args: {} });
});

test("passes the remote server's JSON-RPC error through as the same error", async () => {
  const { client } = await setup({ HEYPCB_API_KEY: TEST_KEY }, { acceptTokens: new Set([TEST_KEY]) });
  await assert.rejects(client.callTool({ name: "bad_params", arguments: {} }), (err: unknown) => {
    assert.ok(err instanceof McpError);
    assert.equal(err.code, ErrorCode.InvalidParams);
    assert.match(err.message, /brief is required/);
    return true;
  });
});

test("relays the remote server's progress under the caller's own progress token", async () => {
  const { client, fake } = await setup({ HEYPCB_API_KEY: TEST_KEY }, { acceptTokens: new Set([TEST_KEY]) });
  const seen: Array<{ progress: number; total?: number; message?: string }> = [];
  const res = await client.callTool({ name: "slow", arguments: { steps: 3, finishAfterMs: 20 } }, undefined, { onprogress: (p) => seen.push(p) });
  assert.deepEqual(res.content, [{ type: "text", text: "done" }]);
  assert.deepEqual(
    seen.map((p) => [p.progress, p.total, p.message]),
    [
      [1, 3, "step 1"],
      [2, 3, "step 2"],
      [3, 3, "step 3"],
    ]
  );
  const call = fake.rpc.find((m) => m.method === "tools/call" && (m.params as { name?: string })?.name === "slow");
  assert.ok((call?.params as { _meta?: { progressToken?: unknown } })?._meta?.progressToken !== undefined, "the remote call asked for progress");
});

test("passes the caller's other _meta on to the remote call", async () => {
  const { client } = await setup({ HEYPCB_API_KEY: TEST_KEY }, { acceptTokens: new Set([TEST_KEY]) });
  const res = await client.callTool({ name: "echo", arguments: { text: "x" }, _meta: { "example.com/trace": "abc" } });
  const meta = (res.structuredContent as { meta: Record<string, unknown> }).meta;
  assert.equal(meta["example.com/trace"], "abc");
  // The proxy always asks for progress (it keeps a long call's timeout alive) under its own token.
  assert.equal(typeof meta.progressToken, "number");
});

test("forwards a cancellation to the remote server", async () => {
  const { client, fake } = await setup({ HEYPCB_API_KEY: TEST_KEY }, { acceptTokens: new Set([TEST_KEY]) });
  const ctl = new AbortController();
  const call = client.callTool({ name: "slow", arguments: { steps: 1 } }, undefined, {
    signal: ctl.signal,
    onprogress: () => ctl.abort("the agent changed its mind"),
  });
  await assert.rejects(call);
  await until(() => fake.cancelled.length === 1);
  const remoteCall = fake.rpc.find((m) => m.method === "tools/call" && (m.params as { name?: string })?.name === "slow");
  assert.equal(fake.cancelled[0], remoteCall?.id, "the cancelled id is the remote call's own id");
});

test("without credentials: the offline names plus the local tools, and every tool says the two ways to sign in", async () => {
  const { client, fake } = await setup({}, {});
  const { tools } = await client.listTools();
  assert.deepEqual(
    tools.map((t) => t.name),
    [...OFFLINE_CATALOG.map((t) => t.name), ...LOCAL_TOOLS.map((t) => t.name)]
  );
  for (const name of ["build_board", "whoami", "upload_kicad_project", "save_export"]) {
    const res = await client.callTool({ name, arguments: name === "save_export" ? { project: "p1", kind: "bom", dir: "~/x" } : name === "upload_kicad_project" ? { path: "~/x" } : {} });
    assert.equal(res.isError, true, name);
    const r = res.structuredContent as { ok: boolean; code: string; error: string; fix: string };
    assert.equal(r.ok, false);
    assert.equal(r.code, "sign_in_required", name);
    assert.match(r.error, /not signed in/);
    assert.match(r.fix, /npx @heypcb\/mcp login/);
    assert.match(r.fix, /HEYPCB_API_KEY/);
    assert.match(r.fix, /Settings → Devices & API keys/);
    assert.match(r.fix, /\/settings\?tab=devices/);
  }
  assert.equal(fake.requests.filter((r) => r.path === "/mcp").length, 0, "nothing was sent without a credential");
});

test("signing in while the server runs needs no restart, and the tool list is updated", async () => {
  const fake = await startFakeHeypcb({ acceptTokens: new Set(["hpcb_at_STOREDabcdefghij"]) });
  cleanups.push(fake.close);
  const { client, store, config, listChangedCount } = await setup({}, {}, fake);
  assert.ok((await client.listTools()).tools.some((t) => t.name === "build_board"));
  await store.put(config.apiBase, {
    clientId: "heypcb-mcp",
    refreshToken: "hpcb_rt_STOREDabcdefghij",
    accessToken: "hpcb_at_STOREDabcdefghij",
    accessTokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
    scope: "account:read",
    signedInAt: new Date().toISOString(),
  });
  const res = await client.callTool({ name: "echo", arguments: { text: "after login" } });
  assert.deepEqual((res.structuredContent as { echoed: unknown }).echoed, { text: "after login" });
  await until(() => listChangedCount() >= 1);
  const { tools } = await client.listTools();
  assert.ok(tools.some((t) => t.name === "echo") && !tools.some((t) => t.name === "build_board"));
});

test("a remote server that is not there is a retryable refusal, and the local tools still work", async () => {
  const { client } = await setup({ HEYPCB_API_KEY: TEST_KEY }, { acceptTokens: new Set([TEST_KEY]), mcpStatus: 404 });
  const res = await client.callTool({ name: "whoami", arguments: {} });
  assert.equal(res.isError, true);
  const r = res.structuredContent as { code: string; retryable: boolean; fix: string };
  // The API host's own 404 body is a refusal, and it is passed on as one.
  assert.equal(r.code, "not_found");
  const dir = tmpDir();
  const saved = await client.callTool({ name: "save_export", arguments: { project: "prj_1", kind: "gerbers", dir } });
  assert.equal(saved.isError, undefined, JSON.stringify(saved.structuredContent));
});

test("an expired access token is renewed once and the call goes through", async () => {
  const fake = await startFakeHeypcb({
    acceptTokens: new Set<string>(),
    tokenAnswers: [{ status: 200, body: { access_token: "hpcb_at_NEWabcdefghijk", refresh_token: "hpcb_rt_NEXTabcdefghij", expires_in: 3600, token_type: "Bearer", scope: "account:read" } }],
  });
  cleanups.push(fake.close);
  const dir = tmpDir();
  const store = new CredentialStore(path.join(dir, "credentials.json"));
  const config = configFor(fake.mcpUrl);
  await store.put(config.apiBase, {
    clientId: "heypcb-mcp",
    refreshToken: "hpcb_rt_OLDabcdefghijk",
    accessToken: "hpcb_at_OLDabcdefghijk",
    accessTokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
    scope: "account:read",
    signedInAt: new Date().toISOString(),
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const running = await startServer(serverSide, { config, store, startupWaitMs: 5000, log: () => {} });
  const c2 = new Client({ name: "t", version: "1" }, { capabilities: {} });
  await c2.connect(clientSide);
  cleanups.push(async () => {
    await c2.close();
    await running.close();
  });
  const res = await c2.callTool({ name: "echo", arguments: { text: "renewed" } });
  assert.deepEqual((res.structuredContent as { echoed: unknown }).echoed, { text: "renewed" });
  assert.equal(fake.requests.filter((r) => r.path === "/oauth/token").length, 1, "one refresh");
  const form = new URLSearchParams(fake.requests.find((r) => r.path === "/oauth/token")!.body.toString());
  assert.equal(form.get("grant_type"), "refresh_token");
  assert.equal(form.get("refresh_token"), "hpcb_rt_OLDabcdefghijk");
  assert.equal(form.get("client_id"), "heypcb-mcp");
  const acc = await store.account(config.apiBase);
  assert.equal(acc?.refreshToken, "hpcb_rt_NEXTabcdefghij");
  assert.equal(acc?.accessToken, "hpcb_at_NEWabcdefghijk");
});

test("a refresh the server refuses ends the sign-in here too, and says how to sign in again", async () => {
  const fake = await startFakeHeypcb({ acceptTokens: new Set<string>(), tokenAnswers: [{ status: 400, body: { error: "invalid_grant", error_description: "revoked" } }] });
  cleanups.push(fake.close);
  const dir = tmpDir();
  const store = new CredentialStore(path.join(dir, "credentials.json"));
  const config = configFor(fake.mcpUrl);
  await store.put(config.apiBase, {
    clientId: "heypcb-mcp",
    refreshToken: "hpcb_rt_GONEabcdefghij",
    accessToken: "hpcb_at_GONEabcdefghij",
    accessTokenExpiresAt: new Date(Date.now() - 1000).toISOString(),
    scope: "account:read",
    signedInAt: new Date().toISOString(),
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const running = await startServer(serverSide, { config, store, startupWaitMs: 5000, log: () => {} });
  const client = new Client({ name: "t", version: "1" }, { capabilities: {} });
  await client.connect(clientSide);
  cleanups.push(async () => {
    await client.close();
    await running.close();
  });
  const res = await client.callTool({ name: "echo", arguments: { text: "x" } });
  const r = res.structuredContent as { code: string; fix: string };
  assert.equal(res.isError, true);
  assert.equal(r.code, "signed_out");
  assert.match(r.fix, /npx @heypcb\/mcp login/);
  assert.equal(await store.account(config.apiBase), null, "the dead sign-in is forgotten");
});

test("a personal key the server refuses names the key and both ways out", async () => {
  const { client } = await setup({ HEYPCB_API_KEY: TEST_KEY }, { acceptTokens: new Set(["something-else"]) });
  const res = await client.callTool({ name: "echo", arguments: { text: "x" } });
  const r = res.structuredContent as { code: string; error: string; fix: string };
  assert.equal(r.code, "api_key_refused");
  assert.match(r.error, /HEYPCB_API_KEY/);
  assert.match(r.fix, /Devices & API keys/);
  assert.match(r.fix, /npx @heypcb\/mcp login/);
});

test("a bad HEYPCB_MCP_URL is refused by name on every tool", async () => {
  const { loadConfig } = await import("../src/config.ts");
  const bad = loadConfig({ HEYPCB_MCP_URL: "http://example.com/mcp" });
  assert.equal(bad.ok, false);
  const mixed = loadConfig({ HEYPCB_MCP_URL: "https://a.example/mcp", HEYPCB_API_BASE: "https://b.example" });
  assert.equal(mixed.ok, false);
  assert.match(mixed.ok ? "" : mixed.refusal.error, /different hosts/);
  const dir = tmpDir();
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const running = await startServer(serverSide, { config: null, configRefusal: bad.ok ? undefined : bad.refusal, store: new CredentialStore(path.join(dir, "c.json")), log: () => {} });
  const client = new Client({ name: "t", version: "1" }, { capabilities: {} });
  await client.connect(clientSide);
  cleanups.push(async () => {
    await client.close();
    await running.close();
  });
  const res = await client.callTool({ name: "whoami", arguments: {} });
  assert.equal((res.structuredContent as { code: string }).code, "bad_config");
});
