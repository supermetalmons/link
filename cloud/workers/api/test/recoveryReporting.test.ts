import assert from "node:assert/strict";
import test from "node:test";
import {
  logRecoveryEvent,
  reportRecoveryFailure,
  type RecoveryFailureContext,
} from "../src/recoveryReporting.ts";
import { MAX_RECORD_KEY_BYTES } from "../src/recordKeys.ts";

const context = {
  event: "recovery_failed",
  scope: "profile-game",
  phase: "claim",
  source: "rating",
  itemIndex: 2,
} satisfies RecoveryFailureContext;

test("recovery failure logs allowlisted identity and bounded cause details", () => {
  const logs: string[] = [];
  const error = Object.assign(
    new Error("claim-failed", {
      cause: Object.assign(new Error("x".repeat(300)), { code: "D1_ERROR" }),
    }),
    { request: { token: "private" }, record: { secret: "private" } },
  );
  const entry = {
    ...context,
    operationId: "invite__match",
    profileId: "profile-1",
    loginUid: "login-1",
    record: { secret: "private" },
  };
  reportRecoveryFailure({ error: (value) => logs.push(value) }, entry, error);
  assert.deepEqual(JSON.parse(logs[0]), {
    ...context,
    operationId: "invite__match",
    profileId: "profile-1",
    loginUid: "login-1",
    code: "claim-failed",
    error: {
      name: "Error",
      message: "claim-failed",
      cause: {
        name: "Error",
        message: "x".repeat(256),
        code: "D1_ERROR",
        truncated: true,
      },
    },
  });
  assert.equal(logs[0].includes("private"), false);
  assert.equal(logs[0].includes("stack"), false);
});

test("recovery failure logs omit malformed IDs and raw non-Error payloads", () => {
  const logs: string[] = [];
  const logger = { error: (value: string) => logs.push(value) };
  for (const value of [
    "",
    " trimmed ",
    "bad#key",
    "bad\nkey",
    "x".repeat(MAX_RECORD_KEY_BYTES + 1),
    "\ud800",
  ]) {
    reportRecoveryFailure(
      logger,
      {
        ...context,
        profileId: value,
        eventId: value,
        inviteId: value,
        operationId: value,
        loginUid: value,
      },
      { token: "private" },
    );
    assert.deepEqual(JSON.parse(logs.at(-1)!), {
      ...context,
      code: "unknown",
      error: { type: "object" },
    });
  }
});

test("recovery logging cannot replace failures or fail on unserializable events", () => {
  const logger = {
    error() {
      throw new Error("logger-failed");
    },
    info() {
      throw new Error("logger-failed");
    },
  };
  assert.doesNotThrow(() =>
    reportRecoveryFailure(logger, context, new Error("original")),
  );
  assert.doesNotThrow(() =>
    logRecoveryEvent(logger, "info", { event: "completed" }),
  );
  const entry: { self?: unknown } = {};
  entry.self = entry;
  assert.doesNotThrow(() => logRecoveryEvent(logger, "error", entry));
});
