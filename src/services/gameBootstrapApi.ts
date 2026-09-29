import { normalizeRecordKey } from "@mons/shared/ids";
import {
  GAME_BOOTSTRAP_MAX_RESPONSE_BYTES,
  isReadGameBootstrapResponse,
  type ReadGameBootstrapResponse,
} from "@mons/shared/game-bootstrap";
import { readSnapshotJson, type AuthTokenProvider } from "./apiTransport";

const GAME_BOOTSTRAP_API_ROOT = "https://api.mons.link";
export const GAME_BOOTSTRAP_REQUEST_TIMEOUT_MS = 10_000;

export class GameBootstrapApiError extends Error {
  readonly code: string;
  readonly status?: number;
  readonly retryAfterMs?: number;

  constructor(code: string, status?: number, retryAfterMs?: number) {
    super(code);
    this.name = "GameBootstrapApiError";
    this.code = code;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

function bootstrapPath(
  inviteId: string,
  selection: "current" | "approved",
): string {
  if (!inviteId || normalizeRecordKey(inviteId) !== inviteId) {
    throw new GameBootstrapApiError("invalid-invite");
  }
  return `/invites/${encodeURIComponent(inviteId)}/bootstrap${selection === "approved" ? "?selection=approved" : ""}`;
}

export async function readGameBootstrapViaApi(
  inviteId: string,
  tokenProvider?: AuthTokenProvider,
  options: { signal?: AbortSignal; selection?: "current" | "approved" } = {},
): Promise<ReadGameBootstrapResponse> {
  const path = bootstrapPath(inviteId, options.selection ?? "current");
  return readSnapshotJson({
    url: `${GAME_BOOTSTRAP_API_ROOT}${path}`,
    tokenProvider,
    signal: options.signal,
    timeoutMs: GAME_BOOTSTRAP_REQUEST_TIMEOUT_MS,
    maxResponseBytes: GAME_BOOTSTRAP_MAX_RESPONSE_BYTES,
    validate: (payload): payload is ReadGameBootstrapResponse =>
      isReadGameBootstrapResponse(payload) &&
      payload.metadata.inviteId === inviteId,
    createError: (code, status, retryAfterMs) =>
      new GameBootstrapApiError(code, status, retryAfterMs),
  });
}
