import type { TransactionDecision } from "./repositoryContracts.ts";
import type { AutomatchD1StoreOptions } from "./automatchD1/types.ts";
import { createAutomatchReads } from "./automatchD1/reads.ts";
import { createAutomatchMutations } from "./automatchD1/mutations.ts";

export {
  AUTOMATCH_RECORD_TABLES,
  AutomatchD1Failure,
  type AutomatchRoot,
  type AutomatchRecordSnapshot,
  type AutomatchRecordMutation,
  type AutomatchRuntimeControl,
  type AutomatchWriteAdmission,
  type RecordRow,
  type AutomatchD1StoreOptions,
} from "./automatchD1/types.ts";
export {
  decodeSnapshot,
  isAutomatchRevisionConflict,
  resolveAutomatchServerValues,
} from "./automatchD1/codec.ts";
export {
  prepareAutomatchRuntimeControlRead,
  parseAutomatchRuntimeControlRow,
  readAutomatchRuntimeControl,
  acquireAutomatchWriteAdmission,
  automatchAdmissionGuardStatements,
  assertAutomatchWriteAdmission,
  releaseAutomatchWriteAdmission,
} from "./automatchD1/control.ts";

export function createAutomatchD1Store(
  db: D1Database,
  { now = Date.now, writeGuards }: AutomatchD1StoreOptions = {},
) {
  const reads = createAutomatchReads(db);
  const {
    read,
    listAutomatchEntriesByLogin,
    readFirstAutomatchEntry,
    listDueAutomatchTelegramOutboxes,
    listDueAutomatchProfileOutboxes,
    listMalformedAutomatchProfileOutboxes,
    listEntriesByLogins,
  } = reads;
  const {
    buildRevisionGuardStatements,
    buildCommitStatements,
    commit,
    prepareChanges,
    transactRecord,
    expireReceipts,
  } = createAutomatchMutations(db, { now, writeGuards }, reads);
  return {
    read,
    prepareChanges,
    readAutomatchEntry: async (inviteId: string, signal?: AbortSignal) =>
      (await read("automatch", inviteId, signal)).value,
    listAutomatchEntriesByLogin,
    readFirstAutomatchEntry,
    readMutationReceipt: async (operationId: string, signal?: AbortSignal) =>
      (await read("gameplayMutationReceipts", operationId, signal)).value,
    readAutomatchTelegramSource: async (
      inviteId: string,
      signal?: AbortSignal,
    ) => (await read("telegramAutomatches", inviteId, signal)).value,
    transactAutomatchTelegramSource: (
      inviteId: string,
      update: (value: unknown) => TransactionDecision<unknown>,
      signal?: AbortSignal,
    ) => transactRecord("telegramAutomatches", inviteId, update, signal),
    readAutomatchTelegramOutbox: async (
      inviteId: string,
      signal?: AbortSignal,
    ) =>
      (await read("telegramProjectionOutbox/automatch", inviteId, signal))
        .value,
    transactAutomatchTelegramOutbox: (
      inviteId: string,
      update: (value: unknown) => TransactionDecision<unknown>,
      signal?: AbortSignal,
    ) =>
      transactRecord(
        "telegramProjectionOutbox/automatch",
        inviteId,
        update,
        signal,
      ),
    listDueAutomatchTelegramOutboxes,
    readAutomatchProfileOutbox: async (
      inviteId: string,
      signal?: AbortSignal,
    ) =>
      (await read("profileGameProjectionOutbox/automatch", inviteId, signal))
        .value,
    transactAutomatchProfileOutbox: (
      inviteId: string,
      update: (value: unknown) => TransactionDecision<unknown>,
      signal?: AbortSignal,
    ) =>
      transactRecord(
        "profileGameProjectionOutbox/automatch",
        inviteId,
        update,
        signal,
      ),
    listDueAutomatchProfileOutboxes,
    listMalformedAutomatchProfileOutboxes,
    listEntriesByLogins,
    buildRevisionGuardStatements,
    buildCommitStatements,
    commit,
    expireReceipts,
  };
}

export type AutomatchD1Store = ReturnType<typeof createAutomatchD1Store>;
