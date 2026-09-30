// Generated from src/telegram/automatchSource.ts. Run npm run generate:runtime.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildPendingAutomatchTelegramSource =
  exports.buildMatchedAutomatchTelegramChanges =
  exports.buildAutomatchTelegramLifecycleChanges =
  exports.buildAutomatchTelegramProjectionChanges =
  exports.TELEGRAM_AUTOMATCH_VERSION =
  exports.TELEGRAM_AUTOMATCH_PROJECTION_OUTBOX_ROOT =
  exports.TELEGRAM_AUTOMATCH_ROOT =
    void 0;
const TELEGRAM_AUTOMATCH_VERSION = 2;
exports.TELEGRAM_AUTOMATCH_VERSION = TELEGRAM_AUTOMATCH_VERSION;
const TELEGRAM_AUTOMATCH_ROOT = "telegramAutomatches";
exports.TELEGRAM_AUTOMATCH_ROOT = TELEGRAM_AUTOMATCH_ROOT;
const TELEGRAM_AUTOMATCH_PROJECTION_OUTBOX_ROOT =
  "telegramProjectionOutbox/automatch";
exports.TELEGRAM_AUTOMATCH_PROJECTION_OUTBOX_ROOT =
  TELEGRAM_AUTOMATCH_PROJECTION_OUTBOX_ROOT;
const buildAutomatchTelegramProjectionChanges = ({
  inviteId,
  requestId,
  timestamp,
}) => [
  {
    kind: "telegram-outbox",
    inviteId,
    value: {
      schemaVersion: 1,
      status: "pending",
      requestId,
      updatedAtMs: timestamp,
    },
  },
];
exports.buildAutomatchTelegramProjectionChanges =
  buildAutomatchTelegramProjectionChanges;
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
exports.buildPendingAutomatchTelegramSource =
  buildPendingAutomatchTelegramSource;
const buildMatchedAutomatchTelegramChanges = ({
  inviteId,
  matchedText,
  timestamp,
  generation,
}) => {
  return [
    {
      kind: "telegram-source-merge",
      inviteId,
      value: {
        lifecycle: "matched",
        matchedText,
        matchedInstanceKey: `matched:${inviteId}`,
        updatedAtMs: timestamp,
        generation,
      },
    },
  ];
};
exports.buildMatchedAutomatchTelegramChanges =
  buildMatchedAutomatchTelegramChanges;
const buildAutomatchTelegramLifecycleChanges = ({
  inviteId,
  lifecycle,
  timestamp,
  generation,
}) => {
  return [
    {
      kind: "telegram-source-merge",
      inviteId,
      value: {
        lifecycle,
        updatedAtMs: timestamp,
        generation,
      },
    },
  ];
};
exports.buildAutomatchTelegramLifecycleChanges =
  buildAutomatchTelegramLifecycleChanges;
