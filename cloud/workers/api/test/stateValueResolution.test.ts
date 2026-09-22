import assert from "node:assert/strict";
import test from "node:test";
import { resolveAutomatchServerValues } from "../src/automatchD1.ts";
import {
  GameSessionTransitionFailure,
  resolveValue as resolveSessionValue,
} from "../src/gameSessionCodec.ts";

test("session and automatch resolution preserve nested markers and array baselines", () => {
  const current = { count: 3, values: [4, "unknown"] };
  const value = {
    count: { ".sv": { increment: 2 } },
    values: [{ ".sv": { increment: -0.5 } }, { ".sv": { increment: 2 } }],
    updatedAtMs: { ".sv": "timestamp" },
  };
  const expected = { count: 5, values: [3.5, 2], updatedAtMs: 123 };
  assert.deepEqual(resolveSessionValue(value, current, 123), expected);
  assert.deepEqual(resolveAutomatchServerValues(value, current, 123), expected);
  assert.deepEqual(current, { count: 3, values: [4, "unknown"] });
});

test("marker failures retain each caller's published error", () => {
  for (const value of [
    { ".sv": { increment: "1" } },
    { ".sv": "timestamp", extra: true },
    { ".sv": { increment: Number.MAX_VALUE } },
  ]) {
    assert.throws(() => resolveSessionValue(value, Number.MAX_VALUE, 123), {
      constructor: GameSessionTransitionFailure,
      message: "game-session-transition-invalid-server-value",
    });
  }
  assert.throws(
    () => resolveAutomatchServerValues({ ".sv": { increment: "1" } }, 2, 123),
    { constructor: TypeError, message: "invalid-automatch-server-value" },
  );
  assert.throws(
    () =>
      resolveAutomatchServerValues({ ".sv": "timestamp", extra: true }, 2, 123),
    { constructor: TypeError, message: "invalid-automatch-server-value" },
  );
  assert.throws(
    () =>
      resolveAutomatchServerValues(
        { ".sv": { increment: Number.MAX_VALUE } },
        Number.MAX_VALUE,
        123,
      ),
    { constructor: TypeError, message: "invalid-automatch-increment" },
  );
});

test("caller-specific current-value lookup remains unchanged", () => {
  const current = Object.create({ count: 7 });
  const value = { count: { ".sv": { increment: 1 } } };
  assert.deepEqual(resolveSessionValue(value, current, 123), { count: 8 });
  assert.deepEqual(resolveAutomatchServerValues(value, current, 123), {
    count: 1,
  });
});
