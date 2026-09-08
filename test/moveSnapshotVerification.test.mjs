import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import {
  MoveDelivery,
  MoveDeliveryError,
  moveDeliveryStorageKey,
} from "../src/connection/moveDelivery.ts";

const scope = {
  loginUid: "login",
  playerId: "actor",
  inviteId: "abcdefghijk",
  matchId: "abcdefghijk",
};
const initial = { fen: "initial-fen", flatMovesString: "first" };
const target = { fen: "expected-fen", flatMovesString: "first-second" };
const settle = async () => {
  await setImmediate();
  await setImmediate();
};

function harness({ windowMs = 3500, ignoreReadAbort = false } = {}) {
  let now = 10_000;
  let timerId = 0;
  let authorized = true;
  const timers = new Map();
  const delays = [];
  const reads = [];
  const submissions = [];
  const errors = [];
  const records = new Map();
  const key = moveDeliveryStorageKey(scope);
  const pending = (entries, details, ignoreAbort = false) =>
    new Promise((resolve, reject) => {
      const entry = {
        ...details,
        startedAt: now,
        active: true,
        resolve(value) {
          if (!entry.active) return;
          entry.active = false;
          details.signal.removeEventListener("abort", onAbort);
          resolve(value);
        },
        reject(error) {
          if (!entry.active) return;
          entry.active = false;
          details.signal.removeEventListener("abort", onAbort);
          reject(error);
        },
      };
      const onAbort = () => {
        if (!ignoreAbort)
          entry.reject(new MoveDeliveryError("request-aborted"));
      };
      details.signal.addEventListener("abort", onAbort, { once: true });
      entries.push(entry);
      if (details.signal.aborted) onAbort();
    });
  const outbox = new MoveDelivery(scope, initial, {
    storage: {
      getItem: (name) => records.get(name) ?? null,
      setItem: (name, value) => records.set(name, value),
      removeItem: (name) => records.delete(name),
    },
    isAuthorized: () => authorized,
    isOnline: () => true,
    submit: (request, options) => pending(submissions, { request, ...options }),
    read: (options) => pending(reads, options, ignoreReadAbort),
    onError: (error, kind) => errors.push({ error, kind }),
    onRemoteAdvance: () => {},
    now: () => now,
    setTimer(callback, delayMs) {
      const id = ++timerId;
      delays.push(delayMs);
      timers.set(id, { callback, at: now + delayMs });
      return id;
    },
    clearTimer: (id) => timers.delete(id),
    retryWindowMs: 20,
    attemptTimeoutMs: 20,
    verificationWindowMs: windowMs,
  });
  const h = {
    outbox,
    reads,
    submissions,
    errors,
    records,
    key,
    delays,
    now: () => now,
    elapse: (milliseconds) => {
      now += milliseconds;
    },
    setAuthorized: (value) => {
      authorized = value;
    },
    async advance(milliseconds) {
      const end = now + milliseconds;
      let steps = 0;
      while (true) {
        const next = [...timers]
          .filter(([, timer]) => timer.at <= end)
          .sort((left, right) => left[1].at - right[1].at)[0];
        if (!next) break;
        assert.ok(++steps < 1000);
        timers.delete(next[0]);
        now = next[1].at;
        next[1].callback();
        await settle();
      }
      now = end;
      await settle();
    },
    async begin() {
      outbox.enqueue("second", target.fen);
      const result = { status: "pending" };
      result.done = outbox.flush().then(
        () => {
          result.status = "fulfilled";
        },
        (error) => {
          result.status = "rejected";
          result.error = error;
        },
      );
      h.elapse(20);
      submissions[0].reject(
        Object.assign(new Error("uncertain-move-result"), {
          code: "unavailable",
        }),
      );
      await settle();
      assert.equal(reads.length, 1);
      return result;
    },
  };
  return h;
}

async function exhaust(h, respond) {
  const end = h.reads[0].startedAt + 3500;
  while (h.now() < end) {
    const read = h.reads.find((entry) => entry.active);
    assert.ok(read);
    respond(read);
    await settle();
    await h.advance(Math.min(350, end - h.now()));
  }
}

