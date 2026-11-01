import { Game } from "mons-rules";
import {
  canonicalMatch,
  canonicalProfile,
  required,
} from "./fixtures/canonicalData.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerTypeScriptTestHooks } from "./support/typescriptHooks.mjs";
import test from "node:test";
import ts from "typescript";
import { createMatchTimerHarness } from "./fixtures/matchTimerHarness.mjs";
import { createRematchViewingHarness } from "./fixtures/rematchViewingHarness.mjs";
import { MatchPresentationState } from "../src/connection/matchPresentationState.ts";
import { moveDeliveryStorageKey } from "../src/connection/moveDelivery.ts";
import { isCompletedMatchPair } from "../src/connection/matchCompletion.ts";
import { canonicalScoreMatchPair } from "./fixtures/completedMatchPair.mjs";

registerTypeScriptTestHooks();

const { batchGameControlsUpdates } =
  await import("../src/game/gameControlsStore.ts");

/** @typedef {typeof import("../src/connection/connection.ts").connection} ConnectionContract */
/** @typedef {typeof import("../src/game/board.ts")} BoardContract */
/** @typedef {typeof import("../src/game/gameController.ts")} GameControllerContract */
/** @typedef {import("@mons/shared/match-presentation").MatchPresentation} Presentation */
/** @typedef {ConstructorParameters<typeof import("../src/connection/inviteReactionChannel.ts").InviteReactionChannel>[0]} RoomDependencies */
/** @typedef {RoomDependencies & Required<Pick<RoomDependencies, "onPresentationSnapshot">>} PresentationRoom */
/** @typedef {{-readonly [K in keyof import("../src/connection/matchRuntimeContext.ts").MatchRuntimeContext]: import("../src/connection/matchRuntimeContext.ts").MatchRuntimeContext[K]} & {actorUid: string}} FixtureContext */
/** @typedef {Omit<Partial<import("@mons/shared/game-sessions").GameSessionMatch>, "status" | "timer"> & {fen: string; status: string; timer?: string | import("@mons/shared/timers").MatchTimer}} LocalMatchProbe */
/**
 * @typedef {object} ConnectionMethods
 * @property {ConnectionContract["observeInviteReactions"]} observeInviteReactions
 * @property {ConnectionContract["cleanupInviteReactionObserver"]} cleanupInviteReactionObserver
 * @property {ConnectionContract["rememberMatchPresentation"]} rememberMatchPresentation
 * @property {ConnectionContract["getMatchPresentation"]} getMatchPresentation
 * @property {ConnectionContract["updateEmoji"]} updateEmoji
 * @property {ConnectionContract["surrender"]} surrender
 * @property {ConnectionContract["updateRatings"]} updateRatings
 * @property {ConnectionContract["applyMatchSyncSnapshot"]} applyMatchSyncSnapshot
 * @property {ConnectionContract["getOpponentId"]} getOpponentId
 * @property {ConnectionContract["getCurrentInviteEventId"]} getCurrentInviteEventId
 * @property {ConnectionContract["ensureAuthenticated"]} ensureAuthenticated
 * @property {ConnectionContract["notifyNavigationGamesChanged"]} notifyNavigationGamesChanged
 * @property {ConnectionContract["moveDeliveryScope"]} moveDeliveryScope
 * @property {ConnectionContract["isCurrentMoveBoard"]} isCurrentMoveBoard
 * @property {ConnectionContract["recoverMoveBoard"]} recoverMoveBoard
 * @property {ConnectionContract["isCurrentAuthUser"]} isCurrentAuthUser
 * @property {ConnectionContract["requireWritableContext"]} requireWritableContext
 * @property {ConnectionContract["createMatchContextGuard"]} createMatchContextGuard
 * @property {ConnectionContract["createSessionGuard"]} createSessionGuard
 * @property {ConnectionContract["isSessionEpochActive"]} isSessionEpochActive
 * @property {ConnectionContract["reconnectAfterMatchUpdateFailure"]} reconnectAfterMatchUpdateFailure
 * @property {ConnectionContract["isContextActive"]} isContextActive
 * @property {ConnectionContract["registerObserverCleanup"]} registerObserverCleanup
 * @property {ConnectionContract["unregisterObserverCleanup"]} unregisterObserverCleanup
 * @property {ConnectionContract["getUserBoundAuthTokenProvider"]} getUserBoundAuthTokenProvider
 * @property {ConnectionContract["flushPendingMoves"]} flushPendingMoves
 * @property {ConnectionContract["logContextEvent"]} logContextEvent
 * @property {ConnectionContract["updateStoredEmoji"]} updateStoredEmoji
 * @property {ConnectionContract["signIn"]} signIn
 * @property {ConnectionContract["connectToGame"]} connectToGame
 */
/** @typedef {ConnectionMethods & {
 * db?: Record<string, never>; auth: {currentUser: {uid: string} | null};
 * myMatch: LocalMatchProbe | null; activeContext: FixtureContext | null;
 * latestInvite?: Pick<import("@mons/shared/invite-metadata").InviteMetadataSnapshot, "hostId" | "guestId"> | null;
 * matchPresentations: Map<string, Presentation>; confirmedSurrenders: Set<string>; pendingSurrenders: Map<string, Promise<void>>; pendingMatchCompletions: ConnectionContract["pendingMatchCompletions"]; reconcilingMoveKeys: Set<string>;
 * eventClient: Pick<ConnectionContract["eventClient"], "syncEventStateAfterMatch">;
 * moveRecoveryTimers: ConnectionContract["moveRecoveryTimers"]; observedMatchSnapshots?: Map<string, LocalMatchProbe>;
 * sessionEpoch: number; moveReconnectCooldownMs: number; moveReconnectLastAttemptAt: number; moveReconnectInFlight: boolean;
 * inviteReactionSubscription: {contextId: number; channel: {signal: AbortSignal; stop(): void}; presentation: MatchPresentationState; stop(): void} | null;
 * }} FixtureConnection */
/** @param {FixtureContext | null | undefined} value @returns {value is FixtureContext & {canWrite: true}} */
const writableContext = (value) =>
  value != null && value.canWrite === true && !!value.actorUid;
/** @param {RoomDependencies} value @returns {value is PresentationRoom} */
const hasPresentationCallback = (value) =>
  typeof value.onPresentationSnapshot === "function";
/** @returns {import("@mons/shared/game-sessions").SurrenderMatchResponse} */
const surrenderReceipt = () => ({
  ok: true,
  inviteId: "invite",
  matchId: "invite",
  actorUid: "actor",
});

