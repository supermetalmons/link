import type {
  EventParticipantView,
  EventMatchView,
  EventRoundView,
  EventPrizeAssignmentView,
  EventView,
} from "@mons/shared/events";
import {
  MINING_MATERIAL_NAMES as SHARED_MINING_MATERIAL_NAMES,
  type MiningMaterialName as SharedMiningMaterialName,
} from "@mons/shared/mining";
import type {
  NavigationGameItem as SharedNavigationGameItem,
  NavigationEventItem as SharedNavigationEventItem,
  EventNavigationPreviewParticipant as SharedEventNavigationPreviewParticipant,
  NavigationItem as SharedNavigationItem,
  NavigationStatus as SharedNavigationStatus,
  RemoveNavigationGameResponse,
} from "@mons/shared/navigation";
import type {
  EventPrizeId as SharedEventPrizeId,
  EventPrizeWithdrawalCompletedResponse,
} from "@mons/shared/event-prizes";
import type { PlayerProfile as SharedPlayerProfile } from "@mons/shared/profiles";
import type {
  GameSessionMatch,
  HistoricalMatchPair as SharedHistoricalMatchPair,
} from "@mons/shared/game-sessions";
import type { InviteMetadataSnapshot } from "@mons/shared/invite-metadata";
export type { Reaction, InviteReaction } from "@mons/shared/reactions";

export type Match = GameSessionMatch;

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

export type NavigationGameStatus = Exclude<SharedNavigationStatus, "dismissed">;
export type NavigationGameItem = SharedNavigationGameItem;
export type NavigationEventItem = SharedNavigationEventItem;
export type EventNavigationPreviewParticipant =
  SharedEventNavigationPreviewParticipant;
export type NavigationItem = SharedNavigationItem;

export type RemoveWaitingNavigationGameResult =
  | RemoveNavigationGameResponse
  | { ok: false; skipped: true; reason: "invalid-invite-id" };

export type EventParticipant = EventParticipantView;
export type EventMatch = EventMatchView;
export type EventRound = EventRoundView;
export type EventPrizeAssignment = EventPrizeAssignmentView;
export type EventRecord = EventView;

export type EventPrizeId = SharedEventPrizeId;
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
  schemaVersion?: 1;
  state?: "proposed" | "agreed" | "settling" | "settled" | "blocked";
  blocked?: import("@mons/shared/invite-wagers").PublicWagerBlock | null;
  proposals?: Record<string, WagerProposal>;
  proposedBy?: Record<string, boolean>;
  agreed?: WagerAgreement | null;
  resolved?: WagerResolution | null;
};

export type PlayerProfile = SharedPlayerProfile;
