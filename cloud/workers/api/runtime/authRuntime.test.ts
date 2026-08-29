import { describe, expect, it } from "vitest";
import { exports } from "cloudflare:workers";
import { ParsedMessage } from "@spruceid/siwe-parser";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { Wallet } from "ethers";
import bs58 from "bs58";
import nacl from "tweetnacl";
import type { AuthProfileResponse } from "@mons/shared/auth";
import { acceptedNonces, verifyAppleIdToken } from "../src/appleAuth.ts";
import type { AuthIdentityService } from "../src/authIdentity.ts";
import {
  handleAuthMutation,
  validateSiweLocation,
} from "../src/authMutations.ts";
import { prepareSiweMessage } from "../../../../src/connection/siweMessage.ts";

const env = {
  APPLE_AUDIENCES: "link.mons",
  PROFILE_STORAGE_MODE: "firestore",
} as Env;
const identity = { uid: "runtime-login", idToken: "firebase-token" };
const nonce = "nonceABC123456789012345";
const intentId = "abcdefghijklmnopqrstuvwx";
const profile: AuthProfileResponse = {
  ok: true,
  uid: identity.uid,
  profileId: "runtime-profile",
  username: "Mons123",
  linkedMethods: { apple: false, eth: true, sol: true, x: false },
  appleLinked: false,
  emoji: 1,
  opId: `intent:${intentId}`,
};
const ctx = { waitUntil: (_promise: Promise<unknown>) => undefined };

