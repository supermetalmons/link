import { createTimerHandle } from "./fixtures/timerHandle.mjs";
import { required } from "./fixtures/canonicalData.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { startNavigationGamesPolling } from "../src/connection/navigationGamesPoller.ts";

/** @template T @param {() => Promise<T>} load */
function harness(load) {
  let visible = true;
  let active = true;
  let invalidation = () => {};
  let visibility = () => {};
  /** @type {Map<ReturnType<typeof createTimerHandle>, {callback: () => void; delay: number}>} */
  const timers = new Map();
  /** @type {T[]} */
  const updates = [];
  /** @type {Array<unknown>} */
  const errors = [];
  const stop = startNavigationGamesPolling({
    addInvalidationListener(listener) {
      invalidation = listener;
      return () => {
        invalidation = () => {};
      };
    },
    addVisibilityListener(listener) {
      visibility = listener;
      return () => {
        visibility = () => {};
      };
    },
    clearTimer(id) {
      timers.delete(id);
    },
    intervalMs: 5_000,
    isActive: () => active,
    isVisible: () => visible,
    load,
    maxConsecutiveFailures: 3,
    onError: (error) => errors.push(error),
    onUpdate: (value) => updates.push(value),
    setTimer(callback, delay) {
      const id = createTimerHandle();
      timers.set(id, { callback, delay });
      return id;
    },
  });
  return {
    errors,
    invalidate: () => invalidation(),
    /**
     * @param {boolean} value
     */
    setActive(value) {
      active = value;
    },
    /**
     * @param {boolean} value
     */
    setVisible(value) {
      visible = value;
      visibility();
    },
    stop,
    timers,
    updates,
    async runNext() {
      const entry = timers.entries().next().value;
      assert.ok(entry);
      timers.delete(entry[0]);
      entry[1].callback();
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

test("navigation polling refreshes immediately, pauses while hidden, and resumes", async () => {
  let reads = 0;
  const polling = harness(async () => ++reads);
  assert.equal(required([...polling.timers.values()][0]).delay, 0);
  await polling.runNext();
  assert.deepEqual(polling.updates, [1]);
  assert.equal(required([...polling.timers.values()][0]).delay, 5_000);

  polling.setVisible(false);
  assert.equal(polling.timers.size, 0);
  polling.setVisible(true);
  assert.equal(required([...polling.timers.values()][0]).delay, 0);
  await polling.runNext();
  assert.deepEqual(polling.updates, [1, 2]);

  polling.stop();
  assert.equal(polling.timers.size, 0);
});

test("navigation polling never overlaps and stops after three later failures", async () => {
  /** @type {PromiseWithResolvers<string>} */
  const { promise: firstResponse, resolve: resolveFirst } =
    Promise.withResolvers();
  let attempts = 0;
  const polling = harness(() => {
    attempts += 1;
    if (attempts === 1) {
      return firstResponse;
    }
    return Promise.reject(new Error(`failure-${attempts}`));
  });
  const firstTimer = polling.timers.entries().next().value;
  polling.timers.delete(required(firstTimer)[0]);
  required(firstTimer)[1].callback();
  polling.invalidate();
  assert.equal(attempts, 1);
  required(resolveFirst)("first");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(required([...polling.timers.values()][0]).delay, 0);
  await polling.runNext();
  await polling.runNext();
  await polling.runNext();
  assert.equal(attempts, 4);
  assert.equal(polling.errors.length, 1);
  assert.equal(polling.timers.size, 0);
});

test("navigation polling stops after three initial failures and a fresh subscription retries", async () => {
  let attempts = 0;
  const polling = harness(async () => {
    attempts += 1;
    throw new Error(`failure-${attempts}`);
  });

  await polling.runNext();
  assert.equal(polling.errors.length, 0);
  await polling.runNext();
  assert.equal(polling.errors.length, 0);
  await polling.runNext();
  assert.equal(attempts, 3);
  assert.equal(polling.errors.length, 1);
  assert.equal(polling.timers.size, 0);
  polling.stop();

  const reopened = harness(async () => "reopened");
  await reopened.runNext();
  assert.deepEqual(reopened.updates, ["reopened"]);
  reopened.stop();
});
