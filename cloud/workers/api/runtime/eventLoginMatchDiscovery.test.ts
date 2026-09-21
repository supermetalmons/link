import { decodeEventUpdates } from "../src/eventCompatibilityCodec.ts";
import {
  eventMatchTestPort,
  readEventRepositoryFixture,
} from "./eventRepositoryFixture.ts";
import { env } from "cloudflare:workers";
import { resetMatchPresentationTestState } from "./matchPresentationTestFixture.ts";
import type { D1Migration } from "cloudflare:test";
import { applyStrictMatchStateTestMigrations } from "./strictMatchStateTestFixture.ts";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  captureEventMatchDiscovery,
  ensureEventMatchDiscovery,
  eventMatchInviteIds,
} from "../src/eventLoginMatchDiscovery.ts";
import {
  buildLoginMatchDiscoveryStatements,
  captureLoginMatchDiscovery,
} from "../src/loginMatchDiscoveryD1.ts";
import { createEventStateRepository } from "../src/eventRepository.ts";
import { listPendingEventTransitionIntents } from "../src/eventD1.ts";
import { processEventProfileGameProjection } from "../src/profileGameProjection.ts";
import { createEventProfileGameProjectionRuntime } from "../src/profileGameProjectionRepository.ts";
import type {
  StateRepository,
  StateQuery,
} from "../test/stateRepositoryTestTypes.ts";
import type { EventReads } from "../../../runtime/eventReads.js";
import { eventReadFixture } from "../test/eventReadFixture.ts";
import { applyEventTestMigrations } from "./eventTestMigrations.ts";
import { applyRetiredProfileMigrations } from "./profileTestMigrations.ts";
import type { MatchStatePort } from "../src/repositoryContracts.ts";
import {
  eventTransitionFixture,
  resetEventReceiptTestState,
} from "./eventTransitionTestFixture.ts";

const testEnv = env as Env & {
  TEST_D1_MIGRATIONS: D1Migration[];
  TEST_EVENT_D1_MIGRATIONS: D1Migration[];
  TEST_PROFILE_D1_MIGRATIONS: D1Migration[];
};
const eventId = "discovery-event";
const inviteId = "discovery-invite";
const hostUid = "original-anonymous-host";
const guestUid = "original-guest-login";

function eventRecord() {
  return {
    schemaVersion: 2,
    eventId,
    status: "scheduled",
    createdAtMs: 100,
    updatedAtMs: 100,
    startAtMs: 1_000,
    createdByProfileId: "profile-one",
    createdByLoginUid: hostUid,
    createdByUsername: "ivan",
    participants: {},
    rounds: {},
  };
}

function eventRounds() {
  return {
    0: {
      matches: {
        "0_0": {
          inviteId,
          hostLoginUid: "changed-bracket-login",
          guestLoginUid: null,
        },
      },
    },
  };
}

function matchEffects() {
  return {
    [`invites/${inviteId}`]: {
      eventId,
      eventOwned: true,
      hostId: hostUid,
      guestId: guestUid,
    },
    [`players/${hostUid}/matches/${inviteId}`]: {
      fen: "initial",
      color: "white",
    },
    [`players/${guestUid}/matches/${inviteId}`]: {
      fen: "initial",
      color: "black",
    },
  };
}

