import { inviteDocumentFixture } from "./inviteDocumentFixture.ts";
import { retainedInviteSourceFixture } from "./inviteDocumentFixture.ts";
import type { MatchStateRecord } from "../src/matchStateTypes.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { isHistoricalMatchPair } from "@mons/shared/game-sessions";
import {
  MAX_MATCH_FEN_BYTES,
  MAX_MATCH_HISTORY_ENTRIES,
} from "@mons/shared/match-protocol";
import { MATCH_TIMER_TERMINAL } from "@mons/shared/timers";
import { Color, Game } from "mons-rules";
import { AuthApiFailure } from "../src/authErrors.ts";
import type { RequestIdentity } from "../src/requestIdentity.ts";
import type {
  RatingCommitPlan,
  RatingProfile,
  RatingRepository,
  RatingUpdateData,
} from "../src/ratingContracts.ts";
import type {
  ProfileOwnershipQuery,
  ProfileOwnershipSnapshot,
} from "../src/profileOwnership.ts";
import {
  FEB_CHALLENGE_END_UTC,
  FEB_CHALLENGE_START_UTC,
  buildRatingPlan,
  readMatchRecord,
  resolveRatingResult,
  updateRatings as updateRatingsImpl,
  type RatingUpdateDependencies,
} from "../src/ratingUpdate.ts";
import { createMemoryGameplayCoordinationStores } from "./gameplayCoordinationTestUtils.ts";

const request = {
  playerId: "player",
  opponentId: "opponent",
  inviteId: "auto_aaaaaaaaaaa",
  matchId: "auto_aaaaaaaaaaa",
};

const identity: RequestIdentity = {
  uid: "player",
};

type RatingDependencyOverrides = Omit<RatingUpdateDependencies, "timerStarts">;

const coordinationByRepository = new WeakMap<
  RatingRepository,
  ReturnType<typeof createMemoryGameplayCoordinationStores>
>();

function coordination(repository: RatingRepository) {
  let stores = coordinationByRepository.get(repository);
  if (!stores) {
    stores = createMemoryGameplayCoordinationStores();
    coordinationByRepository.set(repository, stores);
  }
  return stores;
}

function updateRatings(
  actor: RequestIdentity,
  ratingRequest: typeof request,
  repository: RatingRepository,
  dependencies: RatingDependencyOverrides = {},
) {
  return updateRatingsImpl(actor, ratingRequest, repository, {
    ...dependencies,
    timerStarts: coordination(repository).timerStarts,
  });
}

function match(
  color: "white" | "black",
  overrides: Record<string, unknown> = {},
) {
  return {
    color,
    emojiId: color === "white" ? 1 : 2,
    fen: new Game().toFen(),
    flatMovesString: "move",
    status: "",
    timer: "",
    ...overrides,
  };
}

function historicalMatchPair() {
  const fen = new Game().toFen();
  return {
    matchId: request.matchId,
    hostPlayerId: request.playerId,
    guestPlayerId: request.opponentId,
    hostMatch: {
      version: 2,
      color: "white" as const,
      emojiId: 1,
      aura: "",
      gameVariant: "Classic",
      fen,
      status: "",
      flatMovesString: "move",
      timer: "",
    },
    guestMatch: {
      version: 2,
      color: "black" as const,
      emojiId: 2,
      aura: "",
      gameVariant: "Classic",
      fen,
      status: "surrendered",
      flatMovesString: "move",
      timer: "",
    },
  };
}

function profile(
  profileId: string,
  overrides: Partial<RatingProfile> = {},
): RatingProfile {
  return {
    aura: "",
    emoji: 1,
    eth: "",
    nonce: 4,
    profileId,
    rating: profileId.endsWith("player") ? 1500 : 1400,
    sol: "",
    totalManaPoints: 10,
    username: profileId.endsWith("player") ? "Alice" : "Bob",
    ...overrides,
  };
}

function ratingPlan(
  overrides: Partial<Parameters<typeof buildRatingPlan>[0]> = {},
) {
  return buildRatingPlan({
    historicalMatchPair: historicalMatchPair(),
    invite: inviteDocumentFixture({}),
    matchId: request.matchId,
    nowMs: Date.UTC(2026, 7, 21),
    player: profile("profile-player"),
    opponent: profile("profile-opponent", { nonce: 8 }),
    playerMatch: match("white"),
    opponentMatch: match("black"),
    request,
    result: "win",
    ...overrides,
  });
}

function completedData(
  overrides: Partial<RatingUpdateData> = {},
): RatingUpdateData {
  return {
    inviteId: request.inviteId,
    leaseExpiresAtMs: 1_000,
    matchId: request.matchId,
    opponentId: request.opponentId,
    opponentProfileId: "profile-opponent",
    ownerToken: "owner-token",
    playerId: request.playerId,
    playerProfileId: "profile-player",
    shouldUpdateFebruaryChallenge: false,
    startedAtMs: 100,
    status: "done",
    ...overrides,
  };
}

function ownershipSnapshot(
  query: ProfileOwnershipQuery,
  playerProfile: RatingProfile | null,
  opponentProfile: RatingProfile | null,
): ProfileOwnershipSnapshot {
  const ownerByUid: Record<string, RatingProfile | null> = {
    [request.playerId]: playerProfile,
    "alternate-login": playerProfile,
    [request.opponentId]: opponentProfile,
  };
  const loginOwnerByUid = new Map(
    query.loginUids.map((uid) => {
      const owner = ownerByUid[uid];
      return [
        uid,
        owner ? { profileId: owner.profileId, revision: 1 } : null,
      ] as const;
    }),
  );
  const profiles = new Map(
    [playerProfile, opponentProfile].flatMap((value) =>
      value ? [[value.profileId, value] as const] : [],
    ),
  );
  const requestedProfileIds = new Set(
    [...loginOwnerByUid.values()].flatMap((owner) =>
      owner ? [owner.profileId] : [],
    ),
  );
  return {
    canonicalProfileIdByProfileId: new Map(),
    loginOwnerByUid,
    loginUidsByProfileId: new Map(
      [...requestedProfileIds].map((profileId) => [
        profileId,
        Object.entries(ownerByUid)
          .filter(([, value]) => value?.profileId === profileId)
          .map(([uid]) => uid)
          .sort(),
      ]),
    ),
    profileById: new Map(
      [...requestedProfileIds].map((profileId) => {
        const value = profiles.get(profileId);
        if (!value) throw new Error("missing-test-profile");
        return [profileId, { profile: value, revision: 1 }];
      }),
    ),
  };
}

