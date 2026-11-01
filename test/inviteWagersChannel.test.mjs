import { createTimerHandle } from "./fixtures/timerHandle.mjs";
import { required } from "./fixtures/canonicalData.mjs";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { INVITE_WAGERS_MAX_MESSAGE_BYTES } from "@mons/shared/invite-wagers";

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

const { InviteWagersChannel } =
  await import("../src/connection/inviteWagersChannel.ts");
const { InviteWagersApiError } =
  await import("../src/services/inviteWagersApi.ts");
/** @type {import("@mons/shared/invite-wagers").InviteWagersSnapshot["wagers"][string]} */
const wager = {
  schemaVersion: 1,
  state: "proposed",
  agreed: null,
  resolved: null,
  blocked: null,
  proposals: { host: { material: "dust", count: 3, createdAt: 1 } },
  proposedBy: { host: true },
};
/** @param {number} [revision] @param {Partial<import("@mons/shared/invite-wagers").InviteWagersSnapshot>} [changes] @returns {import("@mons/shared/invite-wagers").InviteWagersSnapshot} */
const snapshot = (revision = 1, changes = {}) => ({
  inviteId: "invite",
  revision,
  wagers: { invite: wager },
  ...changes,
});
/** @param {number} [revision] @param {Partial<import("@mons/shared/invite-wagers").InviteWagersSnapshot>} [changes] @returns {import("@mons/shared/invite-wagers").ReadInviteWagersResponse} */
const response = (revision = 1, changes = {}) => ({
  ok: true,
  snapshot: snapshot(revision, changes),
});
/** @param {number} [revision] @param {Record<string, unknown>} [changes] */
const frame = (revision = 1, changes = {}) => ({
  schemaVersion: 1,
  type: "snapshot",
  snapshot: { ...snapshot(revision), ...changes },
});
const flush = () => new Promise((resolve) => setImmediate(resolve));
/** @template [T=void] @returns {PromiseWithResolvers<T>} */
const deferred = () => {
  /** @type {PromiseWithResolvers<T>} */
  const pending = Promise.withResolvers();
  return {
    promise: pending.promise,
    resolve: pending.resolve,
    reject: pending.reject,
  };
};

/**
 * @typedef {ConstructorParameters<typeof InviteWagersChannel>[0]} ChannelDependencies
 * @typedef {Omit<ReturnType<ChannelDependencies["createSocket"]>, "readyState"> & {readyState: WebSocket["readyState"], url: string, protocols: string[] | undefined, closes: number, sent: Parameters<WebSocket["send"]>[0][], receive: (value: unknown) => void, fail: () => void}} TestSocket
 * @param {Partial<Pick<ChannelDependencies, "getProtocols" | "captureGeneration" | "needsHttpRefresh" | "readWagers" | "onSnapshot">> & {rawRead?: (signal: AbortSignal) => Promise<{ok: true, snapshot: Omit<import("@mons/shared/invite-wagers").InviteWagersSnapshot, "wagers"> & {wagers: Record<string, unknown>}}>, createError?: boolean, online?: boolean, visible?: boolean}} [options]
 */
