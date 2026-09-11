import assert from "node:assert/strict";
import test from "node:test";
import { AuthApiFailure } from "../src/authErrors.ts";
import {
  readGameplayBody,
  type GameplayRouteDependencies,
} from "../src/gameplayRoute.ts";
import type {
  GameplayRepository,
  RatingRepository,
} from "../src/gameplayRepository.ts";
import { handleRequest } from "../src/router.ts";
import { createMemoryGameplayCoordinationStores } from "./gameplayCoordinationTestUtils.ts";
import { createAutomatchPersistenceStub } from "./automatchPersistenceTestUtils.ts";
import { TELEGRAM_TEST_ENV } from "./testEnv.ts";

const operationId = "00000000-0000-4000-8000-000000000001";
const uid = "login-uid";
const presentation = { emojiId: 1, aura: "" };
const operation = { operationId, inviteId: "invite" };
const matchRequest = { inviteId: "invite", matchId: "invite", playerId: uid };
const timerRequest = { ...matchRequest, opponentId: "opponent-uid" };
const wagerRequest = { inviteId: "invite", matchId: "invite" };
const match = {
  version: 1,
  color: "white",
  emojiId: 1,
  aura: "",
  gameVariant: "Classic",
  fen: "stored-fen",
  status: "",
  flatMovesString: "",
  timer: "",
};
const materials = { dust: 0, slime: 0, gum: 0, metal: 0, ice: 0 };

type RouteCase = {
  path: string;
  body: Record<string, unknown>;
  effect: string;
  response?: Record<string, unknown>;
  receipt?: { kind: string; fingerprint: string };
};

const routes: RouteCase[] = [
  {
    path: "/matches/move",
    body: {
      ...matchRequest,
      previousFlatMovesString: "",
      flatMovesString: "move",
      fen: "next-fen",
    },
    effect: "canonical-move",
  },
  {
    path: "/wagers/frozen/read",
    body: { playerUid: uid },
    effect: "frozen-balance",
    response: { ok: true, playerUid: uid, frozen: materials, revision: 7 },
  },
  { path: "/automatch/cancel", body: {}, effect: "automatch-queues" },
  {
    path: "/automatch/start",
    body: presentation,
    effect: "automatch-receipt",
    response: {
      ok: true,
      inviteId: "auto_invite",
      mode: "pending",
      matchedImmediately: false,
    },
  },
  {
    path: "/invites/create",
    body: { ...operation, ...presentation, inviteId: "AbCdEfGhIjK" },
    effect: "invite-create",
    receipt: {
      kind: "invite-create",
      fingerprint:
        "60b8680dcda1f9e322fb2836ac36487d8b150f147bb7457b958ffce99f2d17b4",
    },
    response: {
      ok: true,
      inviteId: "AbCdEfGhIjK",
      hostId: uid,
      matchId: "AbCdEfGhIjK",
    },
  },
  {
    path: "/invites/join",
    body: { ...operation, ...presentation },
    effect: "invite-join",
    receipt: {
      kind: "invite-join",
      fingerprint:
        "9edc23d8a1ad5b44cd62f5e2b504f7ee99714b93c679556b09685f52200f6cdd",
    },
    response: {
      ok: true,
      inviteId: "invite",
      guestId: uid,
      joined: true,
      matchId: "invite",
    },
  },
  {
    path: "/invites/role/read",
    body: { inviteId: "invite" },
    effect: "invite-role",
    response: {
      ok: true,
      inviteId: "invite",
      hostId: uid,
      guestId: "opponent-uid",
      actorUid: uid,
      role: "host",
    },
  },
  {
    path: "/matches/ensure",
    body: { ...operation, ...presentation, matchId: "invite" },
    effect: "match-ensure",
    receipt: {
      kind: "match-ensure",
      fingerprint:
        "bdf60cb7e3ee308ea2db7db43efe4379b9d13d33b9142f7bee80b524cbe8d838",
    },
    response: {
      ok: true,
      inviteId: "invite",
      actorUid: uid,
      matchId: "invite",
      created: false,
      match,
    },
  },
  {
    path: "/matches/surrender",
    body: matchRequest,
    effect: "canonical-surrender",
  },
  {
    path: "/matches/timer/claim",
    body: timerRequest,
    effect: "canonical-timer-claim",
  },
  {
    path: "/matches/timer/start",
    body: timerRequest,
    effect: "canonical-timer-start",
  },
  {
    path: "/navigation/games/read",
    body: { limit: 3, cursor: null },
    effect: "navigation-page",
    response: { ok: true, items: [], nextCursor: null, hasMore: false },
  },
  {
    path: "/navigation/games/remove",
    body: { inviteId: "invite" },
    effect: "navigation-delete",
    response: {
      ok: true,
      skipped: false,
      deleted: true,
      reason: null,
      inviteId: "invite",
    },
  },
  {
    path: "/ratings/update",
    body: { ...timerRequest, inviteId: "auto_invite", matchId: "auto_invite" },
    effect: "rating-completion",
  },
  {
    path: "/rematches/end",
    body: operation,
    effect: "rematch-end",
    receipt: {
      kind: "rematch-end",
      fingerprint:
        "be05702264e491e2d35142721e69813ea7058d2f7fa140dd588eaf2d7d28cb01",
    },
    response: { ok: true, inviteId: "invite", actorUid: uid, rematches: "x" },
  },
  {
    path: "/rematches/propose",
    body: { ...operation, ...presentation },
    effect: "rematch-propose",
    receipt: {
      kind: "rematch-propose",
      fingerprint:
        "69990ab96985e54b2b10d95f6e5573341e26f17c0f2d8b6a5112dc431f7af748",
    },
    response: {
      ok: true,
      inviteId: "invite",
      actorUid: uid,
      matchId: "invite1",
      rematches: "1",
      match,
    },
  },
  ...["accept", "cancel", "decline", "send"].map((action) => ({
    path: `/wagers/proposals/${action}`,
    body:
      action === "send"
        ? { ...wagerRequest, material: "dust", count: 1 }
        : wagerRequest,
    effect: `/wagers/proposals/${action}`,
  })),
  {
    path: "/wagers/outcomes/resolve",
    body: wagerRequest,
    effect: "/wagers/outcomes/resolve",
  },
];

