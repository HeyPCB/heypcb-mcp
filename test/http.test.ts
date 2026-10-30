/** anySignal: aborts with the caller's signal, or with a TimeoutError on its own timeout. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { anySignal } from "../src/http.ts";

test("anySignal follows the caller's signal", () => {
  const ctl = new AbortController();
  const s = anySignal(ctl.signal, 60_000);
  ctl.abort(new Error("stop"));
  assert.equal(s.aborted, true);
  assert.equal((s.reason as Error).message, "stop");
});

test("anySignal times out with a TimeoutError", async () => {
  const s = anySignal(new AbortController().signal, 20);
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(s.aborted, true);
  assert.equal((s.reason as Error).name, "TimeoutError");
});

