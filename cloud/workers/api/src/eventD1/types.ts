import { STATE_EFFECTS_FIELD } from "../stateCompatibility.ts";
import type {
  EventJsonRecord,
  EventPrizeAssignmentRecord,
  EventSnapshot,
} from "../../../../runtime/eventReads.js";

export const MAX_EVENT_TRANSACTION_ATTEMPTS = 12;

export type EventD1Connection = Pick<D1Database, "batch" | "prepare"> &
  Partial<Pick<D1Database, "withSession">>;

export type ConditionalSnapshot<T> =
  { notModified: true; revision: number } | { notModified: false; snapshot: T };

export type EventStorageMode = "frozen" | "d1";

export type EventRuntimeControl = {
  freezeGeneration: number;
  storageMode: EventStorageMode;
  updatedAtMs: number;
};

export type EventWriteAdmission = {
  admissionId: string;
  expiresAtMs: number;
  freezeGeneration: number;
};

export type EventLeaseGuard = {
  eventId: string;
  lockId: string;
  ownerUid: string;
};

type EventTransitionIntentBase = {
  canonicalUpdates: Record<string, unknown>;
  createdAtMs: number;
  eventId: string;
  expectedRevision: number;
  [STATE_EFFECTS_FIELD]: Record<string, unknown>;
  transitionId: string;
  updatedAtMs: number;
};

export type EventInviteSourceMutation = {
  current: {
    inviteId: string;
    value: Record<string, unknown> | null;
    revision: number;
  };
  value: Record<string, unknown>;
};

export type EventTransitionIntent = EventTransitionIntentBase &
  (
    | { schemaVersion: 1 }
    | {
        schemaVersion: 2;
        sourceEpoch: number;
        payloadDigest: string;
        inviteMutations: EventInviteSourceMutation[];
      }
  );

export type EventOutboxRecord = Record<string, unknown>;

export class EventD1Failure extends Error {
  constructor(message = "event-d1-unavailable", options?: ErrorOptions) {
    super(message, options);
  }
}

export class EventD1Conflict extends EventD1Failure {
  constructor(message = "event-d1-conflict", options?: ErrorOptions) {
    super(message, options);
  }
}

export class EventWritesDisabled extends EventD1Failure {
  constructor(options?: ErrorOptions) {
    super("event-writes-disabled", options);
  }
}

export type EventRow = {
  event_id: string;
  pending_transition_id: string | null;
  record_json: string | null;
  revision: number;
  start_at_ms: number;
  status: string;
  updated_at_ms: number;
};

export type AssignmentRow = {
  assignment_json: string;
  event_id: string;
  profile_id: string;
};

export type RuntimeControlRow = {
  freeze_generation: number;
  storage_mode: string;
  updated_at_ms: number;
};

export type DecodedEventRow = {
  event: EventJsonRecord;
  pendingTransitionId: string | null;
  revision: number;
};

export type EventMutationState = {
  current: EventJsonRecord | null;
  next: EventJsonRecord | null;
  originalSelections: Readonly<Record<string, string>> | null;
  pendingTransitionId: string | null;
  revision: number;
  selections: Record<string, string> | null;
  selectionsChanged: boolean;
};

export type ProfilePrizeMutationState = {
  originalPrizes: Readonly<Record<string, EventPrizeAssignmentRecord>>;
  prizes: Record<string, EventPrizeAssignmentRecord>;
  revision: number;
};

export type ProfilePrizeAssignmentSnapshot = {
  assignment: EventPrizeAssignmentRecord | null;
  eventId: string;
  profileId: string;
  revision: number;
};

export type StoredEventSnapshot = EventSnapshot & {
  pendingTransitionId: string | null;
};

export type ProgressOutboxSnapshot = {
  outboxId: string;
  recordJson: string | null;
};

export type TelegramProjectionState = {
  generation: number;
  revision: number;
  state: EventJsonRecord;
};

export type TelegramProjectionSnapshot = {
  eventId: string;
  current: TelegramProjectionState | null;
};

export type EventMutationOptions = {
  admission: EventWriteAdmission;
  allowStoredProfilePrizeAssignment?: boolean;
  eventLease?: EventLeaseGuard;
  eventSnapshot?: StoredEventSnapshot;
  expectedEventRevisions?: Readonly<Record<string, number>>;
  expectedRecords?: {
    progress?: Readonly<Record<string, unknown>>;
    dead?: Readonly<Record<string, unknown>>;
    profileGame?: Readonly<Record<string, unknown>>;
    telegram?: Readonly<Record<string, unknown>>;
  };
  expectedProfilePrizeRevisions?: Readonly<Record<string, number>>;
  expectedTelegramStateRevisions?: Readonly<Record<string, number>>;
  now?: () => number;
  profilePrizeSnapshot?: ProfilePrizeAssignmentSnapshot;
  progressOutboxSnapshot?: ProgressOutboxSnapshot;
  telegramProjectionSnapshot?: TelegramProjectionSnapshot;
  transition?: { eventId: string; transitionId: string };
};

export type PublicEventMutationOptions = Omit<
  EventMutationOptions,
  | "allowStoredProfilePrizeAssignment"
  | "eventSnapshot"
  | "profilePrizeSnapshot"
  | "progressOutboxSnapshot"
  | "telegramProjectionSnapshot"
>;

export type EventMutationResult = {
  eventRevisions: Record<string, number>;
  profilePrizeRevisions: Record<string, number>;
};

export type EventLeaseRecord = {
  lockId: string;
  ownerUid: string;
  acquiredAtMs: number;
  refreshedAtMs: number;
  expiresAtMs: number;
  ownerId?: string;
};

export type EventSyncThrottleRecord = {
  ownerUid: string;
  token: string;
  startedAtMs: number;
};

export type EventTransactionOptions = {
  admission: EventWriteAdmission;
  eventLease?: EventLeaseGuard;
  signal?: AbortSignal;
  now?: () => number;
};
