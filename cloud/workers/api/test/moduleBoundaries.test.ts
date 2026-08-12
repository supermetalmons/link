import assert from "node:assert/strict";
import test from "node:test";
import * as entrypoint from "../src/index.ts";
import {
  extractIdFromJsonUri,
  PRIMARY_COLLECTION_ID,
  SPECIALS_COLLECTION_ID,
} from "../src/helius.ts";
import { handleRequest } from "../src/router.ts";

test("the Worker entrypoint remains a thin exact compatibility facade", () => {
  assert.deepEqual(Object.keys(entrypoint).sort(), [
    "PRIMARY_COLLECTION_ID",
    "SPECIALS_COLLECTION_ID",
    "default",
    "extractIdFromJsonUri",
    "handleRequest",
  ]);
  assert.strictEqual(entrypoint.handleRequest, handleRequest);
  assert.strictEqual(entrypoint.extractIdFromJsonUri, extractIdFromJsonUri);
  assert.strictEqual(entrypoint.PRIMARY_COLLECTION_ID, PRIMARY_COLLECTION_ID);
  assert.strictEqual(entrypoint.SPECIALS_COLLECTION_ID, SPECIALS_COLLECTION_ID);
});
