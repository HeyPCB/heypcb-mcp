# Changelog

Releases of `@heypcb/mcp`, newest first. HeyPCB's own tools live on its
remote server and change there, whichever version of this package you run.
Each release also lists the tool changes since the previous release that an
agent will notice.

## 0.1.8

### This package

- **`fast-uri` 3.1.9.** The copy of `fast-uri` bundled with the MCP SDK's
  JSON Schema validator moves from 3.1.8 to 3.1.9. The new version fixes
  four advisories: GHSA-wjr9-j795-jxcr, GHSA-w74x-v6f9-j3xg,
  GHSA-xhq7-xmqj-769h and GHSA-333x-w4r6-6crp. None of them could be reached
  in this package. `fast-uri` only resolves references inside tool schemas
  from HeyPCB's own server, and the package checks hosts with the standard
  `URL` parser. Nothing else in the package changed.

### HeyPCB's remote server

- `set_board_rules` accepts smaller rules, down to what JLCPCB builds at all
  for the board's layer count. On 1–2 layers the floor is 0.10 mm track and
  clearance and a 0.25/0.15 mm via with a 0.05 mm ring. On 4 or more layers
  it is 0.09 mm track and clearance, with the same via. The floor was
  0.127 mm with a 0.45/0.30 mm via. A value under the floor is still refused
  (`below_fab_floor`), never clamped. `fab: "jlcpcb"` still applies 0.127 mm
  and 0.45/0.30 mm vias. At JLCPCB, 0.10 mm track and space is still
  standard price. Two of the new values cost more there. A via under 0.45 mm
  across with a 0.20–0.25 mm hole, or any via hole under 0.20 mm, is a paid
  option. 0.09 mm track and space adds 20% to the order on 4–8 layers and
  30% on 10 or more.
- `check_board` handles a clearance finding between pads of the same footprint
  differently. It now suggests `set_board_rules` with a clearance as low as
  0.10 mm, where it used to stop at 0.127 mm.

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
