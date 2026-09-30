import {
  resolveEventTelegramAnnouncements,
  type EventCreateOptions,
  type EventCreateDateTimePayload,
  type EventSnapshotResponse,
  type EventSnapshotSeed,
  type LeaveEventResponse,
} from "@mons/shared/events";
import { isToggleEventPrizeSelectionRequest } from "@mons/shared/event-prizes";
import type {
  EventRecord,
  EventPrizeId,
  EventPrizeSelections,
  EventPrizeWithdrawalResponse,
  ProfileEventPrizes,
} from "./connectionModels";
import type { SessionUser } from "../session/sessionAuth";
import type { AuthTokenProvider } from "../services/authApi";
import {
  GameplayApiError,
  GAMEPLAY_API_TIMEOUT_MS,
  type ConditionalRead,
  type ConditionalReadOptions,
} from "../services/gameplayTransport";
import {
  mapDatabaseEventRecord,
  mapEventPrizeAssignment,
  normalizeEventPrizeId,
} from "./eventMappers";
import {
  normalizeFiniteNumber,
  normalizeString,
  normalizeStringOrNull,
} from "./valueNormalizers";
import { EventPollingRegistry } from "./eventPollingRegistry";

type BoundAuthTokenProvider = AuthTokenProvider & {
  readonly assertCurrentUser: () => void;
};
type TimerHandle = ReturnType<typeof setTimeout>;

export type EventClientApi = Pick<
  typeof import("../services/gameplayApi"),
  | "createEventViaApi"
  | "joinEventViaApi"
  | "leaveEventViaApi"
  | "postponeEventStartViaApi"
  | "removeEventParticipantViaApi"
  | "disqualifyEventMatchWinnersViaApi"
  | "syncEventStateViaApi"
  | "toggleEventPrizeSelectionViaApi"
  | "readEventSnapshotViaApi"
  | "readProfileEventPrizesViaApi"
> &
  Pick<typeof import("../services/eventPrizeApi"), "withdrawEventPrizeViaApi">;

export type EventClientDependencies = {
  getCurrentUser: () => SessionUser | null;
  onAuthStateChanged: (listener: () => void) => () => void;
  ensureAuthenticated: () => Promise<void>;
  getUserBoundAuthTokenProvider: () => BoundAuthTokenProvider;
  createPollingAuthTokenProvider: (
    signal?: AbortSignal,
  ) => BoundAuthTokenProvider;
  getLocalProfileId: () => string | null;
  getFallbackLoginUid: () => string | null;
  takeInitialEventBootstrap: (
    eventId: string,
    user: SessionUser,
  ) => {
    promise: Promise<ConditionalRead<EventSnapshotResponse>>;
    abort: () => void;
  } | null;
  api: EventClientApi;
  now: () => number;
  setTimer: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimer: (timer: TimerHandle) => void;
  isVisible: () => boolean;
  addVisibilityListener: (listener: () => void) => () => void;
  notifyNavigationGamesChanged: () => void;
};

const EVENT_SYNC_COOLDOWN_ACTIVE_MS = 700;
const EVENT_SYNC_COOLDOWN_SCHEDULED_MS = 1500;
const EVENT_SYNC_RETRY_DELAYS_MS = [150, 300] as const;

const mapKnownEventPrizeSelections = (
  eventId: string,
  selections: Readonly<Record<string, string>>,
): EventPrizeSelections => {
  const known: EventPrizeSelections = {};
  for (const [profileId, value] of Object.entries(selections)) {
    const prizeId = normalizeEventPrizeId(value, eventId);
    if (prizeId) known[profileId] = prizeId;
  }
  return known;
};

const mapKnownProfileEventPrizes = (
  prizes: Readonly<Record<string, unknown>>,
): ProfileEventPrizes => {
  const known: ProfileEventPrizes = {};
  for (const [eventId, value] of Object.entries(prizes)) {
    const assignment = mapEventPrizeAssignment(value, eventId);
    if (assignment) known[eventId] = assignment;
  }
  return known;
};

type EventSyncSkipReason = "locked" | "rate-limited" | "not-participant";

