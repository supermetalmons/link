import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import {
  countMoveHistory,
  isSubmitMoveRequest,
  MAX_MATCH_MOVE_PREVIOUS_STATES,
  MAX_MATCH_MOVE_REQUEST_BYTES,
} from "@mons/shared/game-sessions";
import { MAX_MATCH_FEN_BYTES } from "@mons/shared/match-protocol";
import {
  MoveDelivery,
  MoveDeliveryError,
  moveDeliveryStorageKey,
} from "../src/connection/moveDelivery.ts";

const scope = {
  loginUid: "original-login",
  playerId: "actor",
  inviteId: "abcdefghijk",
  matchId: "abcdefghijk",
};
const initial = { fen: "initial-fen", flatMovesString: "" };
const settle = async () => {
  await setImmediate();
  await setImmediate();
};

function fakeClock() {
  let now = 0;
  let nextId = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimer(callback, delayMs) {
      assert.ok(delayMs >= 0);
      const id = ++nextId;
      timers.set(id, { callback, at: now + delayMs });
      return id;
    },
    clearTimer: (id) => timers.delete(id),
    async advance(milliseconds) {
      const end = now + milliseconds;
      let steps = 0;
      while (true) {
        const next = [...timers]
          .filter(([, timer]) => timer.at <= end)
          .sort((left, right) => left[1].at - right[1].at)[0];
        if (!next) break;
        assert.ok(++steps < 1000, "timer loop did not settle");
        timers.delete(next[0]);
        now = next[1].at;
        next[1].callback();
        await settle();
      }
      now = end;
      await settle();
    },
    timers,
  };
}

function harness({
  start = initial,
  online = true,
  storageFailure = false,
  records = new Map(),
  ignoreAbort = false,
  retryWindowMs = 60_000,
  attemptTimeoutMs = 20_000,
  verificationWindowMs = 3500,
} = {}) {
  const clock = fakeClock();
  const requests = [];
  const reads = [];
  const errors = [];
  const advances = [];
  let loginUid = scope.loginUid;
  let maximumActive = 0;
  const pending = (list, data, options) =>
    new Promise((resolve, reject) => {
      const entry = {
        ...data,
        ...options,
        active: true,
        resolve(value) {
          if (!entry.active) return;
          entry.active = false;
          options.signal.removeEventListener("abort", cancel);
          resolve(value);
        },
        reject(error) {
          if (!entry.active) return;
          entry.active = false;
          options.signal.removeEventListener("abort", cancel);
          reject(error);
        },
      };
      const cancel = () => {
        if (!ignoreAbort)
          entry.reject(new MoveDeliveryError("request-aborted"));
      };
      options.signal.addEventListener("abort", cancel, { once: true });
      list.push(entry);
      if (options.signal.aborted) cancel();
      maximumActive = Math.max(
        maximumActive,
        requests.filter((request) => request.active).length,
      );
    });
  const storage = {
    getItem: (key) => records.get(key) ?? null,
    setItem: (key, value) => {
      if (storageFailure) throw new Error("storage-quota-exceeded");
      records.set(key, value);
    },
    removeItem: (key) => {
      if (storageFailure) throw new Error("storage-unavailable");
      records.delete(key);
    },
  };
  const outbox = new MoveDelivery(
    scope,
    { ...start, gameVariant: "Classic" },
    {
      storage,
      isAuthorized: () => loginUid === scope.loginUid,
      isOnline: () => online,
      submit: (request, options) => {
        assert.equal(loginUid, scope.loginUid);
        assert.ok(isSubmitMoveRequest(request));
        return pending(requests, { request, authorizedUid: loginUid }, options);
      },
      read: (options) => pending(reads, {}, options),
      onError: (error, kind) => errors.push({ error, kind }),
      onRemoteAdvance: () => advances.push(true),
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      retryWindowMs,
      attemptTimeoutMs,
      verificationWindowMs,
    },
  );
  return {
    outbox,
    clock,
    requests,
    reads,
    errors,
    advances,
    records,
    key: moveDeliveryStorageKey(scope),
    setOnline: (value) => {
      online = value;
    },
    setLogin: (value) => {
      loginUid = value;
    },
    maximumActive: () => maximumActive,
    stored: () => JSON.parse(records.get(moveDeliveryStorageKey(scope))),
    acknowledge(index, outcome = "applied") {
      const entry = requests[index];
      entry.resolve({
        ok: true,
        inviteId: scope.inviteId,
        matchId: scope.matchId,
        actorUid: scope.playerId,
        outcome,
      });
    },
  };
}

