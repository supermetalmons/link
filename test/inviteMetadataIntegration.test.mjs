import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { InviteMetadataState } from "../src/connection/inviteMetadataState.ts";
import { InviteMetadataApiError } from "../src/services/inviteMetadataApi.ts";
import { withAutomatchOperationLock } from "../src/connection/automatchOperationLock.ts";
import { isAutoInviteId } from "../cloud/functions/shared/ids.js";
import {
  parseRematchIndices,
  rematchSeriesEnded,
} from "../cloud/functions/shared/rematches.js";

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
const names = [
  "clearPendingAutomatchRequest",
  "reconcilePendingAutomatchRequest",
  "beginConnectAttempt",
  "isConnectAttemptActive",
  "isContextActive",
  "isCurrentAuthUser",
  "registerObserverCleanup",
  "unregisterObserverCleanup",
  "cleanupObserverContext",
  "clearAllObserverContexts",
  "buildRuntimeContext",
  "activateContext",
  "clearActiveContext",
  "bumpSessionEpoch",
  "isSessionEpochActive",
  "createMatchContextGuard",
  "requireWritableContext",
  "detachFromMatchSession",
  "fetchInviteWithPendingCreation",
  "connectToGame",
  "applyInviteMetadata",
  "observeInviteMetadata",
  "cleanupInviteMetadataObserver",
  "cleanupInviteReactionObserver",
  "cleanupWagerObserver",
  "stopObservingAllMatches",
  "rematchSeriesEndIsIndicatedForInvite",
  "getLatestBothSidesApprovedRematchIndexForInvite",
  "getLatestBothSidesApprovedRematchIndex",
  "getLatestMatchIdForActor",
  "approvedRematchIndices",
  "maybeRefreshContextAfterRematchMetadata",
  "tryNavigateWatchOnlyToLatestApprovedMatch",
  "sendRematchProposal",
  "sendEndMatchIndicator",
  "rematchSeriesEndIsIndicated",
  "subscribeToAuthChanges",
];
const methods = names.map((name) => {
  const method = declaration.members.find(
    (node) => node.name?.getText(source) === name,
  );
  assert.ok(method, `missing Connection.${name}`);
  return method.getText(source);
});
const { outputText } = ts.transpileModule(
  `class Connection { ${methods.join("\n")} }`.replaceAll(
    "import.meta.env.DEV",
    "false",
  ),
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
);

