import {
  isMineRockResponse,
  type MineRockRequest,
  type MineRockResponse,
} from "@mons/shared/mining";
import type { AuthTokenProvider } from "./authApi";

const MINING_API_URL = "https://api.mons.link/mining/rock";
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cancelBody(response: Response): void {
  void response.body?.cancel().catch(() => undefined);
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const contentLength = Number(response.headers.get("Content-Length"));
  if (
    Number.isFinite(contentLength) &&
    contentLength > MINING_API_MAX_RESPONSE_BYTES
  ) {
    cancelBody(response);
    throw new MiningApiError("unavailable", "Mining service is unavailable.");
  }
  if (!response.body) {
    throw new MiningApiError("unavailable", "Mining service is unavailable.");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const chunks: string[] = [];
  let bytesRead = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      bytesRead += value.byteLength;
      if (bytesRead > MINING_API_MAX_RESPONSE_BYTES) {
        throw new Error("oversized-response");
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return JSON.parse(chunks.join("")) as unknown;
  } catch {
    void reader.cancel().catch(() => undefined);
    throw new MiningApiError("unavailable", "Mining service is unavailable.");
  }
}

function responseError(value: unknown, status: number): MiningApiError {
  const body = isRecord(value) ? value : {};
  const code =
    typeof body.error === "string" && body.error.trim()
      ? body.error.trim()
      : status === 401
        ? "unauthenticated"
        : "unavailable";
  const message =
    typeof body.message === "string" && body.message.trim()
      ? body.message.trim()
      : "Mining service is unavailable.";
  return new MiningApiError(code, message, body.details);
}

export async function mineRockViaApi(
  request: MineRockRequest,
  tokenProvider: AuthTokenProvider,
): Promise<MineRockResponse> {
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      reject(new MiningApiError("unavailable", "Mining request timed out."));
    }, MINING_API_TIMEOUT_MS);
  });
  const run = async (): Promise<MineRockResponse> => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const token = await tokenProvider(attempt === 1);
        if (controller.signal.aborted) {
          throw new MiningApiError("unavailable", "Mining request timed out.");
        }
        const response = await fetch(MINING_API_URL, {
          method: "POST",
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(request),
          cache: "no-store",
          signal: controller.signal,
        });
        if (response.status === 401 && attempt === 0) {
          cancelBody(response);
          continue;
        }
        const payload = await readBoundedJson(response);
        if (!response.ok) {
          throw responseError(payload, response.status);
        }
        if (!isMineRockResponse(payload)) {
          throw new MiningApiError(
            "unavailable",
            "Mining service is unavailable.",
          );
        }
        return payload;
      } catch (error) {
        if (error instanceof MiningApiError) {
          throw error;
        }
        throw new MiningApiError(
          "unavailable",
          "Mining service is unavailable.",
        );
      }
    }
    throw new MiningApiError("unauthenticated", "authentication-required");
  };
  try {
    return await Promise.race([run(), deadline]);
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
}