export type EventSyncResponse = {
  ok: boolean;
  didChange?: boolean;
  skipped?: boolean;
  reason?: EventSyncSkipReason;
  event?: EventRecord | null;
};

type EventSyncCooldownCacheEntry = {
  responseAtMs: number;
  response: EventSyncResponse;
};

export class EventClient {
  private readonly dependencies: EventClientDependencies;
  private readonly eventPollingRegistry: EventPollingRegistry;
  private eventAuthUser: SessionUser | null;
  private readonly eventMutationTails = new Map<string, Promise<unknown>>();
  private readonly inFlightEventSyncById = new Map<
    string,
    Promise<EventSyncResponse>
  >();
  private readonly eventSyncCooldownCacheById = new Map<
    string,
    EventSyncCooldownCacheEntry
  >();
  private readonly latestObservedEventById = new Map<
    string,
    EventRecord | null
  >();

  constructor(dependencies: EventClientDependencies) {
    this.dependencies = dependencies;
    this.eventAuthUser = dependencies.getCurrentUser();
    this.eventPollingRegistry = new EventPollingRegistry({
      addVisibilityListener: dependencies.addVisibilityListener,
      clearTimer: dependencies.clearTimer,
      isVisible: dependencies.isVisible,
      loadEvent: (eventId, options) => this.loadEventSnapshot(eventId, options),
      loadProfilePrizes: (profileId, options) =>
        dependencies.api.readProfileEventPrizesViaApi(
          profileId,
          dependencies.createPollingAuthTokenProvider(options.signal),
          options,
        ),
      onEventIdle: (eventId) => this.clearEventSyncCacheForId(eventId),
      setTimer: dependencies.setTimer,
      now: dependencies.now,
    });
    dependencies.onAuthStateChanged(() => this.synchronizeEventAuthOwner());
  }

  private async delay(ms: number): Promise<void> {
    await new Promise<void>((resolve) =>
      this.dependencies.setTimer(resolve, ms),
    );
  }

  private synchronizeEventAuthOwner(): void {
    if (this.eventAuthUser === this.dependencies.getCurrentUser()) return;
    this.eventAuthUser = this.dependencies.getCurrentUser();
    this.reset();
  }

  private async loadEventSnapshot(
    eventId: string,
    options: ConditionalReadOptions,
  ): Promise<ConditionalRead<EventSnapshotResponse>> {
    const controller = new AbortController();
    let rejectCanceled: (error: GameplayApiError) => void = () => undefined;
    const canceled = new Promise<never>((_resolve, reject) => {
      rejectCanceled = reject;
    });
    const cancel = (caller: boolean) => {
      controller.abort();
      rejectCanceled(
        new GameplayApiError(
          caller ? "aborted" : "unavailable",
          caller ? "request-aborted" : "Gameplay request timed out.",
        ),
      );
    };
    const handleAbort = () => cancel(true);
    options.signal?.addEventListener("abort", handleAbort, { once: true });
    const timeout = this.dependencies.setTimer(
      () => cancel(false),
      GAMEPLAY_API_TIMEOUT_MS,
    );
    const run = async (): Promise<ConditionalRead<EventSnapshotResponse>> => {
      if (options.signal?.aborted) handleAbort();
      if (controller.signal.aborted)
        throw new GameplayApiError("aborted", "request-aborted");
      await this.dependencies.ensureAuthenticated();
      if (controller.signal.aborted)
        throw new GameplayApiError("aborted", "request-aborted");
      this.synchronizeEventAuthOwner();
      const user = this.dependencies.getCurrentUser();
      if (!user || controller.signal.aborted)
        throw new GameplayApiError("aborted", "request-aborted");
      const initial = this.dependencies.takeInitialEventBootstrap(
        eventId,
        user,
      );
      if (!initial) {
        return this.dependencies.api.readEventSnapshotViaApi(
          eventId,
          this.dependencies.getUserBoundAuthTokenProvider(),
          {
            ...options,
            signal: controller.signal,
          },
        );
      }
      controller.signal.addEventListener("abort", initial.abort, {
        once: true,
      });
      try {
        return await initial.promise;
      } finally {
        controller.signal.removeEventListener("abort", initial.abort);
      }
    };
    try {
      return await Promise.race([run(), canceled]);
    } finally {
      this.dependencies.clearTimer(timeout);
      options.signal?.removeEventListener("abort", handleAbort);
    }
  }

