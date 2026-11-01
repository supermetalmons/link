import {
  canonicalMatch,
  canonicalProfile,
  required,
} from "./fixtures/canonicalData.mjs";
import { createConnectionWagerClientHarness } from "./wagerClientHarness.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import {
  isHistoricalMatchPair,
  normalizeHistoricalMatchRecord,
} from "@mons/shared/game-sessions";
import { ObserverRegistry } from "../src/connection/observerRegistry.ts";
import { moveDeliveryStorageKey } from "../src/connection/moveDelivery.ts";

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
assert.ok(connectionClass && ts.isClassDeclaration(connectionClass));
const methods = [
  "observeMatch",
  "ensureMatchSyncSubscription",
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
  "detachMatchSession",
  "tryNavigateWatchOnlyToLatestApprovedMatch",
  "subscribeToAuthChanges",
].map((name) => {
  const method = required(connectionClass).members.find(
    (member) => member.name?.getText(source) === name,
  );
  assert.ok(method, name);
  return method.getText(source);
});
const { outputText } = ts.transpileModule(
  `class Connection { ${methods.join("\n")} }`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
);
/**
 * @typedef {typeof import("../src/connection/connection.ts").connection} SourceConnection
 * @typedef {import("@mons/shared/game-sessions").GameSessionMatch} Match
 * @typedef {import("@mons/shared/profiles").PlayerProfile} Profile
 * @typedef {import("@mons/shared/match-sync").MatchSyncSnapshot} Snapshot
 * @typedef {import("../src/session/sessionAuth.ts").SessionUser} SessionUser
 * @typedef {ConstructorParameters<typeof import("../src/connection/matchSyncChannel.ts").MatchSyncChannel>[0]} ChannelDependencies
 * @typedef {{dependencies: ChannelDependencies; signal: AbortSignal; stops: number; refreshes: number; stop(): void; refresh(): void; emit(value: Snapshot): void}} ChannelProbe
 * @typedef {{pending: string[]; confirmationVersion: number}} JournalProbe
 * @typedef {{observeMatch: SourceConnection["observeMatch"]; ensureMatchSyncSubscription: SourceConnection["ensureMatchSyncSubscription"]; applyMatchSyncSnapshot: SourceConnection["applyMatchSyncSnapshot"]; stopObservingAllMatches: SourceConnection["stopObservingAllMatches"]; getCachedHistoricalMatchPair: SourceConnection["getCachedHistoricalMatchPair"]; registerObserverCleanup: SourceConnection["registerObserverCleanup"]; unregisterObserverCleanup: SourceConnection["unregisterObserverCleanup"]; cleanupObserverContext: SourceConnection["cleanupObserverContext"]; clearAllObserverContexts: SourceConnection["clearAllObserverContexts"]; buildRuntimeContext: SourceConnection["buildRuntimeContext"]; activateContext: SourceConnection["activateContext"]; clearActiveContext: SourceConnection["clearActiveContext"]; detachFromMatchSession: SourceConnection["detachFromMatchSession"]; detachMatchSession: SourceConnection["detachMatchSession"]; tryNavigateWatchOnlyToLatestApprovedMatch: SourceConnection["tryNavigateWatchOnlyToLatestApprovedMatch"]; subscribeToAuthChanges: SourceConnection["subscribeToAuthChanges"]; setSameProfilePlayerUid: SourceConnection["setSameProfilePlayerUid"]; getSameProfilePlayerUid: SourceConnection["getSameProfilePlayerUid"]; isContextActive: SourceConnection["isContextActive"]; isCurrentAuthUser: SourceConnection["isCurrentAuthUser"]; getUserBoundAuthTokenProvider: SourceConnection["getUserBoundAuthTokenProvider"]; getPlayerProfileWithRetry: SourceConnection["getPlayerProfileWithRetry"]; getLatestBothSidesApprovedRematchIndex: SourceConnection["getLatestBothSidesApprovedRematchIndex"]; observeInviteMetadata: SourceConnection["observeInviteMetadata"]; observeInviteReactions: SourceConnection["observeInviteReactions"]; cleanupInviteMetadataObserver: SourceConnection["cleanupInviteMetadataObserver"]; cleanupInviteReactionObserver: SourceConnection["cleanupInviteReactionObserver"]; refreshMoveDeliveries: SourceConnection["refreshMoveDeliveries"]; refreshRematchEndDeliveries: SourceConnection["refreshRematchEndDeliveries"]; beginConnectAttempt: SourceConnection["beginConnectAttempt"]; bumpSessionEpoch: SourceConnection["bumpSessionEpoch"]; logContextEvent: SourceConnection["logContextEvent"]; flushPendingMoves: SourceConnection["flushPendingMoves"]; sessionEpoch: SourceConnection["sessionEpoch"]; nextContextId: SourceConnection["nextContextId"]; activeContext: SourceConnection["activeContext"]; currentUid: SourceConnection["currentUid"]; loginUid: SourceConnection["loginUid"]; inviteId: SourceConnection["inviteId"]; matchId: SourceConnection["matchId"]; myMatch: SourceConnection["myMatch"]; authUnsubscribers: SourceConnection["authUnsubscribers"]; observedMatchSnapshots: SourceConnection["observedMatchSnapshots"]; pendingMatchCompletions: SourceConnection["pendingMatchCompletions"]; matchPresentations: SourceConnection["matchPresentations"]; wagerClient: SourceConnection["wagerClient"]; observerRegistry: SourceConnection["observerRegistry"]; auth: Pick<import("../src/session/sessionAuth.ts").SessionAuth, "currentUser" | "getTokenRemainingMs" | "onAuthStateChanged">; latestInvite: {hostId: string; guestId: string | null} | null; moveDeliveries: Map<string, JournalProbe>; matchSyncSubscription: {contextId: number; channel: ChannelProbe; players: Set<string>; snapshot: Snapshot | null; stop(): void} | null; eventClient: {reset(options?: {preserveSnapshots?: boolean}): void}}} FixtureConnection
 */
