import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import type { D1Migration } from "cloudflare:test";
import {
  applyEventTestMigrations,
  transitionEventStorageMode,
} from "./eventTestMigrations.ts";
import {
  acquireEventWriteAdmission,
  createEventTransitionIntent,
  listPendingEventTransitionIntents,
  patchEventOwnedPaths,
  readEventOwnedPath,
  readEventSnapshot,
  releaseEventWriteAdmission,
  type EventWriteAdmission,
} from "../src/eventD1.ts";
import {
  EVENT_TRANSITION_RECEIPT_ROOT,
  createEventRtdbClient,
  recoverEventTransitionIntents,
} from "../src/eventRepository.ts";
import { processEventProfileGameProjection } from "../src/profileGameProjection.ts";
import { buildEventProfileGameProjectionOutboxUpdates } from "../src/profileGameProjectionOutbox.ts";
import { sweepEventTelegramProjections } from "../src/eventTelegramProjection.ts";
import type { TelegramProjectionTask } from "../src/telegramProjectionTasks.ts";

const testEnv = env as Env & { TEST_EVENT_D1_MIGRATIONS: D1Migration[] };
const eventId = "NN3eRzoZo80";

function eventRecord(status = "scheduled", recordEventId = eventId) {
  return {
    schemaVersion: 2,
    eventId: recordEventId,
    status,
    createdAtMs: 100,
    updatedAtMs: status === "scheduled" ? 100 : 200,
    startAtMs: 1_000,
    createdByProfileId: "profile-one",
    createdByLoginUid: "login-one",
    createdByUsername: "ivan",
    participants: {},
    rounds: {},
  };
}

function applyFlatUpdates(
  values: Map<string, unknown>,
  updates: Record<string, unknown>,
): void {
  for (const [path, value] of Object.entries(updates)) {
    if (value === null) values.delete(path);
    else values.set(path, structuredClone(value));
  }
}

async function withD1Admission<T>(
  work: (admission: EventWriteAdmission) => Promise<T>,
): Promise<T> {
  const admission = await acquireEventWriteAdmission(testEnv.EVENT_DB);
  try {
    return await work(admission);
  } finally {
    await releaseEventWriteAdmission(testEnv.EVENT_DB, admission);
  }
}