function observe(promise) {
  const outcome = { state: "pending" };
  outcome.done = promise.then(
    () => {
      outcome.state = "fulfilled";
    },
    (error) => {
      outcome.state = "rejected";
      outcome.error = error;
    },
  );
  return outcome;
}

test("two in-flight attempts coalesce later inputs and stale acknowledgements cannot reverse progress", async (t) => {
  const h = harness();
  t.after(() => h.outbox.pause());
  for (const [move, fen] of [
    ["a", "a-fen"],
    ["b", "b-fen"],
    ["z", "a-fen"],
    ["c", "c-fen"],
  ]) {
    h.outbox.enqueue(move, fen);
  }
  const completed = observe(h.outbox.flush());
  assert.equal(h.requests.length, 2);
  assert.deepEqual(
    h.requests.map(({ request }) => request.flatMovesString),
    ["a", "a-b"],
  );
  h.acknowledge(1);
  await settle();
  assert.equal(h.requests.length, 3);
  assert.equal(h.requests[2].request.previousFlatMovesString, "a-b");
  assert.equal(h.requests[2].request.flatMovesString, "a-b-z-c");
  assert.deepEqual(h.requests[2].request.previousStates, [
    { moveCount: 2, fen: "b-fen" },
    { moveCount: 3, fen: "a-fen" },
  ]);
  h.acknowledge(2);
  await completed.done;
  const revision = h.outbox.confirmationVersion;
  h.acknowledge(0);
  await settle();
  assert.equal(completed.state, "fulfilled");
  assert.equal(h.outbox.confirmationVersion, revision);
  assert.equal(h.outbox.hasPendingMoves, false);
  assert.deepEqual(h.outbox.latest, {
    fen: "c-fen",
    flatMovesString: "a-b-z-c",
  });
  assert.equal(h.maximumActive(), 2);
  assert.equal(h.records.size, 0);
  assert.deepEqual(h.errors, []);
});

test("offline journals split at 64 checkpoints and drain the remaining suffix", async (t) => {
  const h = harness({ online: false });
  t.after(() => h.outbox.pause());
  for (let index = 0; index < 70; index++)
    h.outbox.enqueue(`m${index}`, `f${index}`);
  assert.equal(h.requests.length, 0);
  assert.equal(h.stored().pending.length, 70);
  const completed = observe(h.outbox.flush());
  h.setOnline(true);
  h.outbox.resume();
  assert.equal(
    h.requests[0].request.previousStates.length,
    MAX_MATCH_MOVE_PREVIOUS_STATES,
  );
  assert.equal(countMoveHistory(h.requests[0].request.flatMovesString), 64);
  h.acknowledge(0);
  await settle();
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests[1].request.previousStates.length, 6);
  assert.equal(h.requests[1].request.previousStates[0].moveCount, 64);
  assert.equal(countMoveHistory(h.requests[1].request.flatMovesString), 70);
  assert.equal(completed.state, "pending");
  h.acknowledge(1);
  await completed.done;
  assert.equal(completed.state, "fulfilled");
  assert.equal(h.outbox.hasPendingMoves, false);
  assert.equal(h.records.size, 0);
});

