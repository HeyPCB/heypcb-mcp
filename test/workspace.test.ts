/**
 * A bound workspace end to end, through the local server against the fake
 * host: binding, the sync round trip, the conflict refusal and both ways
 * out of it, the save-during-a-call guard, backups and restore, automatic
 * part installs, and a server without the file API.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { CredentialStore } from "../src/credentials.ts";
import { startServer } from "../src/server.ts";
import { Auth } from "../src/auth.ts";
import { FileApi, Workspace, pull, ignoreInGit, WORKSPACE_DIR } from "../src/workspace.ts";
import { startFakeHeypcb, type FakeOptions } from "./fake-heypcb.ts";
import { configFor, copyFixture, TEST_KEY, tmpDir } from "./helpers.ts";

const cleanups: Array<() => Promise<void>> = [];
after(async () => {
  for (const c of cleanups.reverse()) await c().catch(() => {});
});

async function setup(fakeOpts: FakeOptions = {}, serveOpts: { maxSpend?: number } = {}) {
  const fake = await startFakeHeypcb(fakeOpts);
  cleanups.push(fake.close);
  const home = tmpDir();
  const store = new CredentialStore(path.join(home, ".config", "heypcb", "credentials.json"));
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const running = await startServer(serverSide, { config: configFor(fake.mcpUrl, { HEYPCB_API_KEY: TEST_KEY }), store, startupWaitMs: 5000, log: () => {}, home, maxSpend: serveOpts.maxSpend });
  const client = new Client({ name: "test-agent", version: "1.0.0" }, { capabilities: {} });
  await client.connect(clientSide);
  cleanups.push(async () => {
    await client.close();
    await running.close();
  });
  const call = async (name: string, args: Record<string, unknown> = {}, meta?: Record<string, unknown>) =>
    (await client.callTool({ name, arguments: args, ...(meta ? { _meta: meta } : {}) })) as CallToolResult;
  const config = configFor(fake.mcpUrl, { HEYPCB_API_KEY: TEST_KEY });
  return { fake, home, client, call, running, api: new FileApi({ config, auth: new Auth(config, store) }) };
}

const sc = (r: CallToolResult) => r.structuredContent as Record<string, any>;
const read = (root: string, rel: string) => fsp.readFile(path.join(root, ...rel.split("/")), "utf8");
const puts = (fake: { requests: Array<{ method: string; path: string; body: Buffer; sync?: { baseRevision: string; files: Array<{ path: string }>; delete: string[] } }> }) =>
  fake.requests.filter((r) => r.method === "PUT" && r.path.endsWith("/files")).map((r) => r.sync!);

async function bound(fakeOpts: FakeOptions = {}, serveOpts: { maxSpend?: number } = {}) {
  const s = await setup(fakeOpts, serveOpts);
  const root = await copyFixture("blinky2", s.home);
  await fsp.mkdir(path.join(s.home, "projects", ".git")); // the projects folder is a git work tree
  const opened = await s.call("open_kicad_project", { path: root });
  assert.equal(opened.isError, undefined, JSON.stringify(opened.structuredContent));
  return { ...s, root, id: sc(opened).project.id as string, opened };
}

test("open_kicad_project uploads once, writes the binding and .gitignore, and reuses it on the next call", async () => {
  const { fake, root, id, opened, call } = await bound();
  assert.equal(sc(opened).binding, "new");
  assert.ok(sc(opened).uploaded.files.includes("sub/power.kicad_sch"));
  const state = JSON.parse(await read(root, `${WORKSPACE_DIR}/workspace.json`));
  assert.equal(state.projectId, id);
  assert.equal(state.stem, "blinky");
  assert.equal(state.revision, fake.revisionOf(id));
  assert.ok(state.files["blinky.kicad_pcb"].local);
  assert.match(await read(root, ".gitignore"), /^\.heypcb\/$/m);

  const again = await call("open_kicad_project", { path: path.join(root, "blinky.kicad_pro") });
  assert.equal(sc(again).binding, "existing");
  assert.equal(sc(again).project.id, id);
  assert.equal(fake.requests.filter((r) => r.path === "/v1/projects/import").length, 1, "no second project");
  assert.deepEqual(puts(fake), [], "nothing changed, nothing sent");
});

test("sync round trip: an edit here goes up before the call, HeyPCB's change comes back after it, with a backup", async () => {
  const { fake, root, id, call } = await bound();
  const before = await read(root, "blinky.kicad_pcb");
  const edited = before.replace(/\)\s*$/, "  (gr_text \"local edit\" (at 105 95) (layer \"F.SilkS\"))\n)\n");
  await fsp.writeFile(path.join(root, "blinky.kicad_pcb"), edited);

  const res = await call("edit_board", { project: id, text: "(server edit)" });
  assert.equal(res.isError, undefined, JSON.stringify(res.structuredContent));
  const sent = puts(fake);
  assert.equal(sent.length, 1);
  assert.ok(sent[0].files.some((f) => f.path === "blinky.kicad_pcb"));
  assert.ok(sent[0].files.some((f) => f.path === "sub/power.kicad_sch"), "replace sync carries the complete snapshot");

  const now = await read(root, "blinky.kicad_pcb");
  assert.match(now, /local edit/, "the local edit is part of what came back");
  assert.match(now, /\(server edit\)/);
  const local = (res._meta as any).heypcb.local;
  assert.deepEqual(local.local_files_changed, ["blinky.kicad_pcb"]);
  assert.ok(local.backup, "a backup was made");
  const backups = await fsp.readdir(path.join(root, WORKSPACE_DIR, "backup"));
  assert.equal(await read(root, `${WORKSPACE_DIR}/backup/${backups[0]}/blinky.kicad_pcb`), edited, "the backup is the file as it was");
  const text = (res.content as Array<{ text: string }>).map((c) => c.text).join("\n");
  assert.match(text, /HeyPCB updated blinky\.kicad_pcb/);

  // A read-only call does not pull, and with nothing changed sends nothing.
  const r2 = await call("read_board", { project: id });
  assert.equal(r2.isError, undefined);
  assert.equal(puts(fake).length, 1);
});

test("without a revision in the result, the file list says what changed", async () => {
  const { root, id, call } = await bound({ omitRevision: true });
  const res = await call("edit_board", { project: id, text: "(no rev)" });
  assert.equal(res.isError, undefined);
  assert.match(await read(root, "blinky.kicad_pcb"), /\(no rev\)/);
});

test("an edit on HeyPCB and one here: workspace_conflict, nothing overwritten; take_heypcb resolves it with a backup", async () => {
  const { fake, root, id, call } = await bound();
  fake.editFile(id, "blinky.kicad_pcb", "(kicad_pcb (version 20240108) (web edit))\n");
  await fsp.writeFile(path.join(root, "blinky.kicad_pcb"), "(kicad_pcb (version 20240108) (local edit))\n");

  const res = await call("edit_board", { project: id });
  assert.equal(res.isError, true);
  assert.equal(sc(res).code, "workspace_conflict");
  assert.match(sc(res).fix, /on_conflict/);
  assert.match(await read(root, "blinky.kicad_pcb"), /local edit/);
  assert.match(fake.projects.get(id)!.files.get("blinky.kicad_pcb")!.toString(), /web edit/);

  const took = await call("open_kicad_project", { path: root, on_conflict: "take_heypcb" });
  assert.equal(took.isError, undefined, JSON.stringify(took.structuredContent));
  assert.match(await read(root, "blinky.kicad_pcb"), /web edit/);
  const backup = sc(took).backup as string;
  assert.match(await fsp.readFile(path.join(backup, "blinky.kicad_pcb"), "utf8"), /local edit/);
  // Synced again: the next call goes through.
  assert.equal((await call("edit_board", { project: id })).isError, undefined);
});

test("keep_local sends the files here over HeyPCB's, and still brings down HeyPCB's other changes", async () => {
  const { fake, root, id, call } = await bound();
  fake.editFile(id, "blinky.kicad_pcb", "(kicad_pcb (web))\n");
  fake.editFile(id, "blinky.kicad_dru", "(version 1)\n(rule web)\n");
  await fsp.writeFile(path.join(root, "blinky.kicad_pcb"), "(kicad_pcb (mine))\n");
  assert.equal(sc(await call("edit_board", { project: id })).code, "workspace_conflict");

  const kept = await call("open_kicad_project", { path: root, on_conflict: "keep_local" });
  assert.equal(kept.isError, undefined, JSON.stringify(kept.structuredContent));
  assert.equal(fake.projects.get(id)!.files.get("blinky.kicad_pcb")!.toString(), "(kicad_pcb (mine))\n");
  assert.match(await read(root, "blinky.kicad_dru"), /rule web/, "a file only HeyPCB changed still comes down");
});

test("a save in KiCad while the call runs is never overwritten: .heypcb-new beside it, and syncing waits for a choice", async () => {
  let root = "";
  const { fake, id, call, ...s } = await bound({
    duringCall: async (tool) => {
      if (tool === "edit_board") await fsp.writeFile(path.join(root, "blinky.kicad_pcb"), "(kicad_pcb (saved in kicad))\n");
    },
  });
  root = s.root;
  const res = await call("edit_board", { project: id, text: "(server)" });
  assert.equal(res.isError, true);
  assert.equal(sc(res).code, "kicad_saved_during_call");
  assert.equal(await read(root, "blinky.kicad_pcb"), "(kicad_pcb (saved in kicad))\n", "the user's save is untouched");
  assert.match(await read(root, "blinky.kicad_pcb.heypcb-new"), /\(server\)/);
  assert.ok(sc(res).result, "the call's own result is still there");

  const next = await call("read_board", { project: id });
  assert.equal(sc(next).code, "workspace_conflict", "no sync until it is resolved");

  const kept = await call("open_kicad_project", { path: root, on_conflict: "keep_local" });
  assert.equal(kept.isError, undefined, JSON.stringify(kept.structuredContent));
  await assert.rejects(fsp.stat(path.join(root, "blinky.kicad_pcb.heypcb-new")));
  assert.equal(fake.projects.get(id)!.files.get("blinky.kicad_pcb")!.toString(), "(kicad_pcb (saved in kicad))\n");
});

test("a file open in KiCad (its lock file is there) is updated and named for a reload", async () => {
  const { root, id, call } = await bound();
  await fsp.writeFile(path.join(root, "~blinky.kicad_pcb.lck"), "{}");
  const res = await call("edit_board", { project: id });
  assert.deepEqual((res._meta as any).heypcb.local.open_in_kicad, ["blinky.kicad_pcb"]);
  assert.match((res.content as Array<{ text: string }>).at(-1)!.text, /open in KiCad: tell the user to reload/);
});

test("restore_local lists the backups and puts one back, backing up what it replaces", async () => {
  const { root, id, call } = await bound();
  const original = await read(root, "blinky.kicad_pcb");
  await call("edit_board", { project: id, text: "(change 1)" });
  const list = await call("restore_local", { path: root });
  const backups = sc(list).backups as Array<{ revision: string }>;
  assert.equal(backups.length, 1);

  const res = await call("restore_local", { path: root, revision: backups[0].revision });
  assert.equal(res.isError, undefined, JSON.stringify(res.structuredContent));
  assert.equal(await read(root, "blinky.kicad_pcb"), original);
  assert.match(sc(res).savedCurrentAs, /^before-restore-/);
  assert.match(await read(root, `${WORKSPACE_DIR}/backup/${sc(res).savedCurrentAs}/blinky.kicad_pcb`), /\(change 1\)/);

  const missing = await call("restore_local", { path: root, revision: "nope" });
  assert.equal(sc(missing).code, "no_backup");
});

test("unavailable part installation is not advertised or allowed to mutate libraries", async () => {
  const { root, id, call, client } = await bound();
  assert.ok(!(await client.listTools()).tools.some((t) => t.name === "install_parts"));
  const original = await read(root, "sym-lib-table");
  const refused = await call("install_parts", { path: root, parts: ["C2040"] });
  assert.equal(sc(refused).code, "parts_assets_unsupported");
  assert.equal(sc(refused).written, false);
  const res = await call("add_parts", { project: id, parts: ["C2040"] });
  assert.equal(res.isError, undefined);
  assert.equal((res._meta as any).heypcb.local.install_failed[0].code, "parts_assets_unsupported");
  assert.equal(await read(root, "sym-lib-table"), original);
  await assert.rejects(fsp.stat(path.join(root, "heypcb.kicad_sym")));
});

test("a binding made in an earlier session still syncs: the index finds the folder by project id", async () => {
  const s = await setup();
  const root = await copyFixture("blinky2", s.home);
  const id = sc(await s.call("open_kicad_project", { path: root })).project.id;
  // A second server process with the same sign-in folder, which never called open_kicad_project.
  const [c, srv] = InMemoryTransport.createLinkedPair();
  const store = new CredentialStore(path.join(s.home, ".config", "heypcb", "credentials.json"));
  const running = await startServer(srv, { config: configFor(s.fake.mcpUrl, { HEYPCB_API_KEY: TEST_KEY }), store, startupWaitMs: 5000, log: () => {}, home: s.home });
  const client = new Client({ name: "t2", version: "1" }, { capabilities: {} });
  await client.connect(c);
  cleanups.push(async () => {
    await client.close();
    await running.close();
  });
  await client.callTool({ name: "edit_board", arguments: { project: id, text: "(from session 2)" } });
  assert.match(await read(root, "blinky.kicad_pcb"), /from session 2/);
});

test("a server without the file API: workspace_unsupported, naming the project it made", async () => {
  const s = await setup({ filesApi: false });
  const root = await copyFixture("blinky2", s.home);
  const res = await s.call("open_kicad_project", { path: root });
  assert.equal(sc(res).code, "workspace_unsupported");
  assert.ok(sc(res).project);
  await assert.rejects(fsp.stat(path.join(root, WORKSPACE_DIR, "workspace.json")), "no binding written");
});

test(".heypcbignore keeps files local", async () => {
  const s = await setup();
  const root = await copyFixture("blinky2", s.home);
  await fsp.writeFile(path.join(root, ".heypcbignore"), "# private\nsub/\n");
  const res = await s.call("open_kicad_project", { path: root });
  assert.ok(!sc(res).uploaded.files.includes("sub/power.kicad_sch"));
  assert.ok(sc(res).skipped.some((x: { path: string; reason: string }) => x.path === "sub/power.kicad_sch" && x.reason === "heypcbignore"));
});


test("sync uses the real manifest, file-path and multipart snapshot contract", async () => {
  const { fake, root, id, call } = await bound();
  await fsp.writeFile(path.join(root, "blinky.kicad_pcb"), "(kicad_pcb (local))\n");
  assert.equal((await call("edit_board", { project: id })).isError, undefined);
  assert.ok(fake.requests.some((r) => r.path.endsWith("/files/manifest")));
  const put = fake.requests.find((r) => r.method === "PUT")!;
  assert.match(String(put.headers["content-type"]), /^multipart\/form-data/);
  assert.ok(put.sync!.files.length > 1, "replace carries unchanged sheets and libraries too");
  assert.ok(!fake.requests.some((r) => r.path.endsWith("/files/content")));
  const legacy = await fetch(`${fake.url}/v1/projects/${id}/files`, { method: "PUT", headers: { authorization: `Bearer ${TEST_KEY}`, "content-type": "application/json" }, body: "{}" });
  assert.equal(legacy.status, 400);
  assert.equal((await legacy.json() as {code:string}).code, "sync_body_unreadable");
});

test("a committed sync whose reply drops is read back, never automatically resent", async () => {
  const { fake, root, id, call } = await bound({ dropPutReply: true });
  await fsp.writeFile(path.join(root, "blinky.kicad_pcb"), "(kicad_pcb (local))\n");
  assert.equal((await call("read_board", { project: id })).isError, undefined);
  assert.equal(puts(fake).length, 1);
  assert.equal(fake.projects.get(id)!.files.get("blinky.kicad_pcb")!.toString(), "(kicad_pcb (local))\n");
});

test("an unreadable outcome refuses further work and preserves the logical sync key", async () => {
  const { fake, root, id, call } = await bound({ dropPutReply: true, manifestAfterPutFault: true });
  await fsp.writeFile(path.join(root, "blinky.kicad_pcb"), "(kicad_pcb (local))\n");
  const lost = await call("edit_board", { project: id });
  assert.equal(sc(lost).code, "write_outcome_unknown");
  assert.equal(sc(lost).written, null);
  assert.equal(sc(lost).retryable, false);
  assert.equal(puts(fake).length, 1);
  assert.equal(fake.rpc.filter((r) => r.method === "tools/call").length, 0, "no design call follows an unknown sync");
  fake.opts.dropPutReply = false; fake.opts.manifestAfterPutFault = false;
  assert.equal((await call("read_board", { project: id })).isError, undefined);
  const keys = fake.requests.filter((r) => r.method === "PUT").map((r) => r.headers["idempotency-key"]);
  assert.equal(keys.length, 2); assert.equal(keys[0], keys[1]);
  assert.equal(fake.projects.get(id)!.revision, 2, "explicit recovery reuses the committed sync rather than writing again");
});

test("a KiCad save during download is kept beside the incoming server copy", async () => {
  let root = "";
  const s = await bound({ duringDownload: async (rel) => {
    if (rel === "blinky.kicad_pcb") await fsp.writeFile(path.join(root, rel), "(kicad_pcb (saved during download))\n");
  }});
  root = s.root;
  const result = await s.call("edit_board", { project: s.id, text: "(server)" });
  assert.equal(sc(result).code, "kicad_saved_during_call");
  assert.match(await read(root, "blinky.kicad_pcb"), /saved during download/);
  assert.match(await read(root, "blinky.kicad_pcb.heypcb-new"), /server/);
});

test("pull deletion refuses a parent symlink before any project file changes", async () => {
  const { root, fake, id, api, home } = await bound();
  const outside = path.join(home, "outside"); await fsp.mkdir(outside);
  await fsp.writeFile(path.join(outside, "power.kicad_sch"), "external bytes");
  await fsp.rm(path.join(root, "sub"), {recursive:true}); await fsp.symlink(outside, path.join(root, "sub"), "dir");
  fake.projects.get(id)!.files.delete("sub/power.kicad_sch"); fake.projects.get(id)!.revision++;
  const board = await read(root, "blinky.kicad_pcb");
  const ws = await Workspace.load(root);
  await assert.rejects(pull(ws!, api), (e:any) => e.refusal?.code === "symlink_escape");
  assert.equal(await fsp.readFile(path.join(outside, "power.kicad_sch"), "utf8"), "external bytes");
  assert.equal(await read(root, "blinky.kicad_pcb"), board);
});

test("malicious persisted paths and a linked gitignore are refused without outside writes", async () => {
  const { root, home } = await bound();
  const stateFile = path.join(root, WORKSPACE_DIR, "workspace.json"); const original = await fsp.readFile(stateFile, "utf8");
  for (const field of ["files", "conflicts"]) {
    const state = JSON.parse(original);
    if (field === "files") state.files["../external.kicad_sch"] = {local:"x",remote:"x"};
    else state.conflicts = ["../external.kicad_sch"];
    await fsp.writeFile(stateFile, JSON.stringify(state));
    await assert.rejects(Workspace.load(root), (e:any) => e.refusal?.code === "workspace_unreadable");
  }
  await fsp.writeFile(stateFile, original);
  const outside = path.join(home,"outside-ignore"); await fsp.writeFile(outside,"keep");
  await fsp.rm(path.join(root,".gitignore")); await fsp.symlink(outside,path.join(root,".gitignore"));
  await assert.rejects(ignoreInGit(root), (e:any) => e.refusal?.code === "symlink_escape");
  assert.equal(await fsp.readFile(outside,"utf8"),"keep");
});
