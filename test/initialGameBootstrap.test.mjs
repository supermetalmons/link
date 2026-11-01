import { required } from "./fixtures/canonicalData.mjs";
import assert from "node:assert/strict";
import { registerTypeScriptTestHooks } from "./support/typescriptHooks.mjs";
import test from "node:test";
import {
  automatchBootstrap,
  automatchOperationId,
} from "./automatchBootstrapFixture.mjs";

registerTypeScriptTestHooks();

const { createInitialGameBootstrap, getInitialGameBootstrapSelection } =
  await import("../src/services/initialGameBootstrap.ts");
const { SessionAuth } = await import("../src/session/sessionAuth.ts");
const { readPendingRematchEnd, rematchEndDeliveryStorageKey } =
  await import("../src/connection/rematchEndDelivery.ts");
const flush = () => new Promise((resolve) => setImmediate(resolve));
/**
 * @template [T=void]
 * @returns {PromiseWithResolvers<T>}
 */
const deferred = () => {
  return Promise.withResolvers();
};
/**
 * @typedef {Parameters<typeof createInitialGameBootstrap>[0]} BootstrapDependencies
 * @typedef {import("../src/session/sessionAuth.ts").SessionUser} SessionUser
 * @typedef {Parameters<ReturnType<typeof createInitialGameBootstrap>["seedAutomatch"]>[0]} AutomatchSeed
 * @typedef {import("@mons/shared/session-bootstrap").SessionBootstrapResult} BootstrapResult
 */
/** @returns {import("../src/navigation/routeState.ts").RouteState} */
const invite = (inviteId = "match-a") => ({
  mode: "invite",
  path: inviteId,
  inviteId,
  snapshotId: null,
  eventId: null,
  autojoin: false,
});

/** @param {ReturnType<typeof fixture>} h @param {Partial<AutomatchSeed>} [overrides] */
function seedAutomatch(h, overrides = {}) {
  const seed = {
    inviteId: "auto_bootstrap",
    operationId: automatchOperationId,
    user: h.user,
    bootstrap: automatchBootstrap({ hostId: h.user.uid }),
    ...overrides,
  };
  h.bootstrap.seedAutomatch(seed);
  return seed;
}

test("automatch adopts a matching in-memory seed once without another read", async () => {
  const h = fixture({ mode: "home" });
  h.start();
  const seed = seedAutomatch(h);
  h.navigate(invite(seed.inviteId));
  const taken = h.bootstrap.take(
    seed.inviteId,
    h.user,
    "current",
    seed.operationId,
  );
  assert.ok(taken);
  assert.deepEqual(await taken.promise, seed.bootstrap);
  assert.equal(
    h.bootstrap.take(seed.inviteId, h.user, "current", seed.operationId),
    null,
  );
  assert.equal(h.requests.length, 0);
  assert.equal(h.routeListeners.size, 0);
  assert.equal(h.authListeners.size, 0);
});

test("automatch seeds are fenced by operation, invite, user, selection, and expiry", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000 });
  /** @type {Array<(h: ReturnType<typeof fixture>, seed: AutomatchSeed) => void>} */
  const changes = [
    (_h, seed) => {
      seed.operationId = "00000000-0000-4000-8000-000000000002";
    },
    (_h, seed) => {
      seed.inviteId = "auto_other";
    },
    (h, seed) => {
      h.changeUser({ ...h.user, generation: "other" });
      seed.user = required(h.auth.currentUser);
    },
    (h) => h.setSelection("approved"),
    () => t.mock.timers.tick(5_000),
  ];
  for (const change of changes) {
    const h = fixture({ mode: "home" });
    const seed = seedAutomatch(h);
    h.navigate(invite(seed.inviteId));
    change(h, seed);
    assert.equal(
      h.bootstrap.take(seed.inviteId, seed.user, "current", seed.operationId),
      null,
    );
    assert.equal(h.requests.length, 0);
    assert.equal(h.routeListeners.size, 0);
    assert.equal(h.authListeners.size, 0);
  }
});

