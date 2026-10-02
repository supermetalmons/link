// Generated from src/telegram/projectionCore.ts. Run npm run generate:runtime.
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
declare const AUTOMATCH_PROJECTION_GUARD_VERSION = 1;
declare const normalizeString: (value: unknown) => string;
declare const asObject: (value: unknown) => Record<string, unknown>;
declare const resolveAutomatchTelegramLifecycle: (
  source: Record<string, unknown> | null,
  inviteData: Record<string, unknown> | null,
) => AutomatchLifecycle | null;
declare const getAutomatchResultFragments: (
  inviteId: string,
  source: Record<string, unknown>,
) => Array<{
  matchId: string;
  text: string;
  matchIndex: number | null;
}>;
declare const evaluateAutomatchProjectionUpdate: (
  record: unknown,
  projection: AutomatchTelegramProjection,
) => ProjectionDecision;
declare const buildAutomatchProjectionGuard: (
  projection: AutomatchTelegramProjection,
) => Record<string, unknown>;
declare const renderMatchedAutomatchTelegramText: (
  inviteId: string,
  source: Record<string, unknown>,
) => string;
declare const buildAutomatchTelegramProjection: (input: {
  inviteId: string;
  source: Record<string, unknown> | null;
  inviteData: Record<string, unknown> | null;
}) => AutomatchTelegramProjection | null;
declare const isEventRatingUpdate: (
  ratingUpdate: Record<string, unknown> | null,
) => boolean | null;
declare const shouldProjectRatingTelegramUpdate: (
  ratingUpdate: Record<string, unknown> | null,
) => boolean;
declare const mergeRatingResultFragment: (
  source: unknown,
  ratingUpdate: Record<string, unknown>,
) => RatingProjectionMerge;
export {
  AUTOMATCH_PROJECTION_GUARD_VERSION,
  asObject,
  buildAutomatchProjectionGuard,
  buildAutomatchTelegramProjection,
  evaluateAutomatchProjectionUpdate,
  getAutomatchResultFragments,
  isEventRatingUpdate,
  mergeRatingResultFragment,
  normalizeString,
  renderMatchedAutomatchTelegramText,
  resolveAutomatchTelegramLifecycle,
  shouldProjectRatingTelegramUpdate,
};
