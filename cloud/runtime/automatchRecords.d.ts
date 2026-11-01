// Generated from src/automatchRecords.ts. Run npm run generate:runtime.
import { type Aura, type EmojiId } from "./shared/appearance.js";
import {
  type CreateInviteResponse,
  type EndRematchResponse,
  type EnsureMatchResponse,
  type JoinInviteResponse,
  type ProposeRematchResponse,
} from "./shared/game-sessions.js";
import { type StartAutomatchResponse } from "./shared/navigation.js";
export type AutomatchRecordRoot =
  | "automatch"
  | "telegramAutomatches"
  | "telegramProjectionOutbox/automatch"
  | "profileGameProjectionOutbox/automatch"
  | "gameplayMutationReceipts"
  | "gameplayMutationReceiptExpirations";
export type SessionTimestampOperation = {
  readonly kind: "timestamp";
};
export type SessionIncrementOperation = {
  readonly kind: "increment";
  readonly delta: number;
};
export type SessionTimestamp = number | SessionTimestampOperation;
export type SessionCounter = number | SessionIncrementOperation;
export type AutomatchEntryRecord = {
  schemaVersion: 1;
  uid: string;
  profileId: string | null;
  timestamp: number;
  rating: number;
  hostColor: "white" | "black";
  password: string;
  gameVariant: string;
  telegramDeliveryVersion: 2 | null;
  username: string;
  ethAddress: string;
  solAddress: string;
  emojiId: EmojiId;
};
export type AutomatchEntryFields = AutomatchEntryRecord;
export type AutomatchEntryRead = AutomatchEntryRecord | null;
export type AutomatchEntryWrite = Omit<AutomatchEntryRecord, "timestamp"> & {
  timestamp: SessionTimestamp;
};
type AutomatchTelegramResult = {
  completedAtMs: number;
  text: string;
};
export type AutomatchTelegramSourceRecord = {
  schemaVersion: 1;
  version: 2;
  generation: number;
  lifecycle: "pending" | "matched" | "canceled";
  waitingText: string;
  canceledText: string;
  waitingInstanceKey: string;
  matchedText: string | null;
  matchedInstanceKey: string | null;
  createdAtMs: number;
  updatedAtMs: number;
  results: Record<string, AutomatchTelegramResult>;
};
export type AutomatchTelegramSourceWrite = Omit<
  AutomatchTelegramSourceRecord,
  "createdAtMs" | "updatedAtMs"
> & {
  createdAtMs: SessionTimestamp;
  updatedAtMs: SessionTimestamp;
};
type RetiredGameplayEffects = {
  state: "retired";
  retiredAtMs: number;
  sourceDigest: string;
};
type GameplayEffectsState =
  | {
      state: "enabled";
    }
  | RetiredGameplayEffects;
type SuccessfulStartAutomatchResponse = Extract<
  StartAutomatchResponse,
  {
    ok: true;
  }
>;
export type AutomatchReceiptView = {
  schemaVersion: 2;
  kind: "automatch-start";
  aura: Aura;
  completedAtMs: number;
  emojiId: EmojiId;
  inviteId: string;
  operationId: string;
  profileProjectionRequestId: string | null;
  requesterUid: string;
  response: SuccessfulStartAutomatchResponse;
  telegramProjection: boolean;
  effects: GameplayEffectsState;
};
export type AutomatchReceiptWrite = Omit<
  AutomatchReceiptView,
  "completedAtMs"
> & {
  completedAtMs: SessionTimestamp;
};
type SessionResponseUnion =
  | CreateInviteResponse
  | JoinInviteResponse
  | EnsureMatchResponse
  | EndRematchResponse
  | ProposeRematchResponse;
type ResponseKeys<Response> = Response extends unknown ? keyof Response : never;
type ReceiptResponse<Response> = Response & {
  [Key in Exclude<ResponseKeys<SessionResponseUnion>, keyof Response>]?: never;
};
export type GameSessionMutationResponseMap = {
  "invite-create": ReceiptResponse<CreateInviteResponse>;
  "invite-join": ReceiptResponse<JoinInviteResponse>;
  "match-ensure": ReceiptResponse<EnsureMatchResponse>;
  "rematch-end": ReceiptResponse<EndRematchResponse>;
  "rematch-propose": ReceiptResponse<ProposeRematchResponse>;
};
export type GameSessionMutationKind = keyof GameSessionMutationResponseMap;
export type GameSessionResponse =
  GameSessionMutationResponseMap[GameSessionMutationKind];
