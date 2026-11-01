import { applyPreCleanupTestMigrations } from "./canonicalTestMigrations.ts";
import { env } from "cloudflare:workers";
import type { D1Migration } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { querySql } from "../test/legacyAutomatchStoreFixture.ts";

const db = env.PROFILE_GAMES_DB;
const migrations = (env as Env & { TEST_D1_MIGRATIONS: D1Migration[] })
  .TEST_D1_MIGRATIONS;
const migrationIndex = migrations.findIndex(
  ({ name }) => name === "0027_outbox_recovery_sort_columns.sql",
);
async function readOutbox(table: string, field: string, generated = false) {
  const query = querySql("payload_json", {
    orderBy: field,
    startAt: 0,
    endAt: 10,
    limitToFirst: 1,
  });
  const where = generated
    ? "payload_json IS NOT NULL AND recovery_sort_rank = 3 AND recovery_sort_value >= 0 AND recovery_sort_value <= 10"
    : query.where;
  const order = generated
    ? "recovery_sort_rank, recovery_sort_value, recovery_key_rank, recovery_key_integer, recovery_key_length, record_key COLLATE BINARY"
    : query.order;
  const values = await db
    .prepare(
      `SELECT record_key, payload_json FROM ${table} WHERE ${where} ORDER BY ${order} LIMIT 1`,
    )
    .bind(...(generated ? [] : query.values))
    .all<{ record_key: string; payload_json: string }>();
  return Object.fromEntries(
    values.results.map((row) => [row.record_key, JSON.parse(row.payload_json)]),
  );
}
const outboxes = [
  {
    table: "automatch_telegram_projection_outbox",
    oldIndex: "idx_automatch_telegram_projection_due",
    newIndex: "idx_automatch_telegram_projection_recovery",
    index: "idx_automatch_telegram_projection_due",
    field: "updatedAtMs",
    read: () =>
      readOutbox("automatch_telegram_projection_outbox", "updatedAtMs", true),
    legacyRead: () =>
      readOutbox("automatch_telegram_projection_outbox", "updatedAtMs"),
  },
  {
    table: "game_session_projection_outbox",
    oldIndex: "idx_game_session_projection_due",
    newIndex: "idx_game_session_projection_recovery",
    index: "idx_game_session_projection_due",
    field: "lastQueuedAtMs",
    read: () =>
      readOutbox("game_session_projection_outbox", "lastQueuedAtMs", true),
    legacyRead: () =>
      readOutbox("game_session_projection_outbox", "lastQueuedAtMs"),
  },
] as const;

async function rows(table: string) {
  return (
    await db
      .prepare(
        `SELECT record_key, payload_json, revision, updated_at_ms,
                hex(CAST(record_key AS BLOB)) AS key_hex,
                hex(CAST(payload_json AS BLOB)) AS payload_hex
         FROM ${table} ORDER BY record_key COLLATE BINARY`,
      )
      .all()
  ).results;
}

async function indexSql(name: string) {
  return db
    .prepare("SELECT sql FROM sqlite_schema WHERE type = 'index' AND name = ?")
    .bind(name)
    .first<string>("sql");
}

