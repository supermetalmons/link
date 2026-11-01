import {
  buildEventProgressPlan,
  type EventProgressPlan,
} from "./eventProgressCodec.ts";
import type { MatchStateClaimTimerRequest } from "./matchStateTypes.ts";
import { isSafeRecordKey } from "./recordKeys.ts";

export type TimerClaimEffectPayload = {
  schemaVersion: 1;
  kind: "timer-claimed";
  effectId: string;
  inviteId: string;
  matchId: string;
  playerId: string;
  opponentId: string;
  epoch: number;
  claimedAtMs: number;
  eventId: string | null;
  sourceKey: string;
};
export type DueMatchEffect = TimerClaimEffectPayload & {
  state: "pending";
  nextAtMs: number;
  attempts: number;
};
export type MatchEffectTarget = { effectId: string };

function invalid(): never {
  throw new TypeError("match-state-invalid-effect");
}
function key(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim() === value &&
    isSafeRecordKey(value)
  );
}
function integer(value: unknown, minimum = 0): value is number {
  return (
    typeof value === "number" && Number.isSafeInteger(value) && value >= minimum
  );
}

export function parseTimerClaimEffectPayload(
  value: unknown,
): TimerClaimEffectPayload {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    invalid();
  const row: Record<string, unknown> = Object.fromEntries(
    Object.entries(value),
  );
  const fields = [
    "schemaVersion",
    "kind",
    "effectId",
    "inviteId",
    "matchId",
    "playerId",
    "opponentId",
    "epoch",
    "claimedAtMs",
    "eventId",
    "sourceKey",
  ];
  if (
    Object.keys(row).length !== fields.length ||
    fields.some((field) => !Object.hasOwn(row, field)) ||
    row.schemaVersion !== 1 ||
    row.kind !== "timer-claimed" ||
    !key(row.effectId) ||
    !key(row.inviteId) ||
    !key(row.matchId) ||
    !key(row.playerId) ||
    !key(row.opponentId) ||
    row.playerId === row.opponentId ||
    !integer(row.epoch, 1) ||
    !integer(row.claimedAtMs) ||
    !(row.eventId === null || key(row.eventId)) ||
    row.effectId !== `timer:${row.inviteId}:${row.matchId}` ||
    row.sourceKey !== row.effectId
  )
    invalid();
  return {
    schemaVersion: 1,
    kind: "timer-claimed",
    effectId: row.effectId,
    inviteId: row.inviteId,
    matchId: row.matchId,
    playerId: row.playerId,
    opponentId: row.opponentId,
    epoch: row.epoch,
    claimedAtMs: row.claimedAtMs,
    eventId: row.eventId,
    sourceKey: row.sourceKey,
  };
}

export function createTimerClaimEffectPayload(
  input: MatchStateClaimTimerRequest,
  claimedAtMs: number,
): TimerClaimEffectPayload {
  const effectId = `timer:${input.inviteId}:${input.matchId}`;
  return parseTimerClaimEffectPayload({
    schemaVersion: 1,
    kind: "timer-claimed",
    effectId,
    inviteId: input.inviteId,
    matchId: input.matchId,
    playerId: input.playerId,
    opponentId: input.opponentId,
    epoch: input.epoch,
    claimedAtMs,
    eventId: input.eventId ?? null,
    sourceKey: effectId,
  });
}

export function matchesStoredTimerEffect(
  json: string,
  input: MatchStateClaimTimerRequest,
): boolean {
  const value: unknown = JSON.parse(json);
  const previous = parseTimerClaimEffectPayload(value);
  return (
    previous.inviteId === input.inviteId &&
    previous.matchId === input.matchId &&
    previous.playerId === input.playerId &&
    previous.opponentId === input.opponentId &&
    previous.epoch === input.epoch &&
    previous.eventId === (input.eventId ?? null)
  );
}

export function readDueMatchEffect(row: {
  payload_json: string;
  next_at_ms: number;
  attempts: number;
}): DueMatchEffect {
  const value: unknown = JSON.parse(row.payload_json);
  return createDueMatchEffect(parseTimerClaimEffectPayload(value), {
    nextAtMs: row.next_at_ms,
    attempts: row.attempts,
  });
}

export function createDueMatchEffect(
  payload: TimerClaimEffectPayload,
  schedule: { nextAtMs: number; attempts: number },
): DueMatchEffect {
  const effect = parseTimerClaimEffectPayload(payload);
  if (!integer(schedule.nextAtMs) || !integer(schedule.attempts)) invalid();
  return { ...effect, state: "pending", ...schedule };
}

export function captureMatchEffectTarget(
  effect: DueMatchEffect,
): MatchEffectTarget {
  return { effectId: effect.effectId };
}

export function matchEffectStorageKey(target: MatchEffectTarget): string {
  if (!key(target.effectId)) invalid();
  return target.effectId;
}

export function matchEffectLogIdentity(effect: DueMatchEffect) {
  return { inviteId: effect.inviteId, matchId: effect.matchId };
}

export function prepareMatchEffectProgress(
  effect: DueMatchEffect,
): Promise<EventProgressPlan> | null {
  return effect.eventId === null
    ? null
    : buildEventProgressPlan(
        {
          eventId: effect.eventId,
          sourceKey: effect.sourceKey,
          reason: "timer-claimed",
        },
        effect.claimedAtMs,
      );
}
