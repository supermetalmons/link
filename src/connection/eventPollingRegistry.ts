import type { ProfileEventPrizesResponse } from "@mons/shared/event-prizes";
import type { EventSnapshotResponse } from "@mons/shared/events";
import type {
  ConditionalRead,
  ConditionalReadOptions,
} from "../services/gameplayApi";

export const EVENT_POLL_INTERVAL_MS = 2_000;
export const EVENT_POLL_BACKOFF_MS = [
  2_000, 4_000, 8_000, 16_000, 30_000,
] as const;

type TimerHandle = ReturnType<typeof setTimeout>;

type PollingSubscriber<T> = {
  onError?: (error: unknown) => void;
  onUpdate: (value: T) => void;
};

type PollingEntry<T> = {
  abortController: AbortController | null;
  bookmark: string | null;
  consecutiveFailures: number;
  etag: string | null;
  lastError: unknown;
  lastResponse: T | null;
  lifecycleToken: object;
  load: (options: ConditionalReadOptions) => Promise<ConditionalRead<T>>;
  refreshQueued: boolean;
  subscribers: Set<PollingSubscriber<T>>;
  timer: TimerHandle | null;
};

type EventPollingRegistryDependencies = {
  addVisibilityListener: (listener: () => void) => () => void;
  clearTimer: (timer: TimerHandle) => void;
  isVisible: () => boolean;
  loadEvent: (
    eventId: string,
    options: ConditionalReadOptions,
  ) => Promise<ConditionalRead<EventSnapshotResponse>>;
  loadProfilePrizes: (
    profileId: string,
    options: ConditionalReadOptions,
  ) => Promise<ConditionalRead<ProfileEventPrizesResponse>>;
  onEventIdle?: (eventId: string) => void;
  setTimer: (callback: () => void, delayMs: number) => TimerHandle;
  backoffMs?: readonly number[];
  intervalMs?: number;
};

export class EventPollingRegistry {
  private readonly backoffMs: readonly number[];
  private readonly dependencies: EventPollingRegistryDependencies;
  private readonly eventEntries = new Map<
    string,
    PollingEntry<EventSnapshotResponse>
  >();
  private readonly intervalMs: number;
  private readonly profilePrizeEntries = new Map<
    string,
    PollingEntry<ProfileEventPrizesResponse>
  >();
  private removeVisibilityListener: (() => void) | null = null;

  constructor(dependencies: EventPollingRegistryDependencies) {
    this.dependencies = dependencies;
    this.intervalMs = dependencies.intervalMs ?? EVENT_POLL_INTERVAL_MS;
    this.backoffMs = dependencies.backoffMs ?? EVENT_POLL_BACKOFF_MS;
    if (
      !Number.isFinite(this.intervalMs) ||
      this.intervalMs < 0 ||
      this.backoffMs.length === 0 ||
      this.backoffMs.some((delayMs) => !Number.isFinite(delayMs) || delayMs < 0)
    ) {
      throw new TypeError("invalid-event-polling-timing");
    }
  }

  subscribeToEvent(
    eventId: string,
    onUpdate: (event: EventSnapshotResponse["event"]) => void,
    onError?: (error: unknown) => void,
  ): () => void {
    return this.subscribeToEventSnapshot(
      eventId,
      (response) => onUpdate(response.event),
      onError,
    );
  }

  subscribeToEventPrizeSelections(
    eventId: string,
    onUpdate: (selections: EventSnapshotResponse["prizeSelections"]) => void,
    onError?: (error: unknown) => void,
  ): () => void {
    return this.subscribeToEventSnapshot(
      eventId,
      (response) => onUpdate(response.prizeSelections),
      onError,
    );
  }

  subscribeToProfileEventPrizes(
    profileId: string,
    onUpdate: (response: ProfileEventPrizesResponse) => void,
    onError?: (error: unknown) => void,
  ): () => void {
    const entry =
      this.profilePrizeEntries.get(profileId) ||
      this.createProfilePrizeEntry(profileId);
    return this.subscribe(entry, onUpdate, onError, () => {
      if (this.profilePrizeEntries.get(profileId) !== entry) return;
      this.profilePrizeEntries.delete(profileId);
      this.teardownEntry(entry);
      this.releaseVisibilityListenerIfIdle();
    });
  }

