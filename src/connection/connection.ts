import { initializeApp, FirebaseApp } from "firebase/app";
import {
  getAuth,
  Auth,
  signInAnonymously,
  onAuthStateChanged,
  signOut,
} from "firebase/auth";
import {
  getDatabase,
  Database,
  ref,
  set,
  onValue,
  off,
  get,
  runTransaction,
} from "firebase/database";
import {
  didFindInviteThatCanBeJoined,
  didReceiveInviteReactionUpdate,
  didReceiveMatchUpdate,
  didRecoverInviteReactions,
  didRecoverMyMatch,
  enterWatchOnlyMode,
  didFindYourOwnInviteThatNobodyJoined,
  didReceiveRematchesSeriesEndIndicator,
  didDiscoverExistingRematchProposalWaitingForResponse,
  didJustCreateRematchProposalSuccessfully,
  failedToCreateRematchProposal,
  didUpdateRematchSeriesMetadata,
  didFailToLoadPendingInvite,
} from "../game/gameController";
import {
  getPlayersEmojiId,
  didGetPlayerProfile,
  setupPlayerId,
} from "../game/board";
import {
  Match,
  Invite,
  InviteReaction,
  Reaction,
  PlayerProfile,
  PlayerMiningMaterials,
  MINING_MATERIAL_NAMES,
  MiningMaterialName,
  MatchWagerState,
  WagerProposal,
  WagerAgreement,
  RematchSeriesDescriptor,
  HistoricalMatchPair,
  NavigationGameItem,
  NavigationItem,
  EventRecord,
  EventPrizeId,
  EventPrizeSelections,
  EventPrizeWithdrawalResponse,
  ProfileEventPrizes,
} from "./connectionModels";
import {
  resolvePlayerProfile,
  resolvePlayerProfileWithRetry,
} from "./playerProfileLookup";
import { storage } from "../utils/storage";
import { generateNewInviteId } from "../utils/misc";
import {
  getWagerState,
  setCurrentWagerMatch,
  setWagerState,
  syncCurrentWagerMatchState,
} from "../game/wagerState";
import {
  applyFrozenMaterialsDelta,
  computeAvailableMaterials,
  getFrozenMaterials,
  setFrozenMaterials,
} from "../services/wagerMaterialsService";
import { rocksMiningService } from "../services/rocksMiningService";
import { mineRockViaApi } from "../services/miningApi";
import { withdrawEventPrizeViaApi } from "../services/eventPrizeApi";
import {
  editUsernameViaApi,
  getProfileByIdViaApi,
  getProfileByLoginIdViaApi,
  readLeaderboardViaApi,
  updateProfileCustomizationViaApi,
} from "../services/profileApi";
import {
  acceptWagerProposalViaApi,
  cancelAutomatchViaApi,
  cancelWagerProposalViaApi,
  claimMatchVictoryByTimerViaApi,
  createInviteViaApi,
  createEventViaApi,
  declineWagerProposalViaApi,
  disqualifyEventMatchWinnersViaApi,
  endRematchViaApi,
  ensureMatchViaApi,
  joinEventViaApi,
  joinInviteViaApi,
  removeEventParticipantViaApi,
  removeNavigationGameViaApi,
  readNavigationGamesViaApi,
  resolveWagerOutcomeViaApi,
  sendWagerProposalViaApi,
  startAutomatchViaApi,
  startMatchTimerViaApi,
  syncEventStateViaApi,
  toggleEventPrizeSelectionViaApi,
  updateRatingsViaApi,
  postponeEventStartViaApi,
  proposeRematchViaApi,
} from "../services/gameplayApi";
import { compareNavigationItems as compareNavigationItemsByDisplayOrder } from "../services/navigationItemOrdering";
import { resetNftCache } from "../services/nftCache";
import { resetPlayerMetadataCaches } from "../utils/playerMetadataCache";
import { resetLeaderboardCache } from "../ui/leaderboardCache";
import { RouteState, getCurrentRouteState } from "../navigation/routeState";
import {
  decrementLifecycleCounter,
  incrementLifecycleCounter,
} from "../lifecycle/lifecycleDiagnostics";
import type { MineRockResponse } from "@mons/shared/mining";
import {
  createInviteCandidatesFromMatchId,
  deriveLatestMatchId,
  parseInviteMatchIndex,
  parseRematchIndices,
  rematchSeriesEnded,
} from "@mons/shared/rematches";
import {
  getNavigationSortBucket,
  normalizeStrictAutomatchStateHint,
  type NavigationGamesCursor,
  type StartAutomatchResponse,
} from "@mons/shared/navigation";
import { isAutoInviteId } from "@mons/shared/ids";
import type {
  EventCreateDateTimePayload,
  EventScheduleTimezone as SharedEventScheduleTimezone,
} from "@mons/shared/events";
import {
  normalizeAuthPresentation,
  type AuthMethodKey,
} from "@mons/shared/auth";
import type {
  XConsentSource,
  XRedirectStartResponse,
} from "@mons/shared/x-redirect";
import type {
  AuthVerificationResponse,
  AuthIntentResponse,
  LinkedAuthMethodsResponse,
} from "@mons/shared/auth";
import type {
  ClaimMatchVictoryByTimerResponse,
  StartMatchTimerResponse,
} from "@mons/shared/timers";
import { isToggleEventPrizeSelectionRequest } from "@mons/shared/event-prizes";
import type { ProfileCustomizationUpdateRequest } from "@mons/shared/profiles";
import type {
  WagerOutcomeResolveResponse,
  WagerProposalAcceptResponse,
  WagerProposalRemovalResponse,
  WagerProposalSendResponse,
} from "@mons/shared/wagers";
import type { RatingUpdateResponse } from "@mons/shared/ratings";
import {
  beginAuthIntentViaApi,
  beginXRedirectAuthViaApi,
  bindAuthSessionResult,
  completeXRedirectAuthViaApi,
  createUserBoundAuthTokenProvider,
  getLinkedAuthMethodsViaApi,
  syncProfileClaimViaApi,
  unlinkAuthMethodViaApi,
  verifyAppleTokenViaApi,
  verifyEthereumAddressViaApi,
  verifySolanaAddressViaApi,
  type AuthSessionBoundResult,
  type AuthTokenProvider,
} from "../services/authApi";
import {
  mapDatabaseEventRecord,
  mapEventPrizeAssignment,
  normalizeEventPrizeId,
} from "./eventMappers";
import {
  normalizeFiniteNumber,
  normalizeString,
  normalizeStringOrNull,
} from "./valueNormalizers";
import { ObserverRegistry } from "./observerRegistry";
import { transition } from "../session/sessionTransitionPort";
import { startNavigationGamesPolling } from "./navigationGamesPoller";

const getStoredAuthPresentation = (): {
  emoji: number;
  aura: string | null;
} => {
  return normalizeAuthPresentation(
    storage.getPlayerEmojiId("1"),
    storage.getPlayerEmojiAura(""),
  );
};

const LEADERBOARD_ENTRY_LIMIT = 99;
const wagerDebugLogsEnabled = import.meta.env.DEV;
const EVENT_SYNC_COOLDOWN_ACTIVE_MS = 700;
const EVENT_SYNC_COOLDOWN_SCHEDULED_MS = 1500;
const EVENT_SYNC_PARTICIPANT_CACHE_TTL_MS = 3000;
const EVENT_SYNC_PARTICIPANT_NEGATIVE_CACHE_TTL_MS = 800;
const EVENT_SYNC_RETRY_DELAYS_MS = [150, 300] as const;
const PROFILE_LOOKUP_RETRY_DELAY_MS = 1_000;
const NAVIGATION_GAMES_POLL_INTERVAL_MS = 5_000;
const NAVIGATION_GAMES_MAX_CONSECUTIVE_FAILURES = 3;

export type EventScheduleTimezone = SharedEventScheduleTimezone;
export type { EventCreateDateTimePayload } from "@mons/shared/events";

type EventCreateOptions = {
  announceOnTelegram?: boolean;
};

export type NavigationGamesPageCursor = NavigationGamesCursor | null;

interface NavigationGamesPageResult {
  items: NavigationItem[];
  nextCursor: NavigationGamesPageCursor;
  hasMore: boolean;
}

type WagerApiResponse =
  | WagerOutcomeResolveResponse
  | WagerProposalAcceptResponse
  | WagerProposalRemovalResponse
  | WagerProposalSendResponse;

type InviteRole = "host" | "guest" | "watch";

type MatchRuntimeContext = {
  contextId: number;
  sessionEpoch: number;
  inviteId: string;
  matchId: string;
  loginUid: string;
  actorUid: string | null;
  role: InviteRole;
  canWrite: boolean;
  createdAtMs: number;
};

type EventSyncSkipReason = "locked" | "rate-limited" | "not-participant";

type EventSyncResponse = {
  ok: boolean;
  didChange?: boolean;
  skipped?: boolean;
  reason?: EventSyncSkipReason;
  event?: EventRecord | null;
};

type EventSyncParticipantMembershipCacheEntry = {
  profileId: string;
  checkedAtMs: number;
  isParticipant: boolean;
};

type EventSyncCooldownCacheEntry = {
  responseAtMs: number;
  response: EventSyncResponse;
};

const getRouteStateSnapshot = () => getCurrentRouteState();
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

class Connection {
  private app: FirebaseApp;
  private auth: Auth;
  private db: Database;

  private hostRematchesRef: any = null;
  private guestRematchesRef: any = null;
  private wagersRef: any = null;
  private inviteReactionsRef: any = null;
  private miningFrozenRef: any = null;
  private matchRefs: { [key: string]: any } = {};
  private profileObserverCleanups = new Map<string, () => void>();
  private observerRegistry = new ObserverRegistry(
    (contextId, sessionEpoch) => this.isContextActive(contextId, sessionEpoch),
    (reason, contextId) => {
      this.logContextEvent("ctx.dispose", { reason, contextId });
    },
  );

  private loginUid: string | null = null;
  private sameProfilePlayerUid: string | null = null;
  private sameProfileHydrationRequest: {
    uid: string;
    sessionEpoch: number;
    refreshRequested: boolean;
  } | null = null;
  private optimisticResolvedMatchIds = new Set<string>();

  private latestInvite: Invite | null = null;
  private myMatch: Match | null = null;
  private observedMatchSnapshots: Map<string, Match> = new Map();
  private inviteId: string | null = null;
  private matchId: string | null = null;
  private wagerViewMatchId: string | null = null;
  private activeContext: MatchRuntimeContext | null = null;
  private nextContextId = 1;
  private connectAttemptId = 0;

  private newInviteId = "";
  private didCreateNewGameInvite = false;
  private currentUid: string | null = "";
  private sessionEpoch = 0;
  private authUnsubscribers = new Set<() => void>();
  private authBootstrapPromise: Promise<void> | null = null;
  private navigationGamesRefreshListeners = new Set<() => void>();
  private pendingInviteCreation: {
    inviteId: string;
    promise: Promise<boolean>;
  } | null = null;
  private pendingRematchProposal: {
    contextId: number;
    inviteId: string;
    operationId: string;
  } | null = null;
  private inFlightEventSyncById = new Map<string, Promise<EventSyncResponse>>();
  private eventSyncParticipantCacheById = new Map<
    string,
    EventSyncParticipantMembershipCacheEntry
  >();
  private eventSyncCooldownCacheById = new Map<
    string,
    EventSyncCooldownCacheEntry
  >();
  private latestObservedEventById = new Map<string, EventRecord | null>();
  private activeEventSubscriptionsById = new Map<string, number>();
  private moveSendRequestId = 0;
  private readonly moveSendRetryWindowMs = 60000;
  private readonly moveSendAttemptMaxTimeoutMs = 20000;
  private readonly moveSendPostRetryVerificationWindowMs = 3500;
  private readonly moveSendPostRetryPollIntervalMs = 350;
  private moveReconnectInFlight = false;
  private moveReconnectLastAttemptAt = 0;
  private readonly moveReconnectCooldownMs = 3000;

  private logContextEvent(
    event: string,
    payload: Record<string, unknown> = {},
  ): void {
    if (import.meta.env.PROD) {
      return;
    }
    console.log(event, payload);
  }

  private beginConnectAttempt(): number {
    this.connectAttemptId += 1;
    return this.connectAttemptId;
  }

  private isConnectAttemptActive(
    connectAttemptId: number,
    epoch: number,
  ): boolean {
    if (!this.isSessionEpochActive(epoch)) {
      return false;
    }
    const isActive = this.connectAttemptId === connectAttemptId;
    if (!isActive && import.meta.env.DEV) {
      this.logContextEvent("ctx.callback.stale_dropped", {
        reason: "connect-attempt-mismatch",
        expectedConnectAttemptId: connectAttemptId,
        currentConnectAttemptId: this.connectAttemptId,
        expectedEpoch: epoch,
        currentEpoch: this.sessionEpoch,
      });
    }
    return isActive;
  }

  private isContextActive(contextId: number, epoch: number): boolean {
    if (!this.isSessionEpochActive(epoch)) {
      return false;
    }
    const activeContext = this.activeContext;
    const isActive =
      !!activeContext &&
      activeContext.contextId === contextId &&
      activeContext.sessionEpoch === epoch;
    if (!isActive && import.meta.env.DEV) {
      this.logContextEvent("ctx.callback.stale_dropped", {
        reason: "context-mismatch",
        expectedContextId: contextId,
        currentContextId: activeContext?.contextId ?? null,
        expectedEpoch: epoch,
        currentEpoch: this.sessionEpoch,
      });
    }
    return isActive;
  }

  private registerObserverCleanup(
    contextId: number,
    key: string,
    cleanup: () => void,
  ): boolean {
    return this.observerRegistry.register(contextId, key, cleanup);
  }

  private unregisterObserverCleanup(contextId: number, key: string): void {
    this.observerRegistry.unregister(contextId, key);
  }

  private observeContextValue(
    context: MatchRuntimeContext,
    key: string,
    targetRef: any,
    onData: (snapshot: any) => void,
    onError?: (error: unknown) => void,
    onCleanup?: () => void,
  ): (() => void) | null {
    return this.observerRegistry.observe(
      context,
      key,
      targetRef,
      onData,
      onError,
      onCleanup,
    );
  }

  private cleanupObserverContext(contextId: number, reason: string): void {
    this.observerRegistry.cleanupContext(contextId, reason);
  }

  private clearAllObserverContexts(reason: string): void {
    this.observerRegistry.clear(reason);
  }

  private buildRuntimeContext(
    inviteId: string,
    matchId: string,
    loginUid: string,
    actorUid: string | null,
    role: InviteRole,
    canWrite: boolean,
    epoch: number,
  ): MatchRuntimeContext {
    return {
      contextId: this.nextContextId++,
      sessionEpoch: epoch,
      inviteId,
      matchId,
      loginUid,
      actorUid,
      role,
      canWrite,
      createdAtMs: Date.now(),
    };
  }

  private activateContext(
    nextContext: MatchRuntimeContext,
    reason: string,
  ): void {
    const previousContext = this.activeContext;
    if (
      previousContext &&
      previousContext.contextId !== nextContext.contextId
    ) {
      this.cleanupObserverContext(
        previousContext.contextId,
        `switch:${reason}`,
      );
      this.stopObservingAllMatches();
    }
    this.activeContext = nextContext;
    this.inviteId = nextContext.inviteId;
    this.matchId = nextContext.matchId;
    const writableActorUid = nextContext.canWrite ? nextContext.actorUid : null;
    this.setSameProfilePlayerUid(writableActorUid);
    this.logContextEvent("ctx.activate", {
      reason,
      contextId: nextContext.contextId,
      sessionEpoch: nextContext.sessionEpoch,
      inviteId: nextContext.inviteId,
      matchId: nextContext.matchId,
      role: nextContext.role,
      actorUid: nextContext.actorUid,
      canWrite: nextContext.canWrite,
    });
  }

  private clearActiveContext(reason: string): void {
    const activeContext = this.activeContext;
    if (activeContext) {
      this.cleanupObserverContext(activeContext.contextId, reason);
    } else {
      this.logContextEvent("ctx.clear", {
        reason,
        contextId: null,
      });
    }
    this.activeContext = null;
    this.inviteId = null;
    this.matchId = null;
    this.setSameProfilePlayerUid(null);
  }

  public getActiveContextSnapshot(): {
    inviteId: string;
    matchId: string;
    canWrite: boolean;
    contextId: number;
  } | null {
    const activeContext = this.activeContext;
    if (!activeContext) {
      return null;
    }
    return {
      inviteId: activeContext.inviteId,
      matchId: activeContext.matchId,
      canWrite: activeContext.canWrite,
      contextId: activeContext.contextId,
    };
  }

  private requireWritableContext(
    expectedMatchId?: string | null,
    reason = "write",
  ): (MatchRuntimeContext & { actorUid: string; canWrite: true }) | null {
    const activeContext = this.activeContext;
    if (!activeContext || !activeContext.canWrite || !activeContext.actorUid) {
      this.logContextEvent("ctx.write.blocked", {
        reason,
        blockReason: "no-writable-context",
        contextId: activeContext?.contextId ?? null,
        inviteId: activeContext?.inviteId ?? null,
        matchId: activeContext?.matchId ?? null,
      });
      const inviteToReconnect = activeContext?.inviteId ?? this.inviteId;
      if (inviteToReconnect) {
        this.reconnectAfterMatchUpdateFailure(
          inviteToReconnect,
          this.createSessionGuard(),
        );
      }
      return null;
    }
    if (expectedMatchId && expectedMatchId !== activeContext.matchId) {
      this.logContextEvent("ctx.write.blocked", {
        reason,
        blockReason: "expected-match-mismatch",
        contextId: activeContext.contextId,
        inviteId: activeContext.inviteId,
        expectedMatchId,
        activeMatchId: activeContext.matchId,
        action: "drop-stale-write",
      });
      return null;
    }
    return activeContext as MatchRuntimeContext & {
      actorUid: string;
      canWrite: true;
    };
  }

  private bumpSessionEpoch() {
    this.sessionEpoch += 1;
    return this.sessionEpoch;
  }

  private isSessionEpochActive(epoch: number) {
    const isActive = this.sessionEpoch === epoch;
    if (!isActive && import.meta.env.DEV) {
      console.log("stale-session-callback", {
        expectedEpoch: epoch,
        currentEpoch: this.sessionEpoch,
      });
    }
    return isActive;
  }

  public beginMatchSessionTeardown() {
    this.bumpSessionEpoch();
  }

  public createSessionGuard(): () => boolean {
    const epoch = this.sessionEpoch;
    return () => this.isSessionEpochActive(epoch);
  }

  private createMatchContextGuard(
    inviteId: string,
    matchId: string,
  ): () => boolean {
    const epoch = this.sessionEpoch;
    const contextId = this.activeContext?.contextId ?? null;
    if (contextId === null && import.meta.env.DEV) {
      console.warn("createMatchContextGuard called without an active context", {
        inviteId,
        matchId,
        epoch,
      });
    }
    return () => {
      if (!this.isSessionEpochActive(epoch)) {
        return false;
      }
      const activeContext = this.activeContext;
      const isActive =
        !!activeContext &&
        activeContext.inviteId === inviteId &&
        activeContext.matchId === matchId &&
        activeContext.contextId === contextId;
      if (!isActive && import.meta.env.DEV) {
        console.log("stale-session-callback", {
          expectedEpoch: epoch,
          currentEpoch: this.sessionEpoch,
          expectedInviteId: inviteId,
          currentInviteId: activeContext?.inviteId ?? null,
          expectedMatchId: matchId,
          currentMatchId: activeContext?.matchId ?? null,
          expectedContextId: contextId,
          currentContextId: activeContext?.contextId ?? null,
        });
      }
      return isActive;
    };
  }

  private logWagerDebug(
    event: string,
    payload: Record<string, unknown> = {},
  ): void {
    if (!wagerDebugLogsEnabled) {
      return;
    }
    console.log("wager-debug", {
      source: "connection",
      event,
      inviteId: this.inviteId,
      activeMatchId: this.matchId,
      wagerViewMatchId: this.wagerViewMatchId,
      ...payload,
    });
  }

