import { env } from "cloudflare:workers";
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createInviteSourceReader } from "../src/inviteSource.ts";
import { applyRetiredProfileMigrations } from "./profileTestMigrations.ts";

const testEnv = env as Env & {
  TEST_D1_MIGRATIONS: D1Migration[];
  TEST_PROFILE_D1_MIGRATIONS: D1Migration[];
};
const db = env.PROFILE_GAMES_DB;
let inviteId: string;
const source = {
  hostId: "host-login",
  guestId: "guest-login",
  hostColor: "white",
  password: "private",
  custom: { future: [1, null, false] },
};

type ReadInterceptor = (
  query: string,
  execute: () => Promise<unknown>,
) => Promise<unknown>;

type ReadExecution = { kind: "batch" | "single"; queries: string[] };
type ReadSession = { primary: boolean; executed: boolean };

function readOnlyDatabase(
  database: D1Database,
  intercept: ReadInterceptor = (_query, execute) => execute(),
  executions: ReadExecution[] = [],
): D1Database {
  const statements = new WeakMap<
    D1PreparedStatement,
    { statement: D1PreparedStatement; query: string; session: ReadSession }
  >();
  const recordExecution = (
    session: ReadSession,
    kind: ReadExecution["kind"],
    queries: string[],
  ) => {
    expect(session.primary).toBe(true);
    expect(session.executed).toBe(false);
    session.executed = true;
    executions.push({ kind, queries });
  };
  const wrapStatement = (
    statement: D1PreparedStatement,
    query: string,
    session: ReadSession,
  ): D1PreparedStatement => {
    const wrapped = new Proxy(statement, {
      get(target, property) {
        if (property === "bind")
          return (...values: unknown[]) =>
            wrapStatement(target.bind(...values), query, session);
        if (property === "first" || property === "all")
          return (...args: unknown[]) => {
            recordExecution(session, "single", [query]);
            return intercept(query, () =>
              Reflect.apply(
                Reflect.get(target, property, target),
                target,
                args,
              ),
            );
          };
        throw new Error(
          `unexpected-d1-statement-operation:${String(property)}`,
        );
      },
    });
    statements.set(wrapped, { statement, query, session });
    return wrapped;
  };
  const wrapDatabase = <T extends D1Database | D1DatabaseSession>(
    target: T,
    session: ReadSession = { primary: false, executed: false },
  ): T =>
    new Proxy(target, {
      get(target, property) {
        if (property === "withSession")
          return (constraint: D1SessionConstraint | D1SessionBookmark) => {
            expect(constraint).toBe("first-primary");
            return wrapDatabase(database.withSession(constraint), {
              primary: true,
              executed: false,
            });
          };
        if (property === "prepare")
          return (query: string) => {
            expect(query.trimStart().startsWith("SELECT ")).toBe(true);
            return wrapStatement(target.prepare(query), query, session);
          };
        if (property === "batch")
          return async (batch: D1PreparedStatement[]) => {
            const entries = batch.map((wrapped) => {
              const entry = statements.get(wrapped);
              if (!entry) throw new Error("unexpected-d1-batch-statement");
              expect(entry.session).toBe(session);
              return entry;
            });
            recordExecution(
              session,
              "batch",
              entries.map(({ query }) => query),
            );
            const results = await target.batch(
              entries.map(({ statement }) => statement),
            );
            for (let index = 0; index < results.length; index++) {
              const result = results[index];
              expect(result.results.length).toBeLessThanOrEqual(1);
              const row = await intercept(
                entries[index].query,
                async () => result.results[0] ?? null,
              );
              results[index] = {
                ...result,
                results: row === null ? [] : [row],
              };
            }
            return results;
          };
        throw new Error(`unexpected-d1-operation:${String(property)}`);
      },
    });
  return wrapDatabase(database);
}

function reader(
  games?: ReadInterceptor,
  profileAccess = () => {
    throw new Error("unexpected-profile-binding-access");
  },
  executions: ReadExecution[] = [],
) {
  return createInviteSourceReader(
    new Proxy(env, {
      get(target, property) {
        if (property === "PROFILE_GAMES_DB")
          return readOnlyDatabase(db, games, executions);
        if (property === "PROFILE_DB") return profileAccess();
        if (/FIREBASE|SERVICE_ACCOUNT/.test(String(property)))
          throw new Error(
            `unexpected-firebase-configuration:${String(property)}`,
          );
        return Reflect.get(target, property, target);
      },
    }),
  );
}

async function seedSource(value: unknown = source) {
  await db
    .prepare(
      `INSERT INTO invite_sources (invite_id, source_json, revision, updated_at_ms)
       VALUES (?, ?, 1, 1) ON CONFLICT (invite_id)
       DO UPDATE SET source_json = excluded.source_json, revision = revision + 1`,
    )
    .bind(inviteId, JSON.stringify(value))
    .run();
}

