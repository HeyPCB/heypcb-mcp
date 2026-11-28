/**
 * upload_project with a board from another tool, as the import receives it:
 * one board file (Altium .PcbDoc, Eagle .brd, EasyEDA .json / .epro) sent
 * alone and byte for byte under its own name; an Altium project's .PrjPcb
 * and the boards and sheets it lists, zipped; what a folder resolves to; the
 * refusals, which send nothing; and the old name, upload_kicad_project.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { Auth } from "../src/auth.ts";
import { CredentialStore } from "../src/credentials.ts";
import { callLocalTool, LOCAL_TOOLS, uploadProject } from "../src/local-tools.ts";
import { startFakeHeypcb, type Fake } from "./fake-heypcb.ts";
import { configFor, copyFixture, FIXTURES, readZip, TEST_KEY, tmpDir } from "./helpers.ts";

const closers: Array<() => Promise<void>> = [];
after(async () => {
  for (const c of closers) await c();
});

type Uploaded = {
  project: { id: string; name: string };
  webUrl: string;
  format: string;
  uploaded: { root: string; files: string[]; bytes: number; zipBytes?: number };
  skipped: Array<{ path: string; reason: string }>;
  missing: Array<{ path: string; kind: string }>;
  note?: string;
};
type Refused = { ok: false; code: string; error: string; fix: string; candidates?: string[] };

async function host(opts: Parameters<typeof startFakeHeypcb>[0] = {}): Promise<{ fake: Fake; home: string; ctx: Parameters<typeof uploadProject>[0] }> {
  const fake = await startFakeHeypcb({ acceptTokens: new Set([TEST_KEY]), ...opts });
  closers.push(fake.close);
  const config = configFor(fake.mcpUrl, { HEYPCB_API_KEY: TEST_KEY });
  const home = tmpDir();
  return { fake, home, ctx: { config, auth: new Auth(config, new CredentialStore(path.join(tmpDir(), "c.json"))), home } };
}

function ok(res: Awaited<ReturnType<typeof uploadProject>>): Uploaded {
  assert.equal(res.isError, undefined, JSON.stringify(res.structuredContent));
  return res.structuredContent as Uploaded;
}

function refused(res: Awaited<ReturnType<typeof uploadProject>>): Refused {
  assert.equal(res.isError, true, JSON.stringify(res.structuredContent));
  return res.structuredContent as Refused;
}

const LISTED = ["lamp.PcbDoc", "lamp.PrjPcb", "lamp.SchDoc", "sheets/power.SchDoc"];

test("an Altium .PcbDoc goes up alone, byte for byte, under its own name: not refused as not_kicad", async () => {
  const { fake, home, ctx } = await host();
  const root = await copyFixture("altium-lamp", home);
  const board = path.join(root, "lamp.PcbDoc");
  const out = ok(await uploadProject(ctx, { path: board }));
  assert.equal(out.format, "altium");
  assert.equal(out.project.id, "prj_123");
  assert.equal(out.webUrl, `${fake.url}/p/prj_123`);
  assert.deepEqual(out.uploaded.files, ["lamp.PcbDoc"]);
  assert.equal(out.uploaded.bytes, (await fsp.stat(board)).size);
  assert.equal(out.uploaded.zipBytes, undefined, "nothing was zipped");
  assert.match(out.note ?? "", /does not read Altium schematics/);

  assert.equal(fake.imports.length, 1);
  const [sent] = fake.imports;
  assert.equal(sent.fileName, "lamp.PcbDoc", "the import reads the format off the name");
  assert.equal(sent.type, "application/octet-stream");
  assert.ok(sent.data.equals(await fsp.readFile(board)), "the board's bytes, untouched");
  assert.equal(sent.name, "lamp");
  assert.match(String(sent.idempotencyKey), /^[0-9a-f-]{36}$/);
  const req = fake.requests.find((r) => r.path === "/v1/projects/import")!;
  assert.equal(req.headers.authorization, `Bearer ${TEST_KEY}`);
});

test("an Altium project (its folder, its .PrjPcb, a folder above it, ~/…) sends the .PrjPcb and the boards and sheets it lists, zipped", async () => {
  const { fake, home, ctx } = await host();
  const root = await copyFixture("altium-lamp", home);
  for (const p of [root, path.join(root, "lamp.PrjPcb"), path.dirname(root), "~/projects/altium-lamp"]) {
    const out = ok(await uploadProject(ctx, { path: p }));
    assert.equal(out.format, "altium", p);
    assert.equal(out.uploaded.root, root, p);
    assert.deepEqual(out.uploaded.files, LISTED, `${p}: never the library, the output job, History, previews or outputs`);
    assert.deepEqual(out.missing, [{ path: "missing.SchDoc", kind: "schematic" }], "a listed sheet the folder lacks is reported");
    assert.equal(typeof out.uploaded.zipBytes, "number");
  }
  assert.equal(fake.imports.length, 4);
  for (const sent of fake.imports) {
    assert.equal(sent.fileName, "lamp.zip");
    assert.equal(sent.type, "application/zip");
    assert.equal(sent.name, "lamp");
    const entries = readZip(sent.data);
    assert.deepEqual([...entries.keys()], [...LISTED].sort());
    for (const [rel, data] of entries) assert.ok(data.equals(await fsp.readFile(path.join(root, ...rel.split("/")))), rel);
  }
});

test("an Eagle .brd and EasyEDA's .json and .epro go up alone, as they are", async () => {
  const { fake, home, ctx } = await host();
  const root = await copyFixture("boards", home);
  for (const [file, format] of [
    ["blinky.brd", "eagle"],
    ["PCB_blinky.json", "easyeda"],
    ["blinky.epro", "easyeda"],
  ]) {
    const out = ok(await uploadProject(ctx, { path: path.join(root, file), name: `Blinky ${format}` }));
    assert.equal(out.format, format, file);
    assert.deepEqual(out.uploaded.files, [file]);
    const sent = fake.imports.at(-1)!;
    assert.equal(sent.fileName, file);
    assert.equal(sent.name, `Blinky ${format}`);
    assert.ok(sent.data.equals(await fsp.readFile(path.join(root, file))), file);
  }
  assert.equal(fake.imports.length, 3);
});

test("in a folder, EasyEDA's PCB file counts by its export name, and Altium's own folders are not searched", async () => {
  const { fake, home, ctx } = await host();
  const easy = path.join(home, "easy");
  await fsp.mkdir(easy, { recursive: true });
  await fsp.copyFile(path.join(FIXTURES, "boards", "PCB_blinky.json"), path.join(easy, "PCB_blinky.json"));
  await fsp.writeFile(path.join(easy, "settings.json"), '{"theme": "dark"}');
  const out = ok(await uploadProject(ctx, { path: easy }));
  assert.equal(out.format, "easyeda");
  assert.deepEqual(out.uploaded.files, ["PCB_blinky.json"], "settings.json is no board");

  const altium = path.join(home, "altium");
  const board = await fsp.readFile(path.join(FIXTURES, "altium-lamp", "lamp.PcbDoc"));
  for (const rel of ["History/old.PcbDoc", "Project Outputs for lamp/lamp.PcbDoc", "__Previews/lamp.PcbDoc", "pcb/lamp.PcbDoc"]) {
    await fsp.mkdir(path.dirname(path.join(altium, rel)), { recursive: true });
    await fsp.writeFile(path.join(altium, rel), board);
  }
  const found = ok(await uploadProject(ctx, { path: altium }));
  assert.equal(found.uploaded.root, path.join(altium, "pcb"));
  assert.deepEqual(found.uploaded.files, ["lamp.PcbDoc"]);
  assert.equal(fake.imports.at(-1)!.fileName, "lamp.PcbDoc");
});

test("a folder that holds a KiCad project is still a KiCad upload, whatever else it holds", async () => {
  const { fake, home, ctx } = await host();
  const root = await copyFixture("blinky2", home);
  await fsp.copyFile(path.join(FIXTURES, "altium-lamp", "lamp.PcbDoc"), path.join(root, "lamp.PcbDoc"));
  const out = ok(await uploadProject(ctx, { path: root }));
  assert.equal(out.format, "kicad");
  assert.ok(out.uploaded.files.includes("blinky.kicad_pcb"));
  assert.ok(!out.uploaded.files.includes("lamp.PcbDoc"));
  assert.equal(fake.imports[0].fileName, "blinky.zip");
});

test("upload_kicad_project, the old name, is listed and runs the same tool for every format", async () => {
  const tool = (name: string) => LOCAL_TOOLS.find((t) => t.name === name);
  assert.ok(tool("upload_project") && tool("upload_kicad_project"), "both names are listed, so allow-lists that name either keep working");
  assert.deepEqual(tool("upload_kicad_project")!.inputSchema, tool("upload_project")!.inputSchema);
  assert.match(String(tool("upload_kicad_project")!.description), /upload_project/);

  const { fake, home, ctx } = await host();
  const kicad = await copyFixture("blinky2", home);
  const altium = await copyFixture("altium-lamp", home);
  const results: Uploaded[] = [];
  for (const name of ["upload_project", "upload_kicad_project"]) {
    results.push(ok(await callLocalTool(ctx, name, { path: kicad })));
    results.push(ok(await callLocalTool(ctx, name, { path: path.join(altium, "lamp.PcbDoc") })));
  }
  assert.deepEqual(
    results.map((r) => r.format),
    ["kicad", "altium", "kicad", "altium"]
  );
  assert.deepEqual(results[2].uploaded, results[0].uploaded, "the same KiCad files either way");
  assert.ok(fake.imports[2].data.equals(fake.imports[0].data), "the same zip, byte for byte");
  assert.ok(fake.imports[3].data.equals(fake.imports[1].data), "the same board, byte for byte");
});

test("open_kicad_project stays KiCad-only: a .PcbDoc is still not_kicad there", async () => {
  const { fake, home, ctx } = await host();
  const root = await copyFixture("altium-lamp", home);
  const out = refused(await callLocalTool(ctx, "open_kicad_project", { path: path.join(root, "lamp.PcbDoc") }));
  assert.equal(out.code, "not_kicad");
  assert.equal(fake.imports.length, 0);
});

test("a board upload whose first try wrote nothing (503) is sent again with the same key and bytes", async () => {
  const { fake, home, ctx } = await host({
    importAnswers: [
      { status: 503, body: { ok: false, code: "engine_unavailable", error: "busy", fix: "retry", retryable: true, written: false } },
      { status: 200, body: { ok: true, project: { id: "prj_retry", name: "lamp", revision: null } } },
    ],
  });
  const root = await copyFixture("altium-lamp", home);
  const out = ok(await uploadProject(ctx, { path: path.join(root, "lamp.PcbDoc") }));
  assert.equal(out.project.id, "prj_retry");
  assert.equal(fake.imports.length, 2);
  assert.equal(fake.imports[0].idempotencyKey, fake.imports[1].idempotencyKey);
  assert.ok(fake.imports[0].data.equals(fake.imports[1].data));
});

test("refusals send nothing: an empty or missing path, a schematic or other file, no board, several, outside the folder, over 50 MB", async (t) => {
  const { fake, home, ctx } = await host();
  const altium = await copyFixture("altium-lamp", home);
  const boards = await copyFixture("boards", home);
  const code = async (args: Record<string, unknown>) => refused(await uploadProject(ctx, args));

  assert.equal((await code({ path: "" })).code, "bad_path");
  assert.equal((await code({})).code, "bad_path");
  assert.equal((await code({ path: path.join(home, "nowhere", "lamp.PcbDoc") })).code, "not_found");

  const sheet = await code({ path: path.join(altium, "lamp.SchDoc") });
  assert.equal(sheet.code, "unsupported_file_type");
  assert.match(sheet.error, /Altium schematic/);
  assert.match(sheet.fix, /\.PcbDoc/);
  const notes = path.join(home, "notes.txt");
  await fsp.writeFile(notes, "not a board");
  const other = await code({ path: notes });
  assert.equal(other.code, "unsupported_file_type");
  assert.match(other.fix, /\.PcbDoc/);
  assert.match(other.fix, /\.kicad_pcb/);

  const empty = path.join(home, "empty");
  await fsp.mkdir(empty);
  await fsp.writeFile(path.join(empty, "readme.md"), "nothing here");
  const none = await code({ path: empty });
  assert.equal(none.code, "no_project");
  assert.match(none.fix, /\.PrjPcb/);

  const several = await code({ path: boards });
  assert.equal(several.code, "several_projects");
  assert.deepEqual([...(several.candidates ?? [])].sort(), ["PCB_blinky.json", "blinky.brd", "blinky.epro"]);
  await fsp.copyFile(path.join(altium, "lamp.PrjPcb"), path.join(altium, "copy.PrjPcb"));
  const two = await code({ path: altium });
  assert.equal(two.code, "several_projects");
  assert.deepEqual(two.candidates, ["copy.PrjPcb", "lamp.PrjPcb"]);
  await fsp.rm(path.join(altium, "copy.PrjPcb"));

  const prj = path.join(altium, "lamp.PrjPcb");
  const listed = await fsp.readFile(prj, "latin1");
  await fsp.writeFile(prj, listed.replace("DocumentPath=lamp.PcbDoc\r\n", ""), "latin1");
  const sheetsOnly = await code({ path: altium });
  assert.equal(sheetsOnly.code, "no_board");
  assert.match(sheetsOnly.fix, /\.PcbDoc/);
  await fsp.writeFile(prj, listed.replace("DocumentPath=lamp.SchDoc", "DocumentPath=..\\..\\elsewhere\\lamp.SchDoc"), "latin1");
  assert.equal((await code({ path: altium })).code, "unsafe_path", "a listed sheet outside the folder refuses the whole upload");
  await fsp.writeFile(prj, listed, "latin1");

  if (process.platform !== "win32") {
    const outside = tmpDir();
    await fsp.copyFile(path.join(altium, "lamp.PcbDoc"), path.join(outside, "secret.PcbDoc"));
    const linked = path.join(home, "linked");
    await fsp.mkdir(linked);
    await fsp.symlink(path.join(outside, "secret.PcbDoc"), path.join(linked, "board.PcbDoc"));
    assert.equal((await code({ path: path.join(linked, "board.PcbDoc") })).code, "unsafe_path", "a link out of the folder");
  } else t.diagnostic("symlinks need privileges on Windows");

  const big = path.join(home, "big");
  await fsp.mkdir(big);
  await fsp.writeFile(path.join(big, "huge.PcbDoc"), Buffer.alloc(51 * 1024 * 1024, 0x41));
  assert.equal((await code({ path: path.join(big, "huge.PcbDoc") })).code, "project_too_large");

  assert.equal(fake.imports.length, 0);
  assert.equal(fake.requests.filter((r) => r.path === "/v1/projects/import").length, 0, "no refusal reached the import");
});
