import type { NftApiRequest } from "@mons/shared/nfts";
import { isValidSolanaAddress } from "@mons/shared/solana";
import { readBoundedText } from "./boundedStreams.ts";

const MAX_REQUEST_BODY_BYTES = 4096;

export const CORS_HEADERS = {
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

export function jsonResponse(
  body: unknown,
  status: number,
  headers?: HeadersInit,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...BASE_HEADERS, ...headers },
  });
}

export async function readBoundedBody(
  request: Request,
  maxBytes = MAX_REQUEST_BODY_BYTES,
): Promise<string> {
  const contentLength = request.headers.get("Content-Length");
  if (contentLength) {
    const parsedLength = Number(contentLength);
    if (Number.isFinite(parsedLength) && parsedLength > maxBytes) {
      throw new Error("Invalid request body.");
    }
  }
  if (!request.body) {
    throw new Error("Invalid request body.");
  }
  return readBoundedText(
    request.body,
    maxBytes,
    () => new Error("Invalid request body."),
  );
}

export async function readBoundedJson(
  request: Request,
  maxBytes = MAX_REQUEST_BODY_BYTES,
): Promise<unknown> {
  return JSON.parse(await readBoundedBody(request, maxBytes)) as unknown;
}

export async function parseRequestBody(
  request: Request,
): Promise<NftApiRequest> {
  const parsed = await readBoundedJson(request);
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
