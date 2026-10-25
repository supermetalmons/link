// Generated from src/shared/invite-records.ts. Run npm run generate:runtime.
import type { CONTROLLER_VERSION } from "./match-protocol.js";
declare const inviteDocument: unique symbol;
export type InviteDocument = {
  readonly [inviteDocument]: true;
};
export declare function readInviteDocument(
  value: unknown,
): InviteDocument | null;
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
  hostRematches: string | undefined;
  guestRematches: string | undefined;
  hostColor: "white" | "black";
};
export type PresentationInviteView = {
  hostId: string;
  guestId: string | null;
  hostRematches?: string;
  guestRematches?: string;
};
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
  automatchStateHint: string | null;
  automatchCanceledAt: number | null;
  telegramDeliveryVersion: number | null;
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
  automatchCanceledAt?:
    | number
    | {
        readonly ".sv": "timestamp";
      }
    | null;
  telegramDeliveryVersion?: number;
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
) => InviteDocument;
export declare function inviteHistoricalParticipants(value: InviteDocument): {
  hostId: string;
  guestId: string;
};
export declare function mergeInviteAutomatchOperation(
  value: InviteDocument,
  current: InviteDocument | null,
  uid: string,
  operationId: string,
): InviteDocument;
export declare function inviteRatingWager(
  value: InviteDocument,
  matchId: string,
): {
  material: string;
  count: number;
};
export {};
