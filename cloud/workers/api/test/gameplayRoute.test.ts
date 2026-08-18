import assert from "node:assert/strict";
import test from "node:test";
import { AuthApiFailure } from "../src/authErrors.ts";
import {
  cancelAutomatch,
  getQueuedAutomatchCandidates,
  handleGameplayRoute,
  removeNavigationGame,
} from "../src/gameplayRoute.ts";
import type { FirebaseIdentity } from "../src/firebaseAuth.ts";
import type {
  GameplayRepository,
  NavigationGameDeleteResult,
  NavigationGameDocument,
} from "../src/gameplayRepository.ts";
import { TELEGRAM_TEST_ENV } from "./testEnv.ts";

const env = {
  ...TELEGRAM_TEST_ENV,
  AUTH_DISABLE_X_VERIFY: "false",
  AUTH_RATE_LIMITER: { limit: async () => ({ success: true }) },
  FIRESTORE_SERVICE_ACCOUNT_EMAIL: "worker@example.iam.gserviceaccount.com",
  FIRESTORE_SERVICE_ACCOUNT_PRIVATE_KEY: "test-private-key",
  HELIUS_RPC_API_KEY: "test-helius-key",
  NFT_RATE_LIMITER: { limit: async () => ({ success: true }) },
  X_CLIENT_ID: "test-x-client",
  X_CLIENT_SECRET: "test-x-secret",
} as Env;

const identity: FirebaseIdentity = {
  idToken: "firebase-token",
  profileId: "claim-profile",
  uid: "firebase-uid",
};

function repository(
  overrides: Partial<GameplayRepository> = {},
): GameplayRepository {
  return {
    deleteNavigationGame: async () => "deleted",
    findProfileId: async () => null,
    getNavigationGame: async () => null,
    getRtdbPath: async () => null,
    patchRtdbRoot: async () => undefined,
    ...overrides,
  };
}

