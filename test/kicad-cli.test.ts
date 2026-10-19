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
import { checkFileVersion, cliCandidates, findKicadCli, readReport, run } from "../src/kicad-cli.ts";
import { installParts } from "../src/library.ts";
import { checkLocal, exportLocal } from "../src/local-tools.ts";
import { RefusalError } from "../src/refusal.ts";
import { startFakeHeypcb } from "./fake-heypcb.ts";
import { configFor, copyFixture, readZip, TEST_KEY, tmpDir } from "./helpers.ts";

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

test("the libraries install_parts writes load in KiCad", needsKicad, async () => {
  const fake = await startFakeHeypcb({});
  try {
    const home = tmpDir();
    const root = await copyFixture("blinky2", home);
    const config = configFor(fake.mcpUrl, { HEYPCB_API_KEY: TEST_KEY });
    await installParts({ config, auth: new Auth(config, new CredentialStore(path.join(home, ".config", "heypcb", "c.json"))) }, root, ["C2040", "C1525"]);
    const out = path.join(home, "svg");
    await fsp.mkdir(out);
    const sym = await run(cli!.bin, ["sym", "export", "svg", "-o", out, path.join(root, "heypcb.kicad_sym")]);
    assert.equal(sym.code, 0, sym.stderr);
    const fp = await run(cli!.bin, ["fp", "export", "svg", "-o", out, path.join(root, "heypcb.pretty")]);
    assert.equal(fp.code, 0, fp.stderr);
    const plotted = await fsp.readdir(out);
    for (const name of ["C_0402", "C_100nF", "QFN-56_7x7mm", "RP2040"]) assert.ok(plotted.some((f) => f.startsWith(name) && f.endsWith(".svg")), `${name} plotted: ${plotted.join(", ")}`);
  } finally {
    await fake.close();
  }
});
