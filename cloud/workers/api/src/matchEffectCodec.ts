import {
  buildRetainedEventProgressPlan,
  type RetainedEventProgressPlan,
} from "./eventProgressCodec.ts";
import type { MatchStateClaimTimerRequest } from "./matchStateTypes.ts";
import type { RetainedTimerCleanupInput } from "./gameplayCoordinationD1.ts";

declare const dueMatchEffect: unique symbol;
declare const matchEffectTarget: unique symbol;

export type DueMatchEffect = {
  readonly [dueMatchEffect]: true;
  readonly nextAtMs: number;
  readonly attempts: number;
};
export type MatchEffectTarget = { readonly [matchEffectTarget]: true };

export type TimerClaimEffectPayload = {
  effectId: string;
  inviteId: string;
  matchId: string;
  playerId: string;
  opponentId: string;
  epoch: number;
  claimedAtMs: number;
  eventId: string | null;
  sourceKey: string;
  reason: "timer-claimed";
};

type EffectFields = {
  effectId?: unknown;
  inviteId?: unknown;
  matchId?: unknown;
  playerId?: unknown;
  opponentId?: unknown;
  epoch?: unknown;
  claimedAtMs?: unknown;
  eventId?: unknown;
  sourceKey?: unknown;
  reason?: unknown;
};

const fields = (effect: DueMatchEffect): EffectFields => effect as EffectFields;

export function createTimerClaimEffectPayload(
  input: MatchStateClaimTimerRequest,
  claimedAtMs: number,
): TimerClaimEffectPayload {
  const effectId = `timer:${input.inviteId}:${input.matchId}`;
  return {
    effectId,
    inviteId: input.inviteId,
    matchId: input.matchId,
    playerId: input.playerId,
    opponentId: input.opponentId,
    epoch: input.epoch,
    claimedAtMs,
    eventId: input.eventId ?? null,
    sourceKey: effectId,
    reason: "timer-claimed",
  };
}

export function matchesStoredTimerEffect(
  json: string,
  input: MatchStateClaimTimerRequest,
): boolean {
  const value: unknown = JSON.parse(json);
  const previous = value as EffectFields;
  return (
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
  const payload: object = Object(value);
  return {
    ...payload,
    nextAtMs: row.next_at_ms,
    attempts: row.attempts,
  } as DueMatchEffect;
}

export function createDueMatchEffect(
  payload: TimerClaimEffectPayload,
  schedule: { nextAtMs: number; attempts: number },
): DueMatchEffect {
  return { ...payload, ...schedule } as object as DueMatchEffect;
}

export function captureMatchEffectTarget(
  effect: DueMatchEffect,
): MatchEffectTarget {
  return { effectId: fields(effect).effectId } as object as MatchEffectTarget;
}

export function matchEffectStorageKey(target: MatchEffectTarget): unknown {
  return (target as { effectId?: unknown }).effectId;
}

export function matchEffectLogIdentity(effect: DueMatchEffect) {
  const value = fields(effect);
  return { inviteId: value.inviteId, matchId: value.matchId };
}

export function cleanupRetainedMatchEffect(
  effect: DueMatchEffect,
  cleanup: (input: RetainedTimerCleanupInput) => Promise<void>,
): Promise<void> {
  return cleanup(fields(effect));
}

export function prepareMatchEffectProgress(
  effect: DueMatchEffect,
): Promise<RetainedEventProgressPlan> | null {
  const value = fields(effect);
  if (!value.eventId) return null;
  return buildRetainedEventProgressPlan(
    {
      eventId: value.eventId,
      sourceKey: value.sourceKey,
      reason: value.reason,
    },
    value.claimedAtMs,
  );
}
