import { beforeAll, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import {
  assertImportAllowed,
  buildImportSql,
  normalizeSnapshot,
  verifyImportedSnapshot,
} from "../../../../scripts/migrate-events-d1.ts";
import {
  acquireEventWriteAdmission,
  listPendingEventTransitionIntents,
  markEventImportVerified,
  readEventRuntimeControl,
  readEventSnapshot,
  readProfileEventPrizes,
  releaseEventWriteAdmission,
  transitionEventStorageMode,
} from "../src/eventD1.ts";
import { handleEventReadRoute } from "../src/eventReadRoute.ts";
import {
  createEventRtdbClient,
  recoverEventTransitionIntents,
} from "../src/eventRepository.ts";

const testEnv = env as Env & {
  TEST_EVENT_D1_MIGRATIONS: D1Migration[];
  TEST_EVENT_RTDB_EMULATOR_HOST: string;
};
const eventId = "NN3eRzoZo81";
const endedEventId = "NN3eRzoZo80";
const profileId = "profile-one";
const eventPath = `events/${eventId}`;
const matchPath = "players/login-one/matches/cutover-match";
const emptySupport = {
  eventProfileGameProjectionOutboxes: {},
  eventProgressOutbox: {},
  eventProgressOutboxDead: {},
  eventTelegramProjectionGenerations: {},
  eventTelegramProjectionOutboxes: {},
  eventTelegramProjections: {},
};

beforeAll(async () => {
  await applyD1Migrations(testEnv.EVENT_DB, testEnv.TEST_EVENT_D1_MIGRATIONS);
});

it.runIf(Boolean(testEnv.TEST_EVENT_RTDB_EMULATOR_HOST))(
  "rehearses verified cutover and interrupted recovery against the RTDB emulator",
  async () => {
    expect(testEnv.TEST_EVENT_RTDB_EMULATOR_HOST).toMatch(
      /^(?:127\.0\.0\.1|localhost):\d+$/,
    );
    const namespace = `demo-mons-cutover-${crypto.randomUUID()}`;
    async function rtdb(
      method: string,
      path: string,
      value?: unknown,
    ): Promise<unknown> {
      const response = await fetch(
        `http://${testEnv.TEST_EVENT_RTDB_EMULATOR_HOST}/${path}.json?ns=${namespace}`,
        {
          method,
          headers: {
            Authorization: "Bearer owner",
            "Content-Type": "application/json",
          },
          body: value === undefined ? undefined : JSON.stringify(value),
        },
      );
      if (!response.ok) throw new Error(`RTDB emulator: ${response.status}`);
      return response.json();
    }
    let interruptEffect = false;
    let matchEffectWrites = 0;
    const base = {
      getPath: (path: string) => rtdb("GET", path),
      patchRoot: async (updates: Record<string, unknown>) => {
        await rtdb("PATCH", "", updates);
        if (Object.hasOwn(updates, matchPath)) {
          matchEffectWrites += 1;
          if (interruptEffect) {
            interruptEffect = false;
            throw new Error("lost-rtdb-success-response");
          }
        }
      },
      transactPath: async () => {
        throw new Error("unexpected RTDB transaction");
      },
    };
    const client = createEventRtdbClient(testEnv, base);
    const dependencies = {
      repository: {
        getRtdbPath: base.getPath,
        readProfileOwnershipSnapshot: async () => {
          throw new Error("event snapshots do not require profile lookup");
        },
      },
      verifyIdentity: async () => ({ uid: "login-one" }),
    };
    const read = (headers: Record<string, string> = {}) =>
      handleEventReadRoute(
        new Request(
          `https://api.mons.link/events/snapshot?eventId=${eventId}`,
          {
            headers: { Origin: "https://mons.link", ...headers },
          },
        ),
        testEnv,
        { waitUntil() {} },
        dependencies,
      );
    const event = {
      schemaVersion: 2,
      eventId,
      status: "scheduled",
      createdAtMs: 100,
      updatedAtMs: 100,
      startAtMs: 1_000,
      createdByProfileId: profileId,
      createdByLoginUid: "login-one",
      createdByUsername: "ivan",
      participants: {},
      rounds: {},
    };
    const assignment = {
      eventId: endedEventId,
      profileId,
      place: 1,
      prizeId: "1092",
      assignedAtMs: 200,
    };
    try {
      await client.patchRoot({
        [eventPath]: event,
        [`events/${endedEventId}`]: {
          ...event,
          eventId: endedEventId,
          status: "ended",
          updatedAtMs: 200,
          prizeAssignments: { 1: assignment },
        },
        [`eventPrizeSelections/${endedEventId}/${profileId}`]: "1092",
        [`profileEventPrizes/${profileId}/${endedEventId}`]: assignment,
      });
      const oldSession = await read();
      const firebaseEvent = await base.getPath(eventPath);
      expect(oldSession.status).toBe(200);
      expect(oldSession.headers.get("X-D1-Bookmark")).toBe("firebase");
      expect(await oldSession.json()).toMatchObject({ event: firebaseEvent });

      const freeze = () =>
        transitionEventStorageMode(testEnv.EVENT_DB, {
          expected: { storageMode: "firebase", previousStorageMode: null },
          next: { storageMode: "frozen", previousStorageMode: "firebase" },
          nowMs: 300,
        });
      const admission = await acquireEventWriteAdmission(testEnv.EVENT_DB);
      try {
        await expect(freeze()).rejects.toThrow();
      } finally {
        await releaseEventWriteAdmission(testEnv.EVENT_DB, admission);
      }
      const frozen = await freeze();
      await expect(
        client.patchRoot({ [`${eventPath}/updatedAtMs`]: 301 }),
      ).rejects.toThrow("event-writes-disabled");
      const activate = () =>
        transitionEventStorageMode(testEnv.EVENT_DB, {
          expected: {
            storageMode: "frozen",
            previousStorageMode: "firebase",
          },
          next: { storageMode: "d1", previousStorageMode: null },
          cutoverAtMs: 400,
          nowMs: 400,
        });
      await expect(activate()).rejects.toThrow();
      const importState = {
        eventControl: frozen,
        eventWriteAdmissions: 0,
        expectedFreezeGeneration: frozen.freezeGeneration,
        profileControl: "frozen",
        withdrawalControl: {
          storageMode: "frozen" as const,
          previousStorageMode: "d1" as const,
          freezeGeneration: 1,
          verifiedImportGeneration: null,
        },
        withdrawalPendingCount: 0,
        inspection: {
          activeEventLeases: 0,
          activeProfileGameProjectionLeases: 0,
          activeTelegramProjectionLeases: 0,
          eventSyncThrottles: 0,
        },
      };
      expect(() =>
        assertImportAllowed("final", {
          ...importState,
          withdrawalPendingCount: 1,
        }),
      ).toThrow("not quiescent");
      assertImportAllowed("final", importState);
      const source = normalizeSnapshot({
        ...emptySupport,
        events: await base.getPath("events"),
        eventPrizeSelections: await base.getPath("eventPrizeSelections"),
        profileEventPrizes: await base.getPath("profileEventPrizes"),
      });
      const statements = buildImportSql(
        source,
        350,
        "final",
        frozen.freezeGeneration,
      )
        .split(";")
        .map((sql) => sql.trim())
        .filter(Boolean)
        .map((sql) => testEnv.EVENT_DB.prepare(sql));
      await testEnv.EVENT_DB.batch(statements);
      const importedEvent = await readEventSnapshot(testEnv.EVENT_DB, eventId);
      const importedEnded = await readEventSnapshot(
        testEnv.EVENT_DB,
        endedEventId,
      );
      const importedPrizes = await readProfileEventPrizes(
        testEnv.EVENT_DB,
        profileId,
      );
      const proof = verifyImportedSnapshot(
        source,
        normalizeSnapshot({
          ...emptySupport,
          events: {
            [eventId]: importedEvent.event,
            [endedEventId]: importedEnded.event,
          },
          eventPrizeSelections: {
            [endedEventId]: importedEnded.prizeSelections,
          },
          profileEventPrizes: { [profileId]: importedPrizes.prizes },
        }),
      );
      expect(proof).toMatchObject({
        events: 2,
        selections: 1,
        assignedPrizes: 1,
      });
      await markEventImportVerified(testEnv.EVENT_DB, {
        expectedFreezeGeneration: frozen.freezeGeneration,
        sourceDigest: proof.digest,
        nowMs: 375,
      });
      await activate();
      expect(await readEventRuntimeControl(testEnv.EVENT_DB)).toMatchObject({
        storageMode: "d1",
        verifiedImportGeneration: frozen.freezeGeneration,
      });
      const resumed = await read({
        "If-None-Match": oldSession.headers.get("ETag")!,
        "X-D1-Bookmark": oldSession.headers.get("X-D1-Bookmark")!,
      });
      expect(resumed.status).toBe(200);
      expect(resumed.headers.get("X-D1-Bookmark")).toBeTruthy();
      expect(resumed.headers.get("X-D1-Bookmark")).not.toBe("firebase");
      expect(await resumed.json()).toMatchObject({
        event: source.events[eventId],
        revision: 1,
      });

      interruptEffect = true;
      await expect(
        client.patchRoot({
          [`${eventPath}/status`]: "active",
          [`${eventPath}/updatedAtMs`]: 500,
          [matchPath]: { fen: "initial", flatMovesString: "" },
        }),
      ).rejects.toThrow("lost-rtdb-success-response");
      expect(
        await listPendingEventTransitionIntents(testEnv.EVENT_DB),
      ).toHaveLength(1);
      expect(await readEventSnapshot(testEnv.EVENT_DB, eventId)).toMatchObject({
        event: { status: "scheduled" },
        revision: 1,
      });
      const advancedMatch = { fen: "advanced", flatMovesString: "l0,0;l1,1" };
      await rtdb("PATCH", "", { [matchPath]: advancedMatch });
      await expect(
        recoverEventTransitionIntents(testEnv, {
          getRtdbPath: base.getPath,
          patchRtdbRoot: base.patchRoot,
        }),
      ).resolves.toBe(1);
      expect(await base.getPath(matchPath)).toEqual(advancedMatch);
      expect(matchEffectWrites).toBe(1);
      expect(await listPendingEventTransitionIntents(testEnv.EVENT_DB)).toEqual(
        [],
      );
      expect(await readEventSnapshot(testEnv.EVENT_DB, eventId)).toMatchObject({
        event: { status: "active", updatedAtMs: 500 },
        revision: 2,
      });
      expect(await base.getPath(eventPath)).toEqual(firebaseEvent);
    } finally {
      await rtdb("DELETE", "");
    }
  },
  30_000,
);
