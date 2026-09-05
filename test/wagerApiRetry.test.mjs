import assert from "node:assert/strict";
import test from "node:test";
import { retryWagerApi } from "../src/connection/wagerApiRetry.ts";

test("does not retry a client-update-required response", async () => {
  let calls = 0;
  const failure = Object.assign(new Error("Reload to continue wagering."), {
    code: "client-update-required",
  });
  await assert.rejects(
    retryWagerApi(
      async () => {
        calls += 1;
        throw failure;
      },
      { delay: async () => assert.fail("compatibility error retried") },
    ),
    (error) => error === failure,
  );
  assert.equal(calls, 1);
});

test("retains transient request and proposal retries", async () => {
  let calls = 0;
  const delays = [];
  const result = await retryWagerApi(
    async () => {
      calls += 1;
      if (calls === 1) throw new Error("offline");
      if (calls === 2) return { ok: false, reason: "proposal-unavailable" };
      return { ok: true, count: 3 };
    },
    { delay: async (milliseconds) => delays.push(milliseconds) },
  );
  assert.equal(calls, 3);
  assert.deepEqual(delays, [180, 320]);
  assert.deepEqual(result, { ok: true, count: 3 });
});
