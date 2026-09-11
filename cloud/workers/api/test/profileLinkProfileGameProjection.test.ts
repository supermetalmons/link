import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import test from "node:test";
import {
  matchDiscoverySortKey,
  type MatchDiscoveryEntry,
} from "../../../runtime/shared/login-match-discovery.js";
import { createProfileLinkProjectionRuntime } from "../src/profileLinkProfileGameProjection.ts";
import { TELEGRAM_TEST_ENV } from "./testEnv.ts";

function discoveryDatabase(
  backend: "rtdb" | "d1",
  entries: readonly MatchDiscoveryEntry[] = [],
) {
  const database = new DatabaseSync(":memory:");
  for (const migration of [
    "0014_login_match_discovery.sql",
    "0015_login_match_discovery_control.sql",
  ]) {
    database.exec(
      readFileSync(
        new URL(`../migrations/${migration}`, import.meta.url),
        "utf8",
      ),
    );
  }
  if (backend === "d1") {
    database.exec(
      `UPDATE login_match_discovery_control SET discovery_backend = 'd1',
       capture_enforced = 1, capture_version_id = 'capture',
       capture_started_at_ms = 1, verified_at_ms = 2, activated_at_ms = 3`,
    );
  }
  const insert = database.prepare(
    `INSERT INTO login_match_discovery (login_uid, match_id, match_sort_key,
      invite_id, resolution, provenance, indexed_at_ms)
     VALUES ('login-uid', ?, ?, ?, ?, 'backfill', 1)`,
  );
  for (const entry of entries) {
    insert.run(
      entry.matchId,
      matchDiscoverySortKey(entry.matchId),
      entry.inviteId,
      entry.resolution,
    );
  }
  const queries: Array<{ sql: string; values: SQLInputValue[] }> = [];
  const baseDb = TELEGRAM_TEST_ENV.PROFILE_GAMES_DB;
  const prepare = (
    sql: string,
    values: SQLInputValue[] = [],
  ): D1PreparedStatement => ({
    raw: baseDb.prepare(sql).raw,
    run: baseDb.prepare(sql).run,
    bind: (...bindings: SQLInputValue[]) => prepare(sql, bindings),
    async first<T>(columnName?: string): Promise<T | null> {
      const row = database.prepare(sql).get(...values);
      return row ? ((columnName ? row[columnName] : row) as T) : null;
    },
    async all<T>(): Promise<D1Result<T>> {
      queries.push({ sql, values });
      const result = await baseDb.prepare(sql).all<T>();
      return {
        ...result,
        results: database.prepare(sql).all(...values) as T[],
      };
    },
  });
  const d1: D1Database = {
    ...baseDb,
    prepare,
    withSession(constraint) {
      assert.equal(constraint, "first-primary");
      return { prepare, batch: baseDb.batch, getBookmark: () => null };
    },
  };
  return { database, d1, queries };
}

test("profile-link projection rejects inactive D1 discovery without Firebase reads", async (t) => {
  const { database, d1, queries } = discoveryDatabase("rtdb");
  t.after(() => database.close());
  const runtime = createProfileLinkProjectionRuntime(TELEGRAM_TEST_ENV as Env, {
    d1,
    readProfileOwnershipSnapshot: async ({ loginUids, profileIds }) => {
      assert.deepEqual(loginUids, ["login-uid"]);
      assert.deepEqual(profileIds, []);
      return {
        profileIdByLoginUid: new Map([["login-uid", "profile-id"]]),
      };
    },
    logger: { error() {}, info() {} },
    projection: {
      async recomputeInviteProjection() {
        assert.fail("inactive discovery must retain work before projecting");
      },
    },
    state: {
      async getStatePath() {
        assert.fail("inactive discovery must not fall back to Firebase");
      },
    },
    async withInviteProjectionLock(_inviteId, work) {
      return work();
    },
  });

  await assert.rejects(
    runtime.process({
      cleanupProfileIds: [],
      loginUid: "login-uid",
      matchCursor: null,
      profileId: "profile-id",
      sourceUpdatedAtMs: 1,
    }),
    /login-match-discovery-not-active/,
  );
  assert.equal(queries.length, 0);
});

