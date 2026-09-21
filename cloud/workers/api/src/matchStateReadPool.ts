export async function runMatchStateReads<T>(
  reads: readonly (() => Promise<T>)[],
  signal?: AbortSignal,
): Promise<T[]> {
  signal?.throwIfAborted();
  const results = new Array<T>(reads.length);
  let nextIndex = 0;
  let failed = false;
  let failure: unknown;
  const worker = async () => {
    try {
      while (!failed && nextIndex < reads.length) {
        signal?.throwIfAborted();
        const index = nextIndex++;
        results[index] = await reads[index]();
      }
    } catch (error) {
      if (!failed) failure = error;
      failed = true;
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, reads.length) }, worker));
  signal?.throwIfAborted();
  if (failed) throw failure;
  return results;
}
