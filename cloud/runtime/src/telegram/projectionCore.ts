import type { RetainedAutomatchValue } from "../automatchRecords.js";
import {
  inviteTrimmedParticipants,
  type InviteDocument,
} from "@mons/shared/invite-records";
import { readProperty } from "./values.js";
import type {
  TelegramAutomatchProjectionGuardWrite,
  TelegramMessageDocument,
} from "./records.js";
import { createHash } from "node:crypto";
import { parseInviteMatchIndex } from "../shared/rematches.js";
import { TELEGRAM_AUTOMATCH_VERSION } from "./automatchSource.js";
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
export function retainAutomatchTelegramSource(
  value: unknown,
): AutomatchTelegramSourceDocument {
  return value as AutomatchTelegramSourceDocument;
}
function sourceEvidence(
  value: AutomatchTelegramSourceDocument | null,
): Record<string, unknown> | null {
  const retained: unknown = value;
  return retained as Record<string, unknown> | null;
}
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

const AUTOMATCH_PROJECTION_GUARD_VERSION = 1;

const normalizeString: (value: unknown) => string = (value: unknown): string =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : "";

const normalizeGeneration = (value: unknown): number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : 0;

const asObject: (value: unknown) => Record<string, unknown> = (
  value: unknown,
): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const resolveAutomatchTelegramLifecycle: (
  source: AutomatchTelegramSourceDocument | null,
  inviteData: InviteDocument | null,
) => AutomatchLifecycle | null = (sourceDocument, inviteData) => {
  const source = sourceEvidence(sourceDocument);
  if (!source || source.version !== TELEGRAM_AUTOMATCH_VERSION) {
    return null;
  }
  if (inviteTrimmedParticipants(inviteData).guestId) {
    return "matched";
  }
  if (
    source.lifecycle === "pending" ||
    source.lifecycle === "matched" ||
    source.lifecycle === "canceled"
  ) {
    return source.lifecycle;
  }
  return null;
};

const getAutomatchResultFragments: (
  inviteId: string,
  source: AutomatchTelegramSourceDocument,
) => Array<{ matchId: string; text: string; matchIndex: number | null }> = (
  inviteId,
  sourceDocument,
) => {
  const source = sourceEvidence(sourceDocument);
  const results =
    source && source.results && typeof source.results === "object"
      ? source.results
      : {};
  return Object.entries(results)
    .map(([matchId, value]) => ({
      matchId,
      text: normalizeString(
        typeof value === "string"
          ? value
          : value && readProperty(value, "text"),
      ),
      matchIndex: parseInviteMatchIndex(inviteId, matchId),
    }))
    .filter((result) => result.matchId !== "" && result.text !== "")
    .sort((left, right) => {
      const leftIndex = left.matchIndex === null ? Infinity : left.matchIndex;
      const rightIndex =
        right.matchIndex === null ? Infinity : right.matchIndex;
      if (leftIndex !== rightIndex) {
        return leftIndex - rightIndex;
      }
      return left.matchId.localeCompare(right.matchId);
    });
};

const hashText = (value: unknown): string =>
  createHash("sha256").update(String(value)).digest("hex");

const buildResultDigests = (
  fragments: readonly { matchId: string; text: string }[],
): Record<string, string> =>
  Object.fromEntries(
    fragments.map((fragment) => [fragment.matchId, hashText(fragment.text)]),
  );

const inferAutomatchProjectionLifecycle = (
  record: unknown,
): AutomatchLifecycle | null => {
  const currentRecord = asObject(record);
  const guard = asObject(currentRecord.automatchProjection);
  const appliedInstanceKey = normalizeString(
    asObject(currentRecord.applied).instanceKey,
  );
  const desired = asObject(currentRecord.desired);
  const desiredInstanceKey = normalizeString(desired.instanceKey);
  if (
    guard.lifecycle === "matched" ||
    appliedInstanceKey.startsWith("matched:") ||
    desiredInstanceKey.startsWith("matched:")
  ) {
    return "matched";
  }
  if (
    guard.lifecycle === "canceled" ||
    (desired.operation === "edit" &&
      desired.ifMissing === "skip" &&
      desiredInstanceKey.startsWith("waiting:"))
  ) {
    return "canceled";
  }
  if (
    guard.lifecycle === "pending" ||
    desiredInstanceKey.startsWith("waiting:")
  ) {
    return "pending";
  }
  return null;
};

