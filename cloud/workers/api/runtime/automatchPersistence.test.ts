import { env } from "cloudflare:workers";
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAutomatchPersistence } from "../src/automatchPersistence.ts";
import { createGameSessionMutationLockStore } from "../src/gameplayCoordinationD1.ts";
import type { FirebaseRtdbClient } from "../src/firebaseRtdb.ts";
import { validateTelegramTransactionDecision } from "../src/telegramTransaction.ts";

const testEnv = env as Env & { TEST_D1_MIGRATIONS: D1Migration[] };
const db = env.PROFILE_GAMES_DB;

function firebase() {
  const values = new Map<string, unknown>();
  const patches: Record<string, unknown>[] = [];
  const client: FirebaseRtdbClient = {
    async getPath(path) {
      return structuredClone(values.get(path) ?? null);
    },
    async patchRoot(updates) {
      patches.push(structuredClone(updates));
      for (const [path, value] of Object.entries(updates))
        values.set(path, value);
    },
    async transactPath(path, updater) {
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

describe("automatch persistence integration", () => {
  beforeAll(() => applyD1Migrations(db, testEnv.TEST_D1_MIGRATIONS));
  beforeEach(async () => {
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
    ])
      await db.prepare(`DELETE FROM ${table}`).run();
    await db
      .prepare(
        "UPDATE automatch_runtime_control SET backend = 'd1', state = 'active', epoch = epoch + 1",
      )
      .run();
  });

  it("routes mixed session writes through the journal and outbox transactions exclusively to D1", async () => {
    const raw = firebase();
    const runtime = createAutomatchPersistence(db, raw.client);
    const locks = runtime.decorateLocks(createGameSessionMutationLockStore(db));
    const lock = { lockId: "invite-one", operationId: "operation-one" };
    await locks.acquire(lock, "owner", Date.now());
    await runtime.client.patchRoot({
      "invites/invite-one": { hostId: "host", guestId: null },
      "players/host/matches/invite-one": {
        fen: "initial",
        flatMovesString: "",
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
    expect(raw.values.get("invites/invite-one")).toMatchObject({
      sessionTransition: { sequence: 1 },
    });
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

  it("recovers a failed invite publication before admitting a competing session and preserves moves", async () => {
    const raw = firebase();
    let failInvite = true;
    const runtime = createAutomatchPersistence(db, {
      ...raw.client,
      async transactPath(path, updater, signal) {
        if (path.startsWith("invites/") && failInvite)
          throw new Error("connection-lost");
        return raw.client.transactPath(path, updater, signal);
      },
    });
    const locks = runtime.decorateLocks(createGameSessionMutationLockStore(db));
    const lock = { lockId: "invite-one", operationId: "operation-one" };
    await locks.acquire(lock, "owner", Date.now());
    await expect(
      runtime.client.patchRoot({
        "invites/invite-one": { hostId: "host" },
        "players/host/matches/invite-one": {
          fen: "initial",
          flatMovesString: "",
        },
        "automatch/invite-one": { uid: "host" },
        "gameplayMutationReceipts/operation-one": {
          inviteId: "invite-one",
          requesterUid: "host",
        },
      }),
    ).rejects.toThrow("connection-lost");
    await locks.release(lock, "owner");
    const match = raw.values.get("players/host/matches/invite-one") as Record<
      string,
      unknown
    >;
    raw.values.set("players/host/matches/invite-one", {
      ...match,
      fen: "advanced",
      flatMovesString: "move",
    });
    failInvite = false;
    await locks.acquire(
      { ...lock, operationId: "operation-two" },
      "next",
      Date.now(),
    );
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

  it("rejects frozen persistence writes while allowing raw live match updates", async () => {
    const raw = firebase();
    const runtime = createAutomatchPersistence(db, raw.client);
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
    await runtime.client.patchRoot({
      "players/host/matches/live/timer": "1;1000",
    });
    expect(raw.values.get("players/host/matches/live/timer")).toBe("1;1000");
    expect(await runtime.sweep()).toEqual({ recovered: 0, failed: 0 });
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
    const runtime = createAutomatchPersistence(observed, firebase().client);
    await runtime.recoverLogins(
      Array.from({ length: 512 }, (_, i) => `login-${i}`),
    );
    expect(queries).toBe(2);
  });
});
