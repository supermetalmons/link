import assert from "node:assert/strict";
import test from "node:test";
import { AuthApiFailure } from "../src/authErrors.ts";
import {
  FirebaseAuthAdminFailure,
  type FirebaseAuthAdminClient,
  type FirebaseAuthUser,
} from "../src/firebaseAuthAdmin.ts";
import { syncProfileClaim as syncProfileClaimImpl } from "../src/profileClaim.ts";
import { TELEGRAM_TEST_ENV } from "./testEnv.ts";

const env = {
  ...TELEGRAM_TEST_ENV,
  AUTH_RATE_LIMITER: { limit: async () => ({ success: true }) },
  FIREBASE_IDENTITY_SERVICE_ACCOUNT_EMAIL:
    "worker@example.iam.gserviceaccount.com",
  FIREBASE_IDENTITY_SERVICE_ACCOUNT_PRIVATE_KEY: "test-private-key",
  HELIUS_RPC_API_KEY: "test-helius-key",
  NFT_RATE_LIMITER: { limit: async () => ({ success: true }) },
  X_CLIENT_ID: "test-x-client",
  X_CLIENT_SECRET: "test-x-secret",
} as Env;

const syncProfileClaim: typeof syncProfileClaimImpl = (
  identity,
  env,
  dependencies,
) =>
  syncProfileClaimImpl(identity, env, {
    catchupStore: {
      read: async () => null,
      settleMissing: async () => false,
    },
    ...dependencies,
  });

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

function mutableProfileClients(initialProfileId: string) {
  let customClaims: Record<string, unknown> = {
    admin: true,
    profileId: initialProfileId,
  };
  const authWrites: Array<Record<string, unknown>> = [];
  return {
    authClient: {
      getUser: async () => ({
        uid: identity.uid,
        customClaims: { ...customClaims },
      }),
      setCustomUserClaims: async (uid, claims) => {
        customClaims = { ...claims };
        authWrites.push({ uid, claims: { ...claims } });
      },
    } satisfies FirebaseAuthAdminClient,
    authWrites,
    readState: () => ({ customClaims }),
  };
}

test("returns current profile state without directly writing claims", async () => {
  const authWrites: Array<Record<string, unknown>> = [];
  const syncCalls: string[] = [];
  const result = await syncProfileClaim(identity, env, {
    repository: { getProfileClaimSource: async () => linkedSource },
    authClient: authClient(
      {
        uid: identity.uid,
        customClaims: { admin: true, profileId: "profile-1" },
      },
      authWrites,
    ),
    syncCurrentCallerProfile: async (uid) => {
      syncCalls.push(uid);
      return linkedSource;
    },
  });
  assert.deepEqual(result, linkedSource);
  assert.deepEqual(syncCalls, [identity.uid]);
  assert.deepEqual(authWrites, []);
});

test("delegates when a profile appears after no-profile cleanup", async () => {
  const clients = mutableProfileClients("profile-1");
  const sources = [emptySource, linkedSource, linkedSource];
  const syncCalls: string[] = [];
  let reads = 0;

  const result = await syncProfileClaim(identity, env, {
    repository: {
      getProfileClaimSource: async () =>
        sources[Math.min(reads++, sources.length - 1)],
    },
    authClient: clients.authClient,
    syncCurrentCallerProfile: async (uid) => {
      syncCalls.push(uid);
      return linkedSource;
    },
  });

  assert.deepEqual(result, linkedSource);
  assert.equal(reads, 3);
  assert.deepEqual(syncCalls, [identity.uid]);
  assert.deepEqual(clients.authWrites, [
    { uid: identity.uid, claims: { admin: true } },
  ]);
  assert.deepEqual(clients.readState(), {
    customClaims: { admin: true },
  });
});

test("does not repair a stale source before canonical caller sync", async () => {
  const targetSource = {
    ...linkedSource,
    profileId: "profile-2",
    linkedMethods: { apple: false, eth: true, sol: false, x: true },
    appleLinked: false,
  };
  const clients = mutableProfileClients(targetSource.profileId);
  const sources = [linkedSource, targetSource, targetSource];
  const syncCalls: string[] = [];
  let reads = 0;

  const result = await syncProfileClaim(identity, env, {
    repository: {
      getProfileClaimSource: async () =>
        sources[Math.min(reads++, sources.length - 1)],
    },
    authClient: clients.authClient,
    syncCurrentCallerProfile: async (uid) => {
      syncCalls.push(uid);
      return targetSource;
    },
  });

  assert.deepEqual(result, targetSource);
  assert.equal(reads, 3);
  assert.deepEqual(syncCalls, [identity.uid]);
  assert.deepEqual(clients.authWrites, []);
  assert.deepEqual(clients.readState(), {
    customClaims: { admin: true, profileId: "profile-2" },
  });
});

