import type {
  EventProgressRecoverySnapshot,
  EventProgressRecoveryStore,
} from "../src/eventProgressRecoveryD1.ts";
import type { EventProgressSweepRepository } from "../src/eventProgress.ts";

export function createEventProgressRecoveryTestStore(
  repository: EventProgressSweepRepository,
): EventProgressRecoveryStore {
  const checkpoints = new Map<
    string,
    { recordJson: string; nextReconcileAtMs: number }
  >();
  const snapshot = (
    outboxId: string,
    record: unknown,
  ): EventProgressRecoverySnapshot => {
    const recordJson = JSON.stringify(record);
    const checkpoint = checkpoints.get(outboxId);
    return {
      outboxId,
      record,
      recordJson,
      nextReconcileAtMs:
        checkpoint?.recordJson === recordJson
          ? checkpoint.nextReconcileAtMs
          : 0,
    };
  };
  const read = async (outboxId: string) => {
    const record = await repository.readEventProgressOutbox(outboxId);
    if (record === null) {
      checkpoints.delete(outboxId);
      return null;
    }
    return snapshot(outboxId, record);
  };
  return {
    read,
    async listDue(nowMs, limit) {
      const rows = await repository.listDueEventProgressOutboxes(
        Number.MAX_SAFE_INTEGER,
        limit,
      );
      return rows
        .map(({ outboxId, record }) => snapshot(outboxId, record))
        .filter((row) => row.nextReconcileAtMs <= nowMs);
    },
    async checkpoint(observed, nextReconcileAtMs) {
      const current = await read(observed.outboxId);
      if (
        current?.recordJson !== observed.recordJson ||
        (current.nextReconcileAtMs !== observed.nextReconcileAtMs &&
          current.nextReconcileAtMs <= nextReconcileAtMs)
      )
        return false;
      checkpoints.set(observed.outboxId, {
        recordJson: observed.recordJson,
        nextReconcileAtMs,
      });
      return true;
    },
    async remove(observed) {
      const current = await read(observed.outboxId);
      if (current?.recordJson !== observed.recordJson) return false;
      await repository.commitEventPlan([
        { kind: "progress-outbox", outboxId: observed.outboxId, value: null },
      ]);
      checkpoints.delete(observed.outboxId);
      return true;
    },
  };
}
