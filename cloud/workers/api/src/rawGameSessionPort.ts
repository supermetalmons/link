import type { InviteDocument } from "@mons/shared/invite-records";
import type { GameSessionChange } from "../../../runtime/gameSessionChanges.js";
import type {
  AutomatchOutboxClaimSnapshot,
  AutomatchOutboxRecoveryPage,
  AutomatchRecordValue,
} from "./automatchD1/types.ts";
import type {
  TransactionDecision,
  TransactionResult,
} from "./repositoryContracts.ts";
export type { GameSessionChange } from "../../../runtime/gameSessionChanges.js";

export type RawAutomatchProjectionPort = {
  readAutomatchTelegramSource(
    inviteId: string,
    signal?: AbortSignal,
  ): Promise<AutomatchRecordValue<"telegramAutomatches">>;
  transactAutomatchTelegramSource(
    inviteId: string,
    update: (current: unknown) => TransactionDecision<unknown>,
    signal?: AbortSignal,
  ): Promise<TransactionResult<unknown>>;
  readAutomatchTelegramOutbox(
    inviteId: string,
    signal?: AbortSignal,
  ): Promise<AutomatchRecordValue<"telegramProjectionOutbox/automatch">>;
  transactAutomatchTelegramOutbox(
    inviteId: string,
    update: (current: unknown) => TransactionDecision<unknown>,
    signal?: AbortSignal,
  ): Promise<TransactionResult<unknown>>;
  claimAutomatchTelegramOutbox(
    inviteId: string,
    requestId: string,
    expectedUpdatedAtMs: number,
    nowMs: number,
    signal?: AbortSignal,
    snapshot?: AutomatchOutboxClaimSnapshot<"telegramProjectionOutbox/automatch">,
  ): Promise<boolean>;
  acknowledgeAutomatchTelegramOutbox(
    inviteId: string,
    requestId: string,
    signal?: AbortSignal,
  ): Promise<boolean>;
  listDueAutomatchTelegramOutboxes(
    nowMs: number,
    limit: number,
    signal?: AbortSignal,
  ): Promise<Record<
    string,
    AutomatchRecordValue<"telegramProjectionOutbox/automatch">
  > | null>;
  listDueAutomatchTelegramOutboxesPage(
    nowMs: number,
    limit: number,
    excludedIdentities?: readonly string[],
    signal?: AbortSignal,
  ): Promise<AutomatchOutboxRecoveryPage<"telegramProjectionOutbox/automatch">>;
  readAutomatchProfileOutbox(
    inviteId: string,
    signal?: AbortSignal,
  ): Promise<AutomatchRecordValue<"profileGameProjectionOutbox/automatch">>;
  transactAutomatchProfileOutbox(
    inviteId: string,
    update: (current: unknown) => TransactionDecision<unknown>,
    signal?: AbortSignal,
  ): Promise<TransactionResult<unknown>>;
  claimAutomatchProfileOutbox(
    inviteId: string,
    requestId: string,
    expectedLastQueuedAtMs: number,
    nowMs: number,
    signal?: AbortSignal,
    snapshot?: AutomatchOutboxClaimSnapshot<"profileGameProjectionOutbox/automatch">,
  ): Promise<boolean>;
  acknowledgeAutomatchProfileOutbox(
    inviteId: string,
    requestId: string,
    signal?: AbortSignal,
  ): Promise<boolean>;
  finishAutomatchProfileOutbox(
    inviteId: string,
    requestId: string,
    nowMs: number,
    signal?: AbortSignal,
  ): Promise<"superseded" | "continued" | "deferred" | "projected">;
  listDueAutomatchProfileOutboxes(
    beforeMs: number,
    limit: number,
    signal?: AbortSignal,
  ): Promise<Record<
    string,
    AutomatchRecordValue<"profileGameProjectionOutbox/automatch">
  > | null>;
  listDueAutomatchProfileOutboxesPage(
    beforeMs: number,
    limit: number,
    excludedIdentities?: readonly string[],
    signal?: AbortSignal,
  ): Promise<
    AutomatchOutboxRecoveryPage<"profileGameProjectionOutbox/automatch">
  >;
  listMalformedAutomatchProfileOutboxes(
    limit: number,
    signal?: AbortSignal,
  ): Promise<Record<
    string,
    AutomatchRecordValue<"profileGameProjectionOutbox/automatch">
  > | null>;
  listMalformedAutomatchProfileOutboxesPage(
    limit: number,
    excludedIdentities?: readonly string[],
    signal?: AbortSignal,
  ): Promise<
    AutomatchOutboxRecoveryPage<"profileGameProjectionOutbox/automatch">
  >;
};

export type RawGameSessionPort = RawAutomatchProjectionPort & {
  readInviteMetadata(
    inviteId: string,
    signal?: AbortSignal,
  ): Promise<InviteDocument | null>;
  readInviteMetadataMany(
    inviteIds: readonly string[],
    signal?: AbortSignal,
  ): Promise<Array<InviteDocument | null>>;
  readAutomatchEntry(
    inviteId: string,
    signal?: AbortSignal,
  ): Promise<AutomatchRecordValue<"automatch">>;
  listAutomatchEntriesByLogin(
    uid: string,
    limit: number,
    signal?: AbortSignal,
  ): Promise<Record<string, AutomatchRecordValue<"automatch">> | null>;
  readFirstAutomatchEntry(
    signal?: AbortSignal,
  ): Promise<Record<string, AutomatchRecordValue<"automatch">> | null>;
  readMutationReceipt(
    operationId: string,
    signal?: AbortSignal,
  ): Promise<AutomatchRecordValue<"gameplayMutationReceipts">>;
  commitSessionChanges(
    changes: readonly GameSessionChange[],
    signal?: AbortSignal,
  ): Promise<void>;
};
