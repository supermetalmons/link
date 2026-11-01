import { isCanonicalLoginUid, isSafeRecordKey } from "./ids.js";
import { isRematchSeries, type RematchSeries } from "./rematches.js";
import type { CONTROLLER_VERSION } from "./match-protocol.js";

export type InviteTransitionEvidence = {
  transitionId: string;
  sequence: number;
  digest: string;
};
export type InviteAutomatchMessage = {
  name: string;
  text: string;
  telegramMessageId: number;
};
type InviteFields = {
  schemaVersion: 1;
  version: typeof CONTROLLER_VERSION;
  hostId: string;
  guestId: string | null;
  hostColor: "white" | "black";
  hostRematches: RematchSeries;
  guestRematches: RematchSeries;
  sessionTransition: InviteTransitionEvidence | null;
  automatchMessage: InviteAutomatchMessage | null;
  automatchOperationIds: Record<string, string>;
};
type NonEventInvite = {
  eventOwned: false;
  eventId: null;
  eventRoundIndex: null;
  eventMatchKey: null;
};
export type ManualInviteDocument = InviteFields &
  NonEventInvite & {
    kind: "manual";
    password: null;
    automatchStateHint: null;
    automatchCanceledAt: null;
    telegramDeliveryVersion: null;
  };
export type AutomatchInviteDocument = InviteFields &
  NonEventInvite & {
    kind: "automatch";
    password: string;
    automatchStateHint: "pending" | "matched" | "canceled" | null;
    automatchCanceledAt: number | null;
    telegramDeliveryVersion: 2 | null;
  };
export type EventInviteDocument = InviteFields & {
  kind: "event";
  password: null;
  automatchStateHint: null;
  automatchCanceledAt: null;
  telegramDeliveryVersion: null;
  eventOwned: true;
  eventId: string;
  eventRoundIndex: number | null;
  eventMatchKey: string;
};
export type InviteDocument =
  ManualInviteDocument | AutomatchInviteDocument | EventInviteDocument;

const FIELDS = [
  "schemaVersion",
  "version",
  "kind",
  "hostId",
  "guestId",
  "hostColor",
  "hostRematches",
  "guestRematches",
  "sessionTransition",
  "automatchMessage",
  "automatchOperationIds",
  "password",
  "automatchStateHint",
  "automatchCanceledAt",
  "telegramDeliveryVersion",
  "eventOwned",
  "eventId",
  "eventRoundIndex",
  "eventMatchKey",
];
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (
  value: unknown,
  fields: readonly string[],
): value is Record<string, unknown> =>
  record(value) &&
  Object.keys(value).length === fields.length &&
  fields.every((field) => Object.hasOwn(value, field));
const key = (value: unknown): value is string =>
  typeof value === "string" && value.trim() === value && isSafeRecordKey(value);
const integer = (value: unknown, minimum = 0): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
const operationIds = (value: unknown): value is Record<string, string> =>
  record(value) &&
  Object.entries(value).every(
    ([uid, operation]) => isCanonicalLoginUid(uid) && key(operation),
  );

export function isInviteTransitionEvidence(
  value: unknown,
): value is InviteTransitionEvidence {
  return (
    exact(value, ["transitionId", "sequence", "digest"]) &&
    key(value.transitionId) &&
    integer(value.sequence) &&
    typeof value.digest === "string" &&
    /^[a-f0-9]{64}$/.test(value.digest)
  );
}
export function isInviteAutomatchMessage(
  value: unknown,
): value is InviteAutomatchMessage {
  return (
    exact(value, ["name", "text", "telegramMessageId"]) &&
    typeof value.name === "string" &&
    typeof value.text === "string" &&
    integer(value.telegramMessageId, 1)
  );
}

