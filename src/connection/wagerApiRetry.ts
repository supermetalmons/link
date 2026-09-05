export const isWagerClientUpdateRequired = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === "client-update-required";

export async function retryWagerApi<T extends { ok: boolean; reason?: string }>(
  call: () => Promise<T>,
  options: {
    delay: (milliseconds: number) => Promise<void>;
    maxAttempts?: number;
    onRetry?: (attempt: number, error?: unknown) => void;
  },
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const data = await call();
      if (
        data.ok === false &&
        (data.reason === "proposal-unavailable" ||
          data.reason === "proposal-missing" ||
          data.reason === "match-not-found") &&
        attempt < maxAttempts
      ) {
        options.onRetry?.(attempt + 1);
        await options.delay(160 * attempt);
        continue;
      }
      return data;
    } catch (error) {
      if (isWagerClientUpdateRequired(error) || attempt === maxAttempts) {
        throw error;
      }
      options.onRetry?.(attempt + 1, error);
      await options.delay(180 * attempt);
    }
  }
  throw new Error("wager-retry-exhausted");
}
