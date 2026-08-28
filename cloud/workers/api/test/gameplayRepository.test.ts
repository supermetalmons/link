import assert from "node:assert/strict";
import test from "node:test";
import {
  createGameplayRepository,
  GameplayRepositoryFailure,
  parseGameplayProfileQuery,
  parseMiningMaterialsDocument,
  parseMiningSnapshotDocument,
  parseProfileQuery,
} from "../src/gameplayRepository.ts";
import type { FirebaseRtdbClient } from "../src/firebaseRtdb.ts";
import { TELEGRAM_TEST_ENV } from "./testEnv.ts";

const env = {
  ...TELEGRAM_TEST_ENV,
  AUTH_RATE_LIMITER: { limit: async () => ({ success: true }) },
  FIRESTORE_SERVICE_ACCOUNT_EMAIL: "worker@example.iam.gserviceaccount.com",
  FIRESTORE_SERVICE_ACCOUNT_PRIVATE_KEY: "test-private-key",
  HELIUS_RPC_API_KEY: "test-helius-key",
  NFT_RATE_LIMITER: { limit: async () => ({ success: true }) },
  X_CLIENT_ID: "test-x-client",
  X_CLIENT_SECRET: "test-x-secret",
} as Env;

const rtdbClient: FirebaseRtdbClient = {
  getPath: async () => null,
  patchRoot: async () => undefined,
  transactPath: async () => ({ committed: false, value: null }),
};

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("parses only the profile fields used by gameplay", () => {
  assert.equal(
    parseProfileQuery([
      {
        document: {
          name: "projects/mons-link/databases/(default)/documents/users/profile-1",
          fields: { logins: { arrayValue: {} } },
        },
      },
    ]),
    "profile-1",
  );
  assert.equal(parseProfileQuery([{ readTime: "now" }]), null);
  assert.throws(() => parseProfileQuery({}), GameplayRepositoryFailure);
  assert.deepEqual(
    parseGameplayProfileQuery([
      {
        document: {
          name: "projects/mons-link/databases/(default)/documents/users/profile-1",
          fields: {
            aura: { stringValue: "legacy" },
            custom: {
              mapValue: {
                fields: {
                  aura: { stringValue: "rainbow" },
                  emoji: { integerValue: "0" },
                },
              },
            },
            emoji: { integerValue: "8" },
            eth: { stringValue: "0xabc" },
            rating: { integerValue: "1512" },
            sol: { stringValue: "solana" },
            username: { stringValue: "alice" },
          },
        },
      },
    ]),
    {
      aura: "rainbow",
      emoji: 0,
      eth: "0xabc",
      profileId: "profile-1",
      rating: 1512,
      sol: "solana",
      username: "alice",
    },
  );
  assert.deepEqual(
    parseGameplayProfileQuery([
      {
        document: {
          name: "projects/mons-link/databases/(default)/documents/users/profile-2",
        },
      },
    ]),
    {
      aura: "",
      emoji: "",
      eth: "",
      profileId: "profile-2",
      rating: 1500,
      sol: "",
      username: "",
    },
  );
  assert.equal(
    parseGameplayProfileQuery([
      {
        document: {
          name: "projects/mons-link/databases/(default)/documents/users/profile-3",
          fields: {
            aura: { stringValue: "legacy" },
            custom: {
              mapValue: { fields: { aura: { nullValue: null } } },
            },
          },
        },
      },
    ])?.aura,
    "legacy",
  );
  assert.equal(
    parseGameplayProfileQuery([
      {
        document: {
          name: "projects/mons-link/databases/(default)/documents/users/profile-4",
          fields: {
            aura: { stringValue: "legacy" },
            custom: {
              mapValue: { fields: { aura: { stringValue: "" } } },
            },
          },
        },
      },
    ])?.aura,
    "",
  );
  assert.equal(parseGameplayProfileQuery([{ readTime: "now" }]), null);
  assert.throws(() => parseGameplayProfileQuery({}), GameplayRepositoryFailure);
  assert.deepEqual(
    parseMiningMaterialsDocument({
      fields: {
        mining: {
          mapValue: {
            fields: {
              materials: {
                mapValue: {
                  fields: {
                    dust: { integerValue: "3" },
                    slime: { doubleValue: 1.4 },
                    ice: { stringValue: "2" },
                  },
                },
              },
            },
          },
        },
      },
    }),
    { dust: 3, slime: 1, gum: 0, metal: 0, ice: 0 },
  );
  assert.throws(
    () => parseMiningMaterialsDocument([]),
    GameplayRepositoryFailure,
  );
  assert.deepEqual(
    parseMiningSnapshotDocument({
      fields: {
        mining: {
          mapValue: {
            fields: {
              lastRockDate: { stringValue: "2026-08-20" },
              materials: {
                mapValue: {
                  fields: { dust: { integerValue: "4" } },
                },
              },
            },
          },
        },
      },
    }),
    {
      lastRockDate: "2026-08-20",
      materials: { dust: 4, slime: 0, gum: 0, metal: 0, ice: 0 },
    },
  );
});