/** @param {Match["color"]} color @param {Partial<Match>} [changes] @returns {Match} */
const match = (color, changes = {}) =>
  canonicalMatch({ version: 2, color, fen: "initial", ...changes });
/** @param {Partial<Snapshot>} [changes] @returns {Snapshot} */
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
/** @param {string} uid @returns {SessionUser} */
const user = (uid) => ({
  uid,
  sessionId: "session",
  generation: "generation",
  getIdToken: async () => "header.payload.signature",
});
const flush = () => new Promise((resolve) => setImmediate(resolve));

/** @param {{participant?: boolean; paired?: boolean; onMatch?: (connection: FixtureConnection, value: Match, playerId: string) => void; profile?: (uid: string) => Promise<Profile | null>}} [options] */
function harness({
  participant = false,
  paired = true,
  onMatch,
  profile,
} = {}) {
  /** @type {FixtureConnection} */
  let connection;
  /** @type {((user: SessionUser | null) => void) | undefined} */
  let authListener;
  /** @type {ChannelProbe[]} */
  const channels = [];
  /** @type {Array<{value: Match; playerId: string; matchId: string; cached: ReturnType<SourceConnection["getCachedHistoricalMatchPair"]>}>} */
  const deliveries = [];
  /** @type {Array<{uid: string; isCurrent: () => boolean}>} */
  const profileReads = [];
  /** @type {Array<Parameters<typeof import("../src/game/board.ts").didGetPlayerProfile>>} */
  const profiles = [];
  /** @type {Array<Parameters<typeof import("../src/services/matchSyncApi.ts").readMatchSyncViaApi>>} */
  const reads = [];
  /** @type {Map<string, number>} */
  const counters = new Map();
  const journal = { pending: ["optimistic-move"], confirmationVersion: 3 };
  const noop = () => {};
  class Channel {
    /** @param {ChannelDependencies} dependencies */
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
    /** @param {Snapshot} value */
    emit(value) {
      this.dependencies.onSnapshot(value);
    }
  }
  const dependencies = {
    moveDeliveryStorageKey,
    MatchSyncChannel: Channel,
    isHistoricalMatchPair,
    normalizeHistoricalMatchRecord,
    didReceiveMatchUpdates: (
      /** @type {Map<string, Match>} */ matches,
      /** @type {string} */ matchId,
      /** @type {() => boolean} */ isActive,
    ) => {
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
    didGetPlayerProfile: (
      /** @type {Parameters<typeof import("../src/game/board.ts").didGetPlayerProfile>} */ ...args
    ) => profiles.push(args),
    readMatchSyncViaApi: (
      /** @type {Parameters<typeof import("../src/services/matchSyncApi.ts").readMatchSyncViaApi>} */ ...args
    ) => {
      reads.push(args);
      return Promise.resolve({ ok: true, snapshot: snapshot() });
    },
    createMatchSyncSocketProtocols: (/** @type {string} */ token) => [
      "mons-match-sync-v1",
      `bearer.${token}`,
    ],
    incrementLifecycleCounter: (/** @type {string} */ name) =>
      counters.set(name, (counters.get(name) ?? 0) + 1),
    decrementLifecycleCounter: (/** @type {string} */ name) =>
      counters.set(name, (counters.get(name) ?? 0) - 1),
  };
  const Constructor = /** @type {new () => FixtureConnection} */ (
    new Function(
      ...Object.keys(dependencies),
      `${outputText}\nreturn Connection;`,
    )(...Object.values(dependencies))
  );
  /** @type {import("../src/connection/matchRuntimeContext.ts").MatchRuntimeContext} */
  const context = {
    contextId: 1,
    sessionEpoch: 1,
    inviteId: "invite",
    matchId: "invite",
    loginUid: "login",
    actorUid: participant ? "host" : null,
    role: participant ? "host" : "watch",
    canWrite: participant,
    createdAtMs: 0,
  };
  connection = Object.assign(
    new Constructor(),
    /** @satisfies {Partial<FixtureConnection>} */ ({
      auth: {
        currentUser: user("login"),
        getTokenRemainingMs: () => 300_000,
        onAuthStateChanged: (callback) => {
          authListener = callback;
          return noop;
        },
      },
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
      pendingMatchCompletions: new Map(),
      matchSyncSubscription: null,
      moveDeliveries: new Map([["journal", journal]]),
      matchPresentations: new Map(),
      setSameProfilePlayerUid: noop,
      getSameProfilePlayerUid() {
        return connection.activeContext?.canWrite
          ? connection.activeContext.actorUid
          : null;
      },
      /**
       * @param {number} contextId
       * @param {number} epoch
       */
      isContextActive(contextId, epoch) {
        return (
          connection.activeContext?.contextId === contextId &&
          connection.activeContext?.sessionEpoch === epoch &&
          connection.sessionEpoch === epoch
        );
      },
      /**
       * @param {string} uid
       */
      isCurrentAuthUser(uid) {
        return connection.auth.currentUser?.uid === uid;
      },
      getUserBoundAuthTokenProvider(uid) {
        assert.equal(uid, "login");
        return Object.assign(async () => "header.payload.signature", {
          assertCurrentUser: () =>
            assert.equal(connection.auth.currentUser?.uid, uid),
        });
      },
      getPlayerProfileWithRetry(uid, isCurrent) {
        profileReads.push({ uid, isCurrent });
        return profile
          ? profile(uid)
          : Promise.resolve(canonicalProfile({ id: uid }));
      },
      getLatestBothSidesApprovedRematchIndex: () => 1,
      observeInviteMetadata: noop,
      observeInviteReactions: noop,
      cleanupInviteMetadataObserver: noop,
      cleanupInviteReactionObserver: noop,
      eventClient: { reset: noop },
      refreshMoveDeliveries: noop,
      refreshRematchEndDeliveries: noop,
      beginConnectAttempt: () => 0,
      flushPendingMoves: async () => assert.fail("unexpected move flush"),
      bumpSessionEpoch() {
        return ++connection.sessionEpoch;
      },
      logContextEvent: noop,
    }),
  );
  connection.observerRegistry = new ObserverRegistry(noop);
  const wagerHarness = createConnectionWagerClientHarness(connection, {
    createWagerChannel: () => ({ stop: noop, requestRefresh: noop }),
  });
  connection.wagerClient = wagerHarness.client;
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
    /**
     * @param {string} uid
     */
    emitAuth(uid) {
      connection.auth.currentUser = uid ? user(uid) : null;
      required(authListener)(connection.auth.currentUser);
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
    [...required(h.channels[0]).dependencies.requiredPlayerIds()],
    ["host", "guest"],
  );
  required(h.channels[0]).emit(snapshot());
  assert.deepEqual(
    h.deliveries.map((value) => value.playerId),
    ["host", "guest"],
  );
  assert.deepEqual(
    required(required(h.deliveries[0]).cached).hostMatch,
    match("white"),
  );
  assert.deepEqual(
    required(required(h.deliveries[0]).cached).guestMatch,
    match("black"),
  );
  await flush();
  assert.deepEqual(
    h.profileReads.map((value) => value.uid),
    ["host", "guest"],
  );
  assert.equal(h.profiles.length, 2);
  const channel = h.channels[0];
  await required(channel).dependencies.readMatches(required(channel).signal);
  assert.equal(required(h.reads[0])[0], "invite");
  assert.equal(required(h.reads[0])[1], "invite");
  assert.equal(
    required(required(h.reads[0])[3]).signal,
    required(channel).signal,
  );
  assert.deepEqual(
    await required(required(channel).dependencies.getProtocols)(false),
    ["mons-match-sync-v1", "bearer.header.payload.signature"],
  );
});

