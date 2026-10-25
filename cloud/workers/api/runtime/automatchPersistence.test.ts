import { inviteDocumentFixture } from "../test/inviteDocumentFixture.ts";
import { readMatchCreationInput } from "../src/matchRecordCodec.ts";
import {
  matchTestPort,
  legacySessionClient,
} from "../test/gameSessionTestPorts.ts";
import { env } from "cloudflare:workers";
import type { D1Migration } from "cloudflare:test";
import { applyStrictMatchStateTestMigrations } from "./strictMatchStateTestFixture.ts";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAutomatchPersistenceCompatibility as createAutomatchPersistence } from "../src/automatchPersistence.ts";
import { createGameSessionMutationLockStore } from "../src/gameplayCoordinationD1.ts";
import type { StateRepository } from "../test/stateRepositoryTestTypes.ts";
import { validateTelegramTransactionDecision } from "../src/telegramTransaction.ts";
import { resetMatchPresentationTestState } from "./matchPresentationTestFixture.ts";

const testEnv = env as Env & { TEST_D1_MIGRATIONS: D1Migration[] };
const db = env.PROFILE_GAMES_DB;

function memoryState() {
  const values = new Map<string, unknown>();
  const patches: Record<string, unknown>[] = [];
  const assertLivePath = (path: string) => {
    if (
      !/^players\/[^/]+\/matches\//.test(path) &&
      !path.startsWith("matchTimerClaims/")
    ) {
      throw new Error("retired-source-path");
    }
  };
  const client: StateRepository = {
    async getPath(path) {
      assertLivePath(path);
      return structuredClone(values.get(path) ?? null);
    },
    async patchRoot(updates) {
      patches.push(structuredClone(updates));
      for (const [path, value] of Object.entries(updates)) {
        assertLivePath(path);
        values.set(path, value);
      }
    },
    async transactPath(path, updater) {
      assertLivePath(path);
      const current = structuredClone(values.get(path) ?? null);
      const decision = validateTelegramTransactionDecision(updater(current));
      if (!decision.commit) {
        return {
          committed: false,
          value: current,
          decision: decision.decision,
        };
      }
      values.set(path, structuredClone(decision.value));
      return {
        committed: true,
        value: decision.value,
        decision: decision.decision,
      };
    },
  };
  return { values, patches, client };
}

function persistence(
  client: StateRepository,
  database = db,
  onCommitted?: (inviteId: string) => Promise<void>,
) {
  const persistence = createAutomatchPersistence(
    database,
    matchTestPort(client),
    {
      onCommitted,
      async prepareMatchPresentations(creations) {
        return creations.map((creation) => ({
          ...creation,
          seedDigest: "a".repeat(64),
          provenance: "creation" as const,
        }));
      },
    },
  );
  return {
    ...persistence,
    typedClient: persistence.client,
    client: legacySessionClient(persistence.rawClient),
  };
}

