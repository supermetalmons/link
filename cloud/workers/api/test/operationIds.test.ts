import assert from "node:assert/strict";
import test from "node:test";
import {
  isSafeOperationId,
  MAX_OPERATION_ID_BYTES,
} from "../src/operationIds.ts";

test("validates storage-neutral operation IDs by exact UTF-8 bytes", () => {
  assert.equal(isSafeOperationId("operation-1"), true);
  assert.equal(isSafeOperationId("a".repeat(MAX_OPERATION_ID_BYTES)), true);
  assert.equal(isSafeOperationId("é".repeat(MAX_OPERATION_ID_BYTES / 2)), true);
  assert.equal(
    isSafeOperationId("é".repeat(MAX_OPERATION_ID_BYTES / 2 + 1)),
    false,
  );
  for (const value of [
    "",
    ".",
    "..",
    "unsafe/path",
    " surrounded ",
    "__reserved__",
    "\ud800",
  ]) {
    assert.equal(isSafeOperationId(value), false, JSON.stringify(value));
  }
});
