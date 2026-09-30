// Generated from src/events/ownership.ts. Run npm run generate:runtime.
import type { EventData, EventParticipant } from "./model.js";
export type EventOwnershipProfile = {
  aura: string;
  emoji: number | string;
  eth: string;
  profileId: string;
  rating: number;
  sol: string;
  username: string;
};
export type EventOwnershipSnapshot = Readonly<{
  canonicalProfileIdByProfileId: ReadonlyMap<string, string | null>;
  loginOwnerByUid: ReadonlyMap<
    string,
    Readonly<{
      profileId: string;
      revision: number;
    }> | null
  >;
  loginUidsByProfileId: ReadonlyMap<string, readonly string[]>;
  profileById: ReadonlyMap<
    string,
    Readonly<{
      profile: EventOwnershipProfile;
      revision: number;
    }>
  >;
}>;
export type EventOwnershipResolutionSnapshot = Pick<
  EventOwnershipSnapshot,
  "canonicalProfileIdByProfileId" | "loginOwnerByUid"
> &
  Partial<Pick<EventOwnershipSnapshot, "profileById">>;
type Signature_buildEventOwnershipQuery = (
  event: EventData,
  extras?: {
    loginUids?: string[];
    profileIds?: string[];
  },
) => {
  loginUids: string[];
  profileIds: string[];
};
type Signature_canonicalizeEventParticipants = (
  event: EventData,
  snapshot: EventOwnershipSnapshot,
) => {
  didChange: boolean;
  participantsById: Record<string, EventParticipant>;
};
type Signature_directRequesterParticipation = (
  event: EventData,
  requesterUid: string,
) => {
  isParticipant: boolean;
  profileId: string | null;
};
type Signature_directParticipantParticipation = (
  event: EventData,
  requesterUid: string,
) => {
  isParticipant: boolean;
  profileId: string | null;
};
type Signature_getCanonicalProfileId = (
  snapshot: EventOwnershipResolutionSnapshot,
  profileId: string,
) => string | null;
type Signature_getLoginProfileId = (
  snapshot: EventOwnershipResolutionSnapshot,
  loginUid: string,
) => string | null;
type Signature_getOwnershipProfile = (
  snapshot: EventOwnershipSnapshot,
  profileId: string,
) => EventOwnershipProfile | null;
type Signature_requesterOwnsProfileReference = (input: {
  requesterUid: string;
  snapshot?: EventOwnershipSnapshot | null;
  storedLoginUid: string;
  storedProfileId: string;
}) => boolean;
type Signature_resolveOwnedProfileReferences = (
  snapshot: EventOwnershipResolutionSnapshot,
  references: Array<{
    loginUid: unknown;
    profileId: unknown;
  }>,
) => string[];
type Signature_resolvePrizeProjectionOwnerId = (input: {
  event: EventData;
  profileId: string;
  snapshot: EventOwnershipSnapshot;
}) => string;
type Signature_resolveParticipantParticipation = (
  event: EventData,
  requesterUid: string,
  snapshot?: EventOwnershipSnapshot | null,
) => {
  isParticipant: boolean;
  profileId: string | null;
};
type Signature_resolveRequesterParticipation = (
  event: EventData,
  requesterUid: string,
  snapshot?: EventOwnershipSnapshot | null,
) => {
  isParticipant: boolean;
  profileId: string | null;
};
declare const profileOwnershipUnavailable: () => Error & {
  code: "unavailable";
};
declare const buildEventOwnershipQuery: Signature_buildEventOwnershipQuery;
declare const getLoginProfileId: Signature_getLoginProfileId;
declare const getCanonicalProfileId: Signature_getCanonicalProfileId;
declare const getOwnershipProfile: Signature_getOwnershipProfile;
declare const resolveOwnedProfileReferences: Signature_resolveOwnedProfileReferences;
declare const directParticipantParticipation: Signature_directParticipantParticipation;
declare const directRequesterParticipation: Signature_directRequesterParticipation;
declare const resolveRequesterParticipation: Signature_resolveRequesterParticipation;
declare const resolveParticipantParticipation: Signature_resolveParticipantParticipation;
declare const requesterOwnsProfileReference: Signature_requesterOwnsProfileReference;
declare const canonicalizeEventParticipants: Signature_canonicalizeEventParticipants;
declare const canonicalizeEventPrizeSelections: <T>(
  event: EventData,
  value: Record<string, T> | null | undefined,
  snapshot: EventOwnershipSnapshot | null,
) => {
  didChange: boolean;
  selectionsByProfileId: Record<string, T>;
};
declare const resolvePrizeProjectionOwnerId: Signature_resolvePrizeProjectionOwnerId;
export {
  buildEventOwnershipQuery,
  canonicalizeEventParticipants,
  canonicalizeEventPrizeSelections,
  directParticipantParticipation,
  directRequesterParticipation,
  getCanonicalProfileId,
  getLoginProfileId,
  getOwnershipProfile,
  profileOwnershipUnavailable,
  requesterOwnsProfileReference,
  resolveOwnedProfileReferences,
  resolvePrizeProjectionOwnerId,
  resolveParticipantParticipation,
  resolveRequesterParticipation,
};
