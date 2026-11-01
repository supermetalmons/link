import {
  isAura,
  isEmojiId,
  type Aura,
  type EmojiId,
} from "./shared/appearance.js";
import { normalizeRecordKey } from "./shared/ids.js";
import {
  isCreateInviteResponse,
  isEndRematchResponse,
  isEnsureMatchResponse,
  isJoinInviteResponse,
  isProposeRematchResponse,
  type CreateInviteResponse,
  type EndRematchResponse,
  type EnsureMatchResponse,
  type JoinInviteResponse,
  type ProposeRematchResponse,
} from "./shared/game-sessions.js";
import {
  isStartAutomatchResponse,
  type StartAutomatchResponse,
} from "./shared/navigation.js";

export type AutomatchRecordRoot =
  | "automatch"
  | "telegramAutomatches"
  | "telegramProjectionOutbox/automatch"
  | "profileGameProjectionOutbox/automatch"
  | "gameplayMutationReceipts"
  | "gameplayMutationReceiptExpirations";
export type SessionTimestampOperation = { readonly kind: "timestamp" };
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
export type AutomatchTelegramResult = { completedAtMs: number; text: string };
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
export type RetiredGameplayEffects = {
  state: "retired";
  retiredAtMs: number;
  sourceDigest: string;
};
export type GameplayEffectsState =
  { state: "enabled" } | RetiredGameplayEffects;
export type SuccessfulStartAutomatchResponse = Extract<
  StartAutomatchResponse,
  { ok: true }
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
> & { completedAtMs: SessionTimestamp };
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
export type MutationReceiptRecord =
  AutomatchReceiptView | GameSessionMutationReceiptView;
export type MutationReceiptWrite =
  AutomatchReceiptWrite | GameSessionMutationReceiptWrite;
