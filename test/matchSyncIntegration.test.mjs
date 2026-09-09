import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import {
  isHistoricalMatchPair,
  normalizeHistoricalMatchRecord,
} from "@mons/shared/game-sessions";
import { ObserverRegistry } from "../src/connection/observerRegistry.ts";

const source = ts.createSourceFile(
  "connection.ts",
  readFileSync(
    new URL("../src/connection/connection.ts", import.meta.url),
    "utf8",
  ),
  ts.ScriptTarget.Latest,
  true,
);
const connectionClass = source.statements.find(
  (node) => ts.isClassDeclaration(node) && node.name?.text === "Connection",
);
const methods = [
  "observeMatch",
  "applyMatchSyncSnapshot",
  "stopObservingAllMatches",
  "getCachedHistoricalMatchPair",
  "registerObserverCleanup",
  "unregisterObserverCleanup",
  "cleanupObserverContext",
  "clearAllObserverContexts",
  "buildRuntimeContext",
  "activateContext",
  "clearActiveContext",
  "detachFromMatchSession",
  "tryNavigateWatchOnlyToLatestApprovedMatch",
  "subscribeToAuthChanges",
].map((name) => {
  const method = connectionClass.members.find(
    (member) => member.name?.getText(source) === name,
  );
  assert.ok(method, name);
  return method.getText(source);
});
const { outputText } = ts.transpileModule(
  `class Connection { ${methods.join("\n")} }`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
);
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
const snapshot = (changes = {}) => ({
  inviteId: "invite",
  matchId: "invite",
  revision: 1,
  hostPlayerId: "host",
  guestPlayerId: "guest",
  hostMatch: match("white"),
  guestMatch: match("black"),
  ...changes,
});
const flush = () => new Promise((resolve) => setImmediate(resolve));

function harness({
  participant = false,
  paired = true,
  onMatch,
  profile,
} = {}) {
  let connection;
  let authListener;
  const channels = [];
  const deliveries = [];
  const profileReads = [];
  const profiles = [];
  const reads = [];
  const counters = new Map();
  const journal = { pending: ["optimistic-move"], confirmationVersion: 3 };
  const noop = () => {};
  class Channel {
    constructor(dependencies) {
      this.dependencies = dependencies;
      this.controller = new AbortController();
      this.stops = 0;
      this.refreshes = 0;
      channels.push(this);
    }
    get signal() {
      return this.controller.signal;
    }
    stop() {
      this.stops++;
      this.controller.abort();
    }
    refresh() {
      this.refreshes++;
    }
    emit(value) {
      this.dependencies.onSnapshot(value);
    }
  }
  const dependencies = {
    MatchSyncChannel: Channel,
    isHistoricalMatchPair,
    normalizeHistoricalMatchRecord,
    didReceiveMatchUpdates: (matches, matchId, isActive) => {
      for (const [playerId, value] of matches) {
        if (!isActive()) return;
        deliveries.push({
          value,
          playerId,
          matchId,
          cached: connection.getCachedHistoricalMatchPair(matchId),
        });
        onMatch?.(connection, value, playerId);
      }
    },
    didGetPlayerProfile: (...args) => profiles.push(args),
    readMatchSyncViaApi: (...args) => {
      reads.push(args);
      return Promise.resolve({ ok: true, snapshot: snapshot() });
    },
    createMatchSyncSocketProtocols: (token) => [
      "mons-match-sync-v1",
      `bearer.${token}`,
    ],
    incrementLifecycleCounter: (name) =>
      counters.set(name, (counters.get(name) ?? 0) + 1),
    decrementLifecycleCounter: (name) =>
      counters.set(name, (counters.get(name) ?? 0) - 1),
    onAuthStateChanged: (_auth, callback) => {
      authListener = callback;
      return noop;
    },
    setCurrentWagerMatch: noop,
  };
  const Constructor = new Function(
    ...Object.keys(dependencies),
    `${outputText}\nreturn Connection;`,
  )(...Object.values(dependencies));
  const context = {
    contextId: 1,
    sessionEpoch: 1,
    inviteId: "invite",
    matchId: "invite",
    loginUid: "login",
    actorUid: participant ? "host" : null,
    role: participant ? "host" : "watch",
    canWrite: participant,
  };
  connection = Object.assign(new Constructor(), {
    auth: { currentUser: { uid: "login" } },
    authUnsubscribers: new Set(),
    currentUid: "login",
    loginUid: "login",
    sessionEpoch: 1,
    nextContextId: 2,
    activeContext: context,
    inviteId: "invite",
    matchId: "invite",
    latestInvite: { hostId: "host", guestId: paired ? "guest" : null },
    myMatch: participant
      ? match("white", {
          fen: "optimistic",
          flatMovesString: "optimistic-move",
        })
      : null,
    observedMatchSnapshots: new Map(),
    matchSyncSubscription: null,
    moveDeliveries: new Map([["journal", journal]]),
    matchPresentations: new Map(),
    optimisticResolvedMatchIds: new Set(),
    pendingWagerMutations: new Set(),
    wagerSnapshotGeneration: 0,
    setSameProfilePlayerUid: noop,
    getSameProfilePlayerUid() {
      return this.activeContext?.canWrite ? this.activeContext.actorUid : null;
    },
    isContextActive(contextId, epoch) {
      return (
        this.activeContext?.contextId === contextId &&
        this.activeContext?.sessionEpoch === epoch &&
        this.sessionEpoch === epoch
      );
    },
    isCurrentAuthUser(uid) {
      return this.auth.currentUser?.uid === uid;
    },
    getUserBoundAuthTokenProvider(uid) {
      assert.equal(uid, "login");
      return Object.assign(async () => "header.payload.signature", {
        assertCurrentUser: () => assert.equal(this.auth.currentUser?.uid, uid),
      });
    },
    getPlayerProfileWithRetry(uid, isCurrent) {
      profileReads.push({ uid, isCurrent });
      return profile ? profile(uid) : Promise.resolve({ profileId: uid });
    },
    getLatestBothSidesApprovedRematchIndex: () => 1,
    observeInviteMetadata: noop,
    observeWagers: noop,
    observeInviteReactions: noop,
    updateWagerStateForCurrentMatch: noop,
    cleanupInviteMetadataObserver: noop,
    cleanupWagerObserver: noop,
    cleanupInviteReactionObserver: noop,
    clearEventSyncCaches: noop,
    refreshMoveDeliveries: noop,
    beginConnectAttempt: noop,
    bumpSessionEpoch() {
      this.sessionEpoch++;
    },
    logContextEvent: noop,
  });
  connection.observerRegistry = new ObserverRegistry(noop);
  return {
    connection,
    context,
    channels,
    deliveries,
    profileReads,
    profiles,
    reads,
    journal,
    observerCount: () => counters.get("connectionObservers") ?? 0,
    emitAuth(uid) {
      connection.auth.currentUser = uid ? { uid } : null;
      authListener(connection.auth.currentUser);
    },
  };
}

