import { test } from "node:test";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { anySignal } from "../src/http.ts";

/** Keep the process alive while the helper's unref'ed timer runs, with a bounded wait. */
function untilAborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", done);
      reject(new Error("signal did not abort"));
    }, 2_000);
    signal.addEventListener("abort", done, { once: true });
  });
}

test("anySignal releases the parent listener before notifying timeout observers", async (t) => {
  const parent = new AbortController();
  t.after(() => parent.abort());
  const signal = anySignal(parent.signal, 5);
  assert.equal(getEventListeners(parent.signal, "abort").length, 1);
  let listenersAtAbort = -1;
  signal.addEventListener("abort", () => {
    listenersAtAbort = getEventListeners(parent.signal, "abort").length;
  }, { once: true });
  await untilAborted(signal);
  assert.equal(parent.signal.aborted, false);
  assert.ok(signal.reason instanceof DOMException);
  assert.equal(signal.reason.name, "TimeoutError");
  assert.equal(listenersAtAbort, 0);
  assert.equal(getEventListeners(parent.signal, "abort").length, 0);
  const reason = signal.reason;
  parent.abort(new Error("cancelled after timeout"));
  assert.equal(signal.reason, reason, "the first abort reason is retained");
});

test("anySignal does not accumulate parent listeners across repeated timeouts", async (t) => {
  const parent = new AbortController();
  t.after(() => parent.abort());
  for (let i = 0; i < 12; i++) await untilAborted(anySignal(parent.signal, 5));
  assert.equal(parent.signal.aborted, false);
  assert.equal(getEventListeners(parent.signal, "abort").length, 0);
});

test("anySignal propagates parent cancellation before the timeout", async () => {
  const parent = new AbortController();
  const signal = anySignal(parent.signal, 5);
  const reason = new Error("cancelled by caller");
  let notifications = 0;
  signal.addEventListener("abort", () => notifications++, { once: true });
  parent.abort(reason);
  assert.equal(signal.aborted, true);
  assert.equal(signal.reason, reason);
  assert.equal(getEventListeners(parent.signal, "abort").length, 0);
  await delay(15);
  assert.equal(signal.reason, reason);
  assert.equal(notifications, 1);
});

test("anySignal handles an already-aborted parent without adding a listener", () => {
  const parent = new AbortController();
  const reason = new Error("already cancelled");
  parent.abort(reason);
  const signal = anySignal(parent.signal, 5);
  assert.equal(signal.aborted, true);
  assert.equal(signal.reason, reason);
  assert.equal(getEventListeners(parent.signal, "abort").length, 0);
});

test("anySignal timeout preserves unrelated listeners and other active signals", async (t) => {
  const parent = new AbortController();
  t.after(() => parent.abort());
  let notifications = 0;
  const unrelated = () => notifications++;
  parent.signal.addEventListener("abort", unrelated, { once: true });
  const timedOut = anySignal(parent.signal, 5);
  const waiting = anySignal(parent.signal, 10_000);
  await untilAborted(timedOut);
  assert.equal(waiting.aborted, false);
  const remaining = getEventListeners(parent.signal, "abort");
  assert.equal(remaining.length, 2);
  assert.ok(remaining.includes(unrelated));
  assert.equal(notifications, 0);
  const timeoutReason = timedOut.reason;
  const cancellation = new Error("cancel remaining work");
  parent.abort(cancellation);
  assert.equal(waiting.aborted, true);
  assert.equal(waiting.reason, cancellation);
  assert.equal(timedOut.reason, timeoutReason);
  assert.equal(notifications, 1);
  assert.equal(getEventListeners(parent.signal, "abort").length, 0);
});
