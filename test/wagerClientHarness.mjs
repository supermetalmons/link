import assert from "node:assert/strict";
import { registerTypeScriptTestHooks } from "./support/typescriptHooks.mjs";
import { createTimerHandle } from "./fixtures/timerHandle.mjs";

registerTypeScriptTestHooks();

const { WagerClient } = await import("../src/connection/wagerClient.ts");
const { createUserBoundAuthTokenProvider } =
  await import("../src/services/authApi.ts");
const { FrozenMaterialsPoller } =
  await import("../src/connection/frozenMaterialsPoller.ts");
const { computeAvailableMaterials, applyMaterialDeltas } =
  await import("@mons/shared/mining");

/**
 * @typedef {import("../src/connection/wagerClient.ts").WagerClientDependencies} WagerDependencies
 * @typedef {import("../src/connection/matchRuntimeContext.ts").MatchRuntimeContext} MatchContext
 * @typedef {import("../src/connection/matchRuntimeContext.ts").WritableMatchRuntimeContext} WritableContext
 * @typedef {import("../src/session/sessionAuth.ts").SessionUser} SessionUser
 * @typedef {import("../src/connection/connectionModels.ts").MatchWagerState} WagerState
 * @typedef {import("../src/connection/connectionModels.ts").PlayerMiningData} MiningData
 * @typedef {ReturnType<WagerDependencies["materialStore"]["getFrozenMaterials"]>} Materials
 * @typedef {ReturnType<WagerDependencies["materialStore"]["getFrozenMaterialsStatus"]>} MaterialsStatus
 * @typedef {Parameters<NonNullable<WagerDependencies["createWagerChannel"]>>[0]} ChannelOptions
 * @typedef {import("@mons/shared/invite-wagers").InviteWagersSnapshot} WagerSnapshot
 * @typedef {import("../src/connection/inviteWagersChannel.ts").InviteWagersDelivery} WagerDelivery
 * @typedef {{ options: ChannelOptions, stops: number, refreshes: number, stop(): void, requestRefresh(): void, emit(snapshot: WagerSnapshot, source?: WagerDelivery["source"], requestGeneration?: number): void }} TestChannel
 * @typedef {{ activeContext: MatchContext | null, epoch: number, actorUid: string | null, profileId: string, auth: { currentUser: SessionUser | null, getTokenRemainingMs: WagerDependencies["auth"]["getTokenRemainingMs"] } }} HarnessSession
 * @typedef {{ states: { matchId: string | null, state: WagerState | null, confirmed?: boolean | undefined }[], frozen: { materials: Materials, status: MaterialsStatus }[], inventory: MiningData[], banners: boolean[], initial: boolean[], refreshes: number, observers: number, channels: TestChannel[], pollers: import("../src/connection/frozenMaterialsPoller.ts").FrozenMaterialsPoller[], flushes: { context: Parameters<WagerDependencies["flushPendingMoves"]>[0], options: Parameters<WagerDependencies["flushPendingMoves"]>[1] }[] }} HarnessEvents
 * @typedef {Pick<WagerDependencies, "auth" | "getUserBoundAuthTokenProvider" | "flushPendingMoves"> & Partial<Pick<WagerDependencies, "requireWritableContext" | "ensureAuthenticated" | "getOpponentId" | "registerObserverCleanup" | "unregisterObserverCleanup">> & { activeContext: MatchContext | null, sessionEpoch: number, sameProfilePlayerUid?: string | null }} HarnessConnection
 */

/**
 * @template [T=void]
 * @returns {{ promise: Promise<T>, resolve: (value: T | PromiseLike<T>) => void, reject: (reason?: unknown) => void }}
 */
export const deferred = () => {
  /** @type {PromiseWithResolvers<T>} */
  const pending = Promise.withResolvers();
  return pending;
};
export const flush = () => new Promise(setImmediate);
export const emptyMaterials = { dust: 0, slime: 0, gum: 0, metal: 0, ice: 0 };

