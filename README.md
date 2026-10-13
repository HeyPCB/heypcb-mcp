# @heypcb/mcp

HeyPCB for AI agents. Add HeyPCB to Claude Code, Codex, Cursor or Claude
Desktop and design real KiCad boards from your agent: HeyPCB's server does
the engineering (Inky's design agent, parts, placement, routing, DRC/ERC,
fab checks), and your agent calls a few high-level tools such as
`build_board`, `get_board`, `check_board` and `export`. Or your agent
designs the board itself with HeyPCB's parts library, proven circuit blocks
and checks: `search_parts`, `get_part`, `add_parts`, `add_block`, `connect`,
`get_netlist` and the rest of the parts and circuit tools, then lays it out
with `set_board_outline`, `set_board_rules`, `move_part`, `lock_parts`,
`add_ground_pour` and `get_board_layout`, and takes it to fab-ready by
following `check_board`: every finding names the call that fixes it
(`fixWith`).

## The quickest way: the remote server (nothing to install)

HeyPCB runs the MCP server for you at `https://api.heypcb.ai/mcp`
(Streamable HTTP, OAuth sign-in in your browser):

```sh
claude mcp add --transport http heypcb https://api.heypcb.ai/mcp
```

Codex, Cursor and claude.ai (as a custom connector) take the same URL. Use
it unless you need the two local tools below.

## The local server (this package)

`npx -y @heypcb/mcp` runs a small MCP server on your computer (stdio). It
passes every HeyPCB tool through to the remote server unchanged — same
names, schemas, results, progress and cancellation; it holds no design logic
of its own — and adds two tools that need your files:

| Tool | What it does |
|---|---|
| `upload_kicad_project` | Zips a KiCad project folder on this computer (board, schematic hierarchy, `.kicad_pro`, `.kicad_dru`, library tables and project-local libraries — never 3D models, backups or `.kicad_prl`; at most 50 MB) and imports it as a new HeyPCB project. Returns the project id and its web link. |
| `save_export` | Saves Gerbers, the KiCad project, BOM, pick-and-place (CPL) or STEP into a folder here, atomically, and returns the file's path. |

It needs Node.js 18 or newer, and nothing else: everything it uses is bundled
into one file.

### 1. Sign in (once per computer)

Either sign in with a code:

```sh
npx @heypcb/mcp login
```

It opens heypcb.ai/connect and shows a code; check the page shows the same
code and approve. The sign-in is stored in `~/.config/heypcb/credentials.json`
(`%APPDATA%\heypcb\credentials.json` on Windows), readable only by you. A
running server picks it up on its next call — no restart.

Or make a personal key in **heypcb.ai → Settings → Devices & API keys** and
give it to the server as `HEYPCB_API_KEY` (examples below). A key is used
instead of a stored sign-in while it is set.

Without either, the server still starts, and every tool answers with these
two ways to sign in.

### 2. Add it to your agent

**Claude Code**

```sh
claude mcp add heypcb -- npx -y @heypcb/mcp
# or with a personal key instead of `login`:
claude mcp add heypcb -e HEYPCB_API_KEY=hpcb_pk_… -- npx -y @heypcb/mcp
```

**Codex** — `~/.codex/config.toml`

```toml
[mcp_servers.heypcb]
command = "npx"
args = ["-y", "@heypcb/mcp"]
# env = { HEYPCB_API_KEY = "hpcb_pk_…" }
```

**Cursor** — `.cursor/mcp.json` in your project (or `~/.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "heypcb": {
      "command": "npx",
      "args": ["-y", "@heypcb/mcp"]
    }
  }
}
```

**Claude Desktop** — `claude_desktop_config.json` (Settings → Developer → Edit Config)

```json
{
  "mcpServers": {
    "heypcb": {
      "command": "npx",
      "args": ["-y", "@heypcb/mcp"],
      "env": { "HEYPCB_API_KEY": "hpcb_pk_…" }
    }
  }
}
```

(Claude Desktop starts servers with a short `PATH`: if it cannot find `npx`,
put its full path in `command`, as `which npx` prints it.)

### Commands

```text
npx -y @heypcb/mcp          run the MCP server on stdio (what your agent runs)
npx @heypcb/mcp login       sign in with a code (--no-browser prints the link only)
npx @heypcb/mcp logout      sign out here and end that sign-in on HeyPCB
npx @heypcb/mcp status      who this computer is signed in as
```

### Environment

| Variable | Meaning |
|---|---|
| `HEYPCB_API_KEY` | A personal key (`hpcb_pk_…`). Used instead of a stored sign-in. |
| `HEYPCB_MCP_URL` | The remote server. Default `https://api.heypcb.ai/mcp`. |
| `HEYPCB_API_BASE` | The API host for sign-in and the local tools. Default: the MCP URL's host, and it must be that host. |
| `HEYPCB_WEB_BASE` | Where project links point. Default `https://heypcb.ai`. |
| `HEYPCB_CONFIG_DIR` | Where the sign-in is stored. |
| `HEYPCB_MCP_TIMEOUT_MS` | How long one remote call may run without progress. Default 10 minutes. |

### What it does with your computer

- It reads files only when you call `upload_kicad_project`, and only the
  project's own files listed above. A file or link that leads outside the
  project folder stops the upload; nothing partial is sent.
- It writes files only when you call `save_export`: inside your home folder
  (it creates missing folders), or into an existing folder elsewhere that you
  can write to. It never follows a link out of your home folder, never writes
  into folders that hold keys (`~/.ssh`, `~/.aws`, …), never overwrites a
  file unless you pass `overwrite: true`, and writes through a temp file it
  renames into place.
- Your sign-in is only ever sent to the API host it was issued by, over https
  (plain http only to `localhost`). Refreshes are coordinated between every
  copy of the server running on your computer, so two agents never spend the
  same refresh token.

## Billing

Tools cost what the same work costs on heypcb.ai, from the same account and
wallet. `estimate` prices an operation before it runs; `whoami` shows the
balance. The parts and circuit tools your own agent designs with are free
(rate-limited per account; `whoami` says the limits).

## Source

Source: https://github.com/HeyPCB/heypcb-mcp — issues and pull requests are
welcome there (its `CONTRIBUTING.md`; security reports: its `SECURITY.md`).
Each release is mirrored there from HeyPCB's own repository, and that
repository's CI publishes it to npm with provenance, so npm links each
version to the commit and the build that made it.

## Development

The package has its own pnpm lockfile and is its own workspace root.

```sh
pnpm install --ignore-workspace --frozen-lockfile
pnpm run typecheck
pnpm run test          # node --test against a fake HeyPCB host
pnpm run build         # dist/cli.js, one bundled file
pnpm run test:smoke    # the built file over stdio
```

Releasing: bump `version` in `package.json` and `src/version.ts` (a test
holds them equal). When that commit reaches `main` in heypcb-mcp, its CI
publishes it to npm, with provenance, if that version is not on npm yet.

## License

MIT — see `LICENSE`. The bundled packages' notices are in
`dist/THIRD-PARTY-NOTICES.txt` in the published package.
