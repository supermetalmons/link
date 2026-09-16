import type { ProfileEventPrizesResponse } from "@mons/shared/event-prizes";
import {
  eventBookmarkEpoch,
  isEventSnapshotSeed,
  type EventSnapshotResponse,
  type EventSnapshotSeed,
} from "@mons/shared/events";
import type {
  ConditionalRead,
  ConditionalReadOptions,
} from "../services/gameplayApi";

export const EVENT_POLL_INTERVAL_MS = 2_000;
export const EVENT_POLL_BACKOFF_MS = [
  2_000, 4_000, 8_000, 16_000, 30_000,
] as const;
export const EVENT_SNAPSHOT_CACHE_CAPACITY = 8;
export const EVENT_SNAPSHOT_CACHE_TTL_MS = 5 * 60_000;

type TimerHandle = ReturnType<typeof setTimeout>;

type PollingSubscriber<T> = {
  onError?: (error: unknown) => void;
  onUpdate: (value: T) => void;
};

type PollingEntry<T> = {
  acceptResult?: (result: ConditionalRead<T>) => boolean;
  abortController: AbortController | null;
  bookmark: string | null;
  consecutiveFailures: number;
  etag: string | null;
  lastError: unknown;
  lastResponse: T | null;
  lifecycleToken: object;
  load: (options: ConditionalReadOptions) => Promise<ConditionalRead<T>>;
  queuedDelayMs: number | null;
  responseVersion: number;
  onReadAccepted?: () => void;
  onReadFailed?: () => void;
  subscribers: Set<PollingSubscriber<T>>;
  timer: TimerHandle | null;
};

type EventPollingEntry = PollingEntry<EventSnapshotResponse> & {
  adoptedAtMs: number | null;
  epoch: string | null;
  eventId: string;
  fresh: boolean;
  retiredEpochs: Set<string>;
  validatedAtMs: number | null;
};

type CachedEventSnapshot = {
  adoptedAtMs: number | null;
  validatedAtMs: number;
  retiredEpochs: Set<string>;
  seed: EventSnapshotSeed;
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
  now?: () => number;
};

export class EventPollingRegistry {
  private readonly backoffMs: readonly number[];
  private readonly dependencies: EventPollingRegistryDependencies;
  private readonly eventEntries = new Map<string, EventPollingEntry>();
  private readonly eventSnapshots = new Map<string, CachedEventSnapshot>();
  private readonly freshnessSubscribers = new Map<
    string,
    Set<(fresh: boolean) => void>
  >();
  private generation = 0;
  private readonly pendingMutations = new Map<
    string,
    Set<{ current: boolean }>
  >();
  private readonly intervalMs: number;
  private readonly profilePrizeEntries = new Map<
    string,
    PollingEntry<ProfileEventPrizesResponse>
  >();
  private removeVisibilityListener: (() => void) | null = null;
  private readonly now: () => number;

