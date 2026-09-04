import { parseStrictMatchTimer } from "@mons/shared/timers";
import {
  createInviteCandidatesFromMatchId,
  parseInviteMatchIndex,
} from "@mons/shared/rematches";
import type {
  MatchTimerStartReconciliationItem,
  MatchTimerStartStore,
} from "./gameplayCoordinationD1.ts";
import type { GameplayRepository } from "./gameplayRepository.ts";
import { isSafeFirebaseKey } from "./firebaseKeys.ts";
import {
  parseMatchTimerRecord,
  rawMatchTimerIsTerminal,
  resolveMatchTimerGame,
  type MatchTimerGameState,
  type MatchTimerRecord,
} from "./matchTimer.ts";

const MATCH_TIMER_START_SWEEP_CONCURRENCY = 5;
const MATCH_TIMER_START_INVITE_CANDIDATE_LIMIT = 17;

type MatchTimerStartSweepRepository = Pick<GameplayRepository, "getRtdbPath">;

export type MatchTimerStartSweepDependencies = {
  assertMutationAllowed: () => Promise<void>;
  logger?: Pick<Console, "error" | "info">;
  now?: () => number;
  resolveGame?: (
    player: MatchTimerRecord,
    opponent: MatchTimerRecord,
  ) => MatchTimerGameState;
};

export type MatchTimerStartSweepResult = {
  deleted: number;
  failed: number;
  retained: number;
  scanned: number;
  stale: number;
};

function toRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function rawTimerTurn(value: unknown): number | null {
  const timer = toRecord(value)?.timer;
  const parsed =
    typeof timer === "string" ? parseStrictMatchTimer(timer) : null;
  return parsed?.turnNumber ?? null;
}

function rawMatchProvesMarkerObsolete(
  marker: MatchTimerStartReconciliationItem,
  value: unknown,
): boolean {
  return (
    rawMatchTimerIsTerminal(value) ||
    (rawTimerTurn(value) ?? -1) > marker.turnNumber
  );
}

function opponentFromInvite(
  marker: MatchTimerStartReconciliationItem,
  inviteId: string,
  value: unknown,
): string | null {
  if (parseInviteMatchIndex(inviteId, marker.matchId) === null) return null;
  const invite = toRecord(value);
  const opponentId =
    invite?.hostId === marker.playerId
      ? invite.guestId
      : invite?.guestId === marker.playerId
        ? invite.hostId
        : null;
  return typeof opponentId === "string" &&
    opponentId !== marker.playerId &&
    isSafeFirebaseKey(opponentId)
    ? opponentId
    : null;
}

async function resolveLegacyOpponent(
  marker: MatchTimerStartReconciliationItem,
  repository: MatchTimerStartSweepRepository,
): Promise<string | null> {
  const candidates = [
    marker.matchId,
    ...createInviteCandidatesFromMatchId(marker.matchId),
  ];
  if (
    candidates.length > MATCH_TIMER_START_INVITE_CANDIDATE_LIMIT ||
    candidates.some((candidate) => !isSafeFirebaseKey(candidate))
  ) {
    return null;
  }
  const invites = await Promise.all(
    candidates.map((inviteId) => repository.getRtdbPath(`invites/${inviteId}`)),
  );
  const opponents = new Set(
    invites.flatMap((invite, index) => {
      const opponentId = opponentFromInvite(marker, candidates[index], invite);
      return opponentId ? [opponentId] : [];
    }),
  );
  return opponents.size === 1 ? [...opponents][0] : null;
}

function shouldDeleteMarker(
  marker: MatchTimerStartReconciliationItem,
  playerValue: unknown,
  opponentValue: unknown,
  resolveGame: NonNullable<MatchTimerStartSweepDependencies["resolveGame"]>,
): boolean {
  if (
    rawMatchProvesMarkerObsolete(marker, playerValue) ||
    rawMatchProvesMarkerObsolete(marker, opponentValue)
  ) {
    return true;
  }
  const player = parseMatchTimerRecord(playerValue);
  const opponent = parseMatchTimerRecord(opponentValue);
  if (!player || !opponent || player.color === opponent.color) {
    return false;
  }
  try {
    const game = resolveGame(player, opponent);
    return (
      game.historyValid &&
      (game.winner !== undefined || game.turnNumber > marker.turnNumber)
    );
  } catch {
    return false;
  }
}

