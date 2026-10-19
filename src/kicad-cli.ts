/**
 * The free local tools: KiCad's own `kicad-cli` run on the project here, no
 * network. `check_local` is a fast pre-check (KiCad's DRC or ERC), not
 * HeyPCB's verification — `check_board` stays the full check.
 * `export_local` writes Gerbers (+ drill), BOM, pick-and-place or STEP.
 *
 * kicad-cli is looked for on PATH, then where KiCad installs it. KiCad 8 is
 * the oldest supported (it added `--format json` to DRC/ERC, `sch export
 * bom` and stored plot settings for `export gerbers`); a file KiCad 8 did
 * not write yet (older format) is refused before anything runs.
 */
import { execFile } from "node:child_process";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { refusal, RefusalError } from "./refusal.ts";
import { fileVersion } from "./sexpr.ts";

export const MIN_KICAD_MAJOR = 8;
/** The first file format versions KiCad 8 wrote. */
export const MIN_FILE_VERSION = { kicad_pcb: 20240108, kicad_sch: 20231120 } as const;

const INSTALL_FIX =
  "Install KiCad 8 or newer from https://www.kicad.org/download/ (kicad-cli comes with it), or put kicad-cli on PATH; then call the tool again. check_board (on HeyPCB) works without it.";

export type KicadCli = { bin: string; version: string; major: number };

async function isFile(p: string): Promise<boolean> {
  try {
    return (await fsp.stat(p)).isFile();
  } catch {
    return false;
  }
}

/** Where kicad-cli may be, best first. */
export async function cliCandidates(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): Promise<string[]> {
  const exe = platform === "win32" ? "kicad-cli.exe" : "kicad-cli";
  const out = (env.PATH ?? env.Path ?? "")
    .split(path.delimiter)
    .filter(Boolean)
    .map((d) => path.join(d, exe));
  if (platform === "darwin") {
    out.push("/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli", path.join(os.homedir(), "Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli"));
  } else if (platform === "win32") {
    for (const base of [env.ProgramFiles ?? "C:\\Program Files", env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, "Programs") : ""].filter(Boolean)) {
      const kicad = path.join(base, "KiCad");
      // Newest version folder first (C:\Program Files\KiCad\9.0\bin).
      const versions = (await fsp.readdir(kicad).catch(() => [] as string[])).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
      for (const v of versions) out.push(path.join(kicad, v, "bin", exe));
    }
  } else {
    out.push("/usr/bin/kicad-cli", "/usr/local/bin/kicad-cli", "/snap/bin/kicad.kicad-cli");
  }
  return [...new Set(out)];
}

export type RunResult = { code: number; stdout: string; stderr: string };

export function run(bin: string, args: string[], opts: { signal?: AbortSignal; timeoutMs?: number; cwd?: string } = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { signal: opts.signal, timeout: opts.timeoutMs ?? 300_000, cwd: opts.cwd, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code as number) : -1) : 0;
      if (err && code === -1) return reject(err);
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

let cached: Promise<KicadCli> | null = null;

/** The kicad-cli to use and its version. Throws RefusalError when there is none, or only one older than KiCad 8. */
export function findKicadCli(): Promise<KicadCli> {
  cached ??= locate().catch((err) => {
    cached = null; // installed meanwhile? look again next time
    throw err;
  });
  return cached;
}

async function locate(): Promise<KicadCli> {
  let tooOld: KicadCli | null = null;
  for (const bin of await cliCandidates()) {
    if (!(await isFile(bin))) continue;
    let r: RunResult;
    try {
      r = await run(bin, ["version"], { timeoutMs: 30_000 });
    } catch {
      continue;
    }
    const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(r.stdout);
    if (r.code !== 0 || !m) continue;
    const cli = { bin, version: m[0], major: Number(m[1]) };
    if (cli.major >= MIN_KICAD_MAJOR) return cli;
    tooOld ??= cli;
  }
  if (tooOld) {
    throw new RefusalError(refusal("kicad_too_old", `The kicad-cli here is KiCad ${tooOld.version} (${tooOld.bin}); the local tools need KiCad ${MIN_KICAD_MAJOR} or newer.`, INSTALL_FIX, { kicad: tooOld.version }));
  }
  throw new RefusalError(refusal("kicad_cli_missing", "kicad-cli (KiCad's command line) was not found on this computer.", INSTALL_FIX));
}

