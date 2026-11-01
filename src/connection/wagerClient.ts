import type {
  MatchWagerState,
  WagerProposal,
  WagerAgreement,
  MiningMaterialName,
  PlayerMiningData,
} from "./connectionModels";
import type {
  MatchRuntimeContext,
  WritableMatchRuntimeContext,
} from "./matchRuntimeContext";
import type { SessionUser } from "../session/sessionAuth";
import type { AuthTokenProvider } from "../services/authApi";
import type { InviteWagersSnapshot } from "@mons/shared/invite-wagers";
import type {
  WagerOutcomeResolveResponse,
  WagerProposalAcceptResponse,
  WagerProposalRemovalResponse,
  WagerProposalSendResponse,
} from "@mons/shared/wagers";
import { InviteWagersChannel } from "./inviteWagersChannel";
import { FrozenMaterialsPoller } from "./frozenMaterialsPoller";
import { createInviteWagersSocketProtocols } from "../services/inviteWagersApi";
import { isWagerClientUpdateRequired, retryWagerApi } from "./wagerApiRetry";

type BoundAuthTokenProvider = AuthTokenProvider & {
  readonly assertCurrentUser: () => void;
};
type WagerApiResponse =
  | WagerOutcomeResolveResponse
  | WagerProposalAcceptResponse
  | WagerProposalRemovalResponse
  | WagerProposalSendResponse;
export type WagerOwner = { inviteId: string; loginUid: string };
type WagerChannel = Pick<InviteWagersChannel, "stop" | "requestRefresh">;
type FrozenPoller = Pick<
  FrozenMaterialsPoller,
  "stop" | "refresh" | "runMutation"
>;
export type WagerClientDependencies = {
  auth: {
    readonly currentUser: SessionUser | null;
    getTokenRemainingMs: (token: string) => number;
  };
  getActiveContext: () => MatchRuntimeContext | null;
  getSessionEpoch: () => number;
  getSameProfilePlayerUid: () => string | null;
  getProfileId: () => string;
  requireWritableContext: (
    expectedMatchId?: string | null,
    reason?: string,
  ) => WritableMatchRuntimeContext | null;
  ensureAuthenticated: () => Promise<void>;
  getUserBoundAuthTokenProvider: (
    expectedUid?: string,
  ) => BoundAuthTokenProvider;
  createSessionGuard: () => () => boolean;
  createMatchContextGuard: (inviteId: string, matchId: string) => () => boolean;
  isContextActive: (contextId: number, epoch: number) => boolean;
  isCurrentAuthUser: (uid: string) => boolean;
  isSessionEpochActive: (epoch: number) => boolean;
  getOpponentId: (actorUid?: string | null) => string;
  flushPendingMoves: (
    context: WritableMatchRuntimeContext,
    options: { requireCurrentContext: false },
  ) => Promise<void>;
  registerObserverCleanup: (
    contextId: number,
    key: string,
    cleanup: () => void,
  ) => boolean;
  unregisterObserverCleanup: (contextId: number, key: string) => void;
  changeObserverCount: (delta: 1 | -1) => void;
  wagerStore: Pick<
    typeof import("../game/wagerState"),
    | "getWagerState"
    | "setWagerState"
    | "syncCurrentWagerMatchState"
    | "setCurrentWagerMatch"
  >;
  materialStore: Pick<
    typeof import("../services/wagerMaterialsService"),
    | "applyFrozenMaterialsDelta"
    | "computeAvailableMaterials"
    | "getFrozenMaterials"
    | "getFrozenMaterialsStatus"
    | "setFrozenMaterials"
    | "setFrozenMaterialsStatus"
  >;
  mining: {
    getSnapshot: () => PlayerMiningData;
    setFromServer: (
      mining: PlayerMiningData,
      options: { persist: true },
    ) => void;
  };
  api: Pick<
    typeof import("../services/gameplayApi"),
    | "resolveWagerOutcomeViaApi"
    | "sendWagerProposalViaApi"
    | "cancelWagerProposalViaApi"
    | "declineWagerProposalViaApi"
    | "acceptWagerProposalViaApi"
    | "readWagerFrozenViaApi"
  > &
    Pick<
      typeof import("../services/inviteWagersApi"),
      "readInviteWagersViaApi"
    >;
  onInitialWagers: () => void;
  onReloadRequired: () => void;
  now: () => number;
  setTimer: (
    callback: () => void,
    delayMs: number,
  ) => ReturnType<typeof setTimeout>;
  clearTimer: (timer: ReturnType<typeof setTimeout>) => void;
  createSocket: (url: string, protocols?: string[]) => WebSocket;
  isOnline: () => boolean;
  isVisible: () => boolean;
  addWakeListener: (listener: () => void) => () => void;
  addVisibilityListener: (listener: () => void) => () => void;
  addOnlineListener: (listener: () => void) => () => void;
  random: () => number;
  log: (...values: unknown[]) => void;
  logError: (...values: unknown[]) => void;
  debug: boolean;
  createWagerChannel?: (
    dependencies: ConstructorParameters<typeof InviteWagersChannel>[0],
  ) => WagerChannel;
  createFrozenPoller?: (
    dependencies: ConstructorParameters<typeof FrozenMaterialsPoller>[0],
  ) => FrozenPoller;
};

const summarizeWagerState = (state: MatchWagerState | null) => {
  const proposalKeys = Object.keys(state?.proposals || {});
  const agreed = state?.agreed
    ? {
        material: state.agreed.material,
        count: state.agreed.count,
        total: state.agreed.total,
        proposerId: state.agreed.proposerId,
        accepterId: state.agreed.accepterId,
      }
    : null;
  const resolved = state?.resolved
    ? {
        material: state.resolved.material,
        count: state.resolved.count,
        total: state.resolved.total,
        winnerId: state.resolved.winnerId,
        loserId: state.resolved.loserId,
      }
    : null;
  return {
    hasState: !!state,
    proposalKeys,
    agreed,
    resolved,
  };
};

