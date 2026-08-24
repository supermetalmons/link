import assert from "node:assert/strict";
import test from "node:test";
import bs58 from "bs58";
import { Wallet } from "ethers";
import nacl from "tweetnacl";
import type { AuthProfileResponse } from "@mons/shared/auth";
import {
  handleAuthMutation,
  validateSiweLocation,
} from "../src/authMutations.ts";
import type { AuthIdentityService } from "../src/authIdentity.ts";
import {
  AuthFirestoreConflict,
  encodeFields,
  type AuthFirestoreClient,
  type AuthFirestoreDocument,
  type AuthFirestoreWrite,
} from "../src/authFirestore.ts";
import { TELEGRAM_TEST_ENV } from "./testEnv.ts";
import { prepareSiweMessage } from "../../../../src/connection/siweMessage.ts";

const env = TELEGRAM_TEST_ENV as Env;
const identity = { uid: "login-1", idToken: "firebase-token" };
const ctx = { waitUntil: () => undefined };
const INTENT_ID = "abcdefghijklmnopqrstuvwx";
const FLOW_ID = "zyxwvutsrqponmlkjihgfedc";
const PREVIEW_ORIGIN = "https://8bdf84df-mons-link.lil-org.workers.dev";

const profile: AuthProfileResponse = {
  ok: true,
  uid: identity.uid,
  profileId: "profile-1",
  username: "Mons123",
  linkedMethods: { apple: true, eth: true, sol: true, x: true },
  appleLinked: true,
  emoji: 1,
  opId: "operation-1",
};

