import { writeMatchTimer, type MatchDocument } from "./matchRecordCodec.ts";
import {
  MATCH_TIMER_DURATION_MS,
  MATCH_TIMER_TERMINAL,
  formatMatchTimer,
  parseStrictMatchTimer,
} from "@mons/shared/timers";
import { AuthApiFailure } from "./authErrors.ts";
import type { MatchTimerStartCandidate } from "./gameplayCoordinationD1.ts";
import type { MatchTimerGameState, MatchTimerRecord } from "./matchTimer.ts";
import { canonicalMatchStateJson } from "./matchStateLogic.ts";
import {
  createClaimedTimerDocument,
  pendingTimerClaim,
  readCommittedTimerClaim,
  timerClaimStatus,
  type TimerClaimDocument,
} from "./matchClaimCodec.ts";
import type {
  MatchStateClaimTimerRequest,
  MatchStatePair,
} from "./matchStateTypes.ts";

export type TimerPair = {
  pair: MatchStatePair & {
    playerMatch: MatchDocument;
    opponentMatch: MatchDocument;
  };
  player: MatchTimerRecord;
  opponent: MatchTimerRecord;
  game: MatchTimerGameState;
};

export type MatchStateTimerStartPreparation = {
  turnNumber: number;
  existingTimer: string | null;
};

function fail(message: string): never {
  throw new AuthApiFailure(409, "failed-precondition", message);
}

function sameGameFields(
  left: MatchTimerRecord,
  right: MatchTimerRecord,
): boolean {
  return (
    left.color === right.color &&
    left.fen === right.fen &&
    left.flatMovesString === right.flatMovesString &&
    left.status === right.status
  );
}

export function timerTerminal(pair: TimerPair): boolean {
  return (
    pair.player.status === "surrendered" ||
    pair.opponent.status === "surrendered" ||
    pair.player.timer === MATCH_TIMER_TERMINAL ||
    pair.opponent.timer === MATCH_TIMER_TERMINAL ||
    pair.game.winner !== undefined
  );
}

export function assertTimerTurn(pair: TimerPair, claim = false): void {
  if (timerTerminal(pair)) fail("game is already over.");
  if (!pair.game.historyValid) fail("something is wrong with the moves.");
  if (pair.game.activeColor !== pair.opponent.color) {
    fail(
      claim
        ? "can't claim timer victory on your own turn."
        : "can't start a timer on your own turn.",
    );
  }
}

export function prepareMatchStateTimerStart(
  pair: TimerPair,
): MatchStateTimerStartPreparation {
  assertTimerTurn(pair);
  const stored = parseStrictMatchTimer(pair.player.timer);
  if (stored && stored.turnNumber > pair.game.turnNumber)
    fail("game state changed.");
  return {
    turnNumber: pair.game.turnNumber,
    existingTimer:
      stored?.turnNumber === pair.game.turnNumber ? pair.player.timer : null,
  };
}

export function buildMatchStateTimerStartCandidate(
  prepared: MatchStateTimerStartPreparation,
  nowMs: number,
): MatchTimerStartCandidate {
  return {
    timer:
      prepared.existingTimer ??
      formatMatchTimer(
        prepared.turnNumber,
        nowMs + MATCH_TIMER_DURATION_MS + 500,
      ),
    turnNumber: prepared.turnNumber,
  };
}

export function decideMatchStateTimerStartCommit(
  initial: TimerPair,
  fresh: TimerPair,
  marker: MatchTimerStartCandidate,
): { changed: boolean; playerMatch: MatchDocument; timer: string } {
  assertTimerTurn(fresh);
  if (
    !sameGameFields(initial.player, fresh.player) ||
    !sameGameFields(initial.opponent, fresh.opponent) ||
    initial.game.turnNumber !== fresh.game.turnNumber ||
    marker.turnNumber > fresh.game.turnNumber
  )
    fail("game state changed.");
  const parsedMarker = parseStrictMatchTimer(marker.timer);
  if (
    marker.turnNumber !== fresh.game.turnNumber ||
    parsedMarker?.turnNumber !== marker.turnNumber
  ) {
    throw new AuthApiFailure(
      503,
      "unavailable",
      "gameplay-service-unavailable",
    );
  }
  const freshTimer = parseStrictMatchTimer(fresh.player.timer);
  if (freshTimer && freshTimer.turnNumber > fresh.game.turnNumber)
    fail("game state changed.");
  return {
    changed: fresh.player.timer !== marker.timer,
    playerMatch: writeMatchTimer(fresh.pair.playerMatch, marker.timer),
    timer: marker.timer,
  };
}

export function decideMatchStateTimerClaim(
  current: TimerPair,
  input: MatchStateClaimTimerRequest,
  nowMs: number,
): {
  changed: boolean;
  playerMatch: MatchDocument;
  claim: TimerClaimDocument;
  claimedAtMs: number;
} {
  const existing = current.pair.claim;
  const replay = current.player.timer === MATCH_TIMER_TERMINAL;
  if (!replay) {
    assertTimerTurn(current, true);
    if (!current.player.timer) fail("could not find an existing timer.");
    const timer = parseStrictMatchTimer(current.player.timer);
    if (!timer) fail("wrong timer format.");
    if (timer.turnNumber !== current.game.turnNumber)
      fail("can't claim this timer anymore, it's turn is over.");
    if (timer.targetTimestamp > nowMs)
      fail(`can't claim yet, ${timer.targetTimestamp - nowMs} ms remaining`);
    if (timerClaimStatus(existing) === "claimed") {
      const committed = readCommittedTimerClaim(existing, input.inviteId);
      if (
        !committed ||
        committed.playerId !== input.playerId ||
        committed.opponentId !== input.opponentId ||
        committed.timer !== current.player.timer ||
        committed.turnNumber !== current.game.turnNumber
      )
        fail("game state changed.");
    } else {
      const pending = pendingTimerClaim(existing);
      if (pending && pending.expiresAtMs > nowMs) fail("game state changed.");
    }
  }
  const committed = existing
    ? readCommittedTimerClaim(existing, input.inviteId)
    : null;
  const claimedAtMs =
    committed &&
    committed.playerId === input.playerId &&
    committed.opponentId === input.opponentId
      ? Number(committed.claimedAtMs)
      : nowMs;
  const replayClaim =
    replay && existing
      ? readCommittedTimerClaim(existing, input.inviteId)
      : null;
  const claim = createClaimedTimerDocument({
    status: "claimed",
    playerId: input.playerId,
    opponentId: input.opponentId,
    inviteId: input.inviteId,
    timer: replayClaim ? replayClaim.timer : current.player.timer,
    turnNumber: current.game.turnNumber,
    claimedAtMs,
    expiresAtMs: null,
  });
  return {
    changed:
      !replay ||
      canonicalMatchStateJson(existing) !== canonicalMatchStateJson(claim),
    playerMatch: writeMatchTimer(
      current.pair.playerMatch,
      MATCH_TIMER_TERMINAL,
    ),
    claim,
    claimedAtMs,
  };
}
