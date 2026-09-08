import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { createAutomatchD1Store } from "../src/automatchD1.ts";
import {
  createGameSessionTransitions,
  GAME_SESSION_TRANSITION_RETENTION_MS,
  gameSessionOperationResource,
  gameSessionResourceGuardStatements,
  type GameSessionLeaseProof,
} from "../src/gameSessionTransitions.ts";
import type { FirebaseRtdbClient } from "../src/firebaseRtdb.ts";

const testEnv = env as Env & { TEST_D1_MIGRATIONS: D1Migration[] };
const db = env.PROFILE_GAMES_DB;
const NOW = 10_000;
const INVITE = "auto-transition";
const HOST = "host-transition";
const OPERATION = "operation-transition";
const MATCH_PATH = `players/${HOST}/matches/${INVITE}`;
const INVITE_PATH = `invites/${INVITE}`;
const SERVER_TIMESTAMP = { ".sv": "timestamp" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

class MemoryRtdb implements Pick<
  FirebaseRtdbClient,
  "getPath" | "transactPath"
> {
  readonly values = new Map<string, unknown>();
  readonly writes = new Map<string, number>();
  afterWriteFailure: string | null = null;
  beforeWriteFailure: string | null = null;
  beforeWrite?: (path: string) => Promise<void>;

  async getPath(path: string): Promise<unknown> {
    return structuredClone(this.values.get(path) ?? null);
  }

  async transactPath(
    path: string,
    updater: (current: unknown) => unknown,
    signal?: AbortSignal,
  ) {
    for (let attempt = 0; attempt < 25; attempt++) {
      signal?.throwIfAborted();
      const current = await this.getPath(path);
      const decision = updater(current);
      if (!isRecord(decision)) throw new Error("invalid-test-transaction");
      if (decision.commit === false) {
        return {
          committed: false,
          decision:
            typeof decision.decision === "string"
              ? decision.decision
              : undefined,
          value: current,
        };
      }
      if (this.beforeWriteFailure === path) {
        this.beforeWriteFailure = null;
        throw new Error("before-write-unavailable");
      }
      await this.beforeWrite?.(path);
      if (JSON.stringify(await this.getPath(path)) !== JSON.stringify(current))
        continue;
      this.values.set(path, structuredClone(decision.value));
      this.writes.set(path, (this.writes.get(path) || 0) + 1);
      if (this.afterWriteFailure === path) {
        this.afterWriteFailure = null;
        throw new Error("uncertain-applied-write");
      }
      return {
        committed: true,
        decision:
          typeof decision.decision === "string" ? decision.decision : undefined,
        value: structuredClone(decision.value),
      };
    }
    throw new Error("test-cas-exhausted");
  }
}

async function leases(
  ids = [INVITE, "automatch-owner-host", `automatch-operation-${OPERATION}`],
): Promise<GameSessionLeaseProof[]> {
  const proofs = ids.map((lockId) => ({
    lockId,
    operationId: OPERATION,
    ownerId: "worker-one",
  }));
  await db.batch(
    proofs.map((proof) =>
      db
        .prepare(
          `INSERT INTO game_session_mutation_locks
    (lock_id, owner_id, operation_id, expires_at_ms, writer_generation)
    VALUES (?, ?, ?, ?, 2)`,
        )
        .bind(proof.lockId, proof.ownerId, proof.operationId, NOW + 60_000),
    ),
  );
  return proofs;
}

function receiptUpdates(operationId = OPERATION) {
  return {
    [`gameplayMutationReceipts/${operationId}`]: {
      inviteId: INVITE,
      operationId,
      requesterUid: HOST,
      completedAtMs: SERVER_TIMESTAMP,
      response: { ok: true, inviteId: INVITE },
    },
    [`gameplayMutationReceiptExpirations/${operationId}`]: {
      completedAtMs: SERVER_TIMESTAMP,
    },
  };
}

function createUpdates() {
  return {
    [INVITE_PATH]: {
      hostId: HOST,
      hostColor: "white",
      guestId: null,
      automatchStateHint: "pending",
    },
    [MATCH_PATH]: {
      fen: "seed",
      flatMovesString: "",
      color: "white",
      gameVariant: "v1",
      emojiId: 1,
      aura: "",
    },
    [`automatch/${INVITE}`]: {
      uid: HOST,
      timestamp: SERVER_TIMESTAMP,
      profileId: "profile-host",
    },
    [`telegramAutomatches/${INVITE}`]: {
      lifecycle: "pending",
      generation: 1,
      updatedAtMs: SERVER_TIMESTAMP,
    },
    [`profileGameProjectionOutbox/automatch/${INVITE}`]: {
      requestId: OPERATION,
      status: "pending",
      lastQueuedAtMs: SERVER_TIMESTAMP,
    },
    ...receiptUpdates(),
  };
}

function coordinator(
  rtdb: MemoryRtdb,
  options: Partial<Parameters<typeof createGameSessionTransitions>[0]> = {},
) {
  return createGameSessionTransitions({ db, rtdb, now: () => NOW, ...options });
}

function pendingCount() {
  return db
    .prepare(
      "SELECT count(*) AS count FROM game_session_transitions WHERE status = 'pending'",
    )
    .first<number>("count");
}

function interleavePreparations(
  store: ReturnType<typeof createAutomatchD1Store>,
  afterPrepare: (attempt: number) => Promise<void>,
) {
  let attempts = 0;
  return {
    ...store,
    async preparePatch(...args: Parameters<typeof store.preparePatch>) {
      const mutations = await store.preparePatch(...args);
      await afterPrepare(++attempts);
      return mutations;
    },
  };
}

describe("recoverable D1 game-session transitions", () => {
  beforeAll(async () => {
    await applyD1Migrations(db, testEnv.TEST_D1_MIGRATIONS);
  });

  beforeEach(async () => {
    await db.batch([
      db.prepare("DELETE FROM login_match_discovery"),
      db.prepare(
        "UPDATE login_match_discovery_control SET capture_enforced = 1, capture_version_id = '11111111-1111-4111-8111-111111111111', capture_started_at_ms = 1 WHERE singleton = 1",
      ),
      db.prepare(
        "UPDATE automatch_runtime_control SET backend = 'd1' WHERE singleton = 1",
      ),
      db.prepare("DELETE FROM game_session_transition_resources"),
      db.prepare("DELETE FROM game_session_transitions"),
      db.prepare("DELETE FROM game_session_mutation_locks"),
      db.prepare("DELETE FROM automatch_entries"),
      db.prepare("DELETE FROM automatch_telegram_sources"),
      db.prepare("DELETE FROM automatch_telegram_projection_outbox"),
      db.prepare("DELETE FROM game_session_projection_outbox"),
      db.prepare("DELETE FROM game_session_mutation_receipts"),
    ]);
  });

  it("publishes concrete D1 state and receipt only after match and invite proof", async () => {
    const rtdb = new MemoryRtdb();
    const store = createAutomatchD1Store(db, { writeGuards: () => [] });
    rtdb.beforeWrite = async (path) => {
      expect(
        await db
          .prepare("SELECT COUNT(*) AS count FROM login_match_discovery")
          .first("count"),
      ).toBe(0);
      expect(await store.getPath(`automatch/${INVITE}`)).toBeNull();
      expect(
        await store.getPath(`gameplayMutationReceipts/${OPERATION}`),
      ).toBeNull();
      if (path === INVITE_PATH)
        expect(await rtdb.getPath(MATCH_PATH)).toMatchObject({
          fen: "seed",
          sessionCreation: expect.stringMatching(/^[a-f0-9]{64}$/),
        });
    };
    await coordinator(rtdb).commit(createUpdates(), await leases());
    expect(
      await db
        .prepare(
          "SELECT login_uid, match_id, invite_id, provenance FROM login_match_discovery",
        )
        .first(),
    ).toEqual({
      login_uid: HOST,
      match_id: INVITE,
      invite_id: INVITE,
      provenance: "capture",
    });
    expect(await store.getPath(`automatch/${INVITE}`)).toEqual({
      uid: HOST,
      timestamp: NOW,
      profileId: "profile-host",
    });
    expect(
      await store.getPath(`gameplayMutationReceipts/${OPERATION}`),
    ).toMatchObject({ completedAtMs: NOW });
    expect(await rtdb.getPath(INVITE_PATH)).toMatchObject({
      sessionTransition: { sequence: 1 },
    });
    expect(await pendingCount()).toBe(0);
    expect(
      await db
        .prepare(
          "SELECT count(*) AS count FROM game_session_transition_resources",
        )
        .first("count"),
    ).toBe(0);
  });

  it("keeps the receipt and projection outbox unpublished when discovery capture fails", async () => {
    const rtdb = new MemoryRtdb();
    const transitions = coordinator(rtdb);
    await db
      .prepare(
        `CREATE TRIGGER test_discovery_capture_failure
      BEFORE INSERT ON login_match_discovery
      BEGIN SELECT RAISE(ABORT, 'test-discovery-unavailable'); END;`,
      )
      .run();
    try {
      await expect(
        transitions.commit(createUpdates(), await leases()),
      ).rejects.toThrow("test-discovery-unavailable");
      expect(await pendingCount()).toBe(1);
      expect(await rtdb.getPath(MATCH_PATH)).toMatchObject({ fen: "seed" });
      expect(
        await db
          .prepare(
            "SELECT COUNT(*) AS count FROM game_session_mutation_receipts",
          )
          .first("count"),
      ).toBe(0);
      expect(
        await db
          .prepare(
            "SELECT COUNT(*) AS count FROM game_session_projection_outbox",
          )
          .first("count"),
      ).toBe(0);
    } finally {
      await db.exec("DROP TRIGGER test_discovery_capture_failure");
    }
    await transitions.recoverResource(INVITE);
    expect(await pendingCount()).toBe(0);
    expect(
      await db
        .prepare("SELECT COUNT(*) AS count FROM login_match_discovery")
        .first("count"),
    ).toBe(1);
    expect(
      await db
        .prepare("SELECT COUNT(*) AS count FROM game_session_mutation_receipts")
        .first("count"),
    ).toBe(1);
    expect(
      await db
        .prepare("SELECT COUNT(*) AS count FROM game_session_projection_outbox")
        .first("count"),
    ).toBe(1);
    expect(rtdb.writes.get(MATCH_PATH)).toBe(1);
  });

  it("keeps reservations after a failed RTDB write and recovers through login and operation keys", async () => {
    const rtdb = new MemoryRtdb();
    rtdb.beforeWriteFailure = MATCH_PATH;
    const transitions = coordinator(rtdb);
    await expect(
      transitions.commit(createUpdates(), await leases()),
    ).rejects.toThrow("before-write");
    expect(await pendingCount()).toBe(1);
    await expect(transitions.assertResourceAvailable(INVITE)).rejects.toThrow(
      "resource-pending",
    );
    await expect(
      transitions.assertResourceAvailable(`automatch-login:${HOST}`),
    ).rejects.toThrow("resource-pending");
    await expect(
      transitions.assertResourceAvailable(
        gameSessionOperationResource(OPERATION),
      ),
    ).rejects.toThrow("resource-pending");
    expect(await transitions.recoverResource(`automatch-login:${HOST}`)).toBe(
      true,
    );
    expect(await transitions.recoverResource(INVITE)).toBe(false);
    expect(await pendingCount()).toBe(0);
  });

  it("does not replay a created match after an uncertain write and later moves", async () => {
    const rtdb = new MemoryRtdb();
    rtdb.afterWriteFailure = MATCH_PATH;
    const transitions = coordinator(rtdb);
    await expect(
      transitions.commit(createUpdates(), await leases()),
    ).rejects.toThrow("uncertain");
    const match = await rtdb.getPath(MATCH_PATH);
    expect(isRecord(match)).toBe(true);
    rtdb.values.set(MATCH_PATH, {
      ...(isRecord(match) ? match : {}),
      fen: "after-move",
      flatMovesString: "move-1",
      timer: "terminal",
      status: "surrendered",
    });
    await transitions.recoverResource(INVITE);
    expect(await rtdb.getPath(MATCH_PATH)).toMatchObject({
      fen: "after-move",
      flatMovesString: "move-1",
      timer: "terminal",
      status: "surrendered",
    });
    expect(rtdb.writes.get(MATCH_PATH)).toBe(1);
  });

  it("proves an uncertain invite CAS without resetting unrelated metadata", async () => {
    const rtdb = new MemoryRtdb();
    rtdb.afterWriteFailure = INVITE_PATH;
    const transitions = coordinator(rtdb);
    await expect(
      transitions.commit(createUpdates(), await leases()),
    ).rejects.toThrow("uncertain");
    const invite = await rtdb.getPath(INVITE_PATH);
    rtdb.values.set(INVITE_PATH, {
      ...(isRecord(invite) ? invite : {}),
      reactions: { host: "retained" },
    });
    await transitions.recoverResource(INVITE);
    expect(await rtdb.getPath(INVITE_PATH)).toMatchObject({
      reactions: { host: "retained" },
    });
    expect(rtdb.writes.get(INVITE_PATH)).toBe(1);
  });

  it("notifies after recovered finalization and ignores notification failure", async () => {
    const rtdb = new MemoryRtdb();
    rtdb.afterWriteFailure = INVITE_PATH;
    const notifications: string[] = [];
    const transitions = coordinator(rtdb, {
      async onCommitted(inviteId) {
        expect(await pendingCount()).toBe(0);
        expect(
          await createAutomatchD1Store(db).getPath(
            `gameplayMutationReceipts/${OPERATION}`,
          ),
        ).not.toBeNull();
        notifications.push(inviteId);
        throw new Error("notification-unavailable");
      },
    });
    await expect(
      transitions.commit(createUpdates(), await leases()),
    ).rejects.toThrow("uncertain");
    expect(notifications).toEqual([]);
    await expect(transitions.recoverResource(INVITE)).resolves.toBe(true);
    expect(notifications).toEqual([INVITE]);
  });

  it("rejects legacy or differently marked records at an expected-create target", async () => {
    const rtdb = new MemoryRtdb();
    rtdb.values.set(MATCH_PATH, {
      fen: "legacy-moves",
      flatMovesString: "a;b",
    });
    await expect(
      coordinator(rtdb).commit(createUpdates(), await leases()),
    ).rejects.toThrow("match-creation-conflict");
    expect(await rtdb.getPath(MATCH_PATH)).toEqual({
      fen: "legacy-moves",
      flatMovesString: "a;b",
    });
    expect(await rtdb.getPath(INVITE_PATH)).toBeNull();
    expect(
      await createAutomatchD1Store(db).getPath(`automatch/${INVITE}`),
    ).toBeNull();
    expect(await pendingCount()).toBe(1);
  });

  it("protects the prepared revisions from projection settlement until recovery completes", async () => {
    const rtdb = new MemoryRtdb();
    const store = createAutomatchD1Store(db, { writeGuards: () => [] });
    await store.patchRoot({
      [`profileGameProjectionOutbox/automatch/${INVITE}`]: {
        requestId: "older",
      },
    });
    rtdb.beforeWriteFailure = MATCH_PATH;
    const transitions = coordinator(rtdb);
    await expect(
      transitions.commit(createUpdates(), await leases()),
    ).rejects.toThrow("before-write");
    const guarded = createAutomatchD1Store(db, {
      writeGuards: () => gameSessionResourceGuardStatements(db, [INVITE]),
    });
    await expect(
      guarded.patchRoot({
        [`profileGameProjectionOutbox/automatch/${INVITE}`]: null,
      }),
    ).rejects.toThrow();
    await transitions.recoverResource(INVITE);
    expect(
      await store.getPath(`profileGameProjectionOutbox/automatch/${INVITE}`),
    ).toMatchObject({ requestId: OPERATION });
  });

  it("refreshes conflicted D1 snapshots while preserving the original transition identity and time", async () => {
    const rtdb = new MemoryRtdb();
    const store = createAutomatchD1Store(db, { writeGuards: () => [] });
    const outboxPath = `profileGameProjectionOutbox/automatch/${INVITE}`;
    await store.patchRoot({ [outboxPath]: { requestId: "older" } });
    let nowMs = NOW;
    let preparations = 0;
    let ids = 0;
    let inviteReads = 0;
    const notifications: string[] = [];
    await coordinator(rtdb, {
      now: () => nowMs,
      createId: () => `intent-${++ids}`,
      onCommitted: async (inviteId) => {
        notifications.push(inviteId);
      },
      rtdb: {
        async getPath(path) {
          inviteReads++;
          return rtdb.getPath(path);
        },
        transactPath: rtdb.transactPath.bind(rtdb),
      },
      store: interleavePreparations(store, async (attempt) => {
        preparations = attempt;
        if (attempt !== 1) return;
        await store.transactPath(outboxPath, () => ({
          value: null,
          decision: "cleared",
        }));
        nowMs++;
      }),
    }).commit(createUpdates(), await leases());
    expect(preparations).toBe(2);
    expect(ids).toBe(1);
    expect(inviteReads).toBe(1);
    expect(notifications).toEqual([INVITE]);
    const payloadJson = await db
      .prepare(
        "SELECT payload_json FROM game_session_transitions WHERE transition_id = 'intent-1'",
      )
      .first<string>("payload_json");
    const payload = JSON.parse(payloadJson!);
    expect(payload.createdAtMs).toBe(NOW);
    expect(payload.mutations).toContainEqual({
      current: {
        root: "profileGameProjectionOutbox/automatch",
        key: INVITE,
        value: null,
        revision: 2,
      },
      value: {
        requestId: OPERATION,
        status: "pending",
        lastQueuedAtMs: NOW,
      },
    });
    expect(
      await store.getPath(`gameplayMutationReceipts/${OPERATION}`),
    ).toMatchObject({
      completedAtMs: NOW,
    });
    expect(await rtdb.getPath(INVITE_PATH)).toMatchObject({
      sessionTransition: { transitionId: "intent-1", digest: payload.digest },
    });
    expect(rtdb.writes.get(MATCH_PATH)).toBe(1);
    expect(rtdb.writes.get(INVITE_PATH)).toBe(1);
    expect(await pendingCount()).toBe(0);
  });

  it("bounds preparation conflicts to three attempts without publishing effects", async () => {
    const rtdb = new MemoryRtdb();
    const store = createAutomatchD1Store(db, { writeGuards: () => [] });
    let preparations = 0;
    const transitions = coordinator(rtdb, {
      store: interleavePreparations(store, async (attempt) => {
        preparations = attempt;
        await store.patchRoot({
          [`profileGameProjectionOutbox/automatch/${INVITE}`]: {
            requestId: `concurrent-${attempt}`,
          },
        });
      }),
    });
    await expect(
      transitions.commit(createUpdates(), await leases()),
    ).rejects.toThrow("automatch_revision_guard");
    expect(preparations).toBe(3);
    expect(rtdb.values.size).toBe(0);
    expect(await pendingCount()).toBe(0);
    await expect(
      transitions.assertResourceAvailable(INVITE),
    ).resolves.toBeUndefined();
    expect(
      await store.getPath(`gameplayMutationReceipts/${OPERATION}`),
    ).toBeNull();
  });

  it.each(["lease", "abort", "database"])(
    "stops a preparation retry when interrupted by %s failure",
    async (failure) => {
      const rtdb = new MemoryRtdb();
      const store = createAutomatchD1Store(db, { writeGuards: () => [] });
      const controller = new AbortController();
      let preparations = 0;
      let nowMs = NOW;
      const transitions = coordinator(rtdb, {
        now: () => nowMs,
        writeGuards: () =>
          failure === "database" && preparations === 2
            ? [db.prepare("SELECT * FROM missing_transition_test_table")]
            : [],
        store: interleavePreparations(store, async (attempt) => {
          preparations = attempt;
          if (attempt === 1) {
            await store.patchRoot({
              [`profileGameProjectionOutbox/automatch/${INVITE}`]: {
                requestId: "concurrent",
              },
            });
          } else if (failure === "lease") {
            nowMs = NOW + 60_000;
          } else if (failure === "abort") {
            controller.abort(new Error("test-abort"));
          }
        }),
      });
      await expect(
        transitions.commit(createUpdates(), await leases(), controller.signal),
      ).rejects.toThrow(
        failure === "abort"
          ? "test-abort"
          : failure === "database"
            ? "missing_transition_test_table"
            : "CHECK constraint failed",
      );
      expect(preparations).toBe(2);
      expect(rtdb.values.size).toBe(0);
      expect(await pendingCount()).toBe(0);
      await expect(
        transitions.assertResourceAvailable(INVITE),
      ).resolves.toBeUndefined();
    },
  );

  it("does not prepare another intent after an RTDB materialization failure", async () => {
    const rtdb = new MemoryRtdb();
    const store = createAutomatchD1Store(db, { writeGuards: () => [] });
    let preparations = 0;
    rtdb.beforeWriteFailure = MATCH_PATH;
    await expect(
      coordinator(rtdb, {
        store: interleavePreparations(store, async (attempt) => {
          preparations = attempt;
        }),
      }).commit(createUpdates(), await leases()),
    ).rejects.toThrow("before-write");
    expect(preparations).toBe(1);
    expect(await pendingCount()).toBe(1);
  });

  it("cannot reserve an expired, stolen, or legacy lease", async () => {
    const rtdb = new MemoryRtdb();
    const proofs = await leases();
    await db
      .prepare(
        "UPDATE game_session_mutation_locks SET expires_at_ms = ? WHERE lock_id = ?",
      )
      .bind(NOW, INVITE)
      .run();
    await expect(
      coordinator(rtdb).commit(createUpdates(), proofs),
    ).rejects.toThrow();
    expect(await pendingCount()).toBe(0);
    expect(rtdb.values.size).toBe(0);
    await db
      .prepare(
        "UPDATE game_session_mutation_locks SET expires_at_ms = ?, writer_generation = 0 WHERE lock_id = ?",
      )
      .bind(NOW + 60_000, INVITE)
      .run();
    await expect(
      coordinator(rtdb).commit(createUpdates(), proofs),
    ).rejects.toThrow();
    expect(await pendingCount()).toBe(0);
    await db
      .prepare(
        "UPDATE game_session_mutation_locks SET writer_generation = 2, owner_id = 'successor' WHERE lock_id = ?",
      )
      .bind(INVITE)
      .run();
    await expect(
      coordinator(rtdb).commit(createUpdates(), proofs),
    ).rejects.toThrow();
    expect(await pendingCount()).toBe(0);
  });

  it("allows concurrent recovery but a late create CAS never overwrites live progress", async () => {
    const rtdb = new MemoryRtdb();
    let release: () => void = () => {};
    let entered: () => void = () => {};
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reached = new Promise<void>((resolve) => {
      entered = resolve;
    });
    rtdb.beforeWrite = async (path) => {
      if (path !== MATCH_PATH) return;
      rtdb.beforeWrite = undefined;
      entered();
      await blocked;
    };
    const transitions = coordinator(rtdb);
    const original = transitions.commit(createUpdates(), await leases());
    await reached;
    await coordinator(rtdb).recoverResource(INVITE);
    const match = await rtdb.getPath(MATCH_PATH);
    rtdb.values.set(MATCH_PATH, {
      ...(isRecord(match) ? match : {}),
      fen: "live-progress",
      flatMovesString: "a;b;c",
    });
    release();
    await original;
    expect(await rtdb.getPath(MATCH_PATH)).toMatchObject({
      fen: "live-progress",
      flatMovesString: "a;b;c",
    });
    expect(rtdb.writes.get(MATCH_PATH)).toBe(1);
    expect(await pendingCount()).toBe(0);
  });

  it("cancels once, preserves raw invite fields, and advances the Telegram generation once", async () => {
    const rtdb = new MemoryRtdb();
    const store = createAutomatchD1Store(db, { writeGuards: () => [] });
    rtdb.values.set(INVITE_PATH, {
      hostId: HOST,
      hostColor: "white",
      automatchStateHint: "pending",
      wagers: { legacy: true },
      reactions: { legacy: true },
    });
    await store.patchRoot({
      [`automatch/${INVITE}`]: { uid: HOST },
      [`telegramAutomatches/${INVITE}`]: {
        generation: 4,
        lifecycle: "pending",
      },
    });
    rtdb.afterWriteFailure = INVITE_PATH;
    const transitions = coordinator(rtdb);
    const updates = {
      [`automatch/${INVITE}`]: null,
      [`telegramAutomatches/${INVITE}/generation`]: { ".sv": { increment: 1 } },
      [`telegramAutomatches/${INVITE}/lifecycle`]: "canceled",
      [`invites/${INVITE}/automatchStateHint`]: "canceled",
      [`invites/${INVITE}/automatchCanceledAt`]: SERVER_TIMESTAMP,
      [`profileGameProjectionOutbox/automatch/${INVITE}`]: {
        requestId: OPERATION,
        lastQueuedAtMs: SERVER_TIMESTAMP,
      },
    };
    await expect(transitions.commit(updates, await leases())).rejects.toThrow(
      "uncertain",
    );
    await transitions.recoverResource(INVITE);
    expect(await store.getPath(`automatch/${INVITE}`)).toBeNull();
    expect(await store.getPath(`telegramAutomatches/${INVITE}`)).toMatchObject({
      generation: 5,
      lifecycle: "canceled",
    });
    expect(await rtdb.getPath(INVITE_PATH)).toMatchObject({
      automatchCanceledAt: NOW,
      wagers: { legacy: true },
      reactions: { legacy: true },
    });
    expect(rtdb.writes.get(INVITE_PATH)).toBe(1);
  });

  it("handles match-only ensure on a legacy invite with an invite sequence proof", async () => {
    const rtdb = new MemoryRtdb();
    rtdb.values.set(INVITE_PATH, {
      hostId: HOST,
      guestId: "guest",
      hostRematches: "1",
    });
    await coordinator(rtdb).commit(
      {
        [MATCH_PATH]: { fen: "mirrored", status: "", timer: "" },
        ...receiptUpdates(),
      },
      await leases([INVITE]),
    );
    expect(await rtdb.getPath(INVITE_PATH)).toMatchObject({
      hostRematches: "1",
      sessionTransition: { sequence: 1 },
    });
    expect(await rtdb.getPath(MATCH_PATH)).toMatchObject({
      fen: "mirrored",
      sessionCreation: expect.any(String),
    });
    expect(
      await db
        .prepare(
          "SELECT login_uid, match_id, invite_id FROM login_match_discovery",
        )
        .first(),
    ).toEqual({
      login_uid: HOST,
      match_id: INVITE,
      invite_id: INVITE,
    });
  });

  for (const matchId of [INVITE, `${INVITE}1`]) {
    it(`captures the guest match path for ${matchId} independently of the caller login`, async () => {
      const actorUid = "stored-guest-actor";
      const rtdb = new MemoryRtdb();
      rtdb.values.set(INVITE_PATH, { hostId: HOST, guestId: actorUid });
      await coordinator(rtdb).commit(
        {
          [`players/${actorUid}/matches/${matchId}`]: {
            fen: "guest-seed",
            gameVariant: "v1",
          },
          ...receiptUpdates(),
        },
        await leases([INVITE]),
      );
      expect(
        await db
          .prepare(
            "SELECT login_uid, match_id, invite_id FROM login_match_discovery",
          )
          .first(),
      ).toEqual({
        login_uid: actorUid,
        match_id: matchId,
        invite_id: INVITE,
      });
    });
  }

  it("does not replace prepared preconditions or rematch seeds during recovery", async () => {
    const rtdb = new MemoryRtdb();
    rtdb.values.set(INVITE_PATH, { hostId: HOST, guestId: "guest" });
    const rematchPath = `players/${HOST}/matches/${INVITE}1`;
    const transitions = coordinator(rtdb);
    rtdb.beforeWriteFailure = INVITE_PATH;
    await expect(
      transitions.commit(
        {
          [rematchPath]: { fen: "fixed-rematch-seed", gameVariant: "v1" },
          [`invites/${INVITE}/hostRematches`]: "1",
          ...receiptUpdates(),
        },
        await leases([INVITE]),
      ),
    ).rejects.toThrow("before-write");
    const invite = await rtdb.getPath(INVITE_PATH);
    rtdb.values.set(INVITE_PATH, {
      ...(isRecord(invite) ? invite : {}),
      guestId: "different-guest",
    });
    await expect(transitions.recoverResource(INVITE)).rejects.toThrow(
      "invite-precondition-conflict",
    );
    expect(await rtdb.getPath(rematchPath)).toMatchObject({
      fen: "fixed-rematch-seed",
    });
    expect(rtdb.writes.get(rematchPath)).toBe(1);
    expect(await pendingCount()).toBe(1);
  });

  it("bounds recovery and leaves failed intents reserved for a later retry", async () => {
    const rtdb = new MemoryRtdb();
    rtdb.beforeWriteFailure = MATCH_PATH;
    const transitions = coordinator(rtdb);
    await expect(
      transitions.commit(createUpdates(), await leases()),
    ).rejects.toThrow();
    rtdb.beforeWriteFailure = MATCH_PATH;
    expect(await transitions.sweep(1)).toEqual({ recovered: 0, failed: 1 });
    expect(await pendingCount()).toBe(1);
    expect(await transitions.sweep(1)).toEqual({ recovered: 1, failed: 0 });
    await expect(transitions.sweep(101)).rejects.toThrow("invalid-sweep-limit");
  });

  it("bounds completed journal retention without deleting markers or pending work", async () => {
    const rtdb = new MemoryRtdb();
    await coordinator(rtdb).commit(createUpdates(), await leases());
    const existingMarker = await rtdb.getPath(MATCH_PATH);
    const future = NOW + GAME_SESSION_TRANSITION_RETENTION_MS + 1;
    await db
      .prepare(
        `INSERT INTO game_session_transitions
      (transition_id, invite_id, payload_json, status, created_at_ms, updated_at_ms)
      VALUES ('held-intent', 'held-invite', '{}', 'pending', 0, 0)`,
      )
      .run();
    await db
      .prepare(
        "INSERT INTO game_session_transition_resources (resource_key, transition_id) VALUES ('held-invite', 'held-intent')",
      )
      .run();
    expect(await coordinator(rtdb, { now: () => future }).sweep(1)).toEqual({
      recovered: 0,
      failed: 1,
    });
    expect(
      await db
        .prepare(
          "SELECT count(*) AS count FROM game_session_transitions WHERE status = 'completed'",
        )
        .first("count"),
    ).toBe(0);
    expect(await pendingCount()).toBe(1);
    expect(await rtdb.getPath(MATCH_PATH)).toEqual(existingMarker);
    await expect(
      coordinator(rtdb).assertResourceAvailable("held-invite"),
    ).rejects.toThrow("resource-pending");
  });
});
