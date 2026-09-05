import { normalizeMaterials } from "@mons/shared/mining";
import type { WagerReservationRuntime } from "../src/wagerReservationRuntime.ts";
import type { GameplayRepository } from "../src/gameplayRepository.ts";
import { frozenOperationState } from "../src/wagerFrozenRecords.ts";
import {
  assertWagerFrozenKey,
  storedWagerFrozenOperation,
  type WagerFrozenSnapshot,
  type WagerFrozenStore,
} from "../src/wagerFrozenStore.ts";

type Transaction = {
  committed: boolean;
  decision?: string;
  value: unknown;
};

type MemoryBackend = {
  read(playerUid: string): Promise<unknown>;
  transact(
    playerUid: string,
    update: (current: unknown) => unknown,
    signal?: AbortSignal,
  ): Promise<Transaction>;
};

export type TestGameplayRepository = GameplayRepository & {
  readState: GameplayRepository["getRtdbPath"];
  transactState: GameplayRepository["transactRtdbPath"];
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function snapshot(value: unknown, operationId: string): WagerFrozenSnapshot {
  const row = record(value);
  const operations = record(row.operations);
  return {
    frozen: normalizeMaterials(row.frozen),
    operation:
      value !== null &&
      value !== undefined &&
      (typeof value !== "object" || Array.isArray(value))
        ? { status: "malformed" }
        : frozenOperationState(
            Object.hasOwn(operations, operationId)
              ? operations[operationId]
              : undefined,
          ),
  };
}

export function createMemoryWagerFrozenStore(
  backend?: MemoryBackend,
): WagerFrozenStore {
  const rows = new Map<string, unknown>();
  const revisions = new Map<string, number>();
  const memory: MemoryBackend = backend || {
    async read(playerUid) {
      return structuredClone(rows.get(playerUid));
    },
    async transact(playerUid, update, signal) {
      signal?.throwIfAborted();
      const current = structuredClone(rows.get(playerUid));
      const result = update(current) as {
        commit?: false;
        decision?: string;
        value?: unknown;
      };
      if (result.commit === false)
        return { committed: false, decision: result.decision, value: current };
      rows.set(playerUid, structuredClone(result.value));
      return {
        committed: true,
        decision: result.decision,
        value: result.value,
      };
    },
  };
  return {
    async readBalance(playerUid) {
      assertWagerFrozenKey(playerUid);
      return {
        frozen: normalizeMaterials(record(await memory.read(playerUid)).frozen),
        revision: revisions.get(playerUid) || 0,
      };
    },
    async read(playerUid, operationId) {
      assertWagerFrozenKey(playerUid);
      assertWagerFrozenKey(operationId);
      return snapshot(await memory.read(playerUid), operationId);
    },
    async transact(playerUid, operationId, update, signal) {
      assertWagerFrozenKey(playerUid);
      assertWagerFrozenKey(operationId);
      const result = await memory.transact(
        playerUid,
        (current) => {
          const decision = update(snapshot(current, operationId));
          if ("commit" in decision) return decision;
          const row = record(current);
          const operations = { ...record(row.operations) };
          const operation = storedWagerFrozenOperation(
            decision.value.operation,
          );
          if (operation) operations[operationId] = operation;
          else delete operations[operationId];
          return {
            decision: decision.decision,
            value: { ...row, frozen: decision.value.frozen, operations },
          };
        },
        signal,
      );
      if (result.committed)
        revisions.set(playerUid, (revisions.get(playerUid) || 0) + 1);
      return { ...result, value: snapshot(result.value, operationId) };
    },
  };
}

export function attachMemoryWagerFrozenStore(
  state: Omit<TestGameplayRepository, "getRtdbPath" | "transactRtdbPath">,
): TestGameplayRepository {
  const assertGameplayPath = (path: string) => {
    if (/^(?:reservations\/|players\/[^/]+\/mining(?:\/|$))/.test(path)) {
      throw new Error("unexpected-reservation-rtdb-path");
    }
  };
  const repository: TestGameplayRepository = {
    ...state,
    getRtdbPath: (...args) => {
      assertGameplayPath(args[0]);
      return repository.readState(...args);
    },
    transactRtdbPath: (...args) => {
      assertGameplayPath(args[0]);
      return repository.transactState(...args);
    },
  };
  repository.wagerFrozen ??= createMemoryWagerFrozenStore({
    read: (playerUid) => repository.readState(`reservations/${playerUid}`),
    transact: (playerUid, update, signal) =>
      repository.transactState(`reservations/${playerUid}`, update, signal),
  });
  return repository;
}

export function createTestWagerReservationRuntime(
  repository: GameplayRepository,
): WagerReservationRuntime {
  repository.wagerFrozen ??= createMemoryWagerFrozenStore();
  return {
    assertClientVersion: async () => undefined,
    readBalance: (playerUid) => repository.wagerFrozen!.readBalance(playerUid),
    run: (_kind, work) => work(repository, async () => undefined),
  };
}
