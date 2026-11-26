/**
 * save_export: where it may write (judged on the real path), the file name
 * from the server made safe, never overwriting unless asked, the atomic
 * write, and the API's refusals passed through.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { Auth } from "../src/auth.ts";
import { CredentialStore } from "../src/credentials.ts";
import { dispositionName, projectId, saveExport } from "../src/local-tools.ts";
import { resolveTargetDir, safeFileName, writeAtomic } from "../src/safe-path.ts";
import { RefusalError } from "../src/refusal.ts";
import { startFakeHeypcb } from "./fake-heypcb.ts";
import { configFor, TEST_KEY, tmpDir } from "./helpers.ts";

const closers: Array<() => Promise<void>> = [];
after(async () => {
  for (const c of closers) await c();
});

function layout() {
  const base = tmpDir();
  return { base, home: path.join(base, "home"), outside: path.join(base, "outside") };
}

async function refusedWith(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof RefusalError, String(e));
    assert.equal(e.refusal.code, code, e.refusal.error);
    assert.ok(e.refusal.fix.length > 0);
    return true;
  });
}

test("inside home: a missing folder is created; outside home: only an existing, writable one", async () => {
  const { home, outside } = layout();
  await fsp.mkdir(home, { recursive: true });
  const made = await resolveTargetDir("~/exports/rev-a", { home });
  assert.equal(made, path.join(home, "exports", "rev-a"));
  assert.ok((await fsp.stat(made)).isDirectory());
  await refusedWith(resolveTargetDir(path.join(outside, "new"), { home }), "outside_home_missing");
  await fsp.mkdir(outside, { recursive: true });
  assert.equal(await resolveTargetDir(outside, { home }), outside);
});

test("no link is followed out of the home folder, and secret folders are refused", async (t) => {
  if (process.platform === "win32") return t.skip("symlinks need privileges on Windows");
  const { home, outside } = layout();
  await fsp.mkdir(home, { recursive: true });
  await fsp.mkdir(outside, { recursive: true });
  await fsp.symlink(outside, path.join(home, "escape"));
  await refusedWith(resolveTargetDir("~/escape", { home }), "symlink_escape");
  await refusedWith(resolveTargetDir("~/escape/deeper", { home }), "symlink_escape");
  await refusedWith(resolveTargetDir("~/.ssh", { home }), "protected_dir");
  await refusedWith(resolveTargetDir("~/.config/heypcb", { home }), "protected_dir");
  await fsp.mkdir(path.join(home, "custom-config"), { recursive: true });
  await refusedWith(resolveTargetDir("~/custom-config/sub", { home, protectedDirs: [path.join(home, "custom-config")] }), "protected_dir");
  // A link that stays inside home is fine: the bytes land inside home.
  await fsp.mkdir(path.join(home, "real"), { recursive: true });
  await fsp.symlink(path.join(home, "real"), path.join(home, "alias"));
  assert.equal(await resolveTargetDir("~/alias", { home }), path.join(home, "real"));
  await fsp.writeFile(path.join(home, "file.txt"), "x");
  await refusedWith(resolveTargetDir("~/file.txt", { home }), "not_a_folder");
  await refusedWith(resolveTargetDir("", { home }), "bad_dir");
});

test("a read-only folder outside home is refused", async (t) => {
  if (process.platform === "win32" || process.getuid?.() === 0) return t.skip("POSIX permissions, not as root");
  const { home, outside } = layout();
  await fsp.mkdir(home, { recursive: true });
  await fsp.mkdir(outside, { recursive: true, mode: 0o555 });
  await fsp.chmod(outside, 0o555);
  try {
    await refusedWith(resolveTargetDir(outside, { home }), "not_writable");
  } finally {
    await fsp.chmod(outside, 0o755);
  }
});

test("the server's file name is reduced to one safe name", () => {
  assert.equal(safeFileName("../../evil.zip", "f.zip"), "evil.zip");
  assert.equal(safeFileName("..\\..\\evil.zip", "f.zip"), "evil.zip");
  assert.equal(safeFileName(".bashrc", "f.zip"), "bashrc");
  assert.equal(safeFileName("a‮cod.zip", "f.zip"), "acod.zip");
  assert.equal(safeFileName("", "f.zip"), "f.zip");
  assert.equal(safeFileName("..", "f.zip"), "f.zip");
  assert.equal(safeFileName("CON.txt", "f.zip"), "_CON.txt");
  assert.equal(dispositionName('attachment; filename="led blinker-gerbers.zip"'), "led blinker-gerbers.zip");
  assert.equal(dispositionName("attachment; filename*=UTF-8''r%C3%A9v%20A.zip; filename=\"rev A.zip\""), "rév A.zip");
  assert.equal(dispositionName("attachment; filename=plain.csv"), "plain.csv");
  assert.equal(dispositionName(null), null);
  assert.equal(projectId("prj_123"), "prj_123");
  assert.equal(projectId("https://heypcb.ai/p/prj_123?tab=pcb"), "prj_123");
  assert.equal(projectId("../etc"), null);
});

test("project links reject malformed escapes while preserving valid project IDs", () => {
  for (const [input, expected] of [
    ["https://heypcb.ai/p/%", null],
    ["https://heypcb.ai/p/%2", null],
    ["https://heypcb.ai/p/%GG", null],
    ["https://heypcb.ai/p/%E0%A4%A", null],
    ["https://heypcb.ai/p/%FF", null],
    ["https://heypcb.ai/p/%ED%A0%80", null],
    ["prj_123", "prj_123"],
    ["  prj_123  ", "prj_123"],
    ["https://heypcb.ai/p/prj%5F123", "prj_123"],
    ["https://heypcb.ai/p/prj%2D123%2Erev", "prj-123.rev"],
    ["https://heypcb.ai/p/prj_123?tab=pcb#view", "prj_123"],
    ["https://heypcb.ai/p/prj%5F123?tab=pcb#view", "prj_123"],
    ["https://heypcb.ai/p/prj%2F123", null],
    ["https://heypcb.ai/p/%25", null],
    ["https://heypcb.ai/p/%E6%9D%BF", null],
    ["../etc", null],
    ["", null],
    [null, null],
    [123, null],
  ] as const) assert.equal(projectId(input), expected, JSON.stringify(input));
});

async function exportFake(answer?: { status: number; headers: Record<string, string>; body: Buffer | string }) {
  const fake = await startFakeHeypcb({ acceptTokens: new Set([TEST_KEY]), exportAnswer: answer });
  closers.push(fake.close);
  const config = configFor(fake.mcpUrl, { HEYPCB_API_KEY: TEST_KEY });
  const { home } = layout();
  await fsp.mkdir(home, { recursive: true });
  return { fake, home, ctx: { config, auth: new Auth(config, new CredentialStore(path.join(tmpDir(), "c.json"))), home } };
}

test("save_export refuses malformed project links before requests or directory creation", async () => {
  const { ctx, home, fake } = await exportFake();
  const dir = path.join(home, "not-created");
  for (const suffix of ["%", "%2", "%GG", "%E0%A4%A", "%FF", "%ED%A0%80"]) {
    const res = await saveExport(ctx, { project: `https://heypcb.ai/p/${suffix}`, kind: "gerbers", dir });
    assert.equal(res.isError, true);
    const out = res.structuredContent as { ok: boolean; code: string; fix: string };
    assert.equal(out.ok, false);
    assert.equal(out.code, "bad_project");
    assert.ok(out.fix.length > 0);
  }
  assert.equal(fake.requests.length, 0, "invalid project links send no requests");
  await assert.rejects(fsp.stat(dir), { code: "ENOENT" });
  assert.deepEqual(await fsp.readdir(home), [], "argument validation leaves the destination unchanged");
});

test("oversized export names fit 200 UTF-8 bytes without splitting graphemes or repeating extensions", () => {
  for (const [raw, expected] of [
    ["a".repeat(196) + ".zip", "a".repeat(196) + ".zip"],
    ["a".repeat(197) + ".zip", "a".repeat(196) + ".zip"],
    ["板".repeat(150) + ".zip", "板".repeat(65) + ".zip"],
    ["😀".repeat(120) + ".zip", "😀".repeat(49) + ".zip"],
    ["e\u0301".repeat(80) + ".zip", "e\u0301".repeat(65) + ".zip"],
    ["a" + "e\u0301".repeat(80) + ".zip", "a" + "e\u0301".repeat(65) + ".zip"],
    ["🇮🇳".repeat(40) + ".zip", "🇮🇳".repeat(24) + ".zip"],
    ["板".repeat(100) + ".abcdefghijklmno", "板".repeat(61) + ".abcdefghijklmno"],
    ["板".repeat(100) + ".数据", "板".repeat(64) + ".数据"],
    ["board." + "x".repeat(250), "board." + "x".repeat(194)],
    ["board." + "界".repeat(70), "board." + "界".repeat(64)],
    ["板".repeat(100), "板".repeat(66)],
    ["e" + "\u0301".repeat(300) + ".zip", "export.zip"],
    ["CONe" + "\u0301".repeat(300) + ".zip", "_CON.zip"],
    ["a. " + "e" + "\u0301".repeat(300) + ".zip", "a.zip"],
  ]) {
    const name = safeFileName(raw, "f.zip");
    assert.equal(name, expected, `input: ${Buffer.byteLength(raw)} bytes`);
    assert.ok(Buffer.byteLength(name) <= 200, `${Buffer.byteLength(name)} bytes`);
    assert.equal(Buffer.from(name, "utf8").toString("utf8"), name, "no surrogate is split");
  }
});

test("atomic export writes use a byte-bounded temporary name with whole accents", async () => {
  const dir = tmpDir();
  const name = "a" + "e\u0301".repeat(65) + ".zip";
  const body = Buffer.from("export bytes");
  async function* chunks() {
    const files = await fsp.readdir(dir);
    assert.equal(files.length, 1);
    const match = /^\.(.*)\.[0-9a-f]{12}\.part$/.exec(files[0]);
    assert.ok(match, files[0]);
    assert.ok(Buffer.byteLength(match[1]) <= 60);
    assert.equal(match[1], "a" + "e\u0301".repeat(19));
    yield body;
  }
  const out = await writeAtomic(dir, name, chunks());
  assert.equal(out.path, path.join(dir, name));
  assert.equal(out.bytes, body.length);
  assert.deepEqual(await fsp.readFile(out.path), body);
  assert.deepEqual(await fsp.readdir(dir), [name], "the temporary file was renamed");
});

test("save_export writes long UTF-8 server filenames, numbers copies and preserves overwrite behavior", async () => {
  const body = Buffer.from("PK\u0003\u0004unicode gerbers");
  const raw = "板".repeat(150) + ".zip";
  const { ctx, home } = await exportFake({ status: 200, headers: {
    "content-type": "application/zip",
    "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(raw)}`,
  }, body });
  const dir = path.join(home, "fab");
  for (const [overwrite, expected] of [
    [false, "板".repeat(65) + ".zip"],
    [false, "板".repeat(65) + "-2.zip"],
    [true, "板".repeat(65) + ".zip"],
  ] as const) {
    const res = await saveExport(ctx, { project: "prj_1", kind: "gerbers", dir, overwrite });
    assert.equal(res.isError, undefined, JSON.stringify(res.structuredContent));
    const out = res.structuredContent as { path: string; bytes: number };
    assert.equal(out.path, path.join(dir, expected));
    assert.equal(out.bytes, body.length);
    assert.deepEqual(await fsp.readFile(out.path), body);
  }
  assert.deepEqual((await fsp.readdir(dir)).sort(), ["板".repeat(65) + ".zip", "板".repeat(65) + "-2.zip"].sort());
});

test("saves the export atomically under the server's name, never over an existing file unless asked", async () => {
  const body = Buffer.from("PK\u0003\u0004gerbers");
  const { ctx, home, fake } = await exportFake({ status: 200, headers: { "content-type": "application/zip", "content-disposition": 'attachment; filename="../../led-gerbers.zip"' }, body });
  const first = await saveExport(ctx, { project: "prj_1", kind: "gerbers", dir: "~/fab" });
  assert.equal(first.isError, undefined, JSON.stringify(first.structuredContent));
  const out = first.structuredContent as { path: string; bytes: number };
  assert.equal(out.path, path.join(home, "fab", "led-gerbers.zip"));
  assert.equal(out.bytes, body.length);
  assert.ok((await fsp.readFile(out.path)).equals(body));
  const second = await saveExport(ctx, { project: "prj_1", kind: "gerbers", dir: "~/fab" });
  assert.equal((second.structuredContent as { path: string }).path, path.join(home, "fab", "led-gerbers-2.zip"));
  const third = await saveExport(ctx, { project: "prj_1", kind: "gerbers", dir: "~/fab", overwrite: true });
  assert.equal((third.structuredContent as { path: string }).path, path.join(home, "fab", "led-gerbers.zip"));
  assert.deepEqual((await fsp.readdir(path.join(home, "fab"))).sort(), ["led-gerbers-2.zip", "led-gerbers.zip"], "no .part file is left");
  const req = fake.requests.find((r) => r.path === "/v1/projects/prj_1/exports/gerbers")!;
  assert.equal(req.headers.authorization, `Bearer ${TEST_KEY}`);
});

test("a refusal from the export is passed through; bad arguments are refused before anything is fetched", async () => {
  const refusalBody = { ok: false, code: "trial_downloads_used", error: "Your trial's five design-file downloads are used.", fix: "Choose a plan in Settings → Plan & billing.", retryable: false };
  const { ctx, fake } = await exportFake({ status: 402, headers: { "content-type": "application/json" }, body: JSON.stringify(refusalBody) });
  const res = await saveExport(ctx, { project: "prj_1", kind: "bom", dir: "~/out" });
  assert.equal(res.isError, true);
  assert.equal((res.structuredContent as { code: string }).code, "trial_downloads_used");
  assert.equal((res.structuredContent as { fix: string }).fix, refusalBody.fix);
  const before = fake.requests.length;
  for (const [args, code] of [
    [{ project: "prj_1", kind: "pdf", dir: "~/out" }, "bad_kind"],
    [{ project: "../x", kind: "bom", dir: "~/out" }, "bad_project"],
    [{ project: "prj_1", kind: "bom", dir: "~/.ssh" }, "protected_dir"],
  ] as const) {
    const r = await saveExport(ctx, args as Record<string, unknown>);
    assert.equal((r.structuredContent as { code: string }).code, code);
  }
  assert.equal(fake.requests.length, before, "nothing was fetched for a refused argument");
});
