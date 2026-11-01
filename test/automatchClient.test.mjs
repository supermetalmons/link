import assert from "node:assert/strict";
import test from "node:test";
import {
  automatchBootstrap,
  automatchOperationId,
} from "./automatchBootstrapFixture.mjs";
import { required } from "./fixtures/canonicalData.mjs";
import { registerTypeScriptTestHooks } from "./support/typescriptHooks.mjs";

registerTypeScriptTestHooks();

const { AutomatchClient } =
  await import("../src/connection/automatchClient.ts");
const { withAutomatchOperationLock } =
  await import("../src/connection/automatchOperationLock.ts");
const { createUserBoundAuthTokenProvider } =
  await import("../src/services/authApi.ts");

/** @typedef {import("../src/connection/automatchClient.ts").AutomatchClientDependencies} Dependencies */
/** @typedef {import("../src/connection/automatchClient.ts").AutomatchClientApi} Api */
/** @typedef {import("../src/utils/storage.ts").PendingAutomatchOperation} PendingOperation */
/** @typedef {import("../src/session/sessionAuth.ts").SessionUser} SessionUser */
/** @typedef {Awaited<ReturnType<Api["startAutomatchViaApi"]>>} StartResponse */

const UID = "login-uid";
const INVITE_ID = "auto_result";
const RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const settle = () => new Promise(setImmediate);
/** @returns {SessionUser} */
const user = () => ({
  uid: UID,
  sessionId: "session",
  generation: "generation",
  getIdToken: async () => "token",
});
/** @returns {StartResponse} */
const pendingResponse = () => ({
  ok: true,
  inviteId: INVITE_ID,
  mode: "pending",
  matchedImmediately: false,
});
/** @param {Partial<PendingOperation>} [overrides] @returns {PendingOperation} */
const operation = (overrides = {}) => ({
  createdAtMs: RETENTION_MS * 2,
  operationId: automatchOperationId,
  request: { emojiId: 7, aura: "rainbow" },
  resolvedInviteId: null,
  uid: UID,
  ...overrides,
});

