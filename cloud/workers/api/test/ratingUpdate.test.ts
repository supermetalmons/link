import assert from "node:assert/strict";
import test from "node:test";
import { isHistoricalMatchPair } from "@mons/shared/game-sessions";
import { createRatingUpdater } from "@mons/shared/ratings";
import {
  MAX_MATCH_FEN_BYTES,
  MAX_MATCH_HISTORY_ENTRIES,
} from "@mons/shared/match-protocol";
import { MATCH_TIMER_TERMINAL } from "@mons/shared/timers";
import glicko2 from "glicko2";
import { Color, Game } from "mons-rules";
import { AuthApiFailure } from "../src/authErrors.ts";
import type { RequestIdentity } from "../src/requestIdentity.ts";
import type {
  RatingCommitPlan,
  RatingProfile,
  RatingRepository,
  RatingUpdateData,
} from "../src/gameplayRepository.ts";
import type {
  ProfileOwnershipQuery,
  ProfileOwnershipSnapshot,
} from "../src/profileOwnership.ts";
import {
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
    feb2026UniqueOpponents: [],
    nonce: 4,
    profileId,
    rating: profileId.endsWith("player") ? 1500 : 1400,
    sol: "",
    totalManaPoints: 10,
    username: profileId.endsWith("player") ? "Alice" : "Bob",
    ...overrides,
  };
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
    getRtdbPath: async (path) => {
      if (
        path ===
        `invites/${request.inviteId}/matchesRatingUpdates/${request.matchId}`
      ) {
        return completed;
      }
      if (path === `invites/${request.inviteId}`) return invite;
      if (path === `players/${request.playerId}/matches/${request.matchId}`) {
        if (failMatchReads) throw new Error("match-read-failed");
        return playerMatchValue;
      }
      if (path === `players/${request.opponentId}/matches/${request.matchId}`) {
        if (failMatchReads) throw new Error("match-read-failed");
        return opponentMatchValue;
      }
      return null;
    },
    patchRtdbRoot: async (updates) => {
      patches.push(updates);
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
  const result = buildRatingPlan({
    historicalMatchPair: historicalMatchPair(),
    invite: {
      telegramDeliveryVersion: 2,
      wagers: {
        [request.matchId]: {
          agreed: { material: "dust", count: 3 },
        },
      },
    },
    matchId: request.matchId,
    nowMs,
    opponent,
    opponentMatch,
    player,
    playerMatch,
    request,
    result: "win",
  });
  const expectedRatings = createRatingUpdater(glicko2.Glicko2)(
    1500,
    5,
    1400,
    9,
  );
  assert.deepEqual(result.playerUpdate, {
    rating: expectedRatings[0],
    nonce: 5,
    win: true,
    totalManaPoints: 10,
  });
  assert.deepEqual(result.opponentUpdate, {
    rating: expectedRatings[1],
    nonce: 9,
    win: false,
    totalManaPoints: 10,
  });
  assert.equal(result.ratingUpdate.didApplyRatingDelta, true);
  assert.equal(result.ratingUpdate.telegramDeliveryVersion, 2);
  assert.equal(result.ratingUpdate.telegramProjectionVersion, 1);
  assert.equal(result.ratingUpdate.telegramProjectionState, "pending");
  assert.equal(result.ratingUpdate.telegramProjectionUpdatedAtMs, nowMs);
  assert.equal(result.ratingUpdate.profileGameProjectionVersion, 1);
  assert.equal(result.ratingUpdate.profileGameProjectionState, "pending");
  assert.equal(result.ratingUpdate.profileGameProjectionUpdatedAtMs, nowMs);
  assert.equal(result.ratingUpdate.profileGameProjectionReason, null);
  assert.equal(result.ratingUpdate.status, "done");
  assert.match(String(result.ratingUpdate.updateRatingMessage), /Alice/);
  assert.match(String(result.ratingUpdate.updateRatingMessage), /Bob/);
  assert.match(
    String(result.ratingUpdate.updateRatingMessage),
    /5235835141238063097/,
  );
  assert.match(
    String(result.ratingUpdate.updateRatingMessage),
    /5228702136862282659/,
  );
});

test("event ratings preserve win and mana without applying a rating delta", () => {
  const built = buildRatingPlan({
    historicalMatchPair: historicalMatchPair(),
    invite: { eventOwned: true, eventId: "event-1" },
    matchId: request.matchId,
    nowMs: FEB_CHALLENGE_START_UTC + 1,
    opponent: profile("profile-opponent"),
    opponentMatch: match("black", { timer: MATCH_TIMER_TERMINAL }),
    player: profile("profile-player"),
    playerMatch: match("white"),
    request,
    result: "gg",
  });
  assert.equal(built.ratingUpdate.didApplyRatingDelta, false);
  assert.equal(built.ratingUpdate.isEventMatch, true);
  assert.equal(built.ratingUpdate.eventOwned, true);
  assert.equal(built.ratingUpdate.eventId, "event-1");
  assert.equal(built.ratingUpdate.eventProgressVersion, 1);
  assert.equal(built.ratingUpdate.eventProgressState, "pending");
  assert.equal(
    built.ratingUpdate.eventProgressUpdatedAtMs,
    FEB_CHALLENGE_START_UTC + 1,
  );
  assert.equal(built.ratingUpdate.eventProgressReason, null);
  assert.equal(built.ratingUpdate.telegramDeliveryVersion, null);
  assert.equal(built.ratingUpdate.telegramProjectionState, undefined);
  assert.equal(built.ratingUpdate.telegramProjectionVersion, undefined);
  assert.equal(built.repairData.shouldUpdateFebruaryChallenge, false);
  assert.deepEqual(built.playerUpdate, {
    nonce: 5,
    win: false,
    totalManaPoints: 10,
  });
});

test("completes rating records without profile writes when profiles are absent", () => {
  const built = buildRatingPlan({
    historicalMatchPair: historicalMatchPair(),
    invite: {},
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
    invite: {},
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
    invite: {},
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

test("updates once and persists exact repair markers", async () => {
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
  assert.deepEqual(state.patches, [
    {
      [`invites/${request.inviteId}/matchesRatingUpdates/${request.matchId}`]: true,
    },
  ]);
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
    invite: {
      hostId: request.playerId,
      guestId: request.opponentId,
      eventOwned: true,
      eventId: "event-1",
    },
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

test("event ratings retain a pending recovery marker when RTDB repair fails", async () => {
  const state = createRepository({
    invite: {
      hostId: request.playerId,
      guestId: request.opponentId,
      eventOwned: true,
      eventId: "event-1",
    },
  });
  state.repository.patchRtdbRoot = async () => {
    throw new Error("rtdb-unavailable");
  };
  await assert.rejects(
    updateRatings(identity, request, state.repository, {
      createOwnerToken: () => "owner-token",
      now: () => 2_000,
    }),
    /rtdb-unavailable/,
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
  assert.equal(state.patches.length, 1);
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

test("repairs a done rating when the marker is missing and match reads fail", async () => {
  const state = createRepository({ ratingDone: true, failMatchReads: true });
  assert.deepEqual(await updateRatings(identity, request, state.repository), {
    ok: true,
  });
  assert.equal(state.getAttempts(), 0);
  assert.equal(state.getFinalized(), 0);
  assert.equal(state.patches.length, 1);
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
    invite: { hostId: "other", guestId: request.opponentId },
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