type GameSessionMutationReceiptFields = {
  schemaVersion: 2;
  completedAtMs: number;
  fingerprint: string;
  inviteId: string;
  operationId: string;
  projectionRequestId: string | null;
  requesterUid: string;
  effects: GameplayEffectsState;
};
export type GameSessionMutationReceiptView = {
  [Kind in GameSessionMutationKind]: GameSessionMutationReceiptFields & {
    kind: Kind;
    response: GameSessionMutationResponseMap[Kind];
  };
}[GameSessionMutationKind];
export type GameSessionMutationReceiptWrite<
  Kind extends GameSessionMutationKind = GameSessionMutationKind,
> = {
  [Key in Kind]: Omit<GameSessionMutationReceiptFields, "completedAtMs"> & {
    kind: Key;
    response: GameSessionMutationResponseMap[Key];
    completedAtMs: SessionTimestamp;
  };
}[Kind];
type MutationReceiptRecord =
  AutomatchReceiptView | GameSessionMutationReceiptView;
export type MutationReceiptWrite =
  AutomatchReceiptWrite | GameSessionMutationReceiptWrite;
type MutationReceiptExpirationRecord = {
  schemaVersion: 1;
  completedAtMs: number;
};
export type MutationReceiptExpirationWrite = {
  schemaVersion: 1;
  completedAtMs: SessionTimestamp;
};
export type HistoricalMatchDescriptorWrite = {
  finalizedAtMs: number;
  guestPlayerId: string;
  hostPlayerId: string;
  retryNotBeforeMs: number | null;
  source: "backfill" | "rating" | "transition";
};
export type AutomatchTelegramOutboxRecord =
  | {
      schemaVersion: 2;
      status: "pending";
      requestId: string;
      updatedAtMs: number;
    }
  | {
      schemaVersion: 2;
      status: "dead";
      requestId: string;
      updatedAtMs: null;
      deadAtMs: number;
      reason: string;
    }
  | {
      schemaVersion: 2;
      status: "cancelled";
      requestId: string;
      updatedAtMs: null;
      sourceUpdatedAtMs: number;
      retirement: RetiredGameplayEffects;
    };
export type AutomatchProfileOutboxRecord =
  | {
      schemaVersion: 2;
      status: "pending";
      requestId: string;
      reason: string;
      sourceUpdatedAtMs: number;
      lastQueuedAtMs: number;
      historicalMatches: Record<string, HistoricalMatchDescriptorWrite>;
      archiveRetry: {
        requestId: string;
        notBeforeMs: number;
      } | null;
    }
  | {
      schemaVersion: 2;
      status: "cancelled";
      requestId: string;
      reason: string;
      sourceUpdatedAtMs: number;
      lastQueuedAtMs: number;
      historicalMatches: Record<string, HistoricalMatchDescriptorWrite>;
      archiveRetry: {
        requestId: string;
        notBeforeMs: number;
      } | null;
      retirement: RetiredGameplayEffects;
    };
export type AutomatchRecordMap = {
  automatch: AutomatchEntryRecord;
  telegramAutomatches: AutomatchTelegramSourceRecord;
  "telegramProjectionOutbox/automatch": AutomatchTelegramOutboxRecord;
  "profileGameProjectionOutbox/automatch": AutomatchProfileOutboxRecord;
  gameplayMutationReceipts: MutationReceiptRecord;
  gameplayMutationReceiptExpirations: MutationReceiptExpirationRecord;
};
export declare function isAutomatchReceiptRecord(
  value: unknown,
): value is AutomatchReceiptView;
export declare function isGameSessionMutationReceiptRecord(
  value: unknown,
): value is GameSessionMutationReceiptView;
export declare function isAutomatchTelegramOutboxRecord(
  value: unknown,
): value is AutomatchTelegramOutboxRecord;
export declare function isAutomatchProfileOutboxRecord(
  value: unknown,
): value is AutomatchProfileOutboxRecord;
export declare function parseAutomatchRecord<Root extends AutomatchRecordRoot>(
  root: Root,
  value: unknown,
): AutomatchRecordMap[Root] | null;
export declare function decodeAutomatchEntry(
  value: unknown,
): AutomatchEntryRead;
export declare function decodeAutomatchEntries(
  value: unknown,
): Record<string, AutomatchEntryRead> | null;
export {};