  public async createEvent(
    schedule: number | EventCreateDateTimePayload,
    options: EventCreateOptions = {},
  ): Promise<{ ok: boolean; eventId?: string; event?: EventRecord | null }> {
    try {
      await this.dependencies.ensureAuthenticated();
      this.synchronizeEventAuthOwner();
      const generation = this.eventPollingRegistry.getGeneration();
      const tokenProvider = this.dependencies.getUserBoundAuthTokenProvider();
      const requestPayloadBase =
        typeof schedule === "number"
          ? {
              startsInMinutes: this.normalizeFiniteNumber(schedule, 0),
            }
          : {
              scheduledDate: this.normalizeString(schedule.scheduledDate),
              scheduledTime: this.normalizeString(schedule.scheduledTime),
              scheduledTimezone: schedule.scheduledTimezone,
              ...(this.normalizeString(schedule.localTimezoneIana || "") !== ""
                ? {
                    localTimezoneIana: this.normalizeString(
                      schedule.localTimezoneIana || "",
                    ),
                  }
                : {}),
            };
      const requestPayload = {
        ...requestPayloadBase,
        isSundayMons: options.isSundayMons === true,
        telegramAnnouncements: resolveEventTelegramAnnouncements(options),
      };
      const data = await this.dependencies.api.createEventViaApi(
        requestPayload,
        tokenProvider,
      );
      const event = this.applyEventMutationSnapshot(
        data.eventId,
        data.eventSnapshot,
        generation,
      );
      this.dependencies.notifyNavigationGamesChanged();
      return {
        ok: data.ok,
        eventId: data.eventId,
        event:
          event === undefined
            ? this.mapDatabaseEventRecord(data.event, data.eventId)
            : event,
      };
    } catch (error) {
      console.error("Error creating event:", error);
      throw error;
    }
  }

  private serializeEventMutation<T>(
    eventId: string,
    mutate: () => Promise<T>,
  ): Promise<T> {
    const key = eventId.trim();
    const previous = this.eventMutationTails.get(key) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(mutate);
    this.eventMutationTails.set(key, result);
    return result.finally(() => {
      if (this.eventMutationTails.get(key) === result) {
        this.eventMutationTails.delete(key);
      }
    });
  }

  public async joinEvent(
    eventId: string,
  ): Promise<{ ok: boolean; eventId?: string }> {
    try {
      await this.dependencies.ensureAuthenticated();
      const tokenProvider = this.dependencies.getUserBoundAuthTokenProvider();
      const data = await this.serializeEventMutation(eventId, () => {
        tokenProvider.assertCurrentUser();
        return this.dependencies.api.joinEventViaApi(
          { eventId },
          tokenProvider,
        );
      });
      tokenProvider.assertCurrentUser();
      this.eventPollingRegistry.invalidateEvent(data.eventId);
      this.dependencies.notifyNavigationGamesChanged();
      return {
        ok: data.ok,
        eventId: data.eventId,
      };
    } catch (error) {
      console.error("Error joining event:", error);
      throw error;
    }
  }

  public async leaveEvent(eventId: string): Promise<LeaveEventResponse> {
    try {
      await this.dependencies.ensureAuthenticated();
      this.synchronizeEventAuthOwner();
      const generation = this.eventPollingRegistry.getGeneration();
      const tokenProvider = this.dependencies.getUserBoundAuthTokenProvider();
      try {
        const data = await this.serializeEventMutation(eventId, () => {
          tokenProvider.assertCurrentUser();
          return this.dependencies.api.leaveEventViaApi(
            { eventId },
            tokenProvider,
          );
        });
        tokenProvider.assertCurrentUser();
        return data;
      } finally {
        this.synchronizeEventAuthOwner();
        if (generation === this.eventPollingRegistry.getGeneration()) {
          this.eventPollingRegistry.invalidateEvent(eventId);
          this.dependencies.notifyNavigationGamesChanged();
        }
      }
    } catch (error) {
      console.error("Error leaving event:", error);
      throw error;
    }
  }

