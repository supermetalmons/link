import type { D1Migration } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  buildMatchStateRouteStatements,
  readLegacyMatchStates,
  readMatchStateControl,
  readMatchStateRoutes,
  readMatchStateRouteSnapshot,
} from "../src/matchStateD1.ts";

const runtime = env as Env & { TEST_D1_MIGRATIONS: D1Migration[] };
const db = env.PROFILE_GAMES_DB;

beforeEach(async () => {
  const tables = await db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'match_state_%'",
    )
    .all<{ name: string }>();
  for (const { name } of tables.results)
    await db.prepare(`DROP TABLE ${name}`).run();
  const migration = runtime.TEST_D1_MIGRATIONS.find((item) =>
    item.name.startsWith("0024_"),
  );
  if (!migration) throw new Error("match-state-test-migration-missing");
  await db.batch(migration.queries.map((query) => db.prepare(query)));
});

describe("match state D1 authority and admissions", () => {
  it("starts on Firebase and permits reads of empty routes", async () => {
    expect(await readMatchStateControl(db)).toMatchObject({
      backend: "rtdb",
      state: "active",
      epoch: 1,
      freezeGeneration: 0,
    });
    expect(
      await readMatchStateRoutes(db, [
        { playerId: "host", matchId: "game" },
      ]).then((rows) => rows[0]),
    ).toBeNull();
    expect(
      await readLegacyMatchStates(db, [
        { playerId: "host", matchId: "game" },
      ]).then((rows) => rows[0]),
    ).toBeNull();
  });

  it("reads authority and mixed routes together while preserving duplicates and missing positions", async () => {
    const durable = {
      actorUid: "host",
      matchId: "game",
      kind: "durable" as const,
      inviteId: "game",
      epoch: 1,
    };
    const legacy = {
      actorUid: "guest",
      matchId: "old-game",
      kind: "legacy" as const,
      inviteId: null,
      epoch: 1,
    };
    await db.batch(buildMatchStateRouteStatements(db, [durable, legacy]));
    const control = await readMatchStateControl(db);
    expect(
      await readMatchStateRouteSnapshot(db, [
        { playerId: legacy.actorUid, matchId: legacy.matchId },
        { playerId: "missing", matchId: "game" },
        { playerId: durable.actorUid, matchId: durable.matchId },
        { playerId: legacy.actorUid, matchId: legacy.matchId },
      ]),
    ).toEqual({ control, routes: [legacy, null, durable, legacy] });
    expect(await readMatchStateRouteSnapshot(db, [])).toEqual({
      control,
      routes: [],
    });
  });

  it("preserves immutable exact routes and raw legacy values", async () => {
    const route = {
      actorUid: "old",
      matchId: "old-game",
      kind: "legacy" as const,
      inviteId: null,
      epoch: 2,
    };
    await db.batch(buildMatchStateRouteStatements(db, [route]));
    await db.batch(buildMatchStateRouteStatements(db, [route]));
    expect(
      await readMatchStateRoutes(db, [
        { playerId: "old", matchId: "old-game" },
      ]).then((rows) => rows[0]),
    ).toEqual(route);
    await expect(
      readLegacyMatchStates(db, [
        { playerId: "old", matchId: "old-game" },
      ]).then((rows) => rows[0]),
    ).rejects.toThrow("legacy-record-unavailable");
    await expect(
      db.batch(
        buildMatchStateRouteStatements(db, [
          { ...route, kind: "durable", inviteId: "game" },
        ]),
      ),
    ).rejects.toThrow("route-conflict");
    await db
      .prepare(
        "INSERT INTO match_state_legacy_records VALUES (?, ?, ?, ?, ?, ?)",
      )
      .bind(
        "old",
        "old-game",
        '[1,{"legacy":true}]',
        "a".repeat(64),
        "import",
        "malformed",
      )
      .run();
    expect(
      await readLegacyMatchStates(db, [
        { playerId: "old", matchId: "old-game" },
      ]).then((rows) => rows[0]),
    ).toEqual([1, { legacy: true }]);
    await expect(
      db
        .prepare(
          "UPDATE match_state_legacy_records SET record_json = '{}' WHERE actor_uid = 'old'",
        )
        .run(),
    ).rejects.toThrow("immutable");
  });

  it("batches raw legacy records in order and distinguishes absent routes from missing records", async () => {
    const records = [
      { playerId: "host", matchId: "game", value: [1, { legacy: true }] },
      { playerId: "host", matchId: "rematch", value: null },
      { playerId: "guest", matchId: "game", value: false },
    ];
    const missing = { playerId: "missing", matchId: "game" };
    await db.batch([
      ...buildMatchStateRouteStatements(
        db,
        records.map(({ playerId, matchId }) => ({
          actorUid: playerId,
          matchId,
          kind: "legacy",
          inviteId: null,
          epoch: 2,
        })),
      ),
      ...records.map(({ playerId, matchId, value }) =>
        db
          .prepare(
            "INSERT INTO match_state_legacy_records VALUES (?, ?, ?, ?, ?, ?)",
          )
          .bind(
            playerId,
            matchId,
            JSON.stringify(value),
            "a".repeat(64),
            "import",
            "malformed",
          ),
      ),
    ]);
    expect(
      await readLegacyMatchStates(db, [
        records[2],
        records[0],
        missing,
        records[1],
        records[2],
        records[0],
      ]),
    ).toEqual([false, records[0].value, null, null, false, records[0].value]);
    await db.batch(
      buildMatchStateRouteStatements(db, [
        {
          actorUid: missing.playerId,
          matchId: missing.matchId,
          kind: "legacy",
          inviteId: null,
          epoch: 2,
        },
      ]),
    );
    await expect(
      readLegacyMatchStates(db, [records[1], missing, records[2]]),
    ).rejects.toThrow("legacy-record-unavailable");
  });

  it("requires verified evidence before authority changes and rejects rollback", async () => {
    await expect(
      db
        .prepare(
          "UPDATE match_state_control SET backend = 'durable', epoch = 2 WHERE singleton = 1",
        )
        .run(),
    ).rejects.toThrow();
    await db
      .prepare(
        `UPDATE match_state_control SET backend = 'durable', epoch = 2, state = 'frozen',
      candidate_version_id = 'candidate', import_id = 'import', source_digest = ?, verified_digest = ?, fence_digest = ?,
      source_record_count = 0, source_claim_count = 0, source_bundle_count = 0, verified_at_ms = 1, activated_at_ms = 2 WHERE singleton = 1`,
      )
      .bind("a".repeat(64), "a".repeat(64), "b".repeat(64))
      .run();
    await expect(
      db
        .prepare(
          "UPDATE match_state_control SET backend = 'rtdb' WHERE singleton = 1",
        )
        .run(),
    ).rejects.toThrow("one-way");
  });
});
