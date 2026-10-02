import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";
import ts from "typescript";
import { normalizeProfileEmojiId } from "../cloud/runtime/shared/profiles.js";

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

const { AuthApiError } = await import("../src/services/authApi.ts");
const { createDeferredProfilePresentation } =
  await import("../src/connection/deferredProfilePresentation.ts");
const { formatProfileDisplayName } =
  await import("../src/ui/identity/profileUiPort.ts");

const profileApplicationSource = ts.createSourceFile(
  "verifiedProfile.ts",
  readFileSync(
    new URL("../src/connection/verifiedProfile.ts", import.meta.url),
    "utf8",
  ),
  ts.ScriptTarget.Latest,
  true,
);
const profileApplication = profileApplicationSource.statements.find(
  (node) =>
    ts.isFunctionDeclaration(node) &&
    node.name?.text === "applyVerifiedProfile",
);
const { outputText: profileApplicationOutput } = ts.transpileModule(
  profileApplication.getText(profileApplicationSource).replace("export ", ""),
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
);

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
  initialIdentity = async () => ({ ok: true, profile: authoritativeProfile }),
  syncProfile = async () => ({ ok: true, profileId: "profile-1" }),
  watchOnly = false,
  stored = {},
  applicationErrors = {},
  autoFlushPresentation = true,
} = {}) {
  const data = { ...cachedIdentity, ...stored };
  const events = {
    statuses: [],
    profiles: [],
    displays: [],
    syncs: 0,
    lookups: [],
    mining: [],
    flushes: 0,
    attempts: 0,
    unsubscribed: false,
    identities: 0,
    consumedIdentities: 0,
    invalidatedIdentities: 0,
    tutorials: [],
    presentationErrors: [],
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
  const checkApplicationError = (operation) => {
    if (applicationErrors[operation]) throw applicationErrors[operation];
  };
  const storage = {};
  for (const field of Object.keys(data)) {
    const suffix = field[0].toUpperCase() + field.slice(1);
    storage[`get${suffix}`] = (fallback) => data[field] ?? fallback;
    storage[`set${suffix}`] = (value) => {
      checkApplicationError(`set${suffix}`);
      data[field] = value;
    };
  }
  for (const field of [
    "playerRating",
    "playerNonce",
    "playerTotalManaPoints",
    "cardBackgroundId",
    "cardStickers",
    "cardSubtitleId",
    "profileCounter",
    "profileMons",
  ]) {
    const suffix = field[0].toUpperCase() + field.slice(1);
    storage[`set${suffix}`] = (value) => {
      checkApplicationError(`set${suffix}`);
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
    auth: { currentUser: { uid: "login-1" }, isStoppedForLogout: false },
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
    getSameProfilePlayerUid: () => null,
  };
  const presentationFrames = new Map();
  let nextPresentationFrame = 0;
  const presentation = createDeferredProfilePresentation({
    isHidden: () => false,
    requestFrame: (callback) => {
      const id = ++nextPresentationFrame;
      presentationFrames.set(id, callback);
      return id;
    },
    cancelFrame: (id) => presentationFrames.delete(id),
    scheduleTask: () => {
      throw new Error("unexpected hidden presentation task");
    },
    cancelTask: () => {},
    subscribeVisibility: () => () => {},
    reportError: (error) => events.presentationErrors.push(error),
  });
  const advancePresentationFrame = () => {
    const callbacks = [...presentationFrames.values()];
    presentationFrames.clear();
    callbacks.forEach((callback) => callback());
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
    sessionAuth: connection.auth,
    localStorage: {
      getItem: (key) => {
        const value = data[key];
        if (value == null) return null;
        return typeof value === "string" ? value : JSON.stringify(value);
      },
    },
    beginVerifiedProfileApplication: presentation.beginApplication,
    queueDeferredProfilePresentation: presentation.queue,
    formatProfileDisplayName,
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
    AuthApiError,
    markAuthIdentityReady: () => {},
    readInitialIdentity: async () => {
      events.identities++;
      const user = connection.auth.currentUser;
      const identity = await initialIdentity();
      return { user, read: () => identity };
    },
    consumeInitialIdentity: () => {
      events.consumedIdentities++;
    },
    invalidateInitialIdentity: () => {
      events.invalidatedIdentities++;
    },
    repairInitialIdentity: async (initial, repair) => {
      initial.read();
      await repair();
      dependencies.invalidateInitialIdentity();
      return dependencies.readInitialIdentity();
    },
    syncTutorialProgress: (...args) => {
      checkApplicationError("syncTutorialProgress");
      events.tutorials.push(args);
    },
    didAttemptAuthentication: () => {
      events.attempts++;
    },
    normalizeProfileEmojiId,
    flushPendingOwnProfileMiningState: () => {
      checkApplicationError("flushPendingOwnProfileMiningState");
      events.flushes++;
    },
    syncOwnProfileMiningState: (profile) => {
      checkApplicationError("syncOwnProfileMiningState");
      events.mining.push(profile);
    },
    isWatchOnly: watchOnly,
    updateProfileDisplayName: (...args) => events.displays.push(args),
    setupLoggedInPlayerProfile: (profile, uid) => {
      checkApplicationError("setupLoggedInPlayerProfile");
      events.profiles.push({ profile, uid });
    },
  };
  dependencies.applyVerifiedProfile = new Function(
    ...Object.keys(dependencies),
    `${profileApplicationOutput}\nreturn applyVerifiedProfile;`,
  )(...Object.values(dependencies));
  const cleanup = new Function(
    ...Object.keys(dependencies),
    `${outputText}\nreturn restoreAuth();`,
  )(...Object.values(dependencies));
  return {
    data,
    events,
    connection,
    cleanup,
    applyProfile: dependencies.applyVerifiedProfile,
    commitName: () =>
      presentation.nameCommitted(
        {
          profileId: data.profileId,
          displayName: events.displays.at(-1)?.[0] ?? "anon",
        },
        () => true,
      ),
    advancePresentationFrame,
    flushPresentation: presentation.flush,
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
      if (autoFlushPresentation) {
        presentation.nameCommitted(
          {
            profileId: data.profileId,
            displayName: events.displays.at(-1)?.[0] ?? "anon",
          },
          () => true,
        );
        advancePresentationFrame();
        advancePresentationFrame();
      }
    },
  };
}

test("applies the complete verified identity without sync or profile lookup", async () => {
  const profile = {
    ...authoritativeProfile,
    rating: 1688,
    nonce: 12,
    totalManaPoints: 42,
    win: true,
    cardBackgroundId: 3,
    cardSubtitleId: 2,
    profileCounter: "gp",
    profileMons: "1,2,3,4,5",
    cardStickers: "stickers",
    completedProblemIds: ["one"],
    isTutorialCompleted: true,
  };
  const h = harness({
    initialIdentity: async () => ({ ok: true, profile }),
    stored: { loginId: "another-login", username: "Stale name" },
  });
  h.changeAuth();
  await h.settle();
  assert.deepEqual(h.events.statuses, ["authenticated"]);
  assert.equal(h.events.syncs, 0);
  assert.deepEqual(h.events.lookups, []);
  assert.deepEqual(h.events.profiles, [{ profile, uid: "login-1" }]);
  assert.deepEqual(h.events.tutorials, [[["one"], true]]);
  assert.equal(h.data.username, "Canonical player");
  assert.equal(h.data.loginId, "login-1");
  assert.equal(h.data.playerRating, 1688);
  assert.equal(h.data.profileMons, profile.profileMons);
  assert.equal(h.events.consumedIdentities, 1);
});

test("a verified missing owner stays anonymous without trusting the saved profile", async () => {
  const h = harness({
    initialIdentity: async () => ({ ok: true, profile: null }),
  });
  h.changeAuth();
  await h.settle();
  assert.deepEqual(h.events.statuses, ["unauthenticated"]);
  assert.deepEqual(h.events.profiles, []);
  assert.equal(h.events.syncs, 0);
  assert.deepEqual(h.events.lookups, []);
  assert.deepEqual(h.retryDelays(), []);
});

test("unavailable identity retries without entering profile repair", async () => {
  const h = harness({
    initialIdentity: async () => ({ ok: false, status: 503 }),
  });
  h.changeAuth();
  await h.settle();
  assert.deepEqual(h.events.statuses, ["unauthenticated"]);
  assert.equal(h.events.syncs, 0);
  assert.deepEqual(h.events.lookups, []);
  assert.deepEqual(h.retryDelays(), [1_000]);
  h.cleanup();
});

test("repairs only an explicit repair-required identity then reads the fresh profile", async () => {
  let reads = 0;
  const h = harness({
    initialIdentity: async () =>
      ++reads === 1
        ? { ok: false, status: 409 }
        : { ok: true, profile: authoritativeProfile },
  });
  h.changeAuth();
  await h.settle();
  assert.equal(h.events.syncs, 1);
  assert.equal(h.events.identities, 2);
  assert.equal(h.events.invalidatedIdentities, 1);
  assert.deepEqual(h.events.lookups, []);
  assert.deepEqual(h.events.statuses, ["authenticated"]);
});

test("a newer login fences a late verified startup identity", async () => {
  const pending = deferred();
  const h = harness({ initialIdentity: () => pending.promise });
  h.changeAuth();
  h.confirmSignIn();
  pending.resolve({ ok: true, profile: authoritativeProfile });
  await h.settle();
  assert.deepEqual(h.events.statuses, ["authenticated"]);
  assert.deepEqual(h.events.profiles, []);
  assert.equal(h.events.consumedIdentities, 0);
});

test("unavailable identity preserves cached data and the current session", async () => {
  const h = harness({ initialIdentity: unavailable });
  h.changeAuth();
  const user = h.connection.auth.currentUser;
  await h.settle();
  assert.deepEqual(h.events.statuses, ["unauthenticated"]);
  assert.deepEqual(h.data, cachedIdentity);
  assert.equal(h.connection.auth.currentUser, user);
  assert.equal(h.events.syncs, 0);
  assert.deepEqual(h.events.lookups, []);
  assert.deepEqual(h.retryDelays(), [1_000]);
  h.cleanup();
});

test("retries a verified identity discarded after the game session changes", async () => {
  const pending = deferred();
  const h = harness({ initialIdentity: () => pending.promise });
  h.changeAuth();
  await h.settle();
  h.changeSession();
  pending.resolve({ ok: true, profile: authoritativeProfile });
  await h.settle();
  assert.deepEqual(h.events.statuses, []);
  assert.deepEqual(h.events.profiles, []);
  assert.deepEqual(h.retryDelays(), [1_000]);
  h.advanceRetry();
  await h.settle();
  assert.deepEqual(h.events.statuses, ["authenticated"]);
  assert.equal(h.events.identities, 2);
  assert.deepEqual(h.retryDelays(), []);
});

for (const cancellation of ["sign-out", "account change", "cleanup"]) {
  test(`${cancellation} fences a pending verified identity response`, async () => {
    const pending = deferred();
    let reads = 0;
    const h = harness({
      initialIdentity: () =>
        ++reads === 1
          ? pending.promise
          : Promise.resolve({ ok: true, profile: null }),
    });
    h.changeAuth();
    await h.settle();
    if (cancellation === "cleanup") h.cleanup();
    else h.changeAuth(cancellation === "sign-out" ? null : "login-2");
    pending.resolve({ ok: true, profile: authoritativeProfile });
    await h.settle();
    assert.deepEqual(h.events.profiles, []);
    assert.deepEqual(h.data, cachedIdentity);
    assert.deepEqual(h.retryDelays(), []);
    if (cancellation === "cleanup") assert.equal(h.events.unsubscribed, true);
  });
}

test("keeps the newer verified result when callbacks overlap for the same login", async () => {
  const pending = deferred();
  const current = { ...authoritativeProfile, id: "new-profile" };
  let reads = 0;
  const h = harness({
    initialIdentity: async () =>
      ++reads === 1 ? pending.promise : { ok: true, profile: current },
  });
  h.changeAuth();
  await h.settle();
  h.changeAuth();
  await h.settle();
  pending.resolve({ ok: true, profile: authoritativeProfile });
  await h.settle();
  assert.deepEqual(h.events.statuses, ["authenticated"]);
  assert.equal(h.events.profiles.length, 1);
  assert.equal(h.data.profileId, current.id);
});

test("recovers a transient identity outage by timer without another auth callback", async () => {
  let available = false;
  const h = harness({
    initialIdentity: async () =>
      available ? { ok: true, profile: authoritativeProfile } : unavailable(),
  });
  h.changeAuth();
  const user = h.connection.auth.currentUser;
  await h.settle();
  assert.deepEqual(h.retryDelays(), [1_000]);
  available = true;
  h.advanceRetry();
  await h.settle();
  assert.deepEqual(h.events.statuses, ["unauthenticated", "authenticated"]);
  assert.equal(h.connection.auth.currentUser, user);
  assert.equal(h.events.identities, 2);
  assert.deepEqual(h.retryDelays(), []);
});

test("backs off identity failures to 30 seconds and resets on an auth callback", async () => {
  const h = harness({ initialIdentity: unavailable });
  h.changeAuth();
  await h.settle();
  for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]) {
    assert.deepEqual(h.retryDelays(), [delay]);
    assert.equal(h.advanceRetry(), delay);
    await h.settle();
  }
  assert.equal(h.events.identities, 8);
  assert.deepEqual(h.events.profiles, []);
  h.changeAuth();
  await h.settle();
  assert.deepEqual(h.retryDelays(), [1_000]);
  h.cleanup();
});

