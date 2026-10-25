import assert from "node:assert/strict";
import test from "node:test";
import {
  RematchEndDelivery,
  rematchEndDeliveryStorageKey,
} from "../src/connection/rematchEndDelivery.ts";

const record = {
  loginUid: "login",
  inviteId: "invite",
  matchId: "invite1",
  actorUid: "host",
  operationId: "00000000-0000-4000-8000-000000000001",
};
const key = rematchEndDeliveryStorageKey(record);
const nextRecord = {
  ...record,
  operationId: "00000000-0000-4000-8000-000000000002",
};

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const settle = async () => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

function harness(options = {}) {
  const entries = options.entries ?? new Map();
  const calls = [];
  const confirmed = [];
  const errors = [];
  const timers = new Map();
  let nextTimer = 0;
  let authorized = true;
  let online = options.online ?? true;
  const storage = {
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => entries.set(key, value),
    removeItem: (key) => entries.delete(key),
  };
  const delivery = new RematchEndDelivery(options.scope ?? record, {
    storage: options.storage === undefined ? storage : options.storage,
    isAuthorized: () => authorized,
    isOnline: () => online,
    submit: async (value) => {
      calls.push(value);
      if (options.storage === undefined) {
        assert.equal(
          JSON.parse(entries.get(key)).record.operationId,
          value.operationId,
        );
      }
      return options.submit?.(value);
    },
    onError: (error) => errors.push(error),
    onConfirmed: (value) => confirmed.push(value),
    setTimer: (callback, delayMs) => {
      const id = ++nextTimer;
      timers.set(id, { callback, delayMs });
      return id;
    },
    clearTimer: (id) => timers.delete(id),
  });
  return {
    delivery,
    entries,
    calls,
    confirmed,
    errors,
    timers,
    setAuthorized: (value) => (authorized = value),
    setOnline: (value) => (online = value),
    fireTimer() {
      const [id, timer] = timers.entries().next().value;
      timers.delete(id);
      timer.callback();
      return timer.delayMs;
    },
  };
}

test("end persists before submission and clears only after confirmation", async () => {
  const pending = deferred();
  const h = harness({ submit: () => pending.promise });
  assert.equal(h.delivery.accept(record), true);
  assert.deepEqual(JSON.parse(h.entries.get(key)).record, record);
  assert.deepEqual(h.delivery.pending, record);
  assert.deepEqual(h.confirmed, []);
  pending.resolve();
  await settle();
  assert.equal(h.delivery.pending, null);
  assert.equal(h.entries.has(key), false);
  assert.deepEqual(h.confirmed, [record]);
});

test("offline acceptance survives reload and resumes with the original operation", async () => {
  const initial = harness({ online: false });
  assert.equal(initial.delivery.accept(record), true);
  assert.equal(initial.calls.length, 0);
  const reloaded = harness({ entries: initial.entries });
  assert.deepEqual(reloaded.delivery.pending, record);
  assert.equal(reloaded.calls.length, 0);
  reloaded.delivery.refresh();
  await settle();
  assert.deepEqual(reloaded.calls, [record]);
  assert.equal(initial.entries.has(key), false);
});

test("repeated clicks and wake events keep one in-flight operation", async () => {
  const pending = deferred();
  const h = harness({ submit: () => pending.promise });
  h.delivery.accept(record);
  assert.equal(h.delivery.accept(nextRecord), true);
  h.delivery.refresh();
  h.delivery.refresh();
  assert.deepEqual(h.calls, [record]);
  assert.deepEqual(h.delivery.pending, record);
  pending.resolve();
  await settle();
  assert.deepEqual(h.confirmed, [record]);
});

test("transient contention backs off without expiring or replacing intent", async () => {
  const error = Object.assign(new Error("invite-busy"), { code: "aborted" });
  const h = harness({ submit: () => Promise.reject(error) });
  h.delivery.accept(record);
  const delays = [];
  for (let attempt = 0; attempt < 9; attempt += 1) {
    await settle();
    assert.equal(h.timers.size, 1);
    assert.deepEqual(h.delivery.pending, record);
    delays.push(h.fireTimer());
  }
  await settle();
  assert.deepEqual(
    delays,
    [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000],
  );
  assert.equal(h.entries.has(key), true);
  assert.ok(h.calls.every((call) => call.operationId === record.operationId));
  h.delivery.pause();
});

