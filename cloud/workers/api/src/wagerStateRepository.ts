import type {
  TransactionDecision,
  TransactionResult,
} from "./repositoryContracts.ts";
import { isSafeRecordKey } from "./recordKeys.ts";
import { runOptimisticTransaction } from "./optimisticTransaction.ts";
import {
  createWagerStateD1Store,
  WagerStateD1Failure,
  type WagerStateD1Options,
  type WagerStateSnapshot,
} from "./wagerStateD1.ts";
import {
  sendProposalDecision,
  acceptProposalDecision,
  removeProposalDecision,
  markLineageReadyDecision,
  claimSettlementDecision,
  completeSettlementDecision,
  type WagerKey,
  type WagerRecord,
  type SendWagerProposalCommand,
  type AcceptWagerProposalCommand,
  type RemoveWagerProposalCommand,
  type MarkWagerLineageReadyCommand,
  type ClaimWagerSettlementCommand,
  type CompleteWagerSettlementCommand,
} from "./wagerStateCommands.ts";
export type {
  WagerKey,
  WagerRecord,
  ModernProposalLineage,
} from "./wagerStateCommands.ts";
export type WagerReader = {
  readInviteWagerPresence(
    inviteId: string,
    signal?: AbortSignal,
  ): Promise<{ wagerMatchIds: string[]; resolutionMatchIds: string[] }>;
  readWager(key: WagerKey, signal?: AbortSignal): Promise<WagerRecord | null>;
  readResolutionMarker(
    key: WagerKey,
    signal?: AbortSignal,
  ): Promise<boolean | null>;
  readInviteWagerState(
    inviteId: string,
    signal?: AbortSignal,
  ): Promise<WagerStateSnapshot[]>;
};
export type WagerWriter = WagerReader & {
  sendProposal(
    key: WagerKey,
    input: SendWagerProposalCommand,
    signal?: AbortSignal,
  ): Promise<TransactionResult<WagerRecord>>;
  acceptProposal(
    key: WagerKey,
    input: AcceptWagerProposalCommand,
    signal?: AbortSignal,
  ): Promise<TransactionResult<WagerRecord>>;
  removeProposal(
    key: WagerKey,
    input: RemoveWagerProposalCommand,
    signal?: AbortSignal,
  ): Promise<TransactionResult<WagerRecord>>;
  markLineageReady(
    key: WagerKey,
    input: MarkWagerLineageReadyCommand,
    signal?: AbortSignal,
  ): Promise<TransactionResult<WagerRecord>>;
  claimSettlement(
    key: WagerKey,
    input: ClaimWagerSettlementCommand,
    signal?: AbortSignal,
  ): Promise<TransactionResult<WagerRecord>>;
  completeSettlement(
    key: WagerKey,
    input: CompleteWagerSettlementCommand,
    signal?: AbortSignal,
  ): Promise<TransactionResult<WagerRecord>>;
};
export type WagerStateRepositoryOptions = WagerStateD1Options & {
  notify?: (inviteId: string, committed: boolean) => Promise<void>;
};
export function requireWagerWriter(repository: {
  wagerWriter?: WagerWriter;
}): WagerWriter {
  if (!repository.wagerWriter)
    throw new WagerStateD1Failure("wager-state-read-only");
  return repository.wagerWriter;
}
function normalizeJson(value: unknown): unknown {
  const active = new Set<object>();
  const normalize = (entry: unknown, depth: number): unknown => {
    if (depth > 64) throw new TypeError("invalid-wager-state-json");
    if (
      entry === null ||
      typeof entry === "string" ||
      typeof entry === "boolean" ||
      (typeof entry === "number" && Number.isFinite(entry))
    )
      return entry;
    if (!entry || typeof entry !== "object" || active.has(entry)) {
      throw new TypeError("invalid-wager-state-json");
    }
    const prototype = Object.getPrototypeOf(entry);
    if (
      !Array.isArray(entry) &&
      prototype !== Object.prototype &&
      prototype !== null
    ) {
      throw new TypeError("invalid-wager-state-json");
    }
    active.add(entry);
    let result: unknown;
    if (Array.isArray(entry)) {
      const values = entry.map((nested) => normalize(nested, depth + 1));
      result = values.some((nested) => nested !== null) ? values : null;
    } else {
      const values = Object.entries(entry)
        .map(([key, nested]) => {
          if (!isSafeRecordKey(key))
            throw new TypeError("invalid-wager-state-json");
          return [key, normalize(nested, depth + 1)] as const;
        })
        .filter(([, nested]) => nested !== null);
      result = values.length ? Object.fromEntries(values) : null;
    }
    active.delete(entry);
    return result;
  };
  return normalize(value, 0);
}

