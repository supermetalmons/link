import { applyPreCleanupTestMigrations } from "./canonicalTestMigrations.ts";
import { env } from "cloudflare:workers";
import type { D1Migration } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { querySql } from "../test/legacyAutomatchStoreFixture.ts";

const db = env.PROFILE_GAMES_DB;
const migrations = (env as Env & { TEST_D1_MIGRATIONS: D1Migration[] })
  .TEST_D1_MIGRATIONS;
const migrationIndex = migrations.findIndex(
  ({ name }) => name === "0026_recovery_outbox_ordering.sql",
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
      readOutbox("automatch_telegram_projection_outbox", "updatedAtMs", false),
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
      readOutbox("game_session_projection_outbox", "lastQueuedAtMs", false),
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

async function indexes(table: string) {
  return (
    await db
      .prepare(
        `SELECT name, sql FROM sqlite_schema
         WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL
         ORDER BY name`,
      )
      .bind(table)
      .all<{ name: string; sql: string }>()
  ).results;
}

describe("recovery outbox ordering migration", () => {
  beforeAll(async () => {
    expect(migrationIndex).toBeGreaterThan(0);
    await applyPreCleanupTestMigrations(
      db,
      migrations.slice(0, migrationIndex),
    );
  });

  it("replaces both indexes without changing retained records and maintains later writes", async () => {
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
              `{ "requestId" : "retained-${position}",\n "${field}": 10, "futureField": "\\u03b1" }`,
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
      outboxes.map(({ table }) => indexes(table)),
    );

    await applyPreCleanupTestMigrations(db, [migrations[migrationIndex]!]);

    expect(await Promise.all(outboxes.map(({ table }) => rows(table)))).toEqual(
      beforeRows,
    );
    for (const [
      position,
      { table, index, field, read },
    ] of outboxes.entries()) {
      expect(beforeIndexes[position]!.map(({ name }) => name)).toEqual([index]);
      const afterIndexes = await indexes(table);
      expect(afterIndexes.map(({ name }) => name)).toEqual([index]);
      expect(afterIndexes[0]!.sql).not.toBe(beforeIndexes[position]![0]!.sql);
      expect(afterIndexes[0]!.sql).toContain("WHERE payload_json IS NOT NULL");
      const columns = await db
        .prepare(`PRAGMA index_xinfo(${index})`)
        .all<{ cid: number; key: number; name: string | null }>();
      expect(
        columns.results.filter(({ key }) => key === 1).map(({ cid }) => cid),
      ).toEqual([-2, -2, -2, -2, 0]);

      await db
        .prepare(
          `INSERT INTO ${table} (record_key, payload_json, revision, updated_at_ms)
           VALUES ('fresh', ?, 1, 1800000000300)`,
        )
        .bind(JSON.stringify({ [field]: 5 }))
        .run();
      expect(Object.keys((await read()) ?? {})).toEqual(["fresh"]);

      await db
        .prepare(
          `UPDATE ${table} SET payload_json = ?, revision = revision + 1,
             updated_at_ms = updated_at_ms + 1 WHERE record_key = 'fresh'`,
        )
        .bind(JSON.stringify({ [field]: 30 }))
        .run();
      expect(Object.keys((await read()) ?? {})).toEqual(["-1"]);

      await db
        .prepare(
          `UPDATE ${table} SET payload_json = NULL, revision = revision + 1,
             updated_at_ms = updated_at_ms + 1 WHERE record_key = '-1'`,
        )
        .run();
      expect(Object.keys((await read()) ?? {})).toEqual(["2"]);

      await db.prepare(`DELETE FROM ${table} WHERE record_key = '2'`).run();
      expect(Object.keys((await read()) ?? {})).toEqual(["02"]);

      await db
        .prepare(
          `UPDATE ${table} SET payload_json = ?, revision = revision + 1,
             updated_at_ms = updated_at_ms + 1 WHERE record_key = 'deleted'`,
        )
        .bind(JSON.stringify({ [field]: 4 }))
        .run();
      expect(Object.keys((await read()) ?? {})).toEqual(["deleted"]);
    }
  });
});
