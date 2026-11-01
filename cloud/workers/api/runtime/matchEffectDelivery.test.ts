import { matchDocumentFixture } from "../test/matchRecordFixture.ts";
import { runInCanonicalMatchWriterFixture as runInDurableObject } from "./canonicalMatchTestFixture.ts";
import { eventDocumentFixture } from "../test/eventCompatibilityFixture.ts";
import { matchEffectFixture } from "../test/matchClaimFixture.ts";
import { env } from "cloudflare:workers";
import { type D1Migration } from "cloudflare:test";
import { beforeAll, beforeEach, expect, it } from "vitest";
import { formatMatchTimer } from "@mons/shared/timers";
import {
  createMatchEffectDelivery,
  MatchEffectsDispatcher,
} from "../src/matchEffectsDispatcher.ts";
import {
  MatchStateStore,
  type MatchStateStoreOptions,
} from "../src/matchStateStore.ts";
import { buildEventProgressPlan } from "../src/eventProgressCodec.ts";
import { readDueMatchEffect } from "../src/matchEffectCodec.ts";
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

const effect = matchEffectFixture({
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
});

function environment(onDispatch: () => Promise<void>) {
  let dispatched = 0;
  const value: Env = {
    ...testEnv,
    PROFILE_GAMES_DB: new Proxy(testEnv.PROFILE_GAMES_DB, {
      get(target, property) {
        if (property === "prepare")
          return (sql: string) => {
            if (sql.includes("match_timer_starts"))
              throw new Error("retired-timer-d1-access");
            return target.prepare(sql);
          };
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
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
    deliver: createMatchEffectDelivery(value),
    dispatched: () => dispatched,
  };
}

async function localTimerEffect(
  storage: DurableObjectStorage,
  eventId: string | null,
) {
  const now = 2_000_000_000_000;
  const settings = {
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
      value: matchDocumentFixture({
        color: index === 0 ? "white" : "black",
        fen: "initial",
        flatMovesString: "",
        status: "",
        timer: index === 0 ? formatMatchTimer(7, now - 1) : "",
      }),
    })),
  });
  await store.startTimer(input);
  await store.claimTimer({ ...input, eventId });
  return {
    store: new MatchStateStore(storage, {
      ...settings,
    }),
    now,
  };
}

function localMarkers(storage: DurableObjectStorage) {
  return storage.sql
    .exec(
      "SELECT * FROM match_state_timer_starts_canonical ORDER BY match_id, player_id",
    )
    .toArray();
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
          value: eventDocumentFixture({
            schemaVersion: 3,
            eventId: "event",
            status: "active",
            createdAtMs: 100,
            updatedAtMs: 100,
            startAtMs: 100,
            createdByProfileId: "profile",
            createdByLoginUid: "host",
            createdByUsername: "ivan",
            participants: {},
          }),
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
    testEnv.EVENT_DB.prepare("DELETE FROM event_progress_outboxes_canonical"),
  ]);
  await testEnv.PROFILE_DB.prepare(
    "UPDATE profile_canonical_control SET state = 'active' WHERE singleton = 1",
  ).run();
});

