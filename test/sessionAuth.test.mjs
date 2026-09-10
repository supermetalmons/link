import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";
import ts from "typescript";

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

const {
  SessionAuth,
  retireLegacySessionIdentity,
  consumeSessionResetNotice,
  hasPendingSessionResetNotice,
} = await import("../src/session/sessionAuth.ts");
const { SessionApiError } = await import("../src/services/sessionApi.ts");
const {
  createEmptySessionState,
  createIndexedDbSessionStore,
  SessionStorageError,
} = await import("../src/session/sessionStore.ts");
const { createUserBoundAuthTokenProvider } =
  await import("../src/services/authApi.ts");
const { isLogoutRecoveryRequired, setLogoutRecoveryRequired } =
  await import("../src/session/logoutRecovery.ts");

test.afterEach(() => setLogoutRecoveryRequired(false));

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

const flush = () => new Promise((resolve) => setImmediate(resolve));
const createSession = () => ({
  sessionId: crypto.randomUUID(),
  refreshSecret: Buffer.from(
    crypto.getRandomValues(new Uint8Array(32)),
  ).toString("base64url"),
  revokeSecret: Buffer.from(
    crypto.getRandomValues(new Uint8Array(32)),
  ).toString("base64url"),
  uid: null,
});

function memoryStore(initial = createEmptySessionState()) {
  let state = structuredClone(initial);
  let queue = Promise.resolve();
  return {
    read: () => structuredClone(state),
    update(change) {
      const operation = queue.then(() => {
        state = structuredClone(change(structuredClone(state)));
        return structuredClone(state);
      });
      queue = operation.catch(() => undefined);
      return operation;
    },
  };
}

function harness() {
  let now = 1_000_000;
  let tokenNumber = 0;
  const sessions = new Map();
  const revoked = new Set();
  const creates = [];
  const refreshes = [];
  const revokes = [];
  const store = memoryStore();
  const pendingLogouts = new Set();
  const logoutIntents = {
    has: (generation) => pendingLogouts.has(generation),
    add: (generation) => {
      pendingLogouts.add(generation);
      return true;
    },
    remove: (generation) => pendingLogouts.delete(generation),
  };
  const token = (session) => ({
    ok: true,
    uid: session.uid,
    sessionId: session.sessionId,
    accessToken: `token-${++tokenNumber}`,
    accessExpiresAtMs: now + 300_000,
    accessDeadlineMs: now + 300_000,
  });
  const api = {
    async create(session) {
      creates.push(structuredClone(session));
      if (revoked.has(session.sessionId))
        throw new SessionApiError("session-revoked", "revoked");
      let persisted = sessions.get(session.sessionId);
      if (!persisted) {
        persisted = {
          ...session,
          uid: `m${String(sessions.size + 1).padStart(27, "0")}`,
        };
        sessions.set(session.sessionId, persisted);
      }
      assert.equal(session.refreshSecret, persisted.refreshSecret);
      assert.equal(session.revokeSecret, persisted.revokeSecret);
      return token(persisted);
    },
    async refresh(session) {
      refreshes.push(session.sessionId);
      if (revoked.has(session.sessionId))
        throw new SessionApiError("session-revoked", "revoked");
      return token(sessions.get(session.sessionId));
    },
    async revoke(session) {
      revokes.push(structuredClone(session));
      revoked.add(session.sessionId);
    },
  };
  const make = (overrides = {}) =>
    new SessionAuth({
      store,
      logoutIntents,
      api,
      now: () => now,
      createSession,
      newGeneration: () => crypto.randomUUID(),
      ...overrides,
    });
  return {
    make,
    api,
    store,
    logoutIntents,
    creates,
    refreshes,
    revokes,
    revoked,
    sessions,
    token,
    advance: (ms) => {
      now += ms;
    },
  };
}

function logoutFunction(name, dependencies) {
  dependencies = { setLogoutRecoveryRequired, ...dependencies };
  const source = ts.createSourceFile(
    "logoutOrchestrator.ts",
    readFileSync(
      new URL("../src/session/logoutOrchestrator.ts", import.meta.url),
      "utf8",
    ),
    ts.ScriptTarget.Latest,
    true,
  );
  const declaration = source.statements
    .filter(ts.isVariableStatement)
    .flatMap((statement) => statement.declarationList.declarations)
    .find((node) => node.name.getText(source) === name);
  assert.ok(declaration?.initializer);
  const { outputText } = ts.transpileModule(
    `let lastHandledSignalId = ""; let isHandlingSignal = false; const run = ${declaration.initializer.getText(source)};`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
  );
  return new Function(
    ...Object.keys(dependencies),
    `${outputText}\nreturn run;`,
  )(...Object.values(dependencies));
}

