import assert from "node:assert/strict";
import test from "node:test";
import { Game } from "mons-rules";
import { AuthApiFailure } from "../src/authErrors.ts";
import {
  cancelAutomatch,
  handleGameplayRoute,
  removeNavigationGame,
} from "../src/gameplayRoute.ts";
import type { RequestIdentity } from "../src/requestIdentity.ts";
import type {
  GameplayProfile,
  GameplayRepository,
  RatingRepository,
} from "../src/gameplayRepository.ts";
import type {
  ProfileOwnershipQuery,
  ProfileOwnershipSnapshot,
} from "../src/profileOwnership.ts";
import { TELEGRAM_TEST_ENV, withProfileControl } from "./testEnv.ts";

const env = {
  ...TELEGRAM_TEST_ENV,
  AUTH_RATE_LIMITER: { limit: async () => ({ success: true }) },
  FIREBASE_IDENTITY_SERVICE_ACCOUNT_EMAIL:
    "identity@example.iam.gserviceaccount.com",
  FIREBASE_IDENTITY_SERVICE_ACCOUNT_PRIVATE_KEY: "test-private-key",
  HELIUS_RPC_API_KEY: "test-helius-key",
  NFT_RATE_LIMITER: { limit: async () => ({ success: true }) },
  X_CLIENT_ID: "test-x-client",
  X_CLIENT_SECRET: "test-x-secret",
} as Env;

const identity: RequestIdentity = {
  uid: "firebase-uid",
};

type OwnershipState = Readonly<{
  aliasesByProfileId?: Readonly<Record<string, readonly string[]>>;
  ownerByUid?: Readonly<Record<string, string | null>>;
  profilesById?: Readonly<Record<string, GameplayProfile>>;
}>;

function gameplayProfile(profileId: string): GameplayProfile {
  return {
    aura: "",
    emoji: 1,
    eth: "",
    profileId,
    rating: 0,
    sol: "",
    username: "",
  };
}

function ownershipSnapshot(
  query: ProfileOwnershipQuery,
  state: OwnershipState = {},
): ProfileOwnershipSnapshot {
  const ownerByUid = new Map(
    query.loginUids.map((uid) => {
      const profileId = state.ownerByUid?.[uid] ?? null;
      return [uid, profileId ? { profileId, revision: 1 } : null] as const;
    }),
  );
  const canonicalByProfileId = new Map(
    query.profileIds.map((profileId) => [profileId, profileId] as const),
  );
  const canonicalProfileIds = new Set([
    ...[...ownerByUid.values()].flatMap((owner) =>
      owner ? [owner.profileId] : [],
    ),
    ...canonicalByProfileId.values(),
  ]);
  return {
    canonicalProfileIdByProfileId: canonicalByProfileId,
    loginOwnerByUid: ownerByUid,
    loginUidsByProfileId: new Map(
      [...canonicalProfileIds].map((profileId) => [
        profileId,
        state.aliasesByProfileId?.[profileId] ||
          [...ownerByUid]
            .filter(([, owner]) => owner?.profileId === profileId)
            .map(([uid]) => uid),
      ]),
    ),
    profileById: new Map(
      [...canonicalProfileIds].map((profileId) => [
        profileId,
        {
          profile:
            state.profilesById?.[profileId] || gameplayProfile(profileId),
          revision: 1,
        },
      ]),
    ),
  };
}

function ownershipForLogins(
  query: ProfileOwnershipQuery,
  ownerForUid: (uid: string) => string | null,
  state: Omit<OwnershipState, "ownerByUid"> = {},
): ProfileOwnershipSnapshot {
  return ownershipSnapshot(query, {
    ...state,
    ownerByUid: Object.fromEntries(
      query.loginUids.map((uid) => [uid, ownerForUid(uid)]),
    ),
  });
}

function repository(
  overrides: Partial<GameplayRepository> = {},
): GameplayRepository {
  const transactionValues = new Map<string, unknown>();
  return {
    applyWagerTransferOnce: async () => "applied",
    deleteNavigationGame: async () => "deleted",
    readProfileOwnershipSnapshot: async (query) => ownershipSnapshot(query),
    getNavigationGame: async () => null,
    getMiningMaterials: async () => ({
      dust: 10,
      slime: 10,
      gum: 10,
      metal: 10,
      ice: 10,
    }),
    getMiningSnapshot: async () => null,
    getRtdbPath: async () => null,
    patchRtdbRoot: async () => undefined,
    transactRtdbPath: async (path, updater) => {
      const current = transactionValues.get(path) ?? null;
      const result = applyTransaction(updater, current);
      if (result.committed) {
        transactionValues.set(path, result.value);
      }
      return result;
    },
    ...overrides,
  };
}

function wagerRepository(
  overrides: Partial<GameplayRepository> = {},
): GameplayRepository {
  const value = repository(overrides);
  const transactRtdbPath = value.transactRtdbPath;
  const locks = new Map<string, unknown>();
  value.transactRtdbPath = async (path, updater, signal) => {
    if (path.startsWith("gameplayMutationLocks/")) {
      const result = applyTransaction(updater, locks.get(path) ?? null);
      if (result.committed) locks.set(path, result.value);
      return result;
    }
    return transactRtdbPath(path, updater, signal);
  };
  return value;
}

function applyTransaction(
  updater: (current: unknown) => unknown,
  current: unknown,
): { committed: boolean; decision?: string; value: unknown } {
  const decision = updater(current) as {
    commit?: boolean;
    decision?: string;
    value?: unknown;
  };
  return decision.commit === false
    ? { committed: false, decision: decision.decision, value: current }
    : { committed: true, decision: decision.decision, value: decision.value };
}

function context(
  promises: Promise<unknown>[] = [],
): Pick<ExecutionContext, "waitUntil"> {
  return {
    waitUntil(promise) {
      promises.push(promise);
    },
  };
}

