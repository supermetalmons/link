// Generated from src/shared/navigation.ts. Run npm run generate:runtime.
import type { ReadGameBootstrapResponse } from "./game-bootstrap.js";
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
  | {
      ok: false;
    };
export type StartAutomatchApiResponse =
  | (Extract<
      StartAutomatchResponse,
      {
        mode: "matched";
      }
    > & {
      bootstrap?: ReadGameBootstrapResponse;
    })
  | Exclude<
      StartAutomatchResponse,
      {
        mode: "matched";
      }
    >;
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
declare const AUTOMATCH_API_MAX_RESPONSE_BYTES: number;
declare const NAVIGATION_SORT_BUCKETS: Readonly<
  Record<NavigationStatus, 20 | 30 | 40 | 50>
>;
declare const normalizeStrictAutomatchStateHint: (
  value: unknown,
) => AutomatchStateHint | null;
declare const normalizeAutomatchStateHint: (
  value: unknown,
) => AutomatchStateHint | null;
declare const inferAutomatchStateHint: ({
  inviteId,
  queueValue,
  hasGuest,
  storedStateHint,
}: AutomatchStateHintInput) => AutomatchStateHint | null;
declare const getNavigationStatusPriority: (status: NavigationStatus) => number;
declare const getNavigationSortBucket: (
  status: NavigationStatus,
) => 20 | 30 | 40 | 50;
declare const compareNavigationItems: <T extends NavigationOrderingItem>(
  left: T,
  right: T,
) => number;
declare const mapProfileGameProjection: (
  rawData: unknown,
  fallbackProjectionId: string,
) => NavigationItem | null;
declare const isNavigationItem: (value: unknown) => value is NavigationItem;
declare const isNavigationGamesCursor: (
  value: unknown,
) => value is NavigationGamesCursor;
declare const isReadNavigationGamesRequest: (
  value: unknown,
) => value is ReadNavigationGamesRequest;
declare const isReadNavigationGamesResponse: (
  value: unknown,
) => value is ReadNavigationGamesResponse;
declare const isStartAutomatchRequest: (
  value: unknown,
) => value is StartAutomatchRequest;
declare const isStartAutomatchResponse: (
  value: unknown,
) => value is StartAutomatchResponse;
declare const parseStartAutomatchApiResponse: (
  value: unknown,
) => StartAutomatchApiResponse | null;
declare const isCancelAutomatchResponse: (
  value: unknown,
) => value is CancelAutomatchResponse;
declare const isRemoveNavigationGameRequest: (
  value: unknown,
) => value is RemoveNavigationGameRequest;
declare const isRemoveNavigationGameResponse: (
  value: unknown,
) => value is RemoveNavigationGameResponse;
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