  invalidateEvent(eventId: string): void {
    const entry = this.eventEntries.get(eventId);
    if (!entry) return;
    entry.bookmark = null;
    this.refreshEntry(entry, true);
  }

  invalidateProfileEventPrizes(): void {
    for (const entry of this.profilePrizeEntries.values()) {
      entry.bookmark = null;
      this.refreshEntry(entry, true);
    }
  }

  getEventSubscriptionToken(eventId: string): object | null {
    return this.eventEntries.get(eventId)?.lifecycleToken ?? null;
  }

  isEventSubscriptionTokenCurrent(
    eventId: string,
    token: object | null,
  ): boolean {
    return (
      token !== null && this.eventEntries.get(eventId)?.lifecycleToken === token
    );
  }

  reset(): void {
    for (const entry of this.eventEntries.values()) this.resetEntry(entry);
    for (const entry of this.profilePrizeEntries.values()) {
      this.resetEntry(entry);
    }
  }

  private subscribeToEventSnapshot(
    eventId: string,
    onUpdate: (response: EventSnapshotResponse) => void,
    onError?: (error: unknown) => void,
  ): () => void {
    const entry =
      this.eventEntries.get(eventId) || this.createEventEntry(eventId);
    return this.subscribe(entry, onUpdate, onError, () => {
      if (this.eventEntries.get(eventId) !== entry) return;
      this.eventEntries.delete(eventId);
      this.teardownEntry(entry);
      this.releaseVisibilityListenerIfIdle();
      this.dependencies.onEventIdle?.(eventId);
    });
  }

  private subscribe<T>(
    entry: PollingEntry<T>,
    onUpdate: (value: T) => void,
    onError: ((error: unknown) => void) | undefined,
    onEmpty: () => void,
  ): () => void {
    const subscriber: PollingSubscriber<T> = { onError, onUpdate };
    const shouldStart = entry.subscribers.size === 0;
    entry.subscribers.add(subscriber);
    if (shouldStart) {
      this.ensureVisibilityListener();
      this.scheduleEntry(entry, 0);
    }
    if (entry.lastResponse !== null) {
      this.notifyUpdate(onUpdate, entry.lastResponse, onError);
    } else if (entry.consecutiveFailures > 0) {
      this.notifyError(onError, entry.lastError);
    }
    return () => {
      if (!entry.subscribers.delete(subscriber)) return;
      if (entry.subscribers.size === 0) onEmpty();
    };
  }

  private createEventEntry(
    eventId: string,
  ): PollingEntry<EventSnapshotResponse> {
    const entry = this.createEntry((options) =>
      this.dependencies.loadEvent(eventId, options),
    );
    this.eventEntries.set(eventId, entry);
    return entry;
  }

  private createProfilePrizeEntry(
    profileId: string,
  ): PollingEntry<ProfileEventPrizesResponse> {
    const entry = this.createEntry(async (options) => {
      const result = await this.dependencies.loadProfilePrizes(
        profileId,
        options,
      );
      if (result.kind === "modified" && result.value.profileId !== profileId) {
        throw new Error("profile-event-prizes-owner-mismatch");
      }
      return result;
    });
    this.profilePrizeEntries.set(profileId, entry);
    return entry;
  }

  private createEntry<T>(load: PollingEntry<T>["load"]): PollingEntry<T> {
    return {
      abortController: null,
      bookmark: null,
      consecutiveFailures: 0,
      etag: null,
      lastError: undefined,
      lastResponse: null,
      lifecycleToken: {},
      load,
      refreshQueued: false,
      subscribers: new Set(),
      timer: null,
    };
  }

  private ensureVisibilityListener(): void {
    if (this.removeVisibilityListener) return;
    this.removeVisibilityListener = this.dependencies.addVisibilityListener(
      () => this.handleVisibilityChange(),
    );
  }

  private releaseVisibilityListenerIfIdle(): void {
    if (this.eventEntries.size > 0 || this.profilePrizeEntries.size > 0) return;
    this.removeVisibilityListener?.();
    this.removeVisibilityListener = null;
  }

  private handleVisibilityChange(): void {
    if (!this.dependencies.isVisible()) {
      for (const entry of this.eventEntries.values()) this.pauseEntry(entry);
      for (const entry of this.profilePrizeEntries.values()) {
        this.pauseEntry(entry);
      }
      return;
    }
    for (const entry of this.eventEntries.values()) {
      this.refreshEntry(entry, false);
    }
    for (const entry of this.profilePrizeEntries.values()) {
      this.refreshEntry(entry, false);
    }
  }