  constructor(dependencies: EventPollingRegistryDependencies) {
    this.dependencies = dependencies;
    this.intervalMs = dependencies.intervalMs ?? EVENT_POLL_INTERVAL_MS;
    this.backoffMs = dependencies.backoffMs ?? EVENT_POLL_BACKOFF_MS;
    this.now = dependencies.now ?? Date.now;
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

  subscribeToEventFreshness(
    eventId: string,
    onUpdate: (fresh: boolean) => void,
  ): () => void {
    const subscribers = this.freshnessSubscribers.get(eventId) ?? new Set();
    subscribers.add(onUpdate);
    this.freshnessSubscribers.set(eventId, subscribers);
    this.notifyUpdate(onUpdate, this.eventEntries.get(eventId)?.fresh ?? false);
    return () => {
      subscribers.delete(onUpdate);
      if (subscribers.size === 0) this.freshnessSubscribers.delete(eventId);
    };
  }

  getGeneration(): number {
    return this.generation;
  }

  async withEventMutation<T>(
    eventId: string,
    mutate: (isCurrent: () => boolean) => Promise<T>,
  ): Promise<T> {
    const guard = { current: true };
    const guards = this.pendingMutations.get(eventId) ?? new Set();
    guards.add(guard);
    this.pendingMutations.set(eventId, guards);
    try {
      return await mutate(() => guard.current);
    } finally {
      guards.delete(guard);
      if (guards.size === 0 && this.pendingMutations.get(eventId) === guards)
        this.pendingMutations.delete(eventId);
    }
  }

  getEventSnapshot(eventId: string): EventSnapshotResponse | null {
    return (
      this.eventEntries.get(eventId)?.lastResponse ??
      this.readCachedEventSnapshot(eventId)?.seed.snapshot ??
      null
    );
  }

  adoptEventSnapshot(
    eventId: string,
    seed: EventSnapshotSeed,
    expectedGeneration = this.generation,
  ): boolean {
    if (
      expectedGeneration !== this.generation ||
      !isEventSnapshotSeed(seed) ||
      seed.snapshot.eventId !== eventId
    ) {
      return false;
    }
    const entry = this.eventEntries.get(eventId);
    const cached = entry ? null : this.readCachedEventSnapshot(eventId);
    const previous = entry?.lastResponse ?? cached?.seed.snapshot ?? null;
    const previousEpoch =
      entry?.epoch ?? eventBookmarkEpoch(cached?.seed.bookmark);
    const retiredEpochs =
      entry?.retiredEpochs ?? cached?.retiredEpochs ?? new Set();
    const epoch = eventBookmarkEpoch(seed.bookmark)!;
    if (
      this.isOlderEventSnapshot(previous, previousEpoch, retiredEpochs, seed)
    ) {
      return true;
    }
    if (previousEpoch && previousEpoch !== epoch)
      retiredEpochs.add(previousEpoch);
    this.eventSnapshots.delete(eventId);
    if (!entry) {
      if (seed.snapshot.event !== null) {
        this.retainEventSnapshot(eventId, {
          adoptedAtMs: this.now(),
          validatedAtMs: this.now(),
          retiredEpochs,
          seed,
        });
      }
      return true;
    }
    entry.responseVersion += 1;
    entry.adoptedAtMs = this.now();
    entry.validatedAtMs = this.now();
    entry.epoch = epoch;
    entry.etag = seed.etag;
    entry.bookmark = seed.bookmark;
    entry.lastResponse = seed.snapshot;
    entry.consecutiveFailures = 0;
    entry.lastError = undefined;
    const responseVersion = entry.responseVersion;
    this.setEventFreshness(entry, true);
    if (entry.responseVersion !== responseVersion) return true;
    this.broadcastEntry(entry, seed.snapshot);
    if (entry.responseVersion === responseVersion) {
      this.restartEntry(entry, this.intervalMs, true);
    }
    return true;
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
    for (const guard of this.pendingMutations.get(eventId) ?? [])
      guard.current = false;
    this.eventSnapshots.delete(eventId);
    const entry = this.eventEntries.get(eventId);
    if (!entry) return;
    entry.responseVersion += 1;
    entry.adoptedAtMs = null;
    entry.bookmark = null;
    this.setEventFreshness(entry, false);
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
    this.generation += 1;
    for (const guards of this.pendingMutations.values())
      for (const guard of guards) guard.current = false;
    this.pendingMutations.clear();
    this.eventSnapshots.clear();
    for (const entry of this.eventEntries.values()) {
      this.resetEntry(entry);
      entry.adoptedAtMs = null;
      entry.validatedAtMs = null;
      entry.epoch = null;
      entry.retiredEpochs.clear();
      this.setEventFreshness(entry, false);
      this.broadcastEntry(entry, {
        ok: true,
        eventId: entry.eventId,
        revision: 0,
        event: null,
        prizeSelections: {},
      });
    }
    for (const [profileId, entry] of this.profilePrizeEntries) {
      this.resetEntry(entry);
      this.broadcastEntry(entry, {
        ok: true,
        profileId,
        revision: 0,
        prizes: {},
      });
    }
  }

  private subscribeToEventSnapshot(
    eventId: string,
    onUpdate: (response: EventSnapshotResponse) => void,
    onError?: (error: unknown) => void,
  ): () => void {
    const entry =
      this.eventEntries.get(eventId) || this.createEventEntry(eventId);
    return this.subscribe(
      entry,
      onUpdate,
      onError,
      () => {
        if (this.eventEntries.get(eventId) !== entry) return;
        const generation = this.generation;
        this.eventEntries.delete(eventId);
        this.teardownEntry(entry);
        this.releaseVisibilityListenerIfIdle();
        this.dependencies.onEventIdle?.(eventId);
        this.setEventFreshness(entry, false);
        if (
          generation === this.generation &&
          entry.lastResponse?.event &&
          entry.etag &&
          entry.bookmark &&
          entry.validatedAtMs !== null
        ) {
          this.retainEventSnapshot(eventId, {
            adoptedAtMs: null,
            validatedAtMs: entry.validatedAtMs,
            retiredEpochs: entry.retiredEpochs,
            seed: {
              snapshot: entry.lastResponse,
              etag: entry.etag,
              bookmark: entry.bookmark,
            },
          });
        }
      },
      this.initialEventDelay(entry),
    );
  }

  private subscribe<T>(
    entry: PollingEntry<T>,
    onUpdate: (value: T) => void,
    onError: ((error: unknown) => void) | undefined,
    onEmpty: () => void,
    initialDelayMs = 0,
  ): () => void {
    const subscriber: PollingSubscriber<T> = { onError, onUpdate };
    const shouldStart = entry.subscribers.size === 0;
    entry.subscribers.add(subscriber);
    if (shouldStart) {
      this.ensureVisibilityListener();
      this.scheduleEntry(entry, initialDelayMs);
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

  private createEventEntry(eventId: string): EventPollingEntry {
    const cached = this.readCachedEventSnapshot(eventId);
    this.eventSnapshots.delete(eventId);
    const entry: EventPollingEntry = {
      ...this.createEntry((options) =>
        this.dependencies.loadEvent(eventId, options),
      ),
      adoptedAtMs: cached?.adoptedAtMs ?? null,
      epoch: eventBookmarkEpoch(cached?.seed.bookmark),
      eventId,
      fresh: false,
      retiredEpochs: cached?.retiredEpochs ?? new Set(),
      validatedAtMs: cached?.validatedAtMs ?? null,
    };
    if (cached) {
      entry.lastResponse = cached.seed.snapshot;
      entry.etag = cached.seed.etag;
      entry.bookmark = cached.seed.bookmark;
    }
    entry.acceptResult = (result) => this.acceptEventRead(entry, result);
    entry.onReadAccepted = () => {
      entry.adoptedAtMs = null;
      entry.validatedAtMs = this.now();
      this.setEventFreshness(entry, true);
    };
    entry.onReadFailed = () => this.setEventFreshness(entry, false);
    this.eventEntries.set(eventId, entry);
    if (entry.adoptedAtMs !== null && this.initialEventDelay(entry) > 0) {
      this.setEventFreshness(entry, true);
    }
    return entry;
  }

  private initialEventDelay(entry: EventPollingEntry): number {
    return entry.adoptedAtMs === null
      ? 0
      : Math.max(0, this.intervalMs - (this.now() - entry.adoptedAtMs));
  }

  private acceptEventRead(
    entry: EventPollingEntry,
    result: ConditionalRead<EventSnapshotResponse>,
  ): boolean {
    const epoch = eventBookmarkEpoch(result.bookmark);
    if (result.kind === "not-modified") {
      if (
        !entry.lastResponse ||
        !epoch ||
        epoch !== entry.epoch ||
        result.etag !== entry.etag
      ) {
        if (entry.etag !== null) entry.queuedDelayMs = 0;
        entry.etag = null;
        entry.bookmark = null;
        throw new Error("invalid-event-not-modified-response");
      }
      return true;
    }
    const seed: EventSnapshotSeed = {
      snapshot: result.value,
      etag: result.etag,
      bookmark: result.bookmark,
    };
    if (!isEventSnapshotSeed(seed) || result.value.eventId !== entry.eventId) {
      throw new Error("invalid-event-snapshot-response");
    }
    if (
      this.isOlderEventSnapshot(
        entry.lastResponse,
        entry.epoch,
        entry.retiredEpochs,
        seed,
      )
    ) {
      return false;
    }
    if (entry.epoch && entry.epoch !== epoch)
      entry.retiredEpochs.add(entry.epoch);
    entry.epoch = epoch;
    if (result.value.event === null) this.eventSnapshots.delete(entry.eventId);
    return true;
  }

  private isOlderEventSnapshot(
    previous: EventSnapshotResponse | null,
    previousEpoch: string | null,
    retiredEpochs: Set<string>,
    seed: EventSnapshotSeed,
  ): boolean {
    const epoch = eventBookmarkEpoch(seed.bookmark)!;
    return (
      retiredEpochs.has(epoch) ||
      (previous !== null &&
        previousEpoch === epoch &&
        seed.snapshot.event !== null &&
        seed.snapshot.revision < previous.revision)
    );
  }

  private readCachedEventSnapshot(eventId: string): CachedEventSnapshot | null {
    const cached = this.eventSnapshots.get(eventId);
    if (!cached) return null;
    if (this.now() - cached.validatedAtMs >= EVENT_SNAPSHOT_CACHE_TTL_MS) {
      this.eventSnapshots.delete(eventId);
      return null;
    }
    return cached;
  }

  private retainEventSnapshot(
    eventId: string,
    cached: CachedEventSnapshot,
  ): void {
    for (const id of this.eventSnapshots.keys())
      this.readCachedEventSnapshot(id);
    this.eventSnapshots.delete(eventId);
    this.eventSnapshots.set(eventId, cached);
    while (this.eventSnapshots.size > EVENT_SNAPSHOT_CACHE_CAPACITY) {
      this.eventSnapshots.delete(this.eventSnapshots.keys().next().value!);
    }
  }

  private setEventFreshness(entry: EventPollingEntry, fresh: boolean): void {
    if (entry.fresh === fresh) return;
    entry.fresh = fresh;
    const responseVersion = entry.responseVersion;
    const subscribers = this.freshnessSubscribers.get(entry.eventId);
    for (const subscriber of [...(subscribers ?? [])]) {
      if (entry.responseVersion !== responseVersion || entry.fresh !== fresh)
        return;
      if (subscribers?.has(subscriber)) this.notifyUpdate(subscriber, fresh);
    }
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
      queuedDelayMs: null,
      responseVersion: 0,
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
      for (const entry of this.eventEntries.values()) {
        this.setEventFreshness(entry, false);
        this.pauseEntry(entry);
      }
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
    entry.responseVersion += 1;
    this.restartEntry(entry, 0, true);
  }

  private refreshEntry<T>(
    entry: PollingEntry<T>,
    abortInFlight: boolean,
  ): void {
    this.restartEntry(entry, 0, abortInFlight);
  }

  private restartEntry<T>(
    entry: PollingEntry<T>,
    delayMs: number,
    abortInFlight: boolean,
  ): void {
    this.clearEntryTimer(entry);
    if (entry.abortController) {
      entry.queuedDelayMs = delayMs;
      if (abortInFlight) entry.abortController.abort();
      return;
    }
    this.scheduleEntry(entry, delayMs);
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
    const responseVersion = entry.responseVersion;
    entry.abortController = controller;
    let nextDelay: number | null = null;
    try {
      const result = await entry.load({
        bookmark: entry.bookmark,
        etag: entry.etag,
        signal: controller.signal,
      });
      if (
        controller.signal.aborted ||
        entry.subscribers.size === 0 ||
        entry.responseVersion !== responseVersion
      )
        return;
      nextDelay = this.intervalMs;
      if (entry.acceptResult && !entry.acceptResult(result)) return;
      entry.etag = result.etag;
      entry.bookmark = result.bookmark;
      entry.consecutiveFailures = 0;
      entry.lastError = undefined;
      if (result.kind === "modified") entry.lastResponse = result.value;
      if (
        entry.responseVersion === responseVersion &&
        entry.subscribers.size > 0
      ) {
        entry.onReadAccepted?.();
      }
      if (
        result.kind === "modified" &&
        entry.responseVersion === responseVersion
      ) {
        this.broadcastEntry(entry, result.value);
      }
    } catch (error) {
      if (
        controller.signal.aborted ||
        entry.subscribers.size === 0 ||
        entry.responseVersion !== responseVersion
      )
        return;
      entry.onReadFailed?.();
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
        if (entry.queuedDelayMs !== null) {
          nextDelay = entry.queuedDelayMs;
          entry.queuedDelayMs = null;
        }
        if (nextDelay !== null) this.scheduleEntry(entry, nextDelay);
      }
    }
  }

  private broadcastEntry<T>(entry: PollingEntry<T>, value: T): void {
    const responseVersion = entry.responseVersion;
    for (const subscriber of [...entry.subscribers]) {
      if (entry.responseVersion !== responseVersion) return;
      if (entry.subscribers.has(subscriber)) {
        this.notifyUpdate(subscriber.onUpdate, value, subscriber.onError);
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
    entry.responseVersion += 1;
    entry.queuedDelayMs = null;
    entry.subscribers.clear();
  }
}
