import { env } from "cloudflare:workers";
import { runInDurableObject, type D1Migration } from "cloudflare:test";
import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import { formatMatchTimer } from "@mons/shared/timers";
import {
  createMatchEffectDelivery,
  MatchEffectsDispatcher,
} from "../src/matchEffectsDispatcher.ts";
import {
  MatchStateStore,
  type MatchStateStoreOptions,
} from "../src/matchStateStore.ts";
import type { MatchStateEffect } from "../src/matchStateTypes.ts";
import { createMatchTimerStartStore } from "../src/gameplayCoordinationD1.ts";
import { buildEventProgressPlan } from "../src/eventProgressCodec.ts";
import {
  acquireEventWriteAdmission,
  commitEventMutations,
  readEventProgressOutbox,
  releaseEventWriteAdmission,
} from "../src/eventD1.ts";
import { applyStrictMatchStateTestMigrations } from "./strictMatchStateTestFixture.ts";
import { applyEventTestMigrations } from "./eventTestMigrations.ts";
import { applyRetiredProfileMigrations } from "./profileTestMigrations.ts";

const testEnv = env as Env & {
  TEST_D1_MIGRATIONS: D1Migration[];
  TEST_EVENT_D1_MIGRATIONS: D1Migration[];
  TEST_PROFILE_D1_MIGRATIONS: D1Migration[];
};

const effect: MatchStateEffect = {
  effectId: "timer:invite:match",
  inviteId: "invite",
  matchId: "match",
  playerId: "host",
  opponentId: "guest",
  epoch: 2,
  claimedAtMs: 100,
  eventId: "event",
  sourceKey: "timer:invite:match",
  reason: "timer-claimed",
  nextAtMs: 100,
  attempts: 0,
};

function environment(
  onDispatch: () => Promise<void>,
  cleanupLegacyTimerStarts: Parameters<typeof createMatchEffectDelivery>[1] = (
    input,
  ) =>
    createMatchTimerStartStore(testEnv.PROFILE_GAMES_DB).deletePair(
      input.playerId,
      input.opponentId,
      input.matchId,
    ),
) {
  let dispatched = 0;
  const value: Env = {
    ...testEnv,
    EVENT_PROGRESS_WORKFLOW: {
      create: async () => {
        throw new Error("unexpected-workflow-create");
      },
      createBatch: async () => {
        dispatched++;
        await onDispatch();
        return [];
      },
      get: async () => {
        throw new Error("workflow-not-found");
      },
      deleteBatch: async () => ({ deleted: [], errors: [] }),
    },
  };
  return {
    deliver: createMatchEffectDelivery(value, cleanupLegacyTimerStarts),
    dispatched: () => dispatched,
  };
}

async function localTimerEffect(
  storage: DurableObjectStorage,
  eventId: string | null,
) {
  const now = 2_000_000_000_000;
  const timerStarts = {
    getOrAdvance: vi.fn<MatchStateStoreOptions["timerStarts"]["getOrAdvance"]>(
      async () => {
        throw new Error("unexpected-d1-timer-write");
      },
    ),
    deletePair: vi.fn<MatchStateStoreOptions["timerStarts"]["deletePair"]>(
      async () => {
        throw new Error("unexpected-d1-timer-cleanup");
      },
    ),
  };
  const settings = {
    timerStarts,
    newMatchTimerStorage: "local",
    now: () => now,
    resolveGame: () => ({
      activeColor: "black",
      historyValid: true,
      turnNumber: 7,
      winner: undefined,
    }),
  } satisfies MatchStateStoreOptions;
  const store = new MatchStateStore(storage, settings);
  const input = {
    inviteId: effect.matchId,
    matchId: effect.matchId,
    epoch: effect.epoch,
    playerId: effect.playerId,
    opponentId: effect.opponentId,
  };
  store.createRecords({
    ...input,
    records: [input.playerId, input.opponentId].map((playerId, index) => ({
      matchId: input.matchId,
      playerId,
      marker: `${playerId}-created`,
      value: {
        color: index === 0 ? "white" : "black",
        fen: "initial",
        flatMovesString: "",
        status: "",
        timer: index === 0 ? formatMatchTimer(7, now - 1) : "",
      },
    })),
  });
  await store.startTimer(input);
  await store.claimTimer({ ...input, eventId });
  return {
    store: new MatchStateStore(storage, {
      ...settings,
      newMatchTimerStorage: "d1",
    }),
    timerStarts,
    now,
  };
}