function context(): Pick<ExecutionContext, "waitUntil"> {
  return {
    waitUntil() {},
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

test("normalizes queued candidates and selects newest valid records first", () => {
  assert.deepEqual(
    getQueuedAutomatchCandidates({
      older: {
        uid: " login ",
        profileId: " profile ",
        timestamp: "10.9",
        telegramDeliveryVersion: 2,
      },
      newer: {
        uid: "other",
        timestamp: 20,
        telegramDeliveryVersion: 1,
      },
      "unsafe/key": { timestamp: 30 },
    }),
    [
      {
        inviteId: "newer",
        uid: "other",
        profileId: "",
        timestamp: 20,
        telegramDeliveryVersion: null,
      },
      {
        inviteId: "older",
        uid: "login",
        profileId: "profile",
        timestamp: 10,
        telegramDeliveryVersion: 2,
      },
    ],
  );
  assert.deepEqual(getQueuedAutomatchCandidates(null), []);
});

test("cancels the newest UID automatch with exact v2 multipath updates", async () => {
  const patches: Array<Record<string, unknown>> = [];
  let guestReads = 0;
  const result = await cancelAutomatch(
    identity,
    repository({
      getRtdbPath: async (path, query) => {
        if (path === "players/firebase-uid/profile") return "profile-1";
        if (path === "automatch") {
          assert.deepEqual(query, {
            orderBy: "uid",
            equalTo: "firebase-uid",
          });
          return {
            "auto-older": { timestamp: 1 },
            "auto-newer": {
              timestamp: 2,
              telegramDeliveryVersion: 2,
            },
          };
        }
        if (path === "invites/auto-newer/guestId") {
          guestReads++;
          return null;
        }
        assert.fail(`unexpected RTDB path ${path}`);
      },
      patchRtdbRoot: async (updates) => {
        patches.push(updates);
      },
    }),
  );
  assert.deepEqual(result, { ok: true });
  assert.equal(guestReads, 2);
  assert.deepEqual(patches, [
    {
      "automatch/auto-newer": null,
      "invites/auto-newer/automatchStateHint": "canceled",
      "invites/auto-newer/automatchCanceledAt": { ".sv": "timestamp" },
      "telegramAutomatches/auto-newer/lifecycle": "canceled",
      "telegramAutomatches/auto-newer/updatedAtMs": { ".sv": "timestamp" },
      "telegramAutomatches/auto-newer/generation": {
        ".sv": { increment: 1 },
      },
    },
  ]);
});

test("uses profile fallback and restores matched state after a guest race", async () => {
  const patches: Array<Record<string, unknown>> = [];
  let guestReads = 0;
  const result = await cancelAutomatch(
    identity,
    repository({
      findProfileId: async (uid, token) => {
        assert.equal(uid, identity.uid);
        assert.equal(token, identity.idToken);
        return "profile-1";
      },
      getRtdbPath: async (path, query) => {
        if (path === "players/firebase-uid/profile") return null;
        if (path === "automatch" && query?.orderBy === "uid") return null;
        if (path === "automatch" && query?.orderBy === "profileId") {
          return {
            "auto-race": {
              profileId: "profile-1",
              telegramDeliveryVersion: 2,
            },
          };
        }
        if (path === "invites/auto-race") return { hostId: "host-uid" };
        if (path === "players/host-uid/profile") return "profile-1";
        if (path === "invites/auto-race/guestId") {
          guestReads++;
          return guestReads === 1 ? null : "guest-uid";
        }
        assert.fail(`unexpected RTDB path ${path}`);
      },
      patchRtdbRoot: async (updates) => {
        patches.push(updates);
      },
    }),
  );
  assert.deepEqual(result, { ok: false });
  assert.equal(patches.length, 2);
  assert.deepEqual(patches[1], {
    "invites/auto-race/automatchStateHint": "matched",
    "invites/auto-race/automatchCanceledAt": null,
    "telegramAutomatches/auto-race/lifecycle": "matched",
    "telegramAutomatches/auto-race/updatedAtMs": { ".sv": "timestamp" },
    "telegramAutomatches/auto-race/generation": {
      ".sv": { increment: 1 },
    },
  });
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
  const result = await cancelAutomatch(
    identity,
    repository({
      getRtdbPath: async (path) => {
        if (path === "players/firebase-uid/profile") return "profile";
        if (path === "automatch") {
          return { "auto-legacy": { telegramDeliveryVersion: 1 } };
        }
        if (path === "invites/auto-legacy/guestId") return null;
        return null;
      },
      patchRtdbRoot: async (updates) => {
        patches.push(updates);
      },
    }),
  );
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(patches, [
    {
      "automatch/auto-legacy": null,
      "invites/auto-legacy/automatchStateHint": "canceled",
      "invites/auto-legacy/automatchCanceledAt": { ".sv": "timestamp" },
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
    identity?: FirebaseIdentity;
    inviteId?: string;
    repo: Partial<GameplayRepository>;
    expected: unknown;
  }> = [
    {
      name: "profile unresolved",
      identity: { idToken: "firebase-token", uid: "firebase-uid" },
      repo: { getRtdbPath: async () => null, findProfileId: async () => null },
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
          updateTime: "one",
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
        repository(entry.repo),
      ),
      entry.expected,
      entry.name,
    );
  }
});

test("re-reads navigation games after conflicts and bounds retries", async () => {
  const reads: NavigationGameDocument[] = [
    { status: "waiting", updateTime: "one" },
    { status: "waiting", updateTime: "two" },
  ];
  const deletes: NavigationGameDeleteResult[] = ["conflict", "deleted"];
  const result = await removeNavigationGame(
    identity,
    "invite-1",
    repository({
      getRtdbPath: async (path) => {
        if (path === "players/firebase-uid/profile") return "profile-1";
        if (path === "invites/invite-1") return {};
        return null;
      },
      getNavigationGame: async () => reads.shift() as NavigationGameDocument,
      deleteNavigationGame: async (_profile, _invite, updateTime) => {
        assert.equal(updateTime, deletes.length === 2 ? "one" : "two");
        return deletes.shift() as NavigationGameDeleteResult;
      },
    }),
  );
  assert.deepEqual(result, {
    ok: true,
    skipped: false,
    deleted: true,
    reason: null,
    inviteId: "invite-1",
  });

  let attempts = 0;
  await assert.rejects(
    () =>
      removeNavigationGame(
        identity,
        "invite-1",
        repository({
          getRtdbPath: async (path) => {
            if (path === "players/firebase-uid/profile") return "profile-1";
            if (path === "invites/invite-1") return {};
            return null;
          },
          getNavigationGame: async () => ({
            status: "waiting",
            updateTime: String(++attempts),
          }),
          deleteNavigationGame: async () => "conflict",
        }),
      ),
    (error: unknown) =>
      error instanceof Error &&
      error.message === "navigation-game-write-conflict",
  );
  assert.equal(attempts, 3);
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
    ["/navigation/games/remove", {}],
    ["/navigation/games/remove", { inviteId: "unsafe/key" }],
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
        findProfileId: async () => null,
      }),
      verifyIdentity: async () => ({
        idToken: "token",
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
