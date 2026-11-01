import { canonicalProfile, required } from "./fixtures/canonicalData.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = ts.createSourceFile(
  "gameController.ts",
  readFileSync(
    new URL("../src/game/gameController.ts", import.meta.url),
    "utf8",
  ),
  ts.ScriptTarget.Latest,
  true,
);
const method = source.statements.find(
  (node) =>
    ts.isFunctionDeclaration(node) && node.name?.text === "enterWatchOnlyMode",
);
const { outputText } = ts.transpileModule(
  required(method)
    .getText(source)
    .replace(/^export /, ""),
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
);
const flush = () => new Promise(setImmediate);
const profile = canonicalProfile({
  id: "profile",
  mining: {
    lastRockDate: null,
    materials: { dust: 2, slime: 0, gum: 0, metal: 0, ice: 0 },
  },
});
/** @typedef {import("../src/session/sessionAuth.ts").SessionUser} SessionUser */
/** @typedef {{user: SessionUser; read(): import("@mons/shared/session-bootstrap").SessionIdentityBootstrap | null}} InitialReadProbe */
/**
 * @template [T=InitialReadProbe]
 * @returns {Pick<PromiseWithResolvers<T>, "promise" | "resolve">}
 */
const deferred = () => {
  /** @type {PromiseWithResolvers<T>} */
  const { promise, resolve } = Promise.withResolvers();
  return { promise, resolve };
};
/** @param {{pending?: Promise<InitialReadProbe> | null; consumed?: boolean}} [options] */
function harness({ pending = null, consumed = false } = {}) {
  /** @type {SessionUser} */
  const user = {
    uid: "login",
    sessionId: "session",
    generation: "generation",
    getIdToken: async () => "token",
  };
  const state = { loginId: "login", profileId: "profile", epoch: 1 };
  /** @type {{currentUser: SessionUser | null}} */
  const auth = { currentUser: user };
  /** @type {string[]} */
  const reads = [];
  /** @type {import("@mons/shared/profiles").PlayerProfile[]} */
  const applied = [];
  const dependencies = {
    /** @template T @param {() => T} callback @returns {T} */
    batchGameControlsUpdates: (callback) => callback(),
    setWatchOnlyState: () => {},
    setWatchOnlyVisible: () => {},
    storage: {
      getLoginId: () => state.loginId,
      getProfileId: () => state.profileId,
    },
    sessionAuth: auth,
    getSessionGuard: () => {
      const epoch = state.epoch;
      return () => state.epoch === epoch;
    },
    wasInitialIdentityConsumed: (/** @type {SessionUser} */ owner) => {
      assert.equal(owner, user);
      return consumed;
    },
    peekInitialIdentity: (/** @type {SessionUser} */ owner) => {
      assert.equal(owner, user);
      return pending;
    },
    syncOwnProfileMiningState: (
      /** @type {import("@mons/shared/profiles").PlayerProfile} */ value,
    ) => applied.push(value),
    connection: {
      getProfileByLoginId: async (/** @type {string} */ uid) => {
        reads.push(uid);
        return profile;
      },
    },
  };
  const load =
    /** @type {(...values: unknown[]) => typeof import("../src/game/gameController.ts").enterWatchOnlyMode} */ (
      new Function(
        ...Object.keys(dependencies),
        `${outputText}\nreturn enterWatchOnlyMode;`,
      )
    );
  const enter = load(...Object.values(dependencies));
  return { enter, reads, applied, state, auth, user };
}

test("initial spectator joins verified identity mining; later entry refreshes over the network", async () => {
  const gate = deferred();
  const h = harness({ pending: gate.promise });
  h.enter(true);
  await flush();
  assert.deepEqual(h.reads, []);
  gate.resolve({ user: h.user, read: () => ({ ok: true, profile }) });
  await flush();
  assert.deepEqual(h.applied, [profile]);
  assert.deepEqual(h.reads, []);
  h.enter();
  await flush();
  assert.deepEqual(h.reads, ["login"]);
});

test("initial spectator skips mining already applied by verified profile consumption", async () => {
  const h = harness({ consumed: true });
  h.enter(true);
  await flush();
  assert.deepEqual(h.reads, []);
  assert.deepEqual(h.applied, []);
  h.enter();
  await flush();
  assert.deepEqual(h.reads, ["login"]);
});

test("missing, unavailable and invalidated identity fall back to fresh own-profile reads", async () => {
  for (const value of /** @type {const} */ ([
    null,
    { ok: false, status: 503 },
    "invalidated",
  ])) {
    const gate = deferred();
    const h = harness({ pending: value === null ? null : gate.promise });
    h.enter(true);
    gate.resolve({
      user: h.user,
      read: () => {
        if (value === "invalidated") throw new Error("authentication-changed");
        return value;
      },
    });
    await flush();
    assert.deepEqual(h.reads, ["login"]);
    assert.deepEqual(h.applied, [profile]);
  }
});

test("later first spectator entry refreshes even with a consumed startup identity", async () => {
  const h = harness({ consumed: true });
  h.state.epoch++;
  h.enter();
  await flush();
  assert.deepEqual(h.reads, ["login"]);
  assert.deepEqual(h.applied, [profile]);
});

test("stored alias identities cannot reuse startup mining", async () => {
  const h = harness({ consumed: true });
  h.state.loginId = "alias";
  h.enter(true);
  await flush();
  assert.deepEqual(h.reads, ["alias"]);
});

test("late spectator identity cannot hydrate after logout, same-UID replacement, route teardown or changed profile", async () => {
  for (const change of /** @satisfies {Array<(h: ReturnType<typeof harness>) => void>} */ ([
    (h) => {
      h.auth.currentUser = null;
    },
    (h) => {
      h.auth.currentUser = { ...h.user, generation: "replacement" };
    },
    (h) => {
      h.state.epoch++;
    },
    (h) => {
      h.state.profileId = "replacement-profile";
    },
  ])) {
    const gate = deferred();
    const h = harness({ pending: gate.promise });
    h.enter(true);
    change(h);
    gate.resolve({ user: h.user, read: () => ({ ok: true, profile }) });
    await flush();
    assert.deepEqual(h.reads, []);
    assert.deepEqual(h.applied, []);
  }
});