function createRepository({
  completed = false,
  invite = {
    hostId: request.playerId,
    guestId: request.opponentId,
    telegramDeliveryVersion: 2,
  },
  failMatchReads = false,
  leaseStatus = "acquired" as "acquired" | "busy" | "done",
  playerProfile = profile("profile-player"),
  opponentProfile = profile("profile-opponent"),
  playerMatchValue = match("white"),
  opponentMatchValue = match("black", { status: "surrendered" }),
  ratingDone = completed,
}: {
  completed?: boolean;
  failMatchReads?: boolean;
  invite?: unknown;
  leaseStatus?: "acquired" | "busy" | "done";
  playerProfile?: RatingProfile | null;
  opponentProfile?: RatingProfile | null;
  playerMatchValue?: unknown;
  opponentMatchValue?: unknown;
  ratingDone?: boolean;
} = {}) {
  const patches: Record<string, unknown>[] = [];
  let attempts = 0;
  let finalPlan: RatingCommitPlan | null = null;
  let finalized = 0;
  let operationReads = 0;
  const repository: RatingRepository = {
    applyFebruaryChallengeReplay: async () => undefined,
    finalizeRatingUpdate: async (_input, buildPlan) => {
      finalized++;
      finalPlan = buildPlan(playerProfile, opponentProfile);
      return { status: "committed", data: finalPlan.repairData };
    },
    readInviteMetadata: async () =>
      retainedInviteSourceFixture(invite as Record<string, unknown> | null),
    readMatchRecord: async ({ playerId }) => {
      if (failMatchReads) throw new Error("match-read-failed");
      return (
        playerId === request.playerId ? playerMatchValue : opponentMatchValue
      ) as MatchStateRecord | null;
    },
    async readMatchPair(input) {
      return {
        ...input,
        epoch: 1,
        revision: 1,
        claim: null,
        playerMatch: (await this.readMatchRecord(input)) as
          import("../src/matchStateTypes.ts").MatchStateRecord | null,
        opponentMatch: input.opponentId
          ? ((await this.readMatchRecord({
              playerId: input.opponentId,
              matchId: input.matchId,
            })) as import("../src/matchStateTypes.ts").MatchStateRecord | null)
          : null,
      };
    },
    putEventProgressOutbox: async (outboxId, record) => {
      patches.push({ [`eventProgressOutbox/${outboxId}`]: record });
    },
    hasCompletedRatingUpdate: async (inviteId, matchId) => {
      assert.equal(inviteId, request.inviteId);
      assert.equal(matchId, request.matchId);
      return completed || ratingDone;
    },
    readProfileOwnershipSnapshot: async (query) =>
      ownershipSnapshot(query, playerProfile, opponentProfile),
    readRatingUpdate: async () => {
      operationReads++;
      return ratingDone ? completedData() : null;
    },
    tryAcquireRatingLease: async () => {
      attempts++;
      return {
        status: leaseStatus,
        data: leaseStatus === "done" ? completedData() : null,
      };
    },
  };
  return {
    repository,
    patches,
    getAttempts: () => attempts,
    getFinalPlan: () => finalPlan,
    getFinalized: () => finalized,
    getOperationReads: () => operationReads,
  };
}

test("builds exact non-event rating, mana, and Telegram fields", () => {
  const player = profile("profile-player", { nonce: 4, rating: 1500 });
  const opponent = profile("profile-opponent", { nonce: 8, rating: 1400 });
  const playerMatch = match("white");
  const opponentMatch = match("black", { status: "surrendered" });
  const nowMs = Date.UTC(2026, 7, 21);
  const historical = historicalMatchPair();
  const result = buildRatingPlan({
    historicalMatchPair: historical,
    invite: inviteDocumentFixture({
      telegramDeliveryVersion: 2,
      wagers: {
        [request.matchId]: {
          agreed: { material: "dust", count: 3 },
        },
      },
    }),
    matchId: request.matchId,
    nowMs,
    opponent,
    opponentMatch,
    player,
    playerMatch,
    request,
    result: "win",
  });
  const expected: RatingCommitPlan = {
    playerUpdate: { rating: 1631, nonce: 5, win: true, totalManaPoints: 10 },
    opponentUpdate: { rating: 1272, nonce: 9, win: false, totalManaPoints: 10 },
    repairData: {
      playerProfileId: "profile-player",
      opponentProfileId: "profile-opponent",
      shouldUpdateFebruaryChallenge: false,
    },
    ratingUpdate: {
      inviteId: request.inviteId,
      matchId: request.matchId,
      playerId: request.playerId,
      opponentId: request.opponentId,
      status: "done",
      historicalMatchArchiveVersion: 1,
      historicalMatchPair: historical,
      result: "win",
      canUpdateRatings: true,
      didApplyRatingDelta: true,
      winnerDisplayName: "Alice",
      loserDisplayName: "Bob",
      winnerNewRating: 1631,
      loserNewRating: 1272,
      playerManaPoints: 0,
      opponentManaPoints: 0,
      shouldUpdateFebruaryChallenge: false,
      playerProfileId: "profile-player",
      opponentProfileId: "profile-opponent",
      profileGameProjectionVersion: 1,
      profileGameProjectionState: "pending",
      profileGameProjectionUpdatedAtMs: nowMs,
      profileGameProjectionReason: null,
      updateRatingMessage:
        'Alice 1631↑ Bob 1272↓ (0 - 0) <tg-emoji emoji-id="5228702136862282659">&#11088;</tg-emoji> <tg-emoji emoji-id="5235835141238063097">&#11088;</tg-emoji> 3',
      telegramDeliveryVersion: 2,
      telegramProjectionVersion: 1,
      telegramProjectionState: "pending",
      telegramProjectionUpdatedAtMs: nowMs,
      telegramProjectionReason: null,
      isEventMatch: false,
      eventOwned: false,
      eventId: null,
      updatedAtMs: nowMs,
      completedAtMs: nowMs,
      leaseExpiresAtMs: nowMs,
    },
  };
  assert.deepEqual(result, expected);
  assert.equal(JSON.stringify(result), JSON.stringify(expected));
  assert.equal(result.ratingUpdate.historicalMatchPair, historical);
});