test("applies one atomic idempotent settlement transfer", async () => {
  const requests: Array<{ input: string; init: RequestInit }> = [];
  const projectedProfileIds: string[] = [];
  const fingerprint = "settlement-fingerprint";
  let committed = false;
  const repository = createGameplayRepository(env, {
    rtdbClient,
    projectionCommitted: async (profileId) => {
      projectedProfileIds.push(profileId);
      throw new Error("queue unavailable");
    },
    getAccessToken: async (_env, options) => {
      assert.equal(options?.credentials, undefined);
      return "firestore-access-token";
    },
    fetcher: async (input, init = {}) => {
      const url = String(input);
      requests.push({ input: url, init });
      if (url.endsWith("/wagerSettlements/operation-id")) {
        return committed
          ? jsonResponse({
              fields: { fingerprint: { stringValue: fingerprint } },
            })
          : jsonResponse({}, 404);
      }
      if (url.endsWith(":beginTransaction")) {
        return jsonResponse({ transaction: "wager-transaction" });
      }
      if (url.endsWith(":batchGet")) {
        const body = JSON.parse(String(init.body));
        return jsonResponse(
          body.documents.map((name: string) => ({ missing: name })),
        );
      }
      if (url.endsWith(":commit")) {
        committed = true;
        return jsonResponse({});
      }
      throw new Error(`unexpected request: ${url}`);
    },
  });
  const input = {
    operationId: "operation-id",
    fingerprint,
    winnerProfileId: "winner",
    loserProfileId: "loser",
    material: "dust" as const,
    count: 2,
    appliedAtMs: 100,
  };
  assert.equal(await repository.applyWagerTransferOnce(input), "applied");
  assert.equal(await repository.applyWagerTransferOnce(input), "replayed");
  assert.deepEqual(projectedProfileIds, ["winner", "loser"]);
  assert.equal(requests.length, 5);
  for (const entry of requests) {
    assert.equal(
      new Headers(entry.init.headers).get("Authorization"),
      "Bearer firestore-access-token",
    );
  }
  assert.equal(requests[3].input.endsWith("/documents:commit"), true);
  const commitBody = JSON.parse(String(requests[3].init.body));
  assert.deepEqual(
    {
      writes: commitBody.writes.slice(0, 3),
      transaction: commitBody.transaction,
    },
    {
      writes: [
        {
          update: {
            name: "projects/mons-link/databases/(default)/documents/wagerSettlements/operation-id",
            fields: {
              appliedAtMs: { integerValue: "100" },
              count: { integerValue: "2" },
              fingerprint: { stringValue: fingerprint },
              loserProfileId: { stringValue: "loser" },
              material: { stringValue: "dust" },
              operationId: { stringValue: "operation-id" },
              winnerProfileId: { stringValue: "winner" },
            },
          },
          currentDocument: { exists: false },
        },
        {
          transform: {
            document:
              "projects/mons-link/databases/(default)/documents/users/winner",
            fieldTransforms: [
              {
                fieldPath: "mining.materials.dust",
                increment: { integerValue: "2" },
              },
            ],
          },
          currentDocument: { exists: true },
        },
        {
          transform: {
            document:
              "projects/mons-link/databases/(default)/documents/users/loser",
            fieldTransforms: [
              {
                fieldPath: "mining.materials.dust",
                increment: { integerValue: "-2" },
              },
            ],
          },
          currentDocument: { exists: true },
        },
      ],
      transaction: "wager-transaction",
    },
  );
  assert.equal(commitBody.writes.length, 3);
});

