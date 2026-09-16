import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import {
  automatchBootstrap,
  automatchOperationId,
} from "./automatchBootstrapFixture.mjs";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      context.parentURL?.endsWith(".ts") &&
      (specifier.startsWith("./") || specifier.startsWith("../")) &&
      !/\.[^/]+$/.test(specifier)
    )
      return nextResolve(`${specifier}.ts`, context);
    return nextResolve(specifier, context);
  },
});

const { createInitialGameBootstrap, getInitialGameBootstrapSelection } =
  await import("../src/services/initialGameBootstrap.ts");
const { SessionAuth } = await import("../src/session/sessionAuth.ts");
const { readPendingRematchEnd, rematchEndDeliveryStorageKey } =
  await import("../src/connection/rematchEndDelivery.ts");
const flush = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const invite = (inviteId = "match-a") => ({
  mode: "invite",
  path: inviteId,
  inviteId,
  snapshotId: null,
  eventId: null,
  autojoin: false,
});

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
  for (const change of [
    (h, seed) => {
      seed.operationId = "00000000-0000-4000-8000-000000000002";
    },
    (h, seed) => {
      seed.inviteId = "auto_other";
    },
    (h, seed) => {
      h.changeUser({ ...h.user, generation: "other" });
      seed.user = h.auth.currentUser;
    },
    (h) => h.setSelection("approved"),
    () => t.mock.timers.tick(5_000),
  ]) {
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
  assert.deepEqual(await taken.promise, next.bootstrap);
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
    if (abort) taken.abort();
    else h.changeUser({ ...h.user, sessionId: "replacement" });
    await assert.rejects(taken.promise, (error) => error.code === "aborted");
  }
});

