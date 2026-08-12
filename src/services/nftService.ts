import { createEmptyNftApiResponse } from "@mons/shared/nfts";
import type { AuthState } from "../connection/authModels";
import type { AuthIdentity } from "../utils/storage";
import {
  fetchCachedNfts,
  NFT_CACHE_TTL_MS,
  type NftFetchSnapshot,
} from "./nftCache";
import { fetchNftsFromApi } from "./nftApi";

export { NFT_CACHE_TTL_MS, type NftFetchSnapshot } from "./nftCache";

export function getNftIdentityKey({
  profileId,
  solAddress,
  ethAddress,
}: AuthIdentity): string | null {
  if (!profileId) {
    return null;
  }
  return JSON.stringify([profileId, solAddress || "", ethAddress || ""]);
}

async function fetchNftsByIdentity(
  key: string,
  sol: string,
  eth: string,
): Promise<NftFetchSnapshot> {
  return fetchCachedNfts(key, () =>
    sol
      ? fetchNftsFromApi(sol, eth)
      : Promise.resolve(createEmptyNftApiResponse()),
  );
}

export async function fetchNftsForIdentity(
  identity: AuthState,
): Promise<NftFetchSnapshot> {
  if (identity.authStatus !== "authenticated") {
    return {
      data: createEmptyNftApiResponse(),
      expiresAtMs: Date.now() + NFT_CACHE_TTL_MS,
    };
  }
  const key = getNftIdentityKey(identity);
  if (!key) {
    return { data: { ok: false }, expiresAtMs: 0 };
  }
  return fetchNftsByIdentity(key, identity.solAddress, identity.ethAddress);
}
