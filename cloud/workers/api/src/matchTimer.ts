import { readMatchDocument, type MatchDocument } from "./matchRecordCodec.ts";
import {
  readInviteDocument,
  inviteMatchesParticipants,
  type InviteDocument,
} from "@mons/shared/invite-records";
import {
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
  isMatchHistoryWithinLimits,
  parseGameFromMatchData,
  selectLaterGame,
} from "@mons/shared/match-protocol";
import { parseInviteMatchIndex } from "@mons/shared/rematches";
import { Game } from "mons-rules";
import { AuthApiFailure } from "./authErrors.ts";
import { enforceRateLimit } from "./rateLimit.ts";
import type { RequestIdentity } from "./requestIdentity.ts";
import type { InviteAccessRepository } from "./gameplayContracts.ts";
import {
  authorizeMatchPlayer,
  createMatchAdmissionSignal,
  type MatchAdmissionDependencies,
} from "./matchAdmission.ts";

export type MatchTimerRecord = Pick<
  MatchDocument,
  "color" | "fen" | "flatMovesString" | "status" | "timer"
>;

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
      inviteValue: InviteDocument,
    ) => Promise<ClaimMatchVictoryByTimerResponse>;
  };

type MatchTimerRepository = InviteAccessRepository;

function failedPrecondition(message: string): AuthApiFailure {
  return new AuthApiFailure(409, "failed-precondition", message);
}

export function parseMatchTimerRecord(value: unknown): MatchTimerRecord | null {
  const match = readMatchDocument(value);
  return match === null
    ? null
    : {
        color: match.color,
        fen: match.fen,
        flatMovesString: match.flatMovesString,
        status: match.status,
        timer: match.timer,
      };
}

export function rawMatchTimerIsTerminal(value: unknown): boolean {
  const match = readMatchDocument(value);
  return (
    match !== null &&
    (match.status === "surrendered" || match.timer.state === "finished")
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
): Promise<InviteDocument> {
  const signal = createMatchAdmissionSignal(dependencies.signal);
  await authorizeMatchPlayer(identity, request.playerId, repository, {
    signal,
  });
  const inviteValue = readInviteDocument(
    await repository.readInviteMetadata(request.inviteId, signal),
  );
  if (
    !inviteMatchesParticipants(
      inviteValue,
      request.playerId,
      request.opponentId,
    ) ||
    parseInviteMatchIndex(request.inviteId, request.matchId) === null
  ) {
    throw new AuthApiFailure(403, "permission-denied", "permission-denied");
  }
  signal.throwIfAborted();
  await dependencies.assertMutationAllowed?.();
  return inviteValue!;
}

export async function enforceMatchTimerRateLimit(
  rateLimiter: RateLimit,
  uid: string,
): Promise<void> {
  return enforceRateLimit(
    rateLimiter,
    `timer:${uid}`,
    "Too many timer attempts.",
  );
}

export async function enforceMatchTimerClaimRateLimit(
  rateLimiter: RateLimit,
  uid: string,
): Promise<void> {
  return enforceRateLimit(
    rateLimiter,
    `timer-claim:${uid}`,
    "Too many timer claim attempts.",
  );
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