test("uncertain delivery accepts a matching snapshot and clears the persisted journal", async (t) => {
  const h = harness();
  t.after(() => h.outbox.pause());
  const completed = await h.begin();
  assert.equal(h.reads[0].timeoutMs, 1200);
  assert.equal(h.reads[0].startedAt, 10_020);
  h.reads[0].resolve(target);
  await completed.done;
  assert.equal(completed.status, "fulfilled");
  assert.equal(h.outbox.hasPendingMoves, false);
  assert.deepEqual(h.outbox.latest, target);
  assert.equal(h.records.has(h.key), false);
  assert.deepEqual(h.delays, []);
  assert.deepEqual(h.errors, []);
});

for (const [label, snapshot] of [
  ["different target FEN", { ...target, fen: "other-fen" }],
  ["divergent move chain", { ...target, flatMovesString: "first-other" }],
]) {
  test(`verification cannot acknowledge a ${label}`, async (t) => {
    const h = harness();
    t.after(() => h.outbox.pause());
    const completed = await h.begin();
    h.reads[0].resolve(snapshot);
    await completed.done;
    assert.equal(completed.status, "rejected");
    assert.equal(completed.error.message, "move-delivery-conflict");
    assert.equal(h.outbox.hasPendingMoves, true);
    assert.equal(h.outbox.isConflicted, true);
    assert.equal(h.outbox.confirmationVersion, 0);
    assert.deepEqual(h.outbox.latest, target);
    assert.equal(h.records.has(h.key), true);
  });
}

for (const [label, respond] of [
  ["unchanged history", (read) => read.resolve(initial)],
  ["missing match", (read) => read.resolve(null)],
  [
    "unavailable snapshot",
    (read) => read.reject(new Error("snapshot-unavailable")),
  ],
]) {
  test(`${label} exhausts verification while retaining pending actions and the flush barrier`, async (t) => {
    const h = harness();
    t.after(() => h.outbox.pause());
    const completed = await h.begin();
    await exhaust(h, respond);
    assert.equal(completed.status, "pending");
    assert.equal(h.outbox.hasPendingMoves, true);
    assert.equal(h.outbox.isConflicted, false);
    assert.equal(h.outbox.confirmationVersion, 0);
    assert.equal(h.records.has(h.key), true);
    assert.ok(h.reads.length > 1);
    assert.ok(h.reads.every(({ timeoutMs }) => timeoutMs <= 1200));
    assert.ok(h.reads.every(({ startedAt }) => startedAt < 13_520));
    assert.equal(h.errors.at(-1).error.message, "move-delivery-unavailable");
    assert.equal(h.delays.at(-1), 15_000);
  });
}

test("verification tolerates an unavailable read and confirms a later matching snapshot", async (t) => {
  const h = harness();
  t.after(() => h.outbox.pause());
  const completed = await h.begin();
  h.reads[0].reject(new Error("snapshot-unavailable"));
  await settle();
  await h.advance(350);
  h.reads[1].resolve(target);
  await completed.done;
  assert.equal(completed.status, "fulfilled");
  assert.equal(h.reads.length, 2);
  assert.deepEqual(h.delays, [350]);
  assert.equal(h.records.has(h.key), false);
});

test("each snapshot timeout is capped by 1200 ms and the remaining verification budget", async (t) => {
  const h = harness();
  t.after(() => h.outbox.pause());
  const completed = await h.begin();
  for (const timeoutMs of [1200, 1200, 400]) {
    const read = h.reads.at(-1);
    assert.equal(read.timeoutMs, timeoutMs);
    h.elapse(timeoutMs);
    read.resolve(null);
    await settle();
    if (timeoutMs !== 400) await h.advance(350);
  }
  assert.deepEqual(
    h.reads.map(({ timeoutMs }) => timeoutMs),
    [1200, 1200, 400],
  );
  assert.deepEqual(h.delays, [350, 350, 15_000]);
  assert.equal(h.now(), 13_520);
  assert.equal(completed.status, "pending");
  assert.equal(h.outbox.hasPendingMoves, true);
});

test("verification honors a sub-1200 ms remaining window", async (t) => {
  const h = harness({ windowMs: 900 });
  t.after(() => h.outbox.pause());
  const completed = await h.begin();
  assert.equal(h.reads[0].timeoutMs, 900);
  h.reads[0].resolve(target);
  await completed.done;
  assert.equal(completed.status, "fulfilled");
});

