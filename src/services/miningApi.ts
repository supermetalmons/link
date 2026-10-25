import type {
  ApiHttpUrl,
  ApiRequest,
  ApiResponse,
} from "@mons/shared/api-contracts";
import { isMineRockResponse } from "@mons/shared/mining";
import {
  authenticatedJsonRequest,
  type ApiErrorPolicy,
  type AuthTokenProvider,
} from "./apiTransport";
type MineRockRequest = ApiRequest<"POST /mining/rock">;
type MineRockResponse = ApiResponse<"POST /mining/rock">;

const MINING_API_URL =
  "https://api.mons.link/mining/rock" satisfies ApiHttpUrl<"POST /mining/rock">;
const MINING_API_TIMEOUT_MS = 45_000;
const MINING_API_MAX_RESPONSE_BYTES = 64 * 1024;

export class MiningApiError extends Error {
  readonly code: string;
  readonly details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = "MiningApiError";
    this.code = code;
    this.details = details;
  }
}

const miningErrorPolicy: ApiErrorPolicy = {
  createError: (code, message, details) =>
    new MiningApiError(code, message, details),
  normalizeError: (error) =>
    error instanceof MiningApiError ? error : undefined,
  unavailableMessage: "Mining service is unavailable.",
  timeoutMessage: "Mining request timed out.",
};

export async function mineRockViaApi(
  request: MineRockRequest,
  tokenProvider: AuthTokenProvider,
): Promise<MineRockResponse> {
  return authenticatedJsonRequest({
    url: MINING_API_URL,
    createRequestInit: () => ({
      method: "POST",
      body: JSON.stringify(request),
    }),
    tokenProvider,
    validate: isMineRockResponse,
    timeoutMs: MINING_API_TIMEOUT_MS,
    maxResponseBytes: MINING_API_MAX_RESPONSE_BYTES,
    errors: miningErrorPolicy,
  });
}
