import type { GameSessionChange } from "../../../runtime/gameSessionChanges.js";
import type { RecoveryScanPage } from "./recoveryScanPage.ts";
import type {
  AutomatchOutboxClaimSnapshot,
  AutomatchOutboxRecoveryPage,
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
  ): Promise<unknown>;
  transactAutomatchTelegramSource(
    inviteId: string,
    update: (current: unknown) => TransactionDecision<unknown>,
    signal?: AbortSignal,
  ): Promise<TransactionResult<unknown>>;
  readAutomatchTelegramOutbox(
    inviteId: string,
    signal?: AbortSignal,
  ): Promise<unknown>;
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
    snapshot?: AutomatchOutboxClaimSnapshot,
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
  ): Promise<Record<string, unknown> | null>;
  listDueAutomatchTelegramOutboxesPage(
    nowMs: number,
    limit: number,
    excludedIdentities?: readonly string[],
    signal?: AbortSignal,
  ): Promise<AutomatchOutboxRecoveryPage>;
  readAutomatchProfileOutbox(
    inviteId: string,
    signal?: AbortSignal,
  ): Promise<unknown>;
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
    snapshot?: AutomatchOutboxClaimSnapshot,
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
  ): Promise<Record<string, unknown> | null>;
  listDueAutomatchProfileOutboxesPage(
    beforeMs: number,
    limit: number,
    excludedIdentities?: readonly string[],
    signal?: AbortSignal,
  ): Promise<AutomatchOutboxRecoveryPage>;
  listMalformedAutomatchProfileOutboxes(
    limit: number,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown> | null>;
  listMalformedAutomatchProfileOutboxesPage(
    limit: number,
    excludedIdentities?: readonly string[],
    signal?: AbortSignal,
  ): Promise<RecoveryScanPage<Record<string, unknown> | null>>;
};

export type RawGameSessionPort = RawAutomatchProjectionPort & {
  readInviteMetadata(
    inviteId: string,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown> | null>;
  readInviteMetadataMany(
    inviteIds: readonly string[],
    signal?: AbortSignal,
  ): Promise<Array<Record<string, unknown> | null>>;
  readAutomatchEntry(inviteId: string, signal?: AbortSignal): Promise<unknown>;
  listAutomatchEntriesByLogin(
    uid: string,
    limit: number,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown> | null>;
  readFirstAutomatchEntry(
    signal?: AbortSignal,
  ): Promise<Record<string, unknown> | null>;
  readMutationReceipt(
    operationId: string,
    signal?: AbortSignal,
  ): Promise<unknown>;
  commitSessionChanges(
    changes: readonly GameSessionChange[],
    signal?: AbortSignal,
  ): Promise<void>;
};
