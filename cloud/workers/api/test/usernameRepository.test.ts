import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_FIRESTORE_BODY_BYTES,
  UsernameRepositoryFailure,
  createUsernameRepository,
} from "../src/usernameRepository.ts";
import { TELEGRAM_TEST_ENV } from "./testEnv.ts";

const DATABASE_ROOT = "projects/mons-link/databases/(default)/documents";
const env = {
  ...TELEGRAM_TEST_ENV,
  AUTH_RATE_LIMITER: { limit: async () => ({ success: true }) },
  FIRESTORE_SERVICE_ACCOUNT_EMAIL: "worker@example.iam.gserviceaccount.com",
  FIRESTORE_SERVICE_ACCOUNT_PRIVATE_KEY: "test-private-key",
  HELIUS_RPC_API_KEY: "test-helius-key",
  NFT_RATE_LIMITER: { limit: async () => ({ success: true }) },
  X_CLIENT_ID: "test-x-client",
  X_CLIENT_SECRET: "test-x-secret",
} satisfies Env;

type StoredDocument = {
  fields: Record<string, unknown>;
  name: string;
};

type HarnessOptions = {
  commitConflicts?: number;
  indexes?: StoredDocument[];
  profile?: StoredDocument | null;
  users?: StoredDocument[];
};

function stringFields(values: Record<string, string>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key, { stringValue: value }]),
  );
}

function user(id: string, values: Record<string, string>): StoredDocument {
  return {
    name: `${DATABASE_ROOT}/users/${id}`,
    fields: stringFields(values),
  };
}

