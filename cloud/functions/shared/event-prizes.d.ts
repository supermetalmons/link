export const LEGACY_CORE_PRIZES_EVENT_ID: "NN3eRzoZo80";
export const COMPRESSED_PRIZES_EVENT_ID: "FRkdorMWaYW";
export const ARTIFACT_MAGAZINE_3_PRIZES_EVENT_ID: "VOxalSrexcA";
export const ARTIFACT_MAGAZINE_3_PRIZES_EVENT_2_ID: "oXAceF6anag";
export const RARE_WEITSMANS_PRIZES_EVENT_ID: "RpPjMNyrJJa";

export type EventPrizeEventId =
  | typeof LEGACY_CORE_PRIZES_EVENT_ID
  | typeof COMPRESSED_PRIZES_EVENT_ID
  | typeof ARTIFACT_MAGAZINE_3_PRIZES_EVENT_ID
  | typeof ARTIFACT_MAGAZINE_3_PRIZES_EVENT_2_ID
  | typeof RARE_WEITSMANS_PRIZES_EVENT_ID;
export type EventPrizeId =
  | "1092"
  | "1111"
  | "1514"
  | "1866"
  | "1682"
  | "6793"
  | "282"
  | "283"
  | "280"
  | "281"
  | "279"
  | "284"
  | "217"
  | "220"
  | "221";
export type EventPrizeStandard = "core" | "compressed";

export type EventPrizeDefinition = Readonly<{
  id: EventPrizeId;
  imageUrl: string;
  imageWidth: number;
  imageHeight: number;
  assetAddress: string;
  collectionAddress: string;
  standard: EventPrizeStandard;
  claimAvailable: boolean;
  alt: string;
}>;

export type EventPrizeConfig = Readonly<{
  eventId: EventPrizeEventId;
  prizes: readonly EventPrizeDefinition[];
}>;

export type ToggleEventPrizeSelectionRequest = {
  eventId: EventPrizeEventId;
  prizeId: EventPrizeId;
};

export type ToggleEventPrizeSelectionResponse = {
  ok: true;
  eventId: EventPrizeEventId;
  selectedPrizeId: EventPrizeId | null;
};

export type EventPrizeAssignmentWireRecord = {
  eventId: string;
  profileId: string;
  place: 1 | 2 | 3;
  prizeId: string;
  assignedAtMs: number;
} & Record<string, unknown>;

export type EventPrizeAssignmentRecord = EventPrizeAssignmentWireRecord & {
  eventId: EventPrizeEventId;
  prizeId: EventPrizeId;
};

export type ProfileEventPrizesResponse = {
  ok: true;
  profileId: string | null;
  revision: number;
  prizes: Record<string, EventPrizeAssignmentWireRecord>;
};

export type EventPrizeWithdrawalRequest = {
  eventId: EventPrizeEventId;
  prizeId: EventPrizeId;
  solanaAddress: string;
};

export type EventPrizeWithdrawalStatusRequest = {
  eventId: EventPrizeEventId;
  operationId: string;
  prizeId: EventPrizeId;
};

export type EventPrizeWithdrawalProcessingResponse = {
  ok: true;
  status: "processing";
  operationId: string;
  eventId: EventPrizeEventId;
  prizeId: EventPrizeId;
};

export type EventPrizeWithdrawalCompletedResponse = {
  ok: true;
  status: "completed";
  operationId: string;
  eventId: EventPrizeEventId;
  prizeId: EventPrizeId;
  assetAddress: string;
  recipientAddress: string;
  transactionSignature: string;
};

export type EventPrizeWithdrawalResponse =
  | EventPrizeWithdrawalProcessingResponse
  | EventPrizeWithdrawalCompletedResponse;

export const EVENT_PRIZE_CONFIGS: Readonly<
  Record<EventPrizeEventId, EventPrizeConfig>
>;
export const EVENT_PRIZE_IDS: readonly EventPrizeId[];

export function getEventPrizeConfig(eventId: unknown): EventPrizeConfig | null;
export function getEventPrizeDefinitions(
  eventId: unknown,
): readonly EventPrizeDefinition[];
export function getEventPrizeDefinition(
  eventId: unknown,
  prizeId: unknown,
): EventPrizeDefinition | null;
export function isEventPrizeEvent(
  eventId: unknown,
): eventId is EventPrizeEventId;
export function isEventPrizeId(
  eventId: unknown,
  prizeId: unknown,
): prizeId is EventPrizeId;
export function isEventPrizeStandard(
  value: unknown,
): value is EventPrizeStandard;
export function isEventPrizeWithdrawalCompletedResponse(
  value: unknown,
): value is EventPrizeWithdrawalCompletedResponse;
export function isEventPrizeWithdrawalOperationId(
  value: unknown,
): value is string;
export function isEventPrizeWithdrawalProcessingResponse(
  value: unknown,
): value is EventPrizeWithdrawalProcessingResponse;
export function isEventPrizeWithdrawalRequest(
  value: unknown,
): value is EventPrizeWithdrawalRequest;
export function isEventPrizeWithdrawalResponse(
  value: unknown,
): value is EventPrizeWithdrawalResponse;
export function isEventPrizeWithdrawalStatusRequest(
  value: unknown,
): value is EventPrizeWithdrawalStatusRequest;
export function isToggleEventPrizeSelectionRequest(
  value: unknown,
): value is ToggleEventPrizeSelectionRequest;
export function isToggleEventPrizeSelectionResponse(
  value: unknown,
): value is ToggleEventPrizeSelectionResponse;
export function isEventPrizeAssignmentRecord(
  value: unknown,
): value is EventPrizeAssignmentRecord;
export function isEventPrizeAssignmentWireRecord(
  value: unknown,
): value is EventPrizeAssignmentWireRecord;
export function isProfileEventPrizesResponse(
  value: unknown,
): value is ProfileEventPrizesResponse;
