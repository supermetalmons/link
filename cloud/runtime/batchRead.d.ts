// Generated from src/batchRead.ts. Run npm run generate:runtime.
export declare const batchReadWithRetry: <T>(
  readers: readonly (() => T | Promise<T>)[],
) => Promise<Awaited<T>[]>;