  public async postponeEventStart(
    eventId: string,
    postponeByMinutes: number,
  ): Promise<{
    ok: boolean;
    eventId?: string;
    event?: EventRecord | null;
    postponeByMinutes?: number;
    startAtMs?: number;
  }> {
    try {
      await this.dependencies.ensureAuthenticated();
      if (
        postponeByMinutes !== 5 &&
        postponeByMinutes !== 10 &&
        postponeByMinutes !== 15
      ) {
        throw new Error("Invalid event postponement interval.");
      }
      this.synchronizeEventAuthOwner();
      const generation = this.eventPollingRegistry.getGeneration();
      return await this.eventPollingRegistry.withEventMutation(
        eventId,
        async (isCurrent) => {
          const data = await this.dependencies.api.postponeEventStartViaApi(
            {
              eventId,
              postponeByMinutes,
            },
            this.dependencies.getUserBoundAuthTokenProvider(),
          );
          const event = this.applyEventMutationSnapshot(
            data.eventId,
            isCurrent() ? data.eventSnapshot : undefined,
            generation,
          );
          this.dependencies.notifyNavigationGamesChanged();
          return {
            ok: data.ok,
            eventId: data.eventId,
            event:
              event === undefined
                ? this.mapDatabaseEventRecord(data.event, data.eventId)
                : event,
            postponeByMinutes: data.postponeByMinutes,
            startAtMs: data.startAtMs,
          };
        },
      );
    } catch (error) {
      console.error("Error postponing event start:", error);
      throw error;
    }
  }

  public async removeEventParticipant(
    eventId: string,
    participantProfileId: string,
  ): Promise<{
    ok: boolean;
    eventId?: string;
    removedProfileId?: string;
  }> {
    try {
      await this.dependencies.ensureAuthenticated();
      const data = await this.dependencies.api.removeEventParticipantViaApi(
        { eventId, participantProfileId },
        this.dependencies.getUserBoundAuthTokenProvider(),
      );
      this.eventPollingRegistry.invalidateEvent(data.eventId);
      this.dependencies.notifyNavigationGamesChanged();
      return {
        ok: data.ok,
        eventId: data.eventId,
        removedProfileId: data.removedProfileId,
      };
    } catch (error) {
      console.error("Error removing event participant:", error);
      throw error;
    }
  }

  public async disqualifyEventMatchWinners(
    eventId: string,
    matchKey: string,
  ): Promise<{
    ok: boolean;
    eventId?: string;
    event?: EventRecord | null;
    didDisqualify?: boolean;
    matchKey?: string;
  }> {
    try {
      await this.dependencies.ensureAuthenticated();
      this.synchronizeEventAuthOwner();
      const generation = this.eventPollingRegistry.getGeneration();
      return await this.eventPollingRegistry.withEventMutation(
        eventId,
        async (isCurrent) => {
          const data =
            await this.dependencies.api.disqualifyEventMatchWinnersViaApi(
              { eventId, matchKey },
              this.dependencies.getUserBoundAuthTokenProvider(),
            );
          const event = this.applyEventMutationSnapshot(
            data.eventId,
            isCurrent() ? data.eventSnapshot : undefined,
            generation,
          );
          this.dependencies.notifyNavigationGamesChanged();
          return {
            ok: data.ok,
            eventId: data.eventId,
            event:
              event === undefined
                ? this.mapDatabaseEventRecord(
                    "event" in data ? data.event : null,
                    data.eventId,
                  )
                : event,
            didDisqualify: data.didDisqualify,
            matchKey: data.matchKey,
          };
        },
      );
    } catch (error) {
      console.error("Error disqualifying event match winners:", error);
      throw error;
    }
  }

