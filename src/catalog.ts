/**
 * The remote server's tool NAMES, listed while it cannot be asked (not signed
 * in yet, or unreachable), so an agent still sees what HeyPCB does and gets a
 * refusal that says how to connect when it calls one. As soon as the remote
 * server answers, its own list replaces this one (names, schemas and
 * descriptions 1:1) and the client is told the list changed.
 *
 * Only names and one-line summaries live here — never schemas or logic: the
 * remote server owns those.
 */
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

const OFFLINE = " (HeyPCB is not connected yet: calling this explains how to sign in. The full description arrives once it is.)";

const NAMES: Array<[string, string]> = [
  ["whoami", "Your HeyPCB account, plan, balance and what can run."],
  ["list_projects", "Your HeyPCB boards: id, name, last update, web link."],
  ["create_project", "Create an empty HeyPCB board project."],
  ["build_board", "Design a whole PCB from a plain-language brief: schematic, parts, placement, routing and checks."],
  ["ask_inky", "One turn of Inky, HeyPCB's design agent, on a project: a question or an edit."],
  ["wait_for_turn", "Wait for a running Inky turn and return its result."],
  ["answer_decision", "Answer a decision Inky asked for (for example approve the layout)."],
  ["get_board", "Board facts: layers, size, parts, nets, routed %, DRC/ERC counts, fab readiness, web link."],
  ["get_board_image", "A picture of the PCB (top or bottom), a schematic page or the 3D view."],
  ["check_board", "Run DRC, ERC and the placement check, the full verification, or the fab check, with findings."],
  ["route_board", "Autoroute the board and return the result."],
  ["place_parts", "Re-place the board's parts."],
  ["export", "Gerbers, KiCad project, BOM, pick-and-place or STEP as a short-lived download link."],
  ["read_design", "Read the design or a schematic/board file's text for inspection."],
  ["undo", "Undo the last change to a project."],
  ["estimate", "The price of an operation before running it."],
  // The design harness: your agent designs the board itself with HeyPCB's
  // parts library, proven blocks and checks. Free, rate-limited.
  ["search_parts", "Find real, orderable parts: LCSC stock and price, verified footprints, KiCad symbols."],
  ["get_part", "A part's pins and facts: an LCSC part card, a KiCad symbol's pins, or a part on the board."],
  ["add_parts", "Add parts to the board's design; the board places them."],
  ["remove_parts", "Delete parts from the design and the board."],
  ["set_part_value", "Change one part's value in place."],
  ["source_parts", "Give every unsourced part an orderable LCSC part."],
  ["connect", "Connect pins (REF.PIN) into named nets."],
  ["disconnect", "Remove pins from every net they are on."],
  ["list_blocks", "HeyPCB's proven circuit blocks (USB-C power, regulators, MCU modules…)."],
  ["add_block", "Add a proven circuit block to the design."],
  ["set_net_class", "Set a net class: width, clearance, current, impedance, differential pairs."],
  ["rename_net", "Rename a net."],
  ["set_no_connect", "Toggle a no-connect flag on a pin."],
  ["get_netlist", "Every net with its pins, class and drivers."],
  ["get_design_summary", "The design in one compact read: parts, nets, counts, unsourced parts."],
  ["get_schematic", "One schematic page as text, with the page list."],
  ["get_capable_pins", "Which MCU pins can carry a function (UART, I2C, SPI, PWM…) and are free."],
  // The board layout tools: your agent shapes and lays out the board itself.
  // Free, rate-limited; check_board's findings each name the call that fixes them.
  ["set_board_outline", "Set the board's outline in mm (rect, rounded, circle, polygon…), with corner mounting holes."],
  ["set_board_rules", "Set the copper layers (2 or 4) and the design rules, e.g. JLCPCB's."],
  ["move_part", "Move parts on the board: x/y, a shift, beside a pin, against an edge; refused with where it fits."],
  ["lock_parts", "Pin parts where they are so place_parts keeps them."],
  ["unlock_parts", "Release locked parts."],
  ["add_ground_pour", "Pour the GND plane once routing is finished."],
  ["add_text", "Write text on the board (silkscreen, copper or mask)."],
  ["add_mounting_hole", "Put a screw hole (M2–M4) on the board."],
  ["get_board_layout", "The layout in one read: outline, layers, rules, every part's place, rotation, side and box."],
  // Seeing, placement intent, history, copper and the playbook (2026-10-15).
  ["preview_board", "A CAD view of the board: chosen layers, highlighted nets and parts, open connections, cropped."],
  ["inspect_net", "A net measured: status, copper per layer, vias, every open connection pin to pin."],
  ["inspect_part", "A part measured: place, edge gaps, neighbours, open pins, the nearest cap to each supply pin."],
  ["check_placement", "Grade the placement: decoupling, crystals, connectors at edges; each finding names its fix."],
  ["set_placement_rules", "Say where parts go: edges, locks, caps by a pin, signal chains, rings and grids."],
  ["preview_placement", "Plan a re-place on a copy and show it before anything moves."],
  ["apply_placement", "Land a previewed placement plan exactly, as one undoable change."],
  ["list_history", "Every change the board can go back through, and what redo can put back."],
  ["restore_board", "Put the board back to any point in its history, in one guarded call."],
  ["redo", "Put back changes undo or restore_board took back."],
  ["save_checkpoint", "Save the whole board under a label, past the 50 changes the history keeps."],
  ["delete_checkpoint", "Delete a saved checkpoint."],
  ["rip_up_net", "Delete a net's tracks and vias so it can be routed again."],
  ["add_pour", "Pour copper on any net and layer, once routing is finished."],
  ["remove_pour", "Take a copper pour off the board."],
  ["add_keepout", "Keep an area clear of tracks, vias, pads, pours or parts."],
  ["stitch_vias", "Stitch a net's pours together with a grid of vias."],
  ["tune_lengths", "Match lengths of a bus or a differential pair with meanders, kept only when DRC holds."],
  ["check_routing", "Grade routed copper against pairs, matched lengths and impedance the net classes state."],
  ["tidy_silkscreen", "Re-place every silkscreen designator beside its part, clear of pads and openings."],
  ["rename_part", "Rename a designator everywhere: design, nets, schematic and board."],
  ["tidy_schematic", "Re-lay the schematic's hand-placed symbols with HeyPCB's own layout."],
  ["get_guide", "The playbook for designing a board with these tools yourself."],
  ["stop_turn", "Stop a running Inky turn at its next step."],
];

export const OFFLINE_CATALOG: Tool[] = NAMES.map(([name, summary]) => ({
  name,
  description: summary + OFFLINE,
  inputSchema: { type: "object", properties: {}, additionalProperties: true },
}));
