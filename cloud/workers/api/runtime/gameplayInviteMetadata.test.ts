import { env } from "cloudflare:workers";
import type { D1Migration } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createGameplayRepository } from "../src/gameplayRepository.ts";
import { createGameSessionMutationLockStore } from "../src/gameplayCoordinationD1.ts";
import { normalizeInviteMetadata } from "../src/inviteMetadata.ts";
import type { MatchStatePort } from "../src/repositoryContracts.ts";
import { composeInviteWagerSource } from "../src/inviteWagerSource.ts";
import { applyRetiredProfileMigrations } from "./profileTestMigrations.ts";
import { applyStrictMatchStateTestMigrations } from "./strictMatchStateTestFixture.ts";

const testEnv = env as Env & {
  TEST_D1_MIGRATIONS: D1Migration[];
  TEST_PROFILE_D1_MIGRATIONS: D1Migration[];
};
const db = env.PROFILE_GAMES_DB;
const inviteId = "metadata-invite";
const source = {
  hostId: "host-login",
  guestId: "guest-login",
  hostColor: "white",
  customMetadata: { retained: true },
};
const unexpectedRead = async (): Promise<never> => {
  throw new Error("unexpected-raw-source-read");
};
const unexpectedWrite = async (): Promise<never> => {
  throw new Error("unexpected-raw-source-write");
};
const raw: MatchStatePort = {
  readMatchRecord: unexpectedRead,
  readMatchRecords: unexpectedRead,
  readMatchPair: unexpectedRead,
  readMatchPairs: unexpectedRead,
  createMatchRecords: unexpectedWrite,
  applyMatchEventEffects: unexpectedWrite,
};

function repository(database = db, profileDb?: D1Database) {
  return createGameplayRepository(
    {
      ...env,
      INVITE_REACTIONS: new Proxy(env.INVITE_REACTIONS, {
        get() {
          throw new Error("unexpected-invite-durable-object-access");
        },
      }),
      PROFILE_DB:
        profileDb ??
        new Proxy(env.PROFILE_DB, {
          get() {
            throw new Error("unexpected-profile-database-access");
          },
        }),
    },
    { d1: database, stateClient: raw },
  );
}

async function insertSource(
  value: Record<string, unknown> = source,
  targetInviteId = inviteId,
) {
  await db
    .prepare(
      `INSERT INTO invite_sources (invite_id, source_json, revision, updated_at_ms)
       VALUES (?, ?, 1, 1)`,
    )
    .bind(targetInviteId, JSON.stringify(value))
    .run();
}

async function reserveInvite() {
  await db.batch([
    db
      .prepare(
        `INSERT INTO game_session_transitions
         (transition_id, invite_id, payload_json, status, created_at_ms, updated_at_ms)
         VALUES ('metadata-transition', ?, '{}', 'pending', 1, 1)`,
      )
      .bind(inviteId),
    db
      .prepare(
        `INSERT INTO game_session_transition_resources (resource_key, transition_id)
         VALUES (?, 'metadata-transition')`,
      )
      .bind(inviteId),
  ]);
}