test("two tabs atomically share anonymous credentials and one server identity", async () => {
  const h = harness();
  const first = h.make();
  const second = h.make();
  await Promise.all([first.signInAnonymously(), second.signInAnonymously()]);
  assert.equal(first.currentUser.uid, second.currentUser.uid);
  assert.equal(first.currentUser.sessionId, second.currentUser.sessionId);
  assert.equal(h.sessions.size, 1);
  assert.ok(
    h.creates.every((entry) => entry.sessionId === h.creates[0].sessionId),
  );
  assert.notEqual(h.creates[0].refreshSecret, h.creates[0].revokeSecret);
});

test("a lost create response replays the exact persisted credentials after reload", async () => {
  const h = harness();
  const create = h.api.create;
  let lost = true;
  h.api.create = async (session) => {
    const response = await create(session);
    if (lost) {
      lost = false;
      throw new SessionApiError("unavailable", "offline");
    }
    return response;
  };
  const first = h.make();
  await assert.rejects(first.signInAnonymously(), /offline/);
  assert.equal(first.currentUser, null);
  const pending = h.store.read().session;
  assert.equal(pending.uid, null);
  const restored = h.make();
  await restored.signInAnonymously();
  assert.equal(restored.currentUser.sessionId, pending.sessionId);
  assert.equal(h.sessions.size, 1);
  assert.deepEqual(h.creates[1], h.creates[0]);
});

test("bootstrap waits for storage and never creates a replacement on storage failure", async () => {
  const h = harness();
  const pending = deferred();
  const auth = h.make({ store: { update: () => pending.promise } });
  const attempt = auth.signInAnonymously();
  await flush();
  assert.equal(h.creates.length, 0);
  pending.reject(new SessionStorageError());
  await assert.rejects(attempt, /Session storage is unavailable/);
  assert.equal(h.creates.length, 0);
  assert.equal(auth.currentUser, null);
  await assert.rejects(
    createIndexedDbSessionStore(() => {
      throw new Error("blocked");
    }).update((state) => state),
    SessionStorageError,
  );
});

test("persistent sessions refresh after months inactive and preserve user identity", async () => {
  const h = harness();
  const first = h.make();
  await first.signInAnonymously();
  const uid = first.currentUser.uid;
  assert.equal(first.restoredSessionId, null);
  h.advance(400 * 24 * 60 * 60 * 1000);
  const restored = h.make();
  await restored.authStateReady();
  const user = restored.currentUser;
  assert.equal(restored.restoredSessionId, user.sessionId);
  assert.equal(user.uid, uid);
  const token = await user.getIdToken();
  assert.match(token, /^token-/);
  assert.equal(restored.currentUser, user);
  assert.equal(h.sessions.size, 1);
  assert.equal(h.refreshes.length, 1);
});

test("503 and offline refresh preserve durable credentials and current user", async () => {
  const h = harness();
  const auth = h.make();
  await auth.signInAnonymously();
  const user = auth.currentUser;
  const state = h.store.read();
  h.api.refresh = async () => {
    throw new SessionApiError("unavailable", "offline");
  };
  await assert.rejects(user.getIdToken(true), /offline/);
  assert.equal(auth.currentUser, user);
  assert.deepEqual(h.store.read().session, state.session);
  await auth.signInAnonymously();
  assert.equal(h.creates.length, 1);
});

test("cached token and socket lifetime age monotonically across wall-clock changes", async () => {
  const h = harness();
  const originalNow = Date.now;
  const auth = h.make();
  try {
    Date.now = () => originalNow() + 600_000;
    await auth.signInAnonymously();
    const user = auth.currentUser;
    const token = await user.getIdToken();
    assert.equal(auth.getTokenRemainingMs(token), 300_000);
    Date.now = () => originalNow() - 600_000;
    h.advance(120_000);
    assert.equal(await user.getIdToken(), token);
    assert.equal(auth.getTokenRemainingMs(token), 180_000);
    assert.equal(h.refreshes.length, 0);
    h.advance(150_001);
    const fresh = await user.getIdToken();
    assert.notEqual(fresh, token);
    assert.equal(h.refreshes.length, 1);
    assert.equal(auth.currentUser, user);
    assert.equal(auth.getTokenRemainingMs(fresh), 300_000);
    assert.equal(auth.getTokenRemainingMs(token), 0);
    await auth.signOut();
    assert.equal(auth.getTokenRemainingMs(fresh), 0);
  } finally {
    Date.now = originalNow;
  }
});

