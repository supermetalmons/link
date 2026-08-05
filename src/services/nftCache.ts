export const NFT_CACHE_TTL_MS = 5 * 60 * 1000;

export type NftFetchSnapshot = {
  data: any;
  expiresAtMs: number;
};

const inFlightRequests: Map<string, Promise<NftFetchSnapshot>> = new Map();
const responseCache: Map<string, NftFetchSnapshot> = new Map();
let cacheGeneration = 0;

export function getEmptyNftCollection() {
  return {
    ok: true,
    specials: [],
    swagpack_avatars: [],
    swagpack_reactions: [],
  };
}

function isLegacyMissingAddressError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const { code, message } = error as { code?: unknown; message?: unknown };
  return (
    (code === "functions/invalid-argument" || code === "invalid-argument") &&
    message === "Some address is required."
  );
}

export async function fetchCachedNfts(
  key: string,
  sol: string,
  eth: string,
  fetchNfts: () => Promise<any>,
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
  const request = fetchNfts()
    .then((data) => {
      const isCurrentGeneration = requestGeneration === cacheGeneration;
      const snapshot: NftFetchSnapshot = {
        data,
        expiresAtMs:
          isCurrentGeneration && data?.ok === true
            ? Date.now() + NFT_CACHE_TTL_MS
            : 0,
      };
      if (snapshot.expiresAtMs > 0) {
        responseCache.set(key, snapshot);
      }
      return snapshot;
    })
    .catch((error) => {
      if (!sol && !eth && isLegacyMissingAddressError(error)) {
        const snapshot: NftFetchSnapshot = {
          data: getEmptyNftCollection(),
          expiresAtMs:
            requestGeneration === cacheGeneration
              ? Date.now() + NFT_CACHE_TTL_MS
              : 0,
        };
        if (snapshot.expiresAtMs > 0) {
          responseCache.set(key, snapshot);
        }
        return snapshot;
      }
      throw error;
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
