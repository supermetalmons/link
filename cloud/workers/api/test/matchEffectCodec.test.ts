import assert from "node:assert/strict";
import test from "node:test";
import {
  captureMatchEffectTarget,
  createDueMatchEffect,
  createTimerClaimEffectPayload,
  matchEffectStorageKey,
  matchesStoredTimerEffect,
  prepareMatchEffectProgress,
  readDueMatchEffect,
} from "../src/matchEffectCodec.ts";
import { buildEventProgressPlan } from "../src/eventProgressCodec.ts";
const input = {
  inviteId: "invite",
  matchId: "invite",
  playerId: "host",
  opponentId: "guest",
  epoch: 1,
  eventId: "event",
};

test("effect codecs reject arbitrary payloads and contradictory identity fields", () => {
  const payload = createTimerClaimEffectPayload(input, 100);
  for (const value of [
    null,
    false,
    0,
    "legacy",
    [],
    {},
    { ...payload, extra: true },
    { ...payload, effectId: "different" },
    { ...payload, playerId: "guest" },
  ])
    assert.throws(
      () =>
        readDueMatchEffect({
          payload_json: JSON.stringify(value),
          next_at_ms: 100,
          attempts: 0,
        }),
      /match-state-invalid-effect/,
    );
  assert.deepEqual(
    readDueMatchEffect({
      payload_json: JSON.stringify(payload),
      next_at_ms: 100,
      attempts: 3,
    }),
    { ...payload, state: "pending", nextAtMs: 100, attempts: 3 },
  );
});

test("effect replay identity remains fixed while scheduling can advance", () => {
  const payload = createTimerClaimEffectPayload(input, 100);
  assert.equal(matchesStoredTimerEffect(JSON.stringify(payload), input), true);
  for (const patch of [
    { playerId: "other" },
    { opponentId: "other" },
    { epoch: 2 },
    { eventId: null },
  ])
    assert.equal(
      matchesStoredTimerEffect(JSON.stringify({ ...payload, ...patch }), input),
      false,
    );
  const effect = createDueMatchEffect(payload, { nextAtMs: 100, attempts: 0 });
  const target = captureMatchEffectTarget(effect);
  effect.effectId = "changed-after-capture";
  assert.equal(matchEffectStorageKey(target), payload.effectId);
});

test("event projection receives complete typed timer effect evidence", async () => {
  const payload = createTimerClaimEffectPayload(input, 100);
  const effect = createDueMatchEffect(payload, { nextAtMs: 100, attempts: 0 });
  assert.deepEqual(
    await prepareMatchEffectProgress(effect),
    await buildEventProgressPlan(
      {
        eventId: "event",
        sourceKey: payload.sourceKey,
        reason: "timer-claimed",
      },
      100,
    ),
  );
  assert.equal(prepareMatchEffectProgress({ ...effect, eventId: null }), null);
});