test("a late matching proof may confirm the same generation without starting work beyond its window", async (t) => {
  const h = harness({ windowMs: 900 });
  t.after(() => h.outbox.pause());
  const completed = await h.begin();
  assert.equal(h.reads[0].timeoutMs, 900);
  h.elapse(900);
  h.reads[0].resolve(target);
  await completed.done;
  assert.equal(completed.status, "fulfilled");
  assert.equal(h.reads.length, 1);
  assert.deepEqual(h.delays, []);
  assert.equal(h.records.has(h.key), false);
});

test("a snapshot received after account pause cannot acknowledge accepted moves", async (t) => {
  const h = harness({ ignoreReadAbort: true });
  t.after(() => h.outbox.pause());
  const completed = await h.begin();
  h.setAuthorized(false);
  h.outbox.pause();
  h.reads[0].resolve(target);
  await settle();
  assert.equal(completed.status, "rejected");
  assert.equal(completed.error.message, "move-authentication-changed");
  assert.equal(h.reads[0].signal.aborted, true);
  assert.equal(h.outbox.confirmationVersion, 0);
  assert.equal(h.outbox.hasPendingMoves, true);
  assert.equal(h.records.has(h.key), true);
});

test("a stale verification read cannot replace or pause a reset delivery generation", async (t) => {
  const h = harness({ ignoreReadAbort: true });
  t.after(() => h.outbox.pause());
  const abandoned = await h.begin();
  const branch = { fen: "branch-fen", flatMovesString: "first-branch" };
  assert.throws(() => h.outbox.reconcile(branch), /move-delivery-conflict/);
  await abandoned.done;
  h.outbox.resetAfterConflict(branch);
  h.outbox.enqueue("new", "new-fen");
  const before = h.errors.length;
  h.reads[0].resolve(target);
  await settle();
  assert.equal(h.errors.length, before);
  assert.equal(h.outbox.isConflicted, false);
  assert.deepEqual(h.outbox.latest, {
    fen: "new-fen",
    flatMovesString: "first-branch-new",
  });
  assert.equal(h.submissions.length, 2);
  assert.equal(
    h.submissions[1].request.previousFlatMovesString,
    branch.flatMovesString,
  );
});

test("an old refresh cannot change a replacement delivery generation", async (t) => {
  const h = harness({ ignoreReadAbort: true });
  t.after(() => h.outbox.pause());
  h.outbox.enqueue("second", target.fen);
  const abandoned = h.outbox.flush().catch(() => undefined);
  const refreshed = h.outbox.refresh();
  assert.equal(h.reads.length, 1);
  const branch = { fen: "branch-fen", flatMovesString: "first-branch" };
  assert.throws(() => h.outbox.reconcile(branch), /move-delivery-conflict/);
  await abandoned;
  h.outbox.resetAfterConflict(branch);
  h.outbox.enqueue("new", "new-fen");
  const before = h.errors.length;
  h.reads[0].resolve(target);
  await refreshed;
  await settle();
  assert.equal(h.errors.length, before);
  assert.deepEqual(h.outbox.latest, {
    fen: "new-fen",
    flatMovesString: "first-branch-new",
  });
  assert.equal(h.outbox.isConflicted, false);
  assert.equal(h.submissions.length, 2);
});

test("a late lower snapshot cannot reverse progress confirmed while verification was pending", async (t) => {
  const h = harness();
  t.after(() => h.outbox.pause());
  const completed = await h.begin();
  h.outbox.reconcile(target);
  await completed.done;
  const confirmedVersion = h.outbox.confirmationVersion;
  h.reads[0].resolve(initial);
  await settle();
  assert.equal(completed.status, "fulfilled");
  assert.equal(h.outbox.confirmationVersion, confirmedVersion);
  assert.equal(h.outbox.hasPendingMoves, false);
  assert.deepEqual(h.errors, []);
  assert.equal(h.records.has(h.key), false);
});

test("transient exhaustion never reloads the page or deletes its pending journal", async (t) => {
  const previousWindow = globalThis.window;
  let reloads = 0;
  globalThis.window = { location: { reload: () => reloads++ } };
  t.after(() => {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  });
  const h = harness();
  t.after(() => h.outbox.pause());
  const completed = await h.begin();
  await exhaust(h, (read) => read.resolve(null));
  assert.equal(reloads, 0);
  assert.equal(completed.status, "pending");
  const stored = JSON.parse(h.records.get(h.key));
  assert.deepEqual(stored.confirmed, initial);
  assert.deepEqual(stored.pending, [{ moveFen: "second", fen: target.fen }]);
});
