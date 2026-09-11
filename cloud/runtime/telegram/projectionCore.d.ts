export type AutomatchLifecycle = "pending" | "matched" | "canceled";

export type AutomatchTelegramProjection = {
  operation: "send" | "edit";
  lifecycle: AutomatchLifecycle;
  messageKey: string;
  destination: "community";
  instanceKey: string;
  text: string;
  parseMode: "HTML";
  silent: false;
  ifMissing?: "send" | "skip";
  sourceGeneration: number;
  resultDigests: Record<string, string>;
  sourceRevision: string;
};

export type ProjectionDecision = {
  allowed: boolean;
  reason: string;
};

export type RatingProjectionMerge = {
  changed: boolean;
  source: unknown;
  reason: string;
};

export function asObject(value: unknown): Record<string, unknown>;
export function normalizeString(value: unknown): string;
export function resolveAutomatchTelegramLifecycle(
  source: Record<string, unknown> | null,
  inviteData: Record<string, unknown> | null,
): AutomatchLifecycle | null;
export function getAutomatchResultFragments(
  inviteId: string,
  source: Record<string, unknown>,
): Array<{ matchId: string; text: string; matchIndex: number | null }>;
export function renderMatchedAutomatchTelegramText(
  inviteId: string,
  source: Record<string, unknown>,
): string;
export function buildAutomatchTelegramProjection(input: {
  inviteId: string;
  source: Record<string, unknown> | null;
  inviteData: Record<string, unknown> | null;
}): AutomatchTelegramProjection | null;
export function evaluateAutomatchProjectionUpdate(
  record: unknown,
  projection: AutomatchTelegramProjection,
): ProjectionDecision;
export function buildAutomatchProjectionGuard(
  projection: AutomatchTelegramProjection,
): Record<string, unknown>;
export function isEventRatingUpdate(
  ratingUpdate: Record<string, unknown> | null,
): boolean;
export function shouldProjectRatingTelegramUpdate(
  ratingUpdate: Record<string, unknown> | null,
): boolean;
export function shouldRequestEventRatingProgress(
  ratingUpdate: Record<string, unknown> | null,
): boolean;
export function mergeRatingResultFragment(
  source: unknown,
  ratingUpdate: Record<string, unknown>,
): RatingProjectionMerge;
