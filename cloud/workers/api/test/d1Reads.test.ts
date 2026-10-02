import assert from "node:assert/strict";
import test from "node:test";
import { readD1FirstRow } from "../src/d1Reads.ts";
import { TELEGRAM_TEST_ENV } from "./testEnv.ts";

test("returns the original first row or null with one all call", async () => {
  const row = { value: "stored-value", nullable: null };
  for (const rows of [[row], []]) {
    let calls = 0;
    const source = TELEGRAM_TEST_ENV.PROFILE_DB.prepare(
      "SELECT value WHERE id = ?",
    );
    const statement: D1PreparedStatement = {
      bind: source.bind.bind(source),
      raw: source.raw.bind(source),
      run: source.run.bind(source),
      all: async <T>() => {
        calls++;
        return {
          success: true,
          results: rows as T[],
          meta: {
            changed_db: false,
            changes: 0,
            duration: 1,
            last_row_id: 0,
            rows_read: rows.length,
            rows_written: 0,
            size_after: 0,
          },
        };
      },
      first: async () => {
        assert.fail("unexpected-first-call");
      },
    };
    assert.equal(await readD1FirstRow(statement), rows[0] ?? null);
    assert.equal(calls, 1);
  }
});

test("preserves the exact database failure without retrying", async () => {
  const failure = new Error("database-unavailable");
  let calls = 0;
  const source = TELEGRAM_TEST_ENV.PROFILE_DB.prepare(
    "SELECT value WHERE id = ?",
  );
  const statement: D1PreparedStatement = {
    bind: source.bind.bind(source),
    first: source.first.bind(source),
    raw: source.raw.bind(source),
    run: source.run.bind(source),
    all: async () => {
      calls++;
      throw failure;
    },
  };
  await assert.rejects(readD1FirstRow(statement), (error) => error === failure);
  assert.equal(calls, 1);
});