test("large escaped FEN checkpoints split below the complete 1 MiB envelope", async (t) => {
  const largeFen = "\u0000".repeat(MAX_MATCH_FEN_BYTES);
  const h = harness({
    online: false,
    start: { fen: largeFen, flatMovesString: "" },
  });
  t.after(() => h.outbox.pause());
  for (let index = 0; index < 20; index++)
    h.outbox.enqueue(`m${index}`, largeFen);
  h.setOnline(true);
  h.outbox.resume();
  const completed = observe(h.outbox.flush());
  for (let index = 0; h.outbox.hasPendingMoves; index++) {
    assert.ok(index < 20);
    const { request } = h.requests[index];
    assert.ok(request.previousStates.length < 20);
    assert.ok(
      Buffer.byteLength(JSON.stringify(request)) <=
        MAX_MATCH_MOVE_REQUEST_BYTES,
    );
    assert.ok(isSubmitMoveRequest(request));
    h.acknowledge(index);
    await settle();
  }
  await completed.done;
  assert.equal(completed.state, "fulfilled");
  assert.ok(h.requests.length > 1);
  assert.equal(countMoveHistory(h.outbox.latest.flatMovesString), 20);
  assert.deepEqual(h.errors, []);
});

test("storage failures report once while the in-memory journal remains deliverable", async (t) => {
  const h = harness({ storageFailure: true });
  t.after(() => h.outbox.pause());
  h.outbox.enqueue("a", "a-fen");
  h.outbox.enqueue("b", "b-fen");
  assert.deepEqual(h.outbox.latest, { fen: "b-fen", flatMovesString: "a-b" });
  assert.equal(h.errors.length, 1);
  assert.equal(h.errors[0].kind, "storage");
  const completed = observe(h.outbox.flush());
  h.acknowledge(1);
  await completed.done;
  h.acknowledge(0);
  await settle();
  assert.equal(completed.state, "fulfilled");
  assert.equal(h.outbox.hasPendingMoves, false);
  assert.equal(h.errors.length, 1);
});

test("authentication pause retains pending actions and dispatch resumes only for the original login", async (t) => {
  const h = harness();
  t.after(() => h.outbox.pause());
  h.outbox.enqueue("a", "a-fen");
  const completed = observe(h.outbox.flush());
  h.setLogin("another-login");
  h.outbox.pause();
  await settle();
  assert.equal(completed.state, "rejected");
  assert.equal(completed.error.message, "move-authentication-changed");
  assert.equal(h.requests[0].signal.aborted, true);
  assert.equal(h.stored().pending.length, 1);
  h.outbox.resume();
  await h.clock.advance(60_000);
  assert.equal(h.requests.length, 1);
  h.setLogin(scope.loginUid);
  h.outbox.resume();
  const resumed = observe(h.outbox.flush());
  assert.equal(h.requests.length, 2);
  assert.deepEqual(h.requests[1].request, h.requests[0].request);
  assert.equal(h.requests[1].authorizedUid, scope.loginUid);
  h.acknowledge(1, "already-applied");
  await resumed.done;
  assert.equal(resumed.state, "fulfilled");
  assert.equal(h.outbox.hasPendingMoves, false);
});

test("partial same-match recovery retains the optimistic suffix and disregards an older read revision", async (t) => {
  const h = harness({ online: false });
  t.after(() => h.outbox.pause());
  h.outbox.enqueue("a", "a-fen");
  h.outbox.enqueue("b", "b-fen");
  const readRevision = h.outbox.confirmationVersion;
  const latest = h.outbox.reconcile({ fen: "a-fen", flatMovesString: "a" });
  assert.deepEqual(latest, { fen: "b-fen", flatMovesString: "a-b" });
  assert.deepEqual(h.stored().confirmed, {
    fen: "a-fen",
    flatMovesString: "a",
  });
  assert.deepEqual(h.stored().pending, [{ moveFen: "b", fen: "b-fen" }]);
  assert.deepEqual(h.outbox.reconcile(initial, readRevision), latest);
  assert.equal(h.outbox.isConflicted, false);
  assert.deepEqual(h.errors, []);
  const restored = harness({
    records: h.records,
    start: initial,
    online: false,
  });
  t.after(() => restored.outbox.pause());
  assert.deepEqual(restored.outbox.latest, latest);
  assert.deepEqual(
    restored.outbox.reconcile({ fen: "a-fen", flatMovesString: "a" }),
    latest,
  );
  restored.setOnline(true);
  restored.outbox.resume();
  assert.equal(restored.requests[0].request.previousFlatMovesString, "a");
  restored.acknowledge(0);
  await settle();
  assert.equal(restored.outbox.hasPendingMoves, false);
});