  public async syncEventState(eventId: string): Promise<EventSyncResponse> {
    const normalizedEventId = this.normalizeString(eventId).trim();
    if (!normalizedEventId) {
      return { ok: false, skipped: true, event: null };
    }
    const subscriptionToken =
      this.eventPollingRegistry.getEventSubscriptionToken(normalizedEventId);

    const nowMs = this.dependencies.now();
    const cachedSyncResponse = this.readCachedEventSyncResponse(
      normalizedEventId,
      nowMs,
    );
    if (cachedSyncResponse) {
      return cachedSyncResponse;
    }

    const existingSync = this.inFlightEventSyncById.get(normalizedEventId);
    if (existingSync) {
      return existingSync;
    }

    const syncPromise = this.eventPollingRegistry.withEventMutation(
      normalizedEventId,
      async (isCurrent) => {
        try {
          await this.dependencies.ensureAuthenticated();
          this.synchronizeEventAuthOwner();
          const generation = this.eventPollingRegistry.getGeneration();
          const tokenProvider =
            this.dependencies.getUserBoundAuthTokenProvider();
          const isParticipant =
            await this.isLocalProfileEventParticipant(normalizedEventId);
          if (!isParticipant) {
            return this.commitEventSyncResponse(
              normalizedEventId,
              {
                ok: true,
                skipped: true,
                reason: "not-participant",
                event:
                  this.latestObservedEventById.get(normalizedEventId) ?? null,
              },
              subscriptionToken,
            );
          }

          const maxRetries = EVENT_SYNC_RETRY_DELAYS_MS.length;
          const maxAttempts = maxRetries + 1;
          for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
            const data = await this.dependencies.api.syncEventStateViaApi(
              { eventId: normalizedEventId },
              tokenProvider,
            );
            const isSkipped = "skipped" in data;
            const reason = this.normalizeEventSyncSkipReason(
              isSkipped ? data.reason : undefined,
            );
            const parsed = {
              ok: data.ok,
              didChange: isSkipped ? undefined : data.didChange,
              skipped: isSkipped ? true : undefined,
              reason,
              event: this.mapDatabaseEventRecord(
                "event" in data ? data.event : null,
                normalizedEventId,
              ),
            };
            if (
              !parsed.skipped ||
              !this.shouldRetryEventSync(parsed.reason) ||
              attempt >= maxAttempts - 1
            ) {
              const event = this.applyEventMutationSnapshot(
                normalizedEventId,
                isCurrent() ? data.eventSnapshot : undefined,
                generation,
              );
              if (event !== undefined) parsed.event = event;
              const response = this.commitEventSyncResponse(
                normalizedEventId,
                parsed,
                subscriptionToken,
              );
              return response;
            }
            await this.delay(EVENT_SYNC_RETRY_DELAYS_MS[attempt] || 300);
          }

          return this.commitEventSyncResponse(
            normalizedEventId,
            {
              ok: false,
              skipped: true,
              event: null,
            },
            subscriptionToken,
          );
        } catch (error) {
          console.error("Error syncing event state:", error);
          throw error;
        }
      },
    );

