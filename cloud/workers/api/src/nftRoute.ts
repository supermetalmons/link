import type { ApiRequest } from "@mons/shared/api-contracts";
import { CORS_HEADERS, jsonResponse, parseRequestBody } from "./http.ts";
import { fetchNftInventory } from "./inventory.ts";
import {
  HELIUS_TIMEOUT_MS,
  MAX_HELIUS_RESPONSE_BODY_BYTES,
  ProviderFailure,
  type WorkerDependencies,
} from "./provider.ts";
type NftApiRequest = ApiRequest<"POST /nfts">;

const RATE_LIMIT_RETRY_AFTER_SECONDS = 60;

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

export async function handleNftRoute(
  request: Request,
  env: Env,
  dependencyOverrides: Partial<WorkerDependencies> = {},
): Promise<Response> {
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
    return jsonResponse<"POST /nfts", 200>(
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
