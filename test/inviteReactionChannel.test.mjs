import { createTimerHandle } from "./fixtures/timerHandle.mjs";
import { required } from "./fixtures/canonicalData.mjs";
import { createConnectionWagerClientHarness } from "./wagerClientHarness.mjs";
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
const snapshot = (reactions = {}, matchId = "invite") => ({
  schemaVersion: 2,
  type: "snapshot",
  reactions,
  presentation: { matchId, players: {} },
});
const event = (value = reaction(), senderUid = "guest") => ({
  schemaVersion: 2,
  type: "reaction",
  senderUid,
  reaction: value,
});

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
/** @param {Partial<Pick<ConstructorParameters<typeof InviteReactionChannel>[0], "inviteId" | "matchId" | "getProtocols">> & {online?: boolean; visible?: boolean; createError?: boolean; paired?: boolean}} [options] */
function harness({
  inviteId = "invite",
  matchId = "invite",
  online = true,
  paired = true,
  createError = false,
  getProtocols,
} = {}) {
  let active = true;
  /**
   * @type {(() => void) | null}
   */
  let wake;
  /** @type {Map<ReturnType<typeof createTimerHandle>, { callback: () => void; delayMs: number }>} */
  const timers = new Map();
  /** @type {HarnessSocket[]} */
  const sockets = [];
  /**
   * @type {Record<string, import("@mons/shared/reactions").InviteReaction>[]}
   */
  const initial = [];
  /**
   * @type {{ reaction: import("@mons/shared/reactions").InviteReaction; senderUid: string; }[]}
   */
  const updates = [];
  /** @type {Array<Error>} */
  const errors = [];
  /**
   * @type {import("@mons/shared/match-presentation").MatchPresentationSnapshot[]}
   */
  const presentationSnapshots = [];
  /**
   * @type {import("@mons/shared/match-presentation").MatchPresentation[]}
   */
  const presentations = [];
  const channel = new InviteReactionChannel({
    inviteId,
    matchId,
    createSocket(url, protocols) {
      if (createError) throw new Error("socket-construction-failed");
      /** @type {HarnessSocket} */
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
    ...(getProtocols === undefined ? {} : { getProtocols }),
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
    onError: (error) => {
      assert.ok(error instanceof Error);
      errors.push(error);
    },
    setTimer(callback, delayMs) {
      const id = createTimerHandle();
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
      const [id, timer] = required(timers.entries().next().value);
      timers.delete(id);
      timer.callback();
      return timer.delayMs;
    },
    wake: () => wake?.(),
    listenerCount: () => Number(!!wake),
    setActive: (/** @type {boolean} */ value) => {
      active = value;
    },
    setOnline: (/** @type {boolean} */ value) => {
      online = value;
    },
    setPaired: (/** @type {boolean} */ value) => {
      paired = value;
    },
  };
}

test("first connection baselines latest reactions silently, then delivers both voice and stickers", () => {
  const h = harness();
  assert.equal(h.next(), 0);
  const socket = h.sockets[0];
  assert.equal(
    required(socket).url,
    "wss://api.mons.link/invites/invite/reactions/socket?matchId=invite",
  );
  assert.deepEqual(required(socket).protocols, [
    "mons-reactions-v2",
    "mons-data-v1",
  ]);
  required(socket).receive(snapshot({ host: reaction() }));
  assert.deepEqual(h.initial, [{ host: reaction() }]);
  assert.equal(h.updates.length, 0);
  required(socket).receive(event(reaction(2)));
  required(socket).receive(
    event(reaction(3, { kind: "sticker", variation: 900316 })),
  );
  assert.deepEqual(
    h.updates.map(({ reaction }) => reaction.kind),
    ["yo", "sticker"],
  );
  h.channel.stop();
});

test("reconnect forwards latest per sender to the existing UUID-deduplicating consumer without rebasing", () => {
  const h = harness();
  h.next();
  required(h.sockets[0]).receive(snapshot({ host: reaction() }));
  required(h.sockets[0]).receive(event(reaction(2)));
  required(h.sockets[0]).fail();
  assert.equal(h.next(), 500);
  required(h.sockets[1]).receive(
    snapshot({ host: reaction(), guest: reaction(4) }),
  );
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
  required(socket).receive(snapshot());
  assert.equal(h.next(), REACTION_HEARTBEAT_INTERVAL_MS);
  assert.deepEqual(required(socket).sent, ["ping"]);
  required(socket).receive("pong");
  assert.equal(h.timers.size, 1);
  assert.equal(h.next(), REACTION_HEARTBEAT_INTERVAL_MS);
  assert.equal(h.next(), REACTION_HEARTBEAT_TIMEOUT_MS);
  assert.equal(required(socket).closes, 1);
  assert.equal(h.next(), 500);
  assert.equal(h.sockets.length, 2);
  h.channel.stop();
});

test("bounds reconnect backoff and resets it only after a valid snapshot", () => {
  const h = harness();
  h.next();
  for (const delay of [...REACTION_RECONNECT_DELAYS_MS, 15_000]) {
    required(h.sockets.at(-1)).fail();
    assert.equal(h.next(), delay);
  }
  required(h.sockets.at(-1)).receive(snapshot());
  required(h.sockets.at(-1)).fail();
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
  required(h.sockets[0]).fail();
  h.channel.refresh();
  assert.equal(h.next(), 0);
  required(h.sockets[1]).receive(snapshot());
  h.wake();
  assert.equal(h.sockets.length, 2);
  assert.equal(h.timers.size, 1);
  h.channel.stop();
});

test("a new rematch context baselines independently and cannot receive old context events", () => {
  const old = harness();
  old.next();
  required(old.sockets[0]).receive(snapshot());
  const staleCallback = required(old.sockets[0]).onmessage;
  old.channel.stop();
  const rematch = harness();
  rematch.next();
  required(rematch.sockets[0]).receive(
    snapshot({ guest: reaction(2, { matchId: "invite1" }) }),
  );
  required(staleCallback)({ data: JSON.stringify(event(reaction(3))) });
  assert.equal(old.updates.length, 0);
  assert.equal(rematch.updates.length, 0);
  assert.equal(rematch.initial.length, 1);
  rematch.channel.stop();
});

test("teardown aborts sends and releases all listeners, timers and socket handlers exactly once", () => {
  const h = harness();
  h.next();
  const socket = h.sockets[0];
  const lateMessage = required(socket).onmessage;
  const lateClose = required(socket).onclose;
  h.channel.stop();
  h.channel.stop();
  required(lateMessage)({ data: JSON.stringify(snapshot()) });
  required(lateClose)();
  h.channel.refresh();
  assert.equal(h.channel.signal.aborted, true);
  assert.equal(h.timers.size, 0);
  assert.equal(h.listenerCount(), 0);
  assert.equal(required(socket).closes, 1);
  assert.equal(required(socket).onmessage, null);
  assert.equal(h.initial.length, 0);
});

test("session or auth invalidation drops all callbacks even before explicit cleanup", () => {
  const h = harness();
  h.next();
  h.setActive(false);
  required(h.sockets[0]).receive(snapshot());
  required(h.sockets[0]).receive(event());
  required(h.sockets[0]).fail();
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
    "x".repeat(16385),
    event(),
    snapshot({ host: reaction(1, { matchId: "other" }) }),
    { ...snapshot(), schemaVersion: 1 },
  ]) {
    const h = harness();
    h.next();
    required(h.sockets[0]).receive(badFrame);
    assert.equal(h.errors.length, 1);
    assert.equal(h.initial.length, 0);
    assert.equal(h.updates.length, 0);
    assert.equal(required(h.sockets[0]).closes, 1);
    h.channel.stop();
  }
  const h = harness();
  h.next();
  required(h.sockets[0]).receive(snapshot());
  required(h.sockets[0]).receive(snapshot());
  assert.equal(h.errors.length, 1);
  h.channel.stop();
});