function request(path: string, body: unknown): Request {
  return new Request(`https://api.mons.link${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function service(
  overrides: Partial<AuthIdentityService> = {},
): AuthIdentityService {
  return {
    consumeIntent: async (uid, method) => ({
      uid,
      method,
      nonce: "nonceABC123456789012345",
      consumedAtMs: 0,
      expiresAtMs: Date.now() + 60_000,
    }),
    readIntent: async (uid, method) => ({
      uid,
      method,
      nonce: "nonceABC123456789012345",
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
      profileId: "profile-1",
      linkedMethods: { apple: false, eth: true, sol: true, x: true },
      appleLinked: false,
    }),
    ...overrides,
  };
}

test("verifies the exact Solana nonce message before linking", async () => {
  const keys = nacl.sign.keyPair();
  const nonce = "nonceABC123456789012345";
  const message = new TextEncoder().encode(
    `Sign in mons.link with Solana nonce ${nonce}`,
  );
  const signature = Buffer.from(
    nacl.sign.detached(message, keys.secretKey),
  ).toString("base64");
  const calls: unknown[] = [];
  const phases: string[] = [];
  const response = await handleAuthMutation(
    request("/auth/methods/sol/verify", {
      intentId: INTENT_ID,
      address: bs58.encode(keys.publicKey),
      signature,
      emoji: 2,
      aura: "rainbow",
    }),
    identity,
    env,
    ctx,
    {
      identityService: service({
        consumeIntent: async () => ({
          uid: identity.uid,
          method: "sol",
          nonce,
          consumedAtMs: 0,
          expiresAtMs: Date.now() + 60_000,
        }),
        prepareVerifiedMethod: async (input) => {
          phases.push(`prepare:${input.method}:${input.intentId}`);
          return null;
        },
        linkVerifiedMethod: async (input) => {
          phases.push("link");
          calls.push(input);
          return { ...profile, opId: input.opId };
        },
      }),
    },
  );
  assert.equal(response.ok, true);
  assert.equal(calls.length, 1);
  assert.equal((calls[0] as { opId: string }).opId, `intent:${INTENT_ID}`);
  assert.deepEqual(phases, [`prepare:sol:${INTENT_ID}`, "link"]);
});

test("returns the legacy false response for invalid Ethereum signatures", async () => {
  const wallet = Wallet.createRandom();
  const message = prepareSiweMessage({
    domain: "mons.link",
    address: wallet.address,
    statement: "mons ftw",
    uri: "https://mons.link",
    version: "1",
    chainId: 1,
    nonce: "nonceABC123456789012345",
    issuedAt: new Date().toISOString(),
  });
  const response = await handleAuthMutation(
    request("/auth/methods/eth/verify", {
      intentId: INTENT_ID,
      message,
      signature: await Wallet.createRandom().signMessage(message),
      emoji: 1,
      aura: null,
    }),
    identity,
    env,
    ctx,
    { identityService: service({ peekVerifyReplay: async () => profile }) },
  );
  assert.deepEqual(response, { ok: false });
});

test("does not replay before validating the submitted Solana proof", async () => {
  const keys = nacl.sign.keyPair();
  let replayReads = 0;
  const response = await handleAuthMutation(
    request("/auth/methods/sol/verify", {
      intentId: INTENT_ID,
      address: bs58.encode(keys.publicKey),
      signature: Buffer.alloc(64).toString("base64"),
      emoji: 1,
      aura: null,
    }),
    identity,
    env,
    ctx,
    {
      identityService: service({
        peekVerifyReplay: async () => {
          replayReads += 1;
          return profile;
        },
      }),
    },
  );

  assert.deepEqual(response, { ok: false });
  assert.equal(replayReads, 0);
});

test("links a valid Ethereum proof with the consumed nonce", async () => {
  const wallet = Wallet.createRandom();
  const nonce = "nonceABC123456789012345";
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
  const signature = await wallet.signMessage(message);
  let linkedMethod = "";
  const phases: string[] = [];
  const response = await handleAuthMutation(
    request("/auth/methods/eth/verify", {
      intentId: INTENT_ID,
      message,
      signature,
      emoji: 1,
      aura: "",
    }),
    identity,
    env,
    ctx,
    {
      identityService: service({
        consumeIntent: async () => ({
          uid: identity.uid,
          method: "eth",
          nonce,
          consumedAtMs: 0,
          expiresAtMs: Date.now() + 60_000,
        }),
        prepareVerifiedMethod: async (input) => {
          phases.push(`prepare:${input.method}:${input.intentId}`);
          return null;
        },
        linkVerifiedMethod: async (input) => {
          phases.push("link");
          linkedMethod = input.method;
          return { ...profile, opId: input.opId };
        },
      }),
    },
  );
  assert.equal(response.ok, true);
  assert.equal(linkedMethod, "eth");
  assert.deepEqual(phases, [`prepare:eth:${INTENT_ID}`, "link"]);

  let replayPrepares = 0;
  const replay = await handleAuthMutation(
    request("/auth/methods/eth/verify", {
      intentId: INTENT_ID,
      message,
      signature,
      emoji: 1,
      aura: "",
    }),
    identity,
    env,
    ctx,
    {
      identityService: service({
        readIntent: async () => ({
          uid: identity.uid,
          method: "eth",
          nonce,
          consumedAtMs: Date.now() - 1,
          expiresAtMs: Date.now() - 1,
        }),
        prepareVerifiedMethod: async () => {
          replayPrepares += 1;
          return profile;
        },
        linkVerifiedMethod: async () => {
          throw new Error("unexpected link");
        },
      }),
    },
  );
  if (!replay.ok) {
    assert.fail("expected replay success");
  }
  assert.equal(replay.profileId, profile.profileId);
  assert.equal(replayPrepares, 1);
});

test("validates production, local, and account-owned SIWE origins", () => {
  for (const origin of [
    "https://mons.link",
    "http://localhost:3000",
    PREVIEW_ORIGIN,
  ]) {
    validateSiweLocation({
      domain: new URL(origin).host,
      uri: `${origin}/settings`,
    });
  }
  for (const location of [
    {
      domain: "8bdf84df-mons-link.attacker.workers.dev",
      uri: "https://8bdf84df-mons-link.attacker.workers.dev",
    },
    {
      domain: new URL(PREVIEW_ORIGIN).host,
      uri: `https://user:secret@${new URL(PREVIEW_ORIGIN).host}/settings`,
    },
  ]) {
    assert.throws(
      () => validateSiweLocation(location),
      (error) =>
        error instanceof Error &&
        (error.message === "siwe-domain-not-allowed" ||
          error.message === "siwe-uri-not-allowed"),
    );
  }
});

