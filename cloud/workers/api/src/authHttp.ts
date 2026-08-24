import { AuthApiFailure } from "./authErrors.ts";

const ALLOWED_AUTH_ORIGINS = new Set([
  "https://mons.link",
  "https://www.mons.link",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
]);
const AUTH_PREVIEW_HOST_PATTERN =
  /^[0-9a-f]{8}-mons-link\.lil-org\.workers\.dev$/;

export function isAllowedAuthOrigin(origin: string): boolean {
  if (ALLOWED_AUTH_ORIGINS.has(origin)) {
    return true;
  }
  try {
    const url = new URL(origin);
    return (
      url.origin === origin &&
      url.protocol === "https:" &&
      !url.port &&
      !url.username &&
      !url.password &&
      AUTH_PREVIEW_HOST_PATTERN.test(url.hostname)
    );
  } catch {
    return false;
  }
}

export const AUTH_PATHS = new Set([
  "/auth/intents",
  "/auth/methods/apple/verify",
  "/auth/methods/eth/verify",
  "/auth/methods",
  "/auth/methods/sol/verify",
  "/auth/methods/unlink",
  "/auth/profile-claim/sync",
  "/auth/x/flows",
  "/auth/x/flows/complete",
]);

export function getAuthCorsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get("Origin")?.trim() || "";
  if (origin && !isAllowedAuthOrigin(origin)) {
    throw new AuthApiFailure(403, "permission-denied", "origin-not-allowed");
  }
  return {
    ...(origin ? { "Access-Control-Allow-Origin": origin } : {}),
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

export function authPreflightResponse(headers: HeadersInit): Response {
  return new Response(null, {
    status: 204,
    headers: { ...headers, "Cache-Control": "no-store" },
  });
}

export function authJsonResponse(
  body: unknown,
  status: number,
  headers: HeadersInit,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...headers,
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
