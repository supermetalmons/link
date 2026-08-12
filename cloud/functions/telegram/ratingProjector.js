const { onDocumentWritten } = require("firebase-functions/v2/firestore");
const admin = require("../firebaseAdmin");
const { TELEGRAM_AUTOMATCH_VERSION } = require("./automatchMessages");
const { requestEventProgress } = require("../eventProgressTasks");
const { runRtdbDecisionTransaction } = require("../rtdbDecisionTransaction");

const normalizeString = (value) =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : "";

const isEventRatingUpdate = (ratingUpdate) =>
  ratingUpdate &&
  (ratingUpdate.isEventMatch === true ||
    ratingUpdate.eventOwned === true ||
    normalizeString(ratingUpdate.eventId) !== "");

const shouldProjectRatingTelegramUpdate = (ratingUpdate) =>
  !!ratingUpdate &&
  ratingUpdate.telegramDeliveryVersion === TELEGRAM_AUTOMATCH_VERSION &&
  ratingUpdate.status === "done" &&
  !isEventRatingUpdate(ratingUpdate) &&
  normalizeString(ratingUpdate.inviteId) !== "" &&
  normalizeString(ratingUpdate.matchId) !== "" &&
  normalizeString(ratingUpdate.updateRatingMessage) !== "";

const shouldRequestEventRatingProgress = (ratingUpdate) =>
  !!ratingUpdate &&
  ratingUpdate.status === "done" &&
  ratingUpdate.isEventMatch === true &&
  ratingUpdate.eventOwned === true &&
  normalizeString(ratingUpdate.eventId) !== "" &&
  normalizeString(ratingUpdate.inviteId) !== "" &&
  normalizeString(ratingUpdate.matchId) !== "";

const mergeRatingResultFragment = (source, ratingUpdate) => {
  if (
    !source ||
    source.version !== TELEGRAM_AUTOMATCH_VERSION ||
    !shouldProjectRatingTelegramUpdate(ratingUpdate)
  ) {
    return { changed: false, source, reason: "skipped" };
  }
  const matchId = normalizeString(ratingUpdate.matchId);
  const existingResults =
    source.results && typeof source.results === "object" ? source.results : {};
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
    typeof source.updatedAtMs === "number" &&
    Number.isFinite(source.updatedAtMs)
      ? Math.floor(source.updatedAtMs)
      : 0;
  const currentGeneration =
    Number.isInteger(source.generation) && source.generation >= 0
      ? source.generation
      : 0;
  return {
    changed: true,
    reason: "inserted",
    source: {
      ...source,
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

const projectRatingTelegramUpdate = async (ratingUpdate, dependencies = {}) => {
  if (!shouldProjectRatingTelegramUpdate(ratingUpdate)) {
    return { status: "skipped" };
  }
  const database = dependencies.database || admin.database();
  const inviteId = normalizeString(ratingUpdate.inviteId);
  const transactionResult = await runRtdbDecisionTransaction(
    database.ref(`telegramAutomatches/${inviteId}`),
    (source) => {
      const merged = mergeRatingResultFragment(source, ratingUpdate);
      const decision = { status: merged.reason };
      return merged.changed
        ? { value: merged.source, decision }
        : { commit: false, decision };
    },
  );
  return {
    status: transactionResult.decision?.status || "skipped",
    committed: transactionResult.committed,
  };
};

const requestEventRatingProgress = async (ratingUpdate, dependencies = {}) => {
  if (!shouldRequestEventRatingProgress(ratingUpdate)) {
    return { status: "skipped" };
  }
  const requestProgress =
    dependencies.requestEventProgress || requestEventProgress;
  const logger = dependencies.logger || console;
  const eventId = normalizeString(ratingUpdate.eventId);
  const inviteId = normalizeString(ratingUpdate.inviteId);
  const matchId = normalizeString(ratingUpdate.matchId);
  const sourceKey = `rating:${inviteId}:${matchId}`;
  try {
    const result = await requestProgress({
      eventId,
      sourceKey,
      reason: "match-rating-updated",
    });
    if (result?.fallbackPersisted && typeof logger.warn === "function") {
      logger.warn("event:progress:fallback:queued", {
        eventId,
        inviteId,
        matchId,
        reason: "match-rating-updated",
        fallbackSignalId: result.fallbackSignalId || null,
      });
    }
    return {
      status: "event-progress-requested",
      eventId,
      sourceKey,
      result,
    };
  } catch (error) {
    if (typeof logger.error === "function") {
      logger.error("event:progress:enqueue:error", {
        eventId,
        inviteId,
        matchId,
        reason: "match-rating-updated",
        error: error && error.message ? error.message : error,
      });
    }
    throw error;
  }
};

const projectRatingUpdateRecord = async (ratingUpdate, dependencies = {}) => {
  if (shouldRequestEventRatingProgress(ratingUpdate)) {
    return requestEventRatingProgress(ratingUpdate, dependencies);
  }
  return projectRatingTelegramUpdate(ratingUpdate, dependencies);
};

const projectRatingTelegramUpdates = onDocumentWritten(
  {
    document: "ratingUpdates/{ratingUpdateId}",
    maxInstances: 10,
    concurrency: 20,
    memory: "256MiB",
    retry: true,
  },
  async (event) => {
    const afterSnapshot = event.data && event.data.after;
    if (!afterSnapshot || !afterSnapshot.exists) {
      return;
    }
    await projectRatingUpdateRecord(afterSnapshot.data() || {});
  },
);

module.exports = {
  isEventRatingUpdate,
  shouldProjectRatingTelegramUpdate,
  shouldRequestEventRatingProgress,
  mergeRatingResultFragment,
  projectRatingTelegramUpdate,
  requestEventRatingProgress,
  projectRatingUpdateRecord,
  projectRatingTelegramUpdates,
};
