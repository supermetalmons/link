import * as projectionTransactions from "../src/eventD1/transactions.ts";
import * as d1 from "../src/eventD1.ts";
import { decodeEventUpdates } from "../src/eventCompatibilityCodec.ts";
import { isEventMutation } from "../../../runtime/eventCommands.js";
import type { TransactionDecision } from "../../../runtime/transactions.js";
export async function patchEventOwnedPaths(
  db: d1.EventD1Connection,
  updates: Record<string, unknown>,
  options: Parameters<typeof d1.commitEventMutations>[2],
) {
  const changes = decodeEventUpdates(updates);
  if (changes.some((command) => !isEventMutation(command)))
    throw new d1.EventD1Failure("unsupported-event-path");
  return d1.commitEventMutations(db, changes.filter(isEventMutation), options);
}
export async function readEventOwnedPath(
  db: d1.EventD1Connection,
  path: string,
): Promise<unknown> {
  const [root, id, ...parts] = path.split("/");
  const nested = (value: unknown, keys: string[]) =>
    keys.reduce(
      (current, key) =>
        current && typeof current === "object"
          ? ((current as Record<string, unknown>)[key] ?? null)
          : null,
      value,
    );
  if (root === "events")
    return nested((await d1.readEventSnapshot(db, id)).event, parts);
  if (root === "eventPrizeSelections")
    return nested((await d1.readEventSnapshot(db, id)).prizeSelections, parts);
  if (root === "profileEventPrizes")
    return nested((await d1.readProfileEventPrizes(db, id)).prizes, parts);
  if (root === "eventProgressOutbox")
    return nested(await d1.readEventProgressOutbox(db, id), parts);
  if (root === "eventProgressOutboxDead")
    return d1.readEventProgressDeadOutbox(db, id);
  if (root === "profileGameProjectionOutbox" && id === "event")
    return d1.readEventProfileGameProjectionOutbox(db, parts[0]);
  if (root === "telegramProjectionOutbox" && id === "event")
    return d1.readEventTelegramProjectionOutbox(db, parts[0]);
  if (root === "eventTelegramProjectionGenerations")
    return (await d1.readEventTelegramProjectionState(db, id))?.generation || 0;
  if (root === "eventTelegramProjections")
    return (await d1.readEventTelegramProjectionState(db, id))?.state || null;
  if (root === "eventLocks") return d1.readEventLease(db, id);
  if (root === "eventSyncThrottles") return d1.readEventSyncThrottle(db, id);
  throw new d1.EventD1Failure("unsupported-event-path");
}
export async function transactEventOwnedPath(
  db: d1.EventD1Connection,
  path: string,
  updater: (current: unknown) => TransactionDecision<unknown>,
  options: Parameters<typeof d1.transactEventRecord>[3],
) {
  const [root, id, ...parts] = path.split("/");
  if (root === "events" && parts.length === 0)
    return d1.transactEventRecord(
      db,
      id,
      updater as Parameters<typeof d1.transactEventRecord>[2],
      options,
    );
  if (root === "events" && parts.length === 1)
    return d1.transactEventField(
      db,
      id,
      parts[0] as Parameters<typeof d1.transactEventField>[2],
      updater as Parameters<typeof d1.transactEventField>[3],
      options,
    );
  if (root === "eventPrizeSelections" && parts.length === 0)
    return d1.transactEventPrizeSelections(
      db,
      id,
      updater as Parameters<typeof d1.transactEventPrizeSelections>[2],
      options,
    );
  if (root === "eventPrizeSelections" && parts.length === 1)
    return d1.transactEventPrizeSelection(
      db,
      id,
      parts[0],
      updater as Parameters<typeof d1.transactEventPrizeSelection>[3],
      options,
    );
  if (root === "profileEventPrizes" && parts.length === 1)
    return d1.transactProfileEventPrize(
      db,
      id,
      parts[0],
      updater as Parameters<typeof d1.transactProfileEventPrize>[3],
      options,
    );
  if (root === "eventProgressOutbox")
    return d1.transactEventProgressOutbox(
      db,
      id,
      updater as Parameters<typeof d1.transactEventProgressOutbox>[2],
      options,
    );
  if (root === "eventProgressOutboxDead")
    return d1.transactEventProgressDeadOutbox(
      db,
      id,
      updater as Parameters<typeof d1.transactEventProgressDeadOutbox>[2],
      options,
    );
  if (root === "profileGameProjectionOutbox" && id === "event")
    return projectionTransactions.transactEventProfileGameProjectionOutbox(
      db,
      parts[0],
      updater as Parameters<
        typeof projectionTransactions.transactEventProfileGameProjectionOutbox
      >[2],
      options,
    );
  if (root === "telegramProjectionOutbox" && id === "event")
    return projectionTransactions.transactEventTelegramProjectionOutbox(
      db,
      parts[0],
      updater as Parameters<
        typeof projectionTransactions.transactEventTelegramProjectionOutbox
      >[2],
      options,
    );
  if (root === "eventTelegramProjectionGenerations")
    return d1.transactEventTelegramProjectionGeneration(
      db,
      id,
      updater as Parameters<
        typeof d1.transactEventTelegramProjectionGeneration
      >[2],
      options,
    );
  if (root === "eventTelegramProjections")
    return d1.transactEventTelegramProjectionState(
      db,
      id,
      updater as Parameters<typeof d1.transactEventTelegramProjectionState>[2],
      options,
    );
  if (root === "eventLocks")
    return d1.transactEventLease(
      db,
      id,
      updater as Parameters<typeof d1.transactEventLease>[2],
      options,
    );
  if (root === "eventSyncThrottles")
    return d1.transactEventSyncThrottle(
      db,
      id,
      updater as Parameters<typeof d1.transactEventSyncThrottle>[2],
      options,
    );
  throw new d1.EventD1Failure("unsupported-event-path");
}
