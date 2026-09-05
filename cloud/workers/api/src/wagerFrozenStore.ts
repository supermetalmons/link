import type { MiningMaterials } from "@mons/shared/mining";
import type { FrozenOperationState } from "./wagerFrozenRecords.ts";

export type WagerFrozenBalance = {
  frozen: MiningMaterials;
  revision: number;
};

export type WagerFrozenSnapshot = {
  frozen: MiningMaterials;
  operation: FrozenOperationState;
};

export type WagerFrozenDecision =
  | { commit: false; decision: string }
  | { decision?: string; value: WagerFrozenSnapshot };

export type WagerFrozenTransactionResult = {
  committed: boolean;
  decision?: string;
  value: WagerFrozenSnapshot;
};

export type WagerFrozenStore = {
  readBalance: (playerUid: string) => Promise<WagerFrozenBalance>;
  read: (
    playerUid: string,
    operationId: string,
  ) => Promise<WagerFrozenSnapshot>;
  transact: (
    playerUid: string,
    operationId: string,
    update: (current: WagerFrozenSnapshot) => WagerFrozenDecision,
    signal?: AbortSignal,
  ) => Promise<WagerFrozenTransactionResult>;
};

export function requireWagerFrozenStore(repository: {
  wagerFrozen?: WagerFrozenStore;
}): WagerFrozenStore {
  if (!repository.wagerFrozen) throw new Error("wager-operation-unavailable");
  return repository.wagerFrozen;
}

export function assertWagerFrozenKey(value: string): void {
  if (
    typeof value !== "string" ||
    !value ||
    Array.from(value).some(
      (character) =>
        ".#$[]/".includes(character) ||
        character.charCodeAt(0) < 32 ||
        character.charCodeAt(0) === 127,
    )
  ) {
    throw new TypeError("invalid-wager-frozen-key");
  }
}

export function storedWagerFrozenOperation(
  state: FrozenOperationState,
): Record<string, unknown> | null {
  if (state.status === "absent") return null;
  if (state.status === "consumed") return { consumed: true };
  if (state.status === "malformed")
    throw new Error("wager-operation-unavailable");
  const { appliedAtMs, count, deltas, fingerprint } = state.operation;
  return {
    appliedAtMs,
    ...(count === undefined ? {} : { count }),
    deltas,
    fingerprint,
  };
}