test("event ratings preserve win and mana without applying a rating delta", () => {
  const historical = historicalMatchPair();
  const nowMs = FEB_CHALLENGE_START_UTC + 1;
  const built = buildRatingPlan({
    historicalMatchPair: historical,
    invite: inviteDocumentFixture({ eventOwned: true, eventId: "event-1" }),
    matchId: request.matchId,
    nowMs,
    opponent: profile("profile-opponent"),
    opponentMatch: match("black", { timer: MATCH_TIMER_TERMINAL }),
    player: profile("profile-player"),
    playerMatch: match("white"),
    request,
    result: "gg",
  });
  const expected: RatingCommitPlan = {
    playerUpdate: { nonce: 5, win: false, totalManaPoints: 10 },
    opponentUpdate: { nonce: 5, win: true, totalManaPoints: 10 },
    repairData: {
      playerProfileId: "profile-player",
      opponentProfileId: "profile-opponent",
      shouldUpdateFebruaryChallenge: false,
    },
    ratingUpdate: {
      inviteId: request.inviteId,
      matchId: request.matchId,
      playerId: request.playerId,
      opponentId: request.opponentId,
      status: "done",
      historicalMatchArchiveVersion: 1,
      historicalMatchPair: historical,
      result: "gg",
      canUpdateRatings: true,
      didApplyRatingDelta: false,
      winnerDisplayName: "Bob",
      loserDisplayName: "Alice",
      winnerNewRating: null,
      loserNewRating: null,
      playerManaPoints: 0,
      opponentManaPoints: 0,
      shouldUpdateFebruaryChallenge: false,
      playerProfileId: "profile-player",
      opponentProfileId: "profile-opponent",
      profileGameProjectionVersion: 1,
      profileGameProjectionState: "pending",
      profileGameProjectionUpdatedAtMs: nowMs,
      profileGameProjectionReason: null,
      updateRatingMessage:
        'Bob ↑ Alice (0 - 0) <tg-emoji emoji-id="5229098317530568280">&#11088;</tg-emoji>',
      telegramDeliveryVersion: null,
      eventProgressVersion: 1,
      eventProgressState: "pending",
      eventProgressUpdatedAtMs: nowMs,
      eventProgressReason: null,
      isEventMatch: true,
      eventOwned: true,
      eventId: "event-1",
      updatedAtMs: nowMs,
      completedAtMs: nowMs,
      leaseExpiresAtMs: nowMs,
    },
  };
  assert.deepEqual(built, expected);
  assert.equal(JSON.stringify(built), JSON.stringify(expected));
});

test("preserves Telegram wording, fallback names, and terminal marker precedence", () => {
  const cases: Array<{
    input: Partial<Parameters<typeof buildRatingPlan>[0]>;
    message: string;
  }> = [
    { input: {}, message: "Alice 1631↑ Bob 1272↓ (0 - 0)" },
    {
      input: {
        result: "gg",
        opponentMatch: match("black", { timer: MATCH_TIMER_TERMINAL }),
      },
      message:
        'Bob 1589↑ Alice 1307↓ (0 - 0) <tg-emoji emoji-id="5229098317530568280">&#11088;</tg-emoji>',
    },
    {
      input: {
        playerMatch: match("white", { timer: MATCH_TIMER_TERMINAL }),
        opponentMatch: match("black", { status: "surrendered" }),
      },
      message:
        'Alice 1631↑ Bob 1272↓ (0 - 0) <tg-emoji emoji-id="5228702136862282659">&#11088;</tg-emoji>',
    },
    {
      input: {
        player: profile("profile-player", {
          username: "",
          eth: "0x1234567890123456789012345678901234567890",
          sol: "ignored-sol-address",
          emoji: "",
        }),
        opponent: profile("profile-opponent", {
          nonce: 8,
          username: "",
          sol: "Abcdefghijklmnopqrstuvwxyz123456789",
        }),
      },
      message: "0x12...7890 1631↑ Abcd...6789 1272↓ (0 - 0)",
    },
    {
      input: {
        player: profile("profile-player", { username: "<b>Alice & A</b>" }),
        opponent: profile("profile-opponent", { nonce: 8, username: "" }),
      },
      message: "<b>Alice & A</b> 1631↑ anon 1272↓ (0 - 0)",
    },
  ];
  for (const { input, message } of cases) {
    assert.equal(ratingPlan(input).ratingUpdate.updateRatingMessage, message);
  }
});

test("preserves wager message coercion and the explicit wager match key", () => {
  for (const [material, emojiId] of [
    ["dust", "5235835141238063097"],
    ["slime", "5235497595463303384"],
    ["gum", "5233425978117621609"],
    ["metal", "5235794850149863190"],
    ["ice", "5233743994676086020"],
  ]) {
    const built = ratingPlan({
      matchId: "wager-match",
      invite: inviteDocumentFixture({
        wagers: {
          "wager-match": {
            agreed: { material: ` ${material} `, count: "2.5" },
          },
          [request.matchId]: { agreed: { material: "dust", count: 99 } },
        },
      }),
    });
    assert.equal(
      built.ratingUpdate.updateRatingMessage,
      `Alice 1631↑ Bob 1272↓ (0 - 0) <tg-emoji emoji-id="${emojiId}">&#11088;</tg-emoji> 3`,
    );
    assert.equal(built.ratingUpdate.matchId, request.matchId);
  }
  for (const agreed of [
    { material: "unknown", count: 3 },
    ...[0, -1, Infinity, "invalid", null].map((count) => ({
      material: "dust",
      count,
    })),
  ]) {
    assert.equal(
      ratingPlan({
        invite: inviteDocumentFixture({
          wagers: { [request.matchId]: { agreed } },
        }),
      }).ratingUpdate.updateRatingMessage,
      "Alice 1631↑ Bob 1272↓ (0 - 0)",
    );
  }
});

