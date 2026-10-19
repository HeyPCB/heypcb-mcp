/**
 * Editing KiCad files in place: merging symbols into a library without
 * duplicates, adding a library to a lib table, and install_parts writing a
 * project's own heypcb libraries — idempotent, every other byte kept.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { Auth } from "../src/auth.ts";
import { CredentialStore } from "../src/credentials.ts";
import { ignoreMatcher } from "../src/kicad-files.ts";
import { installParts } from "../src/library.ts";
import { ensureTableLib, fileVersion, mergeSymbols, parseSpans, tableLibs } from "../src/sexpr.ts";
import { startFakeHeypcb } from "./fake-heypcb.ts";
import { configFor, TEST_KEY, tmpDir } from "./helpers.ts";

const closers: Array<() => Promise<void>> = [];
after(async () => {
  for (const c of closers) await c();
});

const LIB = `(kicad_symbol_lib
\t(version 20231120)
\t(generator "kicad_symbol_editor")
\t(symbol "R" (pin_names (offset 0)) (property "Reference" "R" (at 0 0 0)))
)
`;

test("parseSpans gives the offsets of every node and atom", () => {
  const text = '(a "b c" (d 1))';
  const root = parseSpans(text);
  assert.equal(text.slice(root.start, root.end), text);
  const inner = root.items[2] as { start: number; end: number };
  assert.equal(text.slice(inner.start, inner.end), "(d 1)");
  assert.deepEqual(root.items[1], { start: 3, end: 8, value: "b c", quoted: true });
});

test("mergeSymbols appends a new symbol, replaces a changed one, and never duplicates a name", () => {
  const a = mergeSymbols(LIB, [{ name: "C", text: '(symbol "C" (property "Reference" "C" (at 0 0 0)))' }]);
  assert.deepEqual(a.added, ["C"]);
  assert.ok(a.text.startsWith(LIB.slice(0, LIB.lastIndexOf(")"))), "every byte before the new symbol is kept");
  assert.match(a.text, /\n\t\(symbol "C"/, "indented like its siblings");

  const again = mergeSymbols(a.text, [{ name: "C", text: '(symbol "C" (property "Reference" "C" (at 0 0 0)))' }]);
  assert.deepEqual(again.unchanged, ["C"]);
  assert.equal(again.text, a.text);

  const changed = mergeSymbols(a.text, [{ name: "R", text: '(symbol "R" (property "Reference" "RR" (at 0 0 0)))' }]);
  assert.deepEqual(changed.updated, ["R"]);
  assert.equal((changed.text.match(/\(symbol "R"/g) ?? []).length, 1);
  assert.match(changed.text, /"RR"/);
  assert.match(changed.text, /\(symbol "C"/);
});

test("ensureTableLib adds a library once, keeps the others, and leaves a different library of that name alone", () => {
  const table = '(fp_lib_table\n  (version 7)\n  (lib (name "mine")(type "KiCad")(uri "${KIPRJMOD}/mine.pretty")(options "")(descr ""))\n)\n';
  const lib = { name: "heypcb", uri: "${KIPRJMOD}/heypcb.pretty", descr: "HeyPCB parts" };
  const r = ensureTableLib(table, "fp_lib_table", lib);
  assert.equal(r.status, "added");
  assert.deepEqual(
    tableLibs(r.text).map((l) => [l.name, l.uri]),
    [
      ["mine", "${KIPRJMOD}/mine.pretty"],
      ["heypcb", "${KIPRJMOD}/heypcb.pretty"],
    ]
  );
  assert.equal(ensureTableLib(r.text, "fp_lib_table", lib).status, "present");
  assert.equal(ensureTableLib(r.text, "fp_lib_table", { ...lib, uri: "/elsewhere" }).status, "name_taken");
  const fresh = ensureTableLib(null, "sym_lib_table", { name: "heypcb", uri: "${KIPRJMOD}/heypcb.kicad_sym", descr: "x" });
  assert.equal(tableLibs(fresh.text).length, 1);
  assert.throws(() => ensureTableLib(table, "sym_lib_table", lib), /not a sym_lib_table/);
});

test("fileVersion reads a KiCad file's format version", () => {
  assert.equal(fileVersion("(kicad_pcb\n  (version 20240108)\n  (generator pcbnew))"), 20240108);
  assert.equal(fileVersion('(kicad_sch (version 20231120) (generator "eeschema"))'), 20231120);
  assert.equal(fileVersion("(nothing)"), null);
});

test(".heypcbignore patterns: folders, globs, anchored and not", () => {
  const m = ignoreMatcher("# comment\nsecret/\n*.kicad_dru\n/libs/private.kicad_sym\n**/draft-*.kicad_sch\n");
  assert.ok(m("secret/a.kicad_sch"));
  assert.ok(m("deep/secret/a.kicad_sch"));
  assert.ok(m("board.kicad_dru"));
  assert.ok(m("libs/private.kicad_sym"));
  assert.ok(!m("x/libs/private.kicad_sym"));
  assert.ok(m("sheets/draft-1.kicad_sch"));
  assert.ok(m("draft-1.kicad_sch"));
  assert.ok(!m("board.kicad_pcb"));
  assert.ok(!m("secretive.kicad_sch"));
});

