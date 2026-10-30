/**
 * upload_kicad_project: which files go into the zip (the KiCad plugin's own
 * list), the refusals (outside the folder, over 50 MB, several projects), and
 * the import call (multipart, Idempotency-Key, the same key on a retry).
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Auth } from "../src/auth.ts";
import { CredentialStore } from "../src/credentials.ts";
import { collectProject, locateProject, tilde } from "../src/kicad-files.ts";
import { uploadKicadProject } from "../src/local-tools.ts";
import { RefusalError } from "../src/refusal.ts";
import { buildZip } from "../src/zip.ts";
import { startFakeHeypcb } from "./fake-heypcb.ts";
import { configFor, readZip, TEST_KEY, tmpDir } from "./helpers.ts";

const closers: Array<() => Promise<void>> = [];
after(async () => {
  for (const c of closers) await c();
});

const sch = (sheets: string[] = []) =>
  `(kicad_sch (version 20250114) (generator "eeschema")\n` +
  sheets.map((f, i) => `  (sheet (at 10 10) (size 20 20) (property "Sheetname" "S${i}") (property "Sheetfile" "${f}"))\n`).join("") +
  `)\n`;

async function write(root: string, rel: string, text: string | Buffer) {
  const p = path.join(root, ...rel.split("/"));
  await fsp.mkdir(path.dirname(p), { recursive: true });
  await fsp.writeFile(p, text);
}

/** A project with a hierarchy, local libraries, and everything the upload must leave out. */
async function makeProject(): Promise<string> {
  const root = path.join(tmpDir(), "led-blinker");
  await write(root, "board.kicad_pro", '{"meta": {"filename": "board.kicad_pro"}}');
  await write(root, "board.kicad_pcb", "(kicad_pcb (version 20250114) (generator pcbnew))\n");
  await write(root, "board.kicad_sch", sch(["sub/power.kicad_sch", "missing.kicad_sch"]));
  await write(root, "sub/power.kicad_sch", sch(["../shared.kicad_sch"]));
  await write(root, "shared.kicad_sch", sch(["sub/power.kicad_sch"])); // a loop is walked once
  await write(root, "board.kicad_dru", "(version 1)\n");
  await write(root, "board.kicad_prl", "{}");
  await write(root, "fp-info-cache", "x");
  await write(root, "sym-lib-table", '(sym_lib_table (version 7)\n  (lib (name "my") (type "KiCad") (uri "${KIPRJMOD}/libs/my.kicad_sym") (options "") (descr ""))\n  (lib (name "Device") (type "KiCad") (uri "${KICAD10_SYMBOL_DIR}/Device.kicad_sym") (options "") (descr ""))\n)\n');
  await write(root, "fp-lib-table", '(fp_lib_table (version 7)\n  (lib (name "my") (type "KiCad") (uri "${KIPRJMOD}/libs/my.pretty") (options "") (descr ""))\n)\n');
  await write(root, "libs/my.kicad_sym", "(kicad_symbol_lib (version 20241209))\n");
  await write(root, "libs/my.pretty/R.kicad_mod", "(footprint R)\n");
  await write(root, "libs/my.pretty/C.kicad_mod", "(footprint C)\n");
  await write(root, "libs/my.pretty/readme.txt", "not a footprint");
  await write(root, "libs/my.pretty/R.step", "a 3D model");
  await write(root, "3d/part.step", "a 3D model");
  await write(root, "board-backups/board-2026-10-11.zip", "old");
  await write(root, "_autosave-board.kicad_pcb", "autosave");
  await write(root, "notes.txt", "notes");
  return root;
}

const EXPECTED = [
  "board.kicad_pcb",
  "board.kicad_dru",
  "board.kicad_pro",
  "board.kicad_sch",
  "fp-lib-table",
  "libs/my.kicad_sym",
  "libs/my.pretty/C.kicad_mod",
  "libs/my.pretty/R.kicad_mod",
  "shared.kicad_sch",
  "sub/power.kicad_sch",
  "sym-lib-table",
];

