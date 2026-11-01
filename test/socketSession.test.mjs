import { createTimerHandle } from "./fixtures/timerHandle.mjs";
import { required } from "./fixtures/canonicalData.mjs";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

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

const { SnapshotChannel } =
  await import("../src/connection/snapshotChannel.ts");
const { InviteReactionChannel } =
  await import("../src/connection/inviteReactionChannel.ts");
const { socketSessionRefreshDelay } =
  await import("../src/connection/socketSession.ts");
const protocols = (/** @type {number} */ expiresAt) => [
  "mons-reactions-v2",
  `bearer.header.${Buffer.from(JSON.stringify({ exp: expiresAt / 1_000 })).toString("base64url")}.signature`,
];
const flush = () => new Promise((resolve) => setImmediate(resolve));

/**
 * @typedef {{url: string; wireProtocols: string[] | undefined; readyState: 0 | 1 | 2 | 3; closes: number; onopen: (() => void) | null; onmessage: ((event: {data: unknown}) => void) | null; onclose: (() => void) | null; onerror: (() => void) | null; close(): void; send(): void; receive(message: unknown): void}} HarnessSocket
 * @typedef {import("../src/connection/snapshotChannel.ts").SnapshotChannelDependencies<unknown, {snapshot: {revision: number}}>} SnapshotDependencies
 * @param {string} kind
 */
function harness(kind, authenticated = true) {
  let now = 1_000_000;
  let online = true;
  /** @type {(() => void) | null | undefined} */
  let wake;
  /** @type {Map<ReturnType<typeof createTimerHandle>, {callback: () => void; at: number}>} */
  const timers = new Map();
  /** @type {HarnessSocket[]} */
  const sockets = [];
  /** @type {boolean[]} */
  const refreshes = [];
  /** @type {unknown[]} */
  const errors = [];
  /** @type {unknown[]} */
  const updates = [];
  /** @satisfies {Pick<SnapshotDependencies, "createSocket" | "getProtocols" | "getTokenRemainingMs" | "isActive" | "isOnline" | "isVisible" | "addWakeListener" | "onError" | "setTimer" | "clearTimer" | "now" | "random"> & {canConnect(): boolean}} */
  const dependency = {
    createSocket(url, wireProtocols) {
      /** @type {HarnessSocket} */
      const socket = {
        url,
        wireProtocols,
        readyState: 0,
        closes: 0,
        onopen: null,
        onmessage: null,
        onclose: null,
        onerror: null,
        close() {
          this.closes++;
          this.readyState = 3;
        },
        send() {},
        receive(message) {
          this.readyState = 1;
          this.onmessage?.({ data: JSON.stringify(message) });
        },
      };
      sockets.push(socket);
      return socket;
    },
    ...(authenticated
      ? {
          getProtocols: async (/** @type {boolean} */ force) => {
            refreshes.push(force);
            return protocols(now + 300_000);
          },
        }
      : {}),
    getTokenRemainingMs: () => 300_000,
    isActive: () => true,
    isOnline: () => online,
    isVisible: () => true,
    canConnect: () => true,
    addWakeListener(listener) {
      wake = listener;
      return () => {
        wake = null;
      };
    },
    onError: (error) => errors.push(error),
    setTimer(callback, delayMs) {
      const id = createTimerHandle();
      timers.set(id, { callback, at: now + delayMs });
      return id;
    },
    clearTimer: (id) => timers.delete(id),
    now: () => now,
    random: () => 1,
  };
  const channel =
    kind === "snapshot"
      ? new SnapshotChannel({
          ...dependency,
          socketUrl: "wss://api.mons.link/test",
          socketProtocol: "snapshot-v1",
          maxMessageBytes: 1024,
          refreshMs: 5_000,
          readSnapshot: async () => ({ snapshot: { revision: 1 } }),
          parseMessage: (value) => value,
          retryAfterMs: () => 0,
          readError: (error) => error,
          channelError: () => new Error("channel"),
          onSnapshot: (value) => updates.push(value),
        })
      : new InviteReactionChannel({
          ...dependency,
          inviteId: "invite",
          matchId: "invite",
          onInitialSnapshot: (value) => updates.push({ initial: value }),
          onReaction: (reaction) => updates.push({ recovered: reaction }),
        });
  const receive = (/** @type {HarnessSocket} */ socket) =>
    socket.receive(
      kind === "snapshot"
        ? { revision: 2 }
        : {
            schemaVersion: 2,
            type: "snapshot",
            reactions: {},
            presentation: { matchId: "invite", players: {} },
          },
    );
  return {
    channel,
    timers,
    sockets,
    refreshes,
    errors,
    updates,
    receive,
    /**
     * @param {number} time
     */
    async nextAt(time) {
      now = time;
      const entry = [...timers.entries()].find(
        ([, timer]) => timer.at === time,
      );
      assert.ok(entry, `missing timer at ${time}`);
      timers.delete(entry[0]);
      entry[1].callback();
      await flush();
    },
    now: () => now,
    jump: (/** @type {number} */ time) => {
      now = time;
    },
    wake: () => wake?.(),
    offline: () => {
      online = false;
    },
  };
}

