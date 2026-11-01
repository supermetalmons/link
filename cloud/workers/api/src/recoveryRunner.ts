import {
  reportRecoveryItemFailure,
  type RecoveryFailureReporter,
} from "./recoveryReporting.ts";

export async function collectRecoveryItems<T, Result>(
  items: readonly T[],
  operation: (item: T, index: number) => Promise<Result>,
  {
    concurrency = 1,
    onFailure,
  }: {
    concurrency?: number;
    onFailure?: RecoveryFailureReporter<T>;
  } = {},
): Promise<{
  successes: Array<{ item: T; index: number; value: Result }>;
  failures: Array<{ item: T; index: number; error: unknown }>;
}> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError("recovery-concurrency-must-be-a-positive-integer");
  }
  let index = 0;
  const successes: Array<{ item: T; index: number; value: Result }> = [];
  const failures: Array<{ item: T; index: number; error: unknown }> = [];
  const runners = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (index < items.length) {
        const itemIndex = index++;
        const item = items[itemIndex]!;
        try {
          const value = await operation(item, itemIndex);
          successes.push({ item, index: itemIndex, value });
        } catch (error) {
          failures.push({ item, index: itemIndex, error });
          reportRecoveryItemFailure(onFailure, item, error, itemIndex);
        }
      }
    },
  );
  await Promise.all(runners);
  return { successes, failures };
}

export async function runRecoveryItems<T>(
  items: readonly T[],
  operation: (item: T, index: number) => Promise<void>,
  {
    concurrency = 1,
    aggregateErrorMessage = "recovery-records-failed",
  }: {
    concurrency?: number;
    aggregateErrorMessage?: string;
  } = {},
): Promise<void> {
  const { failures } = await collectRecoveryItems(items, operation, {
    concurrency,
  });
  if (failures.length === 1) throw failures[0]!.error;
  if (failures.length > 1) {
    throw new AggregateError(
      failures.map(({ error }) => error),
      aggregateErrorMessage,
    );
  }
}