for (const code of ["not-found", "unauthenticated", "permission-denied"]) {
  test(`does not retry a definitive ${code} identity failure`, async () => {
    const h = harness({
      initialIdentity: async () => {
        throw new AuthApiError(code, "Profile unavailable");
      },
    });
    h.changeAuth();
    await h.settle();
    assert.deepEqual(h.events.statuses, ["unauthenticated"]);
    assert.deepEqual(h.retryDelays(), []);
    h.wake("online");
    await h.settle();
    assert.equal(h.events.identities, 1);
  });
}

for (const code of ["unavailable", "resource-exhausted", "aborted"]) {
  test(`retries a temporary ${code} identity failure`, async () => {
    const h = harness({
      initialIdentity: async () => {
        throw new AuthApiError(code, "Profile temporarily unavailable");
      },
    });
    h.changeAuth();
    await h.settle();
    assert.deepEqual(h.events.statuses, ["unauthenticated"]);
    assert.deepEqual(h.retryDelays(), [1_000]);
    h.cleanup();
  });
}

test("keeps an offline identity retry pending until the network returns", async () => {
  let available = false;
  const h = harness({
    initialIdentity: async () =>
      available ? { ok: true, profile: authoritativeProfile } : unavailable(),
  });
  h.changeAuth();
  await h.settle();
  h.setOnline(false);
  h.advanceRetry();
  h.wake("pageshow");
  await h.settle();
  assert.equal(h.events.identities, 1);
  available = true;
  h.setOnline(true);
  h.wake("online");
  await h.settle();
  assert.deepEqual(h.events.statuses, ["unauthenticated", "authenticated"]);
  assert.equal(h.events.identities, 2);
  assert.deepEqual(h.retryDelays(), []);
});