test("rejects malformed profile merge targets during settlement", async () => {
  for (const targetProfileId of [
    { stringValue: "   " },
    { integerValue: "1" },
    { stringValue: "invalid/profile" },
    { stringValue: "__reserved__" },
    { stringValue: "x".repeat(1_501) },
  ]) {
    let commitAttempts = 0;
    let rollbacks = 0;
    const repository = createGameplayRepository(env, {
      rtdbClient,
      getAccessToken: async () => "firestore-access-token",
      fetcher: async (input, init = {}) => {
        const url = String(input);
        if (url.endsWith("/wagerSettlements/malformed-target")) {
          return jsonResponse({}, 404);
        }
        if (url.endsWith(":beginTransaction")) {
          return jsonResponse({ transaction: "malformed-target-transaction" });
        }
        if (url.endsWith(":batchGet")) {
          const body = JSON.parse(String(init.body)) as {
            documents: string[];
          };
          return jsonResponse(
            body.documents.map((name) =>
              name.endsWith("/profileMergeTargets/winner")
                ? {
                    found: {
                      name,
                      fields: { targetProfileId },
                    },
                  }
                : { missing: name },
            ),
          );
        }
        if (url.endsWith(":rollback")) {
          rollbacks++;
          return jsonResponse({});
        }
        if (url.endsWith(":commit")) {
          commitAttempts++;
          return jsonResponse({});
        }
        throw new Error(`unexpected request: ${url}`);
      },
    });

    await assert.rejects(
      repository.applyWagerTransferOnce({
        operationId: "malformed-target",
        fingerprint: "malformed-target-fingerprint",
        winnerProfileId: "winner",
        loserProfileId: "loser",
        material: "dust",
        count: 2,
        appliedAtMs: 100,
      }),
      GameplayRepositoryFailure,
    );
    assert.equal(commitAttempts, 0);
    assert.equal(rollbacks, 1);
  }
});

