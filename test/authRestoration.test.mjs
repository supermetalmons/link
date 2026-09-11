import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { normalizeProfileEmojiId } from "../cloud/runtime/shared/profiles.js";
import { ProfileApiError } from "../src/services/profileApi.ts";

const source = ts.createSourceFile(
  "authentication.ts",
  readFileSync(
    new URL("../src/connection/authentication.ts", import.meta.url),
    "utf8",
  ),
  ts.ScriptTarget.Latest,
  true,
);
const hook = source.statements.find(
  (node) =>
    ts.isFunctionDeclaration(node) && node.name?.text === "useAuthStatus",
);
const effect = hook.body.statements
  .filter(
    (node) =>
      ts.isExpressionStatement(node) &&
      ts.isCallExpression(node.expression) &&
      node.expression.expression.getText(source) === "useEffect",
  )
  .map((node) => node.expression.arguments[0])
  .find((node) => node.getText(source).includes("subscribeToAuthChanges"));
assert.ok(effect, "missing auth restoration effect");
const { outputText } = ts.transpileModule(
  `const restoreAuth = ${effect.getText(source)};`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
);
const authStatusCallback = hook.body.statements
  .filter(ts.isVariableStatement)
  .flatMap((node) => node.declarationList.declarations)
  .find((node) => node.name.getText(source) === "setAuthStatus").initializer
  .arguments[0];
const { outputText: authStatusOutput } = ts.transpileModule(
  `const applyAuthStatus = ${authStatusCallback.getText(source)};`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
);

const cachedIdentity = {
  loginId: "login-1",
  profileId: "profile-1",
  username: "Cached player",
  ethAddress: "cached-eth",
  solAddress: "cached-sol",
  playerEmojiId: "7",
  playerEmojiAura: "cached-aura",
};
const authoritativeProfile = {
  id: "profile-2",
  username: "Canonical player",
  eth: "canonical-eth",
  sol: "canonical-sol",
  emoji: 9,
  aura: "canonical-aura",
  mining: { materials: {} },
};
const unavailable = async () => {
  throw new Error("unavailable");
};
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

