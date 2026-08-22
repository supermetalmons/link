import assert from "node:assert/strict";
import test from "node:test";
import { AuthApiFailure } from "../src/authErrors.ts";
import {
  FirebaseAuthAdminFailure,
  type FirebaseAuthAdminClient,
  type FirebaseAuthUser,
} from "../src/firebaseAuthAdmin.ts";
import type { FirebaseRtdbClient } from "../src/firebaseRtdb.ts";
import { LoginProfileConflict } from "../src/firestore.ts";
import { syncProfileClaim } from "../src/profileClaim.ts";
import { TELEGRAM_TEST_ENV } from "./testEnv.ts";

const env = {
  ...TELEGRAM_TEST_ENV,
  AUTH_DISABLE_X_VERIFY: "false",
  AUTH_RATE_LIMITER: { limit: async () => ({ success: true }) },
  FIRESTORE_SERVICE_ACCOUNT_EMAIL: "worker@example.iam.gserviceaccount.com",
  FIRESTORE_SERVICE_ACCOUNT_PRIVATE_KEY: "test-private-key",
  HELIUS_RPC_API_KEY: "test-helius-key",
  NFT_RATE_LIMITER: { limit: async () => ({ success: true }) },
  X_CLIENT_ID: "test-x-client",
  X_CLIENT_SECRET: "test-x-secret",
} as Env;

const identity = { idToken: "firebase-token", uid: "firebase-uid" };

const linkedSource = {
  ok: true as const,
  profileId: "profile-1",
  linkedMethods: { apple: true, eth: false, sol: true, x: false },
  appleLinked: true,
};

const emptySource = {
  ok: true as const,
  profileId: null,
  linkedMethods: { apple: false, eth: false, sol: false, x: false },
  appleLinked: false,
};

function authClient(
  user: FirebaseAuthUser,
  writes: Array<Record<string, unknown>>,
): FirebaseAuthAdminClient {
  return {
    getUser: async () => user,
    setCustomUserClaims: async (uid, claims) => {
      writes.push({ uid, claims });
    },
  };
}

function rtdbClient(
  profileLink: unknown,
  writes: Array<Record<string, unknown>>,
): Pick<FirebaseRtdbClient, "getPath" | "patchRoot"> {
  return {
    getPath: async () => profileLink,
    patchRoot: async (updates) => {
      writes.push(updates);
    },
  };
}

test("returns current profile state without writing claims or RTDB", async () => {
  const authWrites: Array<Record<string, unknown>> = [];
  const rtdbWrites: Array<Record<string, unknown>> = [];
  const result = await syncProfileClaim(identity, env, {
    repository: { getProfileClaimSource: async () => linkedSource },
    authClient: authClient(
      {
        uid: identity.uid,
        customClaims: { admin: true, profileId: "profile-1" },
      },
      authWrites,
    ),
    rtdbClient: rtdbClient(" profile-1 ", rtdbWrites),
  });
  assert.deepEqual(result, linkedSource);
  assert.deepEqual(authWrites, []);
  assert.deepEqual(rtdbWrites, []);
});

test("repairs stale claims and RTDB while preserving unrelated claims", async () => {
  const authWrites: Array<Record<string, unknown>> = [];
  const rtdbWrites: Array<Record<string, unknown>> = [];
  await syncProfileClaim(identity, env, {
    repository: { getProfileClaimSource: async () => linkedSource },
    authClient: authClient(
      {
        uid: identity.uid,
        customClaims: { admin: true, profileId: "old-profile" },
      },
      authWrites,
    ),
    rtdbClient: rtdbClient("old-profile", rtdbWrites),
  });
  assert.deepEqual(authWrites, [
    {
      uid: identity.uid,
      claims: { admin: true, profileId: "profile-1" },
    },
  ]);
  assert.deepEqual(rtdbWrites, [
    { "players/firebase-uid/profile": "profile-1" },
  ]);
});

