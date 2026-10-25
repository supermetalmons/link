// Generated from src/telegram/projectionCore.ts. Run npm run generate:runtime.
import type { RetainedAutomatchValue } from "../automatchRecords.js";
import { type InviteDocument } from "@mons/shared/invite-records";
import type {
  TelegramAutomatchProjectionGuardWrite,
  TelegramMessageDocument,
} from "./records.js";
export type AutomatchTelegramSourceDocument =
  RetainedAutomatchValue<"telegramAutomatches">;
export type TelegramRatingProjectionInput = {
  telegramDeliveryVersion?: number | null;
  status?: string;
  isEventMatch?: boolean;
  eventOwned?: boolean;
  eventId?: string | null;
  inviteId?: string;
  matchId?: string;
  updateRatingMessage?: string;
  completedAtMs?: number;
};
export declare function retainAutomatchTelegramSource(
  value: unknown,
): AutomatchTelegramSourceDocument;
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
  source: AutomatchTelegramSourceDocument | null;
  reason: "inserted" | "duplicate" | "skipped";
};
declare const AUTOMATCH_PROJECTION_GUARD_VERSION = 1;
declare const normalizeString: (value: unknown) => string;
declare const resolveAutomatchTelegramLifecycle: (
  source: AutomatchTelegramSourceDocument | null,
  inviteData: InviteDocument | null,
) => AutomatchLifecycle | null;
declare const getAutomatchResultFragments: (
  inviteId: string,
  source: AutomatchTelegramSourceDocument,
) => Array<{
  matchId: string;
  text: string;
  matchIndex: number | null;
}>;
declare const evaluateAutomatchProjectionUpdate: (
  record: TelegramMessageDocument | null,
  projection: AutomatchTelegramProjection,
) => ProjectionDecision;
declare const buildAutomatchProjectionGuard: (
  projection: AutomatchTelegramProjection,
) => TelegramAutomatchProjectionGuardWrite;
declare const renderMatchedAutomatchTelegramText: (
  inviteId: string,
  source: AutomatchTelegramSourceDocument,
) => string;
declare const buildAutomatchTelegramProjection: (input: {
  inviteId: string;
  source: AutomatchTelegramSourceDocument | null;
  inviteData: InviteDocument | null;
}) => AutomatchTelegramProjection | null;
declare const isEventRatingUpdate: (
  ratingUpdate: TelegramRatingProjectionInput | null,
) => boolean | null;
declare const shouldProjectRatingTelegramUpdate: (
  ratingUpdate: TelegramRatingProjectionInput | null,
) => boolean;
declare const mergeRatingResultFragment: (
  source: AutomatchTelegramSourceDocument | null,
  ratingUpdate: TelegramRatingProjectionInput,
) => RatingProjectionMerge;
export {
  AUTOMATCH_PROJECTION_GUARD_VERSION,
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
