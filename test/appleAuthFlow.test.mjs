import { canonicalAppearance, required } from "./fixtures/canonicalData.mjs";
import { createTimerHandle } from "./fixtures/timerHandle.mjs";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      context.parentURL?.endsWith(".ts") &&
      (specifier.startsWith("./") || specifier.startsWith("../")) &&
      !/\.[^/]+$/.test(specifier)
    ) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});

const { createAppleAuthFlowController } =
  await import("../src/ui/identity/appleAuthFlowController.ts");
const {
  APPLE_INTENT_REFRESH_BUFFER_MS,
  getSettingsAppleFlowInProgress,
  setSettingsAppleFlowInProgress,
  subscribeSettingsAppleFlowProgress,
} = await import("../src/ui/identity/authFlowState.ts");

/**
 * @template [T=import("@mons/shared/auth").AuthIntentResponse]
 * @returns {PromiseWithResolvers<T>}
 */
const deferred = () => {
  return Promise.withResolvers();
};

const flush = () => new Promise((resolve) => setImmediate(resolve));
/** @param {number} expiresAtMs @returns {import("@mons/shared/auth").AuthIntentResponse} */
const intent = (expiresAtMs, intentId = "intent") => ({
  ok: true,
  intentId,
  nonce: "nonce",
  state: "state",
  expiresAtMs,
});

/** @param {Partial<Parameters<typeof createAppleAuthFlowController>[0]["dependencies"]>} [overrides]
 * @param {Partial<import("../src/ui/identity/appleAuthFlowController.ts").AppleAuthFlowOptions>} [optionOverrides]
 * @param {import("../src/ui/identity/appleAuthFlowController.ts").AppleConsentSource} [source] */
const harness = (overrides = {}, optionOverrides = {}, source = "signin") => {
  let time = 100_000;
  /** @type {Map<ReturnType<typeof createTimerHandle>, {callback: () => void; at: number}>} */
  const timers = new Map();
  /** @type {Array<[string, ...unknown[]]>} */
  const calls = [];
  /** @type {import("@mons/shared/auth").AuthProfileResponse} */
  const result = {
    ok: true,
    uid: "user",
    profileId: "profile",
    username: null,
    linkedMethods: { apple: true, eth: false, sol: false, x: false },
    appleLinked: true,
    opId: "operation",
    ...canonicalAppearance(),
  };
  const controller = createAppleAuthFlowController({
    consentSource: source,
    dependencies: {
      beginIntent: async () => {
        calls.push(["intent"]);
        return intent(time + 120_000);
      },
      preload: async () => {
        calls.push(["preload"]);
      },
      openPopup: async (request) => {
        calls.push(["popup", request]);
        return { idToken: "token" };
      },
      verify: async (...args) => {
        calls.push(["verify", ...args]);
        return result;
      },
      flushUi: (update) => {
        calls.push(["flush-start"]);
        update();
        calls.push(["flush-end"]);
      },
      now: () => time,
      setTimeout: new Proxy(setTimeout, {
        apply(_target, _receiver, /** @type {unknown[]} */ args) {
          const [callback, delay = 0, ...values] = args;
          assert.ok(
            typeof callback === "function" && typeof delay === "number",
          );
          const id = createTimerHandle();
          timers.set(id, {
            callback: () => {
              Reflect.apply(callback, undefined, values);
            },
            at: time + delay,
          });
          return id;
        },
      }),
      clearTimeout: (id) => {
        if (typeof id === "object" && id !== null) timers.delete(id);
      },
      ...overrides,
    },
  });
  /** @type {import("../src/ui/identity/appleAuthFlowController.ts").AppleAuthFlowOptions} */
  const options = {
    canStart: () => true,
    canConfirm: () => true,
    onStart: () => calls.push(["start"]),
    onPopupStart: () => calls.push(["popup-start"]),
    onPopupSettled: (...args) => calls.push(["settled", ...args]),
    onVerified: (...args) => calls.push(["verified", ...args]),
    onError: (...args) => calls.push(["error", ...args]),
    ...optionOverrides,
  };
  controller.setOptions(options);
  return {
    controller,
    calls,
    timers,
    result,
    setOptions: (
      /** @type {Partial<import("../src/ui/identity/appleAuthFlowController.ts").AppleAuthFlowOptions>} */ nextOptions,
    ) => controller.setOptions({ ...options, ...nextOptions }),
    advance: (/** @type {number} */ duration) => {
      time += duration;
      for (const [id, timer] of timers) {
        if (timer.at <= time) {
          timers.delete(id);
          timer.callback();
        }
      }
    },
  };
};

