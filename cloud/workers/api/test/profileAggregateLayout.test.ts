import assert from "node:assert/strict";
import test from "node:test";
import { parseCanonicalProfileAggregateResults } from "../src/profileCanonical/auth.ts";

const tables = [
  "profile",
  "owners",
  "auth",
  "opponents",
  "merge",
  "recovery",
] as const;

test("aggregate first-row failures retain profile, merge, recovery precedence before child reads", () => {
  const order = ["profile", "merge", "recovery"];
  for (const failingTable of order) {
    const failure = new Error(`${failingTable}-unavailable`);
    const reads: string[] = [];
    const results = tables.map((table) => ({
      get results(): Record<string, unknown>[] {
        reads.push(table);
        if (table === failingTable) throw failure;
        return [];
      },
    }));

    assert.throws(
      () => parseCanonicalProfileAggregateResults(results),
      (error) => error === failure,
    );
    assert.deepEqual(reads, order.slice(0, order.indexOf(failingTable) + 1));
  }
});

test("aggregate decoding keeps lazy child access and its original failure order", () => {
  const firstReads = ["read:profile", "read:merge", "read:recovery"];
  for (const [table, field, precedingReads] of [
    ["profile", "payload_json", []],
    ["owners", "login_uid", ["read:owners"]],
    ["auth", "method", ["read:owners", "read:auth"]],
    [
      "opponents",
      "opponent_profile_id",
      ["read:owners", "read:auth", "read:opponents"],
    ],
    [
      "merge",
      "source_profile_id",
      ["read:owners", "read:auth", "read:opponents"],
    ],
    [
      "recovery",
      "source_phase",
      ["read:owners", "read:auth", "read:opponents"],
    ],
  ] as const) {
    const events: string[] = [];
    const failure = new Error(`${table}-invalid`);
    const row = Object.defineProperty({}, field, {
      get() {
        events.push(`decode:${table}`);
        throw failure;
      },
    });
    const results = tables.map((name) => ({
      get results(): Record<string, unknown>[] {
        events.push(`read:${name}`);
        return name === table ? [row] : [];
      },
    }));

    assert.throws(
      () => parseCanonicalProfileAggregateResults(results),
      (error) => error === failure,
      table,
    );
    assert.deepEqual(events, [
      ...firstReads,
      ...precedingReads,
      `decode:${table}`,
    ]);
  }
});