export class WagerClient {
  private inviteWagersSnapshot: InviteWagersSnapshot | null = null;
  private wagerSnapshotGeneration = 0;
  private wagerSnapshotRevisionFloor = -1;
  private wagerSnapshotNeedsReconciliation = false;
  private pendingWagerMutations = new Set<object>();
  private inviteWagersSubscription: {
    contextId: number;
    channel: WagerChannel;
    stop: () => void;
  } | null = null;
  private miningFrozenPoller: FrozenPoller | null = null;
  private miningFrozenLoginUid: string | null = null;
  private optimisticResolvedMatchIds = new Set<string>();
  private wagerViewMatchId: string | null = null;

  private owner: WagerOwner | null = null;
  private wagers: Record<string, MatchWagerState> | null = null;
  private readonly dependencies: WagerClientDependencies;
  private readonly createWagerChannel: NonNullable<
    WagerClientDependencies["createWagerChannel"]
  >;
  private readonly createFrozenPoller: NonNullable<
    WagerClientDependencies["createFrozenPoller"]
  >;

  constructor(dependencies: WagerClientDependencies) {
    this.dependencies = dependencies;
    this.createWagerChannel =
      dependencies.createWagerChannel ??
      ((options) => new InviteWagersChannel(options));
    this.createFrozenPoller =
      dependencies.createFrozenPoller ??
      ((options) => new FrozenMaterialsPoller(options));
  }

  private get activeContext() {
    return this.dependencies.getActiveContext();
  }

  private get inviteId() {
    return this.activeContext?.inviteId ?? null;
  }

  private get matchId() {
    return this.activeContext?.matchId ?? null;
  }

  public bindContext(context: MatchRuntimeContext): void {
    if (
      this.owner &&
      (this.owner.inviteId !== context.inviteId ||
        this.owner.loginUid !== context.loginUid)
    )
      this.resetMatch();
    this.owner = { inviteId: context.inviteId, loginUid: context.loginUid };
  }

  public hasConfirmedSnapshot(): boolean {
    return (
      this.inviteWagersSnapshot !== null &&
      !this.wagerSnapshotNeedsReconciliation
    );
  }

  public handleAuthChange(loginUid: string | null): boolean {
    if (this.activeContext && loginUid !== this.activeContext.loginUid) {
      this.cleanupWagerObserver();
      this.pendingWagerMutations.clear();
      this.wagerSnapshotGeneration += 1;
    }
    return (
      this.miningFrozenPoller !== null && loginUid !== this.miningFrozenLoginUid
    );
  }

  public resetMatch(options: { preserveInvite?: WagerOwner } = {}): void {
    this.cleanupWagerObserver();
    const preserve =
      options.preserveInvite &&
      this.owner?.inviteId === options.preserveInvite.inviteId &&
      this.owner.loginUid === options.preserveInvite.loginUid;
    this.wagerSnapshotGeneration += 1;
    if (!preserve) {
      this.owner = null;
      this.wagers = null;
      this.inviteWagersSnapshot = null;
      this.wagerSnapshotRevisionFloor = -1;
      this.wagerSnapshotNeedsReconciliation = false;
      this.pendingWagerMutations.clear();
    }
    this.wagerViewMatchId = null;
    this.optimisticResolvedMatchIds.clear();
    this.dependencies.wagerStore.setCurrentWagerMatch(null);
  }

  public resetProfile(): void {
    this.observeMiningFrozen(null);
  }

  private logWagerDebug(
    event: string,
    payload: Record<string, unknown> = {},
  ): void {
    if (!this.dependencies.debug) {
      return;
    }
    this.dependencies.log("wager-debug", {
      source: "connection",
      event,
      inviteId: this.inviteId,
      activeMatchId: this.matchId,
      wagerViewMatchId: this.wagerViewMatchId,
      ...payload,
    });
  }

  private cloneWagerState(
    state: MatchWagerState | null,
  ): MatchWagerState | null {
    if (!state) {
      return null;
    }
    const proposals = state.proposals
      ? Object.keys(state.proposals).reduce(
          (acc, key) => {
            const proposal = state.proposals ? state.proposals[key] : null;
            if (proposal) {
              acc[key] = {
                material: proposal.material,
                count: proposal.count,
                ...(proposal.createdAt === undefined
                  ? {}
                  : { createdAt: proposal.createdAt }),
              };
            }
            return acc;
          },
          {} as Record<string, WagerProposal>,
        )
      : undefined;
    const proposedBy = state.proposedBy ? { ...state.proposedBy } : undefined;
    const agreed = state.agreed ? { ...state.agreed } : undefined;
    const resolved = state.resolved ? { ...state.resolved } : undefined;
    return {
      ...state,
      ...(proposals ? { proposals } : {}),
      ...(proposedBy ? { proposedBy } : {}),
      ...(agreed ? { agreed } : {}),
      ...(resolved ? { resolved } : {}),
    };
  }

  private setLocalWagerState(state: MatchWagerState | null): void {
    if (!this.matchId) {
      return;
    }
    this.logWagerDebug("set-local-state", {
      targetMatchId: this.matchId,
      state: summarizeWagerState(state),
    });
    if (this.owner) {
      this.wagers ??= {};
      if (state) this.wagers[this.matchId] = state;
      else delete this.wagers[this.matchId];
    }
    this.dependencies.wagerStore.setWagerState(this.matchId, state);
  }

  private async delay(ms: number): Promise<void> {
    await new Promise<void>((resolve) =>
      this.dependencies.setTimer(resolve, ms),
    );
  }

  private async callWagerApiWithRetry<T extends WagerApiResponse>(
    label: string,
    call: () => Promise<T>,
    maxAttempts = 3,
  ): Promise<T> {
    return retryWagerApi(call, {
      delay: (milliseconds) => this.delay(milliseconds),
      maxAttempts,
      onRetry: (attempt, error) =>
        this.dependencies.log(`${label}:retry`, { attempt, error }),
    });
  }