test("cold click prepares once and requires a second click to open Apple", async () => {
  const pending = deferred();
  let intentCalls = 0;
  const { controller, calls, timers } = harness({
    beginIntent: () => {
      intentCalls++;
      return pending.promise;
    },
  });
  const preload = controller.prepare();
  const click = controller.start();
  assert.equal(controller.getSnapshot(), "preparing");
  await controller.start();
  assert.equal(intentCalls, 1);
  pending.resolve(intent(220_000));
  await Promise.all([preload, click]);
  assert.equal(controller.getSnapshot(), "confirm");
  assert.equal(timers.size, 1);
  assert.equal(
    calls.some(([name]) => name === "popup"),
    false,
  );

  const connect = controller.start();
  assert.equal(controller.getSnapshot(), "connecting");
  assert.equal(timers.size, 0);
  assert.deepEqual(
    calls.slice(-4).map(([name]) => name),
    ["flush-start", "popup-start", "flush-end", "popup"],
  );
  await connect;
  assert.deepEqual(
    calls.find(([name]) => name === "verify"),
    ["verify", "intent", "token", "signin"],
  );
  assert.equal(controller.getSnapshot(), "idle");

  await controller.start();
  assert.equal(controller.getSnapshot(), "confirm");
  assert.equal(intentCalls, 2);
  assert.equal(calls.filter(([name]) => name === "popup").length, 1);
});

test("confirmation expires at the existing refresh margin and stale clicks prepare", async () => {
  const { controller, advance, timers, calls } = harness();
  await controller.start();
  advance(120_000 - APPLE_INTENT_REFRESH_BUFFER_MS);
  await controller.start();
  assert.equal(controller.getSnapshot(), "confirm");
  assert.equal(
    calls.some(([name]) => name === "popup"),
    false,
  );
  assert.equal(calls.filter(([name]) => name === "intent").length, 2);
  advance(120_000 - APPLE_INTENT_REFRESH_BUFFER_MS + 50);
  assert.equal(controller.getSnapshot(), "idle");
  assert.equal(timers.size, 0);
});

test("confirmation uses current visibility policy while prepared intent is retained", async () => {
  const pending = deferred();
  const { controller, calls, setOptions } = harness({
    beginIntent: () => pending.promise,
  });
  const firstClick = controller.start();
  setOptions({ canConfirm: () => false });
  pending.resolve(intent(220_000));
  await firstClick;
  assert.equal(controller.getSnapshot(), "idle");
  setOptions({ canConfirm: () => true });
  const nextClick = controller.start();
  assert.equal(calls.filter(([name]) => name === "popup").length, 1);
  await nextClick;
});

test("clearing an intent prevents an older preload overwriting the replacement", async () => {
  const oldIntent = deferred();
  const newIntent = deferred();
  let requests = 0;
  const { controller, calls } = harness({
    beginIntent: () =>
      ++requests === 1 ? oldIntent.promise : newIntent.promise,
  });
  const oldPreparation = controller.prepare();
  controller.clearIntent();
  const preparation = controller.prepare();
  newIntent.resolve(intent(220_000, "new"));
  await preparation;
  oldIntent.resolve(intent(220_000, "old"));
  await oldPreparation;
  await controller.start();
  assert.equal(
    fixtureField(
      required(calls.find(([name]) => name === "popup"))[1],
      "intentId",
    ),
    "new",
  );
});

test("invalidated preparation cannot restore confirmation after an unlink reset", async () => {
  const pending = deferred();
  const { controller, calls, timers } = harness({
    beginIntent: () => pending.promise,
  });
  const preparation = controller.start();
  controller.invalidateAction();
  controller.clearIntent();
  pending.resolve(intent(220_000));
  await preparation;
  assert.equal(controller.getSnapshot(), "idle");
  assert.equal(timers.size, 0);
  assert.equal(
    calls.some(([name]) => name === "popup"),
    false,
  );
});

test("resetting UI does not cancel verification, and duplicate clicks remain blocked", async () => {
  /** @type {PromiseWithResolvers<import("@mons/shared/auth").AuthVerificationResponse>} */
  const verification = deferred();
  const { controller, calls, result } = harness({
    verify: () => verification.promise,
  });
  await controller.prepare();
  const connect = controller.start();
  await flush();
  assert.equal(controller.getSnapshot(), "verifying");
  controller.resetUi();
  await controller.start();
  assert.equal(calls.filter(([name]) => name === "popup").length, 1);
  verification.resolve(result);
  await connect;
  assert.deepEqual(
    calls.find(([name]) => name === "verified"),
    ["verified", result, true],
  );
});

