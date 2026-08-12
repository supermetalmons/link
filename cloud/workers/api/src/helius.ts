import type { NftCount } from "@mons/shared/nfts";
import {
  cancelResponseBody,
  readBoundedJsonResponse,
} from "./boundedStreams.ts";
import { ProviderFailure, type WorkerDependencies } from "./provider.ts";

export const PRIMARY_COLLECTION_ID =
  "C22esis7kQMbX9JGWsMaKvsh1X5GeBmHPju28jiKDyAP";
export const SPECIALS_COLLECTION_ID =
  "GCcbUaghGawyM76BhJHsHUXb9kq7H3AZhPL7S3p9WajP";

const HELIUS_RPC_ORIGIN = "https://mainnet.helius-rpc.com/";
const HELIUS_PAGE_LIMIT = 1000;
const HELIUS_MAX_PAGES_PER_COLLECTION = 3;
const HELIUS_MAX_ITEMS_PER_COLLECTION =
  HELIUS_PAGE_LIMIT * HELIUS_MAX_PAGES_PER_COLLECTION;

interface HeliusSearchResult {
  items: unknown[];
  total?: number;
  cursor?: string;
}

interface HeliusRpcResponse {
  error?: unknown;
  result?: unknown;
}

export interface HeliusLookupContext {
  apiKey: string;
  ownerAddress: string;
  signal: AbortSignal;
  dependencies: WorkerDependencies;
}

export function extractIdFromJsonUri(jsonUri: unknown): number | null {
  if (typeof jsonUri !== "string" || !jsonUri) {
    return null;
  }
  const lastSlash = jsonUri.lastIndexOf("/");
  let tail = lastSlash >= 0 ? jsonUri.slice(lastSlash + 1) : jsonUri;
  const queryIndex = tail.indexOf("?");
  if (queryIndex >= 0) {
    tail = tail.slice(0, queryIndex);
  }
  const hashIndex = tail.indexOf("#");
  if (hashIndex >= 0) {
    tail = tail.slice(0, hashIndex);
  }
  const id = Number.parseInt(tail, 10);
  return Number.isFinite(id) ? id : null;
}

function getJsonUri(item: unknown): unknown {
  if (!item || typeof item !== "object") {
    return undefined;
  }
  const content = (item as { content?: unknown }).content;
  if (!content || typeof content !== "object") {
    return undefined;
  }
  return (content as { json_uri?: unknown }).json_uri;
}

function parseHeliusResult(payload: unknown): HeliusSearchResult {
  if (!payload || typeof payload !== "object") {
    throw new ProviderFailure("unavailable");
  }
  const rpcPayload = payload as HeliusRpcResponse;
  if (rpcPayload.error) {
    throw new ProviderFailure("unavailable");
  }
  if (!rpcPayload.result || typeof rpcPayload.result !== "object") {
    throw new ProviderFailure("unavailable");
  }
  const result = rpcPayload.result as {
    items?: unknown;
    total?: unknown;
    cursor?: unknown;
  };
  if (!Array.isArray(result.items)) {
    throw new ProviderFailure("unavailable");
  }
  if (
    result.total !== undefined &&
    result.total !== null &&
    (typeof result.total !== "number" ||
      !Number.isSafeInteger(result.total) ||
      result.total < 0)
  ) {
    throw new ProviderFailure("unavailable");
  }
  if (
    result.cursor !== undefined &&
    result.cursor !== null &&
    typeof result.cursor !== "string"
  ) {
    throw new ProviderFailure("unavailable");
  }
  return {
    items: result.items,
    total: typeof result.total === "number" ? result.total : undefined,
    cursor: typeof result.cursor === "string" ? result.cursor : undefined,
  };
}

async function requestHeliusPage(
  context: HeliusLookupContext,
  collectionId: string,
  cursor: string | undefined,
): Promise<HeliusSearchResult> {
  const { apiKey, ownerAddress, signal, dependencies } = context;
  const params: Record<string, unknown> = {
    ownerAddress,
    grouping: ["collection", collectionId],
    tokenType: "nonFungible",
    limit: HELIUS_PAGE_LIMIT,
    options: {
      showUnverifiedCollections: false,
      showCollectionMetadata: false,
      showGrandTotal: false,
      showNativeBalance: false,
      showZeroBalance: false,
    },
  };
  if (cursor) {
    params.cursor = cursor;
  }

  try {
    const response = await dependencies.providerFetch(
      `${HELIUS_RPC_ORIGIN}?api-key=${encodeURIComponent(apiKey)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "mons-get-nfts",
          method: "searchAssets",
          params,
        }),
        signal,
      },
    );
    if (!response.ok) {
      await cancelResponseBody(response);
      if (signal.aborted) {
        throw new ProviderFailure("timeout");
      }
      if (response.status === 408 || response.status === 504) {
        throw new ProviderFailure("timeout");
      }
      throw new ProviderFailure("unavailable");
    }
    const payload = await readBoundedJsonResponse(
      response,
      dependencies.providerMaxResponseBodyBytes,
    );
    if (signal.aborted) {
      throw new ProviderFailure("timeout");
    }
    return parseHeliusResult(payload);
  } catch (error) {
    if (error instanceof ProviderFailure) {
      if (error.kind !== "timeout" && signal.aborted) {
        throw new ProviderFailure("timeout");
      }
      throw error;
    }
    if (signal.aborted) {
      throw new ProviderFailure("timeout");
    }
    throw new ProviderFailure("unavailable");
  }
}

export async function fetchCollectionIdCounts(
  context: HeliusLookupContext,
  collectionId: string,
): Promise<NftCount[]> {
  const idCounts = new Map<number, number>();
  let cursor: string | undefined;
  let fetched = 0;
  let total: number | undefined;
  let pagesFetched = 0;
  const observedCursors = new Set<string>();

  while (true) {
    if (pagesFetched >= HELIUS_MAX_PAGES_PER_COLLECTION) {
      throw new ProviderFailure("unavailable");
    }
    const result = await requestHeliusPage(context, collectionId, cursor);
    pagesFetched += 1;
    if (typeof result.total === "number") {
      total = result.total;
      if (total > HELIUS_MAX_ITEMS_PER_COLLECTION) {
        throw new ProviderFailure("unavailable");
      }
    }
    const nextFetched = fetched + result.items.length;
    const nextCursor = result.cursor || undefined;
    if (
      result.items.length > 0 &&
      nextCursor &&
      observedCursors.has(nextCursor)
    ) {
      throw new ProviderFailure("unavailable");
    }
    if (result.items.length === 0) {
      break;
    }
    if (total !== undefined && nextFetched > total) {
      throw new ProviderFailure("unavailable");
    }
    for (const item of result.items) {
      const id = extractIdFromJsonUri(getJsonUri(item));
      if (id === null) {
        continue;
      }
      idCounts.set(id, (idCounts.get(id) ?? 0) + 1);
    }
    fetched = nextFetched;
    if (total !== undefined && fetched === total) {
      break;
    }
    if (!nextCursor) {
      if (total === undefined && result.items.length < HELIUS_PAGE_LIMIT) {
        break;
      }
      throw new ProviderFailure("unavailable");
    }
    observedCursors.add(nextCursor);
    cursor = nextCursor;
  }

  return Array.from(idCounts, ([id, count]) => ({ id, count }));
}
