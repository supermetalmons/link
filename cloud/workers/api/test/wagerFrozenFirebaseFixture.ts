import { isMaterialName, normalizeMaterials } from "@mons/shared/mining";
import type { FirebaseRtdbClient } from "../src/firebaseRtdb.ts";
import { frozenOperationState } from "../src/wagerFrozenRecords.ts";
import {
  assertWagerFrozenKey,
  storedWagerFrozenOperation,
  type WagerFrozenSnapshot,
  type WagerFrozenStore,
} from "../src/wagerFrozenStore.ts";

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function snapshot(value: unknown, operationId: string): WagerFrozenSnapshot {
  return {
    frozen: normalizeMaterials(record(value)?.frozen),
    operation: frozenOperationState(value, operationId),
  };
}

export function createWagerFrozenFirebaseStore(
  client: Pick<FirebaseRtdbClient, "getPath" | "transactPath">,
): WagerFrozenStore {
  const path = (playerUid: string) => {
    assertWagerFrozenKey(playerUid);
    return `players/${playerUid}/mining`;
  };
  return {
    async readBalance(playerUid) {
      const value = await client.getPath(path(playerUid));
      if (value !== null && value !== undefined && !record(value)) {
        throw new Error("wager-operation-unavailable");
      }
      const frozen = record(value)?.frozen;
      if (frozen !== null && frozen !== undefined) {
        const counts = record(frozen);
        if (
          !counts ||
          Object.entries(counts).some(
            ([key, count]) =>
              !isMaterialName(key) ||
              typeof count !== "number" ||
              !Number.isSafeInteger(count) ||
              count < 0,
          )
        ) {
          throw new Error("wager-operation-unavailable");
        }
      }
      return { frozen: normalizeMaterials(frozen), revision: 0 };
    },
    async read(playerUid, operationId) {
      assertWagerFrozenKey(operationId);
      return snapshot(await client.getPath(path(playerUid)), operationId);
    },
    async transact(playerUid, operationId, update, signal) {
      assertWagerFrozenKey(operationId);
      const result = await client.transactPath(
        path(playerUid),
        (current) => {
          const decision = update(snapshot(current, operationId));
          if ("commit" in decision) return decision;
          const mining = record(current) || {};
          const operations = { ...(record(mining._wagerOps) || {}) };
          const operation = storedWagerFrozenOperation(
            decision.value.operation,
          );
          if (operation) operations[operationId] = operation;
          else delete operations[operationId];
          const next: Record<string, unknown> = {
            ...mining,
            frozen: decision.value.frozen,
          };
          if (Object.keys(operations).length) next._wagerOps = operations;
          else delete next._wagerOps;
          return { decision: decision.decision, value: next };
        },
        signal,
      );
      return { ...result, value: snapshot(result.value, operationId) };
    },
  };
}
