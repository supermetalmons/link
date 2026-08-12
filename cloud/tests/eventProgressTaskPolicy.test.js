"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  buildEventProgressFallbackSignalId,
  buildEventProgressTaskId,
  isTaskAlreadyExistsError,
  isTransientEnqueueError,
} = require("../functions/events/progressTaskPolicy");

test("event progress task and fallback identities are stable and scoped", () => {
  const first = buildEventProgressTaskId("event-1", "source-1");

  assert.match(first, /^evp_event-1_[a-f0-9]{24}$/);
  assert.equal(first, buildEventProgressTaskId(" event-1 ", " source-1 "));
  assert.notEqual(first, buildEventProgressTaskId("event-1", "source-2"));
  assert.equal(
    buildEventProgressFallbackSignalId("event-1"),
    buildEventProgressFallbackSignalId(" event-1 "),
  );
});

test("event progress enqueue errors retain duplicate and retry classification", () => {
  assert.equal(
    isTaskAlreadyExistsError({ code: "functions/already-exists" }),
    true,
  );
  assert.equal(
    isTaskAlreadyExistsError({ message: "Task already exists" }),
    true,
  );
  assert.equal(isTaskAlreadyExistsError({ code: "permission-denied" }), false);
  assert.equal(isTransientEnqueueError({ code: 14 }), true);
  assert.equal(isTransientEnqueueError({ message: "connection reset" }), true);
  assert.equal(isTransientEnqueueError({ code: "permission-denied" }), false);
});
