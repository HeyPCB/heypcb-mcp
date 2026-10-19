<div align="center">

# @heypcb/mcp

**HeyPCB for AI agents.** Design real KiCad boards from Claude Code, Codex, Cursor or Claude Desktop.

[![npm](https://img.shields.io/npm/v/@heypcb/mcp?logo=npm&color=CB3837)](https://www.npmjs.com/package/@heypcb/mcp)
[![ci](https://img.shields.io/github/actions/workflow/status/HeyPCB/heypcb-mcp/ci.yml?branch=main&label=ci&logo=githubactions&logoColor=white)](https://github.com/HeyPCB/heypcb-mcp/actions/workflows/ci.yml)
[![node](https://img.shields.io/node/v/@heypcb/mcp?logo=nodedotjs&logoColor=white&color=5FA04E)](https://nodejs.org)
[![license](https://img.shields.io/github/license/HeyPCB/heypcb-mcp?color=blue)](LICENSE)
[![MCP](https://img.shields.io/badge/MCP-server-8A2BE2)](https://modelcontextprotocol.io)

[![Claude Code](https://img.shields.io/badge/Claude_Code-191919?logo=claude&logoColor=D97757)](#claude-code)
[![Claude Desktop](https://img.shields.io/badge/Claude_Desktop-191919?logo=claude&logoColor=D97757)](#claude-desktop)
[![Cursor](https://img.shields.io/badge/Cursor-191919?logo=cursor&logoColor=white)](#cursor)
[![Codex](https://img.shields.io/badge/Codex-191919)](#codex)
[![KiCad](https://img.shields.io/badge/KiCad-314CB0?logo=kicad&logoColor=white)](https://www.kicad.org)

[Website](https://heypcb.ai/mcp) · [Quick start](#quick-start) · [Local server](#the-local-server-this-package) · [Billing](#billing) · [Troubleshooting](#troubleshooting)

</div>

---

## Two ways to design

| | You say | Your agent calls |
|---|---|---|
| **Let HeyPCB design it** | "Build a USB-C powered board for …" | `build_board`, `get_board`, `check_board`, `export`. HeyPCB's server does the engineering: Inky's design agent, parts, placement, routing, DRC/ERC and fab checks. |
| **Let your agent design it** | "Add an LDO and wire it to the MCU" | Parts and blocks: `search_parts`, `get_part`, `add_parts`, `add_block`, `connect`, `get_netlist`. Layout: `set_board_outline`, `set_board_rules`, `move_part`, `lock_parts`, `add_ground_pour`, `get_board_layout`. Then `check_board` until the board is fab-ready. Each finding names the call that fixes it (`fixWith`). |

## Quick start

HeyPCB runs the MCP server for you at `https://api.heypcb.ai/mcp` (Streamable
HTTP, OAuth sign-in in your browser). Nothing to install:

```sh
claude mcp add --transport http heypcb https://api.heypcb.ai/mcp
```

[![Add to Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/install-mcp?name=heypcb&config=eyJ1cmwiOiJodHRwczovL2FwaS5oZXlwY2IuYWkvbWNwIn0%3D)

Codex and claude.ai (as a custom connector) take the same URL.

### Which one do I need?

| | Remote server | Local server (this package) |
|---|:---:|:---:|
| Install | nothing | Node.js 18+ |
| All HeyPCB tools | ✅ | ✅ |
| Work on a KiCad project in its own folder, edits synced back | ❌ | ✅ `open_kicad_project` |
| Upload a copy of a KiCad project from your disk | ❌ | ✅ `upload_kicad_project` |
| Save Gerbers, BOM, CPL, STEP to a folder | ❌ | ✅ `save_export` |
| HeyPCB parts in the project's own libraries | ❌ | ✅ `install_parts` |
| KiCad's own DRC/ERC and exports, free and offline | ❌ | ✅ `check_local`, `export_local` |

Use the remote server unless you need one of the local tools.

## The local server (this package)

`npx -y @heypcb/mcp` runs a small MCP server on your computer (stdio). It
passes every HeyPCB tool through to the remote server unchanged, with the
same names, schemas, results, progress and cancellation. It has no design
logic of its own. It adds the tools that need your files:

| Tool | What it does |
|---|---|
| `open_kicad_project` | Binds a KiCad project folder on this computer to one HeyPCB project, so every HeyPCB tool works on it and its edits land back in the folder ([see below](#working-on-a-kicad-project-in-its-own-folder)). |
| `upload_kicad_project` | Zips a KiCad project folder on this computer (board, schematic hierarchy, `.kicad_pro`, `.kicad_dru`, library tables and project-local libraries, but not 3D models, backups or `.kicad_prl`; at most 50 MB) and imports it as a new, separate HeyPCB project: a one-off copy. Returns the project id and its web link. |
| `save_export` | Saves Gerbers, the KiCad project, BOM, pick-and-place (CPL) or STEP into a folder here, atomically, and returns the file's path. |
| `install_parts` | Copies HeyPCB parts (symbol, footprint, 3D model) into the project's own `heypcb.kicad_sym`, `heypcb.pretty/` and `heypcb.3dshapes/`, and adds them to its `sym-lib-table` / `fp-lib-table` with `${KIPRJMOD}` paths, so the project opens on a computer without HeyPCB. |
| `check_local` | KiCad's own DRC or ERC on the project here, with `kicad-cli`: free, no network. A fast pre-check; `check_board` stays the full verification. |
| `export_local` | Gerbers (+ drill), BOM, pick-and-place or STEP from the project here, with `kicad-cli`. |
| `restore_local` | Puts back files a sync backed up before HeyPCB's changes replaced them. |

It needs Node.js 18 or newer and nothing else. Everything it uses is bundled
into one file. `check_local` and `export_local` also need KiCad 8 or newer
installed (`kicad-cli` on `PATH`, or in KiCad's standard install folder).

### 1. Sign in (once per computer)

**Option A: sign in with a code**

```sh
npx @heypcb/mcp login
```

It opens heypcb.ai/connect and shows a code; check the page shows the same
code and approve. The sign-in is stored in `~/.config/heypcb/credentials.json`
(`%APPDATA%\heypcb\credentials.json` on Windows), readable only by you. A
running server picks it up on its next call, without a restart.

**Option B: use a personal key**

Make one in **heypcb.ai → Settings → Devices & API keys** and give it to the
server as `HEYPCB_API_KEY` (examples below). A key is used instead of a
stored sign-in while it is set.

> [!TIP]
> Without either, the server still starts, and every tool answers with these
> two ways to sign in.

### 2. Add it to your agent

#### Claude Code

```sh
claude mcp add heypcb -- npx -y @heypcb/mcp
# or with a personal key instead of `login`:
claude mcp add heypcb -e HEYPCB_API_KEY=hpcb_pk_… -- npx -y @heypcb/mcp
```

#### Cursor

[![Add to Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/install-mcp?name=heypcb&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBoZXlwY2IvbWNwIl19)

Or add it by hand to `.cursor/mcp.json` in your project (or `~/.cursor/mcp.json`):

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

#### Codex

In `~/.codex/config.toml`:

```toml
[mcp_servers.heypcb]
command = "npx"
args = ["-y", "@heypcb/mcp"]
# env = { HEYPCB_API_KEY = "hpcb_pk_…" }
```

#### Claude Desktop

In `claude_desktop_config.json` (Settings → Developer → Edit Config):

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

### 3. Try it

Ask your agent, for example:

- "Upload my KiCad project at `~/boards/sensor` to HeyPCB and run the full check."
- "Save the Gerbers and BOM for that project into `~/boards/sensor/fab`."
- "Open my KiCad project at `~/boards/sensor`, add a 3.3 V LDO and route the board."

### Working on a KiCad project in its own folder

Ask your agent to open the project (`open_kicad_project` with its folder).
The first time, the folder is uploaded as a new HeyPCB project and bound to
it in `.heypcb/workspace.json` (added to `.gitignore` when the folder is in a
git repository). From then on, every HeyPCB tool called on that project
keeps the folder in sync:

- **before a call**, files you changed here go up (only the changed ones);
- **after a call that changes the design**, the files HeyPCB changed come
  back. The old ones are copied to `.heypcb/backup/<revision>/` first, and
  the result tells your agent which files to reload in KiCad;
- **a file you save in KiCad while a call runs is never overwritten**:
  HeyPCB's version is written beside it as `<file>.heypcb-new`, and syncing
  waits until you choose (`on_conflict: "take_heypcb"` or `"keep_local"`).
  The same choice resolves an edit made on heypcb.ai and here at once;
- parts an `add_parts` or `add_block` places are installed into the
  project's own libraries (`install_parts`), so every symbol and footprint
  resolves offline.

The project stays a normal KiCad project: open it in KiCad at any time.
List files you never want uploaded in a `.heypcbignore` next to the
`.kicad_pro` (one gitignore-style pattern a line).

### Commands

```text
npx -y @heypcb/mcp          run the MCP server on stdio (what your agent runs)
     --max-spend <amount>   refuse paid calls once this server has spent <amount>
npx @heypcb/mcp login       sign in with a code (--no-browser prints the link only)
npx @heypcb/mcp logout      sign out here and end that sign-in on HeyPCB
npx @heypcb/mcp status      who this computer is signed in as
```

<details>
<summary><b>Environment variables</b></summary>

| Variable | Meaning |
|---|---|
| `HEYPCB_API_KEY` | A personal key (`hpcb_pk_…`). Used instead of a stored sign-in. |
| `HEYPCB_MCP_URL` | The remote server. Default `https://api.heypcb.ai/mcp`. |
| `HEYPCB_API_BASE` | The API host for sign-in and the local tools. Default: the MCP URL's host, and it must be that host. |
| `HEYPCB_WEB_BASE` | Where project links point. Default `https://heypcb.ai`. |
| `HEYPCB_CONFIG_DIR` | Where the sign-in is stored. |
| `HEYPCB_MCP_TIMEOUT_MS` | How long one remote call may run without progress. Default 10 minutes. |

</details>

### What it does with your computer

- **Reads** a project's files when you call `upload_kicad_project`,
  `open_kicad_project`, `check_local` or `export_local`, and before each
  HeyPCB call on a bound project: only the project's own files listed
  above, minus what `.heypcbignore` names. **A bound project's files are
  uploaded to HeyPCB**, again whenever you change them. A file or link that
  leads outside the project folder stops the upload; nothing partial is sent.
- **Writes**, in a bound project folder, the files HeyPCB changed (after
  backing up the old ones in `.heypcb/backup/`), `.heypcb/` itself, the
  `heypcb` libraries and lib-table entries `install_parts` adds, and
  `exports/` for `export_local`. It never writes outside the project folder
  there, never through a link that leads out of it, and never over a file
  you changed since the last sync.
- **Writes** other files only when you call `save_export`: inside your home
  folder (it creates missing folders), or into an existing folder elsewhere
  that you can write to. It never follows a link out of your home folder,
  never writes into folders that hold keys (`~/.ssh`, `~/.aws`, …), never
  overwrites a file unless you pass `overwrite: true`, and writes through a
  temp file it renames into place.
- **Your sign-in** is only ever sent to the API host it was issued by, over
  https (plain http only to `localhost`). Refreshes are coordinated between
  every copy of the server running on your computer, so two agents never
  spend the same refresh token.

## Billing

Tools cost what the same work costs on heypcb.ai, from the same account and
wallet. `estimate` prices an operation before it runs; `whoami` shows the
balance — and, from the local server, what this session has spent. The
local tools are free.

To cap what an agent may spend, start the local server with
`--max-spend <amount>` (in the units HeyPCB bills in), for example
`claude mcp add heypcb -- npx -y @heypcb/mcp --max-spend 5`. HeyPCB refuses
a call that would cross what is left, and once the cap is spent the server
refuses paid calls before sending them. Each call carries an idempotency
key, so a retried call is never charged twice. In a bound project folder,
every paid call is also logged, one JSON line each, in `.heypcb/usage.log`.

## Troubleshooting

| Problem | Fix |
|---|---|
| Every tool says to sign in | Run `npx @heypcb/mcp login`, or set `HEYPCB_API_KEY`. Check with `npx @heypcb/mcp status`. |
| Claude Desktop can't find `npx` | It starts servers with a short `PATH`. Put the full path from `which npx` in `command`. |
| Running `npx @heypcb/mcp` in a terminal prints a hint and waits | That's expected: your agent starts the server, not you. Add it to your agent as shown above. |
| A long call stops with `remote_timeout` | It may still be running on HeyPCB. Read its state (`wait_for_turn` for a turn, `get_board` for a board) before calling it again, or raise `HEYPCB_MCP_TIMEOUT_MS`. |

## Source

The source is at https://github.com/HeyPCB/heypcb-mcp. Issues and pull
requests are welcome there; see `CONTRIBUTING.md`, and send security
reports as described in `SECURITY.md`. Releases are mirrored there from
HeyPCB's own repository. That GitHub repository's CI then publishes each
release to npm with provenance, so npm links each version to the commit
and the build that made it.

<details>
<summary><b>Development</b></summary>

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

</details>

## License

MIT; see `LICENSE`. The bundled packages' notices are in
`dist/THIRD-PARTY-NOTICES.txt` in the published package.
