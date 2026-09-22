import { classifyD1Failure } from "./d1Failure.ts";

export type GameplayRepositoryOperation =
  | "applyWagerTransferOnce"
  | "readProfileOwnershipSnapshot"
  | "getMiningMaterials"
  | "getMiningSnapshot"
  | "tryAcquireRatingLease"
  | "finalizeRatingUpdate"
  | "applyFebruaryChallengeReplay";

export type CanonicalRepositoryOptions = {
  createFailure(
    operation: GameplayRepositoryOperation,
    options?: ErrorOptions,
  ): Error;
  maxAttempts: number;
  now(): number;
};

export class GameplayRepositoryFailure extends Error {
  readonly operation: GameplayRepositoryOperation;

  constructor(operation: GameplayRepositoryOperation, options?: ErrorOptions) {
    super("gameplay-repository-unavailable", options);
    this.operation = operation;
  }
}

export function createGameplayRepositoryFailure(
  operation: GameplayRepositoryOperation,
  options?: ErrorOptions,
): GameplayRepositoryFailure {
  console.error(
    JSON.stringify({
      event: "gameplay_repository_failure",
      operation,
      failureKind: classifyD1Failure(options?.cause),
    }),
  );
  return new GameplayRepositoryFailure(operation, options);
}

export function retryCount(value: number): number {
  return Number.isInteger(value) && value > 0 ? value : 5;
}

export function reconciliationFailure(
  error: unknown,
  readError: unknown,
): Error {
  return new AggregateError(
    [error, readError],
    "gameplay-write-reconciliation-failed",
    { cause: error },
  );
}
