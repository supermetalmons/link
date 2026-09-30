// Generated from src/shared/event-prizes.ts. Run npm run generate:runtime.
export type EventPrizeEventId =
  | typeof LEGACY_CORE_PRIZES_EVENT_ID
  | typeof COMPRESSED_PRIZES_EVENT_ID
  | typeof ARTIFACT_MAGAZINE_3_PRIZES_EVENT_ID
  | typeof ARTIFACT_MAGAZINE_3_PRIZES_EVENT_2_ID
  | typeof RARE_WEITSMANS_PRIZES_EVENT_ID
  | typeof PLANET_PEPPA_PRIZES_EVENT_ID
  | typeof SHELVES_PRIZES_EVENT_ID
  | typeof VEHICLE_WAMMIN_PRIZES_EVENT_ID
  | typeof SWAG_PACK_PRIZES_EVENT_ID
  | typeof REVERIE_BANNERS_PRIZES_EVENT_ID;
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
  | "221"
  | "3727"
  | "3728"
  | "3729"
  | "865"
  | "1643"
  | "1213"
  | "1241"
  | "443"
  | "1274"
  | "66"
  | "131"
  | "316"
  | "317"
  | "318";
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
  collectionName: string;
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
declare const EVENT_PRIZE_REVEAL_WINDOW_MS = 3600000;
declare const LEGACY_CORE_PRIZES_EVENT_ID = "NN3eRzoZo80";
declare const COMPRESSED_PRIZES_EVENT_ID = "FRkdorMWaYW";
declare const ARTIFACT_MAGAZINE_3_PRIZES_EVENT_ID = "VOxalSrexcA";
declare const ARTIFACT_MAGAZINE_3_PRIZES_EVENT_2_ID = "oXAceF6anag";
declare const RARE_WEITSMANS_PRIZES_EVENT_ID = "RpPjMNyrJJa";
declare const PLANET_PEPPA_PRIZES_EVENT_ID = "z3oj52Iiime";
declare const SHELVES_PRIZES_EVENT_ID = "Q7uRdLXyVKF";
declare const VEHICLE_WAMMIN_PRIZES_EVENT_ID = "wjFa2d03Ciu";
declare const SWAG_PACK_PRIZES_EVENT_ID = "d9RtIQY8ONs";
declare const REVERIE_BANNERS_PRIZES_EVENT_ID = "PCTotuzfUPu";
declare const EVENT_PRIZE_CONFIGS: Readonly<
  Record<EventPrizeEventId, EventPrizeConfig>
>;
declare const EVENT_PRIZE_IDS: readonly EventPrizeId[];
declare const getEventPrizeConfig: (
  eventId: unknown,
) => EventPrizeConfig | null;
declare const getEventPrizeDefinitions: (
  eventId: unknown,
) => readonly EventPrizeDefinition[];
declare const getEventPrizeDefinition: (
  eventId: unknown,
  prizeId: unknown,
) => EventPrizeDefinition | null;
declare const isEventPrizeEvent: (
  eventId: unknown,
) => eventId is EventPrizeEventId;
declare const isEventPrizeId: (
  eventId: unknown,
  prizeId: unknown,
) => prizeId is EventPrizeId;
declare const isEventPrizeRevealOpen: (
  status: unknown,
  startAtMs: unknown,
  nowMs: number,
) => boolean;
declare const isEventPrizeStandard: (
  value: unknown,
) => value is EventPrizeStandard;
declare const isToggleEventPrizeSelectionRequest: (
  value: unknown,
) => value is ToggleEventPrizeSelectionRequest;
declare const isToggleEventPrizeSelectionResponse: (
  value: unknown,
) => value is ToggleEventPrizeSelectionResponse;
declare const isEventPrizeAssignmentWireRecord: (
  value: unknown,
) => value is EventPrizeAssignmentWireRecord;
declare const isEventPrizeAssignmentRecord: (
  value: unknown,
) => value is EventPrizeAssignmentRecord;
declare const isProfileEventPrizesResponse: (
  value: unknown,
) => value is ProfileEventPrizesResponse;
declare const isEventPrizeWithdrawalOperationId: (
  value: unknown,
) => value is string;
declare const isEventPrizeWithdrawalRequest: (
  value: unknown,
) => value is EventPrizeWithdrawalRequest;
declare const isEventPrizeWithdrawalStatusRequest: (
  value: unknown,
) => value is EventPrizeWithdrawalStatusRequest;
declare const isEventPrizeWithdrawalProcessingResponse: (
  value: unknown,
) => value is EventPrizeWithdrawalProcessingResponse;
declare const isEventPrizeWithdrawalCompletedResponse: (
  value: unknown,
) => value is EventPrizeWithdrawalCompletedResponse;
declare const isEventPrizeWithdrawalResponse: (
  value: unknown,
) => value is EventPrizeWithdrawalResponse;
export {
  ARTIFACT_MAGAZINE_3_PRIZES_EVENT_2_ID,
  ARTIFACT_MAGAZINE_3_PRIZES_EVENT_ID,
  COMPRESSED_PRIZES_EVENT_ID,
  EVENT_PRIZE_CONFIGS,
  EVENT_PRIZE_IDS,
  EVENT_PRIZE_REVEAL_WINDOW_MS,
  LEGACY_CORE_PRIZES_EVENT_ID,
  PLANET_PEPPA_PRIZES_EVENT_ID,
  RARE_WEITSMANS_PRIZES_EVENT_ID,
  REVERIE_BANNERS_PRIZES_EVENT_ID,
  SHELVES_PRIZES_EVENT_ID,
  SWAG_PACK_PRIZES_EVENT_ID,
  VEHICLE_WAMMIN_PRIZES_EVENT_ID,
  getEventPrizeConfig,
  getEventPrizeDefinition,
  getEventPrizeDefinitions,
  isEventPrizeAssignmentRecord,
  isEventPrizeAssignmentWireRecord,
  isEventPrizeEvent,
  isEventPrizeId,
  isEventPrizeRevealOpen,
  isEventPrizeStandard,
  isEventPrizeWithdrawalCompletedResponse,
  isEventPrizeWithdrawalOperationId,
  isEventPrizeWithdrawalProcessingResponse,
  isEventPrizeWithdrawalRequest,
  isEventPrizeWithdrawalResponse,
  isEventPrizeWithdrawalStatusRequest,
  isProfileEventPrizesResponse,
  isToggleEventPrizeSelectionRequest,
  isToggleEventPrizeSelectionResponse,
};
