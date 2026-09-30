import type { EventCommitPlan } from "../eventCommands.js";
import type { EventPrizeAssignmentRecord } from "../eventReads.js";
import type { EventOwnershipSnapshot } from "./ownership.js";
import type { MatchSeedRecord } from "@mons/shared/match-protocol";

export type EventParticipant = Record<string, unknown> & {
  profileId?: string;
  loginUid?: string;
  username?: string;
  displayName?: string;
  emojiId?: number;
  aura?: string | null;
  joinedAtMs?: number;
  state?: string;
  eliminatedRoundIndex?: number | null;
  eliminatedByProfileId?: string | null;
};
export type EventMatch = Record<string, unknown> & {
  matchKey?: string;
  inviteId?: string | null;
  status?: string;
  resolvedAtMs?: number | null;
  winnerDisqualified?: boolean;
  winnerProfileId?: string | null;
  loserProfileId?: string | null;
  hostSlotBlocked?: boolean;
  hostProfileId?: string | null;
  hostLoginUid?: string | null;
  hostDisplayName?: string | null;
  hostEmojiId?: number | null;
  hostAura?: string | null;
  guestSlotBlocked?: boolean;
  guestProfileId?: string | null;
  guestLoginUid?: string | null;
  guestDisplayName?: string | null;
  guestEmojiId?: number | null;
  guestAura?: string | null;
};
export type EventRound = Record<string, unknown> & {
  matches?: Record<string, EventMatch>;
  status?: string;
  roundIndex?: number;
};
export type EventRounds = Record<string, EventRound>;
export type EventData = Record<string, unknown> & {
  eventId?: string;
  status?: string;
  createdAtMs?: number;
  updatedAtMs?: number;
  startAtMs?: number;
  startedAtMs?: number | null;
  endedAtMs?: number | null;
  createdByLoginUid?: string;
  createdByProfileId?: string;
  participants?: Record<string, EventParticipant>;
  prizeAssignments?: Record<string, EventPrizeAssignmentRecord>;
  rounds?: EventRounds;
  thirdPlaceMatch?: EventMatch | null;
  winnerProfileId?: string | null;
  winnerDisplayName?: string | null;
  currentRoundIndex?: number | null;
  bracketSize?: number;
  roundCount?: number;
  supportsThirdPlaceMatch?: boolean;
};
export type MatchResolution = {
  status: string;
  winnerProfileId: string | null;
  loserProfileId: string | null;
};
export type EventPlacement = {
  place: 1 | 2 | 3;
  profileId: string;
};
export type BuildGameSeed = (
  random?: () => number,
) => MatchSeedRecord | Promise<MatchSeedRecord>;
export type MatchReadinessInput = {
  eventId: string;
  rounds: EventRounds;
  nowMs: number;
  participantsById: Record<string, EventParticipant>;
  inviteUpdates: EventCommitPlan;
  random?: () => number;
  buildRandomGameSeed: BuildGameSeed;
  ownershipSnapshot: EventOwnershipSnapshot | null;
};