export function createWagerStateReader(db: D1Database): WagerReader {
  const store = createWagerStateD1Store(db);
  return {
    async readInviteWagerPresence(inviteId, signal) {
      const states = await store.readInvite(inviteId, signal, true);
      return {
        wagerMatchIds: states
          .filter((state) => state.wager !== null)
          .map((state) => state.matchId),
        resolutionMatchIds: states
          .filter((state) => state.resolutionMarker !== null)
          .map((state) => state.matchId),
      };
    },
    readWager: async (key, signal) =>
      (await store.read(key, signal)).wager as WagerRecord | null,
    readResolutionMarker: async (key, signal) =>
      (await store.read(key, signal)).resolutionMarker,
    readInviteWagerState: (inviteId, signal) =>
      store.readInvite(inviteId, signal),
  };
}
export function createWagerStateRepository(
  db: D1Database,
  options: WagerStateRepositoryOptions,
): WagerWriter {
  const store = createWagerStateD1Store(db, options);
  const notify = async (inviteId: string, committed: boolean) => {
    try {
      await options.notify?.(inviteId, committed);
    } catch {}
  };
  async function commitDecision(
    key: WagerKey,
    reduce: (current: unknown) => TransactionDecision<WagerRecord>,
    signal?: AbortSignal,
    complete = false,
  ): Promise<TransactionResult<WagerRecord>> {
    if (!options.writeGuards)
      throw new WagerStateD1Failure("wager-state-read-only");
    return runOptimisticTransaction({
      maxAttempts: 25,
      signal,
      read: () => store.read(key, signal),
      getValue: (current) => current.wager as WagerRecord | null,
      decide: (current) => reduce(structuredClone(current)),
      async write(current, next) {
        const wager = (
          complete ? next : normalizeJson(next)
        ) as WagerRecord | null;
        let committed: boolean;
        try {
          committed = await store.commit(
            [
              {
                current,
                value: {
                  wager,
                  resolutionMarker: complete ? true : current.resolutionMarker,
                },
              },
            ],
            signal,
          );
        } catch (error) {
          await notify(key.inviteId, false);
          throw error;
        }
        if (committed) {
          await notify(key.inviteId, true);
        }
        return { applied: committed, value: wager };
      },
      conflictError: () => new WagerStateD1Failure("wager-state-conflict"),
    });
  }
  return {
    ...createWagerStateReader(db),
    sendProposal: (key, input, signal) =>
      commitDecision(
        key,
        (current) => sendProposalDecision(current, input),
        signal,
      ),
    acceptProposal: (key, input, signal) =>
      commitDecision(
        key,
        (current) => acceptProposalDecision(current, input),
        signal,
      ),
    removeProposal: (key, input, signal) =>
      commitDecision(
        key,
        (current) => removeProposalDecision(current, input),
        signal,
      ),
    markLineageReady: (key, input, signal) =>
      commitDecision(
        key,
        (current) => markLineageReadyDecision(current, input),
        signal,
      ),
    claimSettlement: (key, input, signal) =>
      commitDecision(
        key,
        (current) => claimSettlementDecision(current, input),
        signal,
      ),
    completeSettlement: (key, input, signal) =>
      commitDecision(
        key,
        (current) => completeSettlementDecision(current, input),
        signal,
        true,
      ),
  };
}