  private async runWagerMutation<T>(
    action: (tokenProvider: AuthTokenProvider) => Promise<T>,
    requiresSnapshot: boolean,
  ): Promise<T | { ok: false }> {
    const requestedContext = this.activeContext;
    if (requestedContext && this.wagers?.[requestedContext.matchId]?.blocked)
      return { ok: false };
    await this.dependencies.ensureAuthenticated();
    if (requestedContext !== this.activeContext) return { ok: false };
    const context = this.dependencies.requireWritableContext(
      undefined,
      "wager-mutation",
    );
    const poller = this.miningFrozenPoller;
    if (
      !context ||
      !poller ||
      this.inviteWagersSnapshot?.inviteId !== context.inviteId ||
      this.wagerSnapshotNeedsReconciliation ||
      this.wagers?.[context.matchId]?.blocked
    )
      return { ok: false };
    const boundTokenProvider = this.dependencies.getUserBoundAuthTokenProvider(
      context.loginUid,
    );
    const isCurrent = this.createWagerContextGuard(context);
    const assertCurrentUser = () => {
      boundTokenProvider.assertCurrentUser();
      if (!isCurrent()) throw new Error("wager-session-changed");
    };
    const tokenProvider = Object.assign(
      async (forceRefresh: boolean) => {
        assertCurrentUser();
        return boundTokenProvider(forceRefresh);
      },
      { assertCurrentUser },
    );
    try {
      return await poller.runMutation(
        async () => {
          tokenProvider.assertCurrentUser();
          if (
            this.inviteWagersSnapshot?.inviteId !== context.inviteId ||
            this.wagerSnapshotNeedsReconciliation
          )
            return { ok: false as const };
          const finish = this.beginWagerSnapshotMutation(context);
          try {
            return await action(tokenProvider);
          } finally {
            finish();
          }
        },
        { requiresSnapshot, isCurrent },
      );
    } catch (error) {
      if (!isCurrent()) return { ok: false };
      if (isWagerClientUpdateRequired(error)) {
        this.dependencies.onReloadRequired();
      }
      throw error;
    }
  }

  private beginWagerSnapshotMutation(context: MatchRuntimeContext): () => void {
    const mutation = {};
    this.pendingWagerMutations.add(mutation);
    this.wagerSnapshotGeneration += 1;
    this.wagerSnapshotNeedsReconciliation = true;
    this.updateWagerStateForCurrentMatch();
    return () => {
      if (!this.pendingWagerMutations.delete(mutation)) return;
      this.wagerSnapshotGeneration += 1;
      if (
        this.activeContext?.inviteId === context.inviteId &&
        this.activeContext.loginUid === context.loginUid &&
        this.dependencies.auth.currentUser?.uid === context.loginUid
      ) {
        this.inviteWagersSubscription?.channel.requestRefresh();
      }
    };
  }

  private createWagerContextGuard(
    context: MatchRuntimeContext | null,
  ): () => boolean {
    if (!context) return () => false;
    const matchGuard = this.dependencies.createMatchContextGuard(
      context.inviteId,
      context.matchId,
    );
    return () =>
      matchGuard() &&
      this.dependencies.auth.currentUser?.uid === context.loginUid &&
      this.dependencies.getSameProfilePlayerUid() === context.actorUid;
  }

  private applyOptimisticWagerResolution(isWin?: boolean): boolean {
    const writableContext = this.dependencies.requireWritableContext(
      undefined,
      "applyOptimisticWagerResolution",
    );
    if (!writableContext) {
      return false;
    }
    const matchId = writableContext.matchId;
    if (this.optimisticResolvedMatchIds.has(matchId)) {
      return false;
    }
    const state = this.dependencies.wagerStore.getWagerState();
    if (!state) {
      return false;
    }
    const agreed = state.agreed ?? null;
    if (state.resolved || !agreed?.material || typeof isWin !== "boolean") {
      return false;
    }
    const rawCount =
      agreed.count ??
      (agreed.total ? Math.max(0, Math.round(agreed.total / 2)) : 0);
    const count = Math.max(0, Math.round(rawCount));
    const opponentId = this.dependencies.getOpponentId(
      writableContext.actorUid,
    );
    if (!count || !opponentId) {
      return false;
    }
    const winnerId = isWin ? writableContext.actorUid : opponentId;
    const loserId = isWin ? opponentId : writableContext.actorUid;
    const nextState: MatchWagerState = {
      ...state,
      resolved: {
        winnerId,
        loserId,
        material: agreed.material,
        count,
        total: count * 2,
        resolvedAt: this.dependencies.now(),
        optimistic: true,
      },
    };
    delete nextState.proposals;
    this.setLocalWagerState(nextState);
    this.optimisticResolvedMatchIds.add(matchId);
    return true;
  }

  private restoreOptimisticWagerResolution(
    matchId: string,
    previousState: MatchWagerState | null,
    isActive: () => boolean,
    isInviteActive: () => boolean,
  ): void {
    if (!isInviteActive()) return;
    let restored = false;
    const wagers = this.wagers;
    if (wagers?.[matchId]?.resolved?.optimistic) {
      if (previousState) {
        wagers[matchId] = previousState;
      } else {
        delete wagers[matchId];
      }
      restored = true;
    }
    if (
      isActive() &&
      this.dependencies.wagerStore.getWagerState()?.resolved?.optimistic
    ) {
      this.dependencies.wagerStore.setWagerState(matchId, previousState);
      restored = true;
    }
    if (restored) {
      this.optimisticResolvedMatchIds.delete(matchId);
    }
  }

