import { required } from "./fixtures/canonicalData.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import {
  createEmptySessionState,
  createIndexedDbSessionStore,
  SESSION_DATABASE_NAME,
  SessionStorageError,
} from "../src/session/sessionStore.ts";

const flush = () => new Promise((resolve) => setImmediate(resolve));

/**
 * @typedef {{result?: unknown; onsuccess?: () => void}} TestReadRequest
 * @typedef {{aborted: boolean; oncomplete?: () => void; onabort?: () => void; onerror?: () => void;
 * objectStore(name: string): {get(key: string): TestReadRequest; put(value: unknown, key: string): void};
 * read(): void; complete(): void; abort(): void}} TestTransaction
 * @typedef {{closed: boolean; close(): void; transaction(name: string, mode: string): TestTransaction;
 * onversionchange?: () => void; onclose?: () => void}} TestDatabase
 * @typedef {{result?: TestDatabase; onsuccess?: () => void; onerror?: () => void;
 * onblocked?: () => void; onupgradeneeded?: () => void; transaction?: {abort(): void}}} TestOpenRequest
 */
/** @param {unknown} [initial] */
function harness(initial = createEmptySessionState()) {
  let stored = structuredClone(initial);
  /** @type {TestOpenRequest[]} */
  const opens = [];
  /** @type {TestTransaction[]} */
  const transactions = [];
  /** @type {unknown[]} */
  const writes = [];
  /** @type {{open(name: string, version: number): TestOpenRequest}} */
  const factory = {
    open(name, version) {
      assert.equal(name, SESSION_DATABASE_NAME);
      assert.equal(version, 1);
      /** @type {TestOpenRequest} */
      const request = {};
      opens.push(request);
      return request;
    },
  };
  /** @type {ReturnType<typeof createIndexedDbSessionStore>} */
  const store = Reflect.apply(createIndexedDbSessionStore, undefined, [
    () => factory,
  ]);
  const open = (index = opens.length - 1) => {
    /** @type {TestDatabase} */
    const database = {
      closed: false,
      close() {
        this.closed = true;
      },
      transaction(name, mode) {
        assert.equal(name, "state");
        assert.equal(mode, "readwrite");
        assert.equal(this.closed, false);
        /** @type {TestReadRequest} */
        const request = {};
        /** @type {unknown} */
        let pending;
        /** @type {TestTransaction} */
        const transaction = {
          aborted: false,
          objectStore(name) {
            assert.equal(name, "state");
            return {
              get(key) {
                assert.equal(key, "current");
                return request;
              },
              put(value, key) {
                assert.equal(key, "current");
                pending = structuredClone(value);
                writes.push(pending);
              },
            };
          },
          read() {
            request.result = structuredClone(stored);
            required(request.onsuccess).call(request);
          },
          complete() {
            if (!this.aborted && pending) stored = pending;
            required(this.oncomplete).call(this);
          },
          abort() {
            this.aborted = true;
            this.onabort?.();
          },
        };
        transactions.push(transaction);
        return transaction;
      },
    };
    required(opens[index]).result = database;
    const request = required(opens[index]);
    required(request.onsuccess).call(request);
    return database;
  };
  /** @template T @param {Promise<T>} promise @param {number} [index] @returns {Promise<T>} */
  const complete = async (promise, index = transactions.length - 1) => {
    required(transactions[index]).read();
    required(transactions[index]).complete();
    return promise;
  };
  return {
    store,
    factory,
    opens,
    transactions,
    writes,
    open,
    complete,
    stored: () => structuredClone(stored),
  };
}

test("concurrent callers share one open and unchanged updates reuse the connection", async () => {
  const h = harness();
  const first = h.store.update((state) => state);
  const second = h.store.update((state) => ({ ...state }));
  assert.equal(h.opens.length, 1);
  const database = h.open();
  await flush();
  await h.complete(first, 0);
  await h.complete(second, 1);
  const third = h.store.update((state) => state);
  await flush();
  await h.complete(third);
  assert.equal(h.opens.length, 1);
  assert.equal(h.writes.length, 0);
  assert.equal(database.closed, false);
});

