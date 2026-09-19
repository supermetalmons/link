import assert from "node:assert/strict";
import test from "node:test";
import {
  createEmptySessionState,
  createIndexedDbSessionStore,
  SESSION_DATABASE_NAME,
  SessionStorageError,
} from "../src/session/sessionStore.ts";

const flush = () => new Promise((resolve) => setImmediate(resolve));

function harness(initial = createEmptySessionState()) {
  let stored = structuredClone(initial);
  const opens = [];
  const transactions = [];
  const writes = [];
  const factory = {
    open(name, version) {
      assert.equal(name, SESSION_DATABASE_NAME);
      assert.equal(version, 1);
      const request = {};
      opens.push(request);
      return request;
    },
  };
  const store = createIndexedDbSessionStore(() => factory);
  const open = (index = opens.length - 1) => {
    const database = {
      closed: false,
      close() {
        this.closed = true;
      },
      transaction(name, mode) {
        assert.equal(name, "state");
        assert.equal(mode, "readwrite");
        assert.equal(this.closed, false);
        const request = {};
        let pending;
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
            request.onsuccess();
          },
          complete() {
            if (!this.aborted && pending) stored = pending;
            this.oncomplete();
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
    opens[index].result = database;
    opens[index].onsuccess();
    return database;
  };
  const complete = async (promise, index = transactions.length - 1) => {
    transactions[index].read();
    transactions[index].complete();
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
    current.session.uid = "m".repeat(28);
    current.revocations.push({
      sessionId: current.session.sessionId,
      revokeSecret: current.session.revokeSecret,
    });
    return current;
  });
  h.open();
  await flush();
  const changed = await h.complete(first);
  assert.deepEqual(h.stored(), changed);
  assert.equal(h.writes.length, 1);
  assert.equal(changed.revision, 1);
  assert.equal(changed.session.uid, "m".repeat(28));
});

for (const event of ["onversionchange", "onclose"]) {
  test(`${event} closes an idle connection and the next update reopens`, async () => {
    const h = harness();
    const first = h.store.update((state) => state);
    const old = h.open();
    await flush();
    await h.complete(first);
    old[event]();
    assert.equal(old.closed, true);
    const next = h.store.update((state) => state);
    assert.equal(h.opens.length, 2);
    const current = h.open();
    old[event]();
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
    old[event]();
    await rejected;
    h.transactions[0].read();
    h.transactions[0].complete();
    assert.equal(calls, 0);
    assert.equal(h.transactions[0].aborted, true);
    assert.equal(h.writes.length, 0);
  });
}

for (const event of ["onerror", "onblocked"]) {
  test(`${event} rejects shared opening and closes late success without replacing a new connection`, async () => {
    const h = harness();
    const first = h.store.update((state) => state);
    const second = h.store.update((state) => state);
    const rejected = Promise.all([
      assert.rejects(first, SessionStorageError),
      assert.rejects(second, SessionStorageError),
    ]);
    h.opens[0][event]();
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
  h.opens[0].onblocked();
  await rejected;
  let aborts = 0;
  h.opens[0].transaction = { abort: () => aborts++ };
  h.opens[0].onupgradeneeded();
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
  h.transactions[0].read();
  h.transactions[0].abort();
  await rejected;
  assert.equal(calls, 1);
  assert.equal(old.closed, true);
  assert.equal(h.stored().revision, 0);
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
  h.transactions[0].read();
  assert.equal(database.closed, true);
  assert.equal(h.transactions[0].aborted, true);
  assert.equal(calls, 0);
});
