"use strict";

const VALID_REACTION_IDS = Object.freeze([
  9, 17, 20, 26, 30, 31, 40, 50, 54, 61, 63, 74, 101, 109, 132, 146, 148, 163,
  168, 173, 180, 189, 209, 210, 217, 224, 225, 228, 232, 236, 243, 245, 246,
  250, 256, 257, 258, 267, 271, 281, 283, 289, 302, 303, 313, 316, 318, 325,
  328, 338, 347, 356, 374, 382, 389, 393, 396, 401, 403, 405, 407, 429, 430,
  444, 465, 466,
]);

const NFT_COUNT_KEYS = Object.freeze(["id", "count"]);
const NFT_RESPONSE_ARRAY_KEYS = Object.freeze([
  "specials",
  "swagpack_avatars",
  "swagpack_reactions",
]);
const NFT_RESPONSE_KEYS = Object.freeze(["ok", ...NFT_RESPONSE_ARRAY_KEYS]);

const isRecord = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasExactKeys = (value, expectedKeys) => {
  const actualKeys = Object.keys(value);
  return (
    actualKeys.length === expectedKeys.length &&
    actualKeys.every((key) => expectedKeys.includes(key))
  );
};

const isNftCount = (value) =>
  isRecord(value) &&
  Number.isInteger(value.id) &&
  Number.isInteger(value.count) &&
  value.count > 0;

const isNftApiResponse = (value) =>
  isRecord(value) &&
  value.ok === true &&
  NFT_RESPONSE_ARRAY_KEYS.every(
    (key) => Array.isArray(value[key]) && value[key].every(isNftCount),
  );

const isExactNftApiResponse = (value) =>
  isNftApiResponse(value) &&
  hasExactKeys(value, NFT_RESPONSE_KEYS) &&
  NFT_RESPONSE_ARRAY_KEYS.every((key) =>
    value[key].every((item) => hasExactKeys(item, NFT_COUNT_KEYS)),
  );

const createEmptyNftApiResponse = () => ({
  ok: true,
  specials: [],
  swagpack_avatars: [],
  swagpack_reactions: [],
});

module.exports = {
  createEmptyNftApiResponse,
  isExactNftApiResponse,
  isNftApiResponse,
  NFT_RESPONSE_ARRAY_KEYS,
  VALID_REACTION_IDS,
};