test("rate limiting preserves the intent and waits one minute before retry", async () => {
  const h = harness({
    submit: () =>
      Promise.reject(
        Object.assign(new Error("rate limit"), {
          code: "resource-exhausted",
        }),
      ),
  });
  h.delivery.accept(record);
  await settle();
  assert.equal(h.timers.values().next().value.delayMs, 60_000);
  assert.equal(h.entries.has(key), true);
  h.delivery.refresh();
  h.delivery.refresh();
  h.delivery.accept(nextRecord);
  assert.equal(h.calls.length, 1);
  assert.equal(h.timers.values().next().value.delayMs, 60_000);
  h.delivery.pause();
});

test("authentication and permanent failures pause without deleting the intent", async () => {
  for (const code of [
    "unauthenticated",
    "permission-denied",
    "not-found",
    "failed-precondition",
    "invalid-argument",
    "http-401",
    "http-403",
    "http-404",
  ]) {
    let fail = true;
    const h = harness({
      submit: () =>
        fail
          ? Promise.reject(Object.assign(new Error(code), { code }))
          : Promise.resolve(),
    });
    h.delivery.accept(record);
    await settle();
    assert.equal(h.calls.length, 1);
    assert.equal(h.timers.size, 0);
    assert.equal(h.entries.has(key), true);
    fail = false;
    h.delivery.refresh();
    await settle();
    assert.equal(h.calls.length, 2);
    assert.equal(h.delivery.pending, null);
  }
});

test("metadata retry-after controls backoff without overflowing timers", async () => {
  for (const [code, retryAfterMs, expectedMs] of [
    ["http-429", undefined, 60_000],
    ["http-429", 120_000, 120_000],
    ["http-429", 0, 60_000],
    ["http-429", -1, 60_000],
    ["http-429", Infinity, 60_000],
    ["http-429", NaN, 60_000],
    ["http-429", Number.MAX_SAFE_INTEGER, 2_147_483_647],
    ["http-503", 90_000, 90_000],
  ]) {
    const h = harness({
      submit: () =>
        Promise.reject(
          Object.assign(new Error(code), {
            code,
            retryAfterMs,
          }),
        ),
    });
    h.delivery.accept(record);
    await settle();
    assert.equal(h.timers.values().next().value.delayMs, expectedMs);
    assert.equal(h.entries.has(key), true);
    h.delivery.refresh();
    assert.equal(h.calls.length, 1);
    h.delivery.pause();
  }
});

test("account changes pause delivery and an old response cannot confirm another account", async () => {
  const pending = deferred();
  const h = harness({ submit: () => pending.promise });
  h.delivery.accept(record);
  h.setAuthorized(false);
  h.delivery.pause();
  pending.resolve();
  await settle();
  assert.deepEqual(h.delivery.pending, record);
  assert.equal(h.confirmed.length, 0);
  h.delivery.refresh();
  assert.equal(h.calls.length, 1);
  h.setAuthorized(true);
  h.delivery.refresh();
  await settle();
  assert.equal(h.calls.length, 2);
  assert.deepEqual(h.confirmed, [record]);
});

test("offline retries sleep until a wake event", async () => {
  const h = harness({ submit: () => Promise.reject(new Error("network")) });
  h.delivery.accept(record);
  await settle();
  h.setOnline(false);
  h.fireTimer();
  assert.equal(h.calls.length, 1);
  assert.equal(h.timers.size, 0);
  h.setOnline(true);
  h.delivery.refresh();
  await settle();
  assert.equal(h.calls.length, 2);
  h.delivery.pause();
});