function index(id: string, profileId: string): StoredDocument {
  return {
    name: `${DATABASE_ROOT}/usernameIndex/${id}`,
    fields: stringFields({ profileId }),
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function readString(fields: Record<string, unknown>, name: string): string {
  const value = fields[name] as { stringValue?: unknown } | undefined;
  return typeof value?.stringValue === "string" ? value.stringValue : "";
}

function createHarness({
  commitConflicts = 0,
  indexes = [],
  profile = user("profile-1", {
    username: "Old",
    usernameLookupKey: "old",
  }),
  users = [],
}: HarnessOptions = {}) {
  const documents = new Map<string, StoredDocument>();
  if (profile) {
    documents.set(profile.name, profile);
  }
  for (const document of [...indexes, ...users]) {
    documents.set(document.name, document);
  }
  const requests: Array<{ body: Record<string, unknown>; url: string }> = [];
  const commits: Array<Record<string, unknown>> = [];
  const rollbacks: string[] = [];
  let beginCount = 0;
  let commitCount = 0;

  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    requests.push({ url, body });
    const authorization = new Headers(init?.headers).get("Authorization");
    assert.equal(authorization, "Bearer google-token");
    assert.ok(init?.signal instanceof AbortSignal);

    if (url.endsWith("documents:beginTransaction")) {
      beginCount++;
      return jsonResponse({ transaction: `transaction-${beginCount}` });
    }
    if (url.endsWith("documents:rollback")) {
      rollbacks.push(body.transaction);
      return jsonResponse({});
    }
    if (url.endsWith("documents:batchGet")) {
      return jsonResponse(
        body.documents.map((name: string) => {
          const document = documents.get(name);
          return document ? { found: document } : { missing: name };
        }),
      );
    }
    if (url.endsWith("documents:runQuery")) {
      const query = body.structuredQuery;
      const filter = query.where.fieldFilter;
      const fieldPath = filter.field.fieldPath;
      const expected = filter.value.stringValue;
      let matches: StoredDocument[];
      if (fieldPath === "logins") {
        matches = profile ? [profile] : [];
      } else {
        matches = Array.from(documents.values()).filter(
          (document) =>
            document.name.includes("/users/") &&
            readString(document.fields, fieldPath) === expected,
        );
      }
      return jsonResponse(
        matches.slice(0, query.limit).map((document) => ({ document })),
      );
    }
    if (url.endsWith("documents:commit")) {
      commitCount++;
      commits.push(body);
      if (commitCount <= commitConflicts) {
        return jsonResponse({ error: { status: "ABORTED" } }, 409);
      }
      return jsonResponse({ commitTime: "2026-08-21T00:00:00Z" });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  return {
    commits,
    fetcher,
    get beginCount() {
      return beginCount;
    },
    requests,
    rollbacks,
  };
}

function repository(
  harness: ReturnType<typeof createHarness>,
  maxTransactionAttempts = 5,
  projectionCommitted?: (profileId: string) => Promise<void> | void,
) {
  let accessTokenCalls = 0;
  const value = createUsernameRepository(env, {
    fetcher: harness.fetcher,
    getAccessToken: async (_env, options) => {
      accessTokenCalls++;
      assert.deepEqual(options?.credentials, {
        email: "username@example.iam.gserviceaccount.com",
        privateKeyPem: "test-private-key",
      });
      return "google-token";
    },
    maxTransactionAttempts,
    now: () => 1_700_000_000_000,
    projectionCommitted,
  });
  return {
    get accessTokenCalls() {
      return accessTokenCalls;
    },
    value,
  };
}

test("claims a username and removes owned and stale indexes atomically", async () => {
  const projectedProfileIds: string[] = [];
  const harness = createHarness({
    indexes: [
      index("old", "profile-1"),
      index("Old", "profile-1"),
      index("Mons", "stale-profile"),
    ],
    users: [user("stale-profile", { username: "" })],
  });
  const subject = repository(harness, 5, (profileId) => {
    projectedProfileIds.push(profileId);
  });

  assert.equal(
    await subject.value.editUsername("firebase-uid", "Mons"),
    "updated",
  );
  assert.equal(subject.accessTokenCalls, 1);
  assert.equal(harness.commits.length, 1);
  const writes = harness.commits[0].writes as Array<Record<string, unknown>>;
  assert.deepEqual(
    writes
      .filter((write) => typeof write.delete === "string")
      .map((write) => write.delete)
      .sort(),
    [
      `${DATABASE_ROOT}/usernameIndex/Mons`,
      `${DATABASE_ROOT}/usernameIndex/Old`,
      `${DATABASE_ROOT}/usernameIndex/old`,
    ],
  );
  const updates = writes.filter((write) => write.update) as Array<{
    update: StoredDocument;
  }>;
  assert.deepEqual(
    updates.map(({ update }) => update.name),
    [`${DATABASE_ROOT}/usernameIndex/mons`, `${DATABASE_ROOT}/users/profile-1`],
  );
  assert.deepEqual(projectedProfileIds, ["profile-1"]);
  assert.deepEqual(updates[0].update.fields, {
    lookupKey: { stringValue: "mons" },
    profileId: { stringValue: "profile-1" },
    updatedAtMs: { integerValue: "1700000000000" },
    username: { stringValue: "Mons" },
  });
});

test("rejects case-insensitive ownership collisions without writes", async () => {
  const harness = createHarness({
    indexes: [index("mons", "profile-2")],
    users: [user("profile-2", { username: "MONS" })],
  });
  const subject = repository(harness);

  assert.equal(
    await subject.value.editUsername("firebase-uid", "Mons"),
    "taken",
  );
  assert.equal(harness.commits.length, 0);
  assert.deepEqual(harness.rollbacks, ["transaction-1"]);
});

test("preserves missing, unchanged, and walletless clearing outcomes", async () => {
  const cases: Array<{
    expected: string;
    options: HarnessOptions;
    username: string;
  }> = [
    {
      expected: "profile-not-found",
      options: { profile: null },
      username: "Mons",
    },
    { expected: "updated", options: {}, username: "Old" },
    {
      expected: "cannot-clear",
      options: {
        profile: user("profile-1", {
          appleSub: "apple-user",
          username: "Old",
        }),
      },
      username: "",
    },
  ];

  for (const entry of cases) {
    const harness = createHarness(entry.options);
    const subject = repository(harness);
    assert.equal(
      await subject.value.editUsername("firebase-uid", entry.username),
      entry.expected,
    );
    assert.equal(harness.commits.length, 0);
    assert.deepEqual(harness.rollbacks, ["transaction-1"]);
  }
});

test("clears the username and only its owned indexes", async () => {
  const harness = createHarness({
    indexes: [index("old", "profile-1"), index("Old", "different-profile")],
  });
  const subject = repository(harness, 5, async () => {
    throw new Error("queue unavailable");
  });

  assert.equal(await subject.value.editUsername("firebase-uid", ""), "updated");
  const writes = harness.commits[0].writes as Array<Record<string, unknown>>;
  assert.deepEqual(
    writes.filter((write) => write.delete).map((write) => write.delete),
    [`${DATABASE_ROOT}/usernameIndex/old`],
  );
  assert.deepEqual(
    writes.find(
      (write) =>
        (write.update as StoredDocument | undefined)?.name ===
        `${DATABASE_ROOT}/users/profile-1`,
    ),
    {
      update: {
        name: `${DATABASE_ROOT}/users/profile-1`,
        fields: { username: { stringValue: "" } },
      },
      updateMask: { fieldPaths: ["username", "usernameLookupKey"] },
      currentDocument: { exists: true },
    },
  );
});

test("retries conflicts with the prior transaction and bounds exhaustion", async () => {
  const retryHarness = createHarness({ commitConflicts: 1 });
  const retrySubject = repository(retryHarness);
  assert.equal(
    await retrySubject.value.editUsername("firebase-uid", "Mons"),
    "updated",
  );
  assert.equal(retryHarness.beginCount, 2);
  const beginBodies = retryHarness.requests
    .filter(({ url }) => url.endsWith("documents:beginTransaction"))
    .map(({ body }) => body);
  assert.deepEqual(beginBodies, [
    { options: { readWrite: {} } },
    {
      options: {
        readWrite: { retryTransaction: "transaction-1" },
      },
    },
  ]);

  const failedHarness = createHarness({ commitConflicts: 2 });
  const failedSubject = repository(failedHarness, 2);
  await assert.rejects(
    failedSubject.value.editUsername("firebase-uid", "Mons"),
    UsernameRepositoryFailure,
  );
  assert.deepEqual(failedHarness.rollbacks, ["transaction-2"]);
});

test("rejects malformed, oversized, and transport-failed upstream responses", async () => {
  const responses = [
    jsonResponse({}),
    new Response("{}", {
      status: 200,
      headers: {
        "Content-Length": String(MAX_FIRESTORE_BODY_BYTES + 1),
      },
    }),
  ];
  for (const response of responses) {
    const subject = createUsernameRepository(env, {
      fetcher: async () => response,
      getAccessToken: async () => "google-token",
    });
    await assert.rejects(
      subject.editUsername("firebase-uid", "Mons"),
      UsernameRepositoryFailure,
    );
  }

  const subject = createUsernameRepository(env, {
    fetcher: async () => {
      throw new Error("private-network-detail");
    },
    getAccessToken: async () => "google-token",
  });
  await assert.rejects(
    subject.editUsername("firebase-uid", "Mons"),
    (error) =>
      error instanceof UsernameRepositoryFailure &&
      !error.message.includes("private-network-detail"),
  );
});
