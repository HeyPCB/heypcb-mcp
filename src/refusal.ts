/**
 * The HeyPCB public API's refusal shape,
 * `{ ok:false, code, error, fix, retryable }`, which this package's own
 * refusals share: `error` says what happened in one sentence,
 * `fix` says what clears it — written for the AI agent reading it, naming a
 * command, a tool or a Settings control, never internals.
 *
 * A refusal reaches the agent as a tool result with `isError: true`, the JSON
 * as its text and as `structuredContent`, exactly as the remote server's own
 * refusals do — so an agent reads both the same way.
 */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export type Refusal = {
  ok: false;
  code: string;
  error: string;
  fix: string;
  retryable: boolean;
  [extra: string]: unknown;
};

export function refusal(code: string, error: string, fix: string, extra: Record<string, unknown> = {}): Refusal {
  return { ok: false, code, error, fix, retryable: false, ...extra };
}

export class RefusalError extends Error {
  readonly refusal: Refusal;
  constructor(r: Refusal) {
    super(`${r.code}: ${r.error}`);
    this.name = "RefusalError";
    this.refusal = r;
  }
}

export function refusalResult(r: Refusal): CallToolResult {
  return { isError: true, content: [{ type: "text", text: JSON.stringify(r) }], structuredContent: r };
}

export function okResult(body: Record<string, unknown>): CallToolResult {
  const out = { ok: true, ...body };
  return { content: [{ type: "text", text: JSON.stringify(out) }], structuredContent: out };
}

/** A `{ ok:false, code, error, fix }` body read off a response, or null. */
export function asRefusal(body: unknown, status?: number): Refusal | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (b.ok !== false || typeof b.code !== "string") return null;
  return {
    ...b,
    ok: false,
    code: b.code,
    error: typeof b.error === "string" ? b.error : `HeyPCB refused the request (${b.code}).`,
    fix: typeof b.fix === "string" ? b.fix : "",
    retryable: b.retryable === true,
    ...(status ? { status } : {}),
  };
}