test("verifies Apple through the injected bounded provider", async () => {
  let expectedNonce = "";
  const response = await handleAuthMutation(
    request("/auth/methods/apple/verify", {
      intentId: INTENT_ID,
      idToken: "apple-token",
      consentSource: "settings",
      emoji: 1,
      aura: "",
    }),
    identity,
    env,
    ctx,
    {
      identityService: service(),
      verifyApple: async (_token, nonce) => {
        expectedNonce = nonce;
        return { sub: "apple-subject", emailMasked: "a***e@example.com" };
      },
    },
  );
  assert.equal(response.ok, true);
  assert.equal(expectedNonce, "nonceABC123456789012345");
});

test("does not consume an Apple intent when verification is unavailable", async () => {
  let consumes = 0;
  let replayReads = 0;
  await assert.rejects(
    handleAuthMutation(
      request("/auth/methods/apple/verify", {
        intentId: INTENT_ID,
        idToken: "apple-token",
        consentSource: "signin",
        emoji: 1,
        aura: null,
      }),
      identity,
      env,
      ctx,
      {
        identityService: service({
          peekVerifyReplay: async () => {
            replayReads += 1;
            return profile;
          },
          consumeIntent: async () => {
            consumes++;
            throw new Error("unexpected consume");
          },
        }),
        verifyApple: async () => {
          throw new Error("temporary-apple-failure");
        },
      },
    ),
    /temporary-apple-failure/,
  );
  assert.equal(consumes, 0);
  assert.equal(replayReads, 0);
});

test("starts the Apple operation before consuming its intent", async () => {
  const calls: string[] = [];
  await assert.rejects(
    handleAuthMutation(
      request("/auth/methods/apple/verify", {
        intentId: INTENT_ID,
        idToken: "apple-token",
        consentSource: "signin",
        emoji: 1,
        aura: null,
      }),
      identity,
      env,
      ctx,
      {
        identityService: service({
          prepareVerifiedMethod: async () => {
            calls.push("start");
            throw new Error("operation-start-failed");
          },
          consumeIntent: async () => {
            calls.push("consume");
            throw new Error("unexpected consume");
          },
        }),
        verifyApple: async () => ({
          sub: "apple-subject",
          emailMasked: null,
        }),
      },
    ),
    /operation-start-failed/,
  );
  assert.deepEqual(calls, ["start"]);
});

test("resumes Apple linking after its operation consumed the intent", async () => {
  let consumes = 0;
  const response = await handleAuthMutation(
    request("/auth/methods/apple/verify", {
      intentId: INTENT_ID,
      idToken: "apple-token",
      consentSource: "signin",
      emoji: 1,
      aura: null,
    }),
    identity,
    env,
    ctx,
    {
      identityService: service({
        readIntent: async () => ({
          uid: identity.uid,
          method: "apple",
          nonce: "nonceABC123456789012345",
          consumedAtMs: Date.now() - 1,
          expiresAtMs: Date.now() - 1,
        }),
        consumeIntent: async () => {
          consumes++;
          throw new Error("unexpected consume");
        },
      }),
      verifyApple: async () => ({
        sub: "apple-subject",
        emailMasked: null,
      }),
    },
  );
  assert.equal(response.ok, true);
  assert.equal(consumes, 0);
});

function firestoreDocument(
  collection: string,
  id: string,
  fields: Record<string, unknown>,
  updateTime = "2026-08-22T00:00:00Z",
): AuthFirestoreDocument {
  return {
    id,
    name: `projects/mons-link/databases/(default)/documents/${collection}/${id}`,
    fields,
    rawFields: {},
    updateTime,
  };
}

