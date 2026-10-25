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
  type TimerClaimEffectPayload,
} from "../src/matchEffectCodec.ts";
import type {
  MatchTimerStartStore,
  RetainedTimerCleanupInput,
} from "../src/gameplayCoordinationD1.ts";

export function timerClaimFixture<Source extends object>(
  value: Source,
): TimerClaimDocument & Source {
  const claim = readRetainedTimerClaim(value);
  if (!claim || typeof claim !== "object")
    throw new TypeError("invalid claim fixture");
  return Object.assign(claim, value);
}

export function timerClaimRecordFixture(
  value: unknown,
): Record<string, unknown> | null {
  const claim = readRetainedTimerClaim(value);
  return claim && typeof claim === "object"
    ? Object.fromEntries(Object.entries(claim))
    : null;
}

export function matchEffectFixture<
  Source extends TimerClaimEffectPayload & {
    nextAtMs: number;
    attempts: number;
  },
>(value: Source): DueMatchEffect & Source {
  return Object.assign(
    createDueMatchEffect(value, {
      nextAtMs: value.nextAtMs,
      attempts: value.attempts,
    }),
    value,
  );
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

export function timerStartStoreFixture<
  Store extends Pick<MatchTimerStartStore, "getOrAdvance" | "deletePair">,
>(store: Store) {
  return Object.assign(store, {
    deleteRetainedPair(
      this: Store,
      input: RetainedTimerCleanupInput,
    ): Promise<void> {
      return Reflect.apply(this.deletePair, this, [
        input.playerId,
        input.opponentId,
        input.matchId,
      ]);
    },
  });
}
