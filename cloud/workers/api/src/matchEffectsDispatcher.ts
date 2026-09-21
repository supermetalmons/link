import type { MatchStateStore } from "./matchStateStore.ts";
import type { MatchStateEffect } from "./matchStateTypes.ts";
import {
  acquireEventWriteAdmission,
  commitEventMutations,
  releaseEventWriteAdmission,
} from "./eventD1.ts";
import { buildEventProgressPlan } from "./eventProgressCodec.ts";
import { ensureEventProgressWorkflow } from "./eventProgressDispatch.ts";
import { assertProfileBackgroundMutationsEnabled } from "./profileCanonicalActivation.ts";

type MatchEffectsStore = Pick<
  MatchStateStore,
  "listDueEffects" | "completeEffect" | "retryEffect" | "nextEffectAt"
>;

type MatchEffectsDependencies = {
  deliver: (effect: MatchStateEffect) => Promise<void>;
  scheduleAlarm: (atMs: number) => Promise<void>;
  now?: () => number;
};

export function createMatchEffectDelivery(
  env: Env,
  cleanupLegacyTimerStarts: MatchStateStore["cleanupLegacyTimerStarts"],
) {
  return async (effect: MatchStateEffect): Promise<void> => {
    await assertProfileBackgroundMutationsEnabled(env);
    await cleanupLegacyTimerStarts(effect);
    if (!effect.eventId) return;
    const plan = await buildEventProgressPlan(
      {
        eventId: effect.eventId,
        sourceKey: effect.sourceKey,
        reason: effect.reason,
      },
      effect.claimedAtMs,
    );
    const admission = await acquireEventWriteAdmission(env.EVENT_DB);
    let released = false;
    try {
      await commitEventMutations(
        env.EVENT_DB,
        [
          {
            kind: "progress-outbox",
            outboxId: plan.outboxId,
            value: plan.outbox,
          },
        ],
        { admission },
      );
    } finally {
      released = await releaseEventWriteAdmission(env.EVENT_DB, admission);
    }
    if (!released) throw new Error("match-event-admission-release-unconfirmed");
    await ensureEventProgressWorkflow(env, plan);
  };
}

export class MatchEffectsDispatcher {
  private pending: Promise<void> | null = null;
  private readonly now: () => number;
  private readonly effects: MatchEffectsStore;
  private readonly dependencies: MatchEffectsDependencies;

  constructor(
    effects: MatchEffectsStore,
    dependencies: MatchEffectsDependencies,
  ) {
    this.effects = effects;
    this.dependencies = dependencies;
    this.now = dependencies.now ?? (() => Date.now());
  }

  dispatch(): Promise<void> {
    if (this.pending) return this.pending;
    const pending = this.flush();
    this.pending = pending;
    void pending
      .finally(() => {
        if (this.pending === pending) this.pending = null;
      })
      .catch(() => undefined);
    return pending;
  }

  private async flush(): Promise<void> {
    for (const effect of this.effects.listDueEffects(this.now(), 20)) {
      try {
        await this.dependencies.deliver(effect);
        this.effects.completeEffect(effect.effectId);
      } catch (error) {
        await this.effects.retryEffect(effect.effectId, this.now() + 60_000);
        console.error({
          event: "canonical_match_effect_retry",
          inviteId: effect.inviteId,
          matchId: effect.matchId,
          kind: error instanceof Error ? error.name : "unknown",
        });
      }
    }
    const next = this.effects.nextEffectAt();
    if (next !== null) await this.dependencies.scheduleAlarm(next);
  }
}