test("keeps the February challenge interval and next-nonce rating inputs", () => {
  assert.equal(FEB_CHALLENGE_START_UTC, Date.UTC(2026, 1, 1));
  assert.equal(FEB_CHALLENGE_END_UTC, Date.UTC(2026, 2, 1));
  for (const [nowMs, eligible] of [
    [FEB_CHALLENGE_START_UTC - 1, false],
    [FEB_CHALLENGE_START_UTC, true],
    [FEB_CHALLENGE_END_UTC - 1, true],
    [FEB_CHALLENGE_END_UTC, false],
  ] as const) {
    const built = ratingPlan({ nowMs });
    assert.equal(built.repairData.shouldUpdateFebruaryChallenge, eligible);
    assert.equal(built.ratingUpdate.shouldUpdateFebruaryChallenge, eligible);
  }
  for (const missingMoves of ["player", "opponent"] as const) {
    const built = ratingPlan({
      nowMs: FEB_CHALLENGE_START_UTC,
      playerMatch: match("white", {
        flatMovesString: missingMoves === "player" ? "" : "move",
      }),
      opponentMatch: match("black", {
        flatMovesString: missingMoves === "opponent" ? "" : "move",
      }),
    });
    assert.deepEqual(built.playerUpdate, {
      rating: 1631,
      nonce: 4,
      win: true,
      totalManaPoints: 10,
    });
    assert.deepEqual(built.opponentUpdate, {
      rating: 1272,
      nonce: 8,
      win: false,
      totalManaPoints: 10,
    });
    assert.equal(built.repairData.shouldUpdateFebruaryChallenge, false);
    assert.equal(built.ratingUpdate.shouldUpdateFebruaryChallenge, false);
  }
});

test("preserves event eligibility and omitted projection keys", () => {
  for (const invite of [
    { eventId: " event-1 ", telegramDeliveryVersion: 2 },
    { eventOwned: true, telegramDeliveryVersion: 2 },
  ]) {
    const built = ratingPlan({
      invite: inviteDocumentFixture(invite),
      nowMs: FEB_CHALLENGE_START_UTC,
    });
    assert.equal(built.ratingUpdate.isEventMatch, true);
    assert.equal(built.ratingUpdate.didApplyRatingDelta, false);
    assert.equal(built.ratingUpdate.telegramDeliveryVersion, null);
    assert.equal(built.repairData.shouldUpdateFebruaryChallenge, false);
    assert.equal(Object.hasOwn(built.playerUpdate!, "rating"), false);
    assert.equal(Object.hasOwn(built.opponentUpdate!, "rating"), false);
    assert.equal(
      Object.keys(built.ratingUpdate).some(
        (key) =>
          key.startsWith("telegramProjection") ||
          key.startsWith("eventProgress"),
      ),
      false,
    );
  }
  const legacy = ratingPlan();
  assert.equal(legacy.ratingUpdate.telegramDeliveryVersion, null);
  assert.equal(
    Object.keys(legacy.ratingUpdate).some((key) =>
      key.startsWith("telegramProjection"),
    ),
    false,
  );
});

test("completes rating records without profile writes when profiles are absent", () => {
  const built = buildRatingPlan({
    historicalMatchPair: historicalMatchPair(),
    invite: inviteDocumentFixture({}),
    matchId: request.matchId,
    nowMs: Date.UTC(2026, 7, 21),
    opponent: null,
    opponentMatch: match("black", { status: "surrendered" }),
    player: null,
    playerMatch: match("white"),
    request,
    result: "win",
  });
  assert.equal(built.playerUpdate, null);
  assert.equal(built.opponentUpdate, null);
  assert.equal(built.ratingUpdate.canUpdateRatings, false);
  assert.equal(built.ratingUpdate.didApplyRatingDelta, false);
  assert.equal(built.ratingUpdate.status, "done");
});

test("completes merged-profile ratings without profile or challenge writes", () => {
  const built = buildRatingPlan({
    historicalMatchPair: historicalMatchPair(),
    invite: inviteDocumentFixture({}),
    matchId: request.matchId,
    nowMs: FEB_CHALLENGE_START_UTC + 1,
    opponent: profile("shared-profile", { username: "Bob" }),
    opponentMatch: match("black", { status: "surrendered" }),
    player: profile("shared-profile", { username: "Alice" }),
    playerMatch: match("white"),
    request,
    result: "win",
  });
  assert.equal(built.playerUpdate, null);
  assert.equal(built.opponentUpdate, null);
  assert.equal(built.ratingUpdate.status, "done");
  assert.equal(built.ratingUpdate.canUpdateRatings, false);
  assert.equal(built.ratingUpdate.didApplyRatingDelta, false);
  assert.equal(built.repairData.shouldUpdateFebruaryChallenge, false);
});

test("resolves surrender and timer outcomes for both players", () => {
  assert.equal(
    resolveRatingResult(
      match("white"),
      match("black", { status: "surrendered" }),
    ),
    "win",
  );
  assert.equal(
    resolveRatingResult(
      match("white", { status: "surrendered" }),
      match("black"),
    ),
    "gg",
  );
  assert.equal(
    resolveRatingResult(
      match("white", { timer: MATCH_TIMER_TERMINAL }),
      match("black"),
    ),
    "win",
  );
  assert.equal(
    resolveRatingResult(
      match("white"),
      match("black", { timer: MATCH_TIMER_TERMINAL }),
    ),
    "gg",
  );
});

test("scores a surrender from the valid match replica", () => {
  const playerMatch = readMatchRecord(match("white", { fen: undefined }));
  const opponentMatch = readMatchRecord(
    match("black", { status: "surrendered" }),
  );
  const built = buildRatingPlan({
    historicalMatchPair: historicalMatchPair(),
    invite: inviteDocumentFixture({}),
    matchId: request.matchId,
    nowMs: Date.UTC(2026, 7, 21),
    opponent: profile("profile-opponent"),
    opponentMatch,
    player: profile("profile-player"),
    playerMatch,
    request,
    result: "win",
  });
  assert.equal(built.ratingUpdate.status, "done");
});

