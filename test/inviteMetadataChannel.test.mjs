import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { INVITE_METADATA_MAX_MESSAGE_BYTES } from "@mons/shared/invite-metadata";

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

const { InviteMetadataChannel } =
  await import("../src/connection/inviteMetadataChannel.ts");
const { InviteMetadataApiError } =
  await import("../src/services/inviteMetadataApi.ts");
const snapshot = (revision = 1, changes = {}) => ({
  inviteId: "invite",
  revision,
  hostId: "host",
  guestId: null,
  hostColor: "white",
  hostRematches: "",
  guestRematches: "",
  automatchStateHint: null,
  eventId: null,
  eventOwned: false,
  ...changes,
});
const response = (revision = 1, changes = {}, viewer = {}) => ({
  ok: true,
  snapshot: snapshot(revision, changes),
  viewer: {
    role: "host",
    actorUid: "host",
    automatchOperationId: null,
    ...viewer,
  },
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
  readMetadata = async () => response(),
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
  const channel = new InviteMetadataChannel({
    inviteId: "invite",
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
    readMetadata(signal) {
      reads.push({ now, signal });
      return readMetadata(signal);
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
    onSnapshot(value, viewer) {
      snapshots.push({ snapshot: value, viewer });
      onSnapshot?.(value, viewer);
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

test("starts pending-lobby HTTP and metadata sockets asynchronously and delivers equal-revision viewers", async () => {
  const h = harness();
  assert.equal(h.reads.length, 0);
  assert.equal(h.snapshots.length, 0);
  await h.tick();
  assert.equal(h.reads.length, 1);
  assert.deepEqual(h.sockets[0].protocols, ["mons-invite-metadata-v1"]);
  assert.equal(
    h.sockets[0].url,
    "wss://api.mons.link/invites/invite/metadata/socket",
  );
  h.sockets[0].receive(frame());
  assert.equal(h.snapshots.length, 1);
  h.channel.requestRefresh();
  await flush();
  assert.equal(h.snapshots.length, 2);
  assert.deepEqual(h.snapshots[1].viewer, response().viewer);
  await h.tick(5_000);
  assert.equal(h.reads.length, 2);
  h.channel.stop();
});

test("coalesces reads while retaining a refresh requested during a read", async () => {
  const first = deferred();
  const second = deferred();
  let calls = 0;
  const h = harness({
    readMetadata: () => (++calls === 1 ? first.promise : second.promise),
  });
  await h.tick();
  for (let i = 0; i < 10; i++) h.channel.requestRefresh();
  assert.equal(calls, 1);
  first.resolve(response());
  await flush();
  assert.equal(calls, 2);
  second.resolve(response(2, { guestId: "guest" }));
  await flush();
  assert.equal(h.snapshots.at(-1).snapshot.guestId, "guest");
  assert.equal(calls, 2);
  h.channel.stop();
});

test("drops stale HTTP and socket snapshots while preserving newer full metadata", async () => {
  const read = deferred();
  const h = harness({ readMetadata: () => read.promise });
  await h.tick();
  h.sockets[0].receive(
    frame(3, { guestId: "guest", hostRematches: "1;2", guestRematches: "1;2" }),
  );
  read.resolve(response(2));
  await flush();
  h.sockets[0].receive(frame(1));
  assert.equal(h.snapshots.length, 1);
  assert.equal(h.snapshots[0].snapshot.revision, 3);
  assert.equal(h.errors.length, 0);
  h.channel.stop();
});

test("fallback reads every five seconds only until a valid socket snapshot", async () => {
  const h = harness();
  await h.tick(5_000);
  assert.deepEqual(
    h.reads.map((read) => read.now),
    [0, 5_000],
  );
  h.sockets[0].receive(frame(2));
  await h.tick(10_000);
  assert.equal(h.reads.length, 2);
  h.sockets[0].fail();
  await flush();
  assert.equal(h.reads.length, 3);
  await h.tick(500);
  h.sockets[1].receive(frame(2));
  await h.tick(5_000);
  assert.equal(h.reads.length, 3);
  h.channel.stop();
});

test("backs off failing HTTP reads through 5/10/20/30 seconds despite faster socket retries", async () => {
  const h = harness({
    createError: true,
    readMetadata: async () => {
      throw new InviteMetadataApiError("http-503", 503);
    },
  });
  await h.tick(65_000);
  assert.deepEqual(
    h.reads.map((read) => read.now),
    [0, 5_000, 15_000, 35_000, 65_000],
  );
  assert.ok(h.errors.some((error) => error.code === "http-503"));
  h.channel.stop();
});

test("honors Retry-After across wake and reconnect then resumes ordinary recovery", async () => {
  let calls = 0;
  const h = harness({
    createError: true,
    readMetadata: async () => {
      if (++calls === 1)
        throw new InviteMetadataApiError("http-429", 429, 60_000);
      return response(2);
    },
  });
  await h.tick(5_000);
  h.wake();
  h.channel.requestRefresh();
  await h.tick(54_999);
  assert.equal(h.reads.length, 1);
  await h.tick(1);
  assert.equal(h.reads.length, 2);
  assert.equal(h.snapshots[0].snapshot.revision, 2);
  h.channel.stop();
});

test("hidden and offline pages suspend fallback and wake refreshes even a healthy socket", async () => {
  const h = harness();
  await h.tick();
  h.sockets[0].receive(frame());
  h.wake();
  await flush();
  assert.equal(h.reads.length, 2);
  h.setVisible(false);
  h.wake();
  h.sockets[0].fail();
  await flush();
  const before = h.reads.length;
  await h.tick(35_000);
  assert.equal(h.reads.length, before);
  h.setOnline(false);
  h.wake();
  assert.equal(h.timers.size, 0);
  await h.tick(30_000);
  assert.equal(h.reads.length, before);
  h.setOnline(true);
  h.setVisible(true);
  h.wake();
  await h.tick();
  assert.equal(h.reads.length, before + 1);
  h.channel.stop();
});

test("reconnects with refreshed auth and bounds token acquisition plus initial snapshot to ten seconds", async () => {
  const first = deferred();
  const refreshes = [];
  const h = harness({
    getProtocols: (force) => {
      refreshes.push(force);
      return refreshes.length === 1
        ? first.promise
        : Promise.resolve([
            "mons-invite-metadata-v1",
            "bearer.fresh.payload.signature",
          ]);
    },
  });
  await h.tick(10_000);
  assert.equal(h.sockets.length, 0);
  await h.tick(500);
  assert.deepEqual(refreshes, [false, true]);
  assert.equal(h.sockets.length, 1);
  first.resolve(["mons-invite-metadata-v1", "bearer.stale.payload.signature"]);
  await flush();
  assert.equal(h.sockets.length, 1);
  h.sockets[0].receive(frame());
  assert.equal(
    h.errors.filter((error) => error.code === "metadata-channel-unavailable")
      .length,
    1,
  );
  h.channel.stop();
});

test("heartbeats ping every thirty seconds, require pong within ten and recover with HTTP", async () => {
  const h = harness();
  await h.tick();
  const socket = h.sockets[0];
  socket.receive(frame());
  await h.tick(30_000);
  assert.deepEqual(socket.sent, ["ping"]);
  socket.receive("pong");
  await h.tick(30_000);
  assert.deepEqual(socket.sent, ["ping", "ping"]);
  socket.receive(frame(2));
  await h.tick(10_000);
  assert.equal(socket.closes, 1);
  assert.equal(h.reads.length, 2);
  h.channel.stop();
});

test("rejects a first snapshot received after its deadline before delayed timeout callbacks", async () => {
  const h = harness({ readMetadata: () => new Promise(() => {}) });
  await h.tick();
  h.elapseWithoutTimers(10_000);
  h.sockets[0].receive(frame());
  assert.equal(h.snapshots.length, 0);
  assert.equal(h.sockets[0].closes, 1);
  assert.equal(h.errors[0].code, "metadata-channel-unavailable");
  h.channel.stop();
});

test("rejects malformed, oversized, foreign and caller-specific frames without exposing native errors", async () => {
  for (const bad of [
    "bad json",
    "x".repeat(INVITE_METADATA_MAX_MESSAGE_BYTES + 1),
    frame(1, { inviteId: "other" }),
    { ...frame(), viewer: response().viewer },
    { ...frame(), schemaVersion: 2 },
  ]) {
    const h = harness({ readMetadata: () => new Promise(() => {}) });
    await h.tick();
    h.sockets[0].receive(bad);
    assert.equal(h.snapshots.length, 0);
    assert.equal(h.sockets[0].closes, 1);
    assert.equal(h.errors[0].message, "metadata-channel-unavailable");
    h.channel.stop();
  }
  const h = harness({
    getProtocols: () => Promise.reject(new Error("secret-bearer-token")),
  });
  await h.tick();
  assert.equal(h.errors[0].message, "metadata-channel-unavailable");
  h.channel.stop();
});

test("context replacement or stop releases requests, callbacks, sockets, timers and listeners", async () => {
  for (const invalidate of [
    (h) => h.channel.stop(),
    (h) => h.setActive(false),
  ]) {
    const request = deferred();
    const h = harness({ readMetadata: () => request.promise });
    await h.tick();
    const socket = h.sockets[0];
    const lateMessage = socket.onmessage;
    const lateClose = socket.onclose;
    invalidate(h);
    lateMessage({ data: JSON.stringify(frame()) });
    lateClose();
    request.resolve(response());
    await flush();
    assert.equal(h.snapshots.length, 0);
    assert.equal(h.errors.length, 0);
    h.channel.stop();
    h.channel.stop();
    assert.equal(h.reads[0].signal.aborted, true);
    assert.equal(h.timers.size, 0);
    assert.equal(h.listenerCount(), 0);
    assert.equal(socket.closes, 1);
    assert.equal(socket.onmessage, null);
  }
});

test("synchronous navigation during a snapshot callback cannot restart timers or apply late HTTP", async () => {
  const request = deferred();
  let h;
  h = harness({
    readMetadata: () => request.promise,
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
