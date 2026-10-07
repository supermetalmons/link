"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  omitKeys,
  preserveSendEvidence,
  readDelivery,
  readPendingDelete,
  resolvePendingDeleteId,
  writeCleanup,
  writeDelivery,
} = require("../runtime/telegram/deliveryState");

const retry = {
  retryStartedAtMs: 1_000,
  retryDeadlineAtMs: 601_000,
  retryAtMs: 2_000,
  retrySequence: 1,
};

test("delivery views retain historical encodings and untouched fields", () => {
  const source = {
    status: "historical-status",
    revision: " revision-1 ",
    attempts: "2",
    leaseOwner: " owner-1 ",
    leaseExpiresAtMs: "1500.5",
    retryStartedAtMs: "0",
    retryDeadlineAtMs: null,
    retrySequence: "3",
    sendInFlight: true,
    future: { version: 7, nested: [null, { keep: true }] },
    pendingDelete: {
      status: "historical-cleanup",
      chatId: "chat-1",
      messageId: "42",
      retryStartedAtMs: "0",
      retrySequence: null,
      future: { keep: true },
    },
  };
  const original = structuredClone(source);
  const delivery = readDelivery(source);
  assert.equal(delivery.kind, "legacy");
  assert.equal(delivery.revision, " revision-1 ");
  assert.equal(delivery.matchesRevision("revision-1"), true);
  assert.equal(delivery.attempts, 0);
  assert.equal(delivery.leaseOwner, "owner-1");
  assert.equal(delivery.leaseExpiresAtMs, 1500.5);
  assert.equal(delivery.retryTimestampOr("retryStartedAtMs", 9_000), 0);
  assert.equal(delivery.retryTimestampOr("retryDeadlineAtMs", 9_000), 9_000);
  assert.equal(delivery.retrySequenceOr(9), 0);
  assert.equal(Boolean(delivery.sendInFlight), true);
  assert.equal(delivery.pendingDelete.kind, "legacy");
  assert.equal(delivery.pendingDelete.retrySequenceOr(9), 9);
  assert.equal(readPendingDelete(null).kind, "missing");
  assert.equal(
    resolvePendingDeleteId(delivery.pendingDelete),
    resolvePendingDeleteId(source.pendingDelete),
  );
  assert.deepEqual(delivery.source, original);
  assert.deepEqual(source, original);
});

test("typed transitions preserve unknown fields and explicit omissions", () => {
  const original = {
    status: "processing",
    revision: "revision-1",
    attempts: 1,
    leaseOwner: "owner-1",
    leaseExpiresAtMs: 60_000,
    apiGateOwner: "gate-1",
    future: { keep: true },
    explicitNull: null,
    pendingDelete: {
      status: "processing",
      leaseOwner: "cleanup-owner",
      leaseExpiresAtMs: 60_000,
      chatId: "chat-1",
      messageId: 42,
      future: { keep: true },
    },
  };
  const snapshot = readDelivery(original);
  const cleanup = writeCleanup({
    ...omitKeys(snapshot.pendingDelete, ["leaseOwner", "leaseExpiresAtMs"]),
    status: "retryable",
    ...retry,
  });
  const next = writeDelivery({
    ...omitKeys(snapshot, ["leaseOwner", "leaseExpiresAtMs"]),
    status: "retryable",
    revision: "revision-1",
    ...retry,
    pendingDelete: cleanup,
  });
  assert.deepEqual(next.future, original.future);
  assert.deepEqual(next.pendingDelete.future, original.pendingDelete.future);
  assert.equal(next.explicitNull, null);
  assert.equal(next.apiGateOwner, "gate-1");
  assert.equal(Object.hasOwn(next, "leaseOwner"), false);
  assert.equal(Object.hasOwn(next.pendingDelete, "leaseOwner"), false);
  assert.equal(Object.hasOwn(next, "source"), false);
  assert.equal(Object.hasOwn(next.pendingDelete, "source"), false);
  assert.equal(original.leaseOwner, "owner-1");
  assert.deepEqual(JSON.parse(JSON.stringify(next)), next);
});

test("uncertain transitions preserve malformed evidence and absent fields", () => {
  for (const evidence of [
    true,
    "interrupted",
    ["legacy"],
    { future: true },
    null,
  ]) {
    const next = writeDelivery({
      status: "uncertain",
      revision: "revision-1",
      sendInFlight: preserveSendEvidence(evidence),
    });
    assert.deepEqual(next.sendInFlight, evidence);
    assert.deepEqual(JSON.parse(JSON.stringify(next)), next);
  }
  const absent = writeDelivery({
    status: "uncertain",
    revision: "revision-1",
    sendInFlight: preserveSendEvidence(undefined, false),
  });
  assert.equal(Object.hasOwn(absent, "sendInFlight"), false);
});
