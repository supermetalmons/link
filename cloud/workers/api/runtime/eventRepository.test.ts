import { captureLoginMatchDiscovery } from "../src/loginMatchDiscoveryD1.ts";
import { decodeEventUpdates } from "../src/eventCompatibilityCodec.ts";
import {
  eventMatchTestPort,
  readEventRepositoryFixture,
  transactEventRepositoryFixture,
} from "./eventRepositoryFixture.ts";
import { readEventOwnedPath } from "./eventD1Fixture.ts";
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
  readEventSnapshot,
  releaseEventWriteAdmission,
  type EventTransitionIntent,
  type EventWriteAdmission,
} from "../src/eventD1.ts";
import {
  createD1AuthRecoveryPrizeStore,
  createEventGameplayRepository,
  createEventStateRepository,
  recoverEventTransitionIntents,
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
import { buildEventProfileGameProjectionOutboxUpdates } from "../test/legacyProjectionOutboxFixture.ts";
import { sweepEventTelegramProjections } from "../src/eventTelegramProjection.ts";
import type { TelegramProjectionTask } from "../src/telegramProjectionTasks.ts";

const testEnv = env as Env & {
  TEST_D1_MIGRATIONS: D1Migration[];
  TEST_EVENT_D1_MIGRATIONS: D1Migration[];
};
const eventId = "NN3eRzoZo80";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function notificationEnv(
  notify: (inviteId: string, matchIds?: string[]) => Promise<void>,
) {
  return {
    ...testEnv,
    INVITE_REACTIONS: {
      getByName: () => ({
        notifyMatchesChanged: notify,
        notifyMetadataChanged: notify,
        notifyWagersChanged: notify,
      }),
    } as unknown as Env["INVITE_REACTIONS"],
  };
}

function methodNotificationEnv(
  notify: (
    method: "metadata" | "matches" | "wagers",
    inviteId: string,
    matchIds?: string[],
  ) => Promise<void>,
): Env {
  return {
    ...testEnv,
    INVITE_REACTIONS: new Proxy(testEnv.INVITE_REACTIONS, {
      get(target, property) {
        if (property === "getByName") {
          return (name: string) =>
            new Proxy(target.getByName(name), {
              get(room, method) {
                if (method === "notifyMetadataChanged")
                  return (inviteId: string) => notify("metadata", inviteId);
                if (method === "notifyMatchesChanged")
                  return (inviteId: string, matchIds?: string[]) =>
                    notify("matches", inviteId, matchIds);
                if (method === "notifyWagersChanged")
                  return (inviteId: string) => notify("wagers", inviteId);
                const member = Reflect.get(room, method, room);
                return typeof member === "function"
                  ? (...args: unknown[]) => Reflect.apply(member, room, args)
                  : member;
              },
            });
        }
        const member = Reflect.get(target, property, target);
        return typeof member === "function" ? member.bind(target) : member;
      },
    }),
  };
}

function notificationCreationEffects() {
  return {
    "invites/event-match": {
      eventId,
      eventOwned: true,
      hostId: "login-one",
      guestId: "login-two",
    },
    "players/login-one/matches/event-match": {
      fen: "initial",
      flatMovesString: "",
      color: "white",
    },
    "players/login-two/matches/event-match": {
      fen: "initial",
      flatMovesString: "",
      color: "black",
    },
  };
}

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

describe("typed event repository", () => {
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
    await captureLoginMatchDiscovery(
      testEnv.PROFILE_GAMES_DB,
      [
        "event-match",
        "serialized-transition",
        "a-stale-transition",
        "b-stale-transition",
        "conflicting-receipt",
        "a-failing-transition",
        "b-working-transition",
        "admitted-recovery",
      ].map((matchId) => ({
        loginUid: "login-one",
        matchId,
        inviteId: matchId,
      })),
      100,
    );
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

  it("retains malformed canonical intents without applying their effect entries", async () => {
    const fixture = eventTransitionFixture(testEnv);
    await fixture.client.commitEventPlan([
      { kind: "event", eventId, value: eventRecord() },
    ]);
    const before = await readEventSnapshot(testEnv.EVENT_DB, eventId);
    const canonicalUpdates = {
      [`events/${eventId}/status`]: "active",
      "players/host/matches/poison/timer": "gg",
    };
    const intent = await createPendingIntent({
      schemaVersion: 1,
      transitionId: "malformed-canonical-effect",
      eventId,
      expectedRevision: before.revision,
      canonicalUpdates,
      rtdbEffects: {},
      createdAtMs: 200,
      updatedAtMs: 200,
    });
    await expect(fixture.recover()).rejects.toThrow(
      "event-transition-recovery-failed",
    );
    expect(await readEventSnapshot(testEnv.EVENT_DB, eventId)).toEqual(before);
    expect(fixture.writes).toEqual([]);
    expect(
      await readEventTransitionReceipt(
        testEnv.PROFILE_GAMES_DB,
        intent.transitionId,
      ),
    ).toBeNull();
    expect(
      await testEnv.PROFILE_GAMES_DB.prepare(
        "SELECT COUNT(*) AS count FROM invite_event_effect_receipts WHERE transition_id = ?",
      )
        .bind(intent.transitionId)
        .first<number>("count"),
    ).toBe(0);
    const pending = await listPendingEventTransitionIntents(testEnv.EVENT_DB);
    expect(pending).toHaveLength(1);
    expect(pending[0].canonicalUpdates).toEqual(canonicalUpdates);
    expect(pending[0].transitionId).toBe(intent.transitionId);
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
      const client = createEventStateRepository(
        testEnv,
        eventMatchTestPort({
          getPath: async () => null,
          patchRoot: async (updates) => {
            effects.push(updates);
          },
          transactPath: async () => ({ committed: false, value: null }),
        }),
      );
      const update = { [`events/${eventId}`]: eventRecord() };
      await expect(
        client.commitEventPlan(decodeEventUpdates(update)),
      ).resolves.toBeUndefined();
      expect(effects).toEqual([]);
      const failedClient = createEventStateRepository(
        testEnv,
        eventMatchTestPort({
          getPath: async () => null,
          patchRoot: async () => {
            throw new Error("state-write-failed");
          },
          transactPath: async () => ({ committed: false, value: null }),
        }),
      );
      await expect(
        failedClient.commitEventPlan(
          decodeEventUpdates({
            [`events/${eventId}`]: { ...eventRecord(), status: "invalid" },
          }),
        ),
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
    const client = createEventStateRepository(
      testEnv,
      eventMatchTestPort({
        getPath: async () => null,
        patchRoot: async (updates) => {
          effects.push(updates);
        },
        transactPath: async () => ({ committed: false, value: null }),
      }),
    );
    await client.commitEventPlan(
      decodeEventUpdates({
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
      }),
    );
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

  it.each([
    {
      kind: "progress",
      method: "listDueEventProgressOutboxes",
      path: "eventProgressOutbox",
      table: "event_progress_outboxes",
    },
    {
      kind: "profile-game",
      method: "listDueEventProfileGameProjectionOutboxes",
      path: "profileGameProjectionOutbox/event",
      table: "event_profile_game_projection_outboxes",
    },
    {
      kind: "telegram",
      method: "listDueEventTelegramProjectionOutboxes",
      path: "telegramProjectionOutbox/event",
      table: "event_telegram_projection_outboxes",
    },
  ] as const)(
    "lists raw due $kind outboxes through both event repositories",
    async ({ kind, method, path, table }) => {
      const getPath = vi.fn(async () => null);
      const client = createEventStateRepository(
        testEnv,
        eventMatchTestPort({
          getPath,
          patchRoot: async () => undefined,
          transactPath: async () => ({ committed: false, value: null }),
        }),
      );
      const rows = [
        { id: "NN3eRzoZo80", timestamp: 200 },
        { id: "VOxalSrexcA", timestamp: 100 },
        { id: "FRkdorMWaYW", timestamp: 100 },
        { id: "oXAceF6anag", timestamp: 201 },
        { id: "RpPjMNyrJJa", timestamp: 50 },
      ].map(({ id, timestamp }) => ({
        id,
        record:
          kind === "progress"
            ? {
                schemaVersion: 1,
                eventId: id,
                sourceKey: `start:${id}:1000`,
                reason: "scheduled-start",
                runAtMs: 1_000,
                firstQueuedAtMs: timestamp,
                lastQueuedAtMs: timestamp,
              }
            : kind === "profile-game"
              ? {
                  schemaVersion: 1,
                  status: "pending",
                  requestId: `request-${id}`,
                  lastQueuedAtMs: timestamp,
                  cleanupOwnerProfileIds: {},
                }
              : {
                  schemaVersion: 1,
                  status: "pending",
                  requestId: `request-${id}`,
                  firstQueuedAtMs: timestamp,
                  updatedAtMs: timestamp,
                },
      }));
      await client.commitEventPlan(
        decodeEventUpdates(
          Object.fromEntries(
            rows.flatMap(({ id, record }) => [
              [`events/${id}`, eventRecord("scheduled", id)],
              [`${path}/${id}`, record],
            ]),
          ),
        ),
      );
      const malformed = { status: "pending", unrecognized: "raw-record" };
      await testEnv.EVENT_DB.batch([
        testEnv.EVENT_DB.prepare(
          `UPDATE ${table} SET record_json = ? WHERE event_id = ?`,
        ).bind(JSON.stringify(malformed), rows[2].id),
        testEnv.EVENT_DB.prepare(
          `UPDATE ${table} SET status = 'dead' WHERE event_id = ?`,
        ).bind(rows[4].id),
      ]);
      const entries = [rows[2], rows[1], rows[0], rows[3]].map((row) => ({
        ...(kind === "progress" ? { outboxId: row.id } : { eventId: row.id }),
        record: row.id === rows[2].id ? malformed : row.record,
      }));

      for (const repository of [
        client,
        createEventGameplayRepository(testEnv),
      ]) {
        await expect(repository[method](99)).resolves.toEqual([]);
        await expect(repository[method](100)).resolves.toEqual(
          entries.slice(0, 2),
        );
        await expect(repository[method](200)).resolves.toEqual(
          entries.slice(0, 3),
        );
        await expect(repository[method](200, 1)).resolves.toEqual(
          entries.slice(0, 1),
        );
        await expect(
          repository[method](Number.MAX_SAFE_INTEGER),
        ).resolves.toEqual(entries);
      }
      expect(getPath).not.toHaveBeenCalled();
    },
  );

  it("rejects legacy outbox collection queries without base fallback", async () => {
    const getPath = vi.fn(async () => null);
    const client = createEventStateRepository(
      testEnv,
      eventMatchTestPort({
        getPath,
        patchRoot: async () => undefined,
        transactPath: async () => ({ committed: false, value: null }),
      }),
    );
    for (const path of [
      "eventProgressOutbox",
      "profileGameProjectionOutbox/event",
      "telegramProjectionOutbox/event",
    ]) {
      await expect(
        readEventRepositoryFixture(client, path, {
          endAt: 200,
          limitToFirst: 100,
        }),
      ).rejects.toThrow("event-d1-query-unsupported");
    }
    await expect(
      readEventRepositoryFixture(client, "profileGameProjectionOutbox/event", {
        orderBy: "lastQueuedAtMs",
        startAt: "",
        limitToFirst: 100,
      }),
    ).rejects.toThrow("event-d1-query-unsupported");
    expect(getPath).not.toHaveBeenCalled();
  });

  it("quarantines malformed Telegram outboxes in D1 mode", async () => {
    const client = createEventStateRepository(
      testEnv,
      eventMatchTestPort({
        getPath: async () => null,
        patchRoot: async () => undefined,
        transactPath: async () => ({ committed: false, value: null }),
      }),
    );
    await client.commitEventPlan(
      decodeEventUpdates({
        [`events/${eventId}`]: eventRecord(),
        [`telegramProjectionOutbox/event/${eventId}`]: {
          schemaVersion: 1,
          status: "pending",
          requestId: "request-one",
          firstQueuedAtMs: 100,
          updatedAtMs: 100,
        },
      }),
    );
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
      client.listDueEventTelegramProjectionOutboxes(200, 100),
    ).resolves.toEqual([]);
  });

  it("pages mixed-case profile prize IDs in binary cursor order", async () => {
    const client = createEventStateRepository(
      testEnv,
      eventMatchTestPort({
        getPath: async () => null,
        patchRoot: async () => undefined,
        transactPath: async () => ({ committed: false, value: null }),
      }),
    );
    const profileId = "source-profile";
    const assignments = [
      ["NN3eRzoZo80", "1092"],
      ["FRkdorMWaYW", "1866"],
      ["VOxalSrexcA", "282"],
      ["oXAceF6anag", "281"],
      ["RpPjMNyrJJa", "217"],
    ] as const;
    await client.commitEventPlan(
      decodeEventUpdates(
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
    const client = createEventStateRepository(
      testEnv,
      eventMatchTestPort({
        getPath: genericRead,
        patchRoot: async () => undefined,
        transactPath: async () => ({ committed: false, value: null }),
      }),
    );
    const profileId = "profile-one";
    const assignment = {
      profileId,
      eventId,
      place: 1,
      prizeId: "1092",
      assignedAtMs: 100,
    };
    await client.commitEventPlan(
      decodeEventUpdates({
        [`events/${eventId}`]: eventRecord(),
        [`eventPrizeSelections/${eventId}/${profileId}`]: "1092",
        [`profileEventPrizes/${profileId}/${eventId}`]: assignment,
      }),
    );
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
    await f.client.commitEventPlan(
      decodeEventUpdates({ [`events/${eventId}`]: eventRecord() }),
    );
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
    await f.client.commitEventPlan(
      decodeEventUpdates({ [`events/${eventId}`]: eventRecord() }),
    );
    const update = {
      [`events/${eventId}/status`]: "active",
      [`events/${eventId}/updatedAtMs`]: 200,
      [timerPath]: "gg",
    };
    await expect(
      f.client.commitEventPlan(decodeEventUpdates(update)),
    ).rejects.toThrow("state-offline");
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
      f.client.commitEventPlan(
        decodeEventUpdates({ [`events/${eventId}/updatedAtMs`]: 150 }),
      ),
    ).rejects.toThrow("event-transition-pending");
    await f.client.commitEventPlan(decodeEventUpdates(update));
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

  it.each(["scheduled", "awaited", "recovery"] as const)(
    "commits and releases transition admissions before %s notifications",
    async (mode) => {
      const started = deferred();
      const blocked = deferred();
      const notify = vi.fn(async () => {
        started.resolve();
        await blocked.promise;
      });
      const scopedEnv = notificationEnv(notify);
      const f = eventTransitionFixture(scopedEnv);
      const scheduled: Promise<void>[] = [];
      const client = createEventStateRepository(
        scopedEnv,
        f.raw,
        f.raw,
        undefined,
        mode === "scheduled"
          ? { schedule: (work) => scheduled.push(work) }
          : {},
      );
      await client.commitEventPlan([
        { kind: "event", eventId, value: eventRecord() },
      ]);
      const updates = {
        [`events/${eventId}/status`]: "active",
        "players/login-one/matches/event-match/timer": "gg",
      };
      if (mode === "recovery") {
        await createPendingIntent({
          schemaVersion: 1,
          transitionId: "post-commit-recovery",
          eventId,
          expectedRevision: 1,
          canonicalUpdates: { [`events/${eventId}/status`]: "active" },
          rtdbEffects: { "players/login-one/matches/event-match/timer": "gg" },
          createdAtMs: 200,
          updatedAtMs: 200,
        });
      }
      let completed = false;
      const work = (
        mode === "recovery"
          ? recoverEventTransitionIntents(scopedEnv, 100, f.raw)
          : client.commitEventPlan(decodeEventUpdates(updates))
      ).then(() => {
        completed = true;
      });
      try {
        await started.promise;
        expect(
          await readEventSnapshot(testEnv.EVENT_DB, eventId),
        ).toMatchObject({
          event: { status: "active" },
          revision: 2,
        });
        expect(
          await listPendingEventTransitionIntents(testEnv.EVENT_DB),
        ).toEqual([]);
        for (const table of ["event_write_admissions", "event_leases"]) {
          expect(
            await testEnv.EVENT_DB.prepare(
              `SELECT COUNT(*) AS count FROM ${table}`,
            ).first<number>("count"),
          ).toBe(0);
        }
        expect(
          await testEnv.PROFILE_GAMES_DB.prepare(
            "SELECT COUNT(*) AS count FROM invite_source_write_admissions",
          ).first<number>("count"),
        ).toBe(0);
        expect(
          f.values.get("players/login-one/matches/event-match/timer"),
        ).toBe("gg");
        if (mode === "scheduled") {
          await work;
          expect(scheduled).toHaveLength(1);
        } else {
          expect(completed).toBe(false);
          expect(scheduled).toEqual([]);
        }
      } finally {
        blocked.resolve();
        await work;
        await Promise.all(scheduled);
      }
      expect(notify).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["effects", "commit"] as const)(
    "retains pending recovery without notifying when %s fail",
    async (failure) => {
      const notify = vi.fn(async () => {});
      const scopedEnv = notificationEnv(notify);
      const f = eventTransitionFixture(scopedEnv);
      await f.client.commitEventPlan([
        { kind: "event", eventId, value: eventRecord() },
      ]);
      if (failure === "effects") {
        f.hooks.beforePatch = async () => {
          throw new Error("required-effects-failed");
        };
      } else {
        await testEnv.EVENT_DB.prepare(
          `CREATE TRIGGER event_notification_test_commit_failure
          BEFORE UPDATE ON event_records WHEN NEW.revision > OLD.revision
          BEGIN SELECT RAISE(ABORT, 'canonical-commit-failed'); END`,
        ).run();
      }
      try {
        await expect(
          f.client.commitEventPlan(
            decodeEventUpdates({
              [`events/${eventId}/status`]: "active",
              "players/login-one/matches/event-match/timer": "gg",
            }),
          ),
        ).rejects.toThrow();
        expect(notify).not.toHaveBeenCalled();
        expect(
          await readEventSnapshot(testEnv.EVENT_DB, eventId),
        ).toMatchObject({
          event: { status: "scheduled" },
          revision: 1,
        });
        expect(
          await listPendingEventTransitionIntents(testEnv.EVENT_DB),
        ).toHaveLength(1);
      } finally {
        f.hooks.beforePatch = undefined;
        if (failure === "commit")
          await testEnv.EVENT_DB.prepare(
            "DROP TRIGGER event_notification_test_commit_failure",
          ).run();
      }
      await expect(
        recoverEventTransitionIntents(scopedEnv, 100, f.raw),
      ).resolves.toBe(1);
      expect(notify).toHaveBeenCalledTimes(1);
      expect(await listPendingEventTransitionIntents(testEnv.EVENT_DB)).toEqual(
        [],
      );
    },
  );

  it.each(["failure", "timeout", "scheduler"] as const)(
    "preserves a successful mutation through notification %s",
    async (failure) => {
      const blocked = deferred();
      const notify = vi.fn(async () => {
        if (failure === "timeout") await blocked.promise;
        else throw new Error("notification-unavailable");
      });
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      const scopedEnv = notificationEnv(notify);
      const f = eventTransitionFixture(scopedEnv);
      const scheduled: Promise<void>[] = [];
      const client = createEventStateRepository(
        scopedEnv,
        f.raw,
        f.raw,
        undefined,
        {
          ...(failure === "scheduler"
            ? {
                schedule: (work: Promise<void>) => {
                  scheduled.push(work);
                  throw new Error("scheduler-unavailable");
                },
              }
            : {}),
        },
      );
      try {
        await client.commitEventPlan([
          { kind: "event", eventId, value: eventRecord() },
        ]);
        await expect(
          client.commitEventPlan(
            decodeEventUpdates({
              [`events/${eventId}/status`]: "active",
              "players/login-one/matches/event-match/timer": "gg",
            }),
          ),
        ).resolves.toBeUndefined();
        await Promise.all(scheduled);
        expect(
          await readEventSnapshot(testEnv.EVENT_DB, eventId),
        ).toMatchObject({
          event: { status: "active" },
          revision: 2,
        });
        expect(
          await listPendingEventTransitionIntents(testEnv.EVENT_DB),
        ).toEqual([]);
        expect(f.patches).toHaveLength(1);
        expect(notify).toHaveBeenCalledTimes(1);
      } finally {
        blocked.resolve();
        errors.mockRestore();
      }
    },
  );

  it.each(["commit", "recovery"] as const)(
    "deduplicates overlapping notifications while retaining uncovered matches after %s",
    async (mode) => {
      const notify = vi.fn(
        async (_method: string, _inviteId: string, _matchIds?: string[]) => {},
      );
      const scopedEnv = methodNotificationEnv(notify);
      const f = eventTransitionFixture(scopedEnv);
      const client = createEventStateRepository(scopedEnv, f.raw, f.raw);
      await client.commitEventPlan([
        { kind: "event", eventId, value: eventRecord() },
      ]);
      await captureLoginMatchDiscovery(
        testEnv.PROFILE_GAMES_DB,
        [
          { matchId: "event-match1", inviteId: "event-match" },
          { matchId: "claim-match", inviteId: "claim-invite" },
          { matchId: "terminal-match", inviteId: "terminal-invite" },
        ].map((route) => ({ ...route, loginUid: "login-one" })),
        100,
      );
      const claim = (inviteId: string) => ({
        inviteId,
        playerId: "login-one",
        opponentId: "login-two",
        status: "claimed",
        claimedAtMs: 200,
      });
      const effects = {
        ...notificationCreationEffects(),
        "matchTimerClaims/event-match1": claim("event-match"),
        "players/login-one/matches/event-match1/timer": "gg",
        "matchTimerClaims/claim-match": claim("claim-invite"),
        "players/login-one/matches/claim-match/timer": "gg",
        "players/login-one/matches/terminal-match/timer": "gg",
      };
      const canonicalUpdates = { [`events/${eventId}/status`]: "active" };
      if (mode === "recovery") {
        await createPendingIntent({
          schemaVersion: 1,
          transitionId: "deduplicated-notifications",
          eventId,
          expectedRevision: 1,
          canonicalUpdates,
          rtdbEffects: effects,
          createdAtMs: 200,
          updatedAtMs: 200,
        });
        await expect(
          recoverEventTransitionIntents(scopedEnv, 100, f.raw),
        ).resolves.toBe(1);
      } else {
        await client.commitEventPlan(
          decodeEventUpdates({ ...canonicalUpdates, ...effects }),
        );
      }
      expect(notify.mock.calls).toEqual([
        ["metadata", "event-match"],
        ["matches", "claim-invite", undefined],
        ["matches", "terminal-invite", ["terminal-match"]],
      ]);
      expect(await readEventSnapshot(testEnv.EVENT_DB, eventId)).toMatchObject({
        event: { status: "active" },
        revision: 2,
      });
      expect(await listPendingEventTransitionIntents(testEnv.EVENT_DB)).toEqual(
        [],
      );
    },
  );

  it.each(["blocked", "rejected"] as const)(
    "dispatches known metadata independently of %s match discovery",
    async (failure) => {
      const lookupStarted = deferred();
      const releaseLookup = deferred();
      const notify = vi.fn(async (_method: string, _inviteId: string) => {});
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      const scopedEnv = methodNotificationEnv(notify);
      scopedEnv.PROFILE_GAMES_DB = new Proxy(testEnv.PROFILE_GAMES_DB, {
        get(target, property) {
          if (property === "withSession") {
            return (constraint?: string) => {
              const session = target.withSession(constraint);
              return new Proxy(session, {
                get(reader, method) {
                  if (method === "prepare") {
                    return (sql: string) => {
                      if (
                        sql ===
                        "SELECT invite_id, resolution FROM login_match_discovery WHERE login_uid = ? AND match_id = ?"
                      ) {
                        return {
                          bind: () => ({
                            first: async () => {
                              lookupStarted.resolve();
                              if (failure === "blocked")
                                await releaseLookup.promise;
                              throw new Error("discovery-unavailable");
                            },
                          }),
                        } as unknown as D1PreparedStatement;
                      }
                      return reader.prepare(sql);
                    };
                  }
                  const member = Reflect.get(reader, method, reader);
                  return typeof member === "function"
                    ? member.bind(reader)
                    : member;
                },
              });
            };
          }
          const member = Reflect.get(target, property, target);
          return typeof member === "function" ? member.bind(target) : member;
        },
      });
      const f = eventTransitionFixture(scopedEnv);
      const scheduled: Promise<void>[] = [];
      const client = createEventStateRepository(
        scopedEnv,
        f.raw,
        f.raw,
        undefined,
        { schedule: (work) => scheduled.push(work) },
      );
      try {
        await client.commitEventPlan([
          { kind: "event", eventId, value: eventRecord() },
        ]);
        await client.commitEventPlan(
          decodeEventUpdates({
            [`events/${eventId}/status`]: "active",
            ...notificationCreationEffects(),
          }),
        );
        await lookupStarted.promise;
        expect(notify.mock.calls).toEqual([["metadata", "event-match"]]);
        expect(
          await readEventSnapshot(testEnv.EVENT_DB, eventId),
        ).toMatchObject({
          event: { status: "active" },
          revision: 2,
        });
        expect(
          await listPendingEventTransitionIntents(testEnv.EVENT_DB),
        ).toEqual([]);
      } finally {
        releaseLookup.resolve();
        await Promise.all(scheduled);
        errors.mockRestore();
      }
      expect(notify.mock.calls).toEqual([["metadata", "event-match"]]);
    },
  );

  it("notifies timer claims using the invite route stored in the transition", async () => {
    const notify = vi.fn(async (_inviteId: string, _matchIds?: string[]) => {});
    const scopedEnv = notificationEnv(notify);
    const f = eventTransitionFixture(scopedEnv);
    await f.client.commitEventPlan([
      { kind: "event", eventId, value: eventRecord() },
    ]);
    const claim = {
      inviteId: "claim-invite",
      playerId: "login-one",
      opponentId: "login-two",
      status: "claimed",
      claimedAtMs: 200,
    };
    await createPendingIntent({
      schemaVersion: 1,
      transitionId: "claim-notification",
      eventId,
      expectedRevision: 1,
      canonicalUpdates: { [`events/${eventId}/status`]: "active" },
      rtdbEffects: { "matchTimerClaims/claim-match": claim },
      createdAtMs: 200,
      updatedAtMs: 200,
    });
    await expect(
      recoverEventTransitionIntents(scopedEnv, 100, f.raw),
    ).resolves.toBe(1);
    expect(notify).toHaveBeenCalledWith("claim-invite");
    expect(f.values.get("matchTimerClaims/claim-match")).toEqual(claim);
  });

  it("preserves advanced matches after an ambiguous creation commit", async () => {
    const f = eventTransitionFixture(testEnv);
    const matchPath = "players/login-one/matches/event-match";
    f.hooks.afterTransaction = async (path) => {
      if (path !== matchPath) return;
      f.hooks.afterTransaction = undefined;
      throw new Error("ambiguous-state-commit");
    };
    await f.client.commitEventPlan(
      decodeEventUpdates({ [`events/${eventId}`]: eventRecord() }),
    );
    await expect(
      f.client.commitEventPlan(
        decodeEventUpdates({
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
      ),
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
    await f.client.commitEventPlan(
      decodeEventUpdates({ [`events/${eventId}`]: eventRecord() }),
    );
    const update = {
      [`events/${eventId}/status`]: "active",
      "players/login-one/matches/serialized-transition/timer": "gg",
    };
    const first = f.client.commitEventPlan(decodeEventUpdates(update));
    await started;
    await expect(
      f.client.commitEventPlan(decodeEventUpdates(update)),
    ).rejects.toThrow("event-transition-application-busy");
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
      await f.client.commitEventPlan(
        decodeEventUpdates({
          [`events/${targetEventId}`]: eventRecord("scheduled", targetEventId),
        }),
      );
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
    await f.client.commitEventPlan(
      decodeEventUpdates({ [`events/${eventId}`]: eventRecord() }),
    );
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
      await f.client.commitEventPlan(
        decodeEventUpdates({
          [`events/${targetEventId}`]: eventRecord("scheduled", targetEventId),
        }),
      );
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
      f.client.commitEventPlan(
        decodeEventUpdates({ [`events/${eventId}/updatedAtMs`]: 300 }),
      ),
    ).rejects.toThrow("event-transition-pending");
    expect(await readEventSnapshot(testEnv.EVENT_DB, eventId)).toMatchObject({
      event: { status: "scheduled" },
      revision: 1,
    });
  });

  it("holds a durable admission while replaying match effects", async () => {
    const f = eventTransitionFixture(testEnv);
    await f.client.commitEventPlan(
      decodeEventUpdates({ [`events/${eventId}`]: eventRecord() }),
    );
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
    await testEnv.PROFILE_GAMES_DB.prepare(
      "INSERT INTO match_timer_starts(player_id,match_id,timer,turn_number,updated_at_ms) VALUES ('match-one','login-one','timer',0,100)",
    ).run();
    await f.client.commitEventPlan(
      decodeEventUpdates({ [`events/${eventId}`]: eventRecord() }),
    );
    const outbox = {
      schemaVersion: 1,
      eventId,
      sourceKey: "timer:invite-one:match-one",
      reason: "timer-claimed",
      runAtMs: null,
      firstQueuedAtMs: 100,
      lastQueuedAtMs: 100,
    };
    await f.client.commitEventPlan(
      decodeEventUpdates({
        "eventProgressOutbox/progress-mixed": outbox,
        "matchTimerStarts/login-one/match-one": null,
      }),
    );
    expect(f.patches).toEqual([]);
    expect(
      await testEnv.PROFILE_GAMES_DB.prepare(
        "SELECT COUNT(*) AS count FROM match_timer_starts WHERE player_id='match-one' AND match_id='login-one'",
      ).first<number>("count"),
    ).toBe(0);
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

  it("has no generic state methods and rejects receipt paths in the compatibility codec", () => {
    const client = createEventStateRepository(
      testEnv,
      eventMatchTestPort({
        getPath: async () => null,
        patchRoot: async () => {
          throw new Error("unexpected-write");
        },
        transactPath: async () => ({ committed: false, value: null }),
      }),
    );
    expect("getPath" in client).toBe(false);
    expect("patchRoot" in client).toBe(false);
    expect("transactPath" in client).toBe(false);
    for (const path of [
      "eventTransitionReceipts",
      "/eventTransitionReceipts/receipt/expectedRevision/",
    ]) {
      expect(() => decodeEventUpdates({ [path]: null })).toThrow(
        path.startsWith("/") ? "invalid-event-path" : "unsupported-event-path",
      );
      expect(() =>
        decodeEventUpdates({
          [`events/${eventId}`]: eventRecord(),
          [path]: {},
        }),
      ).toThrow(
        path.startsWith("/") ? "invalid-event-path" : "unsupported-event-path",
      );
    }
  });

  it("processes event profile-game projections with the shared lease schema", async () => {
    const client = createEventStateRepository(
      testEnv,
      eventMatchTestPort({
        getPath: async () => null,
        patchRoot: async () => undefined,
        transactPath: async () => ({ committed: false, value: null }),
      }),
    );
    await client.commitEventPlan(
      decodeEventUpdates({
        [`events/${eventId}`]: eventRecord(),
        [`profileGameProjectionOutbox/event/${eventId}`]: {
          schemaVersion: 1,
          status: "pending",
          requestId: "profile-request",
          lastQueuedAtMs: 100,
          cleanupOwnerProfileIds: {},
        },
      }),
    );
    await expect(
      client.listDueEventProfileGameProjectionOutboxes(100, 100),
    ).resolves.toEqual([
      {
        eventId,
        record: {
          schemaVersion: 1,
          status: "pending",
          requestId: "profile-request",
          lastQueuedAtMs: 100,
          cleanupOwnerProfileIds: {},
        },
      },
    ]);
    await expect(
      processEventProfileGameProjection(
        {
          kind: "event-profile-game-projection",
          eventId,
          requestId: "profile-request",
        },
        {
          readEventProfileGameProjectionOutbox:
            client.readEventProfileGameProjectionOutbox,
          transactEventProfileGameProjectionOutbox:
            client.transactEventProfileGameProjectionOutbox,
          transactEventLease: client.transactEventLease,
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
    const client = createEventStateRepository(
      testEnv,
      eventMatchTestPort({
        getPath: async () => null,
        patchRoot: async () => undefined,
        transactPath: async () => ({ committed: false, value: null }),
      }),
    );
    const lock = {
      lockId: "lock-one",
      ownerUid: "owner-one",
      acquiredAtMs: 100,
      refreshedAtMs: 100,
      expiresAtMs: 30_100,
    };
    await expect(
      transactEventRepositoryFixture(client, `eventLocks/${eventId}`, () => ({
        value: lock,
      })),
    ).resolves.toMatchObject({ committed: true, value: lock });
    await expect(
      transactEventRepositoryFixture(
        client,
        `eventTelegramProjectionLocks/${eventId}`,
        () => ({
          value: { ...lock, lockId: "telegram-lock" },
        }),
      ),
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

  it("restricts auth recovery capability to typed prize reads, guarded copies and event leases", async () => {
    const store = createD1AuthRecoveryPrizeStore(testEnv.EVENT_DB);
    expect(Object.keys(store).sort()).toEqual([
      "listProfileEventPrizeAssignments",
      "readProfileEventPrizeAssignment",
      "transactEventLease",
      "transactStoredProfileEventPrizeWithEventLease",
    ]);
    for (const kind of [
      "telegram-projection",
      "profile-game-projection",
      "transition",
    ] as const) {
      await expect(
        store.transactEventLease({ kind, id: eventId }, () => ({
          value: null,
        })),
      ).rejects.toThrow("auth-recovery-prize-path-unsupported");
    }
    expect(
      await store.listProfileEventPrizeAssignments("profile-one", { limit: 2 }),
    ).toEqual({});
    expect(
      await store.readProfileEventPrizeAssignment("profile-one", eventId),
    ).toBeNull();
    expect(
      await testEnv.EVENT_DB.prepare(
        "SELECT COUNT(*) AS count FROM event_write_admissions",
      ).first<number>("count"),
    ).toBe(0);
  });

  it("copies stored retired prizes under an event lease while ordinary writes remain strict", async () => {
    const client = createEventStateRepository(
      testEnv,
      eventMatchTestPort({
        getPath: async () => null,
        patchRoot: async () => undefined,
        transactPath: async () => ({ committed: false, value: null }),
      }),
    );
    await client.commitEventPlan(
      decodeEventUpdates({ [`events/${eventId}`]: eventRecord() }),
    );
    const sourceAssignment = {
      eventId,
      profileId: "profile-one",
      place: 1 as const,
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
      await readEventRepositoryFixture(
        client,
        `profileEventPrizes/profile-one/${eventId}`,
      ),
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
    await transactEventRepositoryFixture(
      client,
      `eventLocks/${eventId}`,
      () => ({
        value: {
          lockId: guard.lockId,
          ownerUid: guard.ownerUid,
          acquiredAtMs: nowMs,
          refreshedAtMs: nowMs,
          expiresAtMs: nowMs + 30_000,
        },
      }),
    );
    await expect(
      client.commitEventPlan(
        decodeEventUpdates({ [targetPath]: targetAssignment }),
      ),
    ).rejects.toThrow("invalid-event-prize-assignment");
    await expect(
      transactEventRepositoryFixture(client, targetPath, updater),
    ).rejects.toThrow("invalid-event-prize-assignment");
    expect(() =>
      client.transactStoredProfileEventPrizeWithEventLease(
        "profile-two",
        "other-event",
        updater,
        guard,
      ),
    ).toThrow("event-lock-guard-path-unsupported");
    await expect(
      client.transactStoredProfileEventPrizeWithEventLease(
        "profile-two",
        eventId,
        updater,
        guard,
      ),
    ).resolves.toMatchObject({ committed: true, value: targetAssignment });
    expect(await readEventRepositoryFixture(client, targetPath)).toEqual(
      targetAssignment,
    );
  });

  it("atomically rejects stored prize writes after a D1 event lease is replaced or expired", async () => {
    const client = createEventStateRepository(
      testEnv,
      eventMatchTestPort({
        getPath: async () => null,
        patchRoot: async () => undefined,
        transactPath: async () => ({ committed: false, value: null }),
      }),
    );
    await client.commitEventPlan(
      decodeEventUpdates({ [`events/${eventId}`]: eventRecord() }),
    );
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
        "profile-two",
        eventId,
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
    await transactEventRepositoryFixture(client, lockPath, () => ({
      value: originalLock,
    }));
    await transactEventRepositoryFixture(client, lockPath, () => ({
      value: { ...originalLock, lockId: "successor-lock" },
    }));
    await expect(writePrize()).rejects.toThrow("event-lease-lost");
    expect(await readEventOwnedPath(testEnv.EVENT_DB, targetPath)).toBeNull();

    await transactEventRepositoryFixture(client, lockPath, () => ({
      value: {
        ...originalLock,
        acquiredAtMs: nowMs - 2_000,
        refreshedAtMs: nowMs - 2_000,
        expiresAtMs: nowMs - 1_000,
      },
    }));
    await expect(writePrize()).rejects.toThrow("event-lease-lost");
    expect(await readEventOwnedPath(testEnv.EVENT_DB, targetPath)).toBeNull();
  });

  it("keeps explicit match reads independent while event writes are frozen", async () => {
    const readMatchRecord = vi.fn(async () => ({ fen: "initial" }));
    const port = eventMatchTestPort({
      getPath: async () => null,
      patchRoot: async () => undefined,
      transactPath: async () => ({ committed: false, value: null }),
    });
    const client = createEventStateRepository(testEnv, {
      ...port,
      readMatchRecord,
    });
    await transitionEventStorageMode(testEnv.EVENT_DB, {
      expected: { storageMode: "d1" },
      next: { storageMode: "frozen" },
      nowMs: 10,
    });
    try {
      expect(await client.readEvent(eventId)).toBeNull();
      await expect(
        client.commitEventPlan([
          { kind: "event", eventId, value: eventRecord() },
        ]),
      ).rejects.toThrow("event-writes-disabled");
      expect(
        await client.readMatchRecord({
          playerId: "login-one",
          matchId: "match-one",
        }),
      ).toEqual({ fen: "initial" });
      expect(readMatchRecord).toHaveBeenCalledExactlyOnceWith({
        playerId: "login-one",
        matchId: "match-one",
      });
      expect("getPath" in client).toBe(false);
      expect("patchRoot" in client).toBe(false);
      expect("transactPath" in client).toBe(false);
    } finally {
      await transitionEventStorageMode(testEnv.EVENT_DB, {
        expected: { storageMode: "frozen" },
        next: { storageMode: "d1" },
        nowMs: 11,
      });
    }
  });
});
