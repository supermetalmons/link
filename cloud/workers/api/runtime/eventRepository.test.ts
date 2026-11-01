import { timerClaimFixture } from "../test/matchClaimFixture.ts";
import { eventStatusFixture } from "../test/eventCompatibilityFixture.ts";
import type { EventTransitionDraftInput } from "../../../runtime/eventTransitionRecords.js";
import {
  eventApplicationEnvironment,
  activateEventApplicationFixture,
} from "./eventApplicationFixture.ts";
import { eventDraftFixture } from "../test/transitionIntentFixture.ts";
import { matchDocumentFixture } from "../test/matchRecordFixture.ts";
import {
  commitEventCompatibilityFixture,
  eventDocumentFixture,
} from "../test/eventCompatibilityFixture.ts";
import { captureLoginMatchDiscovery } from "../src/loginMatchDiscoveryD1.ts";
import { decodeEventUpdates } from "../test/eventLegacyFixtureCodec.ts";
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
  EventD1Conflict,
  EventD1Failure,
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
import { eventIntentPayloadDigest } from "../src/eventTransitionCodec.ts";
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

const testEnv = eventApplicationEnvironment(env) as Env & {
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
  return eventDocumentFixture({
    schemaVersion: 3,
    eventId: recordEventId,
    status,
    createdAtMs: 100,
    updatedAtMs: status === "scheduled" ? 100 : 200,
    startAtMs: 1_000,
    createdByProfileId: "profile-one",
    createdByLoginUid: "login-one",
    createdByUsername: "ivan",
    participants: {},
  });
}

