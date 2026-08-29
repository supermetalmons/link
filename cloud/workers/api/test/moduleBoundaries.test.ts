import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import * as entrypoint from "../src/workerHandler.ts";
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

test("canonical D1 modules have no direct Firestore runtime dependency", () => {
  for (const filename of [
    "authIdentityCanonical.ts",
    "gameplayCanonicalRepository.ts",
    "profileCanonicalD1.ts",
  ]) {
    const source = readFileSync(
      resolve(import.meta.dirname, "../src", filename),
      "utf8",
    );
    assert.doesNotMatch(
      source,
      /(?:authFirestore|firestoreRest|createGoogleAccessToken|firestore\.googleapis\.com)/,
      filename,
    );
  }
});