const snapshot = (overrides = {}) => ({
  inviteId: "invite",
  revision: 1,
  hostId: "host",
  guestId: "guest",
  hostColor: "white",
  hostRematches: "",
  guestRematches: "",
  automatchStateHint: null,
  eventId: null,
  eventOwned: false,
  ...overrides,
});
const response = (value = snapshot(), viewer = {}) => ({
  ok: true,
  snapshot: value,
  viewer: {
    role: "host",
    actorUid: "host",
    automatchOperationId: null,
    ...viewer,
  },
});
const match = {
  version: 1,
  color: "white",
  emojiId: 1,
  fen: "fen",
  gameVariant: "classic",
  status: "",
  flatMovesString: "",
  timer: "",
};
const settle = () => new Promise((resolve) => setImmediate(resolve));
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
  initial = response(),
  loginUid = "login",
  wagers = { invite: { proposals: {} } },
  read,
  join,
  propose,
  end,
  onMetadata,
} = {}) {
  const events = {
    reads: [],
    firebaseReads: [],
    auth: [],
    home: [],
    ui: [],
    observed: [],
    channels: [],
    metadata: [],
    errors: [],
    wagering: [],
  };
  const cleanups = new Map();
  const counters = new Map();
  const operations = new Map();
  let instance;
  let authCallback;
  let currentResponse = initial;
  const noop = () => undefined;
  const dependencies = {
    InviteMetadataState,
    InviteMetadataApiError,
    withAutomatchOperationLock,
    isAutoInviteId,
    parseRematchIndices,
    rematchSeriesEnded,
    storage: {
      getPendingAutomatchOperation: (uid) => operations.get(uid) ?? null,
      setPendingAutomatchOperation: (uid, value) =>
        value ? operations.set(uid, value) : operations.delete(uid),
      getPlayerEmojiAura: () => "",
    },
    InviteMetadataChannel: class {
      constructor(dependencies) {
        this.dependencies = dependencies;
        this.controller = new AbortController();
        this.signal = this.controller.signal;
        this.stops = 0;
        this.refreshes = 0;
        events.channels.push(this);
      }
      stop() {
        this.stops++;
        this.controller.abort();
      }
      requestRefresh() {
        this.refreshes++;
      }
      emit(value, viewer) {
        this.dependencies.onSnapshot(value, viewer);
      }
    },
    readInviteMetadataViaApi: async (inviteId, provider, options) => {
      events.reads.push({ inviteId, provider, signal: options.signal });
      return read ? read(events.reads.length, options.signal) : currentResponse;
    },
    createInviteMetadataSocketProtocols: (token) => [
      "mons-invite-metadata-v1",
      `bearer.${token}`,
    ],
    joinInviteViaApi: async (...args) => {
      events.ui.push("join-request");
      return join ? join(...args) : { ok: true };
    },
    proposeRematchViaApi: async (...args) =>
      propose
        ? propose(...args)
        : {
            ok: true,
            inviteId: "invite",
            actorUid: "host",
            matchId: "invite1",
            rematches: "1",
            match,
          },
    endRematchViaApi: async (...args) =>
      end
        ? end(...args)
        : { ok: true, inviteId: "invite", actorUid: "host", rematches: "x" },
    ref: (_db, path) => path,
    get: async (path) => {
      events.firebaseReads.push(path);
      assert.ok(
        path.endsWith("/wagers") || path.startsWith("players/"),
        `unexpected Firebase invite read: ${path}`,
      );
      return { val: () => (path.endsWith("/wagers") ? wagers : match) };
    },
    off: noop,
    getPlayersEmojiId: () => 1,
    transitionToHome: async (options) => {
      events.home.push(options);
      instance.detachFromMatchSession();
    },
    didFailToLoadPendingInvite: () => events.ui.push("pending-failed"),
    didFindInviteThatCanBeJoined: () => events.ui.push("join-button"),
    enterWatchOnlyMode: () => events.ui.push("watch"),
    didRecoverMyMatch: () => events.ui.push("recover"),
    didDiscoverExistingRematchProposalWaitingForResponse: () =>
      events.ui.push("pending-rematch"),
    didFindYourOwnInviteThatNobodyJoined: () => events.ui.push("waiting"),
    didUpdateRematchSeriesMetadata: () => {
      events.metadata.push([
        instance.latestInvite.hostRematches,
        instance.latestInvite.guestRematches,
      ]);
      onMetadata?.(instance);
    },
    didReceiveRematchesSeriesEndIndicator: () => events.ui.push("ended"),
    didJustCreateRematchProposalSuccessfully: () =>
      events.ui.push("proposal-created"),
    failedToCreateRematchProposal: () => events.ui.push("proposal-failed"),
    setCurrentWagerMatch: noop,
    incrementLifecycleCounter: (key) =>
      counters.set(key, (counters.get(key) ?? 0) + 1),
    decrementLifecycleCounter: (key, count = 1) =>
      counters.set(key, (counters.get(key) ?? 0) - count),
    onAuthStateChanged: (_auth, callback) => {
      authCallback = callback;
      return noop;
    },
    console: {
      log: noop,
      warn: noop,
      error: (...args) => events.errors.push(args),
    },
  };
  const Constructor = new Function(
    ...Object.keys(dependencies),
    `${outputText}\nreturn Connection;`,
  )(...Object.values(dependencies));
  instance = Object.assign(new Constructor(), {
    auth: { currentUser: { uid: loginUid } },
    currentUid: loginUid,
    authUnsubscribers: new Set(),
    sessionEpoch: 1,
    connectAttemptId: 0,
    nextContextId: 1,
    activeContext: null,
    matchRefs: {},
    observedMatchSnapshots: new Map(),
    matchPresentations: new Map(),
    optimisticResolvedMatchIds: new Set(),
    getUserBoundAuthTokenProvider: (expectedUid = loginUid) => {
      events.auth.push(expectedUid);
      return Object.assign(async () => "header.payload.signature", {
        assertCurrentUser: () =>
          assert.equal(instance.auth.currentUser?.uid, expectedUid),
      });
    },
    hasPendingInviteCreationFor: () => false,
    waitForPendingInviteCreation: async () => false,
    notifyNavigationGamesChanged: noop,
    logContextEvent: noop,
    setSameProfilePlayerUid: noop,
    clearEventSyncCaches: noop,
    updateWagerStateForCurrentMatch: () =>
      events.wagering.push(instance.latestInvite?.wagers),
    observeInviteReactions: noop,
    observeWagers: noop,
    observeMatch: (uid, matchId) => events.observed.push([uid, matchId]),
    refreshTokenIfNeeded: async () => events.ui.push("refresh-claims"),
    getRematchIndexAvailableForNewProposal: () => 1,
    getCachedHistoricalMatchPair: () => null,
    observerRegistry: {
      register(contextId, key, cleanup) {
        const name = `${contextId}:${key}`;
        if (cleanups.has(name)) return false;
        cleanups.set(name, cleanup);
        return true;
      },
      unregister: (contextId, key) => cleanups.delete(`${contextId}:${key}`),
      cleanupContext: (contextId) => {
        for (const [key, cleanup] of cleanups)
          if (key.startsWith(`${contextId}:`)) cleanup();
      },
      clear: () => {
        for (const cleanup of cleanups.values()) cleanup();
      },
    },
  });
  return {
    instance,
    events,
    counters,
    operations,
    cleanups,
    setResponse: (value) => {
      currentResponse = value;
    },
    async connect(autojoin = false) {
      instance.connectToGame(loginUid, initial.snapshot.inviteId, autojoin);
      await settle();
      assert.deepEqual(events.errors, []);
    },
    channel: () => events.channels.at(-1),
    authChange: (user) => {
      instance.auth.currentUser = user;
      authCallback(user);
    },
  };
}

