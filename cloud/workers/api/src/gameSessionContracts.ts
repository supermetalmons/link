import type { GameSessionChange } from "../../../runtime/gameSessionChanges.js";
import type {
  TransactionDecision,
  TransactionResult,
} from "./repositoryContracts.ts";
export type { GameSessionChange } from "../../../runtime/gameSessionChanges.js";

export type AutomatchProjectionPort = {
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
  listDueAutomatchTelegramOutboxes(
    nowMs: number,
    limit: number,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown> | null>;
  readAutomatchProfileOutbox(
    inviteId: string,
    signal?: AbortSignal,
  ): Promise<unknown>;
  transactAutomatchProfileOutbox(
    inviteId: string,
    update: (current: unknown) => TransactionDecision<unknown>,
    signal?: AbortSignal,
  ): Promise<TransactionResult<unknown>>;
  listDueAutomatchProfileOutboxes(
    beforeMs: number,
    limit: number,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown> | null>;
  listMalformedAutomatchProfileOutboxes(
    limit: number,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown> | null>;
};

export type GameSessionPort = AutomatchProjectionPort & {
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
