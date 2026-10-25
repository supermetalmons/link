import type {
  WagerWriter,
  WagerKey,
  WagerRecord,
} from "../src/wagerStateRepository.ts";
import {
  sendProposalDecision,
  acceptProposalDecision,
  removeProposalDecision,
  markLineageReadyDecision,
  claimSettlementDecision,
  completeSettlementDecision,
} from "../src/wagerStateCommands.ts";
import type {
  TransactionDecision,
  TransactionResult,
} from "../src/repositoryContracts.ts";
import { decodeWager, type DecodedWager } from "../src/wagerModel.ts";

export type WagerTestState = {
  readState(
    path: string,
    query?: {
      shallow?: boolean;
      orderBy?: string;
      equalTo?: string | number | boolean | null;
      limitToFirst?: number;
    },
    signal?: AbortSignal,
  ): Promise<unknown>;
  transactState(
    path: string,
    update: (current: unknown) => unknown,
    signal?: AbortSignal,
  ): Promise<{ committed: boolean; decision?: string; value: unknown }>;
  patchStateRoot(
    updates: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<void>;
};

export function createMemoryWagerState(state: WagerTestState): WagerWriter {
  const path = (key: WagerKey) =>
    `invites/${key.inviteId}/wagers/${key.matchId}`;
  const transact = async (
    key: WagerKey,
    reduce: (current: DecodedWager | null) => TransactionDecision<WagerRecord>,
    signal?: AbortSignal,
  ): Promise<TransactionResult<DecodedWager>> => {
    const result = await state.transactState(
      path(key),
      (current) => reduce(decodeWager(current)),
      signal,
    );
    return { ...result, value: decodeWager(result.value) };
  };
  return {
    readWager: async (key, signal) =>
      decodeWager(await state.readState(path(key), undefined, signal)),
    readWagerSnapshot: async (key, signal) => {
      const [wager, resolutionMarker] = await Promise.all([
        state.readState(path(key), undefined, signal),
        state.readState(
          `invites/${key.inviteId}/matchesWagerResolutions/${key.matchId}`,
          undefined,
          signal,
        ),
      ]);
      return {
        wager: decodeWager(wager),
        resolutionMarker: resolutionMarker as boolean | null,
      };
    },
    sendProposal: (key, input, signal) =>
      transact(key, (current) => sendProposalDecision(current, input), signal),
    acceptProposal: (key, input, signal) =>
      transact(
        key,
        (current) => acceptProposalDecision(current, input),
        signal,
      ),
    removeProposal: (key, input, signal) =>
      transact(
        key,
        (current) => removeProposalDecision(current, input),
        signal,
      ),
    markLineageReady: (key, input, signal) =>
      transact(
        key,
        (current) => markLineageReadyDecision(current, input),
        signal,
      ),
    claimSettlement: (key, input, signal) =>
      transact(
        key,
        (current) => claimSettlementDecision(current, input),
        signal,
      ),
    async completeSettlement(key, input, signal) {
      const current = decodeWager(
        await state.readState(path(key), undefined, signal),
      );
      const decision = completeSettlementDecision(current, input);
      if ("commit" in decision)
        return {
          committed: false,
          decision: decision.decision,
          value: current,
        };
      const updates: Record<string, unknown> = {
        [`${path(key)}/settlement/state`]: "completed",
        [`${path(key)}/settlement/completedAtMs`]: input.completedAtMs,
        [`${path(key)}/proposals`]: null,
        [`invites/${key.inviteId}/matchesWagerResolutions/${key.matchId}`]: true,
      };
      if (input.insufficientMaterials) {
        updates[`${path(key)}/settlement/failureReason`] =
          "insufficient-materials";
        updates[`${path(key)}/agreed`] = null;
      } else if (input.settlement.kind === "agreed")
        updates[`${path(key)}/resolved`] = decision.value?.resolved;
      await state.patchStateRoot(updates, signal);
      return { committed: true, value: decodeWager(decision.value) };
    },
  };
}