it("commits the event outbox and releases its admission before Workflow dispatch", async () => {
  const plan = await buildEventProgressPlan(
    { eventId: "event", sourceKey: effect.sourceKey, reason: effect.kind },
    effect.claimedAtMs,
  );
  const f = environment(async () => {
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

  expect(await admissionCount()).toBe(1);
  expect(
    await testEnv.EVENT_DB.prepare(
      "SELECT COUNT(*) AS count FROM event_progress_outboxes_canonical",
    ).first<number>("count"),
  ).toBe(1);
});

it.each(["unconfirmed", "throws"] as const)(
  "preserves commit error precedence when match-effect admission release %s",
  async (release) => {
    await testEnv.EVENT_DB.batch([
      testEnv.EVENT_DB.prepare(
        `CREATE TRIGGER fail_match_effect_commit BEFORE INSERT ON event_progress_outboxes_canonical
         BEGIN SELECT RAISE(ABORT, 'match-effect-commit-failed'); END`,
      ),
      testEnv.EVENT_DB.prepare(
        `CREATE TRIGGER fail_match_effect_release BEFORE DELETE ON event_write_admissions
         BEGIN SELECT ${release === "unconfirmed" ? "RAISE(IGNORE)" : "RAISE(ABORT, 'match-effect-release-failed')"}; END`,
      ),
    ]);
    try {
      const f = environment(async () => {});
      const operation = f.deliver(effect);
      if (release === "unconfirmed") {
        await expect(operation).rejects.toMatchObject({
          message: "event-d1-integrity",
          cause: expect.objectContaining({
            message: expect.stringContaining("match-effect-commit-failed"),
          }),
        });
      } else {
        await expect(operation).rejects.toThrow("match-effect-release-failed");
      }
      expect(f.dispatched()).toBe(0);
      expect(await admissionCount()).toBe(1);
      expect(
        await testEnv.EVENT_DB.prepare(
          "SELECT COUNT(*) AS count FROM event_progress_outboxes_canonical",
        ).first<number>("count"),
      ).toBe(0);
    } finally {
      await testEnv.EVENT_DB.batch([
        testEnv.EVENT_DB.prepare("DROP TRIGGER fail_match_effect_commit"),
        testEnv.EVENT_DB.prepare("DROP TRIGGER fail_match_effect_release"),
        testEnv.EVENT_DB.prepare("DELETE FROM event_write_admissions"),
      ]);
    }
  },
);

it.each(["event", null])(
  "does not dispatch effects for event %s when canonical profile writes are frozen",
  async (eventId) => {
    await testEnv.PROFILE_DB.prepare(
      "UPDATE profile_canonical_control SET state = 'frozen' WHERE singleton = 1",
    ).run();
    const f = environment(async () => {});
    await expect(
      f.deliver(matchEffectFixture({ ...effect, eventId })),
    ).rejects.toThrow("profile-writes-disabled");

    expect(await admissionCount()).toBe(0);
    expect(f.dispatched()).toBe(0);
  },
);

it("finishes non-event effects without an event outbox or Workflow", async () => {
  const f = environment(async () => {});
  await f.deliver(matchEffectFixture({ ...effect, eventId: null }));

  expect(await admissionCount()).toBe(0);
  expect(f.dispatched()).toBe(0);
  expect(
    await testEnv.EVENT_DB.prepare(
      "SELECT COUNT(*) AS count FROM event_progress_outboxes_canonical",
    ).first<number>("count"),
  ).toBe(0);
});

it("rejects malformed effects before event projection or Workflow dispatch", async () => {
  for (const fields of [
    { eventId: 42 },
    { sourceKey: ["invalid"] },
    { playerId: [] },
    { opponentId: {} },
  ]) {
    expect(() =>
      readDueMatchEffect({
        payload_json: JSON.stringify({ ...effect, ...fields }),
        next_at_ms: 100,
        attempts: 0,
      }),
    ).toThrow();
  }

  expect(await admissionCount()).toBe(0);
});

it.each(["event", null])(
  "delivers a persisted local timer effect for event %s without D1 timer cleanup",
  async (eventId) => {
    const room = testEnv.INVITE_REACTIONS.getByName(crypto.randomUUID());
    await runInDurableObject(room, async (_instance, ctx) => {
      try {
        const { store, now } = await localTimerEffect(ctx.storage, eventId);
        const pending = store.effects.listDueEffects(now);
        expect(pending).toHaveLength(1);
        const markers = localMarkers(ctx.storage);
        expect(markers).toHaveLength(1);
        const f = environment(async () => {});
        await new MatchEffectsDispatcher(store.effects, {
          deliver: f.deliver,
          scheduleAlarm: async () => {},
          now: () => now,
        }).dispatch();

        expect(store.effects.listDueEffects(now)).toEqual([]);
        expect(store.effects.nextEffectAt()).toBeNull();
        expect(localMarkers(ctx.storage)).toEqual(markers);

        expect(f.dispatched()).toBe(eventId ? 1 : 0);
        expect(await admissionCount()).toBe(0);
        expect(
          await testEnv.EVENT_DB.prepare(
            "SELECT COUNT(*) AS count FROM event_progress_outboxes_canonical",
          ).first<number>("count"),
        ).toBe(eventId ? 1 : 0);
      } finally {
        await ctx.storage.deleteAlarm();
      }
    });
  },
);
