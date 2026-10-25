import type {
  EventRoundsDocument,
  EventParticipantsDocument,
} from "./documents.js";
import type { EventCommitPlan } from "../eventCommands.js";
import type { EventOwnershipSnapshot } from "./ownership.js";
import type { MatchSeedRecord } from "@mons/shared/match-protocol";

export type {
  EventDocument as EventData,
  EventParticipantDocument as EventParticipant,
  EventMatchDocument as EventMatch,
  EventRoundDocument as EventRound,
  EventRoundsDocument as EventRounds,
  EventParticipantsDocument as EventParticipants,
} from "./documents.js";
export type MatchResolution = {
  status: "host" | "guest" | "bye";
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
  rounds: EventRoundsDocument;
  nowMs: number;
  participantsById: EventParticipantsDocument;
  inviteUpdates: EventCommitPlan;
  random?: () => number;
  buildRandomGameSeed: BuildGameSeed;
  ownershipSnapshot: EventOwnershipSnapshot | null;
};