const sourceFile = (/** @type {string} */ path) =>
  ts.createSourceFile(
    path,
    readFileSync(new URL(path, import.meta.url), "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
const connectionSource = sourceFile("../src/connection/connection.ts");
const connectionClass = connectionSource.statements
  .filter(ts.isClassDeclaration)
  .find((node) => node.name?.text === "Connection");
/** @param {readonly string[]} names */
const methods = (names) =>
  names
    .map((name) => {
      const node = required(connectionClass).members.find(
        (member) => member.name?.getText(connectionSource) === name,
      );
      assert.ok(node, name);
      return node.getText(connectionSource);
    })
    .join("\n");
/** @param {ts.SourceFile} source @param {readonly string[]} names */
const functions = (source, names) =>
  names
    .map((name) => {
      const node = source.statements.find(
        (/** @type {ts.Node} */ statement) =>
          ts.isFunctionDeclaration(statement) && statement.name?.text === name,
      );
      assert.ok(node, name);
      return node.getText(source).replace(/^export /, "");
    })
    .join("\n");
/** @param {string} source @param {Record<string, unknown>} dependencies @param {string} result @returns {unknown} */
const compile = (source, dependencies, result) => {
  const { outputText } = ts.transpileModule(
    source.replaceAll("import.meta.env.DEV", "false"),
    {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    },
  );
  return new Function(
    ...Object.keys(dependencies),
    `${outputText}\nreturn ${result};`,
  )(...Object.values(dependencies));
};
const flush = () => new Promise((resolve) => setImmediate(resolve));
/**
 * @template [T=void]
 * @returns {PromiseWithResolvers<T>}
 */
const deferred = () => {
  return Promise.withResolvers();
};
/** @returns {Presentation} */
const appearance = (revision = 1, emojiId = 1, actorUid = "actor") => ({
  matchId: "invite",
  actorUid,
  emojiId,
  aura: "none",
  revision,
});
/** @param {...Presentation} values @returns {import("@mons/shared/match-presentation").MatchPresentationSnapshot} */
const snapshot = (...values) => {
  /** @type {Record<string, Presentation>} */
  const players = {};
  for (const value of values) players[value.actorUid] = value;
  return { matchId: "invite", players };
};

function connectionHarness({ paired = true } = {}) {
  /** @type {PromiseWithResolvers<Awaited<ReturnType<typeof import("../src/services/matchPresentationApi.ts").readMatchPresentationViaApi>>>} */
  const pendingRead = deferred();
  /** @type {PromiseWithResolvers<Awaited<ReturnType<typeof import("../src/services/matchPresentationApi.ts").updateMatchPresentationViaApi>>>} */
  const pendingSave = deferred();
  /** @type {Array<Parameters<GameControllerContract["didReceiveMatchPresentationUpdate"]>>} */
  const changes = [];
  /** @type {Array<Parameters<typeof import("../src/services/matchPresentationApi.ts").updateMatchPresentationViaApi>>} */
  const saves = [];
  /** @type {Array<import("@mons/shared/game-sessions").SurrenderMatchRequest>} */
  const writes = [];
  /** @type {Array<Parameters<ConnectionContract["updateStoredEmoji"]>>} */
  const profileUpdates = [];
  /** @type {Array<Parameters<typeof import("../src/services/matchPresentationApi.ts").readMatchPresentationViaApi>>} */
  const reads = [];
  /** @type {Map<string, () => void>} */
  const cleanups = new Map();
  /** @type {LocalMatchProbe} */
  const storedMatch = {
    emojiId: 1,
    aura: "none",
    status: "active",
    fen: "unchanged",
    flatMovesString: "moves",
  };
  /** @type {PresentationRoom | undefined} */
  let room;
  class Channel {
    controller = new AbortController();
    /** @param {RoomDependencies} dependencies */
    constructor(dependencies) {
      assert.ok(hasPresentationCallback(dependencies));
      room = dependencies;
    }
    get signal() {
      return this.controller.signal;
    }
    stop() {
      this.controller.abort();
    }
  }
  const Constructor = /** @type {new () => FixtureConnection} */ (
    compile(
      `class Connection { ${methods([
        "observeInviteReactions",
        "cleanupInviteReactionObserver",
        "rememberMatchPresentation",
        "getMatchPresentation",
        "updateEmoji",
        "surrender",
        "moveDeliveryScope",
        "isCurrentMoveBoard",
        "recoverMoveBoard",
      ])} }`,
      {
        MatchPresentationState,
        moveDeliveryStorageKey,
        isCompletedMatchPair,
        InviteReactionChannel: Channel,
        readMatchPresentationViaApi: (
          /** @type {Parameters<typeof import("../src/services/matchPresentationApi.ts").readMatchPresentationViaApi>} */ ...args
        ) => {
          reads.push(args);
          return pendingRead.promise;
        },
        updateMatchPresentationViaApi: (
          /** @type {Parameters<typeof import("../src/services/matchPresentationApi.ts").updateMatchPresentationViaApi>} */ ...args
        ) => {
          saves.push(args);
          return pendingSave.promise;
        },
        didReceiveMatchPresentationUpdate: (
          /** @type {Parameters<GameControllerContract["didReceiveMatchPresentationUpdate"]>} */ ...args
        ) => changes.push(args),
        didRecoverInviteReactions: () => {},
        didReceiveInviteReactionUpdate: () => {},
        incrementLifecycleCounter: () => {},
        decrementLifecycleCounter: () => {},
        surrenderMatchViaApi: async (
          /** @type {import("@mons/shared/game-sessions").SurrenderMatchRequest} */ request,
        ) => {
          writes.push(request);
          return {
            ok: true,
            inviteId: request.inviteId,
            matchId: request.matchId,
            actorUid: request.playerId,
          };
        },
        storage: { getPlayerEmojiAura: () => "none" },
      },
      "Connection",
    )
  );
  /** @type {FixtureConnection} */
  const connection = Object.assign(
    new Constructor(),
    /** @satisfies {Partial<FixtureConnection>} */ ({
      db: {},
      auth: { currentUser: { uid: "login-alias" } },
      sessionEpoch: 1,
      moveReconnectCooldownMs: 0,
      moveReconnectLastAttemptAt: 0,
      moveReconnectInFlight: false,
      matchPresentations: new Map(),
      confirmedSurrenders: new Set(),
      pendingSurrenders: new Map(),
      pendingMatchCompletions: new Map(),
      reconcilingMoveKeys: new Set(),
      moveRecoveryTimers: new Map(),
      observedMatchSnapshots: new Map(),
      myMatch: { ...storedMatch },
      activeContext: {
        contextId: 1,
        sessionEpoch: 1,
        inviteId: "invite",
        matchId: "invite",
        loginUid: "login-alias",
        actorUid: "actor",
        canWrite: true,
        role: "host",
        createdAtMs: 0,
      },
      latestInvite: { hostId: "actor", guestId: paired ? "guest" : null },
      inviteReactionSubscription: null,
      /**
       * @param {number} contextId
       */
      isContextActive(contextId) {
        return this.activeContext?.contextId === contextId;
      },
      isCurrentAuthUser: (/** @type {string} */ uid) => uid === "login-alias",
      registerObserverCleanup: (_id, key, cleanup) => {
        cleanups.set(key, cleanup);
        return true;
      },
      unregisterObserverCleanup: (_id, key) => cleanups.delete(key),
      getUserBoundAuthTokenProvider: (uid) => {
        assert.equal(uid, "login-alias");
        return Object.assign(async () => "token", {
          assertCurrentUser: () => {},
        });
      },
      requireWritableContext() {
        const context = this.activeContext;
        assert.ok(writableContext(context));
        return context;
      },
      createMatchContextGuard: () => () => true,
      flushPendingMoves: async () => {},
      logContextEvent: () => {},
      updateStoredEmoji: (...args) => {
        profileUpdates.push(args);
      },
    }),
  );
  connection.observeInviteReactions();
  return {
    connection,
    room: () => required(room),
    pendingRead,
    pendingSave,
    changes,
    saves,
    writes,
    reads,
    profileUpdates,
  };
}

test("actual connection hydrates before pairing and isolates optimistic appearance from legacy gameplay records", async (t) => {
  t.mock.method(console, "error", () => {});
  const h = connectionHarness({ paired: false });
  assert.equal(h.room().canConnect(), false);
  assert.equal(h.reads.length, 1);
  h.pendingRead.resolve({ ok: true, presentation: snapshot(appearance()) });
  await flush();
  const seed = { ...required(h.connection.myMatch) };
  h.connection.updateEmoji(1002, false, "rainbow");
  assert.deepEqual(h.profileUpdates, [[1002, "rainbow"]]);
  assert.deepEqual(h.connection.myMatch, seed);
  assert.equal(h.writes.length, 0);
  assert.equal(
    required(h.connection.getMatchPresentation("invite", "actor")).emojiId,
    1002,
  );
  assert.equal(required(h.saves[0])[2].expectedRevision, 1);
  h.room().onPresentationSnapshot(snapshot(appearance(1, 1)));
  h.connection.myMatch = { ...seed, emojiId: 9 };
  assert.equal(
    required(h.connection.getMatchPresentation("invite", "actor")).emojiId,
    1002,
  );
  h.pendingSave.resolve({
    ok: true,
    presentation: { ...appearance(2, 1002), aura: "rainbow" },
  });
  await flush();
  assert.equal(
    required(h.connection.getMatchPresentation("invite", "actor")).revision,
    2,
  );
  h.room().onError(new Error("reaction-channel-unavailable"));
  await flush();
  assert.equal(h.reads.length, 2);
  assert.equal(
    required(h.connection.getMatchPresentation("invite", "actor")).revision,
    2,
  );
  assert.equal(h.writes.length, 0);
  assert.equal(h.connection.surrender(), true);
  await flush();
  assert.deepEqual(h.writes, [
    {
      inviteId: "invite",
      matchId: "invite",
      playerId: "actor",
    },
  ]);
  h.connection.cleanupInviteReactionObserver();
});

function surrenderHarness() {
  /** @type {PromiseWithResolvers<import("@mons/shared/game-sessions").SurrenderMatchResponse>} */
  const pendingSurrender = deferred();
  /** @type {PromiseWithResolvers<import("@mons/shared/ratings").RatingUpdateResponse>} */
  const pendingRating = deferred();
  const rating = { submit: () => pendingRating.promise };
  /** @type {import("@mons/shared/ratings").RatingUpdateRequest[]} */
  const ratingRequests = [];
  /** @type {Array<{eventId: string; matchId: string}>} */
  const syncRequests = [];
  /** @type {Array<Parameters<typeof import("../src/services/matchSyncApi.ts").readMatchSyncViaApi>>} */
  const recoveryReads = [];
  /** @type {import("@mons/shared/match-sync").MatchSyncSnapshot} */
  const canonicalSnapshot = {
    inviteId: "invite",
    matchId: "invite",
    revision: 1,
    hostPlayerId: "actor",
    guestPlayerId: "opponent",
    hostMatch: canonicalMatch(),
    guestMatch: canonicalMatch({ color: "black" }),
  };
  /** @type {{read: typeof import("../src/services/matchSyncApi.ts").readMatchSyncViaApi}} */
  const recovery = {
    read: async () => ({ ok: true, snapshot: canonicalSnapshot }),
  };
  /** @type {Array<{request: import("@mons/shared/game-sessions").SurrenderMatchRequest; tokenProvider: import("../src/services/apiTransport.ts").AuthTokenProvider}>} */
  const requests = [];
  /** @type {string[]} */
  const events = [];
  /** @type {Array<Parameters<ConnectionContract["connectToGame"]>>} */
  const reconnects = [];
  const loginUser = { uid: "login-alias" };
  /** @type {{currentUser: {uid: string} | null}} */
  const state = { currentUser: loginUser };
  const Constructor = /** @type {new () => FixtureConnection} */ (
    compile(
      `class Connection { ${methods([
        "surrender",
        "updateRatings",
        "applyMatchSyncSnapshot",
        "isContextActive",
        "moveDeliveryScope",
        "isCurrentMoveBoard",
        "recoverMoveBoard",
        "isCurrentAuthUser",
        "requireWritableContext",
        "createMatchContextGuard",
        "createSessionGuard",
        "isSessionEpochActive",
        "reconnectAfterMatchUpdateFailure",
      ])} }`,
      {
        moveDeliveryStorageKey,
        isCompletedMatchPair,
        updateRatingsViaApi: (
          /** @type {import("@mons/shared/ratings").RatingUpdateRequest} */ request,
        ) => {
          ratingRequests.push(request);
          return rating.submit();
        },
        console: { error: () => {} },
        didReceiveMatchUpdates: () => {},
        readMatchSyncViaApi: (
          /** @type {Parameters<typeof import("../src/services/matchSyncApi.ts").readMatchSyncViaApi>} */ ...args
        ) => {
          recoveryReads.push(args);
          return recovery.read(...args);
        },
        surrenderMatchViaApi: (
          /** @type {import("@mons/shared/game-sessions").SurrenderMatchRequest} */ request,
          /** @type {import("../src/services/apiTransport.ts").AuthTokenProvider} */ tokenProvider,
        ) => {
          requests.push({ request, tokenProvider });
          return pendingSurrender.promise;
        },
      },
      "Connection",
    )
  );
  /** @type {FixtureConnection} */
  const connection = Object.assign(
    new Constructor(),
    /** @satisfies {Partial<FixtureConnection>} */ ({
      auth: state,
      getOpponentId: () => "opponent",
      getCurrentInviteEventId: () => "event",
      ensureAuthenticated: async () => {},
      notifyNavigationGamesChanged: () => {},
      eventClient: {
        syncEventStateAfterMatch: async (eventId, matchId) => {
          syncRequests.push({ eventId, matchId });
          return { ok: true };
        },
      },
      confirmedSurrenders: new Set(),
      pendingSurrenders: new Map(),
      pendingMatchCompletions: new Map(),
      reconcilingMoveKeys: new Set(),
      moveRecoveryTimers: new Map(),
      observedMatchSnapshots: new Map(),
      latestInvite: { hostId: "actor", guestId: "opponent" },
      myMatch: {
        fen: "current-fen",
        flatMovesString: "current-moves",
        status: "",
        timer: "current-timer",
        emojiId: 7,
        aura: "rainbow",
      },
      sessionEpoch: 1,
      activeContext: {
        contextId: 1,
        sessionEpoch: 1,
        inviteId: "invite",
        matchId: "invite",
        loginUid: "login-alias",
        actorUid: "actor",
        canWrite: true,
        role: "host",
        createdAtMs: 0,
      },
      moveReconnectCooldownMs: 0,
      moveReconnectLastAttemptAt: 0,
      moveReconnectInFlight: false,
      getUserBoundAuthTokenProvider: (/** @type {string} */ expectedUid) => {
        const assertCurrentUser = () => {
          if (
            state.currentUser !== loginUser ||
            expectedUid !== loginUser.uid
          ) {
            throw new Error("authentication-changed");
          }
        };
        assertCurrentUser();
        return Object.assign(async () => "token", { assertCurrentUser });
      },
      logContextEvent: (event) => events.push(event),
      flushPendingMoves: async () => {},
      signIn: async () => state.currentUser?.uid,
      connectToGame: async (...args) => {
        reconnects.push(args);
      },
    }),
  );
  return {
    connection,
    pendingSurrender,
    pendingRating,
    rating,
    ratingRequests,
    syncRequests,
    recoveryReads,
    canonicalSnapshot,
    recovery,
    requests,
    events,
    reconnects,
    state,
  };
}

test("match completion advances its captured event after moves commit while ratings are pending", async () => {
  const h = surrenderHarness();
  const moves = deferred();
  h.connection.flushPendingMoves = () => moves.promise;
  const completion = h.connection.updateRatings();
  await flush();
  assert.deepEqual(h.syncRequests, []);
  assert.deepEqual(h.ratingRequests, []);
  required(h.connection.activeContext).matchId = "another-match";
  h.connection.getCurrentInviteEventId = () => "another-event";
  moves.resolve();
  await flush();
  assert.deepEqual(h.syncRequests, [{ eventId: "event", matchId: "invite" }]);
  assert.deepEqual(h.ratingRequests, [
    {
      playerId: "actor",
      inviteId: "invite",
      matchId: "invite",
      opponentId: "opponent",
    },
  ]);
  h.pendingRating.resolve({ ok: true });
  await completion;
});

test("surrender acknowledgement precedes both event progression and ratings", async () => {
  const h = surrenderHarness();
  assert.equal(h.connection.surrender(), true);
  const completion = h.connection.updateRatings();
  await flush();
  assert.equal(h.requests.length, 1);
  assert.deepEqual(h.syncRequests, []);
  assert.deepEqual(h.ratingRequests, []);
  h.pendingSurrender.resolve(surrenderReceipt());
  await flush();
  assert.deepEqual(h.syncRequests, [{ eventId: "event", matchId: "invite" }]);
  assert.equal(h.ratingRequests.length, 1);
  h.pendingRating.resolve({ ok: true });
  await completion;
  assert.equal(h.connection.pendingSurrenders.size, 0);
});

test("uncertain surrender failure does not send premature event or rating updates", async () => {
  const h = surrenderHarness();
  assert.equal(h.connection.surrender(), true);
  const failure = assert.rejects(h.connection.updateRatings(), /timed out/);
  await flush();
  h.pendingSurrender.reject(new Error("Gameplay request timed out."));
  await failure;
  await flush();
  assert.deepEqual(h.syncRequests, []);
  assert.deepEqual(h.ratingRequests, []);
  assert.equal(h.recoveryReads.length, 1);
  assert.deepEqual(h.recoveryReads[0]?.slice(0, 2), ["invite", "invite"]);
  assert.equal(h.recoveryReads[0]?.[2], h.requests[0]?.tokenProvider);
  assert.deepEqual(h.reconnects, [["login-alias", "invite", false]]);
});

test("a failed surrender reconciliation resumes completion from the canonical reconnect snapshot", async () => {
  const h = surrenderHarness();
  h.recovery.read = async () => {
    throw new Error("http-503");
  };
  assert.equal(h.connection.surrender(), true);
  const failed = assert.rejects(h.connection.updateRatings(), /http-503/);
  const duplicate = h.connection.updateRatings();
  assert.deepEqual(await duplicate, { ok: true, skipped: true });
  await flush();
  h.pendingSurrender.reject(new Error("lost-response"));
  await failed;
  await flush();
  assert.equal(h.connection.pendingMatchCompletions.size, 1);
  assert.equal(h.ratingRequests.length, 0);
  h.connection.sessionEpoch++;
  h.connection.activeContext = {
    ...required(h.connection.activeContext),
    contextId: 2,
    sessionEpoch: h.connection.sessionEpoch,
  };
  const observe = () =>
    h.connection.applyMatchSyncSnapshot(
      required(h.connection.activeContext),
      h.canonicalSnapshot,
      new Set(["opponent"]),
    );
  observe();
  assert.equal(h.ratingRequests.length, 0);
  h.canonicalSnapshot.hostMatch = canonicalMatch({ status: "surrendered" });
  observe();
  observe();
  await flush();
  assert.equal(h.ratingRequests.length, 1);
  assert.deepEqual(h.syncRequests, [{ eventId: "event", matchId: "invite" }]);
  assert.equal(h.connection.confirmedSurrenders.size, 0);
  h.pendingRating.resolve({ ok: true });
  await flush();
  assert.equal(h.connection.pendingMatchCompletions.size, 0);
  observe();
  assert.equal(h.ratingRequests.length, 1);
});

for (const hostColor of /** @type {const} */ (["white", "black"])) {
  for (const evidence of ["reconciliation", "early-snapshot", "reconnect"]) {
    test(`normal score completion recovers surrender through ${evidence} with a ${hostColor} host`, async () => {
      const h = surrenderHarness();
      if (evidence !== "reconciliation")
        h.recovery.read = async () => {
          throw new Error("reconciliation-unavailable");
        };
      assert.equal(h.connection.surrender(), true);
      const completion = h.connection.updateRatings();
      const failed =
        evidence === "reconnect"
          ? assert.rejects(completion, /reconciliation-unavailable/)
          : null;
      await flush();
      Object.assign(
        h.canonicalSnapshot,
        canonicalScoreMatchPair({ hostColor }),
      );
      const observe = () =>
        h.connection.applyMatchSyncSnapshot(
          required(h.connection.activeContext),
          h.canonicalSnapshot,
          new Set(["opponent"]),
        );
      if (evidence === "early-snapshot") {
        observe();
        h.connection.activeContext = null;
        h.connection.getCurrentInviteEventId = () => "another-event";
      }
      h.pendingSurrender.reject(new Error("surrender-unavailable"));
      if (failed) {
        await failed;
        assert.equal(h.ratingRequests.length, 0);
        assert.equal(h.connection.pendingMatchCompletions.size, 1);
        h.connection.sessionEpoch++;
        h.connection.activeContext = {
          ...required(h.connection.activeContext),
          contextId: 2,
          sessionEpoch: h.connection.sessionEpoch,
        };
        observe();
        observe();
      }
      await flush();
      assert.deepEqual(h.ratingRequests, [
        {
          playerId: "actor",
          opponentId: "opponent",
          inviteId: "invite",
          matchId: "invite",
        },
      ]);
      assert.deepEqual(h.syncRequests, [
        { eventId: "event", matchId: "invite" },
      ]);
      assert.equal(h.connection.confirmedSurrenders.size, 0);
      h.pendingRating.resolve({ ok: true });
      if (!failed) assert.deepEqual(await completion, { ok: true });
      await flush();
      assert.equal(h.connection.pendingMatchCompletions.size, 0);
    });
  }
}

test("unconfirmed or malformed score snapshots cannot settle a failed surrender", async () => {
  const completePair = canonicalScoreMatchPair();
  for (const pair of [
    canonicalScoreMatchPair({ completed: false }),
    {
      hostMatch: { ...completePair.hostMatch, fen: "invalid" },
      guestMatch: { ...completePair.guestMatch, fen: "invalid" },
    },
    {
      ...completePair,
      guestMatch: { ...completePair.guestMatch, flatMovesString: "invalid" },
    },
  ]) {
    const h = surrenderHarness();
    Object.assign(h.canonicalSnapshot, pair);
    assert.equal(h.connection.surrender(), true);
    const failed = assert.rejects(
      h.connection.updateRatings(),
      /surrender-unavailable/,
    );
    await flush();
    h.pendingSurrender.reject(new Error("surrender-unavailable"));
    await failed;
    h.connection.applyMatchSyncSnapshot(
      required(h.connection.activeContext),
      h.canonicalSnapshot,
      new Set(["opponent"]),
    );
    await flush();
    assert.deepEqual(h.ratingRequests, []);
    assert.deepEqual(h.syncRequests, []);
    assert.equal(h.connection.confirmedSurrenders.size, 0);
    assert.equal(h.connection.pendingMatchCompletions.size, 1);
  }
});

test("terminal evidence received before surrender failure survives navigation", async () => {
  const h = surrenderHarness();
  h.recovery.read = async () => {
    throw new Error("http-503");
  };
  assert.equal(h.connection.surrender(), true);
  const completion = h.connection.updateRatings();
  await flush();
  h.canonicalSnapshot.guestMatch = canonicalMatch({
    color: "black",
    timer: { state: "finished" },
  });
  h.connection.applyMatchSyncSnapshot(
    required(h.connection.activeContext),
    h.canonicalSnapshot,
    new Set(["opponent"]),
  );
  assert.equal(h.ratingRequests.length, 0);
  h.connection.activeContext = null;
  h.connection.getCurrentInviteEventId = () => "another-event";
  h.pendingSurrender.reject(new Error("lost-response"));
  await flush();
  assert.deepEqual(h.ratingRequests, [
    {
      playerId: "actor",
      opponentId: "opponent",
      inviteId: "invite",
      matchId: "invite",
    },
  ]);
  assert.deepEqual(h.syncRequests, [{ eventId: "event", matchId: "invite" }]);
  h.pendingRating.resolve({ ok: true });
  await completion;
  assert.equal(h.connection.pendingMatchCompletions.size, 0);
});

test("a failed recovery settlement remains retryable on the next canonical reconnect", async () => {
  for (const earlyEvidence of [false, true]) {
    const h = surrenderHarness();
    h.recovery.read = async () => {
      throw new Error("http-503");
    };
    assert.equal(h.connection.surrender(), true);
    const failed = assert.rejects(
      h.connection.updateRatings(),
      earlyEvidence ? /rating-unavailable/ : /http-503/,
    );
    await flush();
    h.canonicalSnapshot.hostMatch = canonicalMatch({ status: "surrendered" });
    const observe = () =>
      h.connection.applyMatchSyncSnapshot(
        required(h.connection.activeContext),
        h.canonicalSnapshot,
        new Set(["opponent"]),
      );
    if (earlyEvidence) observe();
    h.pendingSurrender.reject(new Error("lost-response"));
    await flush();
    if (!earlyEvidence) observe();
    await flush();
    h.pendingRating.reject(new Error("rating-unavailable"));
    await failed;
    await flush();
    assert.equal(h.connection.pendingMatchCompletions.size, 1);
    h.rating.submit = async () => ({ ok: true });
    observe();
    observe();
    await flush();
    assert.equal(h.ratingRequests.length, 2);
    assert.equal(h.connection.pendingMatchCompletions.size, 0);
  }
});

test("a later game completion can supersede an unconfirmed failed surrender", async () => {
  const h = surrenderHarness();
  assert.equal(h.connection.surrender(), true);
  const failed = assert.rejects(
    h.connection.updateRatings(),
    /surrender-unavailable/,
  );
  await flush();
  h.pendingSurrender.reject(new Error("surrender-unavailable"));
  await failed;
  await flush();
  assert.equal(h.connection.pendingSurrenders.size, 0);
  assert.equal(h.connection.pendingMatchCompletions.size, 1);
  assert.equal(h.ratingRequests.length, 0);
  const completion = h.connection.updateRatings();
  await flush();
  assert.equal(h.ratingRequests.length, 1);
  assert.deepEqual(h.syncRequests, [{ eventId: "event", matchId: "invite" }]);
  h.pendingRating.resolve({ ok: true });
  assert.deepEqual(await completion, { ok: true });
  assert.equal(h.connection.pendingMatchCompletions.size, 0);
});

test("deferred completion rejects other matches, participants, and replacement auth sessions", async () => {
  const h = surrenderHarness();
  h.recovery.read = async () => {
    throw new Error("http-503");
  };
  assert.equal(h.connection.surrender(), true);
  const failed = assert.rejects(h.connection.updateRatings(), /http-503/);
  await flush();
  h.pendingSurrender.reject(new Error("lost-response"));
  await failed;
  await flush();
  h.canonicalSnapshot.hostMatch = canonicalMatch({ status: "surrendered" });
  const recovery = required(
    [...h.connection.pendingMatchCompletions.values()][0],
  );
  for (const snapshot of [
    { ...h.canonicalSnapshot, inviteId: "other" },
    { ...h.canonicalSnapshot, matchId: "other" },
    { ...h.canonicalSnapshot, guestPlayerId: "other" },
    { ...h.canonicalSnapshot, hostPlayerId: "other" },
    { ...h.canonicalSnapshot, hostMatch: null },
  ])
    recovery.observe(snapshot);
  assert.equal(h.ratingRequests.length, 0);
  h.state.currentUser = { uid: "login-alias" };
  recovery.observe(h.canonicalSnapshot);
  await flush();
  assert.equal(h.ratingRequests.length, 0);
  assert.deepEqual(h.syncRequests, []);
  assert.equal(h.connection.pendingMatchCompletions.size, 0);
});

test("a lost surrender response progresses only after the actor's canonical surrender is confirmed", async () => {
  for (const role of ["host", "guest"]) {
    const h = surrenderHarness();
    /** @type {PromiseWithResolvers<import("@mons/shared/match-sync").ReadMatchSyncResponse>} */
    const read = deferred();
    h.recovery.read = () => read.promise;
    if (role === "guest") {
      h.canonicalSnapshot.hostPlayerId = "opponent";
      h.canonicalSnapshot.guestPlayerId = "actor";
      h.canonicalSnapshot.guestMatch = canonicalMatch({
        color: "black",
        status: "surrendered",
      });
    } else {
      h.canonicalSnapshot.hostMatch = canonicalMatch({ status: "surrendered" });
    }
    assert.equal(h.connection.surrender(), true);
    const completion = h.connection.updateRatings();
    await flush();
    h.pendingSurrender.reject(new Error("Gameplay request timed out."));
    await flush();
    assert.equal(h.requests.length, 1);
    assert.equal(h.recoveryReads.length, 1);
    assert.deepEqual(h.recoveryReads[0]?.slice(0, 2), ["invite", "invite"]);
    assert.equal(h.recoveryReads[0]?.[2], h.requests[0]?.tokenProvider);
    assert.deepEqual(h.syncRequests, []);
    assert.deepEqual(h.ratingRequests, []);
    read.resolve({ ok: true, snapshot: h.canonicalSnapshot });
    await flush();
    assert.deepEqual(h.syncRequests, [{ eventId: "event", matchId: "invite" }]);
    assert.equal(h.ratingRequests.length, 1);
    h.pendingRating.resolve({ ok: true });
    await completion;
    assert.deepEqual(h.events, ["ctx.write.success"]);
    assert.deepEqual(h.reconnects, []);
    assert.equal(h.connection.pendingSurrenders.size, 0);
  }
});

test("surrender losing a terminal-state race still settles the captured match without confirming surrender", async () => {
  for (const actorRole of ["host", "guest"]) {
    for (const terminal of [
      "host-timer",
      "guest-timer",
      "opponent-surrender",
    ]) {
      const h = surrenderHarness();
      if (actorRole === "guest") {
        h.canonicalSnapshot.hostPlayerId = "opponent";
        h.canonicalSnapshot.guestPlayerId = "actor";
      }
      if (terminal === "host-timer")
        required(h.canonicalSnapshot.hostMatch).timer = { state: "finished" };
      else if (terminal === "guest-timer")
        required(h.canonicalSnapshot.guestMatch).timer = { state: "finished" };
      else
        required(
          actorRole === "host"
            ? h.canonicalSnapshot.guestMatch
            : h.canonicalSnapshot.hostMatch,
        ).status = "surrendered";
      assert.equal(h.connection.surrender(), true);
      const completion = h.connection.updateRatings();
      await flush();
      h.pendingSurrender.reject(new Error("match-surrender-blocked"));
      await flush();
      assert.equal(h.requests.length, 1);
      assert.equal(h.recoveryReads.length, 1);
      assert.equal(h.ratingRequests.length, 1);
      assert.deepEqual(h.syncRequests, [
        { eventId: "event", matchId: "invite" },
      ]);
      assert.equal(h.connection.confirmedSurrenders.size, 0);
      assert.deepEqual(h.reconnects, [["login-alias", "invite", false]]);
      assert.deepEqual(h.events, []);
      h.pendingRating.resolve({ ok: true });
      assert.deepEqual(await completion, { ok: true });
      assert.equal(h.connection.pendingSurrenders.size, 0);
    }
  }
});

test("surrender reconciliation rejects another match or an absent actor", async () => {
  for (const change of /** @satisfies {Array<(snapshot: import("@mons/shared/match-sync").MatchSyncSnapshot) => void>} */ ([
    (snapshot) => {
      snapshot.inviteId = "other-invite";
    },
    (snapshot) => {
      snapshot.matchId = "invite1";
    },
    (snapshot) => {
      snapshot.hostPlayerId = "different-actor";
    },
    (snapshot) => {
      snapshot.hostMatch = null;
    },
  ])) {
    const h = surrenderHarness();
    h.canonicalSnapshot.hostMatch = canonicalMatch({ status: "surrendered" });
    change(h.canonicalSnapshot);
    assert.equal(h.connection.surrender(), true);
    const failure = assert.rejects(h.connection.updateRatings(), /timed out/);
    await flush();
    h.pendingSurrender.reject(new Error("Gameplay request timed out."));
    await failure;
    await flush();
    assert.equal(h.recoveryReads.length, 1);
    assert.deepEqual(h.syncRequests, []);
    assert.deepEqual(h.ratingRequests, []);
    assert.equal(h.connection.confirmedSurrenders.size, 0);
  }
});

test("surrender reconciliation cannot read or confirm under a replacement authentication session", async () => {
  for (const duringRead of [false, true]) {
    const h = surrenderHarness();
    /** @type {PromiseWithResolvers<import("@mons/shared/match-sync").ReadMatchSyncResponse>} */
    const read = deferred();
    h.recovery.read = () => read.promise;
    h.canonicalSnapshot.hostMatch = canonicalMatch({ status: "surrendered" });
    assert.equal(h.connection.surrender(), true);
    const failure = assert.rejects(
      h.connection.updateRatings(),
      /authentication-changed/,
    );
    await flush();
    if (!duringRead) h.state.currentUser = { uid: "login-alias" };
    h.pendingSurrender.reject(new Error("Gameplay request timed out."));
    await flush();
    if (duringRead) h.state.currentUser = { uid: "login-alias" };
    read.resolve({ ok: true, snapshot: h.canonicalSnapshot });
    await failure;
    await flush();
    assert.equal(h.recoveryReads.length, duringRead ? 1 : 0);
    assert.deepEqual(h.syncRequests, []);
    assert.deepEqual(h.ratingRequests, []);
    assert.equal(h.connection.confirmedSurrenders.size, 0);
  }
});

test("completion cannot dispatch under a replacement authentication session", async () => {
  const h = surrenderHarness();
  const moves = deferred();
  h.connection.flushPendingMoves = () => moves.promise;
  const failure = assert.rejects(
    h.connection.updateRatings(),
    /authentication-changed/,
  );
  await flush();
  h.state.currentUser = { uid: "login-alias" };
  moves.resolve();
  await failure;
  assert.deepEqual(h.syncRequests, []);
  assert.deepEqual(h.ratingRequests, []);
});

test("non-event completions do not synchronize events", async () => {
  const h = surrenderHarness();
  h.connection.getCurrentInviteEventId = () => null;
  const completion = h.connection.updateRatings();
  await flush();
  assert.deepEqual(h.syncRequests, []);
  assert.equal(h.ratingRequests.length, 1);
  h.pendingRating.resolve({ ok: true });
  await completion;
});

test("event synchronization failure does not fail completed rating processing", async () => {
  const h = surrenderHarness();
  h.connection.eventClient.syncEventStateAfterMatch = async () => {
    throw new Error("event-sync-unavailable");
  };
  const completion = h.connection.updateRatings();
  await flush();
  h.pendingRating.resolve({ ok: true });
  assert.deepEqual(await completion, { ok: true });
});

test("surrender immediately updates only local status and queues the captured actor through the API", async () => {
  const h = surrenderHarness();
  const previous = { ...h.connection.myMatch };
  assert.equal(h.connection.surrender(), true);
  assert.deepEqual(h.connection.myMatch, {
    ...previous,
    status: "surrendered",
  });
  await flush();
  assert.deepEqual(
    h.requests.map(({ request }) => request),
    [
      {
        inviteId: "invite",
        matchId: "invite",
        playerId: "actor",
      },
    ],
  );
  assert.deepEqual(h.events, []);
  h.connection.myMatch.fen = "newer-fen";
  h.pendingSurrender.resolve(surrenderReceipt());
  await flush();
  assert.equal(h.connection.myMatch.fen, "newer-fen");
  assert.deepEqual(h.events, ["ctx.write.success"]);
});

test("surrender leaves local state unchanged without a match, writable context, or original login", () => {
  for (const invalidate of /** @satisfies {Array<(h: ReturnType<typeof surrenderHarness>) => void>} */ ([
    (h) => {
      h.connection.myMatch = null;
    },
    (h) => {
      h.connection.activeContext = null;
    },
    (h) => {
      required(h.connection.activeContext).canWrite = false;
    },
    (h) => {
      h.state.currentUser = null;
    },
    (h) => {
      h.state.currentUser = { uid: "login-alias" };
    },
  ])) {
    const h = surrenderHarness();
    invalidate(h);
    const previous = structuredClone(h.connection.myMatch);
    assert.equal(h.connection.surrender(), false);
    assert.deepEqual(h.connection.myMatch, previous);
    assert.equal(h.requests.length, 0);
  }
});

test("surrender failure reconciles through reconnect without assuming the optimistic write failed", async () => {
  const h = surrenderHarness();
  assert.equal(h.connection.surrender(), true);
  await flush();
  h.pendingSurrender.reject(new Error("Gameplay request timed out."));
  await flush();
  assert.equal(required(h.connection.myMatch).status, "surrendered");
  assert.deepEqual(h.events, ["ctx.write.fail"]);
  assert.deepEqual(h.reconnects, [["login-alias", "invite", false]]);
});

test("late surrender success and failure cannot affect a different match, invite, actor, or user", async () => {
  for (const invalidate of /** @satisfies {Array<(h: ReturnType<typeof surrenderHarness>) => void>} */ ([
    (h) => {
      required(h.connection.activeContext).matchId = "invite1";
    },
    (h) => {
      required(h.connection.activeContext).inviteId = "another-invite";
    },
    (h) => {
      h.connection.activeContext = {
        ...required(h.connection.activeContext),
        actorUid: "another-actor",
        contextId: 2,
      };
    },
    (h) => {
      h.connection.activeContext = {
        ...required(h.connection.activeContext),
        loginUid: "another-login",
        contextId: 2,
      };
    },
    (h) => {
      h.state.currentUser = null;
    },
    (h) => {
      h.state.currentUser = { uid: "login-alias" };
    },
  ])) {
    for (const reject of [false, true]) {
      const h = surrenderHarness();
      assert.equal(h.connection.surrender(), true);
      await flush();
      invalidate(h);
      h.connection.myMatch = { status: "", fen: "another-match" };
      if (reject) h.pendingSurrender.reject(new Error("unavailable"));
      else h.pendingSurrender.resolve(surrenderReceipt());
      await flush();
      assert.deepEqual(h.events, []);
      assert.deepEqual(h.reconnects, []);
      assert.deepEqual(h.connection.myMatch, {
        status: "",
        fen: "another-match",
      });
    }
  }
});

test("late surrender success restores status and refreshes the same board after context or session replacement", async () => {
  for (const renew of /** @satisfies {Array<(h: ReturnType<typeof surrenderHarness>) => void>} */ ([
    (h) => {
      h.connection.activeContext = {
        ...required(h.connection.activeContext),
        contextId: 2,
      };
    },
    (h) => {
      h.connection.sessionEpoch = 2;
      h.connection.activeContext = {
        ...required(h.connection.activeContext),
        sessionEpoch: 2,
      };
    },
  ])) {
    const h = surrenderHarness();
    const scope = h.connection.moveDeliveryScope(
      required(h.connection.activeContext),
    );
    assert.equal(h.connection.surrender(), true);
    await flush();
    renew(h);
    h.connection.myMatch = { status: "", fen: "reconnected-fen" };
    h.pendingSurrender.resolve(surrenderReceipt());
    await flush();
    assert.deepEqual(h.connection.myMatch, {
      status: "surrendered",
      fen: "reconnected-fen",
    });
    assert.equal(
      h.connection.confirmedSurrenders.has(moveDeliveryStorageKey(scope)),
      true,
    );
    assert.deepEqual(h.events, []);
    assert.deepEqual(h.reconnects, [["login-alias", "invite", false]]);
  }
});

test("late surrender failure retains the original context and session guard", async () => {
  for (const invalidate of /** @satisfies {Array<(h: ReturnType<typeof surrenderHarness>) => void>} */ ([
    (h) => {
      required(h.connection.activeContext).contextId += 1;
    },
    (h) => {
      h.connection.sessionEpoch += 1;
    },
  ])) {
    const h = surrenderHarness();
    assert.equal(h.connection.surrender(), true);
    await flush();
    invalidate(h);
    h.connection.myMatch = { status: "", fen: "reconnected-fen" };
    h.pendingSurrender.reject(new Error("unavailable"));
    await flush();
    assert.deepEqual(h.events, []);
    assert.deepEqual(h.reconnects, []);
    assert.deepEqual(h.connection.myMatch, {
      status: "",
      fen: "reconnected-fen",
    });
    assert.equal(h.connection.confirmedSurrenders.size, 0);
  }
});

test("surrender recovery keeps the original guard while reconnect authentication is pending", async () => {
  for (const invalidate of /** @satisfies {Array<(h: ReturnType<typeof surrenderHarness>) => void>} */ ([
    (h) => {
      required(h.connection.activeContext).matchId = "invite1";
    },
    (h) => {
      h.connection.sessionEpoch += 1;
    },
    (h) => {
      h.state.currentUser = null;
    },
    (h) => {
      h.state.currentUser = { uid: "login-alias" };
    },
  ])) {
    const h = surrenderHarness();
    /** @type {PromiseWithResolvers<string | undefined>} */
    const pendingSignIn = deferred();
    h.connection.signIn = () => pendingSignIn.promise;
    assert.equal(h.connection.surrender(), true);
    await flush();
    h.pendingSurrender.reject(new Error("unavailable"));
    await flush();
    assert.deepEqual(h.events, ["ctx.write.fail"]);
    invalidate(h);
    pendingSignIn.resolve("login-alias");
    await flush();
    assert.deepEqual(h.reconnects, []);
    assert.equal(h.connection.moveReconnectInFlight, false);
  }
});

test("resign confirmation retains immediate UI handling only when submission was queued", async () => {
  for (const writable of [false, true]) {
    const h = surrenderHarness();
    if (!writable) h.connection.myMatch = null;
    /** @type {Array<[boolean, string]>} */
    const resignations = [];
    const click =
      /** @type {GameControllerContract["didClickConfirmResignButton"]} */ (
        compile(
          functions(sourceFile("../src/game/gameController.ts"), [
            "didClickConfirmResignButton",
          ]),
          {
            canHandleLiveBoardInput: () => true,
            isOnlineGame: true,
            connection: h.connection,
            handleResignStatus: (/** @type {[boolean, string]} */ ...args) =>
              resignations.push(args),
          },
          "didClickConfirmResignButton",
        )
      );
    click();
    assert.deepEqual(resignations, writable ? [[false, ""]] : []);
    if (writable) {
      h.pendingSurrender.resolve(surrenderReceipt());
      await flush();
      assert.deepEqual(resignations, [[false, ""]]);
    }
  }
});

test("actual context teardown aborts appearance hydration and rejects its late result", async () => {
  const h = connectionHarness();
  const signal = required(h.connection.inviteReactionSubscription).presentation
    .signal;
  h.connection.cleanupInviteReactionObserver();
  h.connection.activeContext = {
    ...required(h.connection.activeContext),
    contextId: 2,
    matchId: "invite1",
  };
  h.pendingRead.resolve({ ok: true, presentation: snapshot(appearance(3, 3)) });
  await flush();
  assert.equal(signal.aborted, true);
  assert.equal(h.changes.length, 0);
  assert.equal(h.connection.matchPresentations.size, 0);
  assert.equal(h.connection.getMatchPresentation("invite1", "actor"), null);
});

test("actual board hydration and late profile responses retain canonical and optimistic match appearance", () => {
  let value = appearance(2, 7);
  const player = { uid: "actor", emojiId: 1, aura: "none" };
  const opponent = { uid: "guest", emojiId: 3, aura: "none" };
  /** @type {boolean[]} */
  const rendered = [];
  const boardSource = sourceFile("../src/game/board.ts");
  const board =
    /** @type {Pick<BoardContract, "updateEmojiAndAuraIfNeeded" | "didGetPlayerProfile">} */ (
      compile(
        functions(boardSource, [
          "updateEmojiAndAuraIfNeeded",
          "didGetPlayerProfile",
        ]),
        {
          playerSideMetadata: player,
          opponentSideMetadata: opponent,
          gameInputRuntime: {
            isWatchOnly: false,
            getDisplayedMatchPresentation: (/** @type {string} */ uid) =>
              uid === "actor" ? value : null,
          },
          storage: { getPlayerEmojiAura: () => "none" },
          syncAvatarForCurrentMetadata: (/** @type {boolean} */ side) =>
            rendered.push(side),
          updatePlayerMetadataWithProfile: () => {},
          recalculateDisplayNames: () => {},
        },
        "({ updateEmojiAndAuraIfNeeded, didGetPlayerProfile })",
      )
    );
  board.updateEmojiAndAuraIfNeeded(1, "none", false);
  assert.equal(player.emojiId, 7);
  value = { ...appearance(2, 8), aura: "rainbow" };
  board.didGetPlayerProfile(
    canonicalProfile({ emoji: 1, aura: "none" }),
    "actor",
    false,
  );
  assert.equal(player.emojiId, 8);
  assert.equal(player.aura, "rainbow");
  board.updateEmojiAndAuraIfNeeded(1, "none", false);
  assert.equal(player.emojiId, 8);
  assert.deepEqual(rendered, [false, false, false]);
});

/** @param {[import("@mons/shared/appearance").Aura, import("@mons/shared/appearance").Aura]} auras */
function watchOnlyAuraHarness(auras) {
  const element = () => {
    /** @type {Map<string, string>} */
    const attributes = new Map();
    return {
      getAttribute: (/** @type {string} */ name) =>
        attributes.get(name) ?? null,
      getAttributeNS: (
        /** @type {string} */ _namespace,
        /** @type {string} */ name,
      ) => attributes.get(name) ?? null,
      setAttribute: (/** @type {string} */ name, /** @type {string} */ value) =>
        attributes.set(name, value),
      removeAttribute: (/** @type {string} */ name) => attributes.delete(name),
    };
  };
  const avatars = [element(), element()];
  const placeholders = [element(), element()];
  for (const placeholder of placeholders) {
    placeholder.setAttribute("display", "none");
  }
  const actualAuraVisibility = [false, false];
  const presentations = [
    { actorUid: "actor", emojiId: 1001, aura: auras[0] },
    { actorUid: "guest", emojiId: 1002, aura: auras[1] },
  ];
  const newEmptyPlayerMetadata = () => ({
    uid: "",
    emojiId: null,
    aura: "none",
  });
  const noop = () => {};
  const board =
    /** @type {{reset: BoardContract["resetForNewGame"]; hide: BoardContract["hideBoardPlayersInfo"]; show: BoardContract["showBoardPlayersInfo"]; switchPlayers(): void; restore(): void}} */ (
      compile(
        `
    let playerSideMetadata = newEmptyPlayerMetadata();
    let opponentSideMetadata = newEmptyPlayerMetadata();
    let playerInfoPlayerVisible = false;
    let playerInfoOpponentVisible = false;
    let playerInfoPlayerNameVisible = false;
    let playerInfoOpponentNameVisible = false;
    let playerScoreDisplayText = "";
    let opponentScoreDisplayText = "";
    ${functions(sourceFile("../src/game/board.ts"), [
      "syncAvatarForCurrentMetadata",
      "resetForNewGame",
      "updateEmojiAndAuraIfNeeded",
      "setupPlayerId",
      "hideBoardPlayersInfo",
      "showBoardPlayersInfo",
    ])}
    `,
        {
          newEmptyPlayerMetadata,
          gameInputRuntime: {
            isWatchOnly: true,
            isOnlineGame: true,
            isGameWithBot: false,
            getDisplayedMatchPresentation: (/** @type {string} */ uid) =>
              presentations.find(
                (value) =>
                  value.actorUid === uid || `new-${value.actorUid}` === uid,
              ) ?? null,
          },
          storage: { getPlayerEmojiAura: () => "rainbow" },
          slotIsOpponentForMetadataSide: (/** @type {boolean} */ side) => side,
          playerAvatar: avatars[0],
          opponentAvatar: avatars[1],
          playerAvatarPlaceholder: placeholders[0],
          opponentAvatarPlaceholder: placeholders[1],
          doNotShowPlayerAvatarPlaceholderAgain: true,
          doNotShowOpponentAvatarPlaceholderAgain: true,
          emojis: {
            getEmojiUrl: (/** @type {number | null} */ id) =>
              id ? `emoji-${id}.webp` : "",
          },
          SVG: {
            setHidden: (
              /** @type {ReturnType<typeof element>} */ target,
              /** @type {boolean} */ hidden,
            ) => {
              if (hidden) target.setAttribute("display", "none");
              else target.removeAttribute("display");
            },
            setImageUrl: (
              /** @type {ReturnType<typeof element>} */ target,
              /** @type {string} */ url,
            ) => target.setAttribute("href", url),
          },
          showRaibowAura: (
            /** @type {boolean} */ visible,
            /** @type {string} */ _url,
            /** @type {boolean} */ opponent,
          ) => {
            actualAuraVisibility[opponent ? 1 : 0] = visible;
          },
          updateAuraForAvatarElement: noop,
          setEndOfGameMarkers: noop,
          clearVoiceReactionState: noop,
          renderPlayersNamesLabels: noop,
          recalculateDisplayNames: noop,
          updateWagerPlayerUids: noop,
          emitBoardPlayerInfoOverlayState: noop,
          setInviteBotButtonVisible: noop,
          setBotStrengthControlVisible: noop,
          removeHighlights: noop,
          cleanAllPixels: noop,
          clearWagerPilesForNewMatch: noop,
        },
        `({
      reset: resetForNewGame,
      hide: hideBoardPlayersInfo,
      show: showBoardPlayersInfo,
      switchPlayers: () => {
        setupPlayerId("new-actor", false);
        setupPlayerId("new-guest", true);
      },
      restore: () => {
        setupPlayerId("actor", false);
        setupPlayerId("guest", true);
        updateEmojiAndAuraIfNeeded(1001, ${JSON.stringify(auras[0])}, false);
        updateEmojiAndAuraIfNeeded(1002, ${JSON.stringify(auras[1])}, true);
      }
    })`,
      )
    );
  return { board, actualAuraVisibility };
}

/** @type {Array<[string, [import("@mons/shared/appearance").Aura, import("@mons/shared/appearance").Aura]]>} */
const auraCases = [
  ["player rainbow", ["rainbow", "none"]],
  ["opponent rainbow", ["none", "rainbow"]],
  ["both rainbow", ["rainbow", "rainbow"]],
  ["neither rainbow", ["none", "none"]],
];
for (const [label, auras] of auraCases) {
  test(`watch-only board reset restores unchanged appearance with ${label}`, () => {
    const h = watchOnlyAuraHarness(auras);
    const expected = required(auras).map(
      (/** @type {string} */ aura) => aura === "rainbow",
    );
    h.board.restore();
    assert.deepEqual(h.actualAuraVisibility, expected);
    h.board.reset();
    assert.deepEqual(h.actualAuraVisibility, [false, false]);
    h.board.restore();
    assert.deepEqual(h.actualAuraVisibility, expected);
  });
}

test("watch-only player identity changes restore the same rainbow appearance", () => {
  const h = watchOnlyAuraHarness(["rainbow", "rainbow"]);
  h.board.restore();
  assert.deepEqual(h.actualAuraVisibility, [true, true]);
  h.board.switchPlayers();
  assert.deepEqual(h.actualAuraVisibility, [true, true]);
});

test("watch-only appearance refresh keeps hidden auras hidden until avatars are shown", () => {
  const h = watchOnlyAuraHarness(["rainbow", "rainbow"]);
  h.board.restore();
  h.board.hide();
  assert.deepEqual(h.actualAuraVisibility, [false, false]);
  h.board.restore();
  assert.deepEqual(h.actualAuraVisibility, [false, false]);
  h.board.show();
  assert.deepEqual(h.actualAuraVisibility, [true, true]);
});

test("actual presentation callback is appearance-only and respects hydration, actor aliases and historical views", () => {
  const values = new Map([
    ["invite/actor", appearance(2, 7)],
    ["invite1/actor", { ...appearance(4, 8), matchId: "invite1" }],
  ]);
  /** @type {Array<Parameters<BoardContract["updateEmojiAndAuraIfNeeded"]>>} */
  const rendered = [];
  const board = {
    playerSideMetadata: { uid: "" },
    opponentSideMetadata: { uid: "guest" },
    updateEmojiAndAuraIfNeeded: (
      /** @type {Parameters<BoardContract["updateEmojiAndAuraIfNeeded"]>} */ ...args
    ) => rendered.push(args),
  };
  const controllerSource = sourceFile("../src/game/gameController.ts");
  const controller =
    /** @type {{notify: GameControllerContract["didReceiveMatchPresentationUpdate"]; refresh(): void; history(matchId: string): void; live(): void}} */ (
      compile(
        `
    let isOnlineGame = true;
    let boardViewMode = "activeLive";
    ${functions(controllerSource, ["getDisplayedMatchPresentation", "refreshDisplayedMatchPresentation", "didReceiveMatchPresentationUpdate"])}
  `,
        {
          rematchViewing: createRematchViewingHarness(),
          Board: board,
          connection: {
            getActiveMatchId: () => "invite1",
            getMatchPresentation: (
              /** @type {string} */ matchId,
              /** @type {string} */ uid,
            ) => values.get(`${matchId}/${uid}`) ?? null,
          },
          didReceiveMatchUpdate: () =>
            assert.fail("appearance replayed gameplay"),
        },
        "({ notify: didReceiveMatchPresentationUpdate, refresh: refreshDisplayedMatchPresentation, history: (matchId) => { boardViewMode = 'historicalView'; rematchViewing.commitSelection(rematchViewing.beginSelection(() => true), { matchId, pair: { hostPlayerId: 'actor', hostMatch: { emojiId: 5, aura: 'none' } }, game: {} }); }, live: () => { boardViewMode = 'activeLive'; rematchViewing.clearSelection(); } })",
      )
    );
  controller.notify("invite1", "actor");
  assert.deepEqual(rendered, []);
  board.playerSideMetadata.uid = "actor";
  controller.refresh();
  assert.deepEqual(rendered.pop(), [8, "none", false]);
  controller.notify("invite1", "login-alias");
  assert.deepEqual(rendered, []);
  controller.history("invite");
  controller.notify("invite1", "actor");
  assert.deepEqual(rendered, []);
  controller.refresh();
  assert.deepEqual(rendered.pop(), [5, "none", false]);
  controller.notify("invite", "actor");
  assert.deepEqual(rendered, []);
  controller.live();
  controller.refresh();
  assert.deepEqual(rendered.pop(), [8, "none", false]);
});

function historyAppearanceHarness({
  online = true,
  active = true,
  bot = false,
} = {}) {
  const player = { uid: "signed-in-login", emojiId: 1001, aura: "rainbow" };
  const opponent = { uid: "opponent", emojiId: 4, aura: "none" };
  /** @type {Array<{emojiId: number; aura: "rainbow"}>} */
  const requests = [];
  /**
   * @type {string[]}
   */
  const order = [];
  /** @type {Array<Partial<import("../src/game/gameControlsModel.ts").GameControlsContext>>} */
  const contexts = [];
  const noop = () => {};
  /** @type {BoardContract["getPlayersEmojiId"]} */
  const unboundEmoji = () => assert.fail("board emoji function not bound");
  /** @type {BoardContract["updateEmojiAndAuraIfNeeded"]} */
  const unboundAppearance = () =>
    assert.fail("board appearance function not bound");
  const board = {
    getPlayersEmojiId: unboundEmoji,
    updateEmojiAndAuraIfNeeded: unboundAppearance,
    playerSideMetadata: player,
    opponentSideMetadata: opponent,
    removeHighlights: noop,
    hideItemSelectionOrConfirmationOverlay: noop,
    setBoardFlipped: noop,
    markWagerInitialStateReceived: noop,
    hideBoardPlayersInfo: noop,
    runMonsBoardAsDisplayWaitingAnimation: () =>
      order.push("waiting-animation"),
  };
  const controllerSource = sourceFile("../src/game/gameController.ts");
  const controller =
    /** @type {{get(uid: string): Pick<Presentation, "emojiId" | "aura"> | null; refresh(): void; restore(): void; rematch(): void}} */ (
      compile(
        `
    let isOnlineGame = ${online};
    let isGameWithBot = ${bot};
    let isWatchOnly = false;
    let isWaitingForRematchResponse = false;
    let isReconnect = false;
    let didConnect = true;
    let puzzleMode = false;
    let isGameOver = true;
    let boardViewMode = "historicalView";
    let boardViewDebugLogsEnabled = false;
    let flashbackMode = true;
    let currentInputs = [];
    ${functions(controllerSource, ["publishGameControlsContext", "getDisplayedMatchPresentation", "refreshDisplayedMatchPresentation", "enterWaitingLiveView", "restoreLiveBoardView", "prepareLiveBoardView", "clearBoardViewInputs", "didConfirmRematchProposal"])}
  `,
        {
          batchGameControlsUpdates,
          getCurrentSessionId: () => 1,
          isGameConnectionBound: () => false,
          updateGameControlsContext: (
            /** @type {Partial<import("../src/game/gameControlsModel.ts").GameControlsContext>} */ context,
          ) => contexts.push(context),
          rematchViewing: createRematchViewingHarness({
            selection: {
              matchId: "old-match",
              pair: {
                matchId: "old-match",
                hostPlayerId: "signed-in-login",
                guestPlayerId: null,
                guestMatch: null,
                hostMatch: canonicalMatch({
                  emojiId: online ? 1 : 0,
                  aura: "none",
                }),
              },
              game: new Game(),
            },
          }),
          matchTimers: createMatchTimerHarness({
            activeMatchId: null,
            isOnlineGame: online,
          }).controller,
          selectedProblem: null,
          Board: board,
          connection: {
            getActiveMatchId: () => (active ? "current-match" : null),
            getMatchPresentation: (
              /** @type {string} */ _matchId,
              /** @type {string} */ uid,
            ) =>
              uid === player.uid ? { emojiId: 1001, aura: "rainbow" } : null,
            setWagerViewMatchId: noop,
            sendRematchProposal: () => {
              order.push("send-rematch");
              requests.push({
                emojiId: board.getPlayersEmojiId(),
                aura: "rainbow",
              });
            },
          },
          nextBoardRenderSession: noop,
          activeBoardShouldBeFlipped: () => false,
          applyBoardUiForCurrentView: () =>
            board.runMonsBoardAsDisplayWaitingAnimation(),
          triggerMoveHistoryPopupReload: noop,
          setEndMatchVisible: noop,
          setNewBoard: noop,
          applyWagerState: noop,
          markKnownWagerInitialStateReceived: noop,
          updateUndoButtonBasedOnGameState: noop,
        },
        "({ get: getDisplayedMatchPresentation, refresh: refreshDisplayedMatchPresentation, restore: restoreLiveBoardView, rematch: didConfirmRematchProposal })",
      )
    );
  const boardSource = sourceFile("../src/game/board.ts");
  Object.assign(
    board,
    /** @type {Pick<BoardContract, "updateEmojiAndAuraIfNeeded" | "getPlayersEmojiId">} */ (
      compile(
        functions(boardSource, [
          "syncAvatarForCurrentMetadata",
          "updateEmojiAndAuraIfNeeded",
          "getPlayersEmojiId",
        ]),
        {
          playerSideMetadata: player,
          opponentSideMetadata: opponent,
          gameInputRuntime: {
            isWatchOnly: false,
            getDisplayedMatchPresentation: controller.get,
          },
          storage: { getPlayerEmojiAura: () => "rainbow" },
          slotIsOpponentForMetadataSide: (/** @type {boolean} */ side) => side,
          playerAvatar: null,
          opponentAvatar: null,
          playerAvatarPlaceholder: null,
          opponentAvatarPlaceholder: null,
        },
        "({ updateEmojiAndAuraIfNeeded, getPlayersEmojiId })",
      )
    ),
  );
  return { controller, player, requests, order, contexts };
}

test("local and bot synthetic history preserve the signed-in avatar through history and live restoration", () => {
  for (const bot of [false, true]) {
    const h = historyAppearanceHarness({ online: false, active: false, bot });
    h.controller.refresh();
    assert.equal(h.controller.get(h.player.uid), null);
    assert.deepEqual(h.player, {
      uid: "signed-in-login",
      emojiId: 1001,
      aura: "rainbow",
    });
    h.controller.restore();
    assert.equal(required(h.contexts.at(-1)).boardViewMode, "activeLive");
    assert.equal(required(h.contexts.at(-1)).isGameWithBot, bot);
    assert.deepEqual(h.player, {
      uid: "signed-in-login",
      emojiId: 1001,
      aura: "rainbow",
    });
    assert.deepEqual(h.requests, []);
  }
});

test("proposing a rematch from online history restores current appearance before reading request seeds", () => {
  const h = historyAppearanceHarness();
  h.controller.refresh();
  assert.deepEqual(h.player, {
    uid: "signed-in-login",
    emojiId: 1,
    aura: "none",
  });
  h.controller.rematch();
  assert.equal(required(h.contexts.at(-1)).boardViewMode, "waitingLive");
  assert.deepEqual(h.requests, [{ emojiId: 1001, aura: "rainbow" }]);
  assert.deepEqual(h.player, {
    uid: "signed-in-login",
    emojiId: 1001,
    aura: "rainbow",
  });
  assert.ok(
    h.order.indexOf("waiting-animation") < h.order.indexOf("send-rematch"),
  );
});

test("pending online hosts still resolve live appearance before the gameplay online flag is set", () => {
  const h = historyAppearanceHarness({ online: false, active: true });
  h.controller.restore();
  assert.deepEqual(h.controller.get(h.player.uid), {
    emojiId: 1001,
    aura: "rainbow",
  });
});
