import assert from "node:assert/strict";
import test from "node:test";
import { AuthApiFailure } from "../src/authErrors.ts";
import { syncProfile as syncProfileImpl } from "../src/profileSync.ts";
import type { ProfileLinkCatchupJob } from "../src/profileLinkCatchupD1.ts";
import { TELEGRAM_TEST_ENV } from "./testEnv.ts";

const env = TELEGRAM_TEST_ENV as Env;
const identity = { uid: "firebase-uid" };
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
const job: ProfileLinkCatchupJob = {
  loginUid: identity.uid,
  requestId: "observed-request",
  profileId: "old-profile",
  cleanupProfileIds: ["older-profile"],
  matchCursor: "match-20",
  sourceUpdatedAtMs: 100,
  lastQueuedAtMs: 200,
  revision: 1,
};
const syncProfile: typeof syncProfileImpl = (identity, env, dependencies) =>
  syncProfileImpl(identity, env, {
    catchupStore: {
      read: async () => null,
      settleMissing: async () => false,
    },
    ...dependencies,
  });

test("returns canonical profile state and runs caller synchronization", async () => {
  const calls: string[] = [];
  const result = await syncProfile(identity, env, {
    repository: { getLinkedAuthMethods: async () => linkedSource },
    syncCurrentCallerProfile: async (uid) => {
      calls.push(uid);
      return linkedSource;
    },
  });
  assert.deepEqual(result, linkedSource);
  assert.deepEqual(calls, [identity.uid]);
});

test("delegates when a profile appears after no-profile cleanup", async () => {
  const sources = [emptySource, linkedSource, linkedSource];
  const calls: string[] = [];
  let reads = 0;
  const result = await syncProfile(identity, env, {
    repository: {
      getLinkedAuthMethods: async () =>
        sources[Math.min(reads++, sources.length - 1)],
    },
    syncCurrentCallerProfile: async (uid) => {
      calls.push(uid);
      return linkedSource;
    },
  });
  assert.deepEqual(result, linkedSource);
  assert.equal(reads, 3);
  assert.deepEqual(calls, [identity.uid]);
});

test("rechecks a changing owner before canonical caller synchronization", async () => {
  const target = { ...linkedSource, profileId: "profile-2" };
  const sources = [linkedSource, target, target];
  let reads = 0;
  let calls = 0;
  const result = await syncProfile(identity, env, {
    repository: {
      getLinkedAuthMethods: async () =>
        sources[Math.min(reads++, sources.length - 1)],
    },
    syncCurrentCallerProfile: async () => {
      calls++;
      return target;
    },
  });
  assert.deepEqual(result, target);
  assert.equal(reads, 3);
  assert.equal(calls, 1);
});

test("returns the canonical caller after the previously stable source retires", async () => {
  const target = { ...linkedSource, profileId: "profile-2" };
  let reads = 0;
  const result = await syncProfile(identity, env, {
    repository: {
      getLinkedAuthMethods: async () => {
        reads++;
        return linkedSource;
      },
    },
    syncCurrentCallerProfile: async () => target,
  });
  assert.deepEqual(result, target);
  assert.equal(reads, 2);
});

test("fails closed after bounded profile source instability", async () => {
  const target = { ...linkedSource, profileId: "profile-2" };
  const sources = [linkedSource, target, linkedSource, target];
  let reads = 0;
  await assert.rejects(
    syncProfile(identity, env, {
      repository: {
        getLinkedAuthMethods: async () =>
          sources[Math.min(reads++, sources.length - 1)],
      },
    }),
    (error: unknown) =>
      error instanceof AuthApiFailure &&
      error.status === 409 &&
      error.code === "aborted" &&
      error.message === "profile-claim-source-unstable",
  );
  assert.equal(reads, 4);
});

test("absent ownership does not create cleanup work or call Firebase", async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    throw new Error("unexpected-network");
  };
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      assert.deepEqual(
        await syncProfile(identity, env, {
          repository: { getLinkedAuthMethods: async () => emptySource },
          catchupStore: {
            read: async () => null,
            settleMissing: async () => {
              throw new Error("unexpected-settlement");
            },
          },
        }),
        emptySource,
      );
    }
    assert.equal(requests, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("propagates caller repair failures when a profile exists", async () => {
  const failure = new AuthApiFailure(
    503,
    "unavailable",
    "profile-ownership-unavailable",
  );
  await assert.rejects(
    syncProfile(identity, env, {
      repository: { getLinkedAuthMethods: async () => linkedSource },
      syncCurrentCallerProfile: async () => {
        throw failure;
      },
    }),
    failure,
  );
});

test("missing-profile cleanup conditionally settles only the observed D1 job", async () => {
  const settlements: unknown[][] = [];
  const result = await syncProfile(identity, env, {
    repository: { getLinkedAuthMethods: async () => emptySource },
    catchupStore: {
      read: async () => structuredClone(job),
      settleMissing: async (...args) => {
        settlements.push(args);
        return false;
      },
    },
  });
  assert.deepEqual(result, emptySource);
  assert.deepEqual(settlements, [
    [identity.uid, job.requestId, job.matchCursor],
  ]);
});

test("an intervening link during guarded orphan cleanup synchronizes the new owner", async () => {
  let source: typeof linkedSource | typeof emptySource = emptySource;
  const settlements: unknown[][] = [];
  let calls = 0;
  const result = await syncProfile(identity, env, {
    repository: { getLinkedAuthMethods: async () => source },
    catchupStore: {
      read: async () => structuredClone(job),
      settleMissing: async (...args) => {
        settlements.push(args);
        source = linkedSource;
        return false;
      },
    },
    syncCurrentCallerProfile: async () => {
      calls++;
      return linkedSource;
    },
  });
  assert.deepEqual(result, linkedSource);
  assert.deepEqual(settlements, [
    [identity.uid, job.requestId, job.matchCursor],
  ]);
  assert.equal(calls, 1);
});

for (const failingOperation of ["read", "settleMissing"] as const) {
  test(`missing-profile ${failingOperation} failure remains non-fatal and sanitized`, async () => {
    const logs: string[] = [];
    const result = await syncProfile(identity, env, {
      repository: { getLinkedAuthMethods: async () => emptySource },
      catchupStore: {
        read: async () => {
          if (failingOperation === "read")
            throw new Error("private-database-detail");
          return structuredClone(job);
        },
        settleMissing: async () => {
          throw new Error("private-settlement-detail");
        },
      },
      logCleanupFailure: (kind) => logs.push(kind),
    });
    assert.deepEqual(result, emptySource);
    assert.deepEqual(logs, ["profile-sync-cleanup-unavailable"]);
  });
}
