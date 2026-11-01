import type { EventEffect, EventMutation } from "./eventCommands.js";
import type { EventInviteDocument } from "./shared/invite-records.js";

export type EventIntentUpdates = EventMutation[];
export type EventIntentEffects = EventEffect[];
export type EventInviteSourceMutation = {
  current: {
    inviteId: string;
    revision: number;
    value: EventInviteDocument | null;
  };
  value: EventInviteDocument;
};
export type EventTransitionDraftInput = {
  schemaVersion: 3;
  canonicalUpdates: EventIntentUpdates;
  createdAtMs: number;
  eventId: string;
  expectedRevision: number;
  effects: EventIntentEffects;
  transitionId: string;
  updatedAtMs: number;
};
export type EventTransitionIntent = EventTransitionDraftInput & {
  sourceEpoch: number;
  payloadDigest: string;
  operationDigest: string;
  inviteMutations: EventInviteSourceMutation[];
};