function firestore(
  flow: AuthFirestoreDocument,
  writes: unknown[],
): AuthFirestoreClient {
  return {
    batchGet: async () => new Map(),
    commitWrites: async (input) => {
      writes.push(...input);
    },
    createDocumentId: () => "profile-1",
    get: async () => flow,
    listPage: async () => ({ documents: [], nextPageToken: "" }),
    query: async () => [],
    runTransaction: async () => {
      throw new Error("unexpected transaction");
    },
  };
}

function storedFlowResult(write: unknown): unknown {
  const candidate = write as AuthFirestoreWrite;
  assert.ok("update" in candidate);
  return candidate.update.fields.result;
}

test("prepares X verification before linking", async () => {
  const writes: unknown[] = [];
  const phases: string[] = [];
  const response = await handleAuthMutation(
    request("/auth/x/flows/complete", {
      flowId: FLOW_ID,
      emoji: 1,
      aura: "",
    }),
    identity,
    env,
    ctx,
    {
      firestore: firestore(
        firestoreDocument("xAuthRedirectFlows", FLOW_ID, {
          uid: identity.uid,
          status: "verified",
          createdAtMs: Date.now(),
          expiresAtMs: Date.now() + 60_000,
          intentId: INTENT_ID,
          xUserId: "12345",
          consentSource: "signin",
        }),
        writes,
      ),
      identityService: service({
        prepareVerifiedMethod: async (input) => {
          phases.push(`prepare:${input.method}:${input.intentId}`);
          return null;
        },
        linkVerifiedMethod: async (input) => {
          phases.push("link");
          return { ...profile, opId: input.opId };
        },
      }),
    },
  );
  assert.equal(response.ok, true);
  assert.deepEqual(phases, [`prepare:x:${INTENT_ID}`, "link"]);
  assert.equal(writes.length, 1);
  assert.deepEqual((writes[0] as AuthFirestoreWrite).currentDocument, {
    updateTime: "2026-08-22T00:00:00Z",
  });
  assert.deepEqual(storedFlowResult(writes[0]), {
    mapValue: {
      fields: encodeFields({
        profileId: profile.profileId,
        opId: `x-redirect:${FLOW_ID}`,
      }),
    },
  });
});

test("does not trim stored X flow UIDs", async () => {
  await assert.rejects(
    handleAuthMutation(
      request("/auth/x/flows/complete", {
        flowId: FLOW_ID,
        emoji: 1,
        aura: "",
      }),
      identity,
      env,
      ctx,
      {
        firestore: firestore(
          firestoreDocument("xAuthRedirectFlows", FLOW_ID, {
            uid: ` ${identity.uid} `,
            status: "verified",
            createdAtMs: Date.now(),
            expiresAtMs: Date.now() + 60_000,
            intentId: INTENT_ID,
            xUserId: "12345",
            consentSource: "signin",
          }),
          [],
        ),
        identityService: service(),
      },
    ),
    (error) =>
      error instanceof Error &&
      error.message === "x-redirect-flow-user-mismatch",
  );
});

test("replays and persists completed X flows without consuming again", async () => {
  const writes: unknown[] = [];
  let consumes = 0;
  const response = await handleAuthMutation(
    request("/auth/x/flows/complete", {
      flowId: FLOW_ID,
      emoji: 1,
      aura: "",
    }),
    identity,
    env,
    ctx,
    {
      firestore: firestore(
        firestoreDocument("xAuthRedirectFlows", FLOW_ID, {
          uid: identity.uid,
          status: "verified",
          createdAtMs: Date.now(),
          expiresAtMs: Date.now() + 60_000,
          intentId: "intent-x",
          xUserId: "12345",
          consentSource: "signin",
        }),
        writes,
      ),
      identityService: service({
        consumeIntent: async () => {
          consumes++;
          throw new Error("unexpected consume");
        },
        peekVerifyReplay: async () => profile,
      }),
    },
  );
  assert.equal(response.ok, true);
  assert.equal(consumes, 0);
  assert.equal(writes.length, 1);
  assert.deepEqual((writes[0] as AuthFirestoreWrite).currentDocument, {
    updateTime: "2026-08-22T00:00:00Z",
  });
  assert.deepEqual(storedFlowResult(writes[0]), {
    mapValue: { fields: encodeFields({ ...profile }) },
  });
});

