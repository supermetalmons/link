// Generated from src/eventCommands.ts. Run npm run generate:runtime.
import type {
  EventJsonRecord,
  EventPrizeAssignmentRecord,
} from "./eventReads.js";
export type EventFieldValues = {
  createdAtMs: number;
  endedAtMs: number | null;
  participants: Record<string, EventJsonRecord>;
  startAtMs: number;
  startedAtMs: number | null;
  status: "scheduled" | "active" | "ended" | "dismissed";
  winnerDisplayName: string | null;
  winnerProfileId: string | null;
  currentRoundIndex: number | null;
  bracketSize: number;
  roundCount: number;
  rounds: Record<string, unknown>;
  thirdPlaceMatch: EventJsonRecord | null;
  updatedAtMs: number;
  prizeSelectionsLockedAtMs: number | null;
  prizeAssignments: Record<string, unknown>;
  isSundayMons: boolean;
  telegramAnnouncements: {
    invite: boolean;
    matches: boolean;
    results: boolean;
  };
  announceOnTelegram: boolean;
};
export type EventField = keyof EventFieldValues;
export type EventFieldMutation = {
  [K in EventField]: {
    kind: "event-field";
    eventId: string;
    field: K;
    value: EventFieldValues[K];
  };
}[EventField];
export type EventProfileGameOutboxFieldValues = {
  schemaVersion: 1;
  status: "pending" | "dead";
  requestId: string;
  lastQueuedAtMs: number | null;
  reason: string | null;
  deadAtMs: number | null;
};
export type EventProfileGameOutboxFieldMutation = {
  [K in keyof EventProfileGameOutboxFieldValues]: {
    kind: "profile-game-outbox-field";
    eventId: string;
    field: K;
    value: EventProfileGameOutboxFieldValues[K];
  };
}[keyof EventProfileGameOutboxFieldValues];
export type EventMutation =
  | {
      kind: "event";
      eventId: string;
      value: EventJsonRecord;
    }
  | EventFieldMutation
  | {
      kind: "event-round";
      eventId: string;
      roundKey: string;
      value: EventJsonRecord | null;
    }
  | {
      kind: "event-match-status";
      eventId: string;
      roundKey: string;
      matchKey: string;
      value: string;
    }
  | {
      kind: "event-participant";
      eventId: string;
      profileId: string;
      value: EventJsonRecord | null;
    }
  | {
      kind: "event-disqualification";
      eventId: string;
      roundKey: string | null;
      matchKey: string;
      value: boolean;
    }
  | {
      kind: "prize-selections";
      eventId: string;
      value: Record<string, string> | null;
    }
  | {
      kind: "prize-selection";
      eventId: string;
      profileId: string;
      value: string | null;
    }
  | {
      kind: "profile-prizes";
      profileId: string;
      value: Record<string, EventPrizeAssignmentRecord> | null;
    }
  | {
      kind: "profile-prize";
      profileId: string;
      eventId: string;
      value: EventPrizeAssignmentRecord | null;
    }
  | {
      kind: "progress-outbox" | "progress-dead";
      outboxId: string;
      value: EventJsonRecord | null;
    }
  | {
      kind: "progress-dispatched";
      outboxId: string;
      value: number;
    }
  | {
      kind: "profile-game-outbox" | "telegram-outbox";
      eventId: string;
      value: EventJsonRecord | null;
    }
  | EventProfileGameOutboxFieldMutation
  | {
      kind: "profile-game-outbox-cleanup";
      eventId: string;
      profileId: string;
      value: true | null;
    }
  | {
      kind: "telegram-state";
      eventId: string;
      value: EventJsonRecord | null;
    }
  | {
      kind: "telegram-generation";
      eventId: string;
      value: number;
      increment?: boolean;
    };
export type EventEffect =
  | {
      kind: "invite";
      inviteId: string;
      value: EventJsonRecord;
    }
  | {
      kind: "match-creation";
      playerId: string;
      matchId: string;
      value: EventJsonRecord;
    }
  | {
      kind: "match-terminal-timer";
      playerId: string;
      matchId: string;
      value: string;
    }
  | {
      kind: "match-timer-start-cleanup";
      playerId: string;
      matchId: string;
    }
  | {
      kind: "match-timer-claim";
      matchId: string;
      value: EventJsonRecord;
    };
export type EventCommand = EventMutation | EventEffect;
export type EventCommitPlan = EventCommand[];
export type EventRuntimeStore = import("./eventReads.js").EventReads & {
  commitEventPlan(
    plan: readonly EventCommand[],
    signal?: AbortSignal,
  ): Promise<void>;
  transactEventSyncThrottle(
    eventId: string,
    updater: (
      current: {
        ownerUid: string;
        token: string;
        startedAtMs: number;
      } | null,
    ) => import("./transactions.js").TransactionDecision<{
      ownerUid: string;
      token: string;
      startedAtMs: number;
    }>,
    signal?: AbortSignal,
  ): Promise<
    import("./transactions.js").TransactionResult<{
      ownerUid: string;
      token: string;
      startedAtMs: number;
    }>
  >;
  transactProfileEventPrize(
    profileId: string,
    eventId: string,
    updater: (
      current: EventPrizeAssignmentRecord | null,
    ) => import("./transactions.js").TransactionDecision<EventPrizeAssignmentRecord>,
    signal?: AbortSignal,
  ): Promise<
    import("./transactions.js").TransactionResult<EventPrizeAssignmentRecord>
  >;
};
declare const isEventMutation: (
  command: EventCommand,
) => command is EventMutation;
declare const eventField: <K extends EventField>(
  eventId: string,
  field: K,
  value: EventFieldValues[K],
) => Extract<
  EventFieldMutation,
  {
    field: K;
  }
>;
declare const eventCommandIdentity: (command: EventCommand) => string;
declare const mergeEventPlans: (
  ...plans: readonly EventCommand[][]
) => EventCommitPlan;
declare function getEventField<K extends EventField>(
  plan: readonly EventCommand[],
  eventId: string,
  field: K,
): EventFieldValues[K] | undefined;
export {
  getEventField,
  isEventMutation,
  eventField,
  mergeEventPlans,
  eventCommandIdentity,
};
