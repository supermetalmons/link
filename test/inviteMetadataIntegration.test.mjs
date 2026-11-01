import { required, canonicalMatch } from "./fixtures/canonicalData.mjs";
import { createWagerClientHarness } from "./wagerClientHarness.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";
import ts from "typescript";
import {
  InviteMetadataState,
  rematchSeriesEqual,
} from "../src/connection/inviteMetadataState.ts";
import { withAutomatchOperationLock } from "../src/connection/automatchOperationLock.ts";
import {
  MoveDelivery,
  moveDeliveryStorageKey,
} from "../src/connection/moveDelivery.ts";
import {
  RematchEndDelivery,
  rematchEndDeliveryStorageKey,
  REMATCH_END_STORAGE_PREFIX,
} from "../src/connection/rematchEndDelivery.ts";
import { isAutoInviteId } from "../cloud/runtime/shared/ids.js";
import {
  parseRematchIndices,
  rematchSeriesEnded,
  selectInviteMatch,
} from "../cloud/runtime/shared/rematches.js";

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

const { batchGameControlsUpdates } =
  await import("../src/game/gameControlsStore.ts");
const { GameBootstrapApiError } =
  await import("../src/services/gameBootstrapApi.ts");

/** @typedef {typeof import("../src/connection/connection.ts").connection} ConnectionContract */
/**
 * @typedef {object} ExtractedConnection
 * @property {ConnectionContract["activateContext"]} activateContext
 * @property {ConnectionContract["activeContext"]} activeContext
 * @property {ConnectionContract["applyInviteMetadata"]} applyInviteMetadata
 * @property {ConnectionContract["approvedRematchIndices"]} approvedRematchIndices
 * @property {ConnectionContract["auth"]} auth
 * @property {ConnectionContract["authUnsubscribers"]} authUnsubscribers
 * @property {ConnectionContract["beginConnectAttempt"]} beginConnectAttempt
 * @property {ConnectionContract["buildRuntimeContext"]} buildRuntimeContext
 * @property {ConnectionContract["bumpSessionEpoch"]} bumpSessionEpoch
 * @property {ConnectionContract["cleanupInviteMetadataObserver"]} cleanupInviteMetadataObserver
 * @property {ConnectionContract["cleanupInviteReactionObserver"]} cleanupInviteReactionObserver
 * @property {ConnectionContract["cleanupObserverContext"]} cleanupObserverContext
 * @property {ConnectionContract["clearActiveContext"]} clearActiveContext
 * @property {ConnectionContract["clearAllObserverContexts"]} clearAllObserverContexts
 * @property {ConnectionContract["clearPendingAutomatchRequest"]} clearPendingAutomatchRequest
 * @property {ConnectionContract["confirmRematchEndFromMetadata"]} confirmRematchEndFromMetadata
 * @property {ConnectionContract["confirmedSurrenders"]} confirmedSurrenders
 * @property {ConnectionContract["connectAttemptId"]} connectAttemptId
 * @property {ConnectionContract["connectToGame"]} connectToGame
 * @property {ConnectionContract["createMatchContextGuard"]} createMatchContextGuard
 * @property {ConnectionContract["currentUid"]} currentUid
 * @property {ConnectionContract["detachFromMatchSession"]} detachFromMatchSession
 * @property {ConnectionContract["detachMatchSession"]} detachMatchSession
 * @property {ConnectionContract["ensureAuthenticated"]} ensureAuthenticated
 * @property {ConnectionContract["eventClient"]} eventClient
 * @property {ConnectionContract["fetchInviteWithPendingCreation"]} fetchInviteWithPendingCreation
 * @property {ConnectionContract["flushPendingMoves"]} flushPendingMoves
 * @property {ConnectionContract["getCachedHistoricalMatchPair"]} getCachedHistoricalMatchPair
 * @property {ConnectionContract["getLatestBothSidesApprovedRematchIndex"]} getLatestBothSidesApprovedRematchIndex
 * @property {ConnectionContract["getLatestBothSidesApprovedRematchIndexForInvite"]} getLatestBothSidesApprovedRematchIndexForInvite
 * @property {ConnectionContract["getLatestMatchIdForActor"]} getLatestMatchIdForActor
 * @property {ConnectionContract["getMoveDelivery"]} getMoveDelivery
 * @property {ConnectionContract["getRematchEndDelivery"]} getRematchEndDelivery
 * @property {ConnectionContract["getRematchIndexAvailableForNewProposal"]} getRematchIndexAvailableForNewProposal
 * @property {ConnectionContract["getUserBoundAuthTokenProvider"]} getUserBoundAuthTokenProvider
 * @property {ConnectionContract["hasPendingInviteCreationFor"]} hasPendingInviteCreationFor
 * @property {ConnectionContract["inviteMetadataState"]} inviteMetadataState
 * @property {ConnectionContract["inviteReactionSubscription"]} inviteReactionSubscription
 * @property {ConnectionContract["isConnectAttemptActive"]} isConnectAttemptActive
 * @property {ConnectionContract["isContextActive"]} isContextActive
 * @property {ConnectionContract["isCurrentAuthUser"]} isCurrentAuthUser
 * @property {ConnectionContract["isCurrentMoveBoard"]} isCurrentMoveBoard
 * @property {ConnectionContract["isRematchEndPending"]} isRematchEndPending
 * @property {ConnectionContract["isSessionEpochActive"]} isSessionEpochActive
 * @property {ConnectionContract["latestInvite"]} latestInvite
 * @property {ConnectionContract["logContextEvent"]} logContextEvent
 * @property {ConnectionContract["matchPresentations"]} matchPresentations
 * @property {ConnectionContract["maybeRefreshContextAfterRematchMetadata"]} maybeRefreshContextAfterRematchMetadata
 * @property {ConnectionContract["moveDeliveries"]} moveDeliveries
 * @property {ConnectionContract["moveDeliveryScope"]} moveDeliveryScope
 * @property {ConnectionContract["moveReconnectCooldownMs"]} moveReconnectCooldownMs
 * @property {ConnectionContract["moveReconnectInFlight"]} moveReconnectInFlight
 * @property {ConnectionContract["moveReconnectLastAttemptAt"]} moveReconnectLastAttemptAt
 * @property {ConnectionContract["moveRecoveryTimers"]} moveRecoveryTimers
 * @property {ConnectionContract["myMatch"]} myMatch
 * @property {ConnectionContract["nextContextId"]} nextContextId
 * @property {ConnectionContract["notifyNavigationGamesChanged"]} notifyNavigationGamesChanged
 * @property {ConnectionContract["observeInviteMetadata"]} observeInviteMetadata
 * @property {ConnectionContract["observeInviteReactions"]} observeInviteReactions
 * @property {ConnectionContract["observeMatch"]} observeMatch
 * @property {ConnectionContract["observedMatchSnapshots"]} observedMatchSnapshots
 * @property {ConnectionContract["observerRegistry"]} observerRegistry
 * @property {ConnectionContract["pendingInviteCreation"]} pendingInviteCreation
 * @property {ConnectionContract["reconcilePendingAutomatchRequest"]} reconcilePendingAutomatchRequest
 * @property {ConnectionContract["reconcilingMoveKeys"]} reconcilingMoveKeys
 * @property {ConnectionContract["reconnectAfterMatchUpdateFailure"]} reconnectAfterMatchUpdateFailure
 * @property {ConnectionContract["recoverMoveBoard"]} recoverMoveBoard
 * @property {ConnectionContract["refreshMoveDeliveries"]} refreshMoveDeliveries
 * @property {ConnectionContract["refreshRematchEndDeliveries"]} refreshRematchEndDeliveries
 * @property {ConnectionContract["registerObserverCleanup"]} registerObserverCleanup
 * @property {ConnectionContract["rematchEndDeliveries"]} rematchEndDeliveries
 * @property {ConnectionContract["rematchSeriesEndIsIndicated"]} rematchSeriesEndIsIndicated
 * @property {ConnectionContract["rematchSeriesEndIsIndicatedForInvite"]} rematchSeriesEndIsIndicatedForInvite
 * @property {ConnectionContract["requireWritableContext"]} requireWritableContext
 * @property {ConnectionContract["sameProfilePlayerUid"]} sameProfilePlayerUid
 * @property {ConnectionContract["sendEndMatchIndicator"]} sendEndMatchIndicator
 * @property {ConnectionContract["sendRematchProposal"]} sendRematchProposal
 * @property {ConnectionContract["sessionEpoch"]} sessionEpoch
 * @property {ConnectionContract["setSameProfilePlayerUid"]} setSameProfilePlayerUid
 * @property {ConnectionContract["setWagerViewMatchId"]} setWagerViewMatchId
 * @property {ConnectionContract["signIn"]} signIn
 * @property {ConnectionContract["stopObservingAllMatches"]} stopObservingAllMatches
 * @property {ConnectionContract["submitRematchEnd"]} submitRematchEnd
 * @property {ConnectionContract["subscribeToAuthChanges"]} subscribeToAuthChanges
 * @property {ConnectionContract["surrender"]} surrender
 * @property {ConnectionContract["tryNavigateWatchOnlyToLatestApprovedMatch"]} tryNavigateWatchOnlyToLatestApprovedMatch
 * @property {ConnectionContract["unregisterObserverCleanup"]} unregisterObserverCleanup
 * @property {ConnectionContract["wagerClient"]} wagerClient
 * @property {ConnectionContract["waitForInitialAuthState"]} waitForInitialAuthState
 * @property {ConnectionContract["waitForPendingInviteCreation"]} waitForPendingInviteCreation
 */

/**
 * @typedef {import("../src/session/sessionAuth.ts").SessionUser} SessionUser
 * @typedef {import("@mons/shared/invite-metadata").InviteMetadataSnapshot} Metadata
 * @typedef {import("@mons/shared/invite-metadata").InviteMetadataViewer} Viewer
 * @typedef {import("@mons/shared/invite-metadata").ReadInviteMetadataResponse} MetadataResponse
 * @typedef {typeof import("../src/services/gameplayApi.ts")} GameplayApi
 * @typedef {import("@mons/shared/game-sessions").GameSessionMatch} MatchRecord
 * @typedef {import("@mons/shared/invite-wagers").InviteWagersSnapshot} WagerSnapshot
 * @typedef {import("@mons/shared/invite-wagers").ReadInviteWagersResponse} WagerResponse
 * @typedef {import("../src/connection/connectionModels.ts").MatchWagerState} WagerState
 * @typedef {import("../src/connection/wagerClient.ts").WagerClient} WagerClientContract
 * @typedef {ConstructorParameters<typeof import("../src/connection/inviteMetadataChannel.ts").InviteMetadataChannel>[0]} MetadataChannelOptions
 * @typedef {ConstructorParameters<typeof import("../src/connection/inviteWagersChannel.ts").InviteWagersChannel>[0]} WagerChannelOptions
 * @typedef {Pick<ConnectionContract["auth"], "getTokenRemainingMs" | "onAuthStateChanged" | "authStateReady" | "signInAnonymously"> & { currentUser: SessionUser | null }} FixtureAuth
 * @typedef {Pick<MoveDelivery, "scope" | "reconcile" | "resume" | "suspend" | "pause" | "flush"> & { confirmationVersion: number, hasPendingMoves: boolean }} FixtureMoveDelivery
 * @typedef {Omit<ExtractedConnection, "auth" | "getMoveDelivery" | "moveDeliveries" | "eventClient" | "observerRegistry" | "inviteReactionSubscription" | "moveReconnectCooldownMs"> & { moveReconnectCooldownMs: number, auth: FixtureAuth, getMoveDelivery(scope: Parameters<ConnectionContract["getMoveDelivery"]>[0], match: Parameters<ConnectionContract["getMoveDelivery"]>[1]): FixtureMoveDelivery, moveDeliveries: Map<string, FixtureMoveDelivery>, eventClient: Pick<ConnectionContract["eventClient"], "reset">, observerRegistry: Pick<ConnectionContract["observerRegistry"], "register" | "unregister" | "cleanupContext" | "clear">, inviteReactionSubscription: { channel: Pick<NonNullable<ConnectionContract["inviteReactionSubscription"]>["channel"], "refresh">, stop(): void } | null, miningFrozenPoller: NonNullable<WagerClientContract["miningFrozenPoller"]>, matchRefs: Record<string, never>, logWagerDebug(...values: unknown[]): void, refreshTokenIfNeeded(): Promise<number> }} FixtureConnection
 * @typedef {{ initial?: MetadataResponse, loginUid?: string, wagers?: WagerSnapshot["wagers"], read?: (attempt: number, signal: AbortSignal | undefined) => MetadataResponse | Promise<MetadataResponse>, join?: (...args: Parameters<GameplayApi["joinInviteViaApi"]>) => Partial<Awaited<ReturnType<GameplayApi["joinInviteViaApi"]>>> | Promise<Partial<Awaited<ReturnType<GameplayApi["joinInviteViaApi"]>>>>, propose?: (...args: Parameters<GameplayApi["proposeRematchViaApi"]>) => Awaited<ReturnType<GameplayApi["proposeRematchViaApi"]>> | ReturnType<GameplayApi["proposeRematchViaApi"]>, end?: (...args: Parameters<GameplayApi["endRematchViaApi"]>) => Awaited<ReturnType<GameplayApi["endRematchViaApi"]>> | ReturnType<GameplayApi["endRematchViaApi"]>, onMetadata?: (instance: FixtureConnection) => void, onRecover?: (instance: FixtureConnection) => void, readWagers?: (attempt: number, signal: AbortSignal | undefined) => WagerResponse | Promise<WagerResponse>, readMatch?: (attempt: number, input: Parameters<GameplayApi["readMatchSnapshotViaApi"]>[0], options: Parameters<GameplayApi["readMatchSnapshotViaApi"]>[1]) => MatchRecord | null | Promise<MatchRecord | null>, takeBootstrap?: typeof import("../src/services/initialGameBootstrap.ts").takeInitialGameBootstrap, ensureMatch?: (...args: Parameters<GameplayApi["ensureMatchViaApi"]>) => Partial<Awaited<ReturnType<GameplayApi["ensureMatchViaApi"]>>> | Promise<Partial<Awaited<ReturnType<GameplayApi["ensureMatchViaApi"]>>>>, surrender?: (request: Parameters<GameplayApi["surrenderMatchViaApi"]>[0]) => Partial<Awaited<ReturnType<GameplayApi["surrenderMatchViaApi"]>>> | Promise<Partial<Awaited<ReturnType<GameplayApi["surrenderMatchViaApi"]>>>>, records?: Map<string, string> }} FixtureOptions
 */