  public async resolveWagerOutcome(
    isWin?: boolean,
  ): Promise<WagerOutcomeResolveResponse | { ok: false }> {
    const writableContext = this.dependencies.requireWritableContext(
      undefined,
      "wagerOutcomeResolve",
    );
    if (!writableContext) return { ok: false };
    if (this.wagers?.[writableContext.matchId]?.blocked)
      return { ok: false, reason: "manual-review-required" };
    const opponentId = this.dependencies.getOpponentId(
      writableContext.actorUid,
    );
    if (!opponentId) return { ok: false };
    const { inviteId, matchId, loginUid } = writableContext;
    const isCurrentSession = this.dependencies.createSessionGuard();
    const profileIdAtRequest = this.dependencies.getProfileId();
    const isCurrentProfile = () =>
      this.dependencies.auth.currentUser?.uid === loginUid &&
      this.dependencies.getProfileId() === profileIdAtRequest;
    const isCurrentInvite = () =>
      isCurrentSession() &&
      isCurrentProfile() &&
      this.activeContext?.inviteId === inviteId;
    const matchGuard = this.createWagerContextGuard(writableContext);
    let finishSnapshotMutation = () => {};
    let restoreOptimisticState = (_state?: MatchWagerState | null) => {};
    try {
      await this.dependencies.ensureAuthenticated();
      if (!isCurrentProfile()) return { ok: false };
      if (isCurrentInvite()) {
        finishSnapshotMutation =
          this.beginWagerSnapshotMutation(writableContext);
      }
      const tokenProvider =
        this.dependencies.getUserBoundAuthTokenProvider(loginUid);
      await this.dependencies.flushPendingMoves(writableContext, {
        requireCurrentContext: false,
      });
      tokenProvider.assertCurrentUser();
      const previousWagerState = matchGuard()
        ? this.cloneWagerState(this.dependencies.wagerStore.getWagerState())
        : null;
      const optimisticApplied =
        matchGuard() && this.applyOptimisticWagerResolution(isWin);
      restoreOptimisticState = (state = previousWagerState) => {
        if (!optimisticApplied) {
          return;
        }
        this.restoreOptimisticWagerResolution(
          matchId,
          state,
          matchGuard,
          isCurrentInvite,
        );
      };
      this.dependencies.log("wager:resolve:start", {
        inviteId,
        matchId,
        opponentId,
      });
      const data = await this.callWagerApiWithRetry("wager:resolve", () =>
        this.dependencies.api.resolveWagerOutcomeViaApi(
          {
            inviteId,
            matchId,
          },
          tokenProvider,
        ),
      );
      const responseData = data;
      this.dependencies.log("wager:resolve:done", responseData);
      if (responseData?.ok === false) {
        restoreOptimisticState();
      } else if (
        responseData &&
        "reason" in responseData &&
        responseData.reason === "no-wager"
      ) {
        restoreOptimisticState(null);
      }
      if (
        responseData?.ok === true &&
        responseData.mining &&
        isCurrentInvite()
      ) {
        this.dependencies.mining.setFromServer(responseData.mining, {
          persist: true,
        });
      }
      return responseData;
    } catch (error) {
      if (!isCurrentProfile()) return { ok: false };
      restoreOptimisticState();
      if (isWagerClientUpdateRequired(error)) {
        this.dependencies.onReloadRequired();
      }
      this.dependencies.logError("Error resolving wager outcome:", error);
      throw error;
    } finally {
      finishSnapshotMutation();
      if (isCurrentProfile()) this.miningFrozenPoller?.refresh();
    }
  }

  public async sendWagerProposal(
    material: MiningMaterialName,
    count: number,
  ): Promise<WagerProposalSendResponse | { ok: false }> {
    return this.runWagerMutation(
      (tokenProvider) =>
        this.performSendWagerProposal(material, count, tokenProvider),
      true,
    );
  }