function request(path: string, body: unknown = {}, method = "POST"): Request {
  return new Request(`https://api.mons.link${path}`, {
    method,
    headers: {
      Origin: "https://mons.link",
      "Content-Type": "application/json",
    },
    ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
  });
}

function fixture(route: RouteCase) {
  const effects: string[] = [];
  const pending: Promise<unknown>[] = [];
  const unexpected = async (): Promise<never> => {
    throw new Error("unexpected-routing-effect");
  };
  const failAt = (effect: string): never => {
    effects.push(effect);
    throw new AuthApiFailure(409, "failed-precondition", effect);
  };
  const repository: GameplayRepository = {
    applyWagerTransferOnce: unexpected,
    deleteNavigationGame: async (profileId, inviteId) => {
      assert.deepEqual([profileId, inviteId], ["profile", "invite"]);
      effects.push("navigation-delete");
      return "deleted";
    },
    getNavigationGame: async () => ({ status: "waiting" }),
    getMiningMaterials: unexpected,
    getMiningSnapshot: unexpected,
    patchStateRoot: unexpected,
    transactStatePath: unexpected,
    readInviteMetadata: async (inviteId) => {
      assert.equal(inviteId, "invite");
      if (route.path === "/invites/role/read") effects.push("invite-role");
      return {
        hostId: uid,
        guestId:
          route.path === "/navigation/games/remove" ? null : "opponent-uid",
      };
    },
    readProfileOwnershipSnapshot: async (query) => ({
      canonicalProfileIdByProfileId: new Map(
        query.profileIds.map((id) => [id, id]),
      ),
      loginOwnerByUid: new Map(
        query.loginUids.map((id) => [
          id,
          { profileId: "profile", revision: 1 },
        ]),
      ),
      loginUidsByProfileId: new Map([["profile", [...query.loginUids]]]),
      profileById: new Map([
        [
          "profile",
          {
            revision: 1,
            profile: {
              profileId: "profile",
              aura: "",
              emoji: 1,
              eth: "",
              sol: "",
              username: "",
              rating: 0,
            },
          },
        ],
      ]),
    }),
    getStatePath: async (path, query) => {
      if (path === "automatch") {
        assert.equal(query?.equalTo, uid);
        return failAt("automatch-queues");
      }
      if (path === "automatch/invite") return null;
      assert.equal(path, `gameplayMutationReceipts/${operationId}`);
      effects.push(route.effect);
      if (route.path === "/automatch/start") {
        return {
          schemaVersion: 1,
          kind: "automatch-start",
          operationId,
          requesterUid: uid,
          inviteId: "auto_invite",
          completedAtMs: 1,
          ...presentation,
          profileProjectionRequestId: null,
          telegramProjection: false,
          response: route.response,
        };
      }
      assert.ok(route.receipt);
      return {
        schemaVersion: 1,
        ...operation,
        inviteId: route.body.inviteId,
        ...route.receipt,
        requesterUid: uid,
        completedAtMs: 1,
        projectionRequestId: null,
        response: route.response,
      };
    },
    automatchPersistence: createAutomatchPersistenceStub(),
  };
  const ratingRepository: RatingRepository = {
    ...repository,
    getStatePath: async (path) => {
      assert.equal(path, "invites/auto_invite");
      return { hostId: uid, guestId: "opponent-uid" };
    },
    hasCompletedRatingUpdate: async (inviteId, matchId) => {
      assert.deepEqual([inviteId, matchId], ["auto_invite", "auto_invite"]);
      return failAt("rating-completion");
    },
    applyFebruaryChallengeReplay: unexpected,
    finalizeRatingUpdate: unexpected,
    readRatingUpdate: unexpected,
    tryAcquireRatingLease: unexpected,
  };
  const dependencies: GameplayRouteDependencies = {
    repository,
    ratingRepository,
    coordination: createMemoryGameplayCoordinationStores(),
    verifyIdentity: async () => ({ uid }),
    logFailure: (kind) => {
      effects.push(`unexpected-failure:${kind}`);
    },
    readNavigationPage: async (_db, profileId, limit, cursor) => {
      assert.deepEqual([profileId, limit, cursor], ["profile", 3, null]);
      effects.push("navigation-page");
      return { ok: true, items: [], nextCursor: null, hasMore: false };
    },
    move: {
      submitCanonical: async (body) => {
        assert.deepEqual(body, route.body);
        return failAt("canonical-move");
      },
    },
    surrender: {
      surrenderCanonical: async (body) => {
        assert.deepEqual(body, route.body);
        return failAt("canonical-surrender");
      },
    },
    timer: {
      startCanonical: async (body) => {
        assert.deepEqual(body, route.body);
        return failAt("canonical-timer-start");
      },
      claimCanonical: async (body) => {
        assert.deepEqual(body, route.body);
        return failAt("canonical-timer-claim");
      },
    },
    wagerReservations: {
      assertClientVersion: async () => undefined,
      readBalance: async (playerUid) => {
        assert.equal(playerUid, uid);
        effects.push("frozen-balance");
        return { frozen: materials, revision: 7 };
      },
      run: async (kind) => failAt(kind),
    },
  };
  return {
    dependencies,
    effects,
    pending,
    context: {
      waitUntil: (work: Promise<unknown>) => {
        pending.push(work);
      },
    },
  };
}

