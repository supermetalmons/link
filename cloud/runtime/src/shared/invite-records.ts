import { isCanonicalLoginUid, isSafeRecordKey } from "./ids.js";
import type { CONTROLLER_VERSION } from "./match-protocol.js";

declare const inviteDocument: unique symbol;

export type InviteDocument = { readonly [inviteDocument]: true };

type InviteFields = {
  hostId?: unknown;
  guestId?: unknown;
  hostColor?: unknown;
  hostRematches?: unknown;
  guestRematches?: unknown;
  eventOwned?: unknown;
  eventId?: unknown;
  automatchStateHint?: unknown;
  automatchCanceledAt?: unknown;
  telegramDeliveryVersion?: unknown;
  automatchOperationIds?: unknown;
  wagers?: unknown;
};

const fields = (value: InviteDocument | null | undefined): InviteFields =>
  (value ?? {}) as InviteFields;
const string = (value: unknown): string =>
  typeof value === "string" ? value : "";

export function readInviteDocument(value: unknown): InviteDocument | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as InviteDocument)
    : null;
}

export type InviteParticipantsRead =
  | { status: "missing" }
  | { status: "invalid" }
  | {
      status: "ok";
      source: InviteDocument;
      hostId: string;
      guestId: string | null;
      passwordProtected: boolean;
    };

export function readCanonicalInviteParticipants(
  value: unknown,
): InviteParticipantsRead {
  if (value === null || value === undefined) return { status: "missing" };
  const source = readInviteDocument(value);
  if (!source) return { status: "invalid" };
  const invite = fields(source);
  const hostId = invite.hostId;
  const guestId = invite.guestId ?? null;
  if (
    !isCanonicalLoginUid(hostId) ||
    (guestId !== null && (!isCanonicalLoginUid(guestId) || guestId === hostId))
  ) {
    return { status: "invalid" };
  }
  return {
    status: "ok",
    source,
    hostId,
    guestId,
    passwordProtected: Object.hasOwn(source, "password"),
  };
}

export function inviteMutationParticipants(value: InviteDocument) {
  const invite = fields(value);
  return { hostId: string(invite.hostId), guestId: string(invite.guestId) };
}

export function inviteTrimmedParticipants(
  value: InviteDocument | null | undefined,
) {
  const invite = fields(value);
  return {
    hostId: string(invite.hostId).trim(),
    guestId: string(invite.guestId).trim(),
  };
}

export function inviteRematchState(value: InviteDocument) {
  const invite = fields(value);
  return {
    hostRematches:
      typeof invite.hostRematches === "string"
        ? invite.hostRematches
        : undefined,
    guestRematches:
      typeof invite.guestRematches === "string"
        ? invite.guestRematches
        : undefined,
    hostColor:
      invite.hostColor === "black" ? ("black" as const) : ("white" as const),
  };
}

export type PresentationInviteView = {
  hostId: string;
  guestId: string | null;
  hostRematches?: string;
  guestRematches?: string;
};

export function presentationInviteView(
  value: Extract<InviteParticipantsRead, { status: "ok" }>,
): PresentationInviteView {
  const rematches = inviteRematchState(value.source);
  return {
    ...value.source,
    hostId: value.hostId,
    guestId: value.guestId,
    hostRematches: rematches.hostRematches,
    guestRematches: rematches.guestRematches,
  };
}

export function inviteOpponent(
  value: InviteDocument | null,
  playerId: string,
): string | null {
  const invite = fields(value);
  const opponentId =
    invite.hostId === playerId
      ? invite.guestId
      : invite.guestId === playerId
        ? invite.hostId
        : null;
  return typeof opponentId === "string" ? opponentId : null;
}

export function inviteIsEventOwned(
  value: InviteDocument | null | undefined,
): boolean {
  const invite = fields(value);
  return (
    invite.eventOwned === true ||
    (typeof invite.eventId === "string" && invite.eventId.trim() !== "")
  );
}

export function inviteTimerEventId(
  value: InviteDocument | null,
): string | null {
  const invite = fields(value);
  return invite.eventOwned === true && typeof invite.eventId === "string"
    ? invite.eventId
    : null;
}

export function inviteRatingEvent(value: InviteDocument | null) {
  const invite = fields(value);
  const eventId =
    typeof invite.eventId === "string" && invite.eventId.trim() !== ""
      ? invite.eventId.trim()
      : null;
  return {
    isEventMatch: invite.eventOwned === true || eventId !== null,
    eventOwned: invite.eventOwned === true,
    eventId,
  };
}

