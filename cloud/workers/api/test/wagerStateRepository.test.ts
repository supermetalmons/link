import assert from "node:assert/strict";
import test from "node:test";
import type { FirebaseRtdbClient } from "../src/firebaseRtdb.ts";
import { createWagerStateRtdbClient } from "../src/wagerStateRepository.ts";

function createFixture() {
  let databaseAccesses = 0;
  const db = new Proxy({} as D1Database, {
    get() {
      databaseAccesses++;
      throw new Error("unexpected-database-access");
    },
  });
  const forwarded: unknown[] = [];
  const base: FirebaseRtdbClient = {
    async getPath(path, query) {
      forwarded.push({ path, query });
      return { firebase: true };
    },
    async patchRoot(updates) {
      forwarded.push(updates);
    },
    async transactPath(path) {
      forwarded.push(path);
      return { committed: false, value: null };
    },
  };
  return {
    client: createWagerStateRtdbClient(db, base),
    forwarded,
    databaseAccesses: () => databaseAccesses,
  };
}

test("rejects mutations spanning canonical wagers and Firebase before either store is touched", async () => {
  const fixture = createFixture();
  await assert.rejects(
    fixture.client.patchRoot({
      "invites/invite/wagers/match/agreed": { count: 1 },
      "players/host/matches/match/status": "ended",
    }),
    /mixed-wager-state-updates/,
  );
  await assert.rejects(
    fixture.client.patchRoot({
      "invites/invite/wagers/match": { agreed: { count: 1 } },
      "invites/invite/wagers/match/agreed": { count: 2 },
    }),
    /overlapping-wager-state-updates/,
  );
  await assert.rejects(
    fixture.client.patchRoot({
      "invites/invite/wagers/match": {},
      "/invites/invite/wagers/match/": {},
    }),
    /overlapping-wager-state-updates/,
  );
  assert.deepEqual(fixture.forwarded, []);
  assert.equal(fixture.databaseAccesses(), 0);
});

test("rejects ancestor overlaps hidden by a sibling regardless of input order", async () => {
  const fixture = createFixture();
  const parent = "invites/invite/wagers/m";
  const sibling = "invites/invite/wagers/m-foo";
  const child = "invites/invite/wagers/m/value";
  for (const paths of [
    [parent, sibling, child],
    [child, sibling, parent],
    [sibling, parent, child],
  ]) {
    await assert.rejects(
      fixture.client.patchRoot(
        Object.fromEntries(paths.map((path) => [path, { retained: true }])),
      ),
      /overlapping-wager-state-updates/,
    );
  }
  assert.equal(fixture.databaseAccesses(), 0);
  assert.deepEqual(fixture.forwarded, []);
});

test("allows shared string prefixes when no supplied path is an ancestor", async () => {
  const fixture = createFixture();
  const updates = {
    "players/host/matches/m-foo": { fen: "fen" },
    "players/host/matches/m/fen": "fen",
    "players/host/matches/m/status": "surrendered",
  };
  await fixture.client.patchRoot(updates);
  assert.deepEqual(fixture.forwarded, [updates]);
  assert.equal(fixture.databaseAccesses(), 0);
});

test("prevents whole-invite writes from replacing canonical wager data", async () => {
  const fixture = createFixture();
  for (const updates of [
    { invites: { invite: { hostId: "host" } } },
    { "invites/invite": null },
    { "invites/invite": { hostId: "host", wagers: {} } },
    { "invites/invite": { hostId: "host", matchesWagerResolutions: {} } },
  ]) {
    await assert.rejects(
      fixture.client.patchRoot(updates),
      /wager-state-.*write-unsupported/,
    );
  }
  await assert.rejects(
    fixture.client.transactPath("invites/invite", () => ({ value: {} })),
    /wager-state-ancestor-write-unsupported/,
  );
  assert.deepEqual(fixture.forwarded, []);
  assert.equal(fixture.databaseAccesses(), 0);
});

test("requires an admitted writer and rejects unsupported owned queries without Firebase fallback", async () => {
  const fixture = createFixture();
  await assert.rejects(
    fixture.client.transactPath("invites/invite/wagers/match", () => ({
      value: {},
    })),
    /wager-state-read-only/,
  );
  await assert.rejects(
    fixture.client.patchRoot({
      "invites/invite/matchesWagerResolutions/match": true,
    }),
    /wager-state-read-only/,
  );
  await assert.rejects(
    fixture.client.getPath("invites/invite/wagers", { orderBy: "$key" }),
    /wager-state-query-unsupported/,
  );
  assert.deepEqual(fixture.forwarded, []);
  assert.equal(fixture.databaseAccesses(), 0);
});

test("preserves Firebase-only gameplay updates and metadata replacements", async () => {
  const fixture = createFixture();
  const updates = {
    "invites/invite": { hostId: "host", guestId: "guest" },
    "players/guest/matches/match": { fen: "fen" },
    "gameplayMutationReceipts/operation": { completedAtMs: 1 },
  };
  await fixture.client.patchRoot(updates);
  assert.deepEqual(await fixture.client.getPath("players/host/matches/match"), {
    firebase: true,
  });
  await fixture.client.transactPath("matchTimerClaims/match", () => ({
    value: {},
  }));
  assert.deepEqual(fixture.forwarded, [
    updates,
    { path: "players/host/matches/match", query: undefined },
    "matchTimerClaims/match",
  ]);
  assert.equal(fixture.databaseAccesses(), 0);
});