/** @param {Partial<WagerDependencies>} [overrides] */
export function createWagerClientHarness(overrides = {}) {
  /** @type {HarnessSession} */
  const session = {
    activeContext: {
      contextId: 1,
      sessionEpoch: 1,
      inviteId: "invite",
      matchId: "finished",
      loginUid: "login",
      actorUid: "actor",
      role: "host",
      canWrite: true,
      createdAtMs: 0,
    },
    epoch: 1,
    actorUid: "actor",
    profileId: "profile",
    auth: {
      currentUser: {
        uid: "login",
        sessionId: "wager-test-session",
        generation: "wager-test-generation",
        getIdToken: async () => "token",
      },
      getTokenRemainingMs: () => 60_000,
    },
  };
  /** @type {HarnessEvents} */
  const events = {
    states: [],
    frozen: [],
    inventory: [],
    banners: [],
    initial: [],
    refreshes: 0,
    observers: 0,
    channels: [],
    pollers: [],
    flushes: [],
  };
  /** @type {WagerState | null} */
  let state = null;
  /** @type {string | null} */
  let selectedMatchId = null;
  let frozen = { ...emptyMaterials };
  /** @type {MaterialsStatus} */
  let frozenStatus = "idle";
  /** @type {Map<ReturnType<typeof setTimeout>, { callback: () => void, ms: number }>} */
  const timers = new Map();
  /** @type {WagerDependencies} */
  const dependencies = {
    auth: session.auth,
    getActiveContext: () => session.activeContext,
    getSessionEpoch: () => session.epoch,
    getSameProfilePlayerUid: () => session.actorUid,
    getProfileId: () => session.profileId,
    requireWritableContext: () =>
      session.activeContext?.canWrite && session.activeContext.actorUid
        ? /** @type {WritableContext} */ (session.activeContext)
        : null,
    ensureAuthenticated: async () => {},
    getUserBoundAuthTokenProvider: (uid) => {
      const user = session.auth.currentUser;
      if (!user || (uid && user.uid !== uid))
        throw new Error("authentication-changed");
      return createUserBoundAuthTokenProvider(
        user,
        () => session.auth.currentUser,
      );
    },
    createSessionGuard: () => {
      const epoch = session.epoch;
      return () => epoch === session.epoch;
    },
    createMatchContextGuard: (inviteId, matchId) => {
      const epoch = session.epoch;
      const contextId = session.activeContext?.contextId;
      return () =>
        session.epoch === epoch &&
        session.activeContext?.contextId === contextId &&
        session.activeContext?.inviteId === inviteId &&
        session.activeContext?.matchId === matchId;
    },
    isContextActive: (id, epoch) =>
      session.epoch === epoch && session.activeContext?.contextId === id,
    isCurrentAuthUser: (uid) => session.auth.currentUser?.uid === uid,
    isSessionEpochActive: (epoch) => session.epoch === epoch,
    getOpponentId: () => "opponent",
    flushPendingMoves: async (context, options) => {
      events.flushes.push({ context, options });
    },
    registerObserverCleanup: () => true,
    unregisterObserverCleanup: () => {},
    changeObserverCount: (delta) => {
      events.observers += delta;
    },
    wagerStore: {
      getWagerState: () => state,
      setWagerState: (matchId, value) => {
        if (selectedMatchId && matchId !== selectedMatchId) return;
        state = value;
        events.states.push({ matchId, state: value });
      },
      setCurrentWagerMatch: (matchId) => {
        selectedMatchId = matchId;
        state = null;
      },
      syncCurrentWagerMatchState: (matchId, value, confirmed) => {
        selectedMatchId = matchId;
        state = value;
        events.states.push({ matchId, state: value, confirmed });
      },
    },
    materialStore: {
      getFrozenMaterials: () => ({ ...frozen }),
      getFrozenMaterialsStatus: () => frozenStatus,
      setFrozenMaterials: (value, status = frozenStatus) => {
        frozen = { ...emptyMaterials, ...value };
        frozenStatus = status;
        events.frozen.push({ materials: { ...frozen }, status });
      },
      setFrozenMaterialsStatus: (status) => {
        frozenStatus = status;
      },
      applyFrozenMaterialsDelta: (delta) => {
        frozen = applyMaterialDeltas(frozen, delta);
        return { ...frozen };
      },
      computeAvailableMaterials,
    },
    mining: {
      getSnapshot: () => ({
        materials: { ...emptyMaterials, dust: 8 },
        lastRockDate: null,
      }),
      setFromServer: (value) => events.inventory.push(value),
    },
    api: {
      readInviteWagersViaApi: async (inviteId) => ({
        ok: true,
        snapshot: { inviteId, revision: 1, wagers: {} },
      }),
      readWagerFrozenViaApi: async ({ playerUid }) => ({
        ok: true,
        playerUid,
        revision: 1,
        frozen: { ...emptyMaterials },
      }),
      sendWagerProposalViaApi: async () => ({ ok: true, count: 3 }),
      cancelWagerProposalViaApi: async () => ({ ok: true }),
      declineWagerProposalViaApi: async () => ({ ok: true }),
      acceptWagerProposalViaApi: async () => ({ ok: true, count: 3 }),
      resolveWagerOutcomeViaApi: async () => ({
        ok: true,
        reason: "no-wager",
        mining: null,
      }),
    },
    onInitialWagers: () => events.initial.push(true),
    onReloadRequired: () => events.banners.push(true),
    now: () => 100,
    setTimer: (callback, ms) => {
      const id = createTimerHandle();
      timers.set(id, { callback, ms });
      if ([160, 180, 320, 360].includes(ms))
        queueMicrotask(() => {
          if (timers.delete(id)) callback();
        });
      return id;
    },
    clearTimer: (id) => timers.delete(id),
    createSocket: () => {
      throw new Error("unexpected-socket");
    },
    isOnline: () => true,
    isVisible: () => true,
    addWakeListener: () => () => {},
    addVisibilityListener: () => () => {},
    addOnlineListener: () => () => {},
    random: () => 0.5,
    log: () => {},
    logError: () => {},
    debug: false,
    createWagerChannel: (options) => {
      /** @type {TestChannel} */
      const channel = {
        options,
        stops: 0,
        refreshes: 0,
        stop() {
          this.stops++;
        },
        requestRefresh() {
          this.refreshes++;
        },
        emit(snapshot, source = "http", requestGeneration) {
          if (requestGeneration === undefined) {
            assert.ok(options.captureGeneration);
            requestGeneration = options.captureGeneration();
          }
          options.onSnapshot(snapshot, { source, requestGeneration });
        },
      };
      events.channels.push(channel);
      return channel;
    },
    createFrozenPoller: (options) => {
      const poller = new FrozenMaterialsPoller(options);
      const refresh = poller.refresh.bind(poller);
      poller.refresh = () => {
        events.refreshes++;
        refresh();
      };
      events.pollers.push(poller);
      return poller;
    },
    ...overrides,
  };
  const client = new WagerClient(dependencies);
  const activeContext = dependencies.getActiveContext();
  if (activeContext) client.bindContext(activeContext);
  return {
    client,
    dependencies,
    session,
    events,
    timers,
    /** @param {WagerSnapshot["wagers"]} [wagers] */
    observe: (wagers = {}, revision = 1) => {
      client.observeWagers();
      const channel = events.channels.at(-1);
      const context = dependencies.getActiveContext();
      assert.ok(channel);
      assert.ok(context);
      channel.emit({
        inviteId: context.inviteId,
        revision,
        wagers,
      });
    },
    stop: () => {
      client.resetMatch();
      client.resetProfile();
    },
  };
}