test("leaving the target route and replacing a seed invalidate the previous automatch", async () => {
  const h = fixture({ mode: "home" });
  const first = seedAutomatch(h);
  h.navigate(invite("different"));
  h.navigate(invite(first.inviteId));
  assert.equal(
    h.bootstrap.take(first.inviteId, h.user, "current", first.operationId),
    null,
  );
  seedAutomatch(h);
  const next = seedAutomatch(h, {
    inviteId: "auto_new",
    bootstrap: automatchBootstrap({ inviteId: "auto_new", hostId: h.user.uid }),
  });
  h.navigate(invite(next.inviteId));
  const taken = h.bootstrap.take(
    next.inviteId,
    h.user,
    "current",
    next.operationId,
  );
  assert.deepEqual(await required(taken).promise, next.bootstrap);
  assert.equal(h.routeListeners.size, 0);
});

test("a seed cannot resolve across a session replacement or abort after adoption", async () => {
  for (const abort of [false, true]) {
    const h = fixture({ mode: "home" });
    const seed = seedAutomatch(h);
    h.navigate(invite(seed.inviteId));
    const taken = h.bootstrap.take(
      seed.inviteId,
      h.user,
      "current",
      seed.operationId,
    );
    if (abort) required(taken).abort();
    else h.changeUser({ ...h.user, sessionId: "replacement" });
    await assert.rejects(
      required(taken).promise,
      (error) =>
        error instanceof Error && "code" in error && error.code === "aborted",
    );
  }
});

/** @param {{mode?: import("../src/navigation/routeState.ts").RouteState["mode"]; selection?: "current" | "approved"; anonymous?: boolean; combined?: boolean}} [options] */
function fixture({
  mode = "invite",
  selection = "current",
  anonymous = false,
  combined = false,
} = {}) {
  /** @type {PromiseWithResolvers<BootstrapResult>} */
  const response = deferred();
  /** @type {SessionUser} */
  const user = {
    uid: "a".repeat(28),
    sessionId: "session-a",
    generation: "generation-a",
    getIdToken: async () => "token",
  };
  /** @type {Set<(route: import("../src/navigation/routeState.ts").RouteState) => void>} */
  const routeListeners = new Set();
  /** @type {Set<Parameters<BootstrapDependencies["auth"]["onAuthStateChanged"]>[0]>} */
  const authListeners = new Set();
  /** @type {import("../src/navigation/routeState.ts").RouteState} */
  let route =
    mode === "invite" ? invite() : { ...invite(), mode, inviteId: null };
  /**
   * @type {{ inviteId: string; options: { signal?: AbortSignal; selection?: "current" | "approved"; } | undefined; }[]}
   */
  const requests = [];
  /** @type {Array<{inviteId: string; options: Parameters<BootstrapDependencies["auth"]["prepareInitialGame"]>[1]}>} */
  const preparations = [];
  let anonymousStarts = 0;
  /** @type {BootstrapDependencies["auth"]} */
  const auth = {
    currentUser: anonymous ? null : user,
    authStateReady: async () => {},
    signInAnonymously: async () => {
      anonymousStarts += 1;
      auth.currentUser = user;
    },
    async prepareInitialGame(inviteId, options) {
      preparations.push({ inviteId, options });
      if (!auth.currentUser) await auth.signInAnonymously();
      options.onSessionBound?.({
        sessionId: required(auth.currentUser).sessionId,
        generation: required(auth.currentUser).generation,
      });
      return {
        user: required(auth.currentUser),
        selection: options.selectionForUid(required(auth.currentUser).uid),
        bootstrap: combined ? await response.promise : null,
      };
    },
    onAuthStateChanged(listener) {
      authListeners.add(listener);
      return () => authListeners.delete(listener);
    },
  };
  const bootstrap = createInitialGameBootstrap({
    auth,
    route: () => route,
    subscribeRoute(listener) {
      routeListeners.add(listener);
      return () => routeListeners.delete(listener);
    },
    selection: () => selection,
    async read(inviteId, tokenProvider, options) {
      requests.push({ inviteId, options });
      const provider = required(tokenProvider);
      assert.ok(provider.assertCurrentUser);
      provider.assertCurrentUser();
      const value = await response.promise;
      assert.ok(value.ok);
      return value;
    },
  });
  return {
    bootstrap,
    response,
    user,
    auth,
    requests,
    preparations,
    routeListeners,
    authListeners,
    start() {
      bootstrap.start(route);
    },
    anonymousStarts: () => anonymousStarts,
    /**
     * @param {"current" | "approved"} next
     */
    setSelection(next) {
      selection = next;
    },
    /**
     * @param {import("../src/navigation/routeState.ts").RouteState} next
     */
    navigate(next) {
      route = next;
      routeListeners.forEach((listener) => listener(route));
    },
    /**
     * @param {SessionUser | null} next
     */
    changeUser(next) {
      auth.currentUser = next;
      authListeners.forEach((listener) => listener(next));
    },
  };
}

