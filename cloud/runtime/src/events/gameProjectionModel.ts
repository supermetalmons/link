import type { RecomputeInviteProjectionOptions } from "../profileGamesProjectionCore.js";

import { rematchSeriesEnded } from "@mons/shared/rematches";
import { getNavigationSortBucket } from "@mons/shared/navigation";
import { cropAddress } from "@mons/shared/profiles";
import { isAutoInviteId } from "@mons/shared/ids";
import { isEventOwnedInvite } from "@mons/shared/events";
export type ProjectionProfile = Record<string, unknown> & {
  custom?: { emoji?: unknown };
};
export type ProjectionInvite = Record<string, unknown> & {
  hostId?: unknown;
  guestId?: unknown;
};
type InviteProjectionInput = {
  inviteId: string;
  inviteData: ProjectionInvite | null;
  automatchStateHint: string | null;
  latestMatchRatingCompleted?: boolean;
};

const PROJECTOR_SCHEMA_VERSION = 2;

const normalizeString = (value: unknown) =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : null;

const readTimestampMillis = (value: unknown) => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.floor(value);
  }
  return null;
};

const truncateAddress = (address: unknown) => {
  if (typeof address !== "string" || address.length < 8) {
    return "anon";
  }
  return cropAddress(address);
};

const getProfileDisplayName = (
  profileData: ProjectionProfile | null | undefined,
) => {
  if (!profileData || typeof profileData !== "object") {
    return "anon";
  }
  if (
    typeof profileData.username === "string" &&
    profileData.username.trim() !== ""
  ) {
    return profileData.username.trim();
  }
  if (typeof profileData.eth === "string" && profileData.eth.trim() !== "") {
    return truncateAddress(profileData.eth.trim());
  }
  if (typeof profileData.sol === "string" && profileData.sol.trim() !== "") {
    return truncateAddress(profileData.sol.trim());
  }
  return "anon";
};

const getProfileEmoji = (profileData: ProjectionProfile | null | undefined) => {
  if (!profileData || typeof profileData !== "object") {
    return null;
  }
  const customEmoji =
    profileData.custom && typeof profileData.custom === "object"
      ? profileData.custom.emoji
      : undefined;
  const fallbackEmoji = profileData.emoji;
  const source = customEmoji !== undefined ? customEmoji : fallbackEmoji;
  if (typeof source === "number" && Number.isFinite(source)) {
    return Math.floor(source);
  }
  if (typeof source === "string" && source.trim() !== "") {
    const parsed = Number(source);
    if (Number.isFinite(parsed)) {
      return Math.floor(parsed);
    }
  }
  return null;
};

const getEmojiId = (value: unknown) => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.floor(value);
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return Math.floor(parsed);
    }
  }
  return null;
};

const deriveProjectionStatus = ({
  inviteId,
  inviteData,
  automatchStateHint,
  latestMatchRatingCompleted,
}: InviteProjectionInput) => {
  if (rematchSeriesEnded(inviteData)) {
    return "ended";
  }
  if (isEventOwnedInvite(inviteData) && latestMatchRatingCompleted === true) {
    return "ended";
  }
  const hasGuest = !!normalizeString(inviteData ? inviteData.guestId : null);
  if (isAutoInviteId(inviteId) && automatchStateHint === "pending") {
    return "pending";
  }
  if (hasGuest) {
    return "active";
  }
  return "waiting";
};

const shouldProjectInvite = ({
  inviteId,
  inviteData,
  automatchStateHint,
}: InviteProjectionInput) => {
  if (!inviteData || typeof inviteData !== "object") {
    return false;
  }
  if (!isAutoInviteId(inviteId)) {
    return true;
  }
  const hasGuest = !!normalizeString(inviteData.guestId);
  if (hasGuest) {
    return true;
  }
  return automatchStateHint === "pending";
};

const fingerprintForProjection = (payload: unknown) => JSON.stringify(payload);

const pickListSortMillis = ({
  options,
  status,
  automatchData,
  nowMs,
  existingListSortMs,
}: {
  options: RecomputeInviteProjectionOptions;
  status: string;
  automatchData: { timestamp?: number } | null;
  nowMs: number;
  existingListSortMs: number | null;
}) => {
  if (
    options.preserveListSortAt === true &&
    Number.isFinite(existingListSortMs)
  ) {
    return Math.floor(existingListSortMs as number);
  }

  let nextSortMillis = Number.isFinite(options.listSortAtMs)
    ? Math.floor(options.listSortAtMs as number)
    : nowMs;

  if (!Number.isFinite(options.listSortAtMs) && status === "pending") {
    const queueTimestamp =
      automatchData && Number.isFinite(automatchData.timestamp)
        ? Math.floor(automatchData.timestamp as number)
        : null;
    if (queueTimestamp && queueTimestamp > 0) {
      nextSortMillis = queueTimestamp;
    }
  }

  if (
    options.preserveNewerListSortAt !== false &&
    Number.isFinite(existingListSortMs)
  ) {
    nextSortMillis = Math.max(nextSortMillis, existingListSortMs as number);
  }

  return nextSortMillis;
};

const getOwnerProfileIds = (
  hostProfileId: string | null,
  guestProfileId: string | null,
) => {
  const owners = [];
  if (hostProfileId) {
    owners.push(hostProfileId);
  }
  if (guestProfileId && guestProfileId !== hostProfileId) {
    owners.push(guestProfileId);
  }
  return owners;
};

const getOwnerContext = ({
  ownerProfileId,
  hostProfileId,
  guestProfileId,
  hostLoginId,
  guestLoginId,
}: {
  ownerProfileId: string;
  hostProfileId: string | null;
  guestProfileId: string | null;
  hostLoginId: string | null;
  guestLoginId: string | null;
}) => {
  if (ownerProfileId === hostProfileId) {
    return {
      ownerRole: "host",
      ownerLoginId: hostLoginId || null,
      opponentProfileId: guestProfileId || null,
      opponentLoginId: guestLoginId || null,
    };
  }
  return {
    ownerRole: "guest",
    ownerLoginId: guestLoginId || null,
    opponentProfileId: hostProfileId || null,
    opponentLoginId: hostLoginId || null,
  };
};

const readEventTimestampMs = (options: RecomputeInviteProjectionOptions) => {
  if (options && Number.isFinite(options.eventTimestampMs)) {
    return Math.floor(options.eventTimestampMs as number);
  }
  return Date.now();
};

export {
  PROJECTOR_SCHEMA_VERSION,
  deriveProjectionStatus,
  fingerprintForProjection,
  getEmojiId,
  getNavigationSortBucket,
  getOwnerContext,
  getOwnerProfileIds,
  getProfileDisplayName,
  getProfileEmoji,
  isEventOwnedInvite,
  normalizeString,
  pickListSortMillis,
  readEventTimestampMs,
  readTimestampMillis,
  shouldProjectInvite,
};
