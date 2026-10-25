import {
  countMoveHistory,
  isMoveHistoryPrefix,
  type SubmitMoveRequest,
} from "@mons/shared/game-sessions";
import {
  isMatchFenWithinLimit,
  isMatchHistoryWithinLimits,
} from "@mons/shared/match-protocol";
import { AuthApiFailure } from "./authErrors.ts";
import {
  readCommittedTimerClaim,
  type RetainedTimerClaim,
} from "./matchClaimCodec.ts";
import {
  canonicalMatchDocumentJson,
  readMatchDocument,
  normalizeNewMatchDocument,
  readMoveMatch,
  writeMovedMatch,
  type MatchDocument,
} from "./matchRecordCodec.ts";

export const matchStateRecord = readMatchDocument;
export const normalizeCreatedMatchState = normalizeNewMatchDocument;

export function decideMatchStateMove(
  value: unknown,
  request: SubmitMoveRequest,
): {
  outcome: "applied" | "already-applied" | "superseded";
  value: MatchDocument;
} {
  const match = readMoveMatch(value);
  if (match.kind === "missing") {
    throw new AuthApiFailure(404, "not-found", "match-not-found");
  }
  if (match.kind === "invalid") {
    throw new AuthApiFailure(409, "failed-precondition", "match-invalid");
  }
  const history = match.flatMovesString;
  if (
    request.previousStates &&
    (!isMatchFenWithinLimit(match.fen) || !isMatchHistoryWithinLimits(history))
  ) {
    throw new AuthApiFailure(409, "failed-precondition", "match-invalid");
  }
  if (history === request.flatMovesString && match.fen === request.fen) {
    return { outcome: "already-applied", value: match.document };
  }
  if (
    request.previousStates &&
    history !== request.flatMovesString &&
    isMoveHistoryPrefix(request.flatMovesString, history)
  ) {
    return { outcome: "superseded", value: match.document };
  }
  const previousState =
    request.previousStates?.[
      countMoveHistory(history) -
        countMoveHistory(request.previousFlatMovesString)
    ];
  const matchesPreviousState = request.previousStates
    ? isMoveHistoryPrefix(request.previousFlatMovesString, history) &&
      isMoveHistoryPrefix(history, request.flatMovesString) &&
      previousState?.fen === match.fen
    : history === request.previousFlatMovesString;
  if (!matchesPreviousState) {
    throw new AuthApiFailure(409, "aborted", "move-chain-conflict");
  }
  return {
    outcome: "applied",
    value: writeMovedMatch(match.document, request),
  };
}

export function isCommittedMatchStateClaim(
  claim: RetainedTimerClaim,
  inviteId: string,
): boolean {
  return readCommittedTimerClaim(claim, inviteId) !== null;
}

export const canonicalMatchStateJson = canonicalMatchDocumentJson;
