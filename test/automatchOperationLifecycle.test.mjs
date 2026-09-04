import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const previousLocalStorage = Object.getOwnPropertyDescriptor(
  globalThis,
  "localStorage",
);
const values = new Map();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => Array.from(values.keys())[index] ?? null,
    get length() {
      return values.size;
    },
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, String(value)),
  },
});

const { storage } = await import("../src/utils/storage.ts");
const { withAutomatchOperationLock } =
  await import("../src/connection/automatchOperationLock.ts");
const connectionSource = readFileSync(
  new URL("../src/connection/connection.ts", import.meta.url),
  "utf8",
);

const OPERATION_KEY = "pendingAutomatchOperation:firebase-uid";
const OPERATION_ID = "00000000-0000-4000-8000-000000000001";
const VALID_OPERATION = {
  createdAtMs: 1_750_000_000_000,
  operationId: OPERATION_ID,
  request: { emojiId: 7, aura: "rainbow" },
  resolvedInviteId: null,
  uid: "firebase-uid",
};

const methodSource = (start, end) => {
  const startIndex = connectionSource.indexOf(start);
  const endIndex = connectionSource.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `missing source marker: ${start}`);
  assert.notEqual(endIndex, -1, `missing source marker: ${end}`);
  return connectionSource.slice(startIndex, endIndex);
};

test.beforeEach(() => values.clear());

test.after(() => {
  if (previousLocalStorage) {
    Object.defineProperty(globalThis, "localStorage", previousLocalStorage);
  } else {
    delete globalThis.localStorage;
  }
});

test("round-trips and defensively reads a pending automatch operation", () => {
  storage.setPendingAutomatchOperation(VALID_OPERATION.uid, VALID_OPERATION);

  assert.equal(JSON.parse(values.get(OPERATION_KEY)).resolvedInviteId, null);
  const stored = storage.getPendingAutomatchOperation(VALID_OPERATION.uid);
  assert.deepEqual(stored, VALID_OPERATION);
  assert.notStrictEqual(stored, VALID_OPERATION);
  assert.notStrictEqual(stored.request, VALID_OPERATION.request);

  stored.request.aura = "changed";
  assert.equal(
    storage.getPendingAutomatchOperation(VALID_OPERATION.uid).request.aura,
    "rainbow",
  );

  storage.setPendingAutomatchOperation(VALID_OPERATION.uid, null);
  assert.equal(storage.getPendingAutomatchOperation(VALID_OPERATION.uid), null);
  assert.equal(values.has(OPERATION_KEY), false);
});

test("rejects malformed pending automatch operations", () => {
  const malformed = [
    "not-json",
    null,
    [],
    {},
    { ...VALID_OPERATION, uid: "" },
    { ...VALID_OPERATION, operationId: "invalid" },
    { ...VALID_OPERATION, resolvedInviteId: 7 },
    { ...VALID_OPERATION, resolvedInviteId: "invalid/invite" },
    { ...VALID_OPERATION, createdAtMs: 0 },
    { ...VALID_OPERATION, createdAtMs: 1.5 },
    { ...VALID_OPERATION, request: { emojiId: 0, aura: "" } },
    {
      ...VALID_OPERATION,
      request: { emojiId: Number.MAX_SAFE_INTEGER + 1, aura: "" },
    },
    { ...VALID_OPERATION, request: { emojiId: 7, aura: 3 } },
    {
      ...VALID_OPERATION,
      request: { emojiId: 7, aura: "", unexpected: true },
    },
  ];

  for (const value of malformed) {
    values.set(
      OPERATION_KEY,
      typeof value === "string" ? value : JSON.stringify(value),
    );
    assert.equal(
      storage.getPendingAutomatchOperation(VALID_OPERATION.uid),
      null,
      JSON.stringify(value),
    );
  }
});

test("keeps persisted operations through auth initialization and changes", () => {
  const source = methodSource(
    "public subscribeToAuthChanges(",
    "public getSameProfilePlayerUid(",
  );

  assert.doesNotMatch(source, /PendingAutomatchOperation/);
  assert.doesNotMatch(source, /clearPendingAutomatchRequest/);
});

test("serializes automatch start and cancel through the same user lock", () => {
  const startSource = methodSource(
    "public async automatch(",
    "public async cancelAutomatch(",
  );
  const cancelSource = methodSource(
    "public async cancelAutomatch(",
    "public async removeWaitingNavigationGame(",
  );

  for (const [source, apiCall] of [
    [startSource, "startAutomatchViaApi("],
    [cancelSource, "cancelAutomatchViaApi("],
  ]) {
    const lockIndex = source.indexOf("withAutomatchOperationLock(user.uid");
    const apiIndex = source.indexOf(apiCall);
    assert.notEqual(lockIndex, -1);
    assert.ok(apiIndex > lockIndex);
  }
});

test("executes same-user operations serially through the Web-Lock wrapper", async () => {
  const tails = new Map();
  const requestedNames = [];
  const lockManager = {
    request: (name, callback) => {
      requestedNames.push(name);
      const previous = tails.get(name) ?? Promise.resolve();
      const result = previous.then(() => callback(null));
      tails.set(
        name,
        result.then(
          () => undefined,
          () => undefined,
        ),
      );
      return result;
    },
  };
  let active = 0;
  let maxActive = 0;
  const completionOrder = [];

  const results = await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      withAutomatchOperationLock(
        "firebase-uid",
        async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await Promise.resolve();
          completionOrder.push(index);
          active -= 1;
          return index;
        },
        { isBrowser: true, lockManager },
      ),
    ),
  );

  assert.equal(maxActive, 1);
  assert.deepEqual(results, [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(completionOrder, results);
  assert.deepEqual(
    requestedNames,
    Array.from({ length: 8 }, () => "mons-automatch:firebase-uid"),
  );
});

