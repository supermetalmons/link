import { applyPreCleanupTestMigrations } from "./canonicalTestMigrations.ts";
import { env } from "cloudflare:workers";
import { eventDocumentFixture } from "../test/eventCompatibilityFixture.ts";
import type { D1Migration } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import {
  acquireEventWriteAdmission,
  readEventPrizeSelections,
  readEventSnapshotIfChanged,
  releaseEventWriteAdmission,
  transactEventLease,
  transactEventPrizeSelection,
  type EventD1Connection,
} from "../src/eventD1.ts";
import { readEventPrizeSelectionSnapshot } from "../src/eventD1/reads.ts";
import { applyEventTestMigrations } from "./eventTestMigrations.ts";

const db = env.EVENT_DB;
const migrations = (env as Env & { TEST_EVENT_D1_MIGRATIONS: D1Migration[] })
  .TEST_EVENT_D1_MIGRATIONS;
const migrationIndex = migrations.findIndex(
  ({ name }) => name === "0007_drop_unused_prize_selection_profile_index.sql",
);
const indexName = "idx_event_prize_selections_profile";
const eventId = "NN3eRzoZo80";
const siblingEventId = "selection-index-sibling";

function insertEvent(id: string) {
  const event = {
    schemaVersion: 2,
    eventId: id,
    status: "scheduled",
    createdAtMs: 100,
    updatedAtMs: 200,
    startAtMs: 300,
    participants: {},
    rounds: {},
    isSundayMons: id === eventId,
    futureField: { retained: true },
  };
  return db
    .prepare(
      `INSERT INTO event_records (
         event_id, status, start_at_ms, updated_at_ms, revision, record_json
       ) VALUES (?, 'scheduled', 300, 200, 7, ?)`,
    )
    .bind(id, JSON.stringify(event, null, 2));
}

async function retainedRows() {
  const tables = [
    "event_records",
    "event_prize_selections",
    "event_runtime_control",
    "event_write_admissions",
    "event_leases",
  ];
  return Promise.all(
    tables.map(async (table) => {
      return (await db.prepare(`SELECT * FROM ${table} ORDER BY 1, 2`).all())
        .results;
    }),
  );
}

async function schema() {
  return (
    await db
      .prepare(
        `SELECT type, name, tbl_name, sql FROM sqlite_schema
         WHERE sql IS NOT NULL ORDER BY type, name`,
      )
      .all<{ type: string; name: string; tbl_name: string; sql: string }>()
  ).results;
}

