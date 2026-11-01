import { createTimerHandle } from "./fixtures/timerHandle.mjs";
import { required } from "./fixtures/canonicalData.mjs";
import assert from "node:assert/strict";
import { registerTypeScriptTestHooks } from "./support/typescriptHooks.mjs";
import test from "node:test";
import { MATCH_SYNC_MAX_MESSAGE_BYTES } from "@mons/shared/match-sync";

registerTypeScriptTestHooks();

const { MatchSyncChannel } =
  await import("../src/connection/matchSyncChannel.ts");
const { MatchSyncApiError } = await import("../src/services/matchSyncApi.ts");
/** @param {"white" | "black"} color @param {Partial<import("@mons/shared/game-sessions").GameSessionMatch>} [changes] @returns {import("@mons/shared/game-sessions").GameSessionMatch} */
const match = (color, changes = {}) => ({
  schemaVersion: 1,
  version: 2,
  color,
  emojiId: 1,
  aura: "none",
  gameVariant: "Classic",
  fen: "initial",
  status: "active",
  flatMovesString: "",
  timer: { state: "idle" },
  ...changes,
});
/** @param {number} [revision] @param {Partial<import("@mons/shared/match-sync").MatchSyncSnapshot>} [changes] @returns {import("@mons/shared/match-sync").MatchSyncSnapshot} */
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
/** @param {number} [revision] @param {Partial<import("@mons/shared/match-sync").MatchSyncSnapshot>} [changes] @returns {import("@mons/shared/match-sync").ReadMatchSyncResponse} */
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
/**
 * @template [T=import("@mons/shared/match-sync").ReadMatchSyncResponse]
 * @returns {PromiseWithResolvers<T>}
 */
const deferred = () => {
  return Promise.withResolvers();
};

/**
 * @typedef {{
 *   url: string; protocols: string[] | undefined; readyState: 0 | 1 | 2 | 3;
 *   onopen: (() => void) | null; onmessage: ((event: {data: unknown}) => void) | null;
 *   onclose: (() => void) | null; onerror: (() => void) | null;
 *   closes: number; sent: Array<Parameters<WebSocket["send"]>[0]>;
 *   send(value: Parameters<WebSocket["send"]>[0]): void; close(): void;
 *   receive(value: unknown): void; fail(): void;
 * }} HarnessSocket
 */
