/**
 * `install_parts`: HeyPCB parts into a project's OWN libraries, so the
 * project opens — every symbol, footprint and 3D model resolved — on a
 * computer without HeyPCB or a network:
 *
 *   heypcb.kicad_sym   the symbols, merged by name (never duplicated)
 *   heypcb.pretty/     one .kicad_mod per footprint
 *   heypcb.3dshapes/   the STEP models the footprints point at
 *
 * and a `heypcb` entry in sym-lib-table and fp-lib-table with
 * `${KIPRJMOD}` paths. A symbol's Footprint property is pointed at
 * `heypcb:<footprint>`, a footprint's model at
 * `${KIPRJMOD}/heypcb.3dshapes/<file>`. Every other byte of the existing
 * files is kept (sexpr.ts edits in place).
 *
 * The server's part assets, as this client reads them:
 *   GET /v1/parts/{id}/assets → { ok, part: { id, lcsc? },
 *     symbol: { name, text },               // `(symbol "NAME" …)` or a whole `(kicad_symbol_lib …)`
 *     footprint: { name, text } | null,     // `(footprint "NAME" …)`
 *     model: { name, contentBase64 } | null }
 */
import { promises as fsp } from "node:fs";
import path from "node:path";
import { anySignal, networkRefusal, responseRefusal } from "./http.ts";
import { refusal, RefusalError, type Refusal } from "./refusal.ts";
import { writeInside } from "./safe-path.ts";
import { applySplices, atomAt, childrenNamed, ensureTableLib, fileVersion, headOf, mergeSymbols, parseSpans, quote, setProperty, type SpanNode } from "./sexpr.ts";
import type { ApiContext } from "./workspace.ts";

export const LIB = "heypcb";
export const SYM_FILE = `${LIB}.kicad_sym`;
export const FP_DIR = `${LIB}.pretty`;
export const MODEL_DIR = `${LIB}.3dshapes`;
/** KiCad 8's symbol library format: the oldest this package writes. */
const MIN_SYM_VERSION = 20231120;

type Assets = {
  id: string;
  symbols: Array<{ name: string; text: string }>;
  symbolVersion: number | null;
  footprint: { name: string; text: string } | null;
  model: { name: string; data: Buffer } | null;
};

export type Installed = { part: string; symbol: string | null; footprint: string | null; model: string | null };
export type InstallResult = {
  installed: Installed[];
  failed: Array<{ part: string; code: string; error: string }>;
  symbols: { added: string[]; updated: string[]; unchanged: string[] };
  footprints: { added: string[]; updated: string[]; unchanged: string[] };
  models: string[];
  tables: { "sym-lib-table": string; "fp-lib-table": string };
  written: string[];
};

/** A library item or file name: one plain name, no path, no characters KiCad or a file system chokes on. */
function plainName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.replace(/^heypcb:/, "").trim();
  return /^[^\\/:\0-\x1f"*?<>|]{1,120}$/.test(s) && !s.startsWith(".") ? s : null;
}

function bad(id: string, what: string): RefusalError {
  return new RefusalError(refusal("bad_part_assets", `HeyPCB's files for part ${id} are not usable: ${what}.`, "Leave that part out and install the rest; report the part to HeyPCB.", { part: id }));
}

/** Symbols out of a `(symbol …)` or a whole library's text, each with its name. */
function symbolsOf(id: string, text: string): Array<{ name: string; text: string }> {
  let root: SpanNode;
  try {
    root = parseSpans(text);
  } catch {
    throw bad(id, "the symbol does not parse");
  }
  const nodes = headOf(root) === "symbol" ? [root] : headOf(root) === "kicad_symbol_lib" ? childrenNamed(root, "symbol") : [];
  if (!nodes.length) throw bad(id, "no symbol in it");
  return nodes.map((n) => {
    const name = plainName(atomAt(n, 1)?.value);
    if (!name) throw bad(id, "a symbol has no usable name");
    return { name, text: text.slice(n.start, n.end) };
  });
}

