"use strict";

const TELEGRAM_AUTOMATCH_VERSION = 2;
const TELEGRAM_AUTOMATCH_ROOT = "telegramAutomatches";
const TELEGRAM_AUTOMATCH_PROJECTION_OUTBOX_ROOT =
  "telegramProjectionOutbox/automatch";

const getAutomatchTelegramSourcePath = (inviteId) =>
  `${TELEGRAM_AUTOMATCH_ROOT}/${inviteId}`;

const getAutomatchTelegramProjectionOutboxPath = (inviteId) =>
  `${TELEGRAM_AUTOMATCH_PROJECTION_OUTBOX_ROOT}/${inviteId}`;

const buildAutomatchTelegramProjectionOutboxUpdates = ({
  inviteId,
  requestId,
  timestamp,
}) => ({
  [getAutomatchTelegramProjectionOutboxPath(inviteId)]: {
    schemaVersion: 1,
    status: "pending",
    requestId,
    updatedAtMs: timestamp,
  },
});

const buildPendingAutomatchTelegramSource = ({
  inviteId,
  waitingText,
  canceledText,
  timestamp,
}) => ({
  version: TELEGRAM_AUTOMATCH_VERSION,
  generation: 1,
  lifecycle: "pending",
  waitingText,
  canceledText,
  waitingInstanceKey: `waiting:${inviteId}`,
  createdAtMs: timestamp,
  updatedAtMs: timestamp,
});

const buildMatchedAutomatchTelegramUpdates = ({
  inviteId,
  matchedText,
  timestamp,
  generation,
}) => {
  const sourcePath = getAutomatchTelegramSourcePath(inviteId);
  return {
    [`${sourcePath}/lifecycle`]: "matched",
    [`${sourcePath}/matchedText`]: matchedText,
    [`${sourcePath}/matchedInstanceKey`]: `matched:${inviteId}`,
    [`${sourcePath}/updatedAtMs`]: timestamp,
    [`${sourcePath}/generation`]: generation,
  };
};

const buildAutomatchTelegramLifecycleUpdates = ({
  inviteId,
  lifecycle,
  timestamp,
  generation,
}) => {
  const sourcePath = getAutomatchTelegramSourcePath(inviteId);
  return {
    [`${sourcePath}/lifecycle`]: lifecycle,
    [`${sourcePath}/updatedAtMs`]: timestamp,
    [`${sourcePath}/generation`]: generation,
  };
};

module.exports = {
  TELEGRAM_AUTOMATCH_ROOT,
  TELEGRAM_AUTOMATCH_PROJECTION_OUTBOX_ROOT,
  TELEGRAM_AUTOMATCH_VERSION,
  buildAutomatchTelegramProjectionOutboxUpdates,
  buildAutomatchTelegramLifecycleUpdates,
  buildMatchedAutomatchTelegramUpdates,
  buildPendingAutomatchTelegramSource,
  getAutomatchTelegramProjectionOutboxPath,
  getAutomatchTelegramSourcePath,
};
