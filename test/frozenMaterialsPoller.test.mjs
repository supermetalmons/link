import assert from "node:assert/strict";
import test from "node:test";
import {
  FROZEN_MATERIALS_BACKOFF_MS,
  FROZEN_MATERIALS_POLL_INTERVAL_MS,
  FrozenMaterialsPoller,
} from "../src/connection/frozenMaterialsPoller.ts";

const snapshot = (revision = 1, dust = 2, playerUid = "actor") => ({
  ok: true,
  playerUid,
  revision,
  frozen: { dust, slime: 0, gum: 0, metal: 0, ice: 0 },
});

const flush = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

function harness(load = async () => snapshot()) {
  let active = true;
  let visible = true;
  let nextTimer = 1;
  let visibilityListener;
  let onlineListener;
  const timers = new Map();
  const updates = [];
  const errors = [];
  const signals = [];
  let pending = 0;
  const poller = new FrozenMaterialsPoller({
    playerUid: "actor",
    addVisibilityListener(listener) {
      visibilityListener = listener;
      return () => (visibilityListener = null);
    },
    addOnlineListener(listener) {
      onlineListener = listener;
      return () => (onlineListener = null);
    },
    clearTimer: (timer) => timers.delete(timer),
    isActive: () => active,
    isVisible: () => visible,
    load: (signal) => {
      signals.push(signal);
      return load(signal);
    },
    onPending: () => (pending += 1),
    onSnapshot: (value) => updates.push(value),
    onError: (error, confirmed, refreshRequired) =>
      errors.push({ error, confirmed, refreshRequired }),
    setTimer(callback, delayMs) {
      const id = nextTimer++;
      timers.set(id, { callback, delayMs });
      return id;
    },
  });
  return {
    poller,
    timers,
    updates,
    errors,
    signals,
    pending: () => pending,
    listenerCount: () =>
      Number(!!visibilityListener) + Number(!!onlineListener),
    setActive: (value) => (active = value),
    setVisible(value) {
      visible = value;
      visibilityListener?.();
    },
    online: () => onlineListener?.(),
    async next() {
      const [id, { callback, delayMs }] = timers.entries().next().value;
      timers.delete(id);
      callback();
      await flush();
      return delayMs;
    },
  };
}

test("polls immediately and every two seconds, pausing hidden tabs and refreshing online", async () => {
  const h = harness();
  assert.equal(h.pending(), 1);
  assert.equal(await h.next(), 0);
  assert.deepEqual(h.updates, [snapshot()]);
  assert.equal(await h.next(), FROZEN_MATERIALS_POLL_INTERVAL_MS);
  h.setVisible(false);
  assert.equal(h.timers.size, 0);
  h.setVisible(true);
  assert.equal(await h.next(), 0);
  h.online();
  assert.equal(await h.next(), 0);
  h.poller.stop();
  assert.equal(h.timers.size, 0);
  assert.equal(h.listenerCount(), 0);
});

test("coalesces invalidations and never overlaps reads", async () => {
  const pending = deferred();
  let loads = 0;
  const h = harness(() => (++loads === 1 ? pending.promise : snapshot(2)));
  await h.next();
  h.poller.refresh();
  h.poller.refresh();
  await h.next();
  assert.equal(loads, 1);
  assert.equal(h.signals[0].aborted, true);
  pending.resolve(snapshot(1));
  await flush();
  assert.equal(loads, 2);
  assert.deepEqual(h.updates, [snapshot(2)]);
  h.poller.stop();
});

test("keeps the confirmed balance on failures and uses bounded backoff", async () => {
  let failed = false;
  const h = harness(async () => {
    if (failed) throw new Error("offline");
    return snapshot();
  });
  await h.next();
  failed = true;
  await h.next();
  assert.equal(h.pending(), 1);
  assert.equal(h.errors.at(-1).refreshRequired, false);
  for (const expectedDelay of FROZEN_MATERIALS_BACKOFF_MS) {
    assert.equal(await h.next(), expectedDelay);
    assert.deepEqual(h.errors.at(-1).confirmed, snapshot());
  }
  assert.equal(await h.next(), 30_000);
  failed = false;
  await h.next();
  assert.equal(await h.next(), FROZEN_MATERIALS_POLL_INTERVAL_MS);
  h.poller.stop();
});

test("requires the first authoritative snapshot before sending or accepting", async () => {
  const h = harness(async () => {
    throw new Error("unavailable");
  });
  let mutations = 0;
  await assert.rejects(
    h.poller.runMutation(async () => (mutations += 1), {
      requiresSnapshot: true,
      isCurrent: () => true,
    }),
    /wager-balance-unavailable/,
  );
  assert.equal(mutations, 0);
  assert.equal(h.errors[0].confirmed, null);
  assert.equal(h.updates.length, 0);
  assert.equal(
    await h.poller.runMutation(async () => "cancelled", {
      isCurrent: () => true,
    }),
    "cancelled",
  );
  assert.equal(await h.next(), 0);
  h.poller.stop();
});