/** @param {{api?: Partial<Api>; authenticate?: () => Promise<void>}} [options] */
function harness({ api: handlers = {}, authenticate } = {}) {
  /** @type {{user: SessionUser | null; now: number; presentation: import("@mons/shared/navigation").StartAutomatchRequest; uuidCalls: number; notifications: number}} */
  const state = {
    user: user(),
    now: RETENTION_MS * 2,
    presentation: { emojiId: 7, aura: "rainbow" },
    uuidCalls: 0,
    notifications: 0,
  };
  /** @type {Map<string, PendingOperation>} */
  const operations = new Map();
  /** @type {Array<[string, PendingOperation | null]>} */
  const writes = [];
  /** @type {string[]} */
  const events = [];
  /** @type {Array<Parameters<Api["startAutomatchViaApi"]>>} */
  const starts = [];
  /** @type {Array<Parameters<Api["cancelAutomatchViaApi"]>>} */
  const cancels = [];
  /** @type {Array<Parameters<Dependencies["seedGameBootstrap"]>[0]>} */
  const seeds = [];
  /** @type {Map<string, Promise<void>>} */
  const tails = new Map();
  /** @type {string[]} */
  const lockNames = [];
  /** @type {import("../src/connection/automatchOperationLock.ts").AutomatchOperationLockManager} */
  const lockManager = {
    request(name, work) {
      lockNames.push(name);
      const result = (tails.get(name) ?? Promise.resolve()).then(() =>
        work(null),
      );
      tails.set(
        name,
        result.then(
          () => {},
          () => {},
        ),
      );
      return result;
    },
  };
  /** @type {Dependencies} */
  const dependencies = {
    ensureAuthenticated: async () => {
      events.push("authenticate");
      await authenticate?.();
    },
    getCurrentUser: () => state.user,
    getUserBoundAuthTokenProvider: (uid) => {
      events.push("provider");
      if (!state.user || state.user.uid !== uid)
        throw new Error("Failed to authenticate user");
      const provider = createUserBoundAuthTokenProvider(
        state.user,
        () => state.user,
      );
      return Object.assign(provider, {
        assertCurrentUser: (() => {
          const assertCurrentUser = provider.assertCurrentUser;
          return () => {
            events.push("assert-user");
            assertCurrentUser();
          };
        })(),
      });
    },
    storage: {
      getPendingAutomatchOperation: (uid) => {
        const stored = operations.get(uid);
        return stored ? structuredClone(stored) : null;
      },
      setPendingAutomatchOperation: (uid, value) => {
        const stored = value ? structuredClone(value) : null;
        writes.push([uid, stored]);
        events.push(
          stored ? (stored.resolvedInviteId ? "resolved" : "persist") : "clear",
        );
        if (stored) operations.set(uid, stored);
        else operations.delete(uid);
      },
    },
    getPlayerPresentation: () => ({ ...state.presentation }),
    withOperationLock: (uid, work) =>
      withAutomatchOperationLock(
        uid,
        async () => {
          events.push("lock");
          return work();
        },
        { isBrowser: true, lockManager },
      ),
    api: {
      startAutomatchViaApi: (...args) => {
        starts.push(args);
        events.push("start-api");
        return handlers.startAutomatchViaApi
          ? handlers.startAutomatchViaApi(...args)
          : Promise.resolve(pendingResponse());
      },
      cancelAutomatchViaApi: (...args) => {
        cancels.push(args);
        events.push("cancel-api");
        return handlers.cancelAutomatchViaApi
          ? handlers.cancelAutomatchViaApi(...args)
          : Promise.resolve({ ok: true });
      },
    },
    seedGameBootstrap: (seed) => {
      events.push("seed");
      seeds.push(seed);
    },
    notifyNavigationGamesChanged: () => {
      events.push("notify");
      state.notifications++;
    },
    now: () => state.now,
    createOperationId: () => {
      state.uuidCalls++;
      return `00000000-0000-4000-8000-${String(state.uuidCalls).padStart(12, "0")}`;
    },
  };
  const client = new AutomatchClient(dependencies);
  return {
    client,
    dependencies,
    state,
    operations,
    writes,
    events,
    starts,
    cancels,
    seeds,
    lockNames,
  };
}

test.beforeEach((t) => {
  assert.ok("mock" in t);
  t.mock.method(console, "error", () => {});
});

test("start authenticates and persists before its API call, then seeds before notifying and strips bootstrap", async () => {
  /** @type {PromiseWithResolvers<void>} */
  const authenticated = Promise.withResolvers();
  const bootstrap = automatchBootstrap({ inviteId: INVITE_ID, hostId: UID });
  /** @type {StartResponse} */
  const response = {
    ok: true,
    inviteId: INVITE_ID,
    mode: "matched",
    matchedImmediately: true,
    bootstrap,
  };
  const h = harness({
    authenticate: () => authenticated.promise,
    api: {
      startAutomatchViaApi: async (request, provider, operationId) => {
        assert.deepEqual(h.operations.get(UID), operation());
        assert.deepEqual(request, operation().request);
        assert.equal(operationId, automatchOperationId);
        assert.equal(await provider(false), "token");
        return response;
      },
    },
  });
  const capturedUser = h.state.user;
  const result = h.client.automatch();
  assert.deepEqual(h.events, ["authenticate"]);
  authenticated.resolve();
  assert.deepEqual(await result, {
    ok: true,
    inviteId: INVITE_ID,
    mode: "matched",
    matchedImmediately: true,
  });
  assert.deepEqual(h.events, [
    "authenticate",
    "lock",
    "provider",
    "clear",
    "persist",
    "start-api",
    "assert-user",
    "resolved",
    "seed",
    "notify",
  ]);
  assert.deepEqual(
    h.operations.get(UID),
    operation({ resolvedInviteId: INVITE_ID }),
  );
  assert.deepEqual(h.seeds, [
    {
      inviteId: INVITE_ID,
      operationId: automatchOperationId,
      user: capturedUser,
      bootstrap,
    },
  ]);
  assert.strictEqual(required(h.seeds[0]).user, capturedUser);
  assert.strictEqual(required(h.seeds[0]).bootstrap, bootstrap);
  assert.deepEqual(h.lockNames, [`mons-automatch:${UID}`]);
});