  private async performSendWagerProposal(
    material: MiningMaterialName,
    count: number,
    tokenProvider: AuthTokenProvider,
  ): Promise<WagerProposalSendResponse | { ok: false }> {
    let prevState: MatchWagerState | null = null;
    let prevFrozen: Record<MiningMaterialName, number> | null = null;
    let optimisticCount = 0;
    let optimisticApplied = false;
    let sessionGuard: (() => boolean) | null = null;
    let playerUid: string | null = null;
    try {
      const writableContext = this.dependencies.requireWritableContext(
        undefined,
        "sendWagerProposal",
      );
      if (!writableContext) {
        return { ok: false };
      }
      const inviteId = writableContext.inviteId;
      const matchId = writableContext.matchId;
      playerUid = writableContext.actorUid;
      if (!playerUid) {
        this.dependencies.log("wager:send:skipped", { inviteId, matchId });
        return { ok: false };
      }
      sessionGuard = this.createWagerContextGuard(writableContext);
      const currentState = this.dependencies.wagerStore.getWagerState();
      if (!currentState?.agreed && !currentState?.resolved) {
        const totalMaterials = this.dependencies.mining.getSnapshot().materials;
        const frozenMaterials =
          this.dependencies.materialStore.getFrozenMaterials();
        const available =
          this.dependencies.materialStore.computeAvailableMaterials(
            totalMaterials,
            frozenMaterials,
          );
        const availableCount = available[material] ?? 0;
        optimisticCount = Math.max(
          0,
          Math.min(Math.round(count), availableCount),
        );
        if (optimisticCount > 0) {
          prevState = this.cloneWagerState(currentState);
          prevFrozen = frozenMaterials;
          const proposals = { ...(currentState?.proposals ?? {}) };
          proposals[playerUid] = {
            material,
            count: optimisticCount,
            createdAt: this.dependencies.now(),
          };
          const proposedBy = { ...(currentState?.proposedBy ?? {}) };
          proposedBy[playerUid] = true;
          const nextState: MatchWagerState = {
            ...(currentState ?? {}),
            proposals,
            proposedBy,
          };
          this.setLocalWagerState(nextState);
          this.dependencies.materialStore.applyFrozenMaterialsDelta({
            [material]: optimisticCount,
          });
          optimisticApplied = true;
        }
      }
      this.dependencies.log("wager:send:start", {
        inviteId,
        matchId,
        material,
        count,
      });
      const data = await this.callWagerApiWithRetry("wager:send", () =>
        this.dependencies.api.sendWagerProposalViaApi(
          { inviteId, matchId, material, count },
          tokenProvider,
        ),
      );
      if (!sessionGuard()) {
        return { ok: false };
      }
      this.dependencies.log("wager:send:done", data);
      if (optimisticApplied) {
        if (data && data.ok === false) {
          const latestState = this.dependencies.wagerStore.getWagerState();
          const proposal = latestState?.proposals
            ? latestState.proposals[playerUid]
            : null;
          const shouldRollback =
            !!proposal &&
            proposal.material === material &&
            proposal.count === optimisticCount &&
            !latestState?.agreed &&
            !latestState?.resolved;
          if (shouldRollback) {
            this.setLocalWagerState(prevState);
            if (prevFrozen) {
              this.dependencies.materialStore.setFrozenMaterials(prevFrozen);
            }
          }
        } else if (data && data.agreed) {
          const agreed: WagerAgreement = data.agreed;
          const latestState = this.dependencies.wagerStore.getWagerState();
          if (!latestState?.resolved) {
            const nextState: MatchWagerState = {
              ...(latestState ?? {}),
              agreed,
            };
            delete nextState.proposals;
            this.setLocalWagerState(nextState);
            const delta = agreed.count - optimisticCount;
            if (delta !== 0) {
              this.dependencies.materialStore.applyFrozenMaterialsDelta({
                [material]: delta,
              });
            }
          }
        } else if (data && typeof data.count === "number") {
          const serverCount = Math.max(0, Math.round(data.count));
          if (serverCount !== optimisticCount) {
            const latestState = this.dependencies.wagerStore.getWagerState();
            const proposal = latestState?.proposals
              ? latestState.proposals[playerUid]
              : null;
            if (
              proposal &&
              proposal.material === material &&
              proposal.count === optimisticCount &&
              !latestState?.agreed &&
              !latestState?.resolved
            ) {
              const proposals = { ...(latestState?.proposals ?? {}) };
              proposals[playerUid] = { ...proposal, count: serverCount };
              const nextState: MatchWagerState = {
                ...(latestState ?? {}),
                proposals,
              };
              this.setLocalWagerState(nextState);
              const delta = serverCount - optimisticCount;
              if (delta !== 0) {
                this.dependencies.materialStore.applyFrozenMaterialsDelta({
                  [material]: delta,
                });
              }
            }
          }
        }
      }
      return data;
    } catch (error) {
      this.dependencies.logError("wager:send:error", error);
      if (sessionGuard && !sessionGuard()) {
        return { ok: false };
      }
      if (optimisticApplied) {
        const latestState = this.dependencies.wagerStore.getWagerState();
        const proposal =
          latestState?.proposals && playerUid
            ? latestState.proposals[playerUid]
            : null;
        const shouldRollback =
          !!proposal &&
          proposal.material === material &&
          proposal.count === optimisticCount &&
          !latestState?.agreed &&
          !latestState?.resolved;
        if (shouldRollback) {
          this.setLocalWagerState(prevState);
          if (prevFrozen) {
            this.dependencies.materialStore.setFrozenMaterials(prevFrozen);
          }
        }
      }
      throw error;
    }
  }

  public async cancelWagerProposal(): Promise<
    WagerProposalRemovalResponse | { ok: false }
  > {
    return this.runWagerMutation(
      (tokenProvider) => this.performCancelWagerProposal(tokenProvider),
      false,
    );
  }

  private async performCancelWagerProposal(
    tokenProvider: AuthTokenProvider,
  ): Promise<WagerProposalRemovalResponse | { ok: false }> {
    let prevState: MatchWagerState | null = null;
    let prevFrozen: Record<MiningMaterialName, number> | null = null;
    let optimisticApplied = false;
    let proposal: WagerProposal | null = null;
    let sessionGuard: (() => boolean) | null = null;
    let playerUid: string | null = null;
    try {
      const writableContext = this.dependencies.requireWritableContext(
        undefined,
        "cancelWagerProposal",
      );
      if (!writableContext) {
        return { ok: false };
      }
      const inviteId = writableContext.inviteId;
      const matchId = writableContext.matchId;
      playerUid = writableContext.actorUid;
      if (!playerUid) {
        this.dependencies.log("wager:cancel:skipped", { inviteId, matchId });
        return { ok: false };
      }
      sessionGuard = this.createWagerContextGuard(writableContext);
      const currentState = this.dependencies.wagerStore.getWagerState();
      const existingProposal = currentState?.proposals
        ? currentState.proposals[playerUid]
        : null;
      if (
        existingProposal &&
        !currentState?.agreed &&
        !currentState?.resolved
      ) {
        prevState = this.cloneWagerState(currentState);
        prevFrozen = this.dependencies.materialStore.getFrozenMaterials();
        proposal = existingProposal;
        const proposals = { ...(currentState?.proposals ?? {}) };
        delete proposals[playerUid];
        const nextState: MatchWagerState = {
          ...(currentState ?? {}),
          proposals,
        };
        if (Object.keys(proposals).length === 0) delete nextState.proposals;
        this.setLocalWagerState(nextState);
        this.dependencies.materialStore.applyFrozenMaterialsDelta({
          [proposal.material]: -proposal.count,
        });
        optimisticApplied = true;
      }
      this.dependencies.log("wager:cancel:start", { inviteId, matchId });
      const data = await this.callWagerApiWithRetry("wager:cancel", () =>
        this.dependencies.api.cancelWagerProposalViaApi(
          { inviteId, matchId },
          tokenProvider,
        ),
      );
      if (!sessionGuard()) {
        return { ok: false };
      }
      this.dependencies.log("wager:cancel:done", data);
      if (optimisticApplied && data && data.ok === false) {
        const latestState = this.dependencies.wagerStore.getWagerState();
        const hasAgreedOrResolved =
          !!latestState?.agreed || !!latestState?.resolved;
        const stillMissing =
          !latestState?.proposals || !latestState.proposals[playerUid];
        if (!hasAgreedOrResolved && stillMissing) {
          this.setLocalWagerState(prevState);
          if (prevFrozen) {
            this.dependencies.materialStore.setFrozenMaterials(prevFrozen);
          }
        }
      }
      return data;
    } catch (error) {
      this.dependencies.logError("wager:cancel:error", error);
      if (sessionGuard && !sessionGuard()) {
        return { ok: false };
      }
      if (optimisticApplied) {
        const latestState = this.dependencies.wagerStore.getWagerState();
        const hasAgreedOrResolved =
          !!latestState?.agreed || !!latestState?.resolved;
        const stillMissing =
          !latestState?.proposals ||
          (playerUid ? !latestState.proposals[playerUid] : true);
        if (!hasAgreedOrResolved && stillMissing) {
          this.setLocalWagerState(prevState);
          if (prevFrozen) {
            this.dependencies.materialStore.setFrozenMaterials(prevFrozen);
          }
        }
      }
      throw error;
    }
  }

