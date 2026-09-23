import assert from "node:assert/strict";
import test from "node:test";
import { createWalletAuthFlowController } from "../src/ui/identity/walletAuthFlowController.ts";

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};
const flush = () => new Promise((resolve) => setImmediate(resolve));

const harness = (dependencies = {}, options = {}, notFoundDurationMs = 500) => {
  const calls = [];
  const timers = new Map();
  let nextTimer = 0;
  const proof = { signature: "signature", intentId: "intent" };
  const result = { ok: true, uid: "user" };
  const controller = createWalletAuthFlowController({
    notFoundDurationMs,
    dependencies: {
      connect: async () => {
        calls.push(["connect"]);
        return proof;
      },
      verify: async (value) => {
        calls.push(["verify", value]);
        return result;
      },
      setTimeout: (callback, delay) => {
        const id = ++nextTimer;
        timers.set(id, { callback, delay });
        return id;
      },
      clearTimeout: (id) => timers.delete(id),
      ...dependencies,
    },
  });
  controller.setOptions({
    canStart: () => true,
    onStart: () => calls.push(["start"]),
    onVerified: (...args) => calls.push(["verified", ...args]),
    onError: (error) => calls.push(["error", error]),
    onSettled: (mounted) => calls.push(["settled", mounted]),
    ...options,
  });
  const states = [];
  controller.subscribe(() => states.push(controller.getSnapshot()));
  return { controller, calls, states, timers, proof, result };
};

test("one wallet action connects and verifies once despite duplicate starts", async () => {
  const connecting = deferred();
  const verifying = deferred();
  let connectCalls = 0;
  const h = harness({
    connect: () => {
      connectCalls += 1;
      return connecting.promise;
    },
    verify: (proof) => {
      h.calls.push(["verify", proof]);
      return verifying.promise;
    },
  });
  const first = h.controller.start();
  await h.controller.start();
  assert.equal(connectCalls, 1);
  assert.equal(h.controller.getSnapshot(), "connecting");
  connecting.resolve(h.proof);
  await flush();
  assert.equal(h.controller.getSnapshot(), "verifying");
  await h.controller.start();
  assert.equal(connectCalls, 1);
  verifying.resolve(h.result);
  await first;
  assert.deepEqual(h.states, ["connecting", "verifying", "idle"]);
  assert.deepEqual(h.calls, [
    ["start"],
    ["verify", h.proof],
    ["verified", h.result, true],
    ["settled", true],
  ]);
});

test("picker cancellation settles without verification or an error", async () => {
  const h = harness({ connect: async () => null });
  await h.controller.start();
  assert.deepEqual(h.calls, [["start"], ["settled", true]]);
  assert.deepEqual(h.states, ["connecting", "idle"]);
});

for (const duration of [500, 650]) {
  test(`not-found feedback resets after the configured ${duration}ms`, async () => {
    const error = new Error("not found");
    const h = harness(
      {
        connect: async () => {
          throw error;
        },
      },
      {},
      duration,
    );
    await h.controller.start();
    assert.equal(h.controller.getSnapshot(), "not-found");
    assert.equal(h.timers.size, 1);
    const { callback, delay } = [...h.timers.values()][0];
    assert.equal(delay, duration);
    assert.deepEqual(h.calls, [["start"], ["error", error], ["settled", true]]);
    callback();
    assert.equal(h.controller.getSnapshot(), "idle");
  });
}

test("a retry clears not-found feedback and its old timer cannot reset the new action", async () => {
  const connecting = deferred();
  let attempts = 0;
  const h = harness({
    connect: () =>
      ++attempts === 1
        ? Promise.reject(new Error("not found"))
        : connecting.promise,
  });
  await h.controller.start();
  const oldTimer = [...h.timers.values()][0].callback;
  const retry = h.controller.start();
  assert.equal(h.timers.size, 0);
  oldTimer();
  assert.equal(h.controller.getSnapshot(), "connecting");
  connecting.resolve(h.proof);
  await retry;
  assert.equal(h.calls.filter(([name]) => name === "verified").length, 1);
});