test("repairs only the stale profile-claim component", async () => {
  const cases = [
    {
      claim: "old-profile",
      link: "profile-1",
      authWrites: 1,
      rtdbWrites: 0,
    },
    {
      claim: "profile-1",
      link: "old-profile",
      authWrites: 0,
      rtdbWrites: 1,
    },
  ];
  for (const entry of cases) {
    const authWrites: Array<Record<string, unknown>> = [];
    const rtdbWrites: Array<Record<string, unknown>> = [];
    await syncProfileClaim(identity, env, {
      repository: { getProfileClaimSource: async () => linkedSource },
      authClient: authClient(
        {
          uid: identity.uid,
          customClaims: { profileId: entry.claim },
        },
        authWrites,
      ),
      rtdbClient: rtdbClient(entry.link, rtdbWrites),
    });
    assert.equal(authWrites.length, entry.authWrites);
    assert.equal(rtdbWrites.length, entry.rtdbWrites);
  }
});

test("removes only stale profile state when no profile exists", async () => {
  const authWrites: Array<Record<string, unknown>> = [];
  const rtdbWrites: Array<Record<string, unknown>> = [];
  const result = await syncProfileClaim(identity, env, {
    repository: { getProfileClaimSource: async () => emptySource },
    authClient: authClient(
      {
        uid: identity.uid,
        customClaims: { admin: true, profileId: "stale-profile" },
      },
      authWrites,
    ),
    rtdbClient: rtdbClient("stale-profile", rtdbWrites),
  });
  assert.deepEqual(result, emptySource);
  assert.deepEqual(authWrites, [
    { uid: identity.uid, claims: { admin: true } },
  ]);
  assert.deepEqual(rtdbWrites, [{ "players/firebase-uid/profile": null }]);
});

test("does no cleanup writes when profile state is already absent", async () => {
  const authWrites: Array<Record<string, unknown>> = [];
  const rtdbWrites: Array<Record<string, unknown>> = [];
  assert.deepEqual(
    await syncProfileClaim(identity, env, {
      repository: { getProfileClaimSource: async () => emptySource },
      authClient: authClient(
        { uid: identity.uid, customClaims: { admin: true } },
        authWrites,
      ),
      rtdbClient: rtdbClient(null, rtdbWrites),
    }),
    emptySource,
  );
  assert.deepEqual(authWrites, []);
  assert.deepEqual(rtdbWrites, []);
});

test("keeps missing-profile cleanup failures non-fatal and sanitized", async () => {
  const logs: string[] = [];
  const result = await syncProfileClaim(identity, env, {
    repository: { getProfileClaimSource: async () => emptySource },
    authClient: {
      getUser: async () => {
        throw new FirebaseAuthAdminFailure();
      },
      setCustomUserClaims: async () => undefined,
    },
    rtdbClient: rtdbClient(null, []),
    logCleanupFailure: (kind) => logs.push(kind),
  });
  assert.deepEqual(result, emptySource);
  assert.deepEqual(logs, ["firebase-auth-unavailable"]);
});

test("blocks conflicting profiles before Firebase Auth or RTDB work", async () => {
  let authReads = 0;
  let rtdbReads = 0;
  await assert.rejects(
    syncProfileClaim(identity, env, {
      repository: {
        getProfileClaimSource: async () => {
          throw new LoginProfileConflict();
        },
      },
      authClient: {
        getUser: async () => {
          authReads++;
          return { uid: identity.uid, customClaims: {} };
        },
        setCustomUserClaims: async () => undefined,
      },
      rtdbClient: {
        getPath: async () => {
          rtdbReads++;
          return null;
        },
        patchRoot: async () => undefined,
      },
    }),
    (error: unknown) =>
      error instanceof AuthApiFailure &&
      error.status === 409 &&
      error.code === "failed-precondition" &&
      error.message === "login-profile-conflict",
  );
  assert.equal(authReads, 0);
  assert.equal(rtdbReads, 0);
});

test("propagates reconciliation failures when a profile exists", async () => {
  await assert.rejects(
    syncProfileClaim(identity, env, {
      repository: { getProfileClaimSource: async () => linkedSource },
      authClient: {
        getUser: async () => {
          throw new FirebaseAuthAdminFailure();
        },
        setCustomUserClaims: async () => undefined,
      },
      rtdbClient: rtdbClient("profile-1", []),
    }),
    FirebaseAuthAdminFailure,
  );
});
