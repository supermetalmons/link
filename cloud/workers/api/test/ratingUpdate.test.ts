import assert from "node:assert/strict";
import test from "node:test";
import { createRatingUpdater } from "@mons/shared/ratings";
import {
  MAX_MATCH_FEN_BYTES,
  MAX_MATCH_HISTORY_ENTRIES,
} from "@mons/shared/match-protocol";
import { MATCH_TIMER_TERMINAL } from "@mons/shared/timers";
import glicko2 from "glicko2";
import { Color, Game } from "mons-rules";
import { AuthApiFailure } from "../src/authErrors.ts";
import type { FirebaseIdentity } from "../src/firebaseAuth.ts";
import type {
  RatingCommitPlan,
  RatingProfile,
  RatingRepository,
  RatingUpdateData,
} from "../src/gameplayRepository.ts";
import {
  FEB_CHALLENGE_START_UTC,
  buildRatingPlan,
  readMatchRecord,
  resolveRatingResult,
  updateRatings,
} from "../src/ratingUpdate.ts";

const request = {
  playerId: "player",
  opponentId: "opponent",
  inviteId: "auto_aaaaaaaaaaa",
  matchId: "auto_aaaaaaaaaaa",
};

const identity: FirebaseIdentity = {
  idToken: "firebase-token",
  profileId: "profile-player",
  uid: "player",
};

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
  ratingDone = completed,
}: {
  completed?: boolean;
  failMatchReads?: boolean;
  invite?: unknown;
  leaseStatus?: "acquired" | "busy" | "done";
  playerProfile?: RatingProfile | null;
  opponentProfile?: RatingProfile | null;
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
    getRatingProfile: async (uid) =>
      uid === request.playerId ? playerProfile : opponentProfile,
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
        return match("white");
      }
      if (path === `players/${request.opponentId}/matches/${request.matchId}`) {
        if (failMatchReads) throw new Error("match-read-failed");
        return match("black", { status: "surrendered" });
      }
      return null;
    },
    patchRtdbRoot: async (updates) => {
      patches.push(updates);
    },
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
  const projectionTasks: unknown[] = [];
  assert.deepEqual(
    await updateRatings(identity, request, state.repository, {
      createOwnerToken: () => "owner-token",
      enqueueTelegramProjection: async (task) => {
        projectionTasks.push(task);
      },
      now: () => Date.UTC(2026, 7, 21),
    }),
    { ok: true },
  );
  assert.equal(state.getFinalized(), 1);
  assert.equal(state.getAttempts(), 1);
  assert.equal(state.getFinalPlan()?.ratingUpdate.status, "done");
  assert.equal(state.getOperationReads(), 1);
  assert.deepEqual(projectionTasks, [
    {
      kind: "rating-telegram-projection",
      operationId: `${request.inviteId}__${request.matchId}`,
    },
  ]);
  assert.deepEqual(state.patches, [
    {
      [`matchTimerStarts/${request.playerId}/${request.matchId}`]: null,
      [`matchTimerStarts/${request.opponentId}/${request.matchId}`]: null,
      [`invites/${request.inviteId}/matchesRatingUpdates/${request.matchId}`]: true,
    },
  ]);
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
      logProjectionFailure: (task) => failures.push(task.operationId),
      now: () => Date.UTC(2026, 7, 21),
    }),
    { ok: true },
  );
  assert.equal(
    state.getFinalPlan()?.ratingUpdate.telegramProjectionState,
    "pending",
  );
  assert.deepEqual(failures, [`${request.inviteId}__${request.matchId}`]);
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

test("authorizes the direct login or exact profile claim only", async () => {
  const sameProfile = createRepository();
  assert.deepEqual(
    await updateRatings(
      { ...identity, uid: "alternate-login" },
      request,
      sameProfile.repository,
    ),
    { ok: true },
  );
  const unrelated = createRepository();
  await assert.rejects(
    () =>
      updateRatings(
        { ...identity, uid: "alternate-login", profileId: "other-profile" },
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