test("rejects oversized rating match state before rules parsing", () => {
  assert.throws(
    () =>
      readMatchRecord(
        match("white", { fen: "x".repeat(MAX_MATCH_FEN_BYTES + 1) }),
      ),
    (error: unknown) => error instanceof AuthApiFailure && error.status === 409,
  );
  assert.throws(
    () =>
      readMatchRecord(
        match("white", {
          flatMovesString: `${"x-".repeat(MAX_MATCH_HISTORY_ENTRIES)}x`,
        }),
      ),
    (error: unknown) => error instanceof AuthApiFailure && error.status === 409,
  );
});

test("resolves a normally completed game through mons-rules", () => {
  const game = new Game();
  const moves = { white: [] as string[], black: [] as string[] };
  for (let turn = 0; turn < 400 && game.winner === undefined; turn++) {
    const suggestion = game.suggestMove("fast");
    assert.ok(suggestion);
    moves[game.activeColor === Color.White ? "white" : "black"].push(
      suggestion.inputFen,
    );
    game.playFen(suggestion.inputFen);
  }
  assert.ok(game.winner === Color.White || game.winner === Color.Black);
  const playerColor = game.winner === Color.White ? "white" : "black";
  const opponentColor = playerColor === "white" ? "black" : "white";
  const fen = game.toFen();
  assert.equal(
    resolveRatingResult(
      match(playerColor, {
        fen,
        flatMovesString: moves[playerColor].join("-"),
      }),
      match(opponentColor, {
        fen,
        flatMovesString: moves[opponentColor].join("-"),
      }),
    ),
    "win",
  );
});

test("updates once without writing Firebase rating markers", async () => {
  const state = createRepository();
  for (const playerId of [request.playerId, request.opponentId]) {
    coordination(state.repository).timerRows.set(
      `${playerId}/${request.matchId}`,
      {
        timer: "7;1000",
        turnNumber: 7,
        updatedAtMs: 1,
      },
    );
  }
  const projectionTasks: unknown[] = [];
  assert.deepEqual(
    await updateRatings(identity, request, state.repository, {
      createOwnerToken: () => "owner-token",
      enqueueTelegramProjection: async (task) => {
        projectionTasks.push(task);
      },
      enqueueProfileGameProjection: async (task) => {
        projectionTasks.push(task);
      },
      now: () => Date.UTC(2026, 7, 21),
    }),
    { ok: true },
  );
  assert.equal(state.getFinalized(), 1);
  assert.equal(state.getAttempts(), 1);
  assert.equal(state.getFinalPlan()?.ratingUpdate.status, "done");
  assert.equal(
    state.getFinalPlan()?.ratingUpdate.historicalMatchArchiveVersion,
    1,
  );
  const historical = state.getFinalPlan()?.ratingUpdate.historicalMatchPair;
  assert.equal(isHistoricalMatchPair(historical), true);
  assert.equal(state.getOperationReads(), 1);
  assert.deepEqual(projectionTasks, [
    {
      kind: "rating-profile-game-projection",
      operationId: `${request.inviteId}__${request.matchId}`,
    },
    {
      kind: "rating-telegram-projection",
      operationId: `${request.inviteId}__${request.matchId}`,
    },
  ]);
  assert.deepEqual(state.patches, []);
  assert.equal(coordination(state.repository).timerRows.size, 0);
});

test("freezes rating-valid matches with legacy presentation fields", async () => {
  const state = createRepository({
    playerMatchValue: match("white", {
      aura: "x".repeat(33),
      emojiId: 0,
      fen: undefined,
      status: "x".repeat(2_000),
      timer: "x".repeat(2_000),
    }),
  });
  assert.deepEqual(
    await updateRatings(identity, request, state.repository, {
      now: () => 2_000,
    }),
    { ok: true },
  );
  const frozen = state.getFinalPlan()?.ratingUpdate.historicalMatchPair;
  assert.ok(isHistoricalMatchPair(frozen));
  assert.ok(frozen.hostMatch);
  assert.equal(frozen.hostMatch.emojiId, 0);
  assert.equal(frozen.hostMatch.aura, "");
  assert.equal(frozen.hostMatch.fen, "");
  assert.equal(frozen.hostMatch.status, "");
  assert.equal(frozen.hostMatch.timer, "");
  assert.equal(frozen.guestMatch?.status, "surrendered");
});

test("event ratings persist and dispatch one deterministic progress outbox", async () => {
  const state = createRepository({
    invite: inviteDocumentFixture({
      hostId: request.playerId,
      guestId: request.opponentId,
      eventOwned: true,
      eventId: "event-1",
    }),
  });
  const progressPlans: Array<{
    outboxId: string;
    params: { sourceKey: string };
  }> = [];
  assert.deepEqual(
    await updateRatings(identity, request, state.repository, {
      createOwnerToken: () => "owner-token",
      enqueueEventProgress: async (plan) => {
        progressPlans.push(plan);
      },
      now: () => 2_000,
    }),
    { ok: true },
  );
  assert.equal(progressPlans.length, 1);
  assert.equal(
    progressPlans[0].params.sourceKey,
    `rating:${request.inviteId}:${request.matchId}`,
  );
  const update = state.patches[0];
  assert.equal(
    Object.hasOwn(update, `eventProgressOutbox/${progressPlans[0].outboxId}`),
    true,
  );
  assert.equal(
    state.getFinalPlan()?.ratingUpdate.eventProgressState,
    "pending",
  );
});

