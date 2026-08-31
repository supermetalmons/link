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
    Readonly<{ profileId: string; revision: number }> | null
  >;
  loginUidsByProfileId: ReadonlyMap<string, readonly string[]>;
  profileById: ReadonlyMap<
    string,
    Readonly<{ profile: EventOwnershipProfile; revision: number }>
  >;
}>;

export function buildEventOwnershipQuery(
  event: Record<string, unknown>,
  extras?: { loginUids?: string[]; profileIds?: string[] },
): { loginUids: string[]; profileIds: string[] };
export function canonicalizeEventParticipants(
  event: Record<string, unknown>,
  snapshot: EventOwnershipSnapshot,
): { didChange: boolean; participantsById: Record<string, unknown> };
export function canonicalizeEventPrizeSelections(
  event: Record<string, unknown>,
  value: unknown,
  snapshot: EventOwnershipSnapshot | null,
): {
  didChange: boolean;
  selectionsByProfileId: Record<string, unknown>;
};
export function directRequesterParticipation(
  event: Record<string, unknown>,
  requesterUid: string,
): { isParticipant: boolean; profileId: string | null };
export function directParticipantParticipation(
  event: Record<string, unknown>,
  requesterUid: string,
): { isParticipant: boolean; profileId: string | null };
export function getCanonicalProfileId(
  snapshot: EventOwnershipSnapshot,
  profileId: string,
): string | null;
export function getLoginProfileId(
  snapshot: EventOwnershipSnapshot,
  loginUid: string,
): string | null;
export function getOwnershipProfile(
  snapshot: EventOwnershipSnapshot,
  profileId: string,
): EventOwnershipProfile | null;
export function requesterOwnsProfileReference(input: {
  requesterUid: string;
  snapshot?: EventOwnershipSnapshot | null;
  storedLoginUid: string;
  storedProfileId: string;
}): boolean;
export function resolveOwnedProfileReferences(
  snapshot: EventOwnershipSnapshot,
  references: Array<{ loginUid: string; profileId: string }>,
): string[];
export function resolvePrizeProjectionOwnerId(input: {
  event: Record<string, unknown>;
  profileId: string;
  snapshot: EventOwnershipSnapshot;
}): string;
export function resolveParticipantParticipation(
  event: Record<string, unknown>,
  requesterUid: string,
  snapshot?: EventOwnershipSnapshot | null,
): { isParticipant: boolean; profileId: string | null };
export function resolveRequesterParticipation(
  event: Record<string, unknown>,
  requesterUid: string,
  snapshot?: EventOwnershipSnapshot | null,
): { isParticipant: boolean; profileId: string | null };
