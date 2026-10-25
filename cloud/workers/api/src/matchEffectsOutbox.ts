import { AuthApiFailure } from "./authErrors.ts";
import { canonicalMatchStateJson } from "./matchStateLogic.ts";
import type { MatchStateClaimTimerRequest } from "./matchStateTypes.ts";
import {
  createTimerClaimEffectPayload,
  matchesStoredTimerEffect,
  matchEffectStorageKey,
  readDueMatchEffect,
  type DueMatchEffect,
  type MatchEffectTarget,
} from "./matchEffectCodec.ts";

type MatchEffectsOutboxOptions = {
  now: () => number;
  scheduleAlarm: (
    atMs: number,
    transaction: DurableObjectTransaction,
  ) => Promise<void>;
};

function validTimestamp(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError("match-state-invalid-timestamp");
  }
}

export class MatchEffectsOutbox {
  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly options: MatchEffectsOutboxOptions,
  ) {}

  insertTimerClaim(
    input: MatchStateClaimTimerRequest,
    claimedAtMs: number,
  ): number | null {
    const effect = createTimerClaimEffectPayload(input, claimedAtMs);
    const effectId = effect.effectId;
    const [existing] = this.storage.sql
      .exec<{ payload_json: string; next_at_ms: number | null }>(
        "SELECT payload_json, next_at_ms FROM match_state_effects WHERE effect_id = ?",
        effectId,
      )
      .toArray();
    if (existing) {
      if (!matchesStoredTimerEffect(existing.payload_json, input))
        throw new AuthApiFailure(
          409,
          "failed-precondition",
          "match-state-effect-conflict",
        );
      return existing.next_at_ms;
    }
    const nowMs = this.options.now();
    validTimestamp(nowMs);
    this.storage.sql.exec(
      "INSERT INTO match_state_effects(effect_id, payload_json, next_at_ms) VALUES (?, ?, ?)",
      effectId,
      canonicalMatchStateJson(effect),
      nowMs,
    );
    return nowMs;
  }

  listDueEffects(nowMs = this.options.now(), limit = 20): DueMatchEffect[] {
    validTimestamp(nowMs);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new TypeError("match-state-invalid-effect-limit");
    return this.storage.sql
      .exec<{ payload_json: string; next_at_ms: number; attempts: number }>(
        "SELECT payload_json, next_at_ms, attempts FROM match_state_effects WHERE next_at_ms <= ? ORDER BY next_at_ms, effect_id LIMIT ?",
        nowMs,
        limit,
      )
      .toArray()
      .map(readDueMatchEffect);
  }

  nextEffectAt(): number | null {
    return this.storage.sql
      .exec<{ next_at_ms: number | null }>(
        "SELECT MIN(next_at_ms) AS next_at_ms FROM match_state_effects",
      )
      .one().next_at_ms;
  }

  completeEffect(target: MatchEffectTarget): void {
    const nowMs = this.options.now();
    validTimestamp(nowMs);
    this.storage.sql.exec(
      "UPDATE match_state_effects SET next_at_ms = NULL, completed_at_ms = ? WHERE effect_id = ? AND completed_at_ms IS NULL",
      nowMs,
      matchEffectStorageKey(target),
    );
  }

  async retryEffect(target: MatchEffectTarget, atMs: number): Promise<void> {
    validTimestamp(atMs);
    await this.storage.transaction(async (transaction) => {
      this.storage.sql.exec(
        "UPDATE match_state_effects SET next_at_ms = ?, attempts = attempts + 1 WHERE effect_id = ? AND completed_at_ms IS NULL",
        atMs,
        matchEffectStorageKey(target),
      );
      const due = this.nextEffectAt();
      if (due !== null) await this.options.scheduleAlarm(due, transaction);
    });
  }
}