async function reconcileKnownMatch(
  marker: MatchTimerStartReconciliationItem,
  playerValue: unknown,
  opponentValue: unknown,
  store: MatchTimerStartStore,
  nowMs: number,
  resolveGame: NonNullable<MatchTimerStartSweepDependencies["resolveGame"]>,
  assertMutationAllowed: () => Promise<void>,
): Promise<"deleted" | "retained" | "stale"> {
  if (shouldDeleteMarker(marker, playerValue, opponentValue, resolveGame)) {
    await assertMutationAllowed();
    return (await store.deleteIfUnchanged(marker)) ? "deleted" : "stale";
  }
  await assertMutationAllowed();
  return (await store.touchIfUnchanged(marker, nowMs)) ? "retained" : "stale";
}

async function reconcileMarker(
  marker: MatchTimerStartReconciliationItem,
  store: MatchTimerStartStore,
  repository: MatchTimerStartSweepRepository,
  nowMs: number,
  resolveGame: NonNullable<MatchTimerStartSweepDependencies["resolveGame"]>,
  assertMutationAllowed: () => Promise<void>,
): Promise<"deleted" | "retained" | "stale"> {
  const playerPath = `players/${marker.playerId}/matches/${marker.matchId}`;
  if (marker.opponentId === null) {
    const playerValue = await repository.getRtdbPath(playerPath);
    if (rawMatchProvesMarkerObsolete(marker, playerValue)) {
      await assertMutationAllowed();
      return (await store.deleteIfUnchanged(marker)) ? "deleted" : "stale";
    }
    const opponentId = await resolveLegacyOpponent(marker, repository);
    if (!opponentId) {
      await assertMutationAllowed();
      return (await store.touchIfUnchanged(marker, nowMs))
        ? "retained"
        : "stale";
    }
    await assertMutationAllowed();
    if (!(await store.backfillOpponentIfUnchanged(marker, opponentId))) {
      return "stale";
    }
    const activeMarker = { ...marker, opponentId };
    const opponentValue = await repository.getRtdbPath(
      `players/${opponentId}/matches/${marker.matchId}`,
    );
    return reconcileKnownMatch(
      activeMarker,
      playerValue,
      opponentValue,
      store,
      nowMs,
      resolveGame,
      assertMutationAllowed,
    );
  }
  const [playerValue, opponentValue] = await Promise.all([
    repository.getRtdbPath(playerPath),
    repository.getRtdbPath(
      `players/${marker.opponentId}/matches/${marker.matchId}`,
    ),
  ]);
  return reconcileKnownMatch(
    marker,
    playerValue,
    opponentValue,
    store,
    nowMs,
    resolveGame,
    assertMutationAllowed,
  );
}

export async function sweepMatchTimerStarts(
  store: MatchTimerStartStore,
  repository: MatchTimerStartSweepRepository,
  dependencies: MatchTimerStartSweepDependencies,
): Promise<MatchTimerStartSweepResult> {
  const logger = dependencies.logger || console;
  const result: MatchTimerStartSweepResult = {
    deleted: 0,
    failed: 0,
    retained: 0,
    scanned: 0,
    stale: 0,
  };
  let markers: MatchTimerStartReconciliationItem[];
  try {
    markers = await store.listOldest();
    result.scanned = markers.length;
  } catch (error) {
    result.failed = 1;
    logger.error(
      JSON.stringify({ event: "match_timer_start_sweep_failed", ...result }),
    );
    throw error;
  }
  const nowMs = (dependencies.now || Date.now)();
  const resolveGame = dependencies.resolveGame || resolveMatchTimerGame;
  let nextIndex = 0;
  let hasFailure = false;
  let firstFailure: unknown;
  const workers = Array.from(
    {
      length: Math.min(MATCH_TIMER_START_SWEEP_CONCURRENCY, markers.length),
    },
    async () => {
      while (nextIndex < markers.length) {
        const marker = markers[nextIndex++];
        try {
          result[
            await reconcileMarker(
              marker,
              store,
              repository,
              nowMs,
              resolveGame,
              dependencies.assertMutationAllowed,
            )
          ]++;
        } catch (error) {
          if (!hasFailure) firstFailure = error;
          hasFailure = true;
          result.failed++;
        }
      }
    },
  );
  await Promise.all(workers);
  const summary = {
    event: hasFailure
      ? "match_timer_start_sweep_failed"
      : "match_timer_start_sweep_completed",
    ...result,
  };
  if (hasFailure) {
    logger.error(JSON.stringify(summary));
    throw firstFailure;
  }
  if (result.scanned > 0) {
    logger.info(JSON.stringify(summary));
  }
  return result;
}
