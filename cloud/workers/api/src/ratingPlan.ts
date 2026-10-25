import {
  inviteRatingEvent,
  inviteProjectionState,
  type InviteDocument,
} from "@mons/shared/invite-records";
import glicko2 from "glicko2";
import type { HistoricalMatchPair } from "@mons/shared/game-sessions";
import {
  buildOrderedMoveHistory,
  isMatchFenWithinLimit,
  isMatchHistoryWithinLimits,
  parseGameFromMatchData,
  selectLaterGame,
} from "@mons/shared/match-protocol";
import {
  createRatingUpdater,
  type RatingUpdateRequest,
} from "@mons/shared/ratings";
import { MATCH_TIMER_TERMINAL } from "@mons/shared/timers";
import { Color, Game, resolveMatch } from "mons-rules";
import { TELEGRAM_AUTOMATCH_VERSION } from "../../../runtime/telegram/automatchSource.js";
import { AuthApiFailure } from "./authErrors.ts";
import { HISTORICAL_MATCH_ARCHIVE_VERSION } from "./historicalMatches.ts";
import type {
  RatingCommitPlan,
  RatingCompletionPatch,
  RatingProfile,
  RatingProfilePatch,
} from "./ratingContracts.ts";
import {
  buildRatingDisplayNames,
  buildRatingMessage,
} from "./ratingMessage.ts";
import { TELEGRAM_PROJECTION_SCHEMA_VERSION } from "./telegramProjectionTasks.ts";
import { PROFILE_GAME_PROJECTION_SCHEMA_VERSION } from "./profileGameProjectionTasks.ts";

const FEB_CHALLENGE_START_UTC = Date.UTC(2026, 1, 1);
const FEB_CHALLENGE_END_UTC = Date.UTC(2026, 2, 1);

type RatingMatchRecord = {
  color: "white" | "black";
  emojiId: unknown;
  fen?: string;
  flatMovesString: string;
  status: string;
  timer: string;
};

type RatingResult = "gg" | "win";

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

function emptyProfile(): RatingProfile {
  return {
    aura: "",
    emoji: "",
    eth: "",
    nonce: 0,
    profileId: "",
    rating: 0,
    sol: "",
    totalManaPoints: 0,
    username: "",
  };
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
  invite: InviteDocument;
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
  const eventMetadata = inviteRatingEvent(invite);
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
  const { winnerDisplayName, loserDisplayName } = buildRatingDisplayNames({
    player: resolvedPlayer,
    opponent: resolvedOpponent,
    playerMatch,
    opponentMatch,
    result,
  });
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
  const playerUpdate: RatingProfilePatch | null = canUpdateRatings
    ? {
        ...(shouldApplyRatingDelta
          ? ({
              rating: result === "win" ? winnerNewRating : loserNewRating,
            } satisfies RatingProfilePatch)
          : {}),
        nonce: storedPlayerNonce,
        win: result === "win",
        totalManaPoints: resolvedPlayer.totalManaPoints + playerManaPoints,
      }
    : null;
  const opponentUpdate: RatingProfilePatch | null = canUpdateRatings
    ? {
        ...(shouldApplyRatingDelta
          ? ({
              rating: result === "win" ? loserNewRating : winnerNewRating,
            } satisfies RatingProfilePatch)
          : {}),
        nonce: storedOpponentNonce,
        win: result !== "win",
        totalManaPoints: resolvedOpponent.totalManaPoints + opponentManaPoints,
      }
    : null;
  const winnerScore = result === "win" ? playerManaPoints : opponentManaPoints;
  const loserScore = result === "win" ? opponentManaPoints : playerManaPoints;
  const updateRatingMessage = buildRatingMessage({
    winnerDisplayName,
    loserDisplayName,
    winnerNewRating,
    loserNewRating,
    winnerScore,
    loserScore,
    shouldApplyRatingDelta,
    playerMatch,
    opponentMatch,
    invite,
    matchId,
  });
  const shouldUpdateFebruaryChallenge =
    canUpdateRatings &&
    bothPlayersMoved &&
    !eventMetadata.isEventMatch &&
    nowMs >= FEB_CHALLENGE_START_UTC &&
    nowMs < FEB_CHALLENGE_END_UTC;
  const telegramDeliveryVersion =
    !eventMetadata.isEventMatch &&
    inviteProjectionState(invite).telegramDeliveryVersion ===
      TELEGRAM_AUTOMATCH_VERSION
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
        ? ({
            telegramProjectionVersion: TELEGRAM_PROJECTION_SCHEMA_VERSION,
            telegramProjectionState: "pending",
            telegramProjectionUpdatedAtMs: nowMs,
            telegramProjectionReason: null,
          } satisfies Partial<RatingCompletionPatch>)
        : {}),
      ...(eventMetadata.eventOwned && eventMetadata.eventId
        ? ({
            eventProgressVersion: 1,
            eventProgressState: "pending",
            eventProgressUpdatedAtMs: nowMs,
            eventProgressReason: null,
          } satisfies Partial<RatingCompletionPatch>)
        : {}),
      ...eventMetadata,
      updatedAtMs: nowMs,
      completedAtMs: nowMs,
      leaseExpiresAtMs: nowMs,
    },
  };
}

export {
  FEB_CHALLENGE_END_UTC,
  FEB_CHALLENGE_START_UTC,
  buildRatingPlan,
  readMatchRecord,
  resolveRatingResult,
};
