import assert from "node:assert/strict";
import test from "node:test";
import {
  parseEventTransitionReceipt,
  serializeEventTransitionReceipt,
  normalizeEventTransitionReceiptRow,
} from "../src/eventTransitionReceipts.ts";

const receipt = {
  schemaVersion: 1,
  transitionId: "et_preserved",
  eventId: "event-one",
  expectedRevision: 3,
};

test("complete historical receipt variants preserve canonical identity bytes", () => {
  const expected =
    '{"eventId":"event-one","expectedRevision":3,"schemaVersion":1,"transitionId":"et_preserved"}';
  assert.equal(serializeEventTransitionReceipt(receipt), expected);
  assert.deepEqual(parseEventTransitionReceipt(receipt), receipt);
  const current = {
    ...receipt,
    schemaVersion: 2,
    payloadDigest: "a".repeat(64),
  };
  const parsed = parseEventTransitionReceipt(current);
  assert.notStrictEqual(parsed, current);
  assert.deepEqual(parsed, current);
  assert.equal(
    serializeEventTransitionReceipt({
      payloadDigest: current.payloadDigest,
      expectedRevision: 3,
      eventId: "event-one",
      transitionId: "et_preserved",
      schemaVersion: 2,
    }),
    serializeEventTransitionReceipt(current),
  );
});

test("receipt decoders reject extensions, partial records and unsupported variants", () => {
  for (const value of [
    null,
    [],
    {},
    { ...receipt, extra: true },
    { ...receipt, schemaVersion: 3 },
    { ...receipt, payloadDigest: "a".repeat(64) },
    { ...receipt, schemaVersion: 2 },
    { ...receipt, expectedRevision: "3" },
    { ...receipt, eventId: " event-one" },
    { ...receipt, schemaVersion: 2, payloadDigest: "invalid" },
  ]) {
    assert.throws(
      () => parseEventTransitionReceipt(value),
      /invalid-event-transition-receipt/,
    );
  }
  assert.throws(
    () => parseEventTransitionReceipt(receipt, "different"),
    /invalid-event-transition-receipt/,
  );
});

test("row construction preserves recorded time, version and original operation digest", () => {
  for (const value of [
    receipt,
    { ...receipt, schemaVersion: 2, payloadDigest: "a".repeat(64) },
  ]) {
    const row = normalizeEventTransitionReceiptRow(
      receipt.transitionId,
      value,
      1234,
    );
    assert.equal(row.recorded_at_ms, 1234);
    assert.equal(row.schema_version, value.schemaVersion);
    assert.equal(
      row.payload_digest,
      "payloadDigest" in value ? value.payloadDigest : null,
    );
    assert.deepEqual(JSON.parse(row.receipt_json), value);
  }
  assert.throws(
    () => normalizeEventTransitionReceiptRow(receipt.transitionId, receipt, -1),
    /invalid-event-transition-receipt/,
  );
});
