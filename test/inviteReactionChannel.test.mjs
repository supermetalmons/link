import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";
import ts from "typescript";

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

const {
  InviteReactionChannel,
  REACTION_RECONNECT_DELAYS_MS,
  REACTION_HEARTBEAT_INTERVAL_MS,
  REACTION_HEARTBEAT_TIMEOUT_MS,
} = await import("../src/connection/inviteReactionChannel.ts");
const { createInviteReactionSocketProtocols } =
  await import("../src/services/inviteReactionsApi.ts");
const { MatchPresentationState } =
  await import("../src/connection/matchPresentationState.ts");

const reaction = (id = 1, overrides = {}) => ({
  uuid: `00000000-0000-4000-8000-${String(id).padStart(12, "0")}`,
  matchId: "invite",
  kind: "yo",
  variation: 1,
  ...overrides,
});
const snapshot = (reactions = {}) => ({
  schemaVersion: 1,
  type: "snapshot",
  reactions,
});
const event = (value = reaction(), senderUid = "guest") => ({
  schemaVersion: 1,
  type: "reaction",
  senderUid,
  reaction: value,
});

function harness({
  inviteId = "invite",
  matchId,
  online = true,
  paired = true,
  createError = false,
  getProtocols,
} = {}) {
  let active = true;
  let wake;
  let nextTimer = 1;
  const timers = new Map();
  const sockets = [];
  const initial = [];
  const updates = [];
  const errors = [];
  const presentationSnapshots = [];
  const presentations = [];
  const channel = new InviteReactionChannel({
    inviteId,
    matchId,
    createSocket(url, protocols) {
      if (createError) throw new Error("socket-construction-failed");
      const socket = {
        url,
        protocols,
        readyState: 0,
        onopen: null,
        onmessage: null,
        onerror: null,
        onclose: null,
        sent: [],
        closes: 0,
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
    isActive: () => active,
    isOnline: () => online,
    canConnect: () => paired,
    addWakeListener(listener) {
      wake = listener;
      return () => {
        wake = null;
      };
    },
    onInitialSnapshot: (value) => initial.push(value),
    onReaction: (value, senderUid) =>
      updates.push({ reaction: value, senderUid }),
    onPresentationSnapshot: (value) => presentationSnapshots.push(value),
    onPresentation: (value) => presentations.push(value),
    onError: (error) => errors.push(error),
    setTimer(callback, delayMs) {
      const id = nextTimer++;
      timers.set(id, { callback, delayMs });
      return id;
    },
    clearTimer: (id) => timers.delete(id),
    random: () => 1,
  });
  return {
    channel,
    timers,
    sockets,
    initial,
    updates,
    errors,
    presentationSnapshots,
    presentations,
    next() {
      const [id, timer] = timers.entries().next().value;
      timers.delete(id);
      timer.callback();
      return timer.delayMs;
    },
    wake: () => wake?.(),
    listenerCount: () => Number(!!wake),
    setActive: (value) => {
      active = value;
    },
    setOnline: (value) => {
      online = value;
    },
    setPaired: (value) => {
      paired = value;
    },
  };
}

test("first connection baselines latest reactions silently, then delivers both voice and stickers", () => {
  const h = harness();
  assert.equal(h.next(), 0);
  const socket = h.sockets[0];
  assert.equal(
    socket.url,
    "wss://api.mons.link/invites/invite/reactions/socket",
  );
  assert.equal(socket.protocols, undefined);
  socket.receive(snapshot({ host: reaction() }));
  assert.deepEqual(h.initial, [{ host: reaction() }]);
  assert.equal(h.updates.length, 0);
  socket.receive(event(reaction(2)));
  socket.receive(event(reaction(3, { kind: "sticker", variation: 900316 })));
  assert.deepEqual(
    h.updates.map(({ reaction }) => reaction.kind),
    ["yo", "sticker"],
  );
  h.channel.stop();
});

test("reconnect forwards latest per sender to the existing UUID-deduplicating consumer without rebasing", () => {
  const h = harness();
  h.next();
  h.sockets[0].receive(snapshot({ host: reaction() }));
  h.sockets[0].receive(event(reaction(2)));
  h.sockets[0].fail();
  assert.equal(h.next(), 500);
  h.sockets[1].receive(snapshot({ host: reaction(), guest: reaction(4) }));
  assert.equal(h.initial.length, 1);
  assert.deepEqual(
    h.updates.map(({ reaction }) => reaction.uuid),
    [reaction(2).uuid, reaction().uuid, reaction(4).uuid],
  );
  h.channel.stop();
});

test("valid heartbeat keeps the connection and missing pong reconnects it", () => {
  const h = harness();
  h.next();
  const socket = h.sockets[0];
  socket.receive(snapshot());
  assert.equal(h.next(), REACTION_HEARTBEAT_INTERVAL_MS);
  assert.deepEqual(socket.sent, ["ping"]);
  socket.receive("pong");
  assert.equal(h.timers.size, 1);
  assert.equal(h.next(), REACTION_HEARTBEAT_INTERVAL_MS);
  assert.equal(h.next(), REACTION_HEARTBEAT_TIMEOUT_MS);
  assert.equal(socket.closes, 1);
  assert.equal(h.next(), 500);
  assert.equal(h.sockets.length, 2);
  h.channel.stop();
});

test("bounds reconnect backoff and resets it only after a valid snapshot", () => {
  const h = harness();
  h.next();
  for (const delay of [...REACTION_RECONNECT_DELAYS_MS, 15_000]) {
    h.sockets.at(-1).fail();
    assert.equal(h.next(), delay);
  }
  h.sockets.at(-1).receive(snapshot());
  h.sockets.at(-1).fail();
  assert.equal(h.next(), 500);
  h.channel.stop();
});

test("offline startup waits for wake; pending invite pairing wakes reconnect without duplicate sockets", () => {
  const h = harness({ online: false, paired: false });
  assert.equal(h.timers.size, 0);
  h.setOnline(true);
  h.wake();
  assert.equal(h.timers.size, 0);
  h.setPaired(true);
  h.channel.refresh();
  assert.equal(h.next(), 0);
  h.wake();
  assert.equal(h.timers.size, 1);
  assert.equal(h.sockets.length, 1);
  h.sockets[0].fail();
  h.channel.refresh();
  assert.equal(h.next(), 0);
  h.sockets[1].receive(snapshot());
  h.wake();
  assert.equal(h.sockets.length, 2);
  assert.equal(h.timers.size, 1);
  h.channel.stop();
});

test("a new rematch context baselines independently and cannot receive old context events", () => {
  const old = harness();
  old.next();
  old.sockets[0].receive(snapshot());
  const staleCallback = old.sockets[0].onmessage;
  old.channel.stop();
  const rematch = harness();
  rematch.next();
  rematch.sockets[0].receive(
    snapshot({ guest: reaction(2, { matchId: "invite1" }) }),
  );
  staleCallback({ data: JSON.stringify(event(reaction(3))) });
  assert.equal(old.updates.length, 0);
  assert.equal(rematch.updates.length, 0);
  assert.equal(rematch.initial.length, 1);
  rematch.channel.stop();
});

test("teardown aborts sends and releases all listeners, timers and socket handlers exactly once", () => {
  const h = harness();
  h.next();
  const socket = h.sockets[0];
  const lateMessage = socket.onmessage;
  const lateClose = socket.onclose;
  h.channel.stop();
  h.channel.stop();
  lateMessage({ data: JSON.stringify(snapshot()) });
  lateClose();
  h.channel.refresh();
  assert.equal(h.channel.signal.aborted, true);
  assert.equal(h.timers.size, 0);
  assert.equal(h.listenerCount(), 0);
  assert.equal(socket.closes, 1);
  assert.equal(socket.onmessage, null);
  assert.equal(h.initial.length, 0);
});

test("session or auth invalidation drops all callbacks even before explicit cleanup", () => {
  const h = harness();
  h.next();
  h.setActive(false);
  h.sockets[0].receive(snapshot());
  h.sockets[0].receive(event());
  h.sockets[0].fail();
  h.wake();
  assert.equal(h.initial.length, 0);
  assert.equal(h.updates.length, 0);
  assert.equal(h.errors.length, 0);
  h.channel.stop();
  assert.equal(h.timers.size, 0);
});

test("rejects invalid, oversized, foreign-match and out-of-order socket frames", () => {
  for (const badFrame of [
    "invalid-json",
    "x".repeat(4097),
    event(),
    snapshot({ host: reaction(1, { matchId: "other" }) }),
    { ...snapshot(), schemaVersion: 2 },
  ]) {
    const h = harness();
    h.next();
    h.sockets[0].receive(badFrame);
    assert.equal(h.errors.length, 1);
    assert.equal(h.initial.length, 0);
    assert.equal(h.updates.length, 0);
    assert.equal(h.sockets[0].closes, 1);
    h.channel.stop();
  }
  const h = harness();
  h.next();
  h.sockets[0].receive(snapshot());
  h.sockets[0].receive(snapshot());
  assert.equal(h.errors.length, 1);
  h.channel.stop();
});

test("times out connections without a first snapshot and handles socket-construction failure", () => {
  const h = harness();
  h.next();
  assert.equal(h.next(), REACTION_HEARTBEAT_TIMEOUT_MS);
  assert.equal(h.sockets[0].closes, 1);
  assert.equal(h.next(), 500);
  h.channel.stop();
  const failed = harness({ createError: true });
  failed.next();
  assert.equal(failed.errors.length, 1);
  assert.equal(failed.next(), 500);
  failed.channel.stop();
});

test("the actual Firebase auth callback tears down participant and spectator resources on cross-tab signout or user replacement", async () => {
  const source = ts.createSourceFile(
    "connection.ts",
    readFileSync(
      new URL("../src/connection/connection.ts", import.meta.url),
      "utf8",
    ),
    ts.ScriptTarget.Latest,
    true,
  );
  const declaration = source.statements.find(
    (node) => ts.isClassDeclaration(node) && node.name?.text === "Connection",
  );
  const methods = [
    "subscribeToAuthChanges",
    "observeInviteReactions",
    "cleanupInviteReactionObserver",
    "cleanupInviteMetadataObserver",
    "cleanupWagerObserver",
    "stopObservingAllMatches",
  ].map((name) => {
    const method = declaration.members.find(
      (node) => node.name?.getText(source) === name,
    );
    assert.ok(method, `missing method ${name}`);
    return method.getText(source);
  });
  const { outputText } = ts.transpileModule(
    `class Connection { ${methods.join("\n")} }`,
    {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    },
  );
  for (const [newUser, canWrite] of [
    [null, false],
    [{ uid: "replacement-login" }, false],
    [null, true],
    [{ uid: "replacement-login" }, true],
  ]) {
    const timers = new Map();
    const listeners = new Map();
    const observers = new Map();
    const counters = new Map();
    let nextTimer = 1;
    let authCallback;
    let socket;
    const surface = {
      visibilityState: "visible",
      addEventListener: (kind, callback) => listeners.set(kind, callback),
      removeEventListener: (kind) => listeners.delete(kind),
    };
    const dependencies = {
      InviteReactionChannel,
      MatchPresentationState,
      readMatchPresentationViaApi: async (_inviteId, matchId) => ({
        ok: true,
        presentation: { matchId, players: {} },
      }),
      updateMatchPresentationViaApi: () =>
        assert.fail("unexpected presentation write"),
      didReceiveMatchPresentationUpdate: () => undefined,
      createInviteReactionSocketProtocols,
      WebSocket: class {
        readyState = 0;
        closes = 0;
        constructor(_url, protocols) {
          socket = this;
          this.protocols = protocols;
        }
        close() {
          this.closes++;
          this.readyState = 3;
        }
      },
      window: surface,
      document: surface,
      navigator: { onLine: true },
      setTimeout: (callback, delayMs) => {
        const id = nextTimer++;
        timers.set(id, { callback, delayMs });
        return id;
      },
      clearTimeout: (id) => timers.delete(id),
      onAuthStateChanged: (_auth, callback) => {
        authCallback = callback;
        return () => undefined;
      },
      incrementLifecycleCounter: (kind) =>
        counters.set(kind, (counters.get(kind) ?? 0) + 1),
      decrementLifecycleCounter: (kind) =>
        counters.set(kind, counters.get(kind) - 1),
      didRecoverInviteReactions: () => undefined,
      didReceiveInviteReactionUpdate: () => undefined,
    };
    const Constructor = new Function(
      ...Object.keys(dependencies),
      `${outputText}\nreturn Connection;`,
    )(...Object.values(dependencies));
    const connection = Object.assign(new Constructor(), {
      auth: { currentUser: { uid: "original-login" } },
      currentUid: "original-login",
      authUnsubscribers: new Set(),
      pendingWagerMutations: new Set([{}]),
      wagerSnapshotGeneration: 0,
      activeContext: {
        contextId: 1,
        sessionEpoch: 1,
        inviteId: "invite",
        matchId: "invite",
        actorUid: canWrite ? "host" : null,
        loginUid: "original-login",
        canWrite,
      },
      latestInvite: { hostId: "host", guestId: "guest" },
      inviteReactionSubscription: null,
      observedMatchSnapshots: new Map([["old-match", {}]]),
      rememberMatchPresentation: () => undefined,
      isContextActive: () => true,
      isCurrentAuthUser(uid) {
        return this.auth.currentUser?.uid === uid;
      },
      registerObserverCleanup: (_contextId, key, cleanup) => {
        observers.set(key, cleanup);
        return true;
      },
      unregisterObserverCleanup: (_contextId, key) => observers.delete(key),
      clearEventSyncCaches: () => undefined,
      refreshMoveDeliveries: () => undefined,
      getUserBoundAuthTokenProvider(uid) {
        assert.equal(uid, "original-login");
        return Object.assign(
          async (forceRefresh) => {
            assert.equal(forceRefresh, false);
            return "header.payload.signature";
          },
          {
            assertCurrentUser: () =>
              assert.equal(this.auth.currentUser.uid, uid),
          },
        );
      },
    });
    connection.observeInviteReactions();
    const [timerId, timer] = timers.entries().next().value;
    timers.delete(timerId);
    timer.callback();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(
      socket.protocols,
      canWrite
        ? ["mons-reactions-v2", "bearer.header.payload.signature"]
        : ["mons-reactions-v2"],
    );
    const signal = connection.inviteReactionSubscription.channel.signal;
    const presentationSignal =
      connection.inviteReactionSubscription.presentation.signal;
    const unsubscribe = connection.subscribeToAuthChanges(() => {
      assert.equal(signal.aborted, true);
    });
    authCallback({ uid: "original-login" });
    assert.equal(signal.aborted, false);
    assert.equal(listeners.size, 3);
    connection.auth.currentUser = newUser;
    authCallback(newUser);
    assert.equal(signal.aborted, true);
    assert.equal(connection.pendingWagerMutations.size, 0);
    assert.equal(connection.wagerSnapshotGeneration, 1);
    assert.equal(presentationSignal.aborted, true);
    assert.equal(socket.closes, 1);
    assert.equal(socket.onmessage, null);
    assert.equal(timers.size, 0);
    assert.equal(listeners.size, 0);
    assert.equal(observers.size, 0);
    assert.equal(counters.get("connectionObservers"), 0);
    assert.equal(connection.inviteReactionSubscription, null);
    authCallback(newUser);
    assert.equal(socket.closes, 1);
    unsubscribe();
    assert.equal(counters.get("connectionAuthSubscribers"), 0);
  }
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

const presentation = (revision = 1, overrides = {}) => ({
  matchId: "invite",
  actorUid: "host",
  emojiId: 1,
  aura: "",
  revision,
  ...overrides,
});
const roomSnapshot = (value = presentation(), reactions = {}) => ({
  schemaVersion: 2,
  type: "snapshot",
  reactions,
  presentation: {
    matchId: value.matchId,
    players: { [value.actorUid]: value },
  },
});

test("v2 spectators receive persistent appearance on initial connection and reconnect without replaying initial reactions", () => {
  const h = harness({ matchId: "invite" });
  h.next();
  const socket = h.sockets[0];
  assert.equal(new URL(socket.url).searchParams.get("matchId"), "invite");
  assert.deepEqual(socket.protocols, ["mons-reactions-v2"]);
  socket.receive(roomSnapshot(presentation(), { host: reaction() }));
  assert.equal(h.presentationSnapshots.length, 1);
  assert.equal(h.initial.length, 1);
  assert.equal(h.updates.length, 0);
  socket.receive({
    schemaVersion: 2,
    type: "presentation",
    presentation: presentation(2),
  });
  assert.deepEqual(h.presentations, [presentation(2)]);
  assert.equal(h.updates.length, 0);
  socket.fail();
  h.next();
  h.sockets[1].receive(roomSnapshot(presentation(2), { host: reaction() }));
  assert.equal(h.presentationSnapshots.length, 2);
  assert.equal(h.initial.length, 1);
  assert.equal(h.updates.length, 1);
  h.channel.stop();
});

test("v2 participants preserve bearer protocols and reject missing, foreign, premature or oversized presentation frames", async () => {
  for (const frame of [
    snapshot(),
    roomSnapshot(presentation(1, { matchId: "invite1" })),
    { schemaVersion: 2, type: "presentation", presentation: presentation() },
    " ".repeat(16385),
  ]) {
    const h = harness({
      matchId: "invite",
      getProtocols: async () =>
        createInviteReactionSocketProtocols("header.payload.signature"),
    });
    h.next();
    await flush();
    const socket = h.sockets[0];
    assert.deepEqual(socket.protocols, [
      "mons-reactions-v2",
      "bearer.header.payload.signature",
    ]);
    socket.receive(frame);
    assert.equal(h.errors.length, 1);
    assert.equal(h.presentations.length, 0);
    assert.equal(h.presentationSnapshots.length, 0);
    h.channel.stop();
  }
});

test("v2 rematch contexts discard old socket callbacks and reject foreign presentation events", () => {
  const old = harness({ matchId: "invite" });
  old.next();
  old.sockets[0].receive(roomSnapshot());
  const late = old.sockets[0].onmessage;
  old.channel.stop();
  const next = harness({ matchId: "invite1" });
  next.next();
  next.sockets[0].receive(
    roomSnapshot(presentation(1, { matchId: "invite1" })),
  );
  late({
    data: JSON.stringify({
      schemaVersion: 2,
      type: "presentation",
      presentation: presentation(2),
    }),
  });
  assert.equal(old.presentations.length, 0);
  next.sockets[0].receive({
    schemaVersion: 2,
    type: "presentation",
    presentation: presentation(2),
  });
  assert.equal(next.presentations.length, 0);
  assert.equal(next.errors.length, 1);
  next.channel.stop();
});

test("v2 accepts maximal escaped match keys without relaxing the v1 frame limit", () => {
  const matchId = '"'.repeat(768);
  const host = "h".repeat(128);
  const guest = "g".repeat(128);
  const h = harness({ inviteId: matchId, matchId });
  h.next();
  const frame = {
    schemaVersion: 2,
    type: "snapshot",
    reactions: {
      [host]: reaction(1, { matchId }),
      [guest]: reaction(2, { matchId }),
    },
    presentation: {
      matchId,
      players: {
        [host]: presentation(1, { matchId, actorUid: host }),
        [guest]: presentation(1, { matchId, actorUid: guest }),
      },
    },
  };
  const encoded = JSON.stringify(frame);
  assert.ok(new TextEncoder().encode(encoded).byteLength > 4096);
  assert.ok(new TextEncoder().encode(encoded).byteLength <= 16384);
  h.sockets[0].receive(encoded);
  assert.equal(h.errors.length, 0);
  assert.equal(h.presentationSnapshots.length, 1);
  h.channel.stop();
  const legacy = harness();
  legacy.next();
  legacy.sockets[0].receive(" ".repeat(4097));
  assert.equal(legacy.errors.length, 1);
  legacy.channel.stop();
});

test("participant sockets await auth protocols and force-refresh authentication on reconnect", async () => {
  const pending = deferred();
  const refreshes = [];
  const protocols = ["mons-reactions-v1", "bearer.header.payload.signature"];
  const h = harness({
    getProtocols: (forceRefresh) => {
      refreshes.push(forceRefresh);
      return refreshes.length === 1
        ? pending.promise
        : Promise.resolve(protocols);
    },
  });
  h.next();
  assert.equal(h.sockets.length, 0);
  assert.deepEqual(refreshes, [false]);
  h.wake();
  h.channel.refresh();
  assert.equal(h.timers.size, 1);
  assert.deepEqual(refreshes, [false]);
  pending.resolve(protocols);
  await flush();
  assert.equal(h.sockets.length, 1);
  assert.deepEqual(h.sockets[0].protocols, protocols);
  assert.equal(h.sockets[0].url.includes("bearer"), false);
  h.sockets[0].receive(snapshot());
  h.sockets[0].fail();
  assert.equal(h.next(), 500);
  await flush();
  assert.deepEqual(refreshes, [false, true]);
  assert.equal(h.sockets.length, 2);
  h.channel.stop();
});

test("stopping or invalidating the auth user while token preparation is pending never opens a socket", async () => {
  for (const invalidate of [
    (h) => h.channel.stop(),
    (h) => h.setActive(false),
  ]) {
    const pending = deferred();
    const h = harness({ getProtocols: () => pending.promise });
    h.next();
    invalidate(h);
    pending.resolve(["mons-reactions-v1", "bearer.old.user.token"]);
    await flush();
    assert.equal(h.sockets.length, 0);
    assert.equal(h.errors.length, 0);
    h.channel.stop();
    assert.equal(h.timers.size, 0);
    assert.equal(h.listenerCount(), 0);
  }
});

test("the handshake deadline includes token preparation and ignores late tokens from earlier attempts", async () => {
  const first = deferred();
  const second = deferred();
  const refreshes = [];
  const h = harness({
    getProtocols: (forceRefresh) => {
      refreshes.push(forceRefresh);
      return refreshes.length === 1 ? first.promise : second.promise;
    },
  });
  h.next();
  assert.equal(h.next(), REACTION_HEARTBEAT_TIMEOUT_MS);
  assert.equal(h.errors.length, 1);
  assert.equal(h.next(), 500);
  assert.deepEqual(refreshes, [false, true]);
  first.resolve(["mons-reactions-v1", "bearer.stale.payload.signature"]);
  await flush();
  assert.equal(h.sockets.length, 0);
  second.resolve(["mons-reactions-v1", "bearer.fresh.payload.signature"]);
  await flush();
  assert.equal(h.sockets.length, 1);
  assert.equal(h.sockets[0].protocols[1], "bearer.fresh.payload.signature");
  h.sockets[0].receive(snapshot());
  h.channel.stop();
});

test("rejects tokens resolved beyond the handshake deadline even when the timer callback is delayed", async (t) => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const pending = deferred();
  const h = harness({ getProtocols: () => pending.promise });
  h.next();
  now += REACTION_HEARTBEAT_TIMEOUT_MS;
  pending.resolve(["mons-reactions-v1", "bearer.late.payload.signature"]);
  await flush();
  assert.equal(h.sockets.length, 0);
  assert.equal(h.errors.length, 1);
  assert.equal(h.next(), 500);
  h.channel.stop();
});

test("sanitizes token preparation and native socket errors before reporting failures", async () => {
  for (const getProtocols of [
    () => Promise.reject(new Error("secret-token-in-auth-error")),
    () => {
      throw new Error("secret-token-in-auth-error");
    },
  ]) {
    const h = harness({ getProtocols });
    h.next();
    await flush();
    assert.equal(h.errors.length, 1);
    assert.equal(h.errors[0].message, "reaction-channel-unavailable");
    assert.equal(h.sockets.length, 0);
    h.channel.stop();
  }
  const h = harness({
    createError: true,
    getProtocols: async () => [
      "mons-reactions-v1",
      "bearer.secret.payload.signature",
    ],
  });
  h.next();
  await flush();
  assert.equal(h.errors[0].message, "reaction-channel-unavailable");
  h.channel.stop();
});

test("stale rejected tokens cannot cancel a newer connection attempt", async () => {
  const first = deferred();
  const second = deferred();
  let attempts = 0;
  const h = harness({
    getProtocols: () => (++attempts === 1 ? first.promise : second.promise),
  });
  h.next();
  h.next();
  h.next();
  first.reject(new Error("stale-auth-error"));
  await flush();
  assert.equal(h.errors.length, 1);
  second.resolve(["mons-reactions-v1", "bearer.current.payload.signature"]);
  await flush();
  assert.equal(h.sockets.length, 1);
  h.channel.stop();
});
