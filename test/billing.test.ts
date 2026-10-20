/**
 * The client side of per-call billing, through the local server against the
 * fake host's ledger: the spend cap refuses before anything is sent, the
 * cap and a per-call cap go out as maxCost, a retry with the same
 * idempotency key is charged once, paid calls in a bound folder are logged,
 * and whoami shows the session total.
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

test("an agent's own idempotency key and other _meta are kept; a per-call cap goes out as maxCost", () => {
  const s = new Spend(null);
  const r = s.prepare("edit_board", { trace: "t", heypcb: { idempotencyKey: "k1", maxCost: 2 } });
  assert.ok("meta" in r);
  assert.deepEqual(r.meta, { trace: "t", heypcb: { idempotencyKey: "k1", maxCost: 2 } });
  const fresh = s.prepare("edit_board", undefined);
  assert.ok("meta" in fresh && typeof (fresh.meta.heypcb as { idempotencyKey: string }).idempotencyKey === "string");
  assert.equal((fresh as { meta: { heypcb: { maxCost?: number } } }).meta.heypcb.maxCost, undefined, "no cap, no maxCost");
});

test("the cap goes out as maxCost, shrinking as it is spent; once spent, calls are refused before they are sent", async () => {
  const { call, sentMeta, fake } = await setup({ prices: { whoami: 0, edit_board: 1 } }, 2.5);
  const s = setupProject(fake);
  assert.equal((await call("edit_board", { project: s })).isError, undefined);
  assert.equal(sentMeta().at(-1)!.maxCost, 2.5);
  assert.equal((await call("edit_board", { project: s })).isError, undefined);
  assert.equal(sentMeta().at(-1)!.maxCost, 1.5);
  const third = await call("edit_board", { project: s });
  assert.equal((third.structuredContent as { code: string }).code, "over_max_cost", "HeyPCB refuses a call that would cross what is left");
  // Spend exactly to the cap, then the next call never leaves this computer.
  const capped = await setup({ prices: { edit_board: 1 } }, 1);
  const p2 = setupProject(capped.fake);
  await capped.call("edit_board", { project: p2 });
  const sent = capped.fake.rpc.filter((m) => m.method === "tools/call").length;
  const refused = await capped.call("edit_board", { project: p2 });
  assert.equal((refused.structuredContent as { code: string }).code, "spend_cap_reached");
  assert.equal(capped.fake.rpc.filter((m) => m.method === "tools/call").length, sent, "nothing was sent");
  assert.equal(capped.fake.ledger.size, 1);
  const who = await capped.call("whoami");
  assert.equal(who.isError, undefined, "a free tool still works once the cap is spent");
  assert.equal(capped.sentMeta().at(-1)!.maxCost, 0);
});

/** A HeyPCB project (not bound to a folder) the fake's design tools can work on. */
function setupProject(fake: Fake): string {
  const id = `prj_${900 + fake.projects.size}`;
  fake.projects.set(id, { revision: 1, files: new Map([["b.kicad_pcb", Buffer.from("(kicad_pcb\n)\n")]]), stem: "b" });
  return id;
}

test("a retry with the same idempotency key is charged once — 100 logical calls, each sent twice, make 100 charges", async () => {
  const { call, fake, running } = await setup({ prices: { edit_board: 0.01 } });
  const id = setupProject(fake);
  for (let i = 0; i < 100; i++) {
    const key = `logical-${i}`;
    await call("edit_board", { project: id }, { heypcb: { idempotencyKey: key } });
    await call("edit_board", { project: id }, { heypcb: { idempotencyKey: key } }); // the agent's retry after a timeout
  }
  assert.equal(fake.ledger.size, 100);
  assert.equal(running.spend.summary().paidCalls, 100);
  assert.equal(running.spend.summary().charged, 1);
});

test("paid calls in a bound folder go to .heypcb/usage.log, and whoami shows the session total", async () => {
  const { call, home } = await setup({ prices: { edit_board: 0.25 } }, 10);
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
  assert.match(text, /0\.5 USD charged over 2 paid calls; cap 10 USD, 9\.5 USD left/);
  assert.deepEqual((who._meta as { heypcb: { session: unknown } }).heypcb.session, { charged: 0.5, paidCalls: 2, unit: "USD", cap: 10, left: 9.5 });
});