function localMarkers(storage: DurableObjectStorage) {
  return storage.sql
    .exec("SELECT * FROM match_state_timer_starts ORDER BY match_id, player_id")
    .toArray();
}

async function timerCount() {
  return testEnv.PROFILE_GAMES_DB.prepare(
    "SELECT COUNT(*) AS count FROM match_timer_starts WHERE match_id = 'match'",
  ).first<number>("count");
}

async function admissionCount() {
  return testEnv.EVENT_DB.prepare(
    "SELECT COUNT(*) AS count FROM event_write_admissions",
  ).first<number>("count");
}

beforeAll(async () => {
  await applyStrictMatchStateTestMigrations(
    testEnv.PROFILE_GAMES_DB,
    testEnv.TEST_D1_MIGRATIONS,
  );
  await applyEventTestMigrations(
    testEnv.EVENT_DB,
    testEnv.TEST_EVENT_D1_MIGRATIONS,
  );
  await applyRetiredProfileMigrations(
    testEnv.PROFILE_DB,
    testEnv.TEST_PROFILE_D1_MIGRATIONS,
    "a".repeat(64),
  );
  const admission = await acquireEventWriteAdmission(testEnv.EVENT_DB);
  try {
    await commitEventMutations(
      testEnv.EVENT_DB,
      [
        {
          kind: "event",
          eventId: "event",
          value: {
            schemaVersion: 2,
            eventId: "event",
            status: "active",
            createdAtMs: 100,
            updatedAtMs: 100,
            startAtMs: 100,
            createdByProfileId: "profile",
            createdByLoginUid: "host",
            createdByUsername: "ivan",
            participants: {},
            rounds: {},
          },
        },
      ],
      { admission },
    );
  } finally {
    await releaseEventWriteAdmission(testEnv.EVENT_DB, admission);
  }
});

beforeEach(async () => {
  await testEnv.EVENT_DB.batch([
    testEnv.EVENT_DB.prepare(
      "DROP TRIGGER IF EXISTS keep_match_effect_admission",
    ),
    testEnv.EVENT_DB.prepare("DELETE FROM event_write_admissions"),
    testEnv.EVENT_DB.prepare("DELETE FROM event_progress_outboxes"),
  ]);
  await testEnv.PROFILE_DB.prepare(
    "UPDATE profile_canonical_control SET state = 'active' WHERE singleton = 1",
  ).run();
  await testEnv.PROFILE_GAMES_DB.batch([
    testEnv.PROFILE_GAMES_DB.prepare("DELETE FROM match_timer_starts"),
    testEnv.PROFILE_GAMES_DB.prepare(
      `INSERT INTO match_timer_starts (player_id, match_id, timer, turn_number, updated_at_ms)
       VALUES ('host', 'match', '1;100', 1, 100), ('guest', 'match', '1;100', 1, 100)`,
    ),
  ]);
});

it("commits the event outbox and releases its admission before Workflow dispatch", async () => {
  const plan = await buildEventProgressPlan(
    { eventId: "event", sourceKey: effect.sourceKey, reason: effect.reason },
    effect.claimedAtMs,
  );
  const f = environment(async () => {
    expect(await timerCount()).toBe(0);
    expect(
      await readEventProgressOutbox(testEnv.EVENT_DB, plan.outboxId),
    ).toEqual(plan.outbox);
    expect(await admissionCount()).toBe(1);
  });
  await f.deliver(effect);
  expect(f.dispatched()).toBe(1);
  expect(await admissionCount()).toBe(0);
});

it("retains the committed outbox without dispatch when admission release is unconfirmed", async () => {
  await testEnv.EVENT_DB.prepare(
    `CREATE TRIGGER keep_match_effect_admission BEFORE DELETE ON event_write_admissions
     BEGIN SELECT RAISE(IGNORE); END`,
  ).run();
  const f = environment(async () => {});
  await expect(f.deliver(effect)).rejects.toThrow(
    "match-event-admission-release-unconfirmed",
  );
  expect(f.dispatched()).toBe(0);
  expect(await timerCount()).toBe(0);
  expect(await admissionCount()).toBe(1);
  expect(
    await testEnv.EVENT_DB.prepare(
      "SELECT COUNT(*) AS count FROM event_progress_outboxes",
    ).first<number>("count"),
  ).toBe(1);
});

