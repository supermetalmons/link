import type { ReadGameBootstrapResponse } from "./game-bootstrap.js";
import { isAutoInviteId } from "./ids.js";
import {
  GAME_BOOTSTRAP_MAX_RESPONSE_BYTES,
  isReadGameBootstrapResponse,
} from "./game-bootstrap.js";

export type NavigationStatus =
  "pending" | "waiting" | "active" | "ended" | "dismissed";

export interface NavigationOrderingItem {
  id: string;
  status: NavigationStatus;
  sortBucket: number;
  listSortAtMs: number;
}

export type NavigationGameStatus = Exclude<NavigationStatus, "dismissed">;

export type NavigationEventStatus = Exclude<NavigationStatus, "pending">;

export interface NavigationGameItem extends NavigationOrderingItem {
  entityType: "game";
  inviteId: string;
  kind: "auto" | "direct";
  status: NavigationGameStatus;
  hostLoginId: string | null;
  guestLoginId: string | null;
  opponentProfileId: string | null;
  opponentName: string | null;
  opponentEmoji: number | null;
  automatchStateHint: AutomatchStateHint | null;
  isPendingAutomatch: boolean;
  isOptimistic?: boolean;
}

export interface EventNavigationPreviewParticipant {
  profileId: string | null;
  displayName: string | null;
  emojiId: number | null;
  aura: string | null;
}

export interface NavigationEventItem extends NavigationOrderingItem {
  entityType: "event";
  eventId: string;
  status: NavigationEventStatus;
  startAtMs: number | null;
  updatedAtMs: number | null;
  endedAtMs: number | null;
  participantCount: number;
  participantPreview: EventNavigationPreviewParticipant[];
  winnerDisplayName: string | null;
  isOptimistic?: boolean;
}

export type NavigationItem = NavigationGameItem | NavigationEventItem;

export interface NavigationGamesCursor {
  sortBucket: number;
  listSortAtMs: number;
  id: string;
}

export interface ReadNavigationGamesRequest {
  limit: number;
  cursor: NavigationGamesCursor | null;
}

export interface ReadNavigationGamesResponse {
  ok: true;
  items: NavigationItem[];
  nextCursor: NavigationGamesCursor | null;
  hasMore: boolean;
}

export type AutomatchStateHint = "pending" | "matched" | "canceled";

export interface AutomatchStateHintInput {
  inviteId: string;
  queueValue?: unknown;
  hasGuest: boolean;
  storedStateHint?: unknown;
}

export interface StartAutomatchRequest {
  emojiId: number;
  aura: string;
}

export type StartAutomatchResponse =
  | {
      ok: true;
      inviteId: string;
      mode: "matched";
      matchedImmediately: true;
    }
  | {
      ok: true;
      inviteId: string;
      mode: "pending";
      matchedImmediately: false;
    }
  | { ok: false };

export type StartAutomatchApiResponse =
  | (Extract<StartAutomatchResponse, { mode: "matched" }> & {
      bootstrap?: ReadGameBootstrapResponse;
    })
  | Exclude<StartAutomatchResponse, { mode: "matched" }>;

export type CancelAutomatchRequest = Record<string, never>;

export interface CancelAutomatchResponse {
  ok: boolean;
}

export interface RemoveNavigationGameRequest {
  inviteId: string;
}

export interface RemoveNavigationGameResponse {
  ok: true;
  skipped: boolean;
  deleted?: boolean;
  reason: string | null;
  inviteId: string;
}

const AUTOMATCH_API_MAX_RESPONSE_BYTES: number =
  GAME_BOOTSTRAP_MAX_RESPONSE_BYTES + 1024;

const NAVIGATION_SORT_BUCKETS: Readonly<
  Record<NavigationStatus, 20 | 30 | 40 | 50>
> = Object.freeze({
  pending: 20,
  waiting: 30,
  active: 40,
  ended: 50,
  dismissed: 50,
});

