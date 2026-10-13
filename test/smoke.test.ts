/**
 * The BUILT package, as an agent runs it: `node dist/cli.js` on stdio,
 * pointed at the fake remote. Run after `pnpm run build`
 * (`pnpm run test:smoke`); CI runs it on the oldest and newest Node.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startFakeHeypcb } from "./fake-heypcb.ts";
import { TEST_KEY, tmpDir } from "./helpers.ts";

const cli = path.join(process.cwd(), "dist", "cli.js");
const closers: Array<() => Promise<void>> = [];
after(async () => {
  for (const c of closers) await c();
});

async function run(env: Record<string, string>) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [cli], env: { PATH: process.env.PATH ?? "", HEYPCB_CONFIG_DIR: tmpDir(), ...env }, stderr: "pipe" });
  const client = new Client({ name: "smoke", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
  closers.push(() => client.close());
  return client;
}

test("dist/cli.js serves the remote tools and the local ones over stdio", { skip: !existsSync(cli) && "dist/cli.js is not built" }, async () => {
  const fake = await startFakeHeypcb({ acceptTokens: new Set([TEST_KEY]) });
  closers.push(fake.close);
  const client = await run({ HEYPCB_MCP_URL: fake.mcpUrl, HEYPCB_API_KEY: TEST_KEY });
  assert.equal(client.getServerVersion()?.name, "heypcb");
  const names = (await client.listTools()).tools.map((t) => t.name);
  assert.deepEqual(names, ["echo", "slow", "refuse", "bad_params", "upload_kicad_project", "save_export"]);
  const res = await client.callTool({ name: "echo", arguments: { text: "from the bundle" } });
  assert.deepEqual((res.structuredContent as { echoed: unknown }).echoed, { text: "from the bundle" });
});

test("dist/cli.js run by hand with nothing on stdin says what it is, and exits 0", { skip: !existsSync(cli) && "dist/cli.js is not built" }, async () => {
  const { spawnSync } = await import("node:child_process");
  const r = spawnSync(process.execPath, [cli], { input: "", env: { PATH: process.env.PATH ?? "", HEYPCB_CONFIG_DIR: tmpDir() }, encoding: "utf8", timeout: 15000 });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "", "stdout carries the protocol only");
  assert.match(r.stderr, /is an MCP server/);
  assert.match(r.stderr, /claude mcp add heypcb -- npx -y @heypcb\/mcp/);
});

test("dist/cli.js says nothing extra when an agent did connect", { skip: !existsSync(cli) && "dist/cli.js is not built" }, async () => {
  const { spawnSync } = await import("node:child_process");
  const init = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } }) + "\n";
  const r = spawnSync(process.execPath, [cli], { input: init, env: { PATH: process.env.PATH ?? "", HEYPCB_CONFIG_DIR: tmpDir(), HEYPCB_API_KEY: TEST_KEY, HEYPCB_MCP_URL: "http://127.0.0.1:9/mcp" }, encoding: "utf8", timeout: 15000 });
  assert.equal(r.status, 0);
  assert.doesNotMatch(r.stderr, /is an MCP server/);
});

test("dist/cli.js with no sign-in still starts, and every tool says how to sign in", { skip: !existsSync(cli) && "dist/cli.js is not built" }, async () => {
  const fake = await startFakeHeypcb({});
  closers.push(fake.close);
  const client = await run({ HEYPCB_MCP_URL: fake.mcpUrl });
  const names = (await client.listTools()).tools.map((t) => t.name);
  assert.ok(names.includes("build_board") && names.includes("upload_kicad_project"));
  const res = await client.callTool({ name: "build_board", arguments: { brief: "an LED blinker" } });
  assert.equal(res.isError, true);
  assert.equal((res.structuredContent as { code: string }).code, "sign_in_required");
});