export function isInviteDocument(value: unknown): value is InviteDocument {
  if (
    !exact(value, FIELDS) ||
    value.schemaVersion !== 1 ||
    value.version !== 2 ||
    !isCanonicalLoginUid(value.hostId) ||
    !(
      value.guestId === null ||
      (isCanonicalLoginUid(value.guestId) && value.guestId !== value.hostId)
    ) ||
    (value.hostColor !== "white" && value.hostColor !== "black") ||
    !isRematchSeries(value.hostRematches) ||
    !isRematchSeries(value.guestRematches) ||
    !(
      value.sessionTransition === null ||
      isInviteTransitionEvidence(value.sessionTransition)
    ) ||
    !(
      value.automatchMessage === null ||
      isInviteAutomatchMessage(value.automatchMessage)
    ) ||
    !operationIds(value.automatchOperationIds)
  )
    return false;
  if (value.kind === "event")
    return (
      value.password === null &&
      value.automatchStateHint === null &&
      value.automatchCanceledAt === null &&
      value.telegramDeliveryVersion === null &&
      value.eventOwned === true &&
      key(value.eventId) &&
      (value.eventRoundIndex === null ||
        (integer(value.eventRoundIndex) && value.eventRoundIndex < 5)) &&
      key(value.eventMatchKey) &&
      value.guestId !== null &&
      value.automatchMessage === null &&
      Object.keys(value.automatchOperationIds).length === 0
    );
  if (
    value.eventOwned !== false ||
    value.eventId !== null ||
    value.eventRoundIndex !== null ||
    value.eventMatchKey !== null
  )
    return false;
  if (value.kind === "manual")
    return (
      value.password === null &&
      value.automatchStateHint === null &&
      value.automatchCanceledAt === null &&
      value.telegramDeliveryVersion === null &&
      value.automatchMessage === null &&
      Object.keys(value.automatchOperationIds).length === 0
    );
  return (
    value.kind === "automatch" &&
    typeof value.password === "string" &&
    value.password !== "" &&
    (value.automatchStateHint === null ||
      value.automatchStateHint === "pending" ||
      value.automatchStateHint === "matched" ||
      value.automatchStateHint === "canceled") &&
    (value.automatchCanceledAt === null ||
      integer(value.automatchCanceledAt)) &&
    (value.telegramDeliveryVersion === null ||
      value.telegramDeliveryVersion === 2) &&
    (value.automatchStateHint === "canceled"
      ? value.automatchCanceledAt !== null
      : value.automatchCanceledAt === null)
  );
}
export const readInviteDocument = (value: unknown): InviteDocument | null =>
  isInviteDocument(value) ? value : null;
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
  const invite = readInviteDocument(value);
  return invite === null
    ? { status: "invalid" }
    : {
        status: "ok",
        source: invite,
        hostId: invite.hostId,
        guestId: invite.guestId,
        passwordProtected: invite.password !== null,
      };
}
export function inviteMutationParticipants(value: InviteDocument) {
  return { hostId: value.hostId, guestId: value.guestId ?? "" };
}
export function inviteTrimmedParticipants(
  value: InviteDocument | null | undefined,
) {
  return { hostId: value?.hostId ?? "", guestId: value?.guestId ?? "" };
}
export function inviteRematchState(value: InviteDocument) {
  return {
    hostRematches: value.hostRematches,
    guestRematches: value.guestRematches,
    hostColor: value.hostColor,
  };
}
export type PresentationInviteView = Pick<
  InviteDocument,
  "hostId" | "guestId" | "hostRematches" | "guestRematches"