test("re-evaluates a verified callback after an expiry conflict", async () => {
  const nowMs = Date.now();
  const initial = firestoreDocument(
    "xAuthRedirectFlows",
    FLOW_ID,
    {
      uid: identity.uid,
      status: "created",
      createdAtMs: nowMs,
      expiresAtMs: 0,
    },
    "2026-08-22T00:00:00Z",
  );
  const verified = firestoreDocument(
    "xAuthRedirectFlows",
    FLOW_ID,
    {
      uid: identity.uid,
      status: "verified",
      createdAtMs: nowMs,
      expiresAtMs: 0,
      intentId: INTENT_ID,
      xUserId: "12345",
      consentSource: "signin",
    },
    "2026-08-22T00:00:01Z",
  );
  const refreshedVerified = firestoreDocument(
    "xAuthRedirectFlows",
    FLOW_ID,
    { ...verified.fields, updatedAtMs: nowMs + 1 },
    "2026-08-22T00:00:02Z",
  );
  const writes: AuthFirestoreWrite[] = [];
  let reads = 0;
  const client = firestore(initial, writes);
  client.get = async () => {
    reads++;
    return reads === 1 ? initial : reads === 2 ? verified : refreshedVerified;
  };
  client.commitWrites = async (input) => {
    writes.push(...input);
    if (writes.length <= 2) {
      throw new AuthFirestoreConflict();
    }
  };

  const response = await handleAuthMutation(
    request("/auth/x/flows/complete", {
      flowId: FLOW_ID,
      emoji: 1,
      aura: "",
    }),
    identity,
    env,
    ctx,
    {
      firestore: client,
      identityService: service({ peekVerifyReplay: async () => profile }),
      now: () => nowMs,
    },
  );

  assert.equal(response.ok, true);
  assert.equal(reads, 3);
  assert.deepEqual(
    writes.map((write) =>
      "update" in write ? write.update.fields.status : undefined,
    ),
    [
      { stringValue: "failed" },
      { stringValue: "completed" },
      { stringValue: "completed" },
    ],
  );
  assert.deepEqual(
    writes.map((write) => write.currentDocument),
    [
      { updateTime: "2026-08-22T00:00:00Z" },
      { updateTime: "2026-08-22T00:00:01Z" },
      { updateTime: "2026-08-22T00:00:02Z" },
    ],
  );
});

test("lets successful X completion supersede a concurrent expiry failure", async () => {
  const nowMs = Date.now();
  const initial = firestoreDocument(
    "xAuthRedirectFlows",
    FLOW_ID,
    {
      uid: identity.uid,
      status: "verified",
      createdAtMs: nowMs,
      expiresAtMs: nowMs + 60_000,
      intentId: INTENT_ID,
      xUserId: "12345",
      consentSource: "signin",
    },
    "2026-08-22T00:00:00Z",
  );
  const failed = firestoreDocument(
    "xAuthRedirectFlows",
    FLOW_ID,
    {
      ...initial.fields,
      status: "failed",
      errorCode: "x-redirect-flow-expired",
    },
    "2026-08-22T00:00:01Z",
  );
  const writes: AuthFirestoreWrite[] = [];
  let reads = 0;
  const client = firestore(initial, writes);
  client.get = async () => (reads++ === 0 ? initial : failed);
  client.commitWrites = async (input) => {
    writes.push(...input);
    if (writes.length === 1) {
      throw new AuthFirestoreConflict();
    }
  };

  const response = await handleAuthMutation(
    request("/auth/x/flows/complete", {
      flowId: FLOW_ID,
      emoji: 1,
      aura: "",
    }),
    identity,
    env,
    ctx,
    {
      firestore: client,
      identityService: service(),
      now: () => nowMs,
    },
  );

  assert.equal(response.ok, true);
  assert.equal(reads, 2);
  assert.deepEqual(
    writes.map((write) =>
      "update" in write ? write.update.fields.status : undefined,
    ),
    [{ stringValue: "completed" }, { stringValue: "completed" }],
  );
  assert.deepEqual(
    writes.map((write) => write.currentDocument),
    [
      { updateTime: "2026-08-22T00:00:00Z" },
      { updateTime: "2026-08-22T00:00:01Z" },
    ],
  );
});

