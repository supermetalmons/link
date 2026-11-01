import assert from "node:assert/strict";
import test from "node:test";
import { registerTypeScriptTestHooks } from "./support/typescriptHooks.mjs";
import { createTimerHandle } from "./fixtures/timerHandle.mjs";
import { required } from "./fixtures/canonicalData.mjs";
import {
  EVENT_UPDATES_MAX_MESSAGE_BYTES,
  EVENT_UPDATES_SOCKET_PROTOCOL,
} from "@mons/shared/events";

registerTypeScriptTestHooks();
const { EventUpdatesChannel, createEventUpdatesSocketProtocols } =
  await import("../src/connection/eventUpdatesChannel.ts");

const update = (revision = 1, eventId = "event-1") => ({
  schemaVersion: 1,
  type: "event-changed",
  eventId,
  epoch: "12345678-1234-1234-1234-123456789abc",
  revision,
});
const settle = () => new Promise((resolve) => setImmediate(resolve));

function harness() {
  let now = 0;
  let online = true;
  /** @type {(()=>void)|null} */
  let wake = null;
  /** @type {Map<ReturnType<typeof createTimerHandle>, {callback:()=>void, at:number}>} */
  const timers = new Map();
  /** @type {(Pick<WebSocket,"readyState"|"onopen"|"onmessage"|"onclose"|"onerror"|"send"|"close"> & {closed:boolean,receive:(value:unknown)=>void,sent:unknown[]})[]} */
  const sockets = [];
  /** @type {import("@mons/shared/events").EventUpdateMessage[]} */
  const updates = [];
  /** @type {unknown[]} */
  const errors = [];
  /** @type {boolean[]} */
  const authentication = [];
  const channel = new EventUpdatesChannel({
    eventId: "event-1",
    createSocket(url, protocols) {
      assert.equal(url, "wss://api.mons.link/events/event-1/socket");
      assert.equal(protocols?.[0], EVENT_UPDATES_SOCKET_PROTOCOL);
      /** @type {(typeof sockets)[number]} */
      const socket = {
        readyState: 1,
        onopen: null,
        onmessage: null,
        onclose: null,
        onerror: null,
        closed: false,
        sent: [],
        send(value) {
          this.sent.push(value);
        },
        close() {
          this.closed = true;
        },
        receive(value) {
          if (this.onmessage)
            Reflect.apply(this.onmessage, this, [
              new MessageEvent("message", {
                data: typeof value === "string" ? value : JSON.stringify(value),
              }),
            ]);
        },
      };
      sockets.push(socket);
      return socket;
    },
    getProtocols: async (force) => {
      authentication.push(force);
      return [EVENT_UPDATES_SOCKET_PROTOCOL];
    },
    isActive: () => true,
    isOnline: () => online,
    isVisible: () => true,
    addWakeListener(listener) {
      wake = listener;
      return () => {
        wake = null;
      };
    },
    onUpdate: (value) => updates.push(value),
    onError: (error) => errors.push(error),
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
    updates,
    errors,
    authentication,
    wake: () => wake?.(),
    listeners: () => Number(wake !== null),
    setOnline: (/** @type {boolean} */ value) => {
      online = value;
      wake?.();
    },
    async tick(ms = 0) {
      const end = now + ms;
      await settle();
      for (;;) {
        const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > end) break;
        timers.delete(next[0]);
        now = next[1].at;
        next[1].callback();
        await settle();
      }
      now = end;
    },
  };
}

test("event update channel receives hints without an HTTP loop and reconnects with refreshed authentication", async () => {
  const h = harness();
  await h.tick();
  const socket = required(h.sockets[0]);
  socket.receive(update());
  assert.deepEqual(h.updates, [update()]);
  assert.equal(h.timers.size, 1);
  h.channel.requestRefresh();
  h.wake();
  await h.tick(2_000);
  assert.equal(h.timers.size, 1);
  assert.equal(h.sockets.length, 1);
  h.setOnline(false);
  assert.equal(socket.closed, true);
  assert.equal(h.timers.size, 0);
  h.setOnline(true);
  await h.tick();
  assert.deepEqual(h.authentication, [false, true]);
  const next = required(h.sockets[1]);
  next.receive(update(2));
  assert.equal(h.updates.length, 2);
  h.channel.stop();
  assert.equal(next.closed, true);
  assert.equal(h.listeners(), 0);
  assert.equal(h.timers.size, 0);
  next.receive(update(3));
  assert.equal(h.updates.length, 2);
});

test("event update channel rejects foreign and oversized hints and recovers from a silent socket", async () => {
  const h = harness();
  await h.tick();
  required(h.sockets[0]).receive(update(1, "other-event"));
  assert.equal(h.errors.length, 1);
  assert.deepEqual(h.updates, []);
  await h.tick(500);
  required(h.sockets[1]).receive(
    "x".repeat(EVENT_UPDATES_MAX_MESSAGE_BYTES + 1),
  );
  assert.equal(h.errors.length, 2);
  await h.tick(1_000);
  await h.tick(10_000);
  assert.equal(h.errors.length, 3);
  h.channel.stop();
  assert.equal(h.timers.size, 0);
});

test("event socket protocols validate tokens without exposing their content", () => {
  assert.throws(
    () => createEventUpdatesSocketProtocols("invalid token"),
    /invalid-event-updates-socket-token/,
  );
  assert.equal(
    createEventUpdatesSocketProtocols("header.payload.signature")[0],
    EVENT_UPDATES_SOCKET_PROTOCOL,
  );
});
