export interface NftApiRequest {
  sol: string;
  eth: string;
}

export interface NftCount {
  id: number;
  count: number;
}

export interface NftApiResponse {
  ok: true;
  specials: NftCount[];
  swagpack_avatars: NftCount[];
  swagpack_reactions: NftCount[];
}

const VALID_REACTION_IDS: readonly number[] = Object.freeze([
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
] as const);
const NFT_RESPONSE_KEYS = Object.freeze(["ok", ...NFT_RESPONSE_ARRAY_KEYS]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasExactKeys = (
  value: object,
  expectedKeys: readonly string[],
): boolean => {
  const actualKeys = Object.keys(value);
  return (
    actualKeys.length === expectedKeys.length &&
    actualKeys.every((key) => expectedKeys.includes(key))
  );
};

const isNftCount = (value: unknown): value is NftCount =>
  isRecord(value) &&
  Number.isInteger(value.id) &&
  Number.isInteger(value.count) &&
  (value.count as number) > 0;

const isNftApiResponse = (value: unknown): value is NftApiResponse =>
  isRecord(value) &&
  value.ok === true &&
  NFT_RESPONSE_ARRAY_KEYS.every(
    (key) => Array.isArray(value[key]) && value[key].every(isNftCount),
  );

const isExactNftApiResponse = (value: unknown): value is NftApiResponse =>
  isNftApiResponse(value) &&
  hasExactKeys(value, NFT_RESPONSE_KEYS) &&
  NFT_RESPONSE_ARRAY_KEYS.every((key) =>
    value[key].every((item) => hasExactKeys(item, NFT_COUNT_KEYS)),
  );

const createEmptyNftApiResponse = (): NftApiResponse => ({
  ok: true,
  specials: [],
  swagpack_avatars: [],
  swagpack_reactions: [],
});

export {
  createEmptyNftApiResponse,
  isExactNftApiResponse,
  isNftApiResponse,
  NFT_RESPONSE_ARRAY_KEYS,
  VALID_REACTION_IDS,
};
