/**
 * `npx -y @heypcb/mcp`            the MCP server, on stdio (what an agent runs);
 *                                  `--max-spend <amount>` requires an enforced budget
 * `npx @heypcb/mcp login`         sign in with a code you approve at heypcb.ai/connect
 * `npx @heypcb/mcp logout`        sign out here and end that sign-in on HeyPCB
 * `npx @heypcb/mcp status`        who this computer is signed in as
 *
 * In server mode stdout carries the MCP protocol only; every human line goes
 * to stderr.
 */
import { spawn } from "node:child_process";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Auth, deviceLogin, LoginError, logout } from "./auth.ts";
import { parseMaxSpend } from "./billing.ts";
import { loadConfig, settingsKeysUrl } from "./config.ts";
import { CredentialStore, credentialsPath } from "./credentials.ts";
import { RefusalError } from "./refusal.ts";
import { startServer } from "./server.ts";
import { VERSION } from "./version.ts";

const HELP = `HeyPCB MCP server ${VERSION}

Usage:
  npx -y @heypcb/mcp            Run the MCP server on stdio (add this to your agent).
        --max-spend <amount>    Require an enforceable cap; potentially charged calls stay blocked until supported.
                                <amount> (in the units HeyPCB bills in).
  npx @heypcb/mcp login         Sign in: approve a code at heypcb.ai/connect.
        --no-browser            Print the link instead of opening it.
  npx @heypcb/mcp logout        Sign out on this computer (and end that sign-in on HeyPCB).
  npx @heypcb/mcp status        Show who this computer is signed in as.
  npx @heypcb/mcp --version

Or skip login and set HEYPCB_API_KEY to a personal key (hpcb_pk_…) from
HeyPCB Settings → Devices & API keys.

Environment:
  HEYPCB_API_KEY     a personal key; used instead of a stored sign-in
  HEYPCB_MCP_URL     the remote MCP server (default https://api.heypcb.ai/mcp)
  HEYPCB_CONFIG_DIR  where the sign-in is stored (default ~/.config/heypcb,
                     %APPDATA%\\heypcb on Windows)
  HEYPCB_MCP_TIMEOUT_MS  how long one remote call may run without progress,
                     in ms, at least 1000 (default 10 minutes)
`;

/**
 * Said on stderr when a person, not an agent, started the server: stdin is a
 * terminal, or it closed before any message arrived. Without it the server
 * waits for a client a person will never type, or exits without a word.
 */
const SERVER_HINT = `heypcb-mcp ${VERSION} is an MCP server: your coding agent starts it, you don't run it by hand.
  Add it to Claude Code:  claude mcp add heypcb -- npx -y @heypcb/mcp
  Sign in once:           npx @heypcb/mcp login
  More:                   npx @heypcb/mcp --help, or https://heypcb.ai/mcp
`;