test("bootstrap hydrates both spectator actors immediately using one seeded subscription", () => {
  const h = harness();
  const seed = snapshot();
  h.connection.observeMatch("host", "invite", h.context, seed, ["guest"]);
  assert.equal(h.channels.length, 1);
  assert.equal(required(h.channels[0]).refreshes, 0);
  assert.equal(required(h.channels[0]).dependencies.initialSnapshot, seed);
  assert.deepEqual(
    [...required(h.channels[0]).dependencies.requiredPlayerIds()],
    ["host", "guest"],
  );
  assert.equal(h.deliveries.length, 2);
  assert.deepEqual(
    required(required(h.deliveries[0]).cached).hostMatch,
    seed.hostMatch,
  );
  assert.deepEqual(
    required(required(h.deliveries[0]).cached).guestMatch,
    seed.guestMatch,
  );
});

test("bootstrap hydrates an opponent with reconciled own moves before any network callback", () => {
  const h = harness({ participant: true });
  const own = h.connection.myMatch;
  h.connection.observeMatch("guest", "invite", h.context, snapshot());
  assert.equal(h.deliveries.length, 1);
  assert.equal(required(h.deliveries[0]).playerId, "guest");
  assert.deepEqual(required(required(h.deliveries[0]).cached).hostMatch, own);
  assert.equal(h.connection.observedMatchSnapshots.has("invite_host"), false);
  assert.equal(required(h.channels[0]).refreshes, 0);
});