function anonymousSessionFixture() {
  const uid = "a".repeat(28);
  const originalSessionId = crypto.randomUUID();
  const requested = deferred();
  const responseGate = deferred();
  const inlineGame = automatchBootstrap({ inviteId: "match-a", hostId: uid });
  /** @type {import("../src/session/sessionStore.ts").SessionState} */
  let state = {
    initialized: true,
    generation: crypto.randomUUID(),
    revision: 1,
    revocations: [],
    session: null,
  };
  /**
   * @type {{ sessionId: string; target: (import("@mons/shared/session-bootstrap").SessionBootstrapTarget | import("@mons/shared/session-bootstrap").SessionEventBootstrapTarget) | undefined; }[]}
   */
  const creates = [];
  /**
   * @type {{ sessionId: string; target: (import("@mons/shared/session-bootstrap").SessionBootstrapTarget | import("@mons/shared/session-bootstrap").SessionEventBootstrapTarget) | undefined; }[]}
   */
  const refreshes = [];
  /**
   * @type {{ inviteId: string; token: string; }[]}
   */
  const reads = [];
  /**
   * @type {{ selectionForUid: (uid: string) => import("@mons/shared/session-bootstrap").SessionBootstrapTarget["selection"]; signal: AbortSignal; onSessionBound?: NonNullable<((owner: import("../src/session/sessionAuth.ts").InitialGameSessionOwner) => void) | undefined>; }[]}
   */
  const preparations = [];
  /** @param {import("../src/session/sessionStore.ts").StoredSession} session @returns {import("../src/services/sessionApi.ts").SessionTokenResult} */
  const token = (session) => ({
    ok: true,
    uid: required(session.uid),
    sessionId: session.sessionId,
    accessToken: `token-${session.sessionId}`,
    accessExpiresAtMs: 1_300_000,
    accessDeadlineMs: 1_300_000,
  });
  const auth = new SessionAuth({
    store: {
      async update(change) {
        state = structuredClone(change(structuredClone(state)));
        return state;
      },
    },
    api: {
      async create(session, target) {
        if (target) assert.ok("inviteId" in target);
        creates.push({ sessionId: session.sessionId, target });
        requested.resolve();
        await responseGate.promise;
        return {
          ...token({ ...session, uid }),
          ...(target
            ? { gameBootstrap: { ...target, result: inlineGame } }
            : {}),
        };
      },
      async refresh(session, target) {
        if (target) assert.ok("inviteId" in target);
        refreshes.push({ sessionId: session.sessionId, target });
        return token(session);
      },
      async revoke() {},
    },
    now: () => 1_000_000,
    createSession: () => ({
      sessionId: originalSessionId,
      uid: null,
      refreshSecret: "refresh",
      revokeSecret: "revoke",
    }),
    newGeneration: () => crypto.randomUUID(),
  });
  const prepare = auth.prepareInitialGame.bind(auth);
  auth.prepareInitialGame = (inviteId, options) => {
    preparations.push(options);
    return prepare(inviteId, options);
  };
  const bootstrap = createInitialGameBootstrap({
    auth,
    route: invite,
    subscribeRoute: () => () => {},
    selection: () => "current",
    async read(inviteId, tokenProvider) {
      reads.push({ inviteId, token: await required(tokenProvider)(false) });
      return inlineGame;
    },
  });
  return {
    auth,
    bootstrap,
    requested,
    responseGate,
    creates,
    refreshes,
    reads,
    preparations,
    inlineGame,
    uid,
    start: () => bootstrap.start(invite()),
    /**
     * @param {string} nextUid
     */
    async replace(nextUid, pendingFirst = false) {
      state = {
        ...state,
        generation: crypto.randomUUID(),
        revision: state.revision + 1,
        session: {
          ...required(state.session),
          sessionId: crypto.randomUUID(),
          uid: pendingFirst ? null : nextUid,
        },
      };
      await auth.reconcile();
      if (pendingFirst) {
        assert.equal(auth.currentUser, null);
        state = {
          ...state,
          revision: state.revision + 1,
          session: { ...required(state.session), uid: nextUid },
        };
        await auth.reconcile();
      }
      return auth.currentUser;
    },
  };
}