    this.inFlightEventSyncById.set(normalizedEventId, syncPromise);
    const releaseSync = () => {
      if (this.inFlightEventSyncById.get(normalizedEventId) === syncPromise) {
        this.inFlightEventSyncById.delete(normalizedEventId);
      }
    };
    void syncPromise.then(releaseSync, releaseSync);
    return syncPromise;
  }

  private shouldRetryEventSync(
    reason: EventSyncSkipReason | undefined,
  ): boolean {
    return reason === "locked" || reason === "rate-limited";
  }

  private normalizeEventSyncSkipReason(
    value: unknown,
  ): EventSyncSkipReason | undefined {
    if (value === "lock-lost") {
      return "locked";
    }
    if (
      value === "locked" ||
      value === "rate-limited" ||
      value === "not-participant"
    ) {
      return value;
    }
    return undefined;
  }

  private isParticipantInEventRecord(
    eventRecord: EventRecord | null,
    profileId: string,
  ): boolean {
    if (!eventRecord || !eventRecord.participants) {
      return false;
    }
    return !!eventRecord.participants[profileId];
  }

  private isLocalCreatorInEventRecord(
    eventRecord: EventRecord | null,
    profileId: string | null,
  ): boolean {
    if (!eventRecord) {
      return false;
    }
    const normalizedProfileId = this.normalizeStringOrNull(profileId);
    if (
      normalizedProfileId &&
      this.normalizeString(eventRecord.createdByProfileId) ===
        normalizedProfileId
    ) {
      return true;
    }
    const localLoginUid = this.normalizeString(
      this.dependencies.getCurrentUser()?.uid ||
        this.dependencies.getFallbackLoginUid() ||
        "",
    );
    if (!localLoginUid) {
      return false;
    }
    return (
      this.normalizeString(eventRecord.createdByLoginUid) === localLoginUid
    );
  }

  private getEventSyncCooldownMs(eventRecord: EventRecord | null): number {
    if (!eventRecord || eventRecord.status === "scheduled") {
      return EVENT_SYNC_COOLDOWN_SCHEDULED_MS;
    }
    return EVENT_SYNC_COOLDOWN_ACTIVE_MS;
  }

  private readCachedEventSyncResponse(
    eventId: string,
    nowMs: number,
  ): EventSyncResponse | null {
    const cacheEntry = this.eventSyncCooldownCacheById.get(eventId);
    if (!cacheEntry) {
      return null;
    }
    const eventRecord = this.latestObservedEventById.has(eventId)
      ? (this.latestObservedEventById.get(eventId) ?? null)
      : (cacheEntry.response.event ?? null);
    const cooldownMs = this.getEventSyncCooldownMs(eventRecord);
    if (nowMs - cacheEntry.responseAtMs >= cooldownMs) {
      return null;
    }
    return { ...cacheEntry.response, event: eventRecord };
  }

  private commitEventSyncResponse(
    eventId: string,
    response: EventSyncResponse,
    subscriptionToken: object | null,
  ): EventSyncResponse {
    if (
      !this.eventPollingRegistry.isEventSubscriptionTokenCurrent(
        eventId,
        subscriptionToken,
      )
    ) {
      return response;
    }
    this.eventSyncCooldownCacheById.set(eventId, {
      responseAtMs: this.dependencies.now(),
      response,
    });
    return response;
  }

  private async isLocalProfileEventParticipant(
    eventId: string,
  ): Promise<boolean> {
    const profileId = this.dependencies.getLocalProfileId();
    if (!profileId) {
      return true;
    }
    const observedEvent = this.latestObservedEventById.get(eventId) ?? null;
    return (
      !observedEvent ||
      this.isLocalCreatorInEventRecord(observedEvent, profileId) ||
      this.isParticipantInEventRecord(observedEvent, profileId)
    );
  }

  public reset({
    preserveSnapshots = false,
  }: { preserveSnapshots?: boolean } = {}): void {
    this.inFlightEventSyncById.clear();
    this.eventSyncCooldownCacheById.clear();
    this.latestObservedEventById.clear();
    if (!preserveSnapshots) this.eventPollingRegistry.reset();
  }

  private applyEventMutationSnapshot(
    eventId: string,
    seed: EventSnapshotSeed | undefined,
    generation: number,
  ): EventRecord | null | undefined {
    this.synchronizeEventAuthOwner();
    if (generation !== this.eventPollingRegistry.getGeneration()) return;
    if (
      seed &&
      this.eventPollingRegistry.adoptEventSnapshot(eventId, seed, generation)
    ) {
      const snapshot = this.eventPollingRegistry.getEventSnapshot(eventId);
      return this.mapDatabaseEventRecord(snapshot?.event ?? null, eventId);
    }
    this.eventPollingRegistry.invalidateEvent(eventId);
  }

  public subscribeToEventFreshness(
    eventId: string,
    onFreshness: (fresh: boolean) => void,
  ): () => void {
    this.synchronizeEventAuthOwner();
    return this.eventPollingRegistry.subscribeToEventFreshness(
      eventId.trim(),
      onFreshness,
    );
  }

  private clearEventSyncCacheForId(eventId: string): void {
    this.inFlightEventSyncById.delete(eventId);
    this.eventSyncCooldownCacheById.delete(eventId);
    this.latestObservedEventById.delete(eventId);
  }

  public subscribeToEventPrizeSelections(
    eventId: string,
    onUpdate: (selections: EventPrizeSelections) => void,
    onError?: (error: unknown) => void,
  ): () => void {
    this.synchronizeEventAuthOwner();
    const normalizedEventId = typeof eventId === "string" ? eventId.trim() : "";
    if (!normalizedEventId) {
      onUpdate({});
      return () => {};
    }
    return this.eventPollingRegistry.subscribeToEventPrizeSelections(
      normalizedEventId,
      (selections) =>
        onUpdate(mapKnownEventPrizeSelections(normalizedEventId, selections)),
      onError,
    );
  }

  public subscribeToProfileEventPrizes(
    profileId: string,
    onUpdate: (prizes: ProfileEventPrizes) => void,
    onError?: (error: unknown) => void,
  ): () => void {
    this.synchronizeEventAuthOwner();
    const normalizedProfileId =
      typeof profileId === "string" ? profileId.trim() : "";
    if (!normalizedProfileId) {
      onUpdate({});
      return () => {};
    }
    return this.eventPollingRegistry.subscribeToProfileEventPrizes(
      normalizedProfileId,
      (response) => onUpdate(mapKnownProfileEventPrizes(response.prizes)),
      onError,
    );
  }

  public async toggleEventPrizeSelection(
    eventId: string,
    prizeId: string,
  ): Promise<EventPrizeId | null> {
    const normalizedEventId = this.normalizeString(eventId).trim();
    const normalizedPrizeId = this.normalizeString(prizeId).trim();
    const profileId = (this.dependencies.getLocalProfileId() ?? "").trim();
    const request = {
      eventId: normalizedEventId,
      prizeId: normalizedPrizeId,
    };
    if (!profileId || !isToggleEventPrizeSelectionRequest(request)) {
      throw new Error("Event prize selection requires an event and profile.");
    }

    try {
      await this.dependencies.ensureAuthenticated();
      const tokenProvider = this.dependencies.getUserBoundAuthTokenProvider();
      const response = await this.serializeEventMutation(
        normalizedEventId,
        () => {
          tokenProvider.assertCurrentUser();
          return this.dependencies.api.toggleEventPrizeSelectionViaApi(
            request,
            tokenProvider,
          );
        },
      );
      tokenProvider.assertCurrentUser();
      this.eventPollingRegistry.invalidateEvent(response.eventId);
      return response.selectedPrizeId;
    } catch (error) {
      console.error("Error toggling event prize selection:", error);
      throw error;
    }
  }

  public async withdrawEventPrize(
    eventId: string,
    prizeId: EventPrizeId,
    solanaAddress: string,
  ): Promise<EventPrizeWithdrawalResponse> {
    try {
      await this.dependencies.ensureAuthenticated();
      const response = await this.dependencies.api.withdrawEventPrizeViaApi(
        eventId,
        prizeId,
        solanaAddress,
        this.dependencies.getUserBoundAuthTokenProvider(),
      );
      this.eventPollingRegistry.invalidateProfileEventPrizes();
      return response;
    } catch (error) {
      console.error("Error withdrawing event prize:", error);
      throw error;
    }
  }

  public subscribeToEvent(
    eventId: string,
    onUpdate: (event: EventRecord | null) => void,
    onError?: (error: unknown) => void,
  ): () => void {
    this.synchronizeEventAuthOwner();
    const normalizedEventId = typeof eventId === "string" ? eventId.trim() : "";
    if (!normalizedEventId) {
      onUpdate(null);
      return () => {};
    }
    return this.eventPollingRegistry.subscribeToEvent(
      normalizedEventId,
      (rawEvent) => {
        const mappedEvent = this.mapDatabaseEventRecord(
          rawEvent,
          normalizedEventId,
        );
        this.latestObservedEventById.set(normalizedEventId, mappedEvent);
        onUpdate(mappedEvent);
      },
      onError,
    );
  }

  private normalizeStringOrNull(value: unknown): string | null {
    return normalizeStringOrNull(value);
  }

  private normalizeString(value: unknown): string {
    return normalizeString(value);
  }

  private normalizeFiniteNumber(value: unknown, fallback = 0): number {
    return normalizeFiniteNumber(value, fallback);
  }

  private mapDatabaseEventRecord(
    rawValue: unknown,
    fallbackEventId: string,
  ): EventRecord | null {
    return mapDatabaseEventRecord(rawValue, fallbackEventId);
  }
}
