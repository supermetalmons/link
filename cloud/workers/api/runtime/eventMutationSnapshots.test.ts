import { env } from "cloudflare:workers";
import type { D1Migration } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { EventMutation } from "../../../runtime/eventCommands.js";
import {
  acquireEventWriteAdmission,
  commitEventMutations,
  createEventTransitionIntent,
  EventD1Conflict,
  readEventSnapshot,
  readEventTelegramProjectionState,
  releaseEventWriteAdmission,
  type EventD1Connection,
} from "../src/eventD1.ts";
import { buildEventProgressPlan } from "../src/eventProgressCodec.ts";
import { applyEventTestMigrations } from "./eventTestMigrations.ts";

const testEnv = env as Env & { TEST_EVENT_D1_MIGRATIONS: D1Migration[] };
const eventId = "NN3eRzoZo80";
const profileId = "profile-one";

function eventRecord(id = eventId) {
  return {
    schemaVersion: 2,
    eventId: id,
    status: "scheduled",
    createdAtMs: 100,
    updatedAtMs: 100,
    startAtMs: 1_000,
    participants: {},
    rounds: {},
    unknownFutureField: { retained: true },
  };
}

async function withAdmission<T>(
  operation: (
    admission: Awaited<ReturnType<typeof acquireEventWriteAdmission>>,
  ) => Promise<T>,
) {
  const admission = await acquireEventWriteAdmission(testEnv.EVENT_DB);
  try {
    return await operation(admission);
  } finally {
    await releaseEventWriteAdmission(testEnv.EVENT_DB, admission);
  }
}

function commit(db: EventD1Connection, changes: EventMutation[]) {
  return withAdmission((admission) =>
    commitEventMutations(db, changes, { admission, now: () => 300 }),
  );
}

function observeReads(
  options: {
    beforeReadBatch?: (attempt: number) => void;
    afterReadBatch?: (attempt: number) => Promise<void>;
  } = {},
) {
  const connection = testEnv.EVENT_DB.withSession("first-primary");
  const statements = new WeakMap<
    D1PreparedStatement,
    { statement: D1PreparedStatement; query: string }
  >();
  const readBatches: string[][] = [];
  const writeBatches: string[][] = [];
  const standaloneReads: string[] = [];
  const wrap = (statement: D1PreparedStatement, query: string) => {
    const wrapped: D1PreparedStatement = new Proxy(statement, {
      get(target, property) {
        if (property === "bind")
          return (...values: unknown[]) => wrap(target.bind(...values), query);
        const member = Reflect.get(target, property, target);
        if (typeof member !== "function") return member;
        return (...args: unknown[]) => {
          if (property === "first" || property === "all" || property === "raw")
            standaloneReads.push(query);
          return Reflect.apply(member, target, args);
        };
      },
    });
    statements.set(wrapped, { statement, query });
    return wrapped;
  };
  const db: EventD1Connection = {
    prepare: (query) => wrap(connection.prepare(query), query),
    async batch<T>(input: D1PreparedStatement[]) {
      const prepared = input.map((statement) => {
        const tracked = statements.get(statement);
        if (!tracked) throw new Error("untracked-mutation-statement");
        return tracked;
      });
      const queries = prepared.map(({ query }) => query);
      const readOnly = queries.every((query) => /^\s*SELECT\b/i.test(query));
      (readOnly ? readBatches : writeBatches).push(queries);
      if (readOnly) options.beforeReadBatch?.(readBatches.length);
      const result = await connection.batch<T>(
        prepared.map(({ statement }) => statement),
      );
      if (readOnly) await options.afterReadBatch?.(readBatches.length);
      return result;
    },
  };
  return { db, readBatches, writeBatches, standaloneReads };
}

async function seed() {
  const progress = await buildEventProgressPlan(
    {
      eventId,
      sourceKey: "snapshot-batch:test",
      reason: "sunday-mons-reminder",
    },
    100,
  );
  await commit(testEnv.EVENT_DB, [
    { kind: "event", eventId, value: eventRecord() },
    { kind: "prize-selection", eventId, profileId, value: "1092" },
    {
      kind: "progress-outbox",
      outboxId: progress.outboxId,
      value: progress.outbox,
    },
    {
      kind: "profile-game-outbox",
      eventId,
      value: {
        schemaVersion: 1,
        status: "pending",
        requestId: "profile-before",
        lastQueuedAtMs: 100,
      },
    },
    { kind: "telegram-state", eventId, value: { retained: true } },
    { kind: "telegram-generation", eventId, value: 1 },
  ]);
  return progress;
}