function afterSourceRead(after: () => Promise<void> | void): D1Database {
  return new Proxy(db, {
    get(target, property) {
      if (property === "withSession")
        return (constraint?: D1SessionConstraint | D1SessionBookmark) =>
          new Proxy(target.withSession(constraint), {
            get(session, key) {
              if (key === "batch")
                return async (statements: D1PreparedStatement[]) => {
                  const results = await session.batch(statements);
                  await after();
                  return results;
                };
              const value = Reflect.get(session, key, session);
              return typeof value === "function" ? value.bind(session) : value;
            },
          });
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function observeBulkReads(after?: () => Promise<void> | void) {
  const constraints: Array<
    D1SessionConstraint | D1SessionBookmark | undefined
  > = [];
  const queries: Array<{ sql: string; bindings: unknown[] }> = [];
  const batchSizes: number[] = [];
  const database = new Proxy(db, {
    get(target, property) {
      if (property !== "withSession")
        throw new Error(`unexpected-database-access:${String(property)}`);
      return (constraint?: D1SessionConstraint | D1SessionBookmark) => {
        constraints.push(constraint);
        return new Proxy(target.withSession(constraint), {
          get(session, key) {
            if (key === "prepare")
              return (sql: string) => {
                expect(sql.trim()).toMatch(/^(SELECT|WITH)\b/i);
                const query = { sql, bindings: [] as unknown[] };
                queries.push(query);
                return new Proxy(session.prepare(sql), {
                  get(statement, method) {
                    if (method === "bind")
                      return (...bindings: unknown[]) => {
                        query.bindings = bindings;
                        return statement.bind(...bindings);
                      };
                    const value = Reflect.get(statement, method, statement);
                    return typeof value === "function"
                      ? value.bind(statement)
                      : value;
                  },
                });
              };
            if (key === "batch")
              return async (statements: D1PreparedStatement[]) => {
                batchSizes.push(statements.length);
                const results = await session.batch(statements);
                await after?.();
                return results;
              };
            throw new Error(`unexpected-session-access:${String(key)}`);
          },
        });
      };
    },
  });
  return { database, constraints, queries, batchSizes };
}

describe("gameplay invite metadata reads", () => {
  beforeAll(async () => {
    await applyStrictMatchStateTestMigrations(db, testEnv.TEST_D1_MIGRATIONS);
    await applyRetiredProfileMigrations(
      env.PROFILE_DB,
      testEnv.TEST_PROFILE_D1_MIGRATIONS,
      "a".repeat(64),
    );
  });

  beforeEach(async () => {
    await db.batch([
      db.prepare("DELETE FROM game_session_transition_resources"),
      db.prepare("DELETE FROM game_session_transitions"),
      db.prepare("DELETE FROM game_session_mutation_locks"),
      db.prepare("DELETE FROM automatch_entries"),
      db.prepare("DELETE FROM invite_sources"),
      db.prepare("DELETE FROM automatch_runtime_control"),
      db.prepare(
        `INSERT INTO automatch_runtime_control
         (singleton, backend, state, epoch, freeze_generation)
         VALUES (1, 'd1', 'active', 1, 0)`,
      ),
      db.prepare("DELETE FROM invite_source_control"),
      db.prepare(
        `INSERT INTO invite_source_control
         (singleton, backend, state, epoch, freeze_generation, verified_at_ms, activated_at_ms)
         VALUES (1, 'd1', 'active', 1, 0, 1, 1)`,
      ),
    ]);
  });

  it("reads canonical source fields without accessing the profile database", async () => {
    await insertSource();
    const gameplay = repository();
    const value = await gameplay.readInviteMetadata(inviteId);
    expect(value).toEqual(source);
    expect(Object.hasOwn(value!, "password")).toBe(false);
    expect(Object.hasOwn(value!, "wagers")).toBe(false);
    expect(Object.hasOwn(value!, "matchesWagerResolutions")).toBe(false);
    expect(normalizeInviteMetadata(inviteId, value)).toMatchObject({
      status: "ok",
      passwordProtected: false,
    });
    await expect(
      gameplay.wagers.readInviteWagerState(inviteId),
    ).rejects.toThrow("unexpected-profile-database-access");
  });

  it("returns null for a missing invite without accessing wagers", async () => {
    expect(await repository().readInviteMetadata(inviteId)).toBeNull();
  });

  it.each([
    ["legacy", "notifyMetadataChanged"],
    ["bootstrap", "notifySessionCommitted"],
  ])("notifies a committed %s session once", async (mode, method) => {
    const notifications: string[][] = [];
    const workerEnv = new Proxy(env, {
      get(target, property, receiver) {
        if (property === "AUTOMATCH_DELIVERY_MODE") return mode;
        if (property === "INVITE_REACTIONS") {
          return {
            getByName: (roomId: string) => {
              const notify = (name: string) => async (incoming: string) => {
                notifications.push([name, roomId, incoming]);
              };
              return {
                notifyMetadataChanged: notify("notifyMetadataChanged"),
                notifyWagersChanged: notify("notifyWagersChanged"),
                notifyMatchesChanged: notify("notifyMatchesChanged"),
                notifySessionCommitted: notify("notifySessionCommitted"),
              };
            },
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const gameplay = createGameplayRepository(workerEnv, {
      d1: db,
      stateClient: raw,
    });
    const locks = gameplay.automatchPersistence.decorateLocks(
      createGameSessionMutationLockStore(db),
    );
    const lock = { lockId: inviteId, operationId: "notification-operation" };
    await locks.acquire(lock, "notification-owner", Date.now());
    try {
      await gameplay.commitSessionChanges([
        { kind: "invite-merge", inviteId, value: source },
        {
          kind: "automatch-entry",
          inviteId,
          value: { uid: source.hostId, timestamp: Date.now() },
        },
      ]);
      expect(notifications).toEqual([]);
    } finally {
      await locks.release(lock, "notification-owner");
    }
    expect(await gameplay.readInviteMetadata(inviteId)).toEqual(source);
    expect(notifications).toEqual([[method, inviteId, inviteId]]);
  });

  it("preserves explicit password presence and malformed field values", async () => {
    const value = {
      hostId: 7,
      guestId: ["guest-login"],
      hostColor: { invalid: true },
      hostRematches: false,
      password: null,
      customMetadata: { retained: true },
    };
    await insertSource(value);
    expect(await repository().readInviteMetadata(inviteId)).toEqual(value);
  });

  it("keeps complete invite reads composed with canonical wager state", async () => {
    await insertSource();
    const wager = {
      proposals: { "host-login": { material: "dust", count: 2 } },
    };
    await env.PROFILE_DB.prepare(
      `INSERT INTO invite_wager_states
       (invite_id, match_id, wager_json, resolution_marker, revision, updated_at_ms)
       VALUES (?, ?, ?, 1, 1, 1)`,
    )
      .bind(inviteId, inviteId, JSON.stringify(wager))
      .run();
    const gameplay = repository(db, env.PROFILE_DB);
    expect(await gameplay.readInviteMetadata(inviteId)).toEqual(source);
    expect(
      composeInviteWagerSource(
        await gameplay.readInviteMetadata(inviteId),
        await gameplay.wagers.readInviteWagerState(inviteId),
      ),
    ).toEqual({
      ...source,
      wagers: { [inviteId]: wager },
      matchesWagerResolutions: { [inviteId]: true },
    });
  });

  it.each(["automatch_runtime_control", "invite_source_control"])(
    "allows reads while %s is frozen",
    async (table) => {
      await insertSource();
      await db.prepare(`UPDATE ${table} SET state = 'frozen'`).run();
      expect(await repository().readInviteMetadata(inviteId)).toEqual(source);
    },
  );

  it.each(["automatch", "invite"])(
    "rejects the retired %s backend without falling back",
    async (backend) => {
      await insertSource();
      if (backend === "automatch") {
        await db.batch([
          db.prepare("DELETE FROM automatch_runtime_control"),
          db.prepare(
            `INSERT INTO automatch_runtime_control
             (singleton, backend, state, epoch, freeze_generation)
             VALUES (1, 'rtdb', 'active', 1, 0)`,
          ),
        ]);
      } else {
        await db
          .prepare(
            `UPDATE invite_source_control SET backend = 'rtdb', epoch = 0,
             verified_at_ms = NULL, activated_at_ms = NULL WHERE singleton = 1`,
          )
          .run();
      }
      await expect(repository().readInviteMetadata(inviteId)).rejects.toThrow(
        "backend-retired",
      );
    },
  );

  it.each(["automatch_runtime_control", "invite_source_control"])(
    "rejects missing %s",
    async (table) => {
      await db.prepare(`DELETE FROM ${table}`).run();
      await expect(repository().readInviteMetadata(inviteId)).rejects.toThrow(
        "control-unavailable",
      );
    },
  );

  it("rejects a pending transition in the same atomic snapshot as the source", async () => {
    await insertSource();
    await reserveInvite();
    let reads = 0;
    const gameplay = repository(
      afterSourceRead(() => {
        reads++;
      }),
    );
    await expect(gameplay.readInviteMetadata(inviteId)).rejects.toThrow(
      "resource-pending",
    );
    expect(reads).toBe(1);
  });

  it("returns the committed snapshot before a later transition and fences the next read", async () => {
    await insertSource();
    const gameplay = repository(afterSourceRead(reserveInvite));
    expect(await gameplay.readInviteMetadata(inviteId)).toEqual(source);
    await expect(repository().readInviteMetadata(inviteId)).rejects.toThrow(
      "resource-pending",
    );
  });

  it.each(["before", "during"])(
    "honors cancellation %s the read",
    async (when) => {
      await insertSource();
      const controller = new AbortController();
      const reason = new Error("metadata-read-cancelled");
      let reads = 0;
      const observed = afterSourceRead(() => {
        reads++;
        controller.abort(reason);
      });
      if (when === "before") controller.abort(reason);
      await expect(
        repository(observed).readInviteMetadata(inviteId, controller.signal),
      ).rejects.toBe(reason);
      expect(reads).toBe(when === "before" ? 0 : 1);
    },
  );

  describe("bulk reads", () => {
    it("uses one read-only snapshot for ordered, missing and independently decoded duplicate results", async () => {
      await insertSource();
      const secondId = "metadata-second";
      const second = { ...source, hostId: "second-host", password: null };
      await insertSource(second, secondId);
      const observed = observeBulkReads();
      const values = await repository(observed.database).readInviteMetadataMany(
        [secondId, "metadata-missing", inviteId, secondId],
      );
      expect(values).toEqual([second, null, source, second]);
      expect(values[0]).not.toBe(values[3]);
      expect(values[0]!.customMetadata).not.toBe(values[3]!.customMetadata);
      (values[0]!.customMetadata as { retained: boolean }).retained = false;
      expect(values[3]!.customMetadata).toEqual({ retained: true });
      expect(observed.constraints).toEqual(["first-primary"]);
      expect(observed.batchSizes).toEqual([3]);
      expect(observed.queries).toHaveLength(3);
      expect(JSON.parse(String(observed.queries[2].bindings[0]))).toEqual([
        secondId,
        "metadata-missing",
        inviteId,
      ]);
    });

    it("returns an empty result without opening a database session", async () => {
      const observed = observeBulkReads();
      expect(
        await repository(observed.database).readInviteMetadataMany([]),
      ).toEqual([]);
      expect(observed.constraints).toEqual([]);
      expect(observed.queries).toEqual([]);
      expect(observed.batchSizes).toEqual([]);
    });

    it("accepts exactly 32 requested IDs in one snapshot", async () => {
      await insertSource();
      const ids = Array.from({ length: 32 }, (_, index) =>
        index === 31 ? inviteId : `metadata-missing-${index}`,
      );
      const observed = observeBulkReads();
      expect(
        await repository(observed.database).readInviteMetadataMany(ids),
      ).toEqual([...Array.from({ length: 31 }, () => null), source]);
      expect(observed.constraints).toEqual(["first-primary"]);
      expect(observed.batchSizes).toEqual([3]);
      expect(observed.queries).toHaveLength(3);
    });

    it.each([
      [
        "oversized unique input",
        Array.from({ length: 33 }, (_, i) => `id-${i}`),
      ],
      ["oversized duplicate input", Array.from({ length: 33 }, () => inviteId)],
      ["empty key", [inviteId, ""]],
      ["invalid key", [inviteId, "invalid/key"]],
      ["non-string key", [inviteId, 7]],
      ["non-array input", inviteId],
    ])("rejects %s before database access", async (_, ids) => {
      const observed = observeBulkReads();
      await expect(
        repository(observed.database).readInviteMetadataMany(
          ids as unknown as readonly string[],
        ),
      ).rejects.toBeInstanceOf(TypeError);
      expect(observed.constraints).toEqual([]);
      expect(observed.queries).toEqual([]);
      expect(observed.batchSizes).toEqual([]);
    });

    it.each(["automatch_runtime_control", "invite_source_control"])(
      "allows reads while %s is frozen",
      async (table) => {
        await insertSource();
        await db.prepare(`UPDATE ${table} SET state = 'frozen'`).run();
        expect(await repository().readInviteMetadataMany([inviteId])).toEqual([
          source,
        ]);
      },
    );

    it.each(["automatch", "invite"])(
      "rejects the retired %s backend without fallback",
      async (backend) => {
        await insertSource();
        if (backend === "automatch") {
          await db.batch([
            db.prepare("DELETE FROM automatch_runtime_control"),
            db.prepare(
              `INSERT INTO automatch_runtime_control
               (singleton, backend, state, epoch, freeze_generation)
               VALUES (1, 'rtdb', 'active', 1, 0)`,
            ),
          ]);
        } else {
          await db
            .prepare(
              `UPDATE invite_source_control SET backend = 'rtdb', epoch = 0,
               verified_at_ms = NULL, activated_at_ms = NULL`,
            )
            .run();
        }
        const observed = observeBulkReads();
        await expect(
          repository(observed.database).readInviteMetadataMany([inviteId]),
        ).rejects.toThrow("backend-retired");
        expect(observed.constraints).toEqual(["first-primary"]);
        expect(observed.batchSizes).toEqual([3]);
        expect(observed.queries).toHaveLength(3);
      },
    );

    it.each(["automatch_runtime_control", "invite_source_control"])(
      "rejects missing %s",
      async (table) => {
        await db.prepare(`DELETE FROM ${table}`).run();
        await expect(
          repository().readInviteMetadataMany([inviteId]),
        ).rejects.toThrow("control-unavailable");
      },
    );

    it.each([
      ["automatch_runtime_control", "epoch = 1.5"],
      ["invite_source_control", "verified_at_ms = NULL"],
    ])("rejects malformed %s", async (table, assignment) => {
      await db.prepare(`UPDATE ${table} SET ${assignment}`).run();
      await expect(
        repository().readInviteMetadataMany([inviteId]),
      ).rejects.toThrow("control-unavailable");
    });

    it.each([
      ["retired fields", { ...source, wagers: {} }],
      ["invalid source keys", { ...source, "invalid/key": true }],
    ])("rejects corrupt source with %s", async (_, value) => {
      await insertSource(value);
      await expect(
        repository().readInviteMetadataMany(["metadata-missing", inviteId]),
      ).rejects.toThrow("invite-source-corrupt");
    });

    it.each(["pending", "completed"])(
      "leaves retained %s transition resources untouched and rejects before decoding that source",
      async (status) => {
        await insertSource({ ...source, wagers: {} });
        await reserveInvite();
        await db
          .prepare("UPDATE game_session_transitions SET status = ?")
          .bind(status)
          .run();
        const before = await db
          .prepare("SELECT * FROM game_session_transitions")
          .all();
        const observed = observeBulkReads();
        await expect(
          repository(observed.database).readInviteMetadataMany([
            "metadata-missing",
            inviteId,
          ]),
        ).rejects.toThrow("resource-pending");
        expect(observed.constraints).toEqual(["first-primary"]);
        expect(observed.batchSizes).toEqual([3]);
        expect(observed.queries).toHaveLength(3);
        expect(
          (await db.prepare("SELECT * FROM game_session_transitions").all())
            .results,
        ).toEqual(before.results);
        expect(
          await db
            .prepare("SELECT * FROM game_session_transition_resources")
            .all(),
        ).toMatchObject({
          results: [
            { resource_key: inviteId, transition_id: "metadata-transition" },
          ],
        });
      },
    );

    it.each(["before", "during"])(
      "honors cancellation %s the batch",
      async (when) => {
        await insertSource();
        const controller = new AbortController();
        const reason = new Error("bulk-metadata-read-cancelled");
        const observed = observeBulkReads(() => controller.abort(reason));
        if (when === "before") controller.abort(reason);
        await expect(
          repository(observed.database).readInviteMetadataMany(
            [inviteId],
            controller.signal,
          ),
        ).rejects.toBe(reason);
        expect(observed.constraints).toEqual(
          when === "before" ? [] : ["first-primary"],
        );
        expect(observed.batchSizes).toEqual(when === "before" ? [] : [3]);
      },
    );

    it("reads a fresh snapshot on subsequent calls without caching the first value", async () => {
      await insertSource();
      const observed = observeBulkReads();
      const gameplay = repository(observed.database);
      expect(await gameplay.readInviteMetadataMany([inviteId])).toEqual([
        source,
      ]);
      const changed = { ...source, guestId: "updated-guest" };
      await db
        .prepare(
          "UPDATE invite_sources SET source_json = ?, revision = revision + 1 WHERE invite_id = ?",
        )
        .bind(JSON.stringify(changed), inviteId)
        .run();
      expect(await gameplay.readInviteMetadataMany([inviteId])).toEqual([
        changed,
      ]);
      expect(observed.constraints).toEqual(["first-primary", "first-primary"]);
      expect(observed.batchSizes).toEqual([3, 3]);
    });

    it("returns its committed snapshot before a later transition and fences the next call", async () => {
      await insertSource();
      let batches = 0;
      const observed = observeBulkReads(async () => {
        if (++batches === 1) await reserveInvite();
      });
      const gameplay = repository(observed.database);
      expect(await gameplay.readInviteMetadataMany([inviteId])).toEqual([
        source,
      ]);
      await expect(gameplay.readInviteMetadataMany([inviteId])).rejects.toThrow(
        "resource-pending",
      );
      expect(observed.constraints).toEqual(["first-primary", "first-primary"]);
      expect(observed.batchSizes).toEqual([3, 3]);
    });
  });
});