test("a fresh anonymous inline game is adoptable as its first user is published", async () => {
  const h = anonymousSessionFixture();
  /** @type {{ value?: ReturnType<ReturnType<typeof createInitialGameBootstrap>["take"]> }} */
  const captured = {};
  const unsubscribe = h.auth.onAuthStateChanged((user) => {
    if (user) captured.value = h.bootstrap.take("match-a", user);
  });
  try {
    h.start();
    await h.requested.promise;
    assert.equal(h.auth.currentUser, null);
    h.responseGate.resolve();
    await flush();
    const taken = required(captured.value);
    assert.equal(await taken.promise, h.inlineGame);
    assert.equal(
      h.bootstrap.take("match-a", required(readCurrentUser(h.auth))),
      null,
    );
    assert.equal(h.creates.length, 1);
    assert.deepEqual(required(h.creates[0]).target, {
      inviteId: "match-a",
      selection: "current",
    });
    assert.equal(h.refreshes.length, 0);
    assert.equal(h.reads.length, 0);
  } finally {
    unsubscribe();
    h.responseGate.resolve();
    await flush();
  }
});

for (const joinedExistingCreation of [false, true]) {
  test(`the first replacement user cannot adopt ${joinedExistingCreation ? "an already-dispatched" : "a combined"} anonymous creation`, async () => {
    for (const sameUid of [false, true]) {
      for (const lateFailure of [false, true]) {
        const h = anonymousSessionFixture();
        let creation;
        if (joinedExistingCreation) {
          creation = h.auth.signInAnonymously();
          void creation.catch(() => undefined);
          await h.requested.promise;
        }
        h.start();
        try {
          await h.requested.promise;
          await flush();
          assert.equal(h.auth.currentUser, null);
          const replacement = await h.replace(
            sameUid ? h.uid : "b".repeat(28),
            sameUid,
          );
          const taken = h.bootstrap.take("match-a", required(replacement));
          void taken?.promise.catch(() => undefined);
          assert.equal(taken, null);
          assert.equal(required(h.preparations[0]).signal.aborted, true);
          const replacementToken = await required(replacement).getIdToken();
          assert.equal(
            replacementToken,
            `token-${required(replacement).sessionId}`,
          );
          assert.deepEqual(h.refreshes, [
            { sessionId: required(replacement).sessionId, target: undefined },
          ]);
          if (lateFailure)
            h.responseGate.reject(new Error("old-session-unavailable"));
          else h.responseGate.resolve();
          await creation?.catch(() => undefined);
          await flush();
          assert.equal(h.auth.currentUser, replacement);
          assert.equal(
            await required(replacement).getIdToken(),
            replacementToken,
          );
          assert.equal(h.creates.length, 1);
          assert.equal(h.refreshes.length, 1);
          assert.equal(h.reads.length, 0);
          assert.equal(
            h.bootstrap.take("match-a", required(replacement)),
            null,
          );
        } finally {
          h.responseGate.resolve();
          await creation?.catch(() => undefined);
          await flush();
        }
      }
    }
  });
}

test("adoption checks a bound anonymous owner even without an auth notification", async () => {
  const h = fixture({ anonymous: true, combined: true });
  /** @type {PromiseWithResolvers<import("../src/session/sessionAuth.ts").InitialGameSession>} */
  const preparation = deferred();
  h.auth.prepareInitialGame = (_inviteId, options) => {
    options.onSessionBound?.({
      sessionId: h.user.sessionId,
      generation: h.user.generation,
    });
    return preparation.promise;
  };
  h.start();
  h.auth.currentUser = { ...h.user, sessionId: "replacement" };
  assert.equal(
    h.bootstrap.take("match-a", required(readCurrentUser(h.auth))),
    null,
  );
  preparation.resolve({ user: h.user, selection: "current", bootstrap: null });
  await flush();
  assert.equal(h.requests.length, 0);
});

