import type { NftApiResponse } from "@mons/shared/nfts";

export const NFT_CACHE_TTL_MS = 5 * 60 * 1000;

export type NftFetchSnapshot = {
  data: NftApiResponse | { ok: false };
  expiresAtMs: number;
};

const inFlightRequests: Map<string, Promise<NftFetchSnapshot>> = new Map();
const responseCache: Map<string, NftFetchSnapshot> = new Map();
let cacheGeneration = 0;

export async function fetchCachedNfts(
  key: string,
  fetchNfts: () => Promise<NftApiResponse>,
): Promise<NftFetchSnapshot> {
  const cachedResponse = responseCache.get(key);
  if (cachedResponse && cachedResponse.expiresAtMs > Date.now()) {
    return cachedResponse;
  }
  if (cachedResponse) {
    responseCache.delete(key);
  }
  const existing = inFlightRequests.get(key);
  if (existing) {
    return existing;
  }
  const requestGeneration = cacheGeneration;
  const request = fetchNfts().then((data) => {
    const isCurrentGeneration = requestGeneration === cacheGeneration;
    const snapshot: NftFetchSnapshot = {
      data,
      expiresAtMs: isCurrentGeneration ? Date.now() + NFT_CACHE_TTL_MS : 0,
    };
    if (snapshot.expiresAtMs > 0) {
      responseCache.set(key, snapshot);
    }
    return snapshot;
  });
  inFlightRequests.set(key, request);
  const clearInFlightRequest = () => {
    if (inFlightRequests.get(key) === request) {
      inFlightRequests.delete(key);
    }
  };
  void request.then(clearInFlightRequest, clearInFlightRequest);
  return request;
}

export function resetNftCache() {
  cacheGeneration += 1;
  inFlightRequests.clear();
  responseCache.clear();
}
