/**
 * Where this package talks to, and how it names itself.
 *
 * - `HEYPCB_MCP_URL`  the remote MCP server (default https://api.heypcb.ai/mcp).
 * - `HEYPCB_API_BASE` the API host for sign-in and the REST calls the local
 *   tools make. Unset, it is the MCP URL's own origin. Set, it must be that
 *   same origin: a token is only ever sent to the one host it was issued for.
 * - `HEYPCB_WEB_BASE` where people open boards (default: the API base without
 *   its `api.`, so https://heypcb.ai; a dev server's own origin otherwise).
 * - `HEYPCB_API_KEY`  a personal key (`hpcb_pk_…`); beats a stored sign-in.
 * - `HEYPCB_MCP_TIMEOUT_MS` the no-progress budget for one remote call
 *   (default 10 minutes; below 1000 is ignored).
 *
 * Plain http is refused except to a loopback address: every request carries a
 * bearer.
 */
import os from "node:os";
import { VERSION } from "./version.ts";
import { refusal, type Refusal } from "./refusal.ts";

export const DEFAULT_MCP_URL = "https://api.heypcb.ai/mcp";
export const CLIENT_ID = "heypcb-mcp";
/** Every scope the public API has; the remote tools need all six. */
export const SCOPES = ["account:read", "projects:read", "projects:write", "engine:run", "agent:run", "exports:read"] as const;

export type Config = {
  mcpUrl: URL;
  apiBase: string; // origin, no trailing slash
  webBase: string; // origin, no trailing slash
  apiKey: string | null;
  userAgent: string;
  /** Upstream request budget for one remote tool call (reset by progress). */
  callTimeoutMs: number;
};

export type ConfigResult = { ok: true; config: Config } | { ok: false; refusal: Refusal };

function isLoopback(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  return h === "localhost" || h === "127.0.0.1" || h === "::1" || /^127\.\d+\.\d+\.\d+$/.test(h);
}

function parseBase(raw: string, what: string): { ok: true; url: URL } | { ok: false; refusal: Refusal } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, refusal: refusal("bad_config", `${what} is not a URL: ${JSON.stringify(raw)}.`, `Fix or unset ${what} in this MCP server's environment, then restart it.`) };
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname))) {
    return {
      ok: false,
      refusal: refusal("bad_config", `${what} must be an https:// address (plain http is allowed only to this computer).`, `Fix or unset ${what} in this MCP server's environment, then restart it.`),
    };
  }
  if (url.username || url.password) {
    return { ok: false, refusal: refusal("bad_config", `${what} must not carry a user name or password.`, `Remove the credentials from ${what}, then restart the server.`) };
  }
  return { ok: true, url };
}

export function userAgent(): string {
  return `heypcb-mcp/${VERSION} (node ${process.versions.node}; ${os.platform()} ${os.arch()})`;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ConfigResult {
  const mcp = parseBase((env.HEYPCB_MCP_URL || "").trim() || DEFAULT_MCP_URL, "HEYPCB_MCP_URL");
  if (!mcp.ok) return mcp;
  let apiOrigin = mcp.url.origin;
  const apiRaw = (env.HEYPCB_API_BASE || "").trim();
  if (apiRaw) {
    const api = parseBase(apiRaw, "HEYPCB_API_BASE");
    if (!api.ok) return api;
    if (api.url.origin !== mcp.url.origin) {
      return {
        ok: false,
        refusal: refusal(
          "bad_config",
          `HEYPCB_API_BASE (${api.url.origin}) and HEYPCB_MCP_URL (${mcp.url.origin}) are on different hosts, so HeyPCB will not send your sign-in to either.`,
          "Unset HEYPCB_API_BASE (it defaults to the MCP URL's host), or point both at the same host, then restart the server."
        ),
      };
    }
    apiOrigin = api.url.origin;
  }
  let webBase: string;
  const webRaw = (env.HEYPCB_WEB_BASE || "").trim();
  if (webRaw) {
    const web = parseBase(webRaw, "HEYPCB_WEB_BASE");
    if (!web.ok) return web;
    webBase = web.url.origin;
  } else {
    const u = new URL(apiOrigin);
    if (u.hostname.startsWith("api.")) u.hostname = u.hostname.slice(4);
    webBase = u.origin;
  }
  const key = (env.HEYPCB_API_KEY || "").trim();
  const timeout = Number(env.HEYPCB_MCP_TIMEOUT_MS || "");
  return {
    ok: true,
    config: {
      mcpUrl: mcp.url,
      apiBase: apiOrigin,
      webBase,
      apiKey: key || null,
      userAgent: userAgent(),
      callTimeoutMs: Number.isFinite(timeout) && timeout >= 1000 ? timeout : 10 * 60 * 1000,
    },
  };
}

export function projectUrl(config: Pick<Config, "webBase">, id: string): string {
  return `${config.webBase}/p/${encodeURIComponent(id)}`;
}

export function settingsKeysUrl(config: Pick<Config, "webBase">): string {
  return `${config.webBase}/settings?tab=devices`;
}