test("a pre-mutation response cannot overwrite optimistic state or double-apply the server count", async () => {
  const oldRead = deferred();
  const mutation = deferred();
  let loads = 0;
  const h = harness(() => {
    loads += 1;
    if (loads === 1) return snapshot(1, 2);
    if (loads === 2) return oldRead.promise;
    return snapshot(3, 5);
  });
  await h.next();
  await h.next();
  const action = h.poller.runMutation(() => mutation.promise, {
    requiresSnapshot: true,
    isCurrent: () => true,
  });
  await flush();
  assert.equal(h.signals[1].aborted, true);
  oldRead.resolve(snapshot(2, 3));
  await flush();
  assert.deepEqual(h.updates, [snapshot(1, 2)]);
  assert.equal(h.timers.size, 0);
  h.poller.refresh();
  assert.equal(h.timers.size, 0);
  mutation.resolve({ ok: true, count: 3 });
  assert.deepEqual(await action, { ok: true, count: 3 });
  assert.equal(await h.next(), 0);
  assert.deepEqual(h.updates, [snapshot(1, 2), snapshot(3, 5)]);
  h.poller.stop();
});

test("serializes mutations and refreshes after rejected results and thrown requests", async () => {
  const first = deferred();
  const order = [];
  const h = harness();
  await h.next();
  const send = h.poller.runMutation(
    async () => {
      order.push("send-start");
      await first.promise;
      order.push("send-end");
      return { ok: false };
    },
    { isCurrent: () => true },
  );
  const cancel = h.poller.runMutation(
    async () => {
      order.push("cancel");
      throw new Error("ambiguous-request");
    },
    { isCurrent: () => true },
  );
  const cancellation = assert.rejects(cancel, /ambiguous-request/);
  await flush();
  assert.deepEqual(order, ["send-start"]);
  first.resolve();
  assert.deepEqual(await send, { ok: false });
  await cancellation;
  assert.deepEqual(order, ["send-start", "send-end", "cancel"]);
  assert.equal(await h.next(), 0);
  h.poller.stop();
});

test("a later reserve waits for a post-mutation snapshot instead of stale optimism", async () => {
  const refresh = deferred();
  let reads = 0;
  const h = harness(() => (++reads === 1 ? snapshot() : refresh.promise));
  await h.next();
  await h.poller.runMutation(async () => ({ ok: true }), {
    isCurrent: () => true,
  });
  let accepted = false;
  const next = h.poller.runMutation(
    async () => {
      accepted = true;
    },
    { requiresSnapshot: true, isCurrent: () => true },
  );
  await flush();
  assert.equal(accepted, false);
  refresh.resolve(snapshot(2, 5));
  await next;
  assert.equal(accepted, true);
  h.poller.stop();
});

test("a failed post-mutation refresh retains confirmed counts and keeps new reserves fenced", async () => {
  let unavailable = false;
  const h = harness(async () => {
    if (unavailable) throw new Error("offline");
    return snapshot();
  });
  await h.next();
  await assert.rejects(
    h.poller.runMutation(
      async () => {
        unavailable = true;
        throw new Error("ambiguous-write");
      },
      { isCurrent: () => true },
    ),
    /ambiguous-write/,
  );
  assert.equal(await h.next(), 0);
  assert.deepEqual(h.errors.at(-1).confirmed, snapshot());
  assert.equal(h.errors.at(-1).refreshRequired, true);
  await assert.rejects(
    h.poller.runMutation(async () => assert.fail("unconfirmed reserve"), {
      requiresSnapshot: true,
      isCurrent: () => true,
    }),
    /wager-balance-unavailable/,
  );
  unavailable = false;
  assert.equal(
    await h.poller.runMutation(async () => "sent", {
      requiresSnapshot: true,
      isCurrent: () => true,
    }),
    "sent",
  );
  h.poller.stop();
});

test("ignores old actor/session responses and prevents queued old-context actions", async () => {
  const read = deferred();
  const h = harness(() => read.promise);
  await h.next();
  h.setActive(false);
  read.resolve(snapshot());
  await flush();
  assert.equal(h.updates.length, 0);
  await assert.rejects(
    h.poller.runMutation(async () => assert.fail("old actor action"), {
      isCurrent: () => true,
    }),
    /wager-session-changed/,
  );
  h.poller.stop();

  const first = deferred();
  let current = true;
  const next = harness();
  const running = next.poller.runMutation(() => first.promise, {
    isCurrent: () => current,
  });
  const queued = next.poller.runMutation(
    async () => assert.fail("old match action"),
    { isCurrent: () => current },
  );
  const rejection = assert.rejects(queued, /wager-session-changed/);
  await flush();
  current = false;
  first.resolve();
  await running;
  await rejection;
  next.poller.stop();
});

test("rejects actor mismatches and revision regression, while allowing bridge revision zero changes", async () => {
  const results = [
    snapshot(0, 1),
    snapshot(0, 2),
    snapshot(3, 3),
    snapshot(2, 4),
    snapshot(4, 4, "other"),
    snapshot(4, 0),
  ];
  const h = harness(async () => results.shift());
  for (let index = 0; index < 6; index += 1) await h.next();
  assert.deepEqual(h.updates, [
    snapshot(0, 1),
    snapshot(0, 2),
    snapshot(3, 3),
    snapshot(4, 0),
  ]);
  assert.equal(h.errors.length, 2);
  assert.deepEqual(h.errors[0].confirmed, snapshot(3, 3));
  h.poller.stop();
});

test("stopping during a request aborts it and rejects its late completion", async () => {
  const read = deferred();
  const h = harness(() => read.promise);
  await h.next();
  h.poller.stop();
  assert.equal(h.signals[0].aborted, true);
  read.resolve(snapshot());
  await flush();
  assert.equal(h.updates.length, 0);
  assert.equal(h.timers.size, 0);
  assert.equal(h.listenerCount(), 0);
});
