"use strict";

const LEGACY_CORE_PRIZES_EVENT_ID = "NN3eRzoZo80";
const COMPRESSED_PRIZES_EVENT_ID = "FRkdorMWaYW";

const createPrize = ({
  id,
  imageUrl,
  assetAddress,
  standard,
  claimAvailable,
}) =>
  Object.freeze({
    id,
    imageUrl,
    assetAddress,
    standard,
    claimAvailable,
    alt: `Prize collectible ${id}`,
  });

const EVENT_PRIZE_CONFIGS = Object.freeze({
  [LEGACY_CORE_PRIZES_EVENT_ID]: Object.freeze({
    eventId: LEGACY_CORE_PRIZES_EVENT_ID,
    prizes: Object.freeze([
      createPrize({
        id: "1092",
        imageUrl: "https://cdn.lil.org/player/scarecrow/thumbs/1092.webp",
        assetAddress: "JEGmxy88eGv9vD4rWRtN5so9fMfMU6WA5djgrysDWKrU",
        standard: "core",
        claimAvailable: true,
      }),
      createPrize({
        id: "1111",
        imageUrl: "https://cdn.lil.org/player/scarecrow/thumbs/1111.webp",
        assetAddress: "8BhUWeckB6432Vnxr6Jg9ve2NN39huPk8PBNL87wQgpL",
        standard: "core",
        claimAvailable: true,
      }),
      createPrize({
        id: "1514",
        imageUrl: "https://cdn.lil.org/player/scarecrow/thumbs/1514.webp",
        assetAddress: "FxgNuJ47j95kaWEVkPo4QGPfXzF4x5YKLFBSYezyFRRJ",
        standard: "core",
        claimAvailable: true,
      }),
    ]),
  }),
  [COMPRESSED_PRIZES_EVENT_ID]: Object.freeze({
    eventId: COMPRESSED_PRIZES_EVENT_ID,
    prizes: Object.freeze([
      createPrize({
        id: "1866",
        imageUrl: "https://cdn.lil.org/nft/card_nft/1866.webp",
        assetAddress: "2KNT8rbXC7G8w5AChbEHHi6i4FN7EAZCtdWX65ZSuQp6",
        standard: "compressed",
        claimAvailable: false,
      }),
      createPrize({
        id: "1682",
        imageUrl: "https://cdn.lil.org/nft/card_nft/1682.webp",
        assetAddress: "AzQvo7HgBQYiP4bK314QQTsdRKCY98gK9bxrXNMZAeMA",
        standard: "compressed",
        claimAvailable: false,
      }),
      createPrize({
        id: "6793",
        imageUrl: "https://cdn.lil.org/nft/card_nft/6793.webp",
        assetAddress: "CHDbyCecsFmLa9sQrMRz7xBbCs2JALbM4LXB35bv1CU",
        standard: "compressed",
        claimAvailable: false,
      }),
    ]),
  }),
});

const EVENT_PRIZE_IDS = Object.freeze(
  Object.values(EVENT_PRIZE_CONFIGS).flatMap((config) =>
    config.prizes.map((prize) => prize.id),
  ),
);

const normalizeString = (value) =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : "";

const getEventPrizeConfig = (eventId) => {
  const normalizedEventId = normalizeString(eventId);
  return Object.prototype.hasOwnProperty.call(
    EVENT_PRIZE_CONFIGS,
    normalizedEventId,
  )
    ? EVENT_PRIZE_CONFIGS[normalizedEventId]
    : null;
};

const getEventPrizeDefinitions = (eventId) =>
  getEventPrizeConfig(eventId)?.prizes || [];

const getEventPrizeDefinition = (eventId, prizeId) => {
  const normalizedPrizeId = normalizeString(prizeId);
  return (
    getEventPrizeDefinitions(eventId).find(
      (prize) => prize.id === normalizedPrizeId,
    ) || null
  );
};

const isEventPrizeEvent = (eventId) =>
  typeof eventId === "string" &&
  normalizeString(eventId) === eventId &&
  Boolean(getEventPrizeConfig(eventId));

const isEventPrizeId = (eventId, prizeId) =>
  isEventPrizeEvent(eventId) &&
  typeof prizeId === "string" &&
  normalizeString(prizeId) === prizeId &&
  Boolean(getEventPrizeDefinition(eventId, prizeId));

module.exports = {
  COMPRESSED_PRIZES_EVENT_ID,
  EVENT_PRIZE_CONFIGS,
  EVENT_PRIZE_IDS,
  LEGACY_CORE_PRIZES_EVENT_ID,
  getEventPrizeConfig,
  getEventPrizeDefinition,
  getEventPrizeDefinitions,
  isEventPrizeEvent,
  isEventPrizeId,
};
