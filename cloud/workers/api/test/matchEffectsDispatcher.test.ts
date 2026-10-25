import {
  matchEffectFixture,
  matchEffectIdFixture,
  matchEffectKeyFixture,
} from "./matchClaimFixture.ts";
import type { MatchEffectTarget } from "../src/matchEffectCodec.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { MatchEffectsDispatcher } from "../src/matchEffectsDispatcher.ts";
import type { MatchStateEffect } from "../src/matchStateTypes.ts";

function fixture(count = 1) {
  let now = 100;
  const pending = new Map<string, ReturnType<typeof matchEffectFixture>>();
  for (let index = 0; index < count; index++) {
    const effectId = `timer:invite:match-${index}`;
    pending.set(
      effectId,
      matchEffectFixture({
        effectId,
        inviteId: "invite",
        matchId: `match-${index}`,
        playerId: "host",
        opponentId: "guest",
        epoch: 2,
        claimedAtMs: 50,
        eventId: "event",
        sourceKey: effectId,
        reason: "timer-claimed",
        nextAtMs: now,
        attempts: 0,
      }),
    );
  }
  const completed: string[] = [];
  const delivered: string[] = [];
  const alarms: number[] = [];
  const effects = {
    listDueEffects(atMs = now, limit = 20) {
      return [...pending.values()]
        .filter((effect) => effect.nextAtMs <= atMs)
        .slice(0, limit);
    },
    completeEffect(target: MatchEffectTarget) {
      const effectId = matchEffectKeyFixture(target);
      completed.push(effectId);
      pending.delete(effectId);
    },
    async retryEffect(target: MatchEffectTarget, atMs: number) {
      const effectId = matchEffectKeyFixture(target);
      const current = pending.get(effectId)!;
      pending.set(effectId, {
        ...current,
        nextAtMs: atMs,
        attempts: current.attempts + 1,
      });
    },
    nextEffectAt() {
      return pending.size
        ? Math.min(...[...pending.values()].map((effect) => effect.nextAtMs))
        : null;
    },
  };
  const dependencies = {
    async deliver(effect: MatchStateEffect) {
      delivered.push(matchEffectIdFixture(effect));
    },
    async scheduleAlarm(atMs: number) {
      alarms.push(atMs);
    },
    now: () => now,
  };
  return {
    pending,
    completed,
    delivered,
    alarms,
    effects,
    dependencies,
    dispatcher: new MatchEffectsDispatcher(effects, dependencies),
    setNow: (value: number) => {
      now = value;
    },
  };
}

test("overlapping drains share delivery and complete only after it succeeds", async () => {
  const f = fixture();
  const release = Promise.withResolvers<void>();
  f.dependencies.deliver = async (effect) => {
    f.delivered.push(matchEffectIdFixture(effect));
    await release.promise;
  };
  const first = f.dispatcher.dispatch();
  const second = f.dispatcher.dispatch();
  assert.equal(first, second);
  assert.equal(f.delivered.length, 1);
  assert.deepEqual(f.completed, []);
  release.resolve();
  await first;
  assert.deepEqual(f.completed, f.delivered);
  assert.equal(f.pending.size, 0);
  const next = f.dispatcher.dispatch();
  assert.notEqual(next, first);
  await next;
  assert.equal(f.delivered.length, 1);
  assert.deepEqual(f.alarms, []);
});

test("a failed effect retries in sixty seconds without starving the next effect", async (t) => {
  const logged = t.mock.method(console, "error", () => {});
  const f = fixture(2);
  const firstId = [...f.pending.keys()][0];
  f.dependencies.deliver = async (effect) => {
    f.delivered.push(matchEffectIdFixture(effect));
    if (matchEffectIdFixture(effect) === firstId) {
      f.setNow(500);
      throw new Error("delivery-unavailable", {
        cause: Object.assign(new Error("database-unavailable"), {
          code: "D1_ERROR",
        }),
      });
    }
  };
  await f.dispatcher.dispatch();
  assert.equal(f.delivered.length, 2);
  assert.deepEqual(f.completed, [f.delivered[1]]);
  assert.deepEqual(f.alarms, [60_500]);
  assert.equal(f.pending.get(firstId)?.attempts, 1);
  assert.equal(f.pending.get(firstId)?.nextAtMs, 60_500);
  assert.deepEqual(logged.mock.calls[0].arguments, [
    {
      event: "canonical_match_effect_retry",
      inviteId: "invite",
      matchId: "match-0",
      kind: "Error",
      error: {
        name: "Error",
        message: "delivery-unavailable",
        cause: {
          name: "Error",
          message: "database-unavailable",
          code: "D1_ERROR",
        },
      },
    },
  ]);
});

test("failed retry persistence leaves the effect pending and releases the drain", async () => {
  const f = fixture(2);
  const failure = new Error("retry-persistence-unavailable");
  f.dependencies.deliver = async (effect) => {
    f.delivered.push(matchEffectIdFixture(effect));
    throw new Error("delivery-unavailable");
  };
  f.effects.retryEffect = async () => {
    throw failure;
  };
  const first = f.dispatcher.dispatch();
  assert.equal(f.dispatcher.dispatch(), first);
  await assert.rejects(first, (error) => error === failure);
  assert.deepEqual(f.completed, []);
  assert.equal(f.pending.size, 2);
  assert.equal(f.delivered.length, 1);
  assert.deepEqual(f.alarms, []);

  f.dependencies.deliver = async (effect) => {
    f.delivered.push(matchEffectIdFixture(effect));
  };
  await f.dispatcher.dispatch();
  assert.equal(f.pending.size, 0);
  assert.equal(f.completed.length, 2);
});

test("drains at most twenty effects sequentially and schedules remaining work", async () => {
  const f = fixture(21);
  let delivering = false;
  f.dependencies.deliver = async (effect) => {
    assert.equal(delivering, false);
    delivering = true;
    f.delivered.push(matchEffectIdFixture(effect));
    await Promise.resolve();
    delivering = false;
  };
  await f.dispatcher.dispatch();
  assert.equal(f.completed.length, 20);
  assert.equal(f.pending.size, 1);
  assert.deepEqual(f.alarms, [100]);
  await f.dispatcher.dispatch();
  assert.equal(f.completed.length, 21);
  assert.equal(f.pending.size, 0);
  assert.deepEqual(f.completed, f.delivered);
});
