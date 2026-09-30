import {
  MATCH_TIMER_TERMINAL,
  type ClaimMatchVictoryByTimerRequest,
  type ClaimMatchVictoryByTimerResponse,
  type StartMatchTimerRequest,
  type StartMatchTimerResponse,
} from "@mons/shared/timers";
import {
  MAX_MATCH_FEN_BYTES,
  MAX_MATCH_HISTORY_BYTES,
  MAX_MATCH_HISTORY_ENTRIES,
  buildOrderedMoveHistory as buildSharedOrderedMoveHistory,
  isMatchFenWithinLimit,
  isMatchHistoryWithinLimits,
  parseGameFromMatchData,
  selectLaterGame,
} from "@mons/shared/match-protocol";
import {
  inviteMatchesPlayers,
  parseInviteMatchIndex,
} from "@mons/shared/rematches";
import { Game } from "mons-rules";
import { AuthApiFailure } from "./authErrors.ts";
import type { RequestIdentity } from "./requestIdentity.ts";
import type { InviteAccessRepository } from "./gameplayContracts.ts";
import {
  authorizeMatchPlayer,
  createMatchAdmissionSignal,
  type MatchAdmissionDependencies,
} from "./matchAdmission.ts";

export type MatchTimerRecord = {
  color: "white" | "black";
  fen: string;
  flatMovesString: string;
  status: string;
  timer: string;
};

export type MatchTimerGameState = {
  activeColor: "white" | "black";
  historyValid: boolean;
  turnNumber: number;
  winner: "white" | "black" | undefined;
};

export type StartMatchTimerDependencies = MatchAdmissionDependencies & {
  startCanonical: (
    request: StartMatchTimerRequest,
  ) => Promise<StartMatchTimerResponse>;
};

export type ClaimMatchVictoryByTimerDependencies =
  MatchAdmissionDependencies & {
    claimCanonical: (
      request: ClaimMatchVictoryByTimerRequest,
      inviteValue: unknown,
    ) => Promise<ClaimMatchVictoryByTimerResponse>;
  };

type MatchTimerRepository = InviteAccessRepository;

function failedPrecondition(message: string): AuthApiFailure {
  return new AuthApiFailure(409, "failed-precondition", message);
}

function toRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function parseMatchTimerRecord(value: unknown): MatchTimerRecord | null {
  const record = toRecord(value);
  const color = record?.color;
  const fen = typeof record?.fen === "string" ? record.fen : "";
  const flatMovesString =
    typeof record?.flatMovesString === "string" ? record.flatMovesString : "";
  if (
    !record ||
    (color !== "white" && color !== "black") ||
    !fen.trim() ||
    !isMatchFenWithinLimit(fen) ||
    !isMatchHistoryWithinLimits(flatMovesString)
  ) {
    return null;
  }
  return {
    color,
    fen,
    flatMovesString,
    status: typeof record.status === "string" ? record.status : "",
    timer: typeof record.timer === "string" ? record.timer : "",
  };
}

export function rawMatchTimerIsTerminal(value: unknown): boolean {
  const record = toRecord(value);
  return (
    record?.status === "surrendered" || record?.timer === MATCH_TIMER_TERMINAL
  );
}

function movesFromFlatString(value: string): string[] {
  if (!isMatchHistoryWithinLimits(value)) {
    throw failedPrecondition("something is wrong with the game state.");
  }
  if (value === "") {
    return [];
  }
  return value.split("-");
}

export function buildOrderedMoveHistory(
  player: MatchTimerRecord,
  opponent: MatchTimerRecord,
): { white: string[]; black: string[] } {
  return buildSharedOrderedMoveHistory(player, opponent, (value) =>
    movesFromFlatString(typeof value === "string" ? value : ""),
  );
}

export function resolveMatchTimerGame(
  player: MatchTimerRecord,
  opponent: MatchTimerRecord,
): MatchTimerGameState {
  let playerGame: Game | undefined;
  let opponentGame: Game | undefined;
  try {
    playerGame = parseGameFromMatchData({ Game }, player);
    opponentGame = parseGameFromMatchData({ Game }, opponent);
  } catch {
    throw failedPrecondition("something is wrong with the game state.");
  }
  if (!playerGame || !opponentGame) {
    throw failedPrecondition("something is wrong with the game state.");
  }
  const game = selectLaterGame(playerGame, opponentGame);
  if (!game) {
    throw failedPrecondition("something is wrong with the game state.");
  }
  let historyValid = false;
  try {
    historyValid = game.verifyHistory(
      buildOrderedMoveHistory(player, opponent),
    );
  } catch {}
  return {
    activeColor: game.activeColor,
    historyValid,
    turnNumber: game.turnNumber,
    winner: game.winner,
  };
}

async function authorizeTimerMatch(
  identity: RequestIdentity,
  request: StartMatchTimerRequest,
  repository: MatchTimerRepository,
  dependencies: MatchAdmissionDependencies,
): Promise<unknown> {
  const signal = createMatchAdmissionSignal(dependencies.signal);
  await authorizeMatchPlayer(identity, request.playerId, repository, {
    signal,
  });
  const inviteValue = await repository.readInviteMetadata(
    request.inviteId,
    signal,
  );
  if (
    !inviteMatchesPlayers(inviteValue, request.playerId, request.opponentId) ||
    parseInviteMatchIndex(request.inviteId, request.matchId) === null
  ) {
    throw new AuthApiFailure(403, "permission-denied", "permission-denied");
  }
  signal.throwIfAborted();
  await dependencies.assertMutationAllowed?.();
  return inviteValue;
}

export async function enforceMatchTimerRateLimit(
  rateLimiter: RateLimit,
  uid: string,
): Promise<void> {
  let outcome: RateLimitOutcome;
  try {
    outcome = await rateLimiter.limit({ key: `timer:${uid}` });
  } catch {
    throw new AuthApiFailure(503, "unavailable", "rate-limit-unavailable");
  }
  if (!outcome.success) {
    throw new AuthApiFailure(
      429,
      "resource-exhausted",
      "Too many timer attempts.",
    );
  }
}

export async function enforceMatchTimerClaimRateLimit(
  rateLimiter: RateLimit,
  uid: string,
): Promise<void> {
  let outcome: RateLimitOutcome;
  try {
    outcome = await rateLimiter.limit({ key: `timer-claim:${uid}` });
  } catch {
    throw new AuthApiFailure(503, "unavailable", "rate-limit-unavailable");
  }
  if (!outcome.success) {
    throw new AuthApiFailure(
      429,
      "resource-exhausted",
      "Too many timer claim attempts.",
    );
  }
}

export async function startMatchTimer(
  identity: RequestIdentity,
  request: StartMatchTimerRequest,
  repository: MatchTimerRepository,
  dependencies: StartMatchTimerDependencies,
): Promise<StartMatchTimerResponse> {
  await authorizeTimerMatch(identity, request, repository, dependencies);
  return dependencies.startCanonical(request);
}

export async function claimMatchVictoryByTimer(
  identity: RequestIdentity,
  request: ClaimMatchVictoryByTimerRequest,
  repository: MatchTimerRepository,
  dependencies: ClaimMatchVictoryByTimerDependencies,
): Promise<ClaimMatchVictoryByTimerResponse> {
  const inviteValue = await authorizeTimerMatch(
    identity,
    request,
    repository,
    dependencies,
  );
  return dependencies.claimCanonical(request, inviteValue);
}

export {
  MAX_MATCH_FEN_BYTES,
  MAX_MATCH_HISTORY_BYTES,
  MAX_MATCH_HISTORY_ENTRIES,
};
