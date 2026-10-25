import {
  authMetadataFixture,
  authResultFixture,
} from "./profileDataBoundaryFixture.ts";
import assert from "node:assert/strict";
import test from "node:test";
import {
  assertAuthOperationContext,
  canCompleteVerifyOperation,
  createVerifyOperationMeta,
  isAuthOperationReplayExpired,
  readVerifyOperationMeta,
  verifyReplayState,
} from "../src/authOperationReplay.ts";
import { AuthApiFailure } from "../src/authErrors.ts";
import type { LinkInput } from "../src/authIdentity.ts";
import { hashMethodValue } from "../src/authPolicy.ts";
import type { CanonicalAuthOperationSnapshot } from "../src/profileCanonicalD1.ts";

const input: LinkInput = {
  uid: "login",
  method: "x",
  methodValueRaw: "social-user",
  normalizedMethodValue: "social-user",
  opId: "operation",
  requestAura: null,
  requestEmoji: 1,
};
const result = {
  ok: true,
  uid: input.uid,
  profileId: "profile",
  username: "Player",
  linkedMethods: { apple: false, eth: false, sol: false, x: true },
  appleLinked: false,
  emoji: 1,
  opId: input.opId,
};

function operation(
  overrides: Partial<CanonicalAuthOperationSnapshot> = {},
): CanonicalAuthOperationSnapshot {
  return {
    operationId: input.opId,
    kind: "verify",
    method: input.method,
    loginUid: input.uid,
    status: "success",
    meta: authMetadataFixture(createVerifyOperationMeta(input)),
    result: authResultFixture(result),
    errorCode: null,
    errorMessage: null,
    startedAtMs: 1_000,
    updatedAtMs: 1_000,
    revision: 1,
    ...overrides,
  };
}

test("preserves serialized verify metadata and permissive legacy decoding", () => {
  for (const method of ["apple", "x", "eth", "sol"] as const) {
    const meta = createVerifyOperationMeta({ ...input, method });
    assert.equal(
      JSON.stringify(meta),
      JSON.stringify({
        methodValue:
          method === "apple" || method === "x"
            ? "redacted"
            : input.methodValueRaw,
        methodValueHash: hashMethodValue(method, input.normalizedMethodValue),
      }),
    );
    assert.equal(
      createVerifyOperationMeta({ ...input, method, intentId: " intent " })
        .intentId,
      " intent ",
    );
  }
  assert.deepEqual(
    readVerifyOperationMeta({
      methodValueHash: " hash ",
      intentId: " intent ",
      extra: true,
    }),
    { methodValueHash: "hash", intentId: "intent" },
  );
  for (const value of [
    null,
    [],
    "invalid",
    { methodValueHash: 5, intentId: false },
  ]) {
    assert.deepEqual(readVerifyOperationMeta(value), {
      methodValueHash: "",
      intentId: "",
    });
  }
});

test("rejects operation context changes while allowing metadata-free replay lookups", () => {
  const stored = operation();
  const expected = {
    kind: "verify" as const,
    method: input.method,
    loginUid: input.uid,
    meta: createVerifyOperationMeta(input),
  };
  assert.doesNotThrow(() => assertAuthOperationContext(stored, expected));
  assert.doesNotThrow(() =>
    assertAuthOperationContext(stored, { ...expected, meta: undefined }),
  );
  for (const changed of [
    { ...expected, kind: "unlink" as const },
    { ...expected, method: "apple" as const },
    { ...expected, loginUid: "other-login" },
    { ...expected, meta: { ...expected.meta, methodValueHash: "other-hash" } },
    { ...expected, meta: { ...expected.meta, intentId: "other-intent" } },
    { ...expected, meta: null },
  ]) {
    assert.throws(
      () => assertAuthOperationContext(stored, changed),
      (error) =>
        error instanceof AuthApiFailure &&
        error.status === 403 &&
        error.code === "permission-denied" &&
        error.message === "op-context-mismatch",
    );
  }
});

test("keeps completed and incomplete verification eligible through the exact replay deadline", () => {
  const deadline = 1_000 + 10 * 60 * 1_000;
  for (const status of ["success", "started", "failed"] as const) {
    const stored = operation({ status });
    const expected = status === "success" ? "completed" : "incomplete";
    assert.equal(verifyReplayState(stored, deadline - 1), expected);
    assert.equal(verifyReplayState(stored, deadline), expected);
    assert.equal(isAuthOperationReplayExpired(stored, deadline), false);
    assert.equal(verifyReplayState(stored, deadline + 1), null);
    assert.equal(isAuthOperationReplayExpired(stored, deadline + 1), true);
  }
});

test("malformed completed results cannot replay but incomplete verification remains recoverable", () => {
  for (const invalidResult of [null, {}, { ok: true, profileId: "profile" }]) {
    assert.equal(
      verifyReplayState(
        operation({ result: authResultFixture(invalidResult) }),
        1_000,
      ),
      null,
    );
    for (const status of ["started", "failed"] as const) {
      const stored = operation({
        status,
        result: authResultFixture(invalidResult),
      });
      assert.equal(verifyReplayState(stored, 1_000), "incomplete");
      assert.equal(
        verifyReplayState({ ...stored, kind: "unlink" }, 1_000),
        null,
      );
      assert.equal(
        canCompleteVerifyOperation(stored, {
          method: input.method,
          normalizedValue: input.normalizedMethodValue,
        }),
        true,
      );
      assert.equal(
        canCompleteVerifyOperation(stored, {
          method: input.method,
          normalizedValue: "replacement-user",
        }),
        false,
      );
      assert.equal(
        canCompleteVerifyOperation(
          { ...stored, kind: "unlink" },
          {
            method: input.method,
            normalizedValue: input.normalizedMethodValue,
          },
        ),
        false,
      );
    }
  }
  assert.equal(
    canCompleteVerifyOperation(operation(), {
      method: input.method,
      normalizedValue: input.normalizedMethodValue,
    }),
    false,
  );
});