function request(path: string, body: unknown): Request {
  return new Request(`https://api.mons.link${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function service(): AuthIdentityService {
  return {
    consumeIntent: async (uid, method) => ({
      uid,
      method,
      nonce,
      consumedAtMs: 0,
      expiresAtMs: Date.now() + 60_000,
    }),
    readIntent: async (uid, method) => ({
      uid,
      method,
      nonce,
      consumedAtMs: 0,
      expiresAtMs: Date.now() + 60_000,
    }),
    prepareVerifiedMethod: async () => null,
    linkVerifiedMethod: async (input) => ({
      ...profile,
      uid: input.uid,
      opId: input.opId,
    }),
    peekVerifyReplay: async () => null,
    refreshCompletedVerifyResult: async () => null,
    syncCurrentCallerProfile: async () => ({
      ok: true,
      profileId: profile.profileId,
      linkedMethods: profile.linkedMethods,
      appleLinked: profile.appleLinked,
    }),
    unlinkMethod: async () => ({
      ok: true,
      profileId: profile.profileId,
      linkedMethods: profile.linkedMethods,
      appleLinked: profile.appleLinked,
    }),
  };
}

describe("auth runtime primitives", () => {
  it("computes every accepted Apple nonce representation with Web Crypto", async () => {
    const values = await acceptedNonces("nonce-value");
    expect(values.has("nonce-value")).toBe(true);
    expect(
      Array.from(values).some((value) => /^[a-f0-9]{64}$/.test(value)),
    ).toBe(true);
    expect(values.size).toBe(3);
  });

  it("applies the production and port-aware SIWE domain policy", () => {
    expect(() =>
      validateSiweLocation({ domain: "mons.link", uri: "https://mons.link" }),
    ).not.toThrow();
    expect(() =>
      validateSiweLocation({
        domain: "localhost:3000",
        uri: "http://localhost:3000",
      }),
    ).not.toThrow();
    expect(() =>
      validateSiweLocation({
        domain: "attacker.invalid",
        uri: "https://attacker.invalid",
      }),
    ).toThrow("siwe-domain-not-allowed");
    expect(() =>
      validateSiweLocation({
        domain: "mons.link",
        uri: "data:text/plain,mons",
      }),
    ).toThrow("siwe-uri-not-allowed");
    expect(() =>
      validateSiweLocation({ domain: "mons.link", uri: "http://mons.link" }),
    ).toThrow("siwe-uri-not-allowed");
  });

  it("verifies Solana and Ethereum proofs in workerd", async () => {
    const solana = nacl.sign.keyPair();
    const solanaMessage = new TextEncoder().encode(
      `Sign in mons.link with Solana nonce ${nonce}`,
    );
    const solanaResponse = await handleAuthMutation(
      request("/auth/methods/sol/verify", {
        intentId,
        address: bs58.encode(solana.publicKey),
        signature: Buffer.from(
          nacl.sign.detached(solanaMessage, solana.secretKey),
        ).toString("base64"),
        emoji: 1,
        aura: null,
      }),
      identity,
      env,
      ctx,
      { identityService: service() },
    );
    expect(solanaResponse.ok).toBe(true);

    const wallet = new Wallet(
      "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    );
    const message = prepareSiweMessage({
      domain: "mons.link",
      address: wallet.address,
      statement: "mons ftw",
      uri: "https://mons.link",
      version: "1",
      chainId: 1,
      nonce,
      issuedAt: new Date().toISOString(),
    });
    expect(() => new ParsedMessage(message)).not.toThrow();
    const ethereumResponse = await handleAuthMutation(
      request("/auth/methods/eth/verify", {
        intentId,
        message,
        signature: await wallet.signMessage(message),
        emoji: 1,
        aura: null,
      }),
      identity,
      env,
      ctx,
      { identityService: service() },
    );
    expect(ethereumResponse.ok).toBe(true);
  });

  it("refreshes a rotated Apple key through the workerd Cache API", async () => {
    const stalePair = await generateKeyPair("RS256", { extractable: true });
    const currentPair = await generateKeyPair("RS256", { extractable: true });
    const staleJwk = await exportJWK(stalePair.publicKey);
    const currentJwk = await exportJWK(currentPair.publicKey);
    const appleUrl = "https://appleid.apple.com/auth/keys";
    const cache = await caches.open(`apple-runtime-${crypto.randomUUID()}`);
    await cache.put(
      new Request(appleUrl),
      new Response(
        JSON.stringify({ keys: [{ ...staleJwk, kid: "stale-key" }] }),
        {
          headers: {
            "Cache-Control": "public, max-age=3600",
          },
        },
      ),
    );
    const nowSeconds = Math.floor(Date.now() / 1_000);
    const token = await new SignJWT({ nonce })
      .setProtectedHeader({ alg: "RS256", kid: "current-key" })
      .setIssuer("https://appleid.apple.com")
      .setAudience("link.mons")
      .setSubject("apple-runtime-subject")
      .setIssuedAt(nowSeconds)
      .setExpirationTime(nowSeconds + 300)
      .sign(currentPair.privateKey);
    let fetches = 0;
    const background: Promise<unknown>[] = [];
    const result = await verifyAppleIdToken(
      token,
      nonce,
      env,
      {
        waitUntil(promise) {
          background.push(promise);
        },
      },
      {
        cache,
        fetcher: async () => {
          fetches++;
          return new Response(
            JSON.stringify({
              keys: [{ ...currentJwk, kid: "current-key" }],
            }),
          );
        },
      },
    );
    await Promise.all(background);
    expect(result.sub).toBe("apple-runtime-subject");
    expect(fetches).toBe(1);
    await cache.delete(new Request(appleUrl));
  });

  it("dispatches the complete mutation route through the production entrypoint", async () => {
    const preflight = await exports.default.fetch(
      new Request("https://api.mons.link/auth/x/flows/complete", {
        method: "OPTIONS",
        headers: {
          Origin: "https://mons.link",
          "Access-Control-Request-Headers": "Authorization, Content-Type",
          "Access-Control-Request-Method": "POST",
        },
      }),
    );
    expect(preflight.status).toBe(204);
    const response = await exports.default.fetch(
      new Request("https://api.mons.link/auth/x/flows/complete", {
        method: "POST",
        headers: {
          Origin: "https://mons.link",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      }),
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      ok: false,
      error: "unauthenticated",
      message: "authentication-required",
    });
  });
});