/**
 * @param {HarnessConnection} connection
 * @param {Partial<WagerDependencies>} [overrides]
 */
export function createConnectionWagerClientHarness(connection, overrides = {}) {
  return createWagerClientHarness({
    auth: connection.auth,
    getActiveContext: () => connection.activeContext,
    getSessionEpoch: () => connection.sessionEpoch,
    getSameProfilePlayerUid: () =>
      ("sameProfilePlayerUid" in connection
        ? connection.sameProfilePlayerUid
        : connection.activeContext?.actorUid) ?? null,
    requireWritableContext: (...args) =>
      connection.requireWritableContext
        ? connection.requireWritableContext(...args)
        : connection.activeContext?.canWrite
          ? /** @type {WritableContext} */ (connection.activeContext)
          : null,
    ensureAuthenticated: () =>
      connection.ensureAuthenticated?.() ?? Promise.resolve(),
    getUserBoundAuthTokenProvider: (uid) =>
      connection.getUserBoundAuthTokenProvider(uid),
    createSessionGuard: () => {
      const epoch = connection.sessionEpoch;
      return () => epoch === connection.sessionEpoch;
    },
    createMatchContextGuard: (inviteId, matchId) => {
      const epoch = connection.sessionEpoch;
      const contextId = connection.activeContext?.contextId;
      return () =>
        epoch === connection.sessionEpoch &&
        contextId === connection.activeContext?.contextId &&
        inviteId === connection.activeContext?.inviteId &&
        matchId === connection.activeContext?.matchId;
    },
    isContextActive: (contextId, epoch) =>
      connection.activeContext?.contextId === contextId &&
      connection.sessionEpoch === epoch,
    isCurrentAuthUser: (uid) => connection.auth.currentUser?.uid === uid,
    isSessionEpochActive: (epoch) => connection.sessionEpoch === epoch,
    getOpponentId: (...args) =>
      connection.getOpponentId?.(...args) ?? "opponent",
    flushPendingMoves: (...args) => connection.flushPendingMoves(...args),
    registerObserverCleanup: (...args) =>
      connection.registerObserverCleanup?.(...args) ?? true,
    unregisterObserverCleanup: (...args) =>
      connection.unregisterObserverCleanup?.(...args),
    ...overrides,
  });
}