function stateFixture(initial: Record<string, unknown> = {}) {
  const values = new Map(Object.entries(initial));
  const patches: Record<string, unknown>[] = [];
  const reads: string[] = [];
  const metadataReads: string[] = [];
  const matchBatches: Parameters<MatchStatePort["readMatchRecords"]>[0][] = [];
  const read = async (path: string, query?: StateQuery) => {
    reads.push(path);
    if (path.startsWith("players/")) expect(query).toBeUndefined();
    return values.get(path) ?? null;
  };
  const client: StateRepository & EventReads = {
    ...eventReadFixture(read),
    getPath: read,
    async patchRoot(updates) {
      patches.push(updates);
      for (const [path, value] of Object.entries(updates)) {
        if (value === null) values.delete(path);
        else values.set(path, structuredClone(value));
      }
    },
    async transactPath() {
      throw new Error("unexpected-source-transaction");
    },
  };
  const reader = {
    async readMatchRecord(
      { playerId, matchId }: { playerId: string; matchId: string },
      signal?: AbortSignal,
    ) {
      signal?.throwIfAborted();
      return read(`players/${playerId}/matches/${matchId}`) as Promise<
        import("../src/matchStateTypes.ts").MatchStateRecord | null
      >;
    },
    async readMatchRecords(
      inputs: Parameters<MatchStatePort["readMatchRecords"]>[0],
      signal?: AbortSignal,
    ) {
      signal?.throwIfAborted();
      matchBatches.push(inputs);
      return Promise.all(
        inputs.map((input) => reader.readMatchRecord(input, signal)),
      );
    },
    async readInviteMetadata(inviteId: string, signal?: AbortSignal) {
      signal?.throwIfAborted();
      metadataReads.push(inviteId);
      return (values.get(`invites/${inviteId}`) ?? null) as Record<
        string,
        unknown
      > | null;
    },
  };
  return {
    client,
    matchBatches,
    metadataReads,
    patches,
    reader,
    reads,
    values,
  };
}

function captureFixture(count: number) {
  const ids = Array.from({ length: count }, (_, index) => `capture-${index}`);
  return {
    ids,
    ...stateFixture(
      Object.fromEntries(
        ids.flatMap((id) => [
          [`invites/${id}`, { hostId: hostUid, guestId: guestUid }],
          [`players/${hostUid}/matches/${id}`, { fen: "initial" }],
          [`players/${guestUid}/matches/${id}`, { fen: "initial" }],
        ]),
      ),
    ),
  };
}

async function indexedRows() {
  return (
    await testEnv.PROFILE_GAMES_DB.prepare(
      "SELECT login_uid, match_id, invite_id, resolution, provenance FROM login_match_discovery ORDER BY login_uid, match_id",
    ).all()
  ).results;
}

async function seedInvite(id: string, hostId = hostUid, guestId = guestUid) {
  await testEnv.PROFILE_GAMES_DB.batch(
    [hostId, guestId].map((actorUid) =>
      testEnv.PROFILE_GAMES_DB.prepare(
        `INSERT INTO match_presentation_registrations
         (invite_id, match_id, actor_uid, seed_digest, provenance, source_id, registered_at_ms)
         VALUES (?, ?, ?, ?, 'creation', 'discovery-test', 100)`,
      ).bind(id, id, actorUid, "a".repeat(64)),
    ),
  );
  await testEnv.PROFILE_GAMES_DB.prepare(
    `INSERT INTO invite_sources (invite_id, source_json, revision, updated_at_ms)
     VALUES (?, ?, 1, 100)`,
  )
    .bind(id, JSON.stringify({ eventId, eventOwned: true, hostId, guestId }))
    .run();
}

async function seedCapturedInvite(id: string) {
  await seedInvite(id);
  await captureLoginMatchDiscovery(
    testEnv.PROFILE_GAMES_DB,
    [hostUid, guestUid].map((loginUid) => ({
      loginUid,
      matchId: id,
      inviteId: id,
    })),
  );
}

async function rejectIndexWrites() {
  await testEnv.PROFILE_GAMES_DB.prepare(
    `CREATE TRIGGER reject_event_discovery_capture
     BEFORE INSERT ON login_match_discovery
     BEGIN SELECT RAISE(ABORT, 'event-discovery-write-failed'); END`,
  ).run();
}

async function permitIndexWrites() {
  await testEnv.PROFILE_GAMES_DB.prepare(
    "DROP TRIGGER IF EXISTS reject_event_discovery_capture",
  ).run();
}