test("a missing record persists its generation and later no-op reads retain it", async () => {
  const h = harness(null);
  const first = h.store.update((state) => state);
  h.open();
  await flush();
  const original = await h.complete(first);
  assert.equal(h.writes.length, 1);
  const next = h.store.update((state) => state);
  await flush();
  assert.deepEqual(await h.complete(next), original);
  assert.equal(h.writes.length, 1);
});

test("in-place changes to scalar and nested session state are persisted", async () => {
  const state = createEmptySessionState();
  state.session = {
    sessionId: crypto.randomUUID(),
    refreshSecret: Buffer.alloc(32, 1).toString("base64url"),
    revokeSecret: Buffer.alloc(32, 2).toString("base64url"),
    uid: null,
  };
  const h = harness(state);
  const first = h.store.update((current) => {
    current.revision++;
    required(current.session).uid = "m".repeat(28);
    current.revocations.push({
      sessionId: required(current.session).sessionId,
      revokeSecret: required(current.session).revokeSecret,
    });
    return current;
  });
  h.open();
  await flush();
  const changed = await h.complete(first);
  assert.deepEqual(h.stored(), changed);
  assert.equal(h.writes.length, 1);
  assert.equal(changed.revision, 1);
  assert.equal(required(changed.session).uid, "m".repeat(28));
});

for (const event of /** @type {const} */ (["onversionchange", "onclose"])) {
  test(`${event} closes an idle connection and the next update reopens`, async () => {
    const h = harness();
    const first = h.store.update((state) => state);
    const old = h.open();
    await flush();
    await h.complete(first);
    required(old[event]).call(old);
    assert.equal(old.closed, true);
    const next = h.store.update((state) => state);
    assert.equal(h.opens.length, 2);
    const current = h.open();
    required(old[event]).call(old);
    await flush();
    await h.complete(next);
    assert.equal(current.closed, false);
  });

  test(`${event} aborts pending operations and fences their late read events`, async () => {
    const h = harness();
    let calls = 0;
    const first = h.store.update((state) => {
      calls++;
      return state;
    });
    const rejected = assert.rejects(first, SessionStorageError);
    const old = h.open();
    await flush();
    required(old[event]).call(old);
    await rejected;
    required(h.transactions[0]).read();
    required(h.transactions[0]).complete();
    assert.equal(calls, 0);
    assert.equal(required(h.transactions[0]).aborted, true);
    assert.equal(h.writes.length, 0);
  });
}

for (const event of /** @type {const} */ (["onerror", "onblocked"])) {
  test(`${event} rejects shared opening and closes late success without replacing a new connection`, async () => {
    const h = harness();
    const first = h.store.update((state) => state);
    const second = h.store.update((state) => state);
    const rejected = Promise.all([
      assert.rejects(first, SessionStorageError),
      assert.rejects(second, SessionStorageError),
    ]);
    const request = required(h.opens[0]);
    required(request[event]).call(request);
    await rejected;
    const next = h.store.update((state) => state);
    const current = h.open(1);
    const late = h.open(0);
    await flush();
    await h.complete(next);
    assert.equal(late.closed, true);
    assert.equal(current.closed, false);
    assert.equal(h.transactions.length, 1);
  });
}

test("an abandoned open aborts late schema creation", async () => {
  const h = harness();
  const pending = h.store.update((state) => state);
  const rejected = assert.rejects(pending, SessionStorageError);
  const request = required(h.opens[0]);
  required(request.onblocked).call(request);
  await rejected;
  let aborts = 0;
  required(h.opens[0]).transaction = { abort: () => aborts++ };
  required(request.onupgradeneeded).call(request);
  assert.equal(aborts, 1);
});

test("synchronous open failure is recoverable", async () => {
  const h = harness();
  const open = h.factory.open;
  h.factory.open = () => {
    throw new Error("unavailable");
  };
  await assert.rejects(
    h.store.update((state) => state),
    SessionStorageError,
  );
  h.factory.open = open;
  const next = h.store.update((state) => state);
  h.open();
  await flush();
  await h.complete(next);
});