test("a current snapshot behind the confirmed baseline pauses without archiving or discarding actions", async (t) => {
  const base = { fen: "a-fen", flatMovesString: "a" };
  const h = harness({ online: false, start: base });
  t.after(() => h.outbox.pause());
  h.outbox.enqueue("b", "b-fen");
  const completed = observe(h.outbox.flush());
  assert.throws(
    () => h.outbox.reconcile(initial),
    /move-delivery-snapshot-behind/,
  );
  await settle();
  assert.equal(completed.state, "pending");
  assert.equal(h.outbox.isConflicted, false);
  assert.equal(h.outbox.hasPendingMoves, true);
  assert.equal(h.records.has(`${h.key}:conflict`), false);
  h.outbox.resetAfterConflict(initial);
  assert.deepEqual(h.outbox.latest, { fen: "b-fen", flatMovesString: "a-b" });
  assert.throws(
    () => h.outbox.enqueue("c", "c-fen"),
    /move-delivery-snapshot-behind/,
  );
  h.outbox.reconcile(base);
  h.setOnline(true);
  h.outbox.resume();
  h.acknowledge(0);
  await completed.done;
  assert.equal(completed.state, "fulfilled");
  assert.equal(h.outbox.hasPendingMoves, false);
});

test("a divergent branch archives pending state on reset and ignores late pre-reset acknowledgements", async (t) => {
  const h = harness({ ignoreAbort: true });
  t.after(() => h.outbox.pause());
  h.outbox.enqueue("a", "a-fen");
  const completed = observe(h.outbox.flush());
  const remote = { fen: "different-fen", flatMovesString: "other" };
  assert.throws(() => h.outbox.reconcile(remote), /move-delivery-conflict/);
  await completed.done;
  assert.equal(completed.state, "rejected");
  assert.equal(h.outbox.isConflicted, true);
  const previousRecord = h.stored();
  h.outbox.resetAfterConflict(remote);
  assert.deepEqual(
    JSON.parse(h.records.get(`${h.key}:conflict`)),
    previousRecord,
  );
  assert.equal(h.records.has(h.key), false);
  h.outbox.enqueue("next", "next-fen");
  assert.equal(h.requests.length, 2);
  h.acknowledge(0);
  await settle();
  assert.deepEqual(h.outbox.latest, {
    fen: "next-fen",
    flatMovesString: "other-next",
  });
  assert.equal(h.outbox.hasPendingMoves, true);
  h.acknowledge(1);
  await settle();
  assert.equal(h.outbox.hasPendingMoves, false);
  assert.equal(h.outbox.isConflicted, false);
});

test("equal history with a different checkpoint FEN is a conflict, not a partial acknowledgement", (t) => {
  const h = harness({ online: false });
  t.after(() => h.outbox.pause());
  h.outbox.enqueue("a", "a-fen");
  h.outbox.enqueue("b", "b-fen");
  assert.throws(
    () => h.outbox.reconcile({ fen: "wrong-a-fen", flatMovesString: "a" }),
    /move-delivery-conflict/,
  );
  assert.equal(h.outbox.isConflicted, true);
  assert.equal(h.stored().pending.length, 2);
});