test("refresh is single-flight within a tab and independent across tabs", async () => {
  const h = harness();
  const first = h.make();
  await first.signInAnonymously();
  const second = h.make();
  await second.authStateReady();
  const wait = deferred();
  const refresh = h.api.refresh;
  h.api.refresh = async (session) => {
    await wait.promise;
    return refresh(session);
  };
  const tokens = [
    first.currentUser.getIdToken(true),
    first.currentUser.getIdToken(true),
    second.currentUser.getIdToken(true),
  ];
  await flush();
  wait.resolve();
  const results = await Promise.all(tokens);
  assert.equal(results[0], results[1]);
  assert.equal(h.refreshes.length, 2);
  assert.equal(h.revokes.length, 0);
});

test("logout revokes an in-flight create before it can publish a user", async () => {
  const h = harness();
  const wait = deferred();
  const create = h.api.create;
  h.api.create = async (session) => {
    await wait.promise;
    return create(session);
  };
  const auth = h.make();
  const attempt = auth.signInAnonymously();
  await flush();
  const pending = h.store.read().session;
  await auth.signOut();
  await auth.flushRevocations();
  assert.equal(auth.currentUser, null);
  assert.equal(h.store.read().session, null);
  assert.equal(h.revoked.has(pending.sessionId), true);
  wait.resolve();
  await assert.rejects(attempt, /revoked/);
  assert.equal(auth.currentUser, null);
  assert.equal(h.store.read().session, null);
});

test("a delayed successful create cannot restore credentials after logout", async () => {
  const h = harness();
  const wait = deferred();
  const create = h.api.create;
  h.api.create = async (session) => {
    const response = await create(session);
    await wait.promise;
    return response;
  };
  const auth = h.make();
  const attempt = auth.signInAnonymously();
  await flush();
  await auth.signOut();
  wait.resolve();
  await assert.rejects(attempt, /authentication-changed/);
  assert.equal(h.store.read().session, null);
});

test("logout during refresh invalidates bound token providers and cannot resurrect auth", async () => {
  const h = harness();
  const auth = h.make();
  await auth.signInAnonymously();
  const user = auth.currentUser;
  const provider = createUserBoundAuthTokenProvider(
    user,
    () => auth.currentUser,
  );
  const wait = deferred();
  const response = h.token(h.sessions.get(user.sessionId));
  h.api.refresh = () => wait.promise;
  const token = provider(true);
  await flush();
  await auth.signOut();
  wait.resolve(response);
  await assert.rejects(token, /authentication-changed/);
  assert.equal(auth.currentUser, null);
  assert.equal(h.store.read().session, null);
  assert.throws(provider.assertCurrentUser, /authentication-changed/);
});

test("offline logout retains only a revoke capability and retries it after reload", async () => {
  const h = harness();
  const auth = h.make();
  await auth.signInAnonymously();
  const oldSession = h.store.read().session;
  const revoke = h.api.revoke;
  h.api.revoke = async () => {
    throw new Error("offline");
  };
  await auth.signOut();
  await auth.flushRevocations();
  const state = h.store.read();
  assert.equal(state.session, null);
  assert.deepEqual(state.revocations, [
    { sessionId: oldSession.sessionId, revokeSecret: oldSession.revokeSecret },
  ]);
  assert.equal(JSON.stringify(state).includes(oldSession.refreshSecret), false);
  h.api.revoke = revoke;
  const restored = h.make();
  await restored.authStateReady();
  await restored.flushRevocations();
  assert.deepEqual(h.store.read().revocations, []);
  assert.equal(h.revoked.has(oldSession.sessionId), true);
});

test("a missed logout broadcast is discovered before cached-token reuse", async () => {
  const h = harness();
  const first = h.make();
  await first.signInAnonymously();
  const second = h.make();
  await second.authStateReady();
  const user = second.currentUser;
  await user.getIdToken();
  await first.signOut();
  await assert.rejects(user.getIdToken(), /authentication-changed/);
  assert.equal(second.currentUser, null);
});

