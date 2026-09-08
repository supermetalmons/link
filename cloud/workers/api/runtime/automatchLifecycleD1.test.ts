import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { createSeededRandom } from "@mons/shared/ids";
import {
  emptyAutomatchProfile,
  findOwnedQueuedAutomatches,
  startAutomatch,
  type AutomatchDependencies,
} from "../src/automatch.ts";
import { cancelAutomatch } from "../src/gameplayRoute.ts";
import {
  endRematchSeries,
  ensureParticipantMatch,
  joinInvite,
  proposeRematch,
} from "../src/gameSessionMutations.ts";
import { createAutomatchPersistence } from "../src/automatchPersistence.ts";
import {
  createAutomatchD1Store,
  parseAutomatchPath,
} from "../src/automatchD1.ts";
import { createGameSessionMutationLockStore } from "../src/gameplayCoordinationD1.ts";
import type { FirebaseRtdbClient } from "../src/firebaseRtdb.ts";
import type { GameplayRepository } from "../src/gameplayRepository.ts";
import { settleAutomatchProfileGameProjectionOutbox } from "../src/profileGameProjection.ts";
import type {
  ProfileOwnershipQuery,
  ProfileOwnershipSnapshot,
} from "../src/profileOwnership.ts";

const testEnv = env as Env & { TEST_D1_MIGRATIONS: D1Migration[] };
const db = env.PROFILE_GAMES_DB;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

class LiveFirebase implements FirebaseRtdbClient {
  readonly data: Record<string, unknown> = {};
  readonly writePaths: string[] = [];
  failWrites = false;
  failAfterNextMatch = false;

  read(path: string): unknown {
    let value: unknown = this.data;
    for (const key of path.split("/")) {
      if (!record(value) || !Object.hasOwn(value, key)) return null;
      value = value[key];
    }
    return structuredClone(value ?? null);
  }

  put(path: string, value: unknown): void {
    const parts = path.split("/");
    let parent = this.data;
    for (const key of parts.slice(0, -1)) {
      if (!record(parent[key])) parent[key] = {};
      parent = parent[key] as Record<string, unknown>;
    }
    const key = parts.at(-1)!;
    if (value === null) delete parent[key];
    else parent[key] = structuredClone(value);
  }

  async getPath(
    path: string,
    query?: Parameters<FirebaseRtdbClient["getPath"]>[1],
  ): Promise<unknown> {
    if (parseAutomatchPath(path)) throw new Error("retired-firebase-root-read");
    const value = this.read(path);
    return query?.shallow === true && record(value)
      ? Object.fromEntries(Object.keys(value).map((key) => [key, true]))
      : value;
  }

  async patchRoot(updates: Record<string, unknown>): Promise<void> {
    for (const [path, value] of Object.entries(updates)) {
      if (parseAutomatchPath(path))
        throw new Error("retired-firebase-root-write");
      this.put(path, value);
      this.writePaths.push(path);
    }
  }

  async transactPath(
    path: string,
    updater: (current: unknown) => unknown,
    signal?: AbortSignal,
  ) {
    if (parseAutomatchPath(path))
      throw new Error("retired-firebase-root-transaction");
    for (let attempt = 0; attempt < 25; attempt++) {
      signal?.throwIfAborted();
      if (this.failWrites) throw new Error("firebase-offline");
      const current = this.read(path);
      const decision = updater(current);
      if (!record(decision)) throw new Error("invalid-test-transaction");
      if (decision.commit === false)
        return {
          committed: false,
          decision: String(decision.decision),
          value: current,
        };
      await Promise.resolve();
      if (JSON.stringify(current) !== JSON.stringify(this.read(path))) continue;
      this.put(path, decision.value);
      this.writePaths.push(path);
      if (this.failAfterNextMatch && path.startsWith("players/")) {
        this.failAfterNextMatch = false;
        this.failWrites = true;
        throw new Error("firebase-match-response-lost");
      }
      return {
        committed: true,
        decision: String(decision.decision),
        value: structuredClone(decision.value),
      };
    }
    throw new Error("test-cas-exhausted");
  }
}

