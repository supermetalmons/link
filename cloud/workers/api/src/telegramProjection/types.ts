import type { EventReads } from "../../../../runtime/eventReads.js";
import type { TelegramRepository } from "../../../../runtime/telegram/deliveryEngine.js";
import type { EventStore } from "../eventStoreContracts.ts";
import type { GameSessionPort } from "../gameSessionContracts.ts";
import type { EventOutboxReads } from "../eventOutboxReadRepository.ts";
import type { RatingProjectionRepository } from "../ratingContracts.ts";
import type { InitialTelegramDelivery } from "../telegramDeliveryTasks.ts";
import type {
  TelegramAnnouncementRepository,
  TelegramStorageMode,
} from "../telegramD1.ts";

export type ProjectionLogger = Pick<Console, "error" | "info">;

export type ProjectionDependencies = {
  createRating?: (env: Env) => RatingProjectionRepository;
  createStateRepository?: (
    env: Env,
  ) => GameSessionPort &
    EventStore &
    Pick<EventReads, "readEvent"> &
    Pick<EventOutboxReads, "listDueEventTelegramProjectionOutboxes">;
  createTelegram?: (env: Env) => TelegramRepository;
  createAnnouncements?: (
    env: Env,
  ) => Pick<TelegramAnnouncementRepository, "get">;
  enqueueDelivery?: (input: InitialTelegramDelivery) => Promise<unknown>;
  logger?: ProjectionLogger;
  now?: () => number;
  readStorageMode?: (db: D1Database) => Promise<TelegramStorageMode>;
};