test("invalidating linked Apple action suppresses stale success and still settles", async () => {
  /** @type {PromiseWithResolvers<import("@mons/shared/auth").AuthVerificationResponse>} */
  const verification = deferred();
  const { controller, calls, result } = harness({
    verify: () => verification.promise,
  });
  await controller.prepare();
  const connect = controller.start();
  await flush();
  controller.invalidateAction();
  verification.resolve(result);
  await connect;
  assert.equal(
    calls.some(([name]) => name === "verified"),
    false,
  );
  assert.deepEqual(
    calls.find(([name]) => name === "settled"),
    ["settled", false, true],
  );
  assert.equal(controller.getSnapshot(), "idle");
});

test("invalidating a pending popup prevents stale verification", async () => {
  /** @type {PromiseWithResolvers<{idToken: string} | null>} */
  const popup = deferred();
  const { controller, calls } = harness({ openPopup: () => popup.promise });
  await controller.prepare();
  const connect = controller.start();
  controller.invalidateAction();
  popup.resolve({ idToken: "stale" });
  await connect;
  assert.equal(
    calls.some(([name]) => name === "verify"),
    false,
  );
  assert.equal(calls.filter(([name]) => name === "settled").length, 1);
});

test("unmount clears expiry timers and reattach restores confirmation lifecycle", async () => {
  const { controller, timers, advance } = harness();
  await controller.start();
  controller.detach();
  assert.equal(timers.size, 0);
  advance(120_000);
  controller.attach();
  assert.equal(controller.getSnapshot(), "idle");
  assert.equal(timers.size, 0);
});

test("settings lock survives unmount until verification finishes and releases for a remount", async () => {
  setSettingsAppleFlowInProgress(false);
  /** @type {PromiseWithResolvers<import("@mons/shared/auth").AuthVerificationResponse>} */
  const verification = deferred();
  const settingsOptions = {
    canStart: () => !getSettingsAppleFlowInProgress(),
    onPopupStart: () => setSettingsAppleFlowInProgress(true),
    onPopupSettled: () => setSettingsAppleFlowInProgress(false),
  };
  const original = harness(
    { verify: () => verification.promise },
    settingsOptions,
    "settings",
  );
  /** @type {Array<boolean>} */
  const states = [];
  const unsubscribe = subscribeSettingsAppleFlowProgress((state) =>
    states.push(state),
  );
  try {
    await original.controller.prepare();
    const connect = original.controller.start();
    assert.equal(getSettingsAppleFlowInProgress(), true);
    assert.equal(
      fixtureField(
        required(original.calls.find(([name]) => name === "popup"))[1],
        "consentSource",
      ),
      "settings",
    );
    let notificationsAfterDetach = 0;
    original.controller.detach();
    original.controller.subscribe(() => {
      notificationsAfterDetach++;
    });
    const remount = harness({}, settingsOptions, "settings");
    await remount.controller.prepare();
    await remount.controller.start();
    assert.equal(
      remount.calls.some(([name]) => name === "popup"),
      false,
    );
    verification.resolve(original.result);
    await connect;
    assert.deepEqual(
      original.calls.find(([name]) => name === "verified"),
      ["verified", original.result, false],
    );
    assert.equal(getSettingsAppleFlowInProgress(), false);
    assert.equal(notificationsAfterDetach, 0);
    assert.deepEqual(states, [true, false]);
    await remount.controller.start();
    assert.equal(remount.calls.filter(([name]) => name === "popup").length, 1);
  } finally {
    unsubscribe();
    setSettingsAppleFlowInProgress(false);
  }
});

test("redirect null, preparation failure, popup failure, and verify failure recover", async () => {
  const redirect = harness({ openPopup: async () => null });
  await redirect.controller.prepare();
  await redirect.controller.start();
  assert.equal(redirect.controller.getSnapshot(), "idle");
  assert.equal(
    redirect.calls.some(([name]) => name === "verify"),
    false,
  );
  assert.equal(redirect.calls.filter(([name]) => name === "settled").length, 1);

  for (const phase of ["prepare", "popup", "verify"]) {
    const error = new Error(phase);
    const dependencies = {
      [phase === "prepare"
        ? "beginIntent"
        : phase === "popup"
          ? "openPopup"
          : "verify"]: async () => {
        throw error;
      },
    };
    const flow = harness(dependencies);
    if (phase !== "prepare") await flow.controller.prepare();
    await flow.controller.start();
    assert.equal(flow.controller.getSnapshot(), "idle");
    assert.deepEqual(
      flow.calls.find(([name]) => name === "error"),
      ["error", error, phase === "prepare" ? "prepare" : "connect"],
    );
    assert.equal(
      flow.calls.filter(([name]) => name === "settled").length,
      phase === "prepare" ? 0 : 1,
    );
  }
});

/** @param {unknown} value @param {string} key @returns {unknown} */
function fixtureField(value, key) {
  assert.ok(value !== null && typeof value === "object" && key in value);
  return Reflect.get(value, key);
}
