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

test("schedules pending profile recovery without changing the response", async () => {
  const recoveries: string[] = [];
  const result = await syncProfileClaim(identity, env, {
    repository: {
      getProfileClaimSource: async () => ({
        ...linkedSource,
        pendingRecovery: true,
      }),
    },
    authClient: authClient(
      {
        uid: identity.uid,
        customClaims: { profileId: "profile-1" },
      },
      [],
    ),
    rtdbClient: rtdbClient("profile-1", []),
    schedulePendingProfileRecovery: (profileId) => {
      recoveries.push(profileId);
    },
  });
  assert.deepEqual(result, linkedSource);
  assert.deepEqual(recoveries, ["profile-1"]);
});

test("repairs a profile created after stale no-profile cleanup", async () => {
  const clients = mutableProfileClients("profile-1");
  const sources = [emptySource, linkedSource, linkedSource];
  let reads = 0;

  const result = await syncProfileClaim(identity, env, {
    repository: {
      getProfileClaimSource: async () =>
        sources[Math.min(reads++, sources.length - 1)],
    },
    authClient: clients.authClient,
    rtdbClient: clients.rtdbClient,
  });

  assert.deepEqual(result, linkedSource);
  assert.equal(reads, 3);
  assert.deepEqual(clients.authWrites, [
    { uid: identity.uid, claims: { admin: true } },
    {
      uid: identity.uid,
      claims: { admin: true, profileId: "profile-1" },
    },
  ]);
  assert.deepEqual(clients.rtdbWrites, [
    { "players/firebase-uid/profile": null },
    { "players/firebase-uid/profile": "profile-1" },
  ]);
  assert.deepEqual(clients.readState(), {
    customClaims: { admin: true, profileId: "profile-1" },
    profileLink: "profile-1",
  });
});

test("repairs a stale source after a concurrent profile merge", async () => {
  const targetSource = {
    ...linkedSource,
    profileId: "profile-2",
    linkedMethods: { apple: false, eth: true, sol: false, x: true },
    appleLinked: false,
  };
  const clients = mutableProfileClients(targetSource.profileId);
  const sources = [
    { ...linkedSource, pendingRecovery: true },
    { ...targetSource, pendingRecovery: true },
    { ...targetSource, pendingRecovery: true },
  ];
  const recoveries: string[] = [];
  let reads = 0;

  const result = await syncProfileClaim(identity, env, {
    repository: {
      getProfileClaimSource: async () =>
        sources[Math.min(reads++, sources.length - 1)],
    },
    authClient: clients.authClient,
    rtdbClient: clients.rtdbClient,
    schedulePendingProfileRecovery: (profileId) => {
      recoveries.push(profileId);
    },
  });

  assert.deepEqual(result, targetSource);
  assert.equal(reads, 3);
  assert.deepEqual(clients.authWrites, [
    {
      uid: identity.uid,
      claims: { admin: true, profileId: "profile-1" },
    },
    {
      uid: identity.uid,
      claims: { admin: true, profileId: "profile-2" },
    },
  ]);
  assert.deepEqual(clients.rtdbWrites, [
    { "players/firebase-uid/profile": "profile-1" },
    { "players/firebase-uid/profile": "profile-2" },
  ]);
  assert.deepEqual(clients.readState(), {
    customClaims: { admin: true, profileId: "profile-2" },
    profileLink: "profile-2",
  });
  assert.deepEqual(recoveries, ["profile-2"]);
});

test("waits for stale sibling writes before reconciling a moved profile", async () => {
  const targetSource = {
    ...linkedSource,
    profileId: "profile-2",
    linkedMethods: { apple: false, eth: true, sol: false, x: true },
    appleLinked: false,
  };
  const sources = [linkedSource, targetSource, targetSource];
  const links: string[] = [];
  let oldWriteSettled = false;
  let profileLink = "profile-2";
  let reads = 0;

  const result = await syncProfileClaim(identity, env, {
    repository: {
      getProfileClaimSource: async () => {
        if (reads === 1) {
          assert.equal(oldWriteSettled, true);
        }
        return sources[Math.min(reads++, sources.length - 1)];
      },
    },
    authClient: {
      getUser: async () => ({
        uid: identity.uid,
        customClaims: { profileId: "profile-2" },
      }),
      setCustomUserClaims: async () => {
        throw new Error("auth-write-failed");
      },
    },
    rtdbClient: {
      getPath: async () => profileLink,
      patchRoot: async (updates) => {
        const next = String(updates[`players/${identity.uid}/profile`]);
        if (next === "profile-1") {
          await new Promise((resolve) => setTimeout(resolve, 20));
          oldWriteSettled = true;
        }
        profileLink = next;
        links.push(next);
      },
    },
  });

  assert.deepEqual(result, targetSource);
  assert.deepEqual(links, ["profile-1", "profile-2"]);
  assert.equal(profileLink, "profile-2");
});

test("fails closed after bounded profile source instability", async () => {
  const targetSource = {
    ...linkedSource,
    profileId: "profile-2",
    pendingRecovery: true,
  };
  const clients = mutableProfileClients(targetSource.profileId);
  const sources = [
    { ...linkedSource, pendingRecovery: true },
    targetSource,
    { ...linkedSource, pendingRecovery: true },
    targetSource,
  ];
  const recoveries: string[] = [];
  let reads = 0;

  await assert.rejects(
    syncProfileClaim(identity, env, {
      repository: {
        getProfileClaimSource: async () =>
          sources[Math.min(reads++, sources.length - 1)],
      },
      authClient: clients.authClient,
      rtdbClient: clients.rtdbClient,
      schedulePendingProfileRecovery: (profileId) => {
        recoveries.push(profileId);
      },
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
  assert.deepEqual(clients.authWrites.at(-1), {
    uid: identity.uid,
    claims: { admin: true, profileId: "profile-2" },
  });
  assert.deepEqual(clients.rtdbWrites.at(-1), {
    "players/firebase-uid/profile": "profile-2",
  });
  assert.deepEqual(recoveries, ["profile-2"]);
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