function harness({
  getProtocols,
  captureGeneration,
  needsHttpRefresh,
  readWagers = async () => response(),
  rawRead,
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
  /** @type {Map<ReturnType<typeof createTimerHandle>, {callback: () => void, at: number}>} */
  const timers = new Map();
  /** @type {TestSocket[]} */
  const sockets = [];
  /** @type {({ snapshot: import("@mons/shared/invite-wagers").InviteWagersSnapshot; delivery: import("../src/connection/snapshotChannel.ts").SnapshotDelivery; })[]} */
  const snapshots = [];
  /** @type {unknown[]} */
  const errors = [];
  /** @type {({ now: number; signal: AbortSignal; })[]} */
  const reads = [];
  /** @type {ChannelDependencies} */
  const dependencies = {
    inviteId: "invite",
    createSocket(url, protocols) {
      if (createError) throw new Error("secret-token-in-error");
      /** @type {TestSocket} */
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
          if (this.onmessage)
            Reflect.apply(this.onmessage, this, [
              {
                data: typeof value === "string" ? value : JSON.stringify(value),
              },
            ]);
        },
        fail() {
          this.readyState = 3;
          if (this.onclose) Reflect.apply(this.onclose, this, []);
        },
      };
      sockets.push(socket);
      return socket;
    },
    ...(getProtocols ? { getProtocols } : {}),
    ...(captureGeneration ? { captureGeneration } : {}),
    ...(needsHttpRefresh ? { needsHttpRefresh } : {}),
    readWagers(signal) {
      reads.push({ now, signal });
      return readWagers(signal);
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
    onSnapshot(value, delivery) {
      snapshots.push({ snapshot: value, delivery });
      onSnapshot?.(value, delivery);
    },
    onError: (error) => errors.push(error),
    setTimer(callback, delayMs) {
      const id = createTimerHandle();
      timers.set(id, { callback, at: now + delayMs });
      return id;
    },
    clearTimer: (timer) => timers.delete(timer),
    random: () => 1,
    now: () => now,
  };
  if (rawRead)
    Reflect.set(
      dependencies,
      "readWagers",
      (/** @type {AbortSignal} */ signal) => {
        reads.push({ now, signal });
        return rawRead(signal);
      },
    );
  const channel = new InviteWagersChannel(dependencies);
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

test("uses an isolated wager socket and hydrates the full rematch map", async () => {
  const wagers = { invite: wager, invite1: {}, invite2: wager };
  const h = harness({
    rawRead: async () => ({ ok: true, snapshot: { ...snapshot(), wagers } }),
  });
  assert.equal(h.reads.length, 0);
  await h.tick();
  assert.equal(
    required(h.sockets[0]).url,
    "wss://api.mons.link/invites/invite/wagers/socket",
  );
  assert.deepEqual(required(h.sockets[0]).protocols, [
    "mons-invite-wagers-v1",
    "mons-data-v1",
  ]);
  assert.deepEqual(required(h.snapshots[0]).snapshot.wagers, wagers);
  required(h.sockets[0]).receive(frame(2, { wagers: {} }));
  assert.deepEqual(required(h.snapshots.at(-1)).snapshot.wagers, {});
  h.channel.stop();
});

test("drops older snapshots but delivers same-revision HTTP reconciliation", async () => {
  /** @type {PromiseWithResolvers<import("@mons/shared/invite-wagers").ReadInviteWagersResponse>} */
  const read = deferred();
  let calls = 0;
  const h = harness({
    readWagers: () =>
      ++calls === 1 ? read.promise : Promise.resolve(response(3)),
  });
  await h.tick();
  required(h.sockets[0]).receive(frame(3));
  required(h.sockets[0]).receive(frame(3));
  required(read.resolve)(response(2));
  await flush();
  assert.equal(h.snapshots.length, 1);
  h.channel.requestRefresh();
  await flush();
  assert.equal(h.snapshots.length, 2);
  assert.deepEqual(
    h.snapshots.map(({ delivery }) => delivery.source),
    ["socket", "http"],
  );
  h.channel.stop();
});

test("captures HTTP generations before reads and socket generations at delivery", async () => {
  /** @type {PromiseWithResolvers<import("@mons/shared/invite-wagers").ReadInviteWagersResponse>} */
  const read = deferred();
  let generation = 1;
  let calls = 0;
  const h = harness({
    captureGeneration: () => generation,
    readWagers: () =>
      ++calls === 1 ? read.promise : Promise.resolve(response()),
  });
  await h.tick();
  generation = 2;
  required(h.sockets[0]).receive(frame());
  required(read.resolve)(response());
  await flush();
  generation = 3;
  h.channel.requestRefresh();
  await flush();
  assert.deepEqual(
    h.snapshots.map(({ delivery }) => delivery),
    [
      { source: "socket", requestGeneration: 2 },
      { source: "http", requestGeneration: 1 },
      { source: "http", requestGeneration: 3 },
    ],
  );
  h.channel.stop();
});

test("retries requested HTTP reconciliation while sockets remain healthy", async () => {
  let needsRefresh = false;
  let calls = 0;
  const h = harness({
    needsHttpRefresh: () => needsRefresh,
    readWagers: async () => {
      calls++;
      if (calls === 2) throw new InviteWagersApiError("http-429", 429, 10_000);
      return response(calls >= 3 ? 2 : 1);
    },
    onSnapshot: (_snapshot, delivery) => {
      if (delivery.source === "http") needsRefresh = false;
    },
  });
  await h.tick();
  required(h.sockets[0]).receive(frame());
  needsRefresh = true;
  h.channel.requestRefresh();
  await flush();
  assert.equal(calls, 2);
  required(h.sockets[0]).receive(frame(2));
  await h.tick(9_999);
  assert.equal(calls, 2);
  await h.tick(1);
  assert.equal(calls, 3);
  assert.equal(needsRefresh, false);
  await h.tick(5_000);
  assert.equal(calls, 3);
  h.channel.stop();
});

test("recovers through HTTP and refreshed socket authentication after a disconnect", async () => {
  /** @type {boolean[]} */
  const refreshes = [];
  const h = harness({
    getProtocols: async (force) => {
      refreshes.push(force);
      return [
        "mons-invite-wagers-v1",
        "bearer.header.payload.signature",
        "mons-data-v1",
      ];
    },
  });
  await h.tick();
  required(h.sockets[0]).receive(frame());
  required(h.sockets[0]).fail();
  await h.tick(500);
  assert.deepEqual(refreshes, [false, true]);
  assert.equal(h.reads.length, 2);
  required(h.sockets[1]).receive(frame());
  await h.tick(5_000);
  assert.equal(h.reads.length, 2);
  h.channel.stop();
});

test("rejects metadata frames, private wager fields, foreign and oversized messages", async () => {
  for (const invalid of [
    {
      ...frame(),
      snapshot: { inviteId: "invite", revision: 1, hostId: "host" },
    },
    frame(1, { wagers: { invite: { settlementClaim: "secret" } } }),
    frame(1, { inviteId: "another-invite" }),
    "x".repeat(INVITE_WAGERS_MAX_MESSAGE_BYTES + 1),
    { ...frame(), schemaVersion: 2 },
  ]) {
    const h = harness({ readWagers: () => new Promise(() => {}) });
    await h.tick();
    required(h.sockets[0]).receive(invalid);
    assert.equal(h.snapshots.length, 0);
    assert.equal(required(h.sockets[0]).closes, 1);
    const error = required(h.errors[0]);
    assert.ok(error instanceof InviteWagersApiError);
    assert.equal(error.code, "wagers-channel-unavailable");
    h.channel.stop();
  }
});

test("stopping an obsolete context aborts reads and releases every channel resource", async () => {
  /** @type {PromiseWithResolvers<import("@mons/shared/invite-wagers").ReadInviteWagersResponse>} */
  const read = deferred();
  const h = harness({ readWagers: () => read.promise });
  await h.tick();
  const lateMessage = required(h.sockets[0]).onmessage;
  const lateClose = required(h.sockets[0]).onclose;
  h.setActive(false);
  h.channel.stop();
  h.channel.stop();
  required(read.resolve)(response());
  Reflect.apply(required(lateMessage), h.sockets[0], [
    { data: JSON.stringify(frame()) },
  ]);
  Reflect.apply(required(lateClose), h.sockets[0], []);
  await flush();
  assert.equal(h.snapshots.length, 0);
  assert.equal(h.errors.length, 0);
  assert.equal(required(h.reads[0]).signal.aborted, true);
  assert.equal(h.timers.size, 0);
  assert.equal(h.listenerCount(), 0);
  assert.equal(required(h.sockets[0]).closes, 1);
});