function observeQueries() {
  const queries: Array<{ sql: string; values: unknown[] }> = [];
  const connection: EventD1Connection = {
    prepare(sql) {
      const query = { sql, values: [] as unknown[] };
      queries.push(query);
      return new Proxy(db.prepare(sql), {
        get(target, property) {
          if (property === "bind") {
            return (...values: unknown[]) => {
              query.values = values;
              return target.bind(...values);
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
    batch: (statements) => db.batch(statements),
  };
  return { connection, queries };
}

describe("unused prize selection profile index migration", () => {
  beforeAll(async () => {
    expect(migrationIndex).toBeGreaterThan(0);
    await applyEventTestMigrations(db, migrations.slice(0, migrationIndex));
  });

  it("preserves active coordination, selections, constraints and indexed application queries", async () => {
    await db.batch([insertEvent(eventId), insertEvent(siblingEventId)]);
    await db.batch(
      [
        [eventId, "profile-a"],
        [eventId, "profile-😀"],
        [siblingEventId, "profile-a"],
      ].map(([id, profileId]) =>
        db
          .prepare(
            "INSERT INTO event_prize_selections VALUES (?, ?, '1092', 200)",
          )
          .bind(id, profileId),
      ),
    );
    const admission = await acquireEventWriteAdmission(db);
    const nowMs = Date.now();
    const eventLease = {
      eventId,
      lockId: "retained-index-lease",
      ownerUid: "index-test-owner",
    };
    await transactEventLease(
      db,
      eventId,
      () => ({
        value: {
          lockId: eventLease.lockId,
          ownerUid: eventLease.ownerUid,
          acquiredAtMs: nowMs,
          refreshedAtMs: nowMs,
          expiresAtMs: nowMs + 300_000,
        },
      }),
      { admission },
    );
    const beforeRows = await retainedRows();
    const beforeSchema = await schema();
    expect(beforeSchema.find(({ name }) => name === indexName)).toMatchObject({
      type: "index",
      tbl_name: "event_prize_selections",
    });

    await applyPreCleanupTestMigrations(db, [migrations[migrationIndex]!]);

    expect(await retainedRows()).toEqual(beforeRows);
    expect(await schema()).toEqual(
      beforeSchema.filter(({ name }) => name !== indexName),
    );
    expect(
      await db
        .prepare(
          "SELECT storage_mode FROM event_runtime_control WHERE singleton = 1",
        )
        .first("storage_mode"),
    ).toBe("d1");
    await expect(
      db
        .prepare(
          "INSERT INTO event_prize_selections VALUES (?, 'profile-a', '1111', 201)",
        )
        .bind(eventId)
        .run(),
    ).rejects.toThrow(/UNIQUE constraint failed/);
    await expect(
      db
        .prepare(
          "INSERT INTO event_prize_selections VALUES ('missing-event', 'profile-a', '1092', 201)",
        )
        .run(),
    ).rejects.toThrow(/FOREIGN KEY constraint failed/);

    await applyPreCleanupTestMigrations(
      db,
      migrations.slice(migrationIndex + 1),
    );
    for (const id of [eventId, siblingEventId]) {
      await db
        .prepare(
          `INSERT INTO event_records_canonical
        (event_id, status, start_at_ms, updated_at_ms, revision, record_json)
        VALUES (?, 'scheduled', 300, 200, 7, ?)`,
        )
        .bind(
          id,
          JSON.stringify(
            eventDocumentFixture({
              eventId: id,
              status: "scheduled",
              createdAtMs: 100,
              updatedAtMs: 200,
              startAtMs: 300,
              isSundayMons: id === eventId,
            }),
          ),
        )
        .run();
    }
    await db
      .prepare(
        "INSERT INTO event_prize_selections_canonical SELECT * FROM event_prize_selections",
      )
      .run();
    const { connection, queries } = observeQueries();
    const selections = { "profile-a": "1092", "profile-😀": "1092" };
    await expect(
      readEventPrizeSelections(connection, eventId),
    ).resolves.toEqual(selections);
    await expect(
      readEventPrizeSelectionSnapshot(connection, eventId, "profile-a"),
    ).resolves.toMatchObject({ event: { revision: 7 }, value: "1092" });
    await expect(
      readEventSnapshotIfChanged(connection, eventId, 7),
    ).resolves.toEqual({
      notModified: true,
      revision: 7,
    });
    const options = { admission, eventLease, now: () => 400 };
    for (const [offset, value] of ["1092", "1111", null].entries()) {
      await expect(
        transactEventPrizeSelection(
          connection,
          eventId,
          "fresh-profile",
          () => ({ value }),
          options,
        ),
      ).resolves.toMatchObject({ committed: true, value });
      await expect(
        readEventSnapshotIfChanged(connection, eventId, 7 + offset),
      ).resolves.toMatchObject({
        notModified: false,
        snapshot: {
          revision: 8 + offset,
          prizeSelections: {
            ...selections,
            ...(value === null ? {} : { "fresh-profile": value }),
          },
        },
      });
    }
    await expect(
      readEventPrizeSelections(connection, eventId),
    ).resolves.toEqual(selections);
    const selectionQueries = new Map(
      queries
        .filter(
          ({ sql }) =>
            /^\s*(SELECT|DELETE)\b/.test(sql) &&
            sql.includes("FROM event_prize_selections"),
        )
        .map((query) => [query.sql, query]),
    );
    expect(selectionQueries.size).toBe(4);
    for (const { sql, values } of selectionQueries.values()) {
      const plan = await db
        .prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .bind(...values)
        .all<{ detail: string }>();
      const details = plan.results.map(({ detail }) => detail).join("\n");
      expect(details).toMatch(
        /SEARCH event_prize_selections_canonical USING PRIMARY KEY \(event_id=\?/,
      );
      expect(details).not.toMatch(
        /SCAN event_prize_selections_canonical|USE TEMP B-TREE/,
      );
    }

    await db
      .prepare("DELETE FROM event_records_canonical WHERE event_id = ?")
      .bind(siblingEventId)
      .run();
    await expect(readEventPrizeSelections(db, siblingEventId)).resolves.toEqual(
      {},
    );
    await expect(readEventPrizeSelections(db, eventId)).resolves.toEqual(
      selections,
    );
    expect(
      (await db.prepare("PRAGMA foreign_key_check").all()).results,
    ).toEqual([]);
    await transactEventLease(db, eventId, () => ({ value: null }), {
      admission,
    });
    await expect(releaseEventWriteAdmission(db, admission)).resolves.toBe(true);
  });
});
