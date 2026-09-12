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
  listDueEventProfileGameProjectionOutboxes,
  listDueEventProgressOutboxes,
  listDueEventTelegramProjectionOutboxes,
  listPendingEventTransitionIntents,
  listProfileEventPrizeAssignments,
  patchEventOwnedPaths as patchEventOwnedPathsRaw,
  readEvent,
  readEventOwnedPath,
  readEventPrizeSelections,
  readEventRuntimeControl,
  readEventSnapshot,
  readEventTelegramProjectionState,
  readProfileEventPrizes,
  readProfileEventPrizeAssignment,
  releaseEventWriteAdmission,
  transactEventOwnedPath as transactEventOwnedPathRaw,
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

  it("returns empty typed reads for missing records and rejects invalid IDs", async () => {
    await expect(readEvent(testEnv.EVENT_DB, eventId)).resolves.toBeNull();
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
          ).rejects.toBeInstanceOf(EventD1Conflict);
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
    ).rejects.toBeInstanceOf(EventD1Conflict);
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
        ).rejects.toBeInstanceOf(EventD1Conflict);
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
      const outboxId = `ep_${"a".repeat(64)}`;
      const marker = {
        schemaVersion: 1,
        eventId,
        sourceKey: `prizes:${eventId}:3601000`,
        reason,
        runAtMs: 1000,
        firstQueuedAtMs: 100,
        lastQueuedAtMs: 100,
      };
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
          expectedPathValues: {
            [`profileGameProjectionOutbox/event/${eventId}`]: originalOutbox,
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
