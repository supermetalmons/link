import assert from "node:assert/strict";
import test from "node:test";
import { createRematchHistory } from "../src/game/rematchHistory.ts";

const pair = (matchId = "match", emojiId = 1) => ({
  matchId,
  hostPlayerId: "host",
  guestPlayerId: "guest",
  hostMatch: { emojiId, aura: "", fen: "host-fen" },
  guestMatch: { emojiId: 2, aura: "", fen: "guest-fen" },
});

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const flush = () => new Promise((resolve) => setImmediate(resolve));

function harness(load = async (matchId) => pair(matchId)) {
  let now = 1000;
  let session = 0;
  let nextTimerId = 0;
  const reads = [];
  const timers = new Map();
  const history = createRematchHistory({
    loadMatchPair: (matchId) => {
      reads.push(matchId);
      return load(matchId);
    },
    scoreFromPair: (_matchId, value) => ({
      white: value.hostMatch.emojiId,
      black: 2,
    }),
    createSessionGuard: () => {
      const expected = session;
      return () => expected === session;
    },
    now: () => now,
    setTimeout: (callback, delay) => {
      const id = ++nextTimerId;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
  });
  return {
    history,
    reads,
    timers,
    advance: (ms) => {
      now += ms;
    },
    invalidateSession: () => {
      session++;
    },
    runTimer: async () => {
      const [id, timer] = timers.entries().next().value;
      timers.delete(id);
      timer.callback();
      await flush();
    },
  };
}

test("authoritative history replaces provisional data and remains cached", async () => {
  const archived = pair("match", 7);
  const h = harness(async () => archived);
  h.history.seedProvisional(pair());
  assert.equal(h.history.isProvisional("match"), true);
  assert.equal(await h.history.load("match"), archived);
  assert.equal(h.history.isProvisional("match"), false);
  assert.deepEqual(h.history.getScore("match"), { white: 7, black: 2 });

  h.history.seedProvisional(pair("match", 9));
  assert.equal(await h.history.load("match"), archived);
  assert.deepEqual(h.reads, ["match"]);
  assert.equal(h.history.setScore("match", { white: 7, black: 2 }), false);
  h.history.deleteScore("match");
  assert.equal(h.history.getScore("match"), undefined);
});

test("archive misses retain provisional history, expire after 3 seconds, and allow forced reads", async () => {
  const h = harness(async () => {
    throw new Error("unavailable");
  });
  const seed = pair();
  h.history.seedProvisional(seed);
  assert.equal(await h.history.load("match"), seed);
  h.advance(2999);
  assert.equal(h.history.hasRecentMiss("match"), true);
  assert.equal(await h.history.load("match"), seed);
  assert.equal(h.reads.length, 1);
  h.advance(1);
  assert.equal(h.history.hasRecentMiss("match"), false);
  assert.equal(await h.history.load("match"), seed);
  assert.equal(h.reads.length, 2);
  assert.equal(await h.history.load("match", { forceRefresh: true }), seed);
  assert.equal(h.reads.length, 3);
  assert.equal(await h.history.load("missing"), null);
  assert.equal(await h.history.load("missing"), null);
  assert.equal(h.reads.length, 4);
});

test("archive refresh uses existing delays and stops after authoritative data arrives", async () => {
  let archived = null;
  const h = harness(async () => archived);
  const refreshed = [];
  const errors = [];
  h.history.seedProvisional(pair());
  h.history.refreshArchive("match", {
    isCurrent: () => true,
    onRefresh: (value) => refreshed.push(value),
    onError: (error) => errors.push(error),
  });
  assert.equal([...h.timers.values()][0].delay, 250);
  await h.runTimer();
  assert.equal([...h.timers.values()][0].delay, 3000);
  archived = pair("match", 7);
  await h.runTimer();
  assert.deepEqual(refreshed, [archived]);
  assert.deepEqual(errors, []);
  assert.equal(h.timers.size, 0);
});

test("reset alone cancels queued refreshes and rejects in-flight archive results", async () => {
  const pending = deferred();
  const h = harness(() => pending.promise);
  const refreshed = [];
  h.history.seedProvisional(pair());
  h.history.setScore("match", { white: 3, black: 4 });
  const options = {
    isCurrent: () => true,
    onRefresh: (value) => refreshed.push(value),
    onError: assert.fail,
  };
  h.history.refreshArchive("match", options);
  await h.runTimer();
  h.history.refreshArchive("match", options);
  const queued = [...h.timers.values()][0];
  h.history.reset();
  assert.equal(h.timers.size, 0);
  queued.callback();
  pending.resolve(pair("match", 7));
  await flush();
  assert.equal(h.reads.length, 1);
  assert.deepEqual(refreshed, []);
  assert.equal(h.history.getCachedPair("match"), null);
  assert.equal(h.history.getScore("match"), undefined);
  assert.equal(h.history.isProvisional("match"), false);
  assert.equal(h.history.hasRecentMiss("match"), false);
  assert.equal(h.timers.size, 0);
});

test("score prefetch shares identical requests and limits work to two concurrent loads", async () => {
  const pending = new Map();
  const h = harness((matchId) => {
    const request = deferred();
    pending.set(matchId, request);
    return request.promise;
  });
  let changed = 0;
  const onChange = () => changed++;
  h.history.setScore("cached", { white: 9, black: 2 });
  const ids = ["a", "b", "cached", "c"];
  const prefetch = h.history.prefetchScores("live", ids, onChange);
  assert.equal(h.history.prefetchScores("live", ids, onChange), prefetch);
  assert.deepEqual(h.reads, ["a", "b"]);
  pending.get("a").resolve(pair("a", 3));
  await flush();
  assert.deepEqual(h.reads, ["a", "b", "c"]);
  assert.equal(changed, 1);
  pending.get("b").resolve(pair("b", 4));
  pending.get("c").resolve(pair("c", 5));
  assert.equal(await prefetch, true);
  assert.equal(changed, 3);
  assert.deepEqual(h.history.getScore("c"), { white: 5, black: 2 });
  assert.equal(await h.history.prefetchScores("live", ids, onChange), false);
  assert.equal(h.reads.length, 3);
});

test("a previous prefetch finishing cannot release a newer request's deduplication", async () => {
  const older = deferred();
  const newer = deferred();
  const h = harness((matchId) =>
    matchId === "a" ? older.promise : newer.promise,
  );
  const onChange = () => {};
  const first = h.history.prefetchScores("live-a", ["a"], onChange);
  const second = h.history.prefetchScores("live-b", ["b"], onChange);
  older.resolve(pair("a"));
  assert.equal(await first, true);
  assert.equal(h.history.prefetchScores("live-b", ["b"], onChange), second);
  assert.deepEqual(h.reads, ["a", "b"]);
  newer.resolve(pair("b"));
  assert.equal(await second, true);
});

test("reset stops old prefetch workers and preserves a new request with the same signature", async () => {
  const requests = [];
  const h = harness(() => {
    const request = deferred();
    requests.push(request);
    return request.promise;
  });
  let changed = 0;
  const onChange = () => changed++;
  const ids = ["a", "b", "c"];
  const old = h.history.prefetchScores("live", ids, onChange);
  h.history.reset();
  const current = h.history.prefetchScores("live", ids, onChange);
  requests[0].resolve(pair("a", 10));
  requests[1].resolve(pair("b", 10));
  assert.equal(await old, false);
  assert.equal(changed, 0);
  assert.equal(h.history.getScore("a"), undefined);
  assert.equal(h.history.prefetchScores("live", ids, onChange), current);
  assert.deepEqual(h.reads, ["a", "b", "a", "b"]);
  requests[2].resolve(pair("a", 3));
  requests[3].resolve(pair("b", 4));
  await flush();
  assert.deepEqual(h.reads, ["a", "b", "a", "b", "c"]);
  requests[4].resolve(pair("c", 5));
  assert.equal(await current, true);
  assert.equal(changed, 3);
});

test("session invalidation stops score prefetch even without a cache reset", async () => {
  const pending = deferred();
  const h = harness(() => pending.promise);
  const prefetch = h.history.prefetchScores(
    "live",
    ["a", "b", "c"],
    assert.fail,
  );
  h.invalidateSession();
  pending.resolve(pair());
  assert.equal(await prefetch, false);
  assert.deepEqual(h.reads, ["a", "b"]);
  assert.equal(h.history.getScore("a"), undefined);
});

test("score prefetch can use provisional gameplay while archival is unavailable", async () => {
  const h = harness(async () => null);
  h.history.seedProvisional(pair("a", 5));
  let changed = 0;
  assert.equal(
    await h.history.prefetchScores("live", ["a"], () => changed++),
    true,
  );
  assert.equal(changed, 1);
  assert.equal(h.history.isProvisional("a"), true);
  assert.deepEqual(h.history.getScore("a"), { white: 5, black: 2 });
});