  public async declineWagerProposal(): Promise<
    WagerProposalRemovalResponse | { ok: false }
  > {
    return this.runWagerMutation(
      (tokenProvider) => this.performDeclineWagerProposal(tokenProvider),
      false,
    );
  }

  private async performDeclineWagerProposal(
    tokenProvider: AuthTokenProvider,
  ): Promise<WagerProposalRemovalResponse | { ok: false }> {
    let prevState: MatchWagerState | null = null;
    let optimisticApplied = false;
    let opponentUid: string | null = null;
    let sessionGuard: (() => boolean) | null = null;
    let playerUid: string | null = null;
    try {
      const writableContext = this.dependencies.requireWritableContext(
        undefined,
        "declineWagerProposal",
      );
      if (!writableContext) {
        return { ok: false };
      }
      const inviteId = writableContext.inviteId;
      const matchId = writableContext.matchId;
      playerUid = writableContext.actorUid;
      if (!playerUid) {
        this.dependencies.log("wager:decline:skipped", { inviteId, matchId });
        return { ok: false };
      }
      sessionGuard = this.createWagerContextGuard(writableContext);
      opponentUid = this.dependencies.getOpponentId(playerUid);
      const currentState = this.dependencies.wagerStore.getWagerState();
      const existingProposal =
        opponentUid && currentState?.proposals
          ? currentState.proposals[opponentUid]
          : null;
      if (
        existingProposal &&
        !currentState?.agreed &&
        !currentState?.resolved
      ) {
        prevState = this.cloneWagerState(currentState);
        const proposals = { ...(currentState?.proposals ?? {}) };
        delete proposals[opponentUid];
        const nextState: MatchWagerState = {
          ...(currentState ?? {}),
          proposals,
        };
        if (Object.keys(proposals).length === 0) delete nextState.proposals;
        this.setLocalWagerState(nextState);
        optimisticApplied = true;
      }
      this.dependencies.log("wager:decline:start", { inviteId, matchId });
      const data = await this.callWagerApiWithRetry("wager:decline", () =>
        this.dependencies.api.declineWagerProposalViaApi(
          { inviteId, matchId },
          tokenProvider,
        ),
      );
      if (!sessionGuard()) {
        return { ok: false };
      }
      this.dependencies.log("wager:decline:done", data);
      if (optimisticApplied && data && data.ok === false) {
        const latestState = this.dependencies.wagerStore.getWagerState();
        const hasAgreedOrResolved =
          !!latestState?.agreed || !!latestState?.resolved;
        const stillMissing =
          !latestState?.proposals ||
          (opponentUid && !latestState.proposals[opponentUid]);
        if (!hasAgreedOrResolved && stillMissing) {
          this.setLocalWagerState(prevState);
        }
      }
      return data;
    } catch (error) {
      this.dependencies.logError("wager:decline:error", error);
      if (sessionGuard && !sessionGuard()) {
        return { ok: false };
      }
      if (optimisticApplied) {
        const latestState = this.dependencies.wagerStore.getWagerState();
        const hasAgreedOrResolved =
          !!latestState?.agreed || !!latestState?.resolved;
        const stillMissing =
          !latestState?.proposals ||
          (opponentUid && !latestState.proposals[opponentUid]);
        if (!hasAgreedOrResolved && stillMissing) {
          this.setLocalWagerState(prevState);
        }
      }
      throw error;
    }
  }

  public async acceptWagerProposal(): Promise<
    WagerProposalAcceptResponse | { ok: false }
  > {
    return this.runWagerMutation(
      (tokenProvider) => this.performAcceptWagerProposal(tokenProvider),
      true,
    );
  }