test("ordinary errors return to idle and keep the original error", async () => {
  const error = new Error("authentication-cooldown");
  const h = harness({
    verify: async () => {
      throw error;
    },
  });
  await h.controller.start();
  assert.equal(h.controller.getSnapshot(), "idle");
  assert.equal(h.timers.size, 0);
  assert.deepEqual(h.calls.slice(-2), [
    ["error", error],
    ["settled", true],
  ]);
});

test("separate wallet controllers can run independently or honor a shared settings gate", async () => {
  const firstConnect = deferred();
  const secondConnect = deferred();
  const independent = [
    harness({ connect: () => firstConnect.promise }),
    harness({ connect: () => secondConnect.promise }),
  ];
  const actions = independent.map(({ controller }) => controller.start());
  assert.deepEqual(
    independent.map(({ controller }) => controller.getSnapshot()),
    ["connecting", "connecting"],
  );
  firstConnect.resolve(null);
  secondConnect.resolve(null);
  await Promise.all(actions);

  let busy = false;
  const pending = deferred();
  const options = {
    canStart: () => !busy,
    onStart: () => {
      busy = true;
    },
    onSettled: () => {
      busy = false;
    },
  };
  const first = harness({ connect: () => pending.promise }, options);
  const second = harness({}, options);
  const action = first.controller.start();
  await second.controller.start();
  assert.deepEqual(second.calls, []);
  pending.resolve(null);
  await action;
  await second.controller.start();
  assert.equal(
    second.calls.some(([name]) => name === "verified"),
    true,
  );
});

for (const phase of ["connect", "verify"]) {
  test(`detach during ${phase} preserves completion policy without UI notifications`, async () => {
    const pending = deferred();
    const h = harness({ [phase]: () => pending.promise });
    const action = h.controller.start();
    await flush();
    h.controller.detach();
    const stateCount = h.states.length;
    pending.resolve(phase === "connect" ? h.proof : h.result);
    await action;
    assert.equal(h.states.length, stateCount);
    assert.deepEqual(h.calls.slice(-2), [
      ["verified", h.result, false],
      ["settled", false],
    ]);
  });
}

test("detaching clears timers and suppresses late errors", async () => {
  const notFound = harness({
    connect: async () => {
      throw new Error("not found");
    },
  });
  await notFound.controller.start();
  notFound.controller.detach();
  assert.equal(notFound.timers.size, 0);
  const pending = deferred();
  const h = harness({ connect: () => pending.promise });
  const action = h.controller.start();
  h.controller.detach();
  pending.reject(new Error("not found"));
  await action;
  assert.deepEqual(h.calls, [["start"], ["settled", false]]);
  assert.equal(h.timers.size, 0);
});

for (const phase of ["connect", "verify"]) {
  test(`invalidating during ${phase} fences stale completion without blocking a new attempt`, async () => {
    const pending = deferred();
    let attempts = 0;
    const h = harness({
      [phase]: () =>
        ++attempts === 1
          ? pending.promise
          : Promise.resolve(phase === "connect" ? h.proof : h.result),
    });
    const stale = h.controller.start();
    await flush();
    h.controller.invalidateAction();
    await h.controller.start();
    const calls = [...h.calls];
    pending.resolve(phase === "connect" ? h.proof : h.result);
    await stale;
    assert.deepEqual(h.calls, calls);
    assert.equal(h.calls.filter(([name]) => name === "verified").length, 1);
    assert.equal(h.controller.getSnapshot(), "idle");
  });
}

test("attach after the StrictMode cleanup permits actions with current callbacks", async () => {
  const h = harness({}, { canStart: () => false });
  h.controller.detach();
  h.controller.attach();
  await h.controller.start();
  assert.deepEqual(h.calls, []);
  const verified = [];
  h.controller.setOptions({
    canStart: () => true,
    onStart: () => {},
    onVerified: (...args) => verified.push(args),
    onError: () => {},
  });
  await h.controller.start();
  assert.deepEqual(verified, [[h.result, true]]);
});
