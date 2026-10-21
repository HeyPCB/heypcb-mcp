/** Caller caps fail closed against the current unsupported metadata
 * contract; optional reported charges are recorded, absent data is unknown.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { parseMaxSpend, Spend } from "../src/billing.ts";
import { CredentialStore } from "../src/credentials.ts";
import { startServer } from "../src/server.ts";
import { startFakeHeypcb, type Fake, type FakeOptions } from "./fake-heypcb.ts";
import { configFor, copyFixture, TEST_KEY, tmpDir } from "./helpers.ts";

const cleanups: Array<() => Promise<void>> = [];
after(async () => {
  for (const c of cleanups.reverse()) await c().catch(() => {});
});

async function setup(fakeOpts: FakeOptions, maxSpend?: number) {
  const fake = await startFakeHeypcb(fakeOpts);
  cleanups.push(fake.close);
  const home = tmpDir();
  const store = new CredentialStore(path.join(home, ".config", "heypcb", "credentials.json"));
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const running = await startServer(serverSide, { config: configFor(fake.mcpUrl, { HEYPCB_API_KEY: TEST_KEY }), store, startupWaitMs: 5000, log: () => {}, home, maxSpend });
  const client = new Client({ name: "test-agent", version: "1.0.0" }, { capabilities: {} });
  await client.connect(clientSide);
  cleanups.push(async () => {
    await client.close();
    await running.close();
  });
  const call = async (name: string, args: Record<string, unknown> = {}, meta?: Record<string, unknown>) => (await client.callTool({ name, arguments: args, ...(meta ? { _meta: meta } : {}) })) as CallToolResult;
  const sentMeta = () => fake.rpc.filter((m) => m.method === "tools/call").map((m) => ((m.params as { _meta?: { heypcb?: Record<string, unknown> } })._meta?.heypcb ?? {}) as Record<string, unknown>);
  return { fake, home, call, running, sentMeta };
}

test("--max-spend parses as a number, anywhere in the arguments", () => {
  assert.deepEqual(parseMaxSpend(["--max-spend", "5"]), { cap: 5, rest: [] });
  assert.deepEqual(parseMaxSpend(["serve", "--max-spend=2.5"]), { cap: 2.5, rest: ["serve"] });
  assert.deepEqual(parseMaxSpend(["login"]), { cap: null, rest: ["login"] });
  assert.ok("error" in parseMaxSpend(["--max-spend"]));
  assert.ok("error" in parseMaxSpend(["--max-spend", "-1"]));
  assert.ok("error" in parseMaxSpend(["--max-spend", "lots"]));
});

test("an agent's own key and trace are kept without claiming server-side cap support", () => {
  const s = new Spend(null);
  const r = s.prepare("edit_board", { trace: "t", heypcb: { idempotencyKey: "k1" } });
  assert.ok("meta" in r);
  assert.deepEqual(r.meta, { trace: "t", heypcb: { idempotencyKey: "k1" } });
  for (const cap of [0, 2]) {
    const capped = s.prepare("edit_board", {heypcb:{maxCost:cap}});
    assert.ok("refusal" in capped && capped.refusal.code === "spend_cap_unsupported");
  }
  for (const cap of [-1, Infinity, NaN, "2"]) {
    const invalid = s.prepare("edit_board", {heypcb:{maxCost:cap}});
    assert.ok("refusal" in invalid && invalid.refusal.code === "bad_spend_cap");
  }
});

test("session and per-call limits fail closed before charged dispatch, including a zero limit", async () => {
  for (const cap of [0, 2.5]) {
    const s = await setup({prices:{edit_board:1}},cap);
    const id = setupProject(s.fake);
    const refused = await s.call("edit_board",{project:id});
    assert.equal((refused.structuredContent as {code:string}).code,"spend_cap_unsupported");
    assert.equal(s.fake.rpc.filter((r) => r.method === "tools/call").length,0);
    assert.equal(s.fake.ledger.size,0);
    assert.equal((await s.call("whoami")).isError,undefined,"verified free reads remain available");
  }
  const s = await setup({prices:{edit_board:1}}); const id = setupProject(s.fake);
  for (const maxCost of [0,2]) {
    const refused = await s.call("edit_board",{project:id},{heypcb:{maxCost}});
    assert.equal((refused.structuredContent as {code:string}).code,"spend_cap_unsupported");
  }
  assert.equal(s.fake.rpc.filter((r) => r.method === "tools/call").length,0);
  assert.equal(s.fake.ledger.size,0);
});

/** A HeyPCB project (not bound to a folder) the fake's design tools can work on. */
function setupProject(fake: Fake): string {
  const id = `prj_${900 + fake.projects.size}`;
  fake.projects.set(id, { revision: 1, files: new Map([["b.kicad_pcb", Buffer.from("(kicad_pcb\n)\n")]]), stem: "b" });
  return id;
}

test("missing server billing metadata is unmeasured, not a measured zero", async () => {
  const { call, running } = await setup({omitBilling:true});
  const result = await call("whoami");
  assert.equal(running.spend.summary().charged,null);
  assert.equal(running.spend.summary().paidCalls,null);
  assert.match((result.content as Array<{text:string}>).at(-1)!.text,/unmeasured/);
});

test("paid calls in a bound folder go to .heypcb/usage.log, and whoami shows the session total", async () => {
  const { call, home } = await setup({ prices: { edit_board: 0.25 } });
  const root = await copyFixture("blinky2", home);
  const id = ((await call("open_kicad_project", { path: root })).structuredContent as { project: { id: string } }).project.id;
  await call("edit_board", { project: id });
  await call("read_board", { project: id }); // free: not logged
  await call("edit_board", { project: id });
  const lines = (await fsp.readFile(path.join(root, ".heypcb", "usage.log"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(
    lines.map((l) => [l.tool, l.charged, l.unit]),
    [
      ["edit_board", 0.25, "USD"],
      ["edit_board", 0.25, "USD"],
    ]
  );
  assert.ok(lines.every((l) => typeof l.idempotencyKey === "string" && l.revision));
  const who = await call("whoami");
  const text = (who.content as Array<{ text: string }>).map((c) => c.text).join("\n");
  assert.match(text, /0\.5 USD charged over 2 paid calls; no spend cap/);
  assert.deepEqual((who._meta as { heypcb: { session: unknown } }).heypcb.session, { charged: 0.5, paidCalls: 2, unit: "USD", cap: null, left: null, capEnforced: false });
});