test("cleared storage retires old handles and explicit sign-in initializes a reloadable replacement", async () => {
  const h = harness();
  let initializations = 0;
  const initializeIdentity = () => {
    initializations++;
  };
  const auth = h.make({ initializeIdentity });
  await auth.signInAnonymously();
  const oldUser = auth.currentUser;
  await auth.flushRevocations();
  await h.store.update(() => createEmptySessionState());

  await assert.rejects(oldUser.getIdToken(), /authentication-changed/);
  assert.equal(auth.currentUser, null);
  assert.equal(auth.restoredSessionId, null);
  h.advance(24 * 60 * 60 * 1000);
  await assert.rejects(oldUser.getIdToken(true), /authentication-changed/);
  assert.equal(h.refreshes.length, 0);
  assert.equal(h.creates.length, 1);
  assert.equal(h.store.read().session, null);

  await auth.signInAnonymously();
  const replacement = auth.currentUser;
  assert.notEqual(replacement.uid, oldUser.uid);
  assert.equal(h.store.read().initialized, true);
  assert.equal(initializations, 2);
  const reloaded = h.make({ initializeIdentity });
  await reloaded.authStateReady();
  assert.equal(reloaded.currentUser.uid, replacement.uid);
  assert.equal(initializations, 2);
});

test("a recreated database from another tab supersedes a higher old revision", async () => {
  const h = harness();
  const first = h.make();
  await first.signInAnonymously();
  await h.store.update((state) => ({ ...state, revision: 100 }));
  await first.reconcile();
  const oldUser = first.currentUser;
  await h.store.update(() => createEmptySessionState());
  const replacement = h.make();
  await replacement.signInAnonymously();
  assert.ok(h.store.read().revision < 100);
  await assert.rejects(oldUser.getIdToken(), /authentication-changed/);
  assert.equal(first.currentUser.uid, replacement.currentUser.uid);
  await first.currentUser.getIdToken();
  assert.deepEqual(h.refreshes, [replacement.currentUser.sessionId]);
});

test("a tab invalidated by storage clearing can adopt a later replacement notification", async () => {
  const h = harness();
  let initializations = 0;
  const initializeIdentity = () => {
    initializations++;
  };
  const first = h.make({ initializeIdentity });
  await first.signInAnonymously();
  const oldUser = first.currentUser;
  await first.flushRevocations();
  await h.store.update(() => createEmptySessionState());
  await assert.rejects(oldUser.getIdToken(), /authentication-changed/);
  const replacement = h.make({ initializeIdentity });
  await replacement.signInAnonymously();
  await first.reconcile();
  assert.equal(first.currentUser.uid, replacement.currentUser.uid);
  assert.equal(initializations, 2);
  assert.equal(h.creates.length, 2);
});

test("delayed storage completion cannot overwrite a subsequently observed session or its token cache", async () => {
  const h = harness();
  const held = deferred();
  const release = deferred();
  let hold = true;
  const update = h.store.update.bind(h.store);
  h.store.update = (change) => {
    let created = false;
    const result = update((state) => {
      const next = change(state);
      created = !state.session?.uid && !!next.session?.uid;
      return next;
    });
    return result.then(async (state) => {
      if (created && hold) {
        hold = false;
        held.resolve();
        await release.promise;
      }
      return state;
    });
  };
  const first = h.make();
  const creation = first.signInAnonymously();
  await held.promise;
  await h.store.update((state) => ({
    ...state,
    session: null,
    generation: crypto.randomUUID(),
    revision: state.revision + 1,
  }));
  const replacement = h.make();
  await replacement.signInAnonymously();
  let reconciled = false;
  const reconciliation = first.reconcile().then(() => {
    reconciled = true;
  });
  await flush();
  assert.equal(reconciled, false);
  release.resolve();
  await Promise.all([creation, reconciliation]);
  assert.equal(first.currentUser.uid, replacement.currentUser.uid);
  assert.notEqual(await first.currentUser.getIdToken(), "token-1");
  assert.deepEqual(h.refreshes, [replacement.currentUser.sessionId]);
});

test("a superseded local logout finalizer reloads a stopped tab without clearing the replacement", async () => {
  const h = harness();
  const auth = h.make();
  await auth.signInAnonymously();
  await auth.signOut();
  const replacement = h.make();
  await replacement.signInAnonymously();
  const session = h.store.read().session;
  let reloads = 0;
  let cleanups = 0;
  const finalize = logoutFunction("performLogoutCleanupAndReload", {
    sessionAuth: auth,
    clearClientPersistenceForLogout: async () => {
      cleanups++;
    },
    reloadAfterLogout: () => {
      reloads++;
    },
  });
  await finalize();
  assert.equal(reloads, 1);
  assert.equal(cleanups, 0);
  assert.deepEqual(h.store.read().session, session);
  const reloaded = h.make();
  await reloaded.authStateReady();
  assert.equal(reloaded.currentUser.uid, replacement.currentUser.uid);
});

