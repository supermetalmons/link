import type {
  CreateInviteResponse,
  EndRematchResponse,
  EnsureMatchResponse,
  JoinInviteResponse,
  ProposeRematchResponse,
} from "./shared/game-sessions.js";
import type { StartAutomatchResponse } from "./shared/navigation.js";

export type AutomatchRecordRoot =
  | "automatch"
  | "telegramAutomatches"
  | "telegramProjectionOutbox/automatch"
  | "profileGameProjectionOutbox/automatch"
  | "gameplayMutationReceipts"
  | "gameplayMutationReceiptExpirations";

declare const retainedAutomatchRecord: unique symbol;
export type RetainedAutomatchValue<Root extends AutomatchRecordRoot> = {
  readonly [retainedAutomatchRecord]: Root;
};

export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type SessionTimestamp = number | { readonly ".sv": "timestamp" };
export type SessionCounter = number | { readonly ".sv": { increment: number } };

export type AutomatchEntryFields = {
  uid: string;
  timestamp: number;
  numericTimestamp: number | null;
  rating: number;
  hostColor: string;
  password: string;
  gameVariant: string;
  telegramDeliveryVersion: 2 | null;
  display: {
    username?: JsonValue;
    ethAddress?: JsonValue;
    solAddress?: JsonValue;
    rating?: JsonValue;
    emojiId?: JsonValue;
  };
};

export type AutomatchEntryRead = {
  isNull: boolean;
  isTruthy: boolean;
  record: AutomatchEntryFields | null;
};

export type AutomatchEntryWrite = {
  uid: string;
  rating: number;
  timestamp: SessionTimestamp;
  username: string;
  ethAddress: string;
  solAddress: string;
  profileId: string;
  hostColor: "white" | "black";
  password: string;
  emojiId: number | string;
  gameVariant: string;
  telegramDeliveryVersion: 2;
};

export type AutomatchTelegramSourceWrite = {
  version: 2;
  generation: number;
  lifecycle: "pending";
  waitingText: string;
  canceledText: string;
  waitingInstanceKey: string;
  createdAtMs: SessionTimestamp;
  updatedAtMs: SessionTimestamp;
};

export type SuccessfulStartAutomatchResponse = Extract<
  StartAutomatchResponse,
  { ok: true }
>;

export type AutomatchReceiptView = {
  aura: string;
  completedAtMs: number;
  emojiId: number;
  inviteId: string;
  kind: "automatch-start";
  operationId: string;
  profileProjectionRequestId: string | null;
  requesterUid: string;
  response: SuccessfulStartAutomatchResponse;
  schemaVersion: 1;
  telegramProjection: boolean;
};

export type AutomatchReceiptWrite = Omit<
  AutomatchReceiptView,
  "completedAtMs"
> & { completedAtMs: SessionTimestamp };

export type GameSessionMutationKind =
  | "invite-create"
  | "invite-join"
  | "match-ensure"
  | "rematch-end"
  | "rematch-propose";

export type GameSessionResponse =
  | CreateInviteResponse
  | EndRematchResponse
  | EnsureMatchResponse
  | JoinInviteResponse
  | ProposeRematchResponse;

export type GameSessionMutationReceiptView = {
  completedAtMs: number;
  fingerprint: string;
  inviteId: string;
  kind: string;
  operationId: string;
  projectionRequestId: string | null;
  requesterUid: string;
  response: GameSessionResponse;
  schemaVersion: 1;
};

type ResponseKeys<Response> = Response extends unknown ? keyof Response : never;
type ReceiptResponse<Response> = Response & {
  [Key in Exclude<ResponseKeys<GameSessionResponse>, keyof Response>]?: never;
};

export type GameSessionMutationResponseMap = {
  "invite-create": ReceiptResponse<CreateInviteResponse>;
  "invite-join": ReceiptResponse<JoinInviteResponse>;
  "match-ensure": ReceiptResponse<EnsureMatchResponse>;
  "rematch-end": ReceiptResponse<EndRematchResponse>;
  "rematch-propose": ReceiptResponse<ProposeRematchResponse>;
};

export type GameSessionMutationReceiptWrite<
  Kind extends GameSessionMutationKind = GameSessionMutationKind,
> = {
  [Key in Kind]: Omit<
    GameSessionMutationReceiptView,
    "completedAtMs" | "kind" | "response"
  > & {
    completedAtMs: SessionTimestamp;
    kind: Key;
    response: GameSessionMutationResponseMap[Key];
  };
}[Kind];

export type MutationReceiptWrite =
  AutomatchReceiptWrite | GameSessionMutationReceiptWrite;

export type MutationReceiptExpirationWrite = {
  completedAtMs: SessionTimestamp;
  schemaVersion?: never;
  kind?: never;
  response?: never;
};

export type HistoricalMatchDescriptorWrite = {
  finalizedAtMs: number;
  guestPlayerId: string;
  hostPlayerId: string;
  retryNotBeforeMs?: number;
  source: "backfill" | "rating" | "transition";
};

function storedString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function finiteNumber(value: unknown): number {
  const parsed =
    typeof value === "number" || typeof value === "string" ? Number(value) : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}

export function emptyAutomatchEntryFields(): AutomatchEntryFields {
  return {
    uid: "",
    timestamp: 0,
    numericTimestamp: null,
    rating: 0,
    hostColor: "",
    password: "",
    gameVariant: "",
    telegramDeliveryVersion: null,
    display: {},
  };
}

export function decodeAutomatchEntry(value: unknown): AutomatchEntryRead {
  const result: AutomatchEntryRead = {
    isNull: value === null,
    isTruthy: Boolean(value),
    record: null,
  };
  if (!value || typeof value !== "object" || Array.isArray(value))
    return result;
  const entry = value as Record<string, JsonValue | undefined>;
  result.record = {
    uid: storedString(entry.uid),
    timestamp: finiteNumber(entry.timestamp),
    numericTimestamp:
      typeof entry.timestamp === "number" && Number.isFinite(entry.timestamp)
        ? entry.timestamp
        : null,
    rating: finiteNumber(entry.rating),
    hostColor: storedString(entry.hostColor),
    password: storedString(entry.password),
    gameVariant: storedString(entry.gameVariant),
    telegramDeliveryVersion: entry.telegramDeliveryVersion === 2 ? 2 : null,
    display: {
      username: entry.username,
      ethAddress: entry.ethAddress,
      solAddress: entry.solAddress,
      rating: entry.rating,
      emojiId: entry.emojiId,
    },
  };
  return result;
}

export function decodeAutomatchEntries(
  value: unknown,
): Record<string, AutomatchEntryRead> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return Object.fromEntries(
    Object.entries(value).map(([inviteId, entry]) => [
      inviteId,
      decodeAutomatchEntry(entry),
    ]),
  );
}
