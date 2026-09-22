import { commitEventMutations } from "../src/eventD1.ts";
import { commitEventMutationsInternal } from "../src/eventD1/commit.ts";
import { readProfilePrizeMutationSnapshots } from "../src/eventD1/reads.ts";
import { decodeEventUpdates } from "../src/eventCompatibilityCodec.ts";
import { buildEventProgressPlan } from "../src/eventProgressCodec.ts";
import type { EventMutation } from "../../../runtime/eventCommands.js";
import { classifyD1Failure } from "../src/d1Failure.ts";
import { observeD1FailureDatabase } from "./d1FailureTestUtils.ts";
import {
  patchEventOwnedPaths as patchEventOwnedPathsRaw,
  readEventOwnedPath,
  transactEventOwnedPath as transactEventOwnedPathRaw,
} from "./eventD1Fixture.ts";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import type { D1Migration } from "cloudflare:test";
import {
  applyEventTestMigrations,
  transitionEventStorageMode,
} from "./eventTestMigrations.ts";
import {
  acquireEventWriteAdmission,
  createEventTransitionIntent as createEventTransitionIntentRaw,
  EventD1Conflict,
  EventD1Failure,
  EventWritesDisabled,
  listDueEventProfileGameProjectionOutboxes,
  listDueEventProgressOutboxes,
  listDueEventTelegramProjectionOutboxes,
  listEventAggregates,
  listPendingEventTransitionIntents,
  listProfileEventPrizeAssignments,
  readEvent,
  readEventPrizeSelections,
  readEventRuntimeControl,
  readEventSnapshot,
  readEventSnapshotIfChanged,
  readEventTelegramProjectionState,
  readProfileEventPrizes,
  readProfileEventPrizesIfChanged,
  readProfileEventPrizeAssignment,
  releaseEventWriteAdmission,
  transactEventField,
  transactEventLease,
  validateEventAggregate,
  type EventD1Connection,
} from "../src/eventD1.ts";

const testEnv = env as Env & { TEST_EVENT_D1_MIGRATIONS: D1Migration[] };
const eventId = "NN3eRzoZo80";
const prizeId = "1092";
const profileId = "profile-one";

function eventRecord(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 2,
    eventId,
    status: "scheduled",
    createdAtMs: 100,
    updatedAtMs: 100,
    startAtMs: 1_000,
    createdByProfileId: profileId,
    createdByLoginUid: "login-one",
    createdByUsername: "ivan",
    participants: {
      [profileId]: {
        profileId,
        loginUid: "login-one",
        displayName: "Ivan",
        state: "active",
      },
    },
    rounds: {},
    unknownFutureField: { retained: true },
    ...overrides,
  };
}

function assignment(targetProfileId = profileId) {
  return {
    eventId,
    profileId: targetProfileId,
    place: 1 as const,
    prizeId,
    assignedAtMs: 2_000,
  };
}

function observeSnapshotReads() {
  const session = testEnv.EVENT_DB.withSession("first-primary");
  const batches: D1Result<unknown>[][] = [];
  const db: EventD1Connection = {
    prepare: (query) => session.prepare(query),
    async batch<T>(statements: D1PreparedStatement[]) {
      const results = await session.batch<T>(statements);
      batches.push(results);
      return results;
    },
  };
  return { db, batches, session };
}

function observePrizeMutationBatches(
  afterReadBatch?: (count: number) => Promise<void>,
) {
  type Statement = {
    query: string;
    values: unknown[];
    statement: D1PreparedStatement;
  };
  const statements = new WeakMap<D1PreparedStatement, Statement>();
  const readBatches: Array<{
    statements: Statement[];
    results: D1Result<unknown>[];
  }> = [];
  const writeBatches: Statement[][] = [];
  const wrap = (
    statement: D1PreparedStatement,
    query: string,
    values: unknown[] = [],
  ): D1PreparedStatement => {
    const wrapped = new Proxy(statement, {
      get(target, property) {
        if (property === "bind") {
          return (...bound: unknown[]) =>
            wrap(target.bind(...bound), query, bound);
        }
        const member = Reflect.get(target, property, target);
        return typeof member === "function" ? member.bind(target) : member;
      },
    });
    statements.set(wrapped, { query, values, statement });
    return wrapped;
  };
  const database = new Proxy(testEnv.EVENT_DB, {
    get(target, property) {
      if (property === "prepare") {
        return (query: string) => wrap(target.prepare(query), query);
      }
      if (property === "batch") {
        return async (input: D1PreparedStatement[]) => {
          const prepared = input.map((statement) => {
            const value = statements.get(statement);
            if (!value) throw new Error("unknown-prize-statement");
            return value;
          });
          const readOnly = prepared.every(({ query }) =>
            /^\s*SELECT\b/i.test(query),
          );
          if (!readOnly) writeBatches.push(prepared);
          const results = await target.batch(
            prepared.map(({ statement }) => statement),
          );
          if (readOnly) {
            readBatches.push({ statements: prepared, results });
            await afterReadBatch?.(readBatches.length);
          }
          return results;
        };
      }
      const member = Reflect.get(target, property, target);
      return typeof member === "function" ? member.bind(target) : member;
    },
  });
  return { database, readBatches, writeBatches };
}

async function readPrizeStorage() {
  const results = await testEnv.EVENT_DB.batch<Record<string, unknown>>([
    testEnv.EVENT_DB.prepare(
      "SELECT * FROM event_prize_selections ORDER BY event_id, profile_id",
    ),
    testEnv.EVENT_DB.prepare(
      "SELECT * FROM profile_event_prizes ORDER BY profile_id, event_id",
    ),
    testEnv.EVENT_DB.prepare(
      "SELECT * FROM profile_event_prize_revisions ORDER BY profile_id",
    ),
    testEnv.EVENT_DB.prepare("SELECT * FROM event_records ORDER BY event_id"),
    testEnv.EVENT_DB.prepare(
      "SELECT * FROM event_progress_outboxes ORDER BY outbox_id",
    ),
  ]);
  return {
    selections: results[0].results,
    prizes: results[1].results,
    profileRevisions: results[2].results,
    events: results[3].results,
    outboxes: results[4].results,
  };
}

async function seedPrizeRows() {
  const otherEventId = "FRkdorMWaYW";
  const otherAssignment = {
    ...assignment(),
    eventId: otherEventId,
    prizeId: "1866",
    archivedMetadata: { edition: 1, labels: ["first", "second"] },
  };
  await patchEventOwnedPaths(
    testEnv.EVENT_DB,
    {
      [`events/${eventId}`]: eventRecord(),
      [`events/${otherEventId}`]: eventRecord({ eventId: otherEventId }),
      [`eventPrizeSelections/${eventId}`]: {
        [profileId]: prizeId,
        "profile-two": "1111",
      },
      [`profileEventPrizes/${profileId}`]: {
        [eventId]: assignment(),
        [otherEventId]: otherAssignment,
      },
    },
    { now: () => 200 },
  );
  await testEnv.EVENT_DB.prepare(
    "UPDATE profile_event_prizes SET assignment_json = ? WHERE profile_id = ? AND event_id = ?",
  )
    .bind(JSON.stringify(otherAssignment, null, 2), profileId, otherEventId)
    .run();
  return { otherEventId, otherAssignment };
}

async function withD1Admission<T>(
  operation: (
    admission: Awaited<ReturnType<typeof acquireEventWriteAdmission>>,
  ) => Promise<T>,
): Promise<T> {
  const admission = await acquireEventWriteAdmission(testEnv.EVENT_DB);
  try {
    return await operation(admission);
  } finally {
    await releaseEventWriteAdmission(testEnv.EVENT_DB, admission);
  }
}

function patchEventOwnedPaths(
  db: D1Database,
  updates: Parameters<typeof patchEventOwnedPathsRaw>[1],
  options: Omit<
    Parameters<typeof patchEventOwnedPathsRaw>[2],
    "admission"
  > = {},
) {
  return withD1Admission((admission) =>
    patchEventOwnedPathsRaw(db, updates, { ...options, admission }),
  );
}

function transactEventOwnedPath(
  db: EventD1Connection,
  path: string,
  updater: Parameters<typeof transactEventOwnedPathRaw>[2],
  options: Omit<
    Parameters<typeof transactEventOwnedPathRaw>[3],
    "admission"
  > = {},
) {
  return withD1Admission((admission) =>
    transactEventOwnedPathRaw(db, path, updater, { ...options, admission }),
  );
}

function createEventTransitionIntent(
  db: D1Database,
  intent: Parameters<typeof createEventTransitionIntentRaw>[1],
) {
  return withD1Admission((admission) =>
    createEventTransitionIntentRaw(db, intent, { admission }),
  );
}