async function seedWager(
  matchId: string,
  wager: unknown,
  marker: boolean | null,
) {
  await env.PROFILE_DB.prepare(
    `INSERT INTO invite_wager_states
       (invite_id, match_id, wager_json, resolution_marker, revision, updated_at_ms)
       VALUES (?, ?, ?, ?, 1, 1)`,
  )
    .bind(
      inviteId,
      matchId,
      wager === null ? null : JSON.stringify(wager),
      marker === null ? null : Number(marker),
    )
    .run();
}

async function seedPendingTransition(status: "pending" | "completed") {
  await db.batch([
    db
      .prepare(
        `INSERT INTO game_session_transitions
         (transition_id, invite_id, payload_json, status, created_at_ms, updated_at_ms)
         VALUES ('reader-transition', ?, '{}', ?, 1, 1)`,
      )
      .bind(inviteId, status),
    db
      .prepare(
        `INSERT INTO game_session_transition_resources (resource_key, transition_id)
         VALUES (?, 'reader-transition')`,
      )
      .bind(inviteId),
  ]);
}

describe("D1-only invite source reader", () => {
  beforeAll(async () => {
    await applyD1Migrations(db, testEnv.TEST_D1_MIGRATIONS);
    await applyRetiredProfileMigrations(
      env.PROFILE_DB,
      testEnv.TEST_PROFILE_D1_MIGRATIONS,
      "a".repeat(64),
    );
  });

  beforeEach(async () => {
    inviteId = `reader-${crypto.randomUUID()}`;
    await db.batch([
      db.prepare("DELETE FROM game_session_transition_resources"),
      db.prepare("DELETE FROM game_session_transitions"),
      db.prepare("DELETE FROM invite_sources"),
      db.prepare(
        `UPDATE invite_source_control SET backend = 'd1', state = 'active',
         epoch = 1, freeze_generation = 0, verified_at_ms = 1,
         activated_at_ms = 1, metadata_json = NULL WHERE singleton = 1`,
      ),
      db.prepare(
        `UPDATE automatch_runtime_control SET backend = 'd1', state = 'active',
         epoch = 1, freeze_generation = 0, metadata_json = NULL WHERE singleton = 1`,
      ),
    ]);
    await seedSource();
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new Error("unexpected-outbound-request"),
    );
  });

  afterEach(() => vi.restoreAllMocks());

  it.each(["active", "frozen"])(
    "reads %s D1 sources without Firebase configuration, outbound HTTP, or writes",
    async (state) => {
      await db.batch([
        db.prepare("UPDATE invite_source_control SET state = ?").bind(state),
        db
          .prepare("UPDATE automatch_runtime_control SET state = ?")
          .bind(state),
      ]);
      const executions: ReadExecution[] = [];
      expect(await reader(undefined, undefined, executions)(inviteId)).toEqual(
        source,
      );
      expect(executions.map(({ kind }) => kind)).toEqual(["batch", "single"]);
      expect(executions[0].queries).toHaveLength(4);
      expect(executions[0].queries[0]).toContain(
        "FROM automatch_runtime_control ",
      );
      expect(executions[0].queries[1]).toContain("FROM invite_source_control ");
      expect(executions[0].queries[2]).toContain(
        "FROM game_session_transition_resources ",
      );
      expect(executions[0].queries[3]).toContain("FROM invite_sources ");
      expect(executions[1].queries[0]).toContain(
        "FROM game_session_transition_resources ",
      );
      expect(globalThis.fetch).not.toHaveBeenCalled();
    },
  );

  it("returns only metadata while preserving source and retained wager rows", async () => {
    const wager = {
      proposals: { "host-login": { material: "dust", count: 2 } },
    };
    await seedWager("proposal", wager, null);
    await seedWager("empty", {}, false);
    await seedWager("resolved", null, true);
    await seedWager("unresolved", null, false);
    const storedWagers = await env.PROFILE_DB.prepare(
      "SELECT * FROM invite_wager_states WHERE invite_id = ? ORDER BY match_id",
    )
      .bind(inviteId)
      .all();
    const read = reader();
    expect(await read(inviteId)).toEqual(source);
    expect(
      await db
        .prepare(
          "SELECT source_json, revision FROM invite_sources WHERE invite_id = ?",
        )
        .bind(inviteId)
        .first(),
    ).toEqual({ source_json: JSON.stringify(source), revision: 1 });
    expect(
      (
        await env.PROFILE_DB.prepare(
          "SELECT * FROM invite_wager_states WHERE invite_id = ? ORDER BY match_id",
        )
          .bind(inviteId)
          .all()
      ).results,
    ).toEqual(storedWagers.results);
  });

  it("returns null for missing invites even when retained wager rows exist", async () => {
    await seedWager("retained", { proposals: {} }, true);
    await db.prepare("DELETE FROM invite_sources").run();
    const executions: ReadExecution[] = [];
    expect(await reader(undefined, undefined, executions)(inviteId)).toBeNull();
    expect(executions.map(({ kind }) => kind)).toEqual(["batch", "single"]);
    expect(executions[0].queries).toHaveLength(4);
    expect(executions[0].queries[3]).toContain("FROM invite_sources ");
    expect(executions[1].queries[0]).toContain(
      "FROM game_session_transition_resources ",
    );
  });

  it.each([
    ["invite_source_control", null],
    ["invite_source_control", { backend: "rtdb", epoch: 0 }],
    ["invite_source_control", { state: "invalid" }],
    ["invite_source_control", { epoch: 0 }],
    ["invite_source_control", { verified_at_ms: null }],
    ["invite_source_control", { activated_at_ms: 0 }],
    ["invite_source_control", { metadata_json: "{" }],
    ["automatch_runtime_control", null],
    ["automatch_runtime_control", { backend: "rtdb" }],
    ["automatch_runtime_control", { state: "invalid" }],
    ["automatch_runtime_control", { epoch: 0 }],
    ["automatch_runtime_control", { freeze_generation: -1 }],
    ["automatch_runtime_control", { metadata_json: "{" }],
  ])(
    "rejects unavailable or inactive %s control %j",
    async (table, replacement) => {
      const executions: ReadExecution[] = [];
      const read = reader(
        async (query, execute) => {
          const value = await execute();
          return query.includes(`FROM ${table} `)
            ? replacement === null
              ? null
              : { ...(value as object), ...replacement }
            : value;
        },
        undefined,
        executions,
      );
      await expect(read(inviteId)).rejects.toThrow(
        /invite-source|automatch-control/,
      );
      expect(executions.map(({ kind }) => kind)).toEqual(["batch"]);
      expect(executions[0].queries).toHaveLength(4);
      expect(executions[0].queries[3]).toContain("FROM invite_sources ");
      expect(globalThis.fetch).not.toHaveBeenCalled();
    },
  );

  it.each(
    [
      {
        automatch: { state: "invalid" },
        invite: { state: "invalid" },
        error: "automatch-control-unavailable",
      },
      {
        automatch: { metadata_json: "{" },
        invite: { state: "invalid" },
        error: "automatch-control-corrupt",
      },
      {
        automatch: { backend: "rtdb" },
        invite: { state: "invalid" },
        error: "invite-source-control-unavailable",
      },
      {
        automatch: { backend: "rtdb" },
        invite: {},
        error: "invite-source-session-backend-conflict",
      },
      {
        automatch: {},
        invite: { backend: "rtdb", epoch: 0 },
        error: "invite-source-not-activated",
      },
    ].flatMap((scenario) =>
      ["valid", "malformed"].map((sourceState) => ({
        ...scenario,
        sourceState,
      })),
    ),
  )(
    "preserves $error precedence over retained transition resources with a $sourceState source",
    async ({ automatch, invite, error, sourceState }) => {
      await seedPendingTransition("pending");
      let sourceReads = 0;
      const executions: ReadExecution[] = [];
      const read = reader(
        async (query, execute) => {
          const value = await execute();
          if (query.includes("FROM automatch_runtime_control "))
            return { ...(value as object), ...automatch };
          if (query.includes("FROM invite_source_control "))
            return { ...(value as object), ...invite };
          if (query.includes("FROM invite_sources ")) {
            sourceReads++;
            if (sourceState === "malformed")
              return { ...(value as object), source_json: "{" };
          }
          return value;
        },
        undefined,
        executions,
      );
      await expect(read(inviteId)).rejects.toThrow(error);
      expect(sourceReads).toBe(1);
      expect(executions.map(({ kind }) => kind)).toEqual(["batch"]);
    },
  );

  it.each(["wager-state-not-activated", "wager-state-corrupt"])(
    "reads metadata and missing invites without accessing a profile binding that fails with %s",
    async (failure) => {
      const profileAccess = vi.fn(() => {
        throw new Error(failure);
      });
      const read = reader(undefined, profileAccess);
      expect(await read(inviteId)).toEqual(source);
      await db.prepare("DELETE FROM invite_sources").run();
      expect(await read(inviteId)).toBeNull();
      expect(profileAccess).not.toHaveBeenCalled();
    },
  );

  it.each([
    { when: "before", status: "pending" as const },
    { when: "during", status: "pending" as const },
    { when: "before", status: "completed" as const },
    { when: "during", status: "completed" as const },
  ])(
    "rejects retained $status transition resources $when metadata reads without recovering or writing",
    async ({ when, status }) => {
      if (when === "before") await seedPendingTransition(status);
      let sourceReads = 0;
      const executions: ReadExecution[] = [];
      const read = reader(
        async (query, execute) => {
          const value = await execute();
          if (query.includes("FROM invite_sources ")) {
            sourceReads++;
            if (when === "during") await seedPendingTransition(status);
          }
          return value;
        },
        undefined,
        executions,
      );
      await expect(read(inviteId)).rejects.toThrow(
        "game-session-transition-resource-pending",
      );
      expect(sourceReads).toBe(1);
      expect(executions.map(({ kind }) => kind)).toEqual(
        when === "before" ? ["batch"] : ["batch", "single"],
      );
      expect(
        await db
          .prepare("SELECT status, attempt_count FROM game_session_transitions")
          .first(),
      ).toEqual({ status, attempt_count: 0 });
    },
  );

  it.each(["pending", "completed"] as const)(
    "rejects retained %s transition resources before decoding a malformed source",
    async (status) => {
      await seedPendingTransition(status);
      let sourceReads = 0;
      const executions: ReadExecution[] = [];
      const read = reader(
        async (query, execute) => {
          const value = await execute();
          if (query.includes("FROM invite_sources ")) {
            sourceReads++;
            return { ...(value as object), source_json: "{" };
          }
          return value;
        },
        undefined,
        executions,
      );
      await expect(read(inviteId)).rejects.toThrow(
        "game-session-transition-resource-pending",
      );
      expect(sourceReads).toBe(1);
      expect(executions.map(({ kind }) => kind)).toEqual(["batch"]);
      expect(
        await db
          .prepare("SELECT status, attempt_count FROM game_session_transitions")
          .first(),
      ).toEqual({ status, attempt_count: 0 });
    },
  );

  it.each(["pending", "completed"] as const)(
    "checks the final primary fence for missing sources when a %s resource appears during the read",
    async (status) => {
      await db.prepare("DELETE FROM invite_sources").run();
      const executions: ReadExecution[] = [];
      const read = reader(
        async (query, execute) => {
          const value = await execute();
          if (query.includes("FROM invite_sources ")) {
            expect(value).toBeNull();
            await seedPendingTransition(status);
          }
          return value;
        },
        undefined,
        executions,
      );
      await expect(read(inviteId)).rejects.toThrow(
        "game-session-transition-resource-pending",
      );
      expect(executions.map(({ kind }) => kind)).toEqual(["batch", "single"]);
      expect(
        await db
          .prepare("SELECT status, attempt_count FROM game_session_transitions")
          .first(),
      ).toEqual({ status, attempt_count: 0 });
    },
  );

  it.each([
    { source_json: "{" },
    { source_json: "null" },
    { source_json: "[]" },
    { source_json: '{"wagers":{"stale":true}}' },
    { source_json: '{"matchesWagerResolutions":{"stale":true}}' },
    { revision: 0 },
  ])("rejects corrupt invite rows %j", async (replacement) => {
    const read = reader(async (query, execute) => {
      const value = await execute();
      return query.includes("FROM invite_sources ")
        ? { ...(value as object), ...replacement }
        : value;
    });
    await expect(read(inviteId)).rejects.toThrow("invite-source-corrupt");
  });

  it("reads fresh data after success and a transient D1 failure", async () => {
    let failNext = false;
    const read = reader(async (query, execute) => {
      if (failNext && query.includes("FROM invite_sources ")) {
        failNext = false;
        throw new Error("transient-d1-read");
      }
      return execute();
    });
    expect(await read(inviteId)).toEqual(source);
    await seedSource({ ...source, hostRematches: "1" });
    failNext = true;
    await expect(read(inviteId)).rejects.toThrow("transient-d1-read");
    expect(await read(inviteId)).toEqual({ ...source, hostRematches: "1" });
    await seedSource({ ...source, hostRematches: "1;2" });
    expect(await read(inviteId)).toEqual({ ...source, hostRematches: "1;2" });
  });

  it("reads fresh controls after a successful source read", async () => {
    const executions: ReadExecution[] = [];
    const read = reader(undefined, undefined, executions);
    expect(await read(inviteId)).toEqual(source);
    await db
      .prepare("UPDATE invite_source_control SET verified_at_ms = NULL")
      .run();
    await expect(read(inviteId)).rejects.toThrow(
      "invite-source-control-unavailable",
    );
    expect(executions.map(({ kind }) => kind)).toEqual([
      "batch",
      "single",
      "batch",
    ]);
  });
});
