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

function readOnlyDatabase(
  database: D1Database,
  intercept: ReadInterceptor = (_query, execute) => execute(),
): D1Database {
  const wrapStatement = (
    statement: D1PreparedStatement,
    query: string,
  ): D1PreparedStatement =>
    new Proxy(statement, {
      get(target, property) {
        if (property === "bind")
          return (...values: unknown[]) =>
            wrapStatement(target.bind(...values), query);
        if (property === "first" || property === "all")
          return (...args: unknown[]) =>
            intercept(query, () =>
              Reflect.apply(
                Reflect.get(target, property, target),
                target,
                args,
              ),
            );
        throw new Error(
          `unexpected-d1-statement-operation:${String(property)}`,
        );
      },
    });
  const wrapDatabase = <T extends D1Database | D1DatabaseSession>(
    target: T,
  ): T =>
    new Proxy(target, {
      get(target, property) {
        if (property === "withSession")
          return (constraint: D1SessionConstraint | D1SessionBookmark) => {
            expect(constraint).toBe("first-primary");
            return wrapDatabase(database.withSession(constraint));
          };
        if (property === "prepare")
          return (query: string) => {
            expect(query.trimStart().startsWith("SELECT ")).toBe(true);
            return wrapStatement(target.prepare(query), query);
          };
        throw new Error(`unexpected-d1-operation:${String(property)}`);
      },
    });
  return wrapDatabase(database);
}

function reader(games?: ReadInterceptor, profile?: ReadInterceptor) {
  return createInviteSourceReader(
    new Proxy(env, {
      get(target, property) {
        if (property === "PROFILE_GAMES_DB") return readOnlyDatabase(db, games);
        if (property === "PROFILE_DB")
          return readOnlyDatabase(env.PROFILE_DB, profile);
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
      expect(await reader()(inviteId)).toEqual(source);
      expect(globalThis.fetch).not.toHaveBeenCalled();
    },
  );

  it("preserves private metadata, unknown fields, empty wagers, and false resolution markers without changing source rows", async () => {
    const wager = {
      proposals: { "host-login": { material: "dust", count: 2 } },
    };
    await seedWager("proposal", wager, null);
    await seedWager("empty", {}, false);
    await seedWager("resolved", null, true);
    await seedWager("unresolved", null, false);
    const read = reader();
    expect(await read(inviteId)).toEqual({
      ...source,
      wagers: { empty: {}, proposal: wager },
      matchesWagerResolutions: {
        empty: false,
        resolved: true,
        unresolved: false,
      },
    });
    expect(
      await db
        .prepare(
          "SELECT source_json, revision FROM invite_sources WHERE invite_id = ?",
        )
        .bind(inviteId)
        .first(),
    ).toEqual({ source_json: JSON.stringify(source), revision: 1 });
    await env.PROFILE_DB.prepare(
      `UPDATE invite_wager_states SET wager_json = NULL, resolution_marker = NULL,
         revision = revision + 1 WHERE invite_id = ?`,
    )
      .bind(inviteId)
      .run();
    expect(await read(inviteId)).toEqual(source);
  });

  it("returns null for missing invites even when retained wager rows exist", async () => {
    await seedWager("retained", { proposals: {} }, true);
    await db.prepare("DELETE FROM invite_sources").run();
    expect(await reader()(inviteId)).toBeNull();
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
      const read = reader(async (query, execute) => {
        const value = await execute();
        return query.includes(`FROM ${table} `)
          ? replacement === null
            ? null
            : { ...(value as object), ...replacement }
          : value;
      });
      await expect(read(inviteId)).rejects.toThrow(
        /invite-source|automatch-control/,
      );
      expect(globalThis.fetch).not.toHaveBeenCalled();
    },
  );

  it.each([
    null,
    { activation_epoch: 0 },
    { verified_at_ms: null },
    { activated_at_ms: 0 },
  ])(
    "requires valid wager activation %j, including missing invites",
    async (replacement) => {
      await db.prepare("DELETE FROM invite_sources").run();
      const read = reader(undefined, async (query, execute) => {
        const result = (await execute()) as D1Result<Record<string, unknown>>;
        return query.includes("FROM wager_state_activation")
          ? {
              ...result,
              results:
                replacement === null
                  ? []
                  : result.results.map((row) => ({ ...row, ...replacement })),
            }
          : result;
      });
      await expect(read(inviteId)).rejects.toThrow("wager-state-not-activated");
    },
  );

  it.each([
    { when: "before", status: "pending" as const },
    { when: "during", status: "pending" as const },
    { when: "before", status: "completed" as const },
  ])(
    "rejects retained $status transition resources $when metadata reads without recovering or writing",
    async ({ when, status }) => {
      if (when === "before") await seedPendingTransition(status);
      let sourceReads = 0;
      const read = reader(async (query, execute) => {
        const value = await execute();
        if (query.includes("FROM invite_sources ")) {
          sourceReads++;
          if (when === "during") await seedPendingTransition(status);
        }
        return value;
      });
      await expect(read(inviteId)).rejects.toThrow(
        "game-session-transition-resource-pending",
      );
      expect(sourceReads).toBe(when === "before" ? 0 : 1);
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

  it("rejects corrupt wager rows without returning partial metadata", async () => {
    await seedWager("broken", {}, null);
    const read = reader(undefined, async (query, execute) => {
      const result = (await execute()) as D1Result<Record<string, unknown>>;
      return query.includes("FROM wager_state_activation")
        ? {
            ...result,
            results: result.results.map((row) => ({ ...row, wager_json: "{" })),
          }
        : result;
    });
    await expect(read(inviteId)).rejects.toThrow("wager-state-corrupt");
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
});