const normalizeStrictAutomatchStateHint = (
  value: unknown,
): AutomatchStateHint | null =>
  value === "pending" || value === "matched" || value === "canceled"
    ? value
    : null;

const normalizeAutomatchStateHint = (
  value: unknown,
): AutomatchStateHint | null =>
  typeof value === "string"
    ? normalizeStrictAutomatchStateHint(value.trim())
    : null;

const inferAutomatchStateHint = ({
  inviteId,
  queueValue,
  hasGuest,
  storedStateHint,
}: AutomatchStateHintInput): AutomatchStateHint | null => {
  if (!isAutoInviteId(inviteId)) {
    return null;
  }
  if (queueValue) {
    return "pending";
  }
  if (hasGuest) {
    return "matched";
  }
  return normalizeAutomatchStateHint(storedStateHint) ?? "canceled";
};

const getNavigationStatusPriority = (status: NavigationStatus): number => {
  if (status === "pending") {
    return 0;
  }
  if (status === "waiting") {
    return 1;
  }
  if (status === "active") {
    return 2;
  }
  return 3;
};

const getNavigationSortBucket = (
  status: NavigationStatus,
): 20 | 30 | 40 | 50 => {
  if (status === "pending") {
    return NAVIGATION_SORT_BUCKETS.pending;
  }
  if (status === "active") {
    return NAVIGATION_SORT_BUCKETS.active;
  }
  if (status === "ended" || status === "dismissed") {
    return NAVIGATION_SORT_BUCKETS.ended;
  }
  return NAVIGATION_SORT_BUCKETS.waiting;
};

const compareNavigationItems = <T extends NavigationOrderingItem>(
  left: T,
  right: T,
): number => {
  const leftPriority = getNavigationStatusPriority(left.status);
  const rightPriority = getNavigationStatusPriority(right.status);
  if (leftPriority !== rightPriority) {
    return leftPriority - rightPriority;
  }
  if (left.sortBucket !== right.sortBucket) {
    return left.sortBucket - right.sortBucket;
  }
  if (left.listSortAtMs !== right.listSortAtMs) {
    return right.listSortAtMs - left.listSortAtMs;
  }
  return left.id.localeCompare(right.id);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  (value && typeof value === "object" && !Array.isArray(value)) as boolean;

const exactKeys = (value: object, expected: readonly string[]): boolean => {
  const keys = Object.keys(value);
  return (
    keys.length === expected.length &&
    keys.every((key) => expected.includes(key))
  );
};

const readTimestampMillis = (value: unknown) => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.floor(value);
  }
  return 0;
};

const normalizeStringOrNull = (value: unknown) =>
  typeof value === "string" && value !== "" ? value : null;

const normalizeFiniteNumber = (value: unknown, fallback = 0) => {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value !== ""
        ? Number(value)
        : NaN;
  return Number.isFinite(parsed) ? Math.floor(parsed) : fallback;
};

const normalizeNavigationStatus = (status: unknown) =>
  status === "pending" ||
  status === "waiting" ||
  status === "active" ||
  status === "ended" ||
  status === "dismissed"
    ? status
    : "waiting";

const mapProjectionParticipantPreview = (value: unknown) => {
  if (!Array.isArray(value)) return [];
  return value.reduce((participants, candidate) => {
    if (!isRecord(candidate)) return participants;
    const emojiId = normalizeFiniteNumber(candidate.emojiId, NaN);
    participants.push({
      profileId: normalizeStringOrNull(candidate.profileId),
      displayName: normalizeStringOrNull(candidate.displayName),
      emojiId: Number.isFinite(emojiId) ? emojiId : null,
      aura: normalizeStringOrNull(candidate.aura),
    });
    return participants;
  }, []);
};

