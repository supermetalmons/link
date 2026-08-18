export type NavigationStatus =
  "pending" | "waiting" | "active" | "ended" | "dismissed";

export interface NavigationOrderingItem {
  id: string;
  status: NavigationStatus;
  sortBucket: number;
  listSortAtMs: number;
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

export const NAVIGATION_SORT_BUCKETS: Readonly<
  Record<NavigationStatus, 20 | 30 | 40 | 50>
>;
export function normalizeAutomatchStateHint(
  value: unknown,
): AutomatchStateHint | null;
export function normalizeStrictAutomatchStateHint(
  value: unknown,
): AutomatchStateHint | null;
export function inferAutomatchStateHint(
  input: AutomatchStateHintInput,
): AutomatchStateHint | null;
export function getNavigationStatusPriority(status: NavigationStatus): number;
export function getNavigationSortBucket(
  status: NavigationStatus,
): 20 | 30 | 40 | 50;
export function compareNavigationItems<T extends NavigationOrderingItem>(
  left: T,
  right: T,
): number;
export function isStartAutomatchRequest(
  value: unknown,
): value is StartAutomatchRequest;
export function isStartAutomatchResponse(
  value: unknown,
): value is StartAutomatchResponse;
export function isCancelAutomatchResponse(
  value: unknown,
): value is CancelAutomatchResponse;
export function isRemoveNavigationGameRequest(
  value: unknown,
): value is RemoveNavigationGameRequest;
export function isRemoveNavigationGameResponse(
  value: unknown,
): value is RemoveNavigationGameResponse;
