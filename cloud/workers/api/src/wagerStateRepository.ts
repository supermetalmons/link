import {
  decodeWager,
  parseWagerRecord,
  type DecodedWager,
} from "./wagerModel.ts";
import type {
  TransactionDecision,
  TransactionResult,
} from "./repositoryContracts.ts";
import { runOptimisticTransaction } from "./optimisticTransaction.ts";
import {
  createWagerStateD1Store,
  WagerStateD1Failure,
  type WagerStateD1Options,
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
type WagerReadSnapshot = {
  wager: DecodedWager | null;
  resolutionMarker: boolean | null;
};
export type WagerReader = {
  readWager(key: WagerKey, signal?: AbortSignal): Promise<DecodedWager | null>;
  readWagerSnapshot(
    key: WagerKey,
    signal?: AbortSignal,
  ): Promise<WagerReadSnapshot>;
};
export type WagerWriter = WagerReader & {
  sendProposal(
    key: WagerKey,
    input: SendWagerProposalCommand,
    signal?: AbortSignal,
  ): Promise<TransactionResult<DecodedWager>>;
  acceptProposal(
    key: WagerKey,
    input: AcceptWagerProposalCommand,
    signal?: AbortSignal,
  ): Promise<TransactionResult<DecodedWager>>;
  removeProposal(
    key: WagerKey,
    input: RemoveWagerProposalCommand,
    signal?: AbortSignal,
  ): Promise<TransactionResult<DecodedWager>>;
  markLineageReady(
    key: WagerKey,
    input: MarkWagerLineageReadyCommand,
    signal?: AbortSignal,
  ): Promise<TransactionResult<DecodedWager>>;
  claimSettlement(
    key: WagerKey,
    input: ClaimWagerSettlementCommand,
    signal?: AbortSignal,
  ): Promise<TransactionResult<DecodedWager>>;
  completeSettlement(
    key: WagerKey,
    input: CompleteWagerSettlementCommand,
    signal?: AbortSignal,
  ): Promise<TransactionResult<DecodedWager>>;
};
export type WagerStateRepositoryOptions = WagerStateD1Options & {
  notify?: (inviteId: string, committed: boolean) => Promise<void>;
};
export function createWagerStateReader(db: D1Database): WagerReader {
  const store = createWagerStateD1Store(db);
  const readWagerSnapshot = async (
    key: WagerKey,
    signal?: AbortSignal,
  ): Promise<WagerReadSnapshot> => {
    const snapshot = await store.read(key, signal);
    return {
      wager: decodeWager(snapshot.wager),
      resolutionMarker: snapshot.resolutionMarker,
    };
  };
  return {
    readWager: async (key, signal) =>
      (await readWagerSnapshot(key, signal)).wager,
    readWagerSnapshot,
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
    reduce: (current: DecodedWager | null) => TransactionDecision<WagerRecord>,
    signal?: AbortSignal,
    complete = false,
  ): Promise<TransactionResult<DecodedWager>> {
    if (!options.writeGuards)
      throw new WagerStateD1Failure("wager-state-read-only");
    return runOptimisticTransaction({
      maxAttempts: 25,
      ...(signal === undefined ? {} : { signal }),
      read: () => store.read(key, signal),
      getValue: (current) => decodeWager(current.wager),
      decide: (current) => reduce(structuredClone(current)),
      async write(current, next) {
        const wager = parseWagerRecord(next);
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
        return { applied: committed, value: decodeWager(wager) };
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
