// Generated from src/eventProfileGameProjectionCore.ts. Run npm run generate:runtime.
import type { EventData } from "./events/model.js";
export type EventProjectionWrite = {
  type: "delete" | "merge";
  profileId: string;
  eventId: string;
  data?: Record<string, unknown>;
};
export type EventProjectionSourceFence = {
  eventId: string;
  generation: number;
};
export type EventProjectionOwnershipSnapshot = Readonly<{
  canonicalProfileIdByProfileId: ReadonlyMap<string, string | null>;
  loginOwnerByUid: ReadonlyMap<
    string,
    Readonly<{
      profileId: string;
      revision: number;
    }> | null
  >;
}>;
export type EventProfileGameProjectionRepository = {
  commitProjectionWrites(
    writes: EventProjectionWrite[],
    sourceFence?: EventProjectionSourceFence,
  ): Promise<void>;
  getEvent(eventId: string): Promise<EventData | null>;
  readProfileOwnershipSnapshot(query: {
    loginUids: string[];
    profileIds: string[];
  }): Promise<EventProjectionOwnershipSnapshot>;
};
export type EventProjectionResult = {
  deleted: number;
  ownerProfileIds: string[];
  written: number;
};
export type EventProjectionCommitOptions = {
  assertCanCommit?(): Promise<void>;
  sourceFence?: EventProjectionSourceFence;
};
type Signature_createEventProfileGameProjectionCore = (dependencies: {
  now?: () => number;
  prepareEventProjection?(eventId: string, event: EventData): Promise<void>;
  repository: EventProfileGameProjectionRepository;
  wait?(milliseconds: number): Promise<void>;
}) => {
  projectEvent(
    eventId: string,
    eventData: EventData | null,
    cleanupOwnerProfileIds?: string[],
    options?: EventProjectionCommitOptions,
  ): Promise<EventProjectionResult>;
  reconcileEventProjection(
    eventId: string,
    cleanupOwnerProfileIds?: string[],
    options?: EventProjectionCommitOptions,
  ): Promise<
    EventProjectionResult & {
      status: "missing" | "projected";
    }
  >;
};
declare const READ_RETRY_ATTEMPTS = 2;
declare const READ_RETRY_DELAY_MS = 25;
declare const createEventProfileGameProjectionCore: Signature_createEventProfileGameProjectionCore;
export {
  READ_RETRY_ATTEMPTS,
  READ_RETRY_DELAY_MS,
  createEventProfileGameProjectionCore,
};
