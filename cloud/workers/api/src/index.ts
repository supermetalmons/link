import {
  createEmptyNftApiResponse,
  VALID_REACTION_IDS,
  type NftApiRequest,
  type NftApiResponse,
  type NftCount,
} from "@mons/shared/nfts";
import { isValidSolanaAddress } from "@mons/shared/solana";

export const PRIMARY_COLLECTION_ID =
  "C22esis7kQMbX9JGWsMaKvsh1X5GeBmHPju28jiKDyAP";
export const SPECIALS_COLLECTION_ID =
  "GCcbUaghGawyM76BhJHsHUXb9kq7H3AZhPL7S3p9WajP";

const HELIUS_RPC_ORIGIN = "https://mainnet.helius-rpc.com/";
const HELIUS_PAGE_LIMIT = 1000;
const HELIUS_MAX_PAGES_PER_COLLECTION = 3;
const HELIUS_MAX_ITEMS_PER_COLLECTION =
  HELIUS_PAGE_LIMIT * HELIUS_MAX_PAGES_PER_COLLECTION;
const HELIUS_TIMEOUT_MS = 10_000;
const MAX_HELIUS_RESPONSE_BODY_BYTES = 8 * 1024 * 1024;
const MAX_REQUEST_BODY_BYTES = 4096;
const RATE_LIMIT_RETRY_AFTER_SECONDS = 60;
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};
const BASE_HEADERS = {
  ...CORS_HEADERS,
  "Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8",
  "X-Content-Type-Options": "nosniff",
};
const REACTION_IDS = new Set<number>(VALID_REACTION_IDS);

interface HeliusSearchResult {
  items: unknown[];
  total?: number;
  cursor?: string;
}

interface HeliusRpcResponse {
  error?: unknown;
  result?: unknown;
}

export type ProviderFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

interface WorkerDependencies {
  providerFetch: ProviderFetch;
  providerTimeoutMs: number;
  providerMaxResponseBodyBytes: number;
  logProviderFailure: (kind: ProviderFailureKind) => void;
  logRateLimitFailure: () => void;
}

interface HeliusLookupContext {
  apiKey: string;
  ownerAddress: string;
  signal: AbortSignal;
  dependencies: WorkerDependencies;
}

type ProviderFailureKind = "configuration" | "timeout" | "unavailable";

class ProviderFailure extends Error {
  readonly kind: ProviderFailureKind;

  constructor(kind: ProviderFailureKind) {
    super(kind);
    this.kind = kind;
  }
}

function jsonResponse(body: unknown, status: number, headers?: HeadersInit) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...BASE_HEADERS, ...headers },
  });
}

async function readBoundedText(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  createLimitError: () => Error,
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const chunks: string[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      size += value.byteLength;
      if (size > maxBytes) {
        throw createLimitError();
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join("");
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    throw error;
  }
}

async function readBoundedBody(request: Request): Promise<string> {
  const contentLength = request.headers.get("Content-Length");
  if (contentLength) {
    const parsedLength = Number(contentLength);
    if (
      Number.isFinite(parsedLength) &&
      parsedLength > MAX_REQUEST_BODY_BYTES
    ) {
      throw new Error("Invalid request body.");
    }
  }
  if (!request.body) {
    throw new Error("Invalid request body.");
  }
  return readBoundedText(
    request.body,
    MAX_REQUEST_BODY_BYTES,
    () => new Error("Invalid request body."),
  );
}

async function parseRequestBody(request: Request): Promise<NftApiRequest> {
  const parsed: unknown = JSON.parse(await readBoundedBody(request));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid request body.");
  }
  const candidate = parsed as { sol?: unknown; eth?: unknown };
  if (typeof candidate.sol !== "string" || typeof candidate.eth !== "string") {
    throw new Error("Invalid request body.");
  }
  if (candidate.sol && !isValidSolanaAddress(candidate.sol)) {
    throw new Error("Invalid request body.");
  }
  return { sol: candidate.sol, eth: candidate.eth };
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

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {}
}

