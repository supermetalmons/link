export async function mapMatchStateBounded<T, R>(
  items: readonly T[],
  concurrency: number,
  operation: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1)
    throw new Error("match-state-invalid-concurrency");
  const results: R[] = new Array(items.length);
  const failures: unknown[] = [];
  let index = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (index < items.length) {
        const current = index++;
        try {
          results[current] = await operation(items[current], current);
        } catch (error) {
          failures.push(error);
        }
      }
    }),
  );
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1)
    throw new AggregateError(
      failures,
      "match-state-independent-operations-failed",
    );
  return results;
}