>;
export function presentationInviteView(
  value: Extract<InviteParticipantsRead, { status: "ok" }>,
): PresentationInviteView {
  return {
    hostId: value.hostId,
    guestId: value.guestId,
    hostRematches: value.source.hostRematches,
    guestRematches: value.source.guestRematches,
  };
}
export function inviteOpponent(
  value: InviteDocument | null,
  playerId: string,
): string | null {
  return value?.hostId === playerId
    ? value.guestId
    : value?.guestId === playerId
      ? value.hostId
      : null;
}
export function inviteIsEventOwned(
  value: InviteDocument | null | undefined,
): boolean {
  return value?.kind === "event";
}
export function inviteTimerEventId(
  value: InviteDocument | null,
): string | null {
  return value?.kind === "event" ? value.eventId : null;
}
export function inviteRatingEvent(value: InviteDocument | null) {
  return {
    isEventMatch: value?.kind === "event",
    eventOwned: value?.kind === "event",
    eventId: value?.eventId ?? null,
  };
}
export function inviteMatchesParticipants(
  value: InviteDocument | null,
  playerId: string,
  opponentId: string,
): boolean {
  return (
    value !== null &&
    ((value.hostId === playerId && value.guestId === opponentId) ||
      (value.hostId === opponentId && value.guestId === playerId))
  );
}
export function inviteProjectionState(value: InviteDocument | null) {
  return {
    hostId: value?.hostId ?? "",
    guestId: value?.guestId ?? "",
    automatchStateHint: value?.automatchStateHint ?? null,
    automatchCanceledAt: value?.automatchCanceledAt ?? null,
    telegramDeliveryVersion: value?.telegramDeliveryVersion ?? null,
  };
}
export function inviteSourceEventState(value: InviteDocument | null) {
  return {
    hostId: value?.hostId,
    guestId: value?.guestId ?? undefined,
    eventId: value?.eventId ?? undefined,
    eventOwned: value?.eventOwned ?? false,
  };
}
export function inviteTelegramFingerprint(
  source: unknown,
  value: InviteDocument | null,
): string {
  return JSON.stringify({ source, guestId: value?.guestId ?? null });
}

type InviteIdentityWrite = {
  version: typeof CONTROLLER_VERSION;
  hostId: string;
  hostColor: "white" | "black";
};
export type ManualInviteWrite = InviteIdentityWrite & { guestId: null };
export type PendingAutomatchInviteWrite = ManualInviteWrite & {
  password: string;
  automatchStateHint: "pending";
  automatchCanceledAt: null;
  automatchOperationIds: Record<string, string>;
  telegramDeliveryVersion: 2;
};
export type MatchedAutomatchInviteWrite = InviteIdentityWrite & {
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
  automatchCanceledAt?: number | null;
  telegramDeliveryVersion?: 2;
};

function base(value: InviteIdentityWrite) {
  return {
    schemaVersion: 1 as const,
    ...value,
    hostRematches: { state: "open" as const, indices: [] },
    guestRematches: { state: "open" as const, indices: [] },
    sessionTransition: null,
    automatchMessage: null,
    automatchOperationIds: {},
    password: null,
    automatchStateHint: null,
    automatchCanceledAt: null,
    telegramDeliveryVersion: null,
    eventOwned: false,
    eventId: null,
    eventRoundIndex: null,
    eventMatchKey: null,
  };
}
function requireInvite(value: unknown): InviteDocument {
  const invite = readInviteDocument(value);
  if (!invite) throw new TypeError("invalid-invite-document");
  return invite;
}
export const createManualInviteDocument = (
  value: ManualInviteWrite,
): InviteDocument =>
  requireInvite({ ...base(value), ...value, kind: "manual" });
export const createPendingAutomatchInviteDocument = (
  value: PendingAutomatchInviteWrite,
): InviteDocument =>
  requireInvite({ ...base(value), ...value, kind: "automatch" });
export const createMatchedAutomatchInviteDocument = (
  value: MatchedAutomatchInviteWrite,
): InviteDocument =>
  requireInvite({ ...base(value), ...value, kind: "automatch" });
export const createEventInviteDocument = (
  value: EventInviteWrite,
): InviteDocument => requireInvite({ ...base(value), ...value, kind: "event" });
export const createInviteFieldDocument = (
  value: InviteFieldChanges,
): InviteFieldChanges => structuredClone(value);
export function inviteHistoricalParticipants(value: InviteDocument) {
  return { hostId: value.hostId, guestId: value.guestId };
}
export function mergeInviteAutomatchOperation(
  value: InviteDocument,
  current: InviteDocument | null,
  uid: string,
  operationId: string,
): InviteDocument {
  if (
    value.kind !== "automatch" ||
    !isCanonicalLoginUid(uid) ||
    !key(operationId)
  )
    throw new TypeError("invalid-invite-operation");
  return {
    ...value,
    automatchOperationIds: {
      ...current?.automatchOperationIds,
      [uid]: operationId,
    },
  };
}
