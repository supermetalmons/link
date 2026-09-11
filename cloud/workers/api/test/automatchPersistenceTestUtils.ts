import type { AutomatchPersistence } from "../src/automatchPersistence.ts";
import type { GameplayRepository } from "../src/gameplayRepository.ts";

export function createAutomatchQueueLookup(
  readState?: GameplayRepository["getStatePath"],
): AutomatchPersistence["readQueuedByLogins"] {
  return async (loginUids, signal) => {
    const rows = await Promise.all(
      loginUids.map(async (uid) => {
        signal?.throwIfAborted();
        return (
          readState?.(
            "automatch",
            { orderBy: "uid", equalTo: uid, limitToFirst: 2 },
            signal,
          ) ?? null
        );
      }),
    );
    const result: Record<string, unknown> = {};
    for (const row of rows) {
      if (row && typeof row === "object" && !Array.isArray(row))
        Object.assign(result, row);
    }
    return result;
  };
}

export function createAutomatchPersistenceStub(
  overrides: Partial<AutomatchPersistence> = {},
): AutomatchPersistence {
  const unavailable = async (): Promise<never> => {
    throw new Error("unexpected-persistence-operation");
  };
  return {
    client: {
      getPath: unavailable,
      patchRoot: unavailable,
      transactPath: unavailable,
    },
    recoverLogins: async () => {},
    writesEnabled: async () => true,
    readQueuedByLogins: async () => ({}),
    expireReceipts: unavailable,
    sweep: async () => ({ recovered: 0, failed: 0 }),
    decorateLocks: (base) => base,
    ...overrides,
  };
}
