import {
  decodeAutomatchEntries,
  decodeAutomatchEntry,
} from "../../../runtime/automatchRecords.js";
import {
  createAutomatchProfileOutboxSnapshot,
  createAutomatchProjectionCommands,
  createAutomatchTelegramOutboxSnapshot,
  createAutomatchTelegramSourceSnapshot,
} from "./automatchProjectionRecords.ts";
import type {
  GameSessionPort,
  GameSessionRecoveryContext,
  RawGameSessionPort,
} from "./gameSessionContracts.ts";
import {
  decodeAutomatchReceipt,
  decodeGameSessionMutationReceipt,
} from "./gameSessionReceiptRecords.ts";

export function createTypedGameSessionPort(
  raw: RawGameSessionPort,
): GameSessionPort & GameSessionRecoveryContext {
  const commands = createAutomatchProjectionCommands(raw);
  return {
    readInviteMetadata: (id, signal) => raw.readInviteMetadata(id, signal),
    readInviteMetadataMany: (ids, signal) =>
      raw.readInviteMetadataMany(ids, signal),
    commitSessionChanges: (changes, signal) =>
      raw.commitSessionChanges(changes, signal),
    readAutomatchEntry: async (id, signal) =>
      decodeAutomatchEntry(await raw.readAutomatchEntry(id, signal)),
    listAutomatchEntriesByLogin: async (uid, limit, signal) =>
      decodeAutomatchEntries(
        await raw.listAutomatchEntriesByLogin(uid, limit, signal),
      ),
    readFirstAutomatchEntry: async (signal) =>
      decodeAutomatchEntries(await raw.readFirstAutomatchEntry(signal)),
    readAutomatchReceipt: async (id, signal) =>
      decodeAutomatchReceipt(await raw.readMutationReceipt(id, signal)),
    readGameSessionMutationReceipt: async (id, signal) =>
      decodeGameSessionMutationReceipt(
        await raw.readMutationReceipt(id, signal),
      ),
    readAutomatchTelegramSource: async (id, signal) =>
      createAutomatchTelegramSourceSnapshot(
        id,
        await raw.readAutomatchTelegramSource(id, signal),
      ),
    readAutomatchTelegramOutbox: async (id, signal) =>
      createAutomatchTelegramOutboxSnapshot(
        await raw.readAutomatchTelegramOutbox(id, signal),
      ),
    readAutomatchProfileOutbox: async (id, signal) =>
      createAutomatchProfileOutboxSnapshot(
        await raw.readAutomatchProfileOutbox(id, signal),
      ),
    ...commands,
    claimAutomatchTelegramOutbox: (...args) =>
      raw.claimAutomatchTelegramOutbox(...args),
    acknowledgeAutomatchTelegramOutbox: (...args) =>
      raw.acknowledgeAutomatchTelegramOutbox(...args),
    claimAutomatchProfileOutbox: (...args) =>
      raw.claimAutomatchProfileOutbox(...args),
    acknowledgeAutomatchProfileOutbox: (...args) =>
      raw.acknowledgeAutomatchProfileOutbox(...args),
    finishAutomatchProfileOutbox: (...args) =>
      raw.finishAutomatchProfileOutbox(...args),
    projectionRecovery: {
      listDueAutomatchTelegramOutboxes: (...args) =>
        raw.listDueAutomatchTelegramOutboxes(...args),
      listDueAutomatchTelegramOutboxesPage: (...args) =>
        raw.listDueAutomatchTelegramOutboxesPage(...args),
      listDueAutomatchProfileOutboxes: (...args) =>
        raw.listDueAutomatchProfileOutboxes(...args),
      listDueAutomatchProfileOutboxesPage: (...args) =>
        raw.listDueAutomatchProfileOutboxesPage(...args),
      listMalformedAutomatchProfileOutboxes: (...args) =>
        raw.listMalformedAutomatchProfileOutboxes(...args),
      listMalformedAutomatchProfileOutboxesPage: (...args) =>
        raw.listMalformedAutomatchProfileOutboxesPage(...args),
      repairInvalidAutomatchTelegramOutbox:
        commands.repairInvalidAutomatchTelegramOutbox,
      repairInvalidAutomatchProfileOutbox:
        commands.repairInvalidAutomatchProfileOutbox,
    },
  };
}
