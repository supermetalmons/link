export const LEGACY_CORE_PRIZES_EVENT_ID: "NN3eRzoZo80";
export const COMPRESSED_PRIZES_EVENT_ID: "FRkdorMWaYW";
export const ARTIFACT_MAGAZINE_3_PRIZES_EVENT_ID: "VOxalSrexcA";
export const ARTIFACT_MAGAZINE_3_PRIZES_EVENT_2_ID: "oXAceF6anag";

export type EventPrizeEventId =
  | typeof LEGACY_CORE_PRIZES_EVENT_ID
  | typeof COMPRESSED_PRIZES_EVENT_ID
  | typeof ARTIFACT_MAGAZINE_3_PRIZES_EVENT_ID
  | typeof ARTIFACT_MAGAZINE_3_PRIZES_EVENT_2_ID;
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
  | "284";
export type EventPrizeStandard = "core" | "compressed";

export type EventPrizeDefinition = Readonly<{
  id: EventPrizeId;
  imageUrl: string;
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
