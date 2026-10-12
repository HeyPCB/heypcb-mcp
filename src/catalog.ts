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
  ["check_board", "Run DRC + ERC, the full verification, or the fab check, with findings."],
  ["route_board", "Autoroute the board and return the result."],
  ["place_parts", "Re-place the board's parts."],
  ["export", "Gerbers, KiCad project, BOM, pick-and-place or STEP as a short-lived download link."],
  ["read_design", "Read the design or a schematic/board file's text for inspection."],
  ["undo", "Undo the last change to a project."],
  ["estimate", "The price of an operation before running it."],
];

export const OFFLINE_CATALOG: Tool[] = NAMES.map(([name, summary]) => ({
  name,
  description: summary + OFFLINE,
  inputSchema: { type: "object", properties: {}, additionalProperties: true },
}));