test("initial request starts independently and is adopted exactly once, before or after response", async () => {
  for (const completedFirst of [false, true]) {
    const h = fixture();
    h.start();
    h.start();
    await flush();
    assert.equal(h.requests.length, 1);
    const value = automatchBootstrap({
      inviteId: "match-a",
      hostId: h.user.uid,
    });
    if (completedFirst) {
      h.response.resolve(value);
      await flush();
    }
    const taken = h.bootstrap.take("match-a", h.user, "current");
    assert.ok(taken);
    assert.equal(h.bootstrap.take("match-a", h.user, "current"), null);
    assert.equal(h.routeListeners.size, 0);
    assert.equal(h.authListeners.size, 0);
    h.response.resolve(value);
    assert.equal(await taken.promise, value);
    assert.equal(h.requests.length, 1);
  }
});

test("combined session results are adopted once without a separate game read", async () => {
  for (const completedFirst of [false, true]) {
    const h = fixture({ combined: true });
    h.start();
    assert.equal(h.preparations.length, 1);
    const value = automatchBootstrap({
      inviteId: "match-a",
      hostId: h.user.uid,
    });
    if (completedFirst) {
      h.response.resolve(value);
      await flush();
    }
    const taken = h.bootstrap.take("match-a", h.user);
    assert.ok(taken);
    h.response.resolve(value);
    assert.equal(await taken.promise, value);
    assert.equal(h.bootstrap.take("match-a", h.user), null);
    assert.equal(h.requests.length, 0);
  }
});

test("an already-restored user owns the pending combined request before adoption", async () => {
  const h = fixture({ combined: true });
  h.start();
  h.changeUser({ ...h.user, generation: "replacement" });
  assert.equal(
    h.bootstrap.take("match-a", required(readCurrentUser(h.auth))),
    null,
  );
  assert.equal(required(h.preparations[0]).options.signal.aborted, true);
  h.response.resolve(
    automatchBootstrap({ inviteId: "match-a", hostId: h.user.uid }),
  );
  await flush();
  assert.equal(h.requests.length, 0);
});

test("session replacement during restoration cannot adopt the previous user's combined request", async () => {
  for (const sameUid of [false, true]) {
    const uid = "a".repeat(28);
    const sessionId = crypto.randomUUID();
    /** @type {import("../src/session/sessionStore.ts").SessionState} */
    let state = {
      initialized: true,
      generation: crypto.randomUUID(),
      revision: 1,
      revocations: [],
      session: {
        sessionId,
        uid,
        refreshSecret: "refresh",
        revokeSecret: "revoke",
      },
    };
    const requested = deferred();
    const response = deferred();
    /** @type {Array<{ sessionId: string; target: (import("@mons/shared/session-bootstrap").SessionBootstrapTarget | import("@mons/shared/session-bootstrap").SessionEventBootstrapTarget) | undefined; }>} */
    const refreshes = [];
    const auth = new SessionAuth({
      store: {
        async update(change) {
          state = structuredClone(change(structuredClone(state)));
          return state;
        },
      },
      api: {
        async create() {
          throw new Error("unexpected-create");
        },
        async refresh(session, target) {
          if (target) assert.ok("inviteId" in target);
          refreshes.push({ sessionId: session.sessionId, target });
          if (session.sessionId === sessionId) {
            requested.resolve();
            await response.promise;
          }
          return {
            ok: true,
            uid: required(session.uid),
            sessionId: session.sessionId,
            accessToken: `token-${session.sessionId}`,
            accessExpiresAtMs: 1_300_000,
            accessDeadlineMs: 1_300_000,
            ...(target
              ? {
                  gameBootstrap: {
                    ...target,
                    result: { ok: false, status: 404 },
                  },
                }
              : {}),
          };
        },
        async revoke() {},
      },
      now: () => 1_000_000,
      createSession: () => {
        throw new Error("unexpected-create");
      },
      newGeneration: () => crypto.randomUUID(),
    });
    const bootstrap = createInitialGameBootstrap({
      auth,
      route: invite,
      subscribeRoute: () => () => {},
      selection: () => "current",
      read: async () => {
        throw new Error("unexpected-old-game-read");
      },
    });
    bootstrap.start(invite());
    try {
      await requested.promise;
      const previous = auth.currentUser;
      state = {
        ...state,
        generation: crypto.randomUUID(),
        revision: state.revision + 1,
        session: {
          ...required(state.session),
          sessionId: crypto.randomUUID(),
          uid: sameUid ? uid : "b".repeat(28),
        },
      };
      await auth.reconcile();
      const replacement = auth.currentUser;
      assert.notEqual(replacement, previous);
      const taken = bootstrap.take("match-a", required(replacement));
      void taken?.promise.catch(() => undefined);
      assert.equal(taken, null);
      assert.equal(
        await required(replacement).getIdToken(),
        `token-${required(replacement).sessionId}`,
      );
      assert.equal(refreshes.length, 2);
      assert.equal(required(refreshes[1]).target, undefined);
      response.resolve();
      await flush();
      assert.equal(auth.currentUser, replacement);
      assert.equal(
        await required(replacement).getIdToken(),
        `token-${required(replacement).sessionId}`,
      );
      assert.equal(refreshes.length, 2);
    } finally {
      response.resolve();
      await flush();
    }
  }
});