  private async performAcceptWagerProposal(
    tokenProvider: AuthTokenProvider,
  ): Promise<WagerProposalAcceptResponse | { ok: false }> {
    let prevState: MatchWagerState | null = null;
    let prevFrozen: Record<MiningMaterialName, number> | null = null;
    let optimisticApplied = false;
    let optimisticAgreement: WagerAgreement | null = null;
    let opponentUid: string | null = null;
    let sessionGuard: (() => boolean) | null = null;
    try {
      const writableContext = this.dependencies.requireWritableContext(
        undefined,
        "acceptWagerProposal",
      );
      if (!writableContext) {
        return { ok: false };
      }
      const inviteId = writableContext.inviteId;
      const matchId = writableContext.matchId;
      if (!writableContext.actorUid) {
        this.dependencies.log("wager:accept:skipped", { inviteId, matchId });
        return { ok: false };
      }
      sessionGuard = this.createWagerContextGuard(writableContext);
      const playerUid = writableContext.actorUid;
      opponentUid = this.dependencies.getOpponentId(playerUid);
      const currentState = this.dependencies.wagerStore.getWagerState();
      const proposals = currentState?.proposals ?? null;
      const opponentProposal =
        opponentUid && proposals ? proposals[opponentUid] : null;
      const ownProposal = playerUid && proposals ? proposals[playerUid] : null;
      if (
        opponentProposal &&
        !currentState?.agreed &&
        !currentState?.resolved
      ) {
        const totalMaterials = this.dependencies.mining.getSnapshot().materials;
        const frozenMaterials =
          this.dependencies.materialStore.getFrozenMaterials();
        const available =
          this.dependencies.materialStore.computeAvailableMaterials(
            totalMaterials,
            frozenMaterials,
          );
        const opponentCount = Math.max(0, Math.round(opponentProposal.count));
        const extraAvailable =
          ownProposal && ownProposal.material === opponentProposal.material
            ? Math.max(0, Math.round(ownProposal.count))
            : 0;
        const acceptedCount = Math.min(
          opponentCount,
          (available[opponentProposal.material] ?? 0) + extraAvailable,
        );
        if (acceptedCount > 0) {
          prevState = this.cloneWagerState(currentState);
          prevFrozen = frozenMaterials;
          optimisticAgreement = {
            material: opponentProposal.material,
            count: acceptedCount,
            total: acceptedCount * 2,
            proposerId: opponentUid,
            accepterId: playerUid,
            acceptedAt: this.dependencies.now(),
          };
          const nextState: MatchWagerState = {
            ...(currentState ?? {}),
            agreed: optimisticAgreement,
          };
          delete nextState.proposals;
          this.setLocalWagerState(nextState);
          const deltas: Partial<Record<MiningMaterialName, number>> = {};
          if (ownProposal) {
            const ownCount = Math.max(0, Math.round(ownProposal.count));
            if (ownCount > 0) {
              deltas[ownProposal.material] =
                (deltas[ownProposal.material] ?? 0) - ownCount;
            }
          }
          deltas[opponentProposal.material] =
            (deltas[opponentProposal.material] ?? 0) + acceptedCount;
          this.dependencies.materialStore.applyFrozenMaterialsDelta(deltas);
          optimisticApplied = true;
        }
      }
      this.dependencies.log("wager:accept:start", { inviteId, matchId });
      const data = await this.callWagerApiWithRetry("wager:accept", () =>
        this.dependencies.api.acceptWagerProposalViaApi(
          { inviteId, matchId },
          tokenProvider,
        ),
      );
      if (!sessionGuard()) {
        return { ok: false };
      }
      this.dependencies.log("wager:accept:done", data);
      if (optimisticApplied && optimisticAgreement) {
        if (data && data.ok === false) {
          const latestState = this.dependencies.wagerStore.getWagerState();
          const agreed = latestState?.agreed;
          const shouldRollback =
            !!agreed &&
            !latestState?.resolved &&
            agreed.material === optimisticAgreement.material &&
            agreed.count === optimisticAgreement.count &&
            agreed.proposerId === optimisticAgreement.proposerId &&
            agreed.accepterId === optimisticAgreement.accepterId;
          if (shouldRollback) {
            this.setLocalWagerState(prevState);
            if (prevFrozen) {
              this.dependencies.materialStore.setFrozenMaterials(prevFrozen);
            }
          }
        } else if (data && typeof data.count === "number") {
          const serverCount = Math.max(0, Math.round(data.count));
          if (serverCount !== optimisticAgreement.count) {
            const latestState = this.dependencies.wagerStore.getWagerState();
            const agreed = latestState?.agreed;
            if (
              agreed &&
              !latestState?.resolved &&
              agreed.material === optimisticAgreement.material &&
              agreed.proposerId === optimisticAgreement.proposerId &&
              agreed.accepterId === optimisticAgreement.accepterId
            ) {
              const nextAgreed = {
                ...agreed,
                count: serverCount,
                total: serverCount * 2,
              };
              const nextState: MatchWagerState = {
                ...(latestState ?? {}),
                agreed: nextAgreed,
              };
              this.setLocalWagerState(nextState);
              const delta = serverCount - optimisticAgreement.count;
              if (delta !== 0) {
                this.dependencies.materialStore.applyFrozenMaterialsDelta({
                  [optimisticAgreement.material]: delta,
                });
              }
            }
          }
        }
      }
      return data;
    } catch (error) {
      this.dependencies.logError("wager:accept:error", error);
      if (sessionGuard && !sessionGuard()) {
        return { ok: false };
      }
      if (optimisticApplied && optimisticAgreement) {
        const latestState = this.dependencies.wagerStore.getWagerState();
        const agreed = latestState?.agreed;
        const shouldRollback =
          !!agreed &&
          !latestState?.resolved &&
          agreed.material === optimisticAgreement.material &&
          agreed.count === optimisticAgreement.count &&
          agreed.proposerId === optimisticAgreement.proposerId &&
          agreed.accepterId === optimisticAgreement.accepterId;
        if (shouldRollback) {
          this.setLocalWagerState(prevState);
          if (prevFrozen) {
            this.dependencies.materialStore.setFrozenMaterials(prevFrozen);
          }
        }
      }
      throw error;
    }
  }

  public setWagerViewMatchId(matchId: string | null): void {
    this.wagerViewMatchId = matchId;
    this.logWagerDebug("set-view-match", { nextViewMatchId: matchId });
    this.updateWagerStateForCurrentMatch();
  }

  public updateWagerStateForCurrentMatch() {
    const targetMatchId = this.wagerViewMatchId ?? this.matchId;
    if (!targetMatchId) {
      this.dependencies.wagerStore.syncCurrentWagerMatchState(null, null);
      this.logWagerDebug("publish-state:clear-no-target");
      return;
    }
    const wagers = this.wagers;
    const matchWagerState =
      wagers && wagers[targetMatchId] ? wagers[targetMatchId] : null;
    this.logWagerDebug("publish-state", {
      targetMatchId,
      availableMatchIds: wagers ? Object.keys(wagers) : [],
      state: summarizeWagerState(matchWagerState),
    });
    this.dependencies.wagerStore.syncCurrentWagerMatchState(
      targetMatchId,
      matchWagerState,
      this.inviteWagersSnapshot?.inviteId === this.inviteId &&
        !this.wagerSnapshotNeedsReconciliation,
    );
  }

