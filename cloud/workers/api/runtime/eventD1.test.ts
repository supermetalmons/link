import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import {
  acquireEventWriteAdmission,
  createEventTransitionIntent as createEventTransitionIntentRaw,
  EventD1Conflict,
  EventD1Failure,
  listDueEventProfileGameProjectionOutboxes,
  listDueEventProgressOutboxes,
  listDueEventTelegramProjectionOutboxes,
  listPendingEventTransitionIntents,
  markEventImportVerified,
  patchEventOwnedPaths as patchEventOwnedPathsRaw,
  readEventOwnedPath,
  readEventRuntimeControl,
  readEventSnapshot,
  readEventTelegramProjectionState,
  readProfileEventPrizes,
  releaseEventWriteAdmission,
  transactEventOwnedPath as transactEventOwnedPathRaw,
  transitionEventStorageMode,
  validateEventAggregate,
  writeEventImportMetadata,
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
  db: D1Database,
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
    await applyD1Migrations(testEnv.EVENT_DB, testEnv.TEST_EVENT_D1_MIGRATIONS);
    const frozen = await transitionEventStorageMode(testEnv.EVENT_DB, {
      expected: { storageMode: "firebase", previousStorageMode: null },
      next: { storageMode: "frozen", previousStorageMode: "firebase" },
      nowMs: 2,
    });
    const metadata = await writeEventImportMetadata(testEnv.EVENT_DB, {
      expectedStorageMode: "frozen",
      sourceAssignmentCount: 0,
      sourceDigest: "a".repeat(64),
      sourceEventCount: 0,
      sourceExportedAtMs: 2,
      sourceSelectionCount: 0,
      nowMs: 2,
    });
    await markEventImportVerified(testEnv.EVENT_DB, {
      expectedFreezeGeneration: frozen.freezeGeneration,
      sourceDigest: metadata.sourceDigest!,
      nowMs: 2,
    });
    await transitionEventStorageMode(testEnv.EVENT_DB, {
      expected: { storageMode: "frozen", previousStorageMode: "firebase" },
      next: { storageMode: "d1", previousStorageMode: null },
      cutoverAtMs: 3,
      nowMs: 3,
    });
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
      testEnv.EVENT_DB.prepare(
        `UPDATE event_runtime_control
         SET source_digest = NULL, source_event_count = NULL,
             source_selection_count = NULL, source_assignment_count = NULL,
             source_exported_at_ms = NULL, cutover_at_ms = NULL,
             updated_at_ms = 1
         WHERE singleton = 1`,
      ),
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
    expect(
      (await readEventOwnedPath(
        testEnv.EVENT_DB,
        `events/${eventId}/unknownFutureField`,
      )) as unknown,
    ).toEqual({ retained: true });
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
      expected: { storageMode: "d1", previousStorageMode: null },
      next: { storageMode: "frozen", previousStorageMode: "d1" },
      nowMs: 40,
    });
    expect(frozen).toMatchObject({
      storageMode: "frozen",
      previousStorageMode: "d1",
      freezeGeneration: before.freezeGeneration + 1,
      verifiedImportGeneration: null,
    });
    await transitionEventStorageMode(testEnv.EVENT_DB, {
      expected: { storageMode: "frozen", previousStorageMode: "d1" },
      next: { storageMode: "d1", previousStorageMode: null },
      nowMs: 50,
    });
  });

  it("serializes storage freezes with durable write admissions", async () => {
    const admission = await acquireEventWriteAdmission(testEnv.EVENT_DB, {
      admissionId: "admission-one",
      nowMs: 75,
      ttlMs: 1,
    });
    expect(admission.storageMode).toBe("d1");
    await expect(
      transitionEventStorageMode(testEnv.EVENT_DB, {
        expected: { storageMode: "d1", previousStorageMode: null },
        next: { storageMode: "frozen", previousStorageMode: "d1" },
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
      expected: { storageMode: "d1", previousStorageMode: null },
      next: { storageMode: "frozen", previousStorageMode: "d1" },
      nowMs: 101,
    });
    await expect(
      acquireEventWriteAdmission(testEnv.EVENT_DB, {
        admissionId: "admission-two",
        nowMs: 102,
      }),
    ).rejects.toThrow("event-writes-disabled");
    await transitionEventStorageMode(testEnv.EVENT_DB, {
      expected: { storageMode: "frozen", previousStorageMode: "d1" },
      next: { storageMode: "d1", previousStorageMode: null },
      nowMs: 103,
    });
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
