import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { runInCanonicalMatchWriterFixture } from "./canonicalMatchTestFixture.ts";
import { MatchEffectsOutbox } from "../src/matchEffectsOutbox.ts";
import {
  captureMatchEffectTarget,
  createTimerClaimEffectPayload,
  readDueMatchEffect,
} from "../src/matchEffectCodec.ts";

const input = {
  inviteId: "invite",
  matchId: "invite",
  playerId: "host",
  opponentId: "guest",
  epoch: 1,
  eventId: "event",
};
async function fixture(
  work: (storage: DurableObjectStorage) => void | Promise<void>,
) {
  const room = env.INVITE_REACTIONS.getByName(
    `strict-effect-${crypto.randomUUID()}`,
  );
  await runInCanonicalMatchWriterFixture(room, async (_instance, state) => {
    try {
      await work(state.storage);
    } finally {
      await state.storage.deleteAlarm();
    }
  });
}

describe("canonical match effect persistence", () => {
  it("preserves identity through retry, completion and duplicate claim insertion", async () => {
    await fixture(async (storage) => {
      const now = vi.fn(() => 1000);
      const scheduleAlarm = vi.fn(async () => {});
      const outbox = new MatchEffectsOutbox(storage, { now, scheduleAlarm });
      expect(outbox.insertTimerClaim(input, 900)).toBe(1000);
      const [effect] = outbox.listDueEffects(1000);
      expect(effect).toMatchObject({
        schemaVersion: 1,
        state: "pending",
        kind: "timer-claimed",
        effectId: "timer:invite:invite",
        claimedAtMs: 900,
        attempts: 0,
      });
      const target = captureMatchEffectTarget(effect!);
      await outbox.retryEffect(target, 1200);
      expect(outbox.listDueEffects(1000)).toEqual([]);
      expect(outbox.listDueEffects(1200)[0]).toMatchObject({
        effectId: effect!.effectId,
        claimedAtMs: 900,
        attempts: 1,
        nextAtMs: 1200,
      });
      expect(scheduleAlarm).toHaveBeenCalledOnce();
      outbox.completeEffect(target);
      const before = storage.sql
        .exec("SELECT * FROM match_state_effects_canonical")
        .toArray();
      expect(outbox.insertTimerClaim(input, 9999)).toBeNull();
      expect(
        storage.sql
          .exec("SELECT * FROM match_state_effects_canonical")
          .toArray(),
      ).toEqual(before);
      expect(before[0]).toMatchObject({
        state: "completed",
        next_at_ms: null,
        completed_at_ms: 1000,
      });
      expect(() =>
        outbox.insertTimerClaim({ ...input, epoch: 2 }, 900),
      ).toThrow("match-state-effect-conflict");
    });
  });

  it.each(
    [
      null,
      false,
      0,
      "",
      [],
      {},
      { playerId: "host", opponentId: "guest", epoch: 1 },
    ].map((value) => [value]),
  )("rejects incomplete effect %j", async (payload) => {
    await fixture((storage) => {
      expect(() =>
        storage.sql.exec(
          "INSERT INTO match_state_effects_canonical(effect_id, payload_json, state, next_at_ms, attempts) VALUES ('timer:invite:invite', ?, 'pending', 1000, 0)",
          JSON.stringify(payload),
        ),
      ).toThrow();
      expect(() =>
        readDueMatchEffect({
          payload_json: JSON.stringify(payload),
          next_at_ms: 1000,
          attempts: 0,
        }),
      ).toThrow("match-state-invalid-effect");
    });
  });

  it("rejects unknown effect fields and broken schedule state", async () => {
    await fixture((storage) => {
      const payload = createTimerClaimEffectPayload(input, 900);
      expect(() =>
        readDueMatchEffect({
          payload_json: JSON.stringify({ ...payload, unknown: true }),
          next_at_ms: 1000,
          attempts: 0,
        }),
      ).toThrow("match-state-invalid-effect");
      expect(() =>
        storage.sql.exec(
          "INSERT INTO match_state_effects_canonical(effect_id, payload_json, state, next_at_ms, attempts, completed_at_ms) VALUES (?, ?, 'completed', 1000, 0, 1001)",
          payload.effectId,
          JSON.stringify(payload),
        ),
      ).toThrow();
    });
  });
});
