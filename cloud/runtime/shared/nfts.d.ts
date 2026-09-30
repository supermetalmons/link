// Generated from src/shared/nfts.ts. Run npm run generate:runtime.
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
declare const VALID_REACTION_IDS: readonly number[];
declare const NFT_RESPONSE_ARRAY_KEYS: readonly [
  "specials",
  "swagpack_avatars",
  "swagpack_reactions",
];
declare const isNftApiResponse: (value: unknown) => value is NftApiResponse;
declare const isExactNftApiResponse: (
  value: unknown,
) => value is NftApiResponse;
declare const createEmptyNftApiResponse: () => NftApiResponse;
export {
  createEmptyNftApiResponse,
  isExactNftApiResponse,
  isNftApiResponse,
  NFT_RESPONSE_ARRAY_KEYS,
  VALID_REACTION_IDS,
};
