import assert from "node:assert/strict";
import test from "node:test";
import * as entrypoint from "../src/index.ts";
import { extractIdFromJsonUri } from "../src/helius.ts";
import { handleRequest } from "../src/router.ts";

test("the Worker entrypoint remains a thin exact compatibility facade", () => {
  assert.deepEqual(Object.keys(entrypoint).sort(), [
    "default",
    "extractIdFromJsonUri",
    "handleFetch",
    "handleRequest",
  ]);
  assert.strictEqual(entrypoint.handleRequest, handleRequest);
  assert.strictEqual(entrypoint.extractIdFromJsonUri, extractIdFromJsonUri);
  assert.equal(typeof entrypoint.default.queue, "function");
  assert.equal(typeof entrypoint.default.scheduled, "function");
});
