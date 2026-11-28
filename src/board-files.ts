/**
 * Boards from other design tools, which `upload_project` sends as they are:
 * HeyPCB's import converts each into a KiCad project on its server, as the
 * dashboard's import does. Nothing is converted here.
 *
 * - One board file goes up alone, byte for byte: an Altium board
 *   (`.PcbDoc`), an Eagle or KiCad 3 board (`.brd`), EasyEDA's PCB file
 *   (`.json`) or an EasyEDA Pro project (`.epro`, `.epro2`).
 * - An Altium project (its `.PrjPcb`, or the folder it is in) goes up
 *   zipped: the `.PrjPcb` and the boards (`.PcbDoc`) and sheets (`.SchDoc`)
 *   it lists, resolved against its folder. The import converts the board
 *   the project lists. It reads no Altium sheet (KiCad converts none), but
 *   counts them, to refuse a board with no parts whose design is still on
 *   its sheets rather than land it empty.
 *
 * A folder is searched for a KiCad project first, exactly as before
 * (kicad-files.ts `locateProject`); only a folder with none is searched for
 * these: the folder itself, then three levels down, past the folders Altium
 * fills with history, previews, logs and outputs. In a folder, EasyEDA's PCB
 * file counts only under the name EasyEDA exports it as (`PCB_*.json`), so
 * a settings file is never taken for a board.
 *
 * The KiCad rules hold here too, on the same walker: nothing outside the
 * folder (`unsafe_path`), at most 50 MB (`project_too_large`), and never a
 * backup or what `.heypcbignore` names.
 */
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expandHome, findFiles, locateProject, MAX_PROJECT_BYTES, several, tilde, tooLarge, Walker, type Collection, type NameTest } from "./kicad-files.ts";
import { refusal, RefusalError } from "./refusal.ts";

export type BoardFormat = "altium" | "eagle" | "easyeda";
/** What a path names: a KiCad project, or another tool's board file or Altium project (`file`). */
export type UploadTarget = { format: "kicad"; root: string; stem: string } | { format: BoardFormat; root: string; stem: string; file: string };
export type BoardCollection = Collection & { zip: boolean };

const BOARD_FILES: Array<[RegExp, BoardFormat]> = [
  [/\.pcbdoc$/, "altium"],
  [/\.brd$/, "eagle"],
  [/\.(?:json|epro2?)$/, "easyeda"],
];
const ALTIUM_PROJECT = /\.prjpcb$/;
/** What Altium keeps beside a project: its document history, previews, logs and outputs. */
const ALTIUM_DIRS = /^(history|__previews|project logs for .*|project outputs for .*)$/i;
/** Where a `.PrjPcb` lists its documents, relative to itself and with `\` separators. */
const DOCUMENT_PATH = /^\s*DocumentPath\s*=\s*(.+?)\s*$/gim;
const ALTIUM_DOCS: Record<string, string> = { ".pcbdoc": "board", ".schdoc": "schematic" };

const PATH_FIX =
  "Pass the project's folder, or its file: a KiCad .kicad_pro / .kicad_pcb / .kicad_sch, an Altium .PrjPcb or .PcbDoc, an Eagle .brd, or an EasyEDA .json / .epro.";

const formatOf = (lower: string): BoardFormat | null => BOARD_FILES.find(([re]) => re.test(lower))?.[1] ?? null;
const isProject: NameTest = (lower) => ALTIUM_PROJECT.test(lower);
const isFolderBoard: NameTest = (lower) => formatOf(lower) !== null && (!lower.endsWith(".json") || lower.startsWith("pcb_"));

function fileTarget(abs: string): UploadTarget {
  const name = path.basename(abs);
  const lower = name.toLowerCase();
  const stem = name.replace(/\.[^.]+$/, "");
  if (isProject(lower)) return { format: "altium", root: path.dirname(abs), stem, file: abs };
  const format = formatOf(lower);
  if (format) return { format, root: path.dirname(abs), stem, file: abs };
  if (lower.endsWith(".schdoc")) {
    throw new RefusalError(
      refusal(
        "unsupported_file_type",
        `${tilde(abs)} is an Altium schematic, and HeyPCB converts only Altium boards (.PcbDoc).`,
        "Pass the board's .PcbDoc, or the Altium project's folder or .PrjPcb. For a schematic with no board yet: open the project in KiCad 10 (File > Import Non-KiCad Project), save it, and upload that folder."
      )
    );
  }
  throw new RefusalError(refusal("unsupported_file_type", `${tilde(abs)} is not a project or board file HeyPCB imports.`, PATH_FIX));
}

