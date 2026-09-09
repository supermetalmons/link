import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { MATCH_SYNC_MAX_MESSAGE_BYTES } from "@mons/shared/match-sync";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      context.parentURL?.endsWith(".ts") &&
      (specifier.startsWith("./") || specifier.startsWith("../")) &&
      !/\.[^/]+$/.test(specifier)
    ) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});

const { MatchSyncChannel } =
  await import("../src/connection/matchSyncChannel.ts");
const { MatchSyncApiError } = await import("../src/services/matchSyncApi.ts");
const match = (color, changes = {}) => ({
  version: 2,
  color,
  emojiId: 1,
  aura: "",
  gameVariant: "Classic",
  fen: "initial",
  status: "",
  flatMovesString: "",
  timer: "",
  ...changes,
});
const snapshot = (revision = 1, changes = {}) => ({
  inviteId: "invite",
  matchId: "invite",
  revision,
  hostPlayerId: "host",
  guestPlayerId: "guest",
  hostMatch: match("white"),
  guestMatch: match("black"),
  ...changes,
});
const response = (revision = 1, changes = {}) => ({
  ok: true,
  snapshot: snapshot(revision, changes),
});
const frame = (revision = 1, changes = {}) => ({
  schemaVersion: 1,
  type: "snapshot",
  snapshot: snapshot(revision, changes),
});
const flush = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

function harness({
  getProtocols,
  requiredPlayerIds = () => ["host", "guest"],
  readMatches = async () => response(),
  createError = false,
  onSnapshot,
  online = true,
  visible = true,
} = {}) {
  let now = 0;
  let active = true;
  let nextTimer = 1;
  let wake;
  const timers = new Map();
  const sockets = [];
  const snapshots = [];
  const errors = [];
  const reads = [];
  const channel = new MatchSyncChannel({
    inviteId: "invite",
    matchId: "invite",
    requiredPlayerIds,
    createSocket(url, protocols) {
      if (createError) throw new Error("secret-token-in-error");
      const socket = {
        url,
        protocols,
        readyState: 0,
        onopen: null,
        onmessage: null,
        onclose: null,
        onerror: null,
        closes: 0,
        sent: [],
        send(value) {
          this.sent.push(value);
        },
        close() {
          this.closes++;
          this.readyState = 3;
        },
        receive(value) {
          this.readyState = 1;
          this.onmessage?.({
            data: typeof value === "string" ? value : JSON.stringify(value),
          });
        },
        fail() {
          this.readyState = 3;
          this.onclose?.();
        },
      };
      sockets.push(socket);
      return socket;
    },
    getProtocols,
    readMatches(signal) {
      reads.push({ now, signal });
      return readMatches(signal);
    },
    isActive: () => active,
    isOnline: () => online,
    isVisible: () => visible,
    addWakeListener(listener) {
      wake = listener;
      return () => {
        wake = null;
      };
    },
    onSnapshot(value) {
      snapshots.push(value);
      onSnapshot?.(value);
    },
    onError: (error) => errors.push(error),
    setTimer(callback, delayMs) {
      const id = nextTimer++;
      timers.set(id, { callback, at: now + delayMs });
      return id;
    },
    clearTimer: (timer) => timers.delete(timer),
    random: () => 1,
    now: () => now,
  });
  return {
    channel,
    timers,
    sockets,
    snapshots,
    errors,
    reads,
    wake: () => wake?.(),
    listenerCount: () => (wake ? 1 : 0),
    setActive: (value) => {
      active = value;
    },
    setOnline: (value) => {
      online = value;
    },
    setVisible: (value) => {
      visible = value;
    },
    elapseWithoutTimers: (ms) => {
      now += ms;
    },
    async tick(ms = 0) {
      const end = now + ms;
      await flush();
      while (true) {
        const entry = [...timers.entries()].sort(
          (a, b) => a[1].at - b[1].at,
        )[0];
        if (!entry || entry[1].at > end) break;
        const [id, timer] = entry;
        timers.delete(id);
        now = timer.at;
        timer.callback();
        await flush();
      }
      now = end;
    },
  };
}

