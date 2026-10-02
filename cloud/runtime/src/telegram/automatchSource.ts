import type {
  GameSessionChange,
  SessionTimestamp,
  SessionCounter,
} from "../gameSessionChanges.js";
export interface AutomatchTelegramSourceInput {
  inviteId: string;
  timestamp: SessionTimestamp;
}
const TELEGRAM_AUTOMATCH_VERSION = 2;

const buildAutomatchTelegramProjectionChanges: (input: {
  inviteId: string;
  requestId: string;
  timestamp: SessionTimestamp;
}) => GameSessionChange[] = ({ inviteId, requestId, timestamp }) => [
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

const buildPendingAutomatchTelegramSource: (
  input: AutomatchTelegramSourceInput & {
    waitingText: string;
    canceledText: string;
  },
) => Record<string, unknown> = ({
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

const buildMatchedAutomatchTelegramChanges: (
  input: AutomatchTelegramSourceInput & {
    matchedText: string;
    generation: SessionCounter;
  },
) => GameSessionChange[] = ({
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

const buildAutomatchTelegramLifecycleChanges: (
  input: AutomatchTelegramSourceInput & {
    lifecycle: "canceled" | "matched";
    generation: SessionCounter;
  },
) => GameSessionChange[] = ({ inviteId, lifecycle, timestamp, generation }) => {
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

export {
  TELEGRAM_AUTOMATCH_VERSION,
  buildAutomatchTelegramProjectionChanges,
  buildAutomatchTelegramLifecycleChanges,
  buildMatchedAutomatchTelegramChanges,
  buildPendingAutomatchTelegramSource,
};
