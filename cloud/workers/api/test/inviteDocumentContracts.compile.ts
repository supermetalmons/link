import type {
  InviteDocument,
  ManualInviteWrite,
  PendingAutomatchInviteWrite,
  MatchedAutomatchInviteWrite,
  EventInviteWrite,
  InviteFieldChanges,
} from "@mons/shared/invite-records";
import type { InviteMetadataSnapshot } from "@mons/shared/invite-metadata";
import type { GameSessionPort } from "../src/gameSessionContracts.ts";
import type { GameSessionChange } from "../../../runtime/gameSessionChanges.js";
import type { EventEffect } from "../../../runtime/eventCommands.js";
import type {
  InviteSourceSnapshot,
  InviteSourceMutation,
} from "../src/inviteSourceD1.ts";
import type { InviteWagerDocument } from "../src/inviteWagerSource.ts";
import type { canonicalMatchOperations } from "../src/matchStateClient.ts";
import type { ProfileGamesProjectionRepository } from "../../../runtime/profileGamesProjectionCore.js";

type Assert<Value extends true> = Value;
type Equal<Left, Right> =
  (<T>() => T extends Left ? 1 : 2) extends <T>() => T extends Right ? 1 : 2
    ? true
    : false;
type Rejects<Value, Contract> = Value extends Contract ? false : true;

export type InviteDocumentsHaveNoStringIndex = Assert<
  string extends keyof InviteDocument ? false : true
>;
export type RawInviteCannotBecomeDocument = Assert<
  Rejects<{ hostId: string }, InviteDocument>
>;
export type RawInviteCannotBecomePublicMetadata = Assert<
  Rejects<InviteDocument, InviteMetadataSnapshot>
>;
export type PublicMetadataCannotBecomePersistedInvite = Assert<
  Rejects<InviteMetadataSnapshot, InviteDocument>
>;
export type WagerCompositeCannotBecomePersistedInvite = Assert<
  Rejects<InviteWagerDocument, InviteDocument>
>;
export type PersistedInviteCannotBecomeWagerComposite = Assert<
  Rejects<InviteDocument, InviteWagerDocument>
>;
export type SingleInviteReadReturnsDocument = Assert<
  Equal<
    Awaited<ReturnType<GameSessionPort["readInviteMetadata"]>>,
    InviteDocument | null
  >
>;
export type BatchInviteReadReturnsDocuments = Assert<
  Equal<
    Awaited<ReturnType<GameSessionPort["readInviteMetadataMany"]>>,
    (InviteDocument | null)[]
  >
>;
export type ProjectionInviteReadReturnsDocument = Assert<
  Equal<
    Awaited<ReturnType<ProfileGamesProjectionRepository["readInviteMetadata"]>>,
    InviteDocument | null
  >
>;
export type SourceSnapshotHasDocument = Assert<
  Equal<InviteSourceSnapshot["value"], InviteDocument | null>
>;
export type SourceMutationHasDocument = Assert<
  Equal<InviteSourceMutation["value"], InviteDocument>
>;
export type SessionInviteWritesRejectRawBags = Assert<
  Rejects<
    { kind: "invite-merge"; inviteId: string; value: { hostId: string } },
    GameSessionChange
  >
>;
export type EventInviteWritesRejectRawBags = Assert<
  Rejects<
    { kind: "invite"; inviteId: string; value: { hostId: string } },
    EventEffect
  >
>;
export type TimerClaimRejectsScalarInvite = Assert<
  Rejects<
    string,
    Parameters<
      Awaited<ReturnType<typeof canonicalMatchOperations>>["claimCanonical"]
    >[1]
  >
>;
export type ManualWritesRetainControllerVersion = Assert<
  Equal<ManualInviteWrite["version"], 2>
>;
export type ManualWritesHaveEmptyGuestSeat = Assert<
  Equal<ManualInviteWrite["guestId"], null>
>;
export type PendingWritesCannotStartMatched = Assert<
  Rejects<"matched", PendingAutomatchInviteWrite["automatchStateHint"]>
>;
export type MatchedWritesRequireGuest = Assert<
  Rejects<null, MatchedAutomatchInviteWrite["guestId"]>
>;
export type EventWritesRequireOwnership = Assert<
  Equal<EventInviteWrite["eventOwned"], true>
>;
export type EventWritesRejectStringRound = Assert<
  Rejects<string, EventInviteWrite["eventRoundIndex"]>
>;
export type InviteFieldPatchRejectsInvalidColor = Assert<
  Rejects<"red", InviteFieldChanges["hostColor"]>
>;
