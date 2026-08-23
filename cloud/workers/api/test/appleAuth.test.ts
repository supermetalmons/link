import assert from "node:assert/strict";
import test from "node:test";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import {
  acceptedNonces,
  maskEmail,
  verifyAppleIdToken,
} from "../src/appleAuth.ts";
import { TELEGRAM_TEST_ENV } from "./testEnv.ts";

const env = TELEGRAM_TEST_ENV as Env;
const ctx = { waitUntil: () => undefined };

async function fixture(nonce = "nonce-value") {
  const { privateKey, publicKey } = await generateKeyPair("RS256", {
    extractable: true,
  });
  const publicJwk = await exportJWK(publicKey);
  const nowSeconds = Math.floor(Date.now() / 1_000);
  const token = await new SignJWT({
    nonce,
    email: "alice@example.com",
  })
    .setProtectedHeader({ alg: "RS256", kid: "apple-key" })
    .setIssuer("https://appleid.apple.com")
    .setAudience("link.mons")
    .setSubject("apple-subject")
    .setIssuedAt(nowSeconds)
    .setExpirationTime(nowSeconds + 300)
    .sign(privateKey);
  return {
    token,
    fetcher: async () =>
      new Response(
        JSON.stringify({
          keys: [{ ...publicJwk, kid: "apple-key", alg: "RS256", use: "sig" }],
        }),
        { headers: { "Content-Type": "application/json" } },
      ),
  };
}

test("verifies Apple issuer, audience, signature, nonce, and masked email", async () => {
  const { token, fetcher } = await fixture();
  const result = await verifyAppleIdToken(token, "nonce-value", env, ctx, {
    cache: null,
    fetcher,
  });
  assert.deepEqual(result, {
    sub: "apple-subject",
    emailMasked: "a***e@example.com",
  });
});

test("accepts the hashed Apple nonce forms and rejects mismatches", async () => {
  const values = Array.from(await acceptedNonces("nonce-value"));
  for (const nonce of values) {
    const { token, fetcher } = await fixture(nonce);
    assert.equal(
      (
        await verifyAppleIdToken(token, "nonce-value", env, ctx, {
          cache: null,
          fetcher,
        })
      ).sub,
      "apple-subject",
    );
  }
  const { token, fetcher } = await fixture("wrong-nonce");
  await assert.rejects(
    verifyAppleIdToken(token, "nonce-value", env, ctx, {
      cache: null,
      fetcher,
    }),
    (error) =>
      error instanceof Error && error.message === "apple-nonce-mismatch",
  );
});

test("refreshes once when a recent cached JWKS lacks the token key", async () => {
  const { token, fetcher } = await fixture();
  const stale = await fixture();
  let fetches = 0;
  const cache: Cache = {
    add: async () => undefined,
    addAll: async () => undefined,
    delete: async () => true,
    keys: async () => [],
    match: async () => {
      const response = await stale.fetcher();
      const body = (await response.json()) as Record<string, unknown>;
      const keys = (body.keys as Array<Record<string, unknown>>).map((key) => ({
        ...key,
        kid: "stale-key",
      }));
      return new Response(JSON.stringify({ keys }), {
        headers: { "Cache-Control": "public, max-age=3600" },
      });
    },
    matchAll: async () => [],
    put: async () => undefined,
  };
  const result = await verifyAppleIdToken(token, "nonce-value", env, ctx, {
    cache,
    fetcher: async () => {
      fetches++;
      return fetcher();
    },
  });
  assert.equal(result.sub, "apple-subject");
  assert.equal(fetches, 1);
});

test("does not repeatedly refresh a recent JWKS for an unknown key", async () => {
  const { token, fetcher } = await fixture();
  let cached: Response | null = null;
  let fetches = 0;
  const cache: Cache = {
    add: async () => undefined,
    addAll: async () => undefined,
    delete: async () => true,
    keys: async () => [],
    match: async () => cached?.clone(),
    matchAll: async () => [],
    put: async (_request, response) => {
      cached = response.clone();
    },
  };
  const background: Promise<unknown>[] = [];
  const runtime = {
    waitUntil(promise: Promise<unknown>) {
      background.push(promise);
    },
  };
  const dependencies = {
    cache,
    now: () => 1_000_000,
    fetcher: async () => {
      fetches++;
      const response = await fetcher();
      const body = (await response.json()) as Record<string, unknown>;
      const keys = (body.keys as Array<Record<string, unknown>>).map((key) => ({
        ...key,
        kid: "other-key",
      }));
      return new Response(JSON.stringify({ keys }));
    },
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(
      verifyAppleIdToken(token, "nonce-value", env, runtime, dependencies),
      (error) =>
        error instanceof Error && error.message === "Unknown Apple JWT key id.",
    );
    await Promise.all(background.splice(0));
  }
  assert.equal(fetches, 1);
});

test("preserves the existing Apple email masking policy", () => {
  assert.equal(maskEmail("invalid"), null);
  assert.equal(maskEmail("@example.com"), "***@example.com");
  assert.equal(maskEmail("a@example.com"), "a***@example.com");
  assert.equal(maskEmail("alice@example.com"), "a***e@example.com");
});