test("spectators share one channel and cache both actor records before the first hydration callback", async () => {
  const h = harness();
  h.connection.observeMatch("host", "invite");
  h.connection.observeMatch("guest", "invite");
  h.connection.observeMatch("guest", "invite");
  assert.equal(h.channels.length, 1);
  assert.equal(h.observerCount(), 1);
  assert.deepEqual(
    [...h.channels[0].dependencies.requiredPlayerIds()],
    ["host", "guest"],
  );
  h.channels[0].emit(snapshot());
  assert.deepEqual(
    h.deliveries.map((value) => value.playerId),
    ["host", "guest"],
  );
  assert.deepEqual(h.deliveries[0].cached.hostMatch, match("white"));
  assert.deepEqual(h.deliveries[0].cached.guestMatch, match("black"));
  await flush();
  assert.deepEqual(
    h.profileReads.map((value) => value.uid),
    ["host", "guest"],
  );
  assert.equal(h.profiles.length, 2);
  const channel = h.channels[0];
  await channel.dependencies.readMatches(channel.signal);
  assert.equal(h.reads[0][0], "invite");
  assert.equal(h.reads[0][1], "invite");
  assert.equal(h.reads[0][3].signal, channel.signal);
  assert.deepEqual(await channel.dependencies.getProtocols(false), [
    "mons-match-sync-v1",
    "bearer.header.payload.signature",
  ]);
});

test("participant pair delivery only observes the opponent and preserves optimistic actor state and journal", () => {
  const h = harness({ participant: true });
  const optimistic = h.connection.myMatch;
  h.connection.observeMatch("host", "invite");
  assert.equal(h.channels.length, 0);
  h.connection.observeMatch("guest", "invite");
  h.channels[0].emit(
    snapshot({ hostMatch: match("white", { fen: "behind" }) }),
  );
  assert.deepEqual(
    h.deliveries.map((value) => value.playerId),
    ["guest"],
  );
  assert.equal(h.connection.observedMatchSnapshots.has("invite_host"), false);
  assert.equal(h.connection.myMatch, optimistic);
  assert.deepEqual(h.deliveries[0].cached.hostMatch, optimistic);
  assert.equal(h.connection.moveDeliveries.get("journal"), h.journal);
  assert.deepEqual(h.journal.pending, ["optimistic-move"]);
});