/** Refuse a board or schematic in a format older than KiCad 8 before running anything on it. */
export async function checkFileVersion(file: string): Promise<number | null> {
  const ext = path.extname(file).slice(1) as keyof typeof MIN_FILE_VERSION;
  const min = MIN_FILE_VERSION[ext];
  const head = await fsp.readFile(file, "utf8").then((t) => t.slice(0, 4096));
  const v = fileVersion(head);
  if (min && v !== null && v < min) {
    throw new RefusalError(
      refusal("kicad_file_too_old", `${path.basename(file)} is in an older KiCad format (version ${v}); the local tools read KiCad 8 files and newer.`, `Open the project in KiCad 8 or newer and save it (that upgrades the file), then call the tool again.`, {
        file: path.basename(file),
        version: v,
      })
    );
  }
  return v;
}

function failed(what: string, r: RunResult, cli: KicadCli): RefusalError {
  const said = (r.stderr || r.stdout).trim().split("\n").slice(-6).join("\n");
  const newer = /newer|future|unsupported/i.test(said);
  return new RefusalError(
    refusal(
      newer ? "kicad_file_too_new" : "kicad_cli_failed",
      newer ? `KiCad ${cli.version} here cannot read this project: it was saved by a newer KiCad.` : `kicad-cli could not ${what} (exit ${r.code}).`,
      newer ? "Install the KiCad version the project was saved with (or newer), then call the tool again." : "Open the project in KiCad to see the problem, fix it, then call the tool again.",
      { kicad: cli.version, output: said.slice(0, 2000) }
    )
  );
}

export type Finding = { severity: string; type: string; message: string; where: Array<{ text: string; x?: number; y?: number; sheet?: string }> };
export type CheckReport = {
  kind: "drc" | "erc";
  source: "kicad-cli";
  kicad: string;
  file: string;
  passed: boolean;
  counts: { errors: number; warnings: number; unconnected?: number; parity?: number };
  findings: Finding[];
  truncated: number;
};

const MAX_FINDINGS = 100;

type RawItem = { description?: unknown; pos?: { x?: unknown; y?: unknown } };
type RawViolation = { description?: unknown; type?: unknown; severity?: unknown; items?: unknown };

function finding(v: RawViolation, sheet?: string): Finding {
  const items = Array.isArray(v.items) ? (v.items as RawItem[]) : [];
  return {
    severity: String(v.severity ?? "error"),
    type: String(v.type ?? "unknown"),
    message: String(v.description ?? ""),
    where: items.map((i) => ({
      text: String(i.description ?? ""),
      ...(typeof i.pos?.x === "number" ? { x: i.pos.x } : {}),
      ...(typeof i.pos?.y === "number" ? { y: i.pos.y } : {}),
      ...(sheet ? { sheet } : {}),
    })),
  };
}

/** KiCad's DRC / ERC JSON report as findings, errors first. */
export function readReport(kind: "drc" | "erc", json: unknown, file: string, kicad: string): CheckReport {
  const j = (json ?? {}) as { violations?: unknown; unconnected_items?: unknown; schematic_parity?: unknown; sheets?: unknown };
  const all: Finding[] = [];
  const counts: CheckReport["counts"] = { errors: 0, warnings: 0 };
  if (kind === "drc") {
    const v = Array.isArray(j.violations) ? (j.violations as RawViolation[]) : [];
    const u = Array.isArray(j.unconnected_items) ? (j.unconnected_items as RawViolation[]) : [];
    const p = Array.isArray(j.schematic_parity) ? (j.schematic_parity as RawViolation[]) : [];
    all.push(...v.map((x) => finding(x)), ...u.map((x) => finding(x)), ...p.map((x) => finding(x)));
    counts.unconnected = u.length;
    counts.parity = p.length;
  } else {
    for (const s of Array.isArray(j.sheets) ? (j.sheets as Array<{ path?: unknown; violations?: unknown }>) : []) {
      for (const x of Array.isArray(s.violations) ? (s.violations as RawViolation[]) : []) all.push(finding(x, String(s.path ?? "/")));
    }
  }
  for (const f of all) {
    if (f.severity === "error") counts.errors++;
    else if (f.severity === "warning") counts.warnings++;
  }
  const rank = (s: string) => (s === "error" ? 0 : s === "warning" ? 1 : 2);
  all.sort((a, b) => rank(a.severity) - rank(b.severity));
  return { kind, source: "kicad-cli", kicad, file, passed: counts.errors === 0, counts, findings: all.slice(0, MAX_FINDINGS), truncated: Math.max(0, all.length - MAX_FINDINGS) };
}