test("metadata bootstrap preserves linked-login actors and loads existing wagers before recovery", async () => {
  const wagers = { invite: { agreed: { count: 3 } } };
  const h = harness({ wagers });
  await h.connect();
  assert.deepEqual(h.events.firebaseReads, [
    "invites/invite/wagers",
    "players/host/matches/invite",
  ]);
  assert.equal(h.instance.activeContext.loginUid, "login");
  assert.equal(h.instance.activeContext.actorUid, "host");
  assert.strictEqual(h.events.wagering[0], wagers);
  assert.ok(h.events.ui.includes("refresh-claims"));
  h.channel().emit(snapshot({ revision: 2, hostRematches: "1" }));
  assert.strictEqual(h.instance.latestInvite.wagers, wagers);
  h.instance.detachFromMatchSession();
});

test("private automatch denial joins before metadata retry and never reads the old invite root", async () => {
  const paired = response(snapshot({ inviteId: "auto_invite" }), {
    actorUid: "guest",
    role: "guest",
  });
  const h = harness({
    initial: paired,
    read: (attempt) => {
      if (attempt === 1) throw new InviteMetadataApiError("http-403", 403);
      return paired;
    },
  });
  await h.connect(true);
  assert.equal(h.events.reads.length, 2);
  assert.deepEqual(
    h.events.ui.filter((value) => value === "join-request"),
    ["join-request"],
  );
  assert.equal(h.instance.activeContext.actorUid, "guest");
  h.instance.detachFromMatchSession();
});

