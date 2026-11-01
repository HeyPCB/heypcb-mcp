# Changelog

Releases of `@heypcb/mcp`, newest first. HeyPCB's own tools live on its
remote server and change there, whichever version of this package you run.
Each release also lists the tool changes since the previous release that an
agent will notice.

## 0.1.7

### This package

- **Names the agent that drives it.** After your agent's `initialize`, every
  request to HeyPCB carries the agent's own name (its `clientInfo` title,
  else its name; one line, at most 80 characters) in an `X-HeyPCB-Agent`
  header. A board's history then reads "with Claude Code on <computer>"
  instead of "with an agent on <computer>". With a personal key, the history
  names neither.
- **Codex uses the local server.** Since codex-cli 0.165, Codex cannot sign
  in to the remote server. The README gives Codex the local server in one
  paste (`codex mcp add heypcb -- npx -y @heypcb/mcp && npx -y @heypcb/mcp login`)
  and a troubleshooting row for Codex's short environment.
- The tool list shown before you sign in describes `route_board`,
  `get_netlist`, `set_board_rules` and `move_part` as they work now.
- The README lists every HeyPCB tool. The duplicate Environment and
  Development sections are gone.

### HeyPCB's remote server

- `move_part` on a routed board keeps the routing. It takes only the track
  segments the move would leave hanging. Its result names the nets the move
  left open (`unconnected.nets`) and the `route_board` call, with `nets` and
  `groundPlane: false`, that routes only those, keeping every other track,
  via and pour. On an imported board the copper is its author's: the move
  takes none of it, and the result counts what now ends in the air
  (`dangling.new`).
- `get_netlist` gives each net's current grade where its class states a
  current: `ok`, `thin`, `undersized`, `no_width` or `no_layer`, with the
  current, the width, its capacity and the width the current needs.
  `currentGraded: false` means not graded, never a pass.
- `set_board_rules` sets the board's construction and look: `flex` (a
  polyimide FPC board), `coverlay`, `thicknessMm`, `copperOz`, `material`,
  `maskColor`, `silkColor` and `finish`. On a flex board, `fab: "jlcpcb"`
  applies JLCPCB's FPC rules.
- `get_board` names all of a board's stages, including `artwork` (artwork and
  no parts) and `unmeasured` (copper with no DRC of the board as it stands,
  or a read that failed; never a pass).
- HeyPCB's sign-in answer (401) gives Codex users the step to run, from any
  version of this package.

## 0.1.6 and earlier

Each earlier release is described by its release commit in this
repository's history.