test("a flush barrier waits only for actions accepted before that barrier", async (t) => {
  const h = harness();
  t.after(() => h.outbox.pause());
  h.outbox.enqueue("a", "a-fen");
  const earlier = observe(h.outbox.flush());
  h.outbox.enqueue("b", "b-fen");
  const later = observe(h.outbox.flush());
  h.acknowledge(0);
  await earlier.done;
  assert.equal(earlier.state, "fulfilled");
  assert.equal(later.state, "pending");
  assert.equal(h.outbox.hasPendingMoves, true);
  assert.equal(h.stored().pending.length, 1);
  h.acknowledge(1);
  await later.done;
  assert.equal(later.state, "fulfilled");
});

test("hydration suspension keeps barriers and pending actions while blocking new dispatch", async (t) => {
  const h = harness({ online: false });
  t.after(() => h.outbox.pause());
  h.outbox.enqueue("a", "a-fen");
  const completed = observe(h.outbox.flush());
  h.outbox.suspend();
  h.setOnline(true);
  h.outbox.enqueue("b", "b-fen");
  await settle();
  assert.equal(h.requests.length, 0);
  assert.equal(completed.state, "pending");
  h.outbox.reconcile(initial);
  h.outbox.resume();
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].request.flatMovesString, "a-b");
  h.acknowledge(0);
  await completed.done;
  assert.equal(completed.state, "fulfilled");
});

test("transient exhaustion retains journal and barriers and recovers after cooldown without a new online event", async (t) => {
  const h = harness({
    retryWindowMs: 20,
    attemptTimeoutMs: 20,
    verificationWindowMs: 10,
  });
  t.after(() => h.outbox.pause());
  h.outbox.enqueue("a", "a-fen");
  const completed = observe(h.outbox.flush());
  await h.clock.advance(20);
  h.requests[0].reject(
    Object.assign(new Error("upstream-unavailable"), { code: "unavailable" }),
  );
  await settle();
  assert.equal(h.reads.length, 1);
  h.reads[0].resolve(initial);
  await settle();
  await h.clock.advance(10);
  assert.equal(h.outbox.hasPendingMoves, true);
  assert.equal(h.stored().pending.length, 1);
  assert.equal(completed.state, "pending");
  await h.clock.advance(14_999);
  assert.equal(h.requests.length, 1);
  await h.clock.advance(1);
  for (const read of h.reads.filter((entry) => entry.active))
    read.resolve(initial);
  await settle();
  assert.equal(h.requests.length, 2);
  assert.deepEqual(h.requests[1].request, h.requests[0].request);
  h.acknowledge(1, "already-applied");
  await completed.done;
  assert.equal(completed.state, "fulfilled");
  assert.equal(h.outbox.hasPendingMoves, false);
  assert.equal(h.records.has(h.key), false);
});

test("permanent submission errors reject barriers and never auto-resume", async (t) => {
  const h = harness();
  t.after(() => h.outbox.pause());
  h.outbox.enqueue("a", "a-fen");
  const completed = observe(h.outbox.flush());
  h.requests[0].reject(
    Object.assign(new Error("participant-required"), {
      code: "permission-denied",
    }),
  );
  await completed.done;
  assert.equal(completed.state, "rejected");
  assert.equal(h.outbox.isConflicted, true);
  assert.equal(h.stored().pending.length, 1);
  await h.clock.advance(120_000);
  assert.equal(h.requests.length, 1);
  assert.equal(h.reads.length, 0);
});

