// Generated from src/events/gameProjectionModel.ts. Run npm run generate:runtime.
import type { RecomputeInviteProjectionOptions } from "../profileGamesProjectionCore.js";
import { getNavigationSortBucket } from "@mons/shared/navigation";
import { isEventOwnedInvite } from "@mons/shared/events";
export type ProjectionProfile = Record<string, unknown> & {
  custom?: {
    emoji?: unknown;
  };
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
declare const PROJECTOR_SCHEMA_VERSION = 2;
declare const normalizeString: (value: unknown) => string | null;
declare const readTimestampMillis: (value: unknown) => number | null;
declare const getProfileDisplayName: (
  profileData: ProjectionProfile | null | undefined,
) => string;
declare const getProfileEmoji: (
  profileData: ProjectionProfile | null | undefined,
) => number | null;
declare const getEmojiId: (value: unknown) => number | null;
declare const deriveProjectionStatus: ({
  inviteId,
  inviteData,
  automatchStateHint,
  latestMatchRatingCompleted,
}: InviteProjectionInput) => "active" | "ended" | "pending" | "waiting";
declare const shouldProjectInvite: ({
  inviteId,
  inviteData,
  automatchStateHint,
}: InviteProjectionInput) => boolean;
declare const fingerprintForProjection: (payload: unknown) => string;
declare const pickListSortMillis: ({
  options,
  status,
  automatchData,
  nowMs,
  existingListSortMs,
}: {
  options: RecomputeInviteProjectionOptions;
  status: string;
  automatchData: {
    timestamp?: number;
  } | null;
  nowMs: number;
  existingListSortMs: number | null;
}) => number;
declare const getOwnerProfileIds: (
  hostProfileId: string | null,
  guestProfileId: string | null,
) => string[];
declare const getOwnerContext: ({
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
  ownerRole: string;
  ownerLoginId: string | null;
  opponentProfileId: string | null;
  opponentLoginId: string | null;
};
declare const readEventTimestampMs: (
  options: RecomputeInviteProjectionOptions,
) => number;
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
