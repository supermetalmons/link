import type {
  InviteDocument,
  InviteFieldChanges,
} from "./shared/invite-records.js";
import type { MatchCreationRecord } from "./shared/match-protocol.js";
import type {
  AutomatchEntryWrite,
  AutomatchTelegramSourceWrite,
  HistoricalMatchDescriptorWrite,
  MutationReceiptExpirationWrite,
  MutationReceiptWrite,
  SessionCounter,
  SessionTimestamp,
} from "./automatchRecords.js";
export type { InviteFieldChanges } from "./shared/invite-records.js";
export type { SessionCounter, SessionTimestamp } from "./automatchRecords.js";
export type TelegramSourceChanges = {
  lifecycle?: "pending" | "matched" | "canceled";
  matchedText?: string;
  matchedInstanceKey?: string;
  updatedAtMs?: SessionTimestamp;
  generation?: SessionCounter;
};
export type TelegramProjectionRequest = {
  schemaVersion: 1;
  status: "pending";
  requestId: string;
  updatedAtMs: SessionTimestamp;
};
export type ProfileProjectionRequest = {
  schemaVersion: 1;
  status: "pending";
  requestId: string;
  reason: string;
  sourceUpdatedAtMs: SessionTimestamp;
  lastQueuedAtMs: SessionTimestamp;
};
export type GameSessionChange =
  | { kind: "invite-merge"; inviteId: string; value: InviteDocument }
  | { kind: "invite-fields"; inviteId: string; value: InviteFieldChanges }
  | {
      kind: "invite-operation";
      inviteId: string;
      loginUid: string;
      operationId: string;
    }
  | {
      kind: "invite-rematches";
      inviteId: string;
      role: "host" | "guest";
      value: string;
    }
  | {
      kind: "match-create";
      playerId: string;
      matchId: string;
      value: MatchCreationRecord;
    }
  | {
      kind: "automatch-entry";
      inviteId: string;
      value: AutomatchEntryWrite | null;
    }
  | {
      kind: "telegram-source";
      inviteId: string;
      value: AutomatchTelegramSourceWrite;
    }
  | {
      kind: "telegram-source-merge";
      inviteId: string;
      value: TelegramSourceChanges;
    }
  | {
      kind: "telegram-outbox";
      inviteId: string;
      value: TelegramProjectionRequest | null;
    }
  | {
      kind: "profile-outbox";
      inviteId: string;
      value: ProfileProjectionRequest | null;
    }
  | {
      kind: "profile-outbox-merge";
      inviteId: string;
      value: ProfileProjectionRequest;
      historicalMatches?: Record<string, HistoricalMatchDescriptorWrite>;
    }
  | {
      kind: "mutation-receipt";
      operationId: string;
      value: MutationReceiptWrite;
      expiration: MutationReceiptExpirationWrite;
    };