test("fails closed in browsers without Web Locks", async () => {
  let didRun = false;
  await assert.rejects(
    withAutomatchOperationLock(
      "firebase-uid",
      async () => {
        didRun = true;
      },
      { isBrowser: true, lockManager: null },
    ),
    /automatch-coordination-unavailable/,
  );
  assert.equal(didRun, false);
});

test("retains every successful start until its resolved invite is observed", () => {
  const startSource = methodSource(
    "public async automatch(",
    "public async cancelAutomatch(",
  );
  const reconcileSource = methodSource(
    "private reconcilePendingAutomatchRequest(",
    "private beginConnectAttempt(",
  );
  const clearSource = methodSource(
    "private clearPendingAutomatchRequest(",
    "private getPendingAutomatchRequest(",
  );
  const connectSource = methodSource(
    "public connectToGame(",
    "public tryNavigateWatchOnlyToLatestApprovedMatch(",
  );

  assert.match(
    startSource,
    /if \(!response\.ok\) \{\s*this\.clearPendingAutomatchRequest\(\s*user\.uid,\s*pendingRequest\.operationId,?\s*\);\s*\} else \{\s*storage\.setPendingAutomatchOperation\(user\.uid, \{\s*\.\.\.pendingRequest,\s*resolvedInviteId: response\.inviteId,\s*\}\);\s*\}/,
  );
  assert.match(
    reconcileSource,
    /const pending = storage\.getPendingAutomatchOperation\(uid\)/,
  );
  assert.match(reconcileSource, /withAutomatchOperationLock\(uid/);
  assert.match(
    reconcileSource,
    /pending\.resolvedInviteId === inviteId \|\|\s*pending\.operationId === observedOperationId/,
  );
  assert.match(
    reconcileSource,
    /this\.clearPendingAutomatchRequest\(uid, pending\.operationId\)/,
  );
  assert.match(
    clearSource,
    /const stored = storage\.getPendingAutomatchOperation\(uid\);\s*if \(operationId && stored\?\.operationId !== operationId\) return/,
  );
  assert.match(
    connectSource,
    /this\.reconcilePendingAutomatchRequest\(uid, inviteId, workingInvite\)/,
  );
});

test("keeps queued retries on one operation until resolved-invite cleanup", () => {
  const pendingSource = methodSource(
    "private getPendingAutomatchRequest(",
    "private reconcilePendingAutomatchRequest(",
  );
  const startSource = methodSource(
    "public async automatch(",
    "public async cancelAutomatch(",
  );

  assert.ok(
    pendingSource.indexOf("return stored") <
      pendingSource.indexOf("crypto.randomUUID()"),
  );
  assert.match(
    startSource,
    /storage\.setPendingAutomatchOperation\(user\.uid, \{\s*\.\.\.pendingRequest,\s*resolvedInviteId: response\.inviteId,\s*\}\)/,
  );

  storage.setPendingAutomatchOperation(VALID_OPERATION.uid, VALID_OPERATION);
  const seenOperationIds = [];
  for (let index = 0; index < 8; index += 1) {
    const pending = storage.getPendingAutomatchOperation(VALID_OPERATION.uid);
    seenOperationIds.push(pending.operationId);
    storage.setPendingAutomatchOperation(VALID_OPERATION.uid, {
      ...pending,
      resolvedInviteId: "auto_resolved",
    });
  }
  assert.deepEqual(new Set(seenOperationIds), new Set([OPERATION_ID]));
});

test("clears only the captured operation after a successful cancel", () => {
  const source = methodSource(
    "public async cancelAutomatch(",
    "public async removeWaitingNavigationGame(",
  );

  assert.match(source, /storage\.getPendingAutomatchOperation\(user\.uid\)/);
  assert.match(source, /const operationId = pending\?\.operationId \?\? null/);
  assert.match(
    source,
    /if \(response\.ok && operationId\) \{\s*this\.clearPendingAutomatchRequest\(user\.uid, operationId\);\s*\}/,
  );
});

test("persists a new operation before starting the API request", () => {
  const pendingSource = methodSource(
    "private getPendingAutomatchRequest(",
    "private reconcilePendingAutomatchRequest(",
  );
  const startSource = methodSource(
    "public async automatch(",
    "public async cancelAutomatch(",
  );

  const persistIndex = pendingSource.indexOf(
    "storage.setPendingAutomatchOperation(uid, operation)",
  );
  const unresolvedIndex = pendingSource.indexOf("resolvedInviteId: null");
  const pendingReturnIndex = pendingSource.indexOf("return operation");
  const pendingReadIndex = startSource.indexOf(
    "this.getPendingAutomatchRequest(user.uid)",
  );
  const apiIndex = startSource.indexOf("startAutomatchViaApi(");

  assert.notEqual(unresolvedIndex, -1);
  assert.notEqual(persistIndex, -1);
  assert.notEqual(pendingReturnIndex, -1);
  assert.ok(unresolvedIndex < persistIndex);
  assert.ok(persistIndex < pendingReturnIndex);
  assert.notEqual(pendingReadIndex, -1);
  assert.notEqual(apiIndex, -1);
  assert.ok(pendingReadIndex < apiIndex);
});