test("waiting and matched-without-bootstrap responses retain their operation and only notify", async () => {
  /** @type {StartResponse[]} */
  const responses = [
    pendingResponse(),
    {
      ok: true,
      inviteId: INVITE_ID,
      mode: "matched",
      matchedImmediately: true,
    },
  ];
  for (const response of responses) {
    const h = harness({ api: { startAutomatchViaApi: async () => response } });
    assert.deepEqual(await h.client.automatch(), response);
    assert.equal(required(h.operations.get(UID)).resolvedInviteId, INVITE_ID);
    assert.deepEqual(h.seeds, []);
    assert.equal(h.state.notifications, 1);
  }
});

test("queued starts reuse the persisted operation and captured presentation through resolution", async () => {
  /** @type {PromiseWithResolvers<StartResponse>} */
  const response = Promise.withResolvers();
  const h = harness({
    api: {
      startAutomatchViaApi: () =>
        h.starts.length === 1
          ? response.promise
          : Promise.resolve(pendingResponse()),
    },
  });
  const starts = Array.from({ length: 8 }, () => h.client.automatch());
  await settle();
  assert.equal(h.starts.length, 1);
  h.state.presentation = { emojiId: 99, aura: "none" };
  response.resolve(pendingResponse());
  await Promise.all(starts);
  assert.equal(h.state.uuidCalls, 1);
  assert.equal(h.starts.length, 8);
  assert.deepEqual(
    h.starts.map(([request, , operationId]) => [request, operationId]),
    Array.from({ length: 8 }, () => [
      operation().request,
      automatchOperationId,
    ]),
  );
  assert.deepEqual(
    h.lockNames,
    Array.from({ length: 8 }, () => `mons-automatch:${UID}`),
  );
  h.state.user = user();
  const restored = new AutomatchClient(h.dependencies);
  await restored.automatch();
  assert.equal(h.state.uuidCalls, 1);
  assert.equal(required(h.starts.at(-1))[2], automatchOperationId);
});

test("pending operation reads never create or expire records, and start preserves the inclusive retention boundary", async () => {
  for (const age of [0, RETENTION_MS, RETENTION_MS + 1, -1]) {
    const h = harness();
    const stored = operation({
      createdAtMs: h.state.now - age,
      operationId: "00000000-0000-4000-8000-000000000099",
    });
    h.operations.set(UID, stored);
    assert.equal(h.client.getPendingOperationId(UID), stored.operationId);
    assert.equal(h.client.getPendingOperationId("missing"), undefined);
    assert.deepEqual(h.writes, []);
    assert.deepEqual(h.events, []);
    await h.client.automatch();
    const retained = age >= 0 && age <= RETENTION_MS;
    assert.equal(
      required(h.starts[0])[2],
      retained ? stored.operationId : automatchOperationId,
    );
    assert.equal(h.state.uuidCalls, retained ? 0 : 1);
    assert.equal(
      required(h.operations.get(UID)).createdAtMs,
      retained ? stored.createdAtMs : h.state.now,
    );
  }
});

test("a rejected start clears only its captured operation while a thrown request remains retryable", async () => {
  for (const replace of [false, true]) {
    const h = harness({
      api: {
        startAutomatchViaApi: async () => {
          if (replace)
            h.operations.set(
              UID,
              operation({ operationId: "newer-operation" }),
            );
          return { ok: false };
        },
      },
    });
    assert.deepEqual(await h.client.automatch(), { ok: false });
    assert.equal(
      h.operations.get(UID)?.operationId,
      replace ? "newer-operation" : undefined,
    );
    assert.equal(h.state.notifications, 1);
    assert.deepEqual(h.seeds, []);
  }
  const failure = new Error("network-lost");
  const h = harness({
    api: {
      startAutomatchViaApi: async () => {
        throw failure;
      },
    },
  });
  await assert.rejects(h.client.automatch(), failure);
  assert.deepEqual(h.operations.get(UID), operation());
  assert.equal(h.state.notifications, 0);
  assert.deepEqual(h.seeds, []);
  await assert.rejects(h.client.automatch(), failure);
  assert.equal(h.state.uuidCalls, 1);
});