test("event ratings retain a pending recovery marker when match repair fails", async () => {
  const state = createRepository({
    invite: inviteDocumentFixture({
      hostId: request.playerId,
      guestId: request.opponentId,
      eventOwned: true,
      eventId: "event-1",
    }),
  });
  state.repository.putEventProgressOutbox = async () => {
    throw new Error("state-unavailable");
  };
  await assert.rejects(
    updateRatings(identity, request, state.repository, {
      createOwnerToken: () => "owner-token",
      now: () => 2_000,
    }),
    /state-unavailable/,
  );
  assert.equal(
    state.getFinalPlan()?.ratingUpdate.eventProgressState,
    "pending",
  );
  assert.equal(
    state.getFinalPlan()?.ratingUpdate.eventProgressUpdatedAtMs,
    2_000,
  );
});

test("rating queue failures preserve the committed response and pending state", async () => {
  const state = createRepository();
  const failures: string[] = [];
  assert.deepEqual(
    await updateRatings(identity, request, state.repository, {
      createOwnerToken: () => "owner-token",
      enqueueTelegramProjection: async () => {
        throw new Error("queue-unavailable");
      },
      enqueueProfileGameProjection: async () => {
        throw new Error("queue-unavailable");
      },
      logProfileGameProjectionFailure: (task) =>
        failures.push(`profile:${task.operationId}`),
      logProjectionFailure: (task) => failures.push(task.operationId),
      now: () => Date.UTC(2026, 7, 21),
    }),
    { ok: true },
  );
  assert.equal(
    state.getFinalPlan()?.ratingUpdate.telegramProjectionState,
    "pending",
  );
  assert.equal(
    state.getFinalPlan()?.ratingUpdate.profileGameProjectionState,
    "pending",
  );
  assert.deepEqual(failures, [
    `profile:${request.inviteId}__${request.matchId}`,
    `${request.inviteId}__${request.matchId}`,
  ]);
});

test("repairs completed replays without reacquiring or finalizing", async () => {
  const state = createRepository({ completed: true, failMatchReads: true });
  assert.deepEqual(await updateRatings(identity, request, state.repository), {
    ok: true,
  });
  assert.equal(state.getAttempts(), 0);
  assert.equal(state.getFinalized(), 0);
  assert.equal(state.getOperationReads(), 1);
  assert.equal(state.patches.length, 0);
});

test("replays the stored February challenge flag after the challenge has ended", async () => {
  const state = createRepository({ completed: true, failMatchReads: true });
  state.repository.readRatingUpdate = async () =>
    completedData({ shouldUpdateFebruaryChallenge: true });
  const steps: string[] = [];
  coordination(state.repository).timerStarts.deletePair = async () => {
    steps.push("timers");
  };
  state.repository.applyFebruaryChallengeReplay = async (...args) => {
    assert.deepEqual(args, ["profile-player", "profile-opponent"]);
    steps.push("challenge");
  };
  assert.deepEqual(
    await updateRatings(identity, request, state.repository, {
      now: () => Date.UTC(2026, 9, 23),
      assertMutationAllowed: async () => {
        steps.push("guard");
      },
    }),
    { ok: true },
  );
  assert.deepEqual(steps, ["guard", "timers", "challenge"]);
  assert.equal(state.getAttempts(), 0);
  assert.equal(state.getFinalized(), 0);
});

test("observed completions dispatch only pending projections in recovery order", async (t) => {
  const cases = [
    {
      name: "both pending",
      data: completedData({
        telegramProjectionState: "pending",
        profileGameProjectionState: "pending",
      }),
      expected: ["telegram", "profile"],
    },
    {
      name: "Telegram pending and profile done",
      data: completedData({
        telegramProjectionState: "pending",
        profileGameProjectionState: "done",
      }),
      expected: ["telegram"],
    },
    {
      name: "Telegram dead and profile pending",
      data: completedData({
        telegramProjectionState: "dead",
        profileGameProjectionState: "pending",
      }),
      expected: ["profile"],
    },
    {
      name: "completed projections",
      data: completedData({
        telegramProjectionState: "done",
        profileGameProjectionState: "dead",
      }),
      expected: [],
    },
    { name: "missing markers", data: completedData(), expected: [] },
    { name: "legacy completion", data: null, expected: [] },
  ];
  for (const entry of ["existing", "lease"] as const) {
    for (const scenario of cases) {
      await t.test(`${entry}: ${scenario.name}`, async () => {
        const state = createRepository({
          completed: entry === "existing",
          failMatchReads: entry === "existing",
          leaseStatus: "done",
        });
        const read = state.repository.readRatingUpdate;
        state.repository.readRatingUpdate = async (...args) => {
          await read(...args);
          return entry === "existing" ? scenario.data : null;
        };
        const acquire = state.repository.tryAcquireRatingLease;
        state.repository.tryAcquireRatingLease = async (...args) => ({
          ...(await acquire(...args)),
          data: scenario.data,
        });
        const steps: string[] = [];
        coordination(state.repository).timerStarts.deletePair = async () => {
          steps.push("timers");
        };
        assert.deepEqual(
          await updateRatings(identity, request, state.repository, {
            enqueueTelegramProjection: async () => {
              steps.push("telegram");
            },
            enqueueProfileGameProjection: async () => {
              steps.push("profile");
            },
          }),
          { ok: true },
        );
        assert.deepEqual(steps, ["timers", ...scenario.expected]);
        assert.equal(state.getAttempts(), entry === "existing" ? 0 : 1);
        assert.equal(state.getFinalized(), 0);
        assert.equal(state.getOperationReads(), 1);
      });
    }
  }
});

test("finalizer replays retain finalized projection eligibility and order", async (t) => {
  for (const status of ["committed", "replayed"] as const) {
    for (const kind of ["v2", "legacy", "event"] as const) {
      await t.test(`${status}: ${kind}`, async () => {
        const state = createRepository({
          invite: inviteDocumentFixture({
            hostId: request.playerId,
            guestId: request.opponentId,
            ...(kind !== "legacy" ? { telegramDeliveryVersion: 2 } : {}),
            ...(kind === "event"
              ? { eventOwned: true, eventId: "event-1" }
              : {}),
          }),
        });
        if (status === "replayed") {
          state.repository.finalizeRatingUpdate = async () => ({
            status: "replayed",
            data: completedData({
              telegramProjectionState: "done",
              profileGameProjectionState: "done",
            }),
          });
        }
        const dispatched: string[] = [];
        assert.deepEqual(
          await updateRatings(identity, request, state.repository, {
            enqueueEventProgress: async () => {
              dispatched.push("event");
            },
            enqueueTelegramProjection: async () => {
              dispatched.push("telegram");
            },
            enqueueProfileGameProjection: async () => {
              dispatched.push("profile");
            },
          }),
          { ok: true },
        );
        assert.deepEqual(
          dispatched,
          kind === "v2"
            ? ["profile", "telegram"]
            : kind === "event"
              ? ["event", "profile"]
              : ["profile"],
        );
        assert.equal(state.getAttempts(), 1);
      });
    }
  }
});

