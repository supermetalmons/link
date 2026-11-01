import { isAura, isEmojiId, type Aura, type EmojiId } from "./appearance.js";
import { normalizeRecordKey } from "./ids.js";
import type {
  NavigationEventStatus,
  NavigationGameStatus,
} from "./navigation.js";

export const PROJECTION_SORT_BUCKETS = Object.freeze({
  pending: 20,
  waiting: 30,
  active: 40,
  ended: 50,
  dismissed: 50,
} as const);
export type GameProjectionRecord = {
  schemaVersion: 3;
  projectorVersion: 3;
  source: "game-projector";
  entityType: "game";
  inviteId: string;
  kind: "auto" | "direct";
  hostLoginId: string | null;
  guestLoginId: string | null;
  hostProfileId: string | null;
  guestProfileId: string | null;
  status: NavigationGameStatus;
  sortBucket: number;
  isPendingAutomatch: boolean;
  automatchStateHint: "pending" | "matched" | "canceled" | null;
  automatchCanceledAt: number | null;
  latestMatchId: string;
  ownerProfileId: string;
  ownerRole: "host" | "guest";
  ownerLoginId: string | null;
  opponentProfileId: string | null;
  opponentLoginId: string | null;
  opponentName: string | null;
  opponentEmoji: EmojiId | null;
  listSortAt: number;
  createdAt: number;
  updatedAt: number;
  endedAt: number | null;
  lastEventFingerprint: string;
  lastEventType: string | null;
  lastEventReason: string | null;
  lastEventAt: number;
};
export type ProjectionParticipant = {
  profileId: string | null;
  displayName: string | null;
  emojiId: EmojiId | null;
  aura: Aura;
};
export type EventProjectionRecord = {
  schemaVersion: 2;
  source: "event-projector";
  entityType: "event";
  id: string;
  eventId: string;
  status: NavigationEventStatus;
  sortBucket: number;
  listSortAt: number;
  ownerProfileId: string;
  startAt: number | null;
  updatedAt: number;
  endedAt: number | null;
  participantCount: number;
  participantPreview: ProjectionParticipant[];
  winnerDisplayName: string | null;
};
export type ProfileGameProjectionRecord =
  GameProjectionRecord | EventProjectionRecord;
function record(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}
function exact(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  return (
    record(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}
const key = (value: unknown): value is string =>
  typeof value === "string" && normalizeRecordKey(value) === value;
const nullableKey = (value: unknown): value is string | null =>
  value === null || key(value);
const nullableText = (value: unknown): value is string | null =>
  value === null || typeof value === "string";
const time = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const nullableTime = (value: unknown): value is number | null =>
  value === null || time(value);
const nullableEmoji = (value: unknown): value is EmojiId | null =>
  value === null || isEmojiId(value);
export function isGameProjectionRecord(
  value: unknown,
): value is GameProjectionRecord {
  if (
    !exact(value, [
      "schemaVersion",
      "projectorVersion",
      "source",
      "entityType",
      "inviteId",
      "kind",
      "hostLoginId",
      "guestLoginId",
      "hostProfileId",
      "guestProfileId",
      "status",
      "sortBucket",
      "isPendingAutomatch",
      "automatchStateHint",
      "automatchCanceledAt",
      "latestMatchId",
      "ownerProfileId",
      "ownerRole",
      "ownerLoginId",
      "opponentProfileId",
      "opponentLoginId",
      "opponentName",
      "opponentEmoji",
      "listSortAt",
      "createdAt",
      "updatedAt",
      "endedAt",
      "lastEventFingerprint",
      "lastEventType",
      "lastEventReason",
      "lastEventAt",
    ]) ||
    value.schemaVersion !== 3 ||
    value.projectorVersion !== 3 ||
    value.source !== "game-projector" ||
    value.entityType !== "game" ||
    !key(value.inviteId) ||
    (value.kind !== "auto" && value.kind !== "direct") ||
    ![
      value.hostLoginId,
      value.guestLoginId,
      value.hostProfileId,
      value.guestProfileId,
      value.ownerLoginId,
      value.opponentProfileId,
      value.opponentLoginId,
    ].every(nullableKey) ||
    !key(value.ownerProfileId) ||
    !key(value.latestMatchId) ||
    (value.ownerRole !== "host" && value.ownerRole !== "guest") ||
    !nullableText(value.opponentName) ||
    !nullableEmoji(value.opponentEmoji) ||
    ![
      value.listSortAt,
      value.createdAt,
      value.updatedAt,
      value.lastEventAt,
    ].every(time) ||
    !nullableTime(value.endedAt) ||
    !nullableTime(value.automatchCanceledAt) ||
    typeof value.lastEventFingerprint !== "string" ||
    !nullableText(value.lastEventType) ||
    !nullableText(value.lastEventReason) ||
    ![null, "pending", "matched", "canceled"].some(
      (hint) => hint === value.automatchStateHint,
    ) ||
    !["pending", "waiting", "active", "ended"].some(
      (status) => status === value.status,
    )
  )
    return false;
  const status = value.status as NavigationGameStatus;
  return (
    value.sortBucket === PROJECTION_SORT_BUCKETS[status] &&
    value.isPendingAutomatch === (status === "pending") &&
    ((status !== "active" && status !== "ended") ||
      value.opponentEmoji !== null)
  );
}
export function isEventProjectionRecord(
  value: unknown,
): value is EventProjectionRecord {
  if (
    !exact(value, [
      "schemaVersion",
      "source",
      "entityType",
      "id",
      "eventId",
      "status",
      "sortBucket",
      "listSortAt",
      "ownerProfileId",
      "startAt",
      "updatedAt",
      "endedAt",
      "participantCount",
      "participantPreview",
      "winnerDisplayName",
    ]) ||
    value.schemaVersion !== 2 ||
    value.source !== "event-projector" ||
    value.entityType !== "event" ||
    !key(value.eventId) ||
    value.id !== `event_${value.eventId}` ||
    !key(value.ownerProfileId) ||
    !time(value.listSortAt) ||
    !time(value.updatedAt) ||
    !nullableTime(value.startAt) ||
    !nullableTime(value.endedAt) ||
    !nullableText(value.winnerDisplayName) ||
    typeof value.participantCount !== "number" ||
    !Number.isSafeInteger(value.participantCount) ||
    value.participantCount < 0 ||
    !Array.isArray(value.participantPreview) ||
    value.participantPreview.length > 6 ||
    value.participantPreview.length > value.participantCount ||
    !value.participantPreview.every(
      (participant: unknown) =>
        exact(participant, ["profileId", "displayName", "emojiId", "aura"]) &&
        nullableKey(participant.profileId) &&
        nullableText(participant.displayName) &&
        nullableEmoji(participant.emojiId) &&
        isAura(participant.aura),
    ) ||
    !["waiting", "active", "ended", "dismissed"].some(
      (status) => status === value.status,
    )
  )
    return false;
  return (
    value.sortBucket ===
    PROJECTION_SORT_BUCKETS[value.status as NavigationEventStatus]
  );
}
export function isProfileGameProjectionRecord(
  value: unknown,
): value is ProfileGameProjectionRecord {
  return isGameProjectionRecord(value) || isEventProjectionRecord(value);
}
export function parseProfileGameProjectionRecord(
  value: unknown,
): ProfileGameProjectionRecord {
  if (!isProfileGameProjectionRecord(value))
    throw new TypeError("invalid-canonical-profile-game-projection");
  return value;
}
