const X_AUTHORIZATION_URL = "https://x.com/i/oauth2/authorize";
export const X_CALLBACK_URI = "https://api.mons.link/auth/x/callback";
export const X_FLOW_TTL_MS = 10 * 60 * 1_000;
export const X_FLOW_ID_PATTERN = /^[A-Za-z0-9_-]{24}$/;

const DEFAULT_RETURN_URL = "https://mons.link/";
const ALLOWED_RETURN_ORIGINS = new Set([
  "https://mons.link",
  "https://www.mons.link",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
]);

export function safeXReturnUrl(value: string): string {
  try {
    const url = new URL(value);
    return ALLOWED_RETURN_ORIGINS.has(url.origin)
      ? url.toString()
      : DEFAULT_RETURN_URL;
  } catch {
    return DEFAULT_RETURN_URL;
  }
}

export function buildXAuthorizationUrl({
  clientId,
  codeChallenge,
  flowId,
}: {
  clientId: string;
  codeChallenge: string;
  flowId: string;
}): string {
  const url = new URL(X_AUTHORIZATION_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", X_CALLBACK_URI);
  url.searchParams.set("scope", "tweet.read users.read");
  url.searchParams.set("state", flowId);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}
