import { retainEventProjectionOutbox } from "../../../runtime/eventProjectionOutboxRecords.js";
import type {
  TransactionDecision,
  TransactionResult,
} from "../../../runtime/transactions.js";
import type { EventStore } from "../src/eventStoreContracts.ts";
import { recoveryScanIdentityFixture } from "./recoveryScanPageFixture.ts";
import {
  repairEventProfileProjectionRecord,
  markInvalidEventTelegramProjectionRecord,
} from "../src/eventProjectionRecoveryRecords.ts";
import type {
  EventProjectionRecoveryKind,
  EventProjectionRecoverySnapshot,
  EventProjectionRecoveryStore,
  EventProjectionRecoveryWriter,
} from "../src/eventProjectionRecoveryD1.ts";

export type LegacyEventProjectionTransaction = (
  eventId: string,
  updater: (current: unknown) => TransactionDecision<unknown>,
  signal?: AbortSignal,
) => Promise<TransactionResult<unknown>>;
export type LegacyEventProjectionTransactions = {
  transactEventProfileGameProjectionOutbox: LegacyEventProjectionTransaction;
  transactEventTelegramProjectionOutbox: LegacyEventProjectionTransaction;
};

type LegacyRecoveryWriter = { transact: LegacyEventProjectionTransaction };
export function profileProjectionRepairWriterFixture(
  writer: LegacyRecoveryWriter,
): Pick<EventProjectionRecoveryWriter<"profile-game">, "repairInvalid"> {
  return {
    repairInvalid: (eventId, input, signal) =>
      writer.transact(
        eventId,
        (current) =>
          repairEventProfileProjectionRecord(
            retainEventProjectionOutbox("profile-game", current),
            input,
          ),
        signal,
      ) as ReturnType<
        EventProjectionRecoveryWriter<"profile-game">["repairInvalid"]
      >,
  };
}
export function profileProjectionWriterFixture(
  writer: LegacyRecoveryWriter &
    Pick<EventProjectionRecoveryWriter<"profile-game">, "claim">,
): EventProjectionRecoveryWriter<"profile-game"> {
  return {
    claim: (...args) => writer.claim(...args),
    ...profileProjectionRepairWriterFixture(writer),
  };
}
export function telegramProjectionRepairWriterFixture(
  writer: LegacyRecoveryWriter,
): Pick<EventProjectionRecoveryWriter<"telegram">, "markInvalid"> {
  return {
    markInvalid: (eventId, nowMs, signal) =>
      writer.transact(
        eventId,
        (current) =>
          markInvalidEventTelegramProjectionRecord(
            retainEventProjectionOutbox("telegram", current),
            eventId,
            nowMs,
          ),
        signal,
      ) as ReturnType<EventProjectionRecoveryWriter<"telegram">["markInvalid"]>,
  };
}
export function claimRecoveryFixture(
  writer: EventProjectionRecoveryWriter,
  snapshot: unknown,
  requestId: string,
  expected: number,
  nowMs: number,
  signal?: AbortSignal,
): Promise<boolean> {
  return Reflect.apply(writer.claim, writer, [
    snapshot,
    requestId,
    expected,
    nowMs,
    signal,
  ]);
}
export function projectionSnapshotRecordFixture<
  Kind extends EventProjectionRecoveryKind,
>(
  snapshot: EventProjectionRecoverySnapshot<Kind>,
  record: unknown,
): EventProjectionRecoverySnapshot<Kind> {
  return {
    ...snapshot,
    record: retainEventProjectionOutbox(snapshot.kind, record),
  } as EventProjectionRecoverySnapshot<Kind>;
}
function snapshotFixture<Kind extends EventProjectionRecoveryKind>(
  kind: Kind,
  eventId: string,
  record: unknown,
): EventProjectionRecoverySnapshot<Kind> {
  return {
    kind,
    eventId,
    record: retainEventProjectionOutbox(kind, record),
    recordJson: JSON.stringify(record) ?? "null",
  } as EventProjectionRecoverySnapshot<Kind>;
}
function recoveryFixture<Kind extends EventProjectionRecoveryKind>(
  kind: Kind,
  listDue: (
    beforeMs: number,
    limit: number,
  ) => Promise<Array<{ eventId: string; record: unknown }>>,
  writer: EventProjectionRecoveryWriter<Kind>,
): EventProjectionRecoveryStore<Kind> {
  return {
    async listDue(beforeMs, limit) {
      return (await listDue(beforeMs, limit)).map(({ eventId, record }) =>
        snapshotFixture(kind, eventId, record),
      );
    },
    async listDuePage(beforeMs, limit, excludedIdentities = []) {
      const entries = (
        await listDue(beforeMs, limit + excludedIdentities.length)
      )
        .filter(({ eventId }) => {
          const identity = recoveryScanIdentityFixture(eventId);
          return identity === null || !excludedIdentities.includes(identity);
        })
        .slice(0, limit)
        .map(({ eventId, record }) => snapshotFixture(kind, eventId, record));
      return {
        entries,
        scannedIdentities: entries.map(({ eventId }) =>
          recoveryScanIdentityFixture(eventId),
        ),
      };
    },
    withAdmission: (work) => work(writer),
  };
}
export function profileGameProjectionRecoveryFixture(
  source: Pick<EventStore, "claimEventProfileGameProjectionOutbox"> &
    Pick<
      LegacyEventProjectionTransactions,
      "transactEventProfileGameProjectionOutbox"
    > & {
      listDueEventProfileGameProjectionOutboxes(
        beforeMs: number,
        limit?: number,
      ): Promise<Array<{ eventId: string; record: unknown }>>;
    },
): EventProjectionRecoveryStore<"profile-game"> {
  return recoveryFixture(
    "profile-game",
    (beforeMs, limit) =>
      source.listDueEventProfileGameProjectionOutboxes(beforeMs, limit),
    {
      claim: (snapshot, requestId, expected, nowMs, signal) =>
        source.claimEventProfileGameProjectionOutbox(
          snapshot.eventId,
          requestId,
          expected,
          nowMs,
          signal,
        ),
      ...profileProjectionRepairWriterFixture({
        transact: (...args) =>
          source.transactEventProfileGameProjectionOutbox(...args),
      }),
    },
  );
}
export function telegramProjectionRecoveryFixture(
  source: Pick<EventStore, "claimEventTelegramProjectionOutbox"> &
    Pick<
      LegacyEventProjectionTransactions,
      "transactEventTelegramProjectionOutbox"
    > & {
      listDueEventTelegramProjectionOutboxes(
        beforeMs: number,
        limit?: number,
      ): Promise<Array<{ eventId: string; record: unknown }>>;
    },
): EventProjectionRecoveryStore<"telegram"> {
  return recoveryFixture(
    "telegram",
    (beforeMs, limit) =>
      source.listDueEventTelegramProjectionOutboxes(beforeMs, limit),
    {
      claim: (snapshot, requestId, expected, nowMs, signal) =>
        source.claimEventTelegramProjectionOutbox(
          snapshot.eventId,
          requestId,
          expected,
          nowMs,
          signal,
        ),
      ...telegramProjectionRepairWriterFixture({
        transact: (...args) =>
          source.transactEventTelegramProjectionOutbox(...args),
      }),
    },
  );
}