/** @param {Pick<SessionUser, "uid"> & Partial<Omit<SessionUser, "uid">>} value @returns {SessionUser} */
const sessionUser = (value) => ({
  sessionId: "fixture-session",
  generation: "fixture-generation",
  getIdToken: async () => "token",
  ...value,
});

/**
 * @typedef {{ wagers: WagerClientContract["wagers"], inviteWagersSnapshot: WagerClientContract["inviteWagersSnapshot"], pendingWagerMutations: WagerClientContract["pendingWagerMutations"], miningFrozenPoller: WagerClientContract["miningFrozenPoller"], runWagerMutation: WagerClientContract["runWagerMutation"], beginWagerSnapshotMutation: WagerClientContract["beginWagerSnapshotMutation"], restoreOptimisticWagerResolution: WagerClientContract["restoreOptimisticWagerResolution"], setLocalWagerState: WagerClientContract["setLocalWagerState"] }} WagerProbe
 */
/** @param {WagerClientContract} client @returns {WagerProbe} */
function probeWager(client) {
  return {
    get wagers() {
      return Reflect.get(client, "wagers");
    },
    get inviteWagersSnapshot() {
      return Reflect.get(client, "inviteWagersSnapshot");
    },
    get pendingWagerMutations() {
      return Reflect.get(client, "pendingWagerMutations");
    },
    get miningFrozenPoller() {
      return Reflect.get(client, "miningFrozenPoller");
    },
    set miningFrozenPoller(value) {
      Reflect.set(client, "miningFrozenPoller", value);
    },
    runWagerMutation: Reflect.get(client, "runWagerMutation").bind(client),
    beginWagerSnapshotMutation: Reflect.get(
      client,
      "beginWagerSnapshotMutation",
    ).bind(client),
    restoreOptimisticWagerResolution: Reflect.get(
      client,
      "restoreOptimisticWagerResolution",
    ).bind(client),
    setLocalWagerState: Reflect.get(client, "setLocalWagerState").bind(client),
  };
}
/** @param {Partial<import("@mons/shared/invite-wagers").PublicMatchWagerState>} [patch] @returns {import("@mons/shared/invite-wagers").PublicMatchWagerState} */
const wagerRecord = (patch = {}) => ({
  schemaVersion: 1,
  state: "proposed",
  proposals: {},
  proposedBy: {},
  agreed: null,
  resolved: null,
  blocked: null,
  ...patch,
});

