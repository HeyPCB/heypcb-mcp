/**
 * Who this process is signed in as, and the bearer for the next request.
 *
 * Two ways in, in this order:
 *   1. `HEYPCB_API_KEY` — a personal key (`hpcb_pk_…`) made in heypcb.ai
 *      Settings → Devices & API keys. Sent as it is; never refreshed.
 *   2. A stored sign-in from `npx @heypcb/mcp login` (the device code,
 *      RFC 8628, client `heypcb-mcp`): a 1-hour access token and a rotating
 *      refresh token in credentials.json (credentials.ts).
 *
 * A refresh is single-flight inside the process AND across processes (the
 * file lock): the server treats a rotated refresh token presented again as
 * theft and ends the whole sign-in.
 */
import os from "node:os";
import { CLIENT_ID, SCOPES, settingsKeysUrl, type Config } from "./config.ts";
import { CredentialStore, type StoredAccount } from "./credentials.ts";
import { refusal, RefusalError, type Refusal } from "./refusal.ts";

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

/** Seconds of slack before an access token's own end: renew a little early. */
const EARLY_S = 60;

export function signInFix(config: Pick<Config, "webBase">): string {
  return (
    "Sign in one of two ways, then call this tool again: " +
    "(1) run `npx @heypcb/mcp login` in a terminal and approve the code it shows at " +
    `${config.webBase}/connect (no restart needed); or ` +
    `(2) make a personal key in HeyPCB Settings → Devices & API keys (${settingsKeysUrl(config)}), ` +
    "set it as HEYPCB_API_KEY in this MCP server's configuration, and restart the server."
  );
}

export function signInRequired(config: Pick<Config, "webBase">): Refusal {
  return refusal("sign_in_required", "HeyPCB is not signed in on this computer.", signInFix(config));
}

export function signedOut(config: Pick<Config, "webBase">): Refusal {
  return refusal(
    "signed_out",
    "Your HeyPCB sign-in on this computer has ended: it expired, was removed in Settings, or was signed out.",
    signInFix(config)
  );
}

export function apiKeyRefused(config: Pick<Config, "webBase">, code: string): Refusal {
  return refusal(
    "api_key_refused",
    `HeyPCB refused the personal key in HEYPCB_API_KEY (${code}): it has expired, was deleted, or is mistyped.`,
    `Make a new key in HeyPCB Settings → Devices & API keys (${settingsKeysUrl(config)}), put it in HEYPCB_API_KEY and restart this MCP server — or remove HEYPCB_API_KEY and run \`npx @heypcb/mcp login\` instead.`
  );
}

export function authUnavailable(detail: string): Refusal {
  return refusal("auth_unavailable", `HeyPCB's sign-in server could not be reached (${detail}).`, "Check this computer's internet connection, then call the tool again.", {
    retryable: true,
  });
}

function fresh(acc: StoredAccount, now: number): boolean {
  if (!acc.accessToken || !acc.accessTokenExpiresAt) return false;
  const end = Date.parse(acc.accessTokenExpiresAt);
  return Number.isFinite(end) && end - EARLY_S * 1000 > now;
}

export type TokenAnswer = { access_token: string; refresh_token: string; expires_in: number; scope?: string; token_type?: string };

function isTokenAnswer(v: unknown): v is TokenAnswer {
  const t = v as Partial<TokenAnswer> | null;
  return !!t && typeof t.access_token === "string" && typeof t.refresh_token === "string" && typeof t.expires_in === "number";
}

export function accountFromTokens(t: TokenAnswer, now: number, prev?: Partial<StoredAccount>): StoredAccount {
  return {
    clientId: CLIENT_ID,
    refreshToken: t.refresh_token,
    accessToken: t.access_token,
    accessTokenExpiresAt: new Date(now + t.expires_in * 1000).toISOString(),
    scope: t.scope ?? prev?.scope ?? SCOPES.join(" "),
    signedInAt: prev?.signedInAt ?? new Date(now).toISOString(),
    email: prev?.email ?? null,
  };
}

