import assert from "node:assert/strict";
import test from "node:test";
import { createXOAuthProvider, XProviderFailure } from "../src/xProvider.ts";

const env = {
  FIRESTORE_SERVICE_ACCOUNT_EMAIL: "worker@example.iam.gserviceaccount.com",
  FIRESTORE_SERVICE_ACCOUNT_PRIVATE_KEY: "test-private-key",
  HELIUS_RPC_API_KEY: "test-helius-key",
  AUTH_DISABLE_X_VERIFY: "false",
  AUTH_RATE_LIMITER: { limit: async () => ({ success: true }) },
  NFT_RATE_LIMITER: { limit: async () => ({ success: true }) },
  X_CLIENT_ID: "x-client-id",
  X_CLIENT_SECRET: "x-client-secret",
} as Env;

test("uses the exact confidential PKCE token exchange and authenticated-user request", async () => {
  const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  const responses = [
    new Response(JSON.stringify({ access_token: "user-access-token" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
    new Response(
      JSON.stringify({ data: { id: "2244994945", username: "XDevelopers" } }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ),
  ];
  const fetcher: typeof fetch = async (input, init) => {
    requests.push({ input, init });
    const response = responses.shift();
    if (!response) {
      throw new Error("missing response");
    }
    return response;
  };
  const provider = createXOAuthProvider(env, { fetcher });
  const accessToken = await provider.exchangeCode({
    code: "authorization-code",
    callbackUri: "https://api.mons.link/auth/x/callback",
    codeVerifier: "code-verifier",
  });
  assert.equal(accessToken, "user-access-token");
  assert.deepEqual(await provider.fetchAuthenticatedUser(accessToken), {
    id: "2244994945",
    username: "XDevelopers",
  });

  assert.equal(String(requests[0].input), "https://api.x.com/2/oauth2/token");
  assert.equal(requests[0].init?.method, "POST");
  assert.equal(
    new Headers(requests[0].init?.headers).get("authorization"),
    `Basic ${Buffer.from("x-client-id:x-client-secret").toString("base64")}`,
  );
  assert.deepEqual(
    Object.fromEntries(new URLSearchParams(String(requests[0].init?.body))),
    {
      code: "authorization-code",
      grant_type: "authorization_code",
      redirect_uri: "https://api.mons.link/auth/x/callback",
      code_verifier: "code-verifier",
      client_id: "x-client-id",
    },
  );
  assert.equal(
    String(requests[1].input),
    "https://api.x.com/2/users/me?user.fields=username",
  );
  assert.equal(
    new Headers(requests[1].init?.headers).get("authorization"),
    "Bearer user-access-token",
  );
  assert.ok(requests[0].init?.signal instanceof AbortSignal);
  assert.ok(requests[1].init?.signal instanceof AbortSignal);
});

test("normalizes X token and user lookup errors without returning response bodies", async () => {
  const tokenProvider = createXOAuthProvider(env, {
    fetcher: async () =>
      new Response(
        JSON.stringify({ error_description: "Authorization code expired" }),
        { status: 400 },
      ),
  });
  await assert.rejects(
    tokenProvider.exchangeCode({
      code: "code",
      callbackUri: "https://api.mons.link/auth/x/callback",
      codeVerifier: "verifier",
    }),
    (error: unknown) =>
      error instanceof XProviderFailure &&
      error.publicCode === "x-token-exchange-authorization-code-expired",
  );

  const userProvider = createXOAuthProvider(env, {
    fetcher: async () =>
      new Response(JSON.stringify({ detail: "Token revoked" }), {
        status: 401,
      }),
  });
  await assert.rejects(
    userProvider.fetchAuthenticatedUser("token"),
    (error: unknown) =>
      error instanceof XProviderFailure &&
      error.publicCode === "x-user-lookup-token-revoked",
  );
});

test("rejects malformed, oversized, timed-out, and invalid-user responses", async () => {
  const cases: Array<{
    fetcher: typeof fetch;
    operation: "token" | "user";
    code: string;
  }> = [
    {
      fetcher: async () => new Response("not-json", { status: 200 }),
      operation: "token",
      code: "x-token-exchange-failed",
    },
    {
      fetcher: async () =>
        new Response("{}", {
          status: 200,
          headers: { "Content-Length": String(64 * 1024 + 1) },
        }),
      operation: "user",
      code: "x-user-lookup-failed",
    },
    {
      fetcher: async () => {
        throw new DOMException("private-timeout-detail", "TimeoutError");
      },
      operation: "token",
      code: "x-token-exchange-failed",
    },
    {
      fetcher: async () =>
        new Response(JSON.stringify({ data: { id: "not-numeric" } }), {
          status: 200,
        }),
      operation: "user",
      code: "x-user-lookup-missing-id",
    },
  ];

  for (const item of cases) {
    const provider = createXOAuthProvider(env, { fetcher: item.fetcher });
    const promise =
      item.operation === "token"
        ? provider.exchangeCode({
            code: "code",
            callbackUri: "https://api.mons.link/auth/x/callback",
            codeVerifier: "verifier",
          })
        : provider.fetchAuthenticatedUser("token");
    await assert.rejects(
      promise,
      (error: unknown) =>
        error instanceof XProviderFailure && error.publicCode === item.code,
    );
  }
});