  private pauseEntry<T>(entry: PollingEntry<T>): void {
    this.clearEntryTimer(entry);
    entry.abortController?.abort();
  }

  private resetEntry<T>(entry: PollingEntry<T>): void {
    this.clearEntryTimer(entry);
    entry.bookmark = null;
    entry.consecutiveFailures = 0;
    entry.etag = null;
    entry.lastError = undefined;
    entry.lastResponse = null;
    entry.lifecycleToken = {};
    if (entry.abortController) {
      entry.refreshQueued = true;
      entry.abortController.abort();
    } else {
      this.scheduleEntry(entry, 0);
    }
  }

  private refreshEntry<T>(
    entry: PollingEntry<T>,
    abortInFlight: boolean,
  ): void {
    this.clearEntryTimer(entry);
    if (entry.abortController) {
      entry.refreshQueued = true;
      if (abortInFlight) entry.abortController.abort();
      return;
    }
    this.scheduleEntry(entry, 0);
  }

  private scheduleEntry<T>(entry: PollingEntry<T>, delayMs: number): void {
    this.clearEntryTimer(entry);
    if (entry.subscribers.size === 0 || !this.dependencies.isVisible()) return;
    entry.timer = this.dependencies.setTimer(() => {
      entry.timer = null;
      void this.pollEntry(entry);
    }, delayMs);
  }

  private async pollEntry<T>(entry: PollingEntry<T>): Promise<void> {
    if (
      entry.abortController ||
      entry.subscribers.size === 0 ||
      !this.dependencies.isVisible()
    ) {
      return;
    }
    const controller = new AbortController();
    entry.abortController = controller;
    let nextDelay: number | null = null;
    try {
      const result = await entry.load({
        bookmark: entry.bookmark,
        etag: entry.etag,
        signal: controller.signal,
      });
      if (controller.signal.aborted || entry.subscribers.size === 0) return;
      entry.etag = result.etag;
      entry.bookmark = result.bookmark;
      entry.consecutiveFailures = 0;
      entry.lastError = undefined;
      if (result.kind === "modified") {
        entry.lastResponse = result.value;
        for (const subscriber of [...entry.subscribers]) {
          if (entry.subscribers.has(subscriber)) {
            this.notifyUpdate(
              subscriber.onUpdate,
              result.value,
              subscriber.onError,
            );
          }
        }
      }
      nextDelay = this.intervalMs;
    } catch (error) {
      if (controller.signal.aborted || entry.subscribers.size === 0) return;
      entry.consecutiveFailures += 1;
      entry.lastError = error;
      if (entry.consecutiveFailures === 1) {
        for (const subscriber of [...entry.subscribers]) {
          if (entry.subscribers.has(subscriber)) {
            this.notifyError(subscriber.onError, error);
          }
        }
      }
      nextDelay = this.failureDelay(entry.consecutiveFailures);
    } finally {
      if (entry.abortController === controller) entry.abortController = null;
      if (entry.subscribers.size > 0) {
        if (entry.refreshQueued) {
          entry.refreshQueued = false;
          nextDelay = 0;
        }
        if (nextDelay !== null) this.scheduleEntry(entry, nextDelay);
      }
    }
  }

  private failureDelay(consecutiveFailures: number): number {
    return this.backoffMs[
      Math.min(consecutiveFailures - 1, this.backoffMs.length - 1)
    ];
  }

  private notifyUpdate<T>(
    callback: (value: T) => void,
    value: T,
    onError?: (error: unknown) => void,
  ): void {
    try {
      callback(value);
    } catch (error) {
      this.notifyError(onError, error);
    }
  }

  private notifyError(
    callback: ((error: unknown) => void) | undefined,
    error: unknown,
  ): void {
    try {
      callback?.(error);
    } catch {}
  }

  private clearEntryTimer<T>(entry: PollingEntry<T>): void {
    if (entry.timer === null) return;
    this.dependencies.clearTimer(entry.timer);
    entry.timer = null;
  }

  private teardownEntry<T>(entry: PollingEntry<T>): void {
    this.clearEntryTimer(entry);
    entry.abortController?.abort();
    entry.abortController = null;
    entry.subscribers.clear();
  }
}