/** POST a form to an OAuth endpoint; the JSON answer and its status, or throws on the network. */
export async function postForm(
  fetchImpl: FetchLike,
  config: Pick<Config, "apiBase" | "userAgent">,
  pathname: string,
  form: Record<string, string>,
  timeoutMs = 30_000
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetchImpl(config.apiBase + pathname, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json", "user-agent": config.userAgent },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, body: body && typeof body === "object" ? body : {} };
}

export type AuthState = { kind: "api_key" } | { kind: "stored"; email: string | null; scope: string } | { kind: "none" };

export class Auth {
  readonly config: Config;
  readonly store: CredentialStore;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private inflight: Promise<string> | null = null;
  /** This process saw the server end the stored sign-in (so "signed out", not "never signed in"). */
  private ended = false;

  constructor(config: Config, store: CredentialStore, opts: { fetch?: FetchLike; now?: () => number } = {}) {
    this.config = config;
    this.store = store;
    this.fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init));
    this.now = opts.now ?? Date.now;
  }

  async state(): Promise<AuthState> {
    if (this.config.apiKey) return { kind: "api_key" };
    const acc = await this.store.account(this.config.apiBase);
    return acc ? { kind: "stored", email: acc.email ?? null, scope: acc.scope } : { kind: "none" };
  }

  /** Whether any credential is there to try (a key, or a stored sign-in for this host). */
  async hasCredentials(): Promise<boolean> {
    const has = (await this.state()).kind !== "none";
    if (has) this.ended = false;
    return has;
  }

  /** The refusal for "no credential to send": never signed in, or the sign-in ended. */
  missing(): Refusal {
    return this.ended ? signedOut(this.config) : signInRequired(this.config);
  }

  /** The bearer for the next request. Throws RefusalError when there is none to give. */
  async bearer(): Promise<string> {
    const key = this.config.apiKey;
    if (key) {
      if (!/^hpcb_[a-z]{2}_[A-Za-z0-9]{8,}$/.test(key)) {
        throw new RefusalError(
          refusal(
            "bad_api_key",
            "HEYPCB_API_KEY does not look like a HeyPCB key (they start with hpcb_pk_).",
            `Copy the key again from HeyPCB Settings → Devices & API keys (${settingsKeysUrl(this.config)}) into HEYPCB_API_KEY and restart this MCP server.`
          )
        );
      }
      return key;
    }
    const acc = await this.store.account(this.config.apiBase);
    if (!acc) throw new RefusalError(this.missing());
    this.ended = false;
    if (fresh(acc, this.now())) return acc.accessToken!;
    return this.rotate(null);
  }

  /**
   * The server answered 401 to `rejected`. A newer access token (refreshing
   * once if needed), or the refusal that says why there is none.
   */
  async renew(rejected: string, code = "token_expired"): Promise<string> {
    if (this.config.apiKey) throw new RefusalError(apiKeyRefused(this.config, code));
    const acc = await this.store.account(this.config.apiBase);
    if (!acc) throw new RefusalError(signedOut(this.config));
    if (acc.accessToken !== rejected && fresh(acc, this.now())) return acc.accessToken!;
    return this.rotate(rejected);
  }

  private rotate(rejected: string | null): Promise<string> {
    if (this.inflight) return this.inflight;
    this.inflight = this.store
      .withLock(async () => {
        // Re-read under the lock: another process may have rotated already.
        const acc = await this.store.account(this.config.apiBase);
        if (!acc) throw new RefusalError(signedOut(this.config));
        if (acc.accessToken && acc.accessToken !== rejected && fresh(acc, this.now())) return acc.accessToken;
        let answer: { status: number; body: Record<string, unknown> };
        try {
          answer = await postForm(this.fetchImpl, this.config, "/oauth/token", {
            grant_type: "refresh_token",
            refresh_token: acc.refreshToken,
            client_id: acc.clientId,
          });
        } catch (err) {
          throw new RefusalError(authUnavailable((err as Error).message || "network error"));
        }
        if (answer.status === 200 && isTokenAnswer(answer.body)) {
          const next = accountFromTokens(answer.body, this.now(), acc);
          await this.store.put(this.config.apiBase, next);
          return next.accessToken!;
        }
        const error = typeof answer.body.error === "string" ? answer.body.error : "";
        if (answer.status === 400 || answer.status === 401) {
          if (error === "invalid_grant" || error === "invalid_client" || error === "access_denied") {
            // The sign-in is over on the server: forget it here too (we hold the lock, and this is the token we presented).
            await this.store.put(this.config.apiBase, null);
            this.ended = true;
            throw new RefusalError(signedOut(this.config));
          }
        }
        throw new RefusalError(authUnavailable(`the token endpoint answered ${answer.status}${error ? ` ${error}` : ""}`));
      })
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }

  /**
   * `fetch` with the bearer added, renewing once on a 401. Bodies must be
   * re-sendable (a string, bytes or FormData) — every caller here sends one.
   */
  async fetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
    const send = (token: string) => {
      const headers = new Headers(init.headers ?? {});
      headers.set("authorization", `Bearer ${token}`);
      if (!headers.has("user-agent")) headers.set("user-agent", this.config.userAgent);
      return this.fetchImpl(input, { ...init, headers });
    };
    const token = await this.bearer();
    const res = await send(token);
    if (res.status !== 401) return res;
    const code = await refusalCode(res);
    const next = await this.renew(token, code ?? "token_expired");
    const again = await send(next);
    if (again.status === 401 && !this.config.apiKey) {
      throw new RefusalError(signedOut(this.config));
    }
    return again;
  }
}

