export type ReadRetryOptions = {
  attempts?: number;
  shouldRetry(error: unknown): boolean;
  wait?: (milliseconds: number) => Promise<void>;
  onRetry?: (retry: {
    error: unknown;
    attempt: number;
    delayMs: number;
  }) => void | Promise<void>;
};

function positiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error(`invalid ${name}`);
}

export async function retryRead<T>(
  operation: () => Promise<T>,
  options: ReadRetryOptions,
): Promise<T> {
  const attempts = options.attempts ?? 5;
  positiveInteger(attempts, "read retry attempts");
  const wait =
    options.wait ||
    ((milliseconds) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  for (let attempt = 1; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= attempts) throw error;
      let retryable: boolean;
      try {
        retryable = options.shouldRetry(error);
      } catch {
        throw error;
      }
      if (!retryable) throw error;
      const delayMs = Math.min(2_000, 250 * 2 ** Math.min(attempt - 1, 3));
      try {
        await options.onRetry?.({ error, attempt, delayMs });
      } catch {}
      try {
        await wait(delayMs);
      } catch {
        throw error;
      }
    }
  }
}

export async function concurrentSettled<T>(
  items: readonly T[],
  operation: (item: T) => Promise<unknown>,
  limit = 16,
): Promise<void> {
  positiveInteger(limit, "concurrency limit");
  let next = 0;
  let failed = false;
  let firstFailure: unknown;
  const results = await Promise.allSettled(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (!failed && next < items.length) {
        const item = items[next++];
        try {
          await operation(item);
        } catch (error) {
          if (!failed) {
            failed = true;
            firstFailure = error;
          }
        }
      }
    }),
  );
  if (failed) throw firstFailure;
  const unexpected = results.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (unexpected) throw unexpected.reason;
}
