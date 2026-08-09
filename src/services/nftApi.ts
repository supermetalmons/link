import {
  isNftApiResponse,
  type NftApiRequest,
  type NftApiResponse,
} from "@mons/shared/nfts";

const NFT_API_URL = "https://api.mons.link/nfts";
const NFT_API_ERROR_MESSAGE = "NFT inventory is unavailable.";
const NFT_API_TIMEOUT_MS = 15_000;

export type { NftApiResponse, NftCount } from "@mons/shared/nfts";

function createNftApiError(): Error {
  return new Error(NFT_API_ERROR_MESSAGE);
}

export async function fetchNftsFromApi(
  sol: string,
  eth: string,
): Promise<NftApiResponse> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), NFT_API_TIMEOUT_MS);
  const requestBody: NftApiRequest = { sol, eth };
  try {
    const response = await fetch(NFT_API_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) {
      if (response.body) {
        void response.body.cancel().catch(() => undefined);
      }
      throw createNftApiError();
    }
    const payload: unknown = await response.json();
    if (!isNftApiResponse(payload)) {
      throw createNftApiError();
    }
    return payload;
  } catch {
    throw createNftApiError();
  } finally {
    clearTimeout(timeoutId);
  }
}