async function readBoundedJsonResponse(
  response: Response,
  maxBytes: number,
): Promise<unknown> {
  const contentLength = response.headers.get("Content-Length");
  if (contentLength) {
    const parsedLength = Number(contentLength);
    if (Number.isFinite(parsedLength) && parsedLength > maxBytes) {
      await cancelResponseBody(response);
      throw new ProviderFailure("unavailable");
    }
  }
  if (!response.body) {
    throw new ProviderFailure("unavailable");
  }
  return JSON.parse(
    await readBoundedText(
      response.body,
      maxBytes,
      () => new ProviderFailure("unavailable"),
    ),
  ) as unknown;
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

async function fetchCollectionIdCounts(
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

async function fetchNftInventory(
  requestBody: NftApiRequest,
  env: Env,
  dependencies: WorkerDependencies,
): Promise<NftApiResponse> {
  if (!requestBody.sol) {
    return createEmptyNftApiResponse();
  }
  const apiKey = env.HELIUS_RPC_API_KEY.trim();
  if (!apiKey) {
    throw new ProviderFailure("configuration");
  }

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    dependencies.providerTimeoutMs,
  );
  try {
    const context: HeliusLookupContext = {
      apiKey,
      ownerAddress: requestBody.sol,
      signal: controller.signal,
      dependencies,
    };
    const [swagpackAvatars, specials] = await Promise.all([
      fetchCollectionIdCounts(context, PRIMARY_COLLECTION_ID),
      fetchCollectionIdCounts(context, SPECIALS_COLLECTION_ID),
    ]);
    return {
      ok: true,
      specials,
      swagpack_avatars: swagpackAvatars,
      swagpack_reactions: swagpackAvatars.filter(({ id }) =>
        REACTION_IDS.has(id),
      ),
    };
  } catch (error) {
    controller.abort();
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

const defaultDependencies: WorkerDependencies = {
  providerFetch: (input, init) => fetch(input, init),
  providerTimeoutMs: HELIUS_TIMEOUT_MS,
  providerMaxResponseBodyBytes: MAX_HELIUS_RESPONSE_BODY_BYTES,
  logProviderFailure: (kind) => {
    console.error({ event: "nft_provider_failure", kind });
  },
  logRateLimitFailure: () => {
    console.error({ event: "nft_rate_limit_failure" });
  },
};

export async function handleRequest(
  request: Request,
  env: Env,
  dependencyOverrides: Partial<WorkerDependencies> = {},
): Promise<Response> {
  const pathname = new URL(request.url).pathname;
  if (pathname !== "/nfts") {
    return jsonResponse({ ok: false, error: "not-found" }, 404);
  }
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        ...CORS_HEADERS,
        "Cache-Control": "no-store",
      },
    });
  }
  if (request.method !== "POST") {
    return jsonResponse({ ok: false, error: "method-not-allowed" }, 405, {
      Allow: "POST, OPTIONS",
    });
  }

  const dependencies = { ...defaultDependencies, ...dependencyOverrides };
  const connectingIp = request.headers.get("CF-Connecting-IP")?.trim();
  try {
    const outcome = await env.NFT_RATE_LIMITER.limit({
      key: `nfts:${connectingIp || "unknown"}`,
    });
    if (!outcome.success) {
      return jsonResponse({ ok: false, error: "rate-limited" }, 429, {
        "Retry-After": String(RATE_LIMIT_RETRY_AFTER_SECONDS),
      });
    }
  } catch {
    dependencies.logRateLimitFailure();
    return jsonResponse({ ok: false, error: "rate-limit-unavailable" }, 503);
  }

  let requestBody: NftApiRequest;
  try {
    requestBody = await parseRequestBody(request);
  } catch {
    return jsonResponse({ ok: false, error: "invalid-request" }, 400);
  }

  try {
    return jsonResponse(
      await fetchNftInventory(requestBody, env, dependencies),
      200,
    );
  } catch (error) {
    const kind = error instanceof ProviderFailure ? error.kind : "unavailable";
    dependencies.logProviderFailure(kind);
    if (kind === "timeout") {
      return jsonResponse({ ok: false, error: "nft-provider-timeout" }, 504);
    }
    return jsonResponse({ ok: false, error: "nft-provider-unavailable" }, 502);
  }
}

export default {
  fetch(request, env) {
    return handleRequest(request, env);
  },
} satisfies ExportedHandler<Env>;
