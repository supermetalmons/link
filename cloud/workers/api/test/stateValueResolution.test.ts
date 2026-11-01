import assert from "node:assert/strict";
import test from "node:test";
import type {
  SessionCounter,
  SessionTimestamp,
} from "../../../runtime/automatchRecords.js";
import {
  SESSION_TIMESTAMP,
  resolveSessionCounter,
  resolveSessionTimestamp,
  sessionIncrement,
} from "../src/sessionValueOperations.ts";

test("typed session operations preserve numeric timestamps and increment baselines", () => {
  assert.deepEqual(SESSION_TIMESTAMP, { kind: "timestamp" });
  assert.deepEqual(sessionIncrement(-0.5), { kind: "increment", delta: -0.5 });
  assert.equal(resolveSessionTimestamp(SESSION_TIMESTAMP, 123), 123);
  assert.equal(resolveSessionTimestamp(45, 123), 45);
  assert.equal(resolveSessionCounter(sessionIncrement(-0.5), 2), 1.5);
  assert.equal(resolveSessionCounter(45, 2), 45);
  for (const current of [null, undefined, "2", false, NaN, Infinity])
    assert.equal(resolveSessionCounter(sessionIncrement(2), current), 2);
  assert.throws(() => sessionIncrement(Infinity), TypeError);
  assert.throws(() => sessionIncrement(NaN), TypeError);
});

test("typed fields reject retired markers, wrong operations and extra fields", () => {
  for (const value of [
    null,
    [],
    {},
    { ".sv": "timestamp" },
    { kind: "increment", delta: 1 },
    { kind: "timestamp", extra: true },
  ])
    assert.throws(
      () => resolveSessionTimestamp(value as SessionTimestamp, 123),
      { constructor: TypeError, message: "invalid-automatch-server-value" },
    );
  for (const value of [
    null,
    [],
    {},
    { ".sv": { increment: 1 } },
    { kind: "timestamp" },
    { kind: "increment", delta: "1" },
    { kind: "increment", delta: NaN },
    { kind: "increment", delta: Infinity },
    { kind: "increment", delta: 1, extra: true },
  ])
    assert.throws(() => resolveSessionCounter(value as SessionCounter, 2), {
      constructor: TypeError,
      message: "invalid-automatch-server-value",
    });
  assert.throws(
    () =>
      resolveSessionCounter(
        sessionIncrement(Number.MAX_VALUE),
        Number.MAX_VALUE,
      ),
    { constructor: TypeError, message: "invalid-automatch-increment" },
  );
});