const containsProtectedResultDigests = (
  candidateDigests: Record<string, unknown>,
  protectedDigests: unknown,
): boolean =>
  Object.entries(asObject(protectedDigests)).every(
    ([matchId, digest]) =>
      normalizeString(digest) !== "" && candidateDigests[matchId] === digest,
  );

const evaluateAutomatchProjectionUpdate: (
  record: TelegramMessageDocument | null,
  projection: AutomatchTelegramProjection,
) => ProjectionDecision = (record, projection) => {
  const currentRecord = asObject(record);
  const currentGuard = asObject(currentRecord.automatchProjection);
  const currentLifecycle = inferAutomatchProjectionLifecycle(currentRecord);
  const candidateLifecycle = projection.lifecycle;
  const currentGeneration = normalizeGeneration(currentGuard.sourceGeneration);
  const candidateGeneration = normalizeGeneration(projection.sourceGeneration);

  if (currentGeneration > candidateGeneration) {
    return { allowed: false, reason: "older-generation" };
  }
  if (currentLifecycle === "matched" && candidateLifecycle !== "matched") {
    return { allowed: false, reason: "matched-regression" };
  }
  if (currentLifecycle === "canceled" && candidateLifecycle === "pending") {
    return { allowed: false, reason: "canceled-regression" };
  }
  if (
    currentLifecycle === "matched" &&
    candidateLifecycle === "matched" &&
    !containsProtectedResultDigests(
      asObject(projection.resultDigests),
      asObject(currentGuard.resultDigests),
    )
  ) {
    return { allowed: false, reason: "result-regression" };
  }
  return { allowed: true, reason: "advanced" };
};

const buildAutomatchProjectionGuard: (
  projection: AutomatchTelegramProjection,
) => TelegramAutomatchProjectionGuardWrite = (projection) => ({
  schemaVersion: AUTOMATCH_PROJECTION_GUARD_VERSION,
  lifecycle: projection.lifecycle,
  sourceGeneration: normalizeGeneration(projection.sourceGeneration),
  sourceRevision: projection.sourceRevision,
  resultDigests: asObject(projection.resultDigests) as Record<string, string>,
});

const renderMatchedAutomatchTelegramText: (
  inviteId: string,
  source: AutomatchTelegramSourceDocument,
) => string = (inviteId, sourceDocument) => {
  const source = sourceEvidence(sourceDocument);
  const matchedText = normalizeString(source && source.matchedText);
  if (!matchedText) {
    return "";
  }
  const fragments = getAutomatchResultFragments(inviteId, sourceDocument);
  if (fragments.length === 0) {
    return matchedText;
  }
  return `${matchedText}\n\n${fragments.map((fragment) => fragment.text).join("\n\n")}`;
};

const buildSourceRevision = ({
  lifecycle,
  instanceKey,
  text,
  sourceGeneration,
}: {
  lifecycle: AutomatchLifecycle;
  instanceKey: string;
  text: string;
  sourceGeneration: number;
}): string =>
  createHash("sha256")
    .update(
      JSON.stringify({
        version: TELEGRAM_AUTOMATCH_VERSION,
        lifecycle,
        instanceKey,
        text,
        sourceGeneration,
      }),
    )
    .digest("hex");