const mapProfileGameProjection = (
  rawData: unknown,
  fallbackProjectionId: string,
): NavigationItem | null => {
  if (!isRecord(rawData)) return null;
  const entityType = rawData.entityType === "event" ? "event" : "game";
  if (entityType === "event") {
    const eventId = normalizeStringOrNull(rawData.eventId);
    if (!eventId) return null;
    const rawStatus = normalizeNavigationStatus(rawData.status);
    if (rawStatus === "pending") return null;
    const participantPreview = mapProjectionParticipantPreview(
      rawData.participantPreview,
    );
    return {
      id:
        typeof rawData.id === "string" && rawData.id !== ""
          ? rawData.id
          : `event_${eventId}`,
      entityType: "event",
      eventId,
      status: rawStatus,
      sortBucket: getNavigationSortBucket(rawStatus),
      listSortAtMs: readTimestampMillis(rawData.listSortAt) || Date.now(),
      startAtMs: readTimestampMillis(rawData.startAt) || null,
      updatedAtMs: readTimestampMillis(rawData.updatedAt) || null,
      endedAtMs: readTimestampMillis(rawData.endedAt) || null,
      participantCount: normalizeFiniteNumber(
        rawData.participantCount,
        participantPreview.length,
      ),
      participantPreview,
      winnerDisplayName: normalizeStringOrNull(rawData.winnerDisplayName),
    };
  }

  const inviteId =
    typeof rawData.inviteId === "string" && rawData.inviteId !== ""
      ? rawData.inviteId
      : fallbackProjectionId;
  if (!inviteId) return null;
  const rawStatus = normalizeNavigationStatus(rawData.status);
  const status = rawStatus === "dismissed" ? "ended" : rawStatus;
  const rawOpponentEmoji = rawData.opponentEmoji ?? rawData.opponentEmojiId;
  const rawOpponentName = rawData.opponentName ?? rawData.opponentDisplayName;
  const opponentEmoji = normalizeFiniteNumber(rawOpponentEmoji, NaN);
  const normalizedOpponentEmoji = Number.isFinite(opponentEmoji)
    ? opponentEmoji
    : null;
  if (
    (status === "active" || status === "ended") &&
    normalizedOpponentEmoji === null
  ) {
    return null;
  }
  return {
    id: inviteId,
    entityType: "game",
    inviteId,
    kind: rawData.kind === "auto" ? "auto" : "direct",
    status,
    sortBucket: getNavigationSortBucket(status),
    listSortAtMs: readTimestampMillis(rawData.listSortAt) || Date.now(),
    hostLoginId: normalizeStringOrNull(rawData.hostLoginId),
    guestLoginId: normalizeStringOrNull(rawData.guestLoginId),
    opponentProfileId: normalizeStringOrNull(rawData.opponentProfileId),
    opponentName: typeof rawOpponentName === "string" ? rawOpponentName : null,
    opponentEmoji: normalizedOpponentEmoji,
    automatchStateHint: normalizeStrictAutomatchStateHint(
      rawData.automatchStateHint,
    ),
    isPendingAutomatch:
      typeof rawData.isPendingAutomatch === "boolean"
        ? rawData.isPendingAutomatch
        : status === "pending",
  };
};

const isNullableString = (value: unknown): value is string | null =>
  value === null || typeof value === "string";
const isNullableNumber = (value: unknown): value is number | null =>
  value === null || (typeof value === "number" && Number.isFinite(value));

const isNavigationParticipantPreview = (
  value: unknown,
): value is EventNavigationPreviewParticipant[] =>
  Array.isArray(value) &&
  value.every(
    (participant) =>
      isRecord(participant) &&
      exactKeys(participant, ["profileId", "displayName", "emojiId", "aura"]) &&
      isNullableString(participant.profileId) &&
      isNullableString(participant.displayName) &&
      isNullableNumber(participant.emojiId) &&
      isNullableString(participant.aura),
  );

