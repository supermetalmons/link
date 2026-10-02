import { readProperty } from "./values.js";
import { createHash } from "node:crypto";
import { parseInviteMatchIndex } from "../shared/rematches.js";
import { TELEGRAM_AUTOMATCH_VERSION } from "./automatchSource.js";
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
  source: Record<string, unknown> | null,
  inviteData: Record<string, unknown> | null,
) => AutomatchLifecycle | null = (source, inviteData) => {
  if (!source || source.version !== TELEGRAM_AUTOMATCH_VERSION) {
    return null;
  }
  if (normalizeString(inviteData && inviteData.guestId)) {
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
  source: Record<string, unknown>,
) => Array<{ matchId: string; text: string; matchIndex: number | null }> = (
  inviteId,
  source,
) => {
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
  record: unknown,
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
) => Record<string, unknown> = (projection) => ({
  schemaVersion: AUTOMATCH_PROJECTION_GUARD_VERSION,
  lifecycle: projection.lifecycle,
  sourceGeneration: normalizeGeneration(projection.sourceGeneration),
  sourceRevision: projection.sourceRevision,
  resultDigests: asObject(projection.resultDigests),
});

const renderMatchedAutomatchTelegramText: (
  inviteId: string,
  source: Record<string, unknown>,
) => string = (inviteId, source) => {
  const matchedText = normalizeString(source && source.matchedText);
  if (!matchedText) {
    return "";
  }
  const fragments = getAutomatchResultFragments(inviteId, source);
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
  source: Record<string, unknown> | null;
  inviteData: Record<string, unknown> | null;
}) => AutomatchTelegramProjection | null = ({
  inviteId,
  source,
  inviteData,
}) => {
  const normalizedInviteId = normalizeString(inviteId);
  if (!normalizedInviteId) {
    return null;
  }
  const lifecycle = resolveAutomatchTelegramLifecycle(source, inviteData);
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
    resultFragments = getAutomatchResultFragments(normalizedInviteId, source);
    operation = resultFragments.length > 0 ? "edit" : "send";
    instanceKey = normalizeString(source.matchedInstanceKey);
    text = renderMatchedAutomatchTelegramText(normalizedInviteId, source);
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
  ratingUpdate: Record<string, unknown> | null,
) => boolean | null = (ratingUpdate) =>
  ratingUpdate &&
  (ratingUpdate.isEventMatch === true ||
    ratingUpdate.eventOwned === true ||
    normalizeString(ratingUpdate.eventId) !== "");

const shouldProjectRatingTelegramUpdate: (
  ratingUpdate: Record<string, unknown> | null,
) => boolean = (ratingUpdate) =>
  !!ratingUpdate &&
  ratingUpdate.telegramDeliveryVersion === TELEGRAM_AUTOMATCH_VERSION &&
  ratingUpdate.status === "done" &&
  !isEventRatingUpdate(ratingUpdate) &&
  normalizeString(ratingUpdate.inviteId) !== "" &&
  normalizeString(ratingUpdate.matchId) !== "" &&
  normalizeString(ratingUpdate.updateRatingMessage) !== "";

const mergeRatingResultFragment: (
  source: unknown,
  ratingUpdate: Record<string, unknown>,
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
    source: {
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
    },
  };
};

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
