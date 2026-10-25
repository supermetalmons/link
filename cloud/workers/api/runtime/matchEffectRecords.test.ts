import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { MatchEffectsOutbox } from "../src/matchEffectsOutbox.ts";
import { MatchEffectsDispatcher } from "../src/matchEffectsDispatcher.ts";
import {
  captureMatchEffectTarget,
  createTimerClaimEffectPayload,
} from "../src/matchEffectCodec.ts";

const input = {
  inviteId: "invite-one",
  matchId: "invite-one",
  playerId: "host-login",
  opponentId: "guest-login",
  epoch: 1,
  eventId: "event-one",
};

async function fixture(
  work: (storage: DurableObjectStorage) => void | Promise<void>,
) {
  const room = env.INVITE_REACTIONS.getByName(
    `effect-records-${crypto.randomUUID()}`,
  );
  await runInDurableObject(room, async (_instance, state) => {
    try {
      await work(state.storage);
    } finally {
      await state.storage.deleteAlarm();
    }
  });
}

function seed(
  storage: DurableObjectStorage,
  key: string,
  payload: string,
  deadline: number | null = 100,
) {
  storage.sql.exec(
    "INSERT INTO match_state_effects(effect_id, payload_json, next_at_ms) VALUES (?, ?, ?)",
    key,
    payload,
    deadline,
  );
}

function rows(storage: DurableObjectStorage) {
  return storage.sql
    .exec("SELECT * FROM match_state_effects ORDER BY effect_id")
    .toArray();
}

describe("retained match effect persistence", () => {
  it.each([100, null])(
    "replays identity-only payloads with deadline %s without clock reads or rewrites",
    async (deadline) => {
      await fixture((storage) => {
        const payload = {
          playerId: input.playerId,
          opponentId: input.opponentId,
          epoch: input.epoch,
          eventId: input.eventId,
          effectId: false,
          sourceKey: [],
          reason: 42,
          claimedAtMs: "retained",
          extra: { keep: true },
        };
        seed(
          storage,
          `timer:${input.inviteId}:${input.matchId}`,
          JSON.stringify(payload),
          deadline,
        );
        const before = rows(storage);
        const now = vi.fn(() => {
          throw new Error("unexpected clock");
        });
        const outbox = new MatchEffectsOutbox(storage, {
          now,
          scheduleAlarm: async () => {
            throw new Error("unexpected alarm");
          },
        });
        expect(outbox.insertTimerClaim(input, 900)).toBe(deadline);
        expect(now).not.toHaveBeenCalled();
        expect(rows(storage)).toEqual(before);
        expect(() =>
          outbox.insertTimerClaim({ ...input, playerId: "other-login" }, 900),
        ).toThrow("match-state-effect-conflict");
        expect(now).not.toHaveBeenCalled();
      });
    },
  );

  it.each(["null", "broken-json"])(
    "retains existing replay failure for %s",
    async (payload) => {
      await fixture((storage) => {
        seed(storage, `timer:${input.inviteId}:${input.matchId}`, payload);
        const now = vi.fn(() => 100);
        const outbox = new MatchEffectsOutbox(storage, {
          now,
          scheduleAlarm: async () => {},
        });
        expect(() => outbox.insertTimerClaim(input, 100)).toThrow(
          payload === "null" ? TypeError : SyntaxError,
        );
        expect(now).not.toHaveBeenCalled();
      });
    },
  );

  it("parses the entire due page before delivering a healthy earlier row", async () => {
    await fixture(async (storage) => {
      seed(
        storage,
        "a",
        JSON.stringify({
          ...createTimerClaimEffectPayload(input, 100),
          effectId: "a",
        }),
      );
      seed(storage, "b", "broken-json");
      const before = rows(storage);
      const outbox = new MatchEffectsOutbox(storage, {
        now: () => 100,
        scheduleAlarm: async () => {},
      });
      const deliver = vi.fn(async () => {});
      const scheduleAlarm = vi.fn(async () => {});
      const dispatcher = new MatchEffectsDispatcher(outbox, {
        deliver,
        scheduleAlarm,
        now: () => 100,
      });
      await expect(dispatcher.dispatch()).rejects.toThrow(SyntaxError);
      expect(deliver).not.toHaveBeenCalled();
      expect(scheduleAlarm).not.toHaveBeenCalled();
      expect(rows(storage)).toEqual(before);
    });
  });

  it("defers malformed field handling until each delivery and retains retry scheduling", async () => {
    await fixture(async (storage) => {
      seed(
        storage,
        "a",
        JSON.stringify({
          ...createTimerClaimEffectPayload(input, 100),
          effectId: "a",
        }),
      );
      seed(
        storage,
        "b",
        '{"effectId":"b","eventId":42,"sourceKey":["retained"],"nextAtMs":0,"attempts":99}',
      );
      const delivered: unknown[] = [];
      const alarms: number[] = [];
      const outbox = new MatchEffectsOutbox(storage, {
        now: () => 100,
        scheduleAlarm: async (atMs) => {
          alarms.push(atMs);
        },
      });
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        await new MatchEffectsDispatcher(outbox, {
          now: () => 100,
          scheduleAlarm: async (atMs) => {
            alarms.push(atMs);
          },
          deliver: async (effect) => {
            delivered.push(Reflect.get(effect, "effectId"));
            if (Reflect.get(effect, "eventId") === 42)
              throw new Error("field rejected by consumer");
          },
        }).dispatch();
        expect(delivered).toEqual(["a", "b"]);
        expect(rows(storage)).toMatchObject([
          {
            effect_id: "a",
            next_at_ms: null,
            attempts: 0,
            completed_at_ms: 100,
          },
          {
            effect_id: "b",
            next_at_ms: 60100,
            attempts: 1,
            completed_at_ms: null,
          },
        ]);
        expect(outbox.listDueEffects(60100)).toEqual([
          {
            effectId: "b",
            eventId: 42,
            sourceKey: ["retained"],
            nextAtMs: 60100,
            attempts: 1,
          },
        ]);
        expect(alarms).toEqual([60100, 60100]);
        expect(log).toHaveBeenCalledTimes(1);
      } finally {
        log.mockRestore();
      }
    });
  });

  it("uses the captured payload identity rather than the physical row key", async () => {
    await fixture(async (storage) => {
      seed(
        storage,
        "physical-a",
        '{"effectId":"physical-b","extra":"preserved"}',
      );
      seed(storage, "physical-b", '{"effectId":"physical-b"}');
      let now = 100;
      const outbox = new MatchEffectsOutbox(storage, {
        now: () => now,
        scheduleAlarm: async () => {},
      });
      const effect = outbox.listDueEffects()[0];
      const target = captureMatchEffectTarget(effect);
      Reflect.set(effect, "effectId", "physical-a");
      await outbox.retryEffect(target, 200);
      expect(rows(storage)).toMatchObject([
        { effect_id: "physical-a", next_at_ms: 100, attempts: 0 },
        { effect_id: "physical-b", next_at_ms: 200, attempts: 1 },
      ]);
      now = 150;
      outbox.completeEffect(target);
      expect(rows(storage)).toMatchObject([
        { effect_id: "physical-a", next_at_ms: 100, completed_at_ms: null },
        { effect_id: "physical-b", next_at_ms: null, completed_at_ms: 150 },
      ]);
    });
  });
});