  constructor() {
    const firebaseConfig = {
      apiKey:
        import.meta.env.VITE_MONS_FIREBASE_API_KEY ||
        "AIzaSyC8Ihr4kDd34z-RXe8XTBCFtFbXebifo5Y",
      authDomain: "mons-link.firebaseapp.com",
      projectId: "mons-link",
      storageBucket: "mons-link.firebasestorage.app",
      messagingSenderId: "390871694056",
      appId: "1:390871694056:web:49d0679d38f3045030675d",
    };

    this.app = initializeApp(firebaseConfig);
    this.auth = getAuth(this.app);
    this.db = getDatabase(this.app);
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
                createdAt: proposal.createdAt,
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
      proposals,
      proposedBy,
      agreed,
      resolved,
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
    if (this.latestInvite) {
      if (!this.latestInvite.wagers) {
        this.latestInvite.wagers = {};
      }
      if (state) {
        this.latestInvite.wagers[this.matchId] = state;
      } else if (this.latestInvite.wagers) {
        delete this.latestInvite.wagers[this.matchId];
      }
    }
    setWagerState(this.matchId, state);
  }

  private async delay(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private shouldRetryWagerResult(result: WagerApiResponse): boolean {
    const reason = result.ok === false ? result.reason : "";
    return (
      reason === "proposal-unavailable" ||
      reason === "proposal-missing" ||
      reason === "match-not-found"
    );
  }

  private async callWagerApiWithRetry<T extends WagerApiResponse>(
    label: string,
    call: () => Promise<T>,
    maxAttempts = 3,
  ): Promise<T> {
    let attempt = 0;
    while (attempt < maxAttempts) {
      attempt += 1;
      try {
        if (attempt > 1) {
          console.log(`${label}:retry`, { attempt });
        }
        const data = await call();
        if (
          data &&
          data.ok === false &&
          this.shouldRetryWagerResult(data) &&
          attempt < maxAttempts
        ) {
          await this.delay(160 * attempt);
          continue;
        }
        return data;
      } catch (error) {
        if (attempt < maxAttempts) {
          console.log(`${label}:retry`, { attempt, error });
          await this.delay(180 * attempt);
          continue;
        }
        throw error;
      }
    }
    throw new Error("wager-retry-exhausted");
  }

  public setupConnection(
    autojoin: boolean,
    routeStateOverride?: RouteState,
  ): void {
    const routeState = routeStateOverride ?? getRouteStateSnapshot();
    if (routeState.mode !== "invite" || !routeState.inviteId) {
      return;
    }
    const sessionGuard = this.createSessionGuard();
    const inviteId = routeState.inviteId;
    const shouldAutojoin = autojoin || routeState.autojoin;
    this.signIn().then((uid) => {
      if (uid && sessionGuard()) {
        this.connectToGame(uid, inviteId, shouldAutojoin);
      } else {
        console.log("failed to get game info");
      }
    });
  }

  private buildInviteRouteTarget(
    inviteId: string,
    autojoin: boolean,
  ): RouteState {
    return {
      mode: "invite",
      path: inviteId,
      inviteId,
      snapshotId: null,
      eventId: null,
      autojoin,
    };
  }

  private openInvite(inviteId: string, autojoin: boolean): void {
    this.newInviteId = inviteId;
    void this.transitionToInvite(inviteId, autojoin);
  }

  public connectToInvite(inviteId: string): void {
    this.openInvite(inviteId, isAutoInviteId(inviteId));
  }

  public connectToAutomatch(inviteId: string): void {
    this.openInvite(inviteId, true);
  }

  public didClickInviteButton(completion: (success: boolean) => void): void {
    const routeState = getRouteStateSnapshot();
    if (this.didCreateNewGameInvite) {
      this.writeInviteLinkToClipboard();
      completion(true);
    } else {
      if (routeState.mode === "home" || routeState.mode === "event") {
        this.newInviteId = generateNewInviteId();
        this.writeInviteLinkToClipboard();
        this.createNewMatchInvite(completion);
      } else {
        const routeInviteId = routeState.inviteId ?? routeState.path;
        if (!routeInviteId) {
          completion(false);
          return;
        }
        this.newInviteId = routeInviteId;
        this.writeInviteLinkToClipboard();
        completion(true);
      }
    }
  }

  private writeInviteLinkToClipboard(): void {
    if (typeof window === "undefined") {
      return;
    }
    const link = window.location.origin + "/" + this.newInviteId;
    this.writeLinkToClipboard(link, "failed-to-copy-invite-link");
  }

  public writeEventLinkToClipboard(eventId: string): void {
    if (typeof window === "undefined" || !eventId) {
      return;
    }
    const link = `${window.location.origin}/event/${eventId}`;
    this.writeLinkToClipboard(link, "failed-to-copy-event-link");
  }

  private writeLinkToClipboard(link: string, warningLabel: string): void {
    const clipboard = navigator.clipboard;
    if (clipboard && typeof clipboard.writeText === "function") {
      void clipboard.writeText(link).catch((error) => {
        const didCopy = this.writeInviteLinkWithLegacyClipboardApi(link);
        if (!didCopy && import.meta.env.DEV) {
          console.warn(warningLabel, error);
        }
      });
      return;
    }
    this.writeInviteLinkWithLegacyClipboardApi(link);
  }

  private writeInviteLinkWithLegacyClipboardApi(link: string): boolean {
    if (typeof document === "undefined" || !document.body) {
      return false;
    }
    const textArea = document.createElement("textarea");
    textArea.value = link;
    textArea.setAttribute("readonly", "true");
    textArea.style.position = "fixed";
    textArea.style.top = "0";
    textArea.style.left = "-9999px";
    textArea.style.opacity = "0";
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();
    let didCopy = false;
    try {
      didCopy = document.execCommand("copy");
    } catch {
      didCopy = false;
    }
    document.body.removeChild(textArea);
    return didCopy;
  }

  private async transitionToInvite(
    inviteId: string,
    autojoin = isAutoInviteId(inviteId),
  ): Promise<void> {
    const target = this.buildInviteRouteTarget(inviteId, autojoin);
    await Promise.resolve();
    await transition(target);
  }

  private trackPendingInviteCreation(
    inviteId: string,
    promise: Promise<boolean>,
  ): void {
    this.pendingInviteCreation = { inviteId, promise };
  }

  public hasPendingInviteCreationFor(inviteId: string): boolean {
    return this.pendingInviteCreation?.inviteId === inviteId;
  }

  private async waitForPendingInviteCreation(
    inviteId: string,
    epoch: number,
  ): Promise<boolean> {
    const pendingInviteCreation = this.pendingInviteCreation;
    if (!pendingInviteCreation || pendingInviteCreation.inviteId !== inviteId) {
      return false;
    }
    const didCreateInvite = await pendingInviteCreation.promise;
    if (!this.isSessionEpochActive(epoch)) {
      return false;
    }
    if (
      this.pendingInviteCreation &&
      this.pendingInviteCreation.inviteId === inviteId &&
      this.pendingInviteCreation.promise === pendingInviteCreation.promise
    ) {
      this.pendingInviteCreation = null;
    }
    return didCreateInvite;
  }

  private createNewMatchInvite(completion: (success: boolean) => void): void {
    const sessionGuard = this.createSessionGuard();
    void this.signIn().then((uid) => {
      if (!uid || !sessionGuard()) {
        console.log("failed to sign in");
        completion(false);
        return;
      }
      const inviteId = this.newInviteId;
      const createInvitePromise = this.createInvite(uid, inviteId);
      this.trackPendingInviteCreation(inviteId, createInvitePromise);
      this.didCreateNewGameInvite = true;
      completion(true);
      void this.transitionToInvite(inviteId);
    });
  }

  public async refreshTokenIfNeeded(): Promise<void> {
    try {
      if (!this.auth.currentUser) {
        console.warn("Cannot refresh token: No authenticated user");
        return;
      }

      const token = await this.auth.currentUser.getIdTokenResult();

      if (!token.claims.profileId) {
        console.log("No profileId in claims, forcing token refresh");
        await this.forceTokenRefresh();
      }
    } catch (error) {
      console.error("Error checking or refreshing token:", error);
    }
  }

  public async seeIfFreshlySignedInProfileIsOneOfThePlayers(
    profileId: string,
  ): Promise<void> {
    const routeState = getRouteStateSnapshot();
    const sessionGuard = this.createSessionGuard();
    if (!this.latestInvite) {
      return;
    }
    const match = await this.checkBothPlayerProfiles(
      this.latestInvite.hostId,
      this.latestInvite.guestId ?? "",
      profileId,
    );
    if (!sessionGuard()) {
      return;
    }
    if (match !== null) {
      const inviteToReconnect = this.inviteId ?? routeState.inviteId;
      if (!inviteToReconnect) {
        return;
      }
      await Promise.resolve();
      if (!sessionGuard()) {
        return;
      }
      await transition(
        {
          mode: "invite",
          path: inviteToReconnect,
          inviteId: inviteToReconnect,
          snapshotId: null,
          eventId: null,
          autojoin: isAutoInviteId(inviteToReconnect),
        },
        { force: true },
      );
    }
  }

  public async forceTokenRefresh(): Promise<void> {
    try {
      if (!this.auth.currentUser) {
        console.warn("Cannot refresh token: No authenticated user");
      } else {
        await this.auth.currentUser.getIdToken(true);
      }
    } catch (error) {
      console.error("Failed to refresh authentication token:", error);
    }
  }

  public async getCurrentProfileClaimId(): Promise<string> {
    const user = this.auth.currentUser;
    if (!user) {
      return "";
    }
    try {
      const token = await user.getIdTokenResult();
      const profileId = token && token.claims ? token.claims.profileId : "";
      return typeof profileId === "string" ? profileId : "";
    } catch {
      return "";
    }
  }

  public async signIn(): Promise<string | undefined> {
    try {
      if (this.auth.currentUser && this.auth.currentUser.uid) {
        return this.auth.currentUser.uid;
      }
      await this.waitForInitialAuthState();
      if (this.auth.currentUser && this.auth.currentUser.uid) {
        return this.auth.currentUser.uid;
      }
      await signInAnonymously(this.auth);
      const uid = this.auth.currentUser?.uid;
      return uid;
    } catch (error) {
      console.error("Failed to sign in anonymously:", error);
      return undefined;
    }
  }

  public async signOut(): Promise<void> {
    let authSignOutError: unknown = null;
    try {
      await signOut(this.auth);
    } catch (error) {
      authSignOutError = error;
      console.error("Failed to sign out:", error);
    }
    this.detachFromMatchSession();
    this.detachFromProfileSession();
    this.pendingInviteCreation = null;
    this.pendingRematchProposal = null;
    this.loginUid = null;
    this.setSameProfilePlayerUid(null);
    this.cleanupWagerObserver();
    rocksMiningService.resetProfileMiningState();
    const ensResolver = await import("../utils/ensResolver");
    resetNftCache();
    resetPlayerMetadataCaches();
    ensResolver.resetEnsCache();
    resetLeaderboardCache();
    setFrozenMaterials(null);
    if (authSignOutError) {
      throw authSignOutError;
    }
  }

  public detachFromMatchSession(): void {
    this.pendingRematchProposal = null;
    this.bumpSessionEpoch();
    this.beginConnectAttempt();
    this.clearActiveContext("detach-match-session");
    this.clearAllObserverContexts("detach-match-session");
    this.cleanupRematchObservers();
    this.cleanupWagerObserver();
    this.cleanupInviteReactionObserver();
    this.stopObservingAllMatches();
    this.latestInvite = null;
    this.myMatch = null;
    this.inviteId = null;
    this.matchId = null;
    this.wagerViewMatchId = null;
    this.didCreateNewGameInvite = false;
    this.newInviteId = "";
    this.optimisticResolvedMatchIds.clear();
    this.clearEventSyncCaches();
    setCurrentWagerMatch(null);
  }

  public detachFromProfileSession(): void {
    this.loginUid = null;
    this.setSameProfilePlayerUid(null);
    this.observeMiningFrozen(null);
    this.materialLeaderboardCache.clear();
    this.materialLeaderboardCacheTime = 0;
    this.clearEventSyncCaches();
  }

  public async getProfileByLoginId(loginId: string): Promise<PlayerProfile> {
    await this.ensureAuthenticated();
    return getProfileByLoginIdViaApi(loginId, this.getAuthApiToken);
  }

  public async getProfileById(
    profileId: string,
  ): Promise<PlayerProfile | null> {
    const normalizedProfileId = profileId.trim();
    if (!normalizedProfileId) {
      return null;
    }
    await this.ensureAuthenticated();
    return getProfileByIdViaApi(normalizedProfileId, this.getAuthApiToken);
  }

  private async getPlayerProfile(loginId: string): Promise<PlayerProfile> {
    return resolvePlayerProfile(loginId, {
      readLinkedProfileId: async (playerLoginId) => {
        const snapshot = await get(
          ref(this.db, `players/${playerLoginId}/profile`),
        );
        return snapshot.val();
      },
      getProfileById: (profileId) => this.getProfileById(profileId),
      getProfileByLoginId: (playerLoginId) =>
        this.getProfileByLoginId(playerLoginId),
    });
  }

  private materialLeaderboardCache: Map<MiningMaterialName, PlayerProfile[]> =
    new Map();
  private materialLeaderboardCacheTime: number = 0;
  private static LEADERBOARD_CACHE_TTL = 60000;

  private async fetchAllMaterialLeaderboards(): Promise<void> {
    const leaderboards = await Promise.all(
      MINING_MATERIAL_NAMES.map((material) =>
        readLeaderboardViaApi(material, this.getAuthApiToken),
      ),
    );
    MINING_MATERIAL_NAMES.forEach((material, index) => {
      this.materialLeaderboardCache.set(material, leaderboards[index]);
    });
    this.materialLeaderboardCacheTime = Date.now();
  }

  private isMaterialCacheValid(): boolean {
    return (
      this.materialLeaderboardCache.size === MINING_MATERIAL_NAMES.length &&
      Date.now() - this.materialLeaderboardCacheTime <
        Connection.LEADERBOARD_CACHE_TTL
    );
  }

  public async getLeaderboard(
    type: "rating" | "mp" | MiningMaterialName | "total" = "rating",
  ): Promise<PlayerProfile[]> {
    await this.ensureAuthenticated();

    if (type === "total") {
      if (!this.isMaterialCacheValid()) {
        await this.fetchAllMaterialLeaderboards();
      }
      const profileMap = new Map<string, PlayerProfile>();
      MINING_MATERIAL_NAMES.forEach((material) => {
        const cached = this.materialLeaderboardCache.get(material);
        if (cached) {
          cached.forEach((profile) => {
            if (!profileMap.has(profile.id)) {
              profileMap.set(profile.id, profile);
            }
          });
        }
      });
      const profiles = Array.from(profileMap.values());
      profiles.sort((a, b) => {
        const totalA = a.mining
          ? Object.values(a.mining.materials).reduce((sum, val) => sum + val, 0)
          : 0;
        const totalB = b.mining
          ? Object.values(b.mining.materials).reduce((sum, val) => sum + val, 0)
          : 0;
        return totalB - totalA;
      });
      return profiles.slice(0, LEADERBOARD_ENTRY_LIMIT);
    }

    if (MINING_MATERIAL_NAMES.includes(type as MiningMaterialName)) {
      const materialType = type as MiningMaterialName;
      if (this.isMaterialCacheValid()) {
        const cached = this.materialLeaderboardCache.get(materialType);
        if (cached) {
          return cached;
        }
      }
      await this.fetchAllMaterialLeaderboards();
      return this.materialLeaderboardCache.get(materialType) ?? [];
    }

    return readLeaderboardViaApi(type, this.getAuthApiToken);
  }

  public async editUsername(username: string): Promise<any> {
    try {
      await this.ensureAuthenticated();
      return editUsernameViaApi(username, this.getAuthApiToken);
    } catch (error) {
      console.error("Error editing username:", error);
      throw error;
    }
  }

  private getAuthApiToken = async (forceRefresh: boolean): Promise<string> => {
    const user = this.auth.currentUser;
    if (!user) {
      throw new Error("Failed to authenticate user");
    }
    return user.getIdToken(forceRefresh);
  };

  private getUserBoundAuthTokenProvider(
    expectedUid?: string,
  ): AuthTokenProvider & {
    readonly assertCurrentUser: () => void;
  } {
    const user = this.auth.currentUser;
    if (!user || (expectedUid !== undefined && user.uid !== expectedUid)) {
      throw new Error("Failed to authenticate user");
    }
    return createUserBoundAuthTokenProvider(user, () => this.auth.currentUser);
  }

  public isCurrentAuthUser(uid: string): boolean {
    return this.auth.currentUser?.uid === uid;
  }

  public async beginAuthIntent(
    method: AuthMethodKey,
  ): Promise<AuthIntentResponse> {
    try {
      await this.ensureAuthenticated();
      return beginAuthIntentViaApi(method, this.getAuthApiToken);
    } catch (error) {
      console.error("Error beginning auth intent:", error);
      throw error;
    }
  }

  public async getLinkedAuthMethods(): Promise<LinkedAuthMethodsResponse> {
    try {
      await this.ensureAuthenticated();
      return getLinkedAuthMethodsViaApi(this.getAuthApiToken);
    } catch (error) {
      console.error("Error getting linked auth methods:", error);
      throw error;
    }
  }

  public async syncProfileClaim(): Promise<LinkedAuthMethodsResponse> {
    try {
      await this.ensureAuthenticated();
      return syncProfileClaimViaApi(this.getAuthApiToken);
    } catch (error) {
      console.error("Error syncing profile claim:", error);
      throw error;
    }
  }

  public async unlinkAuthMethod(
    method: AuthMethodKey,
  ): Promise<AuthSessionBoundResult<LinkedAuthMethodsResponse>> {
    try {
      const tokenProvider = this.getUserBoundAuthTokenProvider();
      const result = await unlinkAuthMethodViaApi(method, tokenProvider);
      return bindAuthSessionResult(result, tokenProvider.assertCurrentUser);
    } catch (error) {
      console.error("Error unlinking auth method:", error);
      throw error;
    }
  }

  public async verifyAppleToken(
    intentId: string,
    idToken: string,
    consentSource = "signin",
  ): Promise<AuthVerificationResponse> {
    try {
      await this.ensureAuthenticated();
      const presentation = getStoredAuthPresentation();
      const tokenProvider = this.getUserBoundAuthTokenProvider();
      return verifyAppleTokenViaApi(
        {
          intentId,
          idToken,
          ...presentation,
          consentSource: consentSource === "settings" ? "settings" : "signin",
        },
        tokenProvider,
      );
    } catch (error) {
      console.error("Error verifying Apple token:", error);
      throw error;
    }
  }

  public async beginXRedirectAuth(params: {
    intentId: string;
    consentSource?: XConsentSource;
    returnUrl?: string;
  }): Promise<XRedirectStartResponse> {
    try {
      await this.ensureAuthenticated();
      return beginXRedirectAuthViaApi(
        {
          intentId: params.intentId,
          consentSource: params.consentSource || "signin",
          returnUrl: params.returnUrl || "",
        },
        this.getAuthApiToken,
      );
    } catch (error) {
      console.error("Error beginning X redirect auth:", error);
      throw error;
    }
  }

  public async completeXRedirectAuth(params: {
    flowId: string;
  }): Promise<AuthVerificationResponse> {
    try {
      await this.ensureAuthenticated();
      const presentation = getStoredAuthPresentation();
      const tokenProvider = this.getUserBoundAuthTokenProvider();
      return completeXRedirectAuthViaApi(
        { flowId: params.flowId, ...presentation },
        tokenProvider,
      );
    } catch (error) {
      console.error("Error completing X redirect auth:", error);
      throw error;
    }
  }

  public async verifySolanaAddress(
    address: string,
    signature: string,
    intentId: string,
  ): Promise<AuthVerificationResponse> {
    try {
      await this.ensureAuthenticated();
      const presentation = getStoredAuthPresentation();
      const tokenProvider = this.getUserBoundAuthTokenProvider();
      return verifySolanaAddressViaApi(
        { address, signature, intentId, ...presentation },
        tokenProvider,
      );
    } catch (error) {
      console.error("Error verifying Solana address:", error);
      throw error;
    }
  }

  public async mineRock(
    date: string,
    materials: PlayerMiningMaterials,
  ): Promise<MineRockResponse> {
    try {
      await this.ensureAuthenticated();
      return mineRockViaApi({ date, materials }, this.getAuthApiToken);
    } catch (error) {
      console.error("Error mining rock:", error);
      throw error;
    }
  }

  public async verifyEthAddress(
    message: string,
    signature: string,
    intentId: string,
  ): Promise<AuthVerificationResponse> {
    try {
      await this.ensureAuthenticated();
      const presentation = getStoredAuthPresentation();
      const tokenProvider = this.getUserBoundAuthTokenProvider();
      return verifyEthereumAddressViaApi(
        { message, signature, intentId, ...presentation },
        tokenProvider,
      );
    } catch (error) {
      console.error("Error verifying Ethereum address:", error);
      throw error;
    }
  }

  public subscribeToAuthChanges(
    callback: (uid: string | null) => void,
  ): () => void {
    incrementLifecycleCounter("connectionAuthSubscribers");
    const unsubscribe = onAuthStateChanged(this.auth, (user) => {
      const newUid = user?.uid ?? null;
      if (newUid !== this.currentUid) {
        this.currentUid = newUid;
        callback(newUid);
      }
    });
    this.authUnsubscribers.add(unsubscribe);
    return () => {
      if (this.authUnsubscribers.has(unsubscribe)) {
        this.authUnsubscribers.delete(unsubscribe);
        decrementLifecycleCounter("connectionAuthSubscribers");
      }
      unsubscribe();
    };
  }

  public getSameProfilePlayerUid(): string | null {
    const activeContext = this.activeContext;
    if (activeContext && activeContext.canWrite) {
      return activeContext.actorUid;
    }
    return null;
  }

  private async waitForInitialAuthState(): Promise<void> {
    if (this.auth.currentUser) {
      return;
    }
    if (!this.authBootstrapPromise) {
      this.authBootstrapPromise = new Promise<void>((resolve) => {
        let settled = false;
        let timeoutId: ReturnType<typeof setTimeout> | null = null;
        let unsubscribe: (() => void) | null = null;
        const finish = () => {
          if (settled) {
            return;
          }
          settled = true;
          if (timeoutId) {
            clearTimeout(timeoutId);
          }
          if (unsubscribe) {
            unsubscribe();
          }
          resolve();
        };
        unsubscribe = onAuthStateChanged(
          this.auth,
          () => {
            finish();
          },
          () => {
            finish();
          },
        );
        timeoutId = setTimeout(() => {
          finish();
        }, 1500);
      }).finally(() => {
        this.authBootstrapPromise = null;
      });
    }
    await this.authBootstrapPromise;
  }

  private async ensureAuthenticated(): Promise<void> {
    if (this.auth.currentUser) {
      return;
    }
    await this.waitForInitialAuthState();
    if (!this.auth.currentUser) {
      const uid = await this.signIn();
      if (!uid) {
        throw new Error("Failed to authenticate user");
      }
    }
  }

  private applyOptimisticWagerResolution(isWin?: boolean): boolean {
    const writableContext = this.requireWritableContext(
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
    const state = getWagerState();
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
    const opponentId = this.getOpponentId(writableContext.actorUid);
    if (!count || !opponentId) {
      return false;
    }
    const winnerId = isWin ? writableContext.actorUid : opponentId;
    const loserId = isWin ? opponentId : writableContext.actorUid;
    this.setLocalWagerState({
      ...state,
      proposals: undefined,
      resolved: {
        winnerId,
        loserId,
        material: agreed.material,
        count,
        total: count * 2,
        resolvedAt: Date.now(),
        optimistic: true,
      },
    });
    this.optimisticResolvedMatchIds.add(matchId);
    return true;
  }

  private restoreOptimisticWagerResolution(
    matchId: string,
    previousState: MatchWagerState | null,
    isActive: () => boolean,
  ): void {
    let restored = false;
    const wagers = this.latestInvite?.wagers;
    if (wagers?.[matchId]?.resolved?.optimistic) {
      if (previousState) {
        wagers[matchId] = previousState;
      } else {
        delete wagers[matchId];
      }
      restored = true;
    }
    if (isActive() && getWagerState()?.resolved?.optimistic) {
      setWagerState(matchId, previousState);
      restored = true;
    }
    if (restored) {
      this.optimisticResolvedMatchIds.delete(matchId);
    }
  }

  public isAutomatch(): boolean {
    if (this.inviteId) {
      return isAutoInviteId(this.inviteId);
    } else {
      return false;
    }
  }

  public getCurrentInviteEventId(): string | null {
    return typeof this.latestInvite?.eventId === "string" &&
      this.latestInvite.eventId !== ""
      ? this.latestInvite.eventId
      : null;
  }

  public isCurrentInviteEventOwned(): boolean {
    return this.latestInvite?.eventOwned === true;
  }

  public sendEndMatchIndicator(): void {
    const writableContext = this.requireWritableContext(
      undefined,
      "sendEndMatchIndicator",
    );
    if (
      !writableContext ||
      !this.latestInvite ||
      this.rematchSeriesEndIsIndicated()
    ) {
      return;
    }
    const sessionGuard = this.createMatchContextGuard(
      writableContext.inviteId,
      writableContext.matchId,
    );
    let tokenProvider: AuthTokenProvider & {
      readonly assertCurrentUser: () => void;
    };
    try {
      tokenProvider = this.getUserBoundAuthTokenProvider(
        writableContext.loginUid,
      );
    } catch {
      return;
    }
    void endRematchViaApi(
      {
        operationId: crypto.randomUUID(),
        inviteId: writableContext.inviteId,
      },
      tokenProvider,
    )
      .then((response) => {
        tokenProvider.assertCurrentUser();
        this.notifyNavigationGamesChanged();
        if (!sessionGuard() || !this.latestInvite) {
          return;
        }
        if (this.latestInvite.hostId === response.actorUid) {
          this.latestInvite.hostRematches = response.rematches;
        } else {
          this.latestInvite.guestRematches = response.rematches;
        }
      })
      .catch((error) => {
        console.error("Error ending rematch series:", error);
      });
  }

  public sendRematchProposal(): void {
    const writableContext = this.requireWritableContext(
      undefined,
      "sendRematchProposal",
    );
    if (!writableContext || this.pendingRematchProposal) {
      return;
    }
    const sessionGuard = this.createMatchContextGuard(
      writableContext.inviteId,
      writableContext.matchId,
    );
    let tokenProvider: AuthTokenProvider & {
      readonly assertCurrentUser: () => void;
    };
    try {
      tokenProvider = this.getUserBoundAuthTokenProvider(
        writableContext.loginUid,
      );
    } catch {
      return;
    }
    const newRematchProposalIndex =
      this.getRematchIndexAvailableForNewProposal();
    if (!newRematchProposalIndex || !this.latestInvite) {
      return;
    }

    const previousMatchId = writableContext.matchId;
    const previousMatchPair = previousMatchId
      ? this.getCachedHistoricalMatchPair(previousMatchId)
      : null;

    const inviteId = writableContext.inviteId;
    const operationId = crypto.randomUUID();
    this.pendingRematchProposal = {
      contextId: writableContext.contextId,
      inviteId,
      operationId,
    };

    void (async () => {
      const response = await proposeRematchViaApi(
        {
          operationId,
          inviteId,
          emojiId: getPlayersEmojiId(),
          aura: storage.getPlayerEmojiAura(""),
        },
        tokenProvider,
      );
      this.notifyNavigationGamesChanged();
      if (this.pendingRematchProposal?.operationId === operationId) {
        this.pendingRematchProposal = null;
      }
      tokenProvider.assertCurrentUser();
      if (!sessionGuard()) {
        return;
      }
      this.stopObservingAllMatches();
      this.cleanupRematchObservers();
      this.cleanupInviteReactionObserver();
      this.cleanupWagerObserver();
      const nextMatch = response.match as Match;
      this.myMatch = nextMatch;
      const rematchContext = this.buildRuntimeContext(
        inviteId,
        response.matchId,
        writableContext.loginUid,
        response.actorUid,
        writableContext.role,
        true,
        this.sessionEpoch,
      );
      this.activateContext(rematchContext, "rematch-proposed");
      this.updateWagerStateForCurrentMatch();
      this.observeInviteReactions(rematchContext);
      this.observeRematchOrEndMatchIndicators(rematchContext);
      this.observeWagers(rematchContext);
      if (this.latestInvite) {
        if (this.latestInvite.hostId === response.actorUid) {
          this.latestInvite.hostRematches = response.rematches;
        } else {
          this.latestInvite.guestRematches = response.rematches;
        }
      }
      console.log("Successfully updated match and rematches");
      didJustCreateRematchProposalSuccessfully(
        inviteId,
        nextMatch,
        previousMatchId,
        previousMatchPair,
      );
    })().catch((error) => {
      if (this.pendingRematchProposal?.operationId === operationId) {
        this.pendingRematchProposal = null;
      }
      if (!sessionGuard()) {
        return;
      }
      this.maybeRefreshContextAfterRematchMetadata(writableContext);
      if (!sessionGuard()) {
        return;
      }
      console.error("Error updating match and rematches:", error);
      failedToCreateRematchProposal();
    });
  }

  public rematchSeriesEndIsIndicated(): boolean | null {
    if (!this.latestInvite) return null;
    return rematchSeriesEnded(this.latestInvite);
  }

  private approvedRematchIndices(
    hostIndices: number[],
    guestIndices: number[],
  ): number[] {
    const approved: number[] = [];
    const total = Math.min(hostIndices.length, guestIndices.length);
    for (let i = 0; i < total; i++) {
      if (hostIndices[i] !== guestIndices[i]) {
        break;
      }
      approved.push(hostIndices[i]);
    }
    return approved;
  }

  private oppositeColor(color: string): "white" | "black" | null {
    if (color === "white") {
      return "black";
    }
    if (color === "black") {
      return "white";
    }
    return null;
  }

  private rematchIndexFromMatchId(matchId: string): number | null {
    return parseInviteMatchIndex(this.inviteId, matchId);
  }

  private hostColorForRematchIndex(
    rematchIndex: number,
  ): "white" | "black" | null {
    if (!this.latestInvite) {
      return null;
    }
    const initialHostColor = this.latestInvite.hostColor;
    const oppositeInitialHostColor = this.oppositeColor(initialHostColor);
    if (!oppositeInitialHostColor) {
      return null;
    }
    const hostColor =
      rematchIndex % 2 === 0 ? initialHostColor : oppositeInitialHostColor;
    if (hostColor === "white" || hostColor === "black") {
      return hostColor;
    }
    return null;
  }

  private pendingRematchIndexForCurrentPlayer(
    hostIndices: number[],
    guestIndices: number[],
    approvedLength: number,
  ): number | null {
    const actorUid = this.getSameProfilePlayerUid();
    if (!this.latestInvite || !actorUid || this.rematchSeriesEndIsIndicated()) {
      return null;
    }
    if (
      this.latestInvite.hostId === actorUid &&
      hostIndices.length > approvedLength
    ) {
      return hostIndices[approvedLength] ?? null;
    }
    if (
      this.latestInvite.guestId === actorUid &&
      guestIndices.length > approvedLength
    ) {
      return guestIndices[approvedLength] ?? null;
    }
    return null;
  }

  public getRematchSeriesDescriptor(): RematchSeriesDescriptor | null {
    if (!this.latestInvite || !this.inviteId) {
      return null;
    }
    const hostIndices = parseRematchIndices(this.latestInvite.hostRematches);
    const guestIndices = parseRematchIndices(this.latestInvite.guestRematches);
    const approvedIndices = this.approvedRematchIndices(
      hostIndices,
      guestIndices,
    );
    const pendingIndex = this.pendingRematchIndexForCurrentPlayer(
      hostIndices,
      guestIndices,
      approvedIndices.length,
    );
    const activeMatchId = this.matchId;
    const activeMatchIndex = activeMatchId
      ? this.rematchIndexFromMatchId(activeMatchId)
      : null;
    const isEnded = !!this.rematchSeriesEndIsIndicated();
    const allIndices = [0, ...approvedIndices];
    if (pendingIndex !== null && pendingIndex > 0) {
      allIndices.push(pendingIndex);
    }
    if (activeMatchIndex !== null && activeMatchIndex > 0 && !isEnded) {
      allIndices.push(activeMatchIndex);
    }
    const uniqueIndices = Array.from(new Set(allIndices)).sort((a, b) => a - b);
    const matches = uniqueIndices.map((index) => {
      const matchId = index === 0 ? this.inviteId! : `${this.inviteId}${index}`;
      return {
        index,
        matchId,
        isActiveMatch: activeMatchId === matchId,
        isPendingResponse: pendingIndex === index,
      };
    });
    return {
      inviteId: this.inviteId,
      activeMatchId,
      hasSeries: matches.length > 1,
      matches,
    };
  }

  public getHostColorForMatch(matchId: string): "white" | "black" | null {
    const rematchIndex = this.rematchIndexFromMatchId(matchId);
    if (rematchIndex === null) {
      return null;
    }
    return this.hostColorForRematchIndex(rematchIndex);
  }

  public matchBelongsToCurrentInvite(matchId: string): boolean {
    return this.rematchIndexFromMatchId(matchId) !== null;
  }

  public getSameProfileColorForMatch(
    matchId: string,
  ): "white" | "black" | null {
    const actorUid = this.getSameProfilePlayerUid();
    if (!this.latestInvite || !actorUid || !matchId) {
      return null;
    }
    const hostColor = this.getHostColorForMatch(matchId);
    if (!hostColor) {
      return null;
    }
    const guestColor = this.oppositeColor(hostColor);
    if (!guestColor) {
      return null;
    }
    if (this.latestInvite.hostId === actorUid) {
      return hostColor;
    }
    if (this.latestInvite.guestId === actorUid) {
      return guestColor;
    }
    return null;
  }

  public getPlayerColorForMatch(
    matchId: string,
    playerUid: string,
  ): "white" | "black" | null {
    if (!this.latestInvite || !playerUid) {
      return null;
    }
    const hostColor = this.getHostColorForMatch(matchId);
    if (!hostColor) {
      return null;
    }
    const guestColor = this.oppositeColor(hostColor);
    if (!guestColor) {
      return null;
    }
    if (playerUid === this.latestInvite.hostId) {
      return hostColor;
    }
    if (playerUid === this.latestInvite.guestId) {
      return guestColor;
    }
    return null;
  }

  public async loadHistoricalMatchPair(
    matchId: string,
  ): Promise<HistoricalMatchPair | null> {
    if (!this.latestInvite || !matchId) {
      return null;
    }
    await this.ensureAuthenticated();
    const hostPlayerId = this.latestInvite.hostId;
    const guestPlayerId = this.latestInvite.guestId ?? null;
    const hostRef = ref(this.db, `players/${hostPlayerId}/matches/${matchId}`);
    const guestRef = guestPlayerId
      ? ref(this.db, `players/${guestPlayerId}/matches/${matchId}`)
      : null;
    const hostSnapshot = await get(hostRef);
    const guestSnapshot = guestRef ? await get(guestRef) : null;
    const hostMatch: Match | null = hostSnapshot.val();
    const guestMatch: Match | null = guestSnapshot ? guestSnapshot.val() : null;
    if (!hostMatch && !guestMatch) {
      return null;
    }
    return {
      matchId,
      hostPlayerId,
      guestPlayerId,
      hostMatch,
      guestMatch,
    };
  }

  public getCachedHistoricalMatchPair(
    matchId: string,
  ): HistoricalMatchPair | null {
    if (!this.latestInvite || !matchId) {
      return null;
    }
    const hostPlayerId = this.latestInvite.hostId;
    const guestPlayerId = this.latestInvite.guestId ?? null;
    let hostMatch =
      this.observedMatchSnapshots.get(`${matchId}_${hostPlayerId}`) ?? null;
    let guestMatch = guestPlayerId
      ? (this.observedMatchSnapshots.get(`${matchId}_${guestPlayerId}`) ?? null)
      : null;

    const cachedActorUid = this.getSameProfilePlayerUid();
    if (this.myMatch && this.matchId === matchId && cachedActorUid) {
      if (!hostMatch && cachedActorUid === hostPlayerId) {
        hostMatch = this.myMatch;
      }
      if (!guestMatch && guestPlayerId && cachedActorUid === guestPlayerId) {
        guestMatch = this.myMatch;
      }
    }

    if (!hostMatch && !guestMatch) {
      return null;
    }
    return {
      matchId,
      hostPlayerId,
      guestPlayerId,
      hostMatch: hostMatch ? { ...hostMatch } : null,
      guestMatch: guestMatch ? { ...guestMatch } : null,
    };
  }

  private getRematchIndexAvailableForNewProposal(): string | null {
    if (!this.latestInvite || this.rematchSeriesEndIsIndicated()) return null;

    const proposingAsHost =
      this.latestInvite.hostId === this.getSameProfilePlayerUid();
    const guestRematchesLength = parseRematchIndices(
      this.latestInvite.guestRematches,
    ).length;
    const hostRematchesLength = parseRematchIndices(
      this.latestInvite.hostRematches,
    ).length;

    const proposerRematchesLength = proposingAsHost
      ? hostRematchesLength
      : guestRematchesLength;
    const otherPlayerRematchesLength = proposingAsHost
      ? guestRematchesLength
      : hostRematchesLength;

    const latestCommonIndex = this.getLatestBothSidesApprovedRematchIndex();

    if (!latestCommonIndex) {
      if (proposerRematchesLength === 0 && otherPlayerRematchesLength === 0) {
        return "1";
      } else if (proposerRematchesLength >= otherPlayerRematchesLength) {
        return null;
      } else if (proposerRematchesLength < otherPlayerRematchesLength) {
        if (proposerRematchesLength === 0) {
          return "1";
        } else {
          return null;
        }
      } else {
        return null;
      }
    } else {
      if (proposerRematchesLength > otherPlayerRematchesLength) {
        return null;
      } else {
        return (latestCommonIndex + 1).toString();
      }
    }
  }

  public getOpponentId(actorUidOverride?: string | null): string {
    const actorUid = actorUidOverride ?? this.getSameProfilePlayerUid();
    if (!this.latestInvite || !actorUid) {
      return "";
    }

    if (this.latestInvite.hostId === actorUid) {
      return this.latestInvite.guestId ?? "";
    } else {
      return this.latestInvite.hostId ?? "";
    }
  }

  public async startTimer(): Promise<StartMatchTimerResponse | { ok: false }> {
    try {
      await this.ensureAuthenticated();
      const writableContext = this.requireWritableContext(
        undefined,
        "startTimer",
      );
      if (!writableContext) {
        return { ok: false };
      }
      const opponentId = this.getOpponentId(writableContext.actorUid);
      return startMatchTimerViaApi(
        {
          playerId: writableContext.actorUid,
          opponentId,
          matchId: writableContext.matchId,
          inviteId: writableContext.inviteId,
        },
        this.getAuthApiToken,
      );
    } catch (error) {
      console.error("Error starting a timer:", error);
      throw error;
    }
  }

  public async claimVictoryByTimer(): Promise<
    ClaimMatchVictoryByTimerResponse | { ok: false }
  > {
    try {
      await this.ensureAuthenticated();
      const writableContext = this.requireWritableContext(
        undefined,
        "claimVictoryByTimer",
      );
      if (!writableContext) {
        return { ok: false };
      }
      const opponentId = this.getOpponentId(writableContext.actorUid);
      return claimMatchVictoryByTimerViaApi(
        {
          playerId: writableContext.actorUid,
          opponentId,
          matchId: writableContext.matchId,
          inviteId: writableContext.inviteId,
        },
        this.getAuthApiToken,
      );
    } catch (error) {
      console.error("Error claiming victory by timer:", error);
      throw error;
    }
  }

  public async automatch(): Promise<StartAutomatchResponse> {
    try {
      await this.ensureAuthenticated();
      const tokenProvider = this.getUserBoundAuthTokenProvider();
      const emojiId = getPlayersEmojiId();
      const aura = storage.getPlayerEmojiAura("");
      const response = await startAutomatchViaApi(
        { emojiId, aura },
        tokenProvider,
      );
      this.notifyNavigationGamesChanged();
      return response;
    } catch (error) {
      console.error("Error calling automatch:", error);
      throw error;
    }
  }

  public async cancelAutomatch(): Promise<any> {
    try {
      await this.ensureAuthenticated();
      const response = await cancelAutomatchViaApi(
        this.getUserBoundAuthTokenProvider(),
      );
      this.notifyNavigationGamesChanged();
      return response;
    } catch (error) {
      console.error("Error canceling automatch:", error);
      throw error;
    }
  }

  public async removeWaitingNavigationGame(inviteId: string): Promise<any> {
    const normalizedInviteId =
      typeof inviteId === "string" ? inviteId.trim() : "";
    if (!normalizedInviteId) {
      return {
        ok: false,
        skipped: true,
        reason: "invalid-invite-id",
      };
    }
    try {
      await this.ensureAuthenticated();
      const response = await removeNavigationGameViaApi(
        { inviteId: normalizedInviteId },
        this.getAuthApiToken,
      );
      this.notifyNavigationGamesChanged();
      return response;
    } catch (error) {
      console.error("Error removing waiting navigation game:", error);
      throw error;
    }
  }

  public async createEvent(
    schedule: number | EventCreateDateTimePayload,
    options: EventCreateOptions = {},
  ): Promise<{ ok: boolean; eventId?: string; event?: EventRecord | null }> {
    try {
      await this.ensureAuthenticated();
      const requestPayloadBase =
        typeof schedule === "number"
          ? {
              startsInMinutes: this.normalizeFiniteNumber(schedule, 0),
            }
          : {
              scheduledDate: this.normalizeString(schedule.scheduledDate),
              scheduledTime: this.normalizeString(schedule.scheduledTime),
              scheduledTimezone: schedule.scheduledTimezone,
              ...(this.normalizeString(schedule.localTimezoneIana || "") !== ""
                ? {
                    localTimezoneIana: this.normalizeString(
                      schedule.localTimezoneIana || "",
                    ),
                  }
                : {}),
            };
      const requestPayload = {
        ...requestPayloadBase,
        announceOnTelegram: options.announceOnTelegram === true,
      };
      const data = await createEventViaApi(
        requestPayload,
        this.getAuthApiToken,
      );
      this.notifyNavigationGamesChanged();
      return {
        ok: data.ok,
        eventId: data.eventId,
        event: this.mapDatabaseEventRecord(data.event, data.eventId),
      };
    } catch (error) {
      console.error("Error creating event:", error);
      throw error;
    }
  }

  public async joinEvent(
    eventId: string,
  ): Promise<{ ok: boolean; eventId?: string }> {
    try {
      await this.ensureAuthenticated();
      const data = await joinEventViaApi({ eventId }, this.getAuthApiToken);
      this.notifyNavigationGamesChanged();
      return {
        ok: data.ok,
        eventId: data.eventId,
      };
    } catch (error) {
      console.error("Error joining event:", error);
      throw error;
    }
  }

  public async postponeEventStart(
    eventId: string,
    postponeByMinutes: number,
  ): Promise<{
    ok: boolean;
    eventId?: string;
    event?: EventRecord | null;
    postponeByMinutes?: number;
    startAtMs?: number;
  }> {
    try {
      await this.ensureAuthenticated();
      if (
        postponeByMinutes !== 5 &&
        postponeByMinutes !== 10 &&
        postponeByMinutes !== 15
      ) {
        throw new Error("Invalid event postponement interval.");
      }
      const data = await postponeEventStartViaApi(
        {
          eventId,
          postponeByMinutes,
        },
        this.getAuthApiToken,
      );
      this.notifyNavigationGamesChanged();
      return {
        ok: data.ok,
        eventId: data.eventId,
        event: this.mapDatabaseEventRecord(data.event, data.eventId),
        postponeByMinutes: data.postponeByMinutes,
        startAtMs: data.startAtMs,
      };
    } catch (error) {
      console.error("Error postponing event start:", error);
      throw error;
    }
  }

  public async removeEventParticipant(
    eventId: string,
    participantProfileId: string,
  ): Promise<{
    ok: boolean;
    eventId?: string;
    removedProfileId?: string;
  }> {
    try {
      await this.ensureAuthenticated();
      const data = await removeEventParticipantViaApi(
        { eventId, participantProfileId },
        this.getAuthApiToken,
      );
      this.notifyNavigationGamesChanged();
      return {
        ok: data.ok,
        eventId: data.eventId,
        removedProfileId: data.removedProfileId,
      };
    } catch (error) {
      console.error("Error removing event participant:", error);
      throw error;
    }
  }

  public async disqualifyEventMatchWinners(
    eventId: string,
    matchKey: string,
  ): Promise<{
    ok: boolean;
    eventId?: string;
    event?: EventRecord | null;
    didDisqualify?: boolean;
    matchKey?: string;
  }> {
    try {
      await this.ensureAuthenticated();
      const data = await disqualifyEventMatchWinnersViaApi(
        { eventId, matchKey },
        this.getAuthApiToken,
      );
      this.notifyNavigationGamesChanged();
      return {
        ok: data.ok,
        eventId: data.eventId,
        event: this.mapDatabaseEventRecord(
          "event" in data ? data.event : null,
          data.eventId,
        ),
        didDisqualify: data.didDisqualify,
        matchKey: data.matchKey,
      };
    } catch (error) {
      console.error("Error disqualifying event match winners:", error);
      throw error;
    }
  }

  public async syncEventState(eventId: string): Promise<EventSyncResponse> {
    const normalizedEventId = this.normalizeString(eventId).trim();
    if (!normalizedEventId) {
      return { ok: false, skipped: true, event: null };
    }

    const nowMs = Date.now();
    const cachedSyncResponse = this.readCachedEventSyncResponse(
      normalizedEventId,
      nowMs,
    );
    if (cachedSyncResponse) {
      return cachedSyncResponse;
    }

    const existingSync = this.inFlightEventSyncById.get(normalizedEventId);
    if (existingSync) {
      return existingSync;
    }

    const syncPromise = (async () => {
      try {
        await this.ensureAuthenticated();
        const isParticipant =
          await this.isLocalProfileEventParticipant(normalizedEventId);
        if (!isParticipant) {
          return this.commitEventSyncResponse(normalizedEventId, {
            ok: true,
            skipped: true,
            reason: "not-participant",
            event: this.latestObservedEventById.get(normalizedEventId) ?? null,
          });
        }

        const maxRetries = EVENT_SYNC_RETRY_DELAYS_MS.length;
        const maxAttempts = maxRetries + 1;
        for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
          const data = await syncEventStateViaApi(
            { eventId: normalizedEventId },
            this.getAuthApiToken,
          );
          const isSkipped = "skipped" in data;
          const reason = this.normalizeEventSyncSkipReason(
            isSkipped ? data.reason : undefined,
          );
          const parsed = {
            ok: data.ok,
            didChange: isSkipped ? undefined : data.didChange,
            skipped: isSkipped ? true : undefined,
            reason,
            event: this.mapDatabaseEventRecord(
              "event" in data ? data.event : null,
              normalizedEventId,
            ),
          };
          if (
            !parsed.skipped ||
            !this.shouldRetryEventSync(parsed.reason) ||
            attempt >= maxAttempts - 1
          ) {
            return this.commitEventSyncResponse(normalizedEventId, parsed);
          }
          await this.delay(EVENT_SYNC_RETRY_DELAYS_MS[attempt] || 300);
        }

        return this.commitEventSyncResponse(normalizedEventId, {
          ok: false,
          skipped: true,
          event: null,
        });
      } catch (error) {
        console.error("Error syncing event state:", error);
        throw error;
      } finally {
        this.inFlightEventSyncById.delete(normalizedEventId);
      }
    })();

    this.inFlightEventSyncById.set(normalizedEventId, syncPromise);
    return syncPromise;
  }

  private shouldRetryEventSync(
    reason: EventSyncSkipReason | undefined,
  ): boolean {
    return reason === "locked" || reason === "rate-limited";
  }

  private normalizeEventSyncSkipReason(
    value: unknown,
  ): EventSyncSkipReason | undefined {
    if (value === "lock-lost") {
      return "locked";
    }
    if (
      value === "locked" ||
      value === "rate-limited" ||
      value === "not-participant"
    ) {
      return value;
    }
    return undefined;
  }

  private isParticipantInEventRecord(
    eventRecord: EventRecord | null,
    profileId: string,
  ): boolean {
    if (!eventRecord || !eventRecord.participants) {
      return false;
    }
    return !!eventRecord.participants[profileId];
  }

  private isLocalCreatorInEventRecord(
    eventRecord: EventRecord | null,
    profileId: string | null,
  ): boolean {
    if (!eventRecord) {
      return false;
    }
    const normalizedProfileId = this.normalizeStringOrNull(profileId);
    if (
      normalizedProfileId &&
      this.normalizeString(eventRecord.createdByProfileId) ===
        normalizedProfileId
    ) {
      return true;
    }
    const localLoginUid = this.normalizeString(
      this.auth.currentUser?.uid || this.currentUid || "",
    );
    if (!localLoginUid) {
      return false;
    }
    return (
      this.normalizeString(eventRecord.createdByLoginUid) === localLoginUid
    );
  }

  private getEventSyncCooldownMs(eventRecord: EventRecord | null): number {
    if (!eventRecord || eventRecord.status === "scheduled") {
      return EVENT_SYNC_COOLDOWN_SCHEDULED_MS;
    }
    return EVENT_SYNC_COOLDOWN_ACTIVE_MS;
  }

  private readCachedEventSyncResponse(
    eventId: string,
    nowMs: number,
  ): EventSyncResponse | null {
    const cacheEntry = this.eventSyncCooldownCacheById.get(eventId);
    if (!cacheEntry) {
      return null;
    }
    const eventRecord =
      cacheEntry.response.event ??
      this.latestObservedEventById.get(eventId) ??
      null;
    const cooldownMs = this.getEventSyncCooldownMs(eventRecord);
    if (nowMs - cacheEntry.responseAtMs >= cooldownMs) {
      return null;
    }
    return cacheEntry.response;
  }

  private commitEventSyncResponse(
    eventId: string,
    response: EventSyncResponse,
  ): EventSyncResponse {
    this.eventSyncCooldownCacheById.set(eventId, {
      responseAtMs: Date.now(),
      response,
    });
    if (response.event !== undefined) {
      this.latestObservedEventById.set(eventId, response.event ?? null);
    }
    return response;
  }

  private async isLocalProfileEventParticipant(
    eventId: string,
  ): Promise<boolean> {
    const profileId = this.getLocalProfileId();
    if (!profileId) {
      return true;
    }

    const nowMs = Date.now();
    const observedEvent = this.latestObservedEventById.get(eventId) ?? null;
    if (this.isLocalCreatorInEventRecord(observedEvent, profileId)) {
      this.eventSyncParticipantCacheById.set(eventId, {
        profileId,
        checkedAtMs: nowMs,
        isParticipant: true,
      });
      return true;
    }

    const cachedMembership = this.eventSyncParticipantCacheById.get(eventId);
    const cacheTtlMs =
      cachedMembership && cachedMembership.isParticipant
        ? EVENT_SYNC_PARTICIPANT_CACHE_TTL_MS
        : EVENT_SYNC_PARTICIPANT_NEGATIVE_CACHE_TTL_MS;
    if (
      cachedMembership &&
      cachedMembership.profileId === profileId &&
      nowMs - cachedMembership.checkedAtMs <= cacheTtlMs
    ) {
      return cachedMembership.isParticipant;
    }

    if (this.isParticipantInEventRecord(observedEvent, profileId)) {
      this.eventSyncParticipantCacheById.set(eventId, {
        profileId,
        checkedAtMs: nowMs,
        isParticipant: true,
      });
      return true;
    }

    try {
      const participantSnapshot = await get(
        ref(this.db, `events/${eventId}/participants/${profileId}`),
      );
      const isParticipant = participantSnapshot.exists();
      const observedEvent = this.latestObservedEventById.get(eventId) ?? null;
      if (!isParticipant && !observedEvent) {
        return true;
      }
      this.eventSyncParticipantCacheById.set(eventId, {
        profileId,
        checkedAtMs: nowMs,
        isParticipant,
      });
      return isParticipant;
    } catch {
      return true;
    }
  }

  private clearEventSyncCaches(): void {
    this.inFlightEventSyncById.clear();
    this.eventSyncParticipantCacheById.clear();
    this.eventSyncCooldownCacheById.clear();
    this.latestObservedEventById.clear();
    this.activeEventSubscriptionsById.clear();
  }

  private clearEventSyncCacheForId(eventId: string): void {
    this.inFlightEventSyncById.delete(eventId);
    this.eventSyncParticipantCacheById.delete(eventId);
    this.eventSyncCooldownCacheById.delete(eventId);
    this.latestObservedEventById.delete(eventId);
  }

  private retainEventSubscription(eventId: string): void {
    const nextCount = (this.activeEventSubscriptionsById.get(eventId) || 0) + 1;
    this.activeEventSubscriptionsById.set(eventId, nextCount);
  }

  private releaseEventSubscription(eventId: string): void {
    const currentCount = this.activeEventSubscriptionsById.get(eventId) || 0;
    if (currentCount <= 1) {
      this.activeEventSubscriptionsById.delete(eventId);
      this.clearEventSyncCacheForId(eventId);
      return;
    }
    this.activeEventSubscriptionsById.set(eventId, currentCount - 1);
  }

  public subscribeToEventPrizeSelections(
    eventId: string,
    onUpdate: (selections: EventPrizeSelections) => void,
    onError?: (error: unknown) => void,
  ): () => void {
    const normalizedEventId = typeof eventId === "string" ? eventId.trim() : "";
    if (!normalizedEventId) {
      onUpdate({});
      return () => {};
    }
    const selectionsRef = ref(
      this.db,
      `eventPrizeSelections/${normalizedEventId}`,
    );
    let disposed = false;
    let unsubscribe: (() => void) | null = null;
    const sessionGuard = this.createSessionGuard();

    void this.ensureAuthenticated()
      .then(() => {
        if (disposed || !sessionGuard()) {
          return;
        }
        unsubscribe = onValue(
          selectionsRef,
          (snapshot) => {
            if (disposed || !sessionGuard()) {
              return;
            }
            const rawSelections = snapshot.val();
            if (!rawSelections || typeof rawSelections !== "object") {
              onUpdate({});
              return;
            }
            const selections: EventPrizeSelections = {};
            Object.entries(rawSelections as Record<string, unknown>).forEach(
              ([profileId, prizeId]) => {
                const normalizedProfileId = profileId.trim();
                const normalizedPrizeId = this.normalizeEventPrizeId(
                  prizeId,
                  normalizedEventId,
                );
                if (normalizedProfileId && normalizedPrizeId) {
                  selections[normalizedProfileId] = normalizedPrizeId;
                }
              },
            );
            onUpdate(selections);
          },
          (error) => {
            if (disposed || !sessionGuard()) {
              return;
            }
            onError?.(error);
          },
        );
      })
      .catch((error) => {
        if (disposed || !sessionGuard()) {
          return;
        }
        onError?.(error);
      });

    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }

  public subscribeToProfileEventPrizes(
    profileId: string,
    onUpdate: (prizes: ProfileEventPrizes) => void,
    onError?: (error: unknown) => void,
  ): () => void {
    const normalizedProfileId =
      typeof profileId === "string" ? profileId.trim() : "";
    if (!normalizedProfileId) {
      onUpdate({});
      return () => {};
    }
    const prizesRef = ref(this.db, `profileEventPrizes/${normalizedProfileId}`);
    let disposed = false;
    let unsubscribe: (() => void) | null = null;
    const sessionGuard = this.createSessionGuard();

    void this.ensureAuthenticated()
      .then(() => {
        if (disposed || !sessionGuard()) {
          return;
        }
        unsubscribe = onValue(
          prizesRef,
          (snapshot) => {
            if (disposed || !sessionGuard()) {
              return;
            }
            const rawPrizes = snapshot.val();
            if (!rawPrizes || typeof rawPrizes !== "object") {
              onUpdate({});
              return;
            }
            const prizes: ProfileEventPrizes = {};
            Object.entries(rawPrizes as Record<string, unknown>).forEach(
              ([eventId, rawPrize]) => {
                const normalizedEventId = eventId.trim();
                const prize = this.mapEventPrizeAssignment(
                  rawPrize,
                  normalizedEventId,
                );
                if (
                  normalizedEventId &&
                  prize?.eventId === normalizedEventId &&
                  prize.profileId === normalizedProfileId
                ) {
                  prizes[normalizedEventId] = prize;
                }
              },
            );
            onUpdate(prizes);
          },
          (error) => {
            if (disposed || !sessionGuard()) {
              return;
            }
            onError?.(error);
          },
        );
      })
      .catch((error) => {
        if (disposed || !sessionGuard()) {
          return;
        }
        onError?.(error);
      });

    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }

  public async toggleEventPrizeSelection(
    eventId: string,
    prizeId: string,
  ): Promise<string | null> {
    const normalizedEventId = this.normalizeString(eventId).trim();
    const normalizedPrizeId = this.normalizeString(prizeId).trim();
    const profileId = storage.getProfileId("").trim();
    const request = {
      eventId: normalizedEventId,
      prizeId: normalizedPrizeId,
    };
    if (!profileId || !isToggleEventPrizeSelectionRequest(request)) {
      throw new Error("Event prize selection requires an event and profile.");
    }

    try {
      await this.ensureAuthenticated();
      const tokenProvider = this.getUserBoundAuthTokenProvider();
      const response = await toggleEventPrizeSelectionViaApi(
        request,
        tokenProvider,
      );
      return response.selectedPrizeId;
    } catch (error) {
      console.error("Error toggling event prize selection:", error);
      throw error;
    }
  }

  public async withdrawEventPrize(
    eventId: string,
    prizeId: EventPrizeId,
    solanaAddress: string,
  ): Promise<EventPrizeWithdrawalResponse> {
    try {
      await this.ensureAuthenticated();
      return await withdrawEventPrizeViaApi(
        eventId,
        prizeId,
        solanaAddress,
        this.getUserBoundAuthTokenProvider(),
      );
    } catch (error) {
      console.error("Error withdrawing event prize:", error);
      throw error;
    }
  }

  public subscribeToEvent(
    eventId: string,
    onUpdate: (event: EventRecord | null) => void,
    onError?: (error: unknown) => void,
  ): () => void {
    const normalizedEventId = typeof eventId === "string" ? eventId.trim() : "";
    if (!normalizedEventId) {
      onUpdate(null);
      return () => {};
    }
    const eventRef = ref(this.db, `events/${normalizedEventId}`);
    let disposed = false;
    let unsubscribe: (() => void) | null = null;
    const sessionGuard = this.createSessionGuard();
    this.retainEventSubscription(normalizedEventId);

    void this.ensureAuthenticated()
      .then(() => {
        if (disposed || !sessionGuard()) {
          return;
        }
        unsubscribe = onValue(
          eventRef,
          (snapshot) => {
            if (disposed || !sessionGuard()) {
              return;
            }
            if (!snapshot.exists()) {
              this.latestObservedEventById.set(normalizedEventId, null);
              onUpdate(null);
              return;
            }
            const mappedEvent = this.mapDatabaseEventRecord(
              snapshot.val(),
              normalizedEventId,
            );
            this.latestObservedEventById.set(normalizedEventId, mappedEvent);
            onUpdate(mappedEvent);
          },
          (error) => {
            if (disposed || !sessionGuard()) {
              return;
            }
            onError?.(error);
          },
        );
      })
      .catch((error) => {
        if (disposed || !sessionGuard()) {
          return;
        }
        onError?.(error);
      });

    return () => {
      disposed = true;
      unsubscribe?.();
      this.releaseEventSubscription(normalizedEventId);
    };
  }

  private normalizeStringOrNull(value: unknown): string | null {
    return normalizeStringOrNull(value);
  }

  private normalizeString(value: unknown): string {
    return normalizeString(value);
  }

  private normalizeFiniteNumber(value: unknown, fallback = 0): number {
    return normalizeFiniteNumber(value, fallback);
  }

  private compareNavigationItems(a: NavigationItem, b: NavigationItem): number {
    return compareNavigationItemsByDisplayOrder(a, b);
  }

  private notifyNavigationGamesChanged(): void {
    this.navigationGamesRefreshListeners.forEach((refresh) => refresh());
  }

  private normalizeEventPrizeId(
    value: unknown,
    eventId: string,
  ): EventPrizeId | null {
    return normalizeEventPrizeId(value, eventId);
  }

  private mapEventPrizeAssignment(
    rawValue: unknown,
    fallbackEventId: string,
  ): ReturnType<typeof mapEventPrizeAssignment> {
    return mapEventPrizeAssignment(rawValue, fallbackEventId);
  }

  private mapDatabaseEventRecord(
    rawValue: unknown,
    fallbackEventId: string,
  ): EventRecord | null {
    return mapDatabaseEventRecord(rawValue, fallbackEventId);
  }

  public createOptimisticPendingAutomatchItem(
    inviteId: string,
  ): NavigationGameItem | null {
    if (!inviteId || inviteId === "") {
      return null;
    }
    return {
      id: inviteId,
      entityType: "game",
      inviteId,
      kind: "auto",
      status: "pending",
      sortBucket: getNavigationSortBucket("pending"),
      listSortAtMs: Date.now(),
      hostLoginId: this.auth.currentUser?.uid ?? null,
      guestLoginId: null,
      opponentProfileId: null,
      opponentName: null,
      opponentEmoji: null,
      automatchStateHint: "pending",
      isPendingAutomatch: true,
      isOptimistic: true,
    };
  }

  public async getProfileGamesPage(
    maxItems: number,
    cursor: NavigationGamesPageCursor = null,
  ): Promise<NavigationGamesPageResult> {
    await this.ensureAuthenticated();
    const boundedLimit =
      Number.isFinite(maxItems) && maxItems > 0
        ? Math.min(100, Math.floor(maxItems))
        : 40;
    return readNavigationGamesViaApi(
      { limit: boundedLimit, cursor },
      this.getAuthApiToken,
    );
  }

  public subscribeProfileGames(
    maxItems: number,
    onUpdate: (items: NavigationItem[]) => void,
    onError?: (error: unknown) => void,
    onPageMeta?: (result: NavigationGamesPageResult) => void,
  ): () => void {
    const sessionGuard = this.createSessionGuard();
    const boundedLimit =
      Number.isFinite(maxItems) && maxItems > 0
        ? Math.min(100, Math.floor(maxItems))
        : 40;
    return startNavigationGamesPolling({
      addInvalidationListener: (listener) => {
        this.navigationGamesRefreshListeners.add(listener);
        return () => this.navigationGamesRefreshListeners.delete(listener);
      },
      addVisibilityListener: (listener) => {
        if (typeof document === "undefined") return () => {};
        document.addEventListener("visibilitychange", listener);
        return () => document.removeEventListener("visibilitychange", listener);
      },
      clearTimer: (timer) => clearTimeout(timer),
      intervalMs: NAVIGATION_GAMES_POLL_INTERVAL_MS,
      isActive: sessionGuard,
      isVisible: () =>
        typeof document === "undefined" ||
        document.visibilityState === "visible",
      load: () => this.getProfileGamesPage(boundedLimit),
      maxConsecutiveFailures: NAVIGATION_GAMES_MAX_CONSECUTIVE_FAILURES,
      onError: (error) => onError?.(error),
      onUpdate: (page) => {
        onUpdate(page.items);
        onPageMeta?.(page);
      },
      setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
    });
  }

  private async getInviteForFallback(
    inviteId: string,
    inviteCache: Map<string, Invite | null>,
  ): Promise<Invite | null> {
    if (inviteCache.has(inviteId)) {
      return inviteCache.get(inviteId) || null;
    }

    const inviteSnapshot = await get(ref(this.db, `invites/${inviteId}`));
    const inviteData = inviteSnapshot.exists()
      ? (inviteSnapshot.val() as Invite)
      : null;
    inviteCache.set(inviteId, inviteData);
    return inviteData;
  }

  private buildFallbackSortHint(
    maxMatchIndex: number,
    lastSeenOrder: number,
  ): number {
    const normalizedOrder =
      Number.isFinite(lastSeenOrder) && lastSeenOrder > 0
        ? Math.floor(lastSeenOrder)
        : 1;
    const normalizedIndex =
      Number.isFinite(maxMatchIndex) && maxMatchIndex > 0
        ? Math.floor(maxMatchIndex)
        : 0;
    return normalizedIndex > 0
      ? normalizedIndex * 1_000_000 + normalizedOrder
      : normalizedOrder;
  }

  private parseFallbackEmojiId(value: unknown): number | null {
    if (typeof value === "number" && Number.isFinite(value)) {
      return Math.floor(value);
    }
    if (typeof value === "string" && value !== "") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return Math.floor(parsed);
      }
    }
    return null;
  }

  private async getFallbackOpponentEmoji(
    opponentLoginId: string | null,
    latestMatchId: string,
    inviteId: string,
    emojiCache: Map<string, number | null>,
  ): Promise<number | null> {
    if (!opponentLoginId) {
      return null;
    }
    const normalizedLatestMatchId =
      latestMatchId && latestMatchId !== "" ? latestMatchId : inviteId;
    const cacheKey = `${opponentLoginId}|${normalizedLatestMatchId}|${inviteId}`;
    if (emojiCache.has(cacheKey)) {
      return emojiCache.get(cacheKey) ?? null;
    }

    const candidateMatchIds = [normalizedLatestMatchId];
    if (inviteId !== normalizedLatestMatchId) {
      candidateMatchIds.push(inviteId);
    }

    for (const candidateMatchId of candidateMatchIds) {
      try {
        const matchSnapshot = await get(
          ref(
            this.db,
            `players/${opponentLoginId}/matches/${candidateMatchId}`,
          ),
        );
        if (!matchSnapshot.exists()) {
          continue;
        }
        const matchData = matchSnapshot.val() as { emojiId?: unknown } | null;
        const parsedEmojiId = this.parseFallbackEmojiId(matchData?.emojiId);
        if (parsedEmojiId !== null) {
          emojiCache.set(cacheKey, parsedEmojiId);
          return parsedEmojiId;
        }
      } catch {
        continue;
      }
    }

    emojiCache.set(cacheKey, null);
    return null;
  }

  private async resolveFallbackInviteIdFromMatchId(
    matchId: string,
    inviteCache: Map<string, Invite | null>,
  ): Promise<string | null> {
    if (matchId === "") {
      return null;
    }

    const exactInvite = await this.getInviteForFallback(matchId, inviteCache);
    if (exactInvite) {
      return matchId;
    }

    const candidates: string[] = [];
    for (const candidateInviteId of createInviteCandidatesFromMatchId(
      matchId,
    )) {
      const candidateInvite = await this.getInviteForFallback(
        candidateInviteId,
        inviteCache,
      );
      if (candidateInvite && !candidates.includes(candidateInviteId)) {
        candidates.push(candidateInviteId);
      }
    }

    if (candidates.length === 1) {
      return candidates[0];
    }
    if (candidates.length > 1) {
      console.log("navigation:fallback:match-resolver:ambiguous", {
        matchId,
        candidates,
      });
    }
    return null;
  }

  private async getFallbackOpponentProfile(
    opponentLoginId: string | null,
    profileCache: Map<string, PlayerProfile | null>,
  ): Promise<PlayerProfile | null> {
    if (!opponentLoginId) {
      return null;
    }
    if (profileCache.has(opponentLoginId)) {
      return profileCache.get(opponentLoginId) || null;
    }
    let profile: PlayerProfile | null = null;
    try {
      profile = await this.getPlayerProfile(opponentLoginId);
    } catch {
      profile = null;
    }
    profileCache.set(opponentLoginId, profile);
    return profile;
  }

  private async buildFallbackNavigationItem(
    inviteId: string,
    inviteData: Invite,
    currentLoginUid: string,
    profileCache: Map<string, PlayerProfile | null>,
    emojiCache: Map<string, number | null>,
    fallbackSortHint: number,
    latestMatchIdHint: string,
  ): Promise<NavigationGameItem | null> {
    const inviteRecord = inviteData as Invite & {
      automatchStateHint?: unknown;
      automatchCanceledAt?: unknown;
    };
    const hostLoginId =
      typeof inviteRecord.hostId === "string" ? inviteRecord.hostId : null;
    const guestLoginId =
      typeof inviteRecord.guestId === "string" ? inviteRecord.guestId : null;
    const kind: "auto" | "direct" = isAutoInviteId(inviteId)
      ? "auto"
      : "direct";
    const ended = rematchSeriesEnded(inviteRecord);
    const automatchStateHint = normalizeStrictAutomatchStateHint(
      inviteRecord.automatchStateHint,
    );
    if (kind === "auto" && !guestLoginId && automatchStateHint !== "pending") {
      return null;
    }

    const status: "pending" | "waiting" | "active" | "ended" = ended
      ? "ended"
      : kind === "auto" && automatchStateHint === "pending"
        ? "pending"
        : guestLoginId
          ? "active"
          : "waiting";

    const sortBucket = getNavigationSortBucket(status);
    const canceledAt =
      typeof inviteRecord.automatchCanceledAt === "number" &&
      Number.isFinite(inviteRecord.automatchCanceledAt)
        ? Math.floor(inviteRecord.automatchCanceledAt)
        : 0;
    const normalizedFallbackSortHint =
      Number.isFinite(fallbackSortHint) && fallbackSortHint > 0
        ? Math.floor(fallbackSortHint)
        : 1;
    const listSortAtMs =
      status === "pending"
        ? Date.now()
        : canceledAt > 0
          ? canceledAt
          : normalizedFallbackSortHint;

    const opponentLoginId =
      hostLoginId === currentLoginUid ? guestLoginId : hostLoginId;
    const opponentProfile = await this.getFallbackOpponentProfile(
      opponentLoginId,
      profileCache,
    );
    const latestMatchId = deriveLatestMatchId(
      inviteId,
      inviteData,
      latestMatchIdHint,
    );
    const opponentEmojiFromProfile =
      typeof opponentProfile?.emoji === "number" ? opponentProfile.emoji : null;
    const opponentEmoji =
      opponentEmojiFromProfile ??
      (await this.getFallbackOpponentEmoji(
        opponentLoginId,
        latestMatchId,
        inviteId,
        emojiCache,
      ));
    if ((status === "active" || status === "ended") && opponentEmoji === null) {
      return null;
    }

    return {
      id: inviteId,
      entityType: "game",
      inviteId,
      kind,
      status,
      sortBucket,
      listSortAtMs,
      hostLoginId,
      guestLoginId,
      opponentProfileId: opponentProfile?.id ?? null,
      opponentName: opponentProfile?.username ?? null,
      opponentEmoji,
      automatchStateHint,
      isPendingAutomatch: status === "pending",
      isFallback: true,
    };
  }

  public async getCurrentLoginFallbackGames(
    maxItems: number,
  ): Promise<NavigationGameItem[]> {
    console.log("⚠️ getCurrentLoginFallbackGames");
    await this.ensureAuthenticated();
    const currentLoginUid = this.auth.currentUser?.uid;
    if (!currentLoginUid) {
      return [];
    }

    const boundedLimit =
      Number.isFinite(maxItems) && maxItems > 0 ? Math.floor(maxItems) : 40;
    const matchesSnapshot = await get(
      ref(this.db, `players/${currentLoginUid}/matches`),
    );
    if (!matchesSnapshot.exists()) {
      return [];
    }

    const matches = matchesSnapshot.val() as Record<string, unknown>;
    const matchIds = Object.keys(matches || {});
    const inviteCache = new Map<string, Invite | null>();
    const inviteIds = new Set<string>();
    const inviteSortHints = new Map<string, number>();
    const inviteMaxMatchIndices = new Map<string, number>();
    const inviteLatestMatchIdHints = new Map<string, string>();

    let lastSeenOrder = matchIds.length;
    for (const matchId of matchIds) {
      const inviteId = await this.resolveFallbackInviteIdFromMatchId(
        matchId,
        inviteCache,
      );
      if (inviteId) {
        inviteIds.add(inviteId);
        const maxMatchIndex = parseInviteMatchIndex(inviteId, matchId) ?? 0;
        const previousMaxMatchIndex = inviteMaxMatchIndices.get(inviteId) ?? 0;
        if (maxMatchIndex > previousMaxMatchIndex) {
          inviteMaxMatchIndices.set(inviteId, maxMatchIndex);
          inviteLatestMatchIdHints.set(inviteId, matchId);
        }
        const nextSortHint = this.buildFallbackSortHint(
          maxMatchIndex,
          lastSeenOrder,
        );
        const previousSortHint = inviteSortHints.get(inviteId);
        if (!previousSortHint || nextSortHint > previousSortHint) {
          inviteSortHints.set(inviteId, nextSortHint);
        }
      }
      lastSeenOrder -= 1;
    }

    const profileCache = new Map<string, PlayerProfile | null>();
    const emojiCache = new Map<string, number | null>();
    const items: NavigationGameItem[] = [];
    const inviteIdList = Array.from(inviteIds);
    const buildConcurrency = 8;
    for (
      let startIndex = 0;
      startIndex < inviteIdList.length;
      startIndex += buildConcurrency
    ) {
      const chunk = inviteIdList.slice(
        startIndex,
        startIndex + buildConcurrency,
      );
      const chunkItems = await Promise.all(
        chunk.map(async (inviteId) => {
          try {
            const inviteData = await this.getInviteForFallback(
              inviteId,
              inviteCache,
            );
            if (!inviteData) {
              return null;
            }
            return await this.buildFallbackNavigationItem(
              inviteId,
              inviteData,
              currentLoginUid,
              profileCache,
              emojiCache,
              inviteSortHints.get(inviteId) ?? 1,
              inviteLatestMatchIdHints.get(inviteId) ?? inviteId,
            );
          } catch {
            return null;
          }
        }),
      );
      chunkItems.forEach((fallbackItem) => {
        if (fallbackItem) {
          items.push(fallbackItem);
        }
      });
    }

    items.sort((a, b) => this.compareNavigationItems(a, b));
    return items.slice(0, boundedLimit);
  }

  public async updateRatings(): Promise<RatingUpdateResponse> {
    try {
      await this.ensureAuthenticated();
      const writableContext = this.requireWritableContext(
        undefined,
        "updateRatings",
      );
      if (!writableContext) {
        return { ok: false };
      }
      const opponentId = this.getOpponentId(writableContext.actorUid);
      const response = await updateRatingsViaApi(
        {
          playerId: writableContext.actorUid,
          inviteId: writableContext.inviteId,
          matchId: writableContext.matchId,
          opponentId,
        },
        this.getAuthApiToken,
        {
          shouldRetry: () =>
            this.auth.currentUser?.uid === writableContext.loginUid,
        },
      );
      this.notifyNavigationGamesChanged();
      return response;
    } catch (error) {
      console.error("Error updating ratings:", error);
      throw error;
    }
  }

  public async resolveWagerOutcome(isWin?: boolean): Promise<any> {
    const sessionGuard = this.createSessionGuard();
    const profileIdAtRequest = storage.getProfileId("");
    let restoreOptimisticState = (_state?: MatchWagerState | null) => {};
    try {
      await this.ensureAuthenticated();
      const writableContext = this.requireWritableContext(
        undefined,
        "wagerOutcomeResolve",
      );
      if (!writableContext) {
        return { ok: false };
      }
      const opponentId = this.getOpponentId(writableContext.actorUid);
      if (!opponentId) {
        return { ok: false };
      }
      const inviteId = writableContext.inviteId;
      const matchId = writableContext.matchId;
      const matchGuard = this.createMatchContextGuard(inviteId, matchId);
      const previousWagerState = this.cloneWagerState(getWagerState());
      const optimisticApplied = this.applyOptimisticWagerResolution(isWin);
      restoreOptimisticState = (state = previousWagerState) => {
        if (!optimisticApplied) {
          return;
        }
        this.restoreOptimisticWagerResolution(matchId, state, matchGuard);
      };
      console.log("wager:resolve:start", {
        inviteId,
        matchId,
        opponentId,
      });
      const data = await this.callWagerApiWithRetry("wager:resolve", () =>
        resolveWagerOutcomeViaApi(
          {
            inviteId,
            matchId,
          },
          this.getAuthApiToken,
        ),
      );
      const responseData = data as WagerOutcomeResolveResponse | null;
      console.log("wager:resolve:done", responseData);
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
        sessionGuard() &&
        storage.getProfileId("") === profileIdAtRequest
      ) {
        rocksMiningService.setFromServer(responseData.mining, {
          persist: true,
        });
      }
      return responseData;
    } catch (error) {
      restoreOptimisticState();
      console.error("Error resolving wager outcome:", error);
      throw error;
    }
  }

  public async sendWagerProposal(
    material: MiningMaterialName,
    count: number,
  ): Promise<any> {
    let prevState: MatchWagerState | null = null;
    let prevFrozen: Record<MiningMaterialName, number> | null = null;
    let optimisticCount = 0;
    let optimisticApplied = false;
    let sessionGuard: (() => boolean) | null = null;
    let playerUid: string | null = null;
    try {
      await this.ensureAuthenticated();
      const writableContext = this.requireWritableContext(
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
        console.log("wager:send:skipped", { inviteId, matchId });
        return { ok: false };
      }
      sessionGuard = this.createMatchContextGuard(inviteId, matchId);
      const currentState = getWagerState();
      if (!currentState?.agreed && !currentState?.resolved) {
        const totalMaterials = rocksMiningService.getSnapshot().materials;
        const frozenMaterials = getFrozenMaterials();
        const available = computeAvailableMaterials(
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
            createdAt: Date.now(),
          };
          const proposedBy = { ...(currentState?.proposedBy ?? {}) };
          proposedBy[playerUid] = true;
          const nextState: MatchWagerState = {
            ...(currentState ?? {}),
            proposals,
            proposedBy,
          };
          this.setLocalWagerState(nextState);
          applyFrozenMaterialsDelta({ [material]: optimisticCount });
          optimisticApplied = true;
        }
      }
      console.log("wager:send:start", { inviteId, matchId, material, count });
      const data = await this.callWagerApiWithRetry("wager:send", () =>
        sendWagerProposalViaApi(
          { inviteId, matchId, material, count },
          this.getAuthApiToken,
        ),
      );
      if (!sessionGuard()) {
        return { ok: false };
      }
      console.log("wager:send:done", data);
      if (optimisticApplied) {
        if (data && data.ok === false) {
          const latestState = getWagerState();
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
              setFrozenMaterials(prevFrozen);
            }
          }
        } else if (data && data.agreed) {
          const agreed: WagerAgreement = data.agreed;
          const latestState = getWagerState();
          if (!latestState?.resolved) {
            const nextState: MatchWagerState = {
              ...(latestState ?? {}),
              proposals: undefined,
              agreed,
            };
            this.setLocalWagerState(nextState);
            const delta = agreed.count - optimisticCount;
            if (delta !== 0) {
              applyFrozenMaterialsDelta({ [material]: delta });
            }
          }
        } else if (data && typeof data.count === "number") {
          const serverCount = Math.max(0, Math.round(data.count));
          if (serverCount !== optimisticCount) {
            const latestState = getWagerState();
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
                applyFrozenMaterialsDelta({ [material]: delta });
              }
            }
          }
        }
      }
      return data;
    } catch (error) {
      console.error("wager:send:error", error);
      if (sessionGuard && !sessionGuard()) {
        return { ok: false };
      }
      if (optimisticApplied) {
        const latestState = getWagerState();
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
            setFrozenMaterials(prevFrozen);
          }
        }
      }
      throw error;
    }
  }

  public async cancelWagerProposal(): Promise<any> {
    let prevState: MatchWagerState | null = null;
    let prevFrozen: Record<MiningMaterialName, number> | null = null;
    let optimisticApplied = false;
    let proposal: WagerProposal | null = null;
    let sessionGuard: (() => boolean) | null = null;
    let playerUid: string | null = null;
    try {
      await this.ensureAuthenticated();
      const writableContext = this.requireWritableContext(
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
        console.log("wager:cancel:skipped", { inviteId, matchId });
        return { ok: false };
      }
      sessionGuard = this.createMatchContextGuard(inviteId, matchId);
      const currentState = getWagerState();
      const existingProposal = currentState?.proposals
        ? currentState.proposals[playerUid]
        : null;
      if (
        existingProposal &&
        !currentState?.agreed &&
        !currentState?.resolved
      ) {
        prevState = this.cloneWagerState(currentState);
        prevFrozen = getFrozenMaterials();
        proposal = existingProposal;
        const proposals = { ...(currentState?.proposals ?? {}) };
        delete proposals[playerUid];
        const nextState: MatchWagerState = {
          ...(currentState ?? {}),
          proposals: Object.keys(proposals).length > 0 ? proposals : undefined,
          proposedBy: currentState?.proposedBy,
        };
        this.setLocalWagerState(nextState);
        applyFrozenMaterialsDelta({ [proposal.material]: -proposal.count });
        optimisticApplied = true;
      }
      console.log("wager:cancel:start", { inviteId, matchId });
      const data = await this.callWagerApiWithRetry("wager:cancel", () =>
        cancelWagerProposalViaApi({ inviteId, matchId }, this.getAuthApiToken),
      );
      if (!sessionGuard()) {
        return { ok: false };
      }
      console.log("wager:cancel:done", data);
      if (optimisticApplied && data && data.ok === false) {
        const latestState = getWagerState();
        const hasAgreedOrResolved =
          !!latestState?.agreed || !!latestState?.resolved;
        const stillMissing =
          !latestState?.proposals || !latestState.proposals[playerUid];
        if (!hasAgreedOrResolved && stillMissing) {
          this.setLocalWagerState(prevState);
          if (prevFrozen) {
            setFrozenMaterials(prevFrozen);
          }
        }
      }
      return data;
    } catch (error) {
      console.error("wager:cancel:error", error);
      if (sessionGuard && !sessionGuard()) {
        return { ok: false };
      }
      if (optimisticApplied) {
        const latestState = getWagerState();
        const hasAgreedOrResolved =
          !!latestState?.agreed || !!latestState?.resolved;
        const stillMissing =
          !latestState?.proposals ||
          (playerUid ? !latestState.proposals[playerUid] : true);
        if (!hasAgreedOrResolved && stillMissing) {
          this.setLocalWagerState(prevState);
          if (prevFrozen) {
            setFrozenMaterials(prevFrozen);
          }
        }
      }
      throw error;
    }
  }

  public async declineWagerProposal(): Promise<any> {
    let prevState: MatchWagerState | null = null;
    let optimisticApplied = false;
    let opponentUid: string | null = null;
    let sessionGuard: (() => boolean) | null = null;
    let playerUid: string | null = null;
    try {
      await this.ensureAuthenticated();
      const writableContext = this.requireWritableContext(
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
        console.log("wager:decline:skipped", { inviteId, matchId });
        return { ok: false };
      }
      sessionGuard = this.createMatchContextGuard(inviteId, matchId);
      opponentUid = this.getOpponentId(playerUid);
      const currentState = getWagerState();
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
          proposals: Object.keys(proposals).length > 0 ? proposals : undefined,
          proposedBy: currentState?.proposedBy,
        };
        this.setLocalWagerState(nextState);
        optimisticApplied = true;
      }
      console.log("wager:decline:start", { inviteId, matchId });
      const data = await this.callWagerApiWithRetry("wager:decline", () =>
        declineWagerProposalViaApi({ inviteId, matchId }, this.getAuthApiToken),
      );
      if (!sessionGuard()) {
        return { ok: false };
      }
      console.log("wager:decline:done", data);
      if (optimisticApplied && data && data.ok === false) {
        const latestState = getWagerState();
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
      console.error("wager:decline:error", error);
      if (sessionGuard && !sessionGuard()) {
        return { ok: false };
      }
      if (optimisticApplied) {
        const latestState = getWagerState();
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

  public async acceptWagerProposal(): Promise<any> {
    let prevState: MatchWagerState | null = null;
    let prevFrozen: Record<MiningMaterialName, number> | null = null;
    let optimisticApplied = false;
    let optimisticAgreement: WagerAgreement | null = null;
    let opponentUid: string | null = null;
    let sessionGuard: (() => boolean) | null = null;
    try {
      await this.ensureAuthenticated();
      const writableContext = this.requireWritableContext(
        undefined,
        "acceptWagerProposal",
      );
      if (!writableContext) {
        return { ok: false };
      }
      const inviteId = writableContext.inviteId;
      const matchId = writableContext.matchId;
      if (!writableContext.actorUid) {
        console.log("wager:accept:skipped", { inviteId, matchId });
        return { ok: false };
      }
      sessionGuard = this.createMatchContextGuard(inviteId, matchId);
      const playerUid = writableContext.actorUid;
      opponentUid = this.getOpponentId(playerUid);
      const currentState = getWagerState();
      const proposals = currentState?.proposals ?? null;
      const opponentProposal =
        opponentUid && proposals ? proposals[opponentUid] : null;
      const ownProposal = playerUid && proposals ? proposals[playerUid] : null;
      if (
        opponentProposal &&
        !currentState?.agreed &&
        !currentState?.resolved
      ) {
        const totalMaterials = rocksMiningService.getSnapshot().materials;
        const frozenMaterials = getFrozenMaterials();
        const available = computeAvailableMaterials(
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
            acceptedAt: Date.now(),
          };
          const nextState: MatchWagerState = {
            ...(currentState ?? {}),
            proposals: undefined,
            proposedBy: currentState?.proposedBy,
            agreed: optimisticAgreement,
          };
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
          applyFrozenMaterialsDelta(deltas);
          optimisticApplied = true;
        }
      }
      console.log("wager:accept:start", { inviteId, matchId });
      const data = await this.callWagerApiWithRetry("wager:accept", () =>
        acceptWagerProposalViaApi({ inviteId, matchId }, this.getAuthApiToken),
      );
      if (!sessionGuard()) {
        return { ok: false };
      }
      console.log("wager:accept:done", data);
      if (optimisticApplied && optimisticAgreement) {
        if (data && data.ok === false) {
          const latestState = getWagerState();
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
              setFrozenMaterials(prevFrozen);
            }
          }
        } else if (data && typeof data.count === "number") {
          const serverCount = Math.max(0, Math.round(data.count));
          if (serverCount !== optimisticAgreement.count) {
            const latestState = getWagerState();
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
                applyFrozenMaterialsDelta({
                  [optimisticAgreement.material]: delta,
                });
              }
            }
          }
        }
      }
      return data;
    } catch (error) {
      console.error("wager:accept:error", error);
      if (sessionGuard && !sessionGuard()) {
        return { ok: false };
      }
      if (optimisticApplied && optimisticAgreement) {
        const latestState = getWagerState();
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
            setFrozenMaterials(prevFrozen);
          }
        }
      }
      throw error;
    }
  }

  public updateEmoji(
    newId: number,
    matchOnly: boolean,
    aura: string | null | undefined,
  ): void {
    if (!matchOnly) {
      this.updateStoredEmoji(newId, aura);
    }
    const writableContext = this.requireWritableContext(
      undefined,
      "updateEmoji",
    );
    if (!writableContext || !this.myMatch) {
      return;
    }
    this.myMatch.emojiId = newId;
    this.myMatch.aura = aura ?? undefined;
    set(
      ref(
        this.db,
        `players/${writableContext.actorUid}/matches/${writableContext.matchId}/emojiId`,
      ),
      newId,
    ).catch((error) => {
      console.error("Error updating emoji:", error);
    });
    if (this.myMatch.aura !== undefined) {
      set(
        ref(
          this.db,
          `players/${writableContext.actorUid}/matches/${writableContext.matchId}/aura`,
        ),
        this.myMatch.aura,
      ).catch(() => {});
    }
  }

  private getLocalProfileId(): string | null {
    const id = storage.getProfileId("");
    return id === "" ? null : id;
  }

  private getLocalLoginId(): string | null {
    const id = storage.getLoginId("");
    return id === "" ? null : id;
  }

  private async resolveLocalProfileId(
    loginUid?: string | null,
  ): Promise<string | null> {
    const storedProfileId = this.getLocalProfileId();
    const storedLoginUid = this.getLocalLoginId();
    const normalizedLoginUid = this.normalizeStringOrNull(loginUid);
    if (storedProfileId && !normalizedLoginUid) {
      return storedProfileId;
    }

    if (!normalizedLoginUid) {
      const claimedProfileId = this.normalizeStringOrNull(
        await this.getCurrentProfileClaimId(),
      );
      if (claimedProfileId) {
        return claimedProfileId;
      }
      return storedProfileId;
    }

    try {
      const profileSnapshot = await get(
        ref(this.db, `players/${normalizedLoginUid}/profile`),
      );
      const linkedProfileId = this.normalizeStringOrNull(profileSnapshot.val());
      if (linkedProfileId) {
        return linkedProfileId;
      }
    } catch {}

    try {
      const profile = await this.getProfileByLoginId(normalizedLoginUid);
      return this.normalizeStringOrNull(profile.id);
    } catch {}

    const claimedProfileId = this.normalizeStringOrNull(
      await this.getCurrentProfileClaimId(),
    );
    if (claimedProfileId) {
      return claimedProfileId;
    }

    const canUseStoredProfileForLogin =
      !!storedProfileId &&
      (!normalizedLoginUid ||
        !storedLoginUid ||
        storedLoginUid === normalizedLoginUid);
    if (canUseStoredProfileForLogin) {
      return storedProfileId;
    }

    return null;
  }

  private hydrateSameProfilePlayer(uid: string): void {
    const expectedEpoch = this.sessionEpoch;
    setupPlayerId(uid, false);
    const activeRequest = this.sameProfileHydrationRequest;
    if (
      activeRequest?.uid === uid &&
      activeRequest.sessionEpoch === expectedEpoch
    ) {
      activeRequest.refreshRequested = true;
      return;
    }
    const request = {
      uid,
      sessionEpoch: expectedEpoch,
      refreshRequested: false,
    };
    this.sameProfileHydrationRequest = request;
    const isHydrationActive = () =>
      this.sameProfileHydrationRequest === request &&
      this.isSessionEpochActive(expectedEpoch) &&
      this.sameProfilePlayerUid === uid;
    this.getPlayerProfile(uid)
      .then((profile) => {
        if (!isHydrationActive()) {
          return;
        }
        this.stopObservingProfile(uid);
        didGetPlayerProfile(profile, uid, true);
      })
      .catch(() => {
        if (!isHydrationActive()) {
          return;
        }
        this.observeProfile(uid, this.activeContext, true);
      })
      .finally(() => {
        if (this.sameProfileHydrationRequest !== request) {
          return;
        }
        this.sameProfileHydrationRequest = null;
        if (
          request.refreshRequested &&
          this.isSessionEpochActive(expectedEpoch) &&
          this.sameProfilePlayerUid === uid
        ) {
          this.hydrateSameProfilePlayer(uid);
        }
      });
  }

  private setSameProfilePlayerUid(uid: string | null): void {
    if (this.sameProfilePlayerUid === uid) {
      if (uid) {
        this.hydrateSameProfilePlayer(uid);
      }
      return;
    }
    this.sameProfileHydrationRequest = null;
    this.sameProfilePlayerUid = uid;
    this.observeMiningFrozen(uid);
    if (uid) {
      this.hydrateSameProfilePlayer(uid);
    }
  }

  public getActiveMatchId(): string | null {
    return this.activeContext?.matchId ?? null;
  }

  public setWagerViewMatchId(matchId: string | null): void {
    this.wagerViewMatchId = matchId;
    this.logWagerDebug("set-view-match", { nextViewMatchId: matchId });
    this.updateWagerStateForCurrentMatch();
  }

  public updateStoredEmoji(
    newId: number,
    aura: string | null | undefined,
  ): void {
    const storedAura = aura ?? storage.getPlayerEmojiAura("");
    this.updateCustomField({
      field: "emojiAndAura",
      value: {
        emoji: newId,
        aura: storedAura === "rainbow" ? "rainbow" : "",
      },
    });
  }

  public updateCardBackgroundId(newId: number): void {
    this.updateCustomField({ field: "cardBackgroundId", value: newId });
  }

  public updateCardSubtitleId(newId: number): void {
    this.updateCustomField({ field: "cardSubtitleId", value: newId });
  }

  public updateProfileCounter(counter: string): void {
    if (counter === "gp" || counter === "mp") {
      this.updateCustomField({ field: "profileCounter", value: counter });
    }
  }

  public updateProfileMons(mons: string): void {
    this.updateCustomField({ field: "profileMons", value: mons });
  }

  public updateCardStickers(stickers: string): void {
    this.updateCustomField({ field: "cardStickers", value: stickers });
  }

  public updateCompletedProblems(ids: string[]): void {
    this.updateCustomField({ field: "completedProblems", value: ids });
  }

  public updateTutorialCompleted(completed: boolean): void {
    this.updateCustomField({ field: "tutorialCompleted", value: completed });
  }

  private updateCustomField(request: ProfileCustomizationUpdateRequest): void {
    const profileId = this.getLocalProfileId();
    if (profileId === null) {
      return;
    }
    let tokenProvider: AuthTokenProvider;
    try {
      tokenProvider = this.getUserBoundAuthTokenProvider();
    } catch {
      return;
    }
    void updateProfileCustomizationViaApi(request, tokenProvider).catch(
      () => undefined,
    );
  }

  public sendVoiceReaction(reaction: Reaction): void {
    const writableContext = this.requireWritableContext(
      undefined,
      "sendVoiceReaction",
    );
    if (!writableContext) {
      return;
    }
    const inviteReaction: InviteReaction = {
      ...reaction,
      matchId: writableContext.matchId,
    };
    set(
      ref(
        this.db,
        `invites/${writableContext.inviteId}/reactions/${writableContext.actorUid}`,
      ),
      inviteReaction,
    ).catch((error) => {
      console.error("Error sending voice reaction:", error);
    });
  }

  public surrender(): boolean {
    if (!this.myMatch) {
      return false;
    }
    const previousStatus = this.myMatch.status;
    this.myMatch.status = "surrendered";
    const didQueueUpdate = this.sendMatchUpdate(
      this.activeContext?.matchId ?? null,
    );
    if (!didQueueUpdate) {
      this.myMatch.status = previousStatus;
      return false;
    }
    return true;
  }

  public sendMove(
    moveFen: string,
    newBoardFen: string,
    expectedMatchId: string,
  ): void {
    const writableContext = this.requireWritableContext(
      expectedMatchId,
      "sendMove",
    );
    if (!writableContext || !this.myMatch) {
      this.logContextEvent("ctx.write.blocked", {
        reason: "sendMove",
        blockReason: "missing-writable-context-or-match",
        expectedMatchId,
      });
      return;
    }
    const previousFlatMovesString = this.myMatch.flatMovesString ?? "";
    this.myMatch.fen = newBoardFen;
    this.myMatch.flatMovesString = previousFlatMovesString
      ? `${previousFlatMovesString}-${moveFen}`
      : moveFen;
    const matchToPersist: Match = { ...this.myMatch };
    const expectedFlatMovesString = this.myMatch.flatMovesString ?? "";
    const requestId = ++this.moveSendRequestId;
    void this.sendCriticalMoveUpdateWithRetry(
      requestId,
      writableContext.inviteId,
      writableContext.matchId,
      writableContext.actorUid,
      writableContext.contextId,
      writableContext.sessionEpoch,
      matchToPersist,
      newBoardFen,
      expectedFlatMovesString,
      previousFlatMovesString,
    );
  }

  private shouldContinueCriticalMoveSend(
    requestId: number,
    matchId: string,
    playerUid: string,
    contextId: number,
    contextEpoch: number,
    sessionGuard: () => boolean,
  ): boolean {
    const activeContext = this.activeContext;
    return (
      requestId === this.moveSendRequestId &&
      sessionGuard() &&
      this.isContextActive(contextId, contextEpoch) &&
      !!activeContext &&
      activeContext.matchId === matchId &&
      activeContext.actorUid === playerUid
    );
  }

  private async runMoveTransactionWithTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
  ): Promise<
    | { timedOut: false; value: T }
    | { timedOut: true; pendingAttempt: Promise<void> }
  > {
    let settled = false;
    const trackedPromise = promise.finally(() => {
      settled = true;
    });
    const raceResult = await Promise.race([
      trackedPromise.then((value) => ({ kind: "value" as const, value })),
      this.delay(timeoutMs).then(() => ({ kind: "timeout" as const })),
    ]);
    if (raceResult.kind === "timeout") {
      if (settled) {
        return { timedOut: false, value: await trackedPromise };
      }
      return {
        timedOut: true,
        pendingAttempt: trackedPromise.then(
          () => undefined,
          () => undefined,
        ),
      };
    }
    return { timedOut: false, value: raceResult.value };
  }

  private getMoveSendErrorCode(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }
    return "unknown-move-send-error";
  }

  private getMoveSendPendingAttempt(error: unknown): Promise<void> | null {
    if (!error || typeof error !== "object") {
      return null;
    }
    const pendingAttempt = (error as { pendingAttempt?: unknown })
      .pendingAttempt;
    if (
      !pendingAttempt ||
      typeof (pendingAttempt as Promise<void>).then !== "function"
    ) {
      return null;
    }
    return pendingAttempt as Promise<void>;
  }

  private async waitForPromiseToSettle(
    promise: Promise<void>,
    timeoutMs: number,
  ): Promise<boolean> {
    if (timeoutMs <= 0) {
      return false;
    }
    let settled = false;
    await Promise.race([
      promise.finally(() => {
        settled = true;
      }),
      this.delay(timeoutMs),
    ]);
    return settled;
  }

  private async sendMoveAttempt(
    playerUid: string,
    matchId: string,
    matchToPersist: Match,
    expectedFen: string,
    expectedFlatMovesString: string,
    previousFlatMovesString: string,
    timeoutMs: number,
  ): Promise<void> {
    const matchPath = `players/${playerUid}/matches/${matchId}`;
    const matchRef = ref(this.db, matchPath);
    const transactionResult = await this.runMoveTransactionWithTimeout(
      runTransaction(
        matchRef,
        (currentValue) => {
          const currentMatch = currentValue as Match | null;
          if (!currentMatch) {
            return matchToPersist;
          }
          const currentFlatMovesString = currentMatch.flatMovesString ?? "";
          if (
            currentFlatMovesString === expectedFlatMovesString &&
            currentMatch.fen === expectedFen
          ) {
            return currentMatch;
          }
          if (currentFlatMovesString !== previousFlatMovesString) {
            return currentMatch;
          }
          const nextGameVariant =
            typeof currentMatch.gameVariant === "string" &&
            currentMatch.gameVariant !== ""
              ? currentMatch.gameVariant
              : typeof matchToPersist.gameVariant === "string" &&
                  matchToPersist.gameVariant !== ""
                ? matchToPersist.gameVariant
                : undefined;
          return {
            ...currentMatch,
            ...(nextGameVariant ? { gameVariant: nextGameVariant } : {}),
            fen: expectedFen,
            flatMovesString: expectedFlatMovesString,
          } as Match;
        },
        { applyLocally: false },
      ),
      timeoutMs,
    );
    if (transactionResult.timedOut) {
      const timeoutError = new Error("move-send-attempt-timeout") as Error & {
        pendingAttempt?: Promise<void>;
      };
      timeoutError.pendingAttempt = transactionResult.pendingAttempt;
      throw timeoutError;
    }
    const result = transactionResult.value;
    const persistedMatch = result.snapshot.val() as Match | null;
    if (!persistedMatch) {
      if (!result.committed) {
        throw new Error("move-send-transaction-not-committed");
      }
      throw new Error("missing-persisted-match");
    }
    const persistedFlatMovesString = persistedMatch.flatMovesString ?? "";
    if (
      persistedMatch.fen === expectedFen &&
      persistedFlatMovesString === expectedFlatMovesString
    ) {
      return;
    }
    if (persistedFlatMovesString !== previousFlatMovesString) {
      throw new Error("remote-move-chain-mismatch");
    }
    if (!result.committed) {
      throw new Error("move-send-transaction-not-committed");
    }
    throw new Error("mismatch-persisted-match");
  }

  private async verifyMovePersistedAfterRetryWindow(
    requestId: number,
    playerUid: string,
    matchId: string,
    contextId: number,
    contextEpoch: number,
    expectedFen: string,
    expectedFlatMovesString: string,
    sessionGuard: () => boolean,
  ): Promise<boolean> {
    const verificationStartedAt = Date.now();
    while (
      Date.now() - verificationStartedAt <
      this.moveSendPostRetryVerificationWindowMs
    ) {
      if (
        !this.shouldContinueCriticalMoveSend(
          requestId,
          matchId,
          playerUid,
          contextId,
          contextEpoch,
          sessionGuard,
        )
      ) {
        return false;
      }
      const elapsedMs = Date.now() - verificationStartedAt;
      const remainingMs =
        this.moveSendPostRetryVerificationWindowMs - elapsedMs;
      if (remainingMs <= 0) {
        return false;
      }
      const attemptTimeoutMs = Math.min(remainingMs, 1200);
      const matchRef = ref(this.db, `players/${playerUid}/matches/${matchId}`);
      try {
        const verificationResult = await this.runMoveTransactionWithTimeout(
          get(matchRef),
          attemptTimeoutMs,
        );
        if (!verificationResult.timedOut) {
          const persistedMatch = verificationResult.value.val() as Match | null;
          const persistedFlatMovesString =
            persistedMatch?.flatMovesString ?? "";
          if (
            persistedMatch &&
            persistedMatch.fen === expectedFen &&
            persistedFlatMovesString === expectedFlatMovesString
          ) {
            return true;
          }
        }
      } catch {}
      if (
        !this.shouldContinueCriticalMoveSend(
          requestId,
          matchId,
          playerUid,
          contextId,
          contextEpoch,
          sessionGuard,
        )
      ) {
        return false;
      }
      const remainingAfterAttemptMs =
        this.moveSendPostRetryVerificationWindowMs -
        (Date.now() - verificationStartedAt);
      if (remainingAfterAttemptMs <= 0) {
        return false;
      }
      const waitMs = Math.min(
        this.moveSendPostRetryPollIntervalMs,
        remainingAfterAttemptMs,
      );
      await this.delay(waitMs);
    }
    return false;
  }

  private getMoveRetryDelayMs(attempt: number): number {
    return Math.min(700 + attempt * 350, 3000);
  }

  private reconnectAfterMatchUpdateFailure(
    inviteId: string | null,
    sessionGuard: () => boolean,
  ): void {
    if (!inviteId) {
      return;
    }
    const now = Date.now();
    if (this.moveReconnectInFlight) {
      return;
    }
    if (now - this.moveReconnectLastAttemptAt < this.moveReconnectCooldownMs) {
      return;
    }
    this.moveReconnectInFlight = true;
    this.moveReconnectLastAttemptAt = now;
    this.signIn()
      .then((uid) => {
        if (uid && sessionGuard()) {
          this.connectToGame(uid, inviteId, false);
        }
      })
      .finally(() => {
        this.moveReconnectInFlight = false;
      });
  }

  private async sendCriticalMoveUpdateWithRetry(
    requestId: number,
    inviteId: string | null,
    matchId: string,
    playerUid: string,
    contextId: number,
    contextEpoch: number,
    matchToPersist: Match,
    expectedFen: string,
    expectedFlatMovesString: string,
    previousFlatMovesString: string,
  ): Promise<void> {
    const sessionGuard = this.createSessionGuard();
    const startedAt = Date.now();
    let attempt = 0;
    while (true) {
      const elapsedMs = Date.now() - startedAt;
      const remainingMs = this.moveSendRetryWindowMs - elapsedMs;
      if (remainingMs <= 0) {
        break;
      }
      if (
        !this.shouldContinueCriticalMoveSend(
          requestId,
          matchId,
          playerUid,
          contextId,
          contextEpoch,
          sessionGuard,
        )
      ) {
        return;
      }
      attempt += 1;
      try {
        const attemptTimeoutMs = Math.min(
          remainingMs,
          this.moveSendAttemptMaxTimeoutMs,
        );
        await this.sendMoveAttempt(
          playerUid,
          matchId,
          matchToPersist,
          expectedFen,
          expectedFlatMovesString,
          previousFlatMovesString,
          attemptTimeoutMs,
        );
        if (
          !this.shouldContinueCriticalMoveSend(
            requestId,
            matchId,
            playerUid,
            contextId,
            contextEpoch,
            sessionGuard,
          )
        ) {
          return;
        }
        this.logContextEvent("ctx.write.success", {
          reason: "sendMove",
          attempt,
          inviteId,
          matchId,
          actorUid: playerUid,
          contextId,
          sessionEpoch: contextEpoch,
        });
        this.myMatch = matchToPersist;
        return;
      } catch (error) {
        if (
          !this.shouldContinueCriticalMoveSend(
            requestId,
            matchId,
            playerUid,
            contextId,
            contextEpoch,
            sessionGuard,
          )
        ) {
          return;
        }
        const errorCode = this.getMoveSendErrorCode(error);
        if (errorCode === "remote-move-chain-mismatch") {
          this.logContextEvent("ctx.write.fail", {
            reason: "sendMove",
            errorCode,
            inviteId,
            matchId,
            actorUid: playerUid,
            contextId,
            sessionEpoch: contextEpoch,
          });
          this.reconnectAfterMatchUpdateFailure(inviteId, sessionGuard);
          return;
        }
        this.logContextEvent("ctx.write.retry", {
          reason: "sendMove",
          inviteId,
          matchId,
          actorUid: playerUid,
          contextId,
          sessionEpoch: contextEpoch,
          attempt,
          errorCode,
        });
        this.reconnectAfterMatchUpdateFailure(inviteId, sessionGuard);
        const pendingAttempt = this.getMoveSendPendingAttempt(error);
        if (pendingAttempt) {
          const remainingAfterFailureMs =
            this.moveSendRetryWindowMs - (Date.now() - startedAt);
          if (remainingAfterFailureMs <= 0) {
            break;
          }
          const didPendingAttemptSettle = await this.waitForPromiseToSettle(
            pendingAttempt,
            remainingAfterFailureMs,
          );
          if (!didPendingAttemptSettle) {
            break;
          }
        }
        const remainingAfterFailureMs =
          this.moveSendRetryWindowMs - (Date.now() - startedAt);
        if (remainingAfterFailureMs <= 0) {
          break;
        }
        const retryDelayMs = Math.min(
          this.getMoveRetryDelayMs(attempt),
          remainingAfterFailureMs,
        );
        if (retryDelayMs > 0) {
          await this.delay(retryDelayMs);
        }
      }
    }
    if (
      !this.shouldContinueCriticalMoveSend(
        requestId,
        matchId,
        playerUid,
        contextId,
        contextEpoch,
        sessionGuard,
      )
    ) {
      return;
    }
    const didVerifyPersistedMove =
      await this.verifyMovePersistedAfterRetryWindow(
        requestId,
        playerUid,
        matchId,
        contextId,
        contextEpoch,
        expectedFen,
        expectedFlatMovesString,
        sessionGuard,
      );
    if (didVerifyPersistedMove) {
      if (
        !this.shouldContinueCriticalMoveSend(
          requestId,
          matchId,
          playerUid,
          contextId,
          contextEpoch,
          sessionGuard,
        )
      ) {
        return;
      }
      this.logContextEvent("ctx.write.success", {
        reason: "sendMove",
        inviteId,
        matchId,
        actorUid: playerUid,
        contextId,
        sessionEpoch: contextEpoch,
        viaPostRetryVerification: true,
      });
      this.myMatch = matchToPersist;
      return;
    }
    if (
      !this.shouldContinueCriticalMoveSend(
        requestId,
        matchId,
        playerUid,
        contextId,
        contextEpoch,
        sessionGuard,
      )
    ) {
      return;
    }
    this.logContextEvent("ctx.write.fail", {
      reason: "sendMove",
      inviteId,
      matchId,
      actorUid: playerUid,
      contextId,
      sessionEpoch: contextEpoch,
      elapsedMs: Date.now() - startedAt,
    });
    this.reconnectAfterMatchUpdateFailure(
      this.inviteId ?? inviteId,
      sessionGuard,
    );
    if (typeof window !== "undefined") {
      window.location.reload();
    }
  }

  public signInIfNeededAndConnectToGame(
    inviteId: string,
    autojoin: boolean,
  ): void {
    const sessionGuard = this.createSessionGuard();
    this.signIn().then((uid) => {
      if (uid && sessionGuard()) {
        this.connectToGame(uid, inviteId, autojoin);
      } else {
        console.log("failed to get game info");
      }
    });
  }

  private sendMatchUpdate(expectedMatchId: string | null): boolean {
    const writableContext = this.requireWritableContext(
      expectedMatchId,
      "sendMatchUpdate",
    );
    if (!writableContext || !this.myMatch) {
      return false;
    }
    const sessionGuard = this.createMatchContextGuard(
      writableContext.inviteId,
      writableContext.matchId,
    );
    set(
      ref(
        this.db,
        `players/${writableContext.actorUid}/matches/${writableContext.matchId}`,
      ),
      this.myMatch,
    )
      .then(() => {
        if (!sessionGuard()) {
          return;
        }
        this.logContextEvent("ctx.write.success", {
          reason: "sendMatchUpdate",
          inviteId: writableContext.inviteId,
          matchId: writableContext.matchId,
          actorUid: writableContext.actorUid,
          contextId: writableContext.contextId,
          sessionEpoch: writableContext.sessionEpoch,
        });
      })
      .catch((error) => {
        if (!sessionGuard()) {
          return;
        }
        this.logContextEvent("ctx.write.fail", {
          reason: "sendMatchUpdate",
          inviteId: writableContext.inviteId,
          matchId: writableContext.matchId,
          actorUid: writableContext.actorUid,
          contextId: writableContext.contextId,
          sessionEpoch: writableContext.sessionEpoch,
          error: error instanceof Error ? error.message : String(error),
        });
        this.reconnectAfterMatchUpdateFailure(
          writableContext.inviteId,
          this.createSessionGuard(),
        );
      });
    return true;
  }

  private rematchSeriesEndIsIndicatedForInvite(
    invite: Invite | null | undefined,
  ): boolean {
    return rematchSeriesEnded(invite);
  }

  private getLatestBothSidesApprovedRematchIndexForInvite(
    invite: Invite | null | undefined,
  ): number | null {
    if (!invite) {
      return null;
    }
    const approvedIndices = this.approvedRematchIndices(
      parseRematchIndices(invite.hostRematches),
      parseRematchIndices(invite.guestRematches),
    );
    if (approvedIndices.length === 0) {
      return null;
    }
    const latestApproved = approvedIndices[approvedIndices.length - 1];
    return latestApproved ?? null;
  }

  private getLatestBothSidesApprovedRematchIndex(): number | null {
    return this.getLatestBothSidesApprovedRematchIndexForInvite(
      this.latestInvite,
    );
  }

  private getLatestMatchIdForActor(
    inviteId: string,
    invite: Invite,
    actorUid: string | null,
  ): { matchId: string; hasPendingProposal: boolean } {
    const hostIndices = parseRematchIndices(invite.hostRematches);
    const guestIndices = parseRematchIndices(invite.guestRematches);
    let rematchIndex =
      this.getLatestBothSidesApprovedRematchIndexForInvite(invite);
    let hasPendingProposal = false;
    if (!this.rematchSeriesEndIsIndicatedForInvite(invite) && actorUid) {
      const hostHasPending =
        invite.hostId === actorUid && hostIndices.length > guestIndices.length;
      const guestHasPending =
        invite.guestId === actorUid && guestIndices.length > hostIndices.length;
      if (hostHasPending || guestHasPending) {
        rematchIndex = rematchIndex ? rematchIndex + 1 : 1;
        hasPendingProposal = true;
      }
    }
    if (!rematchIndex) {
      return { matchId: inviteId, hasPendingProposal };
    }
    return { matchId: `${inviteId}${rematchIndex}`, hasPendingProposal };
  }

  private maybeRefreshContextAfterRematchMetadata(
    context: MatchRuntimeContext,
  ): void {
    if (!this.latestInvite) {
      return;
    }
    if (!this.isContextActive(context.contextId, context.sessionEpoch)) {
      return;
    }
    if (
      this.pendingRematchProposal?.inviteId === context.inviteId &&
      this.pendingRematchProposal.contextId === context.contextId
    ) {
      return;
    }
    if (!context.canWrite || !context.actorUid) {
      return;
    }
    if (this.rematchSeriesEndIsIndicatedForInvite(this.latestInvite)) {
      return;
    }
    const next = this.getLatestMatchIdForActor(
      context.inviteId,
      this.latestInvite,
      context.actorUid,
    );
    if (next.hasPendingProposal) {
      didDiscoverExistingRematchProposalWaitingForResponse();
    }
    if (next.matchId === context.matchId) {
      return;
    }
    this.logContextEvent("ctx.write.retry", {
      reason: "rematch-context-rotate",
      inviteId: context.inviteId,
      currentMatchId: context.matchId,
      nextMatchId: next.matchId,
      actorUid: context.actorUid,
      contextId: context.contextId,
      sessionEpoch: context.sessionEpoch,
    });
    this.connectToGame(context.loginUid, context.inviteId, false);
  }

  private async fetchInviteWithPendingCreation(
    inviteId: string,
    epoch: number,
    connectAttemptId: number,
  ): Promise<Invite | null> {
    const inviteRef = ref(this.db, `invites/${inviteId}`);
    const initialSnapshot = await get(inviteRef);
    if (!this.isConnectAttemptActive(connectAttemptId, epoch)) {
      return null;
    }
    let inviteData: Invite | null = initialSnapshot.val();
    if (inviteData && !this.hasPendingInviteCreationFor(inviteId)) {
      return inviteData;
    }
    const didWaitForPendingInvite = await this.waitForPendingInviteCreation(
      inviteId,
      epoch,
    );
    if (
      !didWaitForPendingInvite ||
      !this.isConnectAttemptActive(connectAttemptId, epoch)
    ) {
      return null;
    }
    if (inviteData) {
      return inviteData;
    }
    const refreshedSnapshot = await get(inviteRef);
    if (!this.isConnectAttemptActive(connectAttemptId, epoch)) {
      return null;
    }
    inviteData = refreshedSnapshot.val();
    return inviteData;
  }

  private async resolveActorUidForInvite(
    invite: Invite,
    loginUid: string,
    localProfileId: string | null,
    epoch: number,
    connectAttemptId: number,
  ): Promise<{ actorUid: string | null; role: InviteRole }> {
    const hostId = invite.hostId;
    const guestId = invite.guestId ?? null;
    if (loginUid === hostId) {
      return { actorUid: hostId, role: "host" };
    }
    if (guestId && loginUid === guestId) {
      return { actorUid: guestId, role: "guest" };
    }
    if (localProfileId) {
      try {
        const matchingUid = await this.checkBothPlayerProfiles(
          hostId,
          guestId ?? "",
          localProfileId,
        );
        if (!this.isConnectAttemptActive(connectAttemptId, epoch)) {
          return { actorUid: null, role: "watch" };
        }
        if (matchingUid === hostId) {
          return { actorUid: hostId, role: "host" };
        }
        if (guestId && matchingUid === guestId) {
          return { actorUid: guestId, role: "guest" };
        }
      } catch {
        if (!this.isConnectAttemptActive(connectAttemptId, epoch)) {
          return { actorUid: null, role: "watch" };
        }
      }
    }
    return { actorUid: null, role: "watch" };
  }

  public connectToGame(uid: string, inviteId: string, autojoin: boolean): void {
    const isPendingLocalInviteCreation =
      this.pendingInviteCreation?.inviteId === inviteId;
    const cachedInvite =
      this.inviteId === inviteId && this.latestInvite
        ? { ...this.latestInvite }
        : null;
    this.detachFromMatchSession();
    this.loginUid = uid;
    const connectEpoch = this.sessionEpoch;
    const connectAttemptId = this.connectAttemptId;
    const isConnectActive = () =>
      this.isConnectAttemptActive(connectAttemptId, connectEpoch);
    let tokenProvider: AuthTokenProvider & {
      readonly assertCurrentUser: () => void;
    };
    try {
      tokenProvider = this.getUserBoundAuthTokenProvider(uid);
    } catch {
      return;
    }

    const resolveInvite = (async () => {
      if (cachedInvite) {
        return cachedInvite;
      }
      try {
        return await this.fetchInviteWithPendingCreation(
          inviteId,
          connectEpoch,
          connectAttemptId,
        );
      } catch (error) {
        if (!autojoin || !isAutoInviteId(inviteId)) {
          throw error;
        }
      }
      await joinInviteViaApi(
        {
          operationId: crypto.randomUUID(),
          inviteId,
          emojiId: getPlayersEmojiId(),
          aura: storage.getPlayerEmojiAura(""),
        },
        tokenProvider,
      );
      tokenProvider.assertCurrentUser();
      this.notifyNavigationGamesChanged();
      if (!isConnectActive()) {
        return null;
      }
      return this.fetchInviteWithPendingCreation(
        inviteId,
        connectEpoch,
        connectAttemptId,
      );
    })();

    void resolveInvite
      .then(async (inviteData) => {
        if (!isConnectActive()) {
          return;
        }
        if (!inviteData) {
          console.log("No invite data found");
          if (isPendingLocalInviteCreation) {
            didFailToLoadPendingInvite();
          }
          return;
        }

        const workingInvite: Invite = { ...inviteData };
        const localProfileId = await this.resolveLocalProfileId(uid);
        if (!isConnectActive()) {
          return;
        }
        let shouldAutojoinAsGuest =
          !workingInvite.guestId && workingInvite.hostId !== uid && autojoin;
        if (shouldAutojoinAsGuest && localProfileId) {
          const sameProfilePlayerUid = await this.checkBothPlayerProfiles(
            workingInvite.hostId,
            "",
            localProfileId,
          );
          if (!isConnectActive()) {
            return;
          }
          if (sameProfilePlayerUid === workingInvite.hostId) {
            shouldAutojoinAsGuest = false;
          }
        }
        if (shouldAutojoinAsGuest) {
          try {
            const joinResult = await joinInviteViaApi(
              {
                operationId: crypto.randomUUID(),
                inviteId,
                emojiId: getPlayersEmojiId(),
                aura: storage.getPlayerEmojiAura(""),
              },
              tokenProvider,
            );
            tokenProvider.assertCurrentUser();
            this.notifyNavigationGamesChanged();
            if (!isConnectActive()) {
              return;
            }
            if (joinResult.guestId) {
              workingInvite.guestId = joinResult.guestId;
            }
          } catch {
            if (!isConnectActive()) {
              return;
            }
            try {
              const guestIdSnapshot = await get(
                ref(this.db, `invites/${inviteId}/guestId`),
              );
              if (!isConnectActive()) {
                return;
              }
              const resolvedGuestId = guestIdSnapshot.val();
              if (
                typeof resolvedGuestId === "string" &&
                resolvedGuestId !== ""
              ) {
                workingInvite.guestId = resolvedGuestId;
              }
            } catch {}
          }
        }

        const { actorUid, role } = await this.resolveActorUidForInvite(
          workingInvite,
          uid,
          localProfileId,
          connectEpoch,
          connectAttemptId,
        );
        if (!isConnectActive()) {
          return;
        }
        const { matchId, hasPendingProposal } = this.getLatestMatchIdForActor(
          inviteId,
          workingInvite,
          actorUid,
        );
        const canWrite = role !== "watch" && !!actorUid;
        let myMatch: Match | null = null;
        if (canWrite && actorUid) {
          const myMatchSnapshot = await get(
            ref(this.db, `players/${actorUid}/matches/${matchId}`),
          );
          if (!isConnectActive()) {
            return;
          }
          myMatch = myMatchSnapshot.val() as Match | null;
          if (!myMatch) {
            try {
              const ensured = await ensureMatchViaApi(
                {
                  operationId: crypto.randomUUID(),
                  inviteId,
                  matchId,
                  emojiId: getPlayersEmojiId(),
                  aura: storage.getPlayerEmojiAura(""),
                },
                tokenProvider,
              );
              tokenProvider.assertCurrentUser();
              myMatch = ensured.match as Match;
            } catch (error) {
              console.error("Failed to ensure participant match", error);
            }
          }
          if (!isConnectActive()) {
            return;
          }
          if (!myMatch) {
            console.log("No match data found for writable role", {
              inviteId,
              matchId,
              role,
              actorUid,
            });
            return;
          }
        }

        this.latestInvite = workingInvite;
        this.myMatch = myMatch;
        didRecoverInviteReactions(workingInvite.reactions ?? null);

        const nextContext = this.buildRuntimeContext(
          inviteId,
          matchId,
          uid,
          canWrite ? actorUid : null,
          role,
          canWrite,
          connectEpoch,
        );
        this.activateContext(nextContext, "connect-to-game");
        this.updateWagerStateForCurrentMatch();
        this.observeInviteReactions(nextContext);
        this.observeRematchOrEndMatchIndicators(nextContext);
        this.observeWagers(nextContext);

        if (!canWrite) {
          const canJoinAsGuest =
            !workingInvite.guestId && workingInvite.hostId !== uid && !autojoin;
          if (canJoinAsGuest) {
            didFindInviteThatCanBeJoined();
          } else {
            enterWatchOnlyMode();
            this.observeMatch(workingInvite.hostId, matchId, nextContext);
            if (workingInvite.guestId) {
              this.observeMatch(workingInvite.guestId, matchId, nextContext);
            }
          }
          return;
        }

        didRecoverMyMatch(myMatch!, matchId);
        if (hasPendingProposal) {
          didDiscoverExistingRematchProposalWaitingForResponse();
        }
        if (role === "host") {
          if (workingInvite.guestId) {
            this.observeMatch(workingInvite.guestId, matchId, nextContext);
          } else {
            didFindYourOwnInviteThatNobodyJoined(isAutoInviteId(inviteId));
            const inviteRef = ref(this.db, `invites/${inviteId}`);
            const observerKey = `invite-guest-join:${inviteId}:${matchId}`;
            const unregister = this.observeContextValue(
              nextContext,
              observerKey,
              inviteRef,
              (snapshot) => {
                const updatedInvite = snapshot.val() as Invite | null;
                if (!updatedInvite || !updatedInvite.guestId) {
                  return;
                }
                if (this.latestInvite) {
                  this.latestInvite.guestId = updatedInvite.guestId;
                }
                this.observeMatch(updatedInvite.guestId, matchId, nextContext);
                unregister?.();
              },
            );
          }
        } else {
          this.observeMatch(workingInvite.hostId, matchId, nextContext);
        }

        if (actorUid && actorUid !== uid) {
          void this.refreshTokenIfNeeded();
        }
      })
      .catch((error) => {
        if (!isConnectActive()) {
          return;
        }
        if (isPendingLocalInviteCreation) {
          didFailToLoadPendingInvite();
        }
        console.error("Failed to retrieve invite data:", error);
      });
  }

  public tryNavigateWatchOnlyToLatestApprovedMatch(): boolean {
    if (!this.inviteId || !this.latestInvite) return false;
    const latestIndex = this.getLatestBothSidesApprovedRematchIndex();
    const newMatchId = latestIndex
      ? this.inviteId + latestIndex.toString()
      : this.inviteId;
    if (newMatchId === this.matchId) return false;
    const activeContext = this.activeContext;
    if (activeContext?.canWrite) {
      return false;
    }
    const loginUid = activeContext?.loginUid ?? this.loginUid;
    if (!loginUid) {
      this.logContextEvent("ctx.watch.navigate.blocked", {
        reason: "missing-login-uid",
        inviteId: this.inviteId,
        targetMatchId: newMatchId,
      });
      return false;
    }
    const nextWatchContext = this.buildRuntimeContext(
      this.inviteId,
      newMatchId,
      loginUid,
      null,
      "watch",
      false,
      this.sessionEpoch,
    );
    this.activateContext(nextWatchContext, "watch-only-rematch-nav");
    this.observeInviteReactions(nextWatchContext);
    this.observeRematchOrEndMatchIndicators(nextWatchContext);
    this.observeWagers(nextWatchContext);
    this.updateWagerStateForCurrentMatch();
    this.stopObservingAllMatches();
    const hostId = this.latestInvite.hostId;
    const guestId = this.latestInvite.guestId;
    if (hostId) this.observeMatch(hostId, newMatchId, nextWatchContext);
    if (guestId) this.observeMatch(guestId, newMatchId, nextWatchContext);
    return true;
  }

  public async createInvite(uid: string, inviteId: string): Promise<boolean> {
    try {
      const tokenProvider = this.getUserBoundAuthTokenProvider(uid);
      const response = await createInviteViaApi(
        {
          operationId: crypto.randomUUID(),
          inviteId,
          emojiId: getPlayersEmojiId(),
          aura: storage.getPlayerEmojiAura(""),
        },
        tokenProvider,
      );
      tokenProvider.assertCurrentUser();
      if (response.hostId !== uid || response.inviteId !== inviteId) {
        throw new Error("invite-create-response-mismatch");
      }
      this.notifyNavigationGamesChanged();
    } catch (error) {
      console.error("Error creating match and invite:", error);
      return false;
    }
    console.log("Match and invite created successfully");
    return true;
  }

  private observeRematchOrEndMatchIndicators(
    context: MatchRuntimeContext | null = this.activeContext,
  ) {
    if (
      !context ||
      !this.latestInvite ||
      this.rematchSeriesEndIsIndicatedForInvite(this.latestInvite)
    ) {
      return;
    }

    const inviteId = context.inviteId;
    const hostRef = ref(this.db, `invites/${inviteId}/hostRematches`);
    this.hostRematchesRef = hostRef;
    let unregisterHost: (() => void) | null = null;
    let unregisterGuest: (() => void) | null = null;
    const cleanupBothRematchObservers = () => {
      unregisterHost?.();
      unregisterHost = null;
      unregisterGuest?.();
      unregisterGuest = null;
    };
    unregisterHost = this.observeContextValue(
      context,
      `invite-host-rematches:${inviteId}`,
      hostRef,
      (snapshot) => {
        const rematchesString: string | null = snapshot.val();
        if (!this.latestInvite || rematchesString === null) {
          return;
        }
        this.latestInvite.hostRematches = rematchesString;
        if (this.rematchSeriesEndIsIndicatedForInvite(this.latestInvite)) {
          cleanupBothRematchObservers();
          didReceiveRematchesSeriesEndIndicator();
        } else {
          didUpdateRematchSeriesMetadata();
        }
        this.maybeRefreshContextAfterRematchMetadata(context);
      },
      undefined,
      () => {
        if (this.hostRematchesRef === hostRef) {
          this.hostRematchesRef = null;
        }
      },
    );

    const guestRef = ref(this.db, `invites/${inviteId}/guestRematches`);
    this.guestRematchesRef = guestRef;
    unregisterGuest = this.observeContextValue(
      context,
      `invite-guest-rematches:${inviteId}`,
      guestRef,
      (snapshot) => {
        const rematchesString: string | null = snapshot.val();
        if (!this.latestInvite || rematchesString === null) {
          return;
        }
        this.latestInvite.guestRematches = rematchesString;
        if (this.rematchSeriesEndIsIndicatedForInvite(this.latestInvite)) {
          cleanupBothRematchObservers();
          didReceiveRematchesSeriesEndIndicator();
        } else {
          didUpdateRematchSeriesMetadata();
        }
        this.maybeRefreshContextAfterRematchMetadata(context);
      },
      undefined,
      () => {
        if (this.guestRematchesRef === guestRef) {
          this.guestRematchesRef = null;
        }
      },
    );
  }

  private updateWagerStateForCurrentMatch() {
    const targetMatchId = this.wagerViewMatchId ?? this.matchId;
    if (!targetMatchId) {
      syncCurrentWagerMatchState(null, null);
      this.logWagerDebug("publish-state:clear-no-target");
      return;
    }
    const wagers = this.latestInvite?.wagers ?? null;
    const matchWagerState =
      wagers && wagers[targetMatchId] ? wagers[targetMatchId] : null;
    this.logWagerDebug("publish-state", {
      targetMatchId,
      availableMatchIds: wagers ? Object.keys(wagers) : [],
      state: summarizeWagerState(matchWagerState),
    });
    syncCurrentWagerMatchState(targetMatchId, matchWagerState);
  }

  private observeWagers(
    context: MatchRuntimeContext | null = this.activeContext,
  ) {
    if (!context) {
      return;
    }
    const wagersRef = ref(this.db, `invites/${context.inviteId}/wagers`);
    this.wagersRef = wagersRef;
    this.observeContextValue(
      context,
      `invite-wagers:${context.inviteId}`,
      wagersRef,
      (snapshot) => {
        const wagers = snapshot.val();
        this.logWagerDebug("observe-wagers:update", {
          availableMatchIds: wagers ? Object.keys(wagers) : [],
        });
        if (this.latestInvite) {
          this.latestInvite.wagers = wagers;
        }
        this.updateWagerStateForCurrentMatch();
      },
      undefined,
      () => {
        if (this.wagersRef === wagersRef) {
          this.wagersRef = null;
        }
      },
    );
  }

  private observeInviteReactions(
    context: MatchRuntimeContext | null = this.activeContext,
  ) {
    if (!context) {
      return;
    }
    const inviteReactionsRef = ref(
      this.db,
      `invites/${context.inviteId}/reactions`,
    );
    this.inviteReactionsRef = inviteReactionsRef;
    this.observeContextValue(
      context,
      `invite-reactions:${context.inviteId}`,
      inviteReactionsRef,
      (snapshot) => {
        const reactions = snapshot.val() as Record<
          string,
          InviteReaction
        > | null;
        if (this.latestInvite) {
          this.latestInvite.reactions = reactions;
        }
        if (!reactions) {
          return;
        }
        Object.entries(reactions).forEach(([senderUid, inviteReaction]) => {
          if (!inviteReaction || typeof inviteReaction.uuid !== "string") {
            return;
          }
          didReceiveInviteReactionUpdate(inviteReaction, senderUid);
        });
      },
      undefined,
      () => {
        if (this.inviteReactionsRef === inviteReactionsRef) {
          this.inviteReactionsRef = null;
        }
      },
    );
  }

  private cleanupRematchObservers() {
    if (this.hostRematchesRef) {
      off(this.hostRematchesRef);
      this.hostRematchesRef = null;
      decrementLifecycleCounter("connectionObservers");
    }
    if (this.guestRematchesRef) {
      off(this.guestRematchesRef);
      this.guestRematchesRef = null;
      decrementLifecycleCounter("connectionObservers");
    }
  }

  private cleanupWagerObserver() {
    if (this.wagersRef) {
      off(this.wagersRef);
      this.wagersRef = null;
      decrementLifecycleCounter("connectionObservers");
    }
  }

  private cleanupInviteReactionObserver() {
    if (this.inviteReactionsRef) {
      off(this.inviteReactionsRef);
      this.inviteReactionsRef = null;
      decrementLifecycleCounter("connectionObservers");
    }
  }

  private observeMiningFrozen(uid: string | null) {
    if (this.miningFrozenRef) {
      off(this.miningFrozenRef);
      this.miningFrozenRef = null;
      decrementLifecycleCounter("connectionObservers");
    }
    if (!uid) {
      setFrozenMaterials(null);
      return;
    }
    const miningRef = ref(this.db, `players/${uid}/mining/frozen`);
    const observeEpoch = this.sessionEpoch;
    this.miningFrozenRef = miningRef;
    incrementLifecycleCounter("connectionObservers");
    onValue(miningRef, (snapshot) => {
      if (!this.isSessionEpochActive(observeEpoch)) {
        return;
      }
      setFrozenMaterials(snapshot.val());
    });
  }

  private observeMatch(
    playerId: string,
    matchId: string,
    context: MatchRuntimeContext | null = this.activeContext,
  ): void {
    const matchRef = ref(this.db, `players/${playerId}/matches/${matchId}`);
    const key = `${matchId}_${playerId}`;
    if (this.matchRefs[key]) {
      return;
    }
    const observeEpoch = context?.sessionEpoch ?? this.sessionEpoch;
    const contextId = context?.contextId ?? null;
    const isObserverActive = () => {
      if (contextId === null) {
        return this.isSessionEpochActive(observeEpoch);
      }
      return this.isContextActive(contextId, observeEpoch);
    };
    if (context) {
      this.unregisterObserverCleanup(context.contextId, `match:${key}`);
      this.registerObserverCleanup(context.contextId, `match:${key}`, () => {
        const existingRef = this.matchRefs[key];
        if (existingRef) {
          off(existingRef);
          delete this.matchRefs[key];
          decrementLifecycleCounter("connectionObservers");
        }
        this.observedMatchSnapshots.delete(key);
      });
    }
    this.matchRefs[key] = matchRef;
    incrementLifecycleCounter("connectionObservers");

    onValue(
      matchRef,
      (snapshot) => {
        if (!isObserverActive()) {
          return;
        }
        const matchData: Match | null = snapshot.val();
        if (matchData) {
          this.observedMatchSnapshots.set(key, matchData);
          didReceiveMatchUpdate(matchData, playerId, matchId);
        } else {
          this.observedMatchSnapshots.delete(key);
        }
      },
      (error) => {
        if (!isObserverActive()) {
          return;
        }
        console.error("Error observing match data:", error);
      },
    );

    this.getPlayerProfile(playerId)
      .then((profile) => {
        if (!isObserverActive()) {
          return;
        }
        this.stopObservingProfile(playerId);
        didGetPlayerProfile(profile, playerId, false);
      })
      .catch((error) => {
        if (!isObserverActive()) {
          return;
        }
        console.error("Error getting player profile:", error);
        this.observeProfile(playerId, context);
      });
  }

  private stopObservingProfile(playerId: string): void {
    const cleanup = this.profileObserverCleanups.get(playerId);
    if (!cleanup) {
      return;
    }
    this.profileObserverCleanups.delete(playerId);
    cleanup();
    decrementLifecycleCounter("connectionObservers");
  }

  private observeProfile(
    playerId: string,
    context: MatchRuntimeContext | null = this.activeContext,
    isOwnProfile = false,
  ): void {
    const profileRef = ref(this.db, `players/${playerId}/profile`);
    if (this.profileObserverCleanups.has(playerId)) {
      return;
    }
    const observeEpoch = context?.sessionEpoch ?? this.sessionEpoch;
    const contextId = context?.contextId ?? null;
    const isObserverActive = () => {
      if (contextId === null) {
        return this.isSessionEpochActive(observeEpoch);
      }
      return this.isContextActive(contextId, observeEpoch);
    };
    if (context) {
      this.unregisterObserverCleanup(context.contextId, `profile:${playerId}`);
      this.registerObserverCleanup(
        context.contextId,
        `profile:${playerId}`,
        () => {
          this.stopObservingProfile(playerId);
        },
      );
    }
    let linkedProfileId: string | null = null;
    let unsubscribeProfileRef: (() => void) | null = null;
    let lookupGeneration = 0;
    const cleanupProfileObserver = () => {
      lookupGeneration += 1;
      const unsubscribe = unsubscribeProfileRef;
      unsubscribeProfileRef = null;
      unsubscribe?.();
    };
    const isProfileObserverCurrent = () =>
      this.profileObserverCleanups.get(playerId) === cleanupProfileObserver;
    const resolveLinkedProfile = (profileId: string): void => {
      const generation = ++lookupGeneration;
      let tokenProvider: AuthTokenProvider & {
        readonly assertCurrentUser: () => void;
      };
      try {
        tokenProvider = this.getUserBoundAuthTokenProvider();
      } catch {
        this.stopObservingProfile(playerId);
        return;
      }
      const isLookupCurrent = () =>
        lookupGeneration === generation &&
        linkedProfileId === profileId &&
        isObserverActive() &&
        isProfileObserverCurrent();
      void resolvePlayerProfileWithRetry(
        playerId,
        {
          readLinkedProfileId: async () => profileId,
          getProfileById: (linkedProfileId) => {
            if (!isLookupCurrent()) {
              throw new Error("profile-lookup-cancelled");
            }
            return getProfileByIdViaApi(linkedProfileId, tokenProvider);
          },
          getProfileByLoginId: (loginId) => {
            if (!isLookupCurrent()) {
              throw new Error("profile-lookup-cancelled");
            }
            return getProfileByLoginIdViaApi(loginId, tokenProvider);
          },
        },
        isLookupCurrent,
        () => this.delay(PROFILE_LOOKUP_RETRY_DELAY_MS),
      )
        .then((profile) => {
          if (!profile) {
            return;
          }
          tokenProvider.assertCurrentUser();
          if (!isLookupCurrent()) {
            return;
          }
          this.stopObservingProfile(playerId);
          didGetPlayerProfile(profile, playerId, isOwnProfile);
        })
        .catch((error) => {
          if (!isLookupCurrent()) {
            return;
          }
          try {
            tokenProvider.assertCurrentUser();
          } catch {
            this.stopObservingProfile(playerId);
            return;
          }
          this.stopObservingProfile(playerId);
          console.error("Error observing player profile:", error);
        });
    };

    this.profileObserverCleanups.set(playerId, cleanupProfileObserver);
    incrementLifecycleCounter("connectionObservers");

    const unsubscribe = onValue(profileRef, (snapshot) => {
      if (!isObserverActive()) {
        return;
      }
      const profileId = this.normalizeStringOrNull(snapshot.val());
      if (!profileId) {
        linkedProfileId = null;
        lookupGeneration += 1;
        return;
      }
      if (linkedProfileId === profileId) {
        return;
      }
      linkedProfileId = profileId;
      resolveLinkedProfile(profileId);
    });
    if (this.profileObserverCleanups.get(playerId) !== cleanupProfileObserver) {
      unsubscribe();
      return;
    }
    unsubscribeProfileRef = unsubscribe;
  }

  public async checkBothPlayerProfiles(
    hostPlayerId: string,
    guestPlayerId: string,
    profileValue: string,
  ): Promise<string | null> {
    try {
      const hostProfileRef = ref(this.db, `players/${hostPlayerId}/profile`);

      if (guestPlayerId === "") {
        const hostSnapshot = await get(hostProfileRef);
        const hostProfile = hostSnapshot.val();

        if (hostProfile === profileValue) {
          return hostPlayerId;
        }
      } else {
        const guestProfileRef = ref(
          this.db,
          `players/${guestPlayerId}/profile`,
        );

        const [hostSnapshot, guestSnapshot] = await Promise.all([
          get(hostProfileRef),
          get(guestProfileRef),
        ]);

        const hostProfile = hostSnapshot.val();
        const guestProfile = guestSnapshot.val();

        if (hostProfile === profileValue) {
          return hostPlayerId;
        } else if (guestProfile === profileValue) {
          return guestPlayerId;
        }
      }

      return null;
    } catch {
      return null;
    }
  }

  private stopObservingAllMatches(): void {
    let removedMatchCount = 0;
    for (const key in this.matchRefs) {
      off(this.matchRefs[key]);
      console.log(`Stopped observing match for key ${key}`);
      removedMatchCount += 1;
    }
    this.matchRefs = {};
    this.observedMatchSnapshots.clear();
    if (removedMatchCount > 0) {
      decrementLifecycleCounter("connectionObservers", removedMatchCount);
    }

    this.profileObserverCleanups.forEach((_, key) => {
      this.stopObservingProfile(key);
      console.log(`Stopped observing profile for key ${key}`);
    });
  }
}

export const connection = new Connection();
