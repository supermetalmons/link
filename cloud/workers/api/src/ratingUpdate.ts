import glicko2 from "glicko2";
import type { HistoricalMatchPair } from "@mons/shared/game-sessions";
import { isAutoInviteId } from "@mons/shared/ids";
import {
  buildOrderedMoveHistory,
  isMatchFenWithinLimit,
  isMatchHistoryWithinLimits,
  parseGameFromMatchData,
  selectLaterGame,
} from "@mons/shared/match-protocol";
import {
  createRatingUpdater,
  getRatingEventMetadata,
  type RatingUpdateRequest,
  type RatingUpdateResponse,
} from "@mons/shared/ratings";
import {
  inviteMatchesPlayers,
  parseInviteMatchIndex,
} from "@mons/shared/rematches";
import { MATCH_TIMER_TERMINAL } from "@mons/shared/timers";
import { Color, Game, resolveMatch } from "mons-rules";
import {
  getDisplayNameFromAddress,
  getTelegramEmojiTag,
} from "../../../functions/telegramDisplay.js";
import { TELEGRAM_AUTOMATCH_VERSION } from "../../../functions/telegram/automatchSource.js";
import { AuthApiFailure } from "./authErrors.ts";
import type { MatchTimerStartStore } from "./gameplayCoordinationD1.ts";
import {
  buildHistoricalMatchPair,
  HISTORICAL_MATCH_ARCHIVE_VERSION,
} from "./historicalMatches.ts";
import type { RequestIdentity } from "./requestIdentity.ts";
import type {
  RatingCommitPlan,
  RatingProfile,
  RatingRepairData,
  RatingRepository,
} from "./gameplayRepository.ts";
import {
  TELEGRAM_PROJECTION_SCHEMA_VERSION,
  type RatingTelegramProjectionTask,
  type TelegramProjectionTask,
} from "./telegramProjectionTasks.ts";
import {
  PROFILE_GAME_PROJECTION_SCHEMA_VERSION,
  type ProfileGameProjectionTask,
  type RatingProfileGameProjectionTask,
} from "./profileGameProjectionTasks.ts";
import {
  getLoginProfileId,
  requireProfileOwnershipSnapshot,
  type ProfileOwnershipSnapshot,
} from "./profileOwnership.ts";
import {
  buildEventProgressPlan,
  type EventProgressPlan,
} from "./eventProgress.ts";

const RATING_UPDATE_LEASE_MS = 30_000;
const FEB_CHALLENGE_START_UTC = Date.UTC(2026, 1, 1);
const FEB_CHALLENGE_END_UTC = Date.UTC(2026, 2, 1);

const materialTelegramEmojiIds: Record<string, string> = {
  dust: "5235835141238063097",
  slime: "5235497595463303384",
  gum: "5233425978117621609",
  metal: "5235794850149863190",
  ice: "5233743994676086020",
};

const matchStatusTelegramEmojiIds = {
  timer: "5229098317530568280",
  whiteFlag: "5228702136862282659",
};

type RatingMatchRecord = {
  color: "white" | "black";
  emojiId: unknown;
  fen?: string;
  flatMovesString: string;
  status: string;
  timer: string;
};

type RatingResult = "gg" | "win";

export type RatingUpdateDependencies = {
  assertMutationAllowed?: () => Promise<void>;
  createOwnerToken?: (uid: string) => string;
  enqueueEventProgress?: (plan: EventProgressPlan) => Promise<void>;
  enqueueProfileGameProjection?: (
    task: ProfileGameProjectionTask,
  ) => Promise<void>;
  enqueueTelegramProjection?: (task: TelegramProjectionTask) => Promise<void>;
  logProfileGameProjectionFailure?: (
    task: RatingProfileGameProjectionTask,
  ) => void;
  logProjectionFailure?: (task: RatingTelegramProjectionTask) => void;
  now?: () => number;
  timerStarts: MatchTimerStartStore;
};

function toRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function failedPrecondition(message: string): AuthApiFailure {
  return new AuthApiFailure(409, "failed-precondition", message);
}