test("a superseded bootstrap stops actor delivery and profile work even before the context rotates", () => {
  let bootstrapActive = true;
  const h = harness({
    onMatch: () => {
      bootstrapActive = false;
    },
  });
  h.connection.observeMatch(
    "host",
    "invite",
    h.context,
    snapshot(),
    ["guest"],
    () => bootstrapActive,
  );
  assert.equal(h.connection.activeContext, h.context);
  assert.equal(h.deliveries.length, 1);
  assert.equal(required(h.deliveries[0]).playerId, "host");
  assert.deepEqual(h.profileReads, []);
  h.connection.detachFromMatchSession();
});

test("participant pair delivery only observes the opponent and preserves optimistic actor state and journal", () => {
  const h = harness({ participant: true });
  const optimistic = h.connection.myMatch;
  h.connection.observeMatch("host", "invite");
  assert.equal(h.channels.length, 0);
  h.connection.observeMatch("guest", "invite");
  required(h.channels[0]).emit(
    snapshot({ hostMatch: match("white", { fen: "behind" }) }),
  );
  assert.deepEqual(
    h.deliveries.map((value) => value.playerId),
    ["guest"],
  );
  assert.equal(h.connection.observedMatchSnapshots.has("invite_host"), false);
  assert.equal(h.connection.myMatch, optimistic);
  assert.deepEqual(
    required(required(h.deliveries[0]).cached).hostMatch,
    optimistic,
  );
  assert.equal(h.connection.moveDeliveries.get("journal"), h.journal);
  assert.deepEqual(h.journal.pending, ["optimistic-move"]);
});