test("completion repairs finish before dispatch and stop on repair failures", async (t) => {
  for (const failure of [null, "outbox", "timers", "challenge"] as const) {
    await t.test(failure || "success", async () => {
      const state = createRepository({
        leaseStatus: "done",
        invite: inviteDocumentFixture({
          hostId: request.playerId,
          guestId: request.opponentId,
          ...(failure !== "challenge"
            ? { eventOwned: true, eventId: "event-1" }
            : {}),
        }),
      });
      const data = completedData({
        shouldUpdateFebruaryChallenge: failure === "challenge",
        telegramProjectionState: "pending",
        profileGameProjectionState: "pending",
      });
      const acquire = state.repository.tryAcquireRatingLease;
      state.repository.tryAcquireRatingLease = async (...args) => ({
        ...(await acquire(...args)),
        data,
      });
      const steps: string[] = [];
      const repairFailure = new Error("repair-failed");
      const recordRepair = (step: string) => {
        steps.push(step);
        if (step === failure) throw repairFailure;
      };
      state.repository.putEventProgressOutbox = async () => {
        recordRepair("outbox");
      };
      coordination(state.repository).timerStarts.deletePair = async () => {
        recordRepair("timers");
      };
      state.repository.applyFebruaryChallengeReplay = async (...args) => {
        assert.deepEqual(args, ["profile-player", "profile-opponent"]);
        recordRepair("challenge");
      };
      const result = updateRatings(identity, request, state.repository, {
        assertMutationAllowed: async () => {
          steps.push("guard");
        },
        enqueueEventProgress: async () => {
          steps.push("event");
        },
        enqueueTelegramProjection: async () => {
          steps.push("telegram");
        },
        enqueueProfileGameProjection: async () => {
          steps.push("profile");
        },
      });
      if (failure) {
        await assert.rejects(result, (error) => error === repairFailure);
        assert.deepEqual(
          steps,
          failure === "outbox"
            ? ["guard", "outbox"]
            : failure === "timers"
              ? ["guard", "outbox", "guard", "timers"]
              : ["guard", "timers", "challenge"],
        );
      } else {
        assert.deepEqual(await result, { ok: true });
        assert.deepEqual(steps, [
          "guard",
          "outbox",
          "guard",
          "timers",
          "event",
          "telegram",
          "profile",
        ]);
      }
      assert.equal(state.getAttempts(), 1);
      assert.equal(state.getFinalized(), 0);
    });
  }
});

test("repairs D1 timer marker cleanup on a completed replay", async () => {
  const state = createRepository({ completed: true, failMatchReads: true });
  const stores = coordination(state.repository);
  stores.timerRows.set(`${request.playerId}/${request.matchId}`, {
    timer: "7;1000",
    turnNumber: 7,
    updatedAtMs: 1,
  });
  const deletePair = stores.timerStarts.deletePair;
  let cleanupAttempts = 0;
  stores.timerStarts.deletePair = async (...args) => {
    cleanupAttempts++;
    if (cleanupAttempts === 1) throw new Error("timer-cleanup-failed");
    return deletePair(...args);
  };
  await assert.rejects(
    updateRatings(identity, request, state.repository),
    /timer-cleanup-failed/,
  );
  assert.ok(stores.timerRows.has(`${request.playerId}/${request.matchId}`));
  assert.deepEqual(await updateRatings(identity, request, state.repository), {
    ok: true,
  });
  assert.equal(cleanupAttempts, 2);
  assert.equal(stores.timerRows.size, 0);
});

test("repairs a D1-completed rating without Firebase markers or match reads", async () => {
  const state = createRepository({ ratingDone: true, failMatchReads: true });
  assert.deepEqual(await updateRatings(identity, request, state.repository), {
    ok: true,
  });
  assert.equal(state.getAttempts(), 0);
  assert.equal(state.getFinalized(), 0);
  assert.equal(state.patches.length, 0);
});

test("preserves imported legacy completion without a canonical rating record", async () => {
  const state = createRepository({
    completed: true,
    ratingDone: false,
    failMatchReads: true,
  });
  assert.deepEqual(await updateRatings(identity, request, state.repository), {
    ok: true,
  });
  assert.equal(state.getAttempts(), 0);
  assert.equal(state.getFinalized(), 0);
  assert.deepEqual(state.patches, []);
});

test("fails closed when D1 completion evidence is unavailable", async () => {
  const state = createRepository({ ratingDone: true });
  state.repository.hasCompletedRatingUpdate = async () => {
    throw new AuthApiFailure(
      503,
      "unavailable",
      "rating-completions-unavailable",
    );
  };
  await assert.rejects(
    updateRatings(identity, request, state.repository),
    /rating-completions-unavailable/,
  );
  assert.equal(state.getAttempts(), 0);
  assert.equal(state.getFinalized(), 0);
  assert.deepEqual(state.patches, []);
});

test("rejects a done record belonging to another invite or match", async () => {
  const state = createRepository();
  state.repository.readRatingUpdate = async () =>
    completedData({ matchId: "another-match" });
  await assert.rejects(
    updateRatings(identity, request, state.repository),
    /rating-completion-conflict/,
  );
  assert.equal(state.getAttempts(), 0);
  assert.equal(state.getFinalized(), 0);
  assert.deepEqual(state.patches, []);
});

test("bounds busy leases and preserves the skipped response", async () => {
  const state = createRepository({ leaseStatus: "busy" });
  assert.deepEqual(await updateRatings(identity, request, state.repository), {
    ok: true,
    skipped: true,
  });
  assert.equal(state.getAttempts(), 1);
  assert.equal(state.getFinalized(), 0);
});