test("preserves other concurrent X terminal failures", async () => {
  const nowMs = Date.now();
  const initial = firestoreDocument(
    "xAuthRedirectFlows",
    FLOW_ID,
    {
      uid: identity.uid,
      status: "verified",
      createdAtMs: nowMs,
      expiresAtMs: nowMs + 60_000,
      intentId: INTENT_ID,
      xUserId: "12345",
      consentSource: "signin",
    },
    "2026-08-22T00:00:00Z",
  );
  const failed = firestoreDocument(
    "xAuthRedirectFlows",
    FLOW_ID,
    {
      ...initial.fields,
      status: "failed",
      errorCode: "x-token-exchange-failed",
    },
    "2026-08-22T00:00:01Z",
  );
  const writes: AuthFirestoreWrite[] = [];
  let reads = 0;
  const client = firestore(initial, writes);
  client.get = async () => (reads++ === 0 ? initial : failed);
  client.commitWrites = async (input) => {
    writes.push(...input);
    throw new AuthFirestoreConflict();
  };

  await assert.rejects(
    handleAuthMutation(
      request("/auth/x/flows/complete", {
        flowId: FLOW_ID,
        emoji: 1,
        aura: "",
      }),
      identity,
      env,
      ctx,
      {
        firestore: client,
        identityService: service(),
        now: () => nowMs,
      },
    ),
    /x-token-exchange-failed/,
  );

  assert.equal(reads, 2);
  assert.equal(writes.length, 1);
});

test("returns a concurrently completed X replay after a write conflict", async () => {
  const nowMs = Date.now();
  const initial = firestoreDocument(
    "xAuthRedirectFlows",
    FLOW_ID,
    {
      uid: identity.uid,
      status: "verified",
      createdAtMs: nowMs,
      expiresAtMs: nowMs + 60_000,
      intentId: INTENT_ID,
      xUserId: "12345",
      consentSource: "signin",
    },
    "2026-08-22T00:00:00Z",
  );
  const completed = firestoreDocument(
    "xAuthRedirectFlows",
    FLOW_ID,
    {
      uid: identity.uid,
      status: "completed",
      xUserId: "12345",
      result: { profileId: profile.profileId, opId: profile.opId },
    },
    "2026-08-22T00:00:01Z",
  );
  const writes: AuthFirestoreWrite[] = [];
  let reads = 0;
  let refreshes = 0;
  const client = firestore(initial, writes);
  client.get = async () => (reads++ === 0 ? initial : completed);
  client.commitWrites = async (input) => {
    writes.push(...input);
    throw new AuthFirestoreConflict();
  };

  const response = await handleAuthMutation(
    request("/auth/x/flows/complete", {
      flowId: FLOW_ID,
      emoji: 1,
      aura: "",
    }),
    identity,
    env,
    ctx,
    {
      firestore: client,
      identityService: service({
        peekVerifyReplay: async () => profile,
        refreshCompletedVerifyResult: async () => {
          refreshes++;
          return profile;
        },
      }),
      now: () => nowMs,
    },
  );

  assert.equal(response.ok, true);
  assert.equal(reads, 2);
  assert.equal(refreshes, 1);
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].currentDocument, {
    updateTime: "2026-08-22T00:00:00Z",
  });
});

