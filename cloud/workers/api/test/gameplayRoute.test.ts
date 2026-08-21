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
    applyWagerTransferOnce: async () => "applied",
    deleteNavigationGame: async () => "deleted",
    findProfileId: async () => null,
    getAutomatchProfile: async () => null,
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
    transactRtdbPath: async () => ({ committed: false, value: null }),
    ...overrides,
  };
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

  const started = await handleGameplayRoute(
    request("/automatch/start", {
      body: { emojiId: 7, aura: "rainbow" },
    }),
    env,
    context(),
    {
      repository: repository({
        getAutomatchProfile: async () => null,
        getRtdbPath: async (path, query) => {
          assert.equal(path, "automatch");
          assert.deepEqual(query, { orderBy: "$key", limitToFirst: 1 });
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
        repository: repository({
          findProfileId: async (uid) => `profile-${uid}`,
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
          idToken: "token",
          profileId: "profile-host",
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
      repository: repository({
        findProfileId: async (uid) => `profile-${uid}`,
        getMiningMaterials: async (_profileId, token) => {
          assert.equal(token, "token");
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
        idToken: "token",
        profileId: "profile-host",
        uid: "host",
      }),
      wager: { now: () => 100 },
    },
  );
  assert.equal(send.status, 200);
  assert.deepEqual(await send.json(), { ok: true, count: 2 });

  let reads = 0;
  const accept = await handleGameplayRoute(
    request("/wagers/proposals/accept", {
      body: { inviteId: "invite", matchId: "match" },
    }),
    env,
    context(),
    {
      repository: repository({
        findProfileId: async (uid) => `profile-${uid}`,
        getMiningMaterials: async () => ({
          dust: 2,
          slime: 0,
          gum: 0,
          metal: 0,
          ice: 0,
        }),
        getRtdbPath: async () => {
          reads++;
          return reads === 1
            ? { hostId: "host", guestId: "guest" }
            : { proposals: { guest: { material: "dust", count: 2 } } };
        },
        transactRtdbPath: async (path, updater) =>
          applyTransaction(
            updater,
            path.startsWith("players/")
              ? {
                  frozen: { dust: 0, slime: 0, gum: 0, metal: 0, ice: 0 },
                }
              : { proposals: { guest: { material: "dust", count: 2 } } },
          ),
      }),
      verifyIdentity: async () => ({
        idToken: "token",
        profileId: "profile-host",
        uid: "host",
      }),
      wager: { now: () => 200 },
    },
  );
  assert.equal(accept.status, 200);
  assert.deepEqual(await accept.json(), { ok: true, count: 2 });
});

test("returns wager permission and infrastructure failures without details", async () => {
  const forbidden = await handleGameplayRoute(
    request("/wagers/proposals/cancel", {
      body: { inviteId: "invite", matchId: "match" },
    }),
    env,
    context(),
    {
      repository: repository({
        findProfileId: async (uid) => `profile-${uid}`,
        getRtdbPath: async () => ({ hostId: "host", guestId: "guest" }),
      }),
      verifyIdentity: async () => ({
        idToken: "token",
        profileId: "profile-other",
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
      repository: repository({
        findProfileId: async (uid) => `profile-${uid}`,
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
        idToken: "token",
        profileId: "profile-host",
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
      repository: repository({
        findProfileId: async (uid) => `profile-${uid}`,
        getMiningMaterials: async () => ({
          dust: 1,
          slime: 0,
          gum: 0,
          metal: 0,
          ice: 0,
        }),
        getRtdbPath: async () => ({ hostId: "host", guestId: "guest" }),
        transactRtdbPath: async (_path, updater) => {
          sendTransactions++;
          if (sendTransactions === 3) {
            throw new Error("private-rollback-detail");
          }
          return applyTransaction(
            updater,
            sendTransactions === 1
              ? { dust: 0, slime: 0, gum: 0, metal: 0, ice: 0 }
              : { proposedBy: { host: true } },
          );
        },
      }),
      verifyIdentity: async () => ({
        idToken: "token",
        profileId: "profile-host",
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