test("an explicit same-login sign-in fences a late identity retry failure", async () => {
  const pending = deferred();
  let reads = 0;
  const h = harness({
    initialIdentity: async () => {
      if (++reads > 1) await pending.promise;
      return unavailable();
    },
  });
  h.changeAuth();
  await h.settle();
  h.advanceRetry();
  await h.settle();
  h.confirmSignIn();
  pending.resolve();
  await h.settle();
  assert.deepEqual(h.events.statuses, ["unauthenticated", "authenticated"]);
  assert.deepEqual(h.retryDelays(), []);
  h.wake("online");
  await h.settle();
  assert.equal(h.events.identities, 2);
});

for (const wakeEvent of ["online", "pageshow", "visibilitychange"]) {
  test(`${wakeEvent} retries pending identity without overlapping requests`, async () => {
    const pending = deferred();
    let reads = 0;
    const h = harness({
      initialIdentity: async () =>
        ++reads === 1 ? unavailable() : pending.promise,
    });
    h.changeAuth();
    await h.settle();
    if (wakeEvent === "visibilitychange") {
      h.wake(wakeEvent, "hidden");
      await h.settle();
      assert.equal(h.events.identities, 1);
    }
    h.wake(wakeEvent, "visible");
    h.wake("online");
    h.wake("pageshow");
    h.wake("visibilitychange");
    await h.settle();
    assert.equal(h.events.identities, 2);
    assert.deepEqual(h.retryDelays(), []);
    pending.resolve({ ok: true, profile: authoritativeProfile });
    await h.settle();
    assert.deepEqual(h.events.statuses, ["unauthenticated", "authenticated"]);
  });
}