test("pending invite creation waits after missing metadata and reads the created invite", async () => {
  const h = harness({
    read: (attempt) => {
      if (attempt === 1) throw new InviteMetadataApiError("http-404", 404);
      return response();
    },
  });
  h.instance.pendingInviteCreation = {
    inviteId: "invite",
    promise: Promise.resolve(true),
  };
  h.instance.hasPendingInviteCreationFor = () => true;
  h.instance.waitForPendingInviteCreation = async () => true;
  await h.connect();
  assert.equal(h.events.reads.length, 2);
  assert.ok(h.events.ui.includes("recover"));
  assert.ok(!h.events.ui.includes("pending-failed"));
  h.instance.detachFromMatchSession();
});

test("a late bootstrap result after account replacement cannot activate a game", async () => {
  const pending = deferred();
  const h = harness({ read: () => pending.promise });
  h.instance.connectToGame("login", "invite", false);
  h.instance.auth.currentUser = { uid: "replacement" };
  pending.resolve(response());
  await settle();
  assert.equal(h.instance.activeContext, null);
  assert.equal(h.events.firebaseReads.length, 0);
  assert.equal(h.events.channels.length, 0);
});

test("uncertain manual joining recovers the authoritative viewer and paired metadata", async () => {
  const pending = response(snapshot({ guestId: null }), {
    actorUid: null,
    role: "watch",
  });
  const paired = response(snapshot({ revision: 2 }), {
    actorUid: "guest",
    role: "guest",
  });
  const h = harness({
    initial: pending,
    read: (attempt) => (attempt === 1 ? pending : paired),
    join: () => {
      throw new Error("request-timeout");
    },
  });
  await h.connect(true);
  assert.equal(h.instance.activeContext.role, "guest");
  assert.deepEqual(h.events.firebaseReads, [
    "invites/invite/wagers",
    "players/guest/matches/invite",
  ]);
  h.instance.detachFromMatchSession();
});

test("pending hosts observe a guest arrival and retain their existing wager snapshot", async () => {
  const h = harness({ initial: response(snapshot({ guestId: null })) });
  await h.connect();
  const current = h.instance.activeContext;
  h.instance.inviteReactionSubscription = {
    channel: { refresh: () => h.events.ui.push("reactions-woke") },
    stop() {},
  };
  h.channel().emit(snapshot({ revision: 2 }));
  assert.strictEqual(h.instance.activeContext, current);
  assert.deepEqual(h.events.observed, [["guest", "invite"]]);
  assert.ok(h.events.ui.includes("reactions-woke"));
  h.instance.detachFromMatchSession();
});

test("pending watchers re-resolve their role when another player takes the guest slot", async () => {
  const h = harness({
    initial: response(snapshot({ guestId: null }), {
      actorUid: null,
      role: "watch",
    }),
  });
  await h.connect();
  const reconnects = [];
  h.instance.connectToGame = (...args) => reconnects.push(args);
  h.channel().emit(snapshot({ revision: 2 }));
  assert.deepEqual(reconnects, [["login", "invite", false]]);
  assert.ok(h.events.ui.includes("join-button"));
  h.instance.detachFromMatchSession();
});

test("HTTP viewer updates reconcile private operation IDs even when metadata revision is unchanged", async () => {
  const h = harness();
  await h.connect();
  h.operations.set("login", {
    operationId: "private-operation",
    resolvedInviteId: null,
  });
  h.channel().emit(snapshot(), {
    role: "host",
    actorUid: "host",
    automatchOperationId: "private-operation",
  });
  await settle();
  assert.equal(h.operations.has("login"), false);
  assert.equal("automatchOperationId" in h.instance.latestInvite, false);
  h.instance.detachFromMatchSession();
});

