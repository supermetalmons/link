import { required } from "./fixtures/canonicalData.mjs";
import { applicationStorageKey } from "../src/session/applicationDataStorage.ts";
import assert from "node:assert/strict";
import test from "node:test";

const previousLocalStorage = Object.getOwnPropertyDescriptor(
  globalThis,
  "localStorage",
);
/** @type {Map<string, string>} */
const values = new Map();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: /** @satisfies {Storage} */ ({
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => Array.from(values.keys())[index] ?? null,
    get length() {
      return values.size;
    },
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, String(value)),
  }),
});

const { storage } = await import("../src/utils/storage.ts");
const { withAutomatchOperationLock } =
  await import("../src/connection/automatchOperationLock.ts");
const OPERATION_KEY = applicationStorageKey(
  "pendingAutomatchOperation:login-uid",
);
const OPERATION_ID = "00000000-0000-4000-8000-000000000001";
/** @type {import("../src/utils/storage.ts").PendingAutomatchOperation} */
const VALID_OPERATION = {
  createdAtMs: 1_750_000_000_000,
  operationId: OPERATION_ID,
  request: { emojiId: 7, aura: "rainbow" },
  resolvedInviteId: null,
  uid: "login-uid",
};

test.beforeEach(() => values.clear());

test.after(() => {
  if (previousLocalStorage) {
    Object.defineProperty(globalThis, "localStorage", previousLocalStorage);
  } else {
    Reflect.deleteProperty(globalThis, "localStorage");
  }
});

test("round-trips and defensively reads a pending automatch operation", () => {
  storage.setPendingAutomatchOperation(VALID_OPERATION.uid, VALID_OPERATION);

  /** @type {unknown} */
  const serialized = JSON.parse(required(values.get(OPERATION_KEY)));
  assert.ok(
    serialized !== null &&
      typeof serialized === "object" &&
      "resolvedInviteId" in serialized,
  );
  assert.equal(serialized.resolvedInviteId, null);
  const stored = required(
    storage.getPendingAutomatchOperation(VALID_OPERATION.uid),
  );
  assert.deepEqual(stored, VALID_OPERATION);
  assert.notStrictEqual(stored, VALID_OPERATION);
  assert.notStrictEqual(stored.request, VALID_OPERATION.request);

  stored.request.aura = "none";
  assert.equal(
    required(storage.getPendingAutomatchOperation(VALID_OPERATION.uid)).request
      .aura,
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
    { ...VALID_OPERATION, request: { emojiId: -1, aura: "none" } },
    {
      ...VALID_OPERATION,
      request: { emojiId: Number.MAX_SAFE_INTEGER + 1, aura: "none" },
    },
    { ...VALID_OPERATION, request: { emojiId: 7, aura: 3 } },
    {
      ...VALID_OPERATION,
      request: { emojiId: 7, aura: "none", unexpected: true },
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

test("executes same-user operations serially through the Web-Lock wrapper", async () => {
  /** @type {Map<string, Promise<void>>} */
  const tails = new Map();
  /** @type {string[]} */
  const requestedNames = [];
  /** @type {import("../src/connection/automatchOperationLock.ts").AutomatchOperationLockManager} */
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
  /** @type {Array<number>} */
  const completionOrder = [];

  const results = await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      withAutomatchOperationLock(
        "login-uid",
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
    Array.from({ length: 8 }, () => "mons-automatch:login-uid"),
  );
});

test("fails closed in browsers without Web Locks", async () => {
  let didRun = false;
  await assert.rejects(
    withAutomatchOperationLock(
      "login-uid",
      async () => {
        didRun = true;
      },
      { isBrowser: true, lockManager: null },
    ),
    /automatch-coordination-unavailable/,
  );
  assert.equal(didRun, false);
});
