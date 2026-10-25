import type {
  AutomatchEntryRead,
  AutomatchReceiptView,
  GameSessionMutationReceiptView,
} from "../../../runtime/automatchRecords.js";
import type {
  AutomatchProfileOutboxSnapshot,
  AutomatchProjectionCommands,
  AutomatchTelegramOutboxSnapshot,
  AutomatchTelegramSourceSnapshot,
} from "./automatchProjectionRecords.ts";
import type { ReceiptRead } from "./gameSessionReceiptRecords.ts";
import type { RawGameSessionPort } from "./rawGameSessionPort.ts";

export type { GameSessionChange } from "../../../runtime/gameSessionChanges.js";
export type { RawGameSessionPort } from "./rawGameSessionPort.ts";

type AutomatchRecordMethod =
  | "readAutomatchEntry"
  | "listAutomatchEntriesByLogin"
  | "readFirstAutomatchEntry"
  | "readMutationReceipt"
  | "readAutomatchTelegramSource"
  | "transactAutomatchTelegramSource"
  | "readAutomatchTelegramOutbox"
  | "transactAutomatchTelegramOutbox"
  | "readAutomatchProfileOutbox"
  | "transactAutomatchProfileOutbox"
  | "listDueAutomatchTelegramOutboxes"
  | "listDueAutomatchTelegramOutboxesPage"
  | "listDueAutomatchProfileOutboxes"
  | "listDueAutomatchProfileOutboxesPage"
  | "listMalformedAutomatchProfileOutboxes"
  | "listMalformedAutomatchProfileOutboxesPage";

export type GameSessionPort = Omit<RawGameSessionPort, AutomatchRecordMethod> &
  AutomatchProjectionCommands & {
    readAutomatchEntry(
      inviteId: string,
      signal?: AbortSignal,
    ): Promise<AutomatchEntryRead>;
    listAutomatchEntriesByLogin(
      uid: string,
      limit: number,
      signal?: AbortSignal,
    ): Promise<Record<string, AutomatchEntryRead> | null>;
    readFirstAutomatchEntry(
      signal?: AbortSignal,
    ): Promise<Record<string, AutomatchEntryRead> | null>;
    readAutomatchReceipt(
      operationId: string,
      signal?: AbortSignal,
    ): Promise<ReceiptRead<AutomatchReceiptView>>;
    readGameSessionMutationReceipt(
      operationId: string,
      signal?: AbortSignal,
    ): Promise<ReceiptRead<GameSessionMutationReceiptView>>;
    readAutomatchTelegramSource(
      inviteId: string,
      signal?: AbortSignal,
    ): Promise<AutomatchTelegramSourceSnapshot>;
    readAutomatchTelegramOutbox(
      inviteId: string,
      signal?: AbortSignal,
    ): Promise<AutomatchTelegramOutboxSnapshot>;
    readAutomatchProfileOutbox(
      inviteId: string,
      signal?: AbortSignal,
    ): Promise<AutomatchProfileOutboxSnapshot>;
  };

export type AutomatchProjectionPort = Pick<
  GameSessionPort,
  | "readAutomatchTelegramSource"
  | "readAutomatchTelegramOutbox"
  | "readAutomatchProfileOutbox"
  | "mergeAutomatchTelegramRatingResult"
  | "markAutomatchTelegramOutboxDead"
  | "settleAutomatchHistoricalDescriptor"
  | "claimAutomatchTelegramOutbox"
  | "acknowledgeAutomatchTelegramOutbox"
  | "claimAutomatchProfileOutbox"
  | "acknowledgeAutomatchProfileOutbox"
  | "finishAutomatchProfileOutbox"
>;

export type AutomatchProjectionRecoveryPort = Pick<
  RawGameSessionPort,
  | "listDueAutomatchTelegramOutboxes"
  | "listDueAutomatchTelegramOutboxesPage"
  | "listDueAutomatchProfileOutboxes"
  | "listDueAutomatchProfileOutboxesPage"
  | "listMalformedAutomatchProfileOutboxes"
  | "listMalformedAutomatchProfileOutboxesPage"
> &
  Pick<
    AutomatchProjectionCommands,
    | "repairInvalidAutomatchTelegramOutbox"
    | "repairInvalidAutomatchProfileOutbox"
  >;

export type GameSessionRecoveryContext = {
  projectionRecovery: AutomatchProjectionRecoveryPort;
};