test("both rematch sides update atomically and spectator navigation discards the old channel", async () => {
  const h = harness({
    initial: response(snapshot(), { actorUid: null, role: "watch" }),
    onMetadata: (instance) =>
      instance.tryNavigateWatchOnlyToLatestApprovedMatch(),
  });
  await h.connect();
  const old = h.channel();
  let staleRefreshes = 0;
  h.instance.maybeRefreshContextAfterRematchMetadata = () => staleRefreshes++;
  old.emit(snapshot({ revision: 2, hostRematches: "1", guestRematches: "1" }));
  assert.deepEqual(h.events.metadata, [["1", "1"]]);
  assert.equal(h.instance.activeContext.matchId, "invite1");
  assert.equal(old.stops, 1);
  assert.equal(staleRefreshes, 0);
  old.emit(
    snapshot({ revision: 3, hostRematches: "1;2", guestRematches: "1;2" }),
  );
  assert.equal(h.instance.activeContext.matchId, "invite1");
  assert.equal(h.events.metadata.length, 1);
  h.instance.detachFromMatchSession();
});

test("an unchanged first snapshot still reconciles rematch UI once for its new context", async () => {
  const value = snapshot({ hostRematches: "1", guestRematches: "1" });
  const h = harness({ initial: response(value) });
  await h.connect();
  h.channel().emit(value);
  h.channel().emit(value);
  assert.deepEqual(h.events.metadata, [["1", "1"]]);
  h.instance.detachFromMatchSession();
});

test("a pending local proposal defers context rotation and preserves a committed response against stale metadata", async () => {
  const pending = deferred();
  const h = harness({ propose: () => pending.promise });
  await h.connect();
  const previous = h.instance.activeContext;
  h.instance.sendRematchProposal();
  h.channel().emit(
    snapshot({ revision: 2, hostRematches: "1", guestRematches: "1" }),
  );
  assert.strictEqual(h.instance.activeContext, previous);
  pending.resolve({
    ok: true,
    inviteId: "invite",
    actorUid: "host",
    matchId: "invite1",
    rematches: "1",
    match,
  });
  await settle();
  assert.equal(h.instance.activeContext.matchId, "invite1");
  h.channel().emit(snapshot({ revision: 2 }));
  assert.equal(h.instance.latestInvite.hostRematches, "1");
  assert.equal(h.instance.latestInvite.guestRematches, "1");
  assert.ok(h.events.ui.includes("proposal-created"));
  h.instance.detachFromMatchSession();
});

test("end responses close the UI immediately and accept the opponent's canonical end marker", async () => {
  const h = harness();
  await h.connect();
  h.instance.sendEndMatchIndicator();
  await settle();
  assert.equal(h.events.ui.filter((value) => value === "ended").length, 1);
  assert.equal(h.channel().refreshes, 1);
  h.channel().emit(snapshot({ revision: 2, guestRematches: "x" }));
  assert.equal(h.instance.latestInvite.hostRematches, "");
  assert.equal(h.instance.latestInvite.guestRematches, "x");
  h.instance.detachFromMatchSession();
});

test("auth replacement tears down host and spectator metadata resources before callbacks", async () => {
  for (const viewer of [
    { role: "host", actorUid: "host" },
    { role: "watch", actorUid: null },
  ]) {
    const h = harness({ initial: response(snapshot(), viewer) });
    await h.connect();
    const channel = h.channel();
    const before = h.instance.latestInvite;
    const unsubscribe = h.instance.subscribeToAuthChanges(() =>
      assert.equal(channel.signal.aborted, true),
    );
    h.authChange({ uid: "replacement" });
    assert.equal(channel.stops, 1);
    assert.equal(h.cleanups.size, 0);
    assert.equal(h.counters.get("connectionObservers"), 0);
    channel.emit(snapshot({ revision: 2, hostRematches: "1" }));
    assert.strictEqual(h.instance.latestInvite, before);
    unsubscribe();
    h.instance.detachFromMatchSession();
  }
});