async function refusalCode(res: Response): Promise<string | null> {
  try {
    const body = (await res.clone().json()) as { code?: unknown };
    return typeof body?.code === "string" ? body.code : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* The device code sign-in (RFC 8628) and sign-out                     */
/* ------------------------------------------------------------------ */

export type DeviceLoginIo = {
  print: (line: string) => void;
  /** Open the approval page in a browser; false when it could not. */
  openBrowser: ((url: string) => boolean) | null;
  sleep?: (ms: number) => Promise<void>;
  fetch?: FetchLike;
  now?: () => number;
  deviceName?: string;
};

export function defaultDeviceName(): string {
  const host = os.hostname().replace(/[\p{Cc}\p{Cf}]/gu, " ").trim();
  return (host || "This computer").slice(0, 80);
}

class LoginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LoginError";
  }
}

export { LoginError };

/** Is `url` on one of our own origins (A8: the client opens only WEB_BASE and API_BASE)? */
function ownOrigin(config: Pick<Config, "apiBase" | "webBase">, url: string): boolean {
  try {
    const o = new URL(url).origin;
    return o === config.webBase || o === config.apiBase;
  } catch {
    return false;
  }
}

export async function deviceLogin(config: Config, store: CredentialStore, io: DeviceLoginIo): Promise<{ email: string | null; scope: string }> {
  const fetchImpl = io.fetch ?? ((i, n) => fetch(i, n));
  const sleep = io.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = io.now ?? Date.now;
  let start: { status: number; body: Record<string, unknown> };
  try {
    start = await postForm(fetchImpl, config, "/oauth/device/code", {
      client_id: CLIENT_ID,
      scope: SCOPES.join(" "),
      device_name: io.deviceName ?? defaultDeviceName(),
    });
  } catch (err) {
    throw new LoginError(`Could not reach ${config.apiBase} (${(err as Error).message}). Check your internet connection and try again.`);
  }
  const b = start.body;
  if (start.status !== 200 || typeof b.device_code !== "string" || typeof b.user_code !== "string") {
    const why = typeof b.error_description === "string" ? b.error_description : typeof b.error === "string" ? b.error : typeof b.code === "string" ? `${b.code}: ${String(b.error ?? "")}` : `HTTP ${start.status}`;
    const fix = typeof b.fix === "string" ? ` ${b.fix}` : "";
    throw new LoginError(`HeyPCB did not start the sign-in (${why}).${fix}`);
  }
  const userCode = b.user_code;
  const page = typeof b.verification_uri_complete === "string" ? b.verification_uri_complete : typeof b.verification_uri === "string" ? b.verification_uri : `${config.webBase}/connect`;
  const plainPage = typeof b.verification_uri === "string" ? b.verification_uri : `${config.webBase}/connect`;
  const trusted = ownOrigin(config, page);
  io.print("");
  io.print(`  To sign in to HeyPCB, open:  ${trusted ? page : plainPage}`);
  io.print(`  and check that it shows this code:  ${userCode}`);
  io.print("");
  if (trusted && io.openBrowser) {
    if (io.openBrowser(page)) io.print("  (Opened it in your browser.)");
  }
  io.print("  Waiting for you to approve it… (Ctrl+C to stop)");

  let interval = Math.max(1, Number(b.interval) || 5);
  const deadline = now() + Math.max(30, Number(b.expires_in) || 900) * 1000;
  for (;;) {
    await sleep(interval * 1000);
    if (now() > deadline) throw new LoginError("The code expired before it was approved. Run `npx @heypcb/mcp login` again.");
    let poll: { status: number; body: Record<string, unknown> };
    try {
      poll = await postForm(fetchImpl, config, "/oauth/token", {
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: b.device_code,
        client_id: CLIENT_ID,
      });
    } catch {
      continue; // a dropped poll is retried at the next interval
    }
    if (poll.status === 200 && isTokenAnswer(poll.body)) {
      const tokens = poll.body;
      const email = await whoEmail(fetchImpl, config, tokens.access_token);
      const acc = accountFromTokens(tokens, now(), { email });
      await store.withLock(() => store.put(config.apiBase, acc));
      return { email, scope: acc.scope };
    }
    const error = typeof poll.body.error === "string" ? poll.body.error : "";
    if (error === "authorization_pending") continue;
    if (error === "slow_down" || poll.status === 429) {
      interval += 5;
      continue;
    }
    if (error === "access_denied") throw new LoginError("The sign-in was denied on heypcb.ai. Run `npx @heypcb/mcp login` again if that was a mistake.");
    if (error === "expired_token") throw new LoginError("The code expired before it was approved. Run `npx @heypcb/mcp login` again.");
    if (poll.status >= 500) continue;
    const desc = typeof poll.body.error_description === "string" ? `: ${poll.body.error_description}` : "";
    throw new LoginError(`HeyPCB refused the sign-in (${error || `HTTP ${poll.status}`}${desc}).`);
  }
}

