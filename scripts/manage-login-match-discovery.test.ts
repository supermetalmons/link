import assert from "node:assert/strict";
import test from "node:test";
import {
  parseArgs,
  execute,
  manageLoginMatchDiscovery,
} from "./manage-login-match-discovery.ts";
test("retired commands reject before credentials or provider requests", async (t) => {
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => {
    requests++;
    throw new Error("unexpected provider request");
  });
  for (const flag of [
    "--preflight",
    "--export",
    "--import",
    "--verify",
    "--activate",
  ]) {
    assert.throws(() => parseArgs([flag]), /retired/);
    await assert.rejects(execute([flag]), /retired/);
  }
  assert.equal(requests, 0);
  assert.deepEqual(parseArgs(["--status"]).operation, "status");
  assert.throws(() =>
    parseArgs(["--status", "--firebase-credentials", "/missing"]),
  );
});
test("discovery status reports retained authority and provenance counts without source reads", async () => {
  const queries: string[] = [];
  const logs: Record<string, unknown>[] = [];
  const control = {
    discovery_backend: "d1",
    capture_enforced: 1,
    source_digest: "retained",
  };
  const counts = [{ provenance: "capture", resolution: "resolved", count: 7 }];
  await manageLoginMatchDiscovery(parseArgs(["--status"]), {
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
    manageLoginMatchDiscovery(parseArgs(["--status"]), {
      run: async () => [],
      log: () => assert.fail("unexpected success"),
    }),
    /invalid discovery/,
  );
});