export function inviteMatchesParticipants(
  value: InviteDocument | null,
  playerId: string,
  opponentId: string,
): boolean {
  if (!value) return false;
  const invite = fields(value);
  return (
    (invite.hostId === playerId && invite.guestId === opponentId) ||
    (invite.hostId === opponentId && invite.guestId === playerId)
  );
}

export function inviteProjectionState(value: InviteDocument | null) {
  const invite = fields(value);
  return {
    hostId: string(invite.hostId),
    guestId: string(invite.guestId),
    automatchStateHint:
      typeof invite.automatchStateHint === "string"
        ? invite.automatchStateHint
        : null,
    automatchCanceledAt:
      typeof invite.automatchCanceledAt === "number"
        ? invite.automatchCanceledAt
        : null,
    telegramDeliveryVersion: invite.telegramDeliveryVersion === 2 ? 2 : null,
  };
}

export function inviteSourceEventState(value: InviteDocument | null) {
  const invite = fields(value);
  return {
    hostId: typeof invite.hostId === "string" ? invite.hostId : undefined,
    guestId: typeof invite.guestId === "string" ? invite.guestId : undefined,
    eventId: typeof invite.eventId === "string" ? invite.eventId : undefined,
    eventOwned: invite.eventOwned === true,
  };
}

export function inviteTelegramFingerprint(
  source: unknown,
  value: InviteDocument | null,
): string {
  return JSON.stringify({ source, guestId: fields(value).guestId || null });
}

type InviteIdentityWrite = {
  version: typeof CONTROLLER_VERSION;
  hostId: string;
  hostColor: "white" | "black";
};

export type ManualInviteWrite = InviteIdentityWrite & { guestId: null };

export type PendingAutomatchInviteWrite = ManualInviteWrite & {
  guestId: null;
  password: string;
  automatchStateHint: "pending";
  automatchCanceledAt: null;
  automatchOperationIds: Record<string, string>;
  telegramDeliveryVersion: 2;
};

export type MatchedAutomatchInviteWrite = {
  version: typeof CONTROLLER_VERSION;
  hostId: string;
  hostColor: string;
  guestId: string;
  password: string;
  automatchStateHint: "matched";
  automatchCanceledAt: null;
  automatchOperationIds: Record<string, string>;
  telegramDeliveryVersion?: 2;
};

export type EventInviteWrite = InviteIdentityWrite & {
  guestId: string;
  eventId: string;
  eventRoundIndex: number | null;
  eventMatchKey: string;
  eventOwned: true;
};

export type InviteFieldChanges = {
  guestId?: string | null;
  hostId?: string;
  hostColor?: "white" | "black";
  password?: string;
  automatchStateHint?: "pending" | "matched" | "canceled";
  automatchCanceledAt?: number | { readonly ".sv": "timestamp" } | null;
  telegramDeliveryVersion?: number;
};

export const createManualInviteDocument = (
  value: ManualInviteWrite,
): InviteDocument => readInviteDocument(value)!;
export const createPendingAutomatchInviteDocument = (
  value: PendingAutomatchInviteWrite,
): InviteDocument => readInviteDocument(value)!;
export const createMatchedAutomatchInviteDocument = (
  value: MatchedAutomatchInviteWrite,
): InviteDocument => readInviteDocument(value)!;
export const createEventInviteDocument = (
  value: EventInviteWrite,
): InviteDocument => readInviteDocument(value)!;
export const createInviteFieldDocument = (
  value: InviteFieldChanges,
): InviteDocument => readInviteDocument(value)!;

export function inviteHistoricalParticipants(value: InviteDocument) {
  const invite = fields(value);
  return { hostId: String(invite.hostId), guestId: String(invite.guestId) };
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function mergeInviteAutomatchOperation(
  value: InviteDocument,
  current: InviteDocument | null,
  uid: string,
  operationId: string,
): InviteDocument {
  const operationIds = record(fields(current).automatchOperationIds);
  const valid: [string, string][] = [];
  for (const [ownerUid, storedOperationId] of Object.entries(
    operationIds || {},
  )) {
    if (
      isSafeRecordKey(ownerUid) &&
      typeof storedOperationId === "string" &&
      isSafeRecordKey(storedOperationId)
    ) {
      valid.push([ownerUid, storedOperationId]);
    }
  }
  return readInviteDocument({
    ...value,
    automatchOperationIds: { ...Object.fromEntries(valid), [uid]: operationId },
  })!;
}

export function inviteRatingWager(value: InviteDocument, matchId: string) {
  const wagers = record(fields(value).wagers);
  const wager = record(wagers?.[matchId]);
  const agreed = record(wager?.agreed);
  return {
    material:
      typeof agreed?.material === "string" ? agreed.material.trim() : "",
    count: Number(agreed?.count),
  };
}