export async function fetchAssets(ctx: ApiContext, id: string, signal?: AbortSignal): Promise<Assets> {
  let res: Response;
  try {
    res = await ctx.auth.fetch(`${ctx.config.apiBase}/v1/parts/${encodeURIComponent(id)}/assets`, { headers: { accept: "application/json" }, signal: signal ? anySignal(signal, 120_000) : AbortSignal.timeout(120_000) });
  } catch (err) {
    if (err instanceof RefusalError || signal?.aborted) throw err;
    throw new RefusalError(networkRefusal(err, `part ${id}'s files`));
  }
  if (!res.ok) throw new RefusalError(await responseRefusal(res, `part ${id}'s files`));
  const b = (await res.json().catch(() => null)) as {
    symbol?: { name?: unknown; text?: unknown };
    footprint?: { name?: unknown; text?: unknown } | null;
    model?: { name?: unknown; contentBase64?: unknown } | null;
  } | null;
  if (!b || typeof b.symbol?.text !== "string") throw bad(id, "no symbol");
  const symbols = symbolsOf(id, b.symbol.text);
  let footprint: Assets["footprint"] = null;
  if (b.footprint && typeof b.footprint.text === "string") {
    const name = plainName(b.footprint.name);
    if (!name) throw bad(id, "the footprint has no usable name");
    footprint = { name, text: b.footprint.text };
  }
  let model: Assets["model"] = null;
  if (b.model && typeof b.model.contentBase64 === "string") {
    const name = plainName(b.model.name);
    if (!name || !/\.(step|stp|wrl)$/i.test(name)) throw bad(id, "the 3D model has no usable file name");
    model = { name, data: Buffer.from(b.model.contentBase64, "base64") };
  }
  return { id, symbols, symbolVersion: fileVersion(b.symbol.text), footprint, model };
}

/** The footprint's text with its name and every model path pointed at this project's copies. */
function localFootprint(id: string, fp: { name: string; text: string }, model: string | null): string {
  let root: SpanNode;
  try {
    root = parseSpans(fp.text);
  } catch {
    throw bad(id, "the footprint does not parse");
  }
  const head = headOf(root);
  if (head !== "footprint" && head !== "module") throw bad(id, "the footprint is not a (footprint …)");
  const splices = [];
  const name = atomAt(root, 1);
  if (name) splices.push({ start: name.start, end: name.end, text: quote(fp.name) });
  if (model) {
    for (const m of childrenNamed(root, "model")) {
      const p = atomAt(m, 1);
      if (p) splices.push({ start: p.start, end: p.end, text: quote(`\${KIPRJMOD}/${MODEL_DIR}/${model}`) });
    }
  }
  return applySplices(fp.text, splices);
}

function withFootprint(text: string, footprint: string | null): string {
  if (!footprint) return text;
  return setProperty(text, parseSpans(text), "Footprint", `${LIB}:${footprint}`) ?? text;
}

async function readText(p: string): Promise<string | null> {
  return fsp.readFile(p, "utf8").catch(() => null);
}

/** The library's `(version N)` raised to at least `v`, in place. */
function atLeastVersion(text: string, v: number): string {
  const root = parseSpans(text);
  const ver = childrenNamed(root, "version")[0];
  const a = ver ? atomAt(ver, 1) : null;
  if (!a || Number(a.value) >= v) return text;
  return applySplices(text, [{ start: a.start, end: a.end, text: String(v) }]);
}