describe("event D1 store", () => {
  beforeAll(async () => {
    await applyEventTestMigrations(
      testEnv.EVENT_DB,
      testEnv.TEST_EVENT_D1_MIGRATIONS,
    );
  });

  beforeEach(async () => {
    await testEnv.EVENT_DB.batch([
      testEnv.EVENT_DB.prepare(
        "UPDATE event_records SET pending_transition_id = NULL",
      ),
      testEnv.EVENT_DB.prepare("DELETE FROM event_transition_intents"),
      testEnv.EVENT_DB.prepare("DELETE FROM event_leases"),
      testEnv.EVENT_DB.prepare("DELETE FROM event_sync_throttles"),
      testEnv.EVENT_DB.prepare("DELETE FROM event_write_admissions"),
      testEnv.EVENT_DB.prepare("DELETE FROM event_progress_outboxes"),
      testEnv.EVENT_DB.prepare("DELETE FROM event_records"),
      testEnv.EVENT_DB.prepare("DELETE FROM profile_event_prize_revisions"),
    ]);
  });

  describe("commit failure classification", () => {
    it.each(["present", "missing"])(
      "fails closed with a %s event guard sentinel",
      async (sentinel) => {
        await patchEventOwnedPaths(testEnv.EVENT_DB, {
          [`events/${eventId}`]: eventRecord(),
        });
        await withD1Admission(async (admission) => {
          const observed = observeD1FailureDatabase(testEnv.EVENT_DB, {
            async beforeBatch() {
              await testEnv.EVENT_DB.prepare(
                "UPDATE event_records SET revision = revision + 1 WHERE event_id = ?",
              )
                .bind(eventId)
                .run();
            },
          });
          if (sentinel === "missing") {
            await testEnv.EVENT_DB.prepare(
              "DELETE FROM event_transaction_guards",
            ).run();
          }
          let failure: unknown;
          try {
            failure = await commitEventMutations(
              observed.database,
              [
                {
                  kind: "event-field",
                  eventId,
                  field: "status",
                  value: "active",
                },
              ],
              { admission },
            ).catch((error: unknown) => error);
          } finally {
            if (sentinel === "missing") {
              await testEnv.EVENT_DB.prepare(
                "INSERT INTO event_transaction_guards VALUES (1)",
              ).run();
            }
          }
          expect(failure).toBeInstanceOf(
            sentinel === "present" ? EventD1Conflict : EventD1Failure,
          );
          if (sentinel === "missing")
            expect(failure).not.toBeInstanceOf(EventD1Conflict);
          expect(failure).toHaveProperty("cause", observed.errors[0]);
          expect(classifyD1Failure(observed.errors[0])).toBe(
            sentinel === "present" ? "event-conflict" : "guard",
          );
          expect(observed.batches).toHaveLength(1);
          expect(observed.sessions).toEqual(
            sentinel === "present" ? [] : ["first-primary"],
          );
          expect(
            (await readEventSnapshot(testEnv.EVENT_DB, eventId)).event?.status,
          ).toBe("scheduled");
        });
      },
    );

    it.each([
      "expired admission",
      "lost lease",
      "SQL failure",
      "diagnostic unavailable",
    ])("does not retry a transaction after %s", async (mode) => {
      await patchEventOwnedPaths(testEnv.EVENT_DB, {
        [`events/${eventId}`]: eventRecord(),
      });
      const before = await readEventSnapshot(testEnv.EVENT_DB, eventId);
      const admission = await acquireEventWriteAdmission(
        testEnv.EVENT_DB,
        mode === "expired admission" ? { nowMs: 1, ttlMs: 1 } : {},
      );
      const observed = observeD1FailureDatabase(testEnv.EVENT_DB, {
        diagnosticFailure:
          mode === "diagnostic unavailable"
            ? new Error("session-unavailable")
            : undefined,
      });
      if (mode === "SQL failure") {
        await testEnv.EVENT_DB.prepare(
          `CREATE TRIGGER guard_test_event_update BEFORE UPDATE ON event_records
             BEGIN SELECT RAISE(ABORT, 'event pending transition is unavailable'); END`,
        ).run();
      }
      let decisions = 0;
      try {
        const failure = await transactEventField(
          observed.database,
          eventId,
          "status",
          () => {
            decisions++;
            return { value: "active" };
          },
          {
            admission,
            ...(mode === "lost lease" || mode === "diagnostic unavailable"
              ? {
                  eventLease: {
                    eventId,
                    lockId: "missing",
                    ownerUid: "missing",
                  },
                }
              : {}),
          },
        ).catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(EventD1Failure);
        expect(failure).not.toBeInstanceOf(EventD1Conflict);
        expect(failure).toHaveProperty("cause", observed.errors[0]);
        expect(observed.errors).toHaveLength(1);
        expect(decisions).toBe(1);
        expect(observed.sessions).toEqual(
          mode === "SQL failure" ? [] : ["first-primary"],
        );
        expect(failure).toHaveProperty(
          "message",
          mode === "expired admission"
            ? "event-write-admission-invalid"
            : mode === "lost lease"
              ? "event-lease-lost"
              : mode === "diagnostic unavailable"
                ? "event-d1-unavailable"
                : "event-d1-integrity",
        );
        expect(await readEventSnapshot(testEnv.EVENT_DB, eventId)).toEqual(
          before,
        );
      } finally {
        if (mode === "SQL failure") {
          await testEnv.EVENT_DB.prepare(
            "DROP TRIGGER guard_test_event_update",
          ).run();
        }
        await releaseEventWriteAdmission(testEnv.EVENT_DB, admission);
      }
    });

    it("maps frozen coordination and transition writes without losing their causes", async () => {
      await patchEventOwnedPaths(testEnv.EVENT_DB, {
        [`events/${eventId}`]: eventRecord(),
      });
      const admission = await acquireEventWriteAdmission(testEnv.EVENT_DB);
      await releaseEventWriteAdmission(testEnv.EVENT_DB, admission);
      await transitionEventStorageMode(testEnv.EVENT_DB, {
        expected: { storageMode: "d1" },
        next: { storageMode: "frozen" },
        nowMs: 100,
      });
      try {
        for (const kind of ["lease", "transition"] as const) {
          const observed = observeD1FailureDatabase(testEnv.EVENT_DB);
          const operation =
            kind === "lease"
              ? transactEventLease(
                  observed.database,
                  eventId,
                  () => ({
                    value: {
                      lockId: "test-lease",
                      ownerUid: "test-owner",
                      acquiredAtMs: 1,
                      refreshedAtMs: 1,
                      expiresAtMs: 2,
                    },
                  }),
                  { admission },
                )
              : createEventTransitionIntentRaw(
                  observed.database,
                  {
                    schemaVersion: 1,
                    transitionId: "test-transition",
                    eventId,
                    expectedRevision: 1,
                    canonicalUpdates: {},
                    rtdbEffects: {},
                    createdAtMs: 1,
                    updatedAtMs: 1,
                  },
                  { admission },
                );
          const failure = await operation.catch((error: unknown) => error);
          expect(failure).toBeInstanceOf(EventWritesDisabled);
          expect(failure).toHaveProperty("cause", observed.errors[0]);
          expect(observed.batches).toHaveLength(1);
          expect(observed.sessions).toEqual(["first-primary"]);
          expect(
            await readEventSnapshot(testEnv.EVENT_DB, eventId),
          ).toMatchObject({ revision: 1, event: { status: "scheduled" } });
        }
      } finally {
        await transitionEventStorageMode(testEnv.EVENT_DB, {
          expected: { storageMode: "frozen" },
          next: { storageMode: "d1" },
          nowMs: 101,
        });
      }
    });
  });

  it("rejects invalid nested typed identities and stored paths without changing the event", async () => {
    await patchEventOwnedPaths(testEnv.EVENT_DB, {
      [`events/${eventId}`]: eventRecord(),
    });
    const before = await readEventSnapshot(testEnv.EVENT_DB, eventId);
    for (const invalid of ["", "bad/key", "bad#key", " padded "]) {
      const changes: EventMutation[] = [
        { kind: "event-round", eventId, roundKey: invalid, value: {} },
        {
          kind: "event-match-status",
          eventId,
          roundKey: invalid,
          matchKey: "0_0",
          value: "host",
        },
        {
          kind: "event-match-status",
          eventId,
          roundKey: "0",
          matchKey: invalid,
          value: "host",
        },
        {
          kind: "event-disqualification",
          eventId,
          roundKey: invalid,
          matchKey: "0_0",
          value: true,
        },
        {
          kind: "event-disqualification",
          eventId,
          roundKey: "0",
          matchKey: invalid,
          value: true,
        },
      ];
      for (const change of changes)
        await expect(
          withD1Admission((admission) =>
            commitEventMutations(testEnv.EVENT_DB, [change], { admission }),
          ),
        ).rejects.toThrow("invalid-event-path");
    }
    for (const path of [
      `events/${eventId}/rounds//matches/0_0/status`,
      `events/${eventId}/rounds/0/matches//winnerDisqualified`,
      `events/${eventId}/rounds/bad#key`,
      `/events/${eventId}/status`,
      `events/${eventId}/status/`,
    ]) {
      await expect(
        withD1Admission(async (admission) =>
          commitEventMutations(
            testEnv.EVENT_DB,
            decodeEventUpdates({ [path]: true }) as EventMutation[],
            { admission },
          ),
        ),
      ).rejects.toThrow("invalid-event-path");
    }
    expect(await readEventSnapshot(testEnv.EVENT_DB, eventId)).toEqual(before);
  });

  it("stores validated aggregates and returns session-compatible snapshots", async () => {
    const created = await patchEventOwnedPaths(
      testEnv.EVENT_DB,
      {
        [`events/${eventId}`]: eventRecord(),
        [`eventPrizeSelections/${eventId}/${profileId}`]: prizeId,
      },
      { now: () => 200 },
    );
    expect(created.eventRevisions).toEqual({ [eventId]: 1 });

    const session = testEnv.EVENT_DB.withSession("first-primary");
    await expect(readEventSnapshot(session, eventId)).resolves.toEqual({
      event: eventRecord(),
      eventId,
      prizeSelections: { [profileId]: prizeId },
      revision: 1,
    });
    expect(session.getBookmark()).toBeTypeOf("string");
    await expect(readEvent(session, eventId)).resolves.toEqual(eventRecord());
    await expect(listEventAggregates(session)).resolves.toEqual({
      [eventId]: eventRecord(),
    });
    await expect(readEventPrizeSelections(session, eventId)).resolves.toEqual({
      [profileId]: prizeId,
    });
    expect(
      (await readEventOwnedPath(
        testEnv.EVENT_DB,
        `events/${eventId}/unknownFutureField`,
      )) as unknown,
    ).toEqual({ retained: true });
  });

  it("reads only the requested event or prize rows", async () => {
    await patchEventOwnedPaths(testEnv.EVENT_DB, {
      [`events/${eventId}`]: eventRecord(),
      [`eventPrizeSelections/${eventId}/${profileId}`]: prizeId,
      [`profileEventPrizes/${profileId}/${eventId}`]: assignment(),
    });
    const session = testEnv.EVENT_DB.withSession("first-primary");
    const queries: string[] = [];
    const db: EventD1Connection = {
      prepare(query) {
        queries.push(query);
        return session.prepare(query);
      },
      batch: (statements) => session.batch(statements),
    };

    await expect(readEvent(db, eventId)).resolves.toEqual(eventRecord());
    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain("FROM event_records WHERE event_id = ?");
    queries.length = 0;

    await expect(readEventPrizeSelections(db, eventId)).resolves.toEqual({
      [profileId]: prizeId,
    });
    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain("FROM event_prize_selections");
    queries.length = 0;

    await expect(
      readProfileEventPrizeAssignment(db, profileId, eventId),
    ).resolves.toEqual(assignment());
    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain("FROM profile_event_prizes");
    expect(queries[0]).toContain("WHERE profile_id = ? AND event_id = ?");
    queries.length = 0;

    await expect(
      listProfileEventPrizeAssignments(db, profileId, {
        startAt: eventId,
        limit: 1,
      }),
    ).resolves.toEqual({ [eventId]: assignment() });
    expect(queries).toHaveLength(1);
    expect(session.getBookmark()).toBeTypeOf("string");
  });

  it("suppresses unchanged event payloads in one batch without adding a miss roundtrip", async () => {
    await patchEventOwnedPaths(testEnv.EVENT_DB, {
      [`events/${eventId}`]: eventRecord(),
      [`eventPrizeSelections/${eventId}/${profileId}`]: prizeId,
    });
    for (const knownRevision of [null, 0, 1, 2]) {
      const { db, batches, session } = observeSnapshotReads();
      const result = await readEventSnapshotIfChanged(
        db,
        eventId,
        knownRevision,
      );
      expect(batches).toHaveLength(1);
      expect(batches[0]).toHaveLength(2);
      expect(session.getBookmark()).toBeTypeOf("string");
      if (knownRevision === 1) {
        expect(result).toEqual({ notModified: true, revision: 1 });
        expect(batches[0][0].results).toEqual([
          expect.objectContaining({ revision: 1, record_json: null }),
        ]);
        expect(batches[0][1].results).toEqual([]);
      } else {
        expect(result).toEqual({
          notModified: false,
          snapshot: {
            event: eventRecord(),
            eventId,
            prizeSelections: { [profileId]: prizeId },
            revision: 1,
          },
        });
        expect(batches[0][0].results).toEqual([
          expect.objectContaining({ record_json: expect.any(String) }),
        ]);
        expect(batches[0][1].results).toHaveLength(1);
      }
    }
  });

  it("suppresses unchanged prize payloads in one batch without adding a miss roundtrip", async () => {
    await patchEventOwnedPaths(testEnv.EVENT_DB, {
      [`events/${eventId}`]: eventRecord(),
      [`profileEventPrizes/${profileId}/${eventId}`]: assignment(),
    });
    for (const knownRevision of [null, 0, 1, 2]) {
      const { db, batches, session } = observeSnapshotReads();
      const result = await readProfileEventPrizesIfChanged(
        db,
        profileId,
        knownRevision,
      );
      expect(batches).toHaveLength(1);
      expect(batches[0]).toHaveLength(2);
      expect(batches[0][1].results).toEqual([{ revision: 1 }]);
      expect(session.getBookmark()).toBeTypeOf("string");
      if (knownRevision === 1) {
        expect(result).toEqual({ notModified: true, revision: 1 });
        expect(batches[0][0].results).toEqual([]);
      } else {
        expect(result).toEqual({
          notModified: false,
          snapshot: {
            prizes: { [eventId]: assignment() },
            profileId,
            revision: 1,
          },
        });
        expect(batches[0][0].results).toEqual([
          expect.objectContaining({ assignment_json: expect.any(String) }),
        ]);
      }
    }
  });

  it.each(["event", "prizes"] as const)(
    "keeps unchanged %s reads bounded as child rows grow",
    async (kind) => {
      await patchEventOwnedPaths(testEnv.EVENT_DB, {
        [`events/${eventId}`]: eventRecord(),
        [`eventPrizeSelections/${eventId}/${profileId}`]: prizeId,
        [`profileEventPrizes/${profileId}/${eventId}`]: assignment(),
      });
      const read =
        kind === "event"
          ? readEventSnapshotIfChanged
          : readProfileEventPrizesIfChanged;
      const resourceId = kind === "event" ? eventId : profileId;
      const childResultIndex = kind === "event" ? 1 : 0;
      const baseline = observeSnapshotReads();
      await expect(read(baseline.db, resourceId, 1)).resolves.toEqual({
        notModified: true,
        revision: 1,
      });
      const baselineRowsRead = baseline.batches[0].reduce(
        (total, result) => total + result.meta.rows_read,
        0,
      );
      expect(baselineRowsRead).toBeGreaterThan(0);

      await testEnv.EVENT_DB.batch([
        testEnv.EVENT_DB.prepare(
          `WITH RECURSIVE entries(n) AS (
             SELECT 1 UNION ALL SELECT n + 1 FROM entries WHERE n < 127
           )
           INSERT INTO event_records (
             event_id, status, start_at_ms, updated_at_ms, revision, record_json
           )
           SELECT 'poll-event-' || n, status, start_at_ms, updated_at_ms, 1,
                  json_set(record_json, '$.eventId', 'poll-event-' || n)
           FROM entries CROSS JOIN event_records WHERE event_id = ?`,
        ).bind(eventId),
        testEnv.EVENT_DB.prepare(
          `INSERT INTO event_prize_selections (
             event_id, profile_id, prize_id, updated_at_ms
           )
           SELECT ?, event_id, ?, updated_at_ms FROM event_records
           WHERE event_id LIKE 'poll-event-%'`,
        ).bind(eventId, prizeId),
        testEnv.EVENT_DB.prepare(
          `INSERT INTO profile_event_prizes (
             profile_id, event_id, assignment_json, updated_at_ms
           )
           SELECT ?, event_id, json_set(?, '$.eventId', event_id), updated_at_ms
           FROM event_records WHERE event_id LIKE 'poll-event-%'`,
        ).bind(profileId, JSON.stringify(assignment())),
        testEnv.EVENT_DB.prepare(
          "UPDATE event_records SET revision = 2 WHERE event_id = ?",
        ).bind(eventId),
        testEnv.EVENT_DB.prepare(
          "UPDATE profile_event_prize_revisions SET revision = 2 WHERE profile_id = ?",
        ).bind(profileId),
      ]);

      for (const knownRevision of [2, 1, null]) {
        const { db, batches } = observeSnapshotReads();
        const result = await read(db, resourceId, knownRevision);
        expect(batches).toHaveLength(1);
        expect(batches[0]).toHaveLength(2);
        const rowsRead = batches[0].reduce(
          (total, row) => total + row.meta.rows_read,
          0,
        );
        if (knownRevision === 2) {
          expect(result).toEqual({ notModified: true, revision: 2 });
          expect(batches[0][childResultIndex].results).toEqual([]);
          expect(rowsRead).toBeLessThanOrEqual(baselineRowsRead);
        } else {
          expect(result.notModified).toBe(false);
          expect(batches[0][childResultIndex].results).toHaveLength(128);
          expect(rowsRead).toBeGreaterThan(baselineRowsRead);
        }
      }
    },
  );

  it("invalidates conditional reads for event, selection, assignment and cascade changes", async () => {
    await patchEventOwnedPaths(testEnv.EVENT_DB, {
      [`events/${eventId}`]: eventRecord(),
      [`eventPrizeSelections/${eventId}/${profileId}`]: prizeId,
      [`profileEventPrizes/${profileId}/${eventId}`]: assignment(),
    });
    await patchEventOwnedPaths(testEnv.EVENT_DB, {
      [`eventPrizeSelections/${eventId}/${profileId}`]: "1111",
    });
    await expect(
      readEventSnapshotIfChanged(testEnv.EVENT_DB, eventId, 1),
    ).resolves.toMatchObject({
      notModified: false,
      snapshot: { revision: 2, prizeSelections: { [profileId]: "1111" } },
    });
    await patchEventOwnedPaths(testEnv.EVENT_DB, {
      [`events/${eventId}/status`]: "active",
    });
    await expect(
      readEventSnapshotIfChanged(testEnv.EVENT_DB, eventId, 2),
    ).resolves.toMatchObject({
      notModified: false,
      snapshot: { revision: 3, event: { status: "active" } },
    });
    await patchEventOwnedPaths(testEnv.EVENT_DB, {
      [`profileEventPrizes/${profileId}/${eventId}`]: {
        ...assignment(),
        assignedAtMs: 3_000,
      },
    });
    await expect(
      readProfileEventPrizesIfChanged(testEnv.EVENT_DB, profileId, 1),
    ).resolves.toMatchObject({
      notModified: false,
      snapshot: {
        revision: 2,
        prizes: { [eventId]: { assignedAtMs: 3_000 } },
      },
    });
    await patchEventOwnedPaths(testEnv.EVENT_DB, {
      [`profileEventPrizes/${profileId}/${eventId}`]: null,
    });
    await expect(
      readProfileEventPrizesIfChanged(testEnv.EVENT_DB, profileId, 2),
    ).resolves.toEqual({
      notModified: false,
      snapshot: { profileId, revision: 3, prizes: {} },
    });
    await patchEventOwnedPaths(testEnv.EVENT_DB, {
      [`profileEventPrizes/${profileId}/${eventId}`]: assignment(),
    });
    await testEnv.EVENT_DB.prepare(
      "DELETE FROM event_records WHERE event_id = ?",
    )
      .bind(eventId)
      .run();
    await expect(
      readProfileEventPrizesIfChanged(testEnv.EVENT_DB, profileId, 4),
    ).resolves.toEqual({
      notModified: false,
      snapshot: { profileId, revision: 5, prizes: {} },
    });
    await expect(
      readEventSnapshotIfChanged(testEnv.EVENT_DB, eventId, 3),
    ).resolves.toEqual({
      notModified: false,
      snapshot: { eventId, revision: 0, event: null, prizeSelections: {} },
    });
  });

  it("supports conditional revision zero for missing events and empty prizes", async () => {
    for (const knownRevision of [null, 0, 1]) {
      await expect(
        readEventSnapshotIfChanged(testEnv.EVENT_DB, eventId, knownRevision),
      ).resolves.toEqual(
        knownRevision === 0
          ? { notModified: true, revision: 0 }
          : {
              notModified: false,
              snapshot: {
                eventId,
                revision: 0,
                event: null,
                prizeSelections: {},
              },
            },
      );
      await expect(
        readProfileEventPrizesIfChanged(
          testEnv.EVENT_DB,
          profileId,
          knownRevision,
        ),
      ).resolves.toEqual(
        knownRevision === 0
          ? { notModified: true, revision: 0 }
          : {
              notModified: false,
              snapshot: { profileId, revision: 0, prizes: {} },
            },
      );
    }
  });

  it("still loads and validates assignments when a matching zero has no stored revision", async () => {
    await patchEventOwnedPaths(testEnv.EVENT_DB, {
      [`events/${eventId}`]: eventRecord(),
      [`profileEventPrizes/${profileId}/${eventId}`]: assignment(),
    });
    await testEnv.EVENT_DB.prepare(
      "DELETE FROM profile_event_prize_revisions WHERE profile_id = ?",
    )
      .bind(profileId)
      .run();
    const { db, batches } = observeSnapshotReads();
    await expect(
      readProfileEventPrizesIfChanged(db, profileId, 0),
    ).resolves.toEqual({
      notModified: true,
      revision: 0,
    });
    expect(batches).toHaveLength(1);
    expect(batches[0][0].results).toHaveLength(1);
    expect(batches[0][1].results).toEqual([]);
    await testEnv.EVENT_DB.prepare(
      "UPDATE profile_event_prizes SET assignment_json = '{}' WHERE profile_id = ?",
    )
      .bind(profileId)
      .run();
    await expect(
      readProfileEventPrizesIfChanged(testEnv.EVENT_DB, profileId, 0),
    ).rejects.toThrow("invalid-event-prize-assignment");
  });

  it("keeps payload validation on misses and full reads while trusting matching revisions", async () => {
    await patchEventOwnedPaths(testEnv.EVENT_DB, {
      [`events/${eventId}`]: eventRecord(),
      [`profileEventPrizes/${profileId}/${eventId}`]: assignment(),
    });
    await testEnv.EVENT_DB.batch([
      testEnv.EVENT_DB.prepare(
        "UPDATE event_records SET record_json = '{}' WHERE event_id = ?",
      ).bind(eventId),
      testEnv.EVENT_DB.prepare(
        "UPDATE profile_event_prizes SET assignment_json = '{}' WHERE profile_id = ?",
      ).bind(profileId),
    ]);
    await expect(
      readEventSnapshotIfChanged(testEnv.EVENT_DB, eventId, 1),
    ).resolves.toEqual({ notModified: true, revision: 1 });
    await expect(
      readProfileEventPrizesIfChanged(testEnv.EVENT_DB, profileId, 1),
    ).resolves.toEqual({ notModified: true, revision: 1 });
    await expect(
      readEventSnapshotIfChanged(testEnv.EVENT_DB, eventId, 0),
    ).rejects.toThrow("invalid-event-record");
    await expect(
      readProfileEventPrizesIfChanged(testEnv.EVENT_DB, profileId, 0),
    ).rejects.toThrow("invalid-event-prize-assignment");
    await expect(readEventSnapshot(testEnv.EVENT_DB, eventId)).rejects.toThrow(
      "invalid-event-record",
    );
    await expect(listEventAggregates(testEnv.EVENT_DB)).rejects.toThrow(
      "invalid-event-record",
    );
    await expect(
      readProfileEventPrizes(testEnv.EVENT_DB, profileId),
    ).rejects.toThrow("invalid-event-prize-assignment");
  });

  it("rejects unsafe stored revisions instead of returning unchanged", async () => {
    await patchEventOwnedPaths(testEnv.EVENT_DB, {
      [`events/${eventId}`]: eventRecord(),
      [`profileEventPrizes/${profileId}/${eventId}`]: assignment(),
    });
    await testEnv.EVENT_DB.batch([
      testEnv.EVENT_DB.prepare(
        "UPDATE event_records SET revision = 9007199254740992 WHERE event_id = ?",
      ).bind(eventId),
      testEnv.EVENT_DB.prepare(
        "UPDATE profile_event_prize_revisions SET revision = 9007199254740992 WHERE profile_id = ?",
      ).bind(profileId),
    ]);
    await expect(
      readEventSnapshotIfChanged(testEnv.EVENT_DB, eventId, 1),
    ).rejects.toThrow("invalid-event-integer");
    await expect(
      readProfileEventPrizesIfChanged(testEnv.EVENT_DB, profileId, 1),
    ).rejects.toThrow("invalid-event-integer");
  });

  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid known revision %s before querying",
    async (knownRevision) => {
      const { db, batches } = observeSnapshotReads();
      await expect(
        readEventSnapshotIfChanged(db, eventId, knownRevision),
      ).rejects.toThrow("invalid-event-integer");
      await expect(
        readProfileEventPrizesIfChanged(db, profileId, knownRevision),
      ).rejects.toThrow("invalid-event-integer");
      expect(batches).toEqual([]);
    },
  );

  it("returns empty typed reads for missing records and rejects invalid IDs", async () => {
    await expect(readEvent(testEnv.EVENT_DB, eventId)).resolves.toBeNull();
    await expect(listEventAggregates(testEnv.EVENT_DB)).resolves.toEqual({});
    await expect(
      readEventPrizeSelections(testEnv.EVENT_DB, eventId),
    ).resolves.toEqual({});
    await expect(
      readProfileEventPrizeAssignment(testEnv.EVENT_DB, profileId, eventId),
    ).resolves.toBeNull();
    await expect(
      listProfileEventPrizeAssignments(testEnv.EVENT_DB, profileId),
    ).resolves.toEqual({});

    for (const invalidId of ["", "has/slash", " padded", "has#hash"]) {
      await expect(readEvent(testEnv.EVENT_DB, invalidId)).rejects.toThrow(
        "invalid-event-id",
      );
      await expect(
        readEventPrizeSelections(testEnv.EVENT_DB, invalidId),
      ).rejects.toThrow("invalid-event-id");
      await expect(
        readProfileEventPrizeAssignment(testEnv.EVENT_DB, invalidId, eventId),
      ).rejects.toThrow("invalid-profile-id");
      await expect(
        readProfileEventPrizeAssignment(testEnv.EVENT_DB, profileId, invalidId),
      ).rejects.toThrow("invalid-event-id");
      await expect(
        listProfileEventPrizeAssignments(testEnv.EVENT_DB, invalidId),
      ).rejects.toThrow("invalid-profile-id");
    }
  });

  it("validates narrow event reads independently from prize selections", async () => {
    await patchEventOwnedPaths(testEnv.EVENT_DB, {
      [`events/${eventId}`]: eventRecord(),
      [`eventPrizeSelections/${eventId}/${profileId}`]: prizeId,
    });
    await testEnv.EVENT_DB.prepare(
      "UPDATE event_prize_selections SET prize_id = ? WHERE event_id = ?",
    )
      .bind("invalid#prize", eventId)
      .run();
    await expect(readEvent(testEnv.EVENT_DB, eventId)).resolves.toEqual(
      eventRecord(),
    );
    await expect(listEventAggregates(testEnv.EVENT_DB)).resolves.toEqual({
      [eventId]: eventRecord(),
    });
    await expect(
      readEventPrizeSelections(testEnv.EVENT_DB, eventId),
    ).rejects.toThrow("invalid-event-prize-selection");
    await expect(readEventSnapshot(testEnv.EVENT_DB, eventId)).rejects.toThrow(
      "invalid-event-prize-selection",
    );

    await testEnv.EVENT_DB.batch([
      testEnv.EVENT_DB.prepare(
        "UPDATE event_prize_selections SET prize_id = ? WHERE event_id = ?",
      ).bind(prizeId, eventId),
      testEnv.EVENT_DB.prepare(
        "UPDATE event_records SET status = 'active' WHERE event_id = ?",
      ).bind(eventId),
    ]);
    await expect(readEvent(testEnv.EVENT_DB, eventId)).rejects.toThrow(
      "event-row-mismatch",
    );
    await expect(listEventAggregates(testEnv.EVENT_DB)).rejects.toThrow(
      "event-row-mismatch",
    );
    await expect(
      readEventPrizeSelections(testEnv.EVENT_DB, eventId),
    ).resolves.toEqual({ [profileId]: prizeId });
    await expect(readEventSnapshot(testEnv.EVENT_DB, eventId)).rejects.toThrow(
      "event-row-mismatch",
    );
  });

  it("reads one assignment without validating unrelated profile prizes", async () => {
    const otherEventId = "other-event";
    await patchEventOwnedPaths(testEnv.EVENT_DB, {
      [`events/${eventId}`]: eventRecord(),
      [`events/${otherEventId}`]: eventRecord({ eventId: otherEventId }),
      [`profileEventPrizes/${profileId}/${eventId}`]: assignment(),
    });
    await testEnv.EVENT_DB.prepare(
      `INSERT INTO profile_event_prizes (
         profile_id, event_id, assignment_json, updated_at_ms
       ) VALUES (?, ?, ?, ?)`,
    )
      .bind(profileId, otherEventId, JSON.stringify(assignment()), 2_000)
      .run();

    await expect(
      readProfileEventPrizeAssignment(testEnv.EVENT_DB, profileId, eventId),
    ).resolves.toEqual(assignment());
    await expect(
      readProfileEventPrizeAssignment(
        testEnv.EVENT_DB,
        profileId,
        otherEventId,
      ),
    ).rejects.toThrow("invalid-event-prize-assignment");
    await expect(
      readProfileEventPrizes(testEnv.EVENT_DB, profileId),
    ).rejects.toThrow("invalid-event-prize-assignment");
    await expect(
      listProfileEventPrizeAssignments(testEnv.EVENT_DB, profileId, {
        limit: 1,
      }),
    ).resolves.toEqual({ [eventId]: assignment() });
    await expect(
      listProfileEventPrizeAssignments(testEnv.EVENT_DB, profileId, {
        startAt: otherEventId,
        limit: 1,
      }),
    ).rejects.toThrow("invalid-event-prize-assignment");
  });

  it("preserves inclusive lexical prize pagination and the default limit", async () => {
    const eventIds = [
      "prize-a",
      "prize-B",
      "prize-b",
      ...Array.from(
        { length: 100 },
        (_, index) => `prize-c-${String(index).padStart(3, "0")}`,
      ),
    ];
    const expectedOrder = [...eventIds].sort();
    await patchEventOwnedPaths(
      testEnv.EVENT_DB,
      Object.fromEntries(
        eventIds.map((id) => [`events/${id}`, eventRecord({ eventId: id })]),
      ),
    );
    await testEnv.EVENT_DB.batch(
      eventIds.map((id) =>
        testEnv.EVENT_DB.prepare(
          `INSERT INTO profile_event_prizes (
             profile_id, event_id, assignment_json, updated_at_ms
           ) VALUES (?, ?, ?, ?)`,
        ).bind(
          profileId,
          id,
          JSON.stringify({ ...assignment(), eventId: id }),
          2_000,
        ),
      ),
    );
    expect(
      Object.keys(
        await listProfileEventPrizeAssignments(testEnv.EVENT_DB, profileId),
      ),
    ).toEqual(expectedOrder.slice(0, 100));
    expect(
      Object.keys(
        await listProfileEventPrizeAssignments(testEnv.EVENT_DB, profileId, {
          startAt: "prize-a",
          limit: 1,
        }),
      ),
    ).toEqual(["prize-a"]);
    expect(
      Object.keys(
        await listProfileEventPrizeAssignments(testEnv.EVENT_DB, profileId, {
          limit: 0,
        }),
      ),
    ).toEqual(expectedOrder.slice(0, 100));
    expect(
      Object.keys(
        await listProfileEventPrizeAssignments(testEnv.EVENT_DB, profileId, {
          startAt: "prize-c-095",
          limit: 3,
        }),
      ),
    ).toEqual(["prize-c-095", "prize-c-096", "prize-c-097"]);
    await expect(
      listProfileEventPrizeAssignments(testEnv.EVENT_DB, profileId, {
        startAt: "prize-c-095-extra",
        limit: 1,
      }),
    ).resolves.toEqual({
      "prize-c-096": { ...assignment(), eventId: "prize-c-096" },
    });
    await expect(
      listProfileEventPrizeAssignments(testEnv.EVENT_DB, profileId, {
        startAt: "prize-z",
      }),
    ).resolves.toEqual({});
    for (const limit of [-1, 1.5, Infinity]) {
      await expect(
        listProfileEventPrizeAssignments(testEnv.EVENT_DB, profileId, {
          limit,
        }),
      ).rejects.toThrow("invalid-event-integer");
    }
  });

  it.each(["", "prize-"])(
    "preserves Unicode prize recovery pagination with prefix %j",
    async (prefix) => {
      const emojiId = `${prefix}😀`;
      const eventIds = [
        ...Array.from(
          { length: 21 },
          (_, index) => `${prefix}\uE000${String(index).padStart(2, "0")}`,
        ),
        emojiId,
      ];
      const expectedOrder = [...eventIds].sort();
      await patchEventOwnedPaths(
        testEnv.EVENT_DB,
        Object.fromEntries(
          eventIds.map((id) => [`events/${id}`, eventRecord({ eventId: id })]),
        ),
      );
      await testEnv.EVENT_DB.batch(
        eventIds.map((id) =>
          testEnv.EVENT_DB.prepare(
            `INSERT INTO profile_event_prizes (
               profile_id, event_id, assignment_json, updated_at_ms
             ) VALUES (?, ?, ?, ?)`,
          ).bind(
            profileId,
            id,
            JSON.stringify({ ...assignment(), eventId: id }),
            2_000,
          ),
        ),
      );

      const copied: string[] = [];
      let cursor = "";
      let complete = false;
      for (let attempt = 0; attempt < 3 && !complete; attempt += 1) {
        const source = await listProfileEventPrizeAssignments(
          testEnv.EVENT_DB,
          profileId,
          { startAt: cursor, limit: cursor ? 22 : 21 },
        );
        const remaining = Object.keys(source)
          .filter((id) => id > cursor)
          .sort();
        const page = remaining.slice(0, 20);
        copied.push(...page);
        complete = remaining.length <= page.length;
        cursor = page.at(-1) || cursor;
      }
      expect(complete).toBe(true);
      expect(copied).toEqual(expectedOrder);

      expect(
        Object.keys(
          await listProfileEventPrizeAssignments(testEnv.EVENT_DB, profileId, {
            startAt: emojiId,
            limit: 3,
          }),
        ),
      ).toEqual(expectedOrder.slice(0, 3));
      await testEnv.EVENT_DB.prepare(
        "DELETE FROM profile_event_prizes WHERE profile_id = ? AND event_id = ?",
      )
        .bind(profileId, emojiId)
        .run();
      expect(
        Object.keys(
          await listProfileEventPrizeAssignments(testEnv.EVENT_DB, profileId, {
            startAt: emojiId,
            limit: 3,
          }),
        ),
      ).toEqual(expectedOrder.slice(1, 4));
    },
  );

  it("keeps typed reads available while writes are frozen without admissions", async () => {
    await patchEventOwnedPaths(testEnv.EVENT_DB, {
      [`events/${eventId}`]: eventRecord(),
      [`eventPrizeSelections/${eventId}/${profileId}`]: prizeId,
      [`profileEventPrizes/${profileId}/${eventId}`]: assignment(),
    });
    await transitionEventStorageMode(testEnv.EVENT_DB, {
      expected: { storageMode: "d1" },
      next: { storageMode: "frozen" },
      nowMs: 300,
    });
    try {
      const session = testEnv.EVENT_DB.withSession("first-primary");
      await expect(readEvent(session, eventId)).resolves.toEqual(eventRecord());
      await expect(readEventPrizeSelections(session, eventId)).resolves.toEqual(
        {
          [profileId]: prizeId,
        },
      );
      await expect(
        readProfileEventPrizeAssignment(session, profileId, eventId),
      ).resolves.toEqual(assignment());
      await expect(readEventSnapshot(session, eventId)).resolves.toMatchObject({
        event: eventRecord(),
        revision: 1,
      });
      await expect(readProfileEventPrizes(session, profileId)).resolves.toEqual(
        {
          profileId,
          prizes: { [eventId]: assignment() },
          revision: 1,
        },
      );
      await expect(
        listProfileEventPrizeAssignments(session, profileId),
      ).resolves.toEqual({ [eventId]: assignment() });
      expect(session.getBookmark()).toBeTypeOf("string");
      expect(
        await testEnv.EVENT_DB.prepare(
          "SELECT COUNT(*) AS count FROM event_write_admissions",
        ).first<number>("count"),
      ).toBe(0);
    } finally {
      await transitionEventStorageMode(testEnv.EVENT_DB, {
        expected: { storageMode: "frozen" },
        next: { storageMode: "d1" },
        nowMs: 400,
      });
    }
  });

  it("rejects malformed aggregates without stripping unknown JSON fields", () => {
    expect(validateEventAggregate(eventId, eventRecord())).toEqual(
      eventRecord(),
    );
    expect(() =>
      validateEventAggregate(eventId, {
        ...eventRecord(),
        eventId: "other-event",
      }),
    ).toThrow(EventD1Failure);
    expect(() =>
      validateEventAggregate(eventId, {
        ...eventRecord(),
        updatedAtMs: Number.NaN,
      }),
    ).toThrow(EventD1Failure);
  });

  it("guards event revisions across path mutations and transactions", async () => {
    await patchEventOwnedPaths(testEnv.EVENT_DB, {
      [`events/${eventId}`]: eventRecord(),
    });
    await patchEventOwnedPaths(
      testEnv.EVENT_DB,
      { [`events/${eventId}/status`]: "active" },
      { expectedEventRevisions: { [eventId]: 1 } },
    );
    await expect(
      patchEventOwnedPaths(
        testEnv.EVENT_DB,
        { [`events/${eventId}/status`]: "ended" },
        { expectedEventRevisions: { [eventId]: 1 } },
      ),
    ).rejects.toBeInstanceOf(EventD1Conflict);
    const toggled = await transactEventOwnedPath(
      testEnv.EVENT_DB,
      `eventPrizeSelections/${eventId}/${profileId}`,
      (current) => ({ value: current === prizeId ? null : prizeId }),
      { now: () => 300 },
    );
    expect(toggled).toMatchObject({ committed: true, value: prizeId });
    await expect(
      readEventSnapshot(testEnv.EVENT_DB, eventId),
    ).resolves.toMatchObject({
      prizeSelections: { [profileId]: prizeId },
      revision: 3,
    });
  });

  it("does not commit a transaction aborted after its read", async () => {
    await patchEventOwnedPaths(testEnv.EVENT_DB, {
      [`events/${eventId}`]: eventRecord(),
    });
    const controller = new AbortController();
    await expect(
      transactEventOwnedPath(
        testEnv.EVENT_DB,
        `events/${eventId}/status`,
        () => {
          controller.abort();
          return { value: "active" };
        },
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    await expect(
      readEventSnapshot(testEnv.EVENT_DB, eventId),
    ).resolves.toMatchObject({
      event: { status: "scheduled" },
      revision: 1,
    });
  });

  it.each([
    ["events", ""],
    ["events", "/unknownFutureField"],
    ["eventPrizeSelections", ""],
    ["eventPrizeSelections", `/${profileId}`],
  ])("reuses the snapshot for %s%s transactions", async (root, suffix) => {
    await seedPrizeRows();
    let reads = 0;
    const batches: number[] = [];
    const db: EventD1Connection = {
      prepare(query) {
        if (/^\s*SELECT\b/i.test(query)) reads += 1;
        return testEnv.EVENT_DB.prepare(query);
      },
      batch(statements) {
        batches.push(statements.length);
        return testEnv.EVENT_DB.batch(statements);
      },
    };
    await transactEventOwnedPath(
      db,
      `${root}/${eventId}${suffix}`,
      (current) => {
        if (root === "events") {
          const value = current as Record<string, unknown>;
          value.transactionValue = { retained: [1, 2, 3] };
          return { value };
        }
        if (suffix) return { value: "1514" };
        const value = current as Record<string, string>;
        value[profileId] = "1514";
        delete value["profile-two"];
        return { value };
      },
    );
    expect(reads).toBe(2);
    expect(batches).toEqual([2, expect.any(Number)]);
    const stored = await readEventSnapshot(testEnv.EVENT_DB, eventId);
    expect(stored.revision).toBe(2);
    if (root === "events") {
      const value = suffix ? stored.event!.unknownFutureField : stored.event;
      expect(value).toMatchObject({
        transactionValue: { retained: [1, 2, 3] },
      });
      expect(stored.prizeSelections).toEqual({
        [profileId]: prizeId,
        "profile-two": "1111",
      });
    } else {
      expect(stored.prizeSelections).toEqual({
        [profileId]: "1514",
        ...(suffix ? { "profile-two": "1111" } : {}),
      });
    }
  });

  describe("outbox transaction snapshots", () => {
    type SnapshotKind = "progress" | "state" | "generation";

    async function seed(kind: SnapshotKind, present = true) {
      const plan = await buildEventProgressPlan(
        {
          eventId,
          sourceKey: "transaction-snapshot:test",
          reason: "sunday-mons-reminder",
          runAtMs: 1_000,
        },
        100,
      );
      const path =
        kind === "progress"
          ? `eventProgressOutbox/${plan.outboxId}`
          : `${kind === "state" ? "eventTelegramProjections" : "eventTelegramProjectionGenerations"}/${eventId}`;
      await patchEventOwnedPaths(testEnv.EVENT_DB, {
        [`events/${eventId}`]: eventRecord(),
        ...(present
          ? kind === "progress"
            ? { [path]: plan.outbox }
            : {
                [`eventTelegramProjections/${eventId}`]: { retained: true },
                [`eventTelegramProjectionGenerations/${eventId}`]: 3,
              }
          : {}),
      });
      return { ...plan, path };
    }

    function observe(
      kind: SnapshotKind,
      beforeBatch?: (attempt: number) => Promise<void>,
    ) {
      const observed = observeD1FailureDatabase(testEnv.EVENT_DB, {
        beforeBatch,
      });
      let reads = 0;
      const table =
        kind === "progress"
          ? "event_progress_outboxes"
          : "event_telegram_projection_state";
      const db: EventD1Connection = {
        prepare(query) {
          if (/^\s*SELECT\b/i.test(query) && query.includes(`FROM ${table}`))
            reads += 1;
          return observed.database.prepare(query);
        },
        batch: (statements) => observed.database.batch(statements),
      };
      return {
        ...observed,
        db,
        get reads() {
          return reads;
        },
      };
    }

    it.each([
      ["progress", "missing"],
      ["progress", "existing"],
      ["progress", "delete"],
      ["state", "missing"],
      ["state", "existing"],
      ["state", "delete"],
      ["generation", "missing"],
      ["generation", "existing"],
    ] as const)(
      "uses one read and one batch for a %s transaction with a %s row",
      async (kind, mode) => {
        const { path, outbox } = await seed(kind, mode !== "missing");
        const observed = observe(kind);
        const next =
          mode === "delete"
            ? null
            : kind === "progress"
              ? { ...outbox, lastQueuedAtMs: 200 }
              : kind === "state"
                ? { updated: true }
                : 4;
        await expect(
          transactEventOwnedPath(observed.db, path, () => ({ value: next })),
        ).resolves.toMatchObject({ committed: true, value: next });
        expect(observed.reads).toBe(1);
        expect(observed.batches).toHaveLength(1);
        if (kind === "progress") {
          expect(await readEventOwnedPath(testEnv.EVENT_DB, path)).toEqual(
            next,
          );
        } else {
          expect(
            await readEventTelegramProjectionState(testEnv.EVENT_DB, eventId),
          ).toEqual(
            mode === "delete"
              ? null
              : {
                  generation:
                    kind === "generation" ? 4 : mode === "missing" ? 0 : 3,
                  revision: mode === "missing" ? 1 : 2,
                  state:
                    kind === "state"
                      ? next
                      : mode === "missing"
                        ? {}
                        : { retained: true },
                },
          );
        }
      },
    );

    it.each(["state", "generation"] as const)(
      "refreshes the complete Telegram snapshot after a concurrent %s transaction write",
      async (kind) => {
        const { path } = await seed(kind);
        const observed = observe(kind, async (attempt) => {
          if (attempt !== 1) return;
          await patchEventOwnedPaths(testEnv.EVENT_DB, {
            [`eventTelegramProjections/${eventId}`]: { concurrent: true },
            [`eventTelegramProjectionGenerations/${eventId}`]: 8,
          });
        });
        const inputs: unknown[] = [];
        await transactEventOwnedPath(observed.db, path, (current) => {
          inputs.push(structuredClone(current));
          if (kind === "generation") return { value: Number(current) + 1 };
          const value = current as Record<string, unknown>;
          value.updated = true;
          return { value };
        });
        expect(inputs).toEqual(
          kind === "state"
            ? [{ retained: true }, { concurrent: true }]
            : [3, 8],
        );
        expect(observed.reads).toBe(2);
        expect(observed.batches).toHaveLength(2);
        expect(
          await readEventTelegramProjectionState(testEnv.EVENT_DB, eventId),
        ).toEqual({
          generation: kind === "state" ? 8 : 9,
          revision: 3,
          state:
            kind === "state"
              ? { concurrent: true, updated: true }
              : { concurrent: true },
        });
      },
    );

    it.each([
      ["progress", "insert"],
      ["progress", "delete"],
      ["state", "insert"],
      ["state", "delete"],
      ["generation", "insert"],
      ["generation", "delete"],
    ] as const)(
      "refreshes a %s transaction after a concurrent %s",
      async (kind, race) => {
        const { path, outboxId, outbox } = await seed(kind, race === "delete");
        const inserted = {
          ...outbox,
          firstQueuedAtMs: 50,
          lastQueuedAtMs: 200,
        };
        const observed = observe(kind, async (attempt) => {
          if (attempt !== 1) return;
          if (race === "insert") {
            await patchEventOwnedPaths(
              testEnv.EVENT_DB,
              kind === "progress"
                ? { [path]: inserted }
                : {
                    [`eventTelegramProjections/${eventId}`]: {
                      concurrent: true,
                    },
                    [`eventTelegramProjectionGenerations/${eventId}`]: 8,
                  },
            );
          } else {
            await testEnv.EVENT_DB.prepare(
              kind === "progress"
                ? "DELETE FROM event_progress_outboxes WHERE outbox_id = ? AND status = 'pending'"
                : "DELETE FROM event_telegram_projection_state WHERE event_id = ?",
            )
              .bind(kind === "progress" ? outboxId : eventId)
              .run();
          }
        });
        const inputs: unknown[] = [];
        await transactEventOwnedPath(observed.db, path, (current) => {
          inputs.push(structuredClone(current));
          return {
            value:
              kind === "generation"
                ? Number(current) + 1
                : kind === "state"
                  ? {
                      ...(current as Record<string, unknown> | null),
                      updated: true,
                    }
                  : { ...outbox, firstQueuedAtMs: 400, lastQueuedAtMs: 300 },
          };
        });
        expect(observed.reads).toBe(2);
        expect(observed.batches).toHaveLength(2);
        if (kind === "progress") {
          expect(inputs).toEqual(
            race === "insert" ? [null, inserted] : [outbox, null],
          );
          expect(await readEventOwnedPath(testEnv.EVENT_DB, path)).toEqual({
            ...outbox,
            firstQueuedAtMs: race === "insert" ? 50 : 400,
            lastQueuedAtMs: 300,
          });
          expect(
            await readEventOwnedPath(
              testEnv.EVENT_DB,
              `eventProgressOutboxDead/${outboxId}`,
            ),
          ).toBeNull();
        } else {
          expect(inputs).toEqual(
            kind === "generation"
              ? race === "insert"
                ? [0, 8]
                : [3, 0]
              : race === "insert"
                ? [null, { concurrent: true }]
                : [{ retained: true }, null],
          );
          expect(
            await readEventTelegramProjectionState(testEnv.EVENT_DB, eventId),
          ).toEqual({
            generation:
              (race === "insert" ? 8 : 0) + (kind === "generation" ? 1 : 0),
            revision: race === "insert" ? 2 : 1,
            state: {
              ...(race === "insert" ? { concurrent: true } : {}),
              ...(kind === "state" ? { updated: true } : {}),
            },
          });
        }
      },
    );

    it("retries progress transactions with the latest raw snapshot and quarantines only the replaced record", async () => {
      const { path, outboxId, outbox } = await seed("progress");
      const raced = { ...outbox, schemaVersion: 2, concurrent: true };
      const observed = observe("progress", async (attempt) => {
        if (attempt !== 1) return;
        await testEnv.EVENT_DB.prepare(
          "UPDATE event_progress_outboxes SET record_json = ? WHERE outbox_id = ? AND status = 'pending'",
        )
          .bind(JSON.stringify(raced, null, 2), outboxId)
          .run();
      });
      const inputs: unknown[] = [];
      await transactEventOwnedPath(observed.db, path, (current) => {
        inputs.push(structuredClone(current));
        return { value: { ...outbox, lastQueuedAtMs: 200 } };
      });
      expect(inputs).toEqual([outbox, raced]);
      expect(observed.reads).toBe(2);
      expect(observed.batches).toHaveLength(2);
      expect(await readEventOwnedPath(testEnv.EVENT_DB, path)).toEqual({
        ...outbox,
        lastQueuedAtMs: 200,
      });
      expect(
        await readEventOwnedPath(
          testEnv.EVENT_DB,
          `eventProgressOutboxDead/${outboxId}`,
        ),
      ).toMatchObject({
        reason: "invalid-event-progress-outbox",
        originalRecord: raced,
      });
    });

    it("keeps raw progress JSON and the earliest timestamp independent of in-place updater mutations", async () => {
      const { path, outboxId, outbox } = await seed("progress");
      const storedJson = JSON.stringify(outbox, null, 2).replace(
        '"firstQueuedAtMs": 100',
        '"firstQueuedAtMs": 1e2',
      );
      await testEnv.EVENT_DB.prepare(
        "UPDATE event_progress_outboxes SET record_json = ? WHERE outbox_id = ? AND status = 'pending'",
      )
        .bind(storedJson, outboxId)
        .run();
      const observed = observe("progress");
      await transactEventOwnedPath(observed.db, path, (current) => {
        const value = current as Record<string, unknown>;
        value.firstQueuedAtMs = 200;
        value.lastQueuedAtMs = 300;
        return { value };
      });
      expect(observed.reads).toBe(1);
      expect(observed.batches).toHaveLength(1);
      expect(await readEventOwnedPath(testEnv.EVENT_DB, path)).toEqual({
        ...outbox,
        lastQueuedAtMs: 300,
      });
      expect(
        await readEventOwnedPath(
          testEnv.EVENT_DB,
          `eventProgressOutboxDead/${outboxId}`,
        ),
      ).toBeNull();
    });

    it("distinguishes raw JSON null from an absent progress snapshot", async () => {
      const { outboxId, path } = await seed("progress", false);
      const observed = observe("progress");
      await withD1Admission(async (admission) => {
        const commit = (recordJson: string | null) =>
          commitEventMutationsInternal(
            observed.db,
            [{ kind: "progress-outbox", outboxId, value: null }],
            { admission, progressOutboxSnapshot: { outboxId, recordJson } },
          );
        await expect(commit("null")).rejects.toBeInstanceOf(EventD1Conflict);
        await expect(commit(null)).resolves.toEqual({
          eventRevisions: {},
          profilePrizeRevisions: {},
        });
      });
      expect(observed.reads).toBe(0);
      expect(observed.batches).toHaveLength(2);
      expect(await readEventOwnedPath(testEnv.EVENT_DB, path)).toBeNull();
    });

    it.each(["progress", "state", "generation"] as const)(
      "does not write a declined or aborted %s transaction",
      async (kind) => {
        const { path } = await seed(kind);
        const before = await readEventOwnedPath(testEnv.EVENT_DB, path);
        const observed = observe(kind);
        await expect(
          transactEventOwnedPath(observed.db, path, (current) => {
            if (typeof current === "object" && current !== null)
              (current as Record<string, unknown>).discarded = true;
            return { commit: false };
          }),
        ).resolves.toMatchObject({ committed: false });
        const controller = new AbortController();
        await expect(
          transactEventOwnedPath(
            observed.db,
            path,
            (current) => {
              controller.abort();
              return { value: current };
            },
            { signal: controller.signal },
          ),
        ).rejects.toMatchObject({ name: "AbortError" });
        expect(observed.reads).toBe(2);
        expect(observed.batches).toHaveLength(0);
        expect(await readEventOwnedPath(testEnv.EVENT_DB, path)).toEqual(
          before,
        );
      },
    );

    it.each(["progress", "state", "generation"] as const)(
      "bounds exhausted %s snapshot conflicts without applying the transaction",
      async (kind) => {
        const { path, outboxId, outbox } = await seed(kind);
        const observed = observe(kind, async (attempt) => {
          if (kind === "progress") {
            await testEnv.EVENT_DB.prepare(
              "UPDATE event_progress_outboxes SET record_json = ? WHERE outbox_id = ? AND status = 'pending'",
            )
              .bind(JSON.stringify({ ...outbox, attempt }), outboxId)
              .run();
          } else {
            await patchEventOwnedPaths(testEnv.EVENT_DB, {
              [`eventTelegramProjectionGenerations/${eventId}`]: attempt + 3,
            });
          }
        });
        await expect(
          transactEventOwnedPath(observed.db, path, (current) => ({
            value:
              kind === "generation"
                ? 100
                : { ...(current as Record<string, unknown>), discarded: true },
          })),
        ).rejects.toBeInstanceOf(EventD1Conflict);
        expect(observed.reads).toBe(12);
        expect(observed.batches).toHaveLength(12);
        if (kind === "progress") {
          expect(await readEventOwnedPath(testEnv.EVENT_DB, path)).toEqual({
            ...outbox,
            attempt: 12,
          });
          expect(
            await readEventOwnedPath(
              testEnv.EVENT_DB,
              `eventProgressOutboxDead/${outboxId}`,
            ),
          ).toBeNull();
        } else {
          expect(
            await readEventTelegramProjectionState(testEnv.EVENT_DB, eventId),
          ).toEqual({
            generation: 15,
            revision: 13,
            state: { retained: true },
          });
        }
      },
    );
  });

  it.each(["events", "eventPrizeSelections"])(
    "distinguishes declining %s transactions from unchanged commits",
    async (root) => {
      await seedPrizeRows();
      const before = await readPrizeStorage();
      const path = `${root}/${eventId}`;
      await expect(
        transactEventOwnedPath(testEnv.EVENT_DB, path, (current) => {
          (current as Record<string, unknown>).discarded = "1514";
          return { commit: false };
        }),
      ).resolves.toMatchObject({ committed: false });
      expect(await readPrizeStorage()).toEqual(before);
      await expect(
        transactEventOwnedPath(testEnv.EVENT_DB, path, (current) => ({
          value: current,
        })),
      ).resolves.toMatchObject({ committed: true });
      const after = await readPrizeStorage();
      expect(after.selections).toEqual(before.selections);
      expect(after.prizes).toEqual(before.prizes);
      expect(after.events.find((row) => row.event_id === eventId)).toEqual({
        ...before.events.find((row) => row.event_id === eventId),
        revision: 2,
      });
    },
  );

  it.each(["events", "eventPrizeSelections"])(
    "refreshes the %s snapshot after a concurrent sibling write",
    async (root) => {
      await seedPrizeRows();
      const observed: unknown[] = [];
      let changeSibling = false;
      const db: EventD1Connection = {
        prepare: (query) => testEnv.EVENT_DB.prepare(query),
        async batch(statements) {
          if (changeSibling) {
            changeSibling = false;
            await patchEventOwnedPaths(
              testEnv.EVENT_DB,
              root === "events"
                ? {
                    [`events/${eventId}`]: {
                      ...(await readEventSnapshot(testEnv.EVENT_DB, eventId))
                        .event,
                      sibling: { retained: true },
                    },
                  }
                : { [`eventPrizeSelections/${eventId}/sibling`]: "1111" },
            );
          }
          return testEnv.EVENT_DB.batch(statements);
        },
      };
      await transactEventOwnedPath(db, `${root}/${eventId}`, (current) => {
        const value = current as Record<string, unknown>;
        observed.push(value.sibling);
        changeSibling = observed.length === 1;
        value.transactionValue =
          root === "events" ? { retained: true } : "1514";
        return { value };
      });
      const sibling = root === "events" ? { retained: true } : "1111";
      expect(observed).toEqual([undefined, sibling]);
      const stored = await readEventSnapshot(testEnv.EVENT_DB, eventId);
      expect(stored.revision).toBe(3);
      expect(
        root === "events" ? stored.event : stored.prizeSelections,
      ).toMatchObject({
        sibling,
        transactionValue: root === "events" ? { retained: true } : "1514",
      });
    },
  );

  it.each(["events", "eventPrizeSelections"])(
    "preserves an intent attached after a %s transaction read",
    async (root) => {
      await seedPrizeRows();
      const before = await readEventSnapshot(testEnv.EVENT_DB, eventId);
      const intent = {
        schemaVersion: 1 as const,
        transitionId: "transition-attached-after-read",
        eventId,
        expectedRevision: before.revision,
        rtdbEffects: { "invites/pending": { eventId } },
        canonicalUpdates: { [`events/${eventId}/status`]: "active" },
        createdAtMs: 200,
        updatedAtMs: 200,
      };
      let attachIntent = false;
      let attached = false;
      const db: EventD1Connection = {
        prepare: (query) => testEnv.EVENT_DB.prepare(query),
        async batch(statements) {
          if (attachIntent && !attached) {
            attached = true;
            await createEventTransitionIntent(testEnv.EVENT_DB, intent);
          }
          return testEnv.EVENT_DB.batch(statements);
        },
      };
      await expect(
        transactEventOwnedPath(db, `${root}/${eventId}`, (current) => {
          attachIntent = true;
          const value = current as Record<string, unknown>;
          value.transactionValue = root === "events" ? true : "1514";
          return { value };
        }),
      ).rejects.toThrow("event-transition-pending");
      expect(attached).toBe(true);
      expect(await readEventSnapshot(testEnv.EVENT_DB, eventId)).toEqual(
        before,
      );
      expect(await listPendingEventTransitionIntents(testEnv.EVENT_DB)).toEqual(
        [{ ...intent, attempts: 0 }],
      );
      expect(
        await testEnv.EVENT_DB.prepare(
          "SELECT pending_transition_id FROM event_records WHERE event_id = ?",
        )
          .bind(eventId)
          .first("pending_transition_id"),
      ).toBe(intent.transitionId);
    },
  );

  describe("targeted profile prize mutation reads", () => {
    it("groups repeated leaf updates and leaves malformed unrelated history untouched", async () => {
      const { otherEventId } = await seedPrizeRows();
      const malformedEventId = "malformed-prize-event";
      await patchEventOwnedPaths(testEnv.EVENT_DB, {
        [`events/${malformedEventId}`]: eventRecord({
          eventId: malformedEventId,
        }),
      });
      await testEnv.EVENT_DB.prepare(
        `INSERT INTO profile_event_prizes (
           profile_id, event_id, assignment_json, updated_at_ms
         ) VALUES (?, ?, '{}', 200)`,
      )
        .bind(profileId, malformedEventId)
        .run();
      const before = await readPrizeStorage();
      const observed = observePrizeMutationBatches();
      const changed = { ...assignment(), assignedAtMs: 4_000 };
      const otherProfileId = "profile-two";
      const result = await withD1Admission((admission) =>
        commitEventMutations(
          observed.database,
          [
            {
              kind: "profile-prize",
              profileId,
              eventId,
              value: { ...assignment(), assignedAtMs: 3_000 },
            },
            {
              kind: "profile-prize",
              profileId: otherProfileId,
              eventId,
              value: assignment(otherProfileId),
            },
            {
              kind: "profile-prize",
              profileId,
              eventId: otherEventId,
              value: null,
            },
            { kind: "profile-prize", profileId, eventId, value: changed },
          ],
          { admission, now: () => 300 },
        ),
      );
      expect(result.profilePrizeRevisions).toEqual({
        [profileId]: 2,
        [otherProfileId]: 1,
      });
      expect(observed.readBatches).toHaveLength(1);
      expect(observed.readBatches[0].statements).toHaveLength(2);
      expect(observed.readBatches[0].results[0].results).toHaveLength(2);
      expect(observed.writeBatches).toHaveLength(1);
      const after = await readPrizeStorage();
      expect(
        after.prizes.find((row) => row.event_id === malformedEventId),
      ).toEqual(before.prizes.find((row) => row.event_id === malformedEventId));
      expect(after.prizes.some((row) => row.event_id === otherEventId)).toBe(
        false,
      );
      await expect(
        readProfileEventPrizeAssignment(testEnv.EVENT_DB, profileId, eventId),
      ).resolves.toEqual(changed);
    });

    it("keeps targeted reads indexed and bounded as unrelated prize history grows", async () => {
      await seedPrizeRows();
      const requested = new Map([[profileId, new Set([eventId])]]);
      const baseline = observePrizeMutationBatches();
      const expected = new Map([
        [
          profileId,
          {
            profileId,
            revision: 1,
            prizes: { [eventId]: assignment() },
          },
        ],
      ]);
      await expect(
        readProfilePrizeMutationSnapshots(baseline.database, requested),
      ).resolves.toEqual(expected);
      const baselineRowsRead =
        baseline.readBatches[0].results[0].meta.rows_read;
      expect(baselineRowsRead).toBeGreaterThan(0);
      await testEnv.EVENT_DB.batch([
        testEnv.EVENT_DB.prepare(
          `WITH RECURSIVE entries(n) AS (
             SELECT 1 UNION ALL SELECT n + 1 FROM entries WHERE n < 512
           )
           INSERT INTO event_records (
             event_id, status, start_at_ms, updated_at_ms, revision, record_json
           )
           SELECT 'prize-history-' || n, status, start_at_ms, updated_at_ms, 1,
                  json_set(record_json, '$.eventId', 'prize-history-' || n)
           FROM entries CROSS JOIN event_records WHERE event_id = ?`,
        ).bind(eventId),
        testEnv.EVENT_DB.prepare(
          `INSERT INTO profile_event_prizes (
             profile_id, event_id, assignment_json, updated_at_ms
           )
           SELECT ?, event_id, '{}', updated_at_ms FROM event_records
           WHERE event_id LIKE 'prize-history-%'`,
        ).bind(profileId),
      ]);
      const observed = observePrizeMutationBatches();
      await expect(
        readProfilePrizeMutationSnapshots(observed.database, requested),
      ).resolves.toEqual(expected);
      expect(observed.readBatches).toHaveLength(1);
      expect(
        observed.readBatches[0].results[0].meta.rows_read,
      ).toBeLessThanOrEqual(baselineRowsRead);
      const read = observed.readBatches[0].statements[0];
      const plan = await testEnv.EVENT_DB.prepare(
        `EXPLAIN QUERY PLAN ${read.query}`,
      )
        .bind(...read.values)
        .all<{ detail: string }>();
      expect(
        plan.results.some(({ detail }) =>
          /SEARCH .+ USING PRIMARY KEY \(profile_id=\? AND event_id=\?\)/.test(
            detail,
          ),
        ),
      ).toBe(true);
    });

    it.each([
      { hasAssignment: false, hasRevision: false },
      { hasAssignment: false, hasRevision: true },
      { hasAssignment: true, hasRevision: false },
      { hasAssignment: true, hasRevision: true },
    ])(
      "retains missing-row semantics for $hasAssignment assignments and $hasRevision revisions",
      async ({ hasAssignment, hasRevision }) => {
        await patchEventOwnedPaths(testEnv.EVENT_DB, {
          [`events/${eventId}`]: eventRecord(),
        });
        if (hasAssignment) {
          await testEnv.EVENT_DB.prepare(
            `INSERT INTO profile_event_prizes (
             profile_id, event_id, assignment_json, updated_at_ms
           ) VALUES (?, ?, ?, 200)`,
          )
            .bind(profileId, eventId, JSON.stringify(assignment()))
            .run();
        }
        if (hasRevision) {
          await testEnv.EVENT_DB.prepare(
            `INSERT INTO profile_event_prize_revisions (
             profile_id, revision, updated_at_ms
           ) VALUES (?, 7, 200)`,
          )
            .bind(profileId)
            .run();
        }
        const snapshots = await readProfilePrizeMutationSnapshots(
          testEnv.EVENT_DB,
          new Map([[profileId, new Set([eventId, "absent-event"])]]),
        );
        expect(snapshots.get(profileId)).toEqual({
          profileId,
          revision: hasRevision ? 7 : 0,
          prizes: hasAssignment ? { [eventId]: assignment() } : {},
        });
      },
    );

    it("rejects malformed touched assignments and unsafe revisions", async () => {
      await seedPrizeRows();
      const requested = new Map([[profileId, new Set([eventId])]]);
      await testEnv.EVENT_DB.prepare(
        "UPDATE profile_event_prizes SET assignment_json = '{}' WHERE profile_id = ? AND event_id = ?",
      )
        .bind(profileId, eventId)
        .run();
      await expect(
        readProfilePrizeMutationSnapshots(testEnv.EVENT_DB, requested),
      ).rejects.toThrow("invalid-event-prize-assignment");
      await testEnv.EVENT_DB.batch([
        testEnv.EVENT_DB.prepare(
          "UPDATE profile_event_prizes SET assignment_json = ? WHERE profile_id = ? AND event_id = ?",
        ).bind(JSON.stringify(assignment()), profileId, eventId),
        testEnv.EVENT_DB.prepare(
          "UPDATE profile_event_prize_revisions SET revision = 9007199254740992 WHERE profile_id = ?",
        ).bind(profileId),
      ]);
      await expect(
        readProfilePrizeMutationSnapshots(testEnv.EVENT_DB, requested),
      ).rejects.toThrow("invalid-event-integer");
    });

    it("chunks 41 profiles without splitting scattered mutations for one profile", async () => {
      const { otherEventId } = await seedPrizeRows();
      const observed = observePrizeMutationBatches();
      const changes: EventMutation[] = [
        { kind: "profile-prize", profileId, eventId, value: null },
        ...Array.from({ length: 40 }, (_, index): EventMutation => ({
          kind: "profile-prize",
          profileId: `batch-profile-${index}`,
          eventId,
          value: null,
        })),
        {
          kind: "profile-prize",
          profileId,
          eventId: otherEventId,
          value: null,
        },
        { kind: "profile-prize", profileId, eventId, value: null },
      ];
      const result = await withD1Admission((admission) =>
        commitEventMutations(observed.database, changes, {
          admission,
          now: () => 300,
        }),
      );
      expect(
        observed.readBatches.map(({ statements }) => statements.length),
      ).toEqual([40, 1]);
      expect(observed.readBatches[0].results[0].results).toHaveLength(2);
      expect(observed.writeBatches).toHaveLength(1);
      expect(Object.keys(result.profilePrizeRevisions)).toHaveLength(41);
      expect(result.profilePrizeRevisions[profileId]).toBe(2);
      const stored = await readPrizeStorage();
      expect(stored.prizes).toEqual([]);
      expect(
        stored.profileRevisions.find((row) => row.profile_id === profileId),
      ).toEqual({
        profile_id: profileId,
        revision: 2,
        updated_at_ms: 300,
      });
    });

    it("rejects the entire plan when a sibling changes between read batches", async () => {
      const { otherEventId, otherAssignment } = await seedPrizeRows();
      const changedSibling = { ...otherAssignment, assignedAtMs: 4_000 };
      let afterRace: Awaited<ReturnType<typeof readPrizeStorage>> | undefined;
      const observed = observePrizeMutationBatches(async (count) => {
        if (count !== 1) return;
        await patchEventOwnedPaths(
          testEnv.EVENT_DB,
          {
            [`profileEventPrizes/${profileId}/${otherEventId}`]: changedSibling,
          },
          { now: () => 300 },
        );
        afterRace = await readPrizeStorage();
      });
      const changes: EventMutation[] = [
        { kind: "profile-prize", profileId, eventId, value: null },
        ...Array.from({ length: 40 }, (_, index): EventMutation => ({
          kind: "profile-prize",
          profileId: `race-profile-${index}`,
          eventId,
          value: assignment(`race-profile-${index}`),
        })),
      ];
      await expect(
        withD1Admission((admission) =>
          commitEventMutations(observed.database, changes, {
            admission,
            now: () => 400,
          }),
        ),
      ).rejects.toBeInstanceOf(EventD1Conflict);
      expect(
        observed.readBatches.map(({ statements }) => statements.length),
      ).toEqual([40, 1]);
      expect(observed.writeBatches).toHaveLength(1);
      expect(afterRace).toBeDefined();
      expect(await readPrizeStorage()).toEqual(afterRace);
    });

    it("preserves Unicode keys and the full-read fallback for lone surrogates", async () => {
      const { otherEventId } = await seedPrizeRows();
      const unicodeEventId = "历史-😀";
      await patchEventOwnedPaths(testEnv.EVENT_DB, {
        [`events/${unicodeEventId}`]: eventRecord({ eventId: unicodeEventId }),
      });
      await testEnv.EVENT_DB.prepare(
        `INSERT INTO profile_event_prizes (
           profile_id, event_id, assignment_json, updated_at_ms
         ) VALUES (?, ?, ?, 200)`,
      )
        .bind(
          profileId,
          unicodeEventId,
          JSON.stringify({
            ...assignment(),
            eventId: unicodeEventId,
          }),
        )
        .run();
      const targeted = observePrizeMutationBatches();
      await patchEventOwnedPaths(targeted.database, {
        [`profileEventPrizes/${profileId}/${unicodeEventId}`]: null,
      });
      expect(targeted.readBatches).toHaveLength(1);
      expect(targeted.readBatches[0].statements).toHaveLength(1);
      await expect(
        readProfileEventPrizeAssignment(
          testEnv.EVENT_DB,
          profileId,
          unicodeEventId,
        ),
      ).resolves.toBeNull();
      await testEnv.EVENT_DB.prepare(
        "UPDATE profile_event_prizes SET assignment_json = '{}' WHERE profile_id = ? AND event_id = ?",
      )
        .bind(profileId, otherEventId)
        .run();
      const before = await readPrizeStorage();
      const fallback = observePrizeMutationBatches();
      await expect(
        withD1Admission((admission) =>
          commitEventMutations(
            fallback.database,
            [
              {
                kind: "profile-prize",
                profileId,
                eventId: "\ud800",
                value: null,
              },
            ],
            { admission },
          ),
        ),
      ).rejects.toThrow("invalid-event-prize-assignment");
      expect(fallback.readBatches).toHaveLength(1);
      expect(fallback.readBatches[0].statements).toHaveLength(2);
      expect(fallback.writeBatches).toHaveLength(0);
      expect(await readPrizeStorage()).toEqual(before);
    });
  });

  it("transacts one profile prize in one read despite a malformed sibling", async () => {
    const { otherEventId, otherAssignment } = await seedPrizeRows();
    await testEnv.EVENT_DB.prepare(
      "UPDATE profile_event_prizes SET assignment_json = ? WHERE profile_id = ? AND event_id = ?",
    )
      .bind(
        JSON.stringify(
          { ...otherAssignment, eventId: "mismatched-event" },
          null,
          2,
        ),
        profileId,
        otherEventId,
      )
      .run();
    const before = await readPrizeStorage();
    await expect(
      readProfileEventPrizes(testEnv.EVENT_DB, profileId),
    ).rejects.toThrow("invalid-event-prize-assignment");
    let reads = 0;
    const db: EventD1Connection = {
      prepare(query) {
        if (/^\s*SELECT\b/i.test(query)) reads += 1;
        return testEnv.EVENT_DB.prepare(query);
      },
      batch: (statements) => testEnv.EVENT_DB.batch(statements),
    };
    const changed = { ...assignment(), assignedAtMs: 3_000 };
    await expect(
      transactEventOwnedPath(
        db,
        `profileEventPrizes/${profileId}/${eventId}`,
        (current) => {
          expect(current).toEqual(assignment());
          return { value: changed };
        },
        { now: () => 300 },
      ),
    ).resolves.toMatchObject({ committed: true, value: changed });
    expect(reads).toBe(1);
    const after = await readPrizeStorage();
    expect(after.prizes.find((row) => row.event_id === otherEventId)).toEqual(
      before.prizes.find((row) => row.event_id === otherEventId),
    );
    expect(after.prizes.find((row) => row.event_id === eventId)).toMatchObject({
      assignment_json: JSON.stringify(changed),
      updated_at_ms: 300,
    });
    expect(after.profileRevisions).toEqual([
      { profile_id: profileId, revision: 2, updated_at_ms: 300 },
    ]);
    expect(after.events).toEqual(before.events);
  });

  it("persists mutations made directly to a profile prize transaction value", async () => {
    const { otherEventId, otherAssignment } = await seedPrizeRows();
    const changed = {
      ...otherAssignment,
      assignedAtMs: 3_000,
      archivedMetadata: { edition: 1, labels: ["first", "second", "third"] },
    };
    const result = await transactEventOwnedPath(
      testEnv.EVENT_DB,
      `profileEventPrizes/${profileId}/${otherEventId}`,
      (current) => {
        const prize = current as typeof otherAssignment;
        prize.assignedAtMs = 3_000;
        prize.archivedMetadata.labels.push("third");
        return { value: prize };
      },
      { now: () => 300 },
    );
    expect(result).toMatchObject({
      committed: true,
      value: changed,
    });
    const stored = await readPrizeStorage();
    expect(
      stored.prizes.find((row) => row.event_id === otherEventId),
    ).toMatchObject({
      assignment_json: JSON.stringify(changed),
      updated_at_ms: 300,
    });
    expect(stored.profileRevisions).toEqual([
      { profile_id: profileId, revision: 2, updated_at_ms: 300 },
    ]);
  });

  it("distinguishes declining a profile prize transaction from committing unchanged bytes", async () => {
    const { otherEventId, otherAssignment } = await seedPrizeRows();
    const before = await readPrizeStorage();
    const path = `profileEventPrizes/${profileId}/${otherEventId}`;
    await expect(
      transactEventOwnedPath(
        testEnv.EVENT_DB,
        path,
        () => ({ commit: false, decision: "already-assigned" }),
        { now: () => 300 },
      ),
    ).resolves.toEqual({
      committed: false,
      decision: "already-assigned",
      value: otherAssignment,
    });
    expect(await readPrizeStorage()).toEqual(before);
    await expect(
      transactEventOwnedPath(
        testEnv.EVENT_DB,
        path,
        (current) => ({ value: current }),
        { now: () => 400 },
      ),
    ).resolves.toMatchObject({ committed: true, value: otherAssignment });
    expect(await readPrizeStorage()).toEqual({
      ...before,
      profileRevisions: [
        { profile_id: profileId, revision: 2, updated_at_ms: 400 },
      ],
    });
  });

  it.each(["creation", "absent deletion"])(
    "starts the profile prize revision at one after a leaf %s",
    async (operation) => {
      await patchEventOwnedPaths(testEnv.EVENT_DB, {
        [`events/${eventId}`]: eventRecord(),
      });
      const before = await readPrizeStorage();
      const value = operation === "creation" ? assignment() : null;
      await expect(
        transactEventOwnedPath(
          testEnv.EVENT_DB,
          `profileEventPrizes/${profileId}/${eventId}`,
          (current) => {
            expect(current).toBeNull();
            return { value };
          },
          { now: () => 300 },
        ),
      ).resolves.toMatchObject({ committed: true, value });
      expect(await readPrizeStorage()).toEqual({
        ...before,
        prizes: value
          ? [
              {
                profile_id: profileId,
                event_id: eventId,
                assignment_json: JSON.stringify(value),
                updated_at_ms: 300,
              },
            ]
          : [],
        profileRevisions: [
          { profile_id: profileId, revision: 1, updated_at_ms: 300 },
        ],
      });
    },
  );

  it("retries a profile prize transaction when a sibling changes before commit", async () => {
    const { otherEventId, otherAssignment } = await seedPrizeRows();
    const sibling = { ...otherAssignment, assignedAtMs: 4_000 };
    const observed: unknown[] = [];
    let changeSibling = false;
    const db: EventD1Connection = {
      prepare: (query) => testEnv.EVENT_DB.prepare(query),
      async batch(statements) {
        if (changeSibling) {
          changeSibling = false;
          await patchEventOwnedPaths(
            testEnv.EVENT_DB,
            { [`profileEventPrizes/${profileId}/${otherEventId}`]: sibling },
            { now: () => 300 },
          );
        }
        return testEnv.EVENT_DB.batch(statements);
      },
    };
    const changed = { ...assignment(), assignedAtMs: 3_000 };
    await expect(
      transactEventOwnedPath(
        db,
        `profileEventPrizes/${profileId}/${eventId}`,
        (current) => {
          observed.push(current);
          changeSibling = observed.length === 1;
          return { value: changed };
        },
        { now: () => 400 },
      ),
    ).resolves.toMatchObject({ committed: true, value: changed });
    expect(observed).toEqual([assignment(), assignment()]);
    await expect(
      readProfileEventPrizes(testEnv.EVENT_DB, profileId),
    ).resolves.toEqual({
      prizes: { [eventId]: changed, [otherEventId]: sibling },
      profileId,
      revision: 3,
    });
    expect((await readPrizeStorage()).profileRevisions).toEqual([
      { profile_id: profileId, revision: 3, updated_at_ms: 400 },
    ]);
  });

  it("does not write a profile prize transaction aborted in its updater", async () => {
    await seedPrizeRows();
    const before = await readPrizeStorage();
    const controller = new AbortController();
    await expect(
      transactEventOwnedPath(
        testEnv.EVENT_DB,
        `profileEventPrizes/${profileId}/${eventId}`,
        () => {
          controller.abort();
          return { value: { ...assignment(), assignedAtMs: 3_000 } };
        },
        { now: () => 300, signal: controller.signal },
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(await readPrizeStorage()).toEqual(before);
  });

  it("keeps visible profile prizes separate from historical event assignments", async () => {
    await patchEventOwnedPaths(testEnv.EVENT_DB, {
      [`events/${eventId}`]: eventRecord({
        status: "ended",
        prizeAssignments: { "1": assignment() },
      }),
      [`profileEventPrizes/${profileId}/${eventId}`]: assignment(),
    });
    expect(await readProfileEventPrizes(testEnv.EVENT_DB, profileId)).toEqual({
      prizes: { [eventId]: assignment() },
      profileId,
      revision: 1,
    });
    await patchEventOwnedPaths(testEnv.EVENT_DB, {
      [`profileEventPrizes/${profileId}/${eventId}`]: null,
    });
    expect(await readProfileEventPrizes(testEnv.EVENT_DB, profileId)).toEqual({
      prizes: {},
      profileId,
      revision: 2,
    });
    const snapshot = await readEventSnapshot(testEnv.EVENT_DB, eventId);
    expect(snapshot.event?.prizeAssignments).toEqual({ "1": assignment() });
  });

  it("changes individual prize rows without rewriting their neighbors", async () => {
    const { otherEventId } = await seedPrizeRows();
    const before = await readPrizeStorage();
    const changedAssignment = {
      ...assignment(),
      assignedAtMs: 3_000,
      futureMetadata: { nested: ["retained", { enabled: true }] },
    };
    const result = await patchEventOwnedPaths(
      testEnv.EVENT_DB,
      {
        [`eventPrizeSelections/${eventId}/${profileId}`]: "1514",
        [`eventPrizeSelections/${eventId}/profile-three`]: prizeId,
        [`profileEventPrizes/${profileId}/${eventId}`]: changedAssignment,
      },
      { now: () => 300 },
    );
    const after = await readPrizeStorage();
    expect(result).toEqual({
      eventRevisions: { [eventId]: 2 },
      profilePrizeRevisions: { [profileId]: 2 },
    });
    expect(after.selections).toEqual([
      {
        event_id: eventId,
        profile_id: profileId,
        prize_id: "1514",
        updated_at_ms: 300,
      },
      {
        event_id: eventId,
        profile_id: "profile-three",
        prize_id: prizeId,
        updated_at_ms: 300,
      },
      before.selections.find((row) => row.profile_id === "profile-two"),
    ]);
    expect(after.prizes.find((row) => row.event_id === otherEventId)).toEqual(
      before.prizes.find((row) => row.event_id === otherEventId),
    );
    expect(after.prizes.find((row) => row.event_id === eventId)).toEqual({
      profile_id: profileId,
      event_id: eventId,
      assignment_json: JSON.stringify(changedAssignment),
      updated_at_ms: 300,
    });
    await patchEventOwnedPaths(
      testEnv.EVENT_DB,
      {
        [`eventPrizeSelections/${eventId}/profile-three`]: null,
        [`profileEventPrizes/${profileId}/${eventId}`]: null,
      },
      { now: () => 400 },
    );
    const deleted = await readPrizeStorage();
    expect(deleted.selections).toEqual(
      after.selections.filter((row) => row.profile_id !== "profile-three"),
    );
    expect(deleted.prizes).toEqual(
      before.prizes.filter((row) => row.event_id === otherEventId),
    );
  });

  it.each([true, false])(
    "preserves collection replacement order and clears prize rows (root first: %s)",
    async (rootFirst) => {
      const { otherEventId, otherAssignment } = await seedPrizeRows();
      const before = await readPrizeStorage();
      const addedEventId = "VOxalSrexcA";
      const addedAssignment = {
        ...assignment(),
        eventId: addedEventId,
        prizeId: "282",
      };
      await patchEventOwnedPaths(testEnv.EVENT_DB, {
        [`events/${addedEventId}`]: eventRecord({ eventId: addedEventId }),
      });
      const roots = {
        [`eventPrizeSelections/${eventId}`]: {
          [profileId]: prizeId,
          "profile-three": "1514",
        },
        [`profileEventPrizes/${profileId}`]: {
          [eventId]: assignment(),
          [addedEventId]: addedAssignment,
        },
      };
      const children = {
        [`eventPrizeSelections/${eventId}/profile-two`]: "1111",
        [`profileEventPrizes/${profileId}/${otherEventId}`]: otherAssignment,
      };
      await patchEventOwnedPaths(
        testEnv.EVENT_DB,
        rootFirst ? { ...roots, ...children } : { ...children, ...roots },
        { now: () => 300 },
      );
      const after = await readPrizeStorage();
      expect(after.selections).toEqual([
        before.selections.find((row) => row.profile_id === profileId),
        {
          event_id: eventId,
          profile_id: "profile-three",
          prize_id: "1514",
          updated_at_ms: 300,
        },
        ...(rootFirst
          ? [before.selections.find((row) => row.profile_id === "profile-two")]
          : []),
      ]);
      expect(after.prizes).toEqual([
        ...(rootFirst
          ? [before.prizes.find((row) => row.event_id === otherEventId)]
          : []),
        before.prizes.find((row) => row.event_id === eventId),
        {
          profile_id: profileId,
          event_id: addedEventId,
          assignment_json: JSON.stringify(addedAssignment),
          updated_at_ms: 300,
        },
      ]);
      const cleared = await patchEventOwnedPaths(
        testEnv.EVENT_DB,
        {
          [`eventPrizeSelections/${eventId}`]: null,
          [`profileEventPrizes/${profileId}`]: null,
        },
        { now: () => 400 },
      );
      expect(cleared).toEqual({
        eventRevisions: { [eventId]: 3 },
        profilePrizeRevisions: { [profileId]: 3 },
      });
      const empty = await readPrizeStorage();
      expect(empty.selections).toEqual([]);
      expect(empty.prizes).toEqual([]);
    },
  );

  it("advances aggregate revisions for no-ops without changing prize rows", async () => {
    const { otherEventId, otherAssignment } = await seedPrizeRows();
    const before = await readPrizeStorage();
    const reorderedAssignment = {
      archivedMetadata: { labels: ["first", "second"], edition: 1 },
      assignedAtMs: otherAssignment.assignedAtMs,
      prizeId: otherAssignment.prizeId,
      place: otherAssignment.place,
      profileId,
      eventId: otherEventId,
    };
    const selections = { [profileId]: prizeId, "profile-two": "1111" };
    const prizes = {
      [eventId]: assignment(),
      [otherEventId]: reorderedAssignment,
    };
    const updates = [
      {
        [`eventPrizeSelections/${eventId}/${profileId}`]: prizeId,
        [`profileEventPrizes/${profileId}/${eventId}`]: assignment(),
      },
      {
        [`eventPrizeSelections/${eventId}`]: selections,
        [`profileEventPrizes/${profileId}`]: prizes,
      },
      {
        [`eventPrizeSelections/${eventId}/missing-profile`]: null,
        [`profileEventPrizes/${profileId}/missing-event`]: null,
      },
      {
        [`eventPrizeSelections/${eventId}`]: {
          ...selections,
          [profileId]: "1514",
        },
        [`eventPrizeSelections/${eventId}/${profileId}`]: prizeId,
        [`profileEventPrizes/${profileId}`]: {
          ...prizes,
          [eventId]: { ...assignment(), assignedAtMs: 4_000 },
        },
        [`profileEventPrizes/${profileId}/${eventId}`]: assignment(),
      },
    ];
    for (const [index, update] of updates.entries()) {
      const nowMs = 300 + index;
      const revision = index + 2;
      expect(
        await patchEventOwnedPaths(testEnv.EVENT_DB, update, {
          now: () => nowMs,
        }),
      ).toEqual({
        eventRevisions: { [eventId]: revision },
        profilePrizeRevisions: { [profileId]: revision },
      });
      const after = await readPrizeStorage();
      expect(after.selections).toEqual(before.selections);
      expect(after.prizes).toEqual(before.prizes);
      expect(after.profileRevisions).toEqual([
        { profile_id: profileId, revision, updated_at_ms: nowMs },
      ]);
      expect(after.events.find((row) => row.event_id === eventId)).toEqual({
        ...before.events.find((row) => row.event_id === eventId),
        revision,
      });
    }
    const changed = {
      ...otherAssignment,
      archivedMetadata: { edition: 1, labels: ["second", "first"] },
    };
    await patchEventOwnedPaths(
      testEnv.EVENT_DB,
      { [`profileEventPrizes/${profileId}/${otherEventId}`]: changed },
      { now: () => 500 },
    );
    expect(
      (await readPrizeStorage()).prizes.find(
        (row) => row.event_id === otherEventId,
      ),
    ).toMatchObject({
      assignment_json: JSON.stringify(changed),
      updated_at_ms: 500,
    });
  });

  it("retains historical prize bytes while rejecting resubmitted retired prizes", async () => {
    const { otherEventId, otherAssignment } = await seedPrizeRows();
    const retiredAssignment = { ...otherAssignment, prizeId: "retired-prize" };
    await testEnv.EVENT_DB.batch([
      testEnv.EVENT_DB.prepare(
        "UPDATE event_prize_selections SET prize_id = ? WHERE event_id = ? AND profile_id = ?",
      ).bind("retired-prize", eventId, "profile-two"),
      testEnv.EVENT_DB.prepare(
        "UPDATE profile_event_prizes SET assignment_json = ? WHERE profile_id = ? AND event_id = ?",
      ).bind(
        JSON.stringify(retiredAssignment, null, 2),
        profileId,
        otherEventId,
      ),
    ]);
    const before = await readPrizeStorage();
    await patchEventOwnedPaths(
      testEnv.EVENT_DB,
      {
        [`eventPrizeSelections/${eventId}/${profileId}`]: "1514",
        [`profileEventPrizes/${profileId}/${eventId}`]: {
          ...assignment(),
          assignedAtMs: 3_000,
        },
      },
      { now: () => 300 },
    );
    const updated = await readPrizeStorage();
    expect(
      updated.selections.find((row) => row.profile_id === "profile-two"),
    ).toEqual(
      before.selections.find((row) => row.profile_id === "profile-two"),
    );
    expect(updated.prizes.find((row) => row.event_id === otherEventId)).toEqual(
      before.prizes.find((row) => row.event_id === otherEventId),
    );
    for (const invalid of [
      { [`eventPrizeSelections/${eventId}/profile-two`]: "retired-prize" },
      {
        [`eventPrizeSelections/${eventId}`]: {
          [profileId]: "1514",
          "profile-two": "retired-prize",
        },
      },
      {
        [`profileEventPrizes/${profileId}/${otherEventId}`]: retiredAssignment,
      },
      {
        [`profileEventPrizes/${profileId}`]: {
          [eventId]: { ...assignment(), assignedAtMs: 3_000 },
          [otherEventId]: retiredAssignment,
        },
      },
    ]) {
      await expect(
        patchEventOwnedPaths(testEnv.EVENT_DB, invalid, { now: () => 400 }),
      ).rejects.toBeInstanceOf(EventD1Failure);
      expect(await readPrizeStorage()).toEqual(updated);
    }
  });

  it.each([
    "event revision",
    "profile revision",
    "expired admission",
    "SQL failure",
  ])(
    "keeps prize changes, revisions, and outboxes atomic after %s",
    async (failure) => {
      const { otherEventId } = await seedPrizeRows();
      const before = await readPrizeStorage();
      await withD1Admission(async (active) => {
        const admission =
          failure === "expired admission"
            ? await acquireEventWriteAdmission(testEnv.EVENT_DB, {
                nowMs: 1,
                ttlMs: 1,
              })
            : active;
        try {
          await expect(
            patchEventOwnedPathsRaw(
              testEnv.EVENT_DB,
              {
                [`eventPrizeSelections/${eventId}/${profileId}`]: "1514",
                [`eventPrizeSelections/${eventId}/profile-two`]: null,
                [`profileEventPrizes/${profileId}/${eventId}`]: {
                  ...assignment(),
                  assignedAtMs: 3_000,
                },
                [`profileEventPrizes/${profileId}/${otherEventId}`]: null,
                "eventProgressOutbox/atomic-prizes": {
                  schemaVersion: 1,
                  eventId:
                    failure === "SQL failure" ? "missing-event" : eventId,
                  runAtMs: 1_000,
                  lastQueuedAtMs: 300,
                },
              },
              {
                admission,
                now: () => 300,
                ...(failure === "event revision"
                  ? { expectedEventRevisions: { [eventId]: 0 } }
                  : {}),
                ...(failure === "profile revision"
                  ? { expectedProfilePrizeRevisions: { [profileId]: 0 } }
                  : {}),
              },
            ),
          ).rejects.toThrow(
            failure === "expired admission"
              ? "event-write-admission-invalid"
              : failure === "SQL failure"
                ? "event-d1-integrity"
                : "event-d1-conflict",
          );
        } finally {
          if (admission !== active) {
            await releaseEventWriteAdmission(testEnv.EVENT_DB, admission);
          }
        }
      });
      expect(await readPrizeStorage()).toEqual(before);
    },
  );

  it("reads retired prize IDs without accepting them in new writes", async () => {
    const retiredPrizeId = "retired-prize";
    const retiredAssignment = {
      ...assignment(),
      prizeId: retiredPrizeId,
      archivedMetadata: { edition: 1 },
    };
    await patchEventOwnedPaths(testEnv.EVENT_DB, {
      [`events/${eventId}`]: eventRecord({ status: "ended" }),
    });
    await testEnv.EVENT_DB.batch([
      testEnv.EVENT_DB.prepare(
        `INSERT INTO event_prize_selections (
           event_id, profile_id, prize_id, updated_at_ms
         ) VALUES (?, ?, ?, ?)`,
      ).bind(eventId, profileId, retiredPrizeId, 2_000),
      testEnv.EVENT_DB.prepare(
        `INSERT INTO profile_event_prizes (
           profile_id, event_id, assignment_json, updated_at_ms
         ) VALUES (?, ?, ?, ?)`,
      ).bind(profileId, eventId, JSON.stringify(retiredAssignment), 2_000),
      testEnv.EVENT_DB.prepare(
        `INSERT INTO profile_event_prize_revisions (
           profile_id, revision, updated_at_ms
         ) VALUES (?, ?, ?)`,
      ).bind(profileId, 1, 2_000),
    ]);

    await expect(
      readEventSnapshot(testEnv.EVENT_DB, eventId),
    ).resolves.toMatchObject({
      prizeSelections: { [profileId]: retiredPrizeId },
    });
    await expect(
      readProfileEventPrizes(testEnv.EVENT_DB, profileId),
    ).resolves.toEqual({
      prizes: { [eventId]: retiredAssignment },
      profileId,
      revision: 1,
    });
    await expect(
      readEventPrizeSelections(testEnv.EVENT_DB, eventId),
    ).resolves.toEqual({ [profileId]: retiredPrizeId });
    await expect(
      readProfileEventPrizeAssignment(testEnv.EVENT_DB, profileId, eventId),
    ).resolves.toEqual(retiredAssignment);

    await expect(
      patchEventOwnedPaths(testEnv.EVENT_DB, {
        [`eventPrizeSelections/${eventId}/profile-two`]: retiredPrizeId,
      }),
    ).rejects.toThrow("invalid-event-prize-selection");
    await expect(
      patchEventOwnedPaths(testEnv.EVENT_DB, {
        [`profileEventPrizes/profile-two/${eventId}`]: {
          ...retiredAssignment,
          profileId: "profile-two",
        },
      }),
    ).rejects.toThrow("invalid-event-prize-assignment");
  });

  it("rejects generic event deletion and advances revisions for direct cascades", async () => {
    await patchEventOwnedPaths(testEnv.EVENT_DB, {
      [`events/${eventId}`]: eventRecord({ status: "ended" }),
      [`profileEventPrizes/${profileId}/${eventId}`]: assignment(),
    });
    await expect(
      patchEventOwnedPaths(testEnv.EVENT_DB, {
        [`events/${eventId}`]: null,
      }),
    ).rejects.toThrow("event-deletion-unsupported");
    await testEnv.EVENT_DB.prepare(
      "DELETE FROM event_records WHERE event_id = ?",
    )
      .bind(eventId)
      .run();
    await expect(
      readProfileEventPrizes(testEnv.EVENT_DB, profileId),
    ).resolves.toEqual({ prizes: {}, profileId, revision: 2 });
  });

  it("freezes and resumes active D1 storage", async () => {
    const before = await readEventRuntimeControl(testEnv.EVENT_DB);
    const frozen = await transitionEventStorageMode(testEnv.EVENT_DB, {
      expected: { storageMode: "d1" },
      next: { storageMode: "frozen" },
      nowMs: 40,
    });
    expect(frozen).toMatchObject({
      storageMode: "frozen",
      freezeGeneration: before.freezeGeneration + 1,
    });
    await transitionEventStorageMode(testEnv.EVENT_DB, {
      expected: { storageMode: "frozen" },
      next: { storageMode: "d1" },
      nowMs: 50,
    });
  });

  it("serializes storage freezes with durable write admissions", async () => {
    const admission = await acquireEventWriteAdmission(testEnv.EVENT_DB, {
      admissionId: "admission-one",
      nowMs: 75,
      ttlMs: 1,
    });
    expect(admission.freezeGeneration).toBe(
      (await readEventRuntimeControl(testEnv.EVENT_DB)).freezeGeneration,
    );
    await expect(
      transitionEventStorageMode(testEnv.EVENT_DB, {
        expected: { storageMode: "d1" },
        next: { storageMode: "frozen" },
        nowMs: 100,
      }),
    ).rejects.toThrow();
    await releaseEventWriteAdmission(testEnv.EVENT_DB, admission);
    await expect(
      patchEventOwnedPathsRaw(
        testEnv.EVENT_DB,
        { [`events/${eventId}`]: eventRecord() },
        { admission },
      ),
    ).rejects.toThrow("event-write-admission-invalid");
    await expect(
      readEventSnapshot(testEnv.EVENT_DB, eventId),
    ).resolves.toMatchObject({ event: null, revision: 0 });
    await transitionEventStorageMode(testEnv.EVENT_DB, {
      expected: { storageMode: "d1" },
      next: { storageMode: "frozen" },
      nowMs: 101,
    });
    await expect(
      acquireEventWriteAdmission(testEnv.EVENT_DB, {
        admissionId: "admission-two",
        nowMs: 102,
      }),
    ).rejects.toThrow("event-writes-disabled");
    await transitionEventStorageMode(testEnv.EVENT_DB, {
      expected: { storageMode: "frozen" },
      next: { storageMode: "d1" },
      nowMs: 103,
    });
  });

  it("rejects expired admissions and mismatched freeze generations", async () => {
    const expired = await acquireEventWriteAdmission(testEnv.EVENT_DB, {
      nowMs: 1,
      ttlMs: 1,
    });
    const active = await acquireEventWriteAdmission(testEnv.EVENT_DB);
    try {
      for (const admission of [
        expired,
        { ...active, freezeGeneration: active.freezeGeneration + 1 },
      ]) {
        await expect(
          patchEventOwnedPathsRaw(
            testEnv.EVENT_DB,
            {
              [`events/${eventId}`]: eventRecord(),
            },
            { admission },
          ),
        ).rejects.toThrow("event-write-admission-invalid");
      }
      await expect(
        readEventSnapshot(testEnv.EVENT_DB, eventId),
      ).resolves.toMatchObject({ event: null, revision: 0 });
    } finally {
      await releaseEventWriteAdmission(testEnv.EVENT_DB, expired);
      await releaseEventWriteAdmission(testEnv.EVENT_DB, active);
    }
  });

  it("persists and atomically publishes deterministic transition intents", async () => {
    await patchEventOwnedPaths(testEnv.EVENT_DB, {
      [`events/${eventId}`]: eventRecord(),
    });
    const intent = {
      schemaVersion: 1 as const,
      transitionId: "transition-one",
      eventId,
      expectedRevision: 1,
      rtdbEffects: { [`invites/invite-one`]: { eventId } },
      canonicalUpdates: { [`events/${eventId}/status`]: "active" },
      createdAtMs: 200,
      updatedAtMs: 200,
    };
    await createEventTransitionIntent(testEnv.EVENT_DB, intent);
    await createEventTransitionIntent(testEnv.EVENT_DB, intent);
    expect(await listPendingEventTransitionIntents(testEnv.EVENT_DB)).toEqual([
      { ...intent, attempts: 0 },
    ]);
    await patchEventOwnedPaths(testEnv.EVENT_DB, intent.canonicalUpdates, {
      expectedEventRevisions: { [eventId]: 1 },
      transition: { eventId, transitionId: intent.transitionId },
    });
    expect(await listPendingEventTransitionIntents(testEnv.EVENT_DB)).toEqual(
      [],
    );
    expect(await readEventSnapshot(testEnv.EVENT_DB, eventId)).toMatchObject({
      revision: 2,
      event: { status: "active" },
    });
  });

  it("keeps pending transition intents attached and fences unrelated writes", async () => {
    await patchEventOwnedPaths(testEnv.EVENT_DB, {
      [`events/${eventId}`]: eventRecord(),
    });
    const intent = {
      schemaVersion: 1 as const,
      transitionId: "transition-pending",
      eventId,
      expectedRevision: 1,
      rtdbEffects: { "invites/pending": { eventId } },
      canonicalUpdates: { [`events/${eventId}/status`]: "active" },
      createdAtMs: 200,
      updatedAtMs: 200,
    };
    await createEventTransitionIntent(testEnv.EVENT_DB, intent);

    await expect(
      testEnv.EVENT_DB.prepare(
        "DELETE FROM event_transition_intents WHERE transition_id = ?",
      )
        .bind(intent.transitionId)
        .run(),
    ).rejects.toThrow("event transition is still attached");
    await expect(
      patchEventOwnedPaths(testEnv.EVENT_DB, {
        [`events/${eventId}/updatedAtMs`]: 300,
      }),
    ).rejects.toThrow("event-transition-pending");
    expect(await listPendingEventTransitionIntents(testEnv.EVENT_DB)).toEqual([
      { ...intent, attempts: 0 },
    ]);
    expect(await readEventSnapshot(testEnv.EVENT_DB, eventId)).toMatchObject({
      event: { status: "scheduled", updatedAtMs: 100 },
      revision: 1,
    });
    expect(
      await testEnv.EVENT_DB.prepare(
        "SELECT pending_transition_id FROM event_records WHERE event_id = ?",
      )
        .bind(eventId)
        .first<string>("pending_transition_id"),
    ).toBe(intent.transitionId);
  });

  it.each(["success", "Telegram revision race", "late SQL failure"] as const)(
    "commits all event mutation families atomically: %s",
    async (outcome) => {
      const { outboxId, outbox: progress } = await buildEventProgressPlan(
        {
          eventId,
          sourceKey: "mixed-family:test",
          reason: "match-rating-updated",
        },
        100,
      );
      const profileOutbox = {
        schemaVersion: 1,
        status: "pending",
        requestId: "profile-before",
        lastQueuedAtMs: 100,
      };
      const telegramOutbox = {
        schemaVersion: 1,
        status: "pending",
        requestId: "telegram-before",
        firstQueuedAtMs: 100,
        updatedAtMs: 100,
      };
      await patchEventOwnedPaths(
        testEnv.EVENT_DB,
        {
          [`events/${eventId}`]: eventRecord(),
          [`eventPrizeSelections/${eventId}/${profileId}`]: prizeId,
          [`profileEventPrizes/${profileId}/${eventId}`]: assignment(),
          [`eventProgressOutbox/${outboxId}`]: progress,
          [`profileGameProjectionOutbox/event/${eventId}`]: profileOutbox,
          [`telegramProjectionOutbox/event/${eventId}`]: telegramOutbox,
          [`eventTelegramProjectionGenerations/${eventId}`]: 1,
          [`eventTelegramProjections/${eventId}`]: { version: "before" },
        },
        { now: () => 100 },
      );
      const malformedProgress = { ...progress, schemaVersion: 2 };
      await testEnv.EVENT_DB.prepare(
        "UPDATE event_progress_outboxes SET record_json = ? WHERE outbox_id = ? AND status = 'pending'",
      )
        .bind(JSON.stringify(malformedProgress), outboxId)
        .run();
      const nextProgress = { ...progress, lastQueuedAtMs: 300 };
      const nextProfileOutbox = {
        ...profileOutbox,
        requestId: "profile-after",
        lastQueuedAtMs: 300,
      };
      const nextTelegramOutbox = {
        ...telegramOutbox,
        requestId: "telegram-after",
        updatedAtMs: 300,
      };
      const nextAssignment = { ...assignment(), assignedAtMs: 300 };
      const dead = {
        deadAtMs: 300,
        originalRecord: progress,
        reason: "mixed-family-dead-letter",
      };
      const updates = {
        [`events/${eventId}/status`]: "active",
        [`eventPrizeSelections/${eventId}/${profileId}`]: "1514",
        [`profileEventPrizes/${profileId}/${eventId}`]: nextAssignment,
        [`eventProgressOutbox/${outboxId}`]: nextProgress,
        "eventProgressOutboxDead/mixed-family-dead": dead,
        [`profileGameProjectionOutbox/event/${eventId}`]: nextProfileOutbox,
        [`telegramProjectionOutbox/event/${eventId}`]: nextTelegramOutbox,
        [`eventTelegramProjectionGenerations/${eventId}`]: 2,
        [`eventTelegramProjections/${eventId}`]: { version: "after" },
      };
      const intent = {
        schemaVersion: 1 as const,
        transitionId: "transition-mixed-family",
        eventId,
        expectedRevision: 1,
        rtdbEffects: { "invites/mixed-family": { eventId } },
        canonicalUpdates: updates,
        createdAtMs: 200,
        updatedAtMs: 200,
      };
      await createEventTransitionIntent(testEnv.EVENT_DB, intent);
      const readStorage = async () => {
        const prizes = await readPrizeStorage();
        const results = await testEnv.EVENT_DB.batch<Record<string, unknown>>([
          testEnv.EVENT_DB.prepare(
            "SELECT * FROM event_profile_game_projection_outboxes ORDER BY event_id",
          ),
          testEnv.EVENT_DB.prepare(
            "SELECT * FROM event_telegram_projection_outboxes ORDER BY event_id",
          ),
          testEnv.EVENT_DB.prepare(
            "SELECT * FROM event_telegram_projection_state ORDER BY event_id",
          ),
          testEnv.EVENT_DB.prepare(
            "SELECT * FROM event_transition_intents ORDER BY transition_id",
          ),
        ]);
        return {
          ...prizes,
          profileOutboxes: results[0].results,
          telegramOutboxes: results[1].results,
          telegramState: results[2].results,
          intents: results[3].results,
        };
      };
      const before = await readStorage();
      const writes = new WeakSet<D1PreparedStatement>();
      let writeBatches = 0;
      const db: EventD1Connection = {
        prepare(query) {
          const statement = testEnv.EVENT_DB.prepare(query);
          if (!/^\s*(INSERT|UPDATE|DELETE)\b/i.test(query)) return statement;
          const tracked = new Proxy(statement, {
            get(target, property) {
              if (property === "bind") {
                return (...values: unknown[]) => {
                  const bound = target.bind(...values);
                  writes.add(bound);
                  return bound;
                };
              }
              const member = Reflect.get(target, property, target);
              return typeof member === "function"
                ? member.bind(target)
                : member;
            },
          });
          writes.add(tracked);
          return tracked;
        },
        async batch(statements) {
          if (statements.some((statement) => writes.has(statement))) {
            writeBatches++;
            if (outcome === "Telegram revision race") {
              await testEnv.EVENT_DB.prepare(
                `UPDATE event_telegram_projection_state
                 SET generation = 7, revision = revision + 1,
                     state_json = ?, updated_at_ms = 250
                 WHERE event_id = ?`,
              )
                .bind(JSON.stringify({ version: "concurrent" }), eventId)
                .run();
            }
          }
          return testEnv.EVENT_DB.batch(statements);
        },
      };
      if (outcome === "late SQL failure") {
        await testEnv.EVENT_DB.prepare(
          `CREATE TRIGGER mixed_family_telegram_failure
           BEFORE UPDATE ON event_telegram_projection_state
           BEGIN SELECT RAISE(ABORT, 'late-telegram-write-failed'); END`,
        ).run();
      }
      try {
        await withD1Admission(async (admission) => {
          const commit = patchEventOwnedPathsRaw(db, updates, {
            admission,
            now: () => 300,
            transition: { eventId, transitionId: intent.transitionId },
          });
          if (outcome === "success") {
            await expect(commit).resolves.toEqual({
              eventRevisions: { [eventId]: 2 },
              profilePrizeRevisions: { [profileId]: 2 },
            });
          } else {
            await expect(commit).rejects.toThrow(
              outcome === "Telegram revision race"
                ? "event-d1-conflict"
                : "event-d1-integrity",
            );
          }
        });
      } finally {
        if (outcome === "late SQL failure") {
          await testEnv.EVENT_DB.prepare(
            "DROP TRIGGER mixed_family_telegram_failure",
          ).run();
        }
      }
      expect(writeBatches).toBe(1);
      const after = await readStorage();
      if (outcome !== "success") {
        expect(after).toEqual({
          ...before,
          ...(outcome === "Telegram revision race"
            ? {
                telegramState: [
                  {
                    ...before.telegramState[0],
                    generation: 7,
                    revision: 2,
                    state_json: JSON.stringify({ version: "concurrent" }),
                    updated_at_ms: 250,
                  },
                ],
              }
            : {}),
        });
        return;
      }
      expect(after.events[0]).toMatchObject({
        status: "active",
        revision: 2,
        pending_transition_id: null,
      });
      expect(after.selections[0]).toMatchObject({
        prize_id: "1514",
        updated_at_ms: 300,
      });
      expect(after.prizes[0]).toMatchObject({
        assignment_json: JSON.stringify(nextAssignment),
        updated_at_ms: 300,
      });
      expect(after.profileRevisions[0]).toMatchObject({
        revision: 2,
        updated_at_ms: 300,
      });
      expect(after.outboxes).toHaveLength(3);
      for (const [path, expected] of [
        [`eventProgressOutbox/${outboxId}`, nextProgress],
        [
          `eventProgressOutboxDead/${outboxId}`,
          {
            deadAtMs: 300,
            originalRecord: malformedProgress,
            reason: "invalid-event-progress-outbox",
          },
        ],
        ["eventProgressOutboxDead/mixed-family-dead", dead],
        [`profileGameProjectionOutbox/event/${eventId}`, nextProfileOutbox],
        [`telegramProjectionOutbox/event/${eventId}`, nextTelegramOutbox],
      ] as const) {
        expect(await readEventOwnedPath(testEnv.EVENT_DB, path)).toEqual(
          expected,
        );
      }
      expect(
        await readEventTelegramProjectionState(testEnv.EVENT_DB, eventId),
      ).toEqual({
        generation: 2,
        revision: 2,
        state: { version: "after" },
      });
      expect(after.intents).toEqual([]);
    },
  );

  it("stores recoverable progress and projection outboxes plus fenced state", async () => {
    await patchEventOwnedPaths(testEnv.EVENT_DB, {
      [`events/${eventId}`]: eventRecord(),
    });
    const progress = {
      schemaVersion: 1,
      eventId,
      sourceKey: `start:${eventId}:1000`,
      reason: "scheduled-start",
      runAtMs: 1_000,
      firstQueuedAtMs: 100,
      lastQueuedAtMs: 100,
    };
    await patchEventOwnedPaths(testEnv.EVENT_DB, {
      "eventProgressOutbox/progress-one": progress,
    });
    expect(await listDueEventProgressOutboxes(testEnv.EVENT_DB, 100)).toEqual([
      { outboxId: "progress-one", record: progress },
    ]);
    await patchEventOwnedPaths(testEnv.EVENT_DB, {
      "eventProgressOutbox/progress-one/lastQueuedAtMs": 150,
    });
    expect(await listDueEventProgressOutboxes(testEnv.EVENT_DB, 100)).toEqual(
      [],
    );
    expect(await listDueEventProgressOutboxes(testEnv.EVENT_DB, 150)).toEqual([
      {
        outboxId: "progress-one",
        record: { ...progress, lastQueuedAtMs: 150 },
      },
    ]);
    const dead = {
      deadAtMs: 175,
      originalRecord: { ...progress, lastQueuedAtMs: 150 },
      reason: "invalid-event-progress-outbox",
    };
    await patchEventOwnedPaths(testEnv.EVENT_DB, {
      "eventProgressOutboxDead/progress-one": dead,
    });
    await expect(
      readEventOwnedPath(testEnv.EVENT_DB, "eventProgressOutbox/progress-one"),
    ).resolves.toEqual({ ...progress, lastQueuedAtMs: 150 });
    await expect(
      readEventOwnedPath(
        testEnv.EVENT_DB,
        "eventProgressOutboxDead/progress-one",
      ),
    ).resolves.toEqual(dead);
    const unscopedDeadLetters = {
      "progress-null": {
        deadAtMs: 176,
        originalRecord: null,
        reason: "invalid-event-progress-outbox",
      },
      "progress-primitive": {
        deadAtMs: 177,
        originalRecord: "invalid",
        reason: "invalid-event-progress-outbox",
      },
      "progress-deleted-event": {
        deadAtMs: 178,
        originalRecord: { eventId: "deleted-event" },
        reason: "invalid-event-progress-outbox",
      },
    };
    await patchEventOwnedPaths(
      testEnv.EVENT_DB,
      Object.fromEntries(
        Object.entries(unscopedDeadLetters).map(([outboxId, record]) => [
          `eventProgressOutboxDead/${outboxId}`,
          record,
        ]),
      ),
    );
    for (const [outboxId, record] of Object.entries(unscopedDeadLetters)) {
      await expect(
        readEventOwnedPath(
          testEnv.EVENT_DB,
          `eventProgressOutboxDead/${outboxId}`,
        ),
      ).resolves.toEqual(record);
    }
    const deadIdentities = await testEnv.EVENT_DB.prepare(
      `SELECT outbox_id, event_id FROM event_progress_outboxes
       WHERE status = 'dead' ORDER BY outbox_id`,
    ).all<{ event_id: string | null; outbox_id: string }>();
    expect(deadIdentities.results).toEqual([
      { event_id: null, outbox_id: "progress-deleted-event" },
      { event_id: null, outbox_id: "progress-null" },
      { event_id: "NN3eRzoZo80", outbox_id: "progress-one" },
      { event_id: null, outbox_id: "progress-primitive" },
    ]);
    await patchEventOwnedPaths(testEnv.EVENT_DB, {
      "eventProgressOutbox/progress-one": null,
    });
    await expect(
      readEventOwnedPath(
        testEnv.EVENT_DB,
        "eventProgressOutboxDead/progress-one",
      ),
    ).resolves.toEqual(dead);

    const profileOutbox = {
      schemaVersion: 1,
      status: "pending",
      requestId: "profile-request",
      lastQueuedAtMs: 200,
      cleanupOwnerProfileIds: { [profileId]: true },
    };
    await patchEventOwnedPaths(testEnv.EVENT_DB, {
      [`profileGameProjectionOutbox/event/${eventId}`]: profileOutbox,
    });
    await patchEventOwnedPaths(testEnv.EVENT_DB, {
      [`profileGameProjectionOutbox/event/${eventId}/cleanupOwnerProfileIds/profile-two`]: true,
    });
    expect(
      await listDueEventProfileGameProjectionOutboxes(testEnv.EVENT_DB, 200),
    ).toEqual([
      {
        eventId,
        record: {
          ...profileOutbox,
          cleanupOwnerProfileIds: {
            ...profileOutbox.cleanupOwnerProfileIds,
            "profile-two": true,
          },
        },
      },
    ]);
    await patchEventOwnedPaths(testEnv.EVENT_DB, {
      [`profileGameProjectionOutbox/event/${eventId}`]: null,
    });

    const telegramOutbox = {
      schemaVersion: 1,
      status: "pending",
      requestId: "telegram-request",
      firstQueuedAtMs: 300,
      updatedAtMs: 300,
    };
    await patchEventOwnedPaths(testEnv.EVENT_DB, {
      [`telegramProjectionOutbox/event/${eventId}`]: telegramOutbox,
    });
    expect(
      await listDueEventTelegramProjectionOutboxes(testEnv.EVENT_DB, 300),
    ).toEqual([{ eventId, record: telegramOutbox }]);
    await patchEventOwnedPaths(testEnv.EVENT_DB, {
      [`telegramProjectionOutbox/event/${eventId}`]: null,
    });

    await patchEventOwnedPaths(
      testEnv.EVENT_DB,
      {
        [`eventTelegramProjectionGenerations/${eventId}`]: 1,
        [`eventTelegramProjections/${eventId}`]: {
          scheduledText: "ready",
        },
      },
      { expectedTelegramStateRevisions: { [eventId]: 0 }, now: () => 400 },
    );
    expect(
      await readEventTelegramProjectionState(testEnv.EVENT_DB, eventId),
    ).toEqual({
      generation: 1,
      revision: 1,
      state: { scheduledText: "ready" },
    });
    await expect(
      patchEventOwnedPaths(
        testEnv.EVENT_DB,
        {
          [`eventTelegramProjectionGenerations/${eventId}`]: 2,
          [`eventTelegramProjections/${eventId}`]: {},
        },
        {
          expectedTelegramStateRevisions: { [eventId]: 0 },
          now: () => 500,
        },
      ),
    ).rejects.toBeInstanceOf(EventD1Conflict);
  });

  it.each(["event-prize-announcement", "sunday-mons-reminder"])(
    "retains the earliest %s scheduling proof across competing upserts",
    async (reason) => {
      const { outboxId, outbox: marker } = await buildEventProgressPlan(
        {
          eventId,
          sourceKey: `prizes:${eventId}:3601000`,
          reason,
          runAtMs: 1000,
        },
        100,
      );
      await patchEventOwnedPaths(testEnv.EVENT_DB, {
        [`events/${eventId}`]: eventRecord(),
        [`eventProgressOutbox/${outboxId}`]: marker,
      });
      await patchEventOwnedPaths(testEnv.EVENT_DB, {
        [`eventProgressOutbox/${outboxId}`]: {
          ...marker,
          firstQueuedAtMs: 200,
          lastQueuedAtMs: 300,
        },
      });
      expect(
        await readEventOwnedPath(
          testEnv.EVENT_DB,
          `eventProgressOutbox/${outboxId}`,
        ),
      ).toMatchObject({ firstQueuedAtMs: 100, lastQueuedAtMs: 300 });
    },
  );

  it.each([
    ["missing", null],
    ["null", "null"],
    ["boolean", "true"],
    ["string", '"100"'],
    ["fraction", "100.5"],
    ["too large", "9007199254740992"],
    ["too small", "-9007199254740992"],
    ["array", "[]"],
    ["object", "{}"],
  ])(
    "repairs and archives an announcement with a %s first scheduling time",
    async (_name, timestamp) => {
      const { outboxId, outbox } = await buildEventProgressPlan(
        {
          eventId,
          sourceKey: "reminder:test",
          reason: "sunday-mons-reminder",
          runAtMs: 1_000,
        },
        200,
      );
      const path = `eventProgressOutbox/${outboxId}`;
      await patchEventOwnedPaths(testEnv.EVENT_DB, {
        [`events/${eventId}`]: eventRecord(),
        [path]: outbox,
      });
      const storedJson = JSON.stringify(outbox).replace(
        ',"firstQueuedAtMs":200',
        timestamp === null ? "" : `,"firstQueuedAtMs":${timestamp}`,
      );
      await testEnv.EVENT_DB.prepare(
        "UPDATE event_progress_outboxes SET record_json = ? WHERE outbox_id = ? AND status = 'pending'",
      )
        .bind(storedJson, outboxId)
        .run();
      await patchEventOwnedPaths(testEnv.EVENT_DB, { [path]: outbox });
      expect(await readEventOwnedPath(testEnv.EVENT_DB, path)).toEqual(outbox);
      expect(
        await readEventOwnedPath(
          testEnv.EVENT_DB,
          `eventProgressOutboxDead/${outboxId}`,
        ),
      ).toMatchObject({
        reason: "invalid-event-progress-outbox",
        originalRecord: JSON.parse(storedJson),
      });
    },
  );

  it.each(["1.0", "-1", "0", "100", "9007199254740991", "-9007199254740991"])(
    "retains the earliest valid announcement time for stored %s",
    async (timestamp) => {
      const { outboxId, outbox } = await buildEventProgressPlan(
        {
          eventId,
          sourceKey: "prizes:test",
          reason: "event-prize-announcement",
          runAtMs: 1_000,
        },
        200,
      );
      const path = `eventProgressOutbox/${outboxId}`;
      await patchEventOwnedPaths(testEnv.EVENT_DB, {
        [`events/${eventId}`]: eventRecord(),
        [path]: outbox,
      });
      await testEnv.EVENT_DB.prepare(
        "UPDATE event_progress_outboxes SET record_json = ? WHERE outbox_id = ? AND status = 'pending'",
      )
        .bind(
          JSON.stringify(outbox).replace(
            '"firstQueuedAtMs":200',
            `"firstQueuedAtMs":${timestamp}`,
          ),
          outboxId,
        )
        .run();
      await patchEventOwnedPaths(testEnv.EVENT_DB, { [path]: outbox });
      expect(await readEventOwnedPath(testEnv.EVENT_DB, path)).toEqual({
        ...outbox,
        firstQueuedAtMs: Math.min(Number(timestamp), outbox.firstQueuedAtMs),
      });
      expect(
        await readEventOwnedPath(
          testEnv.EVENT_DB,
          `eventProgressOutboxDead/${outboxId}`,
        ),
      ).toBeNull();
    },
  );

  it.each([
    ["schemaVersion", 2],
    ["sourceKey", "wrong-source-digest"],
    ["reason", { malformed: true }],
    ["eventId", "wrong-event"],
    ["runAtMs", "1000"],
    ["lastQueuedAtMs", null],
  ])(
    "archives an invalid %s before replacing any progress marker",
    async (field, invalid) => {
      for (const reason of ["sunday-mons-reminder", "match-rating-updated"]) {
        const { outboxId, outbox } = await buildEventProgressPlan(
          { eventId, sourceKey: `${reason}:test`, reason, runAtMs: 1_000 },
          200,
        );
        const path = `eventProgressOutbox/${outboxId}`;
        await patchEventOwnedPaths(testEnv.EVENT_DB, {
          [`events/${eventId}`]: eventRecord(),
          [path]: outbox,
        });
        const malformed = {
          ...outbox,
          firstQueuedAtMs: 50,
          [field]: invalid,
          unknownFutureField: { evidence: [1, 2, 3] },
        };
        await testEnv.EVENT_DB.prepare(
          "UPDATE event_progress_outboxes SET record_json = ? WHERE status = 'pending' AND outbox_id = ?",
        )
          .bind(JSON.stringify(malformed), outboxId)
          .run();
        await patchEventOwnedPaths(testEnv.EVENT_DB, { [path]: outbox });
        expect(await readEventOwnedPath(testEnv.EVENT_DB, path)).toEqual(
          outbox,
        );
        expect(
          await readEventOwnedPath(
            testEnv.EVENT_DB,
            `eventProgressOutboxDead/${outboxId}`,
          ),
        ).toMatchObject({
          reason: "invalid-event-progress-outbox",
          originalRecord: malformed,
        });
      }
    },
  );

  it("compares valid stored JSON bytes without normalizing whitespace or numeric spelling", async () => {
    const { outboxId, outbox } = await buildEventProgressPlan(
      {
        eventId,
        sourceKey: "raw-json:test",
        reason: "sunday-mons-reminder",
        runAtMs: 1_000,
      },
      200,
    );
    const path = `eventProgressOutbox/${outboxId}`;
    await patchEventOwnedPaths(testEnv.EVENT_DB, {
      [`events/${eventId}`]: eventRecord(),
      [path]: outbox,
    });
    const raw = JSON.stringify(outbox, null, 2).replace(
      '"firstQueuedAtMs": 200',
      '"firstQueuedAtMs": 200.0',
    );
    await testEnv.EVENT_DB.prepare(
      "UPDATE event_progress_outboxes SET record_json = ? WHERE status = 'pending' AND outbox_id = ?",
    )
      .bind(raw, outboxId)
      .run();
    const observed = observeD1FailureDatabase(testEnv.EVENT_DB);
    await patchEventOwnedPaths(observed.database, {
      [path]: { ...outbox, firstQueuedAtMs: 400, lastQueuedAtMs: 400 },
    });
    expect(observed.batches).toHaveLength(1);
    expect(await readEventOwnedPath(testEnv.EVENT_DB, path)).toEqual({
      ...outbox,
      lastQueuedAtMs: 400,
    });
    expect(
      await readEventOwnedPath(
        testEnv.EVENT_DB,
        `eventProgressOutboxDead/${outboxId}`,
      ),
    ).toBeNull();
  });

  it.each(["absent", "valid", "invalid"] as const)(
    "retries a changed %s progress snapshot and archives only the actual replaced value",
    async (state) => {
      const { outboxId, outbox } = await buildEventProgressPlan(
        {
          eventId,
          sourceKey: "snapshot-race:test",
          reason: "match-rating-updated",
        },
        200,
      );
      const path = `eventProgressOutbox/${outboxId}`;
      await patchEventOwnedPaths(testEnv.EVENT_DB, {
        [`events/${eventId}`]: eventRecord(),
      });
      if (state !== "absent") {
        await testEnv.EVENT_DB.prepare(
          "INSERT INTO event_progress_outboxes (outbox_id, event_id, status, run_at_ms, last_queued_at_ms, record_json) VALUES (?, ?, 'pending', NULL, ?, ?)",
        )
          .bind(
            outboxId,
            eventId,
            200,
            JSON.stringify(
              state === "valid" ? outbox : { ...outbox, schemaVersion: 2 },
            ),
          )
          .run();
      }
      const raced = {
        ...outbox,
        reason: { broken: true },
        evidence: "concurrent-record",
      };
      const observed = observeD1FailureDatabase(testEnv.EVENT_DB, {
        async beforeBatch(attempt) {
          if (attempt !== 1) return;
          await testEnv.EVENT_DB.prepare(
            "INSERT INTO event_progress_outboxes (outbox_id, event_id, status, run_at_ms, last_queued_at_ms, record_json) VALUES (?, ?, 'pending', NULL, ?, ?) ON CONFLICT (status, outbox_id) DO UPDATE SET record_json = excluded.record_json",
          )
            .bind(outboxId, eventId, 200, JSON.stringify(raced, null, 2))
            .run();
        },
      });
      await patchEventOwnedPaths(observed.database, { [path]: outbox });
      expect(observed.batches).toHaveLength(2);
      expect(await readEventOwnedPath(testEnv.EVENT_DB, path)).toEqual(outbox);
      expect(
        await readEventOwnedPath(
          testEnv.EVENT_DB,
          `eventProgressOutboxDead/${outboxId}`,
        ),
      ).toMatchObject({ originalRecord: raced });
    },
  );

  it("preserves a concurrent valid repair and its timestamp without auditing it as malformed", async () => {
    const { outboxId, outbox } = await buildEventProgressPlan(
      {
        eventId,
        sourceKey: "valid-repair:test",
        reason: "sunday-mons-reminder",
      },
      200,
    );
    const path = `eventProgressOutbox/${outboxId}`;
    await patchEventOwnedPaths(testEnv.EVENT_DB, {
      [`events/${eventId}`]: eventRecord(),
      [path]: outbox,
    });
    await testEnv.EVENT_DB.prepare(
      "UPDATE event_progress_outboxes SET record_json = ? WHERE status = 'pending' AND outbox_id = ?",
    )
      .bind(JSON.stringify({ ...outbox, schemaVersion: 2 }), outboxId)
      .run();
    const repaired = { ...outbox, firstQueuedAtMs: 50 };
    const observed = observeD1FailureDatabase(testEnv.EVENT_DB, {
      async beforeBatch(attempt) {
        if (attempt !== 1) return;
        await testEnv.EVENT_DB.prepare(
          "UPDATE event_progress_outboxes SET record_json = ? WHERE status = 'pending' AND outbox_id = ?",
        )
          .bind(JSON.stringify(repaired), outboxId)
          .run();
      },
    });
    await patchEventOwnedPaths(observed.database, { [path]: outbox });
    expect(observed.batches).toHaveLength(2);
    expect(await readEventOwnedPath(testEnv.EVENT_DB, path)).toEqual(repaired);
    expect(
      await readEventOwnedPath(
        testEnv.EVENT_DB,
        `eventProgressOutboxDead/${outboxId}`,
      ),
    ).toBeNull();
  });

  it.each(["mixed-plan", "explicit-expectation"] as const)(
    "does not retry a changed progress snapshot in a %s",
    async (scope) => {
      const { outboxId, outbox } = await buildEventProgressPlan(
        {
          eventId,
          sourceKey: "snapshot-guard:test",
          reason: "match-rating-updated",
        },
        200,
      );
      const path = `eventProgressOutbox/${outboxId}`;
      await patchEventOwnedPaths(testEnv.EVENT_DB, {
        [`events/${eventId}`]: eventRecord(),
        [path]: outbox,
      });
      const raced = { ...outbox, schemaVersion: 2 };
      const observed = observeD1FailureDatabase(testEnv.EVENT_DB, {
        async beforeBatch() {
          await testEnv.EVENT_DB.prepare(
            "UPDATE event_progress_outboxes SET record_json = ? WHERE status = 'pending' AND outbox_id = ?",
          )
            .bind(JSON.stringify(raced), outboxId)
            .run();
        },
      });
      await expect(
        patchEventOwnedPaths(
          observed.database,
          {
            [path]: outbox,
            ...(scope === "mixed-plan"
              ? { [`events/${eventId}/status`]: "active" }
              : {}),
          },
          scope === "explicit-expectation"
            ? { expectedRecords: { progress: { [outboxId]: outbox } } }
            : {},
        ),
      ).rejects.toBeInstanceOf(EventD1Conflict);
      expect(observed.batches).toHaveLength(1);
      expect(
        (await readEventSnapshot(testEnv.EVENT_DB, eventId)).event?.status,
      ).toBe("scheduled");
      expect(await readEventOwnedPath(testEnv.EVENT_DB, path)).toEqual(raced);
      expect(
        await readEventOwnedPath(
          testEnv.EVENT_DB,
          `eventProgressOutboxDead/${outboxId}`,
        ),
      ).toBeNull();
    },
  );

  it("bounds pure outbox snapshot conflicts without leaving a partial audit or replacement", async () => {
    const { outboxId, outbox } = await buildEventProgressPlan(
      {
        eventId,
        sourceKey: "retry-limit:test",
        reason: "match-rating-updated",
      },
      200,
    );
    const path = `eventProgressOutbox/${outboxId}`;
    await patchEventOwnedPaths(testEnv.EVENT_DB, {
      [`events/${eventId}`]: eventRecord(),
      [path]: outbox,
    });
    const observed = observeD1FailureDatabase(testEnv.EVENT_DB, {
      async beforeBatch(attempt) {
        await testEnv.EVENT_DB.prepare(
          "UPDATE event_progress_outboxes SET record_json = ? WHERE status = 'pending' AND outbox_id = ?",
        )
          .bind(
            JSON.stringify({ ...outbox, schemaVersion: 2, attempt }),
            outboxId,
          )
          .run();
      },
    });
    await expect(
      patchEventOwnedPaths(observed.database, { [path]: outbox }),
    ).rejects.toBeInstanceOf(EventD1Conflict);
    expect(observed.batches).toHaveLength(12);
    expect(await readEventOwnedPath(testEnv.EVENT_DB, path)).toEqual({
      ...outbox,
      schemaVersion: 2,
      attempt: 12,
    });
    expect(
      await readEventOwnedPath(
        testEnv.EVENT_DB,
        `eventProgressOutboxDead/${outboxId}`,
      ),
    ).toBeNull();
  });

  it("rejects stale outbox deletion without other revision guards", async () => {
    const path = `profileGameProjectionOutbox/event/${eventId}`;
    const originalOutbox = {
      schemaVersion: 1,
      status: "pending",
      requestId: "request-one",
      lastQueuedAtMs: 100,
    };
    const currentOutbox = {
      ...originalOutbox,
      requestId: "request-two",
      lastQueuedAtMs: 200,
    };
    await patchEventOwnedPaths(testEnv.EVENT_DB, {
      [`events/${eventId}`]: eventRecord(),
      [path]: originalOutbox,
    });
    await patchEventOwnedPaths(testEnv.EVENT_DB, { [path]: currentOutbox });

    await expect(
      patchEventOwnedPaths(
        testEnv.EVENT_DB,
        { [path]: null },
        { expectedRecords: { profileGame: { [eventId]: originalOutbox } } },
      ),
    ).rejects.toBeInstanceOf(EventD1Conflict);
    expect(await readEventOwnedPath(testEnv.EVENT_DB, path)).toEqual(
      currentOutbox,
    );

    await patchEventOwnedPaths(
      testEnv.EVENT_DB,
      { [path]: null },
      { expectedRecords: { profileGame: { [eventId]: currentOutbox } } },
    );
    expect(await readEventOwnedPath(testEnv.EVENT_DB, path)).toBeNull();
  });

  it("rejects stale profile-prize, outbox, and Telegram-state writes", async () => {
    await patchEventOwnedPaths(testEnv.EVENT_DB, {
      [`events/${eventId}`]: eventRecord(),
      [`profileEventPrizes/${profileId}/${eventId}`]: assignment(),
      [`profileGameProjectionOutbox/event/${eventId}`]: {
        schemaVersion: 1,
        status: "pending",
        requestId: "request-one",
        lastQueuedAtMs: 100,
      },
      [`eventTelegramProjections/${eventId}`]: { version: 1 },
    });
    const originalOutbox = await readEventOwnedPath(
      testEnv.EVENT_DB,
      `profileGameProjectionOutbox/event/${eventId}`,
    );
    await patchEventOwnedPaths(testEnv.EVENT_DB, {
      [`profileEventPrizes/${profileId}/${eventId}`]: {
        ...assignment(),
        assignedAtMs: 3_000,
      },
      [`profileGameProjectionOutbox/event/${eventId}`]: {
        schemaVersion: 1,
        status: "pending",
        requestId: "request-two",
        lastQueuedAtMs: 200,
      },
      [`eventTelegramProjections/${eventId}`]: { version: 2 },
    });
    await expect(
      patchEventOwnedPaths(
        testEnv.EVENT_DB,
        {
          [`profileEventPrizes/${profileId}/${eventId}`]: null,
          [`profileGameProjectionOutbox/event/${eventId}`]: null,
          [`eventTelegramProjections/${eventId}`]: { version: 1 },
        },
        {
          expectedProfilePrizeRevisions: { [profileId]: 1 },
          expectedRecords: {
            profileGame: { [eventId]: originalOutbox },
          },
          expectedTelegramStateRevisions: { [eventId]: 1 },
        },
      ),
    ).rejects.toBeInstanceOf(EventD1Conflict);
    expect(
      await readProfileEventPrizes(testEnv.EVENT_DB, profileId),
    ).toMatchObject({
      prizes: { [eventId]: { assignedAtMs: 3_000 } },
      revision: 2,
    });
    expect(
      await readEventOwnedPath(
        testEnv.EVENT_DB,
        `profileGameProjectionOutbox/event/${eventId}`,
      ),
    ).toMatchObject({ requestId: "request-two" });
    expect(
      await readEventTelegramProjectionState(testEnv.EVENT_DB, eventId),
    ).toMatchObject({
      revision: 2,
      state: { version: 2 },
    });
  });
});
