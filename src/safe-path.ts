/**
 * Where `save_export` may write, judged on where the bytes would really land
 * (the real path, every link resolved), never on how the path is spelled:
 *
 * - inside your home folder: allowed; missing folders are created;
 * - outside it: only into a folder that already exists and is writable;
 * - a path spelled inside your home folder whose links lead outside it is
 *   refused (`symlink_escape`): no link is followed into another place;
 * - a few folders that hold secrets (~/.ssh, ~/.gnupg, ~/.aws, …, and this
 *   package's own sign-in folder) are refused wherever they are reached from.
 *
 * The file itself is written atomically: a fresh temp file created with
 * O_EXCL in the target folder (it can never follow a planted link), then
 * renamed over the final name — a rename replaces a link at that name rather
 * than writing through it.
 */
import { constants as FS, promises as fsp } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomBytes } from "node:crypto";
import { refusal, RefusalError } from "./refusal.ts";
import { expandHome } from "./kicad-files.ts";

const SECRET_DIRS = [".ssh", ".gnupg", ".aws", ".azure", ".kube", ".docker", ".config/gcloud", ".config/heypcb", "Library/Keychains", "AppData/Roaming/heypcb"];

function inside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel));
}

function tilde(p: string, home: string): string {
  return inside(p, home) ? "~" + p.slice(home.length) : p;
}

async function realOrNull(p: string): Promise<string | null> {
  try {
    return await fsp.realpath(p);
  } catch {
    return null;
  }
}

/**
 * The real folder to write into, created if it is missing and inside home.
 * Throws RefusalError with a fix the agent can act on.
 */