for (const name of ["performLogoutCleanupAndReload", "handleLogoutSignal"]) {
  for (const supersededAt of ["relevance", "signOut"]) {
    test(`${name} reloads without cleanup when ${supersededAt} discovers a newer session`, async () => {
      const h = harness();
      const auth = h.make();
      await auth.signInAnonymously();
      const generation = auth.generation;
      const other = h.make();
      await other.authStateReady();
      const replacement = h.make();
      const isRelevant = auth.isLogoutRelevant.bind(auth);
      auth.isLogoutRelevant = async (target) => {
        const relevant = await isRelevant(target);
        await other.signOut(target);
        await replacement.signInAnonymously();
        if (supersededAt === "relevance") {
          await auth.reconcile();
          return isRelevant(target);
        }
        return relevant;
      };
      let reloads = 0;
      let cleanups = 0;
      const run = logoutFunction(name, {
        sessionAuth: auth,
        reloadAfterLogout: () => reloads++,
        clearClientPersistenceForLogout: async () => cleanups++,
      });
      await run(
        name === "handleLogoutSignal"
          ? { id: "old-logout", generation }
          : undefined,
      );
      await flush();
      assert.equal(reloads, 1);
      assert.equal(cleanups, 0);
      assert.equal(auth.canReloadAfterLogout, false);
      assert.equal(auth.currentUser.uid, replacement.currentUser.uid);
      assert.equal(
        h.store.read().session.sessionId,
        replacement.currentUser.sessionId,
      );
      assert.equal(h.revoked.has(replacement.currentUser.sessionId), false);
    });
  }

  test(
    `${name} reloads after logout when a new session appears before cleanup`,
    { timeout: 1000 },
    async () => {
      const h = harness();
      const auth = h.make();
      await auth.signInAnonymously();
      const generation = auth.generation;
      const replacement = h.make();
      const reloaded = deferred();
      let cleaned = false;
      const run = logoutFunction(name, {
        sessionAuth: auth,
        createSignalId: () => "logout-id",
        armPendingLogoutWipe: () => {},
        broadcastLogoutSignal: () => {},
        clearClientPersistenceForLogout: async (_mode, target) => {
          await replacement.signInAnonymously();
          return auth.runLogoutCleanup(target, () => {
            cleaned = true;
          });
        },
        reloadAfterLogout: () => reloaded.resolve(),
      });
      await run(
        name === "handleLogoutSignal"
          ? { id: "logout-id", generation }
          : undefined,
      );
      await reloaded.promise;
      assert.equal(cleaned, false);
      assert.equal(h.store.read().session.uid, replacement.currentUser.uid);
    },
  );
}

test("a delayed logout or cleanup for an older generation preserves a new sign-in", async () => {
  const h = harness();
  const first = h.make();
  await first.signInAnonymously();
  const generation = first.generation;
  await first.signOut();
  const second = h.make();
  await second.signInAnonymously();
  const nextSession = h.store.read().session;
  assert.equal(await first.isLogoutRelevant(generation), false);
  await first.signOut(generation);
  let cleaned = false;
  assert.equal(
    await first.runLogoutCleanup(generation, () => {
      cleaned = true;
    }),
    false,
  );
  assert.equal(cleaned, false);
  assert.deepEqual(h.store.read().session, nextSession);
});