test("selection changes after early adoption are distinguished from authentication changes", async () => {
  for (const original of /** @type {const} */ (["current", "approved"])) {
    const latest = original === "current" ? "approved" : "current";
    const h = fixture({ selection: original });
    /** @type {PromiseWithResolvers<import("../src/session/sessionAuth.ts").InitialGameSession>} */
    const preparation = deferred();
    h.auth.prepareInitialGame = () => preparation.promise;
    h.start();
    const taken = h.bootstrap.take("match-a", h.user, original);
    assert.ok(taken);
    h.setSelection(latest);
    const rejected = assert.rejects(taken.promise, {
      name: "GameBootstrapApiError",
      code: "initial-game-bootstrap-selection-changed",
    });
    preparation.resolve({ user: h.user, selection: latest, bootstrap: null });
    h.response.resolve(
      automatchBootstrap({ inviteId: "match-a", hostId: h.user.uid }),
    );
    await rejected;
    assert.equal(h.requests.length, 1);
    assert.equal(required(required(h.requests[0]).options).selection, latest);
    assert.equal(h.bootstrap.take("match-a", h.user, latest), null);
  }
});

test("explicit combined game failures remain adoptable before and after session completion", async () => {
  for (const completedFirst of [false, true]) {
    const h = fixture({ combined: true });
    h.start();
    /** @type {import("@mons/shared/session-bootstrap").SessionBootstrapFailure} */
    const failure = { ok: false, status: 429, retryAfterMs: 3000 };
    if (completedFirst) {
      h.response.resolve(failure);
      await flush();
      assert.equal(h.routeListeners.size, 1);
      assert.equal(h.authListeners.size, 1);
    }
    const taken = h.bootstrap.take("match-a", h.user);
    assert.ok(taken);
    const rejected = assert.rejects(taken.promise, {
      name: "GameBootstrapApiError",
      code: "http-429",
      status: 429,
      retryAfterMs: 3000,
    });
    h.response.resolve(failure);
    await rejected;
    assert.equal(h.requests.length, 0);
    assert.equal(h.bootstrap.take("match-a", h.user), null);
    assert.equal(h.routeListeners.size, 0);
    assert.equal(h.authListeners.size, 0);
  }
});

test("navigation discards a combined failure before it can be adopted", async () => {
  const h = fixture({ combined: true });
  h.start();
  h.navigate(invite("match-b"));
  h.response.resolve({ ok: false, status: 404 });
  await flush();
  assert.equal(h.bootstrap.take("match-a", h.user), null);
  assert.equal(h.requests.length, 0);
  assert.equal(required(h.preparations[0]).options.signal.aborted, true);
});

