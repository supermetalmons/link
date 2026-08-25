export type EventRuntimeCode =
  | "aborted"
  | "failed-precondition"
  | "invalid-argument"
  | "not-found"
  | "permission-denied"
  | "unauthenticated"
  | "unavailable";

export class EventRuntimeError extends Error {
  code: EventRuntimeCode;
  constructor(code: EventRuntimeCode, message: string);
}

export type EventRuntimeRequest = {
  auth: {
    uid: string;
    token?: { profileId?: string };
  } | null;
  data: Record<string, unknown>;
};

export type EventProgressOutboxRecord = {
  schemaVersion: 1;
  eventId: string;
  sourceKey: string;
  reason: string;
  runAtMs: number | null;
  firstQueuedAtMs: number;
  lastQueuedAtMs: number;
};

export type EventRuntime = {
  createEvent(request: EventRuntimeRequest): Promise<Record<string, unknown>>;
  disqualifyEventMatchWinners(
    request: EventRuntimeRequest,
  ): Promise<Record<string, unknown>>;
  postponeEventStart(
    request: EventRuntimeRequest,
  ): Promise<Record<string, unknown>>;
  runEventSyncState(input: {
    eventId: string;
    requesterUid: string;
    auth: EventRuntimeRequest["auth"];
    enforceParticipantGate: boolean;
    enforceThrottle: boolean;
    syncLog: Record<string, unknown>;
  }): Promise<Record<string, unknown>>;
  syncEventState(
    request: EventRuntimeRequest,
  ): Promise<Record<string, unknown>>;
};

export function createEventRuntime(dependencies: {
  admin: {
    database(): {
      ref(path?: string): {
        once(event: "value"): Promise<{ exists(): boolean; val(): unknown }>;
        remove(): Promise<void>;
        set(value: unknown): Promise<void>;
        transaction(
          updater: (current: unknown) => unknown,
          onComplete?: unknown,
          applyLocally?: boolean,
        ): Promise<{ committed: boolean }>;
        update(updates: Record<string, unknown>): Promise<void>;
      };
    };
  };
  enqueueEventProgressTask(input: {
    eventId: string;
    sourceKey: string;
    reason: string;
    scheduleTimeMs?: number;
  }): Promise<{ outboxId: string; outbox: EventProgressOutboxRecord }>;
  eventLockManager: {
    acquireEventLockWithRetry(
      eventId: string,
      ownerUid: string,
      options: { attempts: number; delayMs: number },
    ): Promise<Record<string, unknown> | null>;
    isEventLockStillOwned(handle: Record<string, unknown>): Promise<boolean>;
    releaseEventLock(handle: Record<string, unknown>): Promise<boolean>;
    startEventLockHeartbeat(handle: Record<string, unknown>): () => void;
  };
  getProfileByLoginId(uid: string): Promise<Record<string, unknown>>;
  now?: () => number;
  random: () => number;
  sleep(milliseconds: number): Promise<void>;
}): EventRuntime;
