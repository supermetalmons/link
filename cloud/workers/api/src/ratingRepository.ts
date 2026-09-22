import { createCanonicalRatingRepository } from "./ratingCanonicalRepository.ts";
import { createGameplayRepositoryFailure } from "./gameplayRepositoryPolicy.ts";
import type { EventProgressOutboxWriter } from "./eventStoreContracts.ts";
import type {
  RatingEventProgressRepository,
  RatingGameplayReader,
  RatingProfileGameProjectionRepository,
  RatingProjectionRepository,
} from "./ratingContracts.ts";

const MAX_RATING_TRANSACTION_ATTEMPTS = 5;

type RatingRepositoryDependencies = {
  maxTransactionAttempts?: number;
  now?: () => number;
};

export function createRatingRepository(
  profileDb: D1Database,
  gameplayReads: RatingGameplayReader,
  outboxWriter: EventProgressOutboxWriter,
  {
    maxTransactionAttempts = MAX_RATING_TRANSACTION_ATTEMPTS,
    now = Date.now,
  }: RatingRepositoryDependencies = {},
): RatingProjectionRepository &
  RatingEventProgressRepository &
  RatingProfileGameProjectionRepository {
  const attempts =
    Number.isInteger(maxTransactionAttempts) && maxTransactionAttempts > 0
      ? maxTransactionAttempts
      : MAX_RATING_TRANSACTION_ATTEMPTS;
  return {
    ...createCanonicalRatingRepository(profileDb, gameplayReads, {
      createFailure: createGameplayRepositoryFailure,
      maxAttempts: attempts,
      now,
    }),
    putEventProgressOutbox: (outboxId, record) =>
      outboxWriter.putEventProgressOutbox(outboxId, record),
  };
}
