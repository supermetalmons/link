export type SessionTimestamp = number | { readonly ".sv": "timestamp" };
export type SessionCounter = number | { readonly ".sv": { increment: number } };
export type InviteFieldChanges = {
  guestId?: string | null;
  hostId?: string;
  hostColor?: "white" | "black";
  password?: string;
  automatchStateHint?: "pending" | "matched" | "canceled";
  automatchCanceledAt?: SessionTimestamp | null;
  telegramDeliveryVersion?: number;
};
export type TelegramSourceChanges = {
  lifecycle?: "pending" | "matched" | "canceled";
  matchedText?: string;
  matchedInstanceKey?: string;
  updatedAtMs?: SessionTimestamp;
  generation?: SessionCounter;
};
export type TelegramProjectionRequest = {
  schemaVersion: number;
  status: "pending";
  requestId: string;
  updatedAtMs: SessionTimestamp;
};
export type ProfileProjectionRequest = {
  schemaVersion: number;
  status: "pending";
  requestId: string;
  reason: string;
  sourceUpdatedAtMs: SessionTimestamp;
  lastQueuedAtMs: SessionTimestamp;
};
export type SessionRecord = Record<string, unknown>;
export type GameSessionChange =
  | { kind: "invite-merge"; inviteId: string; value: SessionRecord }
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
      value: SessionRecord;
    }
  | { kind: "automatch-entry"; inviteId: string; value: SessionRecord | null }
  | { kind: "telegram-source"; inviteId: string; value: SessionRecord }
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
      historicalMatches?: Record<string, SessionRecord>;
    }
  | {
      kind: "mutation-receipt";
      operationId: string;
      value: SessionRecord;
      expiration: SessionRecord;
    };