function ownership(query: ProfileOwnershipQuery): ProfileOwnershipSnapshot {
  const profileId = (uid: string) =>
    uid === "host-linked" ? "profile-host" : `profile-${uid}`;
  const loginOwnerByUid = new Map(
    query.loginUids.map((uid) => [
      uid,
      { profileId: profileId(uid), revision: 1 },
    ]),
  );
  const profileIds = new Set([
    ...query.profileIds,
    ...[...loginOwnerByUid.values()].map((owner) => owner.profileId),
  ]);
  return {
    loginOwnerByUid,
    canonicalProfileIdByProfileId: new Map(
      query.profileIds.map((id) => [id, id]),
    ),
    loginUidsByProfileId: new Map(
      [...profileIds].map((id) => [
        id,
        id === "profile-host"
          ? ["host", "host-linked"]
          : [id.slice("profile-".length)],
      ]),
    ),
    profileById: new Map(
      [...profileIds].map((id) => [
        id,
        {
          revision: 1,
          profile: {
            ...emptyAutomatchProfile(),
            profileId: id,
            rating: 1500,
            username: id,
          },
        },
      ]),
    ),
  };
}

function client(firebase: LiveFirebase, uid: string, database = db) {
  const persistence = createAutomatchPersistence(database, firebase);
  const repository: GameplayRepository = {
    automatchPersistence: persistence,
    getRtdbPath: persistence.client.getPath,
    patchRtdbRoot: persistence.client.patchRoot,
    transactRtdbPath: persistence.client.transactPath,
    readProfileOwnershipSnapshot: async (query) => ownership(query),
    applyWagerTransferOnce: async () => {
      throw new Error("unexpected-wager-transfer");
    },
    deleteNavigationGame: async () => "missing",
    getNavigationGame: async () => null,
    getMiningMaterials: async () => ({
      dust: 0,
      slime: 0,
      gum: 0,
      metal: 0,
      ice: 0,
    }),
    getMiningSnapshot: async () => null,
  };
  const queued: unknown[] = [];
  const dependencies: AutomatchDependencies = {
    mutationLocks: persistence.decorateLocks(
      createGameSessionMutationLockStore(database),
    ),
    random: createSeededRandom(uid),
    enqueueProfileGameProjection: async (task) => {
      queued.push(task);
    },
    enqueueTelegramProjection: async (task) => {
      queued.push(task);
    },
  };
  return { repository, dependencies, persistence, queued, identity: { uid } };
}