for (const cancellation of ["sign-out", "account change", "cleanup"]) {
  test(`${cancellation} cancels a pending identity retry`, async () => {
    let reads = 0;
    const h = harness({
      initialIdentity: async () =>
        ++reads === 1 ? unavailable() : { ok: true, profile: null },
    });
    h.changeAuth();
    await h.settle();
    assert.deepEqual(h.retryDelays(), [1_000]);
    assert.equal(h.listenerCount(), 3);
    if (cancellation === "cleanup") h.cleanup();
    else h.changeAuth(cancellation === "sign-out" ? null : "login-2");
    await h.settle();
    h.wake("online");
    h.wake("pageshow");
    h.wake("visibilitychange");
    await h.settle();
    assert.deepEqual(h.retryDelays(), []);
    assert.equal(
      h.events.identities,
      cancellation === "account change" ? 2 : 1,
    );
    assert.deepEqual(h.events.profiles, []);
    assert.deepEqual(h.data, cachedIdentity);
    if (cancellation === "cleanup") {
      assert.equal(h.listenerCount(), 0);
      assert.equal(h.events.unsubscribed, true);
    }
  });
}

for (const operation of [
  "setCardStickers",
  "setUsername",
  "setPlayerRating",
  "syncTutorialProgress",
  "setupLoggedInPlayerProfile",
  "syncOwnProfileMiningState",
  "flushPendingOwnProfileMiningState",
]) {
  test(`quota failure in optional ${operation} preserves verified authentication and display`, async () => {
    const profile = {
      ...authoritativeProfile,
      id: cachedIdentity.profileId,
      username:
        operation === "setUsername"
          ? "FreshServerName"
          : cachedIdentity.username,
      eth: cachedIdentity.ethAddress,
      sol: cachedIdentity.solAddress,
      rating: 1688,
      nonce: 12,
      totalManaPoints: 42,
      cardStickers: JSON.stringify({ "big-mon-top-right": "applecreme" }),
      completedProblemIds: ["one"],
      isTutorialCompleted: true,
    };
    const h = harness({
      initialIdentity: async () => ({ ok: true, profile }),
      applicationErrors: {
        [operation]: new DOMException(
          "Storage quota exceeded",
          "QuotaExceededError",
        ),
      },
    });
    h.changeAuth();
    await h.settle();

    assert.deepEqual(h.events.statuses, ["authenticated"]);
    assert.deepEqual(h.events.displays, [
      [profile.username, profile.eth, profile.sol],
    ]);
    assert.equal(h.data.loginId, cachedIdentity.loginId);
    assert.equal(h.data.profileId, cachedIdentity.profileId);
    assert.equal(h.data.ethAddress, cachedIdentity.ethAddress);
    assert.equal(h.data.solAddress, cachedIdentity.solAddress);
    if (operation === "setUsername")
      assert.equal(h.data.username, cachedIdentity.username);
    assert.equal(h.events.consumedIdentities, 1);
    assert.equal(h.events.syncs, 0);
    assert.deepEqual(h.events.lookups, []);
    assert.deepEqual(h.retryDelays(), []);
  });
}

