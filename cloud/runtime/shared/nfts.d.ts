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

export const NFT_RESPONSE_ARRAY_KEYS: readonly [
  "specials",
  "swagpack_avatars",
  "swagpack_reactions",
];
export const VALID_REACTION_IDS: readonly number[];

export function createEmptyNftApiResponse(): NftApiResponse;
export function isExactNftApiResponse(value: unknown): value is NftApiResponse;
export function isNftApiResponse(value: unknown): value is NftApiResponse;