/** @param {Partial<Pick<ConstructorParameters<typeof MatchSyncChannel>[0], "initialSnapshot" | "getProtocols" | "requiredPlayerIds" | "readMatches" | "onSnapshot">> & {online?: boolean; visible?: boolean; createError?: boolean; paired?: boolean}} [options] */
function harness({
  initialSnapshot,
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
  /**
   * @type {(() => void) | null}
   */
  let wake;
  /** @type {Map<ReturnType<typeof createTimerHandle>, { callback: () => void; at: number }>} */
  const timers = new Map();
  /** @type {HarnessSocket[]} */
  const sockets = [];
  /**
   * @type {import("@mons/shared/match-sync").MatchSyncSnapshot[]}
   */
  const snapshots = [];
  /** @type {Array<InstanceType<typeof MatchSyncApiError>>} */
  const errors = [];
  /**
   * @type {{ now: number; signal: AbortSignal; }[]}
   */
  const reads = [];
  const channel = new MatchSyncChannel({
    inviteId: "invite",
    ...(initialSnapshot === undefined ? {} : { initialSnapshot }),
    matchId: "invite",
    requiredPlayerIds,
    createSocket(url, protocols) {
      if (createError) throw new Error("secret-token-in-error");
      /** @type {HarnessSocket} */
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
    ...(getProtocols === undefined ? {} : { getProtocols }),
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
    onError: (error) => {
      assert.ok(error instanceof MatchSyncApiError);
      errors.push(error);
    },
    setTimer(callback, delayMs) {
      const id = createTimerHandle();
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
    setActive: (/** @type {boolean} */ value) => {
      active = value;
    },
    setOnline: (/** @type {boolean} */ value) => {
      online = value;
    },
    setVisible: (/** @type {boolean} */ value) => {
      visible = value;
    },
    elapseWithoutTimers: (/** @type {number} */ ms) => {
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
    required(h.sockets[0]).url,
    "wss://api.mons.link/invites/invite/matches/invite/socket",
  );
  assert.deepEqual(required(h.sockets[0]).protocols, [
    "mons-match-sync-v1",
    "mons-data-v1",
  ]);
  assert.deepEqual(h.snapshots[0], snapshot());
  required(h.sockets[0]).receive(frame(2));
  await h.tick(9_000);
  assert.equal(h.reads.length, 2);
  required(h.sockets[0]).fail();
  await flush();
  assert.equal(h.reads.length, 3);
  await h.tick(500);
  required(h.sockets[1]).receive(frame(3));
  await h.tick(2_000);
  assert.equal(h.reads.length, 3);
  h.channel.stop();
});

test("a complete bootstrap seed avoids initial HTTP and rejects older socket data", async () => {
  const h = harness({ initialSnapshot: snapshot(4) });
  await h.tick();
  assert.equal(h.reads.length, 0);
  assert.equal(h.snapshots.length, 0);
  required(h.sockets[0]).receive(frame(3));
  required(h.sockets[0]).receive(frame(4));
  await h.tick(5_000);
  assert.equal(h.reads.length, 0);
  assert.equal(h.snapshots.length, 0);
  required(h.sockets[0]).receive(frame(5));
  assert.equal(required(h.snapshots[0]).revision, 5);
  h.channel.stop();
});

test("seeded matches retain HTTP fallback for missing records, silent sockets, and failures", async () => {
  const missing = harness({
    initialSnapshot: snapshot(2, { guestMatch: null }),
  });
  await missing.tick();
  assert.equal(missing.reads.length, 1);
  missing.channel.stop();

  const silent = harness({ initialSnapshot: snapshot() });
  await silent.tick(999);
  assert.equal(silent.reads.length, 0);
  await silent.tick(1);
  assert.equal(silent.reads.length, 1);
  silent.channel.stop();

  const failed = harness({ initialSnapshot: snapshot() });
  await failed.tick();
  required(failed.sockets[0]).fail();
  await flush();
  assert.equal(failed.reads.length, 1);
  failed.channel.stop();
});

test("drops stale HTTP and duplicate or stale socket revisions without reversing a pair", async () => {
  const read = deferred();
  const h = harness({ readMatches: () => read.promise });
  await h.tick();
  const latest = snapshot(4, {
    hostMatch: match("white", { flatMovesString: "a-b" }),
    guestMatch: match("black", { status: "surrendered" }),
  });
  required(h.sockets[0]).receive({
    schemaVersion: 1,
    type: "snapshot",
    snapshot: latest,
  });
  read.resolve(response(3));
  await flush();
  required(h.sockets[0]).receive(frame(2));
  required(h.sockets[0]).receive(frame(4));
  assert.deepEqual(h.snapshots, [latest]);
  assert.equal(h.errors.length, 0);
  h.channel.stop();
});

test("coalesces pending reads and permits same-revision HTTP hydration after a required actor changes", async () => {
  const first = deferred();
  const second = deferred();
  const requiredPlayers = new Set(["host"]);
  let calls = 0;
  const h = harness({
    requiredPlayerIds: () => requiredPlayers,
    readMatches: () => (++calls === 1 ? first.promise : second.promise),
  });
  await h.tick();
  required(h.sockets[0]).receive(frame(2));
  requiredPlayers.add("guest");
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
  required(h.sockets[0]).receive(
    frame(1, { hostMatch: null, guestMatch: null }),
  );
  await flush();
  const initialReads = h.reads.length;
  await h.tick(2_000);
  assert.equal(h.reads.length, initialReads + 2);
  assert.equal(h.errors.length, 0);
  value = response(2, { guestMatch: null });
  await h.tick(1_000);
  assert.equal(required(required(h.snapshots.at(-1)).hostMatch).color, "white");
  assert.equal(required(h.snapshots.at(-1)).guestMatch, null);
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
  required(h.sockets[0]).receive(frame(2, emptyGuest));
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
  required(h.sockets[0]).receive(frame(2));
  h.setOnline(false);
  h.wake();
  assert.equal(required(h.sockets[0]).closes, 1);
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
  /** @type {Array<boolean>} */
  const refreshes = [];
  const h = harness({
    getProtocols: async (force) => {
      refreshes.push(force);
      return [
        "mons-match-sync-v1",
        "bearer.header.payload.signature",
        "mons-data-v1",
      ];
    },
  });
  await h.tick();
  required(h.sockets[0]).receive(frame(2));
  await h.tick(30_000);
  assert.deepEqual(required(h.sockets[0]).sent, ["ping"]);
  await h.tick(10_000);
  assert.equal(required(h.sockets[0]).closes, 1);
  await h.tick(500);
  assert.deepEqual(refreshes, [false, true]);
  assert.ok(h.reads.length > 1);
  required(h.sockets[1]).receive(frame(3));
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
    required(h.sockets[0]).receive(bad);
    assert.equal(h.snapshots.length, 0);
    assert.equal(required(h.sockets[0]).closes, 1);
    assert.equal(
      required(h.errors[0]).message,
      "match-sync-channel-unavailable",
    );
    h.channel.stop();
  }
});

test("stopping a context aborts reads and releases sockets, callbacks, timers and wake listeners", async () => {
  const request = deferred();
  const h = harness({ readMatches: () => request.promise });
  await h.tick();
  const socket = h.sockets[0];
  const lateMessage = required(socket).onmessage;
  const lateClose = required(socket).onclose;
  h.channel.stop();
  h.channel.stop();
  required(lateMessage)({ data: JSON.stringify(frame()) });
  required(lateClose)();
  request.resolve(response());
  await flush();
  assert.equal(h.snapshots.length, 0);
  assert.equal(h.errors.length, 0);
  assert.equal(required(h.reads[0]).signal.aborted, true);
  assert.equal(h.timers.size, 0);
  assert.equal(h.listenerCount(), 0);
  assert.equal(required(socket).closes, 1);
  assert.equal(required(socket).onmessage, null);
});

test("navigation inside pair delivery cannot revive timers or accept a late HTTP response", async () => {
  const request = deferred();
  /** @type {ReturnType<typeof harness> | undefined} */
  let h;
  h = harness({
    readMatches: () => request.promise,
    onSnapshot: () => required(h).channel.stop(),
  });
  await h.tick();
  required(h.sockets[0]).receive(frame(2));
  request.resolve(response(3));
  await flush();
  assert.equal(h.snapshots.length, 1);
  assert.equal(h.timers.size, 0);
  assert.equal(h.channel.signal.aborted, true);
});
