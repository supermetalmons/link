import { env } from "cloudflare:workers";
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  captureEventMatchDiscovery,
  eventMatchInviteIds,
} from "../src/eventLoginMatchDiscovery.ts";
import {
  createEventRtdbClient,
  recoverEventTransitionIntents,
} from "../src/eventRepository.ts";
import { listPendingEventTransitionIntents } from "../src/eventD1.ts";
import { processEventProfileGameProjection } from "../src/profileGameProjection.ts";
import { createEventProfileGameProjectionRuntime } from "../src/profileGameProjectionRepository.ts";
import type { FirebaseRtdbClient } from "../src/firebaseRtdb.ts";
import { applyEventTestMigrations } from "./eventTestMigrations.ts";
import { applyRetiredProfileMigrations } from "./profileTestMigrations.ts";

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
    [`players/${hostUid}/matches/${inviteId}`]: { fen: "initial" },
    [`players/${guestUid}/matches/${inviteId}`]: { fen: "initial" },
  };
}

function rtdbFixture(initial: Record<string, unknown> = {}) {
  const values = new Map(Object.entries(initial));
  const patches: Record<string, unknown>[] = [];
  const reads: string[] = [];
  const client: FirebaseRtdbClient = {
    async getPath(path, query) {
      reads.push(path);
      if (path.startsWith("players/")) expect(query).toEqual({ shallow: true });
      return values.get(path) ?? null;
    },
    async patchRoot(updates) {
      patches.push(updates);
      for (const [path, value] of Object.entries(updates)) {
        if (value === null) values.delete(path);
        else values.set(path, structuredClone(value));
      }
    },
    async transactPath() {
      throw new Error("unexpected-rtdb-transaction");
    },
  };
  return { client, patches, reads, values };
}

async function indexedRows() {
  return (
    await testEnv.PROFILE_GAMES_DB.prepare(
      "SELECT login_uid, match_id, invite_id, resolution, provenance FROM login_match_discovery ORDER BY login_uid, match_id",
    ).all()
  ).results;
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
    await applyD1Migrations(
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
    await permitIndexWrites();
    await testEnv.PROFILE_GAMES_DB.prepare(
      "DELETE FROM login_match_discovery",
    ).run();
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

  it("keeps the event intent pending when indexing fails after RTDB commit", async () => {
    const fixture = rtdbFixture();
    const repository = createEventRtdbClient(testEnv, fixture.client);
    await repository.patchRoot({ [`events/${eventId}`]: eventRecord() });
    await rejectIndexWrites();
    try {
      await expect(
        repository.patchRoot({
          [`events/${eventId}/status`]: "active",
          [`events/${eventId}/rounds`]: eventRounds(),
          ...matchEffects(),
        }),
      ).rejects.toThrow("event-discovery-write-failed");
      expect(
        await listPendingEventTransitionIntents(testEnv.EVENT_DB),
      ).toHaveLength(1);
      expect(fixture.patches).toHaveLength(1);
      expect(await indexedRows()).toEqual([]);
    } finally {
      await permitIndexWrites();
    }
    const hostMatchPath = `players/${hostUid}/matches/${inviteId}`;
    fixture.values.set(hostMatchPath, { fen: "advanced" });
    await expect(
      recoverEventTransitionIntents(testEnv, {
        getRtdbPath: fixture.client.getPath,
        patchRtdbRoot: fixture.client.patchRoot,
      }),
    ).resolves.toBe(1);
    expect(fixture.patches).toHaveLength(1);
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

  it("captures old Workflow output before event outbox acknowledgment", async () => {
    const fixture = rtdbFixture(matchEffects());
    const repository = createEventRtdbClient(testEnv, fixture.client);
    const outboxPath = `profileGameProjectionOutbox/event/${eventId}`;
    await repository.patchRoot({
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
    });
    const runtime = createEventProfileGameProjectionRuntime(testEnv, {
      rtdb: { getRtdbPath: repository.getPath },
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
          getRtdbPath: repository.getPath,
          transactRtdbPath: repository.transactPath,
        },
        runtime,
      );
    await rejectIndexWrites();
    try {
      await expect(process()).rejects.toThrow("event-discovery-write-failed");
      expect(await repository.getPath(outboxPath)).not.toBeNull();
    } finally {
      await permitIndexWrites();
    }
    await expect(process()).resolves.toBe("projected");
    expect(await repository.getPath(outboxPath)).toBeNull();
    expect((await indexedRows()).map((row) => row.login_uid)).toEqual(
      [hostUid, guestUid].sort(),
    );
    expect(fixture.reads).not.toContain(
      `players/changed-bracket-login/matches/${inviteId}`,
    );
  });

  it("captures original actors even when current profile ownership is unavailable", async () => {
    const fixture = rtdbFixture({
      ...matchEffects(),
      [`events/${eventId}`]: {
        ...eventRecord(),
        rounds: eventRounds(),
        participants: { absent: { profileId: "absent", loginUid: hostUid } },
      },
    });
    const runtime = createEventProfileGameProjectionRuntime(testEnv, {
      rtdb: { getRtdbPath: fixture.client.getPath },
      wait: async () => undefined,
    });
    await expect(runtime.reconcileEventProjection(eventId)).rejects.toThrow();
    expect((await indexedRows()).map((row) => row.login_uid)).toEqual(
      [hostUid, guestUid].sort(),
    );
  });

  it("requires both physical matches and includes the third-place invite", async () => {
    const fixture = rtdbFixture(matchEffects());
    fixture.values.delete(`players/${guestUid}/matches/${inviteId}`);
    const ids = eventMatchInviteIds({
      rounds: {},
      thirdPlaceMatch: { inviteId },
    });
    await expect(
      captureEventMatchDiscovery(
        testEnv.PROFILE_GAMES_DB,
        fixture.client.getPath,
        ids,
      ),
    ).rejects.toThrow("event-match-discovery-match-unavailable");
    expect(await indexedRows()).toEqual([]);
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
    const fixture = rtdbFixture();
    const repository = createEventRtdbClient(testEnv, fixture.client);
    for (const updates of [
      matchEffects(),
      { [`events/${eventId}`]: eventRecord(), ...matchEffects() },
    ]) {
      await expect(repository.patchRoot(updates)).rejects.toThrow(
        "event-match-creation-requires-transition",
      );
    }
    await expect(
      repository.transactPath(`players/${hostUid}/matches/${inviteId}`, () => ({
        value: { fen: "new" },
      })),
    ).rejects.toThrow("event-match-creation-requires-transition");
    expect(fixture.patches).toEqual([]);
    expect(await repository.getPath(`events/${eventId}`)).toBeNull();
  });

  it("bounds event discovery before reading an oversized bracket", async () => {
    const fixture = rtdbFixture();
    await expect(
      captureEventMatchDiscovery(
        testEnv.PROFILE_GAMES_DB,
        fixture.client.getPath,
        Array.from({ length: 33 }, (_, index) => `invite-${index}`),
      ),
    ).rejects.toThrow("event-match-discovery-invalid-invites");
    expect(fixture.reads).toEqual([]);
  });
});