test("D1 profile-link discovery uses bounded ordered pages without Firebase discovery reads", async (t) => {
  const entries: MatchDiscoveryEntry[] = Array.from(
    { length: 2_005 },
    (_, index) => ({
      matchId: `match-${String(index).padStart(4, "0")}`,
      inviteId: index < 2 ? null : `invite-${index}`,
      resolution:
        index === 0 ? "missing" : index === 1 ? "ambiguous" : "resolved",
    }),
  );
  const { database, d1, queries } = discoveryDatabase("d1", entries);
  t.after(() => database.close());
  const recomputed: string[] = [];
  const locked: string[] = [];
  const runtime = createProfileLinkProjectionRuntime(TELEGRAM_TEST_ENV as Env, {
    d1,
    logger: { error() {}, info() {} },
    readProfileOwnershipSnapshot: async () => ({
      profileIdByLoginUid: new Map([["login-uid", "profile-id"]]),
    }),
    projection: {
      async recomputeInviteProjection(inviteId, reason) {
        recomputed.push(inviteId);
        return {
          inviteId,
          ok: true,
          reason,
          skipped: 0,
          sourceCleanupSafe: true,
        };
      },
    },
    state: {
      async getStatePath() {
        assert.fail(
          "D1 discovery must not read Firebase match keys or invites",
        );
      },
    },
    async withInviteProjectionLock(inviteId, work) {
      locked.push(inviteId);
      return work();
    },
  });
  const input = {
    cleanupProfileIds: [],
    loginUid: "login-uid",
    matchCursor: null,
    profileId: "profile-id",
    sourceUpdatedAtMs: 1,
  };
  const first = await runtime.process(input);
  assert.equal(first?.matchIdsScanned, 20);
  assert.equal(first?.processed, 18);
  assert.equal(first?.nextMatchCursor, "match-0019");
  assert.deepEqual(queries[0]?.values, ["login-uid", "", 21]);
  assert.match(queries[0]?.sql || "", /ORDER BY match_sort_key LIMIT \?/);
  const second = await runtime.process({
    ...input,
    matchCursor: first?.nextMatchCursor || null,
  });
  assert.equal(second?.matchIdsScanned, 20);
  assert.equal(second?.nextMatchCursor, "match-0039");
  assert.deepEqual(queries[1]?.values, [
    "login-uid",
    matchDiscoverySortKey("match-0019"),
    21,
  ]);
  assert.equal(recomputed.length, 38);
  assert.deepEqual(locked, recomputed);
  const last = await runtime.process({
    ...input,
    matchCursor: "match-1999",
  });
  assert.equal(last?.matchIdsScanned, 5);
  assert.equal(last?.nextMatchCursor, null);
  assert.equal(last?.didHitInviteCap, false);
  const empty = await runtime.process({
    ...input,
    matchCursor: "match-2004",
  });
  assert.equal(empty?.matchIdsScanned, 0);
  assert.equal(empty?.nextMatchCursor, null);
});

test("D1 profile-link cleanup requests one match and advances past unresolved records", async (t) => {
  const { database, d1, queries } = discoveryDatabase("d1", [
    { matchId: "match-1", inviteId: null, resolution: "ambiguous" },
    { matchId: "match-2", inviteId: "invite-2", resolution: "resolved" },
  ]);
  t.after(() => database.close());
  const runtime = createProfileLinkProjectionRuntime(TELEGRAM_TEST_ENV as Env, {
    d1,
    logger: { error() {}, info() {} },
    readProfileOwnershipSnapshot: async () => ({
      profileIdByLoginUid: new Map([["login-uid", "profile-id"]]),
    }),
    projection: {
      async recomputeInviteProjection() {
        assert.fail("the first unresolved record must not project an invite");
      },
    },
    state: {
      async getStatePath() {
        assert.fail("D1 discovery must not access Firebase");
      },
    },
    async withInviteProjectionLock(_inviteId, work) {
      return work();
    },
  });
  const result = await runtime.process({
    cleanupProfileIds: ["stale-profile"],
    loginUid: "login-uid",
    matchCursor: null,
    profileId: "profile-id",
    sourceUpdatedAtMs: 1,
  });
  assert.equal(result?.matchIdsScanned, 1);
  assert.equal(result?.nextMatchCursor, "match-1");
  assert.equal(result?.processed, 0);
  assert.deepEqual(queries[0]?.values, ["login-uid", "", 2]);
});

test("D1 profile-link failures propagate without falling back to Firebase", async (t) => {
  for (const table of [
    "login_match_discovery",
    "login_match_discovery_control",
  ]) {
    const { database, d1 } = discoveryDatabase("d1");
    t.after(() => database.close());
    database.exec(`DROP TABLE ${table}`);
    const runtime = createProfileLinkProjectionRuntime(
      TELEGRAM_TEST_ENV as Env,
      {
        d1,
        logger: { error() {}, info() {} },
        readProfileOwnershipSnapshot: async () => ({
          profileIdByLoginUid: new Map([["login-uid", "profile-id"]]),
        }),
        projection: {
          async recomputeInviteProjection() {
            assert.fail("failed discovery must not project an invite");
          },
        },
        state: {
          async getStatePath() {
            assert.fail("D1 discovery failure must not fall back to Firebase");
          },
        },
        async withInviteProjectionLock(_inviteId, work) {
          return work();
        },
      },
    );
    await assert.rejects(
      runtime.process({
        cleanupProfileIds: [],
        loginUid: "login-uid",
        matchCursor: null,
        profileId: "profile-id",
        sourceUpdatedAtMs: 1,
      }),
      /no such table/,
    );
  }
});
