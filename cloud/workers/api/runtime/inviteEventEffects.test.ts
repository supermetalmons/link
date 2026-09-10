import { env } from "cloudflare:workers";
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  acquireEventWriteAdmission,
  createEventTransitionIntent,
  listPendingEventTransitionIntents,
  readEventSnapshot,
  releaseEventWriteAdmission,
} from "../src/eventD1.ts";
import {
  createEventRtdbClient,
  recoverEventTransitionIntents,
} from "../src/eventRepository.ts";
import type { FirebaseRtdbClient } from "../src/firebaseRtdb.ts";
import { createInviteSourceD1Store } from "../src/inviteSourceD1.ts";
import { prepareInviteEventIntent } from "../src/inviteEventEffects.ts";
import { applyEventTestMigrations } from "./eventTestMigrations.ts";
import { resetEventReceiptTestState } from "./eventTransitionTestFixture.ts";
import {
  ensureEventTransitionReceipt,
  readEventTransitionReceipt,
} from "../src/eventTransitionReceiptsD1.ts";
import {
  prepareCreatedMatchPresentations,
  readRegisteredMatchPresentations,
  type MatchPresentationCreation,
  type PrepareMatchPresentations,
} from "../src/matchPresentationRegistry.ts";
import { resetMatchPresentationTestState } from "./matchPresentationTestFixture.ts";

const testEnv = env as Env & {
  TEST_D1_MIGRATIONS: D1Migration[];
  TEST_EVENT_D1_MIGRATIONS: D1Migration[];
};
const eventId = "invite-source-event";
const inviteId = "event-invite";
const hostPath = `players/host/matches/${inviteId}`;
const guestPath = `players/guest/matches/${inviteId}`;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function eventRecord() {
  return {
    schemaVersion: 2,
    eventId,
    status: "scheduled",
    createdAtMs: 100,
    updatedAtMs: 100,
    startAtMs: 1_000,
    createdByProfileId: "profile-one",
    createdByLoginUid: "host",
    createdByUsername: "ivan",
    participants: {},
    rounds: {},
  };
}

function matchEffects(id = inviteId) {
  return {
    [`invites/${id}`]: {
      version: 2,
      eventId,
      eventOwned: true,
      eventRoundIndex: 0,
      eventMatchKey: "0_0",
      hostId: "host",
      guestId: "guest",
      hostColor: "white",
    },
    [`players/host/matches/${id}`]: {
      fen: "initial",
      flatMovesString: "",
      color: "white",
      emojiId: 2,
      aura: "host-aura",
    },
    [`players/guest/matches/${id}`]: {
      fen: "initial",
      flatMovesString: "",
      color: "black",
      emojiId: 3,
      aura: "guest-aura",
    },
  };
}