function request(
  path: string,
  {
    body,
    method = "POST",
    origin = "https://mons.link",
  }: { body?: unknown; method?: string; origin?: string } = {},
): Request {
  return new Request(`https://api.mons.link${path}`, {
    method,
    headers: { Origin: origin, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

test("cancels the deterministic UID automatch with exact v2 multipath updates", async () => {
  const patches: Array<Record<string, unknown>> = [];
  const profileProjectionTasks: unknown[] = [];
  let guestReads = 0;
  let queueExists = true;
  const result = await cancelAutomatch(
    identity,
    repository({
      readProfileOwnershipSnapshot: async () => {
        throw new Error("D1 should not be read for a direct UID queue");
      },
      getRtdbPath: async (path, query) => {
        if (path === "automatch") {
          assert.deepEqual(query, {
            orderBy: "uid",
            equalTo: "firebase-uid",
            limitToFirst: 2,
          });
          return queueExists
            ? {
                "auto-newer": {
                  uid: identity.uid,
                  profileId: "profile-1",
                  timestamp: 2,
                  telegramDeliveryVersion: 2,
                },
              }
            : null;
        }
        if (path === "automatch/auto-newer") {
          return queueExists
            ? {
                uid: identity.uid,
                profileId: "profile-1",
                timestamp: 2,
                telegramDeliveryVersion: 2,
              }
            : null;
        }
        if (path === "invites/auto-newer/guestId") {
          guestReads++;
          return null;
        }
        if (path === "invites/auto-newer/hostId") return identity.uid;
        assert.fail(`unexpected RTDB path ${path}`);
      },
      patchRtdbRoot: async (updates) => {
        patches.push(updates);
        if (updates["automatch/auto-newer"] === null) queueExists = false;
      },
    }),
    {
      createProjectionRequestId: () => "request-canceled",
      enqueueProfileGameProjection: async (task) => {
        profileProjectionTasks.push(task);
      },
    },
  );
  assert.deepEqual(result, { ok: true });
  assert.equal(guestReads, 1);
  assert.deepEqual(profileProjectionTasks, [
    {
      kind: "automatch-profile-game-projection",
      inviteId: "auto-newer",
      requestId: "request-canceled",
    },
  ]);
  assert.deepEqual(patches, [
    {
      "automatch/auto-newer": null,
      "invites/auto-newer/automatchStateHint": "canceled",
      "invites/auto-newer/automatchCanceledAt": { ".sv": "timestamp" },
      "profileGameProjectionOutbox/automatch/auto-newer": {
        schemaVersion: 1,
        status: "pending",
        requestId: "request-canceled",
        reason: "automatch-queue",
        sourceUpdatedAtMs: { ".sv": "timestamp" },
        lastQueuedAtMs: { ".sv": "timestamp" },
      },
      "telegramAutomatches/auto-newer/lifecycle": "canceled",
      "telegramAutomatches/auto-newer/updatedAtMs": { ".sv": "timestamp" },
      "telegramAutomatches/auto-newer/generation": {
        ".sv": { increment: 1 },
      },
      "telegramProjectionOutbox/automatch/auto-newer": {
        schemaVersion: 1,
        status: "pending",
        requestId: "request-canceled",
        updatedAtMs: { ".sv": "timestamp" },
      },
    },
  ]);
});

test("cancels every queue owned by merged logins", async () => {
  const queues = new Map<string, Record<string, unknown>>([
    ["auto-direct", { uid: identity.uid, timestamp: 2 }],
    ["auto-alias", { uid: "alias-uid", timestamp: 1 }],
  ]);
  const result = await cancelAutomatch(
    identity,
    repository({
      readProfileOwnershipSnapshot: async (query) =>
        ownershipForLogins(
          query,
          (uid) =>
            uid === identity.uid || uid === "alias-uid" ? "profile-1" : null,
          { aliasesByProfileId: { "profile-1": [identity.uid, "alias-uid"] } },
        ),
      getRtdbPath: async (path, query) => {
        if (path === "automatch") {
          const matches = [...queues].filter(
            ([, value]) => value.uid === query?.equalTo,
          );
          return matches.length ? Object.fromEntries(matches) : null;
        }
        const queue = /^automatch\/(.+)$/.exec(path);
        if (queue) return queues.get(queue[1]) || null;
        const invite = /^invites\/(.+)\/(guestId|hostId)$/.exec(path);
        if (invite) {
          return invite[2] === "guestId"
            ? null
            : queues.get(invite[1])?.uid || null;
        }
        return null;
      },
      patchRtdbRoot: async (updates) => {
        for (const [path, value] of Object.entries(updates)) {
          const queue = /^automatch\/(.+)$/.exec(path);
          if (queue && value === null) queues.delete(queue[1]);
        }
      },
    }),
    { createProjectionRequestId: () => crypto.randomUUID() },
  );
  assert.deepEqual(result, { ok: true });
  assert.equal(queues.size, 0);
});

test("skips cancellation when a guest wins the invite lease race", async () => {
  const patches: Array<Record<string, unknown>> = [];
  const profileProjectionTasks: unknown[] = [];
  const result = await cancelAutomatch(
    identity,
    repository({
      readProfileOwnershipSnapshot: async (query) =>
        ownershipForLogins(
          query,
          (uid) =>
            uid === identity.uid || uid === "host-uid" ? "profile-1" : null,
          { aliasesByProfileId: { "profile-1": [identity.uid, "host-uid"] } },
        ),
      getRtdbPath: async (path, query) => {
        if (path === "automatch") {
          assert.ok(query);
          return query?.equalTo === "host-uid"
            ? {
                "auto-race": {
                  uid: "host-uid",
                  profileId: "profile-1",
                  timestamp: 1,
                  telegramDeliveryVersion: 2,
                },
              }
            : null;
        }
        if (path === "automatch/auto-race") {
          return {
            uid: "host-uid",
            profileId: "profile-1",
            timestamp: 1,
            telegramDeliveryVersion: 2,
          };
        }
        if (path === "invites/auto-race/guestId") return "guest-uid";
        if (path === "invites/auto-race/hostId") return "host-uid";
        assert.fail(`unexpected RTDB path ${path}`);
      },
      patchRtdbRoot: async (updates) => {
        patches.push(updates);
      },
    }),
    {
      createProjectionRequestId: () => "request-canceled",
      enqueueProfileGameProjection: async (task) => {
        profileProjectionTasks.push(task);
      },
    },
  );
  assert.deepEqual(result, { ok: false });
  assert.deepEqual(patches, []);
  assert.deepEqual(profileProjectionTasks, []);
});

test("shared cancellation rejects changed queue timestamps and versions", async (t) => {
  const discovered = {
    uid: identity.uid,
    timestamp: 1,
    telegramDeliveryVersion: 2,
  };
  for (const [name, current] of [
    ["timestamp", { ...discovered, timestamp: 2 }],
    ["version", { ...discovered, telegramDeliveryVersion: 1 }],
  ] as const) {
    await t.test(name, async () => {
      let patches = 0;
      const tasks: unknown[] = [];
      const result = await cancelAutomatch(
        identity,
        repository({
          getRtdbPath: async (path, query) => {
            if (path === "automatch") {
              assert.deepEqual(query, {
                orderBy: "uid",
                equalTo: identity.uid,
                limitToFirst: 2,
              });
              return { auto_changed: discovered };
            }
            if (path === "automatch/auto_changed") return current;
            if (path === "invites/auto_changed/guestId") return null;
            if (path === "invites/auto_changed/hostId") return identity.uid;
            assert.fail(`unexpected RTDB path ${path}`);
          },
          patchRtdbRoot: async () => {
            patches += 1;
          },
        }),
        {
          createProjectionRequestId: () => "changed-request",
          enqueueProfileGameProjection: async (task) => {
            tasks.push(task);
          },
          enqueueTelegramProjection: async (task) => {
            tasks.push(task);
          },
        },
      );
      assert.deepEqual(result, { ok: false });
      assert.equal(patches, 0);
      assert.deepEqual(tasks, []);
    });
  }
});

test("cancels an alternate-login legacy queue without a root scan", async () => {
  const queries: unknown[] = [];
  const patches: Array<Record<string, unknown>> = [];
  let ownershipChanged = false;
  let ownershipReads = 0;
  let queueExists = true;
  const result = await cancelAutomatch(
    identity,
    repository({
      readProfileOwnershipSnapshot: async (query) => {
        ownershipReads++;
        if (ownershipChanged) {
          throw new Error("ownership must not be revalidated");
        }
        return ownershipForLogins(
          query,
          (uid) =>
            uid === identity.uid || uid === "legacy-login" ? "profile-1" : null,
          {
            aliasesByProfileId: {
              "profile-1": [identity.uid, "legacy-login"],
            },
          },
        );
      },
      getRtdbPath: async (path, query) => {
        if (path === "automatch") {
          queries.push(query);
          return query?.equalTo === "legacy-login" && queueExists
            ? {
                "auto-alias": {
                  uid: "legacy-login",
                  profileId: "",
                  timestamp: 1,
                },
              }
            : null;
        }
        if (path === "automatch/auto-alias") {
          ownershipChanged = true;
          return {
            uid: "legacy-login",
            profileId: "",
            timestamp: 1,
          };
        }
        if (path === "invites/auto-alias/guestId") return null;
        if (path === "invites/auto-alias/hostId") return "legacy-login";
        assert.fail(`unexpected RTDB path ${path}`);
      },
      patchRtdbRoot: async (updates) => {
        patches.push(updates);
        if (updates["automatch/auto-alias"] === null) queueExists = false;
      },
    }),
    { createProjectionRequestId: () => "request-canceled" },
  );
  assert.deepEqual(result, { ok: true });
  assert.equal(queries.length, 3);
  assert.equal(ownershipReads, 1);
  assert.equal(patches.length, 1);
  assert.equal(patches[0]["automatch/auto-alias"], null);
});

test("returns false without writes for missing queues and existing guests", async () => {
  let patches = 0;
  const missing = await cancelAutomatch(
    identity,
    repository({
      getRtdbPath: async (path) =>
        path === "players/firebase-uid/profile" ? "profile" : null,
      patchRtdbRoot: async () => {
        patches++;
      },
    }),
  );
  assert.deepEqual(missing, { ok: false });

  const joined = await cancelAutomatch(
    identity,
    repository({
      getRtdbPath: async (path) => {
        if (path === "players/firebase-uid/profile") return "profile";
        if (path === "automatch") return { invite: {} };
        if (path === "automatch/invite") return {};
        if (path === "invites/invite/guestId") return "guest";
        return null;
      },
      patchRtdbRoot: async () => {
        patches++;
      },
    }),
  );
  assert.deepEqual(joined, { ok: false });
  assert.equal(patches, 0);
});

test("keeps legacy automatch cancellation free of Telegram v2 updates", async () => {
  const patches: Array<Record<string, unknown>> = [];
  const profileProjectionTasks: unknown[] = [];
  let queueExists = true;
  const result = await cancelAutomatch(
    identity,
    repository({
      getRtdbPath: async (path) => {
        if (path === "players/firebase-uid/profile") return "profile";
        if (path === "automatch") {
          return queueExists
            ? {
                "auto-legacy": {
                  uid: identity.uid,
                  profileId: "profile",
                  timestamp: 1,
                  telegramDeliveryVersion: 1,
                },
              }
            : null;
        }
        if (path === "automatch/auto-legacy") {
          return {
            uid: identity.uid,
            profileId: "profile",
            timestamp: 1,
            telegramDeliveryVersion: 1,
          };
        }
        if (path === "invites/auto-legacy/guestId") return null;
        if (path === "invites/auto-legacy/hostId") return identity.uid;
        return null;
      },
      patchRtdbRoot: async (updates) => {
        patches.push(updates);
        if (updates["automatch/auto-legacy"] === null) queueExists = false;
      },
    }),
    {
      createProjectionRequestId: () => "legacy-request",
      enqueueProfileGameProjection: async (task) => {
        profileProjectionTasks.push(task);
      },
    },
  );
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(patches, [
    {
      "automatch/auto-legacy": null,
      "invites/auto-legacy/automatchStateHint": "canceled",
      "invites/auto-legacy/automatchCanceledAt": { ".sv": "timestamp" },
      "profileGameProjectionOutbox/automatch/auto-legacy": {
        schemaVersion: 1,
        status: "pending",
        requestId: "legacy-request",
        reason: "automatch-queue",
        sourceUpdatedAtMs: { ".sv": "timestamp" },
        lastQueuedAtMs: { ".sv": "timestamp" },
      },
    },
  ]);
  assert.deepEqual(profileProjectionTasks, [
    {
      kind: "automatch-profile-game-projection",
      inviteId: "auto-legacy",
      requestId: "legacy-request",
    },
  ]);
});

test("preserves every navigation precondition outcome", async () => {
  const basePaths = async (path: string): Promise<unknown> => {
    if (path === "players/firebase-uid/profile") return "profile-1";
    if (path === "invites/invite-1") return {};
    if (path === "automatch/invite-1") return null;
    return null;
  };
  const cases: Array<{
    name: string;
    identity?: RequestIdentity;
    inviteId?: string;
    repo: Partial<GameplayRepository>;
    expected: unknown;
  }> = [
    {
      name: "profile unresolved",
      identity: { uid: "firebase-uid" },
      repo: {
        getRtdbPath: async () => null,
        readProfileOwnershipSnapshot: async (query) => ownershipSnapshot(query),
      },
      expected: {
        ok: true,
        skipped: true,
        reason: "profile-unresolved",
        inviteId: "invite-1",
      },
    },
    {
      name: "invite missing",
      repo: {
        getRtdbPath: async (path) =>
          path === "players/firebase-uid/profile" ? "profile-1" : null,
      },
      expected: {
        ok: true,
        skipped: true,
        reason: "invite-missing",
        inviteId: "invite-1",
      },
    },
    {
      name: "invite active",
      repo: {
        getRtdbPath: async (path) =>
          path === "players/firebase-uid/profile"
            ? "profile-1"
            : path === "invites/invite-1"
              ? { guestId: "guest" }
              : null,
      },
      expected: {
        ok: true,
        skipped: true,
        reason: "invite-active",
        inviteId: "invite-1",
      },
    },
    {
      name: "pending automatch",
      inviteId: "auto_invite1",
      repo: {
        getRtdbPath: async (path) =>
          path === "players/firebase-uid/profile"
            ? "profile-1"
            : path === "invites/auto_invite1"
              ? { automatchStateHint: "pending" }
              : path === "automatch/auto_invite1"
                ? { queued: true }
                : null,
      },
      expected: {
        ok: true,
        skipped: true,
        reason: "pending-automatch",
        inviteId: "auto_invite1",
      },
    },
    {
      name: "game missing",
      repo: { getRtdbPath: basePaths, getNavigationGame: async () => null },
      expected: {
        ok: true,
        skipped: true,
        deleted: false,
        reason: "not-found",
        inviteId: "invite-1",
      },
    },
    {
      name: "game active",
      repo: {
        getRtdbPath: basePaths,
        getNavigationGame: async () => ({
          status: "active",
        }),
      },
      expected: {
        ok: true,
        skipped: true,
        deleted: false,
        reason: "status-active",
        inviteId: "invite-1",
      },
    },
  ];
  for (const entry of cases) {
    assert.deepEqual(
      await removeNavigationGame(
        entry.identity || identity,
        entry.inviteId || "invite-1",
        repository({
          readProfileOwnershipSnapshot: async (query) =>
            ownershipForLogins(query, () => "profile-1"),
          ...entry.repo,
        }),
      ),
      entry.expected,
      entry.name,
    );
  }
});

test("fails closed before removing a D1 game when ownership is unavailable", async () => {
  await assert.rejects(
    () =>
      removeNavigationGame(
        identity,
        "invite-1",
        repository({
          getRtdbPath: async () => {
            throw new Error("rtdb-unavailable");
          },
          readProfileOwnershipSnapshot: async () => {
            throw new Error("profile-storage-unavailable");
          },
        }),
      ),
    /profile-ownership-unavailable/,
  );
});

test("routes authenticated CORS and rejects methods before authentication", async () => {
  const preflight = await handleGameplayRoute(
    request("/automatch/cancel", { method: "OPTIONS" }),
    env,
    context(),
  );
  assert.equal(preflight.status, 204);
  assert.equal(
    preflight.headers.get("Access-Control-Allow-Origin"),
    "https://mons.link",
  );

  let verifications = 0;
  const rejected = await handleGameplayRoute(
    request("/automatch/cancel", { method: "GET" }),
    env,
    context(),
    {
      verifyIdentity: async () => {
        verifications++;
        return identity;
      },
    },
  );
  assert.equal(rejected.status, 405);
  assert.equal(verifications, 0);

  const forbidden = await handleGameplayRoute(
    request("/automatch/cancel", {
      method: "OPTIONS",
      origin: "https://evil.test",
    }),
    env,
    context(),
  );
  assert.equal(forbidden.status, 403);

  const started = await handleGameplayRoute(
    request("/automatch/start", {
      body: { emojiId: 7, aura: "rainbow" },
    }),
    env,
    context(),
    {
      repository: repository({
        readProfileOwnershipSnapshot: async (query) => ownershipSnapshot(query),
        getRtdbPath: async (path, query) => {
          assert.equal(path, "automatch");
          assert.deepEqual(query, {
            orderBy: "uid",
            equalTo: identity.uid,
            limitToFirst: 2,
          });
          return { auto_existing: { uid: identity.uid } };
        },
      }),
      verifyIdentity: async () => identity,
    },
  );
  assert.equal(started.status, 200);
  assert.deepEqual(await started.json(), {
    ok: true,
    inviteId: "auto_existing",
    mode: "pending",
    matchedImmediately: false,
  });
});

test("freezes gameplay mutations while keeping gameplay reads available", async () => {
  let repositoryWrites = 0;
  const frozenEnv = withProfileControl(env, "frozen");
  const mutation = await handleGameplayRoute(
    request("/automatch/cancel", { body: {} }),
    frozenEnv,
    context(),
    {
      repository: repository({
        getRtdbPath: async () => {
          repositoryWrites++;
          return null;
        },
      }),
      verifyIdentity: async () => identity,
    },
  );
  assert.equal(mutation.status, 503);
  assert.equal(mutation.headers.get("Retry-After"), "60");
  assert.deepEqual(await mutation.json(), {
    ok: false,
    error: "unavailable",
    message: "profile-writes-disabled",
  });
  assert.equal(repositoryWrites, 0);

  const read = await handleGameplayRoute(
    request("/navigation/games/read", {
      body: { limit: 10, cursor: null },
    }),
    frozenEnv,
    context(),
    {
      repository: repository({
        getRtdbPath: async (path) =>
          path === `players/${identity.uid}/profile` ? "profile-1" : null,
      }),
      readNavigationPage: async () => ({
        ok: true,
        items: [],
        nextCursor: null,
        hasMore: false,
      }),
      verifyIdentity: async () => identity,
    },
  );
  assert.equal(read.status, 200);
});

test("committed gameplay does not wait for projection Queues", async () => {
  let releaseQueue: (() => void) | undefined;
  const blockedQueue = new Promise<void>((resolve) => {
    releaseQueue = resolve;
  });
  const background: Promise<unknown>[] = [];
  const profileProjectionTasks: unknown[] = [];
  const response = await handleGameplayRoute(
    request("/automatch/start", {
      body: { emojiId: 7, aura: "rainbow" },
    }),
    {
      ...env,
      TELEGRAM_PROJECTION_QUEUE: {
        ...env.TELEGRAM_PROJECTION_QUEUE,
        send: async () => {
          await blockedQueue;
          return {
            metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
          };
        },
      },
      PROFILE_GAME_PROJECTION_QUEUE: {
        ...env.PROFILE_GAME_PROJECTION_QUEUE,
        send: async (task) => {
          profileProjectionTasks.push(task);
          return {
            metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
          };
        },
      },
    },
    context(background),
    {
      automatch: {
        createProjectionRequestId: () => "request-1",
        random: () => 0,
      },
      repository: repository({
        readProfileOwnershipSnapshot: async (query) => ownershipSnapshot(query),
        getRtdbPath: async () => null,
      }),
      verifyIdentity: async () => identity,
    },
  );
  assert.equal(response.status, 200);
  assert.equal(background.length, 2);
  releaseQueue?.();
  await Promise.all(background);
  assert.deepEqual(profileProjectionTasks, [
    {
      kind: "automatch-profile-game-projection",
      inviteId: "auto_aaaaaaaaaaa",
      requestId: "request-1",
    },
  ]);
});

test("routes strict authenticated structural game-session mutations", async () => {
  const patches: Record<string, unknown>[] = [];
  const tasks: unknown[] = [];
  const response = await handleGameplayRoute(
    request("/invites/create", {
      body: {
        operationId: "00000000-0000-4000-8000-000000000001",
        inviteId: "abcdefghijk",
        emojiId: 7,
        aura: "rainbow",
      },
    }),
    env,
    context(),
    {
      gameSession: {
        createOwnerId: () => "owner-1",
        enqueueProfileGameProjection: async (task) => {
          tasks.push(task);
        },
        now: () => 1_000,
        random: () => 0,
      },
      repository: repository({
        patchRtdbRoot: async (updates) => {
          patches.push(updates);
        },
      }),
      verifyIdentity: async () => identity,
    },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    inviteId: "abcdefghijk",
    hostId: identity.uid,
    matchId: "abcdefghijk",
  });
  assert.equal(patches.length, 1);
  assert.deepEqual(tasks, [
    {
      kind: "automatch-profile-game-projection",
      inviteId: "abcdefghijk",
      requestId: "00000000-0000-4000-8000-000000000001",
    },
  ]);

  const malformed = await handleGameplayRoute(
    request("/rematches/end", {
      body: { inviteId: "abcdefghijk" },
    }),
    env,
    context(),
    { verifyIdentity: async () => identity },
  );
  assert.equal(malformed.status, 400);
});

test("routes authoritative invite role reads without mutation rate limiting", async () => {
  let rateLimitCalls = 0;
  const roleEnv = {
    ...env,
    AUTH_RATE_LIMITER: {
      limit: async () => {
        rateLimitCalls += 1;
        return { success: true };
      },
    },
  } as Env;
  const response = await handleGameplayRoute(
    request("/invites/role/read", { body: { inviteId: "abcdefghijk" } }),
    roleEnv,
    context(),
    {
      repository: repository({
        readProfileOwnershipSnapshot: async (query) =>
          ownershipForLogins(query, (uid) =>
            uid === identity.uid || uid === "guest-login"
              ? "profile-1"
              : uid === "host-login"
                ? "profile-host"
                : null,
          ),
        getRtdbPath: async (path) => {
          if (path === "invites/abcdefghijk") {
            return { hostId: "host-login", guestId: "guest-login" };
          }
          return null;
        },
      }),
      verifyIdentity: async () => identity,
    },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    inviteId: "abcdefghijk",
    hostId: "host-login",
    guestId: "guest-login",
    actorUid: "guest-login",
    role: "guest",
  });
  assert.equal(rateLimitCalls, 0);

  const invalid = await handleGameplayRoute(
    request("/invites/role/read", {
      body: { inviteId: "abcdefghijk", extra: true },
    }),
    env,
    context(),
    { verifyIdentity: async () => identity },
  );
  assert.equal(invalid.status, 400);

  const missing = await handleGameplayRoute(
    request("/invites/role/read", { body: { inviteId: "abcdefghijk" } }),
    env,
    context(),
    {
      repository: repository(),
      verifyIdentity: async () => identity,
    },
  );
  assert.equal(missing.status, 404);

  const protectedInvite = await handleGameplayRoute(
    request("/invites/role/read", { body: { inviteId: "abcdefghijk" } }),
    env,
    context(),
    {
      repository: repository({
        getRtdbPath: async (path) => {
          if (path === "invites/abcdefghijk") {
            return {
              hostId: "host-login",
              guestId: null,
              password: "secret",
            };
          }
          if (path === "players/firebase-uid/profile") return "profile-1";
          if (path === "players/host-login/profile") return "profile-host";
          return null;
        },
      }),
      verifyIdentity: async () => identity,
    },
  );
  assert.equal(protectedInvite.status, 403);

  const unavailable = await handleGameplayRoute(
    request("/invites/role/read", { body: { inviteId: "abcdefghijk" } }),
    env,
    context(),
    {
      repository: repository({
        getRtdbPath: async () => {
          throw new Error("rtdb-unavailable");
        },
      }),
      verifyIdentity: async () => identity,
    },
  );
  assert.equal(unavailable.status, 503);
});

test("pending auto-link joins enqueue Telegram projection immediately", async () => {
  const background: Promise<unknown>[] = [];
  const telegramTasks: unknown[] = [];
  const inviteId = "auto_abcdefghi";
  const response = await handleGameplayRoute(
    request("/invites/join", {
      body: {
        operationId: "00000000-0000-4000-8000-000000000002",
        inviteId,
        emojiId: 7,
        aura: "rainbow",
      },
    }),
    {
      ...env,
      TELEGRAM_PROJECTION_QUEUE: {
        ...env.TELEGRAM_PROJECTION_QUEUE,
        send: async (task) => {
          telegramTasks.push(task);
          return {
            metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
          };
        },
      },
    },
    context(background),
    {
      gameSession: {
        createOwnerId: () => "owner-1",
        enqueueProfileGameProjection: async () => undefined,
        now: () => 1_000,
      },
      repository: repository({
        readProfileOwnershipSnapshot: async (query) =>
          ownershipForLogins(query, (uid) =>
            uid === identity.uid ? "host-profile" : `profile-${uid}`,
          ),
        getRtdbPath: async (path) => {
          if (path === `invites/${inviteId}`) {
            return {
              hostId: "host-uid",
              hostColor: "white",
              guestId: null,
            };
          }
          if (path === `players/${identity.uid}/matches/${inviteId}`) {
            return null;
          }
          if (path === `players/host-uid/matches/${inviteId}`) {
            return {
              version: 2,
              color: "white",
              emojiId: 1,
              aura: "",
              gameVariant: "Classic",
              fen: new Game().toFen(),
              status: "",
              flatMovesString: "",
              timer: "",
            };
          }
          if (path === `automatch/${inviteId}`) {
            return {
              uid: "host-uid",
              telegramDeliveryVersion: 2,
            };
          }
          return null;
        },
      }),
      verifyIdentity: async () => identity,
    },
  );
  assert.equal(response.status, 200);
  assert.equal(background.length, 1);
  await Promise.all(background);
  assert.deepEqual(telegramTasks, [
    {
      kind: "automatch-telegram-projection",
      inviteId,
      requestId: "00000000-0000-4000-8000-000000000002",
    },
  ]);
});

test("routes exact authenticated rating updates without a new rate limit", async () => {
  const ratingRequest = {
    playerId: identity.uid,
    opponentId: "opponent-uid",
    inviteId: "auto_aaaaaaaaaaa",
    matchId: "auto_aaaaaaaaaaa",
  };
  const patches: Record<string, unknown>[] = [];
  const ratingRepository: RatingRepository = {
    applyFebruaryChallengeReplay: async () => undefined,
    finalizeRatingUpdate: async (_input, buildPlan) => {
      const plan = buildPlan(null, null);
      assert.equal(plan.ratingUpdate.status, "done");
      return { status: "committed", data: plan.repairData };
    },
    readProfileOwnershipSnapshot: async (query) => ownershipSnapshot(query),
    getRtdbPath: async (path) => {
      if (
        path ===
        `invites/${ratingRequest.inviteId}/matchesRatingUpdates/${ratingRequest.matchId}`
      ) {
        return false;
      }
      if (path === `invites/${ratingRequest.inviteId}`) {
        return {
          hostId: ratingRequest.playerId,
          guestId: ratingRequest.opponentId,
        };
      }
      if (
        path ===
        `players/${ratingRequest.playerId}/matches/${ratingRequest.matchId}`
      ) {
        return {
          color: "white",
          emojiId: 1,
          fen: new Game().toFen(),
          flatMovesString: "",
          status: "",
          timer: "",
        };
      }
      if (
        path ===
        `players/${ratingRequest.opponentId}/matches/${ratingRequest.matchId}`
      ) {
        return {
          color: "black",
          emojiId: 2,
          fen: new Game().toFen(),
          flatMovesString: "",
          status: "surrendered",
          timer: "",
        };
      }
      return null;
    },
    patchRtdbRoot: async (updates) => {
      patches.push(updates);
    },
    readRatingUpdate: async () => null,
    tryAcquireRatingLease: async () => ({
      status: "acquired",
      data: null,
    }),
  };
  const background: Promise<unknown>[] = [];
  const profileProjectionTasks: unknown[] = [];
  const response = await handleGameplayRoute(
    request("/ratings/update", { body: ratingRequest }),
    {
      ...env,
      PROFILE_GAME_PROJECTION_QUEUE: {
        ...env.PROFILE_GAME_PROJECTION_QUEUE,
        send: async (task) => {
          profileProjectionTasks.push(task);
          return {
            metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
          };
        },
      },
    },
    context(background),
    {
      ratingRepository,
      repository: repository(),
      verifyIdentity: async () => identity,
    },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(patches.length, 1);
  await Promise.all(background);
  assert.deepEqual(profileProjectionTasks, [
    {
      kind: "rating-profile-game-projection",
      operationId: `${ratingRequest.inviteId}__${ratingRequest.matchId}`,
    },
  ]);

  const invalid = await handleGameplayRoute(
    request("/ratings/update", {
      body: { ...ratingRequest, playerId: "unsafe/player" },
    }),
    env,
    context(),
    {
      ratingRepository,
      repository: repository(),
      verifyIdentity: async () => identity,
    },
  );
  assert.equal(invalid.status, 400);

  const oversizedOperation = await handleGameplayRoute(
    request("/ratings/update", {
      body: {
        ...ratingRequest,
        inviteId: `auto_${"a".repeat(763)}`,
        matchId: "b".repeat(768),
      },
    }),
    env,
    context(),
    {
      ratingRepository,
      repository: repository(),
      verifyIdentity: async () => identity,
    },
  );
  assert.equal(oversizedOperation.status, 400);
});

test("routes match timer starts with rate limiting and idempotent storage", async () => {
  let rateLimitKey = "";
  const timerEnv = {
    ...env,
    AUTH_RATE_LIMITER: {
      limit: async ({ key }: RateLimitOptions) => {
        rateLimitKey = key;
        return { success: true };
      },
    },
  } as Env;
  const paths: string[] = [];
  const response = await handleGameplayRoute(
    request("/matches/timer/start", {
      body: {
        playerId: identity.uid,
        opponentId: "opponent-uid",
        matchId: "match-1",
        inviteId: "match-1",
      },
    }),
    timerEnv,
    context(),
    {
      repository: repository({
        getRtdbPath: async (path) => {
          paths.push(path);
          if (path === "invites/match-1") {
            return { hostId: identity.uid, guestId: "opponent-uid" };
          }
          if (path.startsWith(`players/${identity.uid}/`)) {
            return {
              color: "black",
              fen: "player-fen",
              flatMovesString: "",
              status: "",
              timer: "4;12345",
            };
          }
          return {
            color: "white",
            fen: "opponent-fen",
            flatMovesString: "",
            status: "",
            timer: "",
          };
        },
        transactRtdbPath: async (path, updater) => {
          paths.push(path);
          return applyTransaction(updater, "4;12345");
        },
      }),
      timer: {
        now: () => 1_000,
        resolveGame: () => ({
          activeColor: "white",
          historyValid: true,
          turnNumber: 4,
          winner: undefined,
        }),
      },
      verifyIdentity: async () => identity,
    },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    timer: "4;12345",
    duration: 90_000,
  });
  assert.equal(rateLimitKey, `timer:${identity.uid}`);
  assert.deepEqual(paths, [
    `players/${identity.uid}/matches/match-1`,
    "players/opponent-uid/matches/match-1",
    "invites/match-1",
    `matchTimerStarts/${identity.uid}/match-1`,
    `players/${identity.uid}/matches/match-1/timer`,
  ]);
});

test("routes timer victory claims with a separate limit and terminal update", async () => {
  let rateLimitKey = "";
  const patches: Array<Record<string, unknown>> = [];
  const response = await handleGameplayRoute(
    request("/matches/timer/claim", {
      body: {
        playerId: identity.uid,
        opponentId: "opponent-uid",
        matchId: "match-1",
        inviteId: "match-1",
      },
    }),
    {
      ...env,
      AUTH_RATE_LIMITER: {
        limit: async ({ key }: RateLimitOptions) => {
          rateLimitKey = key;
          return { success: true };
        },
      },
    } as Env,
    context(),
    {
      repository: repository({
        getRtdbPath: async (path) => {
          if (path === "invites/match-1") {
            return { hostId: identity.uid, guestId: "opponent-uid" };
          }
          if (path.startsWith(`players/${identity.uid}/`)) {
            return {
              color: "black",
              fen: "player-fen",
              flatMovesString: "",
              status: "",
              timer: "4;1000",
            };
          }
          return {
            color: "white",
            fen: "opponent-fen",
            flatMovesString: "",
            status: "",
            timer: "",
          };
        },
        patchRtdbRoot: async (updates) => {
          patches.push(updates);
        },
        transactRtdbPath: async (_path, updater) =>
          applyTransaction(updater, {
            color: "black",
            fen: "player-fen",
            flatMovesString: "",
            status: "",
            timer: "4;1000",
          }),
      }),
      timer: {
        now: () => 1_001,
        resolveGame: () => ({
          activeColor: "white",
          historyValid: true,
          turnNumber: 4,
          winner: undefined,
        }),
      },
      verifyIdentity: async () => identity,
    },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(rateLimitKey, `timer-claim:${identity.uid}`);
  assert.deepEqual(patches, [
    {
      [`players/${identity.uid}/matches/match-1/timer`]: "gg",
      "matchTimerClaims/match-1": {
        status: "claimed",
        playerId: identity.uid,
        opponentId: "opponent-uid",
        inviteId: "match-1",
        timer: "4;1000",
        turnNumber: 4,
        claimedAtMs: 1_001,
        expiresAtMs: null,
      },
      [`matchTimerStarts/${identity.uid}/match-1`]: null,
      "matchTimerStarts/opponent-uid/match-1": null,
    },
  ]);
});

test("rejects rate-limited timer claims before repository access", async () => {
  let reads = 0;
  const response = await handleGameplayRoute(
    request("/matches/timer/claim", {
      body: {
        playerId: identity.uid,
        opponentId: "opponent-uid",
        matchId: "match-1",
        inviteId: "match-1",
      },
    }),
    {
      ...env,
      AUTH_RATE_LIMITER: { limit: async () => ({ success: false }) },
    } as Env,
    context(),
    {
      repository: repository({
        getRtdbPath: async () => {
          reads++;
          return null;
        },
      }),
      verifyIdentity: async () => identity,
    },
  );
  assert.equal(response.status, 429);
  assert.deepEqual(await response.json(), {
    ok: false,
    error: "resource-exhausted",
    message: "Too many timer claim attempts.",
  });
  assert.equal(reads, 0);
});

test("sanitizes timer claim repository failures", async () => {
  const failures: string[] = [];
  const response = await handleGameplayRoute(
    request("/matches/timer/claim", {
      body: {
        playerId: identity.uid,
        opponentId: "opponent-uid",
        matchId: "match-1",
        inviteId: "match-1",
      },
    }),
    env,
    context(),
    {
      logFailure: (kind) => failures.push(kind),
      repository: repository({
        getRtdbPath: async (path) => {
          if (path === "invites/match-1") {
            return { hostId: identity.uid, guestId: "opponent-uid" };
          }
          return path.includes(identity.uid)
            ? {
                color: "black",
                fen: "player-fen",
                flatMovesString: "",
                status: "",
                timer: "4;1000",
              }
            : {
                color: "white",
                fen: "opponent-fen",
                flatMovesString: "",
                status: "",
                timer: "",
              };
        },
        patchRtdbRoot: async () => {
          throw new Error("private-rtdb-detail");
        },
        transactRtdbPath: async (_path, updater) =>
          applyTransaction(updater, {
            color: "black",
            fen: "player-fen",
            flatMovesString: "",
            status: "",
            timer: "4;1000",
          }),
      }),
      timer: {
        now: () => 1_001,
        resolveGame: () => ({
          activeColor: "white",
          historyValid: true,
          turnNumber: 4,
          winner: undefined,
        }),
      },
      verifyIdentity: async () => identity,
    },
  );
  assert.equal(response.status, 503);
  const payload = await response.json();
  assert.deepEqual(payload, {
    ok: false,
    error: "unavailable",
    message: "gameplay-service-unavailable",
  });
  assert.doesNotMatch(JSON.stringify(payload), /private-rtdb-detail/);
  assert.deepEqual(failures, ["gameplay-service-unavailable"]);
});

test("rejects rate-limited match timers before repository access", async () => {
  let reads = 0;
  const response = await handleGameplayRoute(
    request("/matches/timer/start", {
      body: {
        playerId: identity.uid,
        opponentId: "opponent-uid",
        matchId: "match-1",
        inviteId: "match-1",
      },
    }),
    {
      ...env,
      AUTH_RATE_LIMITER: { limit: async () => ({ success: false }) },
    } as Env,
    context(),
    {
      repository: repository({
        getRtdbPath: async () => {
          reads++;
          return null;
        },
      }),
      verifyIdentity: async () => identity,
    },
  );
  assert.equal(response.status, 429);
  assert.deepEqual(await response.json(), {
    ok: false,
    error: "resource-exhausted",
    message: "Too many timer attempts.",
  });
  assert.equal(reads, 0);
});

test("sanitizes match timer rate-limit infrastructure failures", async () => {
  const failures: string[] = [];
  const response = await handleGameplayRoute(
    request("/matches/timer/start", {
      body: {
        playerId: identity.uid,
        opponentId: "opponent-uid",
        matchId: "match-1",
        inviteId: "match-1",
      },
    }),
    {
      ...env,
      AUTH_RATE_LIMITER: {
        limit: async () => {
          throw new Error("private-rate-limit-detail");
        },
      },
    } as Env,
    context(),
    {
      logFailure: (kind) => failures.push(kind),
      verifyIdentity: async () => identity,
    },
  );
  assert.equal(response.status, 503);
  const payload = await response.json();
  assert.deepEqual(payload, {
    ok: false,
    error: "unavailable",
    message: "rate-limit-unavailable",
  });
  assert.doesNotMatch(JSON.stringify(payload), /private/);
  assert.deepEqual(failures, ["rate-limit-unavailable"]);
});

test("routes wager cancellation and decline to their exact proposal owners", async () => {
  const run = async (
    path: "/wagers/proposals/cancel" | "/wagers/proposals/decline",
  ) => {
    const transactionPaths: string[] = [];
    const response = await handleGameplayRoute(
      request(path, { body: { inviteId: "invite", matchId: "match" } }),
      env,
      context(),
      {
        repository: wagerRepository({
          readProfileOwnershipSnapshot: async (query) =>
            ownershipForLogins(query, (uid) => `profile-${uid}`),
          getRtdbPath: async () => ({ hostId: "host", guestId: "guest" }),
          transactRtdbPath: async (transactionPath, updater) => {
            transactionPaths.push(transactionPath);
            const current = transactionPath.startsWith("invites/")
              ? {
                  proposals: {
                    host: { material: "dust", count: 1 },
                    guest: { material: "ice", count: 2 },
                  },
                }
              : { dust: 2, slime: 0, gum: 0, metal: 0, ice: 3 };
            const decision = updater(current) as {
              commit?: boolean;
              value?: unknown;
            };
            return decision.commit === false
              ? { committed: false, value: current }
              : { committed: true, value: decision.value };
          },
        }),
        verifyIdentity: async () => ({
          uid: "host",
        }),
      },
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
    return transactionPaths;
  };

  assert.deepEqual(await run("/wagers/proposals/cancel"), [
    "invites/invite/wagers/match",
    "players/host/mining",
  ]);
  assert.deepEqual(await run("/wagers/proposals/decline"), [
    "invites/invite/wagers/match",
    "players/guest/mining",
  ]);
});

test("routes wager send and accept through the authenticated gameplay surface", async () => {
  const send = await handleGameplayRoute(
    request("/wagers/proposals/send", {
      body: {
        inviteId: "invite",
        matchId: "match",
        material: "dust",
        count: 2,
      },
    }),
    env,
    context(),
    {
      repository: wagerRepository({
        readProfileOwnershipSnapshot: async (query) =>
          ownershipForLogins(query, (uid) => `profile-${uid}`),
        getMiningMaterials: async (_profileId) => {
          return { dust: 2, slime: 0, gum: 0, metal: 0, ice: 0 };
        },
        getRtdbPath: async () => ({ hostId: "host", guestId: "guest" }),
        transactRtdbPath: async (path, updater) =>
          applyTransaction(
            updater,
            path.startsWith("players/")
              ? {
                  frozen: { dust: 0, slime: 0, gum: 0, metal: 0, ice: 0 },
                }
              : null,
          ),
      }),
      verifyIdentity: async () => ({
        uid: "host",
      }),
      wager: { now: () => 100 },
    },
  );
  assert.equal(send.status, 200);
  assert.deepEqual(await send.json(), { ok: true, count: 2 });

  let acceptWager: unknown = {
    proposals: { guest: { material: "dust", count: 2 } },
  };
  let acceptMining: unknown = {
    frozen: { dust: 0, slime: 0, gum: 0, metal: 0, ice: 0 },
  };
  const accept = await handleGameplayRoute(
    request("/wagers/proposals/accept", {
      body: { inviteId: "invite", matchId: "match" },
    }),
    env,
    context(),
    {
      repository: wagerRepository({
        readProfileOwnershipSnapshot: async (query) =>
          ownershipForLogins(query, (uid) => `profile-${uid}`),
        getMiningMaterials: async () => ({
          dust: 2,
          slime: 0,
          gum: 0,
          metal: 0,
          ice: 0,
        }),
        getRtdbPath: async (path) => {
          if (path === "invites/invite") {
            return { hostId: "host", guestId: "guest" };
          }
          if (path === "players/host/mining") return acceptMining;
          return acceptWager;
        },
        transactRtdbPath: async (path, updater) => {
          const result = applyTransaction(
            updater,
            path.startsWith("players/") ? acceptMining : acceptWager,
          );
          if (result.committed) {
            if (path.startsWith("players/")) acceptMining = result.value;
            else acceptWager = result.value;
          }
          return result;
        },
      }),
      verifyIdentity: async () => ({
        uid: "host",
      }),
      wager: { now: () => 200 },
    },
  );
  assert.equal(accept.status, 200);
  assert.deepEqual(await accept.json(), { ok: true, count: 2 });
});

test("rejects an unsafe wager count before repository work", async () => {
  let reads = 0;
  const response = await handleGameplayRoute(
    request("/wagers/proposals/send", {
      body: {
        inviteId: "invite",
        matchId: "match",
        material: "dust",
        count: Number.MAX_SAFE_INTEGER + 1,
      },
    }),
    env,
    context(),
    {
      repository: wagerRepository({
        getRtdbPath: async () => {
          reads += 1;
          return null;
        },
      }),
      verifyIdentity: async () => ({ uid: "host" }),
    },
  );
  assert.equal(response.status, 400);
  assert.equal(reads, 0);
});

test("returns wager permission and infrastructure failures without details", async () => {
  const forbidden = await handleGameplayRoute(
    request("/wagers/proposals/cancel", {
      body: { inviteId: "invite", matchId: "match" },
    }),
    env,
    context(),
    {
      repository: wagerRepository({
        readProfileOwnershipSnapshot: async (query) =>
          ownershipForLogins(query, (uid) => `profile-${uid}`),
        getRtdbPath: async () => ({ hostId: "host", guestId: "guest" }),
      }),
      verifyIdentity: async () => ({
        uid: "other",
      }),
    },
  );
  assert.equal(forbidden.status, 403);
  assert.deepEqual(await forbidden.json(), {
    ok: false,
    error: "permission-denied",
    message: "permission-denied",
  });

  const routeFailures: string[] = [];
  const materialFailures: Array<Record<string, unknown>> = [];
  let transactions = 0;
  const unavailable = await handleGameplayRoute(
    request("/wagers/proposals/cancel", {
      body: { inviteId: "invite", matchId: "match" },
    }),
    env,
    context(),
    {
      logFailure: (kind) => routeFailures.push(kind),
      repository: wagerRepository({
        readProfileOwnershipSnapshot: async (query) =>
          ownershipForLogins(query, (uid) => `profile-${uid}`),
        getRtdbPath: async () => ({ hostId: "host", guestId: "guest" }),
        transactRtdbPath: async (_path, updater) => {
          transactions++;
          if (transactions === 2) {
            throw new Error("private-upstream-detail");
          }
          const current = {
            proposals: { host: { material: "dust", count: 1 } },
          };
          const decision = updater(current) as { value?: unknown };
          return { committed: true, value: decision.value };
        },
      }),
      verifyIdentity: async () => ({
        uid: "host",
      }),
      wager: {
        logMaterialReleaseFailure: (record) => materialFailures.push(record),
      },
    },
  );
  assert.equal(unavailable.status, 503);
  const payload = await unavailable.json();
  assert.deepEqual(payload, {
    ok: false,
    error: "unavailable",
    message: "gameplay-service-unavailable",
  });
  assert.doesNotMatch(JSON.stringify(payload), /private|token|host/);
  assert.deepEqual(routeFailures, ["gameplay-service-unavailable"]);
  assert.equal(materialFailures.length, 1);

  let sendTransactions = 0;
  let sendMining: unknown = {
    frozen: { dust: 0, slime: 0, gum: 0, metal: 0, ice: 0 },
  };
  const sendFailure = await handleGameplayRoute(
    request("/wagers/proposals/send", {
      body: {
        inviteId: "invite",
        matchId: "match",
        material: "dust",
        count: 1,
      },
    }),
    env,
    context(),
    {
      repository: wagerRepository({
        readProfileOwnershipSnapshot: async (query) =>
          ownershipForLogins(query, (uid) => `profile-${uid}`),
        getMiningMaterials: async () => ({
          dust: 1,
          slime: 0,
          gum: 0,
          metal: 0,
          ice: 0,
        }),
        getRtdbPath: async (path) => {
          if (path === "invites/invite") {
            return { hostId: "host", guestId: "guest" };
          }
          if (path === "players/host/mining") return sendMining;
          if (path === "invites/invite/wagers/match") {
            return { proposedBy: { host: true } };
          }
          return null;
        },
        transactRtdbPath: async (path, updater) => {
          sendTransactions++;
          if (sendTransactions === 3) {
            throw new Error("private-rollback-detail");
          }
          if (path === "players/host/mining") {
            const result = applyTransaction(updater, sendMining);
            if (result.committed) sendMining = result.value;
            return result;
          }
          return applyTransaction(updater, { proposedBy: { host: true } });
        },
      }),
      verifyIdentity: async () => ({
        uid: "host",
      }),
    },
  );
  assert.equal(sendFailure.status, 503);
  const sendPayload = await sendFailure.json();
  assert.deepEqual(sendPayload, {
    ok: false,
    error: "unavailable",
    message: "gameplay-service-unavailable",
  });
  assert.doesNotMatch(JSON.stringify(sendPayload), /private|rollback|host/);
});

test("authenticates before body parsing and sanitizes route failures", async () => {
  let repositoryReads = 0;
  const unauthenticated = await handleGameplayRoute(
    request("/automatch/cancel"),
    env,
    context(),
    {
      repository: repository({
        getRtdbPath: async () => {
          repositoryReads++;
          return null;
        },
      }),
      verifyIdentity: async () => {
        throw new AuthApiFailure(
          401,
          "unauthenticated",
          "authentication-required",
        );
      },
    },
  );
  assert.equal(unauthenticated.status, 401);
  assert.equal(repositoryReads, 0);

  const invalidBodies = [
    ["/automatch/cancel", { unexpected: true }],
    ["/automatch/start", {}],
    ["/automatch/start", { emojiId: 0, aura: "" }],
    ["/automatch/start", { emojiId: 1, aura: "", extra: true }],
    ["/matches/timer/start", {}],
    ["/matches/timer/claim", {}],
    [
      "/matches/timer/claim",
      {
        playerId: "player",
        opponentId: "player",
        matchId: "match",
        inviteId: "match",
      },
    ],
    [
      "/matches/timer/claim",
      {
        playerId: "player",
        opponentId: "opponent",
        matchId: "match",
        inviteId: "match",
        extra: true,
      },
    ],
    [
      "/matches/timer/start",
      {
        playerId: "player",
        opponentId: "player",
        matchId: "match",
        inviteId: "match",
      },
    ],
    [
      "/matches/timer/start",
      {
        playerId: "unsafe/player",
        opponentId: "opponent",
        matchId: "match",
        inviteId: "match",
      },
    ],
    [
      "/matches/timer/start",
      {
        playerId: "player",
        opponentId: "opponent",
        matchId: "match",
        inviteId: "match",
        extra: true,
      },
    ],
    ["/navigation/games/remove", {}],
    ["/navigation/games/remove", { inviteId: "unsafe/key" }],
    ["/navigation/games/read", {}],
    ["/navigation/games/read", { limit: 0, cursor: null }],
    ["/navigation/games/read", { limit: 101, cursor: null }],
    [
      "/navigation/games/read",
      {
        limit: 80,
        cursor: { sortBucket: 30, listSortAtMs: 100, id: "unsafe/key" },
      },
    ],
    ["/wagers/proposals/cancel", {}],
    ["/wagers/proposals/cancel", { inviteId: "invite", matchId: "unsafe/key" }],
    ["/wagers/proposals/accept", {}],
    [
      "/wagers/proposals/accept",
      { inviteId: "invite", matchId: "match", extra: true },
    ],
    [
      "/wagers/proposals/send",
      { inviteId: "invite", matchId: "match", material: "dust" },
    ],
    [
      "/wagers/proposals/send",
      {
        inviteId: "invite",
        matchId: "match",
        material: "dust",
        count: 0.4,
      },
    ],
    [
      "/wagers/proposals/send",
      {
        inviteId: "invite",
        matchId: "match",
        material: "unknown",
        count: 1,
      },
    ],
    [
      "/wagers/proposals/send",
      {
        inviteId: "unsafe/key",
        matchId: "match",
        material: "dust",
        count: 1,
      },
    ],
    [
      "/wagers/proposals/decline",
      { inviteId: "x".repeat(769), matchId: "match" },
    ],
    [
      "/wagers/proposals/decline",
      { inviteId: "invite", matchId: "match", extra: true },
    ],
  ] as const;
  for (const [path, body] of invalidBodies) {
    const response = await handleGameplayRoute(
      request(path, { body }),
      env,
      context(),
      { verifyIdentity: async () => identity },
    );
    assert.equal(response.status, 400);
  }

  const failures: string[] = [];
  const unavailable = await handleGameplayRoute(
    request("/automatch/cancel", { body: {} }),
    env,
    context(),
    {
      logFailure: (kind) => failures.push(kind),
      repository: repository({
        getRtdbPath: async () => {
          throw new Error("private-upstream-detail");
        },
        readProfileOwnershipSnapshot: async (query) => ownershipSnapshot(query),
      }),
      verifyIdentity: async () => ({
        uid: "uid-with-no-claim",
      }),
    },
  );
  assert.equal(unavailable.status, 503);
  const payload = await unavailable.json();
  assert.deepEqual(payload, {
    ok: false,
    error: "unavailable",
    message: "gameplay-service-unavailable",
  });
  assert.deepEqual(failures, ["gameplay-service-unavailable"]);
  assert.doesNotMatch(JSON.stringify(payload), /private|token|uid/);
});

test("reads only the authenticated caller profile from D1", async () => {
  let received:
    | {
        profileId: string;
        limit: number;
        cursor: unknown;
      }
    | undefined;
  const response = await handleGameplayRoute(
    request("/navigation/games/read", {
      body: {
        limit: 80,
        cursor: { sortBucket: 30, listSortAtMs: 1_000, id: "invite-1" },
      },
    }),
    env,
    context(),
    {
      repository: repository({
        readProfileOwnershipSnapshot: async (query) =>
          ownershipForLogins(query, () => "profile-from-d1"),
        getRtdbPath: async (path) => {
          assert.fail(`unexpected RTDB read ${path}`);
        },
      }),
      readNavigationPage: async (_db, profileId, limit, cursor) => {
        received = { profileId, limit, cursor };
        return { ok: true, items: [], nextCursor: null, hasMore: false };
      },
      verifyIdentity: async () => identity,
    },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    items: [],
    nextCursor: null,
    hasMore: false,
  });
  assert.deepEqual(received, {
    profileId: "profile-from-d1",
    limit: 80,
    cursor: { sortBucket: 30, listSortAtMs: 1_000, id: "invite-1" },
  });
});

test("fails closed when navigation profile ownership is unavailable", async () => {
  let reads = 0;
  const response = await handleGameplayRoute(
    request("/navigation/games/read", {
      body: { limit: 80, cursor: null },
    }),
    env,
    context(),
    {
      repository: repository({
        getRtdbPath: async () => {
          throw new Error("rtdb-unavailable");
        },
        readProfileOwnershipSnapshot: async () => {
          throw new Error("profile-storage-unavailable");
        },
      }),
      readNavigationPage: async () => {
        reads += 1;
        return { ok: true, items: [], nextCursor: null, hasMore: false };
      },
      verifyIdentity: async () => identity,
    },
  );
  assert.equal(response.status, 503);
  assert.equal(reads, 0);
});