it.each(["event", null])(
  "keeps timer markers for event %s when canonical profile writes are frozen",
  async (eventId) => {
    await testEnv.PROFILE_DB.prepare(
      "UPDATE profile_canonical_control SET state = 'frozen' WHERE singleton = 1",
    ).run();
    const cleanup = vi.fn(async () => {
      throw new Error("unexpected-timer-cleanup");
    });
    const f = environment(async () => {}, cleanup);
    await expect(f.deliver({ ...effect, eventId })).rejects.toThrow(
      "profile-writes-disabled",
    );
    expect(cleanup).not.toHaveBeenCalled();
    expect(await timerCount()).toBe(2);
    expect(await admissionCount()).toBe(0);
    expect(f.dispatched()).toBe(0);
  },
);

it("cleans non-event timer markers without creating an event outbox or Workflow", async () => {
  const f = environment(async () => {});
  await f.deliver({ ...effect, eventId: null });
  expect(await timerCount()).toBe(0);
  expect(await admissionCount()).toBe(0);
  expect(f.dispatched()).toBe(0);
  expect(
    await testEnv.EVENT_DB.prepare(
      "SELECT COUNT(*) AS count FROM event_progress_outboxes",
    ).first<number>("count"),
  ).toBe(0);
});

it.each(["event", null])(
  "delivers a persisted local timer effect for event %s without D1 timer cleanup",
  async (eventId) => {
    const room = testEnv.INVITE_REACTIONS.getByName(crypto.randomUUID());
    await runInDurableObject(room, async (_instance, ctx) => {
      try {
        const { store, timerStarts, now } = await localTimerEffect(
          ctx.storage,
          eventId,
        );
        const pending = store.listDueEffects(now);
        expect(pending).toHaveLength(1);
        const markers = localMarkers(ctx.storage);
        expect(markers).toHaveLength(1);
        const f = environment(
          async () => {},
          store.cleanupLegacyTimerStarts.bind(store),
        );
        await new MatchEffectsDispatcher(store, {
          deliver: f.deliver,
          scheduleAlarm: async () => {},
          now: () => now,
        }).dispatch();

        expect(store.listDueEffects(now)).toEqual([]);
        expect(store.nextEffectAt()).toBeNull();
        expect(localMarkers(ctx.storage)).toEqual(markers);
        expect(timerStarts.getOrAdvance).not.toHaveBeenCalled();
        expect(timerStarts.deletePair).not.toHaveBeenCalled();
        expect(await timerCount()).toBe(2);
        expect(f.dispatched()).toBe(eventId ? 1 : 0);
        expect(await admissionCount()).toBe(0);
        expect(
          await testEnv.EVENT_DB.prepare(
            "SELECT COUNT(*) AS count FROM event_progress_outboxes",
          ).first<number>("count"),
        ).toBe(eventId ? 1 : 0);
      } finally {
        await ctx.storage.deleteAlarm();
      }
    });
  },
);

it("rejects an inconsistent local cohort before cleanup or event dispatch", async () => {
  const room = testEnv.INVITE_REACTIONS.getByName(crypto.randomUUID());
  await runInDurableObject(room, async (_instance, ctx) => {
    try {
      const { store, timerStarts, now } = await localTimerEffect(
        ctx.storage,
        "event",
      );
      const pending = store.listDueEffects(now);
      expect(pending).toHaveLength(1);
      const markers = localMarkers(ctx.storage);
      ctx.storage.sql.exec("DELETE FROM match_state_timer_cohorts");
      const f = environment(
        async () => {},
        store.cleanupLegacyTimerStarts.bind(store),
      );

      await expect(f.deliver(pending[0])).rejects.toThrow(
        "match-timer-storage-invalid",
      );
      expect(store.listDueEffects(now)).toEqual(pending);
      expect(localMarkers(ctx.storage)).toEqual(markers);
      expect(timerStarts.deletePair).not.toHaveBeenCalled();
      expect(await timerCount()).toBe(2);
      expect(f.dispatched()).toBe(0);
      expect(await admissionCount()).toBe(0);
      expect(
        await testEnv.EVENT_DB.prepare(
          "SELECT COUNT(*) AS count FROM event_progress_outboxes",
        ).first<number>("count"),
      ).toBe(0);
    } finally {
      await ctx.storage.deleteAlarm();
    }
  });
});