test("start and cancel share a lock and cancel sees the completed start operation", async () => {
  /** @type {PromiseWithResolvers<StartResponse>} */
  const response = Promise.withResolvers();
  const h = harness({ api: { startAutomatchViaApi: () => response.promise } });
  const start = h.client.automatch();
  await settle();
  const cancel = h.client.cancelAutomatch();
  await settle();
  assert.equal(h.cancels.length, 0);
  assert.deepEqual(h.operations.get(UID), operation());
  response.resolve(pendingResponse());
  await Promise.all([start, cancel]);
  assert.equal(h.cancels.length, 1);
  assert.equal(h.operations.has(UID), false);
  assert.equal(h.state.notifications, 2);
  assert.ok(h.events.indexOf("resolved") < h.events.indexOf("cancel-api"));
  assert.deepEqual(h.lockNames, [
    `mons-automatch:${UID}`,
    `mons-automatch:${UID}`,
  ]);
});

test("cancel preserves failed, absent and replacement operations, clearing only a successful captured one", async () => {
  for (const outcome of [
    "success",
    "rejected",
    "thrown",
    "replaced",
    "absent",
  ]) {
    const failure = new Error("cancel-failed");
    const h = harness({
      api: {
        cancelAutomatchViaApi: async (provider) => {
          assert.equal(await provider(false), "token");
          if (outcome === "thrown") throw failure;
          if (outcome === "replaced" || outcome === "absent")
            h.operations.set(
              UID,
              operation({ operationId: "newer-operation" }),
            );
          return { ok: outcome !== "rejected" };
        },
      },
    });
    if (outcome !== "absent") h.operations.set(UID, operation());
    if (outcome === "thrown")
      await assert.rejects(h.client.cancelAutomatch(), failure);
    else
      assert.deepEqual(await h.client.cancelAutomatch(), {
        ok: outcome !== "rejected",
      });
    const expectedId =
      outcome === "success"
        ? undefined
        : outcome === "replaced" || outcome === "absent"
          ? "newer-operation"
          : automatchOperationId;
    assert.equal(h.operations.get(UID)?.operationId, expectedId);
    assert.equal(h.state.notifications, outcome === "thrown" ? 0 : 1);
    assert.equal(h.state.uuidCalls, 0);
    assert.deepEqual(h.starts, []);
  }
});

test("missing authentication, authentication failure and unavailable coordination never reach an API", async () => {
  for (const method of /** @type {const} */ ([
    "automatch",
    "cancelAutomatch",
  ])) {
    for (const failure of ["missing-user", "authentication", "coordination"]) {
      const expected = new Error(failure);
      const h = harness({
        authenticate: async () => {
          if (failure === "authentication") throw expected;
        },
      });
      h.operations.set(UID, operation());
      if (failure === "missing-user") h.state.user = null;
      if (failure === "coordination")
        h.dependencies.withOperationLock = (uid, work) =>
          withAutomatchOperationLock(uid, work, {
            isBrowser: true,
            lockManager: null,
          });
      await assert.rejects(
        h.client[method](),
        failure === "missing-user"
          ? /Failed to authenticate user/
          : failure === "coordination"
            ? /automatch-coordination-unavailable/
            : expected,
      );
      assert.deepEqual(h.starts, []);
      assert.deepEqual(h.cancels, []);
      assert.deepEqual(h.writes, []);
      assert.equal(h.state.notifications, 0);
    }
  }
});

test("an account change while waiting for the lock is checked before API or storage mutation", async () => {
  for (const method of /** @type {const} */ ([
    "automatch",
    "cancelAutomatch",
  ])) {
    /** @type {PromiseWithResolvers<void>} */
    const release = Promise.withResolvers();
    const h = harness();
    const blocked = h.dependencies.withOperationLock(
      UID,
      () => release.promise,
    );
    const request = h.client[method]();
    await settle();
    assert.equal(h.events.includes("provider"), false);
    h.state.user = { ...user(), uid: "different-user" };
    release.resolve();
    await blocked;
    await assert.rejects(request, /Failed to authenticate user/);
    assert.deepEqual(h.starts, []);
    assert.deepEqual(h.cancels, []);
    assert.deepEqual(h.writes, []);
  }
});

