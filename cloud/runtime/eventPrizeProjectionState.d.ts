// Generated from src/eventPrizeProjectionState.ts. Run npm run generate:runtime.
export type PrizeWithdrawalProjectionRecord = {
  eventId?: unknown;
  prizeId?: unknown;
  assetAddress?: unknown;
  assetStandard?: unknown;
  status?: unknown;
};
declare const getEventPrizeAssetAddress: (
  eventId: unknown,
  prizeId: unknown,
) => string;
declare const getEventPrizeAssetStandard: (
  eventId: unknown,
  prizeId: unknown,
) => "" | import("@mons/shared/event-prizes").EventPrizeStandard;
declare const isMatchingProfileEventPrizeAssignment: (
  value: PrizeWithdrawalProjectionRecord | null | undefined,
  eventId: unknown,
  prizeId: unknown,
) => boolean;
declare const isWithdrawalRecordForPrize: (
  value: PrizeWithdrawalProjectionRecord | null | undefined,
  eventId: unknown,
  prizeId: unknown,
  assetAddress: unknown,
) => boolean;
declare const isCompletedEventPrizeWithdrawal: (
  value: PrizeWithdrawalProjectionRecord | null | undefined,
  eventId: unknown,
  prizeId: unknown,
) => boolean;
declare const filterProjectableEventPrizeAssignments: <
  T extends {
    prizeId?: unknown;
  } | null,
>({
  eventId,
  assignments,
  withdrawals,
}: {
  eventId: unknown;
  assignments: Record<string, T> | null | undefined;
  withdrawals:
    Record<string, PrizeWithdrawalProjectionRecord> | null | undefined;
}) => Record<string, T>;
declare const getCompletedEventPrizeProjectionCleanupRequest: <
  T extends object,
>({
  eventId,
  eventStatus,
  assignments,
}: {
  eventId: unknown;
  eventStatus: unknown;
  assignments: T | null | undefined;
}) => {
  eventId: string;
  assignments: T;
} | null;
export {
  filterProjectableEventPrizeAssignments,
  getCompletedEventPrizeProjectionCleanupRequest,
  getEventPrizeAssetAddress,
  getEventPrizeAssetStandard,
  isCompletedEventPrizeWithdrawal,
  isMatchingProfileEventPrizeAssignment,
  isWithdrawalRecordForPrize,
};
