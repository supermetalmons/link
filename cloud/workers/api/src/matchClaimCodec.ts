import {
  isTimerClaim,
  type ClaimedTimerWrite,
  type TimerClaim,
  type PendingTimerClaim,
} from "@mons/shared/timers";
export type { ClaimedTimerWrite } from "@mons/shared/timers";

export type TimerClaimDocument = TimerClaim;
export type RetainedTimerClaim = TimerClaim | null;
export type TimerClaimWireValue = RetainedTimerClaim;

export function readRetainedTimerClaim(value: unknown): RetainedTimerClaim {
  if (value === null) return null;
  if (!isTimerClaim(value)) throw new TypeError("match-state-invalid-claim");
  return value;
}

export function readStoredTimerClaim(json: string): TimerClaimDocument {
  const value: unknown = JSON.parse(json);
  if (!isTimerClaim(value)) throw new TypeError("match-state-invalid-claim");
  return value;
}

export function timerClaimWireValue(
  value: RetainedTimerClaim,
): TimerClaimWireValue {
  return value;
}

export function timerClaimStatus(
  value: RetainedTimerClaim,
): "pending" | "claimed" | null {
  return value?.status ?? null;
}

export function pendingTimerClaim(
  value: RetainedTimerClaim,
): PendingTimerClaim | null {
  return value?.status === "pending" ? value : null;
}

export type CommittedTimerClaim = ClaimedTimerWrite;

export function readCommittedTimerClaim(
  value: RetainedTimerClaim,
  inviteId: string,
): (CommittedTimerClaim & { document: ClaimedTimerWrite }) | null {
  return value?.status === "claimed" && value.inviteId === inviteId
    ? { ...value, document: value }
    : null;
}

export function timerClaimIdentityMatches(
  value: RetainedTimerClaim,
  playerId: string,
  opponentId: string,
  inviteId: string,
): boolean {
  return (
    value !== null &&
    value.playerId === playerId &&
    value.opponentId === opponentId &&
    value.inviteId === inviteId
  );
}

export function createClaimedTimerDocument(
  value: ClaimedTimerWrite,
): ClaimedTimerWrite {
  if (!isTimerClaim(value)) throw new TypeError("match-state-invalid-claim");
  return structuredClone(value);
}