function fixture({
  mode = "invite",
  selection = "current",
  anonymous = false,
  combined = false,
} = {}) {
  const response = deferred();
  const user = {
    uid: "a".repeat(28),
    sessionId: "session-a",
    generation: "generation-a",
    getIdToken: async () => "token",
  };
  const routeListeners = new Set();
  const authListeners = new Set();
  let route =
    mode === "invite" ? invite() : { ...invite(), mode, inviteId: null };
  const requests = [];
  const preparations = [];
  let anonymousStarts = 0;
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
        sessionId: auth.currentUser.sessionId,
        generation: auth.currentUser.generation,
      });
      return {
        user: auth.currentUser,
        selection: options.selectionForUid(auth.currentUser.uid),
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
      tokenProvider.assertCurrentUser();
      return response.promise;
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
    setSelection(next) {
      selection = next;
    },
    navigate(next) {
      route = next;
      routeListeners.forEach((listener) => listener(route));
    },
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
  const inlineGame = { ok: true, schemaVersion: 1 };
  let state = {
    initialized: true,
    generation: crypto.randomUUID(),
    revision: 1,
    revocations: [],
    session: null,
  };
  const creates = [];
  const refreshes = [];
  const reads = [];
  const preparations = [];
  const token = (session) => ({
    ok: true,
    uid: session.uid,
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
      reads.push({ inviteId, token: await tokenProvider(false) });
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
    async replace(nextUid, pendingFirst = false) {
      state = {
        ...state,
        generation: crypto.randomUUID(),
        revision: state.revision + 1,
        session: {
          ...state.session,
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
          session: { ...state.session, uid: nextUid },
        };
        await auth.reconcile();
      }
      return auth.currentUser;
    },
  };
}

test("a fresh anonymous inline game is adoptable as its first user is published", async () => {
  const h = anonymousSessionFixture();
  let taken;
  const unsubscribe = h.auth.onAuthStateChanged((user) => {
    if (user) taken = h.bootstrap.take("match-a", user);
  });
  try {
    h.start();
    await h.requested.promise;
    assert.equal(h.auth.currentUser, null);
    h.responseGate.resolve();
    await flush();
    assert.ok(taken);
    assert.equal(await taken.promise, h.inlineGame);
    assert.equal(h.bootstrap.take("match-a", h.auth.currentUser), null);
    assert.equal(h.creates.length, 1);
    assert.deepEqual(h.creates[0].target, {
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
          const taken = h.bootstrap.take("match-a", replacement);
          void taken?.promise.catch(() => undefined);
          assert.equal(taken, null);
          assert.equal(h.preparations[0].signal.aborted, true);
          const replacementToken = await replacement.getIdToken();
          assert.equal(replacementToken, `token-${replacement.sessionId}`);
          assert.deepEqual(h.refreshes, [
            { sessionId: replacement.sessionId, target: undefined },
          ]);
          if (lateFailure)
            h.responseGate.reject(new Error("old-session-unavailable"));
          else h.responseGate.resolve();
          await creation?.catch(() => undefined);
          await flush();
          assert.equal(h.auth.currentUser, replacement);
          assert.equal(await replacement.getIdToken(), replacementToken);
          assert.equal(h.creates.length, 1);
          assert.equal(h.refreshes.length, 1);
          assert.equal(h.reads.length, 0);
          assert.equal(h.bootstrap.take("match-a", replacement), null);
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
  h.auth.prepareInitialGame = (_inviteId, options) => {
    options.onSessionBound?.({
      sessionId: h.user.sessionId,
      generation: h.user.generation,
    });
    return h.response.promise;
  };
  h.start();
  h.auth.currentUser = { ...h.user, sessionId: "replacement" };
  assert.equal(h.bootstrap.take("match-a", h.auth.currentUser), null);
  h.response.resolve({ user: h.user, selection: "current", bootstrap: null });
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
    const value = { ok: true };
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
    const value = { ok: true, schemaVersion: 1 };
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
  assert.equal(h.bootstrap.take("match-a", h.auth.currentUser), null);
  assert.equal(h.preparations[0].options.signal.aborted, true);
  h.response.resolve({ ok: true });
  await flush();
  assert.equal(h.requests.length, 0);
});

test("session replacement during restoration cannot adopt the previous user's combined request", async () => {
  for (const sameUid of [false, true]) {
    const uid = "a".repeat(28);
    const sessionId = crypto.randomUUID();
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
          refreshes.push({ sessionId: session.sessionId, target });
          if (session.sessionId === sessionId) {
            requested.resolve();
            await response.promise;
          }
          return {
            ok: true,
            uid: session.uid,
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
          ...state.session,
          sessionId: crypto.randomUUID(),
          uid: sameUid ? uid : "b".repeat(28),
        },
      };
      await auth.reconcile();
      const replacement = auth.currentUser;
      assert.notEqual(replacement, previous);
      const taken = bootstrap.take("match-a", replacement);
      void taken?.promise.catch(() => undefined);
      assert.equal(taken, null);
      assert.equal(
        await replacement.getIdToken(),
        `token-${replacement.sessionId}`,
      );
      assert.equal(refreshes.length, 2);
      assert.equal(refreshes[1].target, undefined);
      response.resolve();
      await flush();
      assert.equal(auth.currentUser, replacement);
      assert.equal(
        await replacement.getIdToken(),
        `token-${replacement.sessionId}`,
      );
      assert.equal(refreshes.length, 2);
    } finally {
      response.resolve();
      await flush();
    }
  }
});

test("selection changes after early adoption are distinguished from authentication changes", async () => {
  for (const original of ["current", "approved"]) {
    const latest = original === "current" ? "approved" : "current";
    const h = fixture({ selection: original });
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
    h.response.resolve({ ok: true });
    await rejected;
    assert.equal(h.requests.length, 1);
    assert.equal(h.requests[0].options.selection, latest);
    assert.equal(h.bootstrap.take("match-a", h.user, latest), null);
  }
});

test("explicit combined game failures remain adoptable before and after session completion", async () => {
  for (const completedFirst of [false, true]) {
    const h = fixture({ combined: true });
    h.start();
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
  assert.equal(h.preparations[0].options.signal.aborted, true);
});

test("completed response is discarded when leaving and returning to the initial invite", async () => {
  const h = fixture();
  h.start();
  await flush();
  h.response.resolve({ ok: true });
  await flush();
  assert.equal(h.routeListeners.size, 1);
  h.navigate(invite("match-b"));
  h.navigate(invite());
  assert.equal(h.bootstrap.take("match-a", h.user), null);
  assert.equal(h.requests[0].options.signal.aborted, true);
  assert.equal(h.routeListeners.size, 0);
  assert.equal(h.authListeners.size, 0);
});

test("same-background overlays preserve the response; another auth object with the same UID invalidates it", async () => {
  const h = fixture();
  h.start();
  await flush();
  h.response.resolve({ ok: true });
  await flush();
  h.navigate({ ...invite(), eventId: "event-a" });
  assert.equal(h.requests[0].options.signal.aborted, false);
  h.changeUser({ ...h.user });
  assert.equal(h.bootstrap.take("match-a", h.auth.currentUser), null);
  assert.equal(h.requests[0].options.signal.aborted, true);
});

test("approved/current selection is part of adoption identity", async () => {
  const h = fixture({ selection: "approved" });
  h.start();
  await flush();
  assert.equal(h.requests[0].options.selection, "approved");
  assert.equal(h.bootstrap.take("match-a", h.user, "current"), null);
  assert.equal(h.requests[0].options.signal.aborted, true);
  h.response.resolve({ ok: true });
  await flush();
});

test("caller abort owns an adopted request, and early failures release listeners", async () => {
  const h = fixture();
  h.start();
  await flush();
  const taken = h.bootstrap.take("match-a", h.user);
  taken.abort();
  assert.equal(h.requests[0].options.signal.aborted, true);
  h.response.resolve({ ok: true });
  await assert.rejects(taken.promise, /canceled/);
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
  for (const mode of ["home", "watch", "snapshot", "event"]) {
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
    getItem(key) {
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
    else delete globalThis.window;
  }
});
