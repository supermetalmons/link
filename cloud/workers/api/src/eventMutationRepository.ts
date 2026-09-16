import type { GameplayRepository } from "./gameplayRepository.ts";
import {
  createEventGameplayRepository,
  type EventGameplayRepository,
} from "./eventRepository.ts";
import { prepareEventProfileGameProjection } from "./eventProfileGameProjectionProducer.ts";
import { prepareEventTelegramProjection } from "./eventTelegramProjectionProducer.ts";
import { prepareEventAnnouncementSchedule } from "./eventPrizeAnnouncementSchedule.ts";
import {
  commitPreparedEventMutation,
  createEventMutationReads,
} from "./eventMutationCommit.ts";

type EventMutationRepositoryOptions = {
  baseRepository?: GameplayRepository;
  eventRepository?: EventGameplayRepository;
  schedule?: (work: Promise<void>) => void;
};

export function createEventMutationRepository(
  env: Env,
  options: EventMutationRepositoryOptions = {},
): EventGameplayRepository {
  const eventRepository =
    options.eventRepository ||
    createEventGameplayRepository(env, options.baseRepository, {
      schedule: options.schedule,
    });
  return {
    ...eventRepository,
    async commitEventPlan(updates, signal) {
      const reads = createEventMutationReads(eventRepository, signal);
      const profile = await prepareEventProfileGameProjection(
        env,
        updates,
        reads,
      );
      const telegram = prepareEventTelegramProjection(env, updates);
      const announcements = await prepareEventAnnouncementSchedule(
        env,
        updates,
        reads,
      );
      await commitPreparedEventMutation(
        eventRepository,
        updates,
        [profile, telegram, announcements],
        signal,
        options.schedule,
      );
    },
  };
}