const buildAutomatchTelegramProjection: (input: {
  inviteId: string;
  source: AutomatchTelegramSourceDocument | null;
  inviteData: InviteDocument | null;
}) => AutomatchTelegramProjection | null = ({
  inviteId,
  source: sourceDocument,
  inviteData,
}) => {
  const source = sourceEvidence(sourceDocument);
  const normalizedInviteId = normalizeString(inviteId);
  if (!normalizedInviteId) {
    return null;
  }
  const lifecycle = resolveAutomatchTelegramLifecycle(
    sourceDocument,
    inviteData,
  );
  if (!lifecycle || !source) {
    return null;
  }

  let operation: "send" | "edit";
  let instanceKey;
  let text;
  let ifMissing: "send" | "skip" | undefined;
  let resultFragments: ReturnType<typeof getAutomatchResultFragments> = [];

  if (lifecycle === "pending") {
    operation = "send";
    instanceKey = normalizeString(source.waitingInstanceKey);
    text = normalizeString(source.waitingText);
  } else if (lifecycle === "canceled") {
    operation = "edit";
    instanceKey = normalizeString(source.waitingInstanceKey);
    text = normalizeString(source.canceledText);
    ifMissing = "skip";
  } else {
    resultFragments = getAutomatchResultFragments(
      normalizedInviteId,
      sourceDocument!,
    );
    operation = resultFragments.length > 0 ? "edit" : "send";
    instanceKey = normalizeString(source.matchedInstanceKey);
    text = renderMatchedAutomatchTelegramText(
      normalizedInviteId,
      sourceDocument!,
    );
    ifMissing = resultFragments.length > 0 ? "send" : undefined;
  }

  if (!instanceKey || !text) {
    return null;
  }

  const sourceGeneration = normalizeGeneration(source.generation);
  return {
    operation,
    lifecycle,
    messageKey: `automatch:${normalizedInviteId}`,
    destination: "community",
    instanceKey,
    text,
    parseMode: "HTML",
    silent: false,
    ...(ifMissing ? { ifMissing } : {}),
    sourceGeneration,
    resultDigests: buildResultDigests(resultFragments),
    sourceRevision: buildSourceRevision({
      lifecycle,
      instanceKey,
      text,
      sourceGeneration,
    }),
  };
};

const isEventRatingUpdate: (
  ratingUpdate: TelegramRatingProjectionInput | null,
) => boolean | null = (ratingUpdate) =>
  ratingUpdate &&
  (ratingUpdate.isEventMatch === true ||
    ratingUpdate.eventOwned === true ||
    normalizeString(ratingUpdate.eventId) !== "");

const shouldProjectRatingTelegramUpdate: (
  ratingUpdate: TelegramRatingProjectionInput | null,
) => boolean = (ratingUpdate) =>
  !!ratingUpdate &&
  ratingUpdate.telegramDeliveryVersion === TELEGRAM_AUTOMATCH_VERSION &&
  ratingUpdate.status === "done" &&
  !isEventRatingUpdate(ratingUpdate) &&
  normalizeString(ratingUpdate.inviteId) !== "" &&
  normalizeString(ratingUpdate.matchId) !== "" &&
  normalizeString(ratingUpdate.updateRatingMessage) !== "";

const mergeRatingResultFragment: (
  source: AutomatchTelegramSourceDocument | null,
  ratingUpdate: TelegramRatingProjectionInput,
) => RatingProjectionMerge = (source, ratingUpdate) => {
  const record = (source || {}) as Record<string, unknown>;
  if (
    !source ||
    record.version !== TELEGRAM_AUTOMATCH_VERSION ||
    !shouldProjectRatingTelegramUpdate(ratingUpdate)
  ) {
    return { changed: false, source, reason: "skipped" };
  }
  const matchId = normalizeString(ratingUpdate.matchId);
  const existingResults =
    record.results && typeof record.results === "object" ? record.results : {};
  if (Object.hasOwn(existingResults, matchId)) {
    return { changed: false, source, reason: "duplicate" };
  }
  const completedAtMs =
    typeof ratingUpdate.completedAtMs === "number" &&
    Number.isFinite(ratingUpdate.completedAtMs)
      ? Math.floor(ratingUpdate.completedAtMs)
      : null;
  const result = {
    text: ratingUpdate.updateRatingMessage,
    ...(completedAtMs === null ? {} : { completedAtMs }),
  };
  const currentUpdatedAtMs =
    typeof record.updatedAtMs === "number" &&
    Number.isFinite(record.updatedAtMs)
      ? Math.floor(record.updatedAtMs)
      : 0;
  const currentGeneration =
    typeof record.generation === "number" &&
    Number.isInteger(record.generation) &&
    record.generation >= 0
      ? record.generation
      : 0;
  return {
    changed: true,
    reason: "inserted",
    source: retainAutomatchTelegramSource({
      ...record,
      results: {
        ...existingResults,
        [matchId]: result,
      },
      updatedAtMs:
        completedAtMs === null
          ? currentUpdatedAtMs
          : Math.max(currentUpdatedAtMs, completedAtMs),
      generation: currentGeneration + 1,
    }),
  };
};

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
