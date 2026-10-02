import assert from "node:assert/strict";
import test from "node:test";
import { inspectMatchDiscovery } from "./operator/inspect/matchDiscovery.ts";

test("discovery status reports retained authority and provenance counts without source reads", async () => {
  const queries: string[] = [];
  const logs: Record<string, unknown>[] = [];
  const control = {
    discovery_backend: "d1",
    capture_enforced: 1,
    source_digest: "retained",
  };
  const counts = [{ provenance: "capture", resolution: "resolved", count: 7 }];
  await inspectMatchDiscovery({
    run: async (sql, database) => {
      queries.push(sql);
      assert.equal(database, "mons-link-profile-games");
      assert.match(sql, /^SELECT /);
      return sql.includes("GROUP BY") ? counts : [control];
    },
    log: (value) => logs.push(value),
  });
  assert.equal(queries.length, 2);
  assert.deepEqual(logs, [{ operation: "status", control, counts }]);
});
test("discovery status fails closed on a missing control", async () => {
  await assert.rejects(
    inspectMatchDiscovery({
      run: async () => [],
      log: () => assert.fail("unexpected success"),
    }),
    /invalid discovery/,
  );
});
