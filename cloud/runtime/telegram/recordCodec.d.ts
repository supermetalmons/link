// Generated from src/telegram/recordCodec.ts. Run npm run generate:runtime.
import type { TelegramDesired } from "./desiredStateCore.js";
import type {
  TelegramAppliedDocument,
  TelegramCleanupDocument,
  TelegramControlDocument,
  TelegramDeliveryDocument,
  TelegramMessageDocument,
  TelegramRetryProofDocument,
  TelegramSendEvidence,
} from "./records.js";
export declare function readTelegramDesired(
  value: unknown,
): TelegramDesired | null;
export declare function readTelegramSendEvidence(
  value: unknown,
): TelegramSendEvidence | null;
export declare function readTelegramApplied(
  value: unknown,
): TelegramAppliedDocument | null;
export declare function readTelegramRetryProof(
  value: unknown,
): TelegramRetryProofDocument | null;
export declare function readTelegramCleanup(
  value: unknown,
): TelegramCleanupDocument | null;
export declare function readTelegramDelivery(
  value: unknown,
): TelegramDeliveryDocument | null;
export declare function readTelegramMessageDocument(
  value: unknown,
): TelegramMessageDocument | null;
export declare function readTelegramControlDocument(
  value: unknown,
): TelegramControlDocument | null;
export declare function requireTelegramMessageDocument(
  value: unknown,
): TelegramMessageDocument;
export declare function requireTelegramTransaction(
  value: unknown,
): import("../transactions.js").TransactionDecision<TelegramMessageDocument>;
export declare function requireTelegramOrphanedDelete(
  value: unknown,
): import("./records.js").TelegramOrphanedDelete;
