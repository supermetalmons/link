import type { GameplayRepository } from "./gameplayRepository.ts";
import { createEventGameplayRepository } from "./eventRepository.ts";
import { createEventProfileGameProjectionRepository } from "./eventProfileGameProjectionProducer.ts";
import { createEventTelegramProjectionRepository } from "./eventTelegramProjectionProducer.ts";
import { createEventPrizeAnnouncementScheduleRepository } from "./eventPrizeAnnouncementSchedule.ts";

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
  const prizeRepository = createEventPrizeAnnouncementScheduleRepository(
    env,
    eventRepository,
    { schedule: options.schedule },
  );
  const telegramRepository = createEventTelegramProjectionRepository(
    env,
    prizeRepository,
    { schedule: options.schedule },
  );
  return createEventProfileGameProjectionRepository(env, telegramRepository, {
    schedule: options.schedule,
  });
}
