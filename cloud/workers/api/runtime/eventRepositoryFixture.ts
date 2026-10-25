import { matchCreationWireValue } from "../src/matchRecordCodec.ts";
import type {
  StateRepository,
  StateQuery,
} from "../test/stateRepositoryTestTypes.ts";
import type { MatchStatePort } from "../src/repositoryContracts.ts";
import type { EventStore } from "../src/eventStoreContracts.ts";
import type { TransactionDecision } from "../../../runtime/transactions.js";
import { matchTestPort } from "../test/gameSessionTestPorts.ts";
import { MATCH_TIMER_TERMINAL } from "@mons/shared/timers";
export function eventMatchTestPort(state: StateRepository): MatchStatePort {
  const port = matchTestPort(state);
  return {
    ...port,
    async createMatchRecords(input, signal) {
      for (const record of input.records)
        await state.transactPath(
          `players/${record.playerId}/matches/${record.matchId}`,
          (current) => {
            if (current !== null && current !== undefined) {
              if (
                typeof current === "object" &&
                (current as Record<string, unknown>).sessionCreation ===
                  record.marker
              )
                return { commit: false, decision: "applied" };
              throw new Error("event-match-creation-conflict");
            }
            return {
              value: {
                ...Object(matchCreationWireValue(record.value)),
                sessionCreation: record.marker,
              },
              decision: "created",
            };
          },
          signal,
        );
    },
    async applyMatchEventEffects(input, signal) {
      if (input.creations?.length)
        await this.createMatchRecords(
          {
            inviteId: input.inviteId,
            transitionId: input.operationId,
            records: input.creations,
          },
          signal,
        );
      const updates: Record<string, unknown> = {};
      for (const claim of input.claims || [])
        updates[`matchTimerClaims/${claim.matchId}`] = claim.claim;
      for (const timer of input.terminalTimers || [])
        updates[`players/${timer.playerId}/matches/${timer.matchId}/timer`] =
          MATCH_TIMER_TERMINAL;
      if (Object.keys(updates).length) await state.patchRoot(updates, signal);
    },
  };
}
export async function readEventRepositoryFixture(
  store: EventStore,
  path: string,
  query?: StateQuery,
): Promise<unknown> {
  const [root, id, ...parts] = path.split("/");
  if (root === "events" && id === undefined) {
    throw new Error("event-d1-query-unsupported");
  }
  if (query && Object.keys(query).length) {
    if (
      root === "profileEventPrizes" &&
      parts.length === 0 &&
      query.orderBy === "$key"
    )
      return store.listProfileEventPrizeAssignments(id, {
        startAt: typeof query.startAt === "string" ? query.startAt : undefined,
        limit: query.limitToFirst,
      });
    throw new Error("event-d1-query-unsupported");
  }
  const nested = (value: unknown, keys: string[]) =>
    keys.reduce(
      (current, key) =>
        current && typeof current === "object"
          ? ((current as Record<string, unknown>)[key] ?? null)
          : null,
      value,
    );
  if (root === "events") return nested(await store.readEvent(id), parts);
  if (root === "eventPrizeSelections")
    return nested(await store.readEventPrizeSelections(id), parts);
  if (root === "profileEventPrizes")
    return parts.length === 1
      ? store.readProfileEventPrizeAssignment(id, parts[0])
      : nested((await store.readProfileEventPrizes(id)).prizes, parts);
  if (root === "eventProgressOutbox") return store.readEventProgressOutbox(id);
  if (root === "profileGameProjectionOutbox" && id === "event")
    return store.readEventProfileGameProjectionOutbox(parts[0]);
  if (root === "telegramProjectionOutbox" && id === "event")
    return store.readEventTelegramProjectionOutbox(parts[0]);
  if (root === "eventTelegramProjectionGenerations")
    return (await store.readEventTelegramProjectionState(id))?.generation || 0;
  if (root === "eventTelegramProjections")
    return (await store.readEventTelegramProjectionState(id))?.state || null;
  throw new Error(
    root === "eventTransitionReceipts"
      ? "event-transition-receipt-path-reserved"
      : "unsupported-event-path",
  );
}
export async function transactEventRepositoryFixture(
  store: EventStore,
  path: string,
  updater: (current: unknown) => TransactionDecision<unknown>,
  signal?: AbortSignal,
) {
  const [root, id, ...parts] = path.split("/");
  if (
    root === "eventLocks" ||
    root === "eventTelegramProjectionLocks" ||
    root === "profileGameProjectionLocks"
  )
    return store.transactEventLease(
      {
        kind:
          root === "eventLocks"
            ? "event"
            : root === "eventTelegramProjectionLocks"
              ? "telegram-projection"
              : "profile-game-projection",
        id: root === "profileGameProjectionLocks" ? parts[0] : id,
      },
      updater as Parameters<EventStore["transactEventLease"]>[1],
      signal,
    );
  if (root === "eventPrizeSelections" && parts.length === 1)
    return store.transactEventPrizeSelection(
      id,
      parts[0],
      updater as Parameters<EventStore["transactEventPrizeSelection"]>[2],
      signal,
    );
  if (root === "profileEventPrizes" && parts.length === 1)
    return store.transactProfileEventPrize(
      id,
      parts[0],
      updater as Parameters<EventStore["transactProfileEventPrize"]>[2],
      signal,
    );
  throw new Error(
    root === "eventTransitionReceipts"
      ? "event-transition-receipt-path-reserved"
      : "unsupported-event-path",
  );
}
