/**
 * Optional server-reported charges and caller spending constraints.
 * Current MCP billing metadata has no advertised enforcement contract, so
 * any supplied cap blocks potentially charged calls before dispatch.
 * Missing charge metadata remains unmeasured. Forwarded logical keys are
 * not evidence of server billing idempotency; lost writes require readback.
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
  measuredCalls = 0;
  unit: string | null = null;
  balance: number | null = null;

  constructor(readonly cap: number | null) {}

  /**
   * The `_meta` to send with a call: the caller's own, with the idempotency
   * key and the cost cap filled in — or a refusal when the session cap is spent.
   */
  prepare(tool: string, meta: Record<string, unknown> | undefined): { meta: Record<string, unknown> } | { refusal: Refusal } {
    const h = { ...heypcbMeta(meta) };
    if (h.maxCost !== undefined && (typeof h.maxCost !== "number" || !Number.isFinite(h.maxCost) || h.maxCost < 0)) {
      return { refusal: refusal("bad_spend_cap", "The call's spending limit is not a nonnegative finite amount.", "Supply a valid limit; nothing was sent.") };
    }
    const perCall = typeof h.maxCost === "number" && Number.isFinite(h.maxCost) && h.maxCost >= 0 ? h.maxCost : null;
    // The current server does not consume these billing metadata caps.
    // A local counter cannot protect a balance when charges are unreported.
    if ((this.cap !== null || perCall !== null) && !FREE_TOOLS.has(tool)) {
      return { refusal: refusal("spend_cap_unsupported", "HeyPCB cannot enforce this call's spending limit through the current MCP server, so the call was not sent.", "Keep the limit in place and use verified free reads or local checks. Run priced work only through a surface that can enforce the budget.", { written: false, retryable: false }) };
    }
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
    this.measuredCalls++;
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

  summary(): { charged: number | null; paidCalls: number | null; unit: string | null; cap: number | null; left: number | null; capEnforced: false } {
    return { capEnforced: false, charged: this.measuredCalls ? this.total : null, paidCalls: this.measuredCalls ? this.paidCalls : null, unit: this.unit, cap: this.cap, left: this.cap === null || !this.measuredCalls ? null : Math.max(0, round(this.cap - this.total)) };
  }

  line(): string {
    const s = this.summary();
    if (!this.measuredCalls) return `This session's charges are unmeasured: the server has supplied no billing metadata.${s.cap !== null ? ` Configured cap ${s.cap}; potentially charged calls are blocked because server-side caps are unsupported.` : ""}`;
    const u = s.unit ? ` ${s.unit}` : "";
    return `This session (this MCP server process): ${s.charged}${u} charged over ${s.paidCalls} paid call${s.paidCalls === 1 ? "" : "s"}${s.cap !== null ? `; requested cap ${s.cap}${u}, potentially charged calls blocked until server enforcement is available` : "; no spend cap"}.`;
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