test("null actors remain absent and later records hydrate without inventing moves or resetting a journal", () => {
  const h = harness();
  h.connection.observeMatch("host", "invite");
  h.connection.observeMatch("guest", "invite");
  h.channels[0].emit(snapshot({ hostMatch: null, guestMatch: null }));
  assert.equal(h.deliveries.length, 0);
  assert.equal(h.connection.getCachedHistoricalMatchPair("invite"), null);
  h.channels[0].emit(snapshot({ revision: 2, guestMatch: null }));
  assert.equal(h.deliveries.length, 1);
  assert.equal(h.deliveries[0].cached.guestMatch, null);
  h.channels[0].emit(snapshot({ revision: 3 }));
  assert.equal(h.deliveries.at(-1).cached.guestMatch.color, "black");
  h.channels[0].emit(
    snapshot({ revision: 4, hostMatch: null, guestMatch: null }),
  );
  assert.equal(h.connection.observedMatchSnapshots.size, 0);
  assert.equal(h.deliveries.length, 3);
  assert.deepEqual(h.journal.pending, ["optimistic-move"]);
});

test("a late guest joins the existing spectator channel and requests current HTTP hydration", () => {
  const h = harness({ paired: false });
  h.connection.observeMatch("host", "invite");
  h.channels[0].emit(snapshot({ guestPlayerId: null, guestMatch: null }));
  h.connection.latestInvite.guestId = "guest";
  h.connection.observeMatch("guest", "invite");
  assert.equal(h.channels.length, 1);
  assert.equal(h.channels[0].refreshes, 1);
  h.channels[0].emit(snapshot({ revision: 2 }));
  assert.deepEqual(h.deliveries.at(-1).cached.guestMatch, match("black"));
});

test("spectator rematch navigation replaces the channel and ignores all old match callbacks", () => {
  const h = harness();
  h.connection.observeMatch("host", "invite");
  h.connection.observeMatch("guest", "invite");
  const previous = h.channels[0];
  previous.emit(snapshot());
  assert.equal(h.connection.tryNavigateWatchOnlyToLatestApprovedMatch(), true);
  assert.equal(previous.stops, 1);
  assert.equal(previous.signal.aborted, true);
  assert.equal(h.channels.length, 2);
  assert.equal(h.channels[1].dependencies.matchId, "invite1");
  assert.deepEqual(
    [...h.channels[1].dependencies.requiredPlayerIds()],
    ["host", "guest"],
  );
  assert.equal(h.observerCount(), 1);
  assert.equal(h.connection.observedMatchSnapshots.size, 0);
  previous.emit(snapshot({ revision: 100 }));
  assert.equal(h.deliveries.length, 2);
  h.channels[1].emit(snapshot({ matchId: "invite1" }));
  assert.equal(h.deliveries.length, 4);
  assert.equal(h.deliveries.at(-1).matchId, "invite1");
  h.connection.detachFromMatchSession();
  assert.equal(h.channels[1].stops, 1);
  assert.equal(h.observerCount(), 0);
  assert.equal(h.connection.observedMatchSnapshots.size, 0);
});

test("navigation during the first actor callback cannot deliver the second actor into the new view", () => {
  const h = harness({
    onMatch: (connection) => connection.detachFromMatchSession(),
  });
  h.connection.observeMatch("host", "invite");
  h.connection.observeMatch("guest", "invite");
  h.channels[0].emit(snapshot());
  assert.equal(h.deliveries.length, 1);
  assert.equal(h.connection.observedMatchSnapshots.size, 0);
  assert.equal(h.channels[0].stops, 1);
  assert.equal(h.observerCount(), 0);
});

test("authentication replacement stops the channel and prevents late profile or match callbacks", async () => {
  let resolveProfile;
  const profile = new Promise((resolve) => {
    resolveProfile = resolve;
  });
  const h = harness({ profile: () => profile });
  const unsubscribe = h.connection.subscribeToAuthChanges(() => {});
  h.connection.observeMatch("host", "invite");
  h.connection.observeMatch("guest", "invite");
  h.emitAuth("other-login");
  assert.equal(h.channels[0].stops, 1);
  assert.equal(h.observerCount(), 0);
  h.channels[0].emit(snapshot());
  resolveProfile({ profileId: "old" });
  await flush();
  assert.equal(h.profiles.length, 0);
  assert.equal(h.deliveries.length, 0);
  assert.equal(h.connection.moveDeliveries.get("journal"), h.journal);
  unsubscribe();
});

test("mismatched invite, match or session epochs cannot update the active match cache", () => {
  const h = harness();
  h.connection.observeMatch("host", "invite");
  h.channels[0].emit(snapshot({ inviteId: "other" }));
  h.channels[0].emit(snapshot({ matchId: "invite1" }));
  h.connection.sessionEpoch++;
  h.channels[0].emit(snapshot());
  assert.equal(h.connection.observedMatchSnapshots.size, 0);
  assert.equal(h.deliveries.length, 0);
  h.connection.stopObservingAllMatches();
  h.connection.stopObservingAllMatches();
  assert.equal(h.channels[0].stops, 1);
  assert.equal(h.observerCount(), 0);
});