for (const operation of [
  "setLoginId",
  "setProfileId",
  "setEthAddress",
  "setSolAddress",
]) {
  test(`quota failure writing required identity ${operation} still fails restoration`, async () => {
    const h = harness({
      initialIdentity: async () => ({
        ok: true,
        profile: authoritativeProfile,
      }),
      applicationErrors: {
        [operation]: new DOMException(
          "Storage quota exceeded",
          "QuotaExceededError",
        ),
      },
    });
    h.changeAuth();
    await h.settle();

    assert.deepEqual(h.events.statuses, ["unauthenticated"]);
    assert.deepEqual(h.events.displays, []);
    assert.equal(h.events.consumedIdentities, 0);
    assert.deepEqual(h.retryDelays(), [1_000]);
    h.cleanup();
  });
}

for (const [label, error] of [
  ["ordinary error", new Error("Unexpected profile failure")],
  [
    "blocked storage",
    new DOMException("Storage access denied", "SecurityError"),
  ],
  [
    "non-DOM quota error",
    Object.assign(new Error("Unexpected quota error"), {
      name: "QuotaExceededError",
    }),
  ],
]) {
  test(`${label} in deferred cosmetics is reported without retrying verified authentication`, async () => {
    const h = harness({
      initialIdentity: async () => ({
        ok: true,
        profile: authoritativeProfile,
      }),
      applicationErrors: { setCardStickers: error },
    });
    h.changeAuth();
    await h.settle();
    assert.deepEqual(h.events.statuses, ["authenticated"]);
    assert.deepEqual(h.events.presentationErrors, [error]);
    assert.equal(h.events.consumedIdentities, 1);
    assert.deepEqual(h.retryDelays(), []);
    h.cleanup();
  });
  for (const operation of [
    "syncTutorialProgress",
    "setupLoggedInPlayerProfile",
    "syncOwnProfileMiningState",
  ]) {
    test(`${label} in ${operation} is not hidden by optional quota handling`, async () => {
      const h = harness({
        initialIdentity: async () => ({
          ok: true,
          profile: authoritativeProfile,
        }),
        applicationErrors: { [operation]: error },
      });
      h.changeAuth();
      await h.settle();

      assert.deepEqual(h.events.statuses, ["unauthenticated"]);
      assert.deepEqual(h.events.displays, []);
      assert.equal(h.events.consumedIdentities, 0);
      assert.deepEqual(h.retryDelays(), [1_000]);
      h.cleanup();
    });
  }
}