const isNavigationItem = (value: unknown): value is NavigationItem => {
  if (!isRecord(value)) return false;
  if (value.entityType === "event") {
    return (
      exactKeys(value, [
        "id",
        "entityType",
        "eventId",
        "status",
        "sortBucket",
        "listSortAtMs",
        "startAtMs",
        "updatedAtMs",
        "endedAtMs",
        "participantCount",
        "participantPreview",
        "winnerDisplayName",
      ]) &&
      typeof value.id === "string" &&
      value.id !== "" &&
      typeof value.eventId === "string" &&
      value.eventId !== "" &&
      value.status !== "pending" &&
      normalizeNavigationStatus(value.status) === value.status &&
      Number.isInteger(value.sortBucket) &&
      Number.isSafeInteger(value.listSortAtMs) &&
      (value.listSortAtMs as number) > 0 &&
      isNullableNumber(value.startAtMs) &&
      isNullableNumber(value.updatedAtMs) &&
      isNullableNumber(value.endedAtMs) &&
      Number.isSafeInteger(value.participantCount) &&
      (value.participantCount as number) >= 0 &&
      isNavigationParticipantPreview(value.participantPreview) &&
      isNullableString(value.winnerDisplayName)
    );
  }
  return (
    value.entityType === "game" &&
    exactKeys(value, [
      "id",
      "entityType",
      "inviteId",
      "kind",
      "status",
      "sortBucket",
      "listSortAtMs",
      "hostLoginId",
      "guestLoginId",
      "opponentProfileId",
      "opponentName",
      "opponentEmoji",
      "automatchStateHint",
      "isPendingAutomatch",
    ]) &&
    typeof value.id === "string" &&
    value.id !== "" &&
    typeof value.inviteId === "string" &&
    value.inviteId !== "" &&
    (value.kind === "auto" || value.kind === "direct") &&
    value.status !== "dismissed" &&
    normalizeNavigationStatus(value.status) === value.status &&
    Number.isInteger(value.sortBucket) &&
    Number.isSafeInteger(value.listSortAtMs) &&
    (value.listSortAtMs as number) > 0 &&
    isNullableString(value.hostLoginId) &&
    isNullableString(value.guestLoginId) &&
    isNullableString(value.opponentProfileId) &&
    isNullableString(value.opponentName) &&
    isNullableNumber(value.opponentEmoji) &&
    normalizeStrictAutomatchStateHint(value.automatchStateHint) ===
      value.automatchStateHint &&
    typeof value.isPendingAutomatch === "boolean"
  );
};

const isNavigationGamesCursor = (
  value: unknown,
): value is NavigationGamesCursor =>
  isRecord(value) &&
  exactKeys(value, ["sortBucket", "listSortAtMs", "id"]) &&
  Number.isInteger(value.sortBucket) &&
  (Object.values(NAVIGATION_SORT_BUCKETS) as readonly unknown[]).includes(
    value.sortBucket,
  ) &&
  Number.isSafeInteger(value.listSortAtMs) &&
  (value.listSortAtMs as number) > 0 &&
  typeof value.id === "string" &&
  value.id !== "" &&
  new TextEncoder().encode(value.id).byteLength <= 1500 &&
  !value.id.includes("/");

const isReadNavigationGamesRequest = (
  value: unknown,
): value is ReadNavigationGamesRequest =>
  isRecord(value) &&
  exactKeys(value, ["limit", "cursor"]) &&
  Number.isSafeInteger(value.limit) &&
  (value.limit as number) >= 1 &&
  (value.limit as number) <= 100 &&
  (value.cursor === null || isNavigationGamesCursor(value.cursor));

const isReadNavigationGamesResponse = (
  value: unknown,
): value is ReadNavigationGamesResponse =>
  isRecord(value) &&
  exactKeys(value, ["ok", "items", "nextCursor", "hasMore"]) &&
  value.ok === true &&
  Array.isArray(value.items) &&
  value.items.length <= 100 &&
  value.items.every(isNavigationItem) &&
  (value.nextCursor === null || isNavigationGamesCursor(value.nextCursor)) &&
  typeof value.hasMore === "boolean";