export async function installParts(ctx: ApiContext, root: string, parts: string[], signal?: AbortSignal): Promise<InstallResult> {
  const out: InstallResult = {
    installed: [],
    failed: [],
    symbols: { added: [], updated: [], unchanged: [] },
    footprints: { added: [], updated: [], unchanged: [] },
    models: [],
    tables: { "sym-lib-table": "present", "fp-lib-table": "present" },
    written: [],
  };
  const assets: Assets[] = [];
  for (const id of [...new Set(parts)]) {
    try {
      assets.push(await fetchAssets(ctx, id, signal));
    } catch (err) {
      if (!(err instanceof RefusalError)) throw err;
      const r: Refusal = err.refusal;
      // A sign-in problem is everyone's problem: stop rather than list it per part.
      if (["not_signed_in", "token_expired", "not_allowed"].includes(r.code)) throw err;
      out.failed.push({ part: id, code: r.code, error: r.error });
    }
  }
  if (!assets.length) return out;
  const write = async (rel: string, data: string | Buffer) => {
    await writeInside(root, rel, typeof data === "string" ? Buffer.from(data, "utf8") : data);
    out.written.push(rel);
  };

  // Footprints and models.
  for (const a of assets) {
    if (a.model) {
      const rel = `${MODEL_DIR}/${a.model.name}`;
      const cur = await fsp.readFile(path.join(root, MODEL_DIR, a.model.name)).catch(() => null);
      if (!cur || !cur.equals(a.model.data)) await write(rel, a.model.data);
      out.models.push(a.model.name);
    }
    if (a.footprint) {
      const text = localFootprint(a.id, a.footprint, a.model?.name ?? null);
      const rel = `${FP_DIR}/${a.footprint.name}.kicad_mod`;
      const cur = await readText(path.join(root, FP_DIR, `${a.footprint.name}.kicad_mod`));
      if (cur === text) out.footprints.unchanged.push(a.footprint.name);
      else {
        await write(rel, text);
        (cur === null ? out.footprints.added : out.footprints.updated).push(a.footprint.name);
      }
    }
  }

  // Symbols, merged into one library.
  const symFile = path.join(root, SYM_FILE);
  const version = Math.max(MIN_SYM_VERSION, ...assets.map((a) => a.symbolVersion ?? 0));
  let lib = (await readText(symFile)) ?? `(kicad_symbol_lib\n  (version ${version})\n  (generator "heypcb")\n  (generator_version "1.0")\n)\n`;
  const before = lib;
  try {
    lib = atLeastVersion(lib, version);
    const merged = mergeSymbols(lib, assets.flatMap((a) => a.symbols.map((s) => ({ name: s.name, text: withFootprint(s.text, a.footprint?.name ?? null) }))));
    lib = merged.text;
    out.symbols = { added: merged.added, updated: merged.updated, unchanged: merged.unchanged };
  } catch {
    throw new RefusalError(refusal("library_unreadable", `${SYM_FILE} in the project is not a KiCad symbol library this tool can merge into.`, `Rename or fix ${SYM_FILE}, then call install_parts again.`));
  }
  if (lib !== before) await write(SYM_FILE, lib);

  // The lib tables.
  for (const [file, table, uri, descr] of [
    ["sym-lib-table", "sym_lib_table", `\${KIPRJMOD}/${SYM_FILE}`, "HeyPCB parts (symbols)"],
    ["fp-lib-table", "fp_lib_table", `\${KIPRJMOD}/${FP_DIR}`, "HeyPCB parts (footprints)"],
  ] as const) {
    const cur = await readText(path.join(root, file));
    let r: ReturnType<typeof ensureTableLib>;
    try {
      r = ensureTableLib(cur, table, { name: LIB, uri, descr });
    } catch {
      throw new RefusalError(refusal("library_unreadable", `The project's ${file} does not parse.`, `Fix ${file} (KiCad's Preferences → Manage Libraries rewrites it), then call install_parts again.`));
    }
    out.tables[file] = r.status === "name_taken" ? `name_taken (a "${LIB}" library already points at ${r.uri})` : r.status;
    if (r.status === "added") await write(file, r.text);
  }

  for (const a of assets) {
    out.installed.push({ part: a.id, symbol: a.symbols[0] ? `${LIB}:${a.symbols[0].name}` : null, footprint: a.footprint ? `${LIB}:${a.footprint.name}` : null, model: a.model ? `${MODEL_DIR}/${a.model.name}` : null });
  }
  return out;
}