test("null actors remain absent and later records hydrate without inventing moves or resetting a journal", () => {
  const h = harness();
  h.connection.observeMatch("host", "invite");
  h.connection.observeMatch("guest", "invite");
  required(h.channels[0]).emit(snapshot({ hostMatch: null, guestMatch: null }));
  assert.equal(h.deliveries.length, 0);
  assert.equal(h.connection.getCachedHistoricalMatchPair("invite"), null);
  required(h.channels[0]).emit(snapshot({ revision: 2, guestMatch: null }));
  assert.equal(h.deliveries.length, 1);
  assert.equal(required(required(h.deliveries[0]).cached).guestMatch, null);
  required(h.channels[0]).emit(snapshot({ revision: 3 }));
  assert.equal(
    required(required(required(h.deliveries.at(-1)).cached).guestMatch).color,
    "black",
  );
  required(h.channels[0]).emit(
    snapshot({ revision: 4, hostMatch: null, guestMatch: null }),
  );
  assert.equal(h.connection.observedMatchSnapshots.size, 0);
  assert.equal(h.deliveries.length, 3);
  assert.deepEqual(h.journal.pending, ["optimistic-move"]);
});

test("a late guest joins the existing spectator channel and requests current HTTP hydration", () => {
  const h = harness({ paired: false });
  h.connection.observeMatch("host", "invite");
  required(h.channels[0]).emit(
    snapshot({ guestPlayerId: null, guestMatch: null }),
  );
  required(h.connection.latestInvite).guestId = "guest";
  h.connection.observeMatch("guest", "invite");
  assert.equal(h.channels.length, 1);
  assert.equal(required(h.channels[0]).refreshes, 1);
  required(h.channels[0]).emit(snapshot({ revision: 2 }));
  assert.deepEqual(
    required(required(h.deliveries.at(-1)).cached).guestMatch,
    match("black"),
  );
});

test("a waiting host buffers the paired snapshot until the guest metadata agrees", async () => {
  const h = harness({ participant: true, paired: false });
  h.connection.ensureMatchSyncSubscription(
    h.context,
    [],
    snapshot({ guestPlayerId: null, guestMatch: null }),
  );
  assert.equal(h.channels.length, 1);
  required(h.channels[0]).emit(snapshot({ revision: 2 }));
  assert.equal(h.deliveries.length, 0);
  assert.equal(h.connection.observedMatchSnapshots.size, 0);
  required(h.connection.latestInvite).guestId = "guest";
  h.connection.observeMatch("guest", "invite");
  assert.equal(h.channels.length, 1);
  assert.equal(required(h.channels[0]).refreshes, 0);
  assert.equal(h.deliveries.length, 1);
  assert.equal(required(h.deliveries[0]).playerId, "guest");
  assert.deepEqual(
    required(required(h.deliveries[0]).cached).guestMatch,
    match("black"),
  );
  await flush();
  assert.deepEqual(
    h.profileReads.map(({ uid }) => uid),
    ["guest"],
  );
});

test("a waiting host retains its socket and recovery read when metadata arrives first", () => {
  const h = harness({ participant: true, paired: false });
  h.connection.ensureMatchSyncSubscription(
    h.context,
    [],
    snapshot({ guestPlayerId: null, guestMatch: null }),
  );
  required(h.connection.latestInvite).guestId = "guest";
  h.connection.observeMatch("guest", "invite");
  assert.equal(h.channels.length, 1);
  assert.equal(required(h.channels[0]).refreshes, 1);
  assert.equal(h.deliveries.length, 0);
  required(h.channels[0]).emit(snapshot({ revision: 2 }));
  assert.equal(h.deliveries.length, 1);
  assert.deepEqual(
    required(required(h.deliveries[0]).cached).guestMatch,
    match("black"),
  );
});