function countReads(database: D1Database, queries: string[]): D1Database {
  return new Proxy(database, {
    get(target, property) {
      if (property === "withSession") {
        return (...args: Parameters<D1Database["withSession"]>) => {
          const session = target.withSession(...args);
          return new Proxy(session, {
            get(current, key) {
              if (key === "prepare") {
                return (query: string) => {
                  queries.push(query);
                  return current.prepare(query);
                };
              }
              const value = Reflect.get(current, key, current);
              return typeof value === "function" ? value.bind(current) : value;
            },
          });
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function start(
  session: ReturnType<typeof client>,
  operationId = crypto.randomUUID(),
) {
  return startAutomatch(
    session.identity,
    { operationId, emojiId: 1, aura: "" },
    session.repository,
    session.dependencies,
  );
}

async function assertSettled() {
  expect(
    await db
      .prepare(
        "SELECT count(*) AS count FROM game_session_transitions WHERE status = 'pending'",
      )
      .first("count"),
  ).toBe(0);
  expect(
    await db
      .prepare(
        "SELECT count(*) AS count FROM game_session_transition_resources",
      )
      .first("count"),
  ).toBe(0);
  expect(
    await db
      .prepare("SELECT count(*) AS count FROM game_session_mutation_locks")
      .first("count"),
  ).toBe(0);
  expect(
    await db
      .prepare("SELECT count(*) AS count FROM automatch_write_admissions")
      .first("count"),
  ).toBe(0);
}

describe("automatch lifecycle through D1 persistence", () => {
  beforeAll(async () => {
    await applyD1Migrations(db, testEnv.TEST_D1_MIGRATIONS);
  });

  beforeEach(async () => {
    await db.batch([
      db.prepare(
        "UPDATE automatch_runtime_control SET backend = 'd1', state = 'active' WHERE singleton = 1",
      ),
      db.prepare("DELETE FROM game_session_transition_resources"),
      db.prepare("DELETE FROM game_session_transitions"),
      db.prepare("DELETE FROM game_session_mutation_locks"),
      db.prepare("DELETE FROM automatch_write_admissions"),
      db.prepare("DELETE FROM automatch_entries"),
      db.prepare("DELETE FROM automatch_telegram_sources"),
      db.prepare("DELETE FROM automatch_telegram_projection_outbox"),
      db.prepare("DELETE FROM game_session_projection_outbox"),
      db.prepare("DELETE FROM game_session_mutation_receipts"),
    ]);
  });

  it("starts, replays, matches and preserves the host's live record", async () => {
    const firebase = new LiveFirebase();
    const host = client(firebase, "host");
    const hostOperation = crypto.randomUUID();
    const pending = await start(host, hostOperation);
    expect(pending).toMatchObject({ ok: true, mode: "pending" });
    if (!pending.ok) throw new Error("expected-pending-invite");
    const inviteId = pending.inviteId;
    const hostMatchPath = `players/host/matches/${inviteId}`;
    const hostMatch = firebase.read(hostMatchPath);
    expect(hostMatch).toMatchObject({ sessionCreation: expect.any(String) });
    firebase.put(hostMatchPath, {
      ...(record(hostMatch) ? hostMatch : {}),
      flatMovesString: "preserved-live-move",
    });
    const writes = firebase.writePaths.length;
    expect(await start(client(firebase, "host"), hostOperation)).toEqual(
      pending,
    );
    expect(firebase.writePaths.length).toBe(writes);
    const guest = client(firebase, "guest");
    const guestOperation = crypto.randomUUID();
    expect(await start(guest, guestOperation)).toEqual({
      ok: true,
      inviteId,
      mode: "matched",
      matchedImmediately: true,
    });
    expect(firebase.read(`invites/${inviteId}`)).toMatchObject({
      hostId: "host",
      guestId: "guest",
      sessionTransition: { sequence: 2 },
      automatchOperationIds: { host: hostOperation, guest: guestOperation },
    });
    expect(firebase.read(hostMatchPath)).toMatchObject({
      flatMovesString: "preserved-live-move",
    });
    expect(firebase.read(`players/guest/matches/${inviteId}`)).toMatchObject({
      sessionCreation: expect.any(String),
    });
    expect(
      await createAutomatchD1Store(db).getPath(`automatch/${inviteId}`),
    ).toBeNull();
    expect(
      await createAutomatchD1Store(db).getPath(
        `telegramAutomatches/${inviteId}`,
      ),
    ).toMatchObject({ lifecycle: "matched", generation: 2 });
    expect(guest.queued).toHaveLength(2);
    await assertSettled();
  });

  it("manually joins a pending automatch and proposes a rematch through the same journal", async () => {
    const firebase = new LiveFirebase();
    const pending = await start(client(firebase, "host"));
    if (!pending.ok) throw new Error("expected-pending-invite");
    const guest = client(firebase, "guest");
    const joinRequest = {
      inviteId: pending.inviteId,
      operationId: crypto.randomUUID(),
      emojiId: 2,
      aura: "",
    };
    const joined = await joinInvite(
      guest.identity,
      joinRequest,
      guest.repository,
      guest.dependencies,
    );
    expect(joined).toMatchObject({ ok: true, joined: true, guestId: "guest" });
    expect(
      await joinInvite(
        guest.identity,
        joinRequest,
        guest.repository,
        guest.dependencies,
      ),
    ).toEqual(joined);
    const rematch = await proposeRematch(
      guest.identity,
      { ...joinRequest, operationId: crypto.randomUUID() },
      guest.repository,
      guest.dependencies,
    );
    expect(rematch).toMatchObject({
      ok: true,
      matchId: `${pending.inviteId}1`,
      rematches: "1",
    });
    expect(
      firebase.read(`players/guest/matches/${pending.inviteId}1`),
    ).toMatchObject({ sessionCreation: expect.any(String) });
    expect(
      await createAutomatchD1Store(db).getPath(`automatch/${pending.inviteId}`),
    ).toBeNull();
    expect(
      await createAutomatchD1Store(db).getPath(
        `profileGameProjectionOutbox/automatch/${pending.inviteId}`,
      ),
    ).toMatchObject({
      requestId: expect.any(String),
      historicalMatches: { [pending.inviteId]: { source: "transition" } },
    });
    await assertSettled();
  });

  it.each([false, true])(
    "reuses an ensured rematch without resetting it (legacy: %s)",
    async (legacy) => {
      const firebase = new LiveFirebase();
      const host = client(firebase, "host");
      const guest = client(firebase, "guest");
      const pending = await start(host);
      if (!pending.ok) throw new Error("expected-pending-invite");
      await start(guest);
      const request = () => ({
        inviteId: pending.inviteId,
        operationId: crypto.randomUUID(),
        emojiId: 1,
        aura: "",
      });
      const proposed = await proposeRematch(
        host.identity,
        request(),
        host.repository,
        host.dependencies,
      );
      await ensureParticipantMatch(
        guest.identity,
        { ...request(), matchId: proposed.matchId },
        guest.repository,
        guest.dependencies,
      );
      const path = `players/guest/matches/${proposed.matchId}`;
      const stored = firebase.read(path);
      if (!record(stored)) throw new Error("expected-ensured-match");
      if (legacy) delete stored.sessionCreation;
      stored.flatMovesString = "preserved-rematch-move";
      stored.timer = "2;123456";
      firebase.put(path, stored);
      const approvalRequest = request();
      const approved = await proposeRematch(
        guest.identity,
        approvalRequest,
        guest.repository,
        guest.dependencies,
      );
      expect(approved.rematches).toBe("1");
      expect(approved.match).toMatchObject({
        flatMovesString: stored.flatMovesString,
        timer: stored.timer,
      });
      expect(firebase.read(path)).toEqual(stored);
      expect(
        await proposeRematch(
          guest.identity,
          approvalRequest,
          guest.repository,
          guest.dependencies,
        ),
      ).toEqual(approved);
      expect(await host.persistence.sweep()).toEqual({
        recovered: 0,
        failed: 0,
      });
      await endRematchSeries(
        host.identity,
        { inviteId: pending.inviteId, operationId: crypto.randomUUID() },
        host.repository,
        host.dependencies,
      );
      await assertSettled();
    },
  );

  it("rejects an invalid existing rematch before reserving the invite", async () => {
    const firebase = new LiveFirebase();
    const host = client(firebase, "host");
    const guest = client(firebase, "guest");
    const pending = await start(host);
    if (!pending.ok) throw new Error("expected-pending-invite");
    await start(guest);
    const request = {
      inviteId: pending.inviteId,
      operationId: crypto.randomUUID(),
      emojiId: 1,
      aura: "",
    };
    const proposed = await proposeRematch(
      host.identity,
      request,
      host.repository,
      host.dependencies,
    );
    firebase.put(`players/guest/matches/${proposed.matchId}`, {
      fen: "",
      color: "white",
    });
    await expect(
      proposeRematch(
        guest.identity,
        { ...request, operationId: crypto.randomUUID() },
        guest.repository,
        guest.dependencies,
      ),
    ).rejects.toMatchObject({ status: 409, message: "rematch-match-invalid" });
    await endRematchSeries(
      host.identity,
      { inviteId: pending.inviteId, operationId: crypto.randomUUID() },
      host.repository,
      host.dependencies,
    );
    await assertSettled();
  });

  it("serializes concurrent linked-login starts into one owned pending invite and cancels it", async () => {
    const firebase = new LiveFirebase();
    const outcomes = await Promise.all([
      start(client(firebase, "host")),
      start(client(firebase, "host-linked")),
    ]);
    expect(outcomes[0]).toMatchObject({ ok: true, mode: "pending" });
    expect(outcomes[1]).toMatchObject({ ok: true, mode: "pending" });
    if (!outcomes[0].ok || !outcomes[1].ok)
      throw new Error("expected-owned-pending");
    expect(outcomes[0].inviteId).toBe(outcomes[1].inviteId);
    expect(await createAutomatchD1Store(db).list("automatch")).toHaveLength(1);
    const linked = client(firebase, "host-linked");
    expect(
      await cancelAutomatch(
        linked.identity,
        linked.repository,
        linked.dependencies,
      ),
    ).toEqual({ ok: true });
    expect(await createAutomatchD1Store(db).list("automatch")).toHaveLength(0);
    expect(firebase.read(`invites/${outcomes[0].inviteId}`)).toMatchObject({
      automatchStateHint: "canceled",
    });
    await assertSettled();
  });

  it("cancels once when a Queue consumer settles the outbox during preparation", async () => {
    const firebase = new LiveFirebase();
    const host = client(firebase, "host");
    const pending = await start(host);
    if (!pending.ok) throw new Error("expected-pending-invite");
    const store = createAutomatchD1Store(db);
    const outbox = await store.getPath(
      `profileGameProjectionOutbox/automatch/${pending.inviteId}`,
    );
    if (!record(outbox)) throw new Error("expected-projection-outbox");
    let preparing = false;
    let preparations = 0;
    const racingDb = new Proxy(db, {
      get(target, property) {
        if (property === "prepare") {
          return (query: string) => {
            if (query.startsWith("INSERT INTO game_session_transitions "))
              preparing = true;
            return target.prepare(query);
          };
        }
        if (property === "batch") {
          return async (statements: D1PreparedStatement[]) => {
            if (preparing) {
              preparing = false;
              if (++preparations === 1) {
                expect(
                  await settleAutomatchProfileGameProjectionOutbox(
                    {
                      kind: "automatch-profile-game-projection",
                      inviteId: pending.inviteId,
                      requestId: String(outbox.requestId),
                    },
                    host.repository,
                  ),
                ).toBe(true);
              }
            }
            return target.batch(statements);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const writes = firebase.writePaths.length;
    const canceler = client(firebase, "host", racingDb);
    expect(
      await cancelAutomatch(
        canceler.identity,
        canceler.repository,
        canceler.dependencies,
      ),
    ).toEqual({ ok: true });
    expect(preparations).toBe(2);
    expect(firebase.writePaths.slice(writes)).toEqual([
      `invites/${pending.inviteId}`,
    ]);
    expect(firebase.read(`invites/${pending.inviteId}`)).toMatchObject({
      automatchStateHint: "canceled",
      sessionTransition: { sequence: 2 },
    });
    expect(await store.getPath(`automatch/${pending.inviteId}`)).toBeNull();
    expect(
      await store.getPath(`telegramAutomatches/${pending.inviteId}`),
    ).toMatchObject({ lifecycle: "canceled", generation: 2 });
    expect(canceler.queued).toHaveLength(2);
    await assertSettled();
  });

  it("recovers an interrupted start before cancellation so the queue cannot reappear", async () => {
    const firebase = new LiveFirebase();
    firebase.failAfterNextMatch = true;
    const host = client(firebase, "host");
    const operationId = crypto.randomUUID();
    await expect(start(host, operationId)).rejects.toThrow();
    expect(
      await db
        .prepare(
          "SELECT count(*) AS count FROM game_session_transitions WHERE status = 'pending'",
        )
        .first("count"),
    ).toBe(1);
    expect(await createAutomatchD1Store(db).list("automatch")).toHaveLength(0);
    firebase.failWrites = false;
    const canceler = client(firebase, "host-linked");
    expect(
      await cancelAutomatch(
        canceler.identity,
        canceler.repository,
        canceler.dependencies,
      ),
    ).toEqual({ ok: true });
    const receipt = await createAutomatchD1Store(db).getPath(
      `gameplayMutationReceipts/${operationId}`,
    );
    expect(receipt).toMatchObject({
      requesterUid: "host",
      response: { mode: "pending" },
    });
    const inviteId = record(receipt) ? String(receipt.inviteId) : "";
    expect(firebase.read(`invites/${inviteId}`)).toMatchObject({
      automatchStateHint: "canceled",
    });
    expect(await createAutomatchD1Store(db).list("automatch")).toHaveLength(0);
    expect(
      firebase.writePaths.filter((path) => path.startsWith("players/")),
    ).toHaveLength(1);
    await assertSettled();
  });

  it("finds two Firebase-ordered entries per login for 512 logins with two reads", async () => {
    const uids = Array.from(
      { length: 512 },
      (_, index) => `lookup-${String(index).padStart(3, "0")}`,
    );
    const entries = uids.flatMap((uid, index) => [
      { key: index === 0 ? "2" : `auto_${uid}_a`, uid, timestamp: 20 },
      { key: index === 0 ? "10" : `auto_${uid}_b`, uid, timestamp: 30 },
      { key: `auto_${uid}_z`, uid, timestamp: 10_000 },
    ]);
    await db
      .prepare(
        `INSERT INTO automatch_entries (record_key, payload_json, revision, updated_at_ms)
      SELECT json_extract(value, '$.key'),
        json_object('uid', json_extract(value, '$.uid'), 'timestamp', json_extract(value, '$.timestamp')),
        1, 1 FROM json_each(?)`,
      )
      .bind(JSON.stringify(entries))
      .run();
    const queries: string[] = [];
    const session = client(
      new LiveFirebase(),
      "unused",
      countReads(db, queries),
    );
    const found = await findOwnedQueuedAutomatches(
      [...uids, uids[0]],
      session.repository,
    );
    expect(queries).toHaveLength(2);
    expect(queries[0]).toContain("automatch_runtime_control");
    expect(queries[1]).toContain("INDEXED BY idx_automatch_entries_uid");
    expect(found).toHaveLength(1024);
    expect(found.every((entry) => entry.data.timestamp !== 10_000)).toBe(true);
    expect(
      found
        .filter((entry) => entry.data.uid === uids[0])
        .map((entry) => entry.inviteId),
    ).toEqual(["10", "2"]);
    expect(
      found.slice(0, 512).every((entry) => entry.data.timestamp === 30),
    ).toBe(true);
    expect(found.slice(512).every((entry) => entry.data.timestamp === 20)).toBe(
      true,
    );
    const store = createAutomatchD1Store(db);
    expect(
      (await store.listEntriesByLogins([uids[0]], 1)).map((entry) => entry.key),
    ).toEqual(["2"]);
    await expect(
      store.listEntriesByLogins([...uids, "too-many"]),
    ).rejects.toThrow("invalid-automatch-login-query");
  });
});
