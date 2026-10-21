/**
 * check_local and export_local. Reading KiCad's report JSON is tested
 * everywhere; running kicad-cli on the fixture projects needs KiCad, so
 * those tests skip when it is not installed — except in the CI job that
 * installs it, which sets HEYPCB_REQUIRE_KICAD_CLI=1 so a missing or
 * broken kicad-cli fails instead of skipping.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { Auth } from "../src/auth.ts";
import { loadConfig } from "../src/config.ts";
import { CredentialStore } from "../src/credentials.ts";
import { checkFileVersion, cliCandidates, findKicadCli, readCheckResult, readReport } from "../src/kicad-cli.ts";
import { checkLocal, exportLocal, installPartsTool } from "../src/local-tools.ts";
import { RefusalError } from "../src/refusal.ts";
import { copyFixture, readZip, tmpDir } from "./helpers.ts";

const required = process.env.HEYPCB_REQUIRE_KICAD_CLI === "1";
const cli = await findKicadCli().catch((err) => {
  if (required) throw err;
  return null;
});
const needsKicad = { skip: cli ? false : "kicad-cli is not installed" };

function ctx(home: string) {
  const r = loadConfig({});
  assert.ok(r.ok);
  return { config: r.config, auth: new Auth(r.config, new CredentialStore(path.join(home, ".config", "heypcb", "c.json"))), home };
}

test("KiCad's DRC and ERC JSON become findings, errors first, with counts", () => {
  const drc = readReport(
    "drc",
    {
      violations: [{ description: "Track has unconnected end", severity: "warning", type: "track_dangling", items: [{ description: "Track [LED]", pos: { x: 110.8, y: 100 } }] }],
      unconnected_items: [{ description: "Missing connection", severity: "error", type: "unconnected_items", items: [{ description: "Pad 1 of R2", pos: { x: 119.2, y: 100 } }] }],
      schematic_parity: [],
    },
    "b.kicad_pcb",
    "9.0.1"
  );
  assert.equal(drc.passed, false);
  assert.deepEqual(drc.counts, { errors: 1, warnings: 1, unconnected: 1, parity: 0 });
  assert.deepEqual(drc.findings[0], { severity: "error", type: "unconnected_items", message: "Missing connection", where: [{ text: "Pad 1 of R2", x: 119.2, y: 100 }] });
  const erc = readReport("erc", { sheets: [{ path: "/Power/", violations: [{ description: "Pin not connected", severity: "error", type: "pin_not_connected", items: [] }] }] }, "b.kicad_sch", "9.0.1");
  assert.deepEqual(erc.counts, { errors: 1, warnings: 0 });
  assert.equal(erc.findings[0].type, "pin_not_connected");
  assert.equal(readReport("erc", { sheets: [] }, "b.kicad_sch", "9").passed, true);
});

test("missing, wrong-kind and malformed KiCad report structures never pass", () => {
  const clean = { violations: [], unconnected_items: [], schematic_parity: [] };
  const invalid = (err: unknown) => err instanceof RefusalError && err.refusal.code === "kicad_report_invalid";
  for (const value of [null, [], {}, { sheets: [] }, { ...clean, violations: null }, { ...clean, unconnected_items: undefined }, { ...clean, schematic_parity: {} }, { ...clean, violations: [null] }, { ...clean, violations: [{ type: "clearance", description: "Short", severity: "unexpected" }] }]) {
    assert.throws(() => readReport("drc", value, "b.kicad_pcb", "9"), invalid);
  }
  for (const value of [{}, clean, { sheets: [null] }, { sheets: [{ path: "/", violations: null }] }, { sheets: [{ path: "/", violations: [{ type: "pin_not_driven", description: "No driver", severity: "unexpected" }] }] }]) {
    assert.throws(() => readReport("erc", value, "b.kicad_sch", "9"), invalid);
  }
  assert.equal(readReport("drc", clean, "b.kicad_pcb", "9").passed, true);
  assert.equal(readReport("erc", { sheets: [{ path: "/", violations: [] }] }, "b.kicad_sch", "9").passed, true);
});

test("failed CLI, missing output and invalid JSON cannot become passing local checks", () => {
  const fakeCli = { bin: "kicad-cli", version: "9.0.1", major: 9 };
  const clean = JSON.stringify({ violations: [], unconnected_items: [], schematic_parity: [] });
  const result = { code: 0, stdout: "", stderr: "" };
  const failed = (err: unknown) => err instanceof RefusalError && err.refusal.code === "kicad_cli_failed";
  const invalid = (err: unknown) => err instanceof RefusalError && err.refusal.code === "kicad_report_invalid";
  assert.throws(() => readCheckResult("drc", { ...result, code: 3, stderr: "Cannot load board" }, clean, "b.kicad_pcb", fakeCli), failed);
  assert.throws(() => readCheckResult("drc", result, null, "b.kicad_pcb", fakeCli), failed);
  assert.throws(() => readCheckResult("drc", result, "{", "b.kicad_pcb", fakeCli), invalid);
  assert.throws(() => readCheckResult("drc", result, "{}", "b.kicad_pcb", fakeCli), invalid);
  const withViolation = JSON.stringify({ violations: [{ description: "Short", type: "shorting_items", severity: "error", items: [] }], unconnected_items: [], schematic_parity: [] });
  assert.equal(readCheckResult("drc", result, withViolation, "b.kicad_pcb", fakeCli).passed, false, "a completed native check still reports its violations");
  assert.equal(readCheckResult("drc", result, clean, "b.kicad_pcb", fakeCli).passed, true);
});

test("kicad-cli is looked for on PATH first, then where KiCad installs it", async () => {
  const mac = await cliCandidates({ PATH: "/opt/bin" }, "darwin");
  assert.equal(mac[0], path.join("/opt/bin", "kicad-cli"));
  assert.ok(mac.includes("/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli"));
  assert.ok((await cliCandidates({ PATH: "" }, "linux")).includes("/usr/bin/kicad-cli"));
});

test("a file older than KiCad 8's format is refused before kicad-cli runs", async () => {
  const dir = tmpDir();
  const f = path.join(dir, "old.kicad_pcb");
  await fsp.writeFile(f, "(kicad_pcb (version 20221018) (generator pcbnew))\n");
  await assert.rejects(checkFileVersion(f), (err: unknown) => err instanceof RefusalError && err.refusal.code === "kicad_file_too_old");
  await fsp.writeFile(f, "(kicad_pcb (version 20240108) (generator pcbnew))\n");
  assert.equal(await checkFileVersion(f), 20240108);
});

for (const [fixture, layers] of [
  ["blinky2", 2],
  ["quad4", 4],
] as const) {
  test(`check_local drc on the ${layers}-layer fixture finds the unrouted connection`, needsKicad, async () => {
    const home = tmpDir();
    const root = await copyFixture(fixture, home);
    const res = await checkLocal(ctx(home), { path: root, kind: "drc" });
    const body = res.structuredContent as { ok: boolean; passed: boolean; counts: { unconnected: number }; findings: Array<{ type: string }>; kicad: string };
    assert.equal(res.isError, undefined, JSON.stringify(body));
    assert.equal(body.passed, false);
    assert.equal(body.counts.unconnected, 1);
    assert.ok(body.findings.some((f) => f.type === "unconnected_items"));
    assert.equal(body.kicad, cli!.version);
  });
}

test("check_local erc walks the hierarchical schematic", needsKicad, async () => {
  const home = tmpDir();
  const root = await copyFixture("blinky2", home);
  const res = await checkLocal(ctx(home), { path: root, kind: "erc" });
  const body = res.structuredContent as { findings: Array<{ type: string }> };
  assert.equal(res.isError, undefined, JSON.stringify(body));
  assert.ok(body.findings.some((f) => f.type === "pin_not_connected"));
});

test("export_local gerbers zips the Gerbers and drill files into the project's exports folder", needsKicad, async () => {
  const home = tmpDir();
  const root = await copyFixture("blinky2", home);
  const res = await exportLocal(ctx(home), { path: root, kind: "gerbers" });
  const body = res.structuredContent as { path: string; files: string[] };
  assert.equal(res.isError, undefined, JSON.stringify(body));
  assert.equal(body.path, path.join(root, "exports", "blinky-gerbers.zip"));
  const names = [...readZip(await fsp.readFile(body.path)).keys()];
  assert.ok(names.some((n) => /F_Cu\.(gtl|gbr)$/.test(n)), names.join(", "));
  assert.ok(names.some((n) => /\.drl$/.test(n)), names.join(", "));
  const again = await exportLocal(ctx(home), { path: root, kind: "gerbers" });
  assert.equal((again.structuredContent as { path: string }).path, path.join(root, "exports", "blinky-gerbers-2.zip"), "an existing export is kept");
});

test("export_local cpl and bom write CSVs", needsKicad, async () => {
  const home = tmpDir();
  const root = await copyFixture("blinky2", home);
  const cpl = await exportLocal(ctx(home), { path: root, kind: "cpl" });
  assert.match(await fsp.readFile((cpl.structuredContent as { path: string }).path, "utf8"), /R1.*R2|R2.*R1/s);
  const bom = await exportLocal(ctx(home), { path: root, kind: "bom" });
  assert.match(await fsp.readFile((bom.structuredContent as { path: string }).path, "utf8"), /R1/);
});

test("unavailable public installer refuses before path/auth/network access and preserves project files", async () => {
  const home = tmpDir();
  const root = await copyFixture("blinky2", home);
  const snapshot = async (dir: string): Promise<Array<[string, string]>> => {
    const out: Array<[string, string]> = [];
    for (const entry of (await fsp.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...await snapshot(file));
      else out.push([path.relative(root, file), (await fsp.readFile(file)).toString("hex")]);
    }
    return out;
  };
  const before = await snapshot(root);
  const context = ctx(home);
  let authOrNetworkCalls = 0;
  context.auth.bearer = async () => { authOrNetworkCalls++; throw new Error("Installer must refuse before authentication"); };
  context.auth.fetch = async () => { authOrNetworkCalls++; throw new Error("Installer must not request unavailable assets"); };
  let pathReads = 0;
  const res = await installPartsTool(context, { get path() { pathReads++; return root; }, parts: ["C2040", "C1525"] });
  assert.equal(res.isError, true);
  const body = res.structuredContent as { code: string; written: boolean; retryable: boolean };
  assert.equal(body.code, "parts_assets_unsupported");
  assert.equal(body.written, false);
  assert.equal(body.retryable, false);
  assert.equal(pathReads, 0, "unsupported installation must not inspect or create the target path");
  assert.equal(authOrNetworkCalls, 0);
  assert.deepEqual(await snapshot(root), before);
});