test("spectator rematch navigation replaces the channel and ignores all old match callbacks", () => {
  const h = harness();
  h.connection.observeMatch("host", "invite");
  h.connection.observeMatch("guest", "invite");
  const previous = h.channels[0];
  required(previous).emit(snapshot());
  assert.equal(h.connection.tryNavigateWatchOnlyToLatestApprovedMatch(), true);
  assert.equal(required(previous).stops, 1);
  assert.equal(required(previous).signal.aborted, true);
  assert.equal(h.channels.length, 2);
  assert.equal(required(h.channels[1]).dependencies.matchId, "invite1");
  assert.deepEqual(
    [...required(h.channels[1]).dependencies.requiredPlayerIds()],
    ["host", "guest"],
  );
  assert.equal(h.observerCount(), 1);
  assert.equal(h.connection.observedMatchSnapshots.size, 0);
  required(previous).emit(snapshot({ revision: 100 }));
  assert.equal(h.deliveries.length, 2);
  required(h.channels[1]).emit(snapshot({ matchId: "invite1" }));
  assert.equal(h.deliveries.length, 4);
  assert.equal(required(h.deliveries.at(-1)).matchId, "invite1");
  h.connection.detachFromMatchSession();
  assert.equal(required(h.channels[1]).stops, 1);
  assert.equal(h.observerCount(), 0);
  assert.equal(h.connection.observedMatchSnapshots.size, 0);
});

test("navigation during the first actor callback cannot deliver the second actor into the new view", () => {
  const h = harness({
    onMatch: (connection) => connection.detachFromMatchSession(),
  });
  h.connection.observeMatch("host", "invite");
  h.connection.observeMatch("guest", "invite");
  required(h.channels[0]).emit(snapshot());
  assert.equal(h.deliveries.length, 1);
  assert.equal(h.connection.observedMatchSnapshots.size, 0);
  assert.equal(required(h.channels[0]).stops, 1);
  assert.equal(h.observerCount(), 0);
});

test("authentication replacement stops the channel and prevents late profile or match callbacks", async () => {
  /** @type {PromiseWithResolvers<Profile | null>} */
  const pendingProfile = Promise.withResolvers();
  const { promise: profile, resolve: resolveProfile } = pendingProfile;
  const h = harness({ profile: () => profile });
  const unsubscribe = h.connection.subscribeToAuthChanges(() => {});
  h.connection.observeMatch("host", "invite");
  h.connection.observeMatch("guest", "invite");
  h.emitAuth("other-login");
  assert.equal(required(h.channels[0]).stops, 1);
  assert.equal(h.observerCount(), 0);
  required(h.channels[0]).emit(snapshot());
  required(resolveProfile)(canonicalProfile({ id: "old" }));
  await flush();
  assert.equal(h.profiles.length, 0);
  assert.equal(h.deliveries.length, 0);
  assert.equal(h.connection.moveDeliveries.get("journal"), h.journal);
  unsubscribe();
});

test("mismatched invite, match or session epochs cannot update the active match cache", () => {
  const h = harness();
  h.connection.observeMatch("host", "invite");
  required(h.channels[0]).emit(snapshot({ inviteId: "other" }));
  required(h.channels[0]).emit(snapshot({ matchId: "invite1" }));
  required(h.channels[0]).emit(snapshot({ hostPlayerId: "other" }));
  required(h.channels[0]).emit(snapshot({ guestPlayerId: "other" }));
  h.connection.sessionEpoch++;
  required(h.channels[0]).emit(snapshot());
  assert.equal(h.connection.observedMatchSnapshots.size, 0);
  assert.equal(h.deliveries.length, 0);
  h.connection.stopObservingAllMatches();
  h.connection.stopObservingAllMatches();
  assert.equal(required(h.channels[0]).stops, 1);
  assert.equal(h.observerCount(), 0);
});