test("top-level router dispatches every gameplay endpoint to its domain behavior", async (t) => {
  for (const route of routes) {
    await t.test(route.path, async () => {
      const f = fixture(route);
      const path =
        route.path === "/automatch/start"
          ? `${route.path}?operationId=${operationId}`
          : route.path;
      const response = await handleRequest(
        request(path, route.body),
        TELEGRAM_TEST_ENV,
        { gameplay: f.dependencies },
        f.context,
      );
      await Promise.all(f.pending);
      assert.equal(response.status, route.response ? 200 : 409);
      assert.deepEqual(
        await response.json(),
        route.response || {
          ok: false,
          error: "failed-precondition",
          message: route.effect,
        },
      );
      assert.deepEqual(f.effects, [route.effect]);
      assert.equal(
        response.headers.get("Access-Control-Allow-Origin"),
        "https://mons.link",
      );
      assert.equal(response.headers.get("Cache-Control"), "no-store");
    });
  }
});

function withMatchControl(state: "frozen" | "unreadable") {
  let reads = 0;
  const base = TELEGRAM_TEST_ENV.PROFILE_GAMES_DB;
  const prepare = (query: string): D1PreparedStatement => {
    const statement = base.prepare(query);
    if (!query.includes("match_state_control")) return statement;
    return {
      all: statement.all.bind(statement),
      bind: statement.bind.bind(statement),
      raw: statement.raw.bind(statement),
      run: statement.run.bind(statement),
      first: async <T>() => {
        reads += 1;
        if (state === "unreadable") throw new Error("database-unavailable");
        return {
          backend: "durable",
          state,
          epoch: 2,
          freeze_generation: 0,
        } as T;
      },
    };
  };
  const db: D1Database = {
    ...base,
    prepare,
    withSession: () => ({
      prepare,
      batch: base.batch,
      getBookmark: () => null,
    }),
  };
  return {
    env: { ...TELEGRAM_TEST_ENV, PROFILE_GAMES_DB: db },
    reads: () => reads,
  };
}