test("returns the canonical caller after the stable source retires", async () => {
  const targetSource = {
    ...linkedSource,
    profileId: "profile-2",
    linkedMethods: { apple: false, eth: true, sol: false, x: true },
    appleLinked: false,
  };
  let reads = 0;
  const syncCalls: string[] = [];

  const result = await syncProfileClaim(identity, env, {
    repository: {
      getProfileClaimSource: async () => {
        reads++;
        return linkedSource;
      },
    },
    authClient: {
      getUser: async () => {
        throw new Error("stale-profile-repair");
      },
      setCustomUserClaims: async () => undefined,
    },
    syncCurrentCallerProfile: async (uid) => {
      syncCalls.push(uid);
      return targetSource;
    },
  });

  assert.deepEqual(result, targetSource);
  assert.equal(reads, 2);
  assert.deepEqual(syncCalls, [identity.uid]);
});

test("fails closed after bounded profile source instability", async () => {
  const targetSource = {
    ...linkedSource,
    profileId: "profile-2",
  };
  const clients = mutableProfileClients(targetSource.profileId);
  const sources = [linkedSource, targetSource, linkedSource, targetSource];
  let reads = 0;

  await assert.rejects(
    syncProfileClaim(identity, env, {
      repository: {
        getProfileClaimSource: async () =>
          sources[Math.min(reads++, sources.length - 1)],
      },
      authClient: clients.authClient,
    }),
    (error: unknown) =>
      error instanceof AuthApiFailure &&
      error.status === 409 &&
      error.code === "aborted" &&
      error.message === "profile-claim-source-unstable",
  );
  assert.equal(reads, 4);
  assert.deepEqual(clients.readState(), {
    customClaims: { admin: true, profileId: "profile-2" },
  });
  assert.deepEqual(clients.authWrites, []);
});

test("removes only the stale profile claim while preserving unrelated claims", async () => {
  const authWrites: Array<Record<string, unknown>> = [];
  const result = await syncProfileClaim(identity, env, {
    repository: { getProfileClaimSource: async () => emptySource },
    authClient: authClient(
      {
        uid: identity.uid,
        customClaims: { admin: true, profileId: "stale-profile" },
      },
      authWrites,
    ),
  });
  assert.deepEqual(result, emptySource);
  assert.deepEqual(authWrites, [
    { uid: identity.uid, claims: { admin: true } },
  ]);
});

test("does no cleanup writes when profile state is already absent", async () => {
  const authWrites: Array<Record<string, unknown>> = [];
  assert.deepEqual(
    await syncProfileClaim(identity, env, {
      repository: { getProfileClaimSource: async () => emptySource },
      authClient: authClient(
        { uid: identity.uid, customClaims: { admin: true } },
        authWrites,
      ),
    }),
    emptySource,
  );
  assert.deepEqual(authWrites, []);
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
    logCleanupFailure: (kind) => logs.push(kind),
  });
  assert.deepEqual(result, emptySource);
  assert.deepEqual(logs, ["firebase-auth-unavailable"]);
});

test("propagates caller repair failures when a profile exists", async () => {
  await assert.rejects(
    syncProfileClaim(identity, env, {
      repository: { getProfileClaimSource: async () => linkedSource },
      syncCurrentCallerProfile: async () => {
        throw new FirebaseAuthAdminFailure();
      },
    }),
    FirebaseAuthAdminFailure,
  );
});

test("missing-profile cleanup conditionally settles the observed D1 job", async () => {
  const settlements: unknown[][] = [];
  const result = await syncProfileClaim(identity, env, {
    repository: { getProfileClaimSource: async () => emptySource },
    authClient: authClient({ uid: identity.uid, customClaims: {} }, []),
    catchupStore: {
      read: async () => ({
        loginUid: identity.uid,
        requestId: "observed-request",
        profileId: "old-profile",
        cleanupProfileIds: [],
        matchCursor: "match-20",
        sourceUpdatedAtMs: 100,
        lastQueuedAtMs: 200,
        revision: 1,
      }),
      settleMissing: async (...args) => {
        settlements.push(args);
        return false;
      },
    },
  });
  assert.deepEqual(result, emptySource);
  assert.deepEqual(settlements, [
    [identity.uid, "observed-request", "match-20"],
  ]);
});

test("D1 cleanup failures retain pending work and do not clear Auth claims", async () => {
  const authWrites: Array<Record<string, unknown>> = [];
  const logs: string[] = [];
  await syncProfileClaim(identity, env, {
    repository: { getProfileClaimSource: async () => emptySource },
    authClient: authClient(
      { uid: identity.uid, customClaims: { profileId: "old-profile" } },
      authWrites,
    ),
    catchupStore: {
      read: async () => {
        throw new Error("private-database-detail");
      },
      settleMissing: async () => {
        throw new Error("unexpected-settlement");
      },
    },
    logCleanupFailure: (kind) => logs.push(kind),
  });
  assert.deepEqual(authWrites, []);
  assert.deepEqual(logs, ["profile-claim-cleanup-unavailable"]);
});