function readMatchRecord(value: unknown): RatingMatchRecord {
  const record = toRecord(value);
  const color = record?.color;
  const fen = typeof record?.fen === "string" ? record.fen : undefined;
  const flatMovesString =
    typeof record?.flatMovesString === "string" ? record.flatMovesString : "";
  if (!record || (color !== "white" && color !== "black")) {
    throw failedPrecondition("something is wrong with the game state.");
  }
  if (
    (fen !== undefined && !isMatchFenWithinLimit(fen)) ||
    !isMatchHistoryWithinLimits(flatMovesString)
  ) {
    throw failedPrecondition("something is wrong with the game state.");
  }
  return {
    color,
    emojiId: record.emojiId,
    fen,
    flatMovesString,
    status: typeof record.status === "string" ? record.status : "",
    timer: typeof record.timer === "string" ? record.timer : "",
  };
}

function resolveRatingResult(
  player: RatingMatchRecord,
  opponent: RatingMatchRecord,
): RatingResult {
  if (
    player.status === "surrendered" ||
    opponent.timer === MATCH_TIMER_TERMINAL
  ) {
    return "gg";
  }
  if (
    opponent.status === "surrendered" ||
    player.timer === MATCH_TIMER_TERMINAL
  ) {
    return "win";
  }
  if (player.color === opponent.color) {
    throw failedPrecondition("something is wrong with the game state.");
  }
  if (!player.fen || !opponent.fen) {
    throw failedPrecondition("Could not confirm victory.");
  }
  let resolution;
  try {
    const ordered = buildOrderedMoveHistory(player, opponent);
    resolution = resolveMatch(
      player.color === "white"
        ? {
            white: { fen: player.fen, moves: ordered.white },
            black: { fen: opponent.fen, moves: ordered.black },
          }
        : {
            white: { fen: opponent.fen, moves: ordered.white },
            black: { fen: player.fen, moves: ordered.black },
          },
    );
  } catch {
    throw failedPrecondition("Could not confirm victory.");
  }
  if (resolution.kind !== "winner") {
    throw failedPrecondition("Could not confirm victory.");
  }
  const playerColor = player.color === "white" ? Color.White : Color.Black;
  return resolution.winner === playerColor ? "win" : "gg";
}

function selectScoreGame(
  player: RatingMatchRecord,
  opponent: RatingMatchRecord,
): Game {
  const parse = (record: RatingMatchRecord) => {
    try {
      return parseGameFromMatchData({ Game }, record);
    } catch {
      return undefined;
    }
  };
  const playerGame = parse(player);
  const opponentGame = parse(opponent);
  const game = selectLaterGame(playerGame, opponentGame);
  if (!game) {
    throw failedPrecondition("Could not validate the game score.");
  }
  return game;
}

function hasMoves(record: RatingMatchRecord): boolean {
  return record.flatMovesString.length > 0;
}

async function enqueueRatingProjection(
  operationId: string,
  dependencies: RatingUpdateDependencies,
): Promise<void> {
  if (!dependencies.enqueueTelegramProjection) {
    return;
  }
  const task: RatingTelegramProjectionTask = {
    kind: "rating-telegram-projection",
    operationId,
  };
  try {
    await dependencies.enqueueTelegramProjection(task);
  } catch {
    (
      dependencies.logProjectionFailure ||
      ((failedTask) =>
        console.error(
          JSON.stringify({
            event: "rating_telegram_projection_enqueue_failed",
            operationId: failedTask.operationId,
          }),
        ))
    )(task);
  }
}

async function enqueueProfileGameProjection(
  operationId: string,
  dependencies: RatingUpdateDependencies,
): Promise<void> {
  if (!dependencies.enqueueProfileGameProjection) {
    return;
  }
  const task: RatingProfileGameProjectionTask = {
    kind: "rating-profile-game-projection",
    operationId,
  };
  try {
    await dependencies.enqueueProfileGameProjection(task);
  } catch {
    (
      dependencies.logProfileGameProjectionFailure ||
      ((failedTask) =>
        console.error(
          JSON.stringify({
            event: "rating_profile_game_projection_enqueue_failed",
            operationId: failedTask.operationId,
          }),
        ))
    )(task);
  }
}

function emptyProfile(): RatingProfile {
  return {
    aura: "",
    emoji: "",
    eth: "",
    feb2026UniqueOpponents: [],
    nonce: 0,
    profileId: "",
    rating: 0,
    sol: "",
    totalManaPoints: 0,
    username: "",
  };
}