const readPaths = new Set([
  "/wagers/frozen/read",
  "/invites/role/read",
  "/navigation/games/read",
]);
const unknownPaths = [
  "/matches/move/extra",
  "/invites/role",
  "/navigation/games",
  "/wagers/proposals/unknown",
];

for (const state of ["frozen", "unreadable"] as const) {
  test(`top-level router blocks all gameplay mutations before authentication when match control is ${state}`, async (t) => {
    for (const route of routes.filter(({ path }) => !readPaths.has(path))) {
      await t.test(route.path, async () => {
        const control = withMatchControl(state);
        let authenticated = false;
        const response = await handleRequest(
          request(route.path),
          control.env,
          {
            gameplay: {
              verifyIdentity: async () => {
                authenticated = true;
                throw new Error("unexpected-authentication");
              },
            },
          },
          { waitUntil: () => undefined },
        );
        assert.equal(response.status, 503);
        assert.deepEqual(await response.json(), {
          ok: false,
          error: "unavailable",
          message:
            state === "frozen"
              ? "match-state-writes-disabled"
              : "match-state-control-unavailable",
        });
        assert.equal(control.reads(), 1);
        assert.equal(authenticated, false);
        assert.equal(response.headers.get("Retry-After"), "60");
        assert.equal(
          response.headers.get("Access-Control-Allow-Origin"),
          "https://mons.link",
        );
      });
    }
  });
}

test("reads, preflights, other methods, and nearby unknown paths bypass match mutation authority", async (t) => {
  const cases = [
    ...[...readPaths].map((path) => ({
      path,
      method: "POST",
      status: 401,
      authenticate: true,
    })),
    ...routes.flatMap(({ path }) => [
      { path, method: "OPTIONS", status: 204, authenticate: false },
      { path, method: "GET", status: 405, authenticate: false },
    ]),
    ...unknownPaths.map((path) => ({
      path,
      method: "POST",
      status: 404,
      authenticate: false,
    })),
  ];
  for (const entry of cases) {
    await t.test(`${entry.method} ${entry.path}`, async () => {
      const control = withMatchControl("unreadable");
      let authenticated = false;
      const response = await handleRequest(
        request(entry.path, {}, entry.method),
        control.env,
        {
          gameplay: {
            verifyIdentity: async () => {
              authenticated = true;
              throw new AuthApiFailure(
                401,
                "unauthenticated",
                "test-authentication",
              );
            },
          },
        },
        { waitUntil: () => undefined },
      );
      assert.equal(response.status, entry.status);
      assert.equal(control.reads(), 0);
      assert.equal(authenticated, entry.authenticate);
      assert.equal(response.headers.get("Retry-After"), null);
      if (entry.status === 404)
        assert.deepEqual(await response.json(), {
          ok: false,
          error: "not-found",
        });
    });
  }
});

test("gameplay request normalization preserves trimmed identifiers and domain payloads", async (t) => {
  const cases = [
    ...["/matches/timer/start", "/matches/timer/claim", "/ratings/update"].map(
      (path) => ({ path, body: timerRequest }),
    ),
    ...[
      "/wagers/proposals/accept",
      "/wagers/proposals/cancel",
      "/wagers/proposals/decline",
      "/wagers/outcomes/resolve",
    ].map((path) => ({ path, body: wagerRequest })),
    {
      path: "/wagers/proposals/send",
      body: { ...wagerRequest, material: "dust", count: 2 },
    },
    { path: "/navigation/games/remove", body: { inviteId: "invite" } },
  ];
  for (const entry of cases) {
    await t.test(entry.path, async () => {
      const padded = Object.fromEntries(
        Object.entries(entry.body).map(([key, value]) => [
          key,
          key.endsWith("Id") ? ` ${value} ` : value,
        ]),
      );
      assert.deepEqual(
        await readGameplayBody(request(entry.path, padded), entry.path),
        entry.body,
      );
    });
  }
});