test("hydrates one pair through Cloudflare and polls each second until a socket snapshot arrives", async () => {
  const h = harness();
  assert.equal(h.reads.length, 0);
  await h.tick(1_000);
  assert.deepEqual(
    h.reads.map((read) => read.now),
    [0, 1_000],
  );
  assert.equal(
    h.sockets[0].url,
    "wss://api.mons.link/invites/invite/matches/invite/socket",
  );
  assert.deepEqual(h.sockets[0].protocols, ["mons-match-sync-v1"]);
  assert.deepEqual(h.snapshots[0], snapshot());
  h.sockets[0].receive(frame(2));
  await h.tick(9_000);
  assert.equal(h.reads.length, 2);
  h.sockets[0].fail();
  await flush();
  assert.equal(h.reads.length, 3);
  await h.tick(500);
  h.sockets[1].receive(frame(3));
  await h.tick(2_000);
  assert.equal(h.reads.length, 3);
  h.channel.stop();
});

test("drops stale HTTP and duplicate or stale socket revisions without reversing a pair", async () => {
  const read = deferred();
  const h = harness({ readMatches: () => read.promise });
  await h.tick();
  const latest = snapshot(4, {
    hostMatch: match("white", { flatMovesString: "a-b" }),
    guestMatch: match("black", { status: "surrendered" }),
  });
  h.sockets[0].receive({
    schemaVersion: 1,
    type: "snapshot",
    snapshot: latest,
  });
  read.resolve(response(3));
  await flush();
  h.sockets[0].receive(frame(2));
  h.sockets[0].receive(frame(4));
  assert.deepEqual(h.snapshots, [latest]);
  assert.equal(h.errors.length, 0);
  h.channel.stop();
});

test("coalesces pending reads and permits same-revision HTTP hydration after a required actor changes", async () => {
  const first = deferred();
  const second = deferred();
  const required = new Set(["host"]);
  let calls = 0;
  const h = harness({
    requiredPlayerIds: () => required,
    readMatches: () => (++calls === 1 ? first.promise : second.promise),
  });
  await h.tick();
  h.sockets[0].receive(frame(2));
  required.add("guest");
  for (let index = 0; index < 10; index++) h.channel.refresh();
  assert.equal(calls, 1);
  first.resolve(response(1));
  await flush();
  assert.equal(calls, 2);
  second.resolve(response(2));
  await flush();
  assert.deepEqual(
    h.snapshots.map((value) => value.revision),
    [2, 2],
  );
  h.channel.stop();
});

test("keeps one-second recovery for expected missing records even with a healthy socket", async () => {
  let value = response(1, { hostMatch: null, guestMatch: null });
  const h = harness({ readMatches: async () => value });
  await h.tick();
  h.sockets[0].receive(frame(1, { hostMatch: null, guestMatch: null }));
  await flush();
  const initialReads = h.reads.length;
  await h.tick(2_000);
  assert.equal(h.reads.length, initialReads + 2);
  assert.equal(h.errors.length, 0);
  value = response(2, { guestMatch: null });
  await h.tick(1_000);
  assert.equal(h.snapshots.at(-1).hostMatch.color, "white");
  assert.equal(h.snapshots.at(-1).guestMatch, null);
  value = response(3);
  await h.tick(1_000);
  const completedReads = h.reads.length;
  await h.tick(2_000);
  assert.equal(h.reads.length, completedReads);
  assert.deepEqual(h.snapshots.at(-1), snapshot(3));
  h.channel.stop();
});

test("an unjoined lobby does not poll for a guest without an ID", async () => {
  const emptyGuest = { guestPlayerId: null, guestMatch: null };
  const h = harness({
    requiredPlayerIds: () => ["host"],
    readMatches: async () => response(1, emptyGuest),
  });
  await h.tick();
  h.sockets[0].receive(frame(2, emptyGuest));
  await h.tick(3_000);
  assert.equal(h.reads.length, 1);
  assert.equal(h.errors.length, 0);
  h.channel.stop();
});