test("regular acknowledgements keep a continuously nonempty journal healthy beyond 60 seconds", async (t) => {
  const h = harness();
  t.after(() => h.outbox.pause());
  h.outbox.enqueue("m0", "f0");
  h.outbox.enqueue("m1", "f1");
  for (let round = 0; round < 15; round++) {
    await h.clock.advance(5000);
    h.outbox.enqueue(`m${round + 2}`, `f${round + 2}`);
    const earliest = h.requests.findIndex((request) => request.active);
    assert.ok(earliest >= 0);
    h.acknowledge(earliest);
    await settle();
    assert.equal(h.outbox.hasPendingMoves, true);
    assert.equal(h.reads.length, 0);
    assert.deepEqual(h.errors, []);
  }
  assert.equal(h.clock.now(), 75_000);
  const completed = observe(h.outbox.flush());
  while (h.outbox.hasPendingMoves) {
    const latest = h.requests.findLastIndex((request) => request.active);
    assert.ok(latest >= 0);
    h.acknowledge(latest);
    await settle();
  }
  for (let index = 0; index < h.requests.length; index++) h.acknowledge(index);
  await completed.done;
  assert.equal(completed.state, "fulfilled");
  assert.equal(countMoveHistory(h.outbox.latest.flatMovesString), 17);
  assert.equal(h.maximumActive(), 2);
});

test("partial verification progress resumes the unacknowledged suffix without entering cooldown", async (t) => {
  const h = harness({
    retryWindowMs: 20,
    attemptTimeoutMs: 20,
    verificationWindowMs: 10,
  });
  t.after(() => h.outbox.pause());
  h.outbox.enqueue("a", "a-fen");
  h.outbox.enqueue("b", "b-fen");
  const completed = observe(h.outbox.flush());
  await h.clock.advance(20);
  for (const request of h.requests) {
    request.reject(
      Object.assign(new Error("upstream-unavailable"), { code: "unavailable" }),
    );
  }
  await settle();
  assert.equal(h.reads.length, 1);
  h.reads[0].resolve({ fen: "a-fen", flatMovesString: "a" });
  await settle();
  assert.equal(h.requests.length, 3);
  assert.equal(h.requests[2].request.previousFlatMovesString, "a");
  assert.equal(h.requests[2].request.flatMovesString, "a-b");
  assert.deepEqual(h.errors, []);
  assert.equal(completed.state, "pending");
  h.acknowledge(2);
  await completed.done;
  assert.equal(completed.state, "fulfilled");
});

test("a confirmed finished match archives undelivered actions and survives reload without reporting delivery", async (t) => {
  const h = harness();
  t.after(() => h.outbox.pause());
  h.outbox.enqueue("a", "a-fen");
  h.outbox.enqueue("b", "b-fen");
  const confirmationVersion = h.outbox.confirmationVersion;
  const completed = observe(h.outbox.flush());
  h.requests[0].reject(
    Object.assign(new Error("match-move-finished"), {
      code: "failed-precondition",
    }),
  );
  await completed.done;
  await settle();
  assert.equal(completed.state, "rejected");
  assert.equal(completed.error.message, "match-move-finished");
  assert.equal(h.outbox.confirmationVersion, confirmationVersion);
  assert.equal(h.outbox.hasPendingMoves, false);
  assert.throws(() => h.outbox.enqueue("c", "c-fen"), /match-move-finished/);
  const later = observe(h.outbox.flush());
  await later.done;
  assert.equal(later.state, "rejected");
  assert.equal(later.error.message, "match-move-finished");
  assert.ok(h.records.size > 0);
  assert.ok(
    [...h.records.values()].some((value) => {
      const record = JSON.parse(value);
      return (
        Array.isArray(record.pending) &&
        record.pending.map((move) => move.moveFen).join("-") === "a-b"
      );
    }),
  );
  await h.clock.advance(60_000);
  assert.equal(h.requests.length, 2);
  assert.equal(h.reads.length, 0);
  const restored = harness({ records: h.records });
  t.after(() => restored.outbox.pause());
  assert.throws(
    () => restored.outbox.enqueue("c", "c-fen"),
    /match-move-finished/,
  );
  const restoredBarrier = observe(restored.outbox.flush());
  await restoredBarrier.done;
  assert.equal(restoredBarrier.state, "rejected");
  assert.equal(restoredBarrier.error.message, "match-move-finished");
  assert.equal(restored.requests.length, 0);
});