function harness({
  syncProfile = async () => ({ ok: true, profileId: "profile-1" }),
  lookupProfile = async () => authoritativeProfile,
  watchOnly = false,
  stored = {},
  claimProfileId = "",
} = {}) {
  const data = { ...cachedIdentity, ...stored };
  const events = {
    statuses: [],
    profiles: [],
    displays: [],
    syncs: 0,
    lookups: [],
    claimReads: 0,
    tokenRefreshes: 0,
    mining: [],
    flushes: 0,
    attempts: 0,
    unsubscribed: false,
  };
  const timers = new Map();
  const windowListeners = new Map();
  const documentListeners = new Map();
  const eventTarget = (listeners) => ({
    addEventListener: (type, callback) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(callback);
    },
    removeEventListener: (type, callback) => {
      listeners.get(type)?.delete(callback);
    },
  });
  const document = {
    ...eventTarget(documentListeners),
    visibilityState: "visible",
  };
  const navigator = { onLine: true };
  const storage = {};
  for (const field of Object.keys(data)) {
    const suffix = field[0].toUpperCase() + field.slice(1);
    storage[`get${suffix}`] = (fallback) => data[field] ?? fallback;
    storage[`set${suffix}`] = (value) => {
      data[field] = value;
    };
  }
  storage.getAuthIdentity = () => ({
    profileId: data.profileId,
    ethAddress: data.ethAddress,
    solAddress: data.solAddress,
  });
  let authCallback;
  let sessionEpoch = 0;
  let nextTimerId = 0;
  const connection = {
    auth: { currentUser: { uid: "login-1" } },
    isCurrentAuthUser: (uid) => connection.auth.currentUser?.uid === uid,
    createSessionGuard: () => {
      const epoch = sessionEpoch;
      return () => epoch === sessionEpoch;
    },
    subscribeToAuthChanges: (callback) => {
      authCallback = callback;
      return () => {
        events.unsubscribed = true;
      };
    },
    syncProfile: async () => {
      events.syncs++;
      return syncProfile();
    },
    getProfileByLoginId: async (uid) => {
      events.lookups.push(uid);
      return lookupProfile(uid);
    },
    getCurrentProfileClaimId: async () => {
      events.claimReads++;
      return claimProfileId;
    },
    refreshTokenIfNeeded: () => {
      events.tokenRefreshes++;
    },
    getSameProfilePlayerUid: () => null,
  };
  const authChangeVersionRef = { current: 0 };
  let authState = { authStatus: "authenticated", ...storage.getAuthIdentity() };
  const statusDependencies = {
    authChangeVersionRef,
    storage,
    EMPTY_AUTH_IDENTITY: { profileId: "", ethAddress: "", solAddress: "" },
    setAuthState: (update) => {
      authState = update(authState);
      events.statuses.push(authState.authStatus);
    },
  };
  const setAuthStatus = new Function(
    ...Object.keys(statusDependencies),
    `${authStatusOutput}\nreturn applyAuthStatus;`,
  )(...Object.values(statusDependencies));
  const dependencies = {
    authAttemptTimeoutIdsRef: { current: new Set() },
    authChangeVersionRef,
    connection,
    storage,
    setAuthStatus,
    window: {
      ...eventTarget(windowListeners),
      setTimeout: (callback, delay) => {
        const id = ++nextTimerId;
        timers.set(id, { callback, delay });
        return id;
      },
      clearTimeout: (id) => timers.delete(id),
    },
    document,
    navigator,
    ProfileApiError,
    didAttemptAuthentication: () => {
      events.attempts++;
    },
    normalizeProfileEmojiId,
    flushPendingOwnProfileMiningState: () => {
      events.flushes++;
    },
    syncOwnProfileMiningState: (profile) => events.mining.push(profile),
    isWatchOnly: watchOnly,
    updateProfileDisplayName: (...args) => events.displays.push(args),
    setupLoggedInPlayerProfile: (profile, uid) =>
      events.profiles.push({ profile, uid }),
  };
  const cleanup = new Function(
    ...Object.keys(dependencies),
    `${outputText}\nreturn restoreAuth();`,
  )(...Object.values(dependencies));
  return {
    data,
    events,
    connection,
    cleanup,
    confirmSignIn: () => setAuthStatus("authenticated"),
    setOnline: (online) => {
      navigator.onLine = online;
    },
    changeAuth: (uid = "login-1") => {
      connection.auth.currentUser = uid === null ? null : { uid };
      authCallback(uid);
    },
    changeSession: () => {
      sessionEpoch++;
    },
    retryDelays: () =>
      Array.from(timers.values())
        .filter(({ delay }) => delay > 23)
        .map(({ delay }) => delay),
    advanceRetry: () => {
      const pending = Array.from(timers).filter(([, { delay }]) => delay > 23);
      assert.equal(pending.length, 1, "expected one pending auth retry");
      const [id, timer] = pending[0];
      timers.delete(id);
      timer.callback();
      return timer.delay;
    },
    wake: (type, visibilityState = document.visibilityState) => {
      document.visibilityState = visibilityState;
      const listeners =
        type === "visibilitychange" ? documentListeners : windowListeners;
      for (const callback of listeners.get(type) || []) callback({ type });
    },
    listenerCount: () =>
      [...windowListeners.values(), ...documentListeners.values()].reduce(
        (count, listeners) => count + listeners.size,
        0,
      ),
    settle: async () => {
      await new Promise(setImmediate);
      for (const [id, { callback, delay }] of timers) {
        if (delay !== 23) continue;
        timers.delete(id);
        callback();
      }
    },
  };
}

test("restores canonical ownership without token claims or forced refreshes", async () => {
  const h = harness();
  h.changeAuth();
  await h.settle();

  assert.deepEqual(h.events.statuses, ["authenticated"]);
  assert.equal(h.events.profiles[0].profile.id, "profile-1");
  assert.equal(h.events.profiles[0].profile.username, "Cached player");
  assert.equal(h.events.profiles[0].uid, "login-1");
  assert.deepEqual(h.events.lookups, []);
  assert.equal(h.events.claimReads, 0);
  assert.equal(h.events.tokenRefreshes, 0);
  assert.equal(h.events.attempts, 1);
});

test("replaces stale cached ownership and presentation with the canonical profile", async () => {
  const h = harness({
    syncProfile: async () => ({ ok: true, profileId: "profile-2" }),
    claimProfileId: "profile-1",
  });
  h.changeAuth();
  await h.settle();

  assert.deepEqual(h.events.statuses, ["authenticated"]);
  assert.deepEqual(h.events.lookups, ["login-1"]);
  assert.equal(h.data.profileId, "profile-2");
  assert.equal(h.data.username, "Canonical player");
  assert.equal(h.data.ethAddress, "canonical-eth");
  assert.equal(h.data.solAddress, "canonical-sol");
  assert.equal(h.data.playerEmojiId, "9");
  assert.equal(h.data.playerEmojiAura, "canonical-aura");
  assert.deepEqual(h.events.mining, [authoritativeProfile]);
  assert.equal(h.events.claimReads, 0);
});

