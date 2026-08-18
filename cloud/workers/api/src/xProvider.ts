import { readBoundedJsonValue } from "./boundedStreams.ts";

const X_TOKEN_URL = "https://api.x.com/2/oauth2/token";
const X_USER_URL = "https://api.x.com/2/users/me?user.fields=username";
const X_TIMEOUT_MS = 10_000;
const MAX_X_BODY_BYTES = 64 * 1024;

export type XAuthenticatedUser = {
  id: string;
  username: string;
};

export type XOAuthProvider = {
  exchangeCode: (input: {
    code: string;
    callbackUri: string;
    codeVerifier: string;
  }) => Promise<string>;
  fetchAuthenticatedUser: (accessToken: string) => Promise<XAuthenticatedUser>;
};

export class XProviderFailure extends Error {
  readonly publicCode: string;

  constructor(publicCode: string) {
    super(publicCode);
    this.publicCode = publicCode;
  }
}

function toRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function encodeBasicCredentials(
  clientId: string,
  clientSecret: string,
): string {
  const bytes = new TextEncoder().encode(`${clientId}:${clientSecret}`);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return `Basic ${btoa(binary)}`;
}

function providerErrorCode(
  prefix: string,
  payload: Record<string, unknown> | null,
  keys: string[],
): string {
  for (const key of keys) {
    const value = payload?.[key];
    if (typeof value === "string" && value.trim()) {
      return `${prefix}-${value.trim().replace(/\s+/g, "-").toLowerCase()}`;
    }
  }
  return `${prefix}-failed`;
}

async function providerJson(
  response: Response,
  failureCode: string,
): Promise<Record<string, unknown>> {
  const value = await readBoundedJsonValue(
    response,
    MAX_X_BODY_BYTES,
    () => new XProviderFailure(failureCode),
  );
  const record = toRecord(value);
  if (!record) {
    throw new XProviderFailure(failureCode);
  }
  return record;
}

export function createXOAuthProvider(
  env: Env,
  {
    fetcher = fetch,
    timeoutMs = X_TIMEOUT_MS,
  }: { fetcher?: typeof fetch; timeoutMs?: number } = {},
): XOAuthProvider {
  const clientId = env.X_CLIENT_ID.trim();
  const clientSecret = env.X_CLIENT_SECRET.trim();

  return {
    async exchangeCode({ code, callbackUri, codeVerifier }) {
      if (!clientId || !clientSecret) {
        throw new XProviderFailure("x-token-exchange-failed");
      }
      let response: Response;
      try {
        response = await fetcher(X_TOKEN_URL, {
          method: "POST",
          headers: {
            Authorization: encodeBasicCredentials(clientId, clientSecret),
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({
            code,
            grant_type: "authorization_code",
            redirect_uri: callbackUri,
            code_verifier: codeVerifier,
            client_id: clientId,
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        throw new XProviderFailure("x-token-exchange-failed");
      }
      if (!response.ok) {
        const payload = await providerJson(
          response,
          "x-token-exchange-failed",
        ).catch(() => null);
        throw new XProviderFailure(
          providerErrorCode("x-token-exchange", payload, [
            "error_description",
            "error",
          ]),
        );
      }
      const payload = await providerJson(response, "x-token-exchange-failed");
      const accessToken =
        typeof payload.access_token === "string"
          ? payload.access_token.trim()
          : "";
      if (!accessToken) {
        throw new XProviderFailure("x-token-missing-access-token");
      }
      return accessToken;
    },

    async fetchAuthenticatedUser(accessToken) {
      let response: Response;
      try {
        response = await fetcher(X_USER_URL, {
          method: "GET",
          headers: { Authorization: `Bearer ${accessToken}` },
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        throw new XProviderFailure("x-user-lookup-failed");
      }
      if (!response.ok) {
        const payload = await providerJson(
          response,
          "x-user-lookup-failed",
        ).catch(() => null);
        throw new XProviderFailure(
          providerErrorCode("x-user-lookup", payload, [
            "title",
            "detail",
            "error",
          ]),
        );
      }
      const payload = await providerJson(response, "x-user-lookup-failed");
      const data = toRecord(payload.data);
      const id = typeof data?.id === "string" ? data.id.trim() : "";
      const username =
        typeof data?.username === "string" ? data.username.trim() : "";
      if (!/^\d+$/.test(id)) {
        throw new XProviderFailure("x-user-lookup-missing-id");
      }
      return { id, username };
    },
  };
}
