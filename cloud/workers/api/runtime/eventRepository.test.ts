import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { resetMatchPresentationTestState } from "./matchPresentationTestFixture.ts";
import type { D1Migration } from "cloudflare:test";
import { applyStrictMatchStateTestMigrations } from "./strictMatchStateTestFixture.ts";
import {
  applyEventTestMigrations,
  transitionEventStorageMode,
} from "./eventTestMigrations.ts";
import {
  acquireEventWriteAdmission,
  createEventTransitionIntent,
  listPendingEventTransitionIntents,
  readEventOwnedPath,
  readEventSnapshot,
  releaseEventWriteAdmission,
  type EventTransitionIntent,
  type EventWriteAdmission,
} from "../src/eventD1.ts";
import {
  createD1AuthRecoveryPrizeStore,
  createEventStateRepository,
} from "../src/eventRepository.ts";
import { prepareInviteEventIntent } from "../src/inviteEventEffects.ts";
import {
  ensureEventTransitionReceipt,
  readEventTransitionReceipt,
} from "../src/eventTransitionReceiptsD1.ts";
import {
  eventTransitionFixture,
  resetEventReceiptTestState,
} from "./eventTransitionTestFixture.ts";
import { processEventProfileGameProjection } from "../src/profileGameProjection.ts";
import { buildEventProfileGameProjectionOutboxUpdates } from "../src/profileGameProjectionOutbox.ts";
import { sweepEventTelegramProjections } from "../src/eventTelegramProjection.ts";
import type { TelegramProjectionTask } from "../src/telegramProjectionTasks.ts";

const testEnv = env as Env & {
  TEST_D1_MIGRATIONS: D1Migration[];
  TEST_EVENT_D1_MIGRATIONS: D1Migration[];
};
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

