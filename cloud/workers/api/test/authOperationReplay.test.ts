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
import type { CanonicalAuthOperationSnapshot } from "../src/profileCanonical/types.ts";
import { parseVerifyOperationMetadata } from "../src/profileCanonical/contracts.ts";
import { parseCanonicalAuthOperationRow } from "../src/profileCanonical/authRecords.ts";
import { authOperationWriteRow } from "../src/profileCanonical/authRows.ts";

const input: LinkInput = {
  uid: "login",
  method: "x",
  methodValueRaw: "social-user",
  normalizedMethodValue: "social-user",
  opId: "operation",
  requestAura: "none",
  requestEmoji: 1,
};

function operation(
  status: "success" | "started" | "failed" | "cancelled" = "success",
): CanonicalAuthOperationSnapshot {
  const base = {
    operationId: input.opId,
    kind: "verify" as const,
    method: input.method,
    loginUid: input.uid,
    meta: createVerifyOperationMeta(input),
    startedAtMs: 1000,
    updatedAtMs: 1000,
    revision: 1,
    cancelledAtMs: null,
    cancellationReason: null,
  };
  if (status === "success")
    return {
      ...base,
      status,
      result: {
        schemaVersion: 1,
        kind: "verify",
        profileId: "profile",
        uid: input.uid,
        opId: input.opId,
      },
      errorCode: null,
      errorMessage: null,
    };
  if (status === "started")
    return {
      ...base,
      status,
      result: null,
      errorCode: null,
      errorMessage: null,
    };
  if (status === "failed")
    return {
      ...base,
      status,
      result: null,
      errorCode: "unavailable",
      errorMessage: "auth-service-unavailable",
    };
  return {
    ...base,
    status,
    result: null,
    errorCode: "aborted",
    errorMessage: "operation-cancelled",
    cancelledAtMs: 1000,
    cancellationReason: "canonical-data-cutover",
  };
}

test("creates exact verify metadata and rejects malformed stored representations", () => {
  for (const method of ["apple", "x", "eth", "sol"] as const) {
    const meta = createVerifyOperationMeta({ ...input, method });
    assert.deepEqual(meta, {
      methodValue:
        method === "apple" || method === "x"
          ? "redacted"
          : input.methodValueRaw,
      methodValueHash: hashMethodValue(method, input.normalizedMethodValue),
      intentId: null,
    });
    assert.deepEqual(parseVerifyOperationMetadata(meta), meta);
    assert.deepEqual(readVerifyOperationMeta(meta), {
      methodValueHash: meta.methodValueHash,
      intentId: null,
    });
  }
  for (const invalid of [
    null,
    [],
    "invalid",
    { methodValueHash: 5, intentId: false },
    { ...createVerifyOperationMeta(input), extra: true },
  ])
    assert.throws(() => parseVerifyOperationMetadata(invalid));
  assert.deepEqual(readVerifyOperationMeta(null), {
    methodValueHash: "",
    intentId: null,
  });
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
    assertAuthOperationContext(stored, {
      kind: expected.kind,
      method: expected.method,
      loginUid: expected.loginUid,
    }),
  );
  for (const changed of [
    { ...expected, kind: "unlink" as const },
    { ...expected, method: "apple" as const },
    { ...expected, loginUid: "other-login" },
    {
      ...expected,
      meta: { ...expected.meta, methodValueHash: "b".repeat(64) },
    },
    { ...expected, meta: { ...expected.meta, intentId: "other-intent" } },
    { ...expected, meta: null },
  ])
    assert.throws(
      () => assertAuthOperationContext(stored, changed),
      (error) =>
        error instanceof AuthApiFailure &&
        error.status === 403 &&
        error.code === "permission-denied" &&
        error.message === "op-context-mismatch",
    );
});

test("keeps completed and incomplete verification eligible through the exact replay deadline", () => {
  const deadline = 1000 + 10 * 60 * 1000;
  for (const status of ["success", "started", "failed"] as const) {
    const stored = operation(status),
      expected = status === "success" ? "completed" : "incomplete";
    assert.equal(verifyReplayState(stored, deadline - 1), expected);
    assert.equal(verifyReplayState(stored, deadline), expected);
    assert.equal(isAuthOperationReplayExpired(stored, deadline), false);
    assert.equal(verifyReplayState(stored, deadline + 1), null);
    assert.equal(isAuthOperationReplayExpired(stored, deadline + 1), true);
  }
});

test("invalid success receipts fail decoding and cancelled operations cannot recover", () => {
  const row = authOperationWriteRow(operation());
  for (const invalid of [
    null,
    {},
    { ok: true, profileId: "profile" },
    {
      schemaVersion: 1,
      kind: "verify",
      profileId: "profile",
      uid: "other",
      opId: input.opId,
    },
  ])
    assert.throws(() =>
      parseCanonicalAuthOperationRow({
        ...row,
        result_json: invalid === null ? null : JSON.stringify(invalid),
        revision: 1,
      }),
    );
  for (const status of ["started", "failed"] as const) {
    const stored = operation(status);
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
  }
  const cancelled = operation("cancelled");
  assert.equal(verifyReplayState(cancelled, 1000), null);
  assert.equal(
    canCompleteVerifyOperation(cancelled, {
      method: input.method,
      normalizedValue: input.normalizedMethodValue,
    }),
    false,
  );
  assert.equal(
    canCompleteVerifyOperation(operation(), {
      method: input.method,
      normalizedValue: input.normalizedMethodValue,
    }),
    false,
  );
});