describe("automatch persistence integration", () => {
  beforeAll(() =>
    applyStrictMatchStateTestMigrations(db, testEnv.TEST_D1_MIGRATIONS),
  );
  beforeEach(async () => {
    await resetMatchPresentationTestState(
      db,
      testEnv.TEST_D1_MIGRATIONS,
      "durable",
    );
    for (const table of [
      "game_session_transition_resources",
      "game_session_transitions",
      "automatch_write_admissions",
      "automatch_entries",
      "automatch_telegram_sources",
      "automatch_telegram_projection_outbox",
      "game_session_projection_outbox",
      "game_session_mutation_receipts",
      "game_session_mutation_locks",
      "invite_sources",
      "invite_source_write_admissions",
      "login_match_discovery",
    ])
      await db.prepare(`DELETE FROM ${table}`).run();
    await db
      .prepare(
        "UPDATE automatch_runtime_control SET backend = 'd1', state = 'active', epoch = epoch + 1",
      )
      .run();
    await db
      .prepare(
        "UPDATE invite_source_control SET backend = 'd1', state = 'active', epoch = 1, freeze_generation = 0, verified_at_ms = 1, activated_at_ms = 1 WHERE singleton = 1",
      )
      .run();
  });

  it("routes mixed session writes through the journal and outbox transactions exclusively to D1", async () => {
    const raw = memoryState();
    const runtime = persistence(raw.client);
    const locks = runtime.decorateLocks(createGameSessionMutationLockStore(db));
    const lock = { lockId: "invite-one", operationId: "operation-one" };
    await locks.acquire(lock, "owner", Date.now());
    await runtime.client.patchRoot({
      "invites/invite-one": { hostId: "host", guestId: null },
      "players/host/matches/invite-one": {
        fen: "initial",
        flatMovesString: "",
        color: "white",
      },
      "automatch/invite-one": {
        uid: "host",
        timestamp: { ".sv": "timestamp" },
      },
      "gameplayMutationReceipts/operation-one": {
        inviteId: "invite-one",
        requesterUid: "host",
        response: { ok: true },
      },
      "profileGameProjectionOutbox/automatch/invite-one": {
        requestId: "operation-one",
        status: "pending",
      },
    });
    await locks.release(lock, "owner");
    expect(raw.patches).toEqual([]);
    expect(await runtime.client.getPath("automatch/invite-one")).toMatchObject({
      uid: "host",
    });
    expect(raw.values.get("players/host/matches/invite-one")).toMatchObject({
      fen: "initial",
      sessionCreation: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(await runtime.client.getPath("invites/invite-one")).toMatchObject({
      hostId: "host",
    });
    expect(raw.values.has("invites/invite-one")).toBe(false);
    const result = await runtime.client.transactPath(
      "profileGameProjectionOutbox/automatch/invite-one",
      () => ({ value: null, decision: "cleared" }),
    );
    expect(result.committed).toBe(true);
    expect(
      await runtime.client.getPath(
        "profileGameProjectionOutbox/automatch/invite-one",
      ),
    ).toBeNull();
    expect(
      await db
        .prepare("SELECT COUNT(*) AS n FROM automatch_write_admissions")
        .first("n"),
    ).toBe(0);
  });

  it("releases the invite before waiting for a slow notification", async () => {
    const notificationStarted = Promise.withResolvers<void>();
    const finishNotification = Promise.withResolvers<void>();
    const notifications: string[] = [];
    let notified = false;
    const runtime = persistence(memoryState().client, db, async (inviteId) => {
      notifications.push(inviteId);
      notificationStarted.resolve();
      await finishNotification.promise;
      notified = true;
    });
    const base = createGameSessionMutationLockStore(db);
    const locks = runtime.decorateLocks(base);
    const lock = { lockId: "invite-one", operationId: "operation-one" };
    const nextLock = { ...lock, operationId: "operation-two" };
    await locks.acquire(lock, "owner", Date.now());
    const commit = runtime.client.patchRoot({
      "invites/invite-one": { hostId: "host" },
      "automatch/invite-one": { uid: "host" },
    });
    let release: Promise<void> | undefined;
    try {
      expect(
        await Promise.race([
          commit.then(() => "committed"),
          notificationStarted.promise.then(() => "notifying"),
        ]),
      ).toBe("committed");
      expect(notifications).toEqual([]);
      release = locks.release(lock, "owner");
      await notificationStarted.promise;
      await base.acquire(nextLock, "next-owner", Date.now());
      expect(notified).toBe(false);
      expect(await runtime.client.getPath("invites/invite-one")).toMatchObject({
        hostId: "host",
      });
    } finally {
      finishNotification.resolve();
      await commit;
      await (release || locks.release(lock, "owner"));
      await base.release(nextLock, "next-owner");
    }
    expect(notifications).toEqual(["invite-one"]);
    expect(notified).toBe(true);
  });

  it("coalesces commits until the outer automatch lease is also released", async () => {
    const notifications: string[] = [];
    const lockCounts: (number | null)[] = [];
    const observedInvites: unknown[] = [];
    const runtime = persistence(memoryState().client, db, async (inviteId) => {
      notifications.push(inviteId);
      lockCounts.push(
        await db
          .prepare("SELECT COUNT(*) AS n FROM game_session_mutation_locks")
          .first<number>("n"),
      );
      observedInvites.push(await runtime.client.getPath("invites/invite-one"));
    });
    const locks = runtime.decorateLocks(createGameSessionMutationLockStore(db));
    const outer = { lockId: "automatch-owner", operationId: "owner-operation" };
    const inner = { lockId: "invite-one", operationId: "operation-one" };
    await locks.acquire(outer, "outer-owner", Date.now());
    await locks.acquire(inner, "inner-owner", Date.now());
    await runtime.client.patchRoot({
      "invites/invite-one": { hostId: "host" },
      "automatch/invite-one": { uid: "host" },
    });
    await runtime.client.patchRoot({
      "invites/invite-one/hostRematches": "1",
      "automatch/invite-one": { uid: "host" },
    });
    expect(notifications).toEqual([]);
    await locks.release(inner, "inner-owner");
    expect(notifications).toEqual([]);
    await locks.release(outer, "outer-owner");
    expect(notifications).toEqual(["invite-one"]);
    expect(lockCounts).toEqual([0]);
    expect(observedInvites).toMatchObject([{ hostRematches: "1" }]);
  });

  it.each(["synchronous", "asynchronous"])(
    "preserves release outcomes when the notification has a %s failure",
    async (failure) => {
      for (const releaseFails of [false, true]) {
        const notifications: string[] = [];
        const runtime = persistence(memoryState().client, db, (inviteId) => {
          notifications.push(inviteId);
          if (failure === "synchronous") throw new Error("notification-failed");
          return Promise.reject(new Error("notification-failed"));
        });
        const base = createGameSessionMutationLockStore(db);
        const releaseError = new Error("release-outcome-unknown");
        const locks = runtime.decorateLocks({
          ...base,
          async release(lock, ownerId) {
            await base.release(lock, ownerId);
            if (releaseFails) throw releaseError;
          },
        });
        const lock = { lockId: "invite-one", operationId: "operation-one" };
        await locks.acquire(lock, "owner", Date.now());
        await runtime.client.patchRoot({
          "invites/invite-one": { hostId: "host" },
          "automatch/invite-one": { uid: "host" },
        });
        expect(notifications).toEqual([]);
        if (releaseFails) {
          await expect(locks.release(lock, "owner")).rejects.toBe(releaseError);
        } else {
          await expect(locks.release(lock, "owner")).resolves.toBeUndefined();
        }
        expect(notifications).toEqual(["invite-one"]);
      }
    },
  );

  it("recovers an uncertain match creation before admitting a competing session and preserves moves", async () => {
    const raw = memoryState();
    let failCreation = true;
    const notifications: string[] = [];
    const lockCounts: (number | null)[] = [];
    const runtime = persistence(
      {
        ...raw.client,
        async transactPath(path, updater, signal) {
          const result = await raw.client.transactPath(path, updater, signal);
          if (failCreation) {
            failCreation = false;
            throw new Error("connection-lost");
          }
          return result;
        },
      },
      db,
      async (inviteId) => {
        notifications.push(inviteId);
        lockCounts.push(
          await db
            .prepare("SELECT COUNT(*) AS n FROM game_session_mutation_locks")
            .first<number>("n"),
        );
      },
    );
    const locks = runtime.decorateLocks(createGameSessionMutationLockStore(db));
    const lock = { lockId: "invite-one", operationId: "operation-one" };
    await locks.acquire(lock, "owner", Date.now());
    await expect(
      runtime.client.patchRoot({
        "invites/invite-one": { hostId: "host" },
        "players/host/matches/invite-one": {
          fen: "initial",
          flatMovesString: "",
          color: "white",
        },
        "automatch/invite-one": { uid: "host" },
        "gameplayMutationReceipts/operation-one": {
          inviteId: "invite-one",
          requesterUid: "host",
        },
      }),
    ).rejects.toThrow("connection-lost");
    await locks.release(lock, "owner");
    expect(notifications).toEqual([]);
    const match = raw.values.get("players/host/matches/invite-one") as Record<
      string,
      unknown
    >;
    raw.values.set("players/host/matches/invite-one", {
      ...match,
      fen: "advanced",
      flatMovesString: "move",
    });
    await locks.acquire(
      { ...lock, operationId: "operation-two" },
      "next",
      Date.now(),
    );
    expect(notifications).toEqual(["invite-one"]);
    expect(lockCounts).toEqual([0]);
    expect(raw.values.get("players/host/matches/invite-one")).toMatchObject({
      fen: "advanced",
      flatMovesString: "move",
    });
    expect(
      await runtime.client.getPath("gameplayMutationReceipts/operation-one"),
    ).toMatchObject({ requesterUid: "host" });
    expect(
      await db
        .prepare("SELECT COUNT(*) AS n FROM game_session_transition_resources")
        .first("n"),
    ).toBe(0);
  });

  it("rejects frozen session writes while keeping the match port separate", async () => {
    const raw = memoryState();
    const runtime = persistence(raw.client);
    await db
      .prepare(
        "UPDATE automatch_runtime_control SET state = 'frozen', freeze_generation = freeze_generation + 1",
      )
      .run();
    await expect(
      runtime.client.patchRoot({ "automatch/invite-one": { uid: "host" } }),
    ).rejects.toMatchObject({
      status: 503,
      message: "automatch-persistence-frozen",
    });
    await matchTestPort(raw.client).createMatchRecords({
      inviteId: "live",
      transitionId: "test",
      records: [
        {
          playerId: "host",
          matchId: "live",
          marker: "created",
          value: readMatchCreationInput({ timer: "1;1000" }),
        },
      ],
    });
    expect(raw.values.get("players/host/matches/live")).toMatchObject({
      timer: "1;1000",
    });
    expect(await runtime.sweep()).toEqual({ recovered: 0, failed: 0 });
  });

  it.each(["automatch", "invite"])(
    "rejects the retired %s backend without falling back or leaking admissions",
    async (backend) => {
      if (backend === "automatch") {
        await db.batch([
          db.prepare("DELETE FROM automatch_runtime_control"),
          db.prepare(
            "INSERT INTO automatch_runtime_control (singleton, backend, state, epoch, freeze_generation) VALUES (1, 'rtdb', 'active', 1, 0)",
          ),
        ]);
      } else {
        await db
          .prepare(
            "UPDATE invite_source_control SET backend = 'rtdb', epoch = 0, verified_at_ms = NULL, activated_at_ms = NULL WHERE singleton = 1",
          )
          .run();
      }
      const raw = memoryState();
      const runtime = persistence(raw.client);
      await expect(
        runtime.client.getPath("invites/invite-one"),
      ).rejects.toThrow("backend-retired");
      await expect(
        runtime.client.patchRoot({ "automatch/invite-one": { uid: "host" } }),
      ).rejects.toThrow("backend-retired");
      await expect(
        runtime.typedClient.projectionRecovery.repairInvalidAutomatchProfileOutbox(
          "invite-one",
          100,
          () => "repair",
        ),
      ).rejects.toThrow("backend-retired");
      await expect(runtime.writesEnabled()).rejects.toThrow("backend-retired");
      if (backend === "automatch") {
        await expect(runtime.readQueuedByLogins(["host"])).rejects.toThrow(
          "backend-retired",
        );
        await expect(runtime.expireReceipts(Date.now(), 10)).rejects.toThrow(
          "backend-retired",
        );
        await expect(runtime.sweep()).rejects.toThrow("backend-retired");
      }
      for (const table of [
        "automatch_write_admissions",
        "invite_source_write_admissions",
      ]) {
        expect(
          await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first("n"),
        ).toBe(0);
      }
      expect(raw.patches).toEqual([]);
      expect(raw.values.size).toBe(0);
    },
  );

  it("rejects direct invite changes and exposes no generic raw fallback", async () => {
    const raw = memoryState();
    const runtime = persistence(raw.client);
    await expect(
      runtime.typedClient.commitSessionChanges([
        {
          kind: "invite-merge",
          inviteId: "invite-one",
          value: inviteDocumentFixture({ hostId: "host" }),
        },
      ]),
    ).rejects.toThrow("invite-source-transition-required");
    expect(runtime.typedClient).not.toHaveProperty("getPath");
    expect(runtime.typedClient).not.toHaveProperty("patchRoot");
    expect(runtime.typedClient).not.toHaveProperty("transactPath");
    expect(raw.values.size).toBe(0);
  });

  it("checks all 512 linked logins with two queries when no recovery is pending", async () => {
    let queries = 0;
    const observed = new Proxy(db, {
      get(target, property) {
        if (property === "withSession") {
          return (constraint?: D1SessionConstraint | D1SessionBookmark) => {
            const session = target.withSession(constraint);
            return {
              prepare(query: string) {
                queries++;
                return session.prepare(query);
              },
              batch: session.batch.bind(session),
              getBookmark: session.getBookmark.bind(session),
            };
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const runtime = persistence(memoryState().client, observed);
    await runtime.recoverLogins(
      Array.from({ length: 512 }, (_, i) => `login-${i}`),
    );
    expect(queries).toBe(2);
  });
});