/** What `input` names for an upload: the KiCad project `locateProject` finds, else another tool's board. */
export async function locateUpload(input: string, home: string = os.homedir()): Promise<UploadTarget> {
  if (typeof input !== "string" || !input.trim()) throw new RefusalError(refusal("bad_path", "`path` is empty.", PATH_FIX));
  try {
    return { format: "kicad", ...(await locateProject(input, home)) };
  } catch (err) {
    if (!(err instanceof RefusalError) || (err.refusal.code !== "not_kicad" && err.refusal.code !== "no_project")) throw err;
  }
  const abs = path.resolve(expandHome(input.trim(), home));
  const st = await fsp.stat(abs).catch(() => null);
  if (st?.isFile()) return fileTarget(abs);
  if (!st?.isDirectory()) throw new RefusalError(refusal("unsupported_file_type", `${tilde(abs)} is neither a folder nor a project or board file.`, PATH_FIX));
  for (const depth of [0, 3]) {
    const projects = await findFiles(abs, isProject, depth, ALTIUM_DIRS);
    if (projects.length === 1) return fileTarget(projects[0]);
    if (projects.length > 1) throw several(projects, abs, ".PrjPcb", "Call the tool again with `path` set to the .PrjPcb (or .PcbDoc) of the project you mean.");
    const boards = await findFiles(abs, isFolderBoard, depth, ALTIUM_DIRS);
    if (boards.length === 1) return fileTarget(boards[0]);
    if (boards.length > 1) throw several(boards, abs, "board", "Call the tool again with `path` set to the board file you mean.");
  }
  throw new RefusalError(
    refusal(
      "no_project",
      `HeyPCB found no project or board to upload in ${tilde(abs)}.`,
      "Pass the folder that holds the project's .kicad_pro or .PrjPcb, or the board file itself: .kicad_pcb, .PcbDoc, .brd, or EasyEDA's .json / .epro."
    )
  );
}

/** Every board and sheet a `.PrjPcb` lists; its libraries, output jobs and fabrication outputs stay here. */
async function addAltiumDocuments(w: Walker, prjpcb: string, data: Buffer): Promise<void> {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    text = data.toString("latin1"); // what older Altium writes
  }
  const base = path.dirname(prjpcb);
  for (const m of text.matchAll(DOCUMENT_PATH)) {
    const name = m[1].replace(/\\/g, "/");
    const kind = ALTIUM_DOCS[path.posix.extname(name).toLowerCase()];
    if (!kind) continue;
    const target = path.isAbsolute(name) || /^[A-Za-z]:\//.test(name) ? name : path.join(base, ...name.split("/"));
    await w.add(path.normalize(target), kind);
  }
}

/** The files a board or an Altium project sends; `zip` false for one board file, sent as it is. */
export async function collectBoard(t: Extract<UploadTarget, { file: string }>): Promise<BoardCollection> {
  const w = new Walker(t.root);
  await w.init();
  const zip = isProject(t.file.toLowerCase());
  const rel = await w.add(t.file, zip ? "project" : "board");
  if (rel && zip) await addAltiumDocuments(w, t.file, w.files.get(rel)!.data);
  const files = [...w.files.values()].sort((a, b) => (a.kind === "board" ? 0 : 1) - (b.kind === "board" ? 0 : 1) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (!files.some((f) => f.kind === "board")) {
    throw new RefusalError(
      zip
        ? refusal("no_board", `${tilde(t.file)} lists no Altium board (.PcbDoc) in its folder, and HeyPCB converts the board, not the sheets.`, "Add the board to the project in Altium and save it, or pass the board's .PcbDoc itself, then call the tool again.", { missing: w.missing })
        : refusal("no_board", `HeyPCB did not send ${tilde(t.file)}.`, "Pass the board file itself, not a backup or a link that leads nowhere, and not one .heypcbignore names.", { skipped: w.skipped })
    );
  }
  const total = files.reduce((n, f) => n + f.bytes, 0);
  if (total > MAX_PROJECT_BYTES) {
    throw tooLarge(
      total,
      [...files].sort((a, b) => b.bytes - a.bytes).slice(0, 3).map((f) => ({ path: f.path, bytes: f.bytes }))
    );
  }
  return { root: w.root, stem: t.stem, files, totalBytes: total, skipped: w.skipped, missing: w.missing, zip };
}