test("uses safe presentation defaults when ownership changes and profile hydration fails", async () => {
  const h = harness({
    syncProfile: async () => ({ ok: true, profileId: "profile-2" }),
    lookupProfile: unavailable,
  });
  h.changeAuth();
  await h.settle();

  assert.deepEqual(h.events.statuses, ["authenticated"]);
  assert.deepEqual(h.data, {
    loginId: "login-1",
    profileId: "profile-2",
    username: "",
    ethAddress: "",
    solAddress: "",
    playerEmojiId: "1",
    playerEmojiAura: "",
  });
  assert.equal(h.events.profiles[0].profile.id, "profile-2");
  assert.equal(h.events.profiles[0].profile.username, "");
  assert.equal(h.events.flushes, 1);
});

test("rejects missing canonical ownership despite a matching stale token claim", async () => {
  const h = harness({
    syncProfile: async () => ({ ok: true, profileId: null }),
    claimProfileId: "profile-1",
  });
  h.changeAuth();
  await h.settle();

  assert.deepEqual(h.events.statuses, ["unauthenticated"]);
  assert.deepEqual(h.events.lookups, []);
  assert.deepEqual(h.events.profiles, []);
  assert.equal(h.events.claimReads, 0);
  assert.deepEqual(h.data, cachedIdentity);
  assert.deepEqual(h.retryDelays(), []);
  h.wake("online");
  h.wake("pageshow");
  h.wake("visibilitychange");
  await h.settle();
  assert.equal(h.events.syncs, 1);
});

test("restores ownership through the D1 profile lookup when synchronization fails", async () => {
  const h = harness({ syncProfile: unavailable });
  h.changeAuth();
  await h.settle();

  assert.deepEqual(h.events.statuses, ["authenticated"]);
  assert.deepEqual(h.events.lookups, ["login-1"]);
  assert.equal(h.data.profileId, "profile-2");
  assert.equal(h.events.profiles[0].profile.username, "Canonical player");
  assert.equal(h.events.claimReads, 0);
});

test("retains cached data and the session when both canonical APIs fail", async () => {
  const h = harness({
    syncProfile: unavailable,
    lookupProfile: unavailable,
    claimProfileId: "profile-1",
  });
  h.changeAuth();
  const sessionUser = h.connection.auth.currentUser;
  await h.settle();

  assert.deepEqual(h.events.statuses, ["unauthenticated"]);
  assert.deepEqual(h.events.profiles, []);
  assert.deepEqual(h.events.displays, []);
  assert.deepEqual(h.data, cachedIdentity);
  assert.equal(h.connection.auth.currentUser, sessionUser);
  assert.equal(h.events.claimReads, 0);
  assert.equal(h.events.tokenRefreshes, 0);
  assert.equal(h.events.attempts, 1);
});

test("does not restore a cached identity belonging to a different login", async () => {
  const h = harness();
  h.changeAuth("login-2");
  await h.settle();

  assert.deepEqual(h.events.statuses, ["unauthenticated"]);
  assert.equal(h.events.syncs, 0);
  assert.deepEqual(h.events.profiles, []);
  assert.deepEqual(h.data, cachedIdentity);
});

test("retries in the current game session after discarding an older ownership response", async () => {
  const pending = deferred();
  const h = harness({ syncProfile: () => pending.promise });
  h.changeAuth();
  h.changeSession();
  pending.resolve({ ok: true, profileId: "profile-2" });
  await h.settle();

  assert.deepEqual(h.events.statuses, []);
  assert.deepEqual(h.events.lookups, []);
  assert.deepEqual(h.events.profiles, []);
  assert.deepEqual(h.data, cachedIdentity);
  assert.deepEqual(h.retryDelays(), [1_000]);
  h.advanceRetry();
  await h.settle();
  assert.deepEqual(h.events.statuses, ["authenticated"]);
  assert.equal(h.events.syncs, 2);
  assert.equal(h.events.profiles[0].profile.id, "profile-2");
  assert.deepEqual(h.retryDelays(), []);
});