export type MutationReceiptExpirationRecord = {
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
      archiveRetry: { requestId: string; notBeforeMs: number } | null;
    }
  | {
      schemaVersion: 2;
      status: "cancelled";
      requestId: string;
      reason: string;
      sourceUpdatedAtMs: number;
      lastQueuedAtMs: number;
      historicalMatches: Record<string, HistoricalMatchDescriptorWrite>;
      archiveRetry: { requestId: string; notBeforeMs: number } | null;
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

function record(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}
function exact(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  return (
    record(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}
const integer = (value: unknown, minimum = 0): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
const key = (value: unknown): value is string =>
  typeof value === "string" && normalizeRecordKey(value) === value;
const nullableKey = (value: unknown): value is string | null =>
  value === null || key(value);
const text = (value: unknown): value is string => typeof value === "string";
const nullableText = (value: unknown): value is string | null =>
  value === null || text(value);
const digest = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
function map<T>(
  value: unknown,
  validate: (entry: unknown) => entry is T,
): value is Record<string, T> {
  return (
    record(value) &&
    Object.entries(value).every(([id, entry]) => key(id) && validate(entry))
  );
}
export function isAutomatchEntryRecord(
  value: unknown,
): value is AutomatchEntryRecord {
  return (
    exact(value, [
      "schemaVersion",
      "uid",
      "profileId",
      "timestamp",
      "rating",
      "hostColor",
      "password",
      "gameVariant",
      "telegramDeliveryVersion",
      "username",
      "ethAddress",
      "solAddress",
      "emojiId",
    ]) &&
    value.schemaVersion === 1 &&
    key(value.uid) &&
    nullableKey(value.profileId) &&
    integer(value.timestamp) &&
    typeof value.rating === "number" &&
    Number.isFinite(value.rating) &&
    value.rating >= 0 &&
    (value.hostColor === "white" || value.hostColor === "black") &&
    text(value.password) &&
    text(value.gameVariant) &&
    value.gameVariant !== "" &&
    (value.telegramDeliveryVersion === null ||
      value.telegramDeliveryVersion === 2) &&
    text(value.username) &&
    text(value.ethAddress) &&
    text(value.solAddress) &&
    isEmojiId(value.emojiId)
  );
}
export function isAutomatchTelegramSourceRecord(
  value: unknown,
): value is AutomatchTelegramSourceRecord {
  return (
    exact(value, [
      "schemaVersion",
      "version",
      "generation",
      "lifecycle",
      "waitingText",
      "canceledText",
      "waitingInstanceKey",
      "matchedText",
      "matchedInstanceKey",
      "createdAtMs",
      "updatedAtMs",
      "results",
    ]) &&
    value.schemaVersion === 1 &&
    value.version === 2 &&
    integer(value.generation, 1) &&
    ["pending", "matched", "canceled"].includes(String(value.lifecycle)) &&
    text(value.waitingText) &&
    text(value.canceledText) &&
    text(value.waitingInstanceKey) &&
    value.waitingInstanceKey !== "" &&
    nullableText(value.matchedText) &&
    nullableText(value.matchedInstanceKey) &&
    integer(value.createdAtMs) &&
    integer(value.updatedAtMs) &&
    value.updatedAtMs >= value.createdAtMs &&
    (value.lifecycle !== "matched" ||
      (typeof value.matchedText === "string" &&
        value.matchedText !== "" &&
        typeof value.matchedInstanceKey === "string" &&
        value.matchedInstanceKey !== "")) &&
    map(
      value.results,
      (entry): entry is AutomatchTelegramResult =>
        exact(entry, ["completedAtMs", "text"]) &&
        integer(entry.completedAtMs) &&
        text(entry.text) &&
        entry.text !== "",
    )
  );
}
export function isGameplayEffectsState(
  value: unknown,
): value is GameplayEffectsState {
  return exact(value, ["state"])
    ? value.state === "enabled"
    : exact(value, ["state", "retiredAtMs", "sourceDigest"]) &&
        value.state === "retired" &&
        integer(value.retiredAtMs) &&
        digest(value.sourceDigest);
}
export function isAutomatchReceiptRecord(
  value: unknown,
): value is AutomatchReceiptView {
  return (
    exact(value, [
      "schemaVersion",
      "kind",
      "aura",
      "completedAtMs",
      "emojiId",
      "inviteId",
      "operationId",
      "profileProjectionRequestId",
      "requesterUid",
      "response",
      "telegramProjection",
      "effects",
    ]) &&
    value.schemaVersion === 2 &&
    value.kind === "automatch-start" &&
    isAura(value.aura) &&
    isEmojiId(value.emojiId) &&
    integer(value.completedAtMs) &&
    key(value.inviteId) &&
    key(value.operationId) &&
    nullableKey(value.profileProjectionRequestId) &&
    key(value.requesterUid) &&
    isStartAutomatchResponse(value.response) &&
    value.response.ok &&
    value.response.inviteId === value.inviteId &&
    typeof value.telegramProjection === "boolean" &&
    isGameplayEffectsState(value.effects)
  );
}
export function isGameSessionMutationReceiptRecord(
  value: unknown,
): value is GameSessionMutationReceiptView {
  if (
    !exact(value, [
      "schemaVersion",
      "completedAtMs",
      "fingerprint",
      "inviteId",
      "operationId",
      "projectionRequestId",
      "requesterUid",
      "effects",
      "kind",
      "response",
    ]) ||
    value.schemaVersion !== 2 ||
    !integer(value.completedAtMs) ||
    !text(value.fingerprint) ||
    value.fingerprint === "" ||
    !key(value.inviteId) ||
    !key(value.operationId) ||
    !nullableKey(value.projectionRequestId) ||
    !key(value.requesterUid) ||
    !isGameplayEffectsState(value.effects)
  )
    return false;
  const response = value.response;
  const valid =
    value.kind === "invite-create"
      ? isCreateInviteResponse(response)
      : value.kind === "invite-join"
        ? isJoinInviteResponse(response)
        : value.kind === "match-ensure"
          ? isEnsureMatchResponse(response)
          : value.kind === "rematch-end"
            ? isEndRematchResponse(response)
            : value.kind === "rematch-propose"
              ? isProposeRematchResponse(response)
              : false;
  return valid && record(response) && response.inviteId === value.inviteId;
}
export function isMutationReceiptExpirationRecord(
  value: unknown,
): value is MutationReceiptExpirationRecord {
  return (
    exact(value, ["schemaVersion", "completedAtMs"]) &&
    value.schemaVersion === 1 &&
    integer(value.completedAtMs)
  );
}
export function isHistoricalMatchDescriptorWrite(
  value: unknown,
): value is HistoricalMatchDescriptorWrite {
  return (
    exact(value, [
      "finalizedAtMs",
      "guestPlayerId",
      "hostPlayerId",
      "retryNotBeforeMs",
      "source",
    ]) &&
    integer(value.finalizedAtMs) &&
    key(value.guestPlayerId) &&
    key(value.hostPlayerId) &&
    value.guestPlayerId !== value.hostPlayerId &&
    (value.retryNotBeforeMs === null || integer(value.retryNotBeforeMs)) &&
    ["backfill", "rating", "transition"].includes(String(value.source))
  );
}
export function isAutomatchTelegramOutboxRecord(
  value: unknown,
): value is AutomatchTelegramOutboxRecord {
  if (!record(value) || value.schemaVersion !== 2 || !key(value.requestId))
    return false;
  if (value.status === "pending")
    return (
      exact(value, ["schemaVersion", "status", "requestId", "updatedAtMs"]) &&
      integer(value.updatedAtMs)
    );
  if (value.status === "dead")
    return (
      exact(value, [
        "schemaVersion",
        "status",
        "requestId",
        "updatedAtMs",
        "deadAtMs",
        "reason",
      ]) &&
      value.updatedAtMs === null &&
      integer(value.deadAtMs) &&
      text(value.reason) &&
      value.reason !== ""
    );
  return (
    exact(value, [
      "schemaVersion",
      "status",
      "requestId",
      "updatedAtMs",
      "sourceUpdatedAtMs",
      "retirement",
    ]) &&
    value.status === "cancelled" &&
    value.updatedAtMs === null &&
    integer(value.sourceUpdatedAtMs) &&
    isGameplayEffectsState(value.retirement) &&
    value.retirement.state === "retired"
  );
}
export function isAutomatchProfileOutboxRecord(
  value: unknown,
): value is AutomatchProfileOutboxRecord {
  if (
    !record(value) ||
    value.schemaVersion !== 2 ||
    !key(value.requestId) ||
    !text(value.reason) ||
    value.reason === "" ||
    !integer(value.sourceUpdatedAtMs) ||
    !integer(value.lastQueuedAtMs) ||
    !map(value.historicalMatches, isHistoricalMatchDescriptorWrite)
  )
    return false;
  const base = [
    "schemaVersion",
    "status",
    "requestId",
    "reason",
    "sourceUpdatedAtMs",
    "lastQueuedAtMs",
    "historicalMatches",
    "archiveRetry",
  ];
  if (!(
    value.archiveRetry === null ||
    (exact(value.archiveRetry, ["requestId", "notBeforeMs"]) &&
      value.archiveRetry.requestId === value.requestId &&
      integer(value.archiveRetry.notBeforeMs))
  ))
    return false;
  if (value.status === "pending") return exact(value, base);
  return (
    exact(value, [...base, "retirement"]) &&
    value.status === "cancelled" &&
    isGameplayEffectsState(value.retirement) &&
    value.retirement.state === "retired"
  );
}
export function parseAutomatchRecord<Root extends AutomatchRecordRoot>(
  root: Root,
  value: unknown,
): AutomatchRecordMap[Root] | null {
  if (value === null) return null;
  const valid =
    root === "automatch"
      ? isAutomatchEntryRecord(value)
      : root === "telegramAutomatches"
        ? isAutomatchTelegramSourceRecord(value)
        : root === "telegramProjectionOutbox/automatch"
          ? isAutomatchTelegramOutboxRecord(value)
          : root === "profileGameProjectionOutbox/automatch"
            ? isAutomatchProfileOutboxRecord(value)
            : root === "gameplayMutationReceipts"
              ? isAutomatchReceiptRecord(value) ||
                isGameSessionMutationReceiptRecord(value)
              : isMutationReceiptExpirationRecord(value);
  if (!valid) throw new TypeError(`invalid-canonical-${root}`);
  return value as AutomatchRecordMap[Root];
}
export function decodeAutomatchEntry(value: unknown): AutomatchEntryRead {
  return parseAutomatchRecord("automatch", value);
}
export function decodeAutomatchEntries(
  value: unknown,
): Record<string, AutomatchEntryRead> | null {
  if (value === null) return null;
  if (!record(value) || !Object.keys(value).every(key))
    throw new TypeError("invalid-canonical-automatch-entries");
  return Object.fromEntries(
    Object.entries(value).map(([id, entry]) => [
      id,
      decodeAutomatchEntry(entry),
    ]),
  );
}
