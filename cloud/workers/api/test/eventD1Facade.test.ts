import assert from "node:assert/strict";
import test from "node:test";
import * as eventD1 from "../src/eventD1.ts";
import * as coordination from "../src/eventD1/coordination.ts";
import * as commit from "../src/eventD1/commit.ts";
import * as transitions from "../src/eventD1/transitions.ts";
import * as types from "../src/eventD1/types.ts";
import * as reads from "../src/eventD1/reads.ts";
import * as transactions from "../src/eventD1/transactions.ts";
import * as validation from "../src/eventD1/validation.ts";

test("event D1 preserves its exact public facade and implementation identities", () => {
  const expected = {
    acquireEventWriteAdmission: coordination.acquireEventWriteAdmission,
    assertEventWritesAllowed: coordination.assertEventWritesAllowed,
    commitEventMutations: commit.commitEventMutations,
    createEventTransitionIntent: transitions.createEventTransitionIntent,
    EventD1Conflict: types.EventD1Conflict,
    EventD1Failure: types.EventD1Failure,
    EventWritesDisabled: types.EventWritesDisabled,
    EventNotUpcoming: types.EventNotUpcoming,
    listDueEventProfileGameProjectionOutboxes:
      reads.listDueEventProfileGameProjectionOutboxes,
    listDueEventProgressOutboxes: reads.listDueEventProgressOutboxes,
    listDueEventTelegramProjectionOutboxes:
      reads.listDueEventTelegramProjectionOutboxes,
    listEventAggregates: reads.listEventAggregates,
    listPendingEventTransitionIntents:
      transitions.listPendingEventTransitionIntents,
    listProfileEventPrizeAssignments: reads.listProfileEventPrizeAssignments,
    readEvent: reads.readEvent,
    readEventLease: reads.readEventLease,
    readEventPrizeSelections: reads.readEventPrizeSelections,
    readEventProfileGameProjectionOutbox:
      reads.readEventProfileGameProjectionOutbox,
    readEventProgressDeadOutbox: reads.readEventProgressDeadOutbox,
    readEventProgressOutbox: reads.readEventProgressOutbox,
    readEventRuntimeControl: coordination.readEventRuntimeControl,
    readEventSnapshot: reads.readEventSnapshot,
    readEventSnapshotIfChanged: reads.readEventSnapshotIfChanged,
    readEventSyncThrottle: reads.readEventSyncThrottle,
    readEventTelegramProjectionOutbox: reads.readEventTelegramProjectionOutbox,
    readEventTelegramProjectionState: reads.readEventTelegramProjectionState,
    readEventTransitionIntent: transitions.readEventTransitionIntent,
    readProfileEventPrizeAssignment: reads.readProfileEventPrizeAssignment,
    readProfileEventPrizes: reads.readProfileEventPrizes,
    readProfileEventPrizesIfChanged: reads.readProfileEventPrizesIfChanged,
    recordEventTransitionAttempt: transitions.recordEventTransitionAttempt,
    releaseEventWriteAdmission: coordination.releaseEventWriteAdmission,
    transactEventField: transactions.transactEventField,
    transactEventLease: coordination.transactEventLease,
    transactEventPrizeSelection: transactions.transactEventPrizeSelection,
    transactEventPrizeSelections: transactions.transactEventPrizeSelections,
    transactEventProfileGameProjectionOutbox:
      transactions.transactEventProfileGameProjectionOutbox,
    transactEventProgressDeadOutbox:
      transactions.transactEventProgressDeadOutbox,
    transactEventProgressOutbox: transactions.transactEventProgressOutbox,
    transactEventRecord: transactions.transactEventRecord,
    transactEventSyncThrottle: coordination.transactEventSyncThrottle,
    transactEventTelegramProjectionGeneration:
      transactions.transactEventTelegramProjectionGeneration,
    transactEventTelegramProjectionOutbox:
      transactions.transactEventTelegramProjectionOutbox,
    transactEventTelegramProjectionState:
      transactions.transactEventTelegramProjectionState,
    transactProfileEventPrize: transactions.transactProfileEventPrize,
    transactStoredProfileEventPrize:
      transactions.transactStoredProfileEventPrize,
    validateEventAggregate: validation.validateEventAggregate,
    validateEventPrizeAssignment: validation.validateEventPrizeAssignment,
  };
  assert.deepEqual(Object.keys(eventD1).sort(), Object.keys(expected).sort());
  for (const [name, implementation] of Object.entries(expected)) {
    assert.strictEqual(
      eventD1[name as keyof typeof expected],
      implementation,
      name,
    );
  }
});