for (const name of ["performLogoutCleanupAndReload", "handleLogoutSignal"]) {
  for (const failureAt of ["open", "commit"]) {
    test(`${name} preserves failed logout intent across reload after a storage ${failureAt} failure`, async () => {
      const h = harness();
      const auth = h.make();
      await auth.signInAnonymously();
      await auth.flushRevocations();
      const user = auth.currentUser;
      const update = h.store.update.bind(h.store);
      h.store.update = (change) => {
        if (failureAt === "commit") change(h.store.read());
        return Promise.reject(new SessionStorageError());
      };
      await assert.rejects(auth.signOut(), SessionStorageError);
      let reloads = 0;
      const run = logoutFunction(name, {
        sessionAuth: auth,
        reloadAfterLogout: () => reloads++,
      });
      if (name === "handleLogoutSignal") {
        run({ id: "failed-logout", generation: user.generation });
        await flush();
      } else {
        await assert.rejects(run(), SessionStorageError);
      }
      assert.equal(reloads, 1);
      assert.equal(h.store.read().session.sessionId, user.sessionId);
      assert.equal(h.logoutIntents.has(user.generation), true);
      h.store.update = update;
      const reloaded = h.make();
      const observed = [];
      reloaded.onAuthStateChanged((value) => observed.push(value));
      await reloaded.authStateReady();
      assert.deepEqual(observed, [null]);
      assert.equal(reloaded.restoredSessionId, null);
      assert.equal(h.store.read().session, null);
      assert.equal(h.logoutIntents.has(user.generation), false);
      await reloaded.flushRevocations();
      assert.equal(h.revoked.has(user.sessionId), true);
      await reloaded.signInAnonymously();
      assert.notEqual(reloaded.currentUser.uid, user.uid);
    });
  }

  test(`${name} does not reload when both logout persistence mechanisms fail`, async () => {
    const h = harness();
    h.logoutIntents.add = () => false;
    const auth = h.make();
    await auth.signInAnonymously();
    await auth.flushRevocations();
    const generation = auth.generation;
    h.store.update = () => Promise.reject(new SessionStorageError());
    await assert.rejects(auth.signOut(), SessionStorageError);
    let reloads = 0;
    const run = logoutFunction(name, {
      sessionAuth: auth,
      reloadAfterLogout: () => reloads++,
    });
    if (name === "handleLogoutSignal") {
      run({ id: "failed-logout", generation });
      await flush();
    } else {
      await assert.rejects(run(), SessionStorageError);
    }
    assert.equal(reloads, 0);
    assert.equal(isLogoutRecoveryRequired(), true);
  });

  for (const failureAt of ["read", "signOut"]) {
    test(`${name} reloads a stopped tab when the ${failureAt} storage operation fails`, async () => {
      const h = harness();
      const auth = h.make();
      await auth.signInAnonymously();
      const generation = auth.generation;
      await auth.signOut();
      await auth.flushRevocations();
      const update = h.store.update.bind(h.store);
      let operations = 0;
      h.store.update = (change) => {
        if (++operations === (failureAt === "read" ? 1 : 2))
          return Promise.reject(new SessionStorageError());
        return update(change);
      };
      let reloads = 0;
      let cleanups = 0;
      const run = logoutFunction(name, {
        sessionAuth: auth,
        clearClientPersistenceForLogout: async () => cleanups++,
        reloadAfterLogout: () => reloads++,
      });
      if (name === "handleLogoutSignal") {
        run({ id: "logout-failed-storage", generation });
        await flush();
      } else {
        await assert.rejects(run(), /Session storage is unavailable/);
      }
      assert.equal(reloads, 1);
      assert.equal(cleanups, 0);
      const reloaded = h.make();
      await reloaded.signInAnonymously();
      assert.ok(reloaded.currentUser);
    });
  }

  test(`${name} does not reload a healthy newer session when a stale signal read fails`, async () => {
    const h = harness();
    const auth = h.make();
    await auth.signInAnonymously();
    const user = auth.currentUser;
    h.store.update = () => Promise.reject(new SessionStorageError());
    let reloads = 0;
    const run = logoutFunction(name, {
      sessionAuth: auth,
      reloadAfterLogout: () => reloads++,
    });
    if (name === "handleLogoutSignal") {
      run({ id: "old-logout", generation: crypto.randomUUID() });
      await flush();
    } else {
      await assert.rejects(run(), /Session storage is unavailable/);
    }
    assert.equal(reloads, 0);
    assert.equal(auth.currentUser, user);
  });
}

test("same-UID replacement invalidates the old user object and bound provider", async () => {
  const h = harness();
  const auth = h.make();
  await auth.signInAnonymously();
  const firstUser = auth.currentUser;
  const bound = createUserBoundAuthTokenProvider(
    firstUser,
    () => auth.currentUser,
  );
  await h.store.update((state) => ({
    ...state,
    generation: crypto.randomUUID(),
    revision: state.revision + 1,
  }));
  await auth.reconcile();
  assert.equal(auth.currentUser.uid, firstUser.uid);
  assert.notEqual(auth.currentUser, firstUser);
  await assert.rejects(bound(false), /authentication-changed/);
});

test("a stale logout intent cannot overwrite a newer generation's pending logout", async () => {
  const h = harness();
  const first = h.make();
  await first.signInAnonymously();
  const oldGeneration = first.generation;
  await first.signOut();
  const second = h.make();
  await second.signInAnonymously();
  const user = second.currentUser;
  await second.flushRevocations();
  const update = h.store.update.bind(h.store);
  h.store.update = () => Promise.reject(new SessionStorageError());
  await assert.rejects(second.signOut(), SessionStorageError);
  h.logoutIntents.add(oldGeneration);
  assert.equal(h.logoutIntents.has(user.generation), true);
  h.store.update = update;
  const reloaded = h.make();
  await reloaded.authStateReady();
  assert.equal(reloaded.currentUser, null);
  await reloaded.flushRevocations();
  assert.equal(h.revoked.has(user.sessionId), true);
});

