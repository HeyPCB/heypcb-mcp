/**
 * The stored sign-in: `credentials.json`, mode 0600, in
 *   - `%APPDATA%\heypcb\` on Windows,
 *   - `$XDG_CONFIG_HOME/heypcb/` (default `~/.config/heypcb/`) elsewhere,
 *   - `$HEYPCB_CONFIG_DIR/` when that is set.
 *
 * One file, one entry per API host (`accounts["https://api.heypcb.ai"]`), so
 * a dev server's sign-in is never sent to production or the other way round.
 *
 * Every write is atomic (a 0600 temp file in the same folder, fsync, rename),
 * and every change that ROTATES a token is made under `credentials.json.lock`:
 * several agents on one computer each run their own `@heypcb/mcp`, and a
 * refresh token is rotated on every use — two processes rotating the same one
 * would look like a stolen token to the server (a spent refresh token
 * presented again ends the whole sign-in) and sign both out. Under the lock a
 * process re-reads the file first and adopts a rotation another process
 * already made.
 */
import { promises as fsp } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomBytes } from "node:crypto";
import { refusal, RefusalError } from "./refusal.ts";

export type StoredAccount = {
  clientId: string;
  refreshToken: string;
  accessToken: string | null;
  /** ISO time the access token stops working. */
  accessTokenExpiresAt: string | null;
  scope: string;
  signedInAt: string;
  email?: string | null;
};

export type CredentialsFile = { version: 1; accounts: Record<string, StoredAccount> };

export function configDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home: string = os.homedir()): string {
  if (env.HEYPCB_CONFIG_DIR && env.HEYPCB_CONFIG_DIR.trim()) return path.resolve(env.HEYPCB_CONFIG_DIR.trim());
  if (platform === "win32") {
    const appData = (env.APPDATA || "").trim();
    return path.join(appData || path.join(home, "AppData", "Roaming"), "heypcb");
  }
  const xdg = (env.XDG_CONFIG_HOME || "").trim();
  // The XDG spec ignores a relative XDG_CONFIG_HOME.
  return path.join(xdg && path.isAbsolute(xdg) ? xdg : path.join(home, ".config"), "heypcb");
}

export function credentialsPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(configDir(env), "credentials.json");
}

const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 20_000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function isAccount(v: unknown): v is StoredAccount {
  if (!v || typeof v !== "object") return false;
  const a = v as Record<string, unknown>;
  return typeof a.refreshToken === "string" && a.refreshToken.length > 0 && typeof a.clientId === "string";
}

export class CredentialStore {
  readonly file: string;
  constructor(file: string) {
    this.file = file;
  }

  get dir(): string {
    return path.dirname(this.file);
  }

  /** The whole file; an absent or unreadable file is an empty one (never thrown). */
  async read(): Promise<CredentialsFile> {
    let text: string;
    try {
      text = await fsp.readFile(this.file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, accounts: {} };
      throw new RefusalError(
        refusal("credentials_unreadable", `HeyPCB could not read its sign-in file ${this.file} (${(err as Error).message}).`, "Check the file's permissions, or delete it and run `npx @heypcb/mcp login` again.")
      );
    }
    await this.tightenMode();
    try {
      const parsed = JSON.parse(text) as Partial<CredentialsFile>;
      const accounts: Record<string, StoredAccount> = {};
      for (const [base, acc] of Object.entries(parsed.accounts ?? {})) if (isAccount(acc)) accounts[base] = acc;
      return { version: 1, accounts };
    } catch {
      process.stderr.write(`[heypcb-mcp] ${this.file} is not valid JSON; treating it as signed out.\n`);
      return { version: 1, accounts: {} };
    }
  }

  async account(base: string): Promise<StoredAccount | null> {
    return (await this.read()).accounts[base] ?? null;
  }

  /** Write `accounts[base]` (or remove it with `null`). Call under `withLock` when rotating. */
  async put(base: string, account: StoredAccount | null): Promise<void> {
    const cur = await this.read();
    if (account) cur.accounts[base] = account;
    else delete cur.accounts[base];
    if (Object.keys(cur.accounts).length === 0) {
      await fsp.rm(this.file, { force: true });
      return;
    }
    await this.writeAtomic(JSON.stringify(cur, null, 2) + "\n");
  }

  private async writeAtomic(text: string): Promise<void> {
    await fsp.mkdir(this.dir, { recursive: true, mode: 0o700 });
    const tmp = path.join(this.dir, `.credentials.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
    const fh = await fsp.open(tmp, "wx", 0o600);
    try {
      await fh.writeFile(text, "utf8");
      await fh.sync();
    } finally {
      await fh.close();
    }
    try {
      if (process.platform !== "win32") await fsp.chmod(tmp, 0o600);
      await fsp.rename(tmp, this.file);
    } catch (err) {
      await fsp.rm(tmp, { force: true });
      throw err;
    }
  }

  /** A file someone loosened is put back to 0600 (POSIX only). */
  private async tightenMode(): Promise<void> {
    if (process.platform === "win32") return;
    try {
      const st = await fsp.stat(this.file);
      if ((st.mode & 0o077) !== 0) {
        await fsp.chmod(this.file, 0o600);
        process.stderr.write(`[heypcb-mcp] ${this.file} was readable by other users; set it back to 0600.\n`);
      }
    } catch {
      /* gone meanwhile */
    }
  }

  /** Run `fn` holding `credentials.json.lock` (one process at a time on this computer). */
  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    await fsp.mkdir(this.dir, { recursive: true, mode: 0o700 });
    const lock = this.file + ".lock";
    const started = Date.now();
    for (;;) {
      try {
        const fh = await fsp.open(lock, "wx", 0o600);
        await fh.writeFile(`${process.pid} ${new Date().toISOString()}\n`);
        await fh.close();
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        try {
          const st = await fsp.stat(lock);
          if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
            await fsp.rm(lock, { force: true });
            continue;
          }
        } catch {
          continue; // released meanwhile
        }
        if (Date.now() - started > LOCK_WAIT_MS) {
          throw new RefusalError(
            refusal("credentials_busy", "Another HeyPCB process on this computer is holding the sign-in file.", "Call the tool again in a few seconds.", { retryable: true })
          );
        }
        await sleep(50 + Math.floor(Math.random() * 100));
      }
    }
    try {
      return await fn();
    } finally {
      await fsp.rm(lock, { force: true });
    }
  }
}
