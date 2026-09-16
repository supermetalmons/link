import type { StateQuery } from "../test/stateRepositoryTestTypes.ts";
import { encodeEventUpdates } from "../src/eventCompatibilityCodec.ts";
import type { EventStore } from "../src/eventStoreContracts.ts";
import type { MatchStatePort } from "../src/repositoryContracts.ts";
import type { EventLeaseKey } from "../../../runtime/eventLeases.js";
import type {
  TransactionDecision,
  TransactionResult,
} from "../../../runtime/transactions.js";
export type EventTestSource = {
  getStatePath?: (
    path: string,
    query?: StateQuery,
    signal?: AbortSignal,
  ) => Promise<unknown>;
  patchStateRoot?: (
    updates: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<void>;
  transactStatePath?: (
    path: string,
    updater: (current: unknown) => unknown,
    signal?: AbortSignal,
  ) => Promise<TransactionResult<unknown>>;
  getPath?: (
    path: string,
    query?: StateQuery,
    signal?: AbortSignal,
  ) => Promise<unknown>;
  patchRoot?: (
    updates: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<void>;
  transactPath?: (
    path: string,
    updater: (current: unknown) => unknown,
    signal?: AbortSignal,
  ) => Promise<TransactionResult<unknown>>;
  read?: (path: string) => Promise<unknown>;
  update?: (path: string, updates: Record<string, unknown>) => Promise<void>;
  transaction?: (
    path: string,
    updater: (current: unknown) => unknown,
  ) => Promise<TransactionResult<unknown>>;
  [key: string]: unknown;
};
export function eventTestLeasePath(key: EventLeaseKey): string {
  const roots = {
    event: "eventLocks",
    "telegram-projection": "eventTelegramProjectionLocks",
    "profile-game-projection": "profileGameProjectionLocks/event",
    transition: "eventLocks",
  };
  return `${roots[key.kind]}/${key.kind === "transition" ? "transition:" : ""}${key.id}`;
}
export function attachEventTestPorts<T>(
  source: Partial<T> & EventTestSource,
): T & EventStore {
  const read = async (path: string, signal?: AbortSignal) => {
    if (source.getStatePath)
      return source.getStatePath(path, undefined, signal);
    if (source.getPath) return source.getPath(path, undefined, signal);
    if (source.read) return source.read(path);
    return null;
  };
  const transact = async <V>(
    path: string,
    updater: (current: V | null) => TransactionDecision<V>,
    signal?: AbortSignal,
  ): Promise<TransactionResult<V>> => {
    const update = (current: unknown) => updater(current as V | null);
    if (source.transactStatePath)
      return source.transactStatePath(path, update, signal) as Promise<
        TransactionResult<V>
      >;
    if (source.transactPath)
      return source.transactPath(path, update, signal) as Promise<
        TransactionResult<V>
      >;
    if (source.transaction)
      return source.transaction(path, (current) => {
        const decision = update(current);
        return "commit" in decision ? undefined : decision.value;
      }) as Promise<TransactionResult<V>>;
    throw new Error("test transaction missing");
  };
  const ports: Pick<
    EventStore,
    | "commitEventPlan"
    | "putEventProgressOutbox"
    | "transactEventLease"
    | "transactEventSyncThrottle"
    | "transactEventPrizeSelection"
    | "transactProfileEventPrize"
    | "transactStoredProfileEventPrizeWithEventLease"
    | "readEventProgressOutbox"
    | "readEventProfileGameProjectionOutbox"
    | "readEventTelegramProjectionOutbox"
    | "readEventTelegramProjectionState"
    | "transactEventProgressOutbox"
    | "transactEventProgressDeadOutbox"
    | "transactEventProfileGameProjectionOutbox"
    | "transactEventTelegramProjectionOutbox"
    | "transactEventTelegramProjectionState"
  > = {
    async commitEventPlan(plan, signal) {
      const updates = encodeEventUpdates(plan);
      if (source.patchStateRoot) return source.patchStateRoot(updates, signal);
      if (source.patchRoot) return source.patchRoot(updates, signal);
      if (source.update) return source.update("", updates);
      throw new Error("test commit missing");
    },
    async putEventProgressOutbox(outboxId, record, signal) {
      await ports.commitEventPlan(
        [{ kind: "progress-outbox", outboxId, value: record }],
        signal,
      );
    },
    transactEventLease: (key, updater, signal) =>
      transact(eventTestLeasePath(key), updater, signal),
    transactEventSyncThrottle: (id, updater, signal) =>
      transact(`eventSyncThrottles/${id}`, updater, signal),
    transactEventPrizeSelection: (id, profileId, updater, signal) =>
      transact(`eventPrizeSelections/${id}/${profileId}`, updater, signal),
    transactProfileEventPrize: (profileId, id, updater, signal) =>
      transact(`profileEventPrizes/${profileId}/${id}`, updater, signal),
    transactStoredProfileEventPrizeWithEventLease: (
      profileId,
      id,
      updater,
      _guard,
      signal,
    ) => transact(`profileEventPrizes/${profileId}/${id}`, updater, signal),
    readEventProgressOutbox: (id, signal) =>
      read(`eventProgressOutbox/${id}`, signal) as ReturnType<
        EventStore["readEventProgressOutbox"]
      >,
    readEventProfileGameProjectionOutbox: (id, signal) =>
      read(`profileGameProjectionOutbox/event/${id}`, signal) as ReturnType<
        EventStore["readEventProfileGameProjectionOutbox"]
      >,
    readEventTelegramProjectionOutbox: (id, signal) =>
      read(`telegramProjectionOutbox/event/${id}`, signal) as ReturnType<
        EventStore["readEventTelegramProjectionOutbox"]
      >,
    async readEventTelegramProjectionState(id, signal) {
      const [state, generation] = await Promise.all([
        read(`eventTelegramProjections/${id}`, signal),
        read(`eventTelegramProjectionGenerations/${id}`, signal),
      ]);
      return {
        state: (state || {}) as Record<string, unknown>,
        generation: typeof generation === "number" ? generation : 0,
        revision: 1,
      };
    },
    transactEventProgressOutbox: (id, updater, signal) =>
      transact(`eventProgressOutbox/${id}`, updater, signal),
    transactEventProgressDeadOutbox: (id, updater, signal) =>
      transact(`eventProgressOutboxDead/${id}`, updater, signal),
    transactEventProfileGameProjectionOutbox: (id, updater, signal) =>
      transact(`profileGameProjectionOutbox/event/${id}`, updater, signal),
    transactEventTelegramProjectionOutbox: (id, updater, signal) =>
      transact(`telegramProjectionOutbox/event/${id}`, updater, signal),
    transactEventTelegramProjectionState: (id, updater, signal) =>
      transact(`eventTelegramProjections/${id}`, updater, signal),
  };
  if (typeof source.readMatchRecord !== "function")
    (source as EventTestSource).readMatchRecord = (
      { playerId, matchId }: { playerId: string; matchId: string },
      signal?: AbortSignal,
    ) => read(`players/${playerId}/matches/${matchId}`, signal);
  if (typeof source.readMatchPair !== "function")
    (source as EventTestSource).readMatchPair = (
      {
        playerId,
        opponentId,
        matchId,
      }: { playerId: string; opponentId: string; matchId: string },
      signal?: AbortSignal,
    ) =>
      Promise.all([
        read(`players/${playerId}/matches/${matchId}`, signal),
        read(`players/${opponentId}/matches/${matchId}`, signal),
      ]).then(([playerMatch, opponentMatch]) => ({
        playerMatch,
        opponentMatch,
        claim: null,
        epoch: 1,
        revision: 1,
      }));
  if (typeof source.readMatchPairs !== "function")
    (source as EventTestSource).readMatchPairs = (
      inputs: Parameters<MatchStatePort["readMatchPairs"]>[0],
      signal?: AbortSignal,
    ) =>
      Promise.all(
        inputs.map((input) =>
          (source.readMatchPair as MatchStatePort["readMatchPair"]).call(
            source,
            input,
            signal,
          ),
        ),
      );
  return Object.assign(source, ports) as T & EventStore;
}