function wagerSuffix(invite: Record<string, unknown>, matchId: string): string {
  const wagers = toRecord(invite.wagers);
  const wager = toRecord(wagers?.[matchId]);
  const agreed = toRecord(wager?.agreed);
  const material =
    typeof agreed?.material === "string" ? agreed.material.trim() : "";
  const count = Number(agreed?.count);
  const emojiId = materialTelegramEmojiIds[material] || "";
  const icon = getTelegramEmojiTag(emojiId);
  if (!icon || !Number.isFinite(count) || count <= 0) {
    return "";
  }
  return `${icon} ${Math.round(count)}`;
}

function buildRatingPlan({
  historicalMatchPair,
  invite,
  matchId,
  nowMs,
  opponent,
  opponentMatch,
  player,
  playerMatch,
  request,
  result,
}: {
  historicalMatchPair: HistoricalMatchPair;
  invite: Record<string, unknown>;
  matchId: string;
  nowMs: number;
  opponent: RatingProfile | null;
  opponentMatch: RatingMatchRecord;
  player: RatingProfile | null;
  playerMatch: RatingMatchRecord;
  request: RatingUpdateRequest;
  result: RatingResult;
}): RatingCommitPlan {
  const resolvedPlayer = player || emptyProfile();
  const resolvedOpponent = opponent || emptyProfile();
  const canUpdateRatings = Boolean(
    player && opponent && player.profileId !== opponent.profileId,
  );
  const eventMetadata = getRatingEventMetadata(invite);
  const shouldApplyRatingDelta =
    canUpdateRatings && !eventMetadata.isEventMatch;
  const game = selectScoreGame(playerMatch, opponentMatch);
  const playerManaPoints =
    playerMatch.color === "white"
      ? game.scores[Color.White]
      : game.scores[Color.Black];
  const opponentManaPoints =
    opponentMatch.color === "white"
      ? game.scores[Color.White]
      : game.scores[Color.Black];
  const playerEmoji =
    resolvedPlayer.emoji === "" ? playerMatch.emojiId : resolvedPlayer.emoji;
  const opponentEmoji =
    resolvedOpponent.emoji === ""
      ? opponentMatch.emojiId
      : resolvedOpponent.emoji;
  const playerDisplayName = getDisplayNameFromAddress(
    resolvedPlayer.username,
    resolvedPlayer.eth,
    resolvedPlayer.sol,
    0,
    playerEmoji,
    false,
  );
  const opponentDisplayName = getDisplayNameFromAddress(
    resolvedOpponent.username,
    resolvedOpponent.eth,
    resolvedOpponent.sol,
    0,
    opponentEmoji,
    false,
  );
  const winnerDisplayName =
    result === "win" ? playerDisplayName : opponentDisplayName;
  const loserDisplayName =
    result === "win" ? opponentDisplayName : playerDisplayName;
  const bothPlayersMoved = hasMoves(playerMatch) && hasMoves(opponentMatch);
  const nextPlayerNonce = resolvedPlayer.nonce + 1;
  const nextOpponentNonce = resolvedOpponent.nonce + 1;
  const storedPlayerNonce = bothPlayersMoved
    ? nextPlayerNonce
    : resolvedPlayer.nonce;
  const storedOpponentNonce = bothPlayersMoved
    ? nextOpponentNonce
    : resolvedOpponent.nonce;
  let winnerNewRating =
    result === "win" ? resolvedPlayer.rating : resolvedOpponent.rating;
  let loserNewRating =
    result === "win" ? resolvedOpponent.rating : resolvedPlayer.rating;
  if (shouldApplyRatingDelta) {
    const updateRating = createRatingUpdater(glicko2.Glicko2);
    [winnerNewRating, loserNewRating] =
      result === "win"
        ? updateRating(
            resolvedPlayer.rating,
            nextPlayerNonce,
            resolvedOpponent.rating,
            nextOpponentNonce,
          )
        : updateRating(
            resolvedOpponent.rating,
            nextOpponentNonce,
            resolvedPlayer.rating,
            nextPlayerNonce,
          );
  }
  const playerUpdate = canUpdateRatings
    ? {
        ...(shouldApplyRatingDelta
          ? {
              rating: result === "win" ? winnerNewRating : loserNewRating,
            }
          : {}),
        nonce: storedPlayerNonce,
        win: result === "win",
        totalManaPoints: resolvedPlayer.totalManaPoints + playerManaPoints,
      }
    : null;
  const opponentUpdate = canUpdateRatings
    ? {
        ...(shouldApplyRatingDelta
          ? {
              rating: result === "win" ? loserNewRating : winnerNewRating,
            }
          : {}),
        nonce: storedOpponentNonce,
        win: result !== "win",
        totalManaPoints: resolvedOpponent.totalManaPoints + opponentManaPoints,
      }
    : null;
  const winnerScore = result === "win" ? playerManaPoints : opponentManaPoints;
  const loserScore = result === "win" ? opponentManaPoints : playerManaPoints;
  let suffix = ` (${winnerScore} - ${loserScore})`;
  if (
    playerMatch.status === "surrendered" ||
    opponentMatch.status === "surrendered"
  ) {
    const icon = getTelegramEmojiTag(matchStatusTelegramEmojiIds.whiteFlag);
    if (icon) {
      suffix += ` ${icon}`;
    }
  } else if (
    playerMatch.timer === MATCH_TIMER_TERMINAL ||
    opponentMatch.timer === MATCH_TIMER_TERMINAL
  ) {
    const icon = getTelegramEmojiTag(matchStatusTelegramEmojiIds.timer);
    if (icon) {
      suffix += ` ${icon}`;
    }
  }
  const wager = wagerSuffix(invite, matchId);
  if (wager) {
    suffix += ` ${wager}`;
  }
  const updateRatingMessage = shouldApplyRatingDelta
    ? `${winnerDisplayName} ${winnerNewRating}↑ ${loserDisplayName} ${loserNewRating}↓${suffix}`
    : `${winnerDisplayName} ↑ ${loserDisplayName}${suffix}`;
  const shouldUpdateFebruaryChallenge =
    canUpdateRatings &&
    bothPlayersMoved &&
    !eventMetadata.isEventMatch &&
    nowMs >= FEB_CHALLENGE_START_UTC &&
    nowMs < FEB_CHALLENGE_END_UTC;
  const telegramDeliveryVersion =
    !eventMetadata.isEventMatch &&
    invite.telegramDeliveryVersion === TELEGRAM_AUTOMATCH_VERSION
      ? TELEGRAM_AUTOMATCH_VERSION
      : null;
  return {
    playerUpdate,
    opponentUpdate,
    repairData: {
      playerProfileId: resolvedPlayer.profileId,
      opponentProfileId: resolvedOpponent.profileId,
      shouldUpdateFebruaryChallenge,
    },
    ratingUpdate: {
      inviteId: request.inviteId,
      matchId: request.matchId,
      playerId: request.playerId,
      opponentId: request.opponentId,
      status: "done",
      historicalMatchArchiveVersion: HISTORICAL_MATCH_ARCHIVE_VERSION,
      historicalMatchPair,
      result,
      canUpdateRatings,
      didApplyRatingDelta: shouldApplyRatingDelta,
      winnerDisplayName,
      loserDisplayName,
      winnerNewRating: shouldApplyRatingDelta ? winnerNewRating : null,
      loserNewRating: shouldApplyRatingDelta ? loserNewRating : null,
      playerManaPoints,
      opponentManaPoints,
      shouldUpdateFebruaryChallenge,
      playerProfileId: resolvedPlayer.profileId,
      opponentProfileId: resolvedOpponent.profileId,
      profileGameProjectionVersion: PROFILE_GAME_PROJECTION_SCHEMA_VERSION,
      profileGameProjectionState: "pending",
      profileGameProjectionUpdatedAtMs: nowMs,
      profileGameProjectionReason: null,
      updateRatingMessage,
      telegramDeliveryVersion,
      ...(telegramDeliveryVersion === TELEGRAM_AUTOMATCH_VERSION
        ? {
            telegramProjectionVersion: TELEGRAM_PROJECTION_SCHEMA_VERSION,
            telegramProjectionState: "pending",
            telegramProjectionUpdatedAtMs: nowMs,
            telegramProjectionReason: null,
          }
        : {}),
      ...(eventMetadata.eventOwned && eventMetadata.eventId
        ? {
            eventProgressVersion: 1,
            eventProgressState: "pending",
            eventProgressUpdatedAtMs: nowMs,
            eventProgressReason: null,
          }
        : {}),
      ...eventMetadata,
      updatedAtMs: nowMs,
      completedAtMs: nowMs,
      leaseExpiresAtMs: nowMs,
    },
  };
}

