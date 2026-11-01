import assert from "node:assert/strict";
import test from "node:test";
import {
  collectD1Telemetry,
  type D1TelemetrySummary,
} from "../src/d1Telemetry.ts";
import {
  readCanonicalMergeTarget,
  readCanonicalProfile,
} from "../src/profileCanonical/profiles.ts";
import { readCanonicalWagerSettlement } from "../src/profileCanonical/accounting.ts";
import { TELEGRAM_TEST_ENV } from "./testEnv.ts";

for (const [read, query] of [
  [
    readCanonicalProfile,
    "SELECT * FROM profile_records_canonical WHERE profile_id = ?",
  ],
  [
    readCanonicalMergeTarget,
    "SELECT source_profile_id, target_profile_id, merged_at_ms, op_id FROM profile_merge_targets_canonical WHERE source_profile_id = ?",
  ],
  [
    readCanonicalWagerSettlement,
    "SELECT * FROM wager_settlements_canonical WHERE operation_id = ?",
  ],
] as const) {
  test(`${read.name} keeps point-read metadata without changing its query or binding`, async () => {
    const id = " private-id' OR 1 = 1 -- ";
    const prepared: string[] = [];
    const bindings: unknown[][] = [];
    let calls = 0;
    let summary: D1TelemetrySummary | undefined;
    const source = TELEGRAM_TEST_ENV.PROFILE_DB.prepare(query);
    const statement: D1PreparedStatement = {
      raw: source.raw.bind(source),
      run: source.run.bind(source),
      bind: (...values) => {
        bindings.push(values);
        return statement;
      },
      first: async () => assert.fail("unexpected-first-call"),
      all: async () => {
        calls++;
        return {
          success: true,
          results: [],
          meta: {
            changed_db: false,
            changes: 0,
            duration: 3,
            last_row_id: 0,
            rows_read: 0,
            rows_written: 0,
            size_after: 0,
          },
        };
      },
    };
    const db: D1Database = {
      ...TELEGRAM_TEST_ENV.PROFILE_DB,
      prepare: (sql) => {
        prepared.push(sql.replace(/\s+/g, " ").trim());
        return statement;
      },
      withSession: () => assert.fail("unexpected-session-change"),
    };
    await collectD1Telemetry(
      { ...TELEGRAM_TEST_ENV, PROFILE_DB: db },
      async (env) => assert.equal(await read(env.PROFILE_DB, id), null),
      { onComplete: (value) => (summary = value) },
    );
    assert.deepEqual(prepared, [query]);
    assert.deepEqual(bindings, [[id]]);
    assert.equal(calls, 1);
    assert.ok(summary);
    assert.equal(summary.d1.calls, 1);
    assert.equal(summary.d1.metadataResults, 1);
    assert.equal(summary.d1.callsWithoutMetadata, 0);
    assert.equal(summary.d1.rowsRead, 0);
    assert.equal(summary.d1.rowsWritten, 0);
    assert.equal(summary.d1.sqlDurationMs, 3);
    assert.equal(JSON.stringify(summary).includes(id), false);
  });
}
