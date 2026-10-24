import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_LOGIN_MATCH_DISCOVERY_READS,
  readResolvedLoginMatchInviteId,
  readResolvedLoginMatchInviteIds,
} from "../src/loginMatchDiscoveryD1.ts";

type Key = { loginUid: string; matchId: string };

function fixture(
  result: (keys: Key[]) => unknown | Promise<unknown> = (keys) =>
    keys.map(({ matchId }) => ({
      success: true,
      results: [{ invite_id: matchId, resolution: "resolved" }],
    })),
) {
  const stats = { sessions: 0, batches: [] as Key[][], scalarReads: 0 };
  const db = {
    withSession(constraint: string) {
      assert.equal(constraint, "first-primary");
      stats.sessions++;
      return {
        prepare(sql: string) {
          assert.equal(
            sql,
            "SELECT invite_id, resolution FROM login_match_discovery WHERE login_uid = ? AND match_id = ?",
          );
          return {
            bind(loginUid: string, matchId: string) {
              return {
                key: { loginUid, matchId },
                async first() {
                  stats.scalarReads++;
                  return { invite_id: "scalar-invite", resolution: "resolved" };
                },
              };
            },
          };
        },
        async batch(statements: Array<{ key: Key }>) {
          const keys = statements.map(({ key }) => key);
          stats.batches.push(keys);
          return result(keys);
        },
      };
    },
  } as unknown as D1Database;
  return { db, stats };
}

test("batch reads preserve input order, duplicate positions, and unresolved nulls", async () => {
  const rows = [
    { invite_id: "invite-b", resolution: "resolved" },
    null,
    { invite_id: null, resolution: "ambiguous" },
    { invite_id: null, resolution: "missing" },
    { invite_id: "invite-b", resolution: "resolved" },
  ];
  const { db, stats } = fixture(() =>
    rows.map((row) => ({ success: true, results: row ? [row] : [] })),
  );
  const inputs = ["b", "absent", "ambiguous", "missing", "b"].map(
    (matchId) => ({ loginUid: "host", matchId }),
  );
  assert.deepEqual(await readResolvedLoginMatchInviteIds(db, inputs), [
    "invite-b",
    null,
    null,
    null,
    "invite-b",
  ]);
  assert.deepEqual(stats.batches, [inputs]);
  assert.equal(stats.sessions, 1);
  assert.equal(stats.scalarReads, 0);
});

test("empty, invalid, oversized, and pre-aborted batches do no database work", async () => {
  const { db, stats } = fixture();
  assert.deepEqual(await readResolvedLoginMatchInviteIds(db, []), []);
  const valid = { loginUid: "host", matchId: "match" };
  for (const inputs of [
    [valid, { ...valid, loginUid: " bad" }],
    [valid, { ...valid, matchId: "bad/key" }],
    Array.from({ length: MAX_LOGIN_MATCH_DISCOVERY_READS + 1 }, () => valid),
  ]) {
    await assert.rejects(
      readResolvedLoginMatchInviteIds(db, inputs),
      TypeError,
    );
  }
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    readResolvedLoginMatchInviteIds(db, [valid], controller.signal),
    { name: "AbortError" },
  );
  assert.equal(stats.sessions, 0);
  assert.deepEqual(stats.batches, []);
});

test("batch reads fail closed on failed, incomplete, or corrupt results", async () => {
  const row = { invite_id: "invite", resolution: "resolved" };
  for (const result of [
    null,
    [],
    [undefined],
    [{ success: false, results: [] }],
    [{ success: true }],
    [{ success: true, results: {} }],
    [{ success: true, results: [row, row] }],
    [{ success: true, results: [null] }],
    [{ success: true, results: [{ ...row, resolution: "unknown" }] }],
    [{ success: true, results: [{ ...row, invite_id: null }] }],
    [{ success: true, results: [{ ...row, invite_id: "bad/key" }] }],
    [{ success: true, results: [{ ...row, resolution: "missing" }] }],
  ]) {
    const { db } = fixture(() => result);
    await assert.rejects(
      readResolvedLoginMatchInviteIds(db, [{ loginUid: "host", matchId: "a" }]),
    );
  }
});

test("cancellation after a batch read rejects its results", async () => {
  const controller = new AbortController();
  const { db, stats } = fixture(() => {
    controller.abort();
    return [{ success: true, results: [] }];
  });
  await assert.rejects(
    readResolvedLoginMatchInviteIds(
      db,
      [{ loginUid: "host", matchId: "a" }],
      controller.signal,
    ),
    { name: "AbortError" },
  );
  assert.equal(stats.batches.length, 1);
});

test("scalar reads retain their primary first call without batching", async () => {
  const { db, stats } = fixture();
  assert.equal(
    await readResolvedLoginMatchInviteId(db, "host", "match"),
    "scalar-invite",
  );
  assert.equal(stats.sessions, 1);
  assert.equal(stats.scalarReads, 1);
  assert.deepEqual(stats.batches, []);
});