async function authorizePlayer(
  identity: RequestIdentity,
  playerId: string,
  opponentId: string,
  repository: RatingRepository,
): Promise<ProfileOwnershipSnapshot | null> {
  if (identity.uid === playerId) {
    return null;
  }
  const ownership = await requireProfileOwnershipSnapshot(repository, {
    loginUids: [identity.uid, playerId, opponentId],
    profileIds: [],
  });
  const identityProfileId = getLoginProfileId(ownership, identity.uid);
  const playerProfileId = getLoginProfileId(ownership, playerId);
  if (!identityProfileId || identityProfileId !== playerProfileId) {
    throw new AuthApiFailure(403, "permission-denied", "permission-denied");
  }
  return ownership;
}

async function repairRatingSideEffects(
  request: RatingUpdateRequest,
  data: RatingRepairData | null,
  repository: RatingRepository,
  timerStarts: MatchTimerStartStore,
  assertMutationAllowed: (() => Promise<void>) | undefined,
  eventId: string | null,
  nowMs: number,
): Promise<EventProgressPlan | null> {
  const progress = eventId
    ? await buildEventProgressPlan(
        {
          eventId,
          sourceKey: `rating:${request.inviteId}:${request.matchId}`,
          reason: "match-rating-updated",
        },
        nowMs,
      )
    : null;
  if (progress) {
    await assertMutationAllowed?.();
    await repository.patchRtdbRoot({
      [`eventProgressOutbox/${progress.outboxId}`]: progress.outbox,
    });
  }
  await assertMutationAllowed?.();
  await timerStarts.deletePair(
    request.playerId,
    request.opponentId,
    request.matchId,
  );
  if (
    data?.shouldUpdateFebruaryChallenge &&
    data.playerProfileId &&
    data.opponentProfileId
  ) {
    await repository.applyFebruaryChallengeReplay(
      data.playerProfileId,
      data.opponentProfileId,
    );
  }
  return progress;
}