async function whoEmail(fetchImpl: FetchLike, config: Config, token: string): Promise<string | null> {
  try {
    const res = await fetchImpl(config.apiBase + "/v1/me", {
      headers: { authorization: `Bearer ${token}`, accept: "application/json", "user-agent": config.userAgent },
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json().catch(() => null)) as { user?: { email?: unknown } } | null;
    return typeof body?.user?.email === "string" ? body.user.email : null;
  } catch {
    return null;
  }
}

/**
 * Forget the stored sign-in for this host, revoking it on the server first
 * (RFC 7009: revoking either token ends the whole session). The local copy is
 * removed whatever the server answered.
 */
export async function logout(config: Config, store: CredentialStore, opts: { fetch?: FetchLike } = {}): Promise<{ hadStored: boolean; revoked: boolean }> {
  const fetchImpl = opts.fetch ?? ((i, n) => fetch(i, n));
  return store.withLock(async () => {
    const acc = await store.account(config.apiBase);
    if (!acc) return { hadStored: false, revoked: false };
    let revoked = false;
    try {
      const r = await postForm(fetchImpl, config, "/oauth/revoke", {
        token: acc.refreshToken,
        token_type_hint: "refresh_token",
        client_id: acc.clientId,
      });
      revoked = r.status === 200;
    } catch {
      revoked = false;
    }
    await store.put(config.apiBase, null);
    return { hadStored: true, revoked };
  });
}