describe("event login-match discovery", () => {
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
      "c".repeat(64),
    );
  });

  beforeEach(async () => {
    await resetMatchPresentationTestState(
      testEnv.PROFILE_GAMES_DB,
      testEnv.TEST_D1_MIGRATIONS,
      "durable",
    );
    await permitIndexWrites();
    await testEnv.PROFILE_GAMES_DB.prepare(
      "DELETE FROM login_match_discovery",
    ).run();
    await testEnv.PROFILE_GAMES_DB.batch([
      testEnv.PROFILE_GAMES_DB.prepare("DELETE FROM invite_sources"),
      testEnv.PROFILE_GAMES_DB.prepare(
        "DELETE FROM game_session_transition_resources",
      ),
      testEnv.PROFILE_GAMES_DB.prepare("DELETE FROM game_session_transitions"),
      testEnv.PROFILE_GAMES_DB.prepare(
        `INSERT INTO automatch_runtime_control
         (singleton, backend, state, epoch, freeze_generation)
         VALUES (1, 'd1', 'active', 1, 0)
         ON CONFLICT(singleton) DO UPDATE SET backend = 'd1', state = 'active'`,
      ),
      testEnv.PROFILE_GAMES_DB.prepare(
        "DELETE FROM invite_event_effect_receipts",
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
      testEnv.EVENT_DB.prepare(
        "DELETE FROM event_profile_game_projection_outboxes",
      ),
      testEnv.EVENT_DB.prepare("DELETE FROM event_records"),
    ]);
  });

  it("checks captured actors in one primary batch without rereading matches or writing discovery", async () => {
    await seedCapturedInvite(inviteId);
    const fixture = stateFixture();
    const constraints: string[] = [];
    const batchSizes: number[] = [];
    const db = new Proxy(testEnv.PROFILE_GAMES_DB, {
      get(target, property) {
        if (property !== "withSession")
          throw new Error(
            `unexpected-discovery-database-operation:${String(property)}`,
          );
        return (constraint: D1SessionConstraint) => {
          constraints.push(constraint);
          const session = target.withSession(constraint);
          return new Proxy(session, {
            get(target, property) {
              if (property === "prepare") return target.prepare.bind(target);
              if (property === "batch")
                return (statements: D1PreparedStatement[]) => {
                  batchSizes.push(statements.length);
                  return target.batch(statements);
                };
              throw new Error(
                `unexpected-discovery-session-operation:${String(property)}`,
              );
            },
          });
        };
      },
    });
    await rejectIndexWrites();
    await expect(
      ensureEventMatchDiscovery(db, fixture.reader, [inviteId, inviteId]),
    ).resolves.toBeUndefined();
    expect(constraints).toEqual(["first-primary"]);
    expect(batchSizes).toEqual([3]);
    expect(fixture.reads).toEqual([]);
    expect(fixture.metadataReads).toEqual([]);
    expect(fixture.matchBatches).toEqual([]);
  });

  it.each(["missing", "unresolved", "backfill", "different-actors"])(
    "repairs only the invite with %s discovery",
    async (coverage) => {
      const coveredId = "already-captured-invite";
      await seedCapturedInvite(coveredId);
      await seedInvite(inviteId);
      if (coverage !== "missing") {
        await testEnv.PROFILE_GAMES_DB.batch(
          buildLoginMatchDiscoveryStatements(
            testEnv.PROFILE_GAMES_DB,
            (coverage === "different-actors"
              ? ["unrelated-host", "unrelated-guest"]
              : [hostUid, guestUid]
            ).map((loginUid) => ({
              loginUid,
              matchId: inviteId,
              inviteId: coverage === "unresolved" ? null : inviteId,
              resolution: coverage === "unresolved" ? "missing" : "resolved",
              provenance:
                coverage === "different-actors" ? "capture" : "backfill",
            })),
            100,
          ),
        );
      }
      const fixture = stateFixture(matchEffects());
      await ensureEventMatchDiscovery(
        testEnv.PROFILE_GAMES_DB,
        fixture.reader,
        [coveredId, inviteId],
      );
      expect(fixture.metadataReads).toEqual([inviteId]);
      expect(fixture.reads.sort()).toEqual(
        [hostUid, guestUid]
          .map((uid) => `players/${uid}/matches/${inviteId}`)
          .sort(),
      );
      const captured = (await indexedRows()).filter(
        (row) =>
          row.match_id === inviteId &&
          [hostUid, guestUid].includes(String(row.login_uid)),
      );
      expect(captured).toHaveLength(2);
      expect(
        captured.every(
          (row) =>
            row.resolution === "resolved" && row.provenance === "capture",
        ),
      ).toBe(true);
    },
  );

  it("rejects conflicting resolved discovery rather than treating it as covered", async () => {
    await seedInvite(inviteId);
    await captureLoginMatchDiscovery(
      testEnv.PROFILE_GAMES_DB,
      [hostUid, guestUid].map((loginUid) => ({
        loginUid,
        matchId: inviteId,
        inviteId: loginUid === guestUid ? "different-invite" : inviteId,
      })),
    );
    const fixture = stateFixture(matchEffects());
    await expect(
      ensureEventMatchDiscovery(testEnv.PROFILE_GAMES_DB, fixture.reader, [
        inviteId,
      ]),
    ).rejects.toThrow();
    expect(fixture.metadataReads).toEqual([inviteId]);
    expect(
      (await indexedRows()).find((row) => row.login_uid === guestUid)
        ?.invite_id,
    ).toBe("different-invite");
  });

  it("allows covered frozen reads but rejects pending session transitions", async () => {
    await seedCapturedInvite(inviteId);
    const fixture = stateFixture();
    await testEnv.PROFILE_GAMES_DB.batch([
      testEnv.PROFILE_GAMES_DB.prepare(
        "UPDATE automatch_runtime_control SET state = 'frozen'",
      ),
      testEnv.PROFILE_GAMES_DB.prepare(
        "UPDATE invite_source_control SET state = 'frozen'",
      ),
    ]);
    await expect(
      ensureEventMatchDiscovery(testEnv.PROFILE_GAMES_DB, fixture.reader, [
        inviteId,
      ]),
    ).resolves.toBeUndefined();
    await testEnv.PROFILE_GAMES_DB.batch([
      testEnv.PROFILE_GAMES_DB.prepare(
        "INSERT INTO game_session_transitions (transition_id, invite_id, payload_json, status, created_at_ms, updated_at_ms) VALUES ('pending-session', ?, '{}', 'pending', 1, 1)",
      ).bind(inviteId),
      testEnv.PROFILE_GAMES_DB.prepare(
        "INSERT INTO game_session_transition_resources (resource_key, transition_id) VALUES (?, 'pending-session')",
      ).bind(inviteId),
    ]);
    await expect(
      ensureEventMatchDiscovery(testEnv.PROFILE_GAMES_DB, fixture.reader, [
        inviteId,
      ]),
    ).rejects.toThrow("resource-pending");
    expect(fixture.metadataReads).toEqual([]);
    expect(fixture.reads).toEqual([]);
  });

  it("rejects inactive invite authority even when discovery rows are captured", async () => {
    await seedCapturedInvite(inviteId);
    await testEnv.PROFILE_GAMES_DB.prepare(
      "UPDATE invite_source_control SET backend = 'rtdb', epoch = 0",
    ).run();
    const fixture = stateFixture();
    await expect(
      ensureEventMatchDiscovery(testEnv.PROFILE_GAMES_DB, fixture.reader, [
        inviteId,
      ]),
    ).rejects.toThrow("invite-source-backend-retired");
    expect(fixture.metadataReads).toEqual([]);
  });

  it.each(["missing", "retired"])(
    "rejects %s automatch authority even when discovery rows are captured",
    async (authority) => {
      await seedCapturedInvite(inviteId);
      await testEnv.PROFILE_GAMES_DB.prepare(
        "DELETE FROM automatch_runtime_control WHERE singleton = 1",
      ).run();
      if (authority === "retired") {
        await testEnv.PROFILE_GAMES_DB.prepare(
          `INSERT INTO automatch_runtime_control
           (singleton, backend, state, epoch, freeze_generation)
           VALUES (1, 'rtdb', 'active', 1, 0)`,
        ).run();
      }
      const fixture = stateFixture(matchEffects());
      await expect(
        ensureEventMatchDiscovery(testEnv.PROFILE_GAMES_DB, fixture.reader, [
          inviteId,
        ]),
      ).rejects.toThrow(
        authority === "missing"
          ? "automatch-control-unavailable"
          : "automatch-persistence-backend-retired",
      );
      expect(fixture.metadataReads).toEqual([]);
      expect(fixture.reads).toEqual([]);
    },
  );

  it("keeps the event intent pending when indexing fails after match creation", async () => {
    const fixture = eventTransitionFixture(testEnv);
    const repository = fixture.client;
    await repository.commitEventPlan(
      decodeEventUpdates({ [`events/${eventId}`]: eventRecord() }),
    );
    await rejectIndexWrites();
    try {
      await expect(
        repository.commitEventPlan(
          decodeEventUpdates({
            [`events/${eventId}/status`]: "active",
            [`events/${eventId}/rounds`]: eventRounds(),
            ...matchEffects(),
          }),
        ),
      ).rejects.toThrow("event-discovery-write-failed");
      expect(
        await listPendingEventTransitionIntents(testEnv.EVENT_DB),
      ).toHaveLength(1);
      expect(fixture.writes).toHaveLength(2);
      expect(await indexedRows()).toEqual([]);
    } finally {
      await permitIndexWrites();
    }
    const hostMatchPath = `players/${hostUid}/matches/${inviteId}`;
    fixture.values.set(hostMatchPath, { fen: "advanced" });
    await expect(fixture.recover()).resolves.toBe(1);
    expect(fixture.writes).toHaveLength(2);
    expect(fixture.values.get(hostMatchPath)).toEqual({ fen: "advanced" });
    expect(await listPendingEventTransitionIntents(testEnv.EVENT_DB)).toEqual(
      [],
    );
    expect(await indexedRows()).toEqual(
      [hostUid, guestUid].sort().map((loginUid) => ({
        login_uid: loginUid,
        match_id: inviteId,
        invite_id: inviteId,
        resolution: "resolved",
        provenance: "capture",
      })),
    );
  });

  it.each([
    { coverage: "missing", capturedUid: null },
    { coverage: "host-only", capturedUid: hostUid },
    { coverage: "guest-only", capturedUid: guestUid },
  ])(
    "captures old Workflow output with $coverage discovery before event outbox acknowledgment",
    async ({ capturedUid }) => {
      if (capturedUid) {
        await seedInvite(inviteId);
        await captureLoginMatchDiscovery(testEnv.PROFILE_GAMES_DB, [
          { loginUid: capturedUid, matchId: inviteId, inviteId },
        ]);
      }
      const fixture = stateFixture(matchEffects());
      const repository = createEventStateRepository(
        testEnv,
        eventMatchTestPort(fixture.client),
      );
      const outboxPath = `profileGameProjectionOutbox/event/${eventId}`;
      await repository.commitEventPlan(
        decodeEventUpdates({
          [`events/${eventId}`]: {
            ...eventRecord(),
            status: "active",
            rounds: eventRounds(),
          },
          [outboxPath]: {
            schemaVersion: 1,
            status: "pending",
            requestId: "old-workflow-projection",
            lastQueuedAtMs: 100,
            cleanupOwnerProfileIds: {},
          },
        }),
      );
      const runtime = createEventProfileGameProjectionRuntime(testEnv, {
        state: {
          ...fixture.reader,
          readEvent: repository.readEvent,
        },
        wait: async () => undefined,
      });
      const process = () =>
        processEventProfileGameProjection(
          {
            kind: "event-profile-game-projection",
            eventId,
            requestId: "old-workflow-projection",
          },
          {
            ...repository,
          },
          runtime,
        );
      await rejectIndexWrites();
      try {
        await expect(process()).rejects.toThrow("event-discovery-write-failed");
        expect(
          await readEventRepositoryFixture(repository, outboxPath),
        ).not.toBeNull();
        expect((await indexedRows()).map((row) => row.login_uid)).toEqual(
          capturedUid ? [capturedUid] : [],
        );
      } finally {
        await permitIndexWrites();
      }
      await expect(process()).resolves.toBe("projected");
      expect(
        await readEventRepositoryFixture(repository, outboxPath),
      ).toBeNull();
      expect((await indexedRows()).map((row) => row.login_uid)).toEqual(
        [hostUid, guestUid].sort(),
      );
      expect(fixture.reads).not.toContain(
        `players/changed-bracket-login/matches/${inviteId}`,
      );
      expect(fixture.metadataReads).toContain(inviteId);
      for (const uid of [hostUid, guestUid]) {
        expect(fixture.reads).toContain(`players/${uid}/matches/${inviteId}`);
      }
      expect(fixture.reads).not.toContain(`invites/${inviteId}`);
    },
  );

  it("captures original actors even when current profile ownership is unavailable", async () => {
    const fixture = stateFixture({
      ...matchEffects(),
      [`events/${eventId}`]: {
        ...eventRecord(),
        rounds: eventRounds(),
        participants: { absent: { profileId: "absent", loginUid: hostUid } },
      },
    });
    const runtime = createEventProfileGameProjectionRuntime(testEnv, {
      state: {
        ...fixture.reader,
        readEvent: fixture.client.readEvent,
      },
      wait: async () => undefined,
    });
    await expect(runtime.reconcileEventProjection(eventId)).rejects.toThrow();
    expect((await indexedRows()).map((row) => row.login_uid)).toEqual(
      [hostUid, guestUid].sort(),
    );
  });

  it("requires both physical matches and includes the third-place invite", async () => {
    const fixture = stateFixture(matchEffects());
    fixture.values.delete(`players/${guestUid}/matches/${inviteId}`);
    const ids = eventMatchInviteIds({
      rounds: {},
      thirdPlaceMatch: { inviteId },
    });
    await expect(
      captureEventMatchDiscovery(testEnv.PROFILE_GAMES_DB, fixture.reader, ids),
    ).rejects.toThrow("event-match-discovery-match-unavailable");
    expect(await indexedRows()).toEqual([]);
  });

  it("captures each four-invite chunk with one ordered match batch", async () => {
    const fixture = captureFixture(5);
    const readMatchRecords = fixture.reader.readMatchRecords;
    fixture.reader.readMatchRecords = async (inputs, signal) => {
      expect(fixture.metadataReads).toHaveLength(
        fixture.matchBatches.length === 0 ? 4 : 5,
      );
      expect(await indexedRows()).toHaveLength(
        fixture.matchBatches.length === 0 ? 0 : 8,
      );
      return readMatchRecords(inputs, signal);
    };
    await captureEventMatchDiscovery(
      testEnv.PROFILE_GAMES_DB,
      fixture.reader,
      fixture.ids,
    );
    expect(fixture.matchBatches.map((batch) => batch.length)).toEqual([8, 2]);
    expect(fixture.matchBatches.flat()).toEqual(
      fixture.ids.flatMap((matchId) =>
        [hostUid, guestUid].map((playerId) => ({ playerId, matchId })),
      ),
    );
    expect(await indexedRows()).toHaveLength(10);
  });

  it("keeps completed chunks but captures no part of an incomplete match batch", async () => {
    const fixture = captureFixture(9);
    fixture.values.delete(`players/${guestUid}/matches/${fixture.ids[5]}`);
    await expect(
      captureEventMatchDiscovery(
        testEnv.PROFILE_GAMES_DB,
        fixture.reader,
        fixture.ids,
      ),
    ).rejects.toThrow("event-match-discovery-match-unavailable");
    expect(fixture.matchBatches.map((batch) => batch.length)).toEqual([8, 8]);
    expect(fixture.metadataReads).toEqual(fixture.ids.slice(0, 8));
    const captured = await indexedRows();
    expect(captured).toHaveLength(8);
    expect(new Set(captured.map((row) => row.match_id))).toEqual(
      new Set(fixture.ids.slice(0, 4)),
    );
  });

  it("does not capture a returned batch or start another chunk after cancellation", async () => {
    const fixture = captureFixture(9);
    const controller = new AbortController();
    const reason = new Error("discovery-cancelled");
    const readMatchRecords = fixture.reader.readMatchRecords;
    fixture.reader.readMatchRecords = async (inputs, signal) => {
      expect(signal).toBe(controller.signal);
      const matches = await readMatchRecords(inputs, signal);
      if (fixture.matchBatches.length === 2) controller.abort(reason);
      return matches;
    };
    await expect(
      captureEventMatchDiscovery(
        testEnv.PROFILE_GAMES_DB,
        fixture.reader,
        fixture.ids,
        controller.signal,
      ),
    ).rejects.toBe(reason);
    expect(fixture.matchBatches.map((batch) => batch.length)).toEqual([8, 8]);
    expect(fixture.metadataReads).toEqual(fixture.ids.slice(0, 8));
    const captured = await indexedRows();
    expect(captured).toHaveLength(8);
    expect(new Set(captured.map((row) => row.match_id))).toEqual(
      new Set(fixture.ids.slice(0, 4)),
    );
  });

  it("reads sparse Firebase arrays and rejects malformed bracket collections", () => {
    expect(
      eventMatchInviteIds({
        rounds: [null, { matches: [null, { inviteId }] }],
        thirdPlaceMatch: { inviteId: "third-place-invite" },
      }),
    ).toEqual([inviteId, "third-place-invite"]);
    for (const malformed of [
      { rounds: "invalid" },
      { rounds: [false] },
      { rounds: [{ matches: "invalid" }] },
      { rounds: [{ matches: [false] }] },
      { thirdPlaceMatch: false },
    ]) {
      expect(() => eventMatchInviteIds(malformed)).toThrow(
        "event-match-discovery-invalid-bracket",
      );
    }
  });

  it("rejects unjournaled match creation before applying any effects", async () => {
    const fixture = stateFixture();
    const repository = createEventStateRepository(
      testEnv,
      eventMatchTestPort(fixture.client),
    );
    for (const updates of [
      matchEffects(),
      { [`events/${eventId}`]: eventRecord(), ...matchEffects() },
    ]) {
      await expect(
        repository.commitEventPlan(decodeEventUpdates(updates)),
      ).rejects.toThrow("event-match-creation-requires-transition");
    }
    expect("transactPath" in repository).toBe(false);
    expect(fixture.patches).toEqual([]);
    expect(await repository.readEvent(eventId)).toBeNull();
  });

  it("bounds event discovery before reading an oversized bracket", async () => {
    const fixture = stateFixture();
    await expect(
      captureEventMatchDiscovery(
        testEnv.PROFILE_GAMES_DB,
        fixture.reader,
        Array.from({ length: 33 }, (_, index) => `invite-${index}`),
      ),
    ).rejects.toThrow("event-match-discovery-invalid-invites");
    expect(fixture.reads).toEqual([]);
    expect(fixture.metadataReads).toEqual([]);
    await expect(
      ensureEventMatchDiscovery(
        testEnv.PROFILE_GAMES_DB,
        fixture.reader,
        Array.from({ length: 33 }, (_, index) => `invite-${index}`),
      ),
    ).rejects.toThrow("event-match-discovery-invalid-invites");
    expect(fixture.reads).toEqual([]);
    expect(fixture.metadataReads).toEqual([]);
  });
});