test("deferred logout retries failed identity cleanup before publishing a replacement", async () => {
  const h = harness();
  const original = h.make();
  await original.signInAnonymously();
  const user = original.currentUser;
  h.logoutIntents.add(user.generation);
  let cleanupFails = true;
  let profileId = "old-profile";
  const reloaded = h.make({
    clearLogoutIdentity: () => {
      if (cleanupFails) throw new Error("identity-cleanup-unavailable");
      profileId = "";
    },
  });
  await assert.rejects(
    reloaded.authStateReady(),
    /identity-cleanup-unavailable/,
  );
  assert.equal(reloaded.currentUser, null);
  assert.equal(h.store.read().session.sessionId, user.sessionId);
  assert.equal(h.logoutIntents.has(user.generation), true);
  cleanupFails = false;
  await reloaded.authStateReady();
  assert.equal(profileId, "");
  assert.equal(reloaded.currentUser, null);
  assert.equal(h.logoutIntents.has(user.generation), false);
  await reloaded.signInAnonymously();
  assert.notEqual(reloaded.currentUser.uid, user.uid);
});

test("a stale logout intent does not clear a replacement profile", async () => {
  const h = harness();
  const original = h.make();
  await original.signInAnonymously();
  const generation = original.generation;
  await original.signOut();
  const replacement = h.make();
  await replacement.signInAnonymously();
  h.logoutIntents.add(generation);
  let profileId = "replacement-profile";
  const reloaded = h.make({
    clearLogoutIdentity: () => {
      profileId = "";
    },
  });
  await reloaded.authStateReady();
  assert.equal(reloaded.currentUser.uid, replacement.currentUser.uid);
  assert.equal(profileId, "replacement-profile");
});

test("logout can retire IndexedDB credentials when localStorage is unavailable", async () => {
  const h = harness();
  const auth = h.make();
  await auth.signInAnonymously();
  await auth.flushRevocations();
  const sessionId = auth.currentUser.sessionId;
  const has = h.logoutIntents.has;
  h.logoutIntents.add = () => false;
  h.logoutIntents.has = () => {
    throw new Error("localStorage unavailable");
  };
  assert.equal(await auth.signOut(), true);
  assert.equal(auth.canReloadAfterLogout, true);
  assert.equal(h.store.read().session, null);
  assert.equal(h.store.read().revocations[0].sessionId, sessionId);
  h.logoutIntents.has = has;
  const reloaded = h.make();
  await reloaded.authStateReady();
  await reloaded.flushRevocations();
  assert.equal(h.revoked.has(sessionId), true);
});

test("a live tab that adopted a new generation ignores an old logout without detaching", async () => {
  const h = harness();
  const first = h.make();
  await first.signInAnonymously();
  const generation = first.generation;
  const live = h.make();
  await live.authStateReady();
  await first.signOut();
  const replacement = h.make();
  await replacement.signInAnonymously();
  await live.reconcile();
  const user = live.currentUser;
  const observed = [];
  live.onAuthStateChanged((value) => observed.push(value));
  await flush();
  assert.equal(await live.signOut(generation), false);
  assert.equal(live.currentUser, user);
  assert.deepEqual(observed, [user]);
  assert.match(await user.getIdToken(), /^token-/);
});

test("a late logout that finds a new durable generation restores the current user", async () => {
  const h = harness();
  const first = h.make();
  await first.signInAnonymously();
  const generation = first.generation;
  const live = h.make();
  await live.authStateReady();
  await first.signOut();
  const replacement = h.make();
  await replacement.signInAnonymously();
  assert.equal(await live.signOut(generation), false);
  assert.equal(live.currentUser.uid, replacement.currentUser.uid);
  assert.match(await live.currentUser.getIdToken(), /^token-/);
});

test("a replacement session refresh does not join an older user's pending refresh", async () => {
  const h = harness();
  const auth = h.make();
  await auth.signInAnonymously();
  const oldUser = auth.currentUser;
  const wait = deferred();
  const refresh = h.api.refresh;
  let first = true;
  h.api.refresh = (session) => {
    if (first) {
      first = false;
      return wait.promise;
    }
    return refresh(session);
  };
  const oldToken = oldUser.getIdToken(true);
  await flush();
  await h.store.update((state) => ({
    ...state,
    generation: crypto.randomUUID(),
    revision: state.revision + 1,
  }));
  await auth.reconcile();
  const newUser = auth.currentUser;
  assert.match(await newUser.getIdToken(true), /^token-/);
  wait.resolve(h.token(h.sessions.get(oldUser.sessionId)));
  await assert.rejects(oldToken, /authentication-changed/);
  assert.equal(auth.currentUser, newUser);
});