test("collects exactly the plugin's file list: board first, the hierarchy, lib tables and project-local libraries", async () => {
  const root = await makeProject();
  const col = await collectProject(root, "board");
  assert.deepEqual(
    col.files.map((f) => f.path),
    EXPECTED
  );
  assert.deepEqual(col.missing, [{ path: "missing.kicad_sch", kind: "schematic" }], "a sheet the schematic names but the folder lacks is reported");
  assert.equal(col.totalBytes, col.files.reduce((n, f) => n + f.bytes, 0));
});

test("the zip holds those files and only those, byte for byte, readable by Python's zipfile too", async () => {
  const root = await makeProject();
  const col = await collectProject(root, "board");
  const zip = buildZip(col.files.map((f) => ({ path: f.path, data: f.data })));
  const entries = readZip(zip);
  assert.deepEqual([...entries.keys()], [...EXPECTED].sort());
  for (const f of col.files) assert.ok(entries.get(f.path)!.equals(await fsp.readFile(path.join(root, ...f.path.split("/")))), f.path);
  assert.ok(buildZip(col.files.map((f) => ({ path: f.path, data: f.data }))).equals(zip), "the same files give the same bytes");
  let python: string | null = null;
  try {
    python = execFileSync("python3", ["-c", "import sys,zipfile,io; z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())); assert z.testzip() is None; print('\\n'.join(z.namelist()))"], { input: zip, encoding: "utf8" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  if (python !== null) assert.deepEqual(python.trim().split("\n"), [...EXPECTED].sort());
});

test("finds the project from its folder, a parent folder, or one of its files", async () => {
  const root = await makeProject();
  assert.deepEqual(await locateProject(root), { root, stem: "board" });
  assert.deepEqual(await locateProject(path.dirname(root)), { root, stem: "board" });
  assert.deepEqual(await locateProject(path.join(root, "board.kicad_pcb")), { root, stem: "board" });
  const home = path.dirname(path.dirname(root));
  assert.deepEqual(await locateProject("~/" + path.relative(home, root), home), { root, stem: "board" });
});

test("two projects in one folder are refused with the candidates", async () => {
  const root = await makeProject();
  await write(root, "other.kicad_pro", "{}");
  await assert.rejects(locateProject(root), (e: unknown) => e instanceof RefusalError && e.refusal.code === "several_projects" && (e.refusal.candidates as string[]).length === 2);
});

test("a link that leads outside the project folder refuses the whole upload", async (t) => {
  if (process.platform === "win32") return t.skip("symlinks need privileges on Windows");
  const root = await makeProject();
  const outside = tmpDir();
  await write(outside, "secret.kicad_mod", "(footprint secret)");
  await fsp.rm(path.join(root, "libs", "my.pretty"), { recursive: true });
  await fsp.symlink(outside, path.join(root, "libs", "my.pretty"));
  await assert.rejects(collectProject(root, "board"), (e: unknown) => e instanceof RefusalError && e.refusal.code === "unsafe_path");
});

test("a sheet path that climbs out of the project folder is refused", async () => {
  const root = await makeProject();
  await write(root, "board.kicad_sch", sch(["../../elsewhere/x.kicad_sch"]));
  await assert.rejects(collectProject(root, "board"), (e: unknown) => e instanceof RefusalError && e.refusal.code === "unsafe_path");
});

test("more than 50 MB is refused, naming the largest files", async () => {
  const root = await makeProject();
  await write(root, "libs/my.kicad_sym", Buffer.alloc(51 * 1024 * 1024, 0x41));
  await assert.rejects(collectProject(root, "board"), (e: unknown) => {
    assert.ok(e instanceof RefusalError);
    assert.equal(e.refusal.code, "project_too_large");
    assert.equal((e.refusal.largest as Array<{ path: string }>)[0].path, "libs/my.kicad_sym");
    return true;
  });
});

function ctxFor(mcpUrl: string, home?: string) {
  const config = configFor(mcpUrl, { HEYPCB_API_KEY: TEST_KEY });
  return { config, auth: new Auth(config, new CredentialStore(path.join(tmpDir(), "c.json"))), home };
}

test("uploads the zip as multipart `file` with an Idempotency-Key, and returns the project id and web link", async () => {
  const fake = await startFakeHeypcb({ acceptTokens: new Set([TEST_KEY]) });
  closers.push(fake.close);
  const root = await makeProject();
  const res = await uploadKicadProject(ctxFor(fake.mcpUrl), { path: root });
  assert.equal(res.isError, undefined, JSON.stringify(res.structuredContent));
  const out = res.structuredContent as { project: { id: string }; webUrl: string; uploaded: { files: string[] } };
  assert.equal(out.project.id, "prj_123");
  assert.equal(out.webUrl, `${fake.url}/p/prj_123`);
  assert.deepEqual(out.uploaded.files, EXPECTED);

  const req = fake.requests.find((r) => r.path === "/v1/projects/import")!;
  assert.equal(req.headers.authorization, `Bearer ${TEST_KEY}`);
  assert.match(String(req.headers["idempotency-key"]), /^[0-9a-f-]{36}$/);
  const form = await new Response(new Uint8Array(req.body), { headers: { "content-type": String(req.headers["content-type"]) } }).formData();
  assert.equal(form.get("name"), "board");
  const file = form.get("file") as Blob & { name?: string };
  assert.equal(file.name, "board.zip");
  assert.equal(file.type, "application/zip");
  assert.deepEqual([...readZip(Buffer.from(await file.arrayBuffer())).keys()], [...EXPECTED].sort());
});

test("a 503 that wrote nothing is sent again with the SAME key; a timeout is never re-sent; a refusal is passed through", async () => {
  const fake = await startFakeHeypcb({
    acceptTokens: new Set([TEST_KEY]),
    importAnswers: [
      { status: 503, body: { ok: false, code: "engine_unavailable", error: "busy", fix: "retry", retryable: true, written: false } },
      { status: 200, body: { ok: true, project: { id: "prj_retry", name: "board", revision: null } } },
    ],
  });
  closers.push(fake.close);
  const root = await makeProject();
  const res = await uploadKicadProject(ctxFor(fake.mcpUrl), { path: root, name: "LED blinker" });
  assert.equal((res.structuredContent as { project: { id: string } }).project.id, "prj_retry");
  const keys = fake.requests.filter((r) => r.path === "/v1/projects/import").map((r) => r.headers["idempotency-key"]);
  assert.equal(keys.length, 2);
  assert.equal(keys[0], keys[1]);

  const timedOut = await startFakeHeypcb({
    acceptTokens: new Set([TEST_KEY]),
    importAnswers: [{ status: 504, body: { ok: false, code: "import_timeout", error: "The design engine may still be importing this file.", fix: "Check your boards in a moment.", retryable: true } }],
  });
  closers.push(timedOut.close);
  const late = await uploadKicadProject(ctxFor(timedOut.mcpUrl), { path: root });
  assert.equal((late.structuredContent as { code: string }).code, "import_timeout");
  assert.equal(timedOut.requests.filter((r) => r.path === "/v1/projects/import").length, 1, "a timeout may have imported it: never sent twice");

  const refusing = await startFakeHeypcb({
    acceptTokens: new Set([TEST_KEY]),
    importAnswers: [{ status: 402, body: { ok: false, code: "project_limit", error: "Your plan's boards are used up.", fix: "Upgrade in Settings → Plan & billing.", retryable: false } }],
  });
  closers.push(refusing.close);
  const refused = await uploadKicadProject(ctxFor(refusing.mcpUrl), { path: root });
  assert.equal(refused.isError, true);
  assert.equal((refused.structuredContent as { code: string }).code, "project_limit");
  assert.equal((refused.structuredContent as { fix: string }).fix, "Upgrade in Settings → Plan & billing.");
});

test("tilde shortens only paths inside the home folder", () => {
  const home = os.homedir();
  assert.equal(tilde(path.join(home, "boards")), path.join("~", "boards"));
  assert.equal(tilde(home), "~");
  assert.equal(tilde(home + "-other" + path.sep + "boards"), home + "-other" + path.sep + "boards");
});
