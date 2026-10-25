import { decodeAutomatchEntries } from "../../../runtime/automatchRecords.js";
import type { AutomatchPersistence } from "../src/automatchPersistence.ts";
import type { StateRepository } from "../test/stateRepositoryTestTypes.ts";
import { gameplayTestPort } from "./gameSessionTestPorts.ts";

export function createAutomatchQueueLookup(
  readState?: StateRepository["getPath"],
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
    return decodeAutomatchEntries(result)!;
  };
}

export function createAutomatchPersistenceStub(
  overrides: Partial<AutomatchPersistence> = {},
): AutomatchPersistence {
  const unavailable = async (): Promise<never> => {
    throw new Error("unexpected-persistence-operation");
  };
  return {
    client: gameplayTestPort({
      getPath: unavailable,
      patchRoot: unavailable,
      transactPath: unavailable,
    }),
    recoverLogins: async () => {},
    writesEnabled: async () => true,
    readQueuedByLogins: async () => ({}),
    expireReceipts: unavailable,
    sweep: async () => ({ recovered: 0, failed: 0 }),
    decorateLocks: (base) => base,
    ...overrides,
  };
}