test("completed response is discarded when leaving and returning to the initial invite", async () => {
  const h = fixture();
  h.start();
  await flush();
  h.response.resolve(
    automatchBootstrap({ inviteId: "match-a", hostId: h.user.uid }),
  );
  await flush();
  assert.equal(h.routeListeners.size, 1);
  h.navigate(invite("match-b"));
  h.navigate(invite());
  assert.equal(h.bootstrap.take("match-a", h.user), null);
  assert.equal(
    required(required(required(h.requests[0]).options).signal).aborted,
    true,
  );
  assert.equal(h.routeListeners.size, 0);
  assert.equal(h.authListeners.size, 0);
});

test("same-background overlays preserve the response; another auth object with the same UID invalidates it", async () => {
  const h = fixture();
  h.start();
  await flush();
  h.response.resolve(
    automatchBootstrap({ inviteId: "match-a", hostId: h.user.uid }),
  );
  await flush();
  h.navigate({ ...invite(), eventId: "event-a" });
  assert.equal(
    required(required(required(h.requests[0]).options).signal).aborted,
    false,
  );
  h.changeUser({ ...h.user });
  assert.equal(
    h.bootstrap.take("match-a", required(readCurrentUser(h.auth))),
    null,
  );
  assert.equal(
    required(required(required(h.requests[0]).options).signal).aborted,
    true,
  );
});

test("approved/current selection is part of adoption identity", async () => {
  const h = fixture({ selection: "approved" });
  h.start();
  await flush();
  assert.equal(required(required(h.requests[0]).options).selection, "approved");
  assert.equal(h.bootstrap.take("match-a", h.user, "current"), null);
  assert.equal(
    required(required(required(h.requests[0]).options).signal).aborted,
    true,
  );
  h.response.resolve(
    automatchBootstrap({ inviteId: "match-a", hostId: h.user.uid }),
  );
  await flush();
});

test("caller abort owns an adopted request, and early failures release listeners", async () => {
  const h = fixture();
  h.start();
  await flush();
  const taken = h.bootstrap.take("match-a", h.user);
  required(taken).abort();
  assert.equal(
    required(required(required(h.requests[0]).options).signal).aborted,
    true,
  );
  h.response.resolve(
    automatchBootstrap({ inviteId: "match-a", hostId: h.user.uid }),
  );
  await assert.rejects(required(taken).promise, /canceled/);
  const failure = fixture();
  failure.start();
  await flush();
  failure.response.reject(new Error("unavailable"));
  await flush();
  assert.equal(failure.routeListeners.size, 0);
  assert.equal(failure.authListeners.size, 0);
  assert.equal(failure.bootstrap.take("match-a", failure.user), null);
});

test("local, bots, snapshot, and event modes warm the shared session without reading a game", async () => {
  for (const mode of /** @type {const} */ ([
    "home",
    "watch",
    "snapshot",
    "event",
  ])) {
    const h = fixture({ mode, anonymous: true });
    h.start();
    await flush();
    assert.equal(h.anonymousStarts(), 1);
    assert.equal(h.requests.length, 0);
    assert.equal(h.routeListeners.size, 0);
  }
});

test("pending rematch-end selection uses the same validated persisted record as delivery", () => {
  const scope = { loginUid: "a".repeat(28), inviteId: "match-a" };
  const record = {
    ...scope,
    matchId: "match-a1",
    actorUid: scope.loginUid,
    operationId: crypto.randomUUID(),
  };
  const persistence = {
    getItem(/** @type {string} */ key) {
      assert.equal(key, rematchEndDeliveryStorageKey(scope));
      return JSON.stringify({ version: 1, record });
    },
  };
  assert.deepEqual(readPendingRematchEnd(scope, persistence), record);
  assert.equal(readPendingRematchEnd(scope, { getItem: () => null }), null);
  assert.throws(
    () => readPendingRematchEnd(scope, { getItem: () => "{}" }),
    /invalid-stored/,
  );
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      sessionStorage: persistence,
      localStorage: { getItem: () => null },
    },
  });
  try {
    assert.equal(
      getInitialGameBootstrapSelection(scope.inviteId, { uid: scope.loginUid }),
      "approved",
    );
  } finally {
    if (previousWindow)
      Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

/** @param {{currentUser: SessionUser | null}} auth @returns {SessionUser | null} */
function readCurrentUser(auth) {
  return auth.currentUser;
}