test("transaction creation failure invalidates the connection without invoking the callback", async () => {
  const h = harness();
  let calls = 0;
  const first = h.store.update((state) => {
    calls++;
    return state;
  });
  const rejected = assert.rejects(first, SessionStorageError);
  const old = h.open();
  old.transaction = () => {
    throw new DOMException("Connection closed", "InvalidStateError");
  };
  await rejected;
  assert.equal(calls, 0);
  assert.equal(old.closed, true);
  const next = h.store.update((state) => state);
  h.open();
  await flush();
  await h.complete(next);
});

test("transaction abort never replays a mutation and a later update opens fresh", async () => {
  const h = harness();
  let calls = 0;
  const first = h.store.update((state) => {
    calls++;
    return { ...state, revision: state.revision + 1 };
  });
  const rejected = assert.rejects(first, SessionStorageError);
  const old = h.open();
  await flush();
  required(h.transactions[0]).read();
  required(h.transactions[0]).abort();
  await rejected;
  assert.equal(calls, 1);
  assert.equal(old.closed, true);
  const stored = h.stored();
  assert.ok(
    stored !== null && typeof stored === "object" && "revision" in stored,
  );
  assert.equal(stored.revision, 0);
  const next = h.store.update((state) => state);
  h.open();
  await flush();
  assert.equal((await h.complete(next)).revision, 0);
  assert.equal(calls, 1);
});

test("open timeout rejects all waiters and closes a late success", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness();
  const pending = h.store.update((state) => state);
  const rejected = assert.rejects(pending, SessionStorageError);
  t.mock.timers.tick(10_000);
  await rejected;
  const next = h.store.update((state) => state);
  h.open(1);
  const late = h.open(0);
  await flush();
  await h.complete(next);
  assert.equal(late.closed, true);
  assert.equal(h.transactions.length, 1);
});

test("the transaction shares the opening operation's 10-second deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness();
  let calls = 0;
  const pending = h.store.update((state) => {
    calls++;
    return state;
  });
  const rejected = assert.rejects(pending, SessionStorageError);
  t.mock.timers.tick(8_000);
  const database = h.open();
  await flush();
  t.mock.timers.tick(2_000);
  await rejected;
  required(h.transactions[0]).read();
  assert.equal(database.closed, true);
  assert.equal(required(h.transactions[0]).aborted, true);
  assert.equal(calls, 0);
});

test("malformed present session rows fail closed before callbacks or writes", async () => {
  const valid = createEmptySessionState();
  for (const value of [
    false,
    0,
    "legacy",
    [],
    {},
    { ...valid, revision: "0" },
    { ...valid, session: undefined },
    { ...valid, revocations: [null] },
    {
      ...valid,
      revocations: [{ sessionId: "invalid", revokeSecret: "invalid" }],
    },
  ]) {
    const h = harness(value);
    let changes = 0;
    const pending = h.store.update((state) => {
      changes++;
      return state;
    });
    const rejected = assert.rejects(pending, SessionStorageError);
    h.open();
    await flush();
    required(h.transactions[0]).read();
    required(h.transactions[0]).complete();
    await rejected;
    assert.equal(changes, 0);
    assert.deepEqual(h.writes, []);
    assert.deepEqual(h.stored(), value);
  }
});

test("validated session rows retain extension evidence and do not write unchanged reads", async () => {
  const state = {
    ...createEmptySessionState(),
    retained: { nested: [null, false] },
  };
  const h = harness(state);
  /** @type {import("../src/session/sessionStore.ts").SessionState | undefined} */
  let observed;
  const pending = h.store.update((value) => {
    observed = value;
    return value;
  });
  h.open();
  await flush();
  const result = await h.complete(pending);
  assert.equal(result, observed);
  assert.deepEqual(result, state);
  assert.deepEqual(h.writes, []);
});