async function dispatchEventProgress(
  progress: EventProgressPlan | null,
  dependencies: RatingUpdateDependencies,
): Promise<void> {
  if (!progress || !dependencies.enqueueEventProgress) {
    return;
  }
  try {
    await dependencies.enqueueEventProgress(progress);
  } catch {
    console.error(
      JSON.stringify({
        event: "rating_event_progress_enqueue_failed",
        eventId: progress.params.eventId,
        sourceKey: progress.params.sourceKey,
      }),
    );
  }
}

export async function updateRatings(
  identity: RequestIdentity,
  request: RatingUpdateRequest,
  repository: RatingRepository,
  dependencies: RatingUpdateDependencies,
): Promise<RatingUpdateResponse> {
  if (!isAutoInviteId(request.inviteId)) {
    return { ok: false };
  }
  if (parseInviteMatchIndex(request.inviteId, request.matchId) === null) {
    throw new AuthApiFailure(403, "permission-denied", "permission-denied");
  }
  await authorizePlayer(
    identity,
    request.playerId,
    request.opponentId,
    repository,
  );
  const operationId = `${request.inviteId}__${request.matchId}`;
  const [inviteValue, completed] = await Promise.all([
    repository.getRtdbPath(`invites/${request.inviteId}`),
    repository.hasCompletedRatingUpdate(request.inviteId, request.matchId),
  ]);
  const invite = toRecord(inviteValue);
  if (
    !invite ||
    !inviteMatchesPlayers(invite, request.playerId, request.opponentId)
  ) {
    throw new AuthApiFailure(403, "permission-denied", "permission-denied");
  }
  const eventMetadata = getRatingEventMetadata(invite);
  const progressEventId =
    eventMetadata.isEventMatch &&
    eventMetadata.eventOwned &&
    eventMetadata.eventId
      ? eventMetadata.eventId
      : null;
  const now = dependencies.now || Date.now;
  const existing = await repository.readRatingUpdate(operationId);
  if (
    existing &&
    (existing.inviteId !== request.inviteId ||
      existing.matchId !== request.matchId)
  ) {
    throw new AuthApiFailure(503, "unavailable", "rating-completion-conflict");
  }
  if (completed === true || existing?.status === "done") {
    const progress = await repairRatingSideEffects(
      request,
      existing,
      repository,
      dependencies.timerStarts,
      dependencies.assertMutationAllowed,
      progressEventId,
      now(),
    );
    await dispatchEventProgress(progress, dependencies);
    if (existing?.telegramProjectionState === "pending") {
      await enqueueRatingProjection(operationId, dependencies);
    }
    if (existing?.profileGameProjectionState === "pending") {
      await enqueueProfileGameProjection(operationId, dependencies);
    }
    return { ok: true };
  }
  const [playerValue, opponentValue] = await Promise.all([
    repository.getRtdbPath(
      `players/${request.playerId}/matches/${request.matchId}`,
    ),
    repository.getRtdbPath(
      `players/${request.opponentId}/matches/${request.matchId}`,
    ),
  ]);
  const playerMatch = readMatchRecord(playerValue);
  const opponentMatch = readMatchRecord(opponentValue);
  const hostPlayerId = typeof invite.hostId === "string" ? invite.hostId : "";
  const guestPlayerId =
    typeof invite.guestId === "string" ? invite.guestId : "";
  const historicalMatchPair = buildHistoricalMatchPair({
    matchId: request.matchId,
    hostPlayerId,
    guestPlayerId,
    hostMatch:
      request.playerId === hostPlayerId
        ? playerValue
        : request.opponentId === hostPlayerId
          ? opponentValue
          : null,
    guestMatch:
      request.playerId === guestPlayerId
        ? playerValue
        : request.opponentId === guestPlayerId
          ? opponentValue
          : null,
  });
  if (!historicalMatchPair) {
    throw failedPrecondition("something is wrong with the game state.");
  }
  const result = resolveRatingResult(playerMatch, opponentMatch);
  const ownerToken = (
    dependencies.createOwnerToken ||
    ((uid: string) => `${uid}_${crypto.randomUUID()}`)
  )(identity.uid);
  const lease = await repository.tryAcquireRatingLease({
    inviteId: request.inviteId,
    matchId: request.matchId,
    opponentId: request.opponentId,
    ownerToken,
    ownerUid: identity.uid,
    playerId: request.playerId,
    leaseMs: RATING_UPDATE_LEASE_MS,
  });
  if (lease.status === "done") {
    const progress = await repairRatingSideEffects(
      request,
      lease.data,
      repository,
      dependencies.timerStarts,
      dependencies.assertMutationAllowed,
      progressEventId,
      now(),
    );
    await dispatchEventProgress(progress, dependencies);
    if (lease.data?.telegramProjectionState === "pending") {
      await enqueueRatingProjection(operationId, dependencies);
    }
    if (lease.data?.profileGameProjectionState === "pending") {
      await enqueueProfileGameProjection(operationId, dependencies);
    }
    return { ok: true };
  }
  if (lease.status !== "acquired") {
    return { ok: true, skipped: true };
  }
  const finalized = await repository.finalizeRatingUpdate(
    {
      inviteId: request.inviteId,
      matchId: request.matchId,
      opponentId: request.opponentId,
      operationId,
      ownerToken,
      playerId: request.playerId,
    },
    (player, opponent) => {
      return buildRatingPlan({
        historicalMatchPair,
        invite,
        matchId: request.matchId,
        nowMs: now(),
        opponent,
        opponentMatch,
        player,
        playerMatch,
        request,
        result,
      });
    },
  );
  if (finalized.status === "lost") {
    return { ok: true, skipped: true };
  }
  const progress = await repairRatingSideEffects(
    request,
    finalized.data,
    repository,
    dependencies.timerStarts,
    dependencies.assertMutationAllowed,
    progressEventId,
    now(),
  );
  await dispatchEventProgress(progress, dependencies);
  await enqueueProfileGameProjection(operationId, dependencies);
  if (
    invite.telegramDeliveryVersion === TELEGRAM_AUTOMATCH_VERSION &&
    !getRatingEventMetadata(invite).isEventMatch
  ) {
    await enqueueRatingProjection(operationId, dependencies);
  }
  return { ok: true };
}

export {
  FEB_CHALLENGE_END_UTC,
  FEB_CHALLENGE_START_UTC,
  RATING_UPDATE_LEASE_MS,
  buildRatingPlan,
  readMatchRecord,
  resolveRatingResult,
};
