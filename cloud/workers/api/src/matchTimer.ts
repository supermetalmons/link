import {
  MATCH_TIMER_DURATION_MS,
  MATCH_TIMER_CLAIM_ROOT,
  MATCH_TIMER_TERMINAL,
  formatMatchTimer,
  parseStrictMatchTimer,
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
import { Color, Game } from "mons-rules";
import { AuthApiFailure } from "./authErrors.ts";
import type { RequestIdentity } from "./requestIdentity.ts";
import { isSafeFirebaseKey } from "./firebaseKeys.ts";
import type { MatchTimerStartStore } from "./gameplayCoordinationD1.ts";
import type { GameplayRepository } from "./gameplayRepository.ts";
import {
  buildEventProgressPlan,
  type EventProgressPlan,
} from "./eventProgress.ts";
import {
  getLoginProfileId,
  requireProfileOwnershipSnapshot,
} from "./profileOwnership.ts";

const MATCH_TIMER_CLAIM_LEASE_MS = 30_000;
const MATCH_TIMER_CLAIM_SIDE_EFFECT_ATTEMPTS = 3;
const TIMER_DEADLINE_GRACE_MS = 500;
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

function matchIsTerminal(
  player: MatchTimerRecord,
  opponent: MatchTimerRecord,
  game: MatchTimerGameState,
): boolean {
  return (
    player.status === "surrendered" ||
    opponent.status === "surrendered" ||
    game.winner !== undefined ||
    player.timer === MATCH_TIMER_TERMINAL ||
    opponent.timer === MATCH_TIMER_TERMINAL
  );
}

function matchStateMatches(
  current: MatchTimerRecord,
  expected: MatchTimerRecord,
): boolean {
  return (
    current.color === expected.color &&
    current.fen === expected.fen &&
    current.flatMovesString === expected.flatMovesString &&
    current.status === expected.status
  );
}

type MatchTimerMarker = {
  timer: string;
  turnNumber: number;
};

type MatchTimerClaimFence = {
  expiresAtMs: number;
  inviteId: string;
  opponentId: string;
  playerId: string;
  status: "pending";
  timer: string;
  turnNumber: number;
};

export type MatchTimerDependencies = {
  assertMutationAllowed?: () => Promise<void>;
  enqueueEventProgress?: (plan: EventProgressPlan) => Promise<void>;
  now?: () => number;
  timerStarts: MatchTimerStartStore;
  signal?: AbortSignal;
  resolveGame?: (
    player: MatchTimerRecord,
    opponent: MatchTimerRecord,
  ) => MatchTimerGameState;
};

type MatchTimerRepository = Pick<
  GameplayRepository,
  "getRtdbPath" | "readProfileOwnershipSnapshot" | "transactRtdbPath"
>;

type MatchTimerClaimRepository = Pick<
  GameplayRepository,
  | "getRtdbPath"
  | "patchRtdbRoot"
  | "readProfileOwnershipSnapshot"
  | "transactRtdbPath"
>;

type MatchTimerRequest =
  ClaimMatchVictoryByTimerRequest | StartMatchTimerRequest;

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

function readMatchTimerRecord(value: unknown): MatchTimerRecord {
  const record = parseMatchTimerRecord(value);
  if (!record) {
    throw failedPrecondition("something is wrong with the game state.");
  }
  return record;
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

async function readMatchRecords(
  request: MatchTimerRequest,
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
  identity: RequestIdentity,
  playerId: string,
  repository: MatchTimerRepository,
  signal: AbortSignal,
): Promise<void> {
  if (identity.uid === playerId) {
    return;
  }
  signal.throwIfAborted();
  const ownership = await requireProfileOwnershipSnapshot(repository, {
    loginUids: [identity.uid, playerId],
    profileIds: [],
  });
  const identityProfileId = getLoginProfileId(ownership, identity.uid);
  const playerProfileId = getLoginProfileId(ownership, playerId);
  if (!identityProfileId || identityProfileId !== playerProfileId) {
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

async function buildTimerClaimSideEffectUpdates(
  inviteValue: unknown,
  request: ClaimMatchVictoryByTimerRequest,
  fence: MatchTimerClaimFence,
  nowMs: number,
): Promise<{
  progress: EventProgressPlan | null;
  updates: Record<string, unknown>;
}> {
  const updates: Record<string, unknown> = {
    [`players/${request.playerId}/matches/${request.matchId}/timer`]:
      MATCH_TIMER_TERMINAL,
    [`${MATCH_TIMER_CLAIM_ROOT}/${request.matchId}`]: {
      ...fence,
      status: "claimed",
      claimedAtMs: nowMs,
      expiresAtMs: null,
    },
  };
  const invite = toRecord(inviteValue);
  const eventId =
    invite?.eventOwned === true && typeof invite.eventId === "string"
      ? invite.eventId.trim()
      : "";
  if (!eventId || !isSafeFirebaseKey(eventId)) {
    return { progress: null, updates };
  }
  const sourceKey = `timer:${request.inviteId}:${request.matchId}`;
  const progress = await buildEventProgressPlan(
    {
      eventId,
      sourceKey,
      reason: "timer-claimed",
    },
    nowMs,
  );
  updates[`eventProgressOutbox/${progress.outboxId}`] = progress.outbox;
  return { progress, updates };
}

async function deleteTimerStartMarkers(
  request: Pick<StartMatchTimerRequest, "matchId" | "opponentId" | "playerId">,
  dependencies: MatchTimerDependencies,
): Promise<void> {
  await dependencies.assertMutationAllowed?.();
  await dependencies.timerStarts.deletePair(
    request.playerId,
    request.opponentId,
    request.matchId,
  );
}

async function persistClaimSideEffectsAndDispatch(
  sideEffects: Awaited<ReturnType<typeof buildTimerClaimSideEffectUpdates>>,
  request: ClaimMatchVictoryByTimerRequest,
  repository: MatchTimerClaimRepository,
  signal: AbortSignal,
  dependencies: MatchTimerDependencies,
  timerMarkersDeleted = false,
): Promise<void> {
  await dependencies.assertMutationAllowed?.();
  await persistTimerClaimSideEffects(sideEffects.updates, repository, signal);
  if (!timerMarkersDeleted) {
    await deleteTimerStartMarkers(request, dependencies);
  }
  if (sideEffects.progress && dependencies.enqueueEventProgress) {
    await dependencies.enqueueEventProgress(sideEffects.progress);
  }
}

async function persistTimerClaimSideEffects(
  updates: Record<string, unknown>,
  repository: MatchTimerClaimRepository,
  signal: AbortSignal,
): Promise<void> {
  let lastError: unknown;
  for (
    let attempt = 0;
    attempt < MATCH_TIMER_CLAIM_SIDE_EFFECT_ATTEMPTS;
    attempt++
  ) {
    try {
      await repository.patchRtdbRoot(updates, signal);
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

function matchSnapshotIsCurrent(
  current: Record<string, unknown>,
  snapshot: MatchTimerRecord,
): boolean {
  return (
    current.color === snapshot.color &&
    current.fen === snapshot.fen &&
    (typeof current.flatMovesString === "string"
      ? current.flatMovesString
      : "") === snapshot.flatMovesString &&
    (typeof current.status === "string" ? current.status : "") ===
      snapshot.status &&
    (typeof current.timer === "string" ? current.timer : "") === snapshot.timer
  );
}

function claimFenceMatches(
  value: Record<string, unknown>,
  fence: MatchTimerClaimFence,
): boolean {
  return (
    value.playerId === fence.playerId &&
    value.opponentId === fence.opponentId &&
    value.inviteId === fence.inviteId &&
    value.timer === fence.timer &&
    value.turnNumber === fence.turnNumber
  );
}

async function releasePendingClaimFence(
  path: string,
  fence: MatchTimerClaimFence,
  repository: MatchTimerClaimRepository,
  signal: AbortSignal,
): Promise<void> {
  await repository.transactRtdbPath(
    path,
    (current) => {
      const value = toRecord(current);
      return value?.status === "pending" && claimFenceMatches(value, fence)
        ? { decision: "released", value: null }
        : { commit: false, decision: "preserved" };
    },
    signal,
  );
}

export async function startMatchTimer(
  identity: RequestIdentity,
  request: StartMatchTimerRequest,
  repository: MatchTimerRepository,
  dependencies: MatchTimerDependencies,
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
  if (
    rawMatchTimerIsTerminal(playerValue) ||
    rawMatchTimerIsTerminal(opponentValue)
  ) {
    await deleteTimerStartMarkers(request, dependencies);
    throw failedPrecondition("game is already over.");
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
  if (matchIsTerminal(player, opponent, game)) {
    await deleteTimerStartMarkers(request, dependencies);
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
  await dependencies.assertMutationAllowed?.();
  const marker = await dependencies.timerStarts.getOrAdvance(
    request.playerId,
    request.opponentId,
    request.matchId,
    markerCandidate,
    nowMs,
  );
  if (marker.turnNumber > game.turnNumber) {
    throw failedPrecondition("game state changed.");
  }
  if (marker.turnNumber !== game.turnNumber) {
    throw new AuthApiFailure(
      503,
      "unavailable",
      "gameplay-service-unavailable",
    );
  }
  const timer = marker.timer;
  const [freshPlayerValue, freshOpponentValue, freshInviteValue] =
    await readMatchRecords(request, repository, signal);
  if (
    rawMatchTimerIsTerminal(freshPlayerValue) ||
    rawMatchTimerIsTerminal(freshOpponentValue)
  ) {
    await deleteTimerStartMarkers(request, dependencies);
    throw failedPrecondition("game is already over.");
  }
  const freshPlayer = readMatchTimerRecord(freshPlayerValue);
  const freshOpponent = readMatchTimerRecord(freshOpponentValue);
  const freshGame = (dependencies.resolveGame || resolveMatchTimerGame)(
    freshPlayer,
    freshOpponent,
  );
  if (matchIsTerminal(freshPlayer, freshOpponent, freshGame)) {
    await deleteTimerStartMarkers(request, dependencies);
    throw failedPrecondition("game is already over.");
  }
  const freshOpponentColor =
    freshOpponent.color === "white" ? Color.White : Color.Black;
  if (
    !inviteMatchesPlayers(
      freshInviteValue,
      request.playerId,
      request.opponentId,
    ) ||
    !matchStateMatches(freshPlayer, player) ||
    !matchStateMatches(freshOpponent, opponent) ||
    !freshGame.historyValid ||
    freshGame.turnNumber !== game.turnNumber ||
    freshGame.activeColor !== freshOpponentColor
  ) {
    throw failedPrecondition("game state changed.");
  }
  await dependencies.assertMutationAllowed?.();
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
    await deleteTimerStartMarkers(request, dependencies);
    throw failedPrecondition("game is already over.");
  }
  if (timerTransaction.decision === "newer-turn") {
    throw failedPrecondition("game state changed.");
  }
  return { ok: true, timer, duration: MATCH_TIMER_DURATION_MS };
}

export async function claimMatchVictoryByTimer(
  identity: RequestIdentity,
  request: ClaimMatchVictoryByTimerRequest,
  repository: MatchTimerClaimRepository,
  dependencies: MatchTimerDependencies,
): Promise<ClaimMatchVictoryByTimerResponse> {
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
  const timerMarkersDeleted =
    rawMatchTimerIsTerminal(playerValue) ||
    rawMatchTimerIsTerminal(opponentValue);
  if (timerMarkersDeleted) {
    await deleteTimerStartMarkers(request, dependencies);
  }
  const player = readMatchTimerRecord(playerValue);
  const opponent = readMatchTimerRecord(opponentValue);
  if (player.color === opponent.color) {
    throw failedPrecondition("something is wrong with the game state.");
  }
  const now = dependencies.now || Date.now;
  const game = (dependencies.resolveGame || resolveMatchTimerGame)(
    player,
    opponent,
  );
  if (player.timer === MATCH_TIMER_TERMINAL) {
    const replayedAtMs = now();
    const replayFence: MatchTimerClaimFence = {
      status: "pending",
      playerId: request.playerId,
      opponentId: request.opponentId,
      inviteId: request.inviteId,
      timer: MATCH_TIMER_TERMINAL,
      turnNumber: game.turnNumber,
      expiresAtMs: replayedAtMs + MATCH_TIMER_CLAIM_LEASE_MS,
    };
    await persistClaimSideEffectsAndDispatch(
      await buildTimerClaimSideEffectUpdates(
        inviteValue,
        request,
        replayFence,
        replayedAtMs,
      ),
      request,
      repository,
      signal,
      dependencies,
      timerMarkersDeleted,
    );
    return { ok: true };
  }
  if (
    player.status === "surrendered" ||
    opponent.status === "surrendered" ||
    opponent.timer === MATCH_TIMER_TERMINAL ||
    game.winner !== undefined
  ) {
    if (!timerMarkersDeleted) {
      await deleteTimerStartMarkers(request, dependencies);
    }
    throw failedPrecondition("game is already over.");
  }
  if (!game.historyValid) {
    throw failedPrecondition("something is wrong with the moves.");
  }
  const opponentColor = opponent.color === "white" ? Color.White : Color.Black;
  if (game.activeColor !== opponentColor) {
    throw failedPrecondition("can't claim timer victory on your own turn.");
  }
  if (!player.timer) {
    throw failedPrecondition("could not find an existing timer.");
  }
  const parsedTimer = parseStrictMatchTimer(player.timer);
  if (!parsedTimer) {
    throw failedPrecondition("wrong timer format.");
  }
  if (game.turnNumber !== parsedTimer.turnNumber) {
    throw failedPrecondition(
      "can't claim this timer anymore, it's turn is over.",
    );
  }
  const nowMs = now();
  const timeDelta = parsedTimer.targetTimestamp - nowMs;
  if (timeDelta > 0) {
    throw failedPrecondition(`can't claim yet, ${timeDelta} ms remaining`);
  }

  const claimPath = `${MATCH_TIMER_CLAIM_ROOT}/${request.matchId}`;
  const claimFence: MatchTimerClaimFence = {
    status: "pending",
    playerId: request.playerId,
    opponentId: request.opponentId,
    inviteId: request.inviteId,
    timer: player.timer,
    turnNumber: game.turnNumber,
    expiresAtMs: nowMs + MATCH_TIMER_CLAIM_LEASE_MS,
  };
  await dependencies.assertMutationAllowed?.();
  const claimTransaction = await repository.transactRtdbPath(
    claimPath,
    (current) => {
      const value = toRecord(current);
      if (value?.status === "claimed") {
        return claimFenceMatches(value, claimFence)
          ? { commit: false, decision: "already-claimed" }
          : { commit: false, decision: "busy" };
      }
      if (
        value?.status === "pending" &&
        typeof value.expiresAtMs === "number" &&
        value.expiresAtMs > nowMs
      ) {
        return { commit: false, decision: "busy" };
      }
      return { decision: "acquired", value: claimFence };
    },
    signal,
  );
  if (claimTransaction.decision === "busy") {
    throw failedPrecondition("game state changed.");
  }
  if (claimTransaction.decision === "already-claimed") {
    await persistClaimSideEffectsAndDispatch(
      await buildTimerClaimSideEffectUpdates(
        inviteValue,
        request,
        claimFence,
        now(),
      ),
      request,
      repository,
      signal,
      dependencies,
    );
    return { ok: true };
  }

  let freshValues: [unknown, unknown, unknown];
  try {
    freshValues = await readMatchRecords(request, repository, signal);
  } catch (error) {
    await releasePendingClaimFence(claimPath, claimFence, repository, signal);
    throw error;
  }
  const [freshPlayerValue, freshOpponentValue, freshInviteValue] = freshValues;
  let snapshotsMatch = false;
  try {
    snapshotsMatch =
      matchSnapshotIsCurrent(toRecord(freshPlayerValue) || {}, player) &&
      matchSnapshotIsCurrent(toRecord(freshOpponentValue) || {}, opponent) &&
      inviteMatchesPlayers(
        freshInviteValue,
        request.playerId,
        request.opponentId,
      );
  } catch {}
  if (!snapshotsMatch) {
    await releasePendingClaimFence(claimPath, claimFence, repository, signal);
    throw failedPrecondition("game state changed.");
  }

  await persistClaimSideEffectsAndDispatch(
    await buildTimerClaimSideEffectUpdates(
      freshInviteValue,
      request,
      claimFence,
      now(),
    ),
    request,
    repository,
    signal,
    dependencies,
  );
  return { ok: true };
}

export {
  MAX_MATCH_FEN_BYTES,
  MAX_MATCH_HISTORY_BYTES,
  MAX_MATCH_HISTORY_ENTRIES,
};
