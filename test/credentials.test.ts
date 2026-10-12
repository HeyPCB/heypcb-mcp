import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { configDir, CredentialStore, type StoredAccount } from "../src/credentials.ts";
import { tmpDir, sleep } from "./helpers.ts";

const acc = (rt: string): StoredAccount => ({
  clientId: "heypcb-mcp",
  refreshToken: rt,
  accessToken: null,
  accessTokenExpiresAt: null,
  scope: "account:read",
  signedInAt: "2026-10-11T00:00:00.000Z",
});

test("where the sign-in lives: XDG on Linux, ~/.config elsewhere, %APPDATA% on Windows, HEYPCB_CONFIG_DIR over all", () => {
  assert.equal(configDir({}, "linux", "/home/ada"), path.join("/home/ada", ".config", "heypcb"));
  assert.equal(configDir({}, "darwin", "/Users/ada"), path.join("/Users/ada", ".config", "heypcb"));
  assert.equal(configDir({ XDG_CONFIG_HOME: "/xdg" }, "linux", "/home/ada"), path.join("/xdg", "heypcb"));
  assert.equal(configDir({ XDG_CONFIG_HOME: "relative/xdg" }, "linux", "/home/ada"), path.join("/home/ada", ".config", "heypcb"), "a relative XDG_CONFIG_HOME is ignored");
  assert.equal(configDir({ APPDATA: "C:\\Users\\ada\\AppData\\Roaming" }, "win32", "C:\\Users\\ada"), path.join("C:\\Users\\ada\\AppData\\Roaming", "heypcb"));
  assert.equal(configDir({ HEYPCB_CONFIG_DIR: "/custom" }, "linux", "/home/ada"), path.resolve("/custom"));
});

test("the file is written 0600 in a 0700 folder, atomically, one entry per API host", async (t) => {
  if (process.platform === "win32") return t.skip("POSIX modes");
  const dir = path.join(tmpDir(), "heypcb");
  const store = new CredentialStore(path.join(dir, "credentials.json"));
  await store.put("https://api.heypcb.ai", acc("hpcb_rt_PROD"));
  await store.put("http://127.0.0.1:3000", acc("hpcb_rt_DEV"));
  assert.equal((await fsp.stat(store.file)).mode & 0o777, 0o600);
  assert.equal((await fsp.stat(dir)).mode & 0o777, 0o700);
  assert.equal((await store.account("https://api.heypcb.ai"))?.refreshToken, "hpcb_rt_PROD");
  assert.equal((await store.account("http://127.0.0.1:3000"))?.refreshToken, "hpcb_rt_DEV");
  assert.deepEqual((await fsp.readdir(dir)).sort(), ["credentials.json"], "no temp file is left behind");
  await store.put("http://127.0.0.1:3000", null);
  assert.equal(await store.account("http://127.0.0.1:3000"), null);
  assert.ok(await store.account("https://api.heypcb.ai"));
  await store.put("https://api.heypcb.ai", null);
  await assert.rejects(fsp.stat(store.file), "the last entry removed removes the file");
});

test("a file someone made readable by others is set back to 0600 when read", async (t) => {
  if (process.platform === "win32") return t.skip("POSIX modes");
  const store = new CredentialStore(path.join(tmpDir(), "credentials.json"));
  await store.put("https://api.heypcb.ai", acc("hpcb_rt_X"));
  await fsp.chmod(store.file, 0o644);
  const write = process.stderr.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try {
    await store.read();
  } finally {
    process.stderr.write = write;
  }
  assert.equal((await fsp.stat(store.file)).mode & 0o777, 0o600);
});

test("a missing or corrupt file reads as signed out, never as an error", async () => {
  const store = new CredentialStore(path.join(tmpDir(), "credentials.json"));
  assert.deepEqual(await store.read(), { version: 1, accounts: {} });
  await fsp.writeFile(store.file, "{not json", { mode: 0o600 });
  const write = process.stderr.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try {
    assert.deepEqual(await store.read(), { version: 1, accounts: {} });
  } finally {
    process.stderr.write = write;
  }
});

test("the lock lets one holder in at a time, and a stale lock is broken", async () => {
  const store = new CredentialStore(path.join(tmpDir(), "credentials.json"));
  const order: string[] = [];
  await Promise.all(
    ["a", "b", "c"].map((name) =>
      store.withLock(async () => {
        order.push(`${name}+`);
        await sleep(20);
        order.push(`${name}-`);
      })
    )
  );
  for (let i = 0; i < order.length; i += 2) assert.equal(order[i].slice(0, 1), order[i + 1].slice(0, 1), `no overlap: ${order.join(" ")}`);
  // A lock left by a process that died 31 s ago is not waited on.
  const lock = store.file + ".lock";
  await fsp.writeFile(lock, "999999");
  const old = new Date(Date.now() - 31_000);
  await fsp.utimes(lock, old, old);
  const t0 = Date.now();
  await store.withLock(async () => {});
  assert.ok(Date.now() - t0 < 2000);
});