const isStartAutomatchRequest = (
  value: unknown,
): value is StartAutomatchRequest =>
  isRecord(value) &&
  Object.keys(value).length === 2 &&
  Number.isSafeInteger(value.emojiId) &&
  (value.emojiId as number) > 0 &&
  typeof value.aura === "string";

const isStartAutomatchResponse = (
  value: unknown,
): value is StartAutomatchResponse => {
  if (!isRecord(value) || typeof value.ok !== "boolean") {
    return false;
  }
  if (value.ok === false) {
    return Object.keys(value).length === 1;
  }
  if (
    Object.keys(value).length !== 4 ||
    typeof value.inviteId !== "string" ||
    value.inviteId.trim() === "" ||
    (value.mode !== "matched" && value.mode !== "pending") ||
    typeof value.matchedImmediately !== "boolean"
  ) {
    return false;
  }
  return value.matchedImmediately === (value.mode === "matched");
};

const parseStartAutomatchApiResponse = (
  value: unknown,
): StartAutomatchApiResponse | null => {
  if (!isRecord(value)) return null;
  const { bootstrap, ...response } = value;
  if (!isStartAutomatchResponse(response)) return null;
  if (
    response.ok &&
    response.mode === "matched" &&
    isReadGameBootstrapResponse(bootstrap) &&
    bootstrap.metadata.inviteId === response.inviteId &&
    bootstrap.metadata.automatchStateHint === "matched" &&
    bootstrap.viewer.role !== "watch" &&
    bootstrap.match.hostMatch !== null &&
    bootstrap.match.guestMatch !== null
  )
    return { ...response, bootstrap };
  return response;
};

const isCancelAutomatchResponse = (
  value: unknown,
): value is CancelAutomatchResponse =>
  isRecord(value) &&
  Object.keys(value).length === 1 &&
  typeof value.ok === "boolean";

const isRemoveNavigationGameRequest = (
  value: unknown,
): value is RemoveNavigationGameRequest =>
  isRecord(value) &&
  Object.keys(value).length === 1 &&
  typeof value.inviteId === "string" &&
  value.inviteId.trim() !== "";

const isRemoveNavigationGameResponse = (
  value: unknown,
): value is RemoveNavigationGameResponse => {
  if (
    !isRecord(value) ||
    value.ok !== true ||
    typeof value.skipped !== "boolean" ||
    typeof value.inviteId !== "string" ||
    value.inviteId === "" ||
    !(value.reason === null || typeof value.reason === "string")
  ) {
    return false;
  }
  const keys = Object.keys(value);
  if (
    keys.some(
      (key) =>
        key !== "ok" &&
        key !== "skipped" &&
        key !== "deleted" &&
        key !== "reason" &&
        key !== "inviteId",
    )
  ) {
    return false;
  }
  if (Object.hasOwn(value, "deleted") && typeof value.deleted !== "boolean") {
    return false;
  }
  if (!value.skipped) {
    return value.deleted === true && value.reason === null;
  }
  return value.deleted !== true && typeof value.reason === "string";
};

export {
  AUTOMATCH_API_MAX_RESPONSE_BYTES,
  NAVIGATION_SORT_BUCKETS,
  normalizeAutomatchStateHint,
  normalizeStrictAutomatchStateHint,
  inferAutomatchStateHint,
  getNavigationStatusPriority,
  getNavigationSortBucket,
  compareNavigationItems,
  mapProfileGameProjection,
  isNavigationItem,
  isNavigationGamesCursor,
  isReadNavigationGamesRequest,
  isReadNavigationGamesResponse,
  isStartAutomatchRequest,
  isStartAutomatchResponse,
  parseStartAutomatchApiResponse,
  isCancelAutomatchResponse,
  isRemoveNavigationGameRequest,
  isRemoveNavigationGameResponse,
};