test("ignores a pending ownership response after sign-out", async () => {
  const pending = deferred();
  const h = harness({ syncProfile: () => pending.promise });
  h.changeAuth();
  h.changeAuth(null);
  pending.resolve({ ok: true, profileId: "profile-2" });
  await h.settle();

  assert.deepEqual(h.events.statuses, ["unauthenticated"]);
  assert.deepEqual(h.events.lookups, []);
  assert.deepEqual(h.events.profiles, []);
  assert.deepEqual(h.data, cachedIdentity);
});

test("ignores a pending fallback profile response after effect cleanup", async () => {
  const pending = deferred();
  const h = harness({
    syncProfile: unavailable,
    lookupProfile: () => pending.promise,
  });
  h.changeAuth();
  await h.settle();
  assert.deepEqual(h.events.lookups, ["login-1"]);
  h.cleanup();
  pending.resolve(authoritativeProfile);
  await h.settle();

  assert.deepEqual(h.events.statuses, []);
  assert.deepEqual(h.events.profiles, []);
  assert.deepEqual(h.data, cachedIdentity);
  assert.equal(h.events.unsubscribed, true);
  assert.equal(h.events.attempts, 0);
});

test("keeps the newer auth result when callbacks overlap for the same login", async () => {
  const pending = deferred();
  let syncs = 0;
  const h = harness({
    syncProfile: async () =>
      ++syncs === 1 ? pending.promise : { ok: true, profileId: "profile-1" },
  });
  h.changeAuth();
  h.changeAuth();
  await h.settle();
  pending.resolve({ ok: true, profileId: "profile-2" });
  await h.settle();

  assert.deepEqual(h.events.statuses, ["authenticated"]);
  assert.equal(h.events.profiles.length, 1);
  assert.equal(h.events.profiles[0].profile.id, "profile-1");
  assert.deepEqual(h.data, cachedIdentity);
});

test("hydrates watch-only presentation after confirming unchanged ownership", async () => {
  const profile = { ...authoritativeProfile, id: "profile-1" };
  const h = harness({
    watchOnly: true,
    lookupProfile: async () => profile,
  });
  h.changeAuth();
  await h.settle();

  assert.deepEqual(h.events.statuses, ["authenticated"]);
  assert.deepEqual(h.events.lookups, ["login-1"]);
  assert.equal(h.events.profiles[0].profile.username, "Canonical player");
  assert.deepEqual(h.events.mining, [profile]);
});

test("recovers a transient outage by timer without another session auth callback", async () => {
  let available = false;
  const h = harness({
    syncProfile: async () =>
      available ? { ok: true, profileId: "profile-1" } : unavailable(),
    lookupProfile: unavailable,
  });
  h.changeAuth();
  const sessionUser = h.connection.auth.currentUser;
  await h.settle();
  assert.deepEqual(h.events.statuses, ["unauthenticated"]);
  assert.deepEqual(h.retryDelays(), [1_000]);

  h.changeSession();
  available = true;
  h.advanceRetry();
  await h.settle();

  assert.deepEqual(h.events.statuses, ["unauthenticated", "authenticated"]);
  assert.equal(h.events.syncs, 2);
  assert.equal(h.events.profiles[0].profile.id, "profile-1");
  assert.equal(h.connection.auth.currentUser, sessionUser);
  assert.deepEqual(h.data, cachedIdentity);
  assert.deepEqual(h.retryDelays(), []);
  assert.equal(h.events.claimReads, 0);
  assert.equal(h.events.tokenRefreshes, 0);
});

test("backs off continuing failures to 30 seconds and resets on an auth callback", async () => {
  const h = harness({
    syncProfile: unavailable,
    lookupProfile: unavailable,
  });
  h.changeAuth();
  await h.settle();

  for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]) {
    assert.deepEqual(h.retryDelays(), [delay]);
    assert.equal(h.advanceRetry(), delay);
    await h.settle();
  }
  assert.equal(h.events.syncs, 8);
  assert.deepEqual(h.events.profiles, []);
  assert.deepEqual(h.retryDelays(), [30_000]);

  h.changeAuth();
  await h.settle();
  assert.deepEqual(h.retryDelays(), [1_000]);
  h.cleanup();
});

for (const code of ["not-found", "unauthenticated", "permission-denied"]) {
  test(`does not retry restoration after a definitive ${code} profile lookup`, async () => {
    const h = harness({
      syncProfile: unavailable,
      lookupProfile: async () => {
        throw new ProfileApiError(code, "Profile unavailable");
      },
    });
    h.changeAuth();
    await h.settle();
    assert.deepEqual(h.events.statuses, ["unauthenticated"]);
    assert.deepEqual(h.retryDelays(), []);
    h.wake("online");
    await h.settle();
    assert.equal(h.events.syncs, 1);
  });
}