test("retries against canonical profiles when a merge races settlement", async () => {
  const fingerprint = "canonical-fingerprint";
  const mergeTargets = new Map<string, string>();
  let transactionSequence = 0;
  let commitAttempts = 0;
  let rawCommitBody: unknown;
  const repository = createGameplayRepository(env, {
    rtdbClient,
    getAccessToken: async () => "firestore-access-token",
    fetcher: async (input, init = {}) => {
      const url = String(input);
      if (url.endsWith("/wagerSettlements/canonical-operation")) {
        return jsonResponse({}, 404);
      }
      if (url.endsWith(":beginTransaction")) {
        transactionSequence++;
        const body = JSON.parse(String(init.body));
        if (transactionSequence === 2) {
          assert.equal(
            body.options.readWrite.retryTransaction,
            "canonical-transaction-1",
          );
        }
        return jsonResponse({
          transaction: `canonical-transaction-${transactionSequence}`,
        });
      }
      if (url.endsWith(":batchGet")) {
        const body = JSON.parse(String(init.body)) as {
          documents: string[];
          transaction: string;
        };
        assert.equal(
          body.transaction,
          `canonical-transaction-${transactionSequence}`,
        );
        assert.equal(
          body.documents.every(
            (name) =>
              name.includes("/wagerSettlements/") ||
              name.includes("/profileMergeTargets/"),
          ),
          true,
        );
        return jsonResponse(
          body.documents.map((name) => {
            const marker = "/profileMergeTargets/";
            const markerIndex = name.indexOf(marker);
            const profileId =
              markerIndex < 0
                ? ""
                : decodeURIComponent(name.slice(markerIndex + marker.length));
            const targetProfileId = mergeTargets.get(profileId);
            return targetProfileId
              ? {
                  found: {
                    name,
                    fields: {
                      targetProfileId: { stringValue: targetProfileId },
                    },
                  },
                }
              : { missing: name };
          }),
        );
      }
      if (url.endsWith(":commit")) {
        commitAttempts++;
        if (commitAttempts === 1) {
          mergeTargets.set("retired-winner", "intermediate-winner");
          mergeTargets.set("intermediate-winner", "winner");
          mergeTargets.set("retired-loser", "loser");
          return jsonResponse({}, 409);
        }
        rawCommitBody = JSON.parse(String(init.body));
        return jsonResponse({});
      }
      throw new Error(`unexpected request: ${url}`);
    },
  });

  assert.equal(
    await repository.applyWagerTransferOnce({
      operationId: "canonical-operation",
      fingerprint,
      winnerProfileId: "retired-winner",
      loserProfileId: "retired-loser",
      material: "dust",
      count: 2,
      appliedAtMs: 100,
    }),
    "applied",
  );
  const commitBody = rawCommitBody as Record<string, unknown>;
  const writes = commitBody?.writes as Array<Record<string, unknown>>;
  assert.equal(commitAttempts, 2);
  assert.equal(commitBody.transaction, "canonical-transaction-2");
  assert.deepEqual(
    writes
      .filter((write) => write.transform)
      .map((write) =>
        String((write.transform as Record<string, unknown>).document),
      ),
    [
      "projects/mons-link/databases/(default)/documents/users/winner",
      "projects/mons-link/databases/(default)/documents/users/loser",
    ],
  );
  assert.deepEqual((writes[0].update as Record<string, unknown>).fields, {
    appliedAtMs: { integerValue: "100" },
    count: { integerValue: "2" },
    fingerprint: { stringValue: fingerprint },
    loserProfileId: { stringValue: "loser" },
    material: { stringValue: "dust" },
    operationId: { stringValue: "canonical-operation" },
    winnerProfileId: { stringValue: "winner" },
  });
});

test("reconciles an ambiguous settlement commit from its ledger", async () => {
  const fingerprint = "ambiguous-fingerprint";
  let committed = false;
  const repository = createGameplayRepository(env, {
    rtdbClient,
    getAccessToken: async () => "firestore-access-token",
    fetcher: async (input, init = {}) => {
      const url = String(input);
      if (url.endsWith("/wagerSettlements/ambiguous-operation")) {
        return committed
          ? jsonResponse({
              fields: { fingerprint: { stringValue: fingerprint } },
            })
          : jsonResponse({}, 404);
      }
      if (url.endsWith(":beginTransaction")) {
        return jsonResponse({ transaction: "ambiguous-transaction" });
      }
      if (url.endsWith(":batchGet")) {
        const body = JSON.parse(String(init.body));
        return jsonResponse(
          body.documents.map((name: string) => ({ missing: name })),
        );
      }
      if (url.endsWith("/documents:commit")) {
        committed = true;
        throw new Error("ambiguous-commit");
      }
      if (url.endsWith(":rollback")) {
        return jsonResponse({});
      }
      throw new Error(`unexpected request: ${url}`);
    },
  });
  assert.equal(
    await repository.applyWagerTransferOnce({
      operationId: "ambiguous-operation",
      fingerprint,
      winnerProfileId: "winner",
      loserProfileId: "loser",
      material: "dust",
      count: 1,
      appliedAtMs: 100,
    }),
    "replayed",
  );
});

test("reads settlement mining with Firestore credentials", async () => {
  const repository = createGameplayRepository(env, {
    rtdbClient,
    getAccessToken: async () => "firestore-access-token",
    fetcher: async (_input, init = {}) => {
      assert.equal(
        new Headers(init.headers).get("Authorization"),
        "Bearer firestore-access-token",
      );
      return jsonResponse({
        fields: {
          mining: {
            mapValue: {
              fields: {
                lastRockDate: { stringValue: "2026-08-20" },
                materials: {
                  mapValue: { fields: { dust: { integerValue: "3" } } },
                },
              },
            },
          },
        },
      });
    },
  });
  assert.deepEqual(await repository.getMiningSnapshot("profile-1"), {
    lastRockDate: "2026-08-20",
    materials: { dust: 3, slime: 0, gum: 0, metal: 0, ice: 0 },
  });
});

