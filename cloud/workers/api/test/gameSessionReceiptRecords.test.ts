import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAutomatchReceiptChanges,
  buildAutomatchReplayTasks,
  parseAutomatchReceipt,
} from "../src/automatch/receipts.ts";
import {
  decodeAutomatchReceipt,
  decodeGameSessionMutationReceipt,
  parseGameSessionMutationReceipt,
} from "../src/gameSessionReceiptRecords.ts";
import type {
  AutomatchReceiptView,
  GameSessionMutationReceiptView,
} from "../../../runtime/automatchRecords.js";

const automatchReceipt: AutomatchReceiptView = {
  schemaVersion: 2,
  kind: "automatch-start",
  completedAtMs: 42,
  emojiId: 1,
  aura: "none",
  operationId: "operation",
  requesterUid: "login",
  inviteId: "invite",
  profileProjectionRequestId: "projection",
  telegramProjection: true,
  effects: { state: "enabled" },
  response: {
    ok: true,
    inviteId: "invite",
    mode: "pending",
    matchedImmediately: false,
  },
};
const sessionReceipt: GameSessionMutationReceiptView = {
  schemaVersion: 2,
  kind: "invite-create",
  completedAtMs: 42,
  fingerprint: "fingerprint",
  inviteId: "invite",
  operationId: "operation",
  projectionRequestId: "projection",
  requesterUid: "login",
  effects: { state: "enabled" },
  response: {
    ok: true,
    inviteId: "invite",
    hostId: "login",
    matchId: "invite",
  },
};

test("canonical receipts retain exact committed responses and identities", () => {
  assert.strictEqual(parseAutomatchReceipt(automatchReceipt), automatchReceipt);
  assert.strictEqual(
    parseGameSessionMutationReceipt(sessionReceipt),
    sessionReceipt,
  );
  assert.deepEqual(decodeAutomatchReceipt(automatchReceipt), {
    kind: "valid",
    value: automatchReceipt,
  });
  assert.deepEqual(decodeGameSessionMutationReceipt(sessionReceipt), {
    kind: "valid",
    value: sessionReceipt,
  });
});
test("receipt parsing rejects fractional time, missing fields, unknown fields, legacy versions, and mismatched response kinds", () => {
  for (const patch of [
    { schemaVersion: 1 },
    { completedAtMs: 42.75 },
    { completedAtMs: -1 },
    { operationId: "unsafe/id" },
    { aura: "" },
    { emojiId: "1" },
    { profileProjectionRequestId: undefined },
    { effects: undefined },
    { extra: true },
    { response: { ...automatchReceipt.response, inviteId: "other" } },
  ])
    assert.equal(
      parseAutomatchReceipt({ ...automatchReceipt, ...patch }),
      null,
    );
  for (const patch of [
    { kind: "rematch-propose" },
    { kind: "unknown" },
    { schemaVersion: 1 },
    { completedAtMs: 42.75 },
    { projectionRequestId: undefined },
    { effects: undefined },
    { extra: true },
    { response: { ...sessionReceipt.response, inviteId: "other" } },
  ])
    assert.equal(
      parseGameSessionMutationReceipt({ ...sessionReceipt, ...patch }),
      null,
    );
});
test("receipt reads distinguish explicit absence from corrupt data and unrelated families", () => {
  for (const decode of [
    decodeAutomatchReceipt,
    decodeGameSessionMutationReceipt,
  ]) {
    assert.deepEqual(decode(null), { kind: "missing" });
    for (const invalid of [undefined, false, 0, "receipt", [], {}, [{}]])
      assert.deepEqual(decode(invalid), { kind: "invalid" });
  }
  assert.deepEqual(decodeAutomatchReceipt(sessionReceipt), { kind: "invalid" });
  assert.deepEqual(decodeGameSessionMutationReceipt(automatchReceipt), {
    kind: "invalid",
  });
});
test("retired receipts remain valid replay evidence without recreating projection tasks", () => {
  const retired: AutomatchReceiptView = {
    ...automatchReceipt,
    effects: {
      state: "retired",
      retiredAtMs: 100,
      sourceDigest: "a".repeat(64),
    },
  };
  assert.strictEqual(parseAutomatchReceipt(retired), retired);
  assert.equal(buildAutomatchReplayTasks(retired), null);
  assert.ok(
    buildAutomatchReplayTasks(automatchReceipt)?.profileGameProjectionTask,
  );
  assert.deepEqual(retired.response, automatchReceipt.response);
});
test("receipt commands carry explicit effects and a separate exact expiration record", () => {
  const changes = buildAutomatchReceiptChanges(
    "login",
    { operationId: "operation", emojiId: 1, aura: "none" },
    automatchReceipt.response,
    "projection",
    true,
  );
  assert.equal(changes.length, 1);
  const change = changes[0]!;
  assert.equal(change.kind, "mutation-receipt");
  if (change.kind !== "mutation-receipt") throw new Error("receipt-required");
  assert.equal(change.value.schemaVersion, 2);
  assert.deepEqual(change.value.effects, { state: "enabled" });
  assert.deepEqual(change.expiration, {
    schemaVersion: 1,
    completedAtMs: { kind: "timestamp" },
  });
  assert.equal(parseAutomatchReceipt(change.value), null);
});