test("restores verified identity and state before deferring only cosmetic cache writes until after the header paint", async () => {
  const profile = {
    ...authoritativeProfile,
    cardBackgroundId: 4,
    cardStickers: "server stickers",
    cardSubtitleId: 8,
    profileCounter: "wins",
    profileMons: "1,2,3,4,5",
    rating: 1800,
    nonce: 7,
    totalManaPoints: 42,
  };
  const h = harness({
    initialIdentity: async () => ({ ok: true, profile }),
    autoFlushPresentation: false,
  });
  h.changeAuth();
  await h.settle();
  assert.deepEqual(h.events.statuses, ["authenticated"]);
  assert.equal(h.data.username, profile.username);
  assert.equal(h.data.playerRating, profile.rating);
  assert.equal(h.data.playerNonce, profile.nonce);
  assert.equal(h.data.playerTotalManaPoints, profile.totalManaPoints);
  assert.equal(h.events.profiles.length, 1);
  assert.equal(h.events.tutorials.length, 1);
  assert.equal(h.events.mining.length, 1);
  const fields = [
    "cardBackgroundId",
    "cardStickers",
    "cardSubtitleId",
    "profileCounter",
    "profileMons",
  ];
  fields.forEach((field) => assert.equal(h.data[field], undefined));
  h.commitName();
  h.advancePresentationFrame();
  fields.forEach((field) => assert.equal(h.data[field], undefined));
  h.advancePresentationFrame();
  fields.forEach((field) => assert.equal(h.data[field], profile[field]));
  h.cleanup();
});

for (const invalidate of [
  "logout",
  "replacement session for the same uid",
  "different profile",
]) {
  test(`${invalidate} fences deferred presentation persistence`, async () => {
    const h = harness({
      initialIdentity: async () => ({
        ok: true,
        profile: { ...authoritativeProfile, cardBackgroundId: 4 },
      }),
      autoFlushPresentation: false,
    });
    h.changeAuth();
    await h.settle();
    h.commitName();
    if (invalidate === "logout") h.connection.auth.isStoppedForLogout = true;
    else if (invalidate === "replacement session for the same uid")
      h.connection.auth.currentUser = { uid: "login-1" };
    else h.data.profileId = "different-profile";
    h.advancePresentationFrame();
    h.advancePresentationFrame();
    assert.equal(h.data.cardBackgroundId, undefined);
    h.cleanup();
  });
}

test("an explicit verified application stays synchronous and supersedes deferred restoration", async () => {
  const h = harness({
    initialIdentity: async () => ({
      ok: true,
      profile: { ...authoritativeProfile, cardBackgroundId: 4 },
    }),
    autoFlushPresentation: false,
  });
  h.changeAuth();
  await h.settle();
  h.commitName();
  h.applyProfile(
    { ...authoritativeProfile, cardBackgroundId: 9, username: "New login" },
    "login-1",
  );
  assert.equal(h.data.cardBackgroundId, 9);
  assert.equal(h.data.username, "New login");
  h.advancePresentationFrame();
  h.advancePresentationFrame();
  assert.equal(h.data.cardBackgroundId, 9);
  h.cleanup();
});

test("an explicit verified application preserves synchronous unexpected-error handling", () => {
  const error = new Error("Unexpected cosmetic failure");
  const h = harness({ applicationErrors: { setCardStickers: error } });
  assert.throws(() => h.applyProfile(authoritativeProfile, "login-1"), error);
  assert.deepEqual(h.events.presentationErrors, []);
  h.cleanup();
});

test("a newer cosmetic edit survives restoration persistence without dropping other fields", async () => {
  const h = harness({
    initialIdentity: async () => ({
      ok: true,
      profile: {
        ...authoritativeProfile,
        cardBackgroundId: 4,
        cardSubtitleId: 7,
      },
    }),
    autoFlushPresentation: false,
  });
  h.changeAuth();
  await h.settle();
  h.data.cardBackgroundId = 9;
  h.flushPresentation();
  assert.equal(h.data.cardBackgroundId, 9);
  assert.equal(h.data.cardSubtitleId, 7);
  h.cleanup();
});
