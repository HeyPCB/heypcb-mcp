/**
 * What every REST call the local tools make shares: a non-ok response or a
 * network failure as a refusal the agent can act on, and a request signal
 * that also times out.
 */
import { asRefusal, refusal, type Refusal } from "./refusal.ts";

/** A refusal from a response that was not ok: the API's own when it sent one. */
export async function responseRefusal(res: Response, what: string): Promise<Refusal> {
  const body = await res.json().catch(() => null);
  const passed = asRefusal(body, res.status);
  if (passed) return passed;
  if (res.status === 401 || res.status === 403) {
    return refusal("not_allowed", `HeyPCB refused ${what} (HTTP ${res.status}).`, "Check that this sign-in may use HeyPCB's API (Settings → Devices & API keys), then call the tool again.", { status: res.status });
  }
  if (res.status === 404) return refusal("not_found", `HeyPCB has no ${what.replace(/^the /, "")} for that project.`, "Check the project id with list_projects, then call the tool again.", { status: 404 });
  if (res.status === 429) return refusal("rate_limited", "HeyPCB is asking for fewer requests for a moment.", "Wait a minute, then call the tool again.", { retryable: true, status: 429 });
  if (res.status >= 500) return refusal("server_unavailable", `HeyPCB could not finish ${what} (HTTP ${res.status}).`, "Call the tool again in a minute.", { retryable: true, status: res.status });
  return refusal("refused", `HeyPCB refused ${what} (HTTP ${res.status}).`, "Check the tool's arguments, then call it again.", { status: res.status });
}

export function networkRefusal(err: unknown, what: string): Refusal {
  const timedOut = (err as Error)?.name === "TimeoutError" || (err as Error)?.name === "AbortError";
  return refusal(
    timedOut ? "timed_out" : "network_error",
    timedOut ? `${what} took too long.` : `HeyPCB could not be reached for ${what} (${(err as Error)?.message ?? String(err)}).`,
    "Check this computer's internet connection, then call the tool again.",
    { retryable: true }
  );
}

/** A request that failed before a connection opened sent nothing. */
export function neverSent(err: unknown): boolean {
  const code = ((err as { cause?: { code?: unknown } })?.cause?.code ?? (err as { code?: unknown })?.code) as string | undefined;
  return code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "UND_ERR_CONNECT_TIMEOUT";
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function* chunksOf(body: ReadableStream<Uint8Array> | null): AsyncIterable<Uint8Array> {
  if (!body) return;
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

/** `signal` or a timeout, whichever comes first (AbortSignal.any is Node 20+). */
export function anySignal(signal: AbortSignal, ms: number): AbortSignal {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(new DOMException("The operation timed out.", "TimeoutError")), ms);
  const stop = () => {
    clearTimeout(timer);
    ctl.abort(signal.reason);
  };
  if (signal.aborted) stop();
  else signal.addEventListener("abort", stop, { once: true });
  timer.unref?.();
  return ctl.signal;
}
