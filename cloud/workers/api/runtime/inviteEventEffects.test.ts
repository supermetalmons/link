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
    },
    [`players/guest/matches/${id}`]: {
      fen: "initial",
      flatMovesString: "",
      color: "black",
    },
  };
}

function fixture() {
  const values = new Map<string, unknown>();
  const writes: string[] = [];
  const reads: string[] = [];
  const hooks: {
    failBeforePath?: string;
    failAfterPath?: string;
    afterWrite?: (path: string) => Promise<void>;
  } = {};
  const raw: FirebaseRtdbClient = {
    async getPath(path) {
      expect(path.startsWith("invites/")).toBe(false);
      reads.push(path);
      return structuredClone(values.get(path) ?? null);
    },
    async patchRoot(updates) {
      for (const [path, value] of Object.entries(updates)) {
        expect(path.startsWith("invites/")).toBe(false);
        expect(/^players\/[^/]+\/matches\/[^/]+$/.test(path)).toBe(false);
        writes.push(path);
        if (value === null) values.delete(path);
        else values.set(path, structuredClone(value));
      }
    },
    async transactPath(path, updater, signal, beforeWrite) {
      signal?.throwIfAborted();
      expect(path.startsWith("invites/")).toBe(false);
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
  const source = createInviteSourceD1Store(testEnv.PROFILE_GAMES_DB);
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
  const client = createEventRtdbClient(testEnv, base, raw);
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
        testEnv,
        { getRtdbPath: base.getPath, patchRtdbRoot: base.patchRoot },
        100,
        raw,
      ),
  };
}

async function count(table: string) {
  if (
    ![
      "invite_sources",
      "invite_event_effect_receipts",
      "login_match_discovery",
      "invite_source_write_admissions",
    ].includes(table)
  ) {
    throw new Error("unsupported-test-table");
  }
  return testEnv.PROFILE_GAMES_DB.prepare(
    `SELECT COUNT(*) AS count FROM ${table}`,
  ).first<number>("count");
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
  });

  it("atomically publishes every event invite and discovery row after proving its two live matches", async () => {
    const f = fixture();
    await f.create();
    await f.start(matchEffects("third-place-invite"));
    expect(await count("invite_sources")).toBe(2);
    expect(await count("invite_event_effect_receipts")).toBe(1);
    expect(await count("login_match_discovery")).toBe(4);
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

  for (const failure of ["before-guest", "after-host", "after-receipt"]) {
    it(`recovers ${failure} without resetting advanced matches or replacing the prepared payload`, async () => {
      const f = fixture();
      await f.create();
      if (failure === "before-guest") f.hooks.failBeforePath = guestPath;
      if (failure === "after-host") f.hooks.failAfterPath = hostPath;
      if (failure === "after-receipt") {
        f.hooks.afterWrite = async (path) => {
          if (path.startsWith("eventTransitionReceipts/")) {
            f.hooks.afterWrite = undefined;
            throw new Error("rtdb-ambiguous-receipt");
          }
        };
      }
      await expect(f.start()).rejects.toThrow(/rtdb-/);
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
    const writes = f.writes.length;
    await testEnv.PROFILE_GAMES_DB.prepare(
      "DROP TRIGGER reject_event_source_discovery",
    ).run();
    await f.recover();
    expect(f.writes).toHaveLength(writes);
    expect(await count("invite_sources")).toBe(2);
    expect(await count("invite_event_effect_receipts")).toBe(1);
    expect(await count("login_match_discovery")).toBe(4);
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
    await testEnv.EVENT_DB.prepare(
      "DROP TRIGGER reject_event_source_finalization",
    ).run();
    await f.recover();
    expect(f.writes).toHaveLength(writes);
    expect(f.reads).toHaveLength(reads);
    expect((await f.source.read(inviteId)).revision).toBe(1);
    expect(await readEventSnapshot(testEnv.EVENT_DB, eventId)).toMatchObject({
      event: { status: "active" },
      revision: 2,
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

  it("fails closed on a conflicting immutable RTDB effect receipt", async () => {
    const f = fixture();
    await f.create();
    f.hooks.failBeforePath = guestPath;
    await expect(f.start()).rejects.toThrow("rtdb-before-create");
    const [pending] = await listPendingEventTransitionIntents(testEnv.EVENT_DB);
    const receiptPath = `eventTransitionReceipts/${pending.transitionId}`;
    f.values.set(receiptPath, { schemaVersion: 2, payloadDigest: "conflict" });
    await expect(f.recover()).rejects.toThrow(
      "event-transition-recovery-failed",
    );
    expect(f.writes).toEqual([hostPath]);
    expect(await count("invite_sources")).toBe(0);
    expect(await count("invite_event_effect_receipts")).toBe(0);
    f.values.delete(receiptPath);
    expect(await f.recover()).toBe(1);
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
