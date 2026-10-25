import assert from "node:assert/strict";
import test from "node:test";
import {
  captureMatchEffectTarget,
  cleanupRetainedMatchEffect,
  createDueMatchEffect,
  createTimerClaimEffectPayload,
  matchEffectStorageKey,
  matchesStoredTimerEffect,
  prepareMatchEffectProgress,
  readDueMatchEffect,
} from "../src/matchEffectCodec.ts";
import {
  buildEventProgressPlan,
  buildRetainedEventProgressPlan,
} from "../src/eventProgressCodec.ts";

const input = {
  inviteId: "invite-one",
  matchId: "invite-one",
  playerId: "host-login",
  opponentId: "guest-login",
  epoch: 1,
  eventId: "event-one",
};

test("due effect reads preserve JSON spread behavior and authoritative scheduling columns", () => {
  for (const payload of [
    null,
    false,
    0,
    "legacy",
    [],
    {
      effectId: "payload-id",
      nextAtMs: "ignored",
      attempts: -7,
      extra: [1, null],
    },
  ]) {
    const effect = readDueMatchEffect({
      payload_json: JSON.stringify(payload),
      next_at_ms: 100,
      attempts: 3,
    });
    assert.deepEqual(effect, {
      ...Object(payload),
      nextAtMs: 100,
      attempts: 3,
    });
    assert.deepEqual(Object.getOwnPropertySymbols(effect), []);
  }
  assert.throws(
    () =>
      readDueMatchEffect({
        payload_json: "broken-json",
        next_at_ms: 100,
        attempts: 0,
      }),
    SyntaxError,
  );
});

test("effect replay checks only retained identity fields without requiring delivery fields", () => {
  const prior = {
    playerId: input.playerId,
    opponentId: input.opponentId,
    epoch: input.epoch,
    eventId: input.eventId,
    effectId: null,
    reason: [],
    claimedAtMs: "invalid",
  };
  assert.equal(matchesStoredTimerEffect(JSON.stringify(prior), input), true);
  for (const patch of [
    { playerId: "other" },
    { opponentId: "other" },
    { epoch: "1" },
    { eventId: null },
  ]) {
    assert.equal(
      matchesStoredTimerEffect(JSON.stringify({ ...prior, ...patch }), input),
      false,
    );
  }
  assert.throws(() => matchesStoredTimerEffect("null", input), TypeError);
  assert.throws(
    () => matchesStoredTimerEffect("broken-json", input),
    SyntaxError,
  );
});

test("effect write targets capture the payload identity before later work", () => {
  const payload = createTimerClaimEffectPayload(input, 100);
  const effect = createDueMatchEffect(payload, { nextAtMs: 100, attempts: 0 });
  const target = captureMatchEffectTarget(effect);
  Reflect.set(effect, "effectId", "changed-after-capture");
  assert.equal(matchEffectStorageKey(target), payload.effectId);
});

test("retained cleanup forwards the original object with standalone receiver semantics", async () => {
  const effect = readDueMatchEffect({
    payload_json: '{"matchId":null,"playerId":7}',
    next_at_ms: 100,
    attempts: 0,
  });
  let calls = 0;
  const cleanup = function (this: unknown, value: object): Promise<void> {
    assert.equal(this, undefined);
    assert.strictEqual(value, effect);
    calls++;
    return Promise.resolve();
  };
  await cleanupRetainedMatchEffect(effect, cleanup);
  assert.equal(calls, 1);
});

test("effect progress construction retains malformed fields and falsy event skips", async () => {
  const effect = readDueMatchEffect({
    payload_json:
      '{"eventId":"event-one","sourceKey":7,"reason":["legacy"],"claimedAtMs":"100"}',
    next_at_ms: 100,
    attempts: 0,
  });
  assert.deepEqual(
    await prepareMatchEffectProgress(effect),
    await buildRetainedEventProgressPlan(
      { eventId: "event-one", sourceKey: 7, reason: ["legacy"] },
      "100",
    ),
  );
  for (const eventId of [undefined, null, false, 0, ""]) {
    assert.equal(
      prepareMatchEffectProgress(
        readDueMatchEffect({
          payload_json: JSON.stringify({ eventId }),
          next_at_ms: 100,
          attempts: 0,
        }),
      ),
      null,
    );
  }
});

test("progress builders reject clock failures asynchronously and preserve explicit timestamps", async () => {
  const previous = Date.now;
  const failure = new Error("clock-failed");
  Date.now = () => {
    throw failure;
  };
  try {
    const input = {
      eventId: "event",
      sourceKey: "source",
      reason: "timer-claimed",
    };
    for (const build of [
      buildEventProgressPlan,
      buildRetainedEventProgressPlan,
    ]) {
      let result!: Promise<unknown>;
      assert.doesNotThrow(() => {
        result = build(input);
      });
      await assert.rejects(result, (error) => error === failure);
      await build(input, 0);
    }
  } finally {
    Date.now = previous;
  }
});
