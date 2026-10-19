/**
 * The client side of per-call billing. HeyPCB prices and charges each call;
 * this only keeps the person running the agent in control of the total:
 *
 * - a cap for this server process, `--max-spend <amount>` on the command
 *   line that starts it (in the units HeyPCB bills in). Once the session has
 *   spent it, a call is refused here, before it is sent — except the tools
 *   HeyPCB never charges for (FREE_TOOLS), which still go, with maxCost 0;
 * - a per-call cap, `_meta.heypcb.maxCost` on a tools/call. The smaller of
 *   it and what is left of the session cap goes to HeyPCB as
 *   `_meta.heypcb.maxCost`, and HeyPCB refuses a call that would cost more
 *   (it alone knows the price: no extra estimate round trip here);
 * - one idempotency key per logical call (`_meta.heypcb.idempotencyKey`,
 *   kept when the agent sends its own), the same on every retry, so a retry
 *   is never charged twice;
 * - the running total, from `_meta.heypcb.billing = { charged, balance, unit }`
 *   on each result, shown by whoami, and one JSON line per paid call in a
 *   bound workspace's `.heypcb/usage.log`.
 */
import { randomUUID } from "node:crypto";
import { promises as fsp } from "node:fs";
import path from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { refusal, type Refusal } from "./refusal.ts";

/** Account and design reads HeyPCB does not charge for: still usable once the cap is spent. */
export const FREE_TOOLS = new Set(["whoami", "estimate", "list_projects", "get_board", "get_netlist", "get_design_summary", "get_schematic", "get_board_layout", "read_design", "wait_for_turn", "list_history", "get_guide"]);

export type Billing = { charged: number; balance: number | null; unit: string | null };

type HeypcbMeta = Record<string, unknown> & { maxCost?: unknown; idempotencyKey?: unknown; billing?: unknown; revision?: unknown };

/** The `heypcb` object of a `_meta`, or an empty one. */
export function heypcbMeta(meta: unknown): HeypcbMeta {
  const h = (meta as { heypcb?: unknown } | undefined)?.heypcb;
  return h && typeof h === "object" ? (h as HeypcbMeta) : {};
}

export function billingOf(result: CallToolResult): Billing | null {
  const b = heypcbMeta(result._meta).billing as Record<string, unknown> | undefined;
  if (!b || typeof b.charged !== "number" || !Number.isFinite(b.charged)) return null;
  return { charged: b.charged, balance: typeof b.balance === "number" ? b.balance : null, unit: typeof b.unit === "string" ? b.unit : null };
}

function round(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

export class Spend {
  total = 0;
  paidCalls = 0;
  unit: string | null = null;
  balance: number | null = null;

  constructor(readonly cap: number | null) {}

  /**
   * The `_meta` to send with a call: the caller's own, with the idempotency
   * key and the cost cap filled in — or a refusal when the session cap is spent.
   */
  prepare(tool: string, meta: Record<string, unknown> | undefined): { meta: Record<string, unknown> } | { refusal: Refusal } {
    const h = { ...heypcbMeta(meta) };
    const perCall = typeof h.maxCost === "number" && Number.isFinite(h.maxCost) && h.maxCost >= 0 ? h.maxCost : null;
    let maxCost = perCall;
    if (this.cap !== null) {
      const left = round(this.cap - this.total);
      if (left <= 0 && !FREE_TOOLS.has(tool)) {
        return {
          refusal: refusal(
            "spend_cap_reached",
            `This session has spent ${this.total}${this.unit ? " " + this.unit : ""} of its ${this.cap} cap (--max-spend), so the call was not sent.`,
            "Tell the user the cap is reached. Free tools (whoami, estimate, reads of the design, the local tools) still work; a higher cap needs the user to restart the server with a larger --max-spend.",
            { spent: this.total, cap: this.cap, unit: this.unit }
          ),
        };
      }
      maxCost = Math.max(0, maxCost === null ? left : Math.min(maxCost, left));
    }
    if (maxCost !== null) h.maxCost = maxCost;
    else delete h.maxCost;
    if (typeof h.idempotencyKey !== "string" || !h.idempotencyKey) h.idempotencyKey = randomUUID();
    return { meta: { ...(meta ?? {}), heypcb: h } };
  }

  /** Count a result's charge; append it to `usageLog` when given. */
  async record(result: CallToolResult, tool: string, sent: Record<string, unknown>, usageLog?: string): Promise<Billing | null> {
    const b = billingOf(result);
    if (!b) return null;
    if (b.unit) this.unit = b.unit;
    if (b.balance !== null) this.balance = b.balance;
    if (b.charged <= 0) return b;
    this.total = round(this.total + b.charged);
    this.paidCalls++;
    if (usageLog) {
      const line = { at: new Date().toISOString(), tool, charged: b.charged, balance: b.balance, unit: b.unit, idempotencyKey: heypcbMeta(sent).idempotencyKey ?? null, revision: heypcbMeta(result._meta).revision ?? null };
      await fsp.mkdir(path.dirname(usageLog), { recursive: true }).catch(() => {});
      await fsp.appendFile(usageLog, JSON.stringify(line) + "\n").catch(() => {});
    }
    return b;
  }

  summary(): { charged: number; paidCalls: number; unit: string | null; cap: number | null; left: number | null } {
    return { charged: this.total, paidCalls: this.paidCalls, unit: this.unit, cap: this.cap, left: this.cap === null ? null : Math.max(0, round(this.cap - this.total)) };
  }

  line(): string {
    const s = this.summary();
    const u = s.unit ? ` ${s.unit}` : "";
    return `This session (this MCP server process): ${s.charged}${u} charged over ${s.paidCalls} paid call${s.paidCalls === 1 ? "" : "s"}${s.cap !== null ? `; cap ${s.cap}${u}, ${s.left}${u} left` : "; no spend cap (start the server with --max-spend <amount> to set one)"}.`;
  }
}

/** `--max-spend <n>` / `--max-spend=<n>` out of argv: the cap, or an error line. */
export function parseMaxSpend(argv: string[]): { cap: number | null; rest: string[] } | { error: string } {
  const rest: string[] = [];
  let cap: number | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a !== "--max-spend" && !a.startsWith("--max-spend=")) {
      rest.push(a);
      continue;
    }
    const raw = a.includes("=") ? a.slice(a.indexOf("=") + 1) : argv[++i];
    const n = Number(raw);
    if (raw === undefined || raw === "" || !Number.isFinite(n) || n < 0) return { error: `--max-spend needs an amount (a number, 0 or more), not ${JSON.stringify(raw ?? "")}.` };
    cap = n;
  }
  return { cap, rest };
}
