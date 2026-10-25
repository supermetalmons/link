// Generated from src/events/eventProjectionModel.ts. Run npm run generate:runtime.
import type { EventData, EventParticipants } from "./model.js";
import "@mons/shared/navigation";
declare const NAVIGATION_PARTICIPANT_PREVIEW_LIMIT = 6;
declare const normalizeString: (value: unknown) => string | null;
declare const normalizeFiniteNumberOrNull: (value: unknown) => number | null;
declare const mapEventStatusToNavigationStatus: (
  status: unknown,
) => "waiting" | "active" | "ended" | "dismissed";
declare const getListSortAtMs: (eventData: EventData, status: string) => number;
declare const buildPreviewParticipants: (
  participants: EventParticipants | null | undefined,
) => {
  profileId: string | null;
  displayName: string | null;
  emojiId: number | null;
  aura: string | null;
}[];
declare const getOwnerProfileIds: (
  participants: EventParticipants | null | undefined,
) => string[];
export {
  NAVIGATION_PARTICIPANT_PREVIEW_LIMIT,
  buildPreviewParticipants,
  getListSortAtMs,
  getOwnerProfileIds,
  mapEventStatusToNavigationStatus,
  normalizeFiniteNumberOrNull,
  normalizeString,
};
