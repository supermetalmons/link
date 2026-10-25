import assert from "node:assert/strict";
import test from "node:test";
import { sha256Hex } from "../src/canonicalJson.ts";
import {
  parseEventTransitionReceipt,
  serializeEventTransitionReceipt,
} from "../src/eventTransitionReceipts.ts";

const receipt = {
  schemaVersion: 1,
  transitionId: "et_legacy",
  eventId: "event-one",
  expectedRevision: 3,
};
const invalidReceipt = { message: "invalid-event-transition-receipt" };

test("receipt serialization preserves canonical bytes, digest and deep cloning", async () => {
  const value = {
    ...receipt,
    extra: { z: -0, a: ["é", "\ud800", null, false], "2": 2, "10": 10 },
  };
  const expected =
    '{"eventId":"event-one","expectedRevision":3,"extra":{"10":10,"2":2,"a":["é","\\ud800",null,false],"z":0},"schemaVersion":1,"transitionId":"et_legacy"}';
  assert.equal(serializeEventTransitionReceipt(value), expected);
  assert.equal(
    await sha256Hex(serializeEventTransitionReceipt(value)),
    "e5f4575409f75a2fad794f08d6fca23cf4a35470c4b6de4afdffd9e02b8234c1",
  );
  const reordered = {
    extra: { "10": 10, "2": 2, a: ["é", "\ud800", null, false], z: 0 },
    expectedRevision: 3,
    eventId: "event-one",
    transitionId: "et_legacy",
    schemaVersion: 1,
  };
  assert.equal(serializeEventTransitionReceipt(reordered), expected);
  const parsed = parseEventTransitionReceipt(value);
  assert.notStrictEqual(parsed, value);
  assert.notStrictEqual(Reflect.get(parsed, "extra"), value.extra);
  assert.deepEqual(parsed, JSON.parse(expected));
});

test("receipts retain dense-array traversal and plain-object validation", () => {
  for (const extra of [
    new Array(1),
    [undefined],
    Object.create({ inherited: true }),
    new Date(0),
    Object(1),
    { toJSON: () => "replacement" },
  ]) {
    assert.throws(
      () => parseEventTransitionReceipt({ ...receipt, extra }),
      invalidReceipt,
    );
  }
  const nullPrototype = Object.assign(Object.create(null), { z: 2, a: 1 });
  const hiddenToJson = Object.defineProperty({ z: 2, a: 1 }, "toJSON", {
    value() {
      throw new Error("toJSON-must-not-run");
    },
  });
  for (const extra of [nullPrototype, hiddenToJson]) {
    assert.deepEqual(
      Reflect.get(parseEventTransitionReceipt({ ...receipt, extra }), "extra"),
      {
        a: 1,
        z: 2,
      },
    );
  }
  const customIterator = Object.defineProperty([1], Symbol.iterator, {
    value: function* () {
      yield 2;
    },
  });
  assert.deepEqual(
    Reflect.get(
      parseEventTransitionReceipt({ ...receipt, extra: customIterator }),
      "extra",
    ),
    [2],
  );
});

test("receipts preserve getter ordering and domain error boundaries", () => {
  const failure = new Error("property-unavailable");
  assert.throws(
    () =>
      parseEventTransitionReceipt({
        ...receipt,
        get eventId() {
          throw failure;
        },
      }),
    (error) => error === failure,
  );
  const reads: string[] = [];
  const extra = {
    get z() {
      reads.push("z");
      return 1;
    },
    get a() {
      reads.push("a");
      throw failure;
    },
  };
  assert.throws(
    () => parseEventTransitionReceipt({ ...receipt, extra }),
    invalidReceipt,
  );
  assert.deepEqual(reads, ["a"]);
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  assert.throws(
    () => parseEventTransitionReceipt({ ...receipt, extra: circular }),
    invalidReceipt,
  );
});
