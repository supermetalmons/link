// Generated from src/shared/invite-records.ts. Run npm run generate:runtime.
import { type RematchSeries } from "./rematches.js";
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
export declare function isInviteTransitionEvidence(
  value: unknown,
): value is InviteTransitionEvidence;
export declare function isInviteAutomatchMessage(
  value: unknown,
): value is InviteAutomatchMessage;
export declare function isInviteDocument(
  value: unknown,
): value is InviteDocument;
export declare const readInviteDocument: (
  value: unknown,
) => InviteDocument | null;
export type InviteParticipantsRead =
  | {
      status: "missing";
    }
  | {
      status: "invalid";
    }
  | {
      status: "ok";
      source: InviteDocument;
      hostId: string;
      guestId: string | null;
      passwordProtected: boolean;
    };
export declare function readCanonicalInviteParticipants(
  value: unknown,
): InviteParticipantsRead;
export declare function inviteMutationParticipants(value: InviteDocument): {
  hostId: string;
  guestId: string;
};
export declare function inviteTrimmedParticipants(
  value: InviteDocument | null | undefined,
): {
  hostId: string;
  guestId: string;
};
export declare function inviteRematchState(value: InviteDocument): {
  hostRematches: RematchSeries;
  guestRematches: RematchSeries;
  hostColor: "white" | "black";
};
export type PresentationInviteView = Pick<
  InviteDocument,
  "hostId" | "guestId" | "hostRematches" | "guestRematches"
>;
export declare function presentationInviteView(
  value: Extract<
    InviteParticipantsRead,
    {
      status: "ok";
    }
  >,
): PresentationInviteView;
export declare function inviteOpponent(
  value: InviteDocument | null,
  playerId: string,
): string | null;
export declare function inviteIsEventOwned(
  value: InviteDocument | null | undefined,
): boolean;
export declare function inviteTimerEventId(
  value: InviteDocument | null,
): string | null;
export declare function inviteRatingEvent(value: InviteDocument | null): {
  isEventMatch: boolean;
  eventOwned: boolean;
  eventId: string | null;
};
export declare function inviteMatchesParticipants(
  value: InviteDocument | null,
  playerId: string,
  opponentId: string,
): boolean;
export declare function inviteProjectionState(value: InviteDocument | null): {
  hostId: string;
  guestId: string;
  automatchStateHint: "pending" | "matched" | "canceled" | null;
  automatchCanceledAt: number | null;
  telegramDeliveryVersion: 2 | null;
};
export declare function inviteSourceEventState(value: InviteDocument | null): {
  hostId: string | undefined;
  guestId: string | undefined;
  eventId: string | undefined;
  eventOwned: boolean;
};
export declare function inviteTelegramFingerprint(
  source: unknown,
  value: InviteDocument | null,
): string;
type InviteIdentityWrite = {
  version: typeof CONTROLLER_VERSION;
  hostId: string;
  hostColor: "white" | "black";
};
export type ManualInviteWrite = InviteIdentityWrite & {
  guestId: null;
};
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
export declare const createManualInviteDocument: (
  value: ManualInviteWrite,
) => InviteDocument;
export declare const createPendingAutomatchInviteDocument: (
  value: PendingAutomatchInviteWrite,
) => InviteDocument;
export declare const createMatchedAutomatchInviteDocument: (
  value: MatchedAutomatchInviteWrite,
) => InviteDocument;
export declare const createEventInviteDocument: (
  value: EventInviteWrite,
) => InviteDocument;
export declare const createInviteFieldDocument: (
  value: InviteFieldChanges,
) => InviteFieldChanges;
export declare function inviteHistoricalParticipants(value: InviteDocument): {
  hostId: string;
  guestId: string | null;
};
export declare function mergeInviteAutomatchOperation(
  value: InviteDocument,
  current: InviteDocument | null,
  uid: string,
  operationId: string,
): InviteDocument;
export {};
