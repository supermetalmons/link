import { required, canonicalProfile } from "./fixtures/canonicalData.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerTypeScriptTestHooks } from "./support/typescriptHooks.mjs";
import test from "node:test";
import ts from "typescript";
import { bindProfileCosmeticStorage } from "./fixtures/profileCosmeticStorageHarness.mjs";

registerTypeScriptTestHooks();

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
assert.ok(profileApplication && ts.isFunctionDeclaration(profileApplication));
const { outputText: profileApplicationOutput } = ts.transpileModule(
  required(profileApplication)
    .getText(profileApplicationSource)
    .replace("export ", ""),
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
assert.ok(hook && ts.isFunctionDeclaration(hook));
const effect = required(hook.body)
  .statements.filter(ts.isExpressionStatement)
  .map((node) => node.expression)
  .filter(ts.isCallExpression)
  .filter((node) => node.expression.getText(source) === "useEffect")
  .map((node) => required(node.arguments[0]))
  .find((node) => node.getText(source).includes("subscribeToAuthChanges"));
assert.ok(effect, "missing auth restoration effect");
const { outputText } = ts.transpileModule(
  `const restoreAuth = ${effect.getText(source)};`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
);
const authStatusInitializer = required(
  required(
    required(hook.body)
      .statements.filter(ts.isVariableStatement)
      .flatMap((node) => node.declarationList.declarations)
      .find((node) => node.name.getText(source) === "setAuthStatus"),
  ).initializer,
);
assert.ok(ts.isCallExpression(authStatusInitializer));
const authStatusCallback = required(authStatusInitializer.arguments[0]);
const { outputText: authStatusOutput } = ts.transpileModule(
  `const applyAuthStatus = ${authStatusCallback.getText(source)};`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
);

/**
 * @typedef {typeof import("../src/utils/storage.ts").storage} StorageContract
 * @typedef {import("../src/connection/authModels.ts").AuthState} AuthState
 * @typedef {import("../src/connection/authModels.ts").AuthStatus} AuthStatus
 * @typedef {import("../src/session/sessionAuth.ts").SessionUser} SessionUser
 * @typedef {import("@mons/shared/profiles").CompletePlayerProfile} Profile
 * @typedef {import("@mons/shared/session-bootstrap").SessionIdentityBootstrap} Identity
 * @typedef {import("../src/services/initialIdentityBootstrap.ts").InitialIdentityRead} InitialRead
 * @typedef {(event: { type: string }) => void} Listener
 * @typedef {Map<string, Set<Listener>>} Listeners
 * @typedef {object} FixtureData
 * @property {Parameters<StorageContract["setLoginId"]>[0]} loginId
 * @property {Parameters<StorageContract["setProfileId"]>[0]} profileId
 * @property {Parameters<StorageContract["setUsername"]>[0]} username
 * @property {Parameters<StorageContract["setEthAddress"]>[0]} ethAddress
 * @property {Parameters<StorageContract["setSolAddress"]>[0]} solAddress
 * @property {Parameters<StorageContract["setPlayerEmojiId"]>[0]} playerEmojiId
 * @property {Parameters<StorageContract["setPlayerEmojiAura"]>[0]} playerEmojiAura
 * @property {Parameters<StorageContract["setPlayerRating"]>[0]} [playerRating]
 * @property {Parameters<StorageContract["setPlayerNonce"]>[0]} [playerNonce]
 * @property {Parameters<StorageContract["setPlayerTotalManaPoints"]>[0]} [playerTotalManaPoints]
 * @property {Parameters<StorageContract["setCardBackgroundId"]>[0]} [cardBackgroundId]
 * @property {Parameters<StorageContract["setCardStickers"]>[0]} [cardStickers]
 * @property {Parameters<StorageContract["setCardSubtitleId"]>[0]} [cardSubtitleId]
 * @property {Parameters<StorageContract["setProfileCounter"]>[0]} [profileCounter]
 * @property {Parameters<StorageContract["setProfileMons"]>[0]} [profileMons]
 */
/** @type {(keyof FixtureData)[]} */
const fixtureFields = [
  "loginId",
  "profileId",
  "username",
  "ethAddress",
  "solAddress",
  "playerEmojiId",
  "playerEmojiAura",
  "playerRating",
  "playerNonce",
  "playerTotalManaPoints",
  "cardBackgroundId",
  "cardStickers",
  "cardSubtitleId",
  "profileCounter",
  "profileMons",
];
/** @param {string} key @returns {key is keyof FixtureData} */
const isFixtureField = (key) => fixtureFields.some((field) => field === key);
/** @param {string} uid @returns {SessionUser} */
const sessionUser = (uid) => ({
  uid,
  sessionId: "fixture-session",
  generation: "fixture-generation",
  getIdToken: async () => "token",
});

/** @satisfies {Pick<FixtureData, "loginId" | "profileId" | "username" | "ethAddress" | "solAddress" | "playerEmojiId" | "playerEmojiAura">} */
const cachedIdentity = {
  loginId: "login-1",
  profileId: "profile-1",
  username: "Cached player",
  ethAddress: "cached-eth",
  solAddress: "cached-sol",
  playerEmojiId: 7,
  playerEmojiAura: "rainbow",
};
const authoritativeProfile = canonicalProfile({
  id: "profile-2",
  username: "Canonical player",
  eth: "canonical-eth",
  sol: "canonical-sol",
  emoji: 9,
  aura: "none",
});
const unavailable = async () => {
  throw new Error("unavailable");
};
/** @template [T=Identity] @returns {Pick<PromiseWithResolvers<T>, "promise" | "resolve">} */
const deferred = () => {
  /** @type {PromiseWithResolvers<T>} */
  const pending = Promise.withResolvers();
  return { promise: pending.promise, resolve: pending.resolve };
};

/** @param {{ initialIdentity?: () => Promise<Identity>, syncProfile?: () => Promise<import("@mons/shared/auth").LinkedAuthMethodsResponse>, watchOnly?: boolean, stored?: Partial<FixtureData>, applicationErrors?: Partial<Record<string, Error>>, autoFlushPresentation?: boolean }} [options] */
function harness({
  initialIdentity = async () => ({ ok: true, profile: authoritativeProfile }),
  syncProfile = async () => ({
    ok: true,
    profileId: "profile-1",
    linkedMethods: { eth: false, sol: false, apple: false, x: false },
    appleLinked: false,
  }),
  watchOnly = false,
  stored = {},
  applicationErrors = {},
  autoFlushPresentation = true,
} = {}) {
  /** @type {FixtureData} */
  const data = { ...cachedIdentity, ...stored };
  /** @type {{ statuses: AuthStatus[], profiles: { profile: import("@mons/shared/profiles").PlayerProfile, uid: string }[], displays: Parameters<typeof import("../src/ui/identity/profileUiPort.ts").updateProfileDisplayName>[], syncs: number, lookups: string[], mining: import("@mons/shared/profiles").PlayerProfile[], flushes: number, attempts: number, unsubscribed: boolean, identities: number, consumedIdentities: number, invalidatedIdentities: number, tutorials: Parameters<typeof import("../src/content/problems.ts").syncTutorialProgress>[], presentationErrors: unknown[] }} */
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
  /** @type {Map<number, { callback: () => void, delay: number }>} */
  const timers = new Map();
  /** @type {Listeners} */
  const windowListeners = new Map();
  /** @type {Listeners} */
  const documentListeners = new Map();
  /** @param {Listeners} listeners */
  const eventTarget = (listeners) => ({
    addEventListener: (
      /** @type {string} */ type,
      /** @type {Listener} */ callback,
    ) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      required(listeners.get(type)).add(callback);
    },
    removeEventListener: (
      /** @type {string} */ type,
      /** @type {Listener} */ callback,
    ) => {
      listeners.get(type)?.delete(callback);
    },
  });
  const document = {
    ...eventTarget(documentListeners),
    visibilityState: "visible",
  };
  const navigator = { onLine: true };
  const checkApplicationError = (/** @type {string} */ operation) => {
    if (applicationErrors[operation]) throw applicationErrors[operation];
  };
  /** @satisfies {Pick<StorageContract, "getLoginId" | "getProfileId" | "getUsername" | "getEthAddress" | "getSolAddress" | "getPlayerEmojiId" | "getPlayerEmojiAura" | "setLoginId" | "setProfileId" | "setUsername" | "setEthAddress" | "setSolAddress" | "setPlayerEmojiId" | "setPlayerEmojiAura" | "setPlayerRating" | "setPlayerNonce" | "setPlayerTotalManaPoints" | "setCardBackgroundId" | "setCardStickers" | "setCardSubtitleId" | "setProfileCounter" | "setProfileMons" | "getAuthIdentity">} */
  const storage = {
    getLoginId: (fallback) => data.loginId ?? fallback,
    setLoginId: (value) => {
      checkApplicationError("setLoginId");
      data.loginId = value;
    },
    getProfileId: (fallback) => data.profileId ?? fallback,
    setProfileId: (value) => {
      checkApplicationError("setProfileId");
      data.profileId = value;
    },
    getUsername: (fallback) => data.username ?? fallback,
    setUsername: (value) => {
      checkApplicationError("setUsername");
      data.username = value;
    },
    getEthAddress: (fallback) => data.ethAddress ?? fallback,
    setEthAddress: (value) => {
      checkApplicationError("setEthAddress");
      data.ethAddress = value;
    },
    getSolAddress: (fallback) => data.solAddress ?? fallback,
    setSolAddress: (value) => {
      checkApplicationError("setSolAddress");
      data.solAddress = value;
    },
    getPlayerEmojiId: (fallback) => data.playerEmojiId ?? fallback,
    setPlayerEmojiId: (value) => {
      checkApplicationError("setPlayerEmojiId");
      data.playerEmojiId = value;
    },
    getPlayerEmojiAura: (fallback) => data.playerEmojiAura ?? fallback,
    setPlayerEmojiAura: (value) => {
      checkApplicationError("setPlayerEmojiAura");
      data.playerEmojiAura = value;
    },
    setPlayerRating: (value) => {
      checkApplicationError("setPlayerRating");
      data.playerRating = value;
    },
    setPlayerNonce: (value) => {
      checkApplicationError("setPlayerNonce");
      data.playerNonce = value;
    },
    setPlayerTotalManaPoints: (value) => {
      checkApplicationError("setPlayerTotalManaPoints");
      data.playerTotalManaPoints = value;
    },
    setCardBackgroundId: (value) => {
      checkApplicationError("setCardBackgroundId");
      data.cardBackgroundId = value;
    },
    setCardStickers: (value) => {
      checkApplicationError("setCardStickers");
      data.cardStickers = value;
    },
    setCardSubtitleId: (value) => {
      checkApplicationError("setCardSubtitleId");
      data.cardSubtitleId = value;
    },
    setProfileCounter: (value) => {
      checkApplicationError("setProfileCounter");
      data.profileCounter = value;
    },
    setProfileMons: (value) => {
      checkApplicationError("setProfileMons");
      data.profileMons = value;
    },
    getAuthIdentity: () => ({
      profileId: data.profileId,
      ethAddress: data.ethAddress,
      solAddress: data.solAddress,
    }),
  };
  /**
   * @type {((uid: string | null) => void) | undefined}
   */
  let authCallback;
  let sessionEpoch = 0;
  let nextTimerId = 0;
  /** @type {{ auth: { currentUser: SessionUser | null, isStoppedForLogout: boolean }, isCurrentAuthUser(uid: string): boolean, createSessionGuard(): () => boolean, subscribeToAuthChanges(callback: (uid: string | null) => void): () => void, syncProfile(): Promise<import("@mons/shared/auth").LinkedAuthMethodsResponse>, getProfileByLoginId(uid: string): Promise<Profile>, getSameProfilePlayerUid(): null }} */
  const connection = {
    auth: {
      currentUser: /** @type {SessionUser | null} */ (sessionUser("login-1")),
      isStoppedForLogout: false,
    },
    isCurrentAuthUser: (/** @type {string} */ uid) =>
      connection.auth.currentUser?.uid === uid,
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
      return assert.fail("unexpected legacy profile lookup");
    },
    getSameProfilePlayerUid: () => null,
  };
  /** @type {Map<number, () => void>} */
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
  /** @type {AuthState} */
  let authState = { authStatus: "authenticated", ...storage.getAuthIdentity() };
  const statusDependencies = {
    authChangeVersionRef,
    storage,
    EMPTY_AUTH_IDENTITY: { profileId: "", ethAddress: "", solAddress: "" },
    setAuthState: (
      /** @type {import("react").SetStateAction<AuthState>} */ update,
    ) => {
      authState = typeof update === "function" ? update(authState) : update;
      events.statuses.push(authState.authStatus);
    },
  };
  const setAuthStatus =
    /** @type {ReturnType<typeof import("../src/connection/authentication.ts").useAuthStatus>["setAuthStatus"]} */ (
      new Function(
        ...Object.keys(statusDependencies),
        `${authStatusOutput}\nreturn applyAuthStatus;`,
      )(...Object.values(statusDependencies))
    );
  const dependencies = {
    authAttemptTimeoutIdsRef: {
      current: new Set(/** @type {number[]} */ ([])),
    },
    authChangeVersionRef,
    connection,
    storage,
    sessionAuth: connection.auth,
    localStorage: {
      getItem: (/** @type {string} */ key) => {
        const value = isFixtureField(key) ? data[key] : undefined;
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
      setTimeout: (
        /** @type {() => void} */ callback,
        /** @type {number} */ delay,
      ) => {
        const id = ++nextTimerId;
        timers.set(id, { callback, delay });
        return id;
      },
      clearTimeout: (/** @type {number} */ id) => timers.delete(id),
    },
    document,
    navigator,
    AuthApiError,
    markAuthIdentityReady: () => {},
    /** @type {typeof import("../src/services/initialIdentityBootstrap.ts").readInitialIdentity} */
    readInitialIdentity: async () => {
      events.identities++;
      const user = required(connection.auth.currentUser);
      const identity = await initialIdentity();
      return { user, read: () => identity };
    },
    consumeInitialIdentity: () => {
      events.consumedIdentities++;
    },
    invalidateInitialIdentity: () => {
      events.invalidatedIdentities++;
    },
    /** @type {typeof import("../src/services/initialIdentityBootstrap.ts").repairInitialIdentity} */
    repairInitialIdentity: async (initial, repair) => {
      initial.read();
      await repair();
      dependencies.invalidateInitialIdentity();
      return dependencies.readInitialIdentity();
    },
    /** @type {typeof import("../src/content/problems.ts").syncTutorialProgress} */
    syncTutorialProgress: (...args) => {
      checkApplicationError("syncTutorialProgress");
      events.tutorials.push(args);
    },
    didAttemptAuthentication: () => {
      events.attempts++;
    },
    flushPendingOwnProfileMiningState: () => {
      checkApplicationError("flushPendingOwnProfileMiningState");
      events.flushes++;
    },
    /** @type {typeof import("../src/services/ownProfileMiningHydration.ts").syncOwnProfileMiningState} */
    syncOwnProfileMiningState: (profile) => {
      checkApplicationError("syncOwnProfileMiningState");
      events.mining.push(profile);
    },
    isWatchOnly: watchOnly,
    /** @type {typeof import("../src/ui/identity/profileUiPort.ts").updateProfileDisplayName} */
    updateProfileDisplayName: (...args) => {
      events.displays.push(args);
    },
    /** @type {typeof import("../src/game/board.ts").setupLoggedInPlayerProfile} */
    setupLoggedInPlayerProfile: (profile, uid) => {
      checkApplicationError("setupLoggedInPlayerProfile");
      events.profiles.push({ profile, uid });
    },
  };
  const profileDependencies = {
    ...dependencies,
    createProfileCosmeticWrites: bindProfileCosmeticStorage(
      storage,
      dependencies.localStorage,
    ),
  };
  const applyVerifiedProfile =
    /** @type {typeof import("../src/connection/verifiedProfile.ts").applyVerifiedProfile} */ (
      new Function(
        ...Object.keys(profileDependencies),
        `${profileApplicationOutput}\nreturn applyVerifiedProfile;`,
      )(...Object.values(profileDependencies))
    );
  const authDependencies = { ...profileDependencies, applyVerifiedProfile };
  const cleanup = /** @type {() => void} */ (
    new Function(
      ...Object.keys(authDependencies),
      `${outputText}\nreturn restoreAuth();`,
    )(...Object.values(authDependencies))
  );

  return {
    data,
    events,
    connection,
    cleanup,
    applyProfile: applyVerifiedProfile,
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
    setOnline: (/** @type {boolean} */ online) => {
      navigator.onLine = online;
    },
    changeAuth: (/** @type {string | null} */ uid = "login-1") => {
      connection.auth.currentUser = uid === null ? null : sessionUser(uid);
      required(authCallback)(uid);
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
      const [id, timer] = required(pending[0]);
      timers.delete(id);
      timer.callback();
      return timer.delay;
    },
    wake: (
      /** @type {string} */ type,
      visibilityState = document.visibilityState,
    ) => {
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
  /** @type {Profile} */
  const profile = {
    ...authoritativeProfile,
    rating: 1688,
    nonce: 12,
    totalManaPoints: 42,
    win: true,
    cardBackgroundId: 3,
    cardSubtitleId: 2,
    profileCounter: "gp",
    profileMons: { demon: 1, angel: 2, drainer: 3, spirit: 1, mystic: 2 },
    cardStickers: { mana: "blue-mana" },
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
  required(pending.resolve)({ ok: true, profile: authoritativeProfile });
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
  required(pending.resolve)({ ok: true, profile: authoritativeProfile });
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
    required(pending.resolve)({ ok: true, profile: authoritativeProfile });
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
  required(pending.resolve)({ ok: true, profile: authoritativeProfile });
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
  /** @type {Pick<PromiseWithResolvers<void>, "promise" | "resolve">} */
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
  required(pending.resolve)();
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
    required(pending.resolve)({ ok: true, profile: authoritativeProfile });
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
    /** @type {Profile} */
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
      cardStickers: { "big-mon-top-right": "applecreme" },
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

for (const [label, error] of /** @type {[string, Error][]} */ ([
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
])) {
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
  /** @type {Profile} */
  const profile = {
    ...authoritativeProfile,
    cardBackgroundId: 4,
    cardStickers: { mana: "blue-mana" },
    cardSubtitleId: 8,
    profileCounter: "gp",
    profileMons: { demon: 1, angel: 2, drainer: 3, spirit: 1, mystic: 2 },
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
  const fields = /** @type {const} */ ([
    "cardBackgroundId",
    "cardStickers",
    "cardSubtitleId",
    "profileCounter",
    "profileMons",
  ]);
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
      h.connection.auth.currentUser = sessionUser("login-1");
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