test("direct rating authorization does not read ownership", async () => {
  const state = createRepository();
  state.repository.readProfileOwnershipSnapshot = async () => {
    throw new Error("d1-unavailable");
  };
  assert.deepEqual(await updateRatings(identity, request, state.repository), {
    ok: true,
  });
  assert.equal(state.getAttempts(), 1);
  assert.equal(state.getFinalized(), 1);
});

test("rating request eligibility precedes ownership and state reads", async () => {
  const state = createRepository();
  const reads: string[] = [];
  state.repository.readProfileOwnershipSnapshot = async () => {
    reads.push("ownership");
    throw new Error("ownership-unavailable");
  };
  state.repository.readInviteMetadata = async () => {
    reads.push("invite");
    throw new Error("invite-unavailable");
  };
  state.repository.hasCompletedRatingUpdate = async () => {
    reads.push("completion");
    throw new Error("completion-unavailable");
  };
  const actor = { uid: "alternate-login" };
  assert.deepEqual(
    await updateRatings(
      actor,
      { ...request, inviteId: "manual-invite" },
      state.repository,
    ),
    { ok: false },
  );
  await assert.rejects(
    updateRatings(
      actor,
      { ...request, matchId: "unrelated-match" },
      state.repository,
    ),
    {
      status: 403,
      code: "permission-denied",
      message: "permission-denied",
    },
  );
  assert.deepEqual(reads, []);
  assert.equal(state.getAttempts(), 0);
});

test("rating ownership failures precede invite and completion reads", async () => {
  for (const malformed of [false, true]) {
    const state = createRepository({ invite: null });
    const reads: string[] = [];
    const readOwnership = state.repository.readProfileOwnershipSnapshot;
    state.repository.readProfileOwnershipSnapshot = async (query) => {
      reads.push("ownership");
      const snapshot = await readOwnership(query);
      if (!malformed) throw new Error("ownership-unavailable");
      return { ...snapshot, loginOwnerByUid: new Map() };
    };
    state.repository.readInviteMetadata = async () => {
      reads.push("invite");
      return null;
    };
    state.repository.hasCompletedRatingUpdate = async () => {
      reads.push("completion");
      return false;
    };
    await assert.rejects(
      updateRatings({ uid: "alternate-login" }, request, state.repository),
      {
        status: 503,
        code: "unavailable",
        message: "profile-ownership-unavailable",
      },
    );
    assert.deepEqual(reads, ["ownership"]);
    assert.equal(state.getAttempts(), 0);
    assert.equal(state.getFinalized(), 0);
  }
});

test("completed rating rematches replay without rematch-list membership", async () => {
  const state = createRepository({ completed: true, failMatchReads: true });
  const input = { ...request, matchId: `${request.inviteId}3` };
  const reads: string[] = [];
  const readOwnership = state.repository.readProfileOwnershipSnapshot;
  state.repository.readProfileOwnershipSnapshot = async (query) => {
    reads.push("ownership");
    return readOwnership(query);
  };
  const readInvite = state.repository.readInviteMetadata;
  state.repository.readInviteMetadata = async (...args) => {
    reads.push("invite");
    return readInvite(...args);
  };
  state.repository.hasCompletedRatingUpdate = async (inviteId, matchId) => {
    reads.push("completion");
    assert.equal(inviteId, input.inviteId);
    assert.equal(matchId, input.matchId);
    return true;
  };
  state.repository.readRatingUpdate = async () =>
    completedData({ matchId: input.matchId });
  assert.deepEqual(
    await updateRatings({ uid: "alternate-login" }, input, state.repository),
    { ok: true },
  );
  assert.deepEqual(reads, ["ownership", "invite", "completion"]);
  assert.equal(state.getAttempts(), 0);
  assert.equal(state.getFinalized(), 0);
});

test("authorizes direct and canonical same-profile logins only", async () => {
  const sameProfile = createRepository();
  let ownershipReads = 0;
  const readOwnership = sameProfile.repository.readProfileOwnershipSnapshot;
  sameProfile.repository.readProfileOwnershipSnapshot = async (query) => {
    ownershipReads++;
    assert.deepEqual(query.loginUids, [
      "alternate-login",
      request.playerId,
      request.opponentId,
    ]);
    return readOwnership(query);
  };
  assert.deepEqual(
    await updateRatings(
      { ...identity, uid: "alternate-login" },
      request,
      sameProfile.repository,
    ),
    { ok: true },
  );
  assert.equal(ownershipReads, 1);
  const unrelated = createRepository();
  await assert.rejects(
    () =>
      updateRatings(
        { ...identity, uid: "unrelated-login" },
        request,
        unrelated.repository,
      ),
    (error: unknown) => error instanceof AuthApiFailure && error.status === 403,
  );
});

test("rejects participant mismatches and invalid game states", async () => {
  const unrelatedMatch = createRepository();
  await assert.rejects(
    () =>
      updateRatings(
        identity,
        { ...request, matchId: "auto_bbbbbbbbbbb" },
        unrelatedMatch.repository,
      ),
    (error: unknown) => error instanceof AuthApiFailure && error.status === 403,
  );
  assert.equal(unrelatedMatch.getOperationReads(), 0);
  const participantMismatch = createRepository({
    invite: inviteDocumentFixture({
      hostId: "other",
      guestId: request.opponentId,
    }),
  });
  await assert.rejects(
    () => updateRatings(identity, request, participantMismatch.repository),
    (error: unknown) => error instanceof AuthApiFailure && error.status === 403,
  );
  assert.throws(
    () => resolveRatingResult(match("white"), match("white")),
    (error: unknown) => error instanceof AuthApiFailure && error.status === 409,
  );
});

test("returns false for non-automatch requests without repository work", async () => {
  const state = createRepository();
  assert.deepEqual(
    await updateRatings(
      identity,
      { ...request, inviteId: "invite" },
      state.repository,
    ),
    { ok: false },
  );
  assert.equal(state.getAttempts(), 0);
});