async function createPendingIntent(
  intent: EventTransitionDraftInput,
): Promise<EventTransitionIntent> {
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
    await activateEventApplicationFixture(testEnv.PROFILE_GAMES_DB);
  });

  beforeEach(async () => {
    await resetMatchPresentationTestState(
      testEnv.PROFILE_GAMES_DB,
      testEnv.TEST_D1_MIGRATIONS,
      "durable",
    );
    await testEnv.PROFILE_GAMES_DB.batch([
      testEnv.PROFILE_GAMES_DB.prepare("DELETE FROM invite_sources_canonical"),
      testEnv.PROFILE_GAMES_DB.prepare(
        "DELETE FROM invite_event_effect_receipts",
      ),
      testEnv.PROFILE_GAMES_DB.prepare(
        "DELETE FROM login_match_discovery_canonical",
      ),
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
        "UPDATE event_records_canonical SET pending_transition_id = NULL",
      ),
      testEnv.EVENT_DB.prepare(
        "DELETE FROM event_transition_intents_canonical",
      ),
      testEnv.EVENT_DB.prepare("DELETE FROM event_leases"),
      testEnv.EVENT_DB.prepare("DELETE FROM event_write_admissions"),
      testEnv.EVENT_DB.prepare("DELETE FROM event_progress_outboxes_canonical"),
      testEnv.EVENT_DB.prepare("DELETE FROM event_records_canonical"),
      testEnv.EVENT_DB.prepare(
        "DELETE FROM profile_event_prize_revisions_canonical",
      ),
    ]);
  });

  it("rejects effects in canonical mutation arrays without applying them", async () => {
    const fixture = eventTransitionFixture(testEnv);
    await commitEventCompatibilityFixture(fixture.client, [
      { kind: "event", eventId, value: eventRecord() },
    ]);
    const before = await readEventSnapshot(testEnv.EVENT_DB, eventId);
    const canonicalUpdates = {
      ...eventStatusFixture(eventId, "active"),
      "players/host/matches/poison/timer": { state: "finished" },
    };
    expect(() =>
      eventDraftFixture({
        schemaVersion: 3,
        transitionId: "malformed-canonical-effect",
        eventId,
        expectedRevision: before.revision,
        canonicalUpdates,
        effects: {},
        createdAtMs: 200,
        updatedAtMs: 200,
      }),
    ).toThrow("unexpected-test-event-effect");
    await expect(fixture.recover()).resolves.toBe(0);
    expect(await readEventSnapshot(testEnv.EVENT_DB, eventId)).toEqual(before);
    expect(fixture.writes).toEqual([]);
    expect(
      await readEventTransitionReceipt(
        testEnv.PROFILE_GAMES_DB,
        "malformed-canonical-effect",
      ),
    ).toBeNull();
    expect(
      await testEnv.PROFILE_GAMES_DB.prepare(
        "SELECT COUNT(*) AS count FROM invite_event_effect_receipts WHERE transition_id = ?",
      )
        .bind("malformed-canonical-effect")
        .first<number>("count"),
    ).toBe(0);
    const pending = await listPendingEventTransitionIntents(testEnv.EVENT_DB);
    expect(pending).toHaveLength(0);
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
        commitEventCompatibilityFixture(client, decodeEventUpdates(update)),
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
        commitEventCompatibilityFixture(failedClient, [
          Object.assign(
            { kind: "event" as const, eventId, value: eventRecord() },
            { value: { ...eventRecord(), status: "invalid" } },
          ),
        ]),
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
    await commitEventCompatibilityFixture(
      client,
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
      table: "event_progress_outboxes_canonical",
    },
    {
      kind: "profile-game",
      method: "listDueEventProfileGameProjectionOutboxes",
      path: "profileGameProjectionOutbox/event",
      table: "event_profile_game_projection_outboxes_canonical",
    },
    {
      kind: "telegram",
      method: "listDueEventTelegramProjectionOutboxes",
      path: "telegramProjectionOutbox/event",
      table: "event_telegram_projection_outboxes_canonical",
    },
  ] as const)(
    "lists canonical due $kind outboxes through both event repositories",
    async ({ kind, method, path }) => {
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
      ].map(({ id, timestamp }) => ({
        id,
        record:
          kind === "progress"
            ? {
                schemaVersion: 2,
                dataEpoch: 1,
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
      await commitEventCompatibilityFixture(
        client,
        decodeEventUpdates(
          Object.fromEntries(
            rows.flatMap(({ id, record }) => [
              [`events/${id}`, eventRecord("scheduled", id)],
              [`${path}/${id}`, record],
            ]),
          ),
        ),
      );
      const entries = [rows[2], rows[1], rows[0], rows[3]].map((row) => ({
        ...(kind === "progress" ? { outboxId: row!.id } : { eventId: row!.id }),
        record: row!.record,
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

  it("rejects malformed Telegram outboxes before they replace canonical work", async () => {
    const client = createEventStateRepository(
      testEnv,
      eventMatchTestPort({
        getPath: async () => null,
        patchRoot: async () => undefined,
        transactPath: async () => ({ committed: false, value: null }),
      }),
    );
    const outbox = {
      schemaVersion: 1,
      status: "pending",
      requestId: "request-one",
      firstQueuedAtMs: 100,
      updatedAtMs: 100,
    };
    await commitEventCompatibilityFixture(
      client,
      decodeEventUpdates({
        [`events/${eventId}`]: eventRecord(),
        [`telegramProjectionOutbox/event/${eventId}`]: outbox,
      }),
    );
    await expect(
      testEnv.EVENT_DB.prepare(
        "UPDATE event_telegram_projection_outboxes_canonical SET record_json = '{}' WHERE event_id = ?",
      )
        .bind(eventId)
        .run(),
    ).rejects.toThrow("invalid-canonical-event-projection");
    expect(
      await client.listDueEventTelegramProjectionOutboxes(200, 100),
    ).toEqual([{ eventId, record: outbox }]);
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
    await commitEventCompatibilityFixture(
      client,
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
    await commitEventCompatibilityFixture(
      client,
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

  it.each(["without", "with"] as const)(
    "rejects malformed selections before transition effects %s selection changes",
    async (selectionChanges) => {
      const f = eventTransitionFixture(testEnv);
      const selectionPath = `eventPrizeSelections/${eventId}/profile-one`;
      await commitEventCompatibilityFixture(
        f.client,
        decodeEventUpdates({
          [`events/${eventId}`]: eventRecord(),
          [selectionPath]: "1092",
        }),
      );
      await testEnv.EVENT_DB.prepare(
        "UPDATE event_prize_selections_canonical SET prize_id = ? WHERE event_id = ? AND profile_id = ?",
      )
        .bind("invalid#prize", eventId, "profile-one")
        .run();
      const readStoredState = async () => {
        const results = await testEnv.EVENT_DB.batch([
          testEnv.EVENT_DB.prepare(
            "SELECT * FROM event_records_canonical WHERE event_id = ?",
          ).bind(eventId),
          testEnv.EVENT_DB.prepare(
            "SELECT * FROM event_prize_selections_canonical WHERE event_id = ? ORDER BY profile_id",
          ).bind(eventId),
        ]);
        return results.map((result) => result.results);
      };
      const before = await readStoredState();
      await expect(
        commitEventCompatibilityFixture(
          f.client,
          decodeEventUpdates({
            ...eventStatusFixture(eventId, "active"),
            [`events/${eventId}/updatedAtMs`]: 200,
            ...notificationCreationEffects(),
            ...(selectionChanges === "with" ? { [selectionPath]: "1092" } : {}),
          }),
        ),
      ).rejects.toThrow("invalid-event-prize-selection");
      expect(await readStoredState()).toEqual(before);
      expect(f.writes).toEqual([]);
      expect(f.patches).toEqual([]);
      for (const loginUid of ["login-one", "login-two"]) {
        expect(f.values.has(`players/${loginUid}/matches/event-match`)).toBe(
          false,
        );
      }
      expect(
        await testEnv.EVENT_DB.prepare(
          "SELECT COUNT(*) AS count FROM event_transition_intents_canonical",
        ).first<number>("count"),
      ).toBe(0);
      for (const table of [
        "event_transition_receipts",
        "invite_event_effect_receipts",
        "invite_sources_canonical",
      ]) {
        expect(
          await testEnv.PROFILE_GAMES_DB.prepare(
            `SELECT COUNT(*) AS count FROM ${table}`,
          ).first<number>("count"),
        ).toBe(0);
      }
    },
  );

  it("rejects upcoming-event plans with effects before journaling or applying them", async () => {
    const f = eventTransitionFixture(testEnv);
    await commitEventCompatibilityFixture(f.client, [
      { kind: "event", eventId, value: eventRecord() },
    ]);
    const commit = commitEventCompatibilityFixture(
      f.client,
      decodeEventUpdates({
        ...eventStatusFixture(eventId, "active"),
        "players/login-one/matches/event-match/timer": { state: "finished" },
      }),
      undefined,
      { upcomingEventId: eventId },
    );
    await expect(commit).rejects.toBeInstanceOf(EventD1Failure);
    await expect(commit).rejects.toThrow(
      "event-upcoming-guard-effects-unsupported",
    );
    expect(f.patches).toEqual([]);
    expect(await listPendingEventTransitionIntents(testEnv.EVENT_DB)).toEqual(
      [],
    );
    expect(await readEventSnapshot(testEnv.EVENT_DB, eventId)).toMatchObject({
      event: { status: "scheduled" },
      revision: 1,
    });
  });

  it("replays a canonical intent with typed effect records and verified digest", async () => {
    const f = eventTransitionFixture(testEnv);
    const timerPath = "players/login-one/matches/event-match/timer";
    await commitEventCompatibilityFixture(
      f.client,
      decodeEventUpdates({ [`events/${eventId}`]: eventRecord() }),
    );
    const pending = await createPendingIntent(
      eventDraftFixture({
        schemaVersion: 3,
        transitionId: "compatibility-transition",
        eventId,
        expectedRevision: 1,
        canonicalUpdates: {
          ...eventStatusFixture(eventId, "active"),
          [`events/${eventId}/updatedAtMs`]: 200,
        },
        effects: { [timerPath]: { state: "finished" } },
        createdAtMs: 200,
        updatedAtMs: 200,
      }),
    );
    expect(pending.payloadDigest).toBe(await eventIntentPayloadDigest(pending));
    expect(pending.operationDigest).toBe(pending.payloadDigest);
    const stored = await testEnv.EVENT_DB.prepare(
      "SELECT intent_json FROM event_transition_intents_canonical WHERE transition_id = ?",
    )
      .bind(pending.transitionId)
      .first<string>("intent_json");
    expect(stored).not.toContain('"rtdbEffects"');
    expect(JSON.parse(stored!).effects).toEqual([
      {
        kind: "match-terminal-timer",
        playerId: "login-one",
        matchId: "event-match",
        value: { state: "finished" },
      },
    ]);
    expect(JSON.parse(stored!)).toEqual(pending);
    expect(await f.recover()).toBe(1);
    expect(f.values.get(timerPath)).toEqual({ state: "finished" });
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
    expect(f.patches).toEqual([{ [timerPath]: { state: "finished" } }]);
  });

  it.each([
    {
      reverse: false,
      matchId: "event-match",
      expectedId:
        "et_dbf93390fea6f6c0783879b2e4b54cdf010d09361986e008c6e9661a01980955",
    },
    {
      reverse: true,
      matchId: "event-match",
      expectedId:
        "et_dbf93390fea6f6c0783879b2e4b54cdf010d09361986e008c6e9661a01980955",
    },
    {
      reverse: false,
      matchId: "other-match",
      expectedId:
        "et_e6a2b6b0368ac79c41e236d0489626f12143b38b17c4593a80664542c8ac7699",
    },
  ])(
    "preserves generated transition identity for $matchId, reversed=$reverse",
    async ({ reverse, matchId, expectedId }) => {
      const f = eventTransitionFixture(testEnv);
      await captureLoginMatchDiscovery(
        testEnv.PROFILE_GAMES_DB,
        [{ loginUid: "login-two", matchId, inviteId: matchId }],
        100,
      );
      await commitEventCompatibilityFixture(
        f.client,
        decodeEventUpdates({ [`events/${eventId}`]: eventRecord() }),
      );
      f.hooks.beforePatch = async () => {
        throw new Error("state-offline");
      };
      const effects = [
        ["players/login-one/matches/event-match/timer", { state: "finished" }],
        [`players/login-two/matches/${matchId}/timer`, { state: "finished" }],
      ];
      await expect(
        commitEventCompatibilityFixture(
          f.client,
          decodeEventUpdates({
            ...eventStatusFixture(eventId, "active"),
            ...Object.fromEntries(reverse ? effects.reverse() : effects),
          }),
        ),
      ).rejects.toThrow("state-offline");
      const [pending] = await listPendingEventTransitionIntents(
        testEnv.EVENT_DB,
      );
      expect(pending!.transitionId).toBe(expectedId);
      expect(pending!.expectedRevision).toBe(1);
    },
  );

  it("recovers a failed match effect before publishing the D1 revision", async () => {
    const f = eventTransitionFixture(testEnv);
    const timerPath = "players/login-one/matches/event-match/timer";
    f.hooks.beforePatch = async () => {
      delete f.hooks.beforePatch;
      throw new Error("state-offline");
    };
    await commitEventCompatibilityFixture(
      f.client,
      decodeEventUpdates({ [`events/${eventId}`]: eventRecord() }),
    );
    const update = {
      ...eventStatusFixture(eventId, "active"),
      [`events/${eventId}/updatedAtMs`]: 200,
      [timerPath]: { state: "finished" },
    };
    await expect(
      commitEventCompatibilityFixture(f.client, decodeEventUpdates(update)),
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
    expect(pending!.schemaVersion).toBe(3);
    await expect(
      commitEventCompatibilityFixture(
        f.client,
        decodeEventUpdates({ [`events/${eventId}/updatedAtMs`]: 150 }),
      ),
    ).rejects.toThrow("event-transition-pending");
    await commitEventCompatibilityFixture(f.client, decodeEventUpdates(update));
    expect(f.patches).toEqual([
      { [timerPath]: { state: "finished" } },
      { [timerPath]: { state: "finished" } },
    ]);
    expect(
      await readEventTransitionReceipt(
        testEnv.PROFILE_GAMES_DB,
        pending!.transitionId,
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
      await commitEventCompatibilityFixture(client, [
        { kind: "event", eventId, value: eventRecord() },
      ]);
      const updates = {
        ...eventStatusFixture(eventId, "active"),
        "players/login-one/matches/event-match/timer": { state: "finished" },
      };
      if (mode === "recovery") {
        await createPendingIntent(
          eventDraftFixture({
            schemaVersion: 3,
            transitionId: "post-commit-recovery",
            eventId,
            expectedRevision: 1,
            canonicalUpdates: { ...eventStatusFixture(eventId, "active") },
            effects: {
              "players/login-one/matches/event-match/timer": {
                state: "finished",
              },
            },
            createdAtMs: 200,
            updatedAtMs: 200,
          }),
        );
      }
      let completed = false;
      const work = (
        mode === "recovery"
          ? recoverEventTransitionIntents(scopedEnv, 100, f.raw)
          : commitEventCompatibilityFixture(client, decodeEventUpdates(updates))
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
        ).toEqual({ state: "finished" });
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
      await commitEventCompatibilityFixture(f.client, [
        { kind: "event", eventId, value: eventRecord() },
      ]);
      if (failure === "effects") {
        f.hooks.beforePatch = async () => {
          throw new Error("required-effects-failed");
        };
      } else {
        await testEnv.EVENT_DB.prepare(
          `CREATE TRIGGER event_notification_test_commit_failure
          BEFORE UPDATE ON event_records_canonical WHEN NEW.revision > OLD.revision
          BEGIN SELECT RAISE(ABORT, 'canonical-commit-failed'); END`,
        ).run();
      }
      try {
        await expect(
          commitEventCompatibilityFixture(
            f.client,
            decodeEventUpdates({
              ...eventStatusFixture(eventId, "active"),
              "players/login-one/matches/event-match/timer": {
                state: "finished",
              },
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
        delete f.hooks.beforePatch;
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
        await commitEventCompatibilityFixture(client, [
          { kind: "event", eventId, value: eventRecord() },
        ]);
        await expect(
          commitEventCompatibilityFixture(
            client,
            decodeEventUpdates({
              ...eventStatusFixture(eventId, "active"),
              "players/login-one/matches/event-match/timer": {
                state: "finished",
              },
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
      await commitEventCompatibilityFixture(client, [
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
        "players/login-one/matches/event-match1/timer": { state: "finished" },
        "matchTimerClaims/claim-match": claim("claim-invite"),
        "players/login-one/matches/claim-match/timer": { state: "finished" },
        "players/login-one/matches/terminal-match/timer": { state: "finished" },
      };
      const canonicalUpdates = { ...eventStatusFixture(eventId, "active") };
      if (mode === "recovery") {
        await createPendingIntent(
          eventDraftFixture({
            schemaVersion: 3,
            transitionId: "deduplicated-notifications",
            eventId,
            expectedRevision: 1,
            canonicalUpdates,
            effects: effects,
            createdAtMs: 200,
            updatedAtMs: 200,
          }),
        );
        await expect(
          recoverEventTransitionIntents(scopedEnv, 100, f.raw),
        ).resolves.toBe(1);
      } else {
        await commitEventCompatibilityFixture(
          client,
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
              const discoveryStatements = new WeakSet<D1PreparedStatement>();
              return new Proxy(session, {
                get(reader, method) {
                  if (method === "batch") {
                    return async (statements: D1PreparedStatement[]) => {
                      if (
                        statements.some((statement) =>
                          discoveryStatements.has(statement),
                        )
                      ) {
                        lookupStarted.resolve();
                        if (failure === "blocked") await releaseLookup.promise;
                        throw new Error("discovery-unavailable");
                      }
                      return reader.batch(statements);
                    };
                  }
                  if (method === "prepare") {
                    return (sql: string) => {
                      if (
                        sql ===
                        "SELECT invite_id, resolution FROM login_match_discovery_canonical WHERE login_uid = ? AND match_id = ?"
                      ) {
                        return new Proxy(reader.prepare(sql), {
                          get(statement, operation) {
                            if (operation === "bind") {
                              return (...values: unknown[]) => {
                                const bound = statement.bind(...values);
                                discoveryStatements.add(bound);
                                return bound;
                              };
                            }
                            const member = Reflect.get(
                              statement,
                              operation,
                              statement,
                            );
                            return typeof member === "function"
                              ? member.bind(statement)
                              : member;
                          },
                        });
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
        await commitEventCompatibilityFixture(client, [
          { kind: "event", eventId, value: eventRecord() },
        ]);
        await commitEventCompatibilityFixture(
          client,
          decodeEventUpdates({
            ...eventStatusFixture(eventId, "active"),
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
    await commitEventCompatibilityFixture(f.client, [
      { kind: "event", eventId, value: eventRecord() },
    ]);
    const claim = {
      inviteId: "claim-invite",
      playerId: "login-one",
      opponentId: "login-two",
      status: "claimed",
      claimedAtMs: 200,
      timer: "1;90",
      turnNumber: 1,
      expiresAtMs: null,
    };
    await createPendingIntent(
      eventDraftFixture({
        schemaVersion: 3,
        transitionId: "claim-notification",
        eventId,
        expectedRevision: 1,
        canonicalUpdates: { ...eventStatusFixture(eventId, "active") },
        effects: { "matchTimerClaims/claim-match": claim },
        createdAtMs: 200,
        updatedAtMs: 200,
      }),
    );
    await expect(
      recoverEventTransitionIntents(scopedEnv, 100, f.raw),
    ).resolves.toBe(1);
    expect(notify).toHaveBeenCalledWith("claim-invite");
    expect(f.values.get("matchTimerClaims/claim-match")).toEqual(
      timerClaimFixture(claim),
    );
  });

  it("preserves advanced matches after an ambiguous creation commit", async () => {
    const f = eventTransitionFixture(testEnv);
    const matchPath = "players/login-one/matches/event-match";
    f.hooks.afterTransaction = async (path) => {
      if (path !== matchPath) return;
      delete f.hooks.afterTransaction;
      throw new Error("ambiguous-state-commit");
    };
    await commitEventCompatibilityFixture(
      f.client,
      decodeEventUpdates({ [`events/${eventId}`]: eventRecord() }),
    );
    await expect(
      commitEventCompatibilityFixture(
        f.client,
        decodeEventUpdates({
          ...eventStatusFixture(eventId, "active"),
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
    await commitEventCompatibilityFixture(
      f.client,
      decodeEventUpdates({ [`events/${eventId}`]: eventRecord() }),
    );
    const update = {
      ...eventStatusFixture(eventId, "active"),
      "players/login-one/matches/serialized-transition/timer": {
        state: "finished",
      },
    };
    const first = commitEventCompatibilityFixture(
      f.client,
      decodeEventUpdates(update),
    );
    await started;
    const duplicate = commitEventCompatibilityFixture(
      f.client,
      decodeEventUpdates(update),
    );
    await expect(duplicate).rejects.toBeInstanceOf(EventD1Conflict);
    await expect(duplicate).rejects.toThrow(
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
      await commitEventCompatibilityFixture(
        f.client,
        decodeEventUpdates({
          [`events/${targetEventId}`]: eventRecord("scheduled", targetEventId),
        }),
      );
      await createPendingIntent(
        eventDraftFixture({
          schemaVersion: 3,
          transitionId,
          eventId: targetEventId,
          expectedRevision: 1,
          effects: {
            [`players/login-one/matches/${transitionId}/timer`]: {
              state: "finished",
            },
          },
          canonicalUpdates: { ...eventStatusFixture(targetEventId, "active") },
          createdAtMs: 200,
          updatedAtMs: 200,
        }),
      );
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
    await commitEventCompatibilityFixture(
      f.client,
      decodeEventUpdates({ [`events/${eventId}`]: eventRecord() }),
    );
    const intent = await createPendingIntent(
      eventDraftFixture({
        schemaVersion: 3,
        transitionId: "conflicting-receipt",
        eventId,
        expectedRevision: 1,
        effects: {
          "players/login-one/matches/conflicting-receipt/timer": {
            state: "finished",
          },
        },
        canonicalUpdates: { ...eventStatusFixture(eventId, "active") },
        createdAtMs: 200,
        updatedAtMs: 200,
      }),
    );
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
      await commitEventCompatibilityFixture(
        f.client,
        decodeEventUpdates({
          [`events/${targetEventId}`]: eventRecord("scheduled", targetEventId),
        }),
      );
      await createPendingIntent(
        eventDraftFixture({
          schemaVersion: 3,
          transitionId,
          eventId: targetEventId,
          expectedRevision: 1,
          effects: {
            [`players/login-one/matches/${transitionId}/timer`]: {
              state: "finished",
            },
          },
          canonicalUpdates: { ...eventStatusFixture(targetEventId, "active") },
          createdAtMs: 200,
          updatedAtMs: 200,
        }),
      );
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
      commitEventCompatibilityFixture(
        f.client,
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
    await commitEventCompatibilityFixture(
      f.client,
      decodeEventUpdates({ [`events/${eventId}`]: eventRecord() }),
    );
    await createPendingIntent(
      eventDraftFixture({
        schemaVersion: 3,
        transitionId: "admitted-recovery",
        eventId,
        expectedRevision: 1,
        effects: {
          "players/login-one/matches/admitted-recovery/timer": {
            state: "finished",
          },
        },
        canonicalUpdates: { ...eventStatusFixture(eventId, "active") },
        createdAtMs: 200,
        updatedAtMs: 200,
      }),
    );
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

  it("publishes progress and decodes historical timer cleanup with the retired D1 timer table absent", async () => {
    const f = eventTransitionFixture(testEnv);
    expect(
      await testEnv.PROFILE_GAMES_DB.prepare(
        "SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'table' AND name = 'match_timer_starts_canonical'",
      ).first<number>("count"),
    ).toBe(0);
    await commitEventCompatibilityFixture(
      f.client,
      decodeEventUpdates({ [`events/${eventId}`]: eventRecord() }),
    );
    const outbox = {
      schemaVersion: 2,
      dataEpoch: 1,
      eventId,
      sourceKey: "timer:invite-one:match-one",
      reason: "timer-claimed",
      runAtMs: null,
      firstQueuedAtMs: 100,
      lastQueuedAtMs: 100,
    };
    await commitEventCompatibilityFixture(
      f.client,
      decodeEventUpdates({
        "eventProgressOutbox/progress-mixed": outbox,
        "matchTimerStarts/login-one/match-one": null,
      }),
    );
    expect(f.patches).toEqual([]);
    expect(
      await testEnv.PROFILE_GAMES_DB.prepare(
        "SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'table' AND name = 'match_timer_starts_canonical'",
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
        "unsupported-test-event-path",
      );
      expect(() =>
        decodeEventUpdates({
          [`events/${eventId}`]: eventRecord(),
          [path]: {},
        }),
      ).toThrow("unsupported-test-event-path");
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
    await commitEventCompatibilityFixture(
      client,
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
          claimEventProfileGameProjectionOutbox:
            client.claimEventProfileGameProjectionOutbox,
          acknowledgeEventProfileGameProjectionOutbox:
            client.acknowledgeEventProfileGameProjectionOutbox,
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
    await commitEventCompatibilityFixture(
      client,
      decodeEventUpdates({ [`events/${eventId}`]: eventRecord() }),
    );
    const sourceAssignment = {
      eventId,
      profileId: "profile-one",
      place: 1 as const,
      prizeId: "retired-prize",
      assignedAtMs: 2_000,
    };
    await testEnv.EVENT_DB.prepare(
      `INSERT INTO profile_event_prizes_canonical (
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
      commitEventCompatibilityFixture(
        client,
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
    await commitEventCompatibilityFixture(
      client,
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
    const readMatchRecord = vi.fn(async () =>
      matchDocumentFixture({ fen: "initial" }),
    );
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
        commitEventCompatibilityFixture(client, [
          { kind: "event", eventId, value: eventRecord() },
        ]),
      ).rejects.toThrow("event-writes-disabled");
      expect(
        await client.readMatchRecord({
          playerId: "login-one",
          matchId: "match-one",
        }),
      ).toEqual(matchDocumentFixture({ fen: "initial" }));
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