function mixedPlan(
  progress: Awaited<ReturnType<typeof seed>>,
): EventMutation[] {
  return [
    { kind: "event-field", eventId, field: "status", value: "active" },
    { kind: "event-field", eventId, field: "updatedAtMs", value: 300 },
    { kind: "prize-selection", eventId, profileId, value: "1514" },
    {
      kind: "progress-outbox",
      outboxId: progress.outboxId,
      value: { ...progress.outbox, lastQueuedAtMs: 300 },
    },
    {
      kind: "profile-game-outbox-field",
      eventId,
      field: "lastQueuedAtMs",
      value: 300,
    },
    { kind: "profile-game-outbox-cleanup", eventId, profileId, value: true },
    { kind: "telegram-generation", eventId, value: 1, increment: true },
    {
      kind: "telegram-state",
      eventId,
      value: { retained: true, updated: true },
    },
  ];
}

async function readStorage() {
  const tables = [
    "event_records",
    "event_prize_selections",
    "event_progress_outboxes",
    "event_profile_game_projection_outboxes",
    "event_telegram_projection_state",
    "event_transition_intents",
  ];
  return (
    await testEnv.EVENT_DB.batch(
      tables.map((table) =>
        testEnv.EVENT_DB.prepare(`SELECT * FROM ${table} ORDER BY 1`),
      ),
    )
  ).map(({ results }) => results);
}

