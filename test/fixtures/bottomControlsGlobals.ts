import type { RematchSeriesNavigatorItem } from "../../src/game/gameController.ts";
import type { GameControlsContext } from "../../src/game/gameControlsModel.ts";
import type { RouteState } from "../../src/navigation/routeState.ts";
import type { AvailableMaterialsSnapshot } from "../../src/services/availableMaterials.ts";

type FixtureRoute = Pick<RouteState, "mode" | "path"> & Partial<RouteState>;
type FixtureParticipant = {
  profileId?: string;
  displayName?: string;
  emojiId?: number | null;
  joinedAtMs?: number;
  aura?: string | null;
};
type FixtureEvent = { participants: Record<string, FixtureParticipant> };
type EventSubscription = {
  active: boolean;
  eventId: string;
  update: (event: FixtureEvent | null) => void;
};
type FixtureWager = {
  proposedBy?: Record<string, boolean>;
  proposals?: Record<string, { material: string; count: number }>;
  agreed?: object;
  resolved?: object;
};
type Materials = Omit<AvailableMaterialsSnapshot, "availableMaterials"> & {
  availableMaterials: Partial<AvailableMaterialsSnapshot["availableMaterials"]>;
};
type Eligibility = {
  context?: Partial<GameControlsContext>;
  playerUid?: string | null;
  opponentUid?: string | null;
  opponentProfileId?: string | null;
  profileId?: string | null;
  authStatus?: string;
};
type NavigationItem = {
  id: string;
  entityType: "event" | "game";
  eventId?: string;
  inviteId?: string;
  status: string;
  sortBucket: number;
  listSortAtMs: number;
  participantPreview?: FixtureParticipant[];
};
type FixtureEnvironment = {
  calls: [string, ...unknown[]][];
  callbacks: Record<string, ((...args: unknown[]) => void) | undefined>;
  route: FixtureRoute;
  eventSubscriptions: EventSubscription[];
  eventSnapshots: Map<string, FixtureEvent>;
  eventModalState: {
    isOpen: boolean;
    eventId: string | null;
    lastCloseReason: string | null;
  };
  eventModalListeners: Set<unknown>;
  navigationListeners: Set<unknown>;
  transientHandlers: Set<{ close: () => void; clear: () => void }>;
  rematchItems: RematchSeriesNavigatorItem[];
  rematchPreloads: PromiseWithResolvers<boolean>[];
  rematchSelections: (PromiseWithResolvers<boolean> & { matchId: string })[];
  historySelectionResets: number;
  wagerEligible: boolean;
  wagerSendGate: PromiseWithResolvers<void> | null;
  inviteRequests: ((ok: boolean, inviteId?: string) => void)[];
  epoch: number;
};

type BottomControlsHarness = {
  required: <T>(value: T) => NonNullable<T>;
  environment: FixtureEnvironment;
  port: typeof import("../../src/ui/controls/bottomControlsPort.ts");
  controlsStore: typeof import("../../src/game/gameControlsStore.ts");
  applyRouteControlsPreset: typeof import("../../src/game/sessionControls.ts").applyRouteControlsPreset;
  applyDisposedControlsPreset: typeof import("../../src/game/sessionControls.ts").applyDisposedControlsPreset;
  applyGameplayControlsPreset: typeof import("../../src/game/sessionControls.ts").applyGameplayControlsPreset;
  run: <T>(callback: () => T) => T;
  render: (profileId?: string | null, authStatus?: string) => void;
  respondAutomatch: (
    index: number,
    response: { ok: boolean; mode?: string; inviteId?: string },
    enterWaiting?: boolean,
  ) => Promise<void>;
  respondCancel: (
    index: number,
    result: { ok: boolean } | null,
    reject?: boolean,
  ) => Promise<void>;
  publishPending: (inviteId: string) => void;
  publishNavigation: (items: NavigationItem[]) => void;
  seedEventPreview: (
    profileId: string,
    eventId: string,
    emojiIds: number[],
  ) => void;
  publishRematches: (items: RematchSeriesNavigatorItem[]) => void;
  respondRematchPreload: (
    index: number,
    updates?: (Partial<RematchSeriesNavigatorItem> & { matchId: string })[],
    reject?: boolean,
  ) => Promise<void>;
  respondRematchSelection: (index: number, didSwitch: boolean) => Promise<void>;
  holdHomeTransition: () => void;
  releaseHomeTransition: () => Promise<void>;
  resetMatch: () => void;
  publishWager: (state: FixtureWager | null, confirmed?: boolean) => void;
  holdWagerSend: () => void;
  respondWagerSend: (reject?: boolean) => Promise<void>;
  publishMaterials: (updates: Partial<Materials>) => void;
  setWagerEligibility: (options?: Eligibility) => void;
  wagerSubscriptions: () => { wager: number; materials: number };
  updateConnection: (options?: {
    inviteId?: string | null;
    eventId?: string | null;
    eventOwned?: boolean;
    online?: boolean;
  }) => void;
  navigate: (route: FixtureRoute) => void;
  openEvent: (eventId: string) => void;
  openPendingEvent: () => void;
  dismissEvent: () => void;
  launchEventGame: (inviteId: string) => void;
  publishEvent: (eventId: string, emojiIds: number[]) => void;
  publishEventParticipants: (
    eventId: string,
    participants: FixtureParticipant[],
  ) => void;
  counters: typeof import("../../src/lifecycle/lifecycleDiagnostics.ts").getLifecycleCounters;
  remount: () => void;
  dispose: () => void;
  holdBootstrap: (inviteId: string) => void;
  releaseBootstrap: () => void;
  navigationState: () => {
    route: RouteState;
    modal: ReturnType<
      typeof import("../../src/ui/event/modalState.ts").getEventModalState
    >;
    transitioning: boolean;
    bootstraps: string[];
  };
};

declare global {
  var bottomControlsHarness: BottomControlsHarness;
  var savedEventButton: Element;
  var savedEventAvatars: HTMLImageElement[];
  var savedEventSubscription: EventSubscription;
  var savedEventSubscriptionCount: number;
  var oldEventSubscription: EventSubscription;
  var profileEventSubscription: EventSubscription;
  var profileEventSubscriptionCount: number;
  var savedTimerConfig: ReturnType<
    typeof import("../../src/game/gameControlsStore.ts").getGameControlsSnapshot
  >["presentation"]["gameControls"]["timer"]["config"];
}
export {};