test("reads only mining materials with the caller Firebase token", async () => {
  const requests: Array<{ input: string; init: RequestInit }> = [];
  const responses = [
    jsonResponse({
      fields: {
        mining: {
          mapValue: {
            fields: {
              materials: {
                mapValue: {
                  fields: { dust: { integerValue: "4" } },
                },
              },
            },
          },
        },
      },
    }),
    jsonResponse({}, 404),
  ];
  const repository = createGameplayRepository(env, {
    rtdbClient,
    fetcher: async (input, init = {}) => {
      requests.push({ input: String(input), init });
      return responses.shift() as Response;
    },
  });
  assert.deepEqual(
    await repository.getMiningMaterials("profile-1", "firebase-token"),
    { dust: 4, slime: 0, gum: 0, metal: 0, ice: 0 },
  );
  assert.deepEqual(
    await repository.getMiningMaterials("missing", "firebase-token"),
    { dust: 0, slime: 0, gum: 0, metal: 0, ice: 0 },
  );
  const url = new URL(requests[0].input);
  assert.equal(url.pathname.endsWith("/documents/users/profile-1"), true);
  assert.deepEqual(url.searchParams.getAll("mask.fieldPaths"), [
    "mining.materials",
  ]);
  assert.equal(
    new Headers(requests[0].init.headers).get("Authorization"),
    "Bearer firebase-token",
  );
});

test("queries the caller profile summary with the Firebase token", async () => {
  const requests: Array<{ input: string; init: RequestInit }> = [];
  const repository = createGameplayRepository(env, {
    rtdbClient,
    fetcher: async (input, init = {}) => {
      requests.push({ input: String(input), init });
      return jsonResponse([
        {
          document: {
            name: "projects/mons-link/databases/(default)/documents/users/profile-1",
            fields: { rating: { doubleValue: 1501.5 } },
          },
        },
      ]);
    },
  });
  assert.deepEqual(
    await repository.getGameplayProfile("firebase-uid", "firebase-token"),
    {
      aura: "",
      emoji: "",
      eth: "",
      profileId: "profile-1",
      rating: 1501.5,
      sol: "",
      username: "",
    },
  );
  assert.equal(requests[0].input.endsWith(":runQuery"), true);
  assert.equal(
    new Headers(requests[0].init.headers).get("Authorization"),
    "Bearer firebase-token",
  );
  assert.deepEqual(
    JSON.parse(String(requests[0].init.body)).structuredQuery.select.fields,
    [
      { fieldPath: "aura" },
      { fieldPath: "custom.aura" },
      { fieldPath: "custom.emoji" },
      { fieldPath: "emoji" },
      { fieldPath: "eth" },
      { fieldPath: "rating" },
      { fieldPath: "sol" },
      { fieldPath: "username" },
    ],
  );
});

test("finds the caller profile with the Firebase token", async () => {
  const requests: Array<{ input: string; init: RequestInit }> = [];
  const repository = createGameplayRepository(env, {
    rtdbClient,
    fetcher: async (input, init = {}) => {
      const url = String(input);
      requests.push({ input: url, init });
      return jsonResponse([
        {
          document: {
            name: "projects/mons-link/databases/(default)/documents/users/profile-1",
            fields: { logins: { arrayValue: {} } },
          },
        },
      ]);
    },
  });

  assert.equal(
    await repository.findProfileId("firebase-uid", "firebase-token"),
    "profile-1",
  );
  assert.equal(
    new Headers(requests[0].init.headers).get("Authorization"),
    "Bearer firebase-token",
  );
  assert.deepEqual(JSON.parse(String(requests[0].init.body)), {
    structuredQuery: {
      select: { fields: [{ fieldPath: "logins" }] },
      from: [{ collectionId: "users" }],
      where: {
        fieldFilter: {
          field: { fieldPath: "logins" },
          op: "ARRAY_CONTAINS",
          value: { stringValue: "firebase-uid" },
        },
      },
      limit: 1,
    },
  });
});
