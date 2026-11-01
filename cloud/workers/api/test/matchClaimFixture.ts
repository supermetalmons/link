import {
  readRetainedTimerClaim,
  type TimerClaimDocument,
} from "../src/matchClaimCodec.ts";
import {
  createDueMatchEffect,
  captureMatchEffectTarget,
  matchEffectStorageKey,
  type DueMatchEffect,
  type MatchEffectTarget,
  parseTimerClaimEffectPayload,
} from "../src/matchEffectCodec.ts";
import { isMatchTimer } from "@mons/shared/timers";

function fixtureFields(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("invalid claim fixture");
  return Object.fromEntries(Object.entries(value));
}

function fixtureTimer(value: unknown) {
  if (isMatchTimer(value)) return value;
  if (value === "gg") return { state: "finished" as const };
  if (typeof value === "string" && /^\d+;\d+$/.test(value))
    return {
      state: "running" as const,
      turnNumber: Number(value.split(";")[0]),
      deadlineAtMs: Number(value.split(";")[1]),
    };
  return value;
}

export function timerClaimFixture<Source extends object>(
  value: Source,
): TimerClaimDocument {
  const fields = fixtureFields(value);
  const claim = readRetainedTimerClaim({
    schemaVersion: 1,
    status: "claimed",
    inviteId: "invite",
    playerId: "host",
    opponentId: "guest",
    turnNumber: 1,
    claimedAtMs: fields.status === "pending" ? null : 0,
    expiresAtMs: fields.status === "pending" ? 1 : null,
    ...fields,
    timer: fixtureTimer(fields.timer ?? "1;1"),
  });
  if (!claim || typeof claim !== "object")
    throw new TypeError("invalid claim fixture");
  return claim;
}

export function timerClaimRecordFixture(
  value: unknown,
): Record<string, unknown> | null {
  const claim = readRetainedTimerClaim(value);
  return claim && typeof claim === "object"
    ? Object.fromEntries(Object.entries(claim))
    : null;
}

export function matchEffectFixture<Source extends object>(
  value: Source,
): DueMatchEffect {
  const fields = fixtureFields(value);
  const {
    nextAtMs,
    attempts,
    reason: _reason,
    state: _state,
    ...payload
  } = fields;
  const effect = { schemaVersion: 1, kind: "timer-claimed", ...payload };
  if (typeof nextAtMs !== "number" || typeof attempts !== "number")
    throw new TypeError("invalid effect fixture");
  return createDueMatchEffect(parseTimerClaimEffectPayload(effect), {
    nextAtMs,
    attempts,
  });
}

export function matchEffectKeyFixture(target: MatchEffectTarget): string {
  const key = matchEffectStorageKey(target);
  if (typeof key !== "string")
    throw new TypeError("invalid effect key fixture");
  return key;
}

export function matchEffectIdFixture(effect: DueMatchEffect): string {
  return matchEffectKeyFixture(captureMatchEffectTarget(effect));
}