test("preserves HTTP failure backoff and Retry-After despite rapid socket retries", async () => {
  let attempts = 0;
  const h = harness({
    createError: true,
    readMatches: async () => {
      attempts++;
      throw new MatchSyncApiError("http-429", 429, attempts === 1 ? 20_000 : 0);
    },
  });
  await h.tick(19_999);
  h.wake();
  await flush();
  assert.deepEqual(
    h.reads.map((read) => read.now),
    [0],
  );
  await h.tick(10_001);
  assert.deepEqual(
    h.reads.map((read) => read.now),
    [0, 20_000, 30_000],
  );
  h.channel.stop();
});

test("hidden and offline pages stop repeated fallback and recover immediately when visible and online", async () => {
  const h = harness();
  await h.tick();
  h.setVisible(false);
  h.wake();
  await h.tick(3_000);
  assert.equal(h.reads.length, 1);
  h.setVisible(true);
  h.wake();
  await flush();
  assert.equal(h.reads.length, 2);
  h.sockets[0].receive(frame(2));
  h.setOnline(false);
  h.wake();
  assert.equal(h.sockets[0].closes, 1);
  await h.tick(3_000);
  assert.equal(h.reads.length, 2);
  h.setOnline(true);
  h.wake();
  await h.tick();
  assert.equal(h.reads.length, 3);
  assert.equal(h.sockets.length, 2);
  h.channel.stop();
});

test("refreshes socket authentication on reconnect and recovers if a heartbeat expires", async () => {
  const refreshes = [];
  const h = harness({
    getProtocols: async (force) => {
      refreshes.push(force);
      return ["mons-match-sync-v1", "bearer.header.payload.signature"];
    },
  });
  await h.tick();
  h.sockets[0].receive(frame(2));
  await h.tick(30_000);
  assert.deepEqual(h.sockets[0].sent, ["ping"]);
  await h.tick(10_000);
  assert.equal(h.sockets[0].closes, 1);
  await h.tick(500);
  assert.deepEqual(refreshes, [false, true]);
  assert.ok(h.reads.length > 1);
  h.sockets[1].receive(frame(3));
  h.channel.stop();
});

test("rejects foreign, malformed, private and oversized frames", async () => {
  for (const bad of [
    "bad json",
    "x".repeat(MATCH_SYNC_MAX_MESSAGE_BYTES + 1),
    frame(1, { inviteId: "other", matchId: "other" }),
    frame(1, { matchId: "invite1" }),
    frame(1, { hostMatch: { ...match("white"), sessionCreation: {} } }),
    frame(1, { guestPlayerId: null }),
    { ...frame(), viewer: { actorUid: "host" } },
    { ...frame(), schemaVersion: 2 },
  ]) {
    const h = harness({ readMatches: () => new Promise(() => {}) });
    await h.tick();
    h.sockets[0].receive(bad);
    assert.equal(h.snapshots.length, 0);
    assert.equal(h.sockets[0].closes, 1);
    assert.equal(h.errors[0].message, "match-sync-channel-unavailable");
    h.channel.stop();
  }
});

test("stopping a context aborts reads and releases sockets, callbacks, timers and wake listeners", async () => {
  const request = deferred();
  const h = harness({ readMatches: () => request.promise });
  await h.tick();
  const socket = h.sockets[0];
  const lateMessage = socket.onmessage;
  const lateClose = socket.onclose;
  h.channel.stop();
  h.channel.stop();
  lateMessage({ data: JSON.stringify(frame()) });
  lateClose();
  request.resolve(response());
  await flush();
  assert.equal(h.snapshots.length, 0);
  assert.equal(h.errors.length, 0);
  assert.equal(h.reads[0].signal.aborted, true);
  assert.equal(h.timers.size, 0);
  assert.equal(h.listenerCount(), 0);
  assert.equal(socket.closes, 1);
  assert.equal(socket.onmessage, null);
});

test("navigation inside pair delivery cannot revive timers or accept a late HTTP response", async () => {
  const request = deferred();
  let h;
  h = harness({
    readMatches: () => request.promise,
    onSnapshot: () => h.channel.stop(),
  });
  await h.tick();
  h.sockets[0].receive(frame(2));
  request.resolve(response(3));
  await flush();
  assert.equal(h.snapshots.length, 1);
  assert.equal(h.timers.size, 0);
  assert.equal(h.channel.signal.aborted, true);
});
