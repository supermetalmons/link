"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const {
  omitKeys,
  preserveSendEvidence,
  readDelivery,
  deliveryDocument,
  readPendingDelete,
  resolvePendingDeleteId,
  writeCleanup,
  writeDelivery,
} = require("../runtime/telegram/deliveryState");
const { readTelegramDelivery } = require("../runtime/telegram/recordCodec");
const retry = {
  retryStartedAtMs: 1000,
  retryDeadlineAtMs: 601000,
  retryAtMs: 2000,
  retrySequence: 1,
};
/** @type {import("../runtime/telegram/records").TelegramCleanupDocument} */
const cleanup = {
  status: "processing",
  pendingDeleteId: "cleanup",
  chatId: "chat",
  messageId: 42,
  instanceKey: "old",
  leaseOwner: "cleanup-owner",
  leaseExpiresAtMs: 60000,
};
test("delivery views preserve validated lifecycle fields without coercion", () => {
  /** @type {import("../runtime/telegram/records").TelegramDeliveryDocument} */
  const source = {
    status: "processing",
    revision: "revision",
    attempts: 2,
    leaseOwner: "owner",
    leaseExpiresAtMs: 1500,
    ...retry,
    pendingDelete: cleanup,
  };
  assert.ok(readTelegramDelivery(source));
  const snapshot = readDelivery(source);
  assert.equal(snapshot.kind, "processing");
  assert.equal(snapshot.attempts, 2);
  assert.equal(snapshot.leaseOwner, "owner");
  assert.equal(snapshot.retrySequenceOr(9), 1);
  assert.equal(snapshot.pendingDelete.kind, "processing");
  assert.equal(resolvePendingDeleteId(snapshot.pendingDelete), "cleanup");
  assert.equal(readPendingDelete(null).kind, "missing");
  assert.deepEqual(deliveryDocument(snapshot), source);
  for (const patch of [
    { status: "historical" },
    { attempts: "2" },
    { leaseExpiresAtMs: "1500" },
    { future: {} },
  ])
    assert.equal(readTelegramDelivery({ ...source, ...patch }), null);
});
test("typed transitions preserve named metadata and remove expired leases", () => {
  /** @type {import("../runtime/telegram/records").TelegramDeliveryDocument} */
  const source = {
    status: "processing",
    revision: "revision",
    attempts: 1,
    leaseOwner: "owner",
    leaseExpiresAtMs: 60000,
    apiGateOwner: "gate",
    pendingDelete: cleanup,
  };
  const snapshot = readDelivery(source);
  const pendingDelete = writeCleanup({
    ...omitKeys(snapshot.pendingDelete, ["leaseOwner", "leaseExpiresAtMs"]),
    status: "retryable",
    ...retry,
  });
  const next = writeDelivery({
    ...omitKeys(snapshot, ["leaseOwner", "leaseExpiresAtMs"]),
    status: "retryable",
    revision: "revision",
    ...retry,
    pendingDelete,
  });
  assert.equal(next.apiGateOwner, "gate");
  assert.equal(next.leaseOwner, undefined);
  assert.ok(next.pendingDelete);
  assert.equal(next.pendingDelete.leaseOwner, undefined);
  assert.equal(next.pendingDelete.messageId, 42);
  assert.equal(source.leaseOwner, "owner");
  assert.throws(
    () => Reflect.apply(writeDelivery, undefined, [{ ...next, future: {} }]),
    /invalid-telegram-delivery-transition/,
  );
});
test("uncertain transitions require complete typed evidence when present", () => {
  /** @type {import("../runtime/telegram/records").TelegramSendEvidence} */
  const evidence = {
    attemptId: "attempt",
    revision: "revision",
    destination: "community",
    chatId: "chat",
    instanceKey: "instance",
    contentHash: "content",
    startedAtMs: 1,
    apiGateOwner: "send:attempt",
  };
  assert.deepEqual(
    writeDelivery({
      status: "uncertain",
      revision: "revision",
      sendInFlight: preserveSendEvidence(evidence),
    }).sendInFlight,
    evidence,
  );
  assert.equal(
    writeDelivery({
      status: "uncertain",
      revision: "revision",
      sendInFlight: preserveSendEvidence(undefined, false),
    }).sendInFlight,
    undefined,
  );
  for (const malformed of [true, {}, { attemptId: "incomplete" }])
    assert.throws(
      () =>
        writeDelivery({
          status: "uncertain",
          revision: "revision",
          sendInFlight: Reflect.apply(preserveSendEvidence, undefined, [
            malformed,
          ]),
        }),
      /invalid-telegram-delivery-transition/,
    );
});
