import {
  MATCH_TIMER_DURATION_MS,
  MATCH_TIMER_START_ROOT,
  MATCH_TIMER_TERMINAL,
  formatMatchTimer,
  parseStrictMatchTimer,
  type StartMatchTimerRequest,
  type StartMatchTimerResponse,
} from "@mons/shared/timers";
import {
  buildOrderedMoveHistory as buildSharedOrderedMoveHistory,
  parseGameFromMatchData,
  selectLaterGame,
} from "@mons/shared/match-protocol";
import {
  inviteMatchesPlayers,
  parseInviteMatchIndex,
} from "@mons/shared/rematches";
import { Color, Game } from "mons-rules";
import { AuthApiFailure } from "./authErrors.ts";
import type { FirebaseIdentity } from "./firebaseAuth.ts";
import type { GameplayRepository } from "./gameplayRepository.ts";

const TIMER_DEADLINE_GRACE_MS = 500;
const MAX_MATCH_FEN_BYTES = 16 * 1024;
const MAX_MATCH_HISTORY_BYTES = 64 * 1024;
const MAX_MATCH_HISTORY_ENTRIES = 2_048;
const MATCH_TIMER_OPERATION_TIMEOUT_MS = 20_000;

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

type MatchTimerMarker = {
  timer: string;
  turnNumber: number;
};

export type MatchTimerDependencies = {
  now?: () => number;
  signal?: AbortSignal;
  resolveGame?: (
    player: MatchTimerRecord,
    opponent: MatchTimerRecord,
  ) => MatchTimerGameState;
};

type MatchTimerRepository = Pick<
  GameplayRepository,
  "getRtdbPath" | "transactRtdbPath"
>;

function failedPrecondition(message: string): AuthApiFailure {
  return new AuthApiFailure(409, "failed-precondition", message);
}

function toRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readMatchTimerRecord(value: unknown): MatchTimerRecord {
  const record = toRecord(value);
  const color = record?.color;
  const fen = typeof record?.fen === "string" ? record.fen : "";
  const flatMovesString =
    typeof record?.flatMovesString === "string" ? record.flatMovesString : "";
  if (
    !record ||
    (color !== "white" && color !== "black") ||
    !fen.trim() ||
    new TextEncoder().encode(fen).byteLength > MAX_MATCH_FEN_BYTES ||
    new TextEncoder().encode(flatMovesString).byteLength >
      MAX_MATCH_HISTORY_BYTES
  ) {
    throw failedPrecondition("something is wrong with the game state.");
  }
  return {
    color,
    fen,
    flatMovesString,
    status: typeof record.status === "string" ? record.status : "",
    timer: typeof record.timer === "string" ? record.timer : "",
  };
}

function movesFromFlatString(value: string): string[] {
  if (value === "") {
    return [];
  }
  let entries = 1;
  for (const character of value) {
    if (character === "-" && ++entries > MAX_MATCH_HISTORY_ENTRIES) {
      throw failedPrecondition("something is wrong with the game state.");
    }
  }
  return value.split("-");
}

async function readMatchRecords(
  request: StartMatchTimerRequest,
  repository: MatchTimerRepository,
  signal: AbortSignal,
): Promise<[unknown, unknown, unknown]> {
  const paths = [
    `players/${request.playerId}/matches/${request.matchId}`,
    `players/${request.opponentId}/matches/${request.matchId}`,
    `invites/${request.inviteId}`,
  ];
  const initial = await Promise.allSettled(
    paths.map((path) => repository.getRtdbPath(path, undefined, signal)),
  );
  const values = await Promise.all(
    initial.map((result, index) =>
      result.status === "fulfilled"
        ? result.value
        : repository.getRtdbPath(paths[index], undefined, signal),
    ),
  );
  return [values[0], values[1], values[2]];
}