function fixture(profileGamesDb = testEnv.PROFILE_GAMES_DB) {
  const values = new Map<string, unknown>();
  const writes: string[] = [];
  const reads: string[] = [];
  const hooks: {
    failBeforePath?: string;
    failAfterPath?: string;
    afterWrite?: (path: string) => Promise<void>;
    prepareMatchPresentations?: PrepareMatchPresentations;
  } = {};
  const raw: FirebaseRtdbClient = {
    async getPath(path) {
      expect(path.startsWith("invites/")).toBe(false);
      expect(path.startsWith("eventTransitionReceipts/")).toBe(false);
      reads.push(path);
      return structuredClone(values.get(path) ?? null);
    },
    async patchRoot(updates) {
      for (const [path, value] of Object.entries(updates)) {
        expect(path.startsWith("invites/")).toBe(false);
        expect(path.startsWith("eventTransitionReceipts/")).toBe(false);
        expect(/^players\/[^/]+\/matches\/[^/]+$/.test(path)).toBe(false);
        writes.push(path);
        if (value === null) values.delete(path);
        else values.set(path, structuredClone(value));
      }
    },
    async transactPath(path, updater, signal, beforeWrite) {
      signal?.throwIfAborted();
      expect(path.startsWith("invites/")).toBe(false);
      expect(path.startsWith("eventTransitionReceipts/")).toBe(false);
      if (hooks.failBeforePath === path) {
        hooks.failBeforePath = undefined;
        throw new Error("rtdb-before-create");
      }
      const current = structuredClone(values.get(path) ?? null);
      const result = updater(current);
      if (!record(result)) throw new Error("invalid-test-decision");
      if (result.commit === false) {
        return {
          committed: false,
          value: current,
          decision: String(result.decision),
        };
      }
      await beforeWrite?.({ current, proposed: result.value, etag: "test" });
      writes.push(path);
      values.set(path, structuredClone(result.value));
      await hooks.afterWrite?.(path);
      if (hooks.failAfterPath === path) {
        hooks.failAfterPath = undefined;
        throw new Error("rtdb-ambiguous-create");
      }
      return {
        committed: true,
        value: result.value,
        decision: String(result.decision),
      };
    },
  };
  const source = createInviteSourceD1Store(profileGamesDb);
  const base: FirebaseRtdbClient = {
    getPath: (path, query, signal) =>
      path.startsWith("invites/")
        ? source.getPath(path, query, signal)
        : raw.getPath(path, query, signal),
    async patchRoot() {
      throw new Error("event-effects-escaped-to-session-coordinator");
    },
    async transactPath() {
      throw new Error("event-effects-escaped-to-session-coordinator");
    },
  };
  const fixtureEnv = { ...testEnv, PROFILE_GAMES_DB: profileGamesDb };
  const prepareMatchPresentations: PrepareMatchPresentations = (creations) =>
    hooks.prepareMatchPresentations?.(creations) ||
    Promise.resolve(appearanceRegistrations(creations));
  const client = createEventRtdbClient(
    fixtureEnv,
    base,
    raw,
    prepareMatchPresentations,
  );
  return {
    values,
    writes,
    reads,
    hooks,
    source,
    raw,
    client,
    create: () => client.patchRoot({ [`events/${eventId}`]: eventRecord() }),
    start: (extra = {}) =>
      client.patchRoot({
        [`events/${eventId}/status`]: "active",
        [`events/${eventId}/updatedAtMs`]: 200,
        ...matchEffects(),
        ...extra,
      }),
    recover: () =>
      recoverEventTransitionIntents(
        fixtureEnv,
        100,
        raw,
        prepareMatchPresentations,
      ),
  };
}

async function count(table: string) {
  if (
    ![
      "invite_sources",
      "invite_event_effect_receipts",
      "event_transition_receipts",
      "login_match_discovery",
      "invite_source_write_admissions",
      "match_presentation_registrations",
    ].includes(table)
  ) {
    throw new Error("unsupported-test-table");
  }
  return testEnv.PROFILE_GAMES_DB.prepare(
    `SELECT COUNT(*) AS count FROM ${table}`,
  ).first<number>("count");
}

function appearanceRegistrations(
  creations: readonly MatchPresentationCreation[],
) {
  return creations.map((creation) => ({
    ...creation,
    seedDigest: "a".repeat(64),
    provenance: "creation" as const,
  }));
}