describe("event mutation snapshot batches", () => {
  beforeAll(() =>
    applyEventTestMigrations(
      testEnv.EVENT_DB,
      testEnv.TEST_EVENT_D1_MIGRATIONS,
    ),
  );

  beforeEach(async () => {
    await testEnv.EVENT_DB.batch([
      testEnv.EVENT_DB.prepare(
        "UPDATE event_records SET pending_transition_id = NULL",
      ),
      testEnv.EVENT_DB.prepare("DELETE FROM event_transition_intents"),
      testEnv.EVENT_DB.prepare("DELETE FROM event_write_admissions"),
      testEnv.EVENT_DB.prepare("DELETE FROM event_records"),
    ]);
  });

  it("loads each required snapshot once in one batch through the supplied session", async () => {
    const progress = await seed();
    const observed = observeReads();
    await commit(observed.db, mixedPlan(progress));
    expect(observed.readBatches.map((batch) => batch.length)).toEqual([5]);
    expect(observed.standaloneReads).toEqual([]);
    expect(observed.writeBatches).toHaveLength(1);
    expect(await readEventSnapshot(testEnv.EVENT_DB, eventId)).toMatchObject({
      revision: 2,
      event: {
        status: "active",
        updatedAtMs: 300,
        unknownFutureField: { retained: true },
      },
      prizeSelections: { [profileId]: "1514" },
    });
    expect(
      await readEventTelegramProjectionState(testEnv.EVENT_DB, eventId),
    ).toEqual({
      revision: 2,
      generation: 2,
      state: { retained: true, updated: true },
    });
    expect(
      await testEnv.EVENT_DB.prepare(
        "SELECT record_json FROM event_profile_game_projection_outboxes WHERE event_id = ?",
      )
        .bind(eventId)
        .first("record_json"),
    ).toBe(
      JSON.stringify({
        schemaVersion: 1,
        status: "pending",
        requestId: "profile-before",
        lastQueuedAtMs: 300,
        cleanupOwnerProfileIds: { [profileId]: true },
      }),
    );
  });

  it.each([false, true])(
    "bounds 41 unique reads and leaves no partial writes on read failure: %s",
    async (failSecondBatch) => {
      const ids = Array.from(
        { length: 41 },
        (_, index) => `batch-event-${index}`,
      );
      await commit(
        testEnv.EVENT_DB,
        ids.map((id) => ({
          kind: "event",
          eventId: id,
          value: eventRecord(id),
        })),
      );
      const before = await readStorage();
      const observed = observeReads({
        beforeReadBatch(attempt) {
          if (failSecondBatch && attempt === 2)
            throw new Error("snapshot-read-failed");
        },
      });
      const changes: EventMutation[] = ids.flatMap((id) => [
        { kind: "event-field", eventId: id, field: "updatedAtMs", value: 200 },
        { kind: "event-field", eventId: id, field: "updatedAtMs", value: 300 },
      ]);
      const result = commit(observed.db, changes);
      if (failSecondBatch) {
        await expect(result).rejects.toThrow("snapshot-read-failed");
        expect(observed.writeBatches).toEqual([]);
        expect(await readStorage()).toEqual(before);
      } else {
        await result;
        expect(observed.writeBatches).toHaveLength(1);
        expect(
          await testEnv.EVENT_DB.prepare(
            "SELECT count(*) AS count FROM event_records WHERE revision = 2 AND updated_at_ms = 300",
          ).first("count"),
        ).toBe(41);
      }
      expect(observed.readBatches.map((batch) => batch.length)).toEqual([
        40, 1,
      ]);
      expect(observed.standaloneReads).toEqual([]);
    },
  );

  it.each([
    "event revision",
    "raw progress JSON",
    "Telegram revision",
    "attached transition",
  ] as const)(
    "rejects a concurrent %s change after preload without partial writes",
    async (race) => {
      const progress = await seed();
      let expected: Awaited<ReturnType<typeof readStorage>> | undefined;
      const observed = observeReads({
        async afterReadBatch(attempt) {
          if (attempt !== 1) return;
          if (race === "event revision") {
            await testEnv.EVENT_DB.prepare(
              "UPDATE event_records SET revision = revision + 1 WHERE event_id = ?",
            )
              .bind(eventId)
              .run();
          } else if (race === "raw progress JSON") {
            await testEnv.EVENT_DB.prepare(
              "UPDATE event_progress_outboxes SET record_json = ? WHERE outbox_id = ? AND status = 'pending'",
            )
              .bind(JSON.stringify(progress.outbox, null, 2), progress.outboxId)
              .run();
          } else if (race === "Telegram revision") {
            await testEnv.EVENT_DB.prepare(
              "UPDATE event_telegram_projection_state SET revision = revision + 1 WHERE event_id = ?",
            )
              .bind(eventId)
              .run();
          } else {
            await withAdmission((admission) =>
              createEventTransitionIntent(
                testEnv.EVENT_DB,
                {
                  schemaVersion: 1,
                  transitionId: "concurrent-transition",
                  eventId,
                  expectedRevision: 1,
                  canonicalUpdates: {},
                  rtdbEffects: {},
                  createdAtMs: 200,
                  updatedAtMs: 200,
                },
                { admission },
              ),
            );
          }
          expected = await readStorage();
        },
      });
      await expect(
        commit(observed.db, mixedPlan(progress)),
      ).rejects.toBeInstanceOf(EventD1Conflict);
      expect(expected).toBeDefined();
      expect(await readStorage()).toEqual(expected);
      expect(observed.readBatches).toHaveLength(1);
      expect(observed.writeBatches).toHaveLength(1);
    },
  );

  it("does not load unrelated malformed records and rejects a required malformed event before writing", async () => {
    await seed();
    await testEnv.EVENT_DB.batch([
      testEnv.EVENT_DB.prepare(
        "UPDATE event_profile_game_projection_outboxes SET record_json = '{}'",
      ),
      testEnv.EVENT_DB.prepare(
        "INSERT INTO profile_event_prizes (profile_id, event_id, assignment_json, updated_at_ms) VALUES (?, ?, '{}', 100)",
      ).bind(profileId, eventId),
    ]);
    const changes: EventMutation[] = [
      { kind: "event-field", eventId, field: "updatedAtMs", value: 300 },
    ];
    const observed = observeReads();
    await commit(observed.db, changes);
    expect(observed.readBatches.map((batch) => batch.length)).toEqual([1]);
    expect(observed.readBatches[0][0]).toContain("FROM event_records");
    await testEnv.EVENT_DB.prepare(
      "UPDATE event_records SET record_json = '{}' WHERE event_id = ?",
    )
      .bind(eventId)
      .run();
    const malformed = observeReads();
    await expect(commit(malformed.db, changes)).rejects.toThrow(
      "invalid-event-record",
    );
    expect(malformed.writeBatches).toEqual([]);
  });
});