function openBrowser(url: string): boolean {
  try {
    const [cmd, args] =
      process.platform === "darwin"
        ? ["open", [url]]
        : process.platform === "win32"
          ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
          : ["xdg-open", [url]];
    const child = spawn(cmd, args as string[], { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

async function main(argvIn: string[]): Promise<number> {
  const spendArg = parseMaxSpend(argvIn);
  if ("error" in spendArg) {
    process.stderr.write(spendArg.error + "\n");
    return 2;
  }
  const argv = spendArg.rest;
  const cmd = argv[0];
  if (cmd === "--version" || cmd === "-v") {
    process.stdout.write(VERSION + "\n");
    return 0;
  }
  if (cmd === "--help" || cmd === "-h" || cmd === "help") {
    process.stdout.write(HELP);
    return 0;
  }
  const cfg = loadConfig();
  const store = new CredentialStore(credentialsPath());

  if (cmd === undefined || cmd === "serve") {
    const transport = new StdioServerTransport();
    const running = await startServer(transport, cfg.ok ? { config: cfg.config, store, maxSpend: spendArg.cap } : { config: null, configRefusal: cfg.refusal, store });
    if (!cfg.ok) process.stderr.write(`[heypcb-mcp] ${cfg.refusal.error} ${cfg.refusal.fix}\n`);
    if (process.stdin.isTTY) process.stderr.write(SERVER_HINT);
    let heard = false;
    process.stdin.once("data", () => {
      heard = true;
    });
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      if (!heard && !process.stdin.isTTY) process.stderr.write(SERVER_HINT);
      running.close().finally(() => process.exit(0));
    };
    process.stdin.on("end", stop);
    process.stdin.on("close", stop);
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    return -1; // keep running
  }

  if (!cfg.ok) {
    process.stderr.write(`${cfg.refusal.error}\n${cfg.refusal.fix}\n`);
    return 2;
  }
  const config = cfg.config;

  if (cmd === "login") {
    if (config.apiKey) process.stdout.write("Note: HEYPCB_API_KEY is set, and a key wins over a stored sign-in while it is set.\n");
    try {
      const out = await deviceLogin(config, store, {
        print: (l) => process.stdout.write(l + "\n"),
        openBrowser: argv.includes("--no-browser") || process.env.HEYPCB_NO_BROWSER === "1" ? null : openBrowser,
      });
      process.stdout.write(`\nSigned in to HeyPCB${out.email ? ` as ${out.email}` : ""}. Your agent's HeyPCB tools work now (no restart needed).\n`);
      process.stdout.write(`Stored in ${store.file}\n`);
      return 0;
    } catch (err) {
      if (err instanceof LoginError) {
        process.stderr.write(err.message + "\n");
        return 1;
      }
      throw err;
    }
  }

  if (cmd === "logout") {
    const out = await logout(config, store);
    if (!out.hadStored) process.stdout.write(`Not signed in to ${config.apiBase} on this computer.\n`);
    else if (out.revoked) process.stdout.write("Signed out. The sign-in was ended on HeyPCB and removed from this computer.\n");
    else process.stdout.write(`Removed the sign-in from this computer, but HeyPCB could not be reached to end it there. Remove it in Settings → Devices & API keys: ${settingsKeysUrl(config)}\n`);
    if (config.apiKey) process.stdout.write("HEYPCB_API_KEY is still set; delete that key in Settings → Devices & API keys to revoke it.\n");
    return 0;
  }

  if (cmd === "status") {
    const auth = new Auth(config, store);
    const state = await auth.state();
    if (state.kind === "none") {
      process.stdout.write(`Not signed in to ${config.apiBase}. Run \`npx @heypcb/mcp login\`, or set HEYPCB_API_KEY (${settingsKeysUrl(config)}).\n`);
      return 1;
    }
    try {
      const res = await auth.fetch(`${config.apiBase}/v1/me`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
      const body = (await res.json().catch(() => null)) as { ok?: boolean; user?: { email?: string }; plan?: { name?: string }; code?: string; error?: string; fix?: string } | null;
      if (!res.ok || !body?.ok) {
        process.stdout.write(`HeyPCB refused (${body?.code ?? res.status}): ${body?.error ?? ""} ${body?.fix ?? ""}\n`);
        return 1;
      }
      const via = state.kind === "api_key" ? "HEYPCB_API_KEY" : `stored sign-in (${store.file})`;
      process.stdout.write(`Signed in to ${config.apiBase} as ${body.user?.email ?? "(no email)"}, plan ${body.plan?.name ?? "—"}, via ${via}.\n`);
      return 0;
    } catch (err) {
      if (err instanceof RefusalError) {
        process.stdout.write(`${err.refusal.error}\n${err.refusal.fix}\n`);
        return 1;
      }
      process.stdout.write(`Could not reach ${config.apiBase}: ${(err as Error).message}\n`);
      return 1;
    }
  }

  process.stderr.write(`Unknown command: ${cmd}\n\n${HELP}`);
  return 2;
}

main(process.argv.slice(2)).then(
  (code) => {
    if (code >= 0) process.exit(code);
  },
  (err) => {
    process.stderr.write(`[heypcb-mcp] ${(err as Error)?.stack ?? String(err)}\n`);
    process.exit(1);
  }
);