async function ctx() {
  const fake = await startFakeHeypcb({ acceptTokens: new Set([TEST_KEY]) });
  closers.push(fake.close);
  const config = configFor(fake.mcpUrl, { HEYPCB_API_KEY: TEST_KEY });
  const dir = tmpDir();
  return { fake, ctx: { config, auth: new Auth(config, new CredentialStore(path.join(dir, "c.json"))) }, root: dir };
}

test("install_parts writes heypcb libraries and lib-table entries, and a second run changes nothing", async () => {
  const { ctx: c, root } = await ctx();
  await fsp.writeFile(path.join(root, "sym-lib-table"), '(sym_lib_table\n  (version 7)\n  (lib (name "Device")(type "KiCad")(uri "${KICAD9_SYMBOL_DIR}/Device.kicad_sym")(options "")(descr ""))\n)\n');
  const r = await installParts(c, root, ["C2040", "C1525", "C404"]);
  assert.deepEqual(r.installed.map((i) => i.part), ["C2040", "C1525"]);
  assert.deepEqual(r.failed.map((f) => [f.part, f.code]), [["C404", "part_not_found"]]);
  assert.deepEqual(r.symbols.added, ["RP2040", "C_100nF"]);
  assert.deepEqual(r.tables, { "sym-lib-table": "added", "fp-lib-table": "added" });

  const sym = await fsp.readFile(path.join(root, "heypcb.kicad_sym"), "utf8");
  assert.match(sym, /\(property "Footprint" "heypcb:QFN-56_7x7mm"/, "the symbol points at the installed footprint");
  assert.match(sym, /\(version 20241209\)/, "the library is at least as new as what went into it");
  const fp = await fsp.readFile(path.join(root, "heypcb.pretty", "QFN-56_7x7mm.kicad_mod"), "utf8");
  assert.match(fp, /^\(footprint "QFN-56_7x7mm"/, "named as its file");
  assert.match(fp, /\(model "\$\{KIPRJMOD\}\/heypcb\.3dshapes\/QFN-56_7x7mm\.step"/);
  assert.equal(await fsp.readFile(path.join(root, "heypcb.3dshapes", "QFN-56_7x7mm.step"), "utf8"), "ISO-10303-21; fake step");
  const symTable = await fsp.readFile(path.join(root, "sym-lib-table"), "utf8");
  assert.deepEqual(
    tableLibs(symTable).map((l) => l.name),
    ["Device", "heypcb"]
  );

  const snapshot = async () => Promise.all(["heypcb.kicad_sym", "sym-lib-table", "fp-lib-table", "heypcb.pretty/C_0402.kicad_mod"].map((f) => fsp.readFile(path.join(root, f), "utf8")));
  const before = await snapshot();
  const again = await installParts(c, root, ["C2040", "C1525"]);
  assert.deepEqual(again.symbols.unchanged, ["RP2040", "C_100nF"]);
  assert.deepEqual(again.written, []);
  assert.deepEqual(await snapshot(), before);
});