  public observeWagers(
    context: MatchRuntimeContext | null = this.activeContext,
  ): void {
    if (!context) return;
    if (this.inviteWagersSubscription?.contextId === context.contextId) return;
    this.cleanupWagerObserver();
    const key = `invite-wagers:${context.inviteId}`;
    const isActive = () =>
      this.dependencies.isContextActive(
        context.contextId,
        context.sessionEpoch,
      ) && this.dependencies.isCurrentAuthUser(context.loginUid);
    const channel = this.createWagerChannel({
      inviteId: context.inviteId,
      createSocket: (url, protocols) =>
        this.dependencies.createSocket(url, protocols),
      getTokenRemainingMs: (token) =>
        this.dependencies.auth.getTokenRemainingMs(token),
      getProtocols: async (forceRefresh) => {
        const tokenProvider = this.dependencies.getUserBoundAuthTokenProvider(
          context.loginUid,
        );
        const token = await tokenProvider(forceRefresh);
        tokenProvider.assertCurrentUser();
        return createInviteWagersSocketProtocols(token);
      },
      readWagers: (signal) =>
        this.dependencies.api.readInviteWagersViaApi(
          context.inviteId,
          this.dependencies.getUserBoundAuthTokenProvider(context.loginUid),
          { signal },
        ),
      captureGeneration: () => this.wagerSnapshotGeneration,
      needsHttpRefresh: () => this.wagerSnapshotNeedsReconciliation,
      isActive,
      isOnline: () => this.dependencies.isOnline(),
      isVisible: this.dependencies.isVisible,
      addWakeListener: this.dependencies.addWakeListener,
      onSnapshot: (snapshot, delivery) => {
        if (!isActive() || snapshot.inviteId !== context.inviteId) return;
        this.wagerSnapshotRevisionFloor = Math.max(
          this.wagerSnapshotRevisionFloor,
          snapshot.revision,
        );
        if (
          !this.owner ||
          this.pendingWagerMutations.size > 0 ||
          delivery.requestGeneration !== this.wagerSnapshotGeneration ||
          snapshot.revision < this.wagerSnapshotRevisionFloor ||
          (this.wagerSnapshotNeedsReconciliation &&
            delivery.source !== "http") ||
          (!this.wagerSnapshotNeedsReconciliation &&
            snapshot.revision === this.inviteWagersSnapshot?.revision)
        ) {
          return;
        }
        this.inviteWagersSnapshot = snapshot;
        this.wagerSnapshotNeedsReconciliation = false;
        this.wagers = { ...snapshot.wagers };
        this.logWagerDebug("observe-wagers:update", {
          availableMatchIds: Object.keys(snapshot.wagers),
          revision: snapshot.revision,
        });
        this.updateWagerStateForCurrentMatch();
        this.dependencies.onInitialWagers();
        this.miningFrozenPoller?.refresh();
      },
      onError: (error) =>
        this.dependencies.logError("Error receiving invite wagers:", error),
      setTimer: (callback, delayMs) =>
        this.dependencies.setTimer(callback, delayMs),
      clearTimer: (timer) => this.dependencies.clearTimer(timer),
      random: this.dependencies.random,
    });
    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      channel.stop();
      this.dependencies.unregisterObserverCleanup(context.contextId, key);
      if (this.inviteWagersSubscription?.channel === channel) {
        this.inviteWagersSubscription = null;
      }
      this.dependencies.changeObserverCount(-1);
    };
    if (
      !this.dependencies.registerObserverCleanup(context.contextId, key, stop)
    ) {
      channel.stop();
      return;
    }
    this.inviteWagersSubscription = {
      contextId: context.contextId,
      channel,
      stop,
    };
    this.dependencies.changeObserverCount(1);
  }

  public cleanupWagerObserver() {
    this.inviteWagersSubscription?.stop();
  }

  public observeMiningFrozen(uid: string | null) {
    if (this.miningFrozenPoller) {
      this.miningFrozenPoller.stop();
      this.miningFrozenPoller = null;
      this.miningFrozenLoginUid = null;
      this.dependencies.changeObserverCount(-1);
    }
    this.dependencies.materialStore.setFrozenMaterials(
      null,
      uid ? "loading" : "idle",
    );
    if (!uid) return;
    const observeEpoch = this.dependencies.getSessionEpoch();
    const loginUid = this.dependencies.auth.currentUser?.uid;
    if (!loginUid) return;
    this.miningFrozenLoginUid = loginUid;
    this.miningFrozenPoller = this.createFrozenPoller({
      playerUid: uid,
      addVisibilityListener: this.dependencies.addVisibilityListener,
      addOnlineListener: this.dependencies.addOnlineListener,
      clearTimer: (timer) => this.dependencies.clearTimer(timer),
      isActive: () =>
        this.dependencies.isSessionEpochActive(observeEpoch) &&
        this.dependencies.getSameProfilePlayerUid() === uid &&
        this.dependencies.auth.currentUser?.uid === loginUid,
      isVisible: this.dependencies.isVisible,
      load: (signal) =>
        this.dependencies.api.readWagerFrozenViaApi(
          { playerUid: uid },
          this.dependencies.getUserBoundAuthTokenProvider(loginUid),
          { signal },
        ),
      onPending: () =>
        this.dependencies.materialStore.setFrozenMaterialsStatus(
          this.dependencies.materialStore.getFrozenMaterialsStatus() ===
            "loading"
            ? "loading"
            : "updating",
        ),
      onSnapshot: (snapshot) =>
        this.dependencies.materialStore.setFrozenMaterials(
          snapshot.frozen,
          "ready",
        ),
      onError: (_error, confirmed, refreshRequired) =>
        this.dependencies.materialStore.setFrozenMaterials(
          confirmed?.frozen,
          confirmed && !refreshRequired ? "ready" : "unavailable",
        ),
      setTimer: (callback, delayMs) =>
        this.dependencies.setTimer(callback, delayMs),
    });
    this.dependencies.changeObserverCount(1);
  }
}