describe("hybrid event repository", () => {
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
      testEnv.EVENT_DB.prepare("DELETE FROM event_write_admissions"),
      testEnv.EVENT_DB.prepare("DELETE FROM event_progress_outboxes"),
      testEnv.EVENT_DB.prepare("DELETE FROM event_records"),
      testEnv.EVENT_DB.prepare("DELETE FROM profile_event_prize_revisions"),
    ]);
  });

  it("does not let admission release failures override D1 write outcomes", async () => {
    const effects: Record<string, unknown>[] = [];
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await testEnv.EVENT_DB.prepare(
      `CREATE TRIGGER event_write_admission_release_failure
       BEFORE DELETE ON event_write_admissions
       BEGIN
         SELECT RAISE(ABORT, 'admission-release-failed');
       END`,
    ).run();
    try {
      const client = createEventRtdbClient(testEnv, {
        getPath: async () => null,
        patchRoot: async (updates) => {
          effects.push(updates);
        },
        transactPath: async () => ({ committed: false, value: null }),
      });
      const update = { [`events/${eventId}`]: eventRecord() };
      await expect(client.patchRoot(update)).resolves.toBeUndefined();
      expect(effects).toEqual([]);
      const failedClient = createEventRtdbClient(testEnv, {
        getPath: async () => null,
        patchRoot: async () => {
          throw new Error("firebase-write-failed");
        },
        transactPath: async () => ({ committed: false, value: null }),
      });
      await expect(
        failedClient.patchRoot({
          [`events/${eventId}`]: { ...eventRecord(), status: "invalid" },
        }),
      ).rejects.toThrow("invalid-event-record");
      expect(
        await testEnv.EVENT_DB.prepare(
          "SELECT COUNT(*) AS count FROM event_write_admissions",
        ).first<number>("count"),
      ).toBe(2);
      const admissions = await testEnv.EVENT_DB.prepare(
        "SELECT admission_id FROM event_write_admissions ORDER BY admission_id",
      ).all<{ admission_id: string }>();
      const failures = errors.mock.calls.map(([message]) =>
        JSON.parse(String(message)),
      ) as Array<Record<string, unknown>>;
      expect(failures).toHaveLength(2);
      expect(failures).toEqual(
        expect.arrayContaining(
          admissions.results.map((admission) =>
            expect.objectContaining({
              event: "event_write_admission_release_failed",
              admissionId: admission.admission_id,
              freezeGeneration: expect.any(Number),
              attempts: 1,
              context: "event-root-patch",
            }),
          ),
        ),
      );
    } finally {
      await testEnv.EVENT_DB.prepare(
        "DROP TRIGGER event_write_admission_release_failure",
      ).run();
      await testEnv.EVENT_DB.prepare(
        "DELETE FROM event_write_admissions",
      ).run();
      errors.mockRestore();
    }
  });

  it("publishes event projection metadata without an RTDB mirror", async () => {
    const effects: Record<string, unknown>[] = [];
    const client = createEventRtdbClient(testEnv, {
      getPath: async () => null,
      patchRoot: async (updates) => {
        effects.push(updates);
      },
      transactPath: async () => ({ committed: false, value: null }),
    });
    await client.patchRoot({
      [`events/${eventId}`]: eventRecord(),
      ...buildEventProfileGameProjectionOutboxUpdates({
        cleanupOwnerProfileIds: [],
        eventId,
        requestId: "profile-request",
        timestamp: 100,
      }),
      [`telegramProjectionOutbox/event/${eventId}`]: {
        schemaVersion: 1,
        status: "pending",
        requestId: "telegram-request",
        firstQueuedAtMs: 100,
        updatedAtMs: 100,
      },
      [`eventTelegramProjectionGenerations/${eventId}`]: {
        ".sv": { increment: 1 },
      },
    });
    expect(effects).toEqual([]);
    expect(await readEventSnapshot(testEnv.EVENT_DB, eventId)).toMatchObject({
      event: { status: "scheduled" },
      revision: 1,
    });
    expect(
      await readEventOwnedPath(
        testEnv.EVENT_DB,
        `profileGameProjectionOutbox/event/${eventId}`,
      ),
    ).toMatchObject({ requestId: "profile-request" });
    expect(
      await readEventOwnedPath(
        testEnv.EVENT_DB,
        `eventTelegramProjectionGenerations/${eventId}`,
      ),
    ).toBe(1);
  });

  it("quarantines malformed Telegram outboxes in D1 mode", async () => {
    const client = createEventRtdbClient(testEnv, {
      getPath: async () => null,
      patchRoot: async () => undefined,
      transactPath: async () => ({ committed: false, value: null }),
    });
    await client.patchRoot({
      [`events/${eventId}`]: eventRecord(),
      [`telegramProjectionOutbox/event/${eventId}`]: {
        schemaVersion: 1,
        status: "pending",
        requestId: "request-one",
        firstQueuedAtMs: 100,
        updatedAtMs: 100,
      },
    });
    const malformed = { status: "pending", updatedAtMs: 100 };
    await testEnv.EVENT_DB.prepare(
      `UPDATE event_telegram_projection_outboxes
       SET record_json = ? WHERE event_id = ?`,
    )
      .bind(JSON.stringify(malformed), eventId)
      .run();
    const sendBatch = vi.fn(async () => ({
      metadata: { metrics: { backlogBytes: 0, backlogCount: 0 } },
    }));

    await expect(
      sweepEventTelegramProjections(
        { sendBatch } as unknown as Queue<TelegramProjectionTask>,
        client,
        200,
      ),
    ).resolves.toBe(0);
    expect(sendBatch).not.toHaveBeenCalled();

    const row = await testEnv.EVENT_DB.prepare(
      `SELECT request_id, status, first_queued_at_ms, updated_at_ms, record_json
       FROM event_telegram_projection_outboxes WHERE event_id = ?`,
    )
      .bind(eventId)
      .first<{
        first_queued_at_ms: number;
        record_json: string;
        request_id: string;
        status: string;
        updated_at_ms: number;
      }>();
    expect(row).toMatchObject({
      request_id: eventId,
      status: "dead",
      first_queued_at_ms: 200,
      updated_at_ms: 200,
    });
    expect(JSON.parse(row!.record_json)).toEqual({
      status: "dead",
      reason: "invalid-record",
      updatedAtMs: null,
      deadAtMs: 200,
    });
    await expect(
      client.getPath("telegramProjectionOutbox/event", {
        orderBy: "updatedAtMs",
        endAt: 200,
        limitToFirst: 100,
      }),
    ).resolves.toEqual({});
  });

  it("pages mixed-case profile prize IDs in binary cursor order", async () => {
    const client = createEventRtdbClient(testEnv, {
      getPath: async () => null,
      patchRoot: async () => undefined,
      transactPath: async () => ({ committed: false, value: null }),
    });
    const profileId = "source-profile";
    const assignments = [
      ["NN3eRzoZo80", "1092"],
      ["FRkdorMWaYW", "1866"],
      ["VOxalSrexcA", "282"],
      ["oXAceF6anag", "281"],
      ["RpPjMNyrJJa", "217"],
    ] as const;
    await client.patchRoot(
      Object.fromEntries(
        assignments.flatMap(([assignmentEventId, prizeId]) => [
          [
            `events/${assignmentEventId}`,
            eventRecord("scheduled", assignmentEventId),
          ],
          [
            `profileEventPrizes/${profileId}/${assignmentEventId}`,
            {
              eventId: assignmentEventId,
              profileId,
              place: 1,
              prizeId,
              assignedAtMs: 100,
            },
          ],
        ]),
      ),
    );
    const binaryOrder = assignments
      .map(([assignmentEventId]) => assignmentEventId)
      .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
    const firstRead = (await client.getPath(`profileEventPrizes/${profileId}`, {
      orderBy: "$key",
      limitToFirst: assignments.length,
    })) as Record<string, unknown>;
    expect(Object.keys(firstRead)).toEqual(binaryOrder);

    const collected: string[] = [];
    let cursor = "";
    while (true) {
      const result = (await client.getPath(`profileEventPrizes/${profileId}`, {
        orderBy: "$key",
        ...(cursor ? { startAt: cursor } : {}),
        limitToFirst: cursor ? 4 : 3,
      })) as Record<string, unknown>;
      const remaining = Object.keys(result)
        .filter((candidate) => candidate > cursor)
        .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
      const page = remaining.slice(0, 2);
      collected.push(...page);
      if (remaining.length <= page.length) break;
      cursor = page.at(-1)!;
    }
    expect(collected).toEqual(binaryOrder);
  });

  it("recovers a failed RTDB effect before publishing the D1 revision", async () => {
    const effects: Record<string, unknown>[] = [];
    const values = new Map<string, unknown>();
    let fail = true;
    const client = createEventRtdbClient(testEnv, {
      getPath: async (path) => values.get(path) ?? null,
      patchRoot: async (updates) => {
        effects.push(updates);
        if (fail && Object.hasOwn(updates, "invites/event-match")) {
          fail = false;
          throw new Error("rtdb-offline");
        }
        applyFlatUpdates(values, updates);
      },
      transactPath: async () => ({ committed: false, value: null }),
    });
    await client.patchRoot({ [`events/${eventId}`]: eventRecord() });
    const update = {
      [`events/${eventId}/status`]: "active",
      [`events/${eventId}/updatedAtMs`]: 200,
      "invites/event-match": { eventId },
    };
    await expect(client.patchRoot(update)).rejects.toThrow("rtdb-offline");
    expect(
      await testEnv.EVENT_DB.prepare(
        "SELECT COUNT(*) AS count FROM event_write_admissions",
      ).first<number>("count"),
    ).toBe(0);
    expect(await readEventSnapshot(testEnv.EVENT_DB, eventId)).toMatchObject({
      event: { status: "scheduled" },
      revision: 1,
    });
    expect(
      await listPendingEventTransitionIntents(testEnv.EVENT_DB),
    ).toHaveLength(1);
    await expect(
      client.patchRoot({ [`events/${eventId}/updatedAtMs`]: 150 }),
    ).rejects.toThrow("event-transition-pending");
    await client.patchRoot(update);
    const effectWrites = effects.filter((candidate) =>
      Object.hasOwn(candidate, "invites/event-match"),
    );
    expect(effectWrites).toHaveLength(2);
    const receiptPath = Object.keys(effectWrites[1]).find((path) =>
      path.startsWith(`${EVENT_TRANSITION_RECEIPT_ROOT}/`),
    );
    expect(receiptPath).toBeTypeOf("string");
    expect(effectWrites[1]).toMatchObject({
      "invites/event-match": { eventId },
      [receiptPath!]: {
        schemaVersion: 1,
        eventId,
        expectedRevision: 1,
      },
    });
    expect(values.has(receiptPath!)).toBe(true);
    expect(await readEventSnapshot(testEnv.EVENT_DB, eventId)).toMatchObject({
      event: { status: "active", updatedAtMs: 200 },
      revision: 2,
    });
    expect(await listPendingEventTransitionIntents(testEnv.EVENT_DB)).toEqual(
      [],
    );
  });

  it("preserves advanced RTDB state after an ambiguous effect commit", async () => {
    const values = new Map<string, unknown>();
    const patches: Record<string, unknown>[] = [];
    const matchPath = "players/login-one/matches/event-match";
    let ambiguous = true;
    const base = {
      getPath: async (path: string) => values.get(path) ?? null,
      patchRoot: async (updates: Record<string, unknown>) => {
        patches.push(updates);
        applyFlatUpdates(values, updates);
        if (ambiguous && Object.hasOwn(updates, matchPath)) {
          ambiguous = false;
          throw new Error("ambiguous-rtdb-commit");
        }
      },
      transactPath: async () => ({ committed: false, value: null }),
    };
    const client = createEventRtdbClient(testEnv, base);
    await client.patchRoot({ [`events/${eventId}`]: eventRecord() });
    const update = {
      [`events/${eventId}/status`]: "active",
      [`events/${eventId}/updatedAtMs`]: 200,
      [matchPath]: { fen: "initial", flatMovesString: "" },
    };
    await expect(client.patchRoot(update)).rejects.toThrow(
      "ambiguous-rtdb-commit",
    );
    const receiptPath = [...values.keys()].find((path) =>
      path.startsWith(`${EVENT_TRANSITION_RECEIPT_ROOT}/`),
    );
    expect(receiptPath).toBeTypeOf("string");
    values.set(matchPath, { fen: "advanced", flatMovesString: "l0,0;l1,1" });

    await expect(
      recoverEventTransitionIntents(testEnv, {
        getRtdbPath: base.getPath,
        patchRtdbRoot: base.patchRoot,
      }),
    ).resolves.toBe(1);

    expect(values.get(matchPath)).toEqual({
      fen: "advanced",
      flatMovesString: "l0,0;l1,1",
    });
    expect(
      patches.filter((candidate) => Object.hasOwn(candidate, matchPath)),
    ).toHaveLength(1);
    expect(values.has(receiptPath!)).toBe(true);
    expect(await readEventSnapshot(testEnv.EVENT_DB, eventId)).toMatchObject({
      event: { status: "active", updatedAtMs: 200 },
      revision: 2,
    });
  });

  it("serializes duplicate transition applications before reading receipts", async () => {
    let continueReceiptRead!: () => void;
    let markReceiptRead!: () => void;
    const receiptRead = new Promise<void>((resolve) => {
      markReceiptRead = resolve;
    });
    const receiptGate = new Promise<void>((resolve) => {
      continueReceiptRead = resolve;
    });
    const effects: Record<string, unknown>[] = [];
    const client = createEventRtdbClient(testEnv, {
      getPath: async () => {
        markReceiptRead();
        await receiptGate;
        return null;
      },
      patchRoot: async (updates) => {
        effects.push(updates);
      },
      transactPath: async () => ({ committed: false, value: null }),
    });
    await client.patchRoot({ [`events/${eventId}`]: eventRecord() });
    const update = {
      [`events/${eventId}/status`]: "active",
      "invites/serialized-transition": { eventId },
    };
    const first = client.patchRoot(update);
    await receiptRead;

    await expect(client.patchRoot(update)).rejects.toThrow(
      "event-transition-application-busy",
    );
    continueReceiptRead();
    await expect(first).resolves.toBeUndefined();
    expect(
      effects.filter((candidate) =>
        Object.hasOwn(candidate, "invites/serialized-transition"),
      ),
    ).toHaveLength(1);
  });

  it("skips an intent that another recovery committed after it was listed", async () => {
    const otherEventId = "eVKpl6f9aBI";
    await withD1Admission((admission) =>
      patchEventOwnedPaths(
        testEnv.EVENT_DB,
        {
          [`events/${eventId}`]: eventRecord(),
          [`events/${otherEventId}`]: eventRecord("scheduled", otherEventId),
        },
        { admission },
      ),
    );
    for (const [transitionId, targetEventId] of [
      ["a-leading-transition", eventId],
      ["b-stale-transition", otherEventId],
    ] as const) {
      await withD1Admission((admission) =>
        createEventTransitionIntent(
          testEnv.EVENT_DB,
          {
            schemaVersion: 1,
            transitionId,
            eventId: targetEventId,
            expectedRevision: 1,
            rtdbEffects: {
              [`invites/${transitionId}`]: { eventId: targetEventId },
            },
            canonicalUpdates: {
              [`events/${targetEventId}/status`]: "active",
            },
            createdAtMs: 200,
            updatedAtMs: 200,
          },
          { admission },
        ),
      );
    }

    const values = new Map<string, unknown>();
    const patches: Record<string, unknown>[] = [];
    let nestedRecoveryStarted = false;
    const patchRtdbRoot = async (updates: Record<string, unknown>) => {
      patches.push(updates);
      applyFlatUpdates(values, updates);
    };
    const getRtdbPath = async (path: string): Promise<unknown> => {
      if (!nestedRecoveryStarted) {
        nestedRecoveryStarted = true;
        await expect(
          recoverEventTransitionIntents(testEnv, {
            getRtdbPath,
            patchRtdbRoot,
          }),
        ).rejects.toThrow("event-transition-recovery-failed");
      }
      return values.get(path) ?? null;
    };

    await expect(
      recoverEventTransitionIntents(testEnv, {
        getRtdbPath,
        patchRtdbRoot,
      }),
    ).resolves.toBe(2);
    expect(nestedRecoveryStarted).toBe(true);
    expect(
      patches.filter((updates) =>
        Object.hasOwn(updates, "invites/b-stale-transition"),
      ),
    ).toHaveLength(1);
    expect(await listPendingEventTransitionIntents(testEnv.EVENT_DB)).toEqual(
      [],
    );
    expect(await readEventSnapshot(testEnv.EVENT_DB, eventId)).toMatchObject({
      event: { status: "active" },
      revision: 2,
    });
    expect(
      await readEventSnapshot(testEnv.EVENT_DB, otherEventId),
    ).toMatchObject({ event: { status: "active" }, revision: 2 });
  });

  it("fails closed on a conflicting RTDB transition receipt", async () => {
    await withD1Admission((admission) =>
      patchEventOwnedPaths(
        testEnv.EVENT_DB,
        { [`events/${eventId}`]: eventRecord() },
        { admission },
      ),
    );
    const intent = {
      schemaVersion: 1 as const,
      transitionId: "conflicting-receipt",
      eventId,
      expectedRevision: 1,
      rtdbEffects: { "invites/conflicting-receipt": { eventId } },
      canonicalUpdates: { [`events/${eventId}/status`]: "active" },
      createdAtMs: 200,
      updatedAtMs: 200,
    };
    await withD1Admission((admission) =>
      createEventTransitionIntent(testEnv.EVENT_DB, intent, { admission }),
    );
    const patchRoot = vi.fn(async () => undefined);
    await expect(
      recoverEventTransitionIntents(testEnv, {
        getRtdbPath: async () => ({
          schemaVersion: 1,
          transitionId: intent.transitionId,
          eventId: "another-event",
          expectedRevision: 1,
        }),
        patchRtdbRoot: patchRoot,
      }),
    ).rejects.toThrow("event-transition-recovery-failed");
    expect(patchRoot).not.toHaveBeenCalled();
    expect(await listPendingEventTransitionIntents(testEnv.EVENT_DB)).toEqual([
      expect.objectContaining({
        transitionId: intent.transitionId,
        attempts: 1,
      }),
    ]);
  });

  it("isolates transition recovery failures while keeping poison intents fenced", async () => {
    const otherEventId = "eVKpl6f9aBI";
    await withD1Admission((admission) =>
      patchEventOwnedPaths(
        testEnv.EVENT_DB,
        {
          [`events/${eventId}`]: eventRecord(),
          [`events/${otherEventId}`]: eventRecord("scheduled", otherEventId),
        },
        { admission },
      ),
    );
    for (const [transitionId, targetEventId] of [
      ["a-failing-transition", eventId],
      ["b-working-transition", otherEventId],
    ] as const) {
      await withD1Admission((admission) =>
        createEventTransitionIntent(
          testEnv.EVENT_DB,
          {
            schemaVersion: 1,
            transitionId,
            eventId: targetEventId,
            expectedRevision: 1,
            rtdbEffects: {
              [`invites/${transitionId}`]: { eventId: targetEventId },
            },
            canonicalUpdates: {
              [`events/${targetEventId}/status`]: "active",
            },
            createdAtMs: 200,
            updatedAtMs: 200,
          },
          { admission },
        ),
      );
    }
    const repository = {
      getRtdbPath: async () => null,
      patchRtdbRoot: async (updates: Record<string, unknown>) => {
        if (Object.hasOwn(updates, "invites/a-failing-transition")) {
          throw new Error("rtdb-offline");
        }
      },
    };
    await expect(
      recoverEventTransitionIntents(testEnv, repository),
    ).rejects.toThrow("event-transition-recovery-failed");
    expect(
      await readEventSnapshot(testEnv.EVENT_DB, otherEventId),
    ).toMatchObject({ event: { status: "active" }, revision: 2 });
    expect(await listPendingEventTransitionIntents(testEnv.EVENT_DB)).toEqual([
      expect.objectContaining({
        transitionId: "a-failing-transition",
        attempts: 1,
      }),
    ]);

    await expect(
      recoverEventTransitionIntents(testEnv, repository),
    ).rejects.toThrow("event-transition-recovery-failed");
    expect(await listPendingEventTransitionIntents(testEnv.EVENT_DB)).toEqual([
      expect.objectContaining({
        transitionId: "a-failing-transition",
        attempts: 2,
      }),
    ]);
    await expect(
      withD1Admission((admission) =>
        patchEventOwnedPaths(
          testEnv.EVENT_DB,
          { [`events/${eventId}/updatedAtMs`]: 300 },
          { admission },
        ),
      ),
    ).rejects.toThrow("event-transition-pending");
    expect(await readEventSnapshot(testEnv.EVENT_DB, eventId)).toMatchObject({
      event: { status: "scheduled" },
      revision: 1,
    });
  });

  it("holds a durable admission while replaying raw RTDB effects", async () => {
    await withD1Admission((admission) =>
      patchEventOwnedPaths(
        testEnv.EVENT_DB,
        { [`events/${eventId}`]: eventRecord() },
        { admission },
      ),
    );
    await withD1Admission((admission) =>
      createEventTransitionIntent(
        testEnv.EVENT_DB,
        {
          schemaVersion: 1,
          transitionId: "admitted-recovery",
          eventId,
          expectedRevision: 1,
          rtdbEffects: { "invites/admitted-recovery": { eventId } },
          canonicalUpdates: { [`events/${eventId}/status`]: "active" },
          createdAtMs: 200,
          updatedAtMs: 200,
        },
        { admission },
      ),
    );
    let finishReplay!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const pending = new Promise<void>((resolve) => {
      finishReplay = resolve;
    });
    const recovery = recoverEventTransitionIntents(testEnv, {
      getRtdbPath: async () => null,
      patchRtdbRoot: async () => {
        markStarted();
        await pending;
      },
    });
    await started;
    await expect(
      transitionEventStorageMode(testEnv.EVENT_DB, {
        expected: { storageMode: "d1" },
        next: { storageMode: "frozen" },
        nowMs: Date.now(),
      }),
    ).rejects.toThrow();
    finishReplay();
    await expect(recovery).resolves.toBe(1);
    await transitionEventStorageMode(testEnv.EVENT_DB, {
      expected: { storageMode: "d1" },
      next: { storageMode: "frozen" },
      nowMs: Date.now(),
    });
    await transitionEventStorageMode(testEnv.EVENT_DB, {
      expected: { storageMode: "frozen" },
      next: { storageMode: "d1" },
      nowMs: Date.now(),
    });
  });

  it("publishes mixed progress outboxes and RTDB effects for one event", async () => {
    const effects: Record<string, unknown>[] = [];
    const client = createEventRtdbClient(testEnv, {
      getPath: async () => null,
      patchRoot: async (updates) => {
        effects.push(updates);
      },
      transactPath: async () => ({ committed: false, value: null }),
    });
    await client.patchRoot({ [`events/${eventId}`]: eventRecord() });
    const outbox = {
      schemaVersion: 1,
      eventId,
      sourceKey: "timer:invite-one:match-one",
      reason: "timer-claimed",
      runAtMs: null,
      firstQueuedAtMs: 100,
      lastQueuedAtMs: 100,
    };
    await client.patchRoot({
      "eventProgressOutbox/progress-mixed": outbox,
      "matchTimerStarts/login-one/match-one": null,
    });
    const receiptPath = Object.keys(effects[0]).find((path) =>
      path.startsWith(`${EVENT_TRANSITION_RECEIPT_ROOT}/`),
    );
    expect(receiptPath).toBeTypeOf("string");
    expect(effects).toEqual([
      {
        "matchTimerStarts/login-one/match-one": null,
        [receiptPath!]: expect.objectContaining({
          eventId,
          expectedRevision: 1,
          schemaVersion: 1,
        }),
      },
    ]);
    expect(
      await readEventOwnedPath(
        testEnv.EVENT_DB,
        "eventProgressOutbox/progress-mixed",
      ),
    ).toEqual(outbox);
  });

  it("processes event profile-game projections with the shared lease schema", async () => {
    const client = createEventRtdbClient(testEnv, {
      getPath: async () => null,
      patchRoot: async () => undefined,
      transactPath: async () => ({ committed: false, value: null }),
    });
    await client.patchRoot({
      [`events/${eventId}`]: eventRecord(),
      [`profileGameProjectionOutbox/event/${eventId}`]: {
        schemaVersion: 1,
        status: "pending",
        requestId: "profile-request",
        lastQueuedAtMs: 100,
        cleanupOwnerProfileIds: {},
      },
    });
    await expect(
      client.getPath("profileGameProjectionOutbox/event", {
        orderBy: "lastQueuedAtMs",
        startAt: "",
        limitToFirst: 100,
      }),
    ).resolves.toEqual({});
    await expect(
      processEventProfileGameProjection(
        {
          kind: "event-profile-game-projection",
          eventId,
          requestId: "profile-request",
        },
        {
          getRtdbPath: client.getPath,
          transactRtdbPath: client.transactPath,
        },
        {
          reconcileEventProjection: async () => ({
            deleted: 0,
            ownerProfileIds: [],
            status: "projected",
            written: 0,
          }),
        },
        "projection-owner",
        () => 500,
      ),
    ).resolves.toBe("projected");
    expect(
      await readEventOwnedPath(
        testEnv.EVENT_DB,
        `profileGameProjectionOutbox/event/${eventId}`,
      ),
    ).toBeNull();
  });

  it("stores domain and projection locks in namespaced D1 leases", async () => {
    const client = createEventRtdbClient(testEnv, {
      getPath: async () => null,
      patchRoot: async () => undefined,
      transactPath: async () => ({ committed: false, value: null }),
    });
    const lock = {
      lockId: "lock-one",
      ownerUid: "owner-one",
      acquiredAtMs: 100,
      refreshedAtMs: 100,
      expiresAtMs: 30_100,
    };
    await expect(
      client.transactPath(`eventLocks/${eventId}`, () => ({ value: lock })),
    ).resolves.toMatchObject({ committed: true, value: lock });
    await expect(
      client.transactPath(`eventTelegramProjectionLocks/${eventId}`, () => ({
        value: { ...lock, lockId: "telegram-lock" },
      })),
    ).resolves.toMatchObject({ committed: true });
    expect(
      await readEventOwnedPath(testEnv.EVENT_DB, `eventLocks/${eventId}`),
    ).toMatchObject({ lockId: "lock-one" });
    expect(
      await readEventOwnedPath(
        testEnv.EVENT_DB,
        `eventLocks/telegram:${eventId}`,
      ),
    ).toMatchObject({ lockId: "telegram-lock" });
  });

  it("copies stored retired prizes under an event lease while ordinary writes remain strict", async () => {
    const client = createEventRtdbClient(testEnv, {
      getPath: async () => null,
      patchRoot: async () => undefined,
      transactPath: async () => ({ committed: false, value: null }),
    });
    await client.patchRoot({ [`events/${eventId}`]: eventRecord() });
    const sourceAssignment = {
      eventId,
      profileId: "profile-one",
      place: 1,
      prizeId: "retired-prize",
      assignedAtMs: 2_000,
      archivedMetadata: { edition: 1 },
    };
    await testEnv.EVENT_DB.prepare(
      `INSERT INTO profile_event_prizes (
         profile_id, event_id, assignment_json, updated_at_ms
       ) VALUES (?, ?, ?, ?)`,
    )
      .bind("profile-one", eventId, JSON.stringify(sourceAssignment), 2_000)
      .run();
    expect(
      await client.getPath(`profileEventPrizes/profile-one/${eventId}`),
    ).toEqual(sourceAssignment);
    const targetPath = `profileEventPrizes/profile-two/${eventId}`;
    const targetAssignment = { ...sourceAssignment, profileId: "profile-two" };
    const updater = () => ({ value: targetAssignment });
    const guard = {
      eventId,
      lockId: "copy-lock",
      lockRoot: "eventLocks",
      ownerUid: "copy-owner",
    };
    const nowMs = Date.now();
    await client.transactPath(`eventLocks/${eventId}`, () => ({
      value: {
        lockId: guard.lockId,
        ownerUid: guard.ownerUid,
        acquiredAtMs: nowMs,
        refreshedAtMs: nowMs,
        expiresAtMs: nowMs + 30_000,
      },
    }));
    await expect(
      client.patchRoot({ [targetPath]: targetAssignment }),
    ).rejects.toThrow("invalid-event-prize-assignment");
    await expect(client.transactPath(targetPath, updater)).rejects.toThrow(
      "invalid-event-prize-assignment",
    );
    for (const path of [
      "profileEventPrizes/profile-two",
      `${targetPath}/prizeId`,
      "profileEventPrizes/profile-two/other-event",
      `events/${eventId}`,
    ]) {
      expect(() =>
        client.transactStoredProfileEventPrizeWithEventLease(
          path,
          updater,
          guard,
        ),
      ).toThrow("event-lock-guard-path-unsupported");
    }
    await expect(
      client.transactStoredProfileEventPrizeWithEventLease(
        targetPath,
        updater,
        guard,
      ),
    ).resolves.toMatchObject({ committed: true, value: targetAssignment });
    expect(await client.getPath(targetPath)).toEqual(targetAssignment);
  });

  it("atomically rejects stored prize writes after a D1 event lease is replaced or expired", async () => {
    const client = createEventRtdbClient(testEnv, {
      getPath: async () => null,
      patchRoot: async () => undefined,
      transactPath: async () => ({ committed: false, value: null }),
    });
    await client.patchRoot({ [`events/${eventId}`]: eventRecord() });
    const lockPath = `eventLocks/${eventId}`;
    const targetPath = `profileEventPrizes/profile-two/${eventId}`;
    const nowMs = Date.now();
    const originalLock = {
      lockId: "original-lock",
      ownerUid: "original-owner",
      acquiredAtMs: nowMs,
      refreshedAtMs: nowMs,
      expiresAtMs: nowMs + 30_000,
    };
    const guard = {
      eventId,
      lockId: originalLock.lockId,
      lockRoot: "eventLocks",
      ownerUid: originalLock.ownerUid,
    };
    const writePrize = () =>
      client.transactStoredProfileEventPrizeWithEventLease(
        targetPath,
        () => ({
          value: {
            eventId,
            profileId: "profile-two",
            place: 1,
            prizeId: "retired-prize",
            assignedAtMs: 2_000,
          },
        }),
        guard,
      );
    await client.transactPath(lockPath, () => ({ value: originalLock }));
    await client.transactPath(lockPath, () => ({
      value: { ...originalLock, lockId: "successor-lock" },
    }));
    await expect(writePrize()).rejects.toThrow("event-d1-conflict");
    expect(await readEventOwnedPath(testEnv.EVENT_DB, targetPath)).toBeNull();

    await client.transactPath(lockPath, () => ({
      value: {
        ...originalLock,
        acquiredAtMs: nowMs - 2_000,
        refreshedAtMs: nowMs - 2_000,
        expiresAtMs: nowMs - 1_000,
      },
    }));
    await expect(writePrize()).rejects.toThrow("event-d1-conflict");
    expect(await readEventOwnedPath(testEnv.EVENT_DB, targetPath)).toBeNull();
  });

  it("delegates unrelated RTDB operations even while event storage is frozen", async () => {
    const calls: string[] = [];
    const client = createEventRtdbClient(testEnv, {
      getPath: async (path) => {
        calls.push(`get:${path}`);
        return { ok: true };
      },
      patchRoot: async (updates) => {
        calls.push(`patch:${Object.keys(updates).join(",")}`);
      },
      transactPath: async (path, updater) => {
        calls.push(`transact:${path}`);
        const decision = updater(null) as { value?: unknown };
        return { committed: true, value: decision.value ?? null };
      },
    });
    await transitionEventStorageMode(testEnv.EVENT_DB, {
      expected: { storageMode: "d1" },
      next: { storageMode: "frozen" },
      nowMs: 10,
    });
    try {
      await expect(client.getPath(`events/${eventId}`)).resolves.toBeNull();
      await expect(
        client.patchRoot({ [`events/${eventId}`]: eventRecord() }),
      ).rejects.toThrow("event-writes-disabled");
      await expect(client.getPath("invites/invite-one")).resolves.toEqual({
        ok: true,
      });
      await client.patchRoot({ "players/login-one/matches/match-one": {} });
      await expect(
        client.transactPath("automatch/invite-one", () => ({ value: {} })),
      ).resolves.toMatchObject({ committed: true });
    } finally {
      await transitionEventStorageMode(testEnv.EVENT_DB, {
        expected: { storageMode: "frozen" },
        next: { storageMode: "d1" },
        nowMs: 11,
      });
    }
    expect(calls).toEqual([
      "get:invites/invite-one",
      "patch:players/login-one/matches/match-one",
      "transact:automatch/invite-one",
    ]);
  });
});
