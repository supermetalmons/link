import type { MatchStateStore } from "./matchStateStore.ts";
import type { MatchEffectsOutbox } from "./matchEffectsOutbox.ts";
import {
  cleanupRetainedMatchEffect,
  captureMatchEffectTarget,
  matchEffectLogIdentity,
  prepareMatchEffectProgress,
  type DueMatchEffect,
} from "./matchEffectCodec.ts";
import { commitEventMutations } from "./eventD1.ts";
import { withEventWriteAdmission } from "./eventWriteAdmission.ts";
import { ensureRetainedEventProgressWorkflow } from "./eventProgressDispatch.ts";
import { summarizeError } from "./errorSummary.ts";
import { assertProfileBackgroundMutationsEnabled } from "./profileCanonicalActivation.ts";

type MatchEffectsStore = Pick<
  MatchEffectsOutbox,
  "listDueEffects" | "completeEffect" | "retryEffect" | "nextEffectAt"
>;

type MatchEffectsDependencies = {
  deliver: (effect: DueMatchEffect) => Promise<void>;
  scheduleAlarm: (atMs: number) => Promise<void>;
  now?: () => number;
};

export function createMatchEffectDelivery(
  env: Env,
  cleanupLegacyTimerStarts: MatchStateStore["cleanupRetainedTimerStarts"],
) {
  return async (effect: DueMatchEffect): Promise<void> => {
    await assertProfileBackgroundMutationsEnabled(env);
    await cleanupRetainedMatchEffect(effect, cleanupLegacyTimerStarts);
    const prepared = prepareMatchEffectProgress(effect);
    if (!prepared) return;
    const plan = await prepared;
    await withEventWriteAdmission(
      env.EVENT_DB,
      { kind: "match-effect" },
      (admission) =>
        commitEventMutations(
          env.EVENT_DB,
          [
            {
              kind: "progress-outbox",
              outboxId: plan.outboxId,
              value: plan.outbox,
            },
          ],
          { admission },
        ),
    );
    await ensureRetainedEventProgressWorkflow(env, plan);
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
        this.effects.completeEffect(captureMatchEffectTarget(effect));
      } catch (error) {
        await this.effects.retryEffect(
          captureMatchEffectTarget(effect),
          this.now() + 60_000,
        );
        console.error({
          event: "canonical_match_effect_retry",
          ...matchEffectLogIdentity(effect),
          kind: error instanceof Error ? error.name : "unknown",
          error: summarizeError(error),
        });
      }
    }
    const next = this.effects.nextEffectAt();
    if (next !== null) await this.dependencies.scheduleAlarm(next);
  }
}