function parseMatchTimerMarker(value: unknown): MatchTimerMarker | null {
  const marker = toRecord(value);
  const timer = typeof marker?.timer === "string" ? marker.timer : "";
  const parsed = parseStrictMatchTimer(timer);
  if (
    !parsed ||
    !Number.isSafeInteger(marker?.turnNumber) ||
    marker?.turnNumber !== parsed.turnNumber
  ) {
    return null;
  }
  return { timer, turnNumber: parsed.turnNumber };
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

async function authorizePlayer(
  identity: FirebaseIdentity,
  playerId: string,
  repository: MatchTimerRepository,
  signal: AbortSignal,
): Promise<void> {
  if (identity.uid === playerId) {
    return;
  }
  const linkedProfileId = await repository.getRtdbPath(
    `players/${playerId}/profile`,
    undefined,
    signal,
  );
  if (
    typeof linkedProfileId !== "string" ||
    !identity.profileId ||
    linkedProfileId.trim() !== identity.profileId
  ) {
    throw new AuthApiFailure(403, "permission-denied", "permission-denied");
  }
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

export async function startMatchTimer(
  identity: FirebaseIdentity,
  request: StartMatchTimerRequest,
  repository: MatchTimerRepository,
  dependencies: MatchTimerDependencies = {},
): Promise<StartMatchTimerResponse> {
  const timeoutSignal = AbortSignal.timeout(MATCH_TIMER_OPERATION_TIMEOUT_MS);
  const signal = dependencies.signal
    ? AbortSignal.any([dependencies.signal, timeoutSignal])
    : timeoutSignal;
  await authorizePlayer(identity, request.playerId, repository, signal);
  const [playerValue, opponentValue, inviteValue] = await readMatchRecords(
    request,
    repository,
    signal,
  );
  if (
    !inviteMatchesPlayers(inviteValue, request.playerId, request.opponentId) ||
    parseInviteMatchIndex(request.inviteId, request.matchId) === null
  ) {
    throw new AuthApiFailure(403, "permission-denied", "permission-denied");
  }
  const player = readMatchTimerRecord(playerValue);
  const opponent = readMatchTimerRecord(opponentValue);
  if (player.color === opponent.color) {
    throw failedPrecondition("something is wrong with the game state.");
  }
  const game = (dependencies.resolveGame || resolveMatchTimerGame)(
    player,
    opponent,
  );
  if (
    player.status === "surrendered" ||
    opponent.status === "surrendered" ||
    game.winner !== undefined ||
    player.timer === MATCH_TIMER_TERMINAL ||
    opponent.timer === MATCH_TIMER_TERMINAL
  ) {
    throw failedPrecondition("game is already over.");
  }
  if (!game.historyValid) {
    throw failedPrecondition("something is wrong with the moves.");
  }
  const opponentColor = opponent.color === "white" ? Color.White : Color.Black;
  if (game.activeColor !== opponentColor) {
    throw failedPrecondition("can't start a timer on your own turn.");
  }
  const nowMs = (dependencies.now || Date.now)();
  const proposedTimer = formatMatchTimer(
    game.turnNumber,
    nowMs + MATCH_TIMER_DURATION_MS + TIMER_DEADLINE_GRACE_MS,
  );
  const storedTimer = parseStrictMatchTimer(player.timer);
  const timerCandidate =
    storedTimer?.turnNumber === game.turnNumber ? player.timer : proposedTimer;
  const markerCandidate: MatchTimerMarker = {
    timer: timerCandidate,
    turnNumber: game.turnNumber,
  };
  const markerPath = `${MATCH_TIMER_START_ROOT}/${request.playerId}/${request.matchId}`;
  const markerTransaction = await repository.transactRtdbPath(
    markerPath,
    (current) => {
      const marker = parseMatchTimerMarker(current);
      if (marker && marker.turnNumber > game.turnNumber) {
        return { commit: false, decision: "newer-turn" };
      }
      if (marker?.turnNumber === game.turnNumber) {
        return { commit: false, decision: "already-started" };
      }
      return { decision: "started", value: markerCandidate };
    },
    signal,
  );
  if (markerTransaction.decision === "newer-turn") {
    throw failedPrecondition("game state changed.");
  }
  const marker = markerTransaction.committed
    ? markerCandidate
    : parseMatchTimerMarker(markerTransaction.value);
  if (!marker || marker.turnNumber !== game.turnNumber) {
    throw new AuthApiFailure(
      503,
      "unavailable",
      "gameplay-service-unavailable",
    );
  }
  const timer = marker.timer;
  const timerTransaction = await repository.transactRtdbPath(
    `players/${request.playerId}/matches/${request.matchId}/timer`,
    (current) => {
      if (current === MATCH_TIMER_TERMINAL) {
        return { commit: false, decision: "terminal" };
      }
      const parsed = parseStrictMatchTimer(current);
      if (parsed && parsed.turnNumber > game.turnNumber) {
        return { commit: false, decision: "newer-turn" };
      }
      if (current === timer) {
        return { commit: false, decision: "synchronized" };
      }
      return { decision: "synchronized", value: timer };
    },
    signal,
  );
  if (timerTransaction.decision === "terminal") {
    await repository.transactRtdbPath(
      markerPath,
      (current) =>
        current === null
          ? { commit: false, decision: "missing" }
          : { decision: "cleared", value: null },
      signal,
    );
    throw failedPrecondition("game is already over.");
  }
  if (timerTransaction.decision === "newer-turn") {
    throw failedPrecondition("game state changed.");
  }
  return { ok: true, timer, duration: MATCH_TIMER_DURATION_MS };
}

export {
  MAX_MATCH_FEN_BYTES,
  MAX_MATCH_HISTORY_BYTES,
  MAX_MATCH_HISTORY_ENTRIES,
  MATCH_TIMER_START_ROOT,
};
