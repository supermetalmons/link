import {
  createMemoryWagerState,
  type WagerTestState,
} from "./wagerStateTestUtils.ts";
import { normalizeMaterials } from "@mons/shared/mining";
import { createAutomatchPersistenceStub } from "./automatchPersistenceTestUtils.ts";
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

export type TestGameplayRepository = GameplayRepository & WagerTestState;

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
  state: WagerTestState &
    Pick<
      GameplayRepository,
      | "applyWagerTransferOnce"
      | "deleteNavigationGame"
      | "getNavigationGame"
      | "getMiningMaterials"
      | "getMiningSnapshot"
      | "readProfileOwnershipSnapshot"
    > &
    Partial<GameplayRepository>,
): TestGameplayRepository {
  const unexpected = async () => {
    throw new Error("unexpected-gameplay-operation");
  };
  const repository = {
    automatchPersistence: createAutomatchPersistenceStub(),
    readAutomatchTelegramSource: unexpected,
    transactAutomatchTelegramSource: unexpected,
    readAutomatchTelegramOutbox: unexpected,
    transactAutomatchTelegramOutbox: unexpected,
    listDueAutomatchTelegramOutboxes: unexpected,
    readAutomatchProfileOutbox: unexpected,
    transactAutomatchProfileOutbox: unexpected,
    listDueAutomatchProfileOutboxes: unexpected,
    listMalformedAutomatchProfileOutboxes: unexpected,
    readAutomatchEntry: unexpected,
    listAutomatchEntriesByLogin: unexpected,
    readFirstAutomatchEntry: unexpected,
    readMutationReceipt: unexpected,
    commitSessionChanges: unexpected,
    createMatchRecords: unexpected,
    applyMatchEventEffects: unexpected,
    readMatchRecord: async (
      { playerId, matchId }: { playerId: string; matchId: string },
      signal?: AbortSignal,
    ) =>
      (await state.readState(
        `players/${playerId}/matches/${matchId}`,
        undefined,
        signal,
      )) as import("../src/matchStateTypes.ts").MatchStateRecord | null,
    ...state,
    readInviteMetadata:
      state.readInviteMetadata ??
      (async (inviteId, signal) =>
        (await repository.readState(
          `invites/${inviteId}`,
          undefined,
          signal,
        )) as Record<string, unknown> | null),
  } as TestGameplayRepository;
  const wagerState = createMemoryWagerState(repository);
  repository.wagers ??= wagerState;
  repository.wagerWriter ??= wagerState;
  repository.readMatchPair ??= async (input, signal) => ({
    ...input,
    epoch: 1,
    revision: 1,
    claim: null,
    playerMatch: (await repository.readState(
      `players/${input.playerId}/matches/${input.matchId}`,
      undefined,
      signal,
    )) as import("../src/matchStateTypes.ts").MatchStateRecord | null,
    opponentMatch: input.opponentId
      ? ((await repository.readState(
          `players/${input.opponentId}/matches/${input.matchId}`,
          undefined,
          signal,
        )) as import("../src/matchStateTypes.ts").MatchStateRecord | null)
      : null,
  });
  repository.readMatchPairs ??= (inputs, signal) =>
    Promise.all(inputs.map((input) => repository.readMatchPair(input, signal)));
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
