import assert from "node:assert/strict";
import test from "node:test";
import { inspectMatchPresentations } from "./operator/inspect/matchPresentations.ts";

test("appearance status preserves authority and both registration and source-exception counts", async () => {
  const queries: string[] = [];
  const logs: Record<string, unknown>[] = [];
  const control = {
    phase: "durable",
    source_digest: "retained",
    source_count: 9664,
  };
  const counts = [{ provenance: "capture", count: 7 }];
  const exceptions = [
    { disposition: "alias", count: 6 },
    { disposition: "archive", count: 6 },
  ];
  await inspectMatchPresentations({
    run: async (sql, database) => {
      queries.push(sql);
      assert.equal(database, "mons-link-profile-games");
      assert.match(sql, /^SELECT /);
      if (sql.includes("sqlite_master"))
        return [{ name: "match_presentation_source_exceptions" }];
      if (sql.includes("GROUP BY disposition")) return exceptions;
      return sql.includes("GROUP BY provenance") ? counts : [control];
    },
    log: (value) => logs.push(value),
  });
  assert.equal(queries.length, 4);
  assert.deepEqual(logs, [
    { operation: "status", control, counts, sourceExceptions: exceptions },
  ]);
});
test("appearance status rejects invalid authority without initializing any records", async () => {
  await assert.rejects(
    inspectMatchPresentations({
      run: async () => [{ phase: "invalid" }],
      log: () => assert.fail("unexpected success"),
    }),
    /control is unavailable/,
  );
});
