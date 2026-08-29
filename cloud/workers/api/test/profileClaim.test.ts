import assert from "node:assert/strict";
import test from "node:test";
import { AuthApiFailure } from "../src/authErrors.ts";
import {
  FirebaseAuthAdminFailure,
  type FirebaseAuthAdminClient,
  type FirebaseAuthUser,
} from "../src/firebaseAuthAdmin.ts";
import type { FirebaseRtdbClient } from "../src/firebaseRtdb.ts";
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

const syncProfileClaim = syncProfileClaimImpl;

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

function mutableProfileClients(initialProfileId: string) {
  let customClaims: Record<string, unknown> = {
    admin: true,
    profileId: initialProfileId,
  };
  let profileLink: unknown = initialProfileId;
  const authWrites: Array<Record<string, unknown>> = [];
  const rtdbWrites: Array<Record<string, unknown>> = [];
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
    rtdbClient: {
      getPath: async () => profileLink,
      patchRoot: async (updates) => {
        profileLink = updates[`players/${identity.uid}/profile`];
        rtdbWrites.push({ ...updates });
      },
    } satisfies Pick<FirebaseRtdbClient, "getPath" | "patchRoot">,
    authWrites,
    rtdbWrites,
    readState: () => ({ customClaims, profileLink }),
  };
}

test("returns current profile state without writing claims or RTDB", async () => {
  const authWrites: Array<Record<string, unknown>> = [];
  const rtdbWrites: Array<Record<string, unknown>> = [];
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
    rtdbClient: rtdbClient(" profile-1 ", rtdbWrites),
    syncCurrentCallerProfile: async (uid) => {
      syncCalls.push(uid);
      return linkedSource;
    },
  });
  assert.deepEqual(result, linkedSource);
  assert.deepEqual(syncCalls, [identity.uid]);
  assert.deepEqual(authWrites, []);
  assert.deepEqual(rtdbWrites, []);
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
    rtdbClient: clients.rtdbClient,
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
  assert.deepEqual(clients.rtdbWrites, [
    {
      "players/firebase-uid/profile": null,
      "profileGameProjectionOutbox/profile/firebase-uid": null,
    },
  ]);
  assert.deepEqual(clients.readState(), {
    customClaims: { admin: true },
    profileLink: null,
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
    rtdbClient: clients.rtdbClient,
    syncCurrentCallerProfile: async (uid) => {
      syncCalls.push(uid);
      return targetSource;
    },
  });

  assert.deepEqual(result, targetSource);
  assert.equal(reads, 3);
  assert.deepEqual(syncCalls, [identity.uid]);
  assert.deepEqual(clients.authWrites, []);
  assert.deepEqual(clients.rtdbWrites, []);
  assert.deepEqual(clients.readState(), {
    customClaims: { admin: true, profileId: "profile-2" },
    profileLink: "profile-2",
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
    rtdbClient: {
      getPath: async () => {
        throw new Error("stale-profile-repair");
      },
      patchRoot: async () => undefined,
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
      rtdbClient: clients.rtdbClient,
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
    profileLink: "profile-2",
  });
  assert.deepEqual(clients.authWrites, []);
  assert.deepEqual(clients.rtdbWrites, []);
});

test("removes stale profile state and its projection outbox", async () => {
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
  assert.deepEqual(rtdbWrites, [
    {
      "players/firebase-uid/profile": null,
      "profileGameProjectionOutbox/profile/firebase-uid": null,
    },
  ]);
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