export async function resolveTargetDir(input: unknown, opts: { home?: string; cwd?: string; extraSecretDirs?: string[]; protectedDirs?: string[] } = {}): Promise<string> {
  const home = path.resolve(opts.home ?? os.homedir());
  if (typeof input !== "string" || !input.trim()) {
    throw new RefusalError(refusal("bad_dir", "`dir` is empty.", "Pass the folder to save into as `dir` (an absolute path, or ~/…)."));
  }
  const abs = path.resolve(opts.cwd ?? process.cwd(), expandHome(input.trim(), home));
  const realHome = (await realOrNull(home)) ?? home;

  // The nearest folder that exists, and what is still to be made under it.
  let existing = abs;
  const rest: string[] = [];
  for (;;) {
    try {
      await fsp.lstat(existing);
      break;
    } catch {
      const parent = path.dirname(existing);
      if (parent === existing) break;
      rest.unshift(path.basename(existing));
      existing = parent;
    }
  }
  const realExisting = await realOrNull(existing);
  if (!realExisting) {
    throw new RefusalError(refusal("bad_dir", `${tilde(abs, home)} cannot be reached (a broken link on the way).`, "Pass a folder that exists, or one inside your home folder."));
  }
  if (rest.some((p) => p === "." || p === "..")) throw new RefusalError(refusal("bad_dir", `${input} is not a plain folder path.`, "Pass an absolute folder path."));
  const real = path.join(realExisting, ...rest);
  const lexicallyHome = inside(abs, home) || inside(abs, realHome);
  const reallyHome = inside(real, realHome);

  for (const s of [...SECRET_DIRS, ...(opts.extraSecretDirs ?? [])]) {
    const secret = path.join(realHome, ...s.split("/"));
    if (inside(real, secret)) {
      throw new RefusalError(refusal("protected_dir", `HeyPCB does not write into ${tilde(secret, realHome)}: it holds keys or sign-ins.`, "Choose another folder for `dir`, such as ~/Downloads or the project's own folder."));
    }
  }
  for (const p of opts.protectedDirs ?? []) {
    const realP = (await realOrNull(p)) ?? path.resolve(p);
    if (inside(real, realP)) {
      throw new RefusalError(refusal("protected_dir", `HeyPCB does not write into ${tilde(realP, realHome)}: it holds this computer's HeyPCB sign-in.`, "Choose another folder for `dir`, such as ~/Downloads or the project's own folder."));
    }
  }
  if (lexicallyHome && !reallyHome) {
    throw new RefusalError(
      refusal("symlink_escape", `${tilde(abs, home)} is inside your home folder, but a link on the way leads to ${real}, outside it.`, "Pass the real folder you mean as `dir` (no links), or a folder inside your home folder.")
    );
  }
  if (!reallyHome) {
    if (rest.length) {
      throw new RefusalError(
        refusal("outside_home_missing", `${real} does not exist, and outside your home folder HeyPCB only writes into a folder that already exists.`, "Create the folder first, or pass a folder inside your home folder (it is created for you).")
      );
    }
    try {
      await fsp.access(real, FS.W_OK);
    } catch {
      throw new RefusalError(refusal("not_writable", `${real} is not writable by you.`, "Choose a folder you can write to, such as ~/Downloads."));
    }
  }
  if (!rest.length) {
    const st = await fsp.stat(real);
    if (!st.isDirectory()) throw new RefusalError(refusal("not_a_folder", `${tilde(real, realHome)} is a file, not a folder.`, "Pass a folder as `dir`; the file name comes from HeyPCB."));
    return real;
  }
  // Inside home: make what is missing, one level at a time, never through a link.
  let cur = realExisting;
  for (const part of rest) {
    cur = path.join(cur, part);
    try {
      await fsp.mkdir(cur, { mode: 0o755 });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    const st = await fsp.lstat(cur);
    if (!st.isDirectory()) {
      throw new RefusalError(refusal("symlink_escape", `${tilde(cur, realHome)} appeared as a link or a file while HeyPCB was making it.`, "Pass a plain folder as `dir`."));
    }
  }
  return cur;
}

/** A file name from a server, made safe: one name, no folders, no control characters. */
export function safeFileName(raw: string | null | undefined, fallback: string): string {
  let name = String(raw ?? "");
  name = name.split(/[\\/]/).pop() ?? "";
  name = name.replace(/[\p{Cc}\p{Cf}<>:"|?*]/gu, "").trim();
  name = name.replace(/^\.+/, "").replace(/[. ]+$/, "");
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(name)) name = "_" + name;
  if (!name) name = fallback;
  if (Buffer.byteLength(name) > 200) {
    const full = path.extname(name);
    const ext = Buffer.byteLength(full) <= 16 ? full : ""; // a 16+ byte "extension" is just more name
    name = clipBytes(name.slice(0, name.length - ext.length), 200 - Buffer.byteLength(ext)).replace(/[. ]+$/, "") + ext;
  }
  return name;
}

const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** The longest prefix of `s` that fits in `max` UTF-8 bytes, never splitting a character (é, 1️⃣, 👩‍💻). */
function clipBytes(s: string, max: number): string {
  let out = "";
  let bytes = 0;
  for (const { segment: ch } of GRAPHEMES.segment(s)) {
    bytes += Buffer.byteLength(ch);
    if (bytes > max) break;
    out += ch;
  }
  return out;
}

/** `name`, or `name-2.ext`, `name-3.ext`… — the first that does not exist in `dir`. */
export async function freeName(dir: string, name: string): Promise<string> {
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  for (let i = 1; i < 1000; i++) {
    const candidate = i === 1 ? name : `${base}-${i}${ext}`;
    try {
      await fsp.lstat(path.join(dir, candidate));
    } catch {
      return candidate;
    }
  }
  throw new RefusalError(refusal("too_many_copies", `${dir} already holds 999 copies of ${name}.`, "Pass `overwrite: true`, or another folder as `dir`."));
}

/**
 * Write a stream to `dir/name` atomically. Returns the final path and size.
 * The temp file is removed on any failure.
 */
export async function writeAtomic(dir: string, name: string, chunks: AsyncIterable<Uint8Array>): Promise<{ path: string; bytes: number }> {
  const finalPath = path.join(dir, name);
  try {
    const st = await fsp.lstat(finalPath);
    if (st.isDirectory()) throw new RefusalError(refusal("not_a_folder", `${finalPath} is a folder.`, "Pass another folder as `dir`, or remove that folder."));
  } catch (err) {
    if (err instanceof RefusalError) throw err;
  }
  const tmp = path.join(dir, `.${clipBytes(name, 60)}.${randomBytes(6).toString("hex")}.part`);
  const fh = await fsp.open(tmp, FS.O_WRONLY | FS.O_CREAT | FS.O_EXCL, 0o644);
  let bytes = 0;
  try {
    for await (const chunk of chunks) {
      await fh.write(chunk);
      bytes += chunk.length;
    }
    await fh.sync();
    await fh.close();
    await fsp.rename(tmp, finalPath);
  } catch (err) {
    await fh.close().catch(() => {});
    await fsp.rm(tmp, { force: true });
    throw err;
  }
  return { path: finalPath, bytes };
}

/**
 * Write `data` to `root/rel` atomically, making the folders on the way. Every
 * folder must really be inside `root` (no link leads out), and `rel` is a
 * plain relative POSIX path. For a project's own files and its .heypcb/ folder.
 */
export async function writeInside(root: string, rel: string, data: Uint8Array): Promise<string> {
  const parts = rel.split("/");
  if (!rel || path.isAbsolute(rel) || rel.includes("\\") || parts.some((p) => p === "" || p === "." || p === "..")) {
    throw new RefusalError(refusal("unsafe_path", `${rel} is not a plain path inside the project.`, "Nothing was written; report this to HeyPCB."));
  }
  const realRoot = await fsp.realpath(root);
  let dir = realRoot;
  for (const part of parts.slice(0, -1)) {
    dir = path.join(dir, part);
    try {
      await fsp.mkdir(dir, { mode: 0o755 });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    const real = await fsp.realpath(dir);
    if (!inside(real, realRoot)) {
      throw new RefusalError(refusal("symlink_escape", `${parts.slice(0, -1).join("/")} in the project folder is a link to ${real}, outside it.`, "Replace the link with a real folder, then call the tool again."));
    }
    dir = real;
  }
  const saved = await writeAtomic(dir, parts[parts.length - 1], (async function* () {
    yield data;
  })());
  return saved.path;
}

/** Existing workspace paths are never read or removed through symlinked parents. */
export async function pathInside(root: string, rel: string): Promise<string> {
  const parts = rel.split("/");
  if (!rel || path.isAbsolute(rel) || /^[A-Za-z]:/.test(rel) || /[\\\x00-\x1f\x7f]/.test(rel) || parts.some((p) => !p || p === "." || p === "..")) {
    throw new RefusalError(refusal("unsafe_path", "A workspace path is not project-relative.", "Nothing was changed; reopen a valid KiCad project."));
  }
  let cur = await fsp.realpath(root);
  for (const part of parts) {
    cur = path.join(cur, part);
    try {
      if ((await fsp.lstat(cur)).isSymbolicLink()) throw new RefusalError(refusal("symlink_escape", `${rel} passes through a symbolic link.`, "Replace the link with a file or folder inside the project."));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
  return cur;
}