test("authoritative metadata confirmation cancels retries", async () => {
  const h = harness({ submit: () => Promise.reject(new Error("network")) });
  h.delivery.accept(record);
  await settle();
  assert.equal(h.timers.size, 1);
  h.delivery.confirm();
  assert.equal(h.timers.size, 0);
  assert.equal(h.delivery.pending, null);
  assert.equal(h.entries.has(key), false);
  h.delivery.refresh();
  assert.equal(h.calls.length, 1);
});

test("late completion cannot clear a newer intent", async () => {
  const first = deferred();
  const second = deferred();
  const h = harness({
    submit: (value) =>
      value.operationId === record.operationId ? first.promise : second.promise,
  });
  h.delivery.accept(record);
  h.delivery.confirm();
  h.delivery.accept(nextRecord);
  assert.equal(h.calls.length, 1);
  first.resolve();
  await settle();
  assert.deepEqual(h.delivery.pending, nextRecord);
  assert.equal(
    JSON.parse(h.entries.get(key)).record.operationId,
    nextRecord.operationId,
  );
  assert.equal(h.calls.length, 2);
  second.resolve();
  await settle();
  assert.deepEqual(h.confirmed, [record, nextRecord]);
});

test("unavailable persistence keeps the end in memory through retries", async () => {
  for (const storage of [
    null,
    {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota exceeded");
      },
      removeItem: () => undefined,
    },
  ]) {
    const pending = deferred();
    let attempts = 0;
    const h = harness({
      storage,
      submit: () =>
        attempts++ === 0
          ? Promise.reject(new Error("network"))
          : pending.promise,
    });
    assert.equal(h.delivery.accept(record), true);
    assert.deepEqual(h.delivery.pending, record);
    assert.deepEqual(h.calls, [record]);
    assert.equal(h.errors.length, 1);
    await settle();
    assert.equal(h.timers.size, 1);
    h.fireTimer();
    assert.deepEqual(h.calls, [record, record]);
    assert.deepEqual(h.delivery.pending, record);
    pending.resolve();
    await settle();
    assert.equal(h.delivery.pending, null);
    assert.deepEqual(h.confirmed, [record]);
    assert.equal(h.timers.size, 0);
  }
});

test("invalid or mismatched stored records never submit", () => {
  for (const value of [
    "malformed JSON",
    JSON.stringify({ version: 2, record }),
    JSON.stringify({
      version: 1,
      record: { ...record, operationId: "invalid" },
    }),
    JSON.stringify({ version: 1, record: { ...record, loginUid: "other" } }),
    JSON.stringify({ version: 1, record: { ...record, matchId: "other1" } }),
    JSON.stringify({ version: 1, record: { ...record, actorUid: "../other" } }),
  ]) {
    const h = harness({ entries: new Map([[key, value]]) });
    h.delivery.refresh();
    assert.equal(h.delivery.pending, null);
    assert.equal(h.calls.length, 0);
    assert.equal(h.errors.length, 1);
  }
});

test("new intent rejects invalid scope and cannot be accepted by another account", () => {
  const h = harness({ online: false });
  assert.equal(h.delivery.accept({ ...record, inviteId: "other" }), false);
  assert.equal(h.delivery.accept({ ...record, loginUid: "other" }), false);
  assert.equal(h.delivery.accept({ ...record, matchId: "other1" }), false);
  h.setAuthorized(false);
  assert.equal(h.delivery.accept(record), false);
  assert.equal(h.delivery.pending, null);
  assert.equal(h.entries.size, 0);
});

test("confirmation removes only the matching stored operation even when its envelope is otherwise incomplete", () => {
  for (const operationId of [record.operationId, nextRecord.operationId]) {
    const h = harness({ online: false });
    assert.equal(h.delivery.accept(record), true);
    const stored = JSON.stringify({ record: { operationId } });
    h.entries.set(key, stored);
    h.delivery.confirm();
    assert.equal(h.delivery.pending, null);
    assert.deepEqual(h.confirmed, [record]);
    assert.deepEqual(h.errors, []);
    assert.equal(
      h.entries.get(key),
      operationId === record.operationId ? undefined : stored,
    );
  }
});