test("socket refresh delay uses the acquired token lifetime and leaves public spectators untimed", () => {
  assert.equal(
    socketSessionRefreshDelay(protocols(1_300_000), () => 300_000),
    270_000,
  );
  assert.equal(
    socketSessionRefreshDelay(["protocol"], () => 300_000),
    null,
  );
  assert.equal(
    socketSessionRefreshDelay(["bearer.token"], () => 10_000),
    0,
  );
  assert.equal(
    socketSessionRefreshDelay(["bearer.token"], () => Number.NaN),
    0,
  );
});

for (const kind of ["snapshot", "reaction"]) {
  test(`${kind} renewal stays on elapsed time after the device wall clock changes`, async () => {
    const originalNow = Date.now;
    const h = harness(kind);
    try {
      Date.now = () => originalNow() + 600_000;
      await h.nextAt(1_000_000);
      h.receive(required(h.sockets[0]));
      Date.now = () => originalNow() - 600_000;
      h.jump(1_001_000);
      h.wake();
      assert.equal(required(h.sockets[0]).closes, 0);
      await h.nextAt(1_270_000);
      assert.equal(required(h.sockets[0]).closes, 1);
    } finally {
      Date.now = originalNow;
      h.channel.stop();
    }
  });
  test(`${kind} sockets reauthenticate before expiry without reporting an error or resetting channel state`, async () => {
    const h = harness(kind);
    await h.nextAt(1_000_000);
    h.receive(required(h.sockets[0]));
    const before = h.updates.length;
    await h.nextAt(1_270_000);
    assert.equal(required(h.sockets[0]).closes, 1);
    assert.equal(h.errors.length, 0);
    await h.nextAt(1_270_000);
    assert.deepEqual(h.refreshes, [false, true]);
    h.receive(required(h.sockets[1]));
    assert.equal(h.errors.length, 0);
    if (kind === "reaction") assert.equal(h.updates.length, before);
    else assert.ok(h.updates.length > before);
    h.channel.stop();
    assert.equal(h.timers.size, 0);
  });

  test(`${kind} sockets reauthenticate on wake if the expiry timer was suspended`, async () => {
    const h = harness(kind);
    await h.nextAt(1_000_000);
    h.receive(required(h.sockets[0]));
    h.jump(1_400_000);
    h.wake();
    assert.equal(required(h.sockets[0]).closes, 1);
    await h.nextAt(1_400_000);
    assert.deepEqual(h.refreshes, [false, true]);
    h.channel.stop();
  });

  test(`${kind} public spectator sockets have no token-expiry timer`, async () => {
    const h = harness(kind, false);
    await h.nextAt(1_000_000);
    h.receive(required(h.sockets[0]));
    assert.equal(
      [...h.timers.values()].some((timer) => timer.at === 1_270_000),
      false,
    );
    h.channel.stop();
  });
}