async function tmpDir(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), "heypcb-kicad-"));
}

export async function runCheck(kind: "drc" | "erc", file: string, signal?: AbortSignal): Promise<CheckReport> {
  const cli = await findKicadCli();
  await checkFileVersion(file);
  const dir = await tmpDir();
  try {
    const out = path.join(dir, `${kind}.json`);
    const args = kind === "drc" ? ["pcb", "drc", "--format", "json", "--severity-all", "--units", "mm", "-o", out, file] : ["sch", "erc", "--format", "json", "--severity-all", "--units", "mm", "-o", out, file];
    const r = await run(cli.bin, args, { signal, cwd: path.dirname(file) });
    const text = await fsp.readFile(out, "utf8").catch(() => null);
    if (text === null) throw failed(kind === "drc" ? "run DRC on the board" : "run ERC on the schematic", r, cli);
    return readReport(kind, JSON.parse(text), path.basename(file), cli.version);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

export const LOCAL_EXPORT_KINDS = ["gerbers", "bom", "cpl", "step"] as const;
export type LocalExportKind = (typeof LOCAL_EXPORT_KINDS)[number];

/**
 * Run one export into a fresh temp folder; returns the files made (for
 * gerbers: every Gerber and drill file, for the caller to zip). The caller
 * removes `dir`.
 */
export async function runExport(kind: LocalExportKind, files: { board: string | null; schematic: string | null }, signal?: AbortSignal): Promise<{ dir: string; files: string[]; kicad: string }> {
  const cli = await findKicadCli();
  const input = kind === "bom" ? files.schematic : files.board;
  if (!input) {
    throw new RefusalError(
      refusal("nothing_to_export", kind === "bom" ? "This project has no schematic (.kicad_sch) to make a BOM from." : "This project has no board (.kicad_pcb) yet.", kind === "bom" ? "Draw the schematic first." : "Make the board first (in KiCad, or update the PCB from the schematic).")
    );
  }
  await checkFileVersion(input);
  const dir = await tmpDir();
  const steps: string[][] =
    kind === "gerbers"
      ? [
          ["pcb", "export", "gerbers", "--board-plot-params", "-o", dir + path.sep, input],
          ["pcb", "export", "drill", "-o", dir + path.sep, input],
        ]
      : kind === "bom"
        ? [["sch", "export", "bom", "-o", path.join(dir, "bom.csv"), input]]
        : kind === "cpl"
          ? [["pcb", "export", "pos", "--format", "csv", "--units", "mm", "--side", "both", "-o", path.join(dir, "cpl.csv"), input]]
          : [["pcb", "export", "step", "--subst-models", "-o", path.join(dir, "board.step"), input]];
  try {
    for (const args of steps) {
      const r = await run(cli.bin, args, { signal, cwd: path.dirname(input), timeoutMs: 600_000 });
      if (r.code !== 0) throw failed(`export ${kind}`, r, cli);
    }
    const made = (await fsp.readdir(dir)).sort();
    if (!made.length) throw failed(`export ${kind}`, { code: 0, stdout: "", stderr: "kicad-cli wrote no file" }, cli);
    return { dir, files: made, kicad: cli.version };
  } catch (err) {
    await fsp.rm(dir, { recursive: true, force: true });
    throw err;
  }
}