test("replacing the authenticated user while start or cancel is in flight rejects all result effects", async () => {
  for (const method of /** @type {const} */ ([
    "automatch",
    "cancelAutomatch",
  ])) {
    /** @type {PromiseWithResolvers<void>} */
    const release = Promise.withResolvers();
    const h = harness({
      api: {
        startAutomatchViaApi: async () => {
          await release.promise;
          return {
            ok: true,
            inviteId: INVITE_ID,
            mode: "matched",
            matchedImmediately: true,
            bootstrap: automatchBootstrap({ inviteId: INVITE_ID, hostId: UID }),
          };
        },
        cancelAutomatchViaApi: async () => {
          await release.promise;
          return { ok: true };
        },
      },
    });
    h.operations.set(UID, operation());
    const request = h.client[method]();
    await settle();
    h.state.user = user();
    release.resolve();
    await assert.rejects(request, /authentication-changed/);
    assert.deepEqual(h.operations.get(UID), operation());
    assert.deepEqual(h.writes, []);
    assert.deepEqual(h.seeds, []);
    assert.equal(h.state.notifications, 0);
  }
});

test("reconciliation clears by resolved invite or observed operation while preserving unrelated records", async () => {
  for (const match of ["invite", "operation", "neither", "absent"]) {
    const h = harness();
    if (match !== "absent")
      h.operations.set(
        UID,
        operation({ resolvedInviteId: match === "invite" ? INVITE_ID : null }),
      );
    assert.equal(
      h.client.reconcilePendingRequest(
        UID,
        INVITE_ID,
        match === "operation" ? automatchOperationId : null,
      ),
      undefined,
    );
    await settle();
    assert.equal(h.operations.has(UID), match === "neither");
    assert.equal(
      h.writes.length,
      match === "invite" || match === "operation" ? 1 : 0,
    );
    assert.deepEqual(h.lockNames, [`mons-automatch:${UID}`]);
    assert.deepEqual(h.starts, []);
    assert.deepEqual(h.cancels, []);
    assert.equal(h.state.notifications, 0);
  }
});

test("reconciliation queues behind start and reads the operation only after acquiring its lock", async () => {
  for (const replace of [false, true]) {
    /** @type {PromiseWithResolvers<StartResponse>} */
    const response = Promise.withResolvers();
    const h = harness({
      api: { startAutomatchViaApi: () => response.promise },
    });
    const start = h.client.automatch();
    await settle();
    const original = required(h.operations.get(UID));
    const replaceBeforeReconcile = h.dependencies.withOperationLock(
      UID,
      async () => {
        if (replace)
          h.operations.set(
            UID,
            operation({
              operationId: "newer-operation",
              resolvedInviteId: "auto_other",
            }),
          );
      },
    );
    assert.equal(
      h.client.reconcilePendingRequest(UID, INVITE_ID, original.operationId),
      undefined,
    );
    assert.deepEqual(h.operations.get(UID), original);
    response.resolve(pendingResponse());
    await Promise.all([start, replaceBeforeReconcile]);
    await settle();
    assert.equal(
      h.operations.get(UID)?.operationId,
      replace ? "newer-operation" : undefined,
    );
    assert.equal(h.state.notifications, 1);
  }
});

test("reconciliation reports coordination errors without throwing or changing persisted state", async (t) => {
  const error = new Error("coordination-unavailable");
  const log = t.mock.method(console, "error", () => {});
  const h = harness();
  h.operations.set(UID, operation());
  h.dependencies.withOperationLock = async () => {
    throw error;
  };
  assert.equal(
    h.client.reconcilePendingRequest(UID, INVITE_ID, automatchOperationId),
    undefined,
  );
  await settle();
  assert.deepEqual(h.operations.get(UID), operation());
  assert.deepEqual(h.writes, []);
  assert.deepEqual(
    log.mock.calls.map((call) => call.arguments),
    [["Failed to clear completed automatch operation", error]],
  );
});
