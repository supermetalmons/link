import type { GameplayRepository } from "./gameplayRepository.ts";
import { createEventGameplayRepository } from "./eventRepository.ts";
import { createEventProfileGameProjectionRepository } from "./eventProfileGameProjectionProducer.ts";
import { createEventTelegramProjectionRepository } from "./eventTelegramProjectionProducer.ts";
import { createEventAnnouncementScheduleRepository } from "./eventPrizeAnnouncementSchedule.ts";

type EventMutationRepositoryOptions = {
  baseRepository?: GameplayRepository;
  eventRepository?: GameplayRepository;
  schedule?: (work: Promise<void>) => void;
};

export function createEventMutationRepository(
  env: Env,
  options: EventMutationRepositoryOptions = {},
): GameplayRepository {
  const eventRepository =
    options.eventRepository ||
    createEventGameplayRepository(env, options.baseRepository);
  const announcementRepository = createEventAnnouncementScheduleRepository(
    env,
    eventRepository,
    { schedule: options.schedule },
  );
  const telegramRepository = createEventTelegramProjectionRepository(
    env,
    announcementRepository,
    { schedule: options.schedule },
  );
  return createEventProfileGameProjectionRepository(env, telegramRepository, {
    schedule: options.schedule,
  });
}
