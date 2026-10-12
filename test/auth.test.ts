/**
 * Sign-in: the device code against a fake token endpoint, the refresh's
 * single flight (inside one process and across two sharing one file), and
 * sign-out revoking before it forgets.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { Auth, deviceLogin, LoginError, logout } from "../src/auth.ts";
import { CredentialStore } from "../src/credentials.ts";
import { SCOPES } from "../src/config.ts";
import { RefusalError } from "../src/refusal.ts";
import { startFakeHeypcb } from "./fake-heypcb.ts";
import { configFor, tmpDir } from "./helpers.ts";

const closers: Array<() => Promise<void>> = [];
after(async () => {
  for (const c of closers) await c();
});

const ok = (access: string, refresh: string) => ({ status: 200, body: { access_token: access, refresh_token: refresh, token_type: "Bearer", expires_in: 3600, scope: SCOPES.join(" ") } });

async function fakeWith(opts: Parameters<typeof startFakeHeypcb>[0]) {
  const fake = await startFakeHeypcb(opts);
  closers.push(fake.close);
  return fake;
}

test("device code: asks as heypcb-mcp for every scope, polls at the interval, slows down when told, stores the sign-in 0600", async () => {
  const fake = await fakeWith({
    acceptTokens: new Set<string>(),
    tokenAnswers: [{ status: 400, body: { error: "authorization_pending" } }, { status: 400, body: { error: "slow_down" } }, ok("hpcb_at_DEVICEabcdefgh", "hpcb_rt_DEVICEabcdefgh")],
  });
  fake.opts.deviceCodeAnswer = {
    status: 200,
    body: { device_code: "hpcb_dc_x", user_code: "BCDF-GHJK", verification_uri: `${fake.url}/connect`, verification_uri_complete: `${fake.url}/connect?code=BCDF-GHJK`, expires_in: 900, interval: 5 },
  };
  const config = configFor(fake.mcpUrl);
  const store = new CredentialStore(path.join(tmpDir(), "heypcb", "credentials.json"));
  const sleeps: number[] = [];
  const opened: string[] = [];
  const lines: string[] = [];
  const out = await deviceLogin(config, store, {
    print: (l) => lines.push(l),
    openBrowser: (u) => (opened.push(u), true),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    deviceName: "Ada's laptop",
  });
  assert.equal(out.email, "ada@example.com");
  assert.deepEqual(sleeps, [5000, 5000, 10000], "interval, interval, interval + 5 s after slow_down");
  assert.deepEqual(opened, [`${fake.url}/connect?code=BCDF-GHJK`]);
  assert.ok(lines.some((l) => l.includes("BCDF-GHJK")), "the code is shown to compare");

  const start = new URLSearchParams(fake.requests.find((r) => r.path === "/oauth/device/code")!.body.toString());
  assert.equal(start.get("client_id"), "heypcb-mcp");
  assert.deepEqual(start.get("scope")!.split(" ").sort(), [...SCOPES].sort());
  assert.equal(start.get("device_name"), "Ada's laptop");
  const polls = fake.requests.filter((r) => r.path === "/oauth/token").map((r) => new URLSearchParams(r.body.toString()));
  assert.equal(polls.length, 3);
  for (const p of polls) {
    assert.equal(p.get("grant_type"), "urn:ietf:params:oauth:grant-type:device_code");
    assert.equal(p.get("device_code"), "hpcb_dc_x");
    assert.equal(p.get("client_id"), "heypcb-mcp");
  }
  const acc = await store.account(config.apiBase);
  assert.equal(acc?.refreshToken, "hpcb_rt_DEVICEabcdefgh");
  assert.equal(acc?.accessToken, "hpcb_at_DEVICEabcdefgh");
  assert.equal(acc?.clientId, "heypcb-mcp");
  assert.equal(acc?.email, "ada@example.com");
  if (process.platform !== "win32") {
    assert.equal((await fsp.stat(store.file)).mode & 0o777, 0o600, "credentials.json is 0600");
    assert.equal((await fsp.stat(store.dir)).mode & 0o777, 0o700, "its folder is 0700");
  }
});

test("device code: a page on another host is printed, never opened", async () => {
  const fake = await fakeWith({ tokenAnswers: [ok("hpcb_at_Aabcdefghijk", "hpcb_rt_Aabcdefghijk")] });
  fake.opts.deviceCodeAnswer = {
    status: 200,
    body: { device_code: "d", user_code: "BCDF-GHJK", verification_uri: "https://evil.example/connect", verification_uri_complete: "https://evil.example/connect?code=BCDF-GHJK", expires_in: 900, interval: 1 },
  };
  const opened: string[] = [];
  const lines: string[] = [];
  await deviceLogin(configFor(fake.mcpUrl), new CredentialStore(path.join(tmpDir(), "c.json")), {
    print: (l) => lines.push(l),
    openBrowser: (u) => (opened.push(u), true),
    sleep: async () => {},
  });
  assert.deepEqual(opened, []);
});

test("device code: denied and expired end with a sentence that says what to do", async () => {
  for (const [error, pattern] of [
    ["access_denied", /denied/],
    ["expired_token", /expired/],
  ] as const) {
    const fake = await fakeWith({ tokenAnswers: [{ status: 400, body: { error } }] });
    fake.opts.deviceCodeAnswer = { status: 200, body: { device_code: "d", user_code: "BCDF-GHJK", verification_uri: `${fake.url}/connect`, expires_in: 900, interval: 1 } };
    await assert.rejects(
      deviceLogin(configFor(fake.mcpUrl), new CredentialStore(path.join(tmpDir(), "c.json")), { print: () => {}, openBrowser: null, sleep: async () => {} }),
      (err: unknown) => err instanceof LoginError && pattern.test(err.message) && /npx @heypcb\/mcp login/.test(err.message)
    );
  }
});

test("device code: an unknown client is said plainly", async () => {
  const fake = await fakeWith({});
  fake.opts.deviceCodeAnswer = { status: 401, body: { error: "invalid_client", error_description: "This client is not registered with heypcb." } };
  await assert.rejects(
    deviceLogin(configFor(fake.mcpUrl), new CredentialStore(path.join(tmpDir(), "c.json")), { print: () => {}, openBrowser: null, sleep: async () => {} }),
    /not registered/
  );
});

async function storedAccount(dir: string, base: string, expiresInMs: number) {
  const store = new CredentialStore(path.join(dir, "credentials.json"));
  await store.put(base, {
    clientId: "heypcb-mcp",
    refreshToken: "hpcb_rt_ONEabcdefghijk",
    accessToken: "hpcb_at_ONEabcdefghijk",
    accessTokenExpiresAt: new Date(Date.now() + expiresInMs).toISOString(),
    scope: "account:read",
    signedInAt: new Date().toISOString(),
  });
  return store;
}

test("refresh is single-flight: three callers at once, one rotation", async () => {
  const fake = await fakeWith({ tokenAnswers: [ok("hpcb_at_TWOabcdefghijk", "hpcb_rt_TWOabcdefghijk")] });
  const config = configFor(fake.mcpUrl);
  const store = await storedAccount(tmpDir(), config.apiBase, -1000);
  const auth = new Auth(config, store);
  const got = await Promise.all([auth.bearer(), auth.bearer(), auth.renew("hpcb_at_ONEabcdefghijk")]);
  assert.deepEqual(got, ["hpcb_at_TWOabcdefghijk", "hpcb_at_TWOabcdefghijk", "hpcb_at_TWOabcdefghijk"]);
  assert.equal(fake.requests.filter((r) => r.path === "/oauth/token").length, 1);
});

test("refresh across processes: the second adopts the first's rotation instead of presenting a spent token", async () => {
  const fake = await fakeWith({ tokenAnswers: [ok("hpcb_at_TWOabcdefghijk", "hpcb_rt_TWOabcdefghijk"), { status: 400, body: { error: "invalid_grant" } }] });
  const config = configFor(fake.mcpUrl);
  const dir = tmpDir();
  await storedAccount(dir, config.apiBase, -1000);
  // Two Auth objects over two store objects on one file: two processes.
  const a = new Auth(config, new CredentialStore(path.join(dir, "credentials.json")));
  const b = new Auth(config, new CredentialStore(path.join(dir, "credentials.json")));
  const [ta, tb] = await Promise.all([a.renew("hpcb_at_ONEabcdefghijk"), b.renew("hpcb_at_ONEabcdefghijk")]);
  assert.equal(ta, "hpcb_at_TWOabcdefghijk");
  assert.equal(tb, "hpcb_at_TWOabcdefghijk");
  const presented = fake.requests.filter((r) => r.path === "/oauth/token").map((r) => new URLSearchParams(r.body.toString()).get("refresh_token"));
  assert.deepEqual(presented, ["hpcb_rt_ONEabcdefghijk"], "the spent refresh token was presented once only");
});

test("a fresh stored access token is used as it is, with no refresh", async () => {
  const fake = await fakeWith({});
  const config = configFor(fake.mcpUrl);
  const auth = new Auth(config, await storedAccount(tmpDir(), config.apiBase, 3600_000));
  assert.equal(await auth.bearer(), "hpcb_at_ONEabcdefghijk");
  assert.equal(fake.requests.length, 0);
});

test("a sign-in stored for another host is never sent here", async () => {
  const fake = await fakeWith({});
  const config = configFor(fake.mcpUrl);
  const auth = new Auth(config, await storedAccount(tmpDir(), "https://api.heypcb.ai", 3600_000));
  await assert.rejects(auth.bearer(), (e: unknown) => e instanceof RefusalError && e.refusal.code === "sign_in_required");
});

test("a malformed HEYPCB_API_KEY is refused before it is sent", async () => {
  const config = configFor("https://api.heypcb.ai/mcp", { HEYPCB_API_KEY: "sk-not-ours" });
  const auth = new Auth(config, new CredentialStore(path.join(tmpDir(), "c.json")));
  await assert.rejects(auth.bearer(), (e: unknown) => e instanceof RefusalError && e.refusal.code === "bad_api_key" && /Devices & API keys/.test(e.refusal.fix));
});

test("logout revokes the refresh token as heypcb-mcp, then forgets it", async () => {
  const fake = await fakeWith({});
  const config = configFor(fake.mcpUrl);
  const store = await storedAccount(tmpDir(), config.apiBase, 3600_000);
  const out = await logout(config, store);
  assert.deepEqual(out, { hadStored: true, revoked: true });
  const form = new URLSearchParams(fake.requests.find((r) => r.path === "/oauth/revoke")!.body.toString());
  assert.equal(form.get("token"), "hpcb_rt_ONEabcdefghijk");
  assert.equal(form.get("token_type_hint"), "refresh_token");
  assert.equal(form.get("client_id"), "heypcb-mcp");
  assert.equal(await store.account(config.apiBase), null);
  await assert.rejects(fsp.stat(store.file), "the file is gone with its last sign-in");
});

test("logout with the server unreachable still forgets the sign-in here, and says so", async () => {
  const fake = await fakeWith({});
  const config = configFor(fake.mcpUrl);
  const store = await storedAccount(tmpDir(), config.apiBase, 3600_000);
  await fake.close();
  const out = await logout(config, store);
  assert.deepEqual(out, { hadStored: true, revoked: false });
  assert.equal(await store.account(config.apiBase), null);
});
