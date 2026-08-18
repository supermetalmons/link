import { cancelResponseBody, readBoundedJsonValue } from "./boundedStreams.ts";

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const FIRESTORE_SCOPE = "https://www.googleapis.com/auth/datastore";
const GOOGLE_TIMEOUT_MS = 5_000;
const MAX_UPSTREAM_BODY_BYTES = 64 * 1024;

export class GoogleAuthFailure extends Error {
  constructor() {
    super("google-auth-unavailable");
  }
}

function toRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function base64UrlEncodeBytes(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function base64UrlEncodeJson(value: Record<string, unknown>): string {
  return base64UrlEncodeBytes(new TextEncoder().encode(JSON.stringify(value)));
}

function decodePrivateKey(privateKeyPem: string): Uint8Array {
  const normalized = privateKeyPem.trim().replace(/\\n/g, "\n");
  const match = normalized.match(
    /^-----BEGIN PRIVATE KEY-----\s+([A-Za-z0-9+/=\s]+)\s+-----END PRIVATE KEY-----$/,
  );
  if (!match) {
    throw new GoogleAuthFailure();
  }
  let binary: string;
  try {
    binary = atob(match[1].replace(/\s+/g, ""));
  } catch {
    throw new GoogleAuthFailure();
  }
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export async function createServiceAccountAssertion({
  email,
  privateKeyPem,
  nowMs,
  scopes = [FIRESTORE_SCOPE],
}: {
  email: string;
  privateKeyPem: string;
  nowMs: number;
  scopes?: readonly string[];
}): Promise<string> {
  const normalizedEmail = email.trim();
  const normalizedScopes = scopes.map((scope) => scope.trim()).filter(Boolean);
  if (
    !normalizedEmail ||
    !Number.isFinite(nowMs) ||
    normalizedScopes.length === 0 ||
    normalizedScopes.length !== scopes.length
  ) {
    throw new GoogleAuthFailure();
  }
  const nowSeconds = Math.floor(nowMs / 1_000);
  const encodedHeader = base64UrlEncodeJson({ alg: "RS256", typ: "JWT" });
  const encodedPayload = base64UrlEncodeJson({
    iss: normalizedEmail,
    scope: normalizedScopes.join(" "),
    aud: GOOGLE_TOKEN_URL,
    iat: nowSeconds,
    exp: nowSeconds + 3_600,
  });
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  try {
    const privateKeyBytes = decodePrivateKey(privateKeyPem);
    const privateKeyData = new ArrayBuffer(privateKeyBytes.byteLength);
    new Uint8Array(privateKeyData).set(privateKeyBytes);
    const key = await crypto.subtle.importKey(
      "pkcs8",
      privateKeyData,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signature = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      key,
      new TextEncoder().encode(signingInput),
    );
    return `${signingInput}.${base64UrlEncodeBytes(new Uint8Array(signature))}`;
  } catch (error) {
    if (error instanceof GoogleAuthFailure) {
      throw error;
    }
    throw new GoogleAuthFailure();
  }
}

export async function createGoogleAccessToken(
  env: Env,
  {
    credentials = {
      email: env.FIRESTORE_SERVICE_ACCOUNT_EMAIL,
      privateKeyPem: env.FIRESTORE_SERVICE_ACCOUNT_PRIVATE_KEY,
    },
    fetcher = fetch,
    now = Date.now,
    scopes = [FIRESTORE_SCOPE],
    timeoutMs = GOOGLE_TIMEOUT_MS,
  }: {
    credentials?: { email: string; privateKeyPem: string };
    fetcher?: typeof fetch;
    now?: () => number;
    scopes?: readonly string[];
    timeoutMs?: number;
  } = {},
): Promise<string> {
  const assertion = await createServiceAccountAssertion({
    email: credentials.email,
    privateKeyPem: credentials.privateKeyPem,
    nowMs: now(),
    scopes,
  });
  let response: Response;
  try {
    response = await fetcher(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new GoogleAuthFailure();
  }
  if (!response.ok) {
    await cancelResponseBody(response);
    throw new GoogleAuthFailure();
  }
  const payload = toRecord(
    await readBoundedJsonValue(
      response,
      MAX_UPSTREAM_BODY_BYTES,
      () => new GoogleAuthFailure(),
    ),
  );
  const accessToken =
    typeof payload?.access_token === "string"
      ? payload.access_token.trim()
      : "";
  if (!accessToken) {
    throw new GoogleAuthFailure();
  }
  return accessToken;
}
