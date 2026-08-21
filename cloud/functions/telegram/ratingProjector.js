const { onDocumentWritten } = require("firebase-functions/v2/firestore");
const { requestEventProgress } = require("../eventProgressTasks");
const {
  normalizeString,
  shouldRequestEventRatingProgress,
} = require("./projectionCore");

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
  return { status: "skipped" };
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
  shouldRequestEventRatingProgress,
  requestEventRatingProgress,
  projectRatingUpdateRecord,
  projectRatingTelegramUpdates,
};