test("confirmed revocation clears the session without anonymous creation", async () => {
  const h = harness();
  const auth = h.make();
  await auth.signInAnonymously();
  const user = auth.currentUser;
  h.revoked.add(user.sessionId);
  await assert.rejects(user.getIdToken(true), /revoked/);
  assert.equal(auth.currentUser, null);
  assert.equal(h.store.read().session, null);
  assert.equal(h.creates.length, 1);
});

test("revoked pending creation is retired and the next explicit attempt uses a new identity", async () => {
  const h = harness();
  const create = h.api.create;
  let blockedId;
  h.api.create = async (session) => {
    if (!blockedId) {
      blockedId = session.sessionId;
      h.revoked.add(blockedId);
    }
    return create(session);
  };
  const auth = h.make();
  await assert.rejects(auth.signInAnonymously(), /revoked/);
  assert.equal(auth.currentUser, null);
  assert.equal(h.store.read().session, null);
  assert.equal(h.creates.length, 1);
  await auth.signInAnonymously();
  assert.notEqual(auth.currentUser.sessionId, blockedId);
  assert.equal(h.creates.length, 2);
});

test("listeners receive a resolved initial state, unsubscribe, and ignore ordinary refresh", async () => {
  const h = harness();
  const auth = h.make();
  const observed = [];
  const unsubscribe = auth.onAuthStateChanged((user) => observed.push(user));
  await auth.signInAnonymously();
  assert.deepEqual(
    observed.map((user) => user?.uid ?? null),
    [null, auth.currentUser.uid],
  );
  await auth.currentUser.getIdToken(true);
  assert.equal(observed.length, 2);
  unsubscribe();
  await auth.signOut();
  assert.equal(observed.length, 2);
});

test("legacy retirement clears identity and old pending actions, preserves preferences, and queues one notice", () => {
  const originalLocal = globalThis.localStorage;
  const originalSession = globalThis.sessionStorage;
  const browserStorage = (initial) => {
    const values = new Map(Object.entries(initial));
    return {
      get length() {
        return values.size;
      },
      key: (index) => [...values.keys()][index] ?? null,
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, String(value)),
      removeItem: (key) => values.delete(key),
    };
  };
  globalThis.localStorage = browserStorage({
    loginId: '"legacy"',
    profileId: '"profile"',
    username: '"Old name"',
    isMuted: "true",
    boardStyleSet: '"wood"',
    preferredAssetsSet: '"original"',
    "pendingAutomatchOperation:legacy": "pending",
    "firebase:authUser:old": "credential",
    appleIntentByStateV1: "intent",
  });
  globalThis.sessionStorage = browserStorage({
    "mons:pending-moves:v1:old": "move",
    appleIntentByStateV1: "intent",
  });
  try {
    retireLegacySessionIdentity();
    for (const key of [
      "loginId",
      "profileId",
      "username",
      "pendingAutomatchOperation:legacy",
      "firebase:authUser:old",
      "appleIntentByStateV1",
    ])
      assert.equal(localStorage.getItem(key), null);
    assert.equal(sessionStorage.length, 0);
    assert.equal(localStorage.getItem("isMuted"), "true");
    assert.equal(localStorage.getItem("boardStyleSet"), '"wood"');
    assert.equal(localStorage.getItem("preferredAssetsSet"), '"original"');
    assert.equal(hasPendingSessionResetNotice(), true);
    assert.equal(hasPendingSessionResetNotice(), true);
    assert.equal(consumeSessionResetNotice(), true);
    assert.equal(hasPendingSessionResetNotice(), false);
    assert.equal(consumeSessionResetNotice(), false);
  } finally {
    if (originalLocal === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = originalLocal;
    if (originalSession === undefined) delete globalThis.sessionStorage;
    else globalThis.sessionStorage = originalSession;
  }
});

test("legacy initialization runs once across simultaneous new clients", async () => {
  const h = harness();
  let cleanups = 0;
  const initializeIdentity = () => {
    cleanups++;
  };
  await Promise.all([
    h.make({ initializeIdentity }).signInAnonymously(),
    h.make({ initializeIdentity }).signInAnonymously(),
  ]);
  assert.equal(cleanups, 1);
});