describe("event transitions with canonical D1 invitation metadata", () => {
  beforeAll(async () => {
    await applyD1Migrations(
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
      testEnv.PROFILE_GAMES_DB.prepare(
        "DROP TRIGGER IF EXISTS reject_event_source_discovery",
      ),
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
    await testEnv.EVENT_DB.batch([
      testEnv.EVENT_DB.prepare(
        "DROP TRIGGER IF EXISTS reject_event_source_finalization",
      ),
      testEnv.EVENT_DB.prepare(
        "UPDATE event_records SET pending_transition_id = NULL",
      ),
      testEnv.EVENT_DB.prepare("DELETE FROM event_transition_intents"),
      testEnv.EVENT_DB.prepare("DELETE FROM event_leases"),
      testEnv.EVENT_DB.prepare("DELETE FROM event_write_admissions"),
      testEnv.EVENT_DB.prepare("DELETE FROM event_records"),
    ]);
    await resetEventReceiptTestState(
      testEnv.PROFILE_GAMES_DB,
      testEnv.TEST_D1_MIGRATIONS,
    );
  });

  it("atomically publishes every event invite and discovery row after proving its two live matches", async () => {
    const f = fixture();
    f.hooks.prepareMatchPresentations = async (creations) => {
      expect(creations).toHaveLength(4);
      expect(await count("invite_sources")).toBe(0);
      expect(await count("match_presentation_registrations")).toBe(0);
      for (const creation of creations) {
        expect(
          f.values.get(
            `players/${creation.actorUid}/matches/${creation.matchId}`,
          ),
        ).toMatchObject({
          emojiId: creation.emojiId,
          aura: creation.aura,
          sessionCreation: creation.sourceId,
        });
      }
      return appearanceRegistrations(creations);
    };
    await f.create();
    await f.start(matchEffects("third-place-invite"));
    expect(await count("invite_sources")).toBe(2);
    expect(await count("invite_event_effect_receipts")).toBe(1);
    expect(await count("event_transition_receipts")).toBe(1);
    expect(await count("login_match_discovery")).toBe(4);
    expect(await count("match_presentation_registrations")).toBe(4);
    expect(await count("invite_source_write_admissions")).toBe(0);
    expect((await f.source.read(inviteId)).value).toEqual(
      matchEffects()[`invites/${inviteId}`],
    );
    expect(f.values.get(hostPath)).toMatchObject({
      fen: "initial",
      sessionCreation: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(await readEventSnapshot(testEnv.EVENT_DB, eventId)).toMatchObject({
      event: { status: "active" },
      revision: 2,
    });
    expect(await listPendingEventTransitionIntents(testEnv.EVENT_DB)).toEqual(
      [],
    );
  });

  it("fences an old event writer and recovers its durable effects with registered appearances", async () => {
    const f = fixture();
    await f.create();
    f.hooks.prepareMatchPresentations = async () => [];
    await expect(f.start()).rejects.toThrow(
      "match-presentation-capture-required",
    );
    expect(f.writes).toEqual([hostPath, guestPath]);
    expect(await count("invite_sources")).toBe(0);
    expect(await count("invite_event_effect_receipts")).toBe(0);
    expect(await count("match_presentation_registrations")).toBe(0);
    expect(
      await listPendingEventTransitionIntents(testEnv.EVENT_DB),
    ).toHaveLength(1);
    f.hooks.prepareMatchPresentations = (creations) =>
      prepareCreatedMatchPresentations(env, creations);
    await f.recover();
    expect(await count("invite_sources")).toBe(1);
    expect(await count("match_presentation_registrations")).toBe(2);
    expect(
      await readRegisteredMatchPresentations(env, inviteId, inviteId),
    ).toMatchObject({
      matchId: inviteId,
      players: {
        host: { actorUid: "host", emojiId: 2, aura: "host-aura", revision: 0 },
        guest: {
          actorUid: "guest",
          emojiId: 3,
          aura: "guest-aura",
          revision: 0,
        },
      },
    });
    expect(f.writes).toEqual([hostPath, guestPath]);
    expect(f.reads).toEqual([]);
    expect(await listPendingEventTransitionIntents(testEnv.EVENT_DB)).toEqual(
      [],
    );
  });

  it("keeps appearance failures recoverable after Firebase confirmation without resetting current appearance", async () => {
    const f = fixture();
    const prepared: MatchPresentationCreation[][] = [];
    const current = new Map<string, { emojiId: number; aura: string }>();
    let failAppearance = true;
    f.hooks.prepareMatchPresentations = async (creations) => {
      prepared.push(structuredClone([...creations]));
      for (const creation of creations) {
        const key = `${creation.matchId}/${creation.actorUid}`;
        if (!current.has(key))
          current.set(key, { emojiId: creation.emojiId, aura: creation.aura });
      }
      if (failAppearance) throw new Error("appearance-unavailable");
      return appearanceRegistrations(creations);
    };
    await f.create();
    await expect(f.start()).rejects.toThrow("appearance-unavailable");
    expect(f.writes).toEqual([hostPath, guestPath]);
    expect(await count("event_transition_receipts")).toBe(1);
    expect(await count("invite_sources")).toBe(0);
    expect(await count("match_presentation_registrations")).toBe(0);
    expect(
      await listPendingEventTransitionIntents(testEnv.EVENT_DB),
    ).toHaveLength(1);
    current.set(`${inviteId}/host`, { emojiId: 9, aura: "edited" });
    failAppearance = false;
    await f.recover();
    expect(prepared).toHaveLength(2);
    expect(prepared[1]).toEqual(prepared[0]);
    expect(current.get(`${inviteId}/host`)).toEqual({
      emojiId: 9,
      aura: "edited",
    });
    expect(await count("match_presentation_registrations")).toBe(2);
    expect(await count("invite_sources")).toBe(1);
    expect(f.writes).toEqual([hostPath, guestPath]);
    expect(f.reads).toEqual([]);
    expect(await listPendingEventTransitionIntents(testEnv.EVENT_DB)).toEqual(
      [],
    );
  });

  for (const failure of [
    "before-guest",
    "after-host",
    "before-receipt",
    "after-receipt",
  ]) {
    it(`recovers ${failure} without resetting advanced matches or replacing the prepared payload`, async () => {
      const f = fixture();
      await f.create();
      if (failure === "before-guest") f.hooks.failBeforePath = guestPath;
      if (failure === "after-host") f.hooks.failAfterPath = hostPath;
      if (failure === "before-receipt" || failure === "after-receipt") {
        await testEnv.PROFILE_GAMES_DB.prepare(
          `CREATE TRIGGER reject_receipt_checkpoint
           BEFORE INSERT ON ${failure === "before-receipt" ? "event_transition_receipts" : "invite_event_effect_receipts"}
           BEGIN SELECT RAISE(ABORT, 'receipt-checkpoint'); END`,
        ).run();
      }
      await expect(f.start()).rejects.toThrow(/rtdb-|receipt-checkpoint/);
      const [pending] = await listPendingEventTransitionIntents(
        testEnv.EVENT_DB,
      );
      expect(pending.schemaVersion).toBe(2);
      const stored = f.values.get(hostPath);
      expect(record(stored)).toBe(true);
      if (!record(stored)) throw new Error("missing-host-match");
      f.values.set(hostPath, {
        ...stored,
        fen: "advanced",
        flatMovesString: "first-move",
      });
      expect(await count("invite_sources")).toBe(0);
      expect(await count("invite_event_effect_receipts")).toBe(0);
      expect(await count("event_transition_receipts")).toBe(
        failure === "after-receipt" ? 1 : 0,
      );
      await testEnv.PROFILE_GAMES_DB.prepare(
        "DROP TRIGGER IF EXISTS reject_receipt_checkpoint",
      ).run();
      expect(await f.recover()).toBe(1);
      expect(f.values.get(hostPath)).toMatchObject({
        fen: "advanced",
        flatMovesString: "first-move",
      });
      expect(f.writes.filter((path) => path === hostPath)).toHaveLength(1);
      expect(await count("invite_sources")).toBe(1);
      expect(await count("login_match_discovery")).toBe(2);
      expect(await f.recover()).toBe(0);
    });
  }

  it("rolls back all invitation sources and receipts if discovery capture fails", async () => {
    const f = fixture();
    f.hooks.prepareMatchPresentations = async (creations) =>
      appearanceRegistrations(creations);
    await f.create();
    await testEnv.PROFILE_GAMES_DB.prepare(
      `CREATE TRIGGER reject_event_source_discovery
       BEFORE INSERT ON login_match_discovery
       BEGIN SELECT RAISE(ABORT, 'event-source-discovery-failed'); END`,
    ).run();
    await expect(f.start(matchEffects("second-invite"))).rejects.toThrow(
      "event-source-discovery-failed",
    );
    expect(await count("invite_sources")).toBe(0);
    expect(await count("invite_event_effect_receipts")).toBe(0);
    expect(await count("match_presentation_registrations")).toBe(0);
    const writes = f.writes.length;
    await testEnv.PROFILE_GAMES_DB.prepare(
      "DROP TRIGGER reject_event_source_discovery",
    ).run();
    await f.recover();
    expect(f.writes).toHaveLength(writes);
    expect(await count("invite_sources")).toBe(2);
    expect(await count("invite_event_effect_receipts")).toBe(1);
    expect(await count("login_match_discovery")).toBe(4);
    expect(await count("match_presentation_registrations")).toBe(4);
  });

  it("uses the committed D1 effect receipt when EVENT_DB finalization must be retried", async () => {
    const f = fixture();
    await f.create();
    await testEnv.EVENT_DB.prepare(
      `CREATE TRIGGER reject_event_source_finalization
       BEFORE UPDATE OF revision ON event_records WHEN NEW.revision > OLD.revision
       BEGIN SELECT RAISE(ABORT, 'event-finalization-failed'); END`,
    ).run();
    await expect(f.start()).rejects.toThrow("event-d1-conflict");
    expect(await count("invite_sources")).toBe(1);
    expect(await count("invite_event_effect_receipts")).toBe(1);
    const writes = f.writes.length;
    const reads = f.reads.length;
    expect(await count("match_presentation_registrations")).toBe(2);
    await testEnv.EVENT_DB.prepare(
      "DROP TRIGGER reject_event_source_finalization",
    ).run();
    await f.recover();
    expect(f.writes).toHaveLength(writes);
    expect(f.reads).toHaveLength(reads);
    expect((await f.source.read(inviteId)).revision).toBe(1);
    expect(await count("match_presentation_registrations")).toBe(2);
    expect(await readEventSnapshot(testEnv.EVENT_DB, eventId)).toMatchObject({
      event: { status: "active" },
      revision: 2,
    });
  });

  it("confirms an ambiguous D1 receipt insert without replaying live effects", async () => {
    let lostReceiptResponse = false;
    const database = new Proxy(testEnv.PROFILE_GAMES_DB, {
      get(target, property) {
        if (property === "batch") {
          return async (statements: D1PreparedStatement[]) => {
            const result = await target.batch(statements);
            if (
              !lostReceiptResponse &&
              (await count("event_transition_receipts")) === 1
            ) {
              lostReceiptResponse = true;
              throw new Error("d1-receipt-response-lost");
            }
            return result;
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const f = fixture(database);
    await f.create();
    await f.start();
    expect(lostReceiptResponse).toBe(true);
    expect(f.writes).toEqual([hostPath, guestPath]);
    expect(await count("event_transition_receipts")).toBe(1);
    expect(await count("invite_event_effect_receipts")).toBe(1);
    expect(await f.recover()).toBe(0);
  });

  it("preserves terminal timers and later claim state after durable receipt confirmation", async () => {
    const f = fixture();
    await f.create();
    const timerPath = "players/host/matches/older-match/timer";
    const claimPath = "matchTimerClaims/older-match";
    const startPath = "matchTimerStarts/host/older-match";
    f.values.set(startPath, { pending: true });
    await testEnv.PROFILE_GAMES_DB.prepare(
      `CREATE TRIGGER reject_event_source_discovery
       BEFORE INSERT ON login_match_discovery
       BEGIN SELECT RAISE(ABORT, 'event-source-discovery-failed'); END`,
    ).run();
    await expect(
      f.start({
        [timerPath]: "gg",
        [claimPath]: { status: "claimed", claimedAtMs: 100 },
        [startPath]: null,
      }),
    ).rejects.toThrow("event-source-discovery-failed");
    expect(await count("event_transition_receipts")).toBe(1);
    expect(f.values.get(timerPath)).toBe("gg");
    const laterClaim = { status: "claimed", claimedAtMs: 300, processed: true };
    f.values.set(claimPath, laterClaim);
    f.values.set(startPath, { nextGeneration: true });
    const writes = f.writes.length;
    await testEnv.PROFILE_GAMES_DB.prepare(
      "DROP TRIGGER reject_event_source_discovery",
    ).run();
    await f.recover();
    expect(f.writes).toHaveLength(writes);
    expect(f.values.get(timerPath)).toBe("gg");
    expect(f.values.get(claimPath)).toEqual(laterClaim);
    expect(f.values.get(startPath)).toEqual({ nextGeneration: true });
  });

  it("fails before live writes when receipt authority is inactive or its table is unavailable", async () => {
    const f = fixture();
    await f.create();
    await resetEventReceiptTestState(
      testEnv.PROFILE_GAMES_DB,
      testEnv.TEST_D1_MIGRATIONS,
      false,
    );
    await expect(f.start()).rejects.toThrow();
    expect(f.writes).toEqual([]);
    await resetEventReceiptTestState(
      testEnv.PROFILE_GAMES_DB,
      testEnv.TEST_D1_MIGRATIONS,
    );
    await testEnv.PROFILE_GAMES_DB.prepare(
      "DROP TABLE event_transition_receipts",
    ).run();
    await expect(f.recover()).rejects.toThrow(
      "event-transition-recovery-failed",
    );
    expect(f.writes).toEqual([]);
    expect(f.reads).toEqual([]);
    expect(await count("invite_sources")).toBe(0);
  });

  it("requires exact RTDB-effect proof even when the final invite receipt exists", async () => {
    const f = fixture();
    await f.create();
    f.hooks.failBeforePath = guestPath;
    await expect(f.start()).rejects.toThrow("rtdb-before-create");
    const [pending] = await listPendingEventTransitionIntents(testEnv.EVENT_DB);
    if (pending.schemaVersion !== 2) throw new Error("missing-v2-intent");
    await testEnv.PROFILE_GAMES_DB.prepare(
      `INSERT INTO invite_event_effect_receipts
       (transition_id, event_id, payload_digest, applied_at_ms) VALUES (?, ?, ?, ?)`,
    )
      .bind(pending.transitionId, eventId, pending.payloadDigest, 100)
      .run();
    await expect(f.recover()).rejects.toThrow(
      "event-transition-recovery-failed",
    );
    expect(f.writes).toEqual([hostPath]);
    expect(await readEventSnapshot(testEnv.EVENT_DB, eventId)).toMatchObject({
      event: { status: "scheduled" },
      revision: 1,
    });
  });

  it("rejects conflicting existing matches without publishing invitation metadata", async () => {
    const f = fixture();
    await f.create();
    f.values.set(hostPath, {
      fen: "legacy-advanced",
      sessionCreation: "other",
    });
    await expect(f.start()).rejects.toThrow("event-match-creation-conflict");
    expect(await count("invite_sources")).toBe(0);
    expect(await count("invite_event_effect_receipts")).toBe(0);
    expect(f.writes).toEqual([]);
    expect(f.values.get(hostPath)).toEqual({
      fen: "legacy-advanced",
      sessionCreation: "other",
    });
  });

  it("rejects collisions with manual, other-event and already-created same-event invitations", async () => {
    const f = fixture();
    await f.create();
    for (const owner of [undefined, "another-event", eventId]) {
      const initial = {
        hostId: "existing-host",
        hostColor: "black",
        ...(owner ? { eventId: owner } : {}),
      };
      const mutations = await f.source.preparePatch({
        [`invites/${inviteId}`]: initial,
      });
      await testEnv.PROFILE_GAMES_DB.batch(
        f.source.buildCommitStatements(mutations),
      );
      await expect(f.start()).rejects.toThrow(
        owner === eventId
          ? "event-transition-invite-already-exists"
          : "event-transition-invite-owner-conflict",
      );
      expect((await f.source.read(inviteId)).value).toEqual(initial);
      expect(f.writes).toEqual([]);
      expect(await count("invite_event_effect_receipts")).toBe(0);
    }
  });

  it("keeps a partially created event recoverable across an admission freeze", async () => {
    const f = fixture();
    await f.create();
    f.hooks.afterWrite = async (path) => {
      if (path !== hostPath) return;
      f.hooks.afterWrite = undefined;
      await testEnv.PROFILE_GAMES_DB.prepare(
        "UPDATE invite_source_control SET state = 'frozen', freeze_generation = freeze_generation + 1 WHERE singleton = 1",
      ).run();
    };
    await expect(f.start()).rejects.toThrow();
    expect(f.writes).toEqual([hostPath]);
    expect(await count("invite_sources")).toBe(0);
    expect(await count("invite_source_write_admissions")).toBe(0);
    await testEnv.PROFILE_GAMES_DB.prepare(
      "UPDATE invite_source_control SET state = 'active' WHERE singleton = 1",
    ).run();
    expect(await f.recover()).toBe(1);
    expect(f.writes.filter((path) => path === hostPath)).toHaveLength(1);
    expect(await count("invite_sources")).toBe(1);
  });

  it("fails closed on a conflicting immutable D1 effect receipt", async () => {
    const f = fixture();
    await f.create();
    f.hooks.failBeforePath = guestPath;
    await expect(f.start()).rejects.toThrow("rtdb-before-create");
    const [pending] = await listPendingEventTransitionIntents(testEnv.EVENT_DB);
    if (pending.schemaVersion !== 2) throw new Error("missing-v2-intent");
    await ensureEventTransitionReceipt(
      testEnv.PROFILE_GAMES_DB,
      {
        schemaVersion: 2,
        transitionId: pending.transitionId,
        eventId: pending.eventId,
        expectedRevision: pending.expectedRevision,
        payloadDigest: "f".repeat(64),
      },
      { recordedAtMs: 100, guards: () => [] },
    );
    await expect(f.recover()).rejects.toThrow(
      "event-transition-recovery-failed",
    );
    expect(f.writes).toEqual([hostPath]);
    expect(await count("invite_sources")).toBe(0);
    expect(await count("invite_event_effect_receipts")).toBe(0);
    expect(
      await readEventTransitionReceipt(
        testEnv.PROFILE_GAMES_DB,
        pending.transitionId,
      ),
    ).toMatchObject({ payloadDigest: "f".repeat(64) });
  });

  it("rejects v1 effects after activation and malformed v2 persisted intents", async () => {
    const f = fixture();
    await f.create();
    const legacy = {
      schemaVersion: 1 as const,
      transitionId: "legacy-event-transition",
      eventId,
      expectedRevision: 1,
      canonicalUpdates: { [`events/${eventId}/status`]: "active" },
      rtdbEffects: matchEffects(),
      createdAtMs: 100,
      updatedAtMs: 100,
    };
    const admission = await acquireEventWriteAdmission(testEnv.EVENT_DB);
    try {
      const prepared = await prepareInviteEventIntent(
        testEnv.PROFILE_GAMES_DB,
        legacy,
      );
      await expect(
        createEventTransitionIntent(
          testEnv.EVENT_DB,
          {
            ...prepared,
            inviteMutations: prepared.inviteMutations.map((mutation) => ({
              ...mutation,
              current: { ...mutation.current, revision: -1 },
            })),
          },
          { admission },
        ),
      ).rejects.toThrow("invalid-event-transition");
      await createEventTransitionIntent(testEnv.EVENT_DB, legacy, {
        admission,
      });
    } finally {
      await releaseEventWriteAdmission(testEnv.EVENT_DB, admission);
    }
    await expect(f.recover()).rejects.toThrow(
      "event-transition-recovery-failed",
    );
    expect(f.reads).toEqual([]);
    expect(f.writes).toEqual([]);
  });

  it("preserves specific timer cleanup effects and fences source freezes", async () => {
    const f = fixture();
    await f.create();
    f.values.set("matchTimerStarts/host/timer-match", { pending: true });
    await f.client.patchRoot({
      [`events/${eventId}/updatedAtMs`]: 200,
      "matchTimerStarts/host/timer-match": null,
    });
    expect(f.values.has("matchTimerStarts/host/timer-match")).toBe(false);
    expect(await count("invite_event_effect_receipts")).toBe(1);
    await testEnv.PROFILE_GAMES_DB.prepare(
      "UPDATE invite_source_control SET state = 'frozen', freeze_generation = freeze_generation + 1 WHERE singleton = 1",
    ).run();
    const writes = f.writes.length;
    await expect(f.start()).rejects.toThrow();
    expect(f.writes).toHaveLength(writes);
    expect(await count("invite_source_write_admissions")).toBe(0);
  });
});
