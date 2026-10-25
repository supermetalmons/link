import {
  MATCH_TIMER_TERMINAL,
  parseStrictMatchTimer,
  type ClaimedTimerWrite,
} from "@mons/shared/timers";
import { isCanonicalLoginUid } from "./recordKeys.ts";
export type { ClaimedTimerWrite } from "@mons/shared/timers";

declare const timerClaimDocument: unique symbol;

export type TimerClaimDocument = { readonly [timerClaimDocument]: true };
export type RetainedTimerClaim =
  undefined | null | boolean | number | string | TimerClaimDocument;
export type TimerClaimWireValue =
  undefined | null | boolean | number | string | object;

type ClaimFields = {
  status?: unknown;
  inviteId?: unknown;
  playerId?: unknown;
  opponentId?: unknown;
  timer?: unknown;
  turnNumber?: unknown;
  claimedAtMs?: unknown;
  expiresAtMs?: unknown;
};

const fields = (value: RetainedTimerClaim): ClaimFields => value as ClaimFields;

export function readRetainedTimerClaim(value: object): TimerClaimDocument;
export function readRetainedTimerClaim(value: unknown): RetainedTimerClaim;
export function readRetainedTimerClaim(value: unknown): RetainedTimerClaim {
  if (
    value === undefined ||
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  )
    return value;
  if (typeof value === "object") return value as TimerClaimDocument;
  throw new TypeError("match-state-invalid-json");
}

export function readStoredTimerClaim(json: string): RetainedTimerClaim {
  const value: unknown = JSON.parse(json);
  return readRetainedTimerClaim(value);
}

export function timerClaimWireValue(
  value: RetainedTimerClaim,
): TimerClaimWireValue {
  return value;
}

export function timerClaimStatus(
  value: RetainedTimerClaim,
): "pending" | "claimed" | null {
  const status = fields(value)?.status;
  return status === "pending" || status === "claimed" ? status : null;
}

export function pendingTimerClaim(
  value: RetainedTimerClaim,
): { expiresAtMs: number } | null {
  const claim = fields(value);
  return claim?.status === "pending" && typeof claim.expiresAtMs === "number"
    ? { expiresAtMs: claim.expiresAtMs }
    : null;
}

export type CommittedTimerClaim = Omit<ClaimedTimerWrite, "expiresAtMs">;

export function readCommittedTimerClaim(
  value: RetainedTimerClaim,
  inviteId: string,
): (CommittedTimerClaim & { document: TimerClaimDocument }) | null {
  const claim = fields(value);
  const timer = parseStrictMatchTimer(claim.timer);
  if (
    claim.status !== "claimed" ||
    claim.inviteId !== inviteId ||
    !isCanonicalLoginUid(claim.playerId) ||
    !isCanonicalLoginUid(claim.opponentId) ||
    claim.playerId === claim.opponentId ||
    !Number.isSafeInteger(claim.turnNumber) ||
    (claim.turnNumber as number) < 0 ||
    !(
      claim.timer === MATCH_TIMER_TERMINAL ||
      timer?.turnNumber === claim.turnNumber
    ) ||
    !Number.isSafeInteger(claim.claimedAtMs) ||
    (claim.claimedAtMs as number) < 0 ||
    claim.expiresAtMs != null
  )
    return null;
  return {
    document: value as TimerClaimDocument,
    status: "claimed",
    inviteId: claim.inviteId,
    playerId: claim.playerId,
    opponentId: claim.opponentId,
    timer: claim.timer as string,
    turnNumber: claim.turnNumber as number,
    claimedAtMs: claim.claimedAtMs as number,
  };
}

export function timerClaimIdentityMatches(
  value: RetainedTimerClaim,
  playerId: string,
  opponentId: string,
  inviteId: string,
): boolean {
  const claim = fields(value);
  return (
    claim.playerId === playerId &&
    claim.opponentId === opponentId &&
    claim.inviteId === inviteId
  );
}

export function createClaimedTimerDocument(
  value: ClaimedTimerWrite,
): TimerClaimDocument {
  return value as object as TimerClaimDocument;
}
