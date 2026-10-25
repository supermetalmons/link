import type { EventProjectionOutboxDocument } from "../../../runtime/eventProjectionOutboxRecords.js";
import type { TransactionResult } from "../../../runtime/transactions.js";
import {
  repairEventProfileProjectionRecord,
  markInvalidEventTelegramProjectionRecord,
  type EventProfileProjectionRepair,
} from "./eventProjectionRecoveryRecords.ts";
import {
  listDueProjectionOutboxSnapshots,
  listDueProjectionOutboxSnapshotsPage,
  type ProjectionOutboxKind,
  type ProjectionOutboxSnapshot,
} from "./eventD1/reads.ts";
import { claimEventProjectionOutboxSnapshot } from "./eventD1/projectionOutboxes.ts";
import {
  transactEventProfileGameProjectionOutbox,
  transactEventTelegramProjectionOutbox,
} from "./eventD1/transactions.ts";
import { EventD1Failure, type EventD1Connection } from "./eventD1/types.ts";
import { withEventWriteAdmission } from "./eventWriteAdmission.ts";
import type { RecoveryScanPage } from "./recoveryScanPage.ts";

export type EventProjectionRecoveryKind = ProjectionOutboxKind;
export type EventProjectionRecoverySnapshot<
  Kind extends EventProjectionRecoveryKind = EventProjectionRecoveryKind,
> = ProjectionOutboxSnapshot<Kind>;

type EventProjectionRecoveryClaim<Kind extends EventProjectionRecoveryKind> = {
  claim(
    snapshot: EventProjectionRecoverySnapshot<Kind>,
    requestId: string,
    expectedTimestamp: number,
    nowMs: number,
    signal?: AbortSignal,
  ): Promise<boolean>;
};
type EventProjectionRecoveryWriters = {
  "profile-game": EventProjectionRecoveryClaim<"profile-game"> & {
    repairInvalid(
      eventId: string,
      input: EventProfileProjectionRepair,
      signal?: AbortSignal,
    ): Promise<
      TransactionResult<EventProjectionOutboxDocument<"profile-game">>
    >;
  };
  telegram: EventProjectionRecoveryClaim<"telegram"> & {
    markInvalid(
      eventId: string,
      nowMs: number,
      signal?: AbortSignal,
    ): Promise<TransactionResult<EventProjectionOutboxDocument<"telegram">>>;
  };
};
export type EventProjectionRecoveryWriter<
  Kind extends EventProjectionRecoveryKind = EventProjectionRecoveryKind,
> = EventProjectionRecoveryWriters[Kind];

export type EventProjectionRecoveryStore<
  Kind extends EventProjectionRecoveryKind = EventProjectionRecoveryKind,
> = {
  listDue(
    beforeMs: number,
    limit: number,
  ): Promise<EventProjectionRecoverySnapshot<Kind>[]>;
  listDuePage(
    beforeMs: number,
    limit: number,
    excludedIdentities?: readonly string[],
  ): Promise<RecoveryScanPage<EventProjectionRecoverySnapshot<Kind>[]>>;
  withAdmission<T>(
    work: (writer: EventProjectionRecoveryWriter<Kind>) => Promise<T>,
  ): Promise<T>;
};

export function createEventProjectionRecoveryStore<
  Kind extends EventProjectionRecoveryKind,
>(db: EventD1Connection, kind: Kind): EventProjectionRecoveryStore<Kind> {
  return {
    listDue: (beforeMs, limit) =>
      listDueProjectionOutboxSnapshots(db, kind, beforeMs, limit),
    listDuePage: (beforeMs, limit, excludedIdentities) =>
      listDueProjectionOutboxSnapshotsPage(
        db,
        kind,
        beforeMs,
        limit,
        excludedIdentities,
      ),
    withAdmission: (work) =>
      withEventWriteAdmission(
        db,
        { kind: "mutation", context: "event-path-transaction" },
        (admission) => {
          const claim: EventProjectionRecoveryClaim<EventProjectionRecoveryKind>["claim"] =
            (snapshot, requestId, expectedTimestamp, nowMs, signal) => {
              if (snapshot.kind !== kind) {
                return Promise.reject(
                  new EventD1Failure("event-projection-recovery-kind-mismatch"),
                );
              }
              return claimEventProjectionOutboxSnapshot(
                db,
                snapshot,
                requestId,
                expectedTimestamp,
                nowMs,
                { admission, signal },
              );
            };
          const writers: EventProjectionRecoveryWriters = {
            "profile-game": {
              claim,
              repairInvalid: (eventId, input, signal) =>
                transactEventProfileGameProjectionOutbox(
                  db,
                  eventId,
                  (current) =>
                    repairEventProfileProjectionRecord(current, input),
                  { admission, signal },
                ),
            },
            telegram: {
              claim,
              markInvalid: (eventId, nowMs, signal) =>
                transactEventTelegramProjectionOutbox(
                  db,
                  eventId,
                  (current) =>
                    markInvalidEventTelegramProjectionRecord(
                      current,
                      eventId,
                      nowMs,
                    ),
                  { admission, signal },
                ),
            },
          };
          return work(writers[kind]);
        },
      ),
  };
}
