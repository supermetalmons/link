export async function runRecoveryItems<T>(
  items: readonly T[],
  operation: (item: T) => Promise<void>,
  {
    concurrency = 1,
    aggregateErrorMessage = "recovery-records-failed",
  }: {
    concurrency?: number;
    aggregateErrorMessage?: string;
  } = {},
): Promise<void> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError("recovery-concurrency-must-be-a-positive-integer");
  }
  let index = 0;
  const failures: unknown[] = [];
  const runners = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (index < items.length) {
        const item = items[index++];
        try {
          await operation(item);
        } catch (error) {
          failures.push(error);
        }
      }
    },
  );
  await Promise.all(runners);
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, aggregateErrorMessage);
  }
}
