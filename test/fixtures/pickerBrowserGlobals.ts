import type { AuthState } from "../../src/connection/authModels.ts";
import type {
  NavigationGamesCursor,
  NavigationItem,
} from "@mons/shared/navigation";

type FixtureIdentity = {
  authStatus: string;
  profileId: string;
  solAddress: string;
  ethAddress: string;
};
type NftEntry = { id: number; count?: number };
export type FixtureNftSnapshot = {
  data: {
    ok: boolean;
    swagpack_avatars?: NftEntry[];
    specials?: NftEntry[];
    swagpack_reactions?: NftEntry[];
  };
  expiresAtMs: number;
};
type RequiredValue = <T>(value: T) => NonNullable<T>;
type ReactionState = {
  profileId: string;
  visibleStickerIds: number[];
  hasFreshStickerEntitlement: boolean;
  stickerUrls: Record<number, string | null | undefined>;
};
type ReactionPickerHarness = {
  required: RequiredValue;
  environment: {
    now: number;
    rejectIdentityReads: boolean;
    writes: unknown[];
    requests: (PromiseWithResolvers<FixtureNftSnapshot> & {
      identity: FixtureIdentity;
      settled: boolean;
    })[];
    imageRequests: number[];
    failingImages: Set<number>;
  };
  fixed: number[];
  extra: number[];
  commits: ReactionState[];
  clicks: { id: number; allowed: boolean }[];
  render: (profileId?: string, isOpen?: boolean) => void;
  setOwner: (profileId: string) => void;
  seed: (profileId: string, extraIds: number[], expiresAtMs: number) => void;
  snapshot: () => ReactionState;
  canSend: (id: number) => boolean;
  resolve: (
    index: number,
    ids?: number[],
    expiresAtMs?: number,
    ok?: boolean,
  ) => Promise<void>;
  dispose: () => void;
};
type InventoryHarness = {
  required: RequiredValue;
  environment: {
    now: number;
    owner: FixtureIdentity;
    selection: { avatarId: number | null; specialIds: Set<number> };
    aura: string;
    writes: unknown[][];
    nftRequests: FixtureIdentity[];
    nftResponses: (FixtureNftSnapshot | { error: string })[];
    pendingNftRequests: (PromiseWithResolvers<FixtureNftSnapshot> & {
      identity: FixtureIdentity;
      requestId: number;
    })[];
    deferNfts: boolean;
    hasEventPrizes: boolean;
    withdrawals: (PromiseWithResolvers<{ ok: boolean; status: string }> & {
      eventId: string;
      prizeId: string;
      address: string;
    })[];
    outsideDismissals: number;
    inventoryDismissals: number;
    bubbledEscapes: number;
  };
  render: (profileId?: string) => void;
  resolve: (index: number, status?: string) => void;
  reject: (index: number, code: string, message?: string) => void;
  resolveNfts: (
    profileId: string,
    snapshot: FixtureNftSnapshot,
    requestId?: number,
  ) => Promise<void>;
  dispose: () => void;
};
type NavigationGame = {
  id: string;
  entityType: "game";
  inviteId: string;
  kind: "direct" | "auto";
  status: "waiting" | "pending" | "active" | "ended";
  sortBucket: number;
  listSortAtMs: number;
  isOptimistic?: boolean;
  opponentName?: string;
  opponentEmoji?: number | null;
};
type NavigationEvent = Omit<
  Extract<NavigationItem, { entityType: "event" }>,
  "participantPreview"
> & {
  participantPreview: {
    emojiId?: unknown;
    profileId?: string;
    displayName?: string;
    aura?: string | null;
  }[];
};
type FixtureNavigation = NavigationGame | NavigationEvent;
type NavigationPage = {
  items: FixtureNavigation[];
  hasMore: boolean;
  nextCursor: NavigationGamesCursor | null;
};
type NavigationState = {
  profileId: string;
  snapshotProfile: string | null;
  top: string[];
  paged: string[];
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  avatars: string[];
};
type NavigationSubscription = {
  limit: number;
  update: (items: FixtureNavigation[]) => void;
  error: (error: Error) => void;
  meta: (page: NavigationPage) => void;
  active: boolean;
};
type PickerProps = Partial<
  Omit<
    Parameters<typeof import("../../src/ui/NavigationPicker.tsx").default>[0],
    "topGames" | "pagedGames"
  >
> & { topGames?: FixtureNavigation[]; pagedGames?: FixtureNavigation[] };
type NavigationHarness = {
  required: RequiredValue;
  render: (profileId?: string, isOpen?: boolean, showPicker?: boolean) => void;
  game: (id: string, n?: number) => NavigationGame;
  event: (profile: string) => NavigationEvent;
  cursor: (n: number) => NavigationGamesCursor;
  commits: NavigationState[];
  subscriptions: NavigationSubscription[];
  pages: (PromiseWithResolvers<NavigationPage> & {
    limit: number;
    cursor: NavigationGamesCursor | null;
  })[];
  interactions: {
    selections: { id: string; options?: { status?: string } }[];
    removals: string[];
    problems: string[];
    home: number;
    loads: number;
  };
  renderPicker: (props?: PickerProps) => void;
  updatePicker: (props: PickerProps) => void;
  closePicker: () => void;
  setProblems: (
    items: { id: string; icon?: string; label?: string }[],
    completed?: string[],
  ) => void;
  scrollable: () => HTMLDivElement | undefined;
  seed: (
    profile: string,
    top: FixtureNavigation[],
    paged?: FixtureNavigation[],
  ) => void;
  snapshot: () => NavigationState;
  update: (items: FixtureNavigation[], meta?: NavigationPage) => void;
  deliverItems: (
    subscription: NavigationSubscription,
    items: FixtureNavigation[],
  ) => void;
  guard: () => () => boolean;
  setOptimistic: (item: NavigationGame) => void;
  resolvePage: (index: number, result: NavigationPage) => Promise<void>;
  dispose: () => void;
};
type TopRightState = {
  visible: boolean;
  activeId: string | null;
  activeLabel: string | null;
  expanded: string[];
  activeMusicSubscriptions: number;
  activePrizeSubscriptions: number;
  outsideDismissed: boolean;
};
type TopRightHarness = {
  required: RequiredValue;
  environment: {
    calls: [string, ...unknown[]][];
    owner: AuthState;
    deferNfts: boolean;
    nftRequests: AuthState[];
    pendingNfts: {
      identity: AuthState;
      resolve: (snapshot: FixtureNftSnapshot) => void;
    }[];
    subscriptionStarts: number;
    subscriptionStops: number;
  };
  render: (patch?: {
    authState?: AuthState;
    isMuted?: boolean;
    isVisible?: boolean;
    callbackVersion?: number;
  }) => void;
  getState: () => TopRightState;
  isMobile: boolean;
  clearCalls: () => void;
  invoke: (name: string) => TopRightState;
  conditionalClose: (id: string) => TopRightState;
  setPlaying: (value: boolean) => void;
  setIdentity: (patch: Partial<AuthState>) => void;
  setMainMenu: (value: boolean) => void;
  resolveNfts: (profileId: string, avatarId: number) => void;
  unmount: () => TopRightState;
};
declare global {
  var reactionPickerHarness: ReactionPickerHarness;
  var inventoryHarness: InventoryHarness;
  var inventoryFixtureOptions: { eventPrizes: boolean };
  var navigationHarness: NavigationHarness;
  var topRightHarness: TopRightHarness;
  var fixtureOptions: { mainMenu: boolean };
}