test("retries temporary typed profile lookup failures", async () => {
  for (const code of ["unavailable", "resource-exhausted", "aborted"]) {
    const h = harness({
      syncProfile: unavailable,
      lookupProfile: async () => {
        throw new ProfileApiError(code, "Profile temporarily unavailable");
      },
    });
    h.changeAuth();
    await h.settle();
    assert.deepEqual(h.events.statuses, ["unauthenticated"]);
    assert.deepEqual(h.retryDelays(), [1_000], code);
    h.cleanup();
  }
});

test("keeps an offline retry pending until the network returns", async () => {
  let available = false;
  const h = harness({
    syncProfile: async () =>
      available ? { ok: true, profileId: "profile-1" } : unavailable(),
    lookupProfile: unavailable,
  });
  h.changeAuth();
  await h.settle();
  h.setOnline(false);
  h.advanceRetry();
  h.wake("pageshow");
  await h.settle();
  assert.equal(h.events.syncs, 1);

  available = true;
  h.setOnline(true);
  h.wake("online");
  await h.settle();
  assert.deepEqual(h.events.statuses, ["unauthenticated", "authenticated"]);
  assert.equal(h.events.syncs, 2);
  assert.deepEqual(h.retryDelays(), []);
});

test("an explicit same-login sign-in fences a late retry failure", async () => {
  const pending = deferred();
  let syncs = 0;
  const h = harness({
    syncProfile: async () => {
      if (++syncs === 1) return unavailable();
      await pending.promise;
      return unavailable();
    },
    lookupProfile: unavailable,
  });
  h.changeAuth();
  await h.settle();
  h.advanceRetry();
  await h.settle();
  assert.equal(h.events.syncs, 2);

  h.confirmSignIn();
  pending.resolve();
  await h.settle();
  assert.deepEqual(h.events.statuses, ["unauthenticated", "authenticated"]);
  assert.deepEqual(h.events.lookups, ["login-1"]);
  assert.deepEqual(h.retryDelays(), []);
  h.wake("online");
  await h.settle();
  assert.equal(h.events.syncs, 2);
});

for (const wakeEvent of ["online", "pageshow", "visibilitychange"]) {
  test(`${wakeEvent} retries pending restoration immediately without overlapping requests`, async () => {
    const pending = deferred();
    let syncs = 0;
    const h = harness({
      syncProfile: async () =>
        ++syncs === 1 ? unavailable() : pending.promise,
      lookupProfile: unavailable,
    });
    h.changeAuth();
    await h.settle();
    assert.deepEqual(h.retryDelays(), [1_000]);

    if (wakeEvent === "visibilitychange") {
      h.wake(wakeEvent, "hidden");
      await h.settle();
      assert.equal(h.events.syncs, 1);
      assert.deepEqual(h.retryDelays(), [1_000]);
    }
    h.wake(wakeEvent, "visible");
    h.wake("online");
    h.wake("pageshow");
    h.wake("visibilitychange");
    await h.settle();
    assert.equal(h.events.syncs, 2);
    assert.deepEqual(h.retryDelays(), []);

    pending.resolve({ ok: true, profileId: "profile-1" });
    await h.settle();
    assert.deepEqual(h.events.statuses, ["unauthenticated", "authenticated"]);
    assert.equal(h.events.profiles.length, 1);
    assert.deepEqual(h.retryDelays(), []);
  });
}

for (const cancellation of ["sign-out", "account change", "cleanup"]) {
  test(`${cancellation} cancels pending restoration retries`, async () => {
    const h = harness({
      syncProfile: unavailable,
      lookupProfile: unavailable,
    });
    h.changeAuth();
    await h.settle();
    assert.deepEqual(h.retryDelays(), [1_000]);
    assert.equal(h.listenerCount(), 3);

    if (cancellation === "cleanup") h.cleanup();
    else h.changeAuth(cancellation === "sign-out" ? null : "login-2");
    h.wake("online");
    h.wake("pageshow");
    h.wake("visibilitychange");
    await h.settle();

    assert.deepEqual(h.retryDelays(), []);
    assert.equal(h.events.syncs, 1);
    assert.deepEqual(h.events.profiles, []);
    assert.deepEqual(h.data, cachedIdentity);
    if (cancellation === "cleanup") {
      assert.equal(h.listenerCount(), 0);
      assert.equal(h.events.unsubscribed, true);
    }
  });
}
