import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import type { D1Migration } from "cloudflare:test";
import { applyStrictMatchStateTestMigrations } from "./strictMatchStateTestFixture.ts";
import { createAutomatchD1Store } from "../src/automatchD1.ts";
import {
  createGameSessionTransitions,
  GAME_SESSION_TRANSITION_RETENTION_MS,
  gameSessionOperationResource,
  gameSessionResourceGuardStatements,
  type GameSessionLeaseProof,
} from "../src/gameSessionTransitions.ts";
import type { StateRepository } from "../src/stateRepositoryTypes.ts";
import {
  acquireInviteSourceAdmission,
  createInviteSourceD1Store,
  releaseInviteSourceAdmission,
} from "../src/inviteSourceD1.ts";
import {
  buildMatchPresentationRegistrationStatements,
  prepareCreatedMatchPresentations,
  readRegisteredMatchPresentations,
  type MatchPresentationCreation,
  type PrepareMatchPresentations,
} from "../src/matchPresentationRegistry.ts";
import { resetMatchPresentationTestState } from "./matchPresentationTestFixture.ts";

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

class MemoryStateRepository implements Pick<
  StateRepository,
  "getPath" | "transactPath"
> {
  readonly values = new Map<string, unknown>();
  readonly writes = new Map<string, number>();
  afterWriteFailure: string | null = null;
  beforeWriteFailure: string | null = null;
  beforeWrite?: (path: string) => Promise<void>;
  forbidInviteAccess = true;

  async getPath(path: string): Promise<unknown> {
    if (this.forbidInviteAccess && path.startsWith("invites/"))
      throw new Error("retired-source-invite-access");
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
  state: MemoryStateRepository,
  options: Partial<Parameters<typeof createGameSessionTransitions>[0]> = {},
) {
  return createGameSessionTransitions({
    db,
    state,
    now: () => NOW,
    prepareMatchPresentations: presentationCapture().prepare,
    ...options,
  });
}

function pendingCount() {
  return db
    .prepare(
      "SELECT count(*) AS count FROM game_session_transitions WHERE status = 'pending'",
    )
    .first<number>("count");
}

function presentationRegistrationCount() {
  return db
    .prepare("SELECT COUNT(*) AS count FROM match_presentation_registrations")
    .first<number>("count");
}

function presentationCapture() {
  const prepared: MatchPresentationCreation[][] = [];
  const current = new Map<string, { emojiId: number; aura: string }>();
  const prepare: PrepareMatchPresentations = async (creations) => {
    prepared.push(structuredClone([...creations]));
    for (const creation of creations) {
      const key = `${creation.matchId}/${creation.actorUid}`;
      if (!current.has(key))
        current.set(key, { emojiId: creation.emojiId, aura: creation.aura });
    }
    return creations.map((creation) => ({
      ...creation,
      seedDigest: "a".repeat(64),
      provenance: "creation" as const,
    }));
  };
  return { prepared, current, prepare };
}

async function activateInviteSource(state?: MemoryStateRepository) {
  await db
    .prepare(
      "UPDATE invite_source_control SET backend = 'd1', state = 'active', epoch = 1, verified_at_ms = 1, activated_at_ms = 1 WHERE singleton = 1",
    )
    .run();
  if (state) state.forbidInviteAccess = true;
  return createInviteSourceD1Store(db, { now: () => NOW });
}

function inviteAdmissionCount() {
  return db
    .prepare("SELECT COUNT(*) AS count FROM invite_source_write_admissions")
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
    await applyStrictMatchStateTestMigrations(db, testEnv.TEST_D1_MIGRATIONS);
  });

  beforeEach(async () => {
    await resetMatchPresentationTestState(
      db,
      testEnv.TEST_D1_MIGRATIONS,
      "durable",
    );
    await db.batch([
      db.prepare("DELETE FROM invite_source_write_admissions"),
      db.prepare("DELETE FROM invite_sources"),
      db.prepare(
        "UPDATE invite_source_control SET backend = 'd1', state = 'active', epoch = 1, freeze_generation = 0, verified_at_ms = 1, activated_at_ms = 1 WHERE singleton = 1",
      ),
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

  describe("D1 invite source", () => {
    it("preserves the deployed v2 transition serialization and creation digest", async () => {
      const state = new MemoryStateRepository();
      await activateInviteSource(state);
      await coordinator(state, {
        createId: () => "v2-serialization-proof",
      }).commit(createUpdates(), await leases());
      const payload = await db
        .prepare("SELECT payload_json FROM game_session_transitions")
        .first<string>("payload_json");
      expect(payload).not.toBeNull();
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(payload!),
      );
      expect(
        Array.from(new Uint8Array(digest), (byte) =>
          byte.toString(16).padStart(2, "0"),
        ).join(""),
      ).toBe(
        "45ff24a21370a2f6621f566638f12c92e3f504893a236422b5bafb4faad01d39",
      );
    });

    it("fences an old creator until capture-aware recovery registers its actual appearance", async () => {
      const state = new MemoryStateRepository();
      const source = await activateInviteSource(state);
      await resetMatchPresentationTestState(
        db,
        testEnv.TEST_D1_MIGRATIONS,
        "durable",
      );
      await expect(
        coordinator(state, { prepareMatchPresentations: undefined }).commit(
          createUpdates(),
          await leases(),
        ),
      ).rejects.toThrow("match-presentation-capture-required");
      expect((await source.read(INVITE)).revision).toBe(0);
      expect(await pendingCount()).toBe(1);
      expect(await presentationRegistrationCount()).toBe(0);
      const recovery = coordinator(state, {
        prepareMatchPresentations: (creations) =>
          prepareCreatedMatchPresentations(env, creations),
      });
      await recovery.recoverResource(INVITE);
      expect(await presentationRegistrationCount()).toBe(1);
      expect(
        await readRegisteredMatchPresentations(env, INVITE, INVITE),
      ).toEqual({
        matchId: INVITE,
        players: {
          [HOST]: {
            matchId: INVITE,
            actorUid: HOST,
            emojiId: 1,
            aura: "",
            revision: 0,
          },
        },
      });
      expect((await source.read(INVITE)).revision).toBe(1);
      expect(await pendingCount()).toBe(0);
      expect(state.writes.get(MATCH_PATH)).toBe(1);
    });

    it("requires successful appearance preparation before publishing a created match", async () => {
      const state = new MemoryStateRepository();
      const source = await activateInviteSource(state);
      const capture = presentationCapture();
      let failAppearance = true;
      const transitions = coordinator(state, {
        async prepareMatchPresentations(creations) {
          expect(await state.getPath(MATCH_PATH)).toMatchObject({
            emojiId: 1,
            aura: "",
            sessionCreation: creations[0].sourceId,
          });
          expect((await source.read(INVITE)).revision).toBe(0);
          expect(await presentationRegistrationCount()).toBe(0);
          const result = await capture.prepare(creations);
          if (failAppearance) throw new Error("appearance-unavailable");
          return result;
        },
      });
      await expect(
        transitions.commit(createUpdates(), await leases()),
      ).rejects.toThrow("appearance-unavailable");
      expect(await pendingCount()).toBe(1);
      expect(await presentationRegistrationCount()).toBe(0);
      expect((await source.read(INVITE)).revision).toBe(0);
      expect(
        await createAutomatchD1Store(db).getPath(
          `gameplayMutationReceipts/${OPERATION}`,
        ),
      ).toBeNull();
      capture.current.set(`${INVITE}/${HOST}`, { emojiId: 8, aura: "edited" });
      failAppearance = false;
      await transitions.recoverResource(INVITE);
      expect(capture.prepared).toHaveLength(2);
      expect(capture.prepared[1]).toEqual(capture.prepared[0]);
      expect(capture.prepared[0]).toEqual([
        {
          inviteId: INVITE,
          matchId: INVITE,
          actorUid: HOST,
          emojiId: 1,
          aura: "",
          sourceId: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      ]);
      expect(capture.current.get(`${INVITE}/${HOST}`)).toEqual({
        emojiId: 8,
        aura: "edited",
      });
      expect(await presentationRegistrationCount()).toBe(1);
      expect((await source.read(INVITE)).revision).toBe(1);
      expect(await pendingCount()).toBe(0);
      expect(state.writes.get(MATCH_PATH)).toBe(1);
    });

    it("rolls back appearance registration with failed publication and recovers the same seed", async () => {
      const state = new MemoryStateRepository();
      const source = await activateInviteSource(state);
      const capture = presentationCapture();
      const transitions = coordinator(state, {
        prepareMatchPresentations: capture.prepare,
      });
      await db.exec(
        "CREATE TRIGGER test_presentation_publication_failure BEFORE INSERT ON invite_sources BEGIN SELECT RAISE(ABORT, 'presentation-publication-unavailable'); END;",
      );
      try {
        await expect(
          transitions.commit(createUpdates(), await leases()),
        ).rejects.toThrow("presentation-publication-unavailable");
        expect(await presentationRegistrationCount()).toBe(0);
        expect(capture.current.size).toBe(1);
        expect((await source.read(INVITE)).revision).toBe(0);
      } finally {
        await db.exec("DROP TRIGGER test_presentation_publication_failure");
      }
      await transitions.recoverResource(INVITE);
      expect(capture.prepared[1]).toEqual(capture.prepared[0]);
      expect(await presentationRegistrationCount()).toBe(1);
      expect(await pendingCount()).toBe(0);
      expect(state.writes.get(MATCH_PATH)).toBe(1);
    });

    it("does not seed an uncertain match creation until its marker is verified by recovery", async () => {
      const state = new MemoryStateRepository();
      await activateInviteSource(state);
      state.afterWriteFailure = MATCH_PATH;
      const capture = presentationCapture();
      const transitions = coordinator(state, {
        prepareMatchPresentations: capture.prepare,
      });
      await expect(
        transitions.commit(createUpdates(), await leases()),
      ).rejects.toThrow("uncertain-applied-write");
      expect(capture.prepared).toEqual([]);
      expect(await presentationRegistrationCount()).toBe(0);
      await transitions.recoverResource(INVITE);
      expect(capture.prepared).toHaveLength(1);
      expect(await presentationRegistrationCount()).toBe(1);
      expect(state.writes.get(MATCH_PATH)).toBe(1);
    });

    it("publishes source, receipts, and discovery together after create-only match effects", async () => {
      const state = new MemoryStateRepository();
      const source = await activateInviteSource(state);
      const store = createAutomatchD1Store(db);
      state.beforeWrite = async () => {
        expect((await source.read(INVITE)).revision).toBe(0);
        expect(
          await store.getPath(`gameplayMutationReceipts/${OPERATION}`),
        ).toBeNull();
        expect(
          await db
            .prepare("SELECT COUNT(*) AS count FROM login_match_discovery")
            .first("count"),
        ).toBe(0);
      };
      await coordinator(state).commit(createUpdates(), await leases());
      expect(await source.read(INVITE)).toEqual({
        inviteId: INVITE,
        revision: 1,
        value: {
          hostId: HOST,
          hostColor: "white",
          automatchStateHint: "pending",
        },
      });
      expect(
        await store.getPath(`gameplayMutationReceipts/${OPERATION}`),
      ).toMatchObject({ completedAtMs: NOW });
      expect(
        await db
          .prepare(
            "SELECT login_uid, match_id, invite_id FROM login_match_discovery",
          )
          .first(),
      ).toEqual({ login_uid: HOST, match_id: INVITE, invite_id: INVITE });
      const payload = JSON.parse(
        (await db
          .prepare("SELECT payload_json FROM game_session_transitions")
          .first<string>("payload_json"))!,
      );
      expect(payload).toMatchObject({
        version: 2,
        inviteSourceEpoch: 1,
        inviteMutations: [{ current: { inviteId: INVITE, revision: 0 } }],
      });
      expect(payload.invite).toBeUndefined();
      expect(state.writes.get(MATCH_PATH)).toBe(1);
      expect(await pendingCount()).toBe(0);
      expect(await inviteAdmissionCount()).toBe(0);
    });

    it("recovers an uncertain creation without replaying advanced moves or the source revision", async () => {
      const state = new MemoryStateRepository();
      const source = await activateInviteSource(state);
      state.afterWriteFailure = MATCH_PATH;
      const transitions = coordinator(state);
      await expect(
        transitions.commit(createUpdates(), await leases()),
      ).rejects.toThrow("uncertain-applied-write");
      expect((await source.read(INVITE)).revision).toBe(0);
      const created = await state.getPath(MATCH_PATH);
      state.values.set(MATCH_PATH, {
        ...(isRecord(created) ? created : {}),
        fen: "advanced",
        flatMovesString: "a;b",
      });
      await transitions.recoverResource(
        gameSessionOperationResource(OPERATION),
      );
      expect(await state.getPath(MATCH_PATH)).toMatchObject({
        fen: "advanced",
        flatMovesString: "a;b",
      });
      expect(await transitions.recoverResource(INVITE)).toBe(false);
      expect((await source.read(INVITE)).revision).toBe(1);
      expect(state.writes.get(MATCH_PATH)).toBe(1);
    });

    it("preserves later source and live moves when another worker finishes a blocked creation", async () => {
      const state = new MemoryStateRepository();
      const source = await activateInviteSource(state);
      let release: () => void = () => {};
      let entered: () => void = () => {};
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      const reached = new Promise<void>((resolve) => {
        entered = resolve;
      });
      state.beforeWrite = async () => {
        state.beforeWrite = undefined;
        entered();
        await blocked;
      };
      const original = coordinator(state).commit(
        createUpdates(),
        await leases(),
      );
      await reached;
      try {
        await coordinator(state).recoverResource(INVITE);
        expect(await inviteAdmissionCount()).toBe(1);
        const created = await state.getPath(MATCH_PATH);
        state.values.set(MATCH_PATH, {
          ...(isRecord(created) ? created : {}),
          fen: "newer-position",
          flatMovesString: "a;b;c",
        });
        await db.batch(
          source.buildCommitStatements(
            await source.preparePatch({
              [`invites/${INVITE}/telegramDeliveryVersion`]: 3,
            }),
          ),
        );
      } finally {
        release();
      }
      await original;
      expect(await source.read(INVITE)).toMatchObject({
        revision: 2,
        value: { telegramDeliveryVersion: 3 },
      });
      expect(await state.getPath(MATCH_PATH)).toMatchObject({
        fen: "newer-position",
        flatMovesString: "a;b;c",
      });
      expect(state.writes.get(MATCH_PATH)).toBe(1);
      expect(await pendingCount()).toBe(0);
      expect(await inviteAdmissionCount()).toBe(0);
    });

    it("rolls back source, receipt, outbox, and discovery when finalization fails", async () => {
      const state = new MemoryStateRepository();
      const source = await activateInviteSource(state);
      const transitions = coordinator(state);
      await db.exec(
        "CREATE TRIGGER test_invite_finalization_failure BEFORE INSERT ON invite_sources BEGIN SELECT RAISE(ABORT, 'test-source-unavailable'); END;",
      );
      try {
        await expect(
          transitions.commit(createUpdates(), await leases()),
        ).rejects.toThrow("test-source-unavailable");
        expect((await source.read(INVITE)).revision).toBe(0);
        for (const table of [
          "game_session_mutation_receipts",
          "game_session_projection_outbox",
          "login_match_discovery",
        ]) {
          expect(
            await db
              .prepare(`SELECT COUNT(*) AS count FROM ${table}`)
              .first("count"),
          ).toBe(0);
        }
        expect(await pendingCount()).toBe(1);
      } finally {
        await db.exec("DROP TRIGGER test_invite_finalization_failure");
      }
      await transitions.recoverResource(INVITE);
      expect((await source.read(INVITE)).revision).toBe(1);
      expect(await pendingCount()).toBe(0);
      expect(state.writes.get(MATCH_PATH)).toBe(1);
    });

    it("recognizes an uncertain D1 completion without applying its source twice", async () => {
      const state = new MemoryStateRepository();
      const source = await activateInviteSource(state);
      let finalizing = false;
      let uncertainResponses = 0;
      const uncertainDb = new Proxy(db, {
        get(target, property) {
          if (property === "batch") {
            return async (statements: D1PreparedStatement[]) => {
              const committed = await target.batch(statements);
              if (finalizing) {
                finalizing = false;
                uncertainResponses++;
                throw new Error("uncertain-d1-completion");
              }
              return committed;
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      await coordinator(state, {
        db: uncertainDb,
        inviteStore: {
          ...source,
          buildCommitStatements(...args) {
            finalizing = true;
            return source.buildCommitStatements(...args);
          },
        },
      }).commit(createUpdates(), await leases());
      expect(uncertainResponses).toBe(1);
      expect((await source.read(INVITE)).revision).toBe(1);
      expect(await pendingCount()).toBe(0);
      expect(await inviteAdmissionCount()).toBe(0);
    });

    it("preserves metadata and legacy provenance during rematch and match-only commits", async () => {
      const state = new MemoryStateRepository();
      const source = await activateInviteSource(state);
      const legacyMarker = {
        sequence: 8,
        transitionId: "legacy",
        digest: "a".repeat(64),
      };
      await db
        .prepare(
          "INSERT INTO invite_sources (invite_id, source_json, revision, updated_at_ms) VALUES (?, ?, 4, ?)",
        )
        .bind(
          INVITE,
          JSON.stringify({
            hostId: HOST,
            guestId: "guest",
            hostRematches: "1",
            guestRematches: "1",
            password: "private",
            sessionTransition: legacyMarker,
          }),
          NOW,
        )
        .run();
      const proofs = await leases([INVITE]);
      await coordinator(state).commit(
        {
          [`invites/${INVITE}/hostRematches`]: "12",
          [`players/${HOST}/matches/${INVITE}2`]: {
            fen: "rematch-seed",
            color: "white",
            gameVariant: "v1",
          },
          ...receiptUpdates(),
        },
        proofs,
      );
      await coordinator(state).commit(
        {
          [`players/guest/matches/${INVITE}2`]: {
            fen: "guest-seed",
            color: "black",
            gameVariant: "v1",
          },
          ...receiptUpdates("ensure-operation"),
        },
        proofs,
      );
      expect(await source.read(INVITE)).toMatchObject({
        revision: 6,
        value: {
          hostRematches: "12",
          guestRematches: "1",
          password: "private",
          sessionTransition: legacyMarker,
        },
      });
      expect(state.writes.get(`players/${HOST}/matches/${INVITE}2`)).toBe(1);
      expect(state.writes.get(`players/guest/matches/${INVITE}2`)).toBe(1);
    });

    it("retries only preparation CAS conflicts with a stable identity and resolved timestamp", async () => {
      const state = new MemoryStateRepository();
      const source = await activateInviteSource(state);
      let attempts = 0;
      let ids = 0;
      let nowMs = NOW;
      const updates = createUpdates();
      await coordinator(state, {
        now: () => nowMs,
        createId: () => `source-intent-${++ids}`,
        inviteStore: {
          ...source,
          async preparePatch(...args) {
            const mutations = await source.preparePatch(...args);
            if (++attempts === 1) {
              await db.batch(
                source.buildCommitStatements(
                  await source.preparePatch({
                    [INVITE_PATH]: { hostId: HOST, telegramDeliveryVersion: 2 },
                  }),
                ),
              );
              nowMs++;
            }
            return mutations;
          },
        },
      }).commit(
        {
          ...updates,
          [INVITE_PATH]: {
            ...updates[INVITE_PATH],
            automatchCanceledAt: SERVER_TIMESTAMP,
          },
        },
        await leases(),
      );
      expect(attempts).toBe(2);
      expect(ids).toBe(1);
      expect(await source.read(INVITE)).toMatchObject({
        revision: 2,
        value: { telegramDeliveryVersion: 2, automatchCanceledAt: NOW },
      });
      expect(state.writes.get(MATCH_PATH)).toBe(1);
    });

    it("retains the original source precondition and rematch seed during recovery", async () => {
      const state = new MemoryStateRepository();
      const source = await activateInviteSource(state);
      await db.batch(
        source.buildCommitStatements(
          await source.preparePatch({
            [INVITE_PATH]: { hostId: HOST, guestId: "guest" },
          }),
        ),
      );
      const rematchPath = `players/${HOST}/matches/${INVITE}1`;
      state.afterWriteFailure = rematchPath;
      const transitions = coordinator(state);
      await expect(
        transitions.commit(
          {
            [`invites/${INVITE}/hostRematches`]: "1",
            [rematchPath]: {
              fen: "fixed-rematch",
              color: "white",
              gameVariant: "v1",
            },
            ...receiptUpdates(),
          },
          await leases([INVITE]),
        ),
      ).rejects.toThrow("uncertain");
      await db.batch(
        source.buildCommitStatements(
          await source.preparePatch({
            [`invites/${INVITE}/guestId`]: "different-guest",
          }),
        ),
      );
      await expect(transitions.recoverResource(INVITE)).rejects.toThrow(
        "invite_source_revision_guard",
      );
      expect(await source.read(INVITE)).toMatchObject({
        revision: 2,
        value: { guestId: "different-guest" },
      });
      expect(await state.getPath(rematchPath)).toMatchObject({
        fen: "fixed-rematch",
      });
      expect(state.writes.get(rematchPath)).toBe(1);
      expect(await pendingCount()).toBe(1);
    });

    it.each([
      { eventOwned: true },
      { eventId: "event-one", eventOwned: false },
    ])(
      "rejects existing and proposed event ownership %j before effects",
      async (ownership) => {
        const state = new MemoryStateRepository();
        const source = await activateInviteSource(state);
        const proofs = await leases();
        const updates = createUpdates();
        await expect(
          coordinator(state).commit(
            {
              ...updates,
              [INVITE_PATH]: { ...updates[INVITE_PATH], ...ownership },
            },
            proofs,
          ),
        ).rejects.toThrow("event-owned-invite");
        await db.batch(
          buildMatchPresentationRegistrationStatements(
            db,
            await presentationCapture().prepare(
              [HOST, "guest"].map((actorUid) => ({
                inviteId: INVITE,
                matchId: INVITE,
                actorUid,
                emojiId: 1,
                aura: "",
                sourceId: "existing-event-match",
              })),
            ),
            NOW,
          ),
        );
        await db.batch(
          source.buildCommitStatements(
            await source.preparePatch({
              [INVITE_PATH]: { hostId: HOST, guestId: "guest", ...ownership },
            }),
          ),
        );
        await expect(
          coordinator(state).commit(updates, proofs),
        ).rejects.toThrow("event-owned-invite");
        expect(state.values.size).toBe(0);
        expect(await pendingCount()).toBe(0);
      },
    );

    it("rejects legacy recovery after activation without touching RTDB invites or matches", async () => {
      const state = new MemoryStateRepository();
      state.beforeWriteFailure = MATCH_PATH;
      const transitions = coordinator(state);
      await expect(
        transitions.commit(createUpdates(), await leases()),
      ).rejects.toThrow("before-write");
      await db
        .prepare(
          "UPDATE game_session_transitions SET payload_json = json_set(payload_json, '$.version', 1) WHERE status = 'pending'",
        )
        .run();
      await expect(transitions.recoverResource(INVITE)).rejects.toThrow(
        "invalid-intent",
      );
      expect(state.values.size).toBe(0);
      expect(await pendingCount()).toBe(1);
      await expect(transitions.assertResourceAvailable(INVITE)).rejects.toThrow(
        "resource-pending",
      );
    });

    it("rejects the retired invite backend without reserving or materializing a session", async () => {
      await db
        .prepare(
          "UPDATE invite_source_control SET backend = 'rtdb', epoch = 0, verified_at_ms = NULL, activated_at_ms = NULL WHERE singleton = 1",
        )
        .run();
      const state = new MemoryStateRepository();
      const transitions = coordinator(state);
      await expect(
        transitions.commit(createUpdates(), await leases()),
      ).rejects.toThrow("invite-source-backend-retired");
      await expect(transitions.sweep()).rejects.toThrow(
        "invite-source-backend-retired",
      );
      expect(state.values.size).toBe(0);
      expect(await pendingCount()).toBe(0);
      expect(await inviteAdmissionCount()).toBe(0);
    });

    it("retains completed legacy transition bytes during current recovery", async () => {
      const payload = JSON.stringify({
        version: 1,
        invite: { marker: "retained" },
      });
      await db
        .prepare(
          `INSERT INTO game_session_transitions
          (transition_id, invite_id, payload_json, status, created_at_ms, updated_at_ms)
          VALUES ('completed-legacy', ?, ?, 'completed', ?, ?)`,
        )
        .bind(INVITE, payload, NOW, NOW)
        .run();
      const state = new MemoryStateRepository();
      expect(await coordinator(state).sweep()).toEqual({
        recovered: 0,
        failed: 0,
      });
      expect(
        await db
          .prepare(
            "SELECT payload_json FROM game_session_transitions WHERE transition_id = 'completed-legacy'",
          )
          .first("payload_json"),
      ).toBe(payload);
      expect(state.values.size).toBe(0);
    });

    it("leaves supplied admissions owned by the coordinator and rejects a revoked admission", async () => {
      const state = new MemoryStateRepository();
      await activateInviteSource(state);
      const admission = await acquireInviteSourceAdmission(db, "coordinator", {
        now: () => NOW,
      });
      const transitions = coordinator(state, { inviteAdmission: admission });
      await transitions.commit(createUpdates(), await leases());
      expect(await inviteAdmissionCount()).toBe(1);
      await releaseInviteSourceAdmission(db, admission);
      await expect(transitions.recoverResource(INVITE)).rejects.toThrow(
        "invite_source_control_guard",
      );
      expect(await inviteAdmissionCount()).toBe(0);
      expect(state.writes.get(MATCH_PATH)).toBe(1);
    });

    it("does not retry a control change as a source revision conflict", async () => {
      const state = new MemoryStateRepository();
      const source = await activateInviteSource(state);
      let attempts = 0;
      await expect(
        coordinator(state, {
          inviteStore: {
            ...source,
            async preparePatch(...args) {
              const mutations = await source.preparePatch(...args);
              attempts++;
              await db
                .prepare(
                  "UPDATE invite_source_control SET state = 'frozen', freeze_generation = freeze_generation + 1 WHERE singleton = 1",
                )
                .run();
              return mutations;
            },
          },
        }).commit(createUpdates(), await leases()),
      ).rejects.toThrow("invite_source_control_guard");
      expect(attempts).toBe(1);
      expect(state.values.size).toBe(0);
      expect(await pendingCount()).toBe(0);
    });
  });

  it("keeps the receipt and projection outbox unpublished when discovery capture fails", async () => {
    const state = new MemoryStateRepository();
    const transitions = coordinator(state);
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
      expect(await state.getPath(MATCH_PATH)).toMatchObject({ fen: "seed" });
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
    expect(state.writes.get(MATCH_PATH)).toBe(1);
  });

  it("keeps reservations after a failed match write and recovers through login and operation keys", async () => {
    const state = new MemoryStateRepository();
    state.beforeWriteFailure = MATCH_PATH;
    const transitions = coordinator(state);
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
    const state = new MemoryStateRepository();
    state.afterWriteFailure = MATCH_PATH;
    const transitions = coordinator(state);
    await expect(
      transitions.commit(createUpdates(), await leases()),
    ).rejects.toThrow("uncertain");
    const match = await state.getPath(MATCH_PATH);
    expect(isRecord(match)).toBe(true);
    state.values.set(MATCH_PATH, {
      ...(isRecord(match) ? match : {}),
      fen: "after-move",
      flatMovesString: "move-1",
      timer: "terminal",
      status: "surrendered",
    });
    await transitions.recoverResource(INVITE);
    expect(await state.getPath(MATCH_PATH)).toMatchObject({
      fen: "after-move",
      flatMovesString: "move-1",
      timer: "terminal",
      status: "surrendered",
    });
    expect(state.writes.get(MATCH_PATH)).toBe(1);
  });

  it("notifies after recovered finalization and ignores notification failure", async () => {
    const state = new MemoryStateRepository();
    state.afterWriteFailure = MATCH_PATH;
    const notifications: string[] = [];
    const transitions = coordinator(state, {
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
    const state = new MemoryStateRepository();
    state.values.set(MATCH_PATH, {
      fen: "legacy-moves",
      flatMovesString: "a;b",
    });
    await expect(
      coordinator(state).commit(createUpdates(), await leases()),
    ).rejects.toThrow("match-creation-conflict");
    expect(await state.getPath(MATCH_PATH)).toEqual({
      fen: "legacy-moves",
      flatMovesString: "a;b",
    });
    expect(state.values.has(INVITE_PATH)).toBe(false);
    expect(
      await createAutomatchD1Store(db).getPath(`automatch/${INVITE}`),
    ).toBeNull();
    expect(await pendingCount()).toBe(1);
  });

  it("protects the prepared revisions from projection settlement until recovery completes", async () => {
    const state = new MemoryStateRepository();
    const store = createAutomatchD1Store(db, { writeGuards: () => [] });
    await store.patchRoot({
      [`profileGameProjectionOutbox/automatch/${INVITE}`]: {
        requestId: "older",
      },
    });
    state.beforeWriteFailure = MATCH_PATH;
    const transitions = coordinator(state);
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
    const state = new MemoryStateRepository();
    const store = createAutomatchD1Store(db, { writeGuards: () => [] });
    const outboxPath = `profileGameProjectionOutbox/automatch/${INVITE}`;
    await store.patchRoot({ [outboxPath]: { requestId: "older" } });
    let nowMs = NOW;
    let preparations = 0;
    let ids = 0;
    let inviteReads = 0;
    const notifications: string[] = [];
    await coordinator(state, {
      now: () => nowMs,
      createId: () => `intent-${++ids}`,
      onCommitted: async (inviteId) => {
        notifications.push(inviteId);
      },
      state: {
        async getPath(path) {
          inviteReads++;
          return state.getPath(path);
        },
        transactPath: state.transactPath.bind(state),
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
    expect(inviteReads).toBe(0);
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
    expect(await createInviteSourceD1Store(db).read(INVITE)).toMatchObject({
      revision: 1,
      value: { hostId: HOST, automatchStateHint: "pending" },
    });
    expect(state.writes.get(MATCH_PATH)).toBe(1);
    expect(state.writes.has(INVITE_PATH)).toBe(false);
    expect(await pendingCount()).toBe(0);
  });

  it("bounds preparation conflicts to three attempts without publishing effects", async () => {
    const state = new MemoryStateRepository();
    const store = createAutomatchD1Store(db, { writeGuards: () => [] });
    let preparations = 0;
    const transitions = coordinator(state, {
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
    expect(state.values.size).toBe(0);
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
      const state = new MemoryStateRepository();
      const store = createAutomatchD1Store(db, { writeGuards: () => [] });
      const controller = new AbortController();
      let preparations = 0;
      let nowMs = NOW;
      const transitions = coordinator(state, {
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
      expect(state.values.size).toBe(0);
      expect(await pendingCount()).toBe(0);
      await expect(
        transitions.assertResourceAvailable(INVITE),
      ).resolves.toBeUndefined();
    },
  );

  it("does not prepare another intent after a match materialization failure", async () => {
    const state = new MemoryStateRepository();
    const store = createAutomatchD1Store(db, { writeGuards: () => [] });
    let preparations = 0;
    state.beforeWriteFailure = MATCH_PATH;
    await expect(
      coordinator(state, {
        store: interleavePreparations(store, async (attempt) => {
          preparations = attempt;
        }),
      }).commit(createUpdates(), await leases()),
    ).rejects.toThrow("before-write");
    expect(preparations).toBe(1);
    expect(await pendingCount()).toBe(1);
  });

  it("cannot reserve an expired, stolen, or legacy lease", async () => {
    const state = new MemoryStateRepository();
    const proofs = await leases();
    await db
      .prepare(
        "UPDATE game_session_mutation_locks SET expires_at_ms = ? WHERE lock_id = ?",
      )
      .bind(NOW, INVITE)
      .run();
    await expect(
      coordinator(state).commit(createUpdates(), proofs),
    ).rejects.toThrow();
    expect(await pendingCount()).toBe(0);
    expect(state.values.size).toBe(0);
    await db
      .prepare(
        "UPDATE game_session_mutation_locks SET expires_at_ms = ?, writer_generation = 0 WHERE lock_id = ?",
      )
      .bind(NOW + 60_000, INVITE)
      .run();
    await expect(
      coordinator(state).commit(createUpdates(), proofs),
    ).rejects.toThrow();
    expect(await pendingCount()).toBe(0);
    await db
      .prepare(
        "UPDATE game_session_mutation_locks SET writer_generation = 2, owner_id = 'successor' WHERE lock_id = ?",
      )
      .bind(INVITE)
      .run();
    await expect(
      coordinator(state).commit(createUpdates(), proofs),
    ).rejects.toThrow();
    expect(await pendingCount()).toBe(0);
  });

  it("allows concurrent recovery but a late create CAS never overwrites live progress", async () => {
    const state = new MemoryStateRepository();
    let release: () => void = () => {};
    let entered: () => void = () => {};
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reached = new Promise<void>((resolve) => {
      entered = resolve;
    });
    state.beforeWrite = async (path) => {
      if (path !== MATCH_PATH) return;
      state.beforeWrite = undefined;
      entered();
      await blocked;
    };
    const transitions = coordinator(state);
    const original = transitions.commit(createUpdates(), await leases());
    await reached;
    await coordinator(state).recoverResource(INVITE);
    const match = await state.getPath(MATCH_PATH);
    state.values.set(MATCH_PATH, {
      ...(isRecord(match) ? match : {}),
      fen: "live-progress",
      flatMovesString: "a;b;c",
    });
    release();
    await original;
    expect(await state.getPath(MATCH_PATH)).toMatchObject({
      fen: "live-progress",
      flatMovesString: "a;b;c",
    });
    expect(state.writes.get(MATCH_PATH)).toBe(1);
    expect(await pendingCount()).toBe(0);
  });

  it("recovers cancellation once while preserving invite metadata and the Telegram generation", async () => {
    const state = new MemoryStateRepository();
    const store = createAutomatchD1Store(db, { writeGuards: () => [] });
    const source = await activateInviteSource(state);
    await db.batch(
      source.buildCommitStatements(
        await source.preparePatch({
          [INVITE_PATH]: {
            hostId: HOST,
            hostColor: "white",
            automatchStateHint: "pending",
            password: "private",
            custom: { retained: true },
          },
        }),
      ),
    );
    await store.patchRoot({
      [`automatch/${INVITE}`]: { uid: HOST },
      [`telegramAutomatches/${INVITE}`]: {
        generation: 4,
        lifecycle: "pending",
      },
    });
    const transitions = coordinator(state);
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
    await db.exec(
      "CREATE TRIGGER test_cancel_publication_failure BEFORE UPDATE ON invite_sources BEGIN SELECT RAISE(ABORT, 'cancel-publication-unavailable'); END;",
    );
    try {
      await expect(transitions.commit(updates, await leases())).rejects.toThrow(
        "cancel-publication-unavailable",
      );
      expect(
        await store.getPath(`telegramAutomatches/${INVITE}`),
      ).toMatchObject({
        generation: 4,
        lifecycle: "pending",
      });
    } finally {
      await db.exec("DROP TRIGGER test_cancel_publication_failure");
    }
    await transitions.recoverResource(INVITE);
    expect(await store.getPath(`automatch/${INVITE}`)).toBeNull();
    expect(await store.getPath(`telegramAutomatches/${INVITE}`)).toMatchObject({
      generation: 5,
      lifecycle: "canceled",
    });
    expect(await source.read(INVITE)).toMatchObject({
      revision: 2,
      value: {
        automatchCanceledAt: NOW,
        password: "private",
        custom: { retained: true },
      },
    });
    expect(state.writes.has(INVITE_PATH)).toBe(false);
  });

  it("ensures an initial match from canonical invite metadata and records its actor", async () => {
    const state = new MemoryStateRepository();
    const source = await activateInviteSource(state);
    await db.batch(
      source.buildCommitStatements(
        await source.preparePatch({
          [INVITE_PATH]: { hostId: HOST, guestId: "guest", hostRematches: "1" },
        }),
      ),
    );
    await coordinator(state).commit(
      {
        [MATCH_PATH]: {
          fen: "mirrored",
          color: "white",
          status: "",
          timer: "",
        },
        ...receiptUpdates(),
      },
      await leases([INVITE]),
    );
    expect(await source.read(INVITE)).toMatchObject({
      revision: 2,
      value: { hostRematches: "1" },
    });
    expect(await state.getPath(MATCH_PATH)).toMatchObject({
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
      const state = new MemoryStateRepository();
      const source = await activateInviteSource(state);
      await db.batch(
        source.buildCommitStatements(
          await source.preparePatch({
            [INVITE_PATH]: { hostId: HOST, guestId: actorUid },
          }),
        ),
      );
      await coordinator(state).commit(
        {
          [`players/${actorUid}/matches/${matchId}`]: {
            fen: "guest-seed",
            color: "black",
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

  it("bounds recovery and leaves failed intents reserved for a later retry", async () => {
    const state = new MemoryStateRepository();
    state.beforeWriteFailure = MATCH_PATH;
    const transitions = coordinator(state);
    await expect(
      transitions.commit(createUpdates(), await leases()),
    ).rejects.toThrow();
    state.beforeWriteFailure = MATCH_PATH;
    expect(await transitions.sweep(1)).toEqual({ recovered: 0, failed: 1 });
    expect(await pendingCount()).toBe(1);
    expect(await transitions.sweep(1)).toEqual({ recovered: 1, failed: 0 });
    await expect(transitions.sweep(101)).rejects.toThrow("invalid-sweep-limit");
  });

  it("bounds completed journal retention without deleting markers or pending work", async () => {
    const state = new MemoryStateRepository();
    await coordinator(state).commit(createUpdates(), await leases());
    const existingMarker = await state.getPath(MATCH_PATH);
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
    expect(await coordinator(state, { now: () => future }).sweep(1)).toEqual({
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
    expect(await state.getPath(MATCH_PATH)).toEqual(existingMarker);
    await expect(
      coordinator(state).assertResourceAvailable("held-invite"),
    ).rejects.toThrow("resource-pending");
  });
});