async function createPendingIntent(
  intent: Extract<EventTransitionIntent, { schemaVersion: 1 }>,
): Promise<Extract<EventTransitionIntent, { schemaVersion: 2 }>> {
  const prepared = await prepareInviteEventIntent(
    testEnv.PROFILE_GAMES_DB,
    intent,
  );
  await withD1Admission((admission) =>
    createEventTransitionIntent(testEnv.EVENT_DB, prepared, { admission }),
  );
  return prepared;
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
    await applyStrictMatchStateTestMigrations(
      testEnv.PROFILE_GAMES_DB,
      testEnv.TEST_D1_MIGRATIONS,
    );
    await applyEventTestMigrations(
      testEnv.EVENT_DB,
      testEnv.TEST_EVENT_D1_MIGRATIONS,
    );
  });

  beforeEach(async () => {
    await resetMatchPresentationTestState(
      testEnv.PROFILE_GAMES_DB,
      testEnv.TEST_D1_MIGRATIONS,
      "durable",
    );
    await testEnv.PROFILE_GAMES_DB.batch([
      testEnv.PROFILE_GAMES_DB.prepare("DELETE FROM invite_sources"),
      testEnv.PROFILE_GAMES_DB.prepare(
        "DELETE FROM invite_event_effect_receipts",
      ),
      testEnv.PROFILE_GAMES_DB.prepare("DELETE FROM login_match_discovery"),
      testEnv.PROFILE_GAMES_DB.prepare(
        "DELETE FROM invite_source_write_admissions",
      ),
      testEnv.PROFILE_GAMES_DB.prepare(
        `UPDATE invite_source_control SET backend = 'd1', state = 'active',
         epoch = 1, freeze_generation = 1, verified_at_ms = 1,
         activated_at_ms = 2 WHERE singleton = 1`,
      ),
    ]);
    await resetEventReceiptTestState(
      testEnv.PROFILE_GAMES_DB,
      testEnv.TEST_D1_MIGRATIONS,
    );
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
      const client = createEventStateRepository(testEnv, {
        getPath: async () => null,
        patchRoot: async (updates) => {
          effects.push(updates);
        },
        transactPath: async () => ({ committed: false, value: null }),
      });
      const update = { [`events/${eventId}`]: eventRecord() };
      await expect(client.patchRoot(update)).resolves.toBeUndefined();
      expect(effects).toEqual([]);
      const failedClient = createEventStateRepository(testEnv, {
        getPath: async () => null,
        patchRoot: async () => {
          throw new Error("state-write-failed");
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

  it("publishes event projection metadata without a legacy mirror", async () => {
    const effects: Record<string, unknown>[] = [];
    const client = createEventStateRepository(testEnv, {
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
    const client = createEventStateRepository(testEnv, {
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
    const client = createEventStateRepository(testEnv, {
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
    const firstRead = await client.listProfileEventPrizeAssignments(profileId, {
      limit: assignments.length,
    });
    expect(Object.keys(firstRead)).toEqual(binaryOrder);

    const prizeStore = createD1AuthRecoveryPrizeStore(testEnv.EVENT_DB);
    const collected: string[] = [];
    let cursor = "";
    while (true) {
      const result = await prizeStore.listProfileEventPrizeAssignments(
        profileId,
        {
          ...(cursor ? { startAt: cursor } : {}),
          limit: cursor ? 4 : 3,
        },
      );
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

  it("serves typed event and prize reads without the generic state backend", async () => {
    const genericRead = vi.fn(async () => {
      throw new Error("typed-event-read-must-not-use-generic-backend");
    });
    const client = createEventStateRepository(testEnv, {
      getPath: genericRead,
      patchRoot: async () => undefined,
      transactPath: async () => ({ committed: false, value: null }),
    });
    const profileId = "profile-one";
    const assignment = {
      profileId,
      eventId,
      place: 1,
      prizeId: "1092",
      assignedAtMs: 100,
    };
    await client.patchRoot({
      [`events/${eventId}`]: eventRecord(),
      [`eventPrizeSelections/${eventId}/${profileId}`]: "1092",
      [`profileEventPrizes/${profileId}/${eventId}`]: assignment,
    });
    await expect(client.readEvent(eventId)).resolves.toEqual(eventRecord());
    await expect(client.readEventPrizeSelections(eventId)).resolves.toEqual({
      [profileId]: "1092",
    });
    await expect(client.readEventSnapshot(eventId)).resolves.toEqual({
      eventId,
      event: eventRecord(),
      prizeSelections: { [profileId]: "1092" },
      revision: 1,
    });
    await expect(client.readProfileEventPrizes(profileId)).resolves.toEqual({
      profileId,
      prizes: { [eventId]: assignment },
      revision: 1,
    });
    await expect(client.listEventsByStatus("scheduled", 1)).resolves.toEqual({
      [eventId]: eventRecord(),
    });
    await expect(client.listEventsByStatus("active")).resolves.toEqual({});
    const prizeStore = createD1AuthRecoveryPrizeStore(testEnv.EVENT_DB);
    await expect(
      prizeStore.readProfileEventPrizeAssignment(profileId, eventId),
    ).resolves.toEqual(assignment);
    await expect(
      prizeStore.listProfileEventPrizeAssignments(profileId, {
        startAt: eventId,
        limit: 1,
      }),
    ).resolves.toEqual({ [eventId]: assignment });
    expect(genericRead).not.toHaveBeenCalled();
  });

  it("replays a stored v2 intent with unchanged serialized effect keys and digest", async () => {
    const f = eventTransitionFixture(testEnv);
    const timerPath = "players/login-one/matches/event-match/timer";
    await f.client.patchRoot({ [`events/${eventId}`]: eventRecord() });
    const pending = await createPendingIntent({
      schemaVersion: 1,
      transitionId: "compatibility-transition",
      eventId,
      expectedRevision: 1,
      canonicalUpdates: {
        [`events/${eventId}/status`]: "active",
        [`events/${eventId}/updatedAtMs`]: 200,
      },
      rtdbEffects: { [timerPath]: "gg" },
      createdAtMs: 200,
      updatedAtMs: 200,
    });
    expect(pending.payloadDigest).toBe(
      "6d1ec90c315e871b8614f55297b3bfd28f27d2fd947db2e390f9e8e532f0f1ba",
    );
    const stored = await testEnv.EVENT_DB.prepare(
      "SELECT intent_json FROM event_transition_intents WHERE transition_id = ?",
    )
      .bind(pending.transitionId)
      .first<string>("intent_json");
    expect(stored).toContain(
      '"rtdbEffects":{"players/login-one/matches/event-match/timer":"gg"}',
    );
    expect(JSON.parse(stored!)).toEqual(pending);
    expect(await f.recover()).toBe(1);
    expect(f.values.get(timerPath)).toBe("gg");
    expect(
      await readEventTransitionReceipt(
        testEnv.PROFILE_GAMES_DB,
        pending.transitionId,
      ),
    ).toMatchObject({
      schemaVersion: 2,
      payloadDigest: pending.payloadDigest,
    });
    expect(await readEventSnapshot(testEnv.EVENT_DB, eventId)).toMatchObject({
      event: { status: "active", updatedAtMs: 200 },
      revision: 2,
    });
    expect(await f.recover()).toBe(0);
    expect(f.patches).toEqual([{ [timerPath]: "gg" }]);
  });

  it("recovers a failed match effect before publishing the D1 revision", async () => {
    const f = eventTransitionFixture(testEnv);
    const timerPath = "players/login-one/matches/event-match/timer";
    f.hooks.beforePatch = async () => {
      f.hooks.beforePatch = undefined;
      throw new Error("state-offline");
    };
    await f.client.patchRoot({ [`events/${eventId}`]: eventRecord() });
    const update = {
      [`events/${eventId}/status`]: "active",
      [`events/${eventId}/updatedAtMs`]: 200,
      [timerPath]: "gg",
    };
    await expect(f.client.patchRoot(update)).rejects.toThrow("state-offline");
    expect(
      await testEnv.EVENT_DB.prepare(
        "SELECT COUNT(*) AS count FROM event_write_admissions",
      ).first<number>("count"),
    ).toBe(0);
    expect(await readEventSnapshot(testEnv.EVENT_DB, eventId)).toMatchObject({
      event: { status: "scheduled" },
      revision: 1,
    });
    const [pending] = await listPendingEventTransitionIntents(testEnv.EVENT_DB);
    expect(pending.schemaVersion).toBe(2);
    await expect(
      f.client.patchRoot({ [`events/${eventId}/updatedAtMs`]: 150 }),
    ).rejects.toThrow("event-transition-pending");
    await f.client.patchRoot(update);
    expect(f.patches).toEqual([{ [timerPath]: "gg" }, { [timerPath]: "gg" }]);
    expect(
      await readEventTransitionReceipt(
        testEnv.PROFILE_GAMES_DB,
        pending.transitionId,
      ),
    ).toMatchObject({ schemaVersion: 2, eventId, expectedRevision: 1 });
    expect(await readEventSnapshot(testEnv.EVENT_DB, eventId)).toMatchObject({
      event: { status: "active", updatedAtMs: 200 },
      revision: 2,
    });
    expect(await listPendingEventTransitionIntents(testEnv.EVENT_DB)).toEqual(
      [],
    );
  });

  it("preserves advanced matches after an ambiguous creation commit", async () => {
    const f = eventTransitionFixture(testEnv);
    const matchPath = "players/login-one/matches/event-match";
    f.hooks.afterTransaction = async (path) => {
      if (path !== matchPath) return;
      f.hooks.afterTransaction = undefined;
      throw new Error("ambiguous-state-commit");
    };
    await f.client.patchRoot({ [`events/${eventId}`]: eventRecord() });
    await expect(
      f.client.patchRoot({
        [`events/${eventId}/status`]: "active",
        [`events/${eventId}/updatedAtMs`]: 200,
        "invites/event-match": {
          eventId,
          eventOwned: true,
          hostId: "login-one",
          guestId: "login-two",
        },
        [matchPath]: { fen: "initial", flatMovesString: "", color: "white" },
        "players/login-two/matches/event-match": {
          fen: "initial",
          flatMovesString: "",
          color: "black",
        },
      }),
    ).rejects.toThrow("ambiguous-state-commit");
    const stored = f.values.get(matchPath) as Record<string, unknown>;
    const advanced = {
      ...stored,
      fen: "advanced",
      flatMovesString: "l0,0;l1,1",
    };
    f.values.set(matchPath, advanced);
    await expect(f.recover()).resolves.toBe(1);
    expect(f.values.get(matchPath)).toEqual(advanced);
    expect(f.writes.filter((path) => path === matchPath)).toHaveLength(1);
    expect(await readEventSnapshot(testEnv.EVENT_DB, eventId)).toMatchObject({
      event: { status: "active", updatedAtMs: 200 },
      revision: 2,
    });
  });

  it("serializes duplicate transition applications before replaying effects", async () => {
    const f = eventTransitionFixture(testEnv);
    let continueEffects!: () => void;
    let markEffectsStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markEffectsStarted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      continueEffects = resolve;
    });
    f.hooks.beforePatch = async () => {
      markEffectsStarted();
      await gate;
    };
    await f.client.patchRoot({ [`events/${eventId}`]: eventRecord() });
    const update = {
      [`events/${eventId}/status`]: "active",
      "players/login-one/matches/serialized-transition/timer": "gg",
    };
    const first = f.client.patchRoot(update);
    await started;
    await expect(f.client.patchRoot(update)).rejects.toThrow(
      "event-transition-application-busy",
    );
    continueEffects();
    await expect(first).resolves.toBeUndefined();
    expect(f.patches).toHaveLength(1);
  });

  it("skips an intent that another recovery committed after it was listed", async () => {
    const f = eventTransitionFixture(testEnv);
    const otherEventId = "eVKpl6f9aBI";
    for (const [transitionId, targetEventId] of [
      ["a-stale-transition", eventId],
      ["b-stale-transition", otherEventId],
    ] as const) {
      await f.client.patchRoot({
        [`events/${targetEventId}`]: eventRecord("scheduled", targetEventId),
      });
      await createPendingIntent({
        schemaVersion: 1,
        transitionId,
        eventId: targetEventId,
        expectedRevision: 1,
        rtdbEffects: {
          [`players/login-one/matches/${transitionId}/timer`]: "gg",
        },
        canonicalUpdates: { [`events/${targetEventId}/status`]: "active" },
        createdAtMs: 200,
        updatedAtMs: 200,
      });
    }
    let nestedRecoveryStarted = false;
    f.hooks.beforePatch = async () => {
      if (nestedRecoveryStarted) return;
      nestedRecoveryStarted = true;
      await expect(f.recover()).rejects.toThrow(
        "event-transition-recovery-failed",
      );
    };
    await expect(f.recover()).resolves.toBe(2);
    expect(nestedRecoveryStarted).toBe(true);
    expect(
      f.patches.filter((updates) =>
        Object.hasOwn(
          updates,
          "players/login-one/matches/b-stale-transition/timer",
        ),
      ),
    ).toHaveLength(1);
    expect(await listPendingEventTransitionIntents(testEnv.EVENT_DB)).toEqual(
      [],
    );
    for (const targetEventId of [eventId, otherEventId]) {
      expect(
        await readEventSnapshot(testEnv.EVENT_DB, targetEventId),
      ).toMatchObject({
        event: { status: "active" },
        revision: 2,
      });
    }
  });

  it("fails closed on a conflicting D1 transition receipt", async () => {
    const f = eventTransitionFixture(testEnv);
    await f.client.patchRoot({ [`events/${eventId}`]: eventRecord() });
    const intent = await createPendingIntent({
      schemaVersion: 1,
      transitionId: "conflicting-receipt",
      eventId,
      expectedRevision: 1,
      rtdbEffects: {
        "players/login-one/matches/conflicting-receipt/timer": "gg",
      },
      canonicalUpdates: { [`events/${eventId}/status`]: "active" },
      createdAtMs: 200,
      updatedAtMs: 200,
    });
    await ensureEventTransitionReceipt(
      testEnv.PROFILE_GAMES_DB,
      {
        schemaVersion: 2,
        transitionId: intent.transitionId,
        eventId: "another-event",
        expectedRevision: 1,
        payloadDigest: intent.payloadDigest,
      },
      { recordedAtMs: 200, guards: () => [] },
    );
    await expect(f.recover()).rejects.toThrow(
      "event-transition-recovery-failed",
    );
    expect(f.patches).toEqual([]);
    expect(await listPendingEventTransitionIntents(testEnv.EVENT_DB)).toEqual([
      expect.objectContaining({
        transitionId: intent.transitionId,
        attempts: 1,
      }),
    ]);
  });

  it("isolates transition recovery failures while keeping poison intents fenced", async () => {
    const f = eventTransitionFixture(testEnv);
    const otherEventId = "eVKpl6f9aBI";
    for (const [transitionId, targetEventId] of [
      ["a-failing-transition", eventId],
      ["b-working-transition", otherEventId],
    ] as const) {
      await f.client.patchRoot({
        [`events/${targetEventId}`]: eventRecord("scheduled", targetEventId),
      });
      await createPendingIntent({
        schemaVersion: 1,
        transitionId,
        eventId: targetEventId,
        expectedRevision: 1,
        rtdbEffects: {
          [`players/login-one/matches/${transitionId}/timer`]: "gg",
        },
        canonicalUpdates: { [`events/${targetEventId}/status`]: "active" },
        createdAtMs: 200,
        updatedAtMs: 200,
      });
    }
    f.hooks.beforePatch = async (updates) => {
      if (
        Object.hasOwn(
          updates,
          "players/login-one/matches/a-failing-transition/timer",
        )
      ) {
        throw new Error("state-offline");
      }
    };
    await expect(f.recover()).rejects.toThrow(
      "event-transition-recovery-failed",
    );
    expect(
      await readEventSnapshot(testEnv.EVENT_DB, otherEventId),
    ).toMatchObject({
      event: { status: "active" },
      revision: 2,
    });
    expect(await listPendingEventTransitionIntents(testEnv.EVENT_DB)).toEqual([
      expect.objectContaining({
        transitionId: "a-failing-transition",
        attempts: 1,
      }),
    ]);
    await expect(f.recover()).rejects.toThrow(
      "event-transition-recovery-failed",
    );
    expect(await listPendingEventTransitionIntents(testEnv.EVENT_DB)).toEqual([
      expect.objectContaining({
        transitionId: "a-failing-transition",
        attempts: 2,
      }),
    ]);
    await expect(
      f.client.patchRoot({ [`events/${eventId}/updatedAtMs`]: 300 }),
    ).rejects.toThrow("event-transition-pending");
    expect(await readEventSnapshot(testEnv.EVENT_DB, eventId)).toMatchObject({
      event: { status: "scheduled" },
      revision: 1,
    });
  });

  it("holds a durable admission while replaying match effects", async () => {
    const f = eventTransitionFixture(testEnv);
    await f.client.patchRoot({ [`events/${eventId}`]: eventRecord() });
    await createPendingIntent({
      schemaVersion: 1,
      transitionId: "admitted-recovery",
      eventId,
      expectedRevision: 1,
      rtdbEffects: {
        "players/login-one/matches/admitted-recovery/timer": "gg",
      },
      canonicalUpdates: { [`events/${eventId}/status`]: "active" },
      createdAtMs: 200,
      updatedAtMs: 200,
    });
    let finishReplay!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const pending = new Promise<void>((resolve) => {
      finishReplay = resolve;
    });
    f.hooks.beforePatch = async () => {
      markStarted();
      await pending;
    };
    const recovery = f.recover();
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

  it("publishes mixed progress outboxes and timer effects with a D1 receipt", async () => {
    const f = eventTransitionFixture(testEnv);
    await f.client.patchRoot({ [`events/${eventId}`]: eventRecord() });
    const outbox = {
      schemaVersion: 1,
      eventId,
      sourceKey: "timer:invite-one:match-one",
      reason: "timer-claimed",
      runAtMs: null,
      firstQueuedAtMs: 100,
      lastQueuedAtMs: 100,
    };
    await f.client.patchRoot({
      "eventProgressOutbox/progress-mixed": outbox,
      "matchTimerStarts/login-one/match-one": null,
    });
    expect(f.patches).toEqual([
      { "matchTimerStarts/login-one/match-one": null },
    ]);
    const row = await testEnv.PROFILE_GAMES_DB.prepare(
      "SELECT receipt_json FROM event_transition_receipts",
    ).first<string>("receipt_json");
    expect(JSON.parse(row!)).toMatchObject({
      eventId,
      expectedRevision: 1,
      schemaVersion: 2,
    });
    expect(
      await readEventOwnedPath(
        testEnv.EVENT_DB,
        "eventProgressOutbox/progress-mixed",
      ),
    ).toEqual(outbox);
  });

  it("never delegates retained Firebase receipt paths for reads or mutations", async () => {
    const getPath = vi.fn(async () => null);
    const patchRoot = vi.fn(async () => undefined);
    const transactPath = vi.fn(async () => ({ committed: false, value: null }));
    const client = createEventStateRepository(testEnv, {
      getPath,
      patchRoot,
      transactPath,
    });
    for (const path of [
      "eventTransitionReceipts",
      "/eventTransitionReceipts/receipt/expectedRevision/",
    ]) {
      await expect(client.getPath(path)).rejects.toThrow(
        "event-transition-receipt-path-reserved",
      );
      await expect(client.patchRoot({ [path]: null })).rejects.toThrow(
        "event-transition-receipt-path-reserved",
      );
      await expect(
        client.patchRoot({ [`events/${eventId}`]: eventRecord(), [path]: {} }),
      ).rejects.toThrow("event-transition-receipt-path-reserved");
      await expect(
        client.transactPath(path, () => ({ value: {} })),
      ).rejects.toThrow("event-transition-receipt-path-reserved");
    }
    expect(getPath).not.toHaveBeenCalled();
    expect(patchRoot).not.toHaveBeenCalled();
    expect(transactPath).not.toHaveBeenCalled();
  });

  it("processes event profile-game projections with the shared lease schema", async () => {
    const client = createEventStateRepository(testEnv, {
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
          getStatePath: client.getPath,
          readInviteMetadata: async () => {
            throw new Error("unexpected-invite-metadata-read");
          },
          transactStatePath: client.transactPath,
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
    const client = createEventStateRepository(testEnv, {
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

  it("restricts the D1 auth recovery store to prize reads and event leases", async () => {
    const store = createD1AuthRecoveryPrizeStore(testEnv.EVENT_DB);
    const unsupportedPaths = [
      "players/login/matches/match",
      `events/${eventId}`,
      "profileEventPrizes",
      `profileEventPrizes/profile-one/${eventId}/prizeId`,
    ];
    for (const path of unsupportedPaths) {
      await expect(store.getPath(path)).rejects.toThrow(
        "auth-recovery-prize-path-unsupported",
      );
      await expect(
        store.transactPath(path, () => ({ value: null })),
      ).rejects.toThrow("auth-recovery-prize-path-unsupported");
    }
    await expect(
      store.transactPath(`profileEventPrizes/profile-one/${eventId}`, () => ({
        value: null,
      })),
    ).rejects.toThrow("auth-recovery-prize-path-unsupported");
    await expect(
      store.getPath("profileEventPrizes/profile-one", { orderBy: "prizeId" }),
    ).rejects.toThrow("event-d1-query-unsupported");
    await expect(
      store.getPath(`profileEventPrizes/profile-one/${eventId}`, {
        orderBy: "$key",
      }),
    ).rejects.toThrow("event-d1-query-unsupported");
    expect(
      await store.getPath("profileEventPrizes/profile-one", {
        orderBy: "$key",
        limitToFirst: 2,
      }),
    ).toEqual({});
    expect(
      await store.getPath(`profileEventPrizes/profile-one/${eventId}`),
    ).toBeNull();
    expect(
      await testEnv.EVENT_DB.prepare(
        "SELECT COUNT(*) AS count FROM event_write_admissions",
      ).first<number>("count"),
    ).toBe(0);
  });

  it("copies stored retired prizes under an event lease while ordinary writes remain strict", async () => {
    const client = createEventStateRepository(testEnv, {
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
    const client = createEventStateRepository(testEnv, {
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

  it("delegates unrelated state operations even while event storage is frozen", async () => {
    const calls: string[] = [];
    const client = createEventStateRepository(testEnv, {
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
      await client.patchRoot({
        "players/login-one/matches/match-one/timer": "",
      });
      await client.patchRoot({
        "players/login-one/matches/match-one": { fen: "initial" },
        "gameplayMutationReceipts/operation-one": { inviteId: "match-one" },
      });
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
      "patch:players/login-one/matches/match-one/timer",
      "patch:players/login-one/matches/match-one,gameplayMutationReceipts/operation-one",
      "transact:automatch/invite-one",
    ]);
  });
});