test("times out connections without a first snapshot and handles socket-construction failure", () => {
  const h = harness();
  h.next();
  assert.equal(h.next(), REACTION_HEARTBEAT_TIMEOUT_MS);
  assert.equal(required(h.sockets[0]).closes, 1);
  assert.equal(h.next(), 500);
  h.channel.stop();
  const failed = harness({ createError: true });
  failed.next();
  assert.equal(failed.errors.length, 1);
  assert.equal(failed.next(), 500);
  failed.channel.stop();
});

test("the actual session auth callback tears down participant and spectator resources on cross-tab signout or user replacement", async () => {
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
  assert.ok(declaration && ts.isClassDeclaration(declaration));
  const methods = [
    "subscribeToAuthChanges",
    "observeInviteReactions",
    "cleanupInviteReactionObserver",
    "cleanupInviteMetadataObserver",
    "stopObservingAllMatches",
  ].map((name) => {
    const method = required(declaration).members.find(
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
  /** @typedef {typeof import("../src/connection/connection.ts").connection} SourceConnection */
  /** @typedef {import("../src/session/sessionAuth.ts").SessionUser} SessionUser */
  /** @typedef {{auth: Pick<import("../src/session/sessionAuth.ts").SessionAuth, "currentUser" | "getTokenRemainingMs" | "onAuthStateChanged">; currentUid: string | null; sessionEpoch: number; activeContext: SourceConnection["activeContext"]; authUnsubscribers: Set<() => void>; latestInvite: {hostId: string; guestId: string}; inviteReactionSubscription: SourceConnection["inviteReactionSubscription"]; observedMatchSnapshots: Map<string, unknown>; rememberMatchPresentation: SourceConnection["rememberMatchPresentation"]; isContextActive: SourceConnection["isContextActive"]; isCurrentAuthUser: SourceConnection["isCurrentAuthUser"]; registerObserverCleanup: SourceConnection["registerObserverCleanup"]; unregisterObserverCleanup: SourceConnection["unregisterObserverCleanup"]; eventClient: {reset(): void}; refreshMoveDeliveries(): void; refreshRematchEndDeliveries(): void; getUserBoundAuthTokenProvider: SourceConnection["getUserBoundAuthTokenProvider"]; flushPendingMoves: SourceConnection["flushPendingMoves"]; wagerClient: SourceConnection["wagerClient"]; observeInviteReactions: SourceConnection["observeInviteReactions"]; subscribeToAuthChanges: SourceConnection["subscribeToAuthChanges"]}} FixtureConnection */
  /** @param {string} uid @returns {SessionUser} */
  const user = (uid) => ({
    uid,
    sessionId: "session",
    generation: "generation",
    getIdToken: async () => "header.payload.signature",
  });
  for (const [
    newUser,
    canWrite,
  ] of /** @satisfies {Array<[SessionUser | null, boolean]>} */ ([
    [null, false],
    [user("replacement-login"), false],
    [null, true],
    [user("replacement-login"), true],
  ])) {
    /** @type {Map<ReturnType<typeof createTimerHandle>, {callback: () => void; delayMs: number}>} */
    const timers = new Map();
    /** @type {Map<string, () => void>} */
    const listeners = new Map();
    /** @type {Map<string, () => void>} */
    const observers = new Map();
    /** @type {Map<string, number>} */
    const counters = new Map();
    /** @type {{authCallback?: (user: SessionUser | null) => void; socket?: SessionSocket}} */
    const captured = {};
    class SessionSocket {
      readyState = 0;
      closes = 0;
      /** @type {((event: {data: unknown}) => void) | null} */
      onmessage = null;
      /** @param {string} _url @param {string[]} [protocols] */
      constructor(_url, protocols) {
        captured.socket = this;
        this.protocols = protocols;
      }
      close() {
        this.closes++;
        this.readyState = 3;
      }
    }
    const surface = {
      visibilityState: "visible",
      addEventListener: (
        /** @type {string} */ kind,
        /** @type {() => void} */ callback,
      ) => listeners.set(kind, callback),
      removeEventListener: (/** @type {string} */ kind) =>
        listeners.delete(kind),
    };
    const dependencies = {
      InviteReactionChannel,
      MatchPresentationState,
      readMatchPresentationViaApi: async (
        /** @type {string} */ _inviteId,
        /** @type {string} */ matchId,
      ) => ({
        ok: true,
        presentation: { matchId, players: {} },
      }),
      updateMatchPresentationViaApi: () =>
        assert.fail("unexpected presentation write"),
      didReceiveMatchPresentationUpdate: () => undefined,
      createInviteReactionSocketProtocols,
      WebSocket: SessionSocket,
      window: surface,
      document: surface,
      navigator: { onLine: true },
      setTimeout: (
        /** @type {() => void} */ callback,
        /** @type {number} */ delayMs,
      ) => {
        const id = createTimerHandle();
        timers.set(id, { callback, delayMs });
        return id;
      },
      clearTimeout: (/** @type {ReturnType<typeof createTimerHandle>} */ id) =>
        timers.delete(id),
      incrementLifecycleCounter: (/** @type {string} */ kind) =>
        counters.set(kind, (counters.get(kind) ?? 0) + 1),
      decrementLifecycleCounter: (/** @type {string} */ kind) =>
        counters.set(kind, required(counters.get(kind)) - 1),
      didRecoverInviteReactions: () => undefined,
      didReceiveInviteReactionUpdate: () => undefined,
    };
    const Constructor = /** @type {new () => FixtureConnection} */ (
      new Function(
        ...Object.keys(dependencies),
        `${outputText}\nreturn Connection;`,
      )(...Object.values(dependencies))
    );
    /** @type {FixtureConnection} */
    const connection = Object.assign(
      new Constructor(),
      /** @satisfies {Partial<FixtureConnection>} */ ({
        auth: {
          currentUser: user("original-login"),
          getTokenRemainingMs: () => 300_000,
          onAuthStateChanged: (callback) => {
            captured.authCallback = callback;
            return () => undefined;
          },
        },
        currentUid: "original-login",
        sessionEpoch: 1,
        flushPendingMoves: async () => assert.fail("unexpected move flush"),
        authUnsubscribers: new Set(),
        activeContext: {
          contextId: 1,
          sessionEpoch: 1,
          inviteId: "invite",
          matchId: "invite",
          actorUid: canWrite ? "host" : null,
          loginUid: "original-login",
          canWrite,
          role: canWrite ? "host" : "watch",
          createdAtMs: 0,
        },
        latestInvite: { hostId: "host", guestId: "guest" },
        inviteReactionSubscription: null,
        observedMatchSnapshots: new Map([["old-match", {}]]),
        rememberMatchPresentation: () => undefined,
        isContextActive: () => true,
        /**
         * @param {string} uid
         */
        isCurrentAuthUser(uid) {
          return connection.auth.currentUser?.uid === uid;
        },
        registerObserverCleanup: (_contextId, key, cleanup) => {
          observers.set(key, cleanup);
          return true;
        },
        unregisterObserverCleanup: (_contextId, key) => observers.delete(key),
        eventClient: { reset: () => undefined },
        refreshMoveDeliveries: () => undefined,
        refreshRematchEndDeliveries: () => undefined,
        getUserBoundAuthTokenProvider(uid) {
          assert.equal(uid, "original-login");
          return Object.assign(
            async (/** @type {boolean | undefined} */ forceRefresh) => {
              assert.equal(forceRefresh, false);
              return "header.payload.signature";
            },
            {
              assertCurrentUser: () =>
                assert.equal(required(connection.auth.currentUser).uid, uid),
            },
          );
        },
      }),
    );
    const wagerHarness = createConnectionWagerClientHarness(connection);
    connection.wagerClient = wagerHarness.client;
    const pendingMutations =
      /** @type {SourceConnection["wagerClient"]["pendingWagerMutations"]} */ (
        Reflect.get(connection.wagerClient, "pendingWagerMutations")
      );
    pendingMutations.add({});
    connection.observeInviteReactions();
    const [timerId, timer] = required(timers.entries().next().value);
    timers.delete(timerId);
    timer.callback();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(
      required(captured.socket).protocols,
      canWrite
        ? [
            "mons-reactions-v2",
            "bearer.header.payload.signature",
            "mons-data-v1",
          ]
        : ["mons-reactions-v2", "mons-data-v1"],
    );
    const signal = required(connection.inviteReactionSubscription).channel
      .signal;
    const presentationSignal = required(connection.inviteReactionSubscription)
      .presentation.signal;
    const unsubscribe = connection.subscribeToAuthChanges(() => {
      assert.equal(signal.aborted, true);
    });
    required(captured.authCallback)(user("original-login"));
    assert.equal(signal.aborted, false);
    assert.equal(listeners.size, 3);
    connection.auth.currentUser = newUser;
    required(captured.authCallback)(newUser);
    assert.equal(signal.aborted, true);
    assert.equal(pendingMutations.size, 0);
    assert.equal(
      Reflect.get(connection.wagerClient, "wagerSnapshotGeneration"),
      1,
    );
    assert.equal(presentationSignal.aborted, true);
    assert.equal(required(captured.socket).closes, 1);
    assert.equal(required(captured.socket).onmessage, null);
    assert.equal(timers.size, 0);
    assert.equal(listeners.size, 0);
    assert.equal(observers.size, 0);
    assert.equal(counters.get("connectionObservers"), 0);
    assert.equal(connection.inviteReactionSubscription, null);
    required(captured.authCallback)(newUser);
    assert.equal(required(captured.socket).closes, 1);
    unsubscribe();
    assert.equal(counters.get("connectionAuthSubscribers"), 0);
  }
});

const flush = () => new Promise((resolve) => setImmediate(resolve));
/**
 * @template [T=string[]]
 * @returns {PromiseWithResolvers<T>}
 */
const deferred = () => {
  return Promise.withResolvers();
};

const presentation = (revision = 1, overrides = {}) => ({
  matchId: "invite",
  actorUid: "host",
  emojiId: 1,
  aura: "none",
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
  assert.equal(
    new URL(required(socket).url).searchParams.get("matchId"),
    "invite",
  );
  assert.deepEqual(required(socket).protocols, [
    "mons-reactions-v2",
    "mons-data-v1",
  ]);
  required(socket).receive(roomSnapshot(presentation(), { host: reaction() }));
  assert.equal(h.presentationSnapshots.length, 1);
  assert.equal(h.initial.length, 1);
  assert.equal(h.updates.length, 0);
  required(socket).receive({
    schemaVersion: 2,
    type: "presentation",
    presentation: presentation(2),
  });
  assert.deepEqual(h.presentations, [presentation(2)]);
  assert.equal(h.updates.length, 0);
  required(socket).fail();
  h.next();
  required(h.sockets[1]).receive(
    roomSnapshot(presentation(2), { host: reaction() }),
  );
  assert.equal(h.presentationSnapshots.length, 2);
  assert.equal(h.initial.length, 1);
  assert.equal(h.updates.length, 1);
  h.channel.stop();
});

test("v2 participants preserve bearer protocols and reject missing, foreign, premature or oversized presentation frames", async () => {
  for (const frame of [
    { ...snapshot(), presentation: undefined },
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
    assert.deepEqual(required(socket).protocols, [
      "mons-reactions-v2",
      "bearer.header.payload.signature",
      "mons-data-v1",
    ]);
    required(socket).receive(frame);
    assert.equal(h.errors.length, 1);
    assert.equal(h.presentations.length, 0);
    assert.equal(h.presentationSnapshots.length, 0);
    h.channel.stop();
  }
});

test("v2 rematch contexts discard old socket callbacks and reject foreign presentation events", () => {
  const old = harness({ matchId: "invite" });
  old.next();
  required(old.sockets[0]).receive(roomSnapshot());
  const late = required(old.sockets[0]).onmessage;
  old.channel.stop();
  const next = harness({ matchId: "invite1" });
  next.next();
  required(next.sockets[0]).receive(
    roomSnapshot(presentation(1, { matchId: "invite1" })),
  );
  required(late)({
    data: JSON.stringify({
      schemaVersion: 2,
      type: "presentation",
      presentation: presentation(2),
    }),
  });
  assert.equal(old.presentations.length, 0);
  required(next.sockets[0]).receive({
    schemaVersion: 2,
    type: "presentation",
    presentation: presentation(2),
  });
  assert.equal(next.presentations.length, 0);
  assert.equal(next.errors.length, 1);
  next.channel.stop();
});

test("v2 accepts maximal escaped match keys within the bounded room frame size", () => {
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
  required(h.sockets[0]).receive(encoded);
  assert.equal(h.errors.length, 0);
  assert.equal(h.presentationSnapshots.length, 1);
  h.channel.stop();
});

test("participant sockets await auth protocols and force-refresh authentication on reconnect", async () => {
  const pending = deferred();
  /** @type {Array<boolean>} */
  const refreshes = [];
  const protocols = [
    "mons-reactions-v2",
    "bearer.header.payload.signature",
    "mons-data-v1",
  ];
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
  assert.deepEqual(required(h.sockets[0]).protocols, protocols);
  assert.equal(required(h.sockets[0]).url.includes("bearer"), false);
  required(h.sockets[0]).receive(snapshot());
  required(h.sockets[0]).fail();
  assert.equal(h.next(), 500);
  await flush();
  assert.deepEqual(refreshes, [false, true]);
  assert.equal(h.sockets.length, 2);
  h.channel.stop();
});

test("stopping or invalidating the auth user while token preparation is pending never opens a socket", async () => {
  for (const invalidate of [
    (/** @type {ReturnType<typeof harness>} */ h) => h.channel.stop(),
    (/** @type {ReturnType<typeof harness>} */ h) => h.setActive(false),
  ]) {
    const pending = deferred();
    const h = harness({ getProtocols: () => pending.promise });
    h.next();
    invalidate(h);
    pending.resolve([
      "mons-reactions-v2",
      "bearer.old.user.token",
      "mons-data-v1",
    ]);
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
  /** @type {Array<boolean>} */
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
  first.resolve([
    "mons-reactions-v2",
    "bearer.stale.payload.signature",
    "mons-data-v1",
  ]);
  await flush();
  assert.equal(h.sockets.length, 0);
  second.resolve([
    "mons-reactions-v2",
    "bearer.fresh.payload.signature",
    "mons-data-v1",
  ]);
  await flush();
  assert.equal(h.sockets.length, 1);
  assert.equal(
    required(required(h.sockets[0]).protocols)[1],
    "bearer.fresh.payload.signature",
  );
  required(h.sockets[0]).receive(snapshot());
  h.channel.stop();
});

test("rejects tokens resolved beyond the handshake deadline even when the timer callback is delayed", async (t) => {
  let now = performance.now();
  t.mock.method(performance, "now", () => now);
  const pending = deferred();
  const h = harness({ getProtocols: () => pending.promise });
  h.next();
  now += REACTION_HEARTBEAT_TIMEOUT_MS;
  pending.resolve([
    "mons-reactions-v2",
    "bearer.late.payload.signature",
    "mons-data-v1",
  ]);
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
    assert.equal(required(h.errors[0]).message, "reaction-channel-unavailable");
    assert.equal(h.sockets.length, 0);
    h.channel.stop();
  }
  const h = harness({
    createError: true,
    getProtocols: async () => [
      "mons-reactions-v2",
      "bearer.secret.payload.signature",
      "mons-data-v1",
    ],
  });
  h.next();
  await flush();
  assert.equal(required(h.errors[0]).message, "reaction-channel-unavailable");
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
  second.resolve([
    "mons-reactions-v2",
    "bearer.current.payload.signature",
    "mons-data-v1",
  ]);
  await flush();
  assert.equal(h.sockets.length, 1);
  h.channel.stop();
});