/** @param {unknown[] | string | undefined} entry @returns {Error} */
function loggedError(entry) {
  assert.ok(Array.isArray(entry) && entry[1] instanceof Error);
  return entry[1];
}

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
  "detachMatchSession",
  "fetchInviteWithPendingCreation",
  "connectToGame",
  "applyInviteMetadata",
  "observeInviteMetadata",
  "setWagerViewMatchId",
  "cleanupInviteMetadataObserver",
  "cleanupInviteReactionObserver",
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
  "getRematchEndDelivery",
  "isRematchEndPending",
  "refreshRematchEndDeliveries",
  "submitRematchEnd",
  "confirmRematchEndFromMetadata",
  "rematchSeriesEndIsIndicated",
  "subscribeToAuthChanges",
  "signIn",
  "waitForInitialAuthState",
  "surrender",
  "moveDeliveryScope",
  "isCurrentMoveBoard",
  "recoverMoveBoard",
];
const methods = names.map((name) => {
  const method = required(declaration).members.find(
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
const controllerSource = ts.createSourceFile(
  "gameController.ts",
  readFileSync(
    new URL("../src/game/gameController.ts", import.meta.url),
    "utf8",
  ),
  ts.ScriptTarget.Latest,
  true,
);
const endMatchHandler = controllerSource.statements.find(
  (node) =>
    ts.isFunctionDeclaration(node) &&
    node.name?.text === "didClickEndMatchButton",
);
assert.ok(endMatchHandler && ts.isFunctionDeclaration(endMatchHandler));
const { outputText: endMatchHandlerOutput } = ts.transpileModule(
  required(endMatchHandler)
    .getText(controllerSource)
    .replace(/^export /, ""),
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
);

/** @param {ReturnType<typeof harness>} h */
function clickEndMatch(h) {
  const dependencies = {
    batchGameControlsUpdates,
    connection: h.instance,
    isReconnect: false,
    didConnect: true,
    isWaitingForRematchResponse: true,
    boardViewMode: "waitingLive",
    pendingRematchNavigationToLiveBoard: false,
    PrimaryActionType: { None: "none" },
    showPrimaryAction: () => h.events.ui.push("hide-primary"),
    setEndMatchConfirmed: () => {
      assert.ok(h.instance.rematchSeriesEndIsIndicated());
      h.events.ui.push("optimistic-ended");
    },
    showWaitingStateText: () => {},
    Board: { stopMonsBoardAsDisplayAnimations: () => {} },
    navigateFromWaitingLiveToLastCompletedMatch: () =>
      h.events.ui.push("return-to-completed"),
    triggerMoveHistoryPopupReload: () => {},
  };
  return new Function(
    ...Object.keys(dependencies),
    `${endMatchHandlerOutput}\nreturn didClickEndMatchButton();`,
  )(...Object.values(dependencies));
}

/** @param {Partial<Metadata>} [overrides] @returns {Metadata} */
const snapshot = (overrides = {}) => ({
  inviteId: "invite",
  revision: 1,
  hostId: "host",
  guestId: "guest",
  hostColor: "white",
  hostRematches: { state: "open", indices: [] },
  guestRematches: { state: "open", indices: [] },
  automatchStateHint: null,
  eventId: null,
  eventOwned: false,
  ...overrides,
});
/** @param {Metadata} [value] @param {Partial<Viewer>} [viewer] @returns {MetadataResponse} */
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
const match = canonicalMatch({
  version: 1,
  color: "white",
  emojiId: 1,
  fen: "fen",
  gameVariant: "Classic",
});
const settle = () => new Promise((resolve) => setImmediate(resolve));
/** @template [T=void] @returns {PromiseWithResolvers<T>} */
const deferred = () => Promise.withResolvers();

/** @param {FixtureOptions} [options] */
function harness({
  initial = response(),
  loginUid = "login",
  wagers = { invite: wagerRecord() },
  read,
  join,
  propose,
  end,
  onMetadata,
  onRecover,
  readWagers,
  readMatch,
  takeBootstrap = () => null,
  ensureMatch,
  surrender,
  records = new Map(),
} = {}) {
  class InviteMetadataChannel {
    /** @param {MetadataChannelOptions} dependencies */
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
    /** @param {Metadata} value @param {Viewer} [viewer] */
    emit(value, viewer) {
      this.dependencies.onSnapshot(value, viewer);
    }
  }
  class InviteWagersChannel {
    /** @param {WagerChannelOptions} dependencies */
    constructor(dependencies) {
      this.dependencies = dependencies;
      this.controller = new AbortController();
      this.signal = this.controller.signal;
      this.stops = 0;
      this.refreshes = 0;
      events.wagerChannels.push(this);
      const generation = required(dependencies.captureGeneration)();
      queueMicrotask(() => {
        void dependencies.readWagers(this.signal).then(
          (response) => {
            if (!this.signal.aborted)
              this.emit(response.snapshot, "http", generation);
          },
          (error) => {
            if (!this.signal.aborted) dependencies.onError(error);
          },
        );
      });
    }
    stop() {
      this.stops++;
      this.controller.abort();
    }
    requestRefresh() {
      this.refreshes++;
    }
    /** @param {WagerSnapshot} value @param {import("../src/connection/snapshotChannel.ts").SnapshotDelivery["source"]} [source] @param {number} [generation] */
    emit(
      value,
      source = "socket",
      generation = required(this.dependencies.captureGeneration)(),
    ) {
      this.dependencies.onSnapshot(value, {
        source,
        requestGeneration: generation,
      });
    }
  }
  /** @type {{ reads: { inviteId: string, provider: import("../src/services/authApi.ts").AuthTokenProvider | undefined, signal: AbortSignal | undefined }[], legacyReads: string[], matchReads: (Parameters<GameplayApi["readMatchSnapshotViaApi"]>[0] & NonNullable<Parameters<GameplayApi["readMatchSnapshotViaApi"]>[1]>)[], bootstrapReads: ({ inviteId: string } & NonNullable<Parameters<typeof import("../src/services/gameBootstrapApi.ts").readGameBootstrapViaApi>[2]>)[], ensuredMatches: Parameters<GameplayApi["ensureMatchViaApi"]>[0][], recoveredMatches: MatchRecord[], surrenders: Parameters<GameplayApi["surrenderMatchViaApi"]>[0][], auth: string[], home: Parameters<typeof import("../src/session/sessionTransitionPort.ts").transitionToHome>[0][], ui: string[], observed: [string, string][], channels: InviteMetadataChannel[], metadata: [Metadata["hostRematches"], Metadata["guestRematches"]][], errors: (unknown[] | string)[], wagering: WagerClientContract["wagers"][], wagerReads: { inviteId: string, provider: import("../src/services/authApi.ts").AuthTokenProvider | undefined, signal: AbortSignal | undefined }[], wagerChannels: InviteWagersChannel[], wagerStates: { matchId: string | null, state: WagerState | null }[], frozenRefreshes: number }} */
  const events = {
    reads: [],
    legacyReads: [],
    matchReads: [],
    bootstrapReads: [],
    ensuredMatches: [],
    recoveredMatches: [],
    surrenders: [],
    auth: [],
    home: [],
    ui: [],
    observed: [],
    channels: [],
    metadata: [],
    errors: [],
    wagering: [],
    wagerReads: [],
    wagerChannels: [],
    wagerStates: [],
    frozenRefreshes: 0,
  };
  /** @type {Map<string, () => void>} */
  const cleanups = new Map();
  /** @type {Map<string, number>} */
  const counters = new Map();
  /** @type {Map<string, import("../src/utils/storage.ts").PendingAutomatchOperation>} */
  const operations = new Map();
  /** @type {FixtureConnection} */
  let instance;
  /** @type {Parameters<FixtureAuth["onAuthStateChanged"]>[0] | undefined} */
  let authCallback;
  let currentResponse = initial;
  /** @type {WagerState | null} */
  let publishedWagerState = null;
  const noop = () => undefined;
  const dependencies = {
    navigator: { onLine: true },
    RematchEndDelivery,
    rematchEndDeliveryStorageKey,
    REMATCH_END_STORAGE_PREFIX,
    window: {
      sessionStorage: /** @satisfies {Storage} */ ({
        clear: () => records.clear(),
        getItem: (key) => records.get(key) ?? null,
        setItem: (key, value) => records.set(key, value),
        removeItem: (key) => records.delete(key),
        key: (/** @type {number} */ index) =>
          [...records.keys()][index] ?? null,
        get length() {
          return records.size;
        },
      }),
    },
    moveDeliveryStorageKey,
    InviteMetadataState,
    rematchSeriesEqual,
    selectInviteMatch,
    takeInitialGameBootstrap: takeBootstrap,
    GameBootstrapApiError,
    withAutomatchOperationLock,
    isAutoInviteId,
    /** @type {(value: WagerState | null) => WagerState | null} */
    summarizeWagerState: (value) => value,
    parseRematchIndices,
    rematchSeriesEnded,
    storage: {
      /** @type {typeof import("../src/utils/storage.ts").storage.getPendingAutomatchOperation} */
      getPendingAutomatchOperation: (uid) => operations.get(uid) ?? null,
      /** @type {typeof import("../src/utils/storage.ts").storage.setPendingAutomatchOperation} */
      setPendingAutomatchOperation: (uid, value) => {
        if (value) operations.set(uid, value);
        else operations.delete(uid);
      },
      /** @type {typeof import("../src/utils/storage.ts").storage.getPlayerEmojiAura} */
      getPlayerEmojiAura: () => "none",
    },
    InviteMetadataChannel,
    InviteWagersChannel,
    /** @type {typeof import("../src/services/inviteWagersApi.ts").createInviteWagersSocketProtocols} */
    createInviteWagersSocketProtocols: (token) => [
      "mons-invite-wagers-v1",
      `bearer.${token}`,
    ],
    /** @type {typeof import("../src/services/inviteWagersApi.ts").readInviteWagersViaApi} */
    readInviteWagersViaApi: async (inviteId, provider, options) => {
      events.wagerReads.push({ inviteId, provider, signal: options?.signal });
      return readWagers
        ? readWagers(events.wagerReads.length, options?.signal)
        : { ok: true, snapshot: { inviteId, revision: 1, wagers } };
    },
    /** @type {typeof import("../src/services/inviteMetadataApi.ts").readInviteMetadataViaApi} */
    readInviteMetadataViaApi: async (inviteId, provider, options) => {
      events.reads.push({ inviteId, provider, signal: options?.signal });
      return read
        ? read(events.reads.length, options?.signal)
        : currentResponse;
    },
    /** @type {typeof import("../src/services/gameBootstrapApi.ts").readGameBootstrapViaApi} */
    readGameBootstrapViaApi: async (inviteId, provider, options) => {
      events.bootstrapReads.push({ inviteId, ...options });
      const metadata = await dependencies.readInviteMetadataViaApi(
        inviteId,
        provider,
        options,
      );
      required(required(provider).assertCurrentUser)();
      const selected = selectInviteMatch(
        inviteId,
        metadata.snapshot,
        metadata.viewer.actorUid,
        {
          preferApproved: required(options).selection === "approved",
        },
      );
      /** @type {MatchRecord | null} */
      let actorMatch = match;
      if (metadata.viewer.actorUid) {
        const input = {
          playerId: metadata.viewer.actorUid,
          matchId: selected.matchId,
        };
        events.matchReads.push({ ...input, ...options });
        actorMatch = readMatch
          ? await readMatch(events.matchReads.length, input, options)
          : match;
      }
      return {
        ok: true,
        schemaVersion: 1,
        metadata: metadata.snapshot,
        viewer: metadata.viewer,
        hasPendingProposal: selected.hasPendingProposal,
        match: {
          inviteId,
          matchId: selected.matchId,
          revision: metadata.snapshot.revision,
          hostPlayerId: metadata.snapshot.hostId,
          guestPlayerId: metadata.snapshot.guestId,
          hostMatch:
            metadata.viewer.actorUid === metadata.snapshot.hostId
              ? actorMatch
              : match,
          guestMatch: metadata.snapshot.guestId
            ? metadata.viewer.actorUid === metadata.snapshot.guestId
              ? actorMatch
              : { ...match, color: "black" }
            : null,
        },
      };
    },
    /** @type {typeof import("../src/services/inviteMetadataApi.ts").createInviteMetadataSocketProtocols} */
    createInviteMetadataSocketProtocols: (token) => [
      "mons-invite-metadata-v1",
      `bearer.${token}`,
    ],
    /** @type {GameplayApi["joinInviteViaApi"]} */
    joinInviteViaApi: async (...args) => {
      events.ui.push("join-request");
      return {
        ok: true,
        inviteId: args[0].inviteId,
        guestId: "guest",
        joined: true,
        matchId: args[0].inviteId,
        ...(join ? await join(...args) : {}),
      };
    },
    /** @type {GameplayApi["proposeRematchViaApi"]} */
    proposeRematchViaApi: async (...args) =>
      propose
        ? propose(...args)
        : {
            ok: true,
            inviteId: "invite",
            actorUid: "host",
            matchId: "invite1",
            rematches: { state: "open", indices: [1] },
            match,
          },
    /** @type {GameplayApi["endRematchViaApi"]} */
    endRematchViaApi: async (...args) =>
      end
        ? end(...args)
        : {
            ok: true,
            inviteId: "invite",
            actorUid: "host",
            rematches: { state: "ended", indices: [] },
          },
    /** @type {GameplayApi["surrenderMatchViaApi"]} */
    surrenderMatchViaApi: async (request, provider) => {
      required(required(provider).assertCurrentUser)();
      events.surrenders.push(request);
      return {
        ok: true,
        inviteId: request.inviteId,
        matchId: request.matchId,
        actorUid: initial.viewer.actorUid ?? "host",
        ...(surrender ? await surrender(request) : {}),
      };
    },
    /** @type {(database: unknown, path: string) => string} */
    ref: (_db, path) => path,
    /** @type {(path: string) => Promise<never>} */
    get: async (path) => {
      events.legacyReads.push(path);
      assert.fail(`unexpected legacy read: ${path}`);
    },
    /** @type {GameplayApi["readMatchSnapshotViaApi"]} */
    readMatchSnapshotViaApi: async (input, options = {}) => {
      events.matchReads.push({ ...input, ...options });
      return {
        ok: true,
        ...input,
        match: readMatch
          ? await readMatch(events.matchReads.length, input, options)
          : match,
      };
    },
    /** @type {GameplayApi["ensureMatchViaApi"]} */
    ensureMatchViaApi: async (input, provider) => {
      events.ensuredMatches.push(input);
      return {
        ok: true,
        inviteId: input.inviteId,
        matchId: input.matchId,
        actorUid: initial.viewer.actorUid ?? "host",
        created: true,
        match,
        ...(ensureMatch ? await ensureMatch(input, provider) : {}),
      };
    },
    off: noop,
    getPlayersEmojiId: () => 1,
    /** @type {typeof import("../src/session/sessionTransitionPort.ts").transitionToHome} */
    transitionToHome: async (options) => {
      events.home.push(options);
      instance.detachFromMatchSession();
    },
    /** @type {(notFound: boolean) => void} */
    didFailToLoadGame: (notFound) => {
      events.ui.push(notFound ? "not-found" : "load-failed");
    },
    didReceiveInitialWagers: () => events.ui.push("wagers-known"),
    didFailToLoadPendingInvite: () => events.ui.push("pending-failed"),
    didFindInviteThatCanBeJoined: () => events.ui.push("join-button"),
    enterWatchOnlyMode: () => events.ui.push("watch"),
    /** @type {typeof import("../src/game/gameController.ts").didRecoverMyMatch} */
    didRecoverMyMatch: (value) => {
      events.ui.push("recover");
      events.recoveredMatches.push({ ...value });
      onRecover?.(instance);
    },
    didDiscoverExistingRematchProposalWaitingForResponse: () =>
      events.ui.push("pending-rematch"),
    didFindYourOwnInviteThatNobodyJoined: () => events.ui.push("waiting"),
    didUpdateRematchSeriesMetadata: () => {
      events.metadata.push([
        required(instance.latestInvite).hostRematches,
        required(instance.latestInvite).guestRematches,
      ]);
      onMetadata?.(instance);
    },
    didReceiveRematchesSeriesEndIndicator: () => events.ui.push("ended"),
    didJustCreateRematchProposalSuccessfully: () =>
      events.ui.push("proposal-created"),
    failedToCreateRematchProposal: () => events.ui.push("proposal-failed"),
    setCurrentWagerMatch: () => {
      publishedWagerState = null;
    },
    getWagerState: () => publishedWagerState,
    /** @type {typeof import("../src/game/wagerState.ts").setWagerState} */
    setWagerState: (matchId, state) => {
      publishedWagerState = state;
      events.wagerStates.push({ matchId, state });
    },
    /** @type {typeof import("../src/game/wagerState.ts").syncCurrentWagerMatchState} */
    syncCurrentWagerMatchState: (matchId, state) => {
      publishedWagerState = state;
      events.wagerStates.push({ matchId, state });
      events.wagering.push(probeWager(instance.wagerClient).wagers);
    },
    isWagerClientUpdateRequired: () => false,
    /** @type {(key: string) => void} */
    incrementLifecycleCounter: (key) => {
      counters.set(key, (counters.get(key) ?? 0) + 1);
    },
    /** @type {(key: string, count?: number) => void} */
    decrementLifecycleCounter: (key, count = 1) => {
      counters.set(key, (counters.get(key) ?? 0) - count);
    },
    console: /** @satisfies {Pick<Console, "log" | "warn" | "error">} */ ({
      log: noop,
      warn: noop,
      error: (...args) => events.errors.push(args),
    }),
  };
  const Constructor = /** @type {new () => FixtureConnection} */ (
    new Function(
      ...Object.keys(dependencies),
      `${outputText}\nreturn Connection;`,
    )(...Object.values(dependencies))
  );
  instance = Object.assign(
    new Constructor(),
    /** @satisfies {Partial<FixtureConnection>} */ ({
      auth: {
        currentUser: sessionUser({ uid: loginUid }),
        authStateReady: async () => {},
        signInAnonymously: async () => {},
        getTokenRemainingMs: () => 300_000,
        onAuthStateChanged: (callback) => {
          authCallback = callback;
          return noop;
        },
      },
      currentUid: loginUid,
      authUnsubscribers: new Set(),
      sessionEpoch: 1,
      connectAttemptId: 0,
      nextContextId: 1,
      activeContext: null,
      rematchEndDeliveries: new Map(),
      moveDeliveries: new Map(),
      reconcilingMoveKeys: new Set(),
      confirmedSurrenders: new Set(),
      moveRecoveryTimers: new Map(),
      moveReconnectCooldownMs: 0,
      moveReconnectLastAttemptAt: 0,
      moveReconnectInFlight: false,
      reconnectAfterMatchUpdateFailure: noop,
      getMoveDelivery: (scope, match) => {
        const delivery = {
          scope,
          confirmationVersion: 0,
          reconcile: () => match,
          resume: noop,
          suspend: noop,
          pause: noop,
          flush: async () => {},
          hasPendingMoves: false,
        };
        instance.moveDeliveries.set(moveDeliveryStorageKey(scope), delivery);
        return delivery;
      },
      flushPendingMoves: async () => {},
      refreshMoveDeliveries: noop,
      matchRefs: {},
      observedMatchSnapshots: new Map(),
      matchPresentations: new Map(),
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
      setSameProfilePlayerUid: (uid) => {
        instance.sameProfilePlayerUid = uid;
      },
      ensureAuthenticated: async () => {},
      miningFrozenPoller: {
        stop: noop,
        refresh: () => {
          events.frozenRefreshes++;
        },
        runMutation: async (action) => action(),
      },
      eventClient: { reset: noop },
      logWagerDebug: noop,
      observeInviteReactions: noop,
      observeMatch: (uid, matchId) => events.observed.push([uid, matchId]),
      refreshTokenIfNeeded: async () => events.ui.push("refresh-claims"),
      getRematchIndexAvailableForNewProposal: () => "1",
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
    }),
  );
  const wagerHarness = createWagerClientHarness({
    auth: instance.auth,
    getActiveContext: () => instance.activeContext,
    getSessionEpoch: () => instance.sessionEpoch,
    getSameProfilePlayerUid: () => instance.sameProfilePlayerUid,
    requireWritableContext: (...args) =>
      instance.requireWritableContext(...args),
    ensureAuthenticated: () => instance.ensureAuthenticated(),
    getUserBoundAuthTokenProvider: (uid) =>
      instance.getUserBoundAuthTokenProvider(uid),
    createMatchContextGuard: (...args) =>
      instance.createMatchContextGuard(...args),
    isContextActive: (...args) => instance.isContextActive(...args),
    isCurrentAuthUser: (uid) => instance.isCurrentAuthUser(uid),
    isSessionEpochActive: (epoch) => instance.isSessionEpochActive(epoch),
    registerObserverCleanup: (...args) =>
      instance.registerObserverCleanup(...args),
    unregisterObserverCleanup: (...args) =>
      instance.unregisterObserverCleanup(...args),
    changeObserverCount: (delta) =>
      delta === 1
        ? dependencies.incrementLifecycleCounter("connectionObservers")
        : dependencies.decrementLifecycleCounter("connectionObservers"),
    wagerStore: {
      getWagerState: dependencies.getWagerState,
      setWagerState: dependencies.setWagerState,
      setCurrentWagerMatch: dependencies.setCurrentWagerMatch,
      syncCurrentWagerMatchState: dependencies.syncCurrentWagerMatchState,
    },
    onInitialWagers: dependencies.didReceiveInitialWagers,
    createWagerChannel: (options) =>
      new dependencies.InviteWagersChannel(options),
  });
  wagerHarness.dependencies.api.readInviteWagersViaApi =
    dependencies.readInviteWagersViaApi;
  instance.wagerClient = wagerHarness.client;
  probeWager(instance.wagerClient).miningFrozenPoller =
    instance.miningFrozenPoller;
  return {
    instance,
    records,
    pauseEnds: () => {
      for (const item of instance.rematchEndDeliveries.values()) item.pause();
    },
    events,
    counters,
    operations,
    cleanups,
    setResponse: (/** @type {MetadataResponse} */ value) => {
      currentResponse = value;
    },
    async connect(autojoin = false) {
      instance.connectToGame(loginUid, initial.snapshot.inviteId, autojoin);
      await settle();
      assert.deepEqual(events.errors, []);
    },
    channel: () => events.channels.at(-1),
    wagerChannel: () => events.wagerChannels.at(-1),
    authChange: (
      /** @type {(Pick<SessionUser, "uid"> & Partial<Omit<SessionUser, "uid">>) | null} */ user,
    ) => {
      instance.auth.currentUser = user === null ? null : sessionUser(user);
      required(authCallback)(instance.auth.currentUser);
    },
  };
}

/** @param {{ synchronousUser?: (Pick<SessionUser, "uid"> & Partial<Omit<SessionUser, "uid">>) | null }} [options] */
function signInHarness({ synchronousUser = null } = {}) {
  const h = harness();
  const creation = deferred();
  /** @type {Set<Parameters<FixtureAuth["onAuthStateChanged"]>[0]>} */
  const listeners = new Set();
  let creates = 0;
  let unsubscribes = 0;
  h.instance.auth = {
    currentUser: null,
    getTokenRemainingMs: () => 300_000,
    authStateReady: async () => {},
    onAuthStateChanged(listener) {
      listeners.add(listener);
      if (synchronousUser)
        h.instance.auth.currentUser = sessionUser(synchronousUser);
      listener(h.instance.auth.currentUser);
      return () => {
        unsubscribes++;
        listeners.delete(listener);
      };
    },
    signInAnonymously() {
      creates++;
      return creation.promise;
    },
  };
  return {
    ...h,
    creation,
    listeners,
    creates: () => creates,
    unsubscribes: () => unsubscribes,
    /** @param {Pick<SessionUser, "uid"> & Partial<Omit<SessionUser, "uid">>} user */
    publish(user) {
      h.instance.auth.currentUser = sessionUser(user);
      for (const listener of listeners) listener(h.instance.auth.currentUser);
    },
  };
}

test("sign-in waiters return a published replacement while anonymous creation is still pending", async () => {
  for (const lateFailure of [false, true]) {
    const h = signInHarness();
    /** @type {string | undefined} */
    let result = "pending";
    const signingIn = h.instance.signIn().then((uid) => {
      result = uid;
      return uid;
    });
    try {
      await settle();
      assert.equal(h.creates(), 1);
      assert.equal(h.listeners.size, 1);
      assert.equal(result, "pending");
      h.publish({ uid: "replacement" });
      await settle();
      assert.equal(result, "replacement");
      assert.equal(await signingIn, "replacement");
      assert.equal(h.listeners.size, 0);
      assert.equal(h.unsubscribes(), 1);
      if (lateFailure)
        required(h.creation.reject)(new Error("old-anonymous-create-failed"));
      else required(h.creation.resolve)();
      await settle();
      assert.equal(result, "replacement");
      assert.deepEqual(h.events.errors, []);
    } finally {
      required(h.creation.resolve)();
      await signingIn;
    }
  }
});

test("a failed anonymous creation without a published user releases the sign-in listener", async () => {
  const h = signInHarness();
  const signingIn = h.instance.signIn();
  await settle();
  assert.equal(h.listeners.size, 1);
  required(h.creation.reject)(new Error("anonymous-create-unavailable"));
  assert.equal(await signingIn, undefined);
  assert.equal(h.listeners.size, 0);
  assert.equal(h.unsubscribes(), 1);
  assert.equal(h.events.errors.length, 1);
  assert.match(
    loggedError(h.events.errors[0]).message,
    /anonymous-create-unavailable/,
  );
});

test("a synchronous auth notification also releases the sign-in listener", async () => {
  const h = signInHarness({ synchronousUser: { uid: "replacement" } });
  /** @type {string | undefined} */
  let result = "pending";
  const signingIn = h.instance.signIn().then((uid) => {
    result = uid;
    return uid;
  });
  try {
    await settle();
    assert.equal(result, "replacement");
    assert.equal(h.listeners.size, 0);
    assert.equal(h.unsubscribes(), 1);
    required(h.creation.resolve)();
    assert.equal(await signingIn, "replacement");
    assert.deepEqual(h.events.errors, []);
  } finally {
    required(h.creation.resolve)();
    await signingIn;
  }
});

test("game bootstrap preserves linked-login actors and recovers before independent wagers", async () => {
  const wagers = {
    invite: wagerRecord({
      state: "agreed",
      agreed: {
        material: "dust",
        count: 3,
        total: 6,
        proposerId: "host",
        accepterId: "guest",
        acceptedAt: 1,
      },
    }),
  };
  const h = harness({ wagers });
  await h.connect();
  assert.deepEqual(
    h.events.matchReads.map(({ playerId, matchId }) => ({ playerId, matchId })),
    [{ playerId: "host", matchId: "invite" }],
  );
  assert.ok(required(h.events.matchReads[0]).signal instanceof AbortSignal);
  assert.deepEqual(h.events.legacyReads, []);
  assert.equal(h.events.wagerReads.length, 1);
  assert.equal(required(h.instance.activeContext).loginUid, "login");
  assert.equal(required(h.instance.activeContext).actorUid, "host");
  assert.equal(h.events.wagering[0], null);
  assert.deepEqual(probeWager(h.instance.wagerClient).wagers, wagers);
  assert.equal(h.events.bootstrapReads.length, 1);
  assert.ok(
    h.events.ui.indexOf("recover") < h.events.ui.indexOf("wagers-known"),
  );
  assert.equal(h.events.ui.includes("refresh-claims"), false);
  required(h.channel()).emit(
    snapshot({ revision: 2, hostRematches: { state: "open", indices: [1] } }),
  );
  assert.deepEqual(probeWager(h.instance.wagerClient).wagers, wagers);
  h.instance.detachFromMatchSession();
});

test("prefetched bootstrap is reused only while no matching move recovery has started", async () => {
  const metadata = response();
  /** @type {import("@mons/shared/game-bootstrap").ReadGameBootstrapResponse} */
  const prefetched = {
    ok: true,
    schemaVersion: 1,
    metadata: metadata.snapshot,
    viewer: metadata.viewer,
    hasPendingProposal: false,
    match: {
      inviteId: "invite",
      matchId: "invite",
      revision: 1,
      hostPlayerId: "host",
      guestPlayerId: "guest",
      hostMatch: match,
      guestMatch: { ...match, color: "black" },
    },
  };
  for (const recoveryTiming of ["none", "before-adoption", "during-adoption"]) {
    /** @type {PromiseWithResolvers<import("@mons/shared/game-bootstrap").ReadGameBootstrapResponse>} */
    const pending = deferred();
    let adoptions = 0;
    const confirmed = {
      ...match,
      fen: "confirmed-fen",
      flatMovesString: "move1",
    };
    const h = harness({
      takeBootstrap: () => {
        adoptions++;
        return { promise: pending.promise, abort: () => {} };
      },
      readMatch: () => confirmed,
    });
    const recoverMove = async () => {
      const scope = {
        loginUid: "login",
        inviteId: "invite",
        matchId: "invite",
        playerId: "host",
      };
      const delivery = new MoveDelivery(scope, match, {
        storage: {
          getItem: () => null,
          setItem: () => {},
          removeItem: () => {},
        },
        isAuthorized: () => true,
        isOnline: () => true,
        submit: async () => ({
          ok: true,
          inviteId: scope.inviteId,
          matchId: scope.matchId,
          actorUid: scope.playerId,
          outcome: "applied",
        }),
        read: async () => confirmed,
        onError: (error) => h.events.errors.push(error.message),
        onRemoteAdvance: () => {},
      });
      delivery.enqueue("move1", "confirmed-fen");
      await delivery.flush();
      assert.equal(delivery.confirmationVersion, 1);
      h.instance.moveDeliveries.set(moveDeliveryStorageKey(scope), delivery);
      h.instance.getMoveDelivery = () => required(delivery);
    };
    if (recoveryTiming === "before-adoption") {
      required(pending.resolve)(prefetched);
      await recoverMove();
    }
    h.instance.connectToGame("login", "invite", false);
    await settle();
    if (recoveryTiming === "during-adoption") await recoverMove();
    required(pending.resolve)(prefetched);
    await settle();
    assert.deepEqual(h.events.errors, [], recoveryTiming);
    assert.equal(h.instance.activeContext?.actorUid, "host", recoveryTiming);
    assert.equal(
      required(h.instance.myMatch).fen,
      recoveryTiming === "none" ? match.fen : confirmed.fen,
    );
    assert.equal(
      h.events.bootstrapReads.length,
      recoveryTiming === "none" ? 0 : 1,
    );
    assert.equal(adoptions, 1);
    h.instance.detachFromMatchSession();
  }
});

test("selection drift after adopting the initial request refetches once with the current choice", async () => {
  for (const original of ["current", "approved"]) {
    /** @type {PromiseWithResolvers<import("@mons/shared/game-bootstrap").ReadGameBootstrapResponse>} */
    const pending = deferred();
    let pendingEnd = original === "approved";
    let adoptions = 0;
    const h = harness({
      initial: response(
        snapshot({ hostRematches: { state: "open", indices: [1] } }),
      ),
      takeBootstrap: () => {
        adoptions++;
        return { promise: pending.promise, abort: () => {} };
      },
    });
    h.instance.isRematchEndPending = () => pendingEnd;
    h.instance.connectToGame("login", "invite", false);
    await settle();
    pendingEnd = !pendingEnd;
    required(pending.reject)(
      new GameBootstrapApiError("initial-game-bootstrap-selection-changed"),
    );
    await settle();
    assert.deepEqual(h.events.errors, []);
    assert.equal(adoptions, 1);
    assert.equal(h.events.bootstrapReads.length, 1);
    assert.equal(
      required(h.events.bootstrapReads[0]).selection,
      pendingEnd ? "approved" : "current",
    );
    assert.equal(
      required(h.instance.activeContext).matchId,
      pendingEnd ? "invite" : "invite1",
    );
    h.instance.detachFromMatchSession();
  }
});

test("explicit adopted game failures do not trigger selection recovery reads", async () => {
  for (const status of [404, 429]) {
    /** @type {PromiseWithResolvers<import("@mons/shared/game-bootstrap").ReadGameBootstrapResponse>} */
    const pending = deferred();
    const h = harness({
      takeBootstrap: () => ({ promise: pending.promise, abort: () => {} }),
    });
    h.instance.connectToGame("login", "invite", false);
    required(pending.reject)(
      new GameBootstrapApiError(`http-${status}`, status),
    );
    await settle();
    assert.equal(h.events.bootstrapReads.length, 0);
    assert.equal(h.instance.activeContext, null);
    assert.ok(
      h.events.ui.includes(status === 404 ? "not-found" : "load-failed"),
    );
  }
});

test("a selection change from a canceled initial attempt cannot read or install a game", async () => {
  /** @type {PromiseWithResolvers<import("@mons/shared/game-bootstrap").ReadGameBootstrapResponse>} */
  const pending = deferred();
  const h = harness({
    takeBootstrap: () => ({ promise: pending.promise, abort: () => {} }),
  });
  h.instance.connectToGame("login", "invite", false);
  h.instance.detachFromMatchSession();
  required(pending.reject)(
    new GameBootstrapApiError("initial-game-bootstrap-selection-changed"),
  );
  await settle();
  assert.deepEqual(h.events.errors, []);
  assert.equal(h.events.bootstrapReads.length, 0);
  assert.equal(h.events.observed.length, 0);
  assert.equal(h.instance.activeContext, null);
});

test("a loaded game remains available while wagers are unknown and rejects wager writes", async () => {
  /** @type {PromiseWithResolvers<import("@mons/shared/invite-wagers").ReadInviteWagersResponse>} */
  const pending = deferred();
  const h = harness({ readWagers: () => pending.promise });
  await h.connect();
  assert.equal(required(h.instance.activeContext).actorUid, "host");
  assert.equal(probeWager(h.instance.wagerClient).inviteWagersSnapshot, null);
  assert.ok(h.events.ui.includes("recover"));
  assert.ok(!h.events.ui.includes("wagers-known"));
  const result = await probeWager(h.instance.wagerClient).runWagerMutation(
    async () => assert.fail("wager write ran before its snapshot"),
    true,
  );
  assert.deepEqual(result, { ok: false });
  required(pending.resolve)({ ok: true, snapshot: wagerSnapshot(1) });
  await settle();
  assert.ok(h.events.ui.includes("wagers-known"));
  assert.deepEqual(probeWager(h.instance.wagerClient).wagers, {});
  h.instance.detachFromMatchSession();
});

test("bootstrap reconciliation captures the delivery revision before an in-flight acknowledgment", async () => {
  /** @type {PromiseWithResolvers<import("@mons/shared/game-sessions").GameSessionMatch | null>} */
  const pending = deferred();
  const h = harness({
    readMatch: (/** @type {number} */ attempt) =>
      attempt === 1 ? match : pending.promise,
  });
  await h.connect();
  const delivery = [...h.instance.moveDeliveries.values()][0];
  required(delivery).confirmationVersion = 4;
  let captured;
  required(delivery).reconcile = (_remote, revision) => {
    captured = revision;
    return { fen: "confirmed-newer", flatMovesString: "confirmed-move" };
  };
  h.instance.getMoveDelivery = () => required(delivery);
  h.instance.connectToGame("login", "invite", false);
  await settle();
  required(delivery).confirmationVersion = 5;
  required(pending.resolve)(match);
  await settle();
  assert.deepEqual(h.events.errors, []);
  assert.equal(captured, 4);
  assert.equal(required(h.instance.myMatch).fen, "confirmed-newer");
  h.instance.detachFromMatchSession();
});

test("a bootstrap cannot activate after replacing the auth object with the same login UID", async () => {
  /** @type {PromiseWithResolvers<import("@mons/shared/game-sessions").GameSessionMatch | null>} */
  const pending = deferred();
  const h = harness({ readMatch: () => pending.promise });
  h.instance.connectToGame("login", "invite", false);
  await settle();
  h.instance.auth.currentUser = { ...required(h.instance.auth.currentUser) };
  required(pending.resolve)(match);
  await settle();
  assert.equal(h.instance.activeContext, null);
  assert.deepEqual(h.events.recoveredMatches, []);
  assert.deepEqual(h.events.observed, []);
  assert.deepEqual(h.events.errors, []);
  h.instance.detachFromMatchSession();
});

test("a canceled bootstrap cannot resume a replacement attempt's suspended move delivery", async () => {
  /** @type {PromiseWithResolvers<import("@mons/shared/game-sessions").GameSessionMatch | null>} */
  const first = deferred();
  /** @type {PromiseWithResolvers<import("@mons/shared/game-sessions").GameSessionMatch | null>} */
  const second = deferred();
  const h = harness({
    readMatch: (/** @type {number} */ attempt) =>
      attempt === 1 ? match : attempt === 2 ? first.promise : second.promise,
  });
  await h.connect();
  const delivery = [...h.instance.moveDeliveries.values()][0];
  let suspended = false;
  let resumes = 0;
  required(delivery).suspend = () => {
    suspended = true;
  };
  required(delivery).resume = () => {
    suspended = false;
    resumes++;
  };
  h.instance.getMoveDelivery = () => required(delivery);
  h.instance.connectToGame("login", "invite", false);
  await settle();
  assert.equal(suspended, true);
  h.instance.connectToGame("login", "invite", false);
  await settle();
  assert.equal(resumes, 1);
  required(first.resolve)(match);
  await settle();
  assert.equal(suspended, true);
  assert.equal(resumes, 1);
  required(second.resolve)(match);
  await settle();
  assert.deepEqual(h.events.errors, []);
  assert.equal(suspended, false);
  assert.equal(resumes, 2);
  h.instance.detachFromMatchSession();
});

test("a reconnect triggered during hydration retains the replacement delivery suspension", async () => {
  /** @type {PromiseWithResolvers<import("@mons/shared/game-sessions").GameSessionMatch | null>} */
  const pending = deferred();
  let reconnectOnHydration = false;
  const h = harness({
    readMatch: (/** @type {number} */ attempt) =>
      attempt < 3 ? match : pending.promise,
    onRecover: (connection) => {
      if (!reconnectOnHydration) return;
      reconnectOnHydration = false;
      connection.connectToGame("login", "invite", false);
    },
  });
  await h.connect();
  const delivery = [...h.instance.moveDeliveries.values()][0];
  let suspended = false;
  let resumes = 0;
  required(delivery).suspend = () => {
    suspended = true;
  };
  required(delivery).resume = () => {
    suspended = false;
    resumes++;
  };
  h.instance.getMoveDelivery = () => required(delivery);
  reconnectOnHydration = true;
  const previousUiCount = h.events.ui.length;
  const previousObserverCount = h.events.observed.length;
  h.instance.connectToGame("login", "invite", false);
  await settle();
  assert.equal(h.events.matchReads.length, 3);
  assert.equal(suspended, true);
  assert.equal(resumes, 1);
  assert.deepEqual(h.events.ui.slice(previousUiCount), ["recover"]);
  assert.equal(h.events.observed.length, previousObserverCount);
  required(pending.resolve)(match);
  await settle();
  assert.deepEqual(h.events.errors, []);
  assert.equal(suspended, false);
  assert.equal(resumes, 2);
  assert.equal(h.events.observed.length, previousObserverCount + 1);
  h.instance.detachFromMatchSession();
});

test("newer accepted rematch metadata forces a fresh matching bootstrap before hydration", async () => {
  /** @type {PromiseWithResolvers<import("@mons/shared/invite-metadata").ReadInviteMetadataResponse>} */
  const pending = deferred();
  const next = response(
    snapshot({
      revision: 3,
      hostRematches: { state: "open", indices: [1] },
      guestRematches: { state: "open", indices: [1] },
    }),
  );
  const h = harness({
    read: (/** @type {number} */ attempt) =>
      attempt === 1 ? response() : attempt === 2 ? pending.promise : next,
  });
  await h.connect();
  h.instance.connectToGame("login", "invite", false);
  await settle();
  required(h.instance.inviteMetadataState).confirmRematches("host", {
    state: "open",
    indices: [1],
  });
  required(h.instance.inviteMetadataState).confirmRematches("guest", {
    state: "open",
    indices: [1],
  });
  required(pending.resolve)(response());
  await settle();
  assert.deepEqual(h.events.errors, []);
  assert.equal(h.events.bootstrapReads.length, 3);
  assert.equal(required(h.instance.activeContext).matchId, "invite1");
  assert.equal(h.events.recoveredMatches.length, 2);
  h.instance.detachFromMatchSession();
});

test("reconnect ensures a participant match only after a successful missing Worker snapshot", async () => {
  const ensuredMatch = { ...match, fen: "ensured-fen" };
  const h = harness({
    readMatch: (/** @type {number} */ attempt) =>
      attempt === 1 ? match : attempt === 2 ? null : ensuredMatch,
    ensureMatch: async () => ({ ok: true, match: ensuredMatch }),
  });
  await h.connect();
  const previousContext = h.instance.activeContext;
  h.instance.connectToGame("login", "invite", false);
  await settle();
  assert.deepEqual(h.events.errors, []);
  assert.equal(h.events.matchReads.length, 3);
  assert.equal(h.events.ensuredMatches.length, 1);
  assert.equal(required(h.events.ensuredMatches[0]).inviteId, "invite");
  assert.equal(required(h.events.ensuredMatches[0]).matchId, "invite");
  assert.notEqual(h.instance.activeContext, previousContext);
  assert.equal(required(h.instance.activeContext).actorUid, "host");
  assert.deepEqual(h.instance.myMatch, ensuredMatch);
  assert.equal(h.events.ui.filter((value) => value === "recover").length, 2);
  assert.deepEqual(h.events.legacyReads, []);
  h.instance.detachFromMatchSession();
});

test("a failed Worker snapshot during reconnect preserves the session without ensuring or reading legacy storage", async () => {
  const h = harness({
    readMatch: (/** @type {number} */ attempt) => {
      if (attempt > 1) throw new Error("snapshot-unavailable");
      return match;
    },
  });
  await h.connect();
  const previousContext = h.instance.activeContext;
  const previousChannel = h.channel();
  h.instance.connectToGame("login", "invite", false);
  await settle();
  assert.equal(h.events.errors.length, 1);
  assert.equal(required(h.events.errors[0])[0], "Failed to connect to invite:");
  assert.equal(loggedError(h.events.errors[0]).message, "snapshot-unavailable");
  assert.equal(h.events.matchReads.length, 2);
  assert.deepEqual(h.events.ensuredMatches, []);
  assert.equal(h.instance.activeContext, previousContext);
  assert.equal(h.channel(), previousChannel);
  assert.deepEqual(h.instance.myMatch, match);
  assert.equal(h.events.ui.filter((value) => value === "recover").length, 1);
  assert.deepEqual(h.events.legacyReads, []);
  h.instance.detachFromMatchSession();
});

for (const invalidation of ["account replacement", "navigation"]) {
  test(`a missing reconnect snapshot after ${invalidation} cannot ensure or restore the old match`, async () => {
    /** @type {PromiseWithResolvers<import("@mons/shared/game-sessions").GameSessionMatch | null>} */
    const pending = deferred();
    const h = harness({
      readMatch: (/** @type {number} */ attempt) =>
        attempt === 1 ? match : pending.promise,
    });
    await h.connect();
    const unsubscribe = h.instance.subscribeToAuthChanges(() => {});
    h.instance.connectToGame("login", "invite", false);
    await settle();
    assert.equal(h.events.matchReads.length, 2);
    const { signal } = required(h.events.matchReads[1]);
    assert.equal(required(signal).aborted, false);
    if (invalidation === "account replacement") {
      h.authChange({ uid: "replacement" });
    } else {
      h.instance.detachFromMatchSession();
    }
    const contextAfterInvalidation = h.instance.activeContext;
    assert.equal(required(signal).aborted, true);
    required(pending.resolve)(null);
    await settle();
    assert.deepEqual(h.events.errors, []);
    assert.deepEqual(h.events.ensuredMatches, []);
    assert.equal(h.instance.activeContext, contextAfterInvalidation);
    assert.equal(h.events.ui.filter((value) => value === "recover").length, 1);
    assert.deepEqual(h.events.legacyReads, []);
    unsubscribe();
    h.instance.detachFromMatchSession();
  });
}

test("private automatch denial joins before metadata retry and never reads the old invite root", async () => {
  const paired = response(snapshot({ inviteId: "auto_invite" }), {
    actorUid: "guest",
    role: "guest",
  });
  const h = harness({
    initial: paired,
    read: (/** @type {number} */ attempt) => {
      if (attempt === 1) throw new GameBootstrapApiError("http-403", 403);
      return paired;
    },
  });
  await h.connect(true);
  assert.equal(h.events.reads.length, 2);
  assert.deepEqual(
    h.events.ui.filter((value) => value === "join-request"),
    ["join-request"],
  );
  assert.equal(required(h.instance.activeContext).actorUid, "guest");
  h.instance.detachFromMatchSession();
});

test("pending invite creation waits after missing metadata and reads the created invite", async () => {
  const h = harness({
    read: (/** @type {number} */ attempt) => {
      if (attempt === 1) throw new GameBootstrapApiError("http-404", 404);
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
  /** @type {PromiseWithResolvers<import("@mons/shared/invite-metadata").ReadInviteMetadataResponse>} */
  const pending = deferred();
  const h = harness({ read: () => pending.promise });
  h.instance.connectToGame("login", "invite", false);
  h.instance.auth.currentUser = sessionUser({ uid: "replacement" });
  required(pending.resolve)(response());
  await settle();
  assert.equal(h.instance.activeContext, null);
  assert.equal(h.events.matchReads.length, 0);
  assert.equal(h.events.legacyReads.length, 0);
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
    read: (/** @type {number} */ attempt) => (attempt === 1 ? pending : paired),
    join: () => {
      throw new Error("request-timeout");
    },
  });
  await h.connect(true);
  assert.equal(required(h.instance.activeContext).role, "guest");
  assert.deepEqual(
    h.events.matchReads.map(({ playerId, matchId }) => ({ playerId, matchId })),
    [{ playerId: "guest", matchId: "invite" }],
  );
  assert.deepEqual(h.events.legacyReads, []);
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
  required(h.channel()).emit(snapshot({ revision: 2 }));
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
  /** @type {Parameters<FixtureConnection["connectToGame"]>[]} */
  const reconnects = [];
  h.instance.connectToGame = (...args) => reconnects.push(args);
  required(h.channel()).emit(snapshot({ revision: 2 }));
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
    uid: "login",
    createdAtMs: 1,
    request: { emojiId: 1, aura: "none" },
  });
  required(h.channel()).emit(snapshot(), {
    role: "host",
    actorUid: "host",
    automatchOperationId: "private-operation",
  });
  await settle();
  assert.equal(h.operations.has("login"), false);
  assert.equal(
    "automatchOperationId" in required(h.instance.latestInvite),
    false,
  );
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
  required(old).emit(
    snapshot({
      revision: 2,
      hostRematches: { state: "open", indices: [1] },
      guestRematches: { state: "open", indices: [1] },
    }),
  );
  assert.deepEqual(h.events.metadata, [
    [
      { state: "open", indices: [1] },
      { state: "open", indices: [1] },
    ],
  ]);
  assert.equal(required(h.instance.activeContext).matchId, "invite1");
  assert.equal(required(old).stops, 1);
  assert.equal(staleRefreshes, 0);
  required(old).emit(
    snapshot({
      revision: 3,
      hostRematches: { state: "open", indices: [1, 2] },
      guestRematches: { state: "open", indices: [1, 2] },
    }),
  );
  assert.equal(required(h.instance.activeContext).matchId, "invite1");
  assert.equal(h.events.metadata.length, 1);
  h.instance.detachFromMatchSession();
});

test("an unchanged first snapshot still reconciles rematch UI once for its new context", async () => {
  const value = snapshot({
    hostRematches: { state: "open", indices: [1] },
    guestRematches: { state: "open", indices: [1] },
  });
  const h = harness({ initial: response(value) });
  await h.connect();
  required(h.channel()).emit(value);
  required(h.channel()).emit(value);
  assert.deepEqual(h.events.metadata, [
    [
      { state: "open", indices: [1] },
      { state: "open", indices: [1] },
    ],
  ]);
  h.instance.detachFromMatchSession();
});

test("a pending local proposal defers context rotation and preserves a committed response against stale metadata", async () => {
  /** @type {PromiseWithResolvers<import("@mons/shared/game-sessions").ProposeRematchResponse>} */
  const pending = deferred();
  const h = harness({ propose: () => pending.promise });
  await h.connect();
  const previous = h.instance.activeContext;
  h.instance.sendRematchProposal();
  required(h.channel()).emit(
    snapshot({
      revision: 2,
      hostRematches: { state: "open", indices: [1] },
      guestRematches: { state: "open", indices: [1] },
    }),
  );
  assert.strictEqual(h.instance.activeContext, previous);
  required(pending.resolve)({
    ok: true,
    inviteId: "invite",
    actorUid: "host",
    matchId: "invite1",
    rematches: { state: "open", indices: [1] },
    match,
  });
  await settle();
  assert.equal(required(h.instance.activeContext).matchId, "invite1");
  required(h.channel()).emit(snapshot({ revision: 2 }));
  assert.deepEqual(required(h.instance.latestInvite).hostRematches, {
    state: "open",
    indices: [1],
  });
  assert.deepEqual(required(h.instance.latestInvite).guestRematches, {
    state: "open",
    indices: [1],
  });
  assert.ok(h.events.ui.includes("proposal-created"));
  h.instance.detachFromMatchSession();
});

test("end intent is durable before optimistic Finished and survives busy rejection and reload", async () => {
  /** @type {PromiseWithResolvers<import("@mons/shared/game-sessions").EndRematchResponse>} */
  const pending = deferred();
  const records = new Map();
  let originalRequest;
  const h = harness({
    records,
    end: (request) => {
      originalRequest = request;
      return pending.promise;
    },
  });
  await h.connect();
  assert.equal(clickEndMatch(h), true);
  assert.ok(h.events.ui.includes("optimistic-ended"));
  assert.deepEqual(required(h.instance.latestInvite).hostRematches, {
    state: "open",
    indices: [],
  });
  assert.equal(h.instance.rematchSeriesEndIsIndicated(), true);
  assert.equal(records.size, 1);
  await settle();
  required(pending.reject)(
    Object.assign(new Error("invite-busy"), { code: "aborted" }),
  );
  await settle();
  assert.equal(records.size, 1);
  assert.equal(h.instance.rematchSeriesEndIsIndicated(), true);
  required(h.channel()).emit(snapshot({ revision: 2 }));
  assert.equal(records.size, 1);
  h.pauseEnds();
  h.instance.detachFromMatchSession();

  /** @type {PromiseWithResolvers<import("@mons/shared/game-sessions").EndRematchResponse>} */
  const resumed = deferred();
  let resumedRequest;
  const reloaded = harness({
    records,
    end: (request) => {
      resumedRequest = request;
      return resumed.promise;
    },
  });
  await reloaded.connect();
  assert.ok(reloaded.events.ui.includes("ended"));
  assert.equal(reloaded.instance.rematchSeriesEndIsIndicated(), true);
  await settle();
  assert.deepEqual(resumedRequest, originalRequest);
  required(resumed.resolve)({
    ok: true,
    inviteId: "invite",
    actorUid: "host",
    rematches: { state: "ended", indices: [] },
  });
  await settle();
  assert.equal(records.size, 0);
  assert.deepEqual(required(reloaded.instance.latestInvite).hostRematches, {
    state: "ended",
    indices: [],
  });
  reloaded.instance.detachFromMatchSession();
});

test("an end still finishes optimistically and saves when browser storage is full", async () => {
  const records = new Map();
  records.set = () => {
    throw new Error("storage-full");
  };
  /** @type {PromiseWithResolvers<import("@mons/shared/game-sessions").EndRematchResponse>} */
  const pending = deferred();
  /** @type {{ value?: Parameters<GameplayApi["endRematchViaApi"]>[0] }} */
  const request = {};
  const h = harness({
    records,
    end: (value) => {
      request.value = value;
      return pending.promise;
    },
  });
  await h.connect();
  assert.equal(clickEndMatch(h), true);
  assert.ok(h.events.ui.includes("optimistic-ended"));
  assert.equal(h.instance.rematchSeriesEndIsIndicated(), true);
  await settle();
  assert.equal(required(request.value).inviteId, "invite");
  required(pending.resolve)({
    ok: true,
    inviteId: "invite",
    actorUid: "host",
    rematches: { state: "ended", indices: [] },
  });
  await settle();
  assert.deepEqual(required(h.instance.latestInvite).hostRematches, {
    state: "ended",
    indices: [],
  });
  assert.equal(
    h.instance.getRematchEndDelivery("login", "invite").pending,
    null,
  );
  assert.equal(records.size, 0);
  h.instance.detachFromMatchSession();
});

test("a late failure cannot undo authoritative end confirmation or restore its journal", async () => {
  /** @type {PromiseWithResolvers<import("@mons/shared/game-sessions").EndRematchResponse>} */
  const pending = deferred();
  const h = harness({ end: () => pending.promise });
  await h.connect();
  assert.equal(clickEndMatch(h), true);
  await settle();
  required(h.channel()).emit(
    snapshot({ revision: 2, guestRematches: { state: "ended", indices: [] } }),
  );
  assert.equal(h.records.size, 0);
  required(pending.reject)(new Error("network-error"));
  await settle();
  assert.equal(h.records.size, 0);
  assert.deepEqual(required(h.instance.latestInvite).guestRematches, {
    state: "ended",
    indices: [],
  });
  h.instance.detachFromMatchSession();
});

test("a successful end updates the current context after same-invite reconnect", async () => {
  /** @type {PromiseWithResolvers<import("@mons/shared/game-sessions").EndRematchResponse>} */
  const pending = deferred();
  const h = harness({ end: () => pending.promise });
  await h.connect();
  clickEndMatch(h);
  await settle();
  const originalChannel = h.channel();
  await h.connect();
  required(pending.resolve)({
    ok: true,
    inviteId: "invite",
    actorUid: "host",
    rematches: { state: "ended", indices: [] },
  });
  await settle();
  assert.deepEqual(required(h.instance.latestInvite).hostRematches, {
    state: "ended",
    indices: [],
  });
  assert.equal(h.records.size, 0);
  assert.equal(required(originalChannel).refreshes, 0);
  assert.ok(required(h.channel()).refreshes >= 1);
  h.instance.detachFromMatchSession();
});

test("accepted end survives navigation without finishing the replacement invite", async () => {
  /** @type {PromiseWithResolvers<import("@mons/shared/game-sessions").EndRematchResponse>} */
  const pending = deferred();
  const h = harness({ end: () => pending.promise });
  await h.connect();
  clickEndMatch(h);
  await settle();
  h.setResponse(response(snapshot({ inviteId: "other" })));
  h.instance.connectToGame("login", "other", false);
  await settle();
  required(pending.resolve)({
    ok: true,
    inviteId: "invite",
    actorUid: "host",
    rematches: { state: "ended", indices: [] },
  });
  await settle();
  assert.deepEqual(required(h.instance.latestInvite).hostRematches, {
    state: "open",
    indices: [],
  });
  assert.equal(h.records.size, 0);
  assert.equal(required(h.channel()).refreshes, 0);
  h.instance.detachFromMatchSession();
});

test("auth replacement retains the original pending end without changing the new account's invite", async () => {
  /** @type {PromiseWithResolvers<import("@mons/shared/game-sessions").EndRematchResponse>} */
  const pending = deferred();
  const h = harness({ end: () => pending.promise });
  await h.connect();
  clickEndMatch(h);
  await settle();
  h.instance.auth.currentUser = sessionUser({ uid: "replacement" });
  required(pending.resolve)({
    ok: true,
    inviteId: "invite",
    actorUid: "host",
    rematches: { state: "ended", indices: [] },
  });
  await settle();
  assert.deepEqual(required(h.instance.latestInvite).hostRematches, {
    state: "open",
    indices: [],
  });
  assert.equal(h.instance.rematchSeriesEndIsIndicated(), false);
  assert.equal(h.records.size, 1);
  h.pauseEnds();
  h.instance.detachFromMatchSession();
});

for (const rejected of [false, true]) {
  test(`a late ${rejected ? "failed" : "successful"} rematch proposal cannot reopen an optimistically ended series`, async () => {
    /** @type {PromiseWithResolvers<import("@mons/shared/game-sessions").ProposeRematchResponse>} */
    const proposal = deferred();
    /** @type {PromiseWithResolvers<import("@mons/shared/game-sessions").EndRematchResponse>} */
    const ending = deferred();
    const h = harness({
      propose: () => proposal.promise,
      end: () => ending.promise,
    });
    await h.connect();
    const context = h.instance.activeContext;
    h.instance.sendRematchProposal();
    assert.equal(clickEndMatch(h), true);
    await settle();
    if (rejected) required(proposal.reject)(new Error("proposal-unavailable"));
    else
      required(proposal.resolve)({
        ok: true,
        inviteId: "invite",
        actorUid: "host",
        matchId: "invite1",
        rematches: { state: "open", indices: [1] },
        match,
      });
    await settle();
    assert.equal(h.instance.activeContext, context);
    assert.equal(h.events.ui.includes("proposal-created"), false);
    assert.equal(h.events.ui.includes("proposal-failed"), false);
    assert.equal(h.instance.rematchSeriesEndIsIndicated(), true);
    required(ending.resolve)({
      ok: true,
      inviteId: "invite",
      actorUid: "host",
      rematches: rejected
        ? { state: "ended", indices: [] }
        : { state: "ended", indices: [1] },
    });
    await settle();
    assert.equal(h.records.size, 0);
    h.instance.detachFromMatchSession();
  });
}

test("reload restores Finished on the completed board while flushing the original pending-rematch scope", async () => {
  const record = {
    loginUid: "login",
    inviteId: "invite",
    actorUid: "host",
    matchId: "invite1",
    operationId: "00000000-0000-4000-8000-000000000123",
  };
  const records = new Map([
    [
      rematchEndDeliveryStorageKey(record),
      JSON.stringify({ version: 1, record }),
    ],
  ]);
  /** @type {PromiseWithResolvers<import("@mons/shared/game-sessions").EndRematchResponse>} */
  const ending = deferred();
  const h = harness({
    records,
    initial: response(
      snapshot({ hostRematches: { state: "open", indices: [1] } }),
    ),
    end: () => ending.promise,
  });
  await h.connect();
  assert.equal(required(h.instance.activeContext).matchId, "invite");
  assert.ok(h.events.ui.includes("ended"));
  assert.equal(h.events.ui.includes("pending-rematch"), false);
  assert.ok(h.events.matchReads.some((value) => value.matchId === "invite1"));
  required(ending.resolve)({
    ok: true,
    inviteId: "invite",
    actorUid: "host",
    rematches: { state: "ended", indices: [1] },
  });
  await settle();
  assert.equal(records.size, 0);
  h.instance.detachFromMatchSession();
});

test("an authenticated wake resumes a stored end even without reopening that invite", async () => {
  const record = {
    loginUid: "login",
    inviteId: "invite",
    actorUid: "host",
    matchId: "invite",
    operationId: "00000000-0000-4000-8000-000000000124",
  };
  const records = new Map([
    [
      rematchEndDeliveryStorageKey(record),
      JSON.stringify({ version: 1, record }),
    ],
  ]);
  /** @type {{ value?: Parameters<GameplayApi["endRematchViaApi"]>[0] }} */
  const request = {};
  const h = harness({
    records,
    end: (value) => {
      request.value = value;
      return {
        ok: true,
        inviteId: "invite",
        actorUid: "host",
        rematches: { state: "ended", indices: [] },
      };
    },
  });
  h.instance.refreshRematchEndDeliveries();
  await settle();
  assert.equal(required(request.value).operationId, record.operationId);
  assert.equal(records.size, 0);
  assert.equal(h.events.ui.includes("ended"), false);
});

test("saved end metadata cannot discard the original move barrier after reload on another route", async () => {
  const record = {
    loginUid: "login",
    inviteId: "invite",
    actorUid: "host",
    matchId: "invite1",
    operationId: "00000000-0000-4000-8000-000000000125",
  };
  const records = new Map([
    [
      rematchEndDeliveryStorageKey(record),
      JSON.stringify({ version: 1, record }),
    ],
  ]);
  const barrier = deferred();
  let endRequests = 0;
  const h = harness({
    records,
    initial: response(
      snapshot({ hostRematches: { state: "ended", indices: [1] } }),
    ),
    end: () => {
      endRequests++;
      return {
        ok: true,
        inviteId: "invite",
        actorUid: "host",
        rematches: { state: "ended", indices: [] },
      };
    },
  });
  /** @type {FixtureMoveDelivery} */
  const moves = {
    scope: {
      loginUid: "login",
      inviteId: "invite",
      matchId: "invite1",
      playerId: "host",
    },
    confirmationVersion: 0,
    reconcile: (state) => state,
    resume() {},
    suspend() {},
    pause() {},
    hasPendingMoves: true,
    flush: () => barrier.promise,
  };
  h.instance.getMoveDelivery = (scope) => {
    assert.equal(scope.matchId, "invite1");
    h.instance.moveDeliveries.set(moveDeliveryStorageKey(scope), moves);
    return moves;
  };
  h.instance.refreshRematchEndDeliveries();
  await settle();
  h.instance.confirmRematchEndFromMetadata("login", "invite");
  assert.equal(records.size, 1);
  moves.hasPendingMoves = false;
  required(barrier.resolve)();
  await settle();
  assert.equal(records.size, 0);
  assert.equal(endRequests, 0);
});

test("auth replacement tears down host and spectator metadata resources before callbacks", async () => {
  for (const viewer of /** @type {Partial<Viewer>[]} */ ([
    { role: "host", actorUid: "host" },
    { role: "watch", actorUid: null },
  ])) {
    const h = harness({ initial: response(snapshot(), viewer) });
    await h.connect();
    const channel = h.channel();
    const wagerChannel = h.wagerChannel();
    const before = h.instance.latestInvite;
    const unsubscribe = h.instance.subscribeToAuthChanges(() => {
      assert.equal(required(channel).signal.aborted, true);
      assert.equal(required(wagerChannel).signal.aborted, true);
    });
    h.authChange({ uid: "replacement" });
    assert.equal(required(channel).stops, 1);
    assert.equal(required(wagerChannel).stops, 1);
    assert.equal(h.cleanups.size, 0);
    assert.equal(h.counters.get("connectionObservers"), 0);
    required(channel).emit(
      snapshot({ revision: 2, hostRematches: { state: "open", indices: [1] } }),
    );
    assert.strictEqual(h.instance.latestInvite, before);
    unsubscribe();
    h.instance.detachFromMatchSession();
  }
});

const wagerSnapshot = (
  /** @type {number} */ revision,
  wagers = {},
  inviteId = "invite",
) => ({
  inviteId,
  revision,
  wagers,
});
const proposalState = (/** @type {number} */ count) =>
  wagerRecord({
    proposals: { host: { material: "dust", count, createdAt: 1 } },
    proposedBy: { host: true },
  });

test("empty Worker wager bootstrap clears the displayed match without any legacy wager read", async () => {
  const h = harness({ wagers: {} });
  await h.connect();
  assert.deepEqual(probeWager(h.instance.wagerClient).wagers, {});
  assert.deepEqual(h.events.wagerStates.at(-1), {
    matchId: "invite",
    state: null,
  });
  assert.deepEqual(
    h.events.wagerReads.map((read) => read.inviteId),
    ["invite"],
  );
  h.instance.detachFromMatchSession();
  assert.equal(required(h.wagerChannel()).signal.aborted, true);
  assert.equal(h.counters.get("connectionObservers"), 0);
});

test("detaching during wager bootstrap aborts the read and drops its late response", async () => {
  /** @type {PromiseWithResolvers<import("@mons/shared/invite-wagers").ReadInviteWagersResponse>} */
  const pending = deferred();
  const h = harness({ readWagers: () => pending.promise });
  h.instance.connectToGame("login", "invite", false);
  await settle();
  assert.equal(h.events.wagerReads.length, 1);
  h.instance.detachFromMatchSession();
  assert.equal(required(required(h.events.wagerReads[0]).signal).aborted, true);
  required(pending.resolve)({ ok: true, snapshot: wagerSnapshot(2) });
  await settle();
  assert.equal(h.instance.activeContext, null);
  assert.equal(h.events.wagerChannels.length, 1);
  assert.equal(h.events.legacyReads.length, 0);
});

test("account replacement during wager bootstrap never publishes the old account snapshot", async () => {
  /** @type {PromiseWithResolvers<import("@mons/shared/invite-wagers").ReadInviteWagersResponse>} */
  const pending = deferred();
  const h = harness({ readWagers: () => pending.promise });
  const unsubscribe = h.instance.subscribeToAuthChanges(() => {});
  h.instance.connectToGame("login", "invite", false);
  await settle();
  h.authChange({ uid: "replacement" });
  assert.equal(required(required(h.events.wagerReads[0]).signal).aborted, true);
  required(pending.resolve)({ ok: true, snapshot: wagerSnapshot(2) });
  await settle();
  assert.equal(probeWager(h.instance.wagerClient).inviteWagersSnapshot, null);
  assert.equal(h.instance.isCurrentAuthUser("login"), false);
  assert.equal(h.events.wagerChannels.length, 1);
  assert.ok(h.events.wagerStates.every(({ state }) => state === null));
  unsubscribe();
});

test("invite-wide wager snapshots update historical selection and empty snapshots clear it", async () => {
  const h = harness({
    wagers: { invite: proposalState(1), invite1: proposalState(2) },
  });
  await h.connect();
  h.instance.setWagerViewMatchId("invite1");
  assert.equal(
    required(
      required(required(required(h.events.wagerStates.at(-1)).state).proposals)
        .host,
    ).count,
    2,
  );
  required(h.wagerChannel()).emit(
    wagerSnapshot(2, { invite: proposalState(3), invite1: proposalState(4) }),
  );
  assert.equal(required(h.instance.activeContext).matchId, "invite");
  assert.deepEqual(h.events.wagerStates.at(-1), {
    matchId: "invite1",
    state: proposalState(4),
  });
  assert.equal(h.events.frozenRefreshes, 2);
  required(h.wagerChannel()).emit(wagerSnapshot(3));
  assert.deepEqual(h.events.wagerStates.at(-1), {
    matchId: "invite1",
    state: null,
  });
  assert.deepEqual(probeWager(h.instance.wagerClient).wagers, {});
  h.instance.detachFromMatchSession();
});

test("internal-only revisions refresh frozen balances while duplicate and older snapshots do not", async () => {
  const wagers = { invite: proposalState(1) };
  const h = harness({ wagers });
  await h.connect();
  required(h.wagerChannel()).emit(wagerSnapshot(2, wagers));
  required(h.wagerChannel()).emit(wagerSnapshot(2, wagers));
  required(h.wagerChannel()).emit(wagerSnapshot(1), "http");
  assert.equal(h.events.frozenRefreshes, 2);
  assert.deepEqual(probeWager(h.instance.wagerClient).wagers, wagers);
  assert.equal(
    required(probeWager(h.instance.wagerClient).inviteWagersSnapshot).revision,
    2,
  );
  h.instance.detachFromMatchSession();
});

test("a stale HTTP response cannot replace a newer socket snapshot", async () => {
  const h = harness();
  await h.connect();
  required(h.wagerChannel()).emit(
    wagerSnapshot(4, { invite: proposalState(4) }),
  );
  required(h.wagerChannel()).emit(
    wagerSnapshot(3, { invite: proposalState(3) }),
    "http",
  );
  assert.equal(
    required(probeWager(h.instance.wagerClient).inviteWagersSnapshot).revision,
    4,
  );
  assert.deepEqual(
    required(probeWager(h.instance.wagerClient).wagers).invite,
    proposalState(4),
  );
  h.instance.detachFromMatchSession();
});

test("mutation generations protect optimistic state and reconcile only a fresh authoritative HTTP snapshot", async () => {
  const h = harness({ wagers: { invite: proposalState(1) } });
  await h.connect();
  const channel = h.wagerChannel();
  const beforeMutation = required(
    required(channel).dependencies.captureGeneration,
  )();
  const finish = probeWager(h.instance.wagerClient).beginWagerSnapshotMutation(
    required(h.instance.activeContext),
  );
  probeWager(h.instance.wagerClient).setLocalWagerState(proposalState(9));
  assert.deepEqual(
    required(probeWager(h.instance.wagerClient).inviteWagersSnapshot).wagers
      .invite,
    proposalState(1),
  );
  required(channel).emit(wagerSnapshot(2, { invite: proposalState(2) }));
  assert.deepEqual(
    required(probeWager(h.instance.wagerClient).wagers).invite,
    proposalState(9),
  );
  finish();
  assert.equal(required(channel).refreshes, 1);
  required(channel).emit(
    wagerSnapshot(2, { invite: proposalState(2) }),
    "http",
    beforeMutation,
  );
  required(channel).emit(wagerSnapshot(3, { invite: proposalState(3) }));
  required(channel).emit(
    wagerSnapshot(2, { invite: proposalState(2) }),
    "http",
  );
  assert.deepEqual(
    required(probeWager(h.instance.wagerClient).wagers).invite,
    proposalState(9),
  );
  assert.equal(
    required(required(channel).dependencies.needsHttpRefresh).call(
      required(channel).dependencies,
    ),
    true,
  );
  required(channel).emit(
    wagerSnapshot(3, { invite: proposalState(3) }),
    "http",
  );
  assert.deepEqual(
    required(probeWager(h.instance.wagerClient).wagers).invite,
    proposalState(3),
  );
  assert.equal(
    required(required(channel).dependencies.needsHttpRefresh).call(
      required(channel).dependencies,
    ),
    false,
  );
  h.instance.detachFromMatchSession();
});

test("successful and failed mutations both reconcile optimistic changes at the same canonical revision", async () => {
  for (const fails of [false, true]) {
    const h = harness({ wagers: {} });
    await h.connect();
    /** @type {PromiseWithResolvers<{ ok: boolean; }>} */
    const pending = deferred();
    const channel = h.wagerChannel();
    const mutation = probeWager(h.instance.wagerClient).runWagerMutation(
      async () => {
        probeWager(h.instance.wagerClient).setLocalWagerState(proposalState(9));
        return pending.promise;
      },
      false,
    );
    const completion = fails
      ? assert.rejects(mutation, /mutation-failed/)
      : mutation;
    await settle();
    assert.equal(
      probeWager(h.instance.wagerClient).pendingWagerMutations.size,
      1,
    );
    if (fails) required(pending.reject)(new Error("mutation-failed"));
    else required(pending.resolve)({ ok: true });
    await completion;
    assert.equal(
      probeWager(h.instance.wagerClient).pendingWagerMutations.size,
      0,
    );
    assert.equal(required(channel).refreshes, 1);
    required(channel).emit(wagerSnapshot(1), "http");
    assert.deepEqual(probeWager(h.instance.wagerClient).wagers, {});
    assert.equal(required(h.events.wagerStates.at(-1)).state, null);
    h.instance.detachFromMatchSession();
  }
});

test("overlapping mutations hold snapshots until every mutation finishes", async () => {
  const h = harness({ wagers: {} });
  await h.connect();
  const first = probeWager(h.instance.wagerClient).beginWagerSnapshotMutation(
    required(h.instance.activeContext),
  );
  const second = probeWager(h.instance.wagerClient).beginWagerSnapshotMutation(
    required(h.instance.activeContext),
  );
  probeWager(h.instance.wagerClient).setLocalWagerState(proposalState(9));
  first();
  required(h.wagerChannel()).emit(wagerSnapshot(2), "http");
  assert.deepEqual(
    required(probeWager(h.instance.wagerClient).wagers).invite,
    proposalState(9),
  );
  second();
  required(h.wagerChannel()).emit(wagerSnapshot(2), "http");
  assert.deepEqual(probeWager(h.instance.wagerClient).wagers, {});
  h.instance.detachFromMatchSession();
});

test("rematch contexts retain historical wagers and refresh the new channel when an old settlement finishes", async () => {
  const h = harness({
    wagers: { invite: proposalState(1), invite1: proposalState(2) },
  });
  await h.connect();
  const oldChannel = h.wagerChannel();
  const finish = probeWager(h.instance.wagerClient).beginWagerSnapshotMutation(
    required(h.instance.activeContext),
  );
  h.instance.sendRematchProposal();
  await settle();
  assert.equal(required(oldChannel).stops, 1);
  assert.equal(required(h.instance.activeContext).matchId, "invite1");
  assert.deepEqual(h.events.wagerStates.at(-1), {
    matchId: "invite1",
    state: proposalState(2),
  });
  required(oldChannel).emit(wagerSnapshot(8));
  assert.equal(
    required(probeWager(h.instance.wagerClient).inviteWagersSnapshot).revision,
    1,
  );
  finish();
  assert.equal(required(h.wagerChannel()).refreshes, 1);
  required(h.wagerChannel()).emit(
    wagerSnapshot(2, { invite: proposalState(3), invite1: proposalState(2) }),
    "http",
  );
  h.instance.setWagerViewMatchId("invite");
  assert.deepEqual(
    required(h.events.wagerStates.at(-1)).state,
    proposalState(3),
  );
  h.instance.detachFromMatchSession();
  assert.equal(h.counters.get("connectionObservers"), 0);
});

test("a stale in-flight match snapshot cannot undo a confirmed surrender", async () => {
  /** @type {PromiseWithResolvers<import("@mons/shared/game-sessions").GameSessionMatch | null>} */
  const pendingRead = deferred();
  const h = harness({
    readMatch: (/** @type {number} */ attempt) =>
      attempt === 1 ? { ...match } : pendingRead.promise,
  });
  await h.connect();
  h.instance.connectToGame("login", "invite", false);
  await settle();
  assert.equal(h.events.matchReads.length, 2);
  assert.equal(h.instance.surrender(), true);
  await settle();
  assert.equal(h.events.surrenders.length, 1);
  Reflect.apply(pendingRead.resolve, undefined, [{ ...match, status: "" }]);
  await settle();
  assert.deepEqual(h.events.errors, []);
  assert.equal(required(h.instance.myMatch).status, "surrendered");
  assert.equal(
    required(h.events.recoveredMatches.at(-1)).status,
    "surrendered",
  );
  h.instance.detachFromMatchSession();
});

test("confirmed surrender hydration is restricted to its original login and match", async () => {
  for (const overrides of [
    { loginUid: "other" },
    { inviteId: "other" },
    { matchId: "invite1" },
    { playerId: "guest" },
  ]) {
    const h = harness();
    h.instance.confirmedSurrenders.add(
      moveDeliveryStorageKey({
        loginUid: "login",
        inviteId: "invite",
        matchId: "invite",
        playerId: "host",
        ...overrides,
      }),
    );
    await h.connect();
    assert.equal(required(h.instance.myMatch).status, "active");
    assert.equal(required(h.events.recoveredMatches.at(-1)).status, "active");
    h.instance.detachFromMatchSession();
  }
});

test("reconnect keeps the latest wager snapshot received while metadata bootstrap is pending", async () => {
  /** @type {PromiseWithResolvers<import("@mons/shared/invite-metadata").ReadInviteMetadataResponse>} */
  const pending = deferred();
  const h = harness({
    read: (/** @type {number} */ attempt) =>
      attempt === 1 ? response() : pending.promise,
  });
  await h.connect();
  h.instance.connectToGame("login", "invite", false);
  required(h.wagerChannel()).emit(
    wagerSnapshot(3, { invite: proposalState(3) }),
  );
  required(pending.resolve)(response());
  await settle();
  assert.deepEqual(h.events.errors, []);
  assert.equal(
    required(probeWager(h.instance.wagerClient).inviteWagersSnapshot).revision,
    3,
  );
  assert.deepEqual(
    required(probeWager(h.instance.wagerClient).wagers).invite,
    proposalState(3),
  );
  assert.equal(h.events.wagerReads.length, 2);
  h.instance.detachFromMatchSession();
});

test("same-invite reconnect preserves pending wager mutations and reconciles after completion", async () => {
  for (const fails of [false, true]) {
    const h = harness({ wagers: {} });
    await h.connect();
    /** @type {PromiseWithResolvers<{ ok: boolean; }>} */
    const pending = deferred();
    const mutation = probeWager(h.instance.wagerClient).runWagerMutation(
      async () => {
        probeWager(h.instance.wagerClient).setLocalWagerState(proposalState(9));
        return pending.promise;
      },
      false,
    );
    await settle();
    const oldContext = h.instance.activeContext;
    const oldChannel = h.wagerChannel();
    h.instance.connectToGame("login", "invite", false);
    await settle();
    assert.deepEqual(h.events.errors, []);
    assert.notEqual(
      required(h.instance.activeContext).sessionEpoch,
      required(oldContext).sessionEpoch,
    );
    assert.equal(required(oldChannel).stops, 1);
    assert.equal(
      probeWager(h.instance.wagerClient).pendingWagerMutations.size,
      1,
    );
    const channel = h.wagerChannel();
    const beforeCompletion = required(
      required(channel).dependencies.captureGeneration,
    )();
    required(channel).emit(wagerSnapshot(1), "http");
    assert.deepEqual(
      required(probeWager(h.instance.wagerClient).wagers).invite,
      proposalState(9),
    );
    if (fails) required(pending.reject)(new Error("mutation-failed"));
    else required(pending.resolve)({ ok: true });
    await mutation;
    assert.equal(
      probeWager(h.instance.wagerClient).pendingWagerMutations.size,
      0,
    );
    assert.equal(required(oldChannel).refreshes, 0);
    assert.equal(required(channel).refreshes, 1);
    assert.ok(
      required(required(channel).dependencies.captureGeneration).call(
        required(channel).dependencies,
      ) > beforeCompletion,
    );
    required(channel).emit(wagerSnapshot(1), "http", beforeCompletion);
    assert.deepEqual(
      required(probeWager(h.instance.wagerClient).wagers).invite,
      proposalState(9),
    );
    assert.equal(
      required(required(channel).dependencies.needsHttpRefresh).call(
        required(channel).dependencies,
      ),
      true,
    );
    required(channel).emit(wagerSnapshot(1), "http");
    assert.deepEqual(probeWager(h.instance.wagerClient).wagers, {});
    assert.equal(
      required(required(channel).dependencies.needsHttpRefresh).call(
        required(channel).dependencies,
      ),
      false,
    );
    h.instance.detachFromMatchSession();
    assert.equal(h.counters.get("connectionObservers"), 0);
  }
});

test("an account switch invalidates old wager tickets even if that account reconnects again", async () => {
  const h = harness({ wagers: {} });
  await h.connect();
  h.instance.subscribeToAuthChanges(() => {});
  /** @type {PromiseWithResolvers<{ ok: boolean; }>} */
  const pending = deferred();
  const mutation = probeWager(h.instance.wagerClient).runWagerMutation(
    async () => pending.promise,
    false,
  );
  await settle();
  assert.equal(
    probeWager(h.instance.wagerClient).pendingWagerMutations.size,
    1,
  );
  h.authChange({ uid: "replacement" });
  assert.equal(
    probeWager(h.instance.wagerClient).pendingWagerMutations.size,
    0,
  );
  h.authChange({ uid: "login" });
  h.instance.connectToGame("login", "invite", false);
  await settle();
  const channel = h.wagerChannel();
  required(pending.resolve)({ ok: true });
  await mutation;
  assert.equal(required(channel).refreshes, 0);
  h.instance.detachFromMatchSession();
});

test("stale settlement restoration cannot modify another invite even with a matching match ID", async () => {
  const h = harness();
  await h.connect();
  const optimistic = {
    resolved: {
      winnerId: "host",
      loserId: "guest",
      material: /** @type {const} */ ("dust"),
      count: 3,
      total: 6,
      resolvedAt: 1,
      optimistic: true,
    },
  };
  probeWager(h.instance.wagerClient).setLocalWagerState(optimistic);
  probeWager(h.instance.wagerClient).restoreOptimisticWagerResolution(
    "invite",
    proposalState(1),
    () => false,
    () => false,
  );
  assert.deepEqual(
    required(probeWager(h.instance.wagerClient).wagers).invite,
    optimistic,
  );
  probeWager(h.instance.wagerClient).restoreOptimisticWagerResolution(
    "invite",
    proposalState(1),
    () => false,
    () => true,
  );
  assert.deepEqual(
    required(probeWager(h.instance.wagerClient).wagers).invite,
    proposalState(1),
  );
  h.instance.detachFromMatchSession();
});

test("detaching invalidates pending mutation completion and stale channel callbacks without observer leaks", async () => {
  const h = harness();
  await h.connect();
  const finish = probeWager(h.instance.wagerClient).beginWagerSnapshotMutation(
    required(h.instance.activeContext),
  );
  const channel = h.wagerChannel();
  h.instance.detachFromMatchSession();
  finish();
  required(channel).emit(wagerSnapshot(9));
  assert.equal(h.instance.latestInvite, null);
  assert.equal(required(channel).refreshes, 0);
  assert.equal(required(channel).stops, 1);
  assert.equal(
    probeWager(h.instance.wagerClient).pendingWagerMutations.size,
    0,
  );
  assert.equal(h.counters.get("connectionObservers"), 0);
  assert.equal(h.cleanups.size, 0);
});

test("a replacement account reconnecting to the same invite bootstraps its own canonical wager snapshot", async () => {
  const h = harness({ wagers: {} });
  await h.connect();
  const finish = probeWager(h.instance.wagerClient).beginWagerSnapshotMutation(
    required(h.instance.activeContext),
  );
  probeWager(h.instance.wagerClient).setLocalWagerState(proposalState(9));
  h.instance.auth.currentUser = sessionUser({ uid: "replacement" });
  h.instance.connectToGame("replacement", "invite", false);
  await settle();
  assert.deepEqual(h.events.errors, []);
  assert.equal(required(h.instance.activeContext).loginUid, "replacement");
  assert.equal(h.events.wagerReads.length, 2);
  assert.deepEqual(probeWager(h.instance.wagerClient).wagers, {});
  finish();
  assert.equal(required(h.wagerChannel()).refreshes, 0);
  h.instance.detachFromMatchSession();
});
