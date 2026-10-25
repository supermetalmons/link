import type {
  EventParticipantView,
  EventMatchView,
  EventRoundView,
  EventPrizeAssignmentView,
  EventPrizeAssignmentsView,
  EventView,
} from "@mons/shared/events";
import {
  MINING_MATERIAL_NAMES as SHARED_MINING_MATERIAL_NAMES,
  type MiningMaterialName as SharedMiningMaterialName,
} from "@mons/shared/mining";
import type {
  AutomatchStateHint,
  NavigationStatus as SharedNavigationStatus,
  RemoveNavigationGameResponse,
} from "@mons/shared/navigation";
import type {
  EventPrizeId as SharedEventPrizeId,
  EventPrizeWithdrawalCompletedResponse,
} from "@mons/shared/event-prizes";
import type { PlayerProfile as SharedPlayerProfile } from "@mons/shared/profiles";
import type { HistoricalMatchPair as SharedHistoricalMatchPair } from "@mons/shared/game-sessions";
import type { Reaction } from "@mons/shared/reactions";
import type { InviteMetadataSnapshot } from "@mons/shared/invite-metadata";
export type { Reaction, InviteReaction } from "@mons/shared/reactions";

export interface Match {
  version: number;
  color: string;
  emojiId: number;
  aura?: string;
  gameVariant?: string;
  fen: string;
  status: string;
  flatMovesString: string;
  timer: string;
  reaction?: Reaction;
}

export interface Invite extends Omit<
  InviteMetadataSnapshot,
  "inviteId" | "revision"
> {
  wagers?: Record<string, MatchWagerState> | null;
}

export interface RematchSeriesMatchDescriptor {
  index: number;
  matchId: string;
  isActiveMatch: boolean;
  isPendingResponse: boolean;
}

export interface RematchSeriesDescriptor {
  inviteId: string;
  activeMatchId: string | null;
  hasSeries: boolean;
  matches: RematchSeriesMatchDescriptor[];
}

export type HistoricalMatchPair = SharedHistoricalMatchPair;

export type NavigationItemStatus = SharedNavigationStatus;
export type NavigationGameStatus = Exclude<SharedNavigationStatus, "dismissed">;
type NavigationEventStatus = Exclude<SharedNavigationStatus, "pending">;

export interface NavigationGameItem {
  id: string;
  entityType: "game";
  inviteId: string;
  kind: "auto" | "direct";
  status: NavigationGameStatus;
  sortBucket: number;
  listSortAtMs: number;
  hostLoginId: string | null;
  guestLoginId: string | null;
  opponentProfileId: string | null;
  opponentName: string | null;
  opponentEmoji: number | null;
  automatchStateHint: AutomatchStateHint | null;
  isPendingAutomatch: boolean;
  isOptimistic?: boolean;
}

export interface EventNavigationPreviewParticipant {
  profileId: string | null;
  displayName: string | null;
  emojiId: number | null;
  aura: string | null;
}

export interface NavigationEventItem {
  id: string;
  entityType: "event";
  eventId: string;
  status: NavigationEventStatus;
  sortBucket: number;
  listSortAtMs: number;
  startAtMs: number | null;
  updatedAtMs: number | null;
  endedAtMs: number | null;
  participantCount: number;
  participantPreview: EventNavigationPreviewParticipant[];
  winnerDisplayName: string | null;
  isOptimistic?: boolean;
}

export type NavigationItem = NavigationGameItem | NavigationEventItem;

export type RemoveWaitingNavigationGameResult =
  | RemoveNavigationGameResponse
  | { ok: false; skipped: true; reason: "invalid-invite-id" };

export type EventParticipant = EventParticipantView;
export type EventMatch = EventMatchView;
export type EventRound = EventRoundView;
export type EventPrizeAssignment = EventPrizeAssignmentView;
export type EventPrizeAssignments = EventPrizeAssignmentsView;
export type EventRecord = EventView;

export type EventPrizeId = SharedEventPrizeId;
export type EventPrizePlace = 1 | 2 | 3;
export type ProfileEventPrizes = Record<string, EventPrizeAssignment>;
export type EventPrizeWithdrawalResponse =
  EventPrizeWithdrawalCompletedResponse;

export type EventPrizeSelections = Record<string, EventPrizeId>;

export const MINING_MATERIAL_NAMES = SHARED_MINING_MATERIAL_NAMES;

export type MiningMaterialName = SharedMiningMaterialName;

export type PlayerMiningMaterials = Record<MiningMaterialName, number>;

export interface PlayerMiningData {
  lastRockDate: string | null;
  materials: PlayerMiningMaterials;
}

export type WagerProposal = {
  material: MiningMaterialName;
  count: number;
  createdAt?: number;
};

export type WagerAgreement = {
  material: MiningMaterialName;
  count: number;
  total?: number;
  proposerId: string;
  accepterId: string;
  acceptedAt?: number;
};

type WagerResolution = {
  winnerId: string;
  loserId: string;
  material: MiningMaterialName;
  count: number;
  total?: number;
  resolvedAt?: number;
  optimistic?: boolean;
};

export type MatchWagerState = {
  proposals?: Record<string, WagerProposal>;
  proposedBy?: Record<string, boolean>;
  agreed?: WagerAgreement;
  resolved?: WagerResolution;
};

export type PlayerProfile = SharedPlayerProfile;