test("recovers completed legacy X flows before returning them", async () => {
  let replayChecks = 0;
  const response = await handleAuthMutation(
    request("/auth/x/flows/complete", {
      flowId: FLOW_ID,
      emoji: 1,
      aura: "",
    }),
    identity,
    env,
    ctx,
    {
      firestore: firestore(
        firestoreDocument("xAuthRedirectFlows", FLOW_ID, {
          uid: identity.uid,
          status: "completed",
          xUserId: "12345",
          result: {
            profileId: profile.profileId,
          },
        }),
        [],
      ),
      identityService: service({
        peekVerifyReplay: async () => {
          replayChecks++;
          return profile;
        },
        refreshCompletedVerifyResult: async (result) => ({
          ...profile,
          profileId: result.profileId,
          opId: result.opId,
        }),
      }),
    },
  );
  assert.equal(response.ok, true);
  assert.equal(replayChecks, 1);
});

test("rejects a completed X flow after live ownership validation fails", async () => {
  let refreshChecks = 0;
  await assert.rejects(
    handleAuthMutation(
      request("/auth/x/flows/complete", {
        flowId: FLOW_ID,
        emoji: 1,
        aura: "",
      }),
      identity,
      env,
      ctx,
      {
        firestore: firestore(
          firestoreDocument("xAuthRedirectFlows", FLOW_ID, {
            uid: identity.uid,
            status: "completed",
            xUserId: "12345",
            result: profile,
          }),
          [],
        ),
        identityService: service({
          refreshCompletedVerifyResult: async (
            _result,
            _method,
            _uid,
            value,
          ) => {
            refreshChecks++;
            assert.equal(value, "12345");
            return null;
          },
        }),
      },
    ),
    (error) =>
      error instanceof Error && error.message === "x-redirect-result-stale",
  );
  assert.equal(refreshChecks, 1);
});

test("strictly rejects malformed mutation bodies", async () => {
  await assert.rejects(
    handleAuthMutation(
      request("/auth/methods/unlink", {
        method: "eth",
        opId: "6ba7b810-9dad-41d1-80b4-00c04fd430c8",
        extra: true,
      }),
      identity,
      env,
      ctx,
      { identityService: service() },
    ),
    (error) => error instanceof Error && error.message === "invalid-request",
  );

  let replayChecks = 0;
  await assert.rejects(
    handleAuthMutation(
      request("/auth/methods/sol/verify", {
        intentId: ` ${INTENT_ID}`,
        address: "11111111111111111111111111111111",
        signature: "AA==",
        emoji: 1,
        aura: null,
      }),
      identity,
      env,
      ctx,
      {
        identityService: service({
          peekVerifyReplay: async () => {
            replayChecks++;
            return null;
          },
        }),
      },
    ),
    (error) => error instanceof Error && error.message === "invalid-request",
  );
  assert.equal(replayChecks, 0);

  await assert.rejects(
    handleAuthMutation(
      request("/auth/methods/sol/verify", {
        intentId: INTENT_ID,
        address: "z".repeat(65),
        signature: "A".repeat(88),
        emoji: 1,
        aura: null,
      }),
      identity,
      env,
      ctx,
      { identityService: service() },
    ),
    (error) => error instanceof Error && error.message === "invalid-request",
  );
});

test("maps the server operation cutoff to deadline-exceeded", async () => {
  await assert.rejects(
    handleAuthMutation(
      request("/auth/methods/unlink", {
        method: "eth",
        opId: "6ba7b810-9dad-41d1-80b4-00c04fd430c8",
      }),
      identity,
      env,
      ctx,
      {
        identityService: service({
          unlinkMethod: async () => {
            await new Promise((resolve) => setTimeout(resolve, 5));
            throw new Error("upstream-aborted");
          },
        }),
        operationDeadlineMs: 1,
      },
    ),
    (error) =>
      error instanceof Error &&
      error.message === "auth-operation-timeout" &&
      "code" in error &&
      error.code === "deadline-exceeded",
  );
});