describe("generated recovery ordering migration", () => {
  beforeAll(async () => {
    expect(migrationIndex).toBeGreaterThan(0);
    await applyPreCleanupTestMigrations(
      db,
      migrations.slice(0, migrationIndex),
    );
  });

  it("preserves canonical bytes and legacy indexes while indexing existing and old-writer rows", async () => {
    for (const { table, field } of outboxes) {
      const keys = ["10", "2", "02", "-1", "auto-a", "\uE000", "😀"];
      await db.batch([
        ...keys.map((key, position) =>
          db
            .prepare(
              `INSERT INTO ${table} (record_key, payload_json, revision, updated_at_ms)
               VALUES (?, ?, ?, ?)`,
            )
            .bind(
              key,
              `{ "requestId" : "retained-${position}",\n "${field}": 1e1, "futureField": "\\u03b1" }`,
              position + 7,
              1_800_000_000_000 + position,
            ),
        ),
        db.prepare(
          `INSERT INTO ${table} (record_key, payload_json, revision, updated_at_ms)
           VALUES ('deleted', NULL, 23, 1800000000100)`,
        ),
        db
          .prepare(
            `INSERT INTO ${table} (record_key, payload_json, revision, updated_at_ms)
             VALUES ('malformed', ?, 29, 1800000000200)`,
          )
          .bind(`{ "${field}" : "10", "requestId": "retained-malformed" }`),
      ]);
    }
    const beforeRows = await Promise.all(
      outboxes.map(({ table }) => rows(table)),
    );
    const beforeIndexes = await Promise.all(
      outboxes.map(({ oldIndex }) => indexSql(oldIndex)),
    );
    const beforeLegacyReads = await Promise.all(
      outboxes.map(({ legacyRead }) => legacyRead()),
    );

    await applyPreCleanupTestMigrations(db, [migrations[migrationIndex]!]);

    expect(await Promise.all(outboxes.map(({ table }) => rows(table)))).toEqual(
      beforeRows,
    );
    expect(
      await Promise.all(outboxes.map(({ oldIndex }) => indexSql(oldIndex))),
    ).toEqual(beforeIndexes);
    expect(await Promise.all(outboxes.map(({ read }) => read()))).toEqual(
      beforeLegacyReads,
    );

    for (const { table, newIndex, field, read, legacyRead } of outboxes) {
      const columns = await db
        .prepare(`PRAGMA table_xinfo(${table})`)
        .all<{ name: string; type: string; hidden: number }>();
      const generated = columns.results.filter(({ hidden }) => hidden === 2);
      expect(generated.map(({ name }) => name)).toEqual([
        "recovery_sort_rank",
        "recovery_sort_value",
        "recovery_key_integer",
        "recovery_key_rank",
        "recovery_key_length",
      ]);
      expect(
        generated.find(({ name }) => name === "recovery_sort_value")?.type,
      ).toBe("");
      const indexColumns = await db
        .prepare(`PRAGMA index_xinfo(${newIndex})`)
        .all<{ name: string | null; key: number; coll: string }>();
      expect(
        indexColumns.results
          .filter(({ key }) => key === 1)
          .map(({ name, coll }) => ({ name, coll })),
      ).toEqual(
        [
          "recovery_sort_rank",
          "recovery_sort_value",
          "recovery_key_rank",
          "recovery_key_integer",
          "recovery_key_length",
          "record_key",
        ].map((name) => ({ name, coll: "BINARY" })),
      );
      expect(await indexSql(newIndex)).toContain(
        "WHERE payload_json IS NOT NULL",
      );

      await db
        .prepare(
          `INSERT INTO ${table} (record_key, payload_json, revision, updated_at_ms)
           VALUES ('fresh', ?, 1, 1800000000300)`,
        )
        .bind(JSON.stringify({ [field]: 5, requestId: "fresh-request" }))
        .run();
      expect(Object.keys((await read()) ?? {})).toEqual(["fresh"]);
      expect(await read()).toEqual(await legacyRead());

      await db
        .prepare(
          `INSERT INTO ${table} (record_key, payload_json, revision, updated_at_ms)
           VALUES ('fresh', ?, 2, 1800000000301)
           ON CONFLICT (record_key) DO UPDATE SET
             payload_json = excluded.payload_json,
             revision = excluded.revision,
             updated_at_ms = excluded.updated_at_ms`,
        )
        .bind(JSON.stringify({ [field]: 30, requestId: "replacement" }))
        .run();
      expect(Object.keys((await read()) ?? {})).toEqual(["-1"]);
      expect(await read()).toEqual(await legacyRead());

      await db
        .prepare(
          `UPDATE ${table}
           SET payload_json = json_set(payload_json, '$.${field}', 3),
             revision = revision + 1, updated_at_ms = updated_at_ms + 1
           WHERE record_key = 'fresh'`,
        )
        .run();
      expect(Object.keys((await read()) ?? {})).toEqual(["fresh"]);
      expect(await read()).toEqual(await legacyRead());
      expect(
        await db
          .prepare(
            `SELECT revision, updated_at_ms, recovery_sort_rank, recovery_sort_value
             FROM ${table} WHERE record_key = 'fresh'`,
          )
          .first(),
      ).toEqual({
        revision: 3,
        updated_at_ms: 1_800_000_000_302,
        recovery_sort_rank: 3,
        recovery_sort_value: 3,
      });

      const beforeNoop = await rows(table);
      await db
        .prepare(
          `UPDATE ${table} SET payload_json = payload_json WHERE record_key = 'fresh'`,
        )
        .run();
      expect(await rows(table)).toEqual(beforeNoop);

      await db
        .prepare(
          `UPDATE ${table} SET payload_json = NULL, revision = revision + 1,
             updated_at_ms = updated_at_ms + 1 WHERE record_key = 'fresh'`,
        )
        .run();
      expect(Object.keys((await read()) ?? {})).toEqual(["-1"]);
      expect(await read()).toEqual(await legacyRead());

      await db
        .prepare(
          `UPDATE ${table} SET payload_json = ?, revision = revision + 1,
             updated_at_ms = updated_at_ms + 1 WHERE record_key = 'deleted'`,
        )
        .bind(JSON.stringify({ [field]: 4 }))
        .run();
      expect(Object.keys((await read()) ?? {})).toEqual(["deleted"]);
      expect(await read()).toEqual(await legacyRead());

      await db
        .prepare(`DELETE FROM ${table} WHERE record_key = 'deleted'`)
        .run();
      expect(Object.keys((await read()) ?? {})).toEqual(["-1"]);
      expect(await read()).toEqual(await legacyRead());
    }
    expect(
      (await db.prepare("PRAGMA foreign_key_check").all()).results,
    ).toEqual([]);
  });
});
