import assert from "node:assert/strict";
import test from "node:test";
import { FirestoreFailure } from "../src/firestore.ts";
import {
  createMiningRepository,
  parseMiningProfileQuery,
} from "../src/miningRepository.ts";
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

function queryResponse() {
  return [
    {
      document: {
        name: "projects/mons-link/databases/(default)/documents/users/profile-1",
        fields: {
          mining: {
            mapValue: {
              fields: {
                lastRockDate: { stringValue: "2026-08-17" },
                materials: {
                  mapValue: {
                    fields: {
                      dust: { stringValue: "4" },
                      slime: { integerValue: "3" },
                      gum: { integerValue: "2" },
                      metal: { integerValue: "1" },
                      ice: { integerValue: "0" },
                    },
                  },
                },
              },
            },
          },
        },
        updateTime: "2026-08-18T10:00:00.123456Z",
      },
    },
  ];
}

test("parses mining profiles and normalizes absent mining fields", () => {
  assert.deepEqual(parseMiningProfileQuery(queryResponse()), {
    profileId: "profile-1",
    updateTime: "2026-08-18T10:00:00.123456Z",
    mining: {
      lastRockDate: "2026-08-17",
      materials: { dust: 4, slime: 3, gum: 2, metal: 1, ice: 0 },
    },
  });
  assert.deepEqual(
    parseMiningProfileQuery([
      {
        document: {
          name: "projects/mons-link/databases/(default)/documents/users/profile-2",
          fields: {},
          updateTime: "2026-08-18T10:00:00Z",
        },
      },
    ]),
    {
      profileId: "profile-2",
      updateTime: "2026-08-18T10:00:00Z",
      mining: {
        lastRockDate: null,
        materials: { dust: 0, slime: 0, gum: 0, metal: 0, ice: 0 },
      },
    },
  );
  assert.equal(
    parseMiningProfileQuery([{ readTime: "2026-08-18T10:00:00Z" }]),
    null,
  );
  assert.throws(() => parseMiningProfileQuery({}), FirestoreFailure);
  assert.throws(
    () =>
      parseMiningProfileQuery([
        {
          document: {
            name: "projects/mons-link/databases/(default)/documents/users/profile-1",
            fields: {},
          },
        },
      ]),
    FirestoreFailure,
  );
});

test("queries with the Firebase token and patches with one Google token", async () => {
  const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  let accessTokenCalls = 0;
  const repository = createMiningRepository(env, {
    getAccessToken: async () => {
      accessTokenCalls++;
      return "google-access-token";
    },
    fetcher: async (input, init) => {
      requests.push({ input, init });
      if (requests.length === 1) {
        return Response.json(queryResponse());
      }
      return Response.json({ updateTime: "2026-08-18T10:01:00Z" });
    },
  });

  const profile = await repository.getProfile(
    "firebase-uid",
    "firebase-id-token",
  );
  assert.ok(profile);
  assert.equal(
    await repository.updateMining(
      profile.profileId,
      {
        lastRockDate: "2026-08-18",
        materials: { dust: 5, slime: 3, gum: 2, metal: 1, ice: 0 },
      },
      profile.updateTime,
    ),
    "updated",
  );
  assert.equal(accessTokenCalls, 1);
  assert.equal(requests.length, 2);

  const queryRequest = requests[0];
  assert.equal(
    String(queryRequest.input),
    "https://firestore.googleapis.com/v1/projects/mons-link/databases/(default)/documents:runQuery",
  );
  assert.equal(queryRequest.init?.method, "POST");
  assert.equal(
    new Headers(queryRequest.init?.headers).get("Authorization"),
    "Bearer firebase-id-token",
  );
  assert.ok(queryRequest.init?.signal instanceof AbortSignal);
  assert.deepEqual(JSON.parse(String(queryRequest.init?.body)), {
    structuredQuery: {
      select: { fields: [{ fieldPath: "mining" }] },
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

  const patchRequest = requests[1];
  const patchUrl = new URL(String(patchRequest.input));
  assert.equal(
    patchUrl.pathname,
    "/v1/projects/mons-link/databases/(default)/documents/users/profile-1",
  );
  assert.deepEqual(patchUrl.searchParams.getAll("updateMask.fieldPaths"), [
    "mining.lastRockDate",
    "mining.materials",
  ]);
  assert.equal(
    patchUrl.searchParams.get("currentDocument.updateTime"),
    "2026-08-18T10:00:00.123456Z",
  );
  assert.equal(patchRequest.init?.method, "PATCH");
  assert.equal(
    new Headers(patchRequest.init?.headers).get("Authorization"),
    "Bearer google-access-token",
  );
  assert.ok(patchRequest.init?.signal instanceof AbortSignal);
  assert.deepEqual(JSON.parse(String(patchRequest.init?.body)), {
    fields: {
      mining: {
        mapValue: {
          fields: {
            lastRockDate: { stringValue: "2026-08-18" },
            materials: {
              mapValue: {
                fields: {
                  dust: { integerValue: "5" },
                  slime: { integerValue: "3" },
                  gum: { integerValue: "2" },
                  metal: { integerValue: "1" },
                  ice: { integerValue: "0" },
                },
              },
            },
          },
        },
      },
    },
  });
});

test("classifies update-time conflicts without exposing response details", async () => {
  for (const response of [
    new Response("private-conflict", { status: 412 }),
    Response.json(
      {
        error: {
          code: 400,
          message: "private-precondition-detail",
          status: "FAILED_PRECONDITION",
        },
      },
      { status: 400 },
    ),
    Response.json(
      {
        error: {
          code: 400,
          message: "private-aborted-detail",
          status: "ABORTED",
        },
      },
      { status: 400 },
    ),
  ]) {
    const repository = createMiningRepository(env, {
      getAccessToken: async () => "google-token",
      fetcher: async () => response,
    });
    assert.equal(
      await repository.updateMining(
        "profile-1",
        {
          lastRockDate: "2026-08-18",
          materials: { dust: 1, slime: 0, gum: 0, metal: 0, ice: 0 },
        },
        "2026-08-18T10:00:00Z",
      ),
      "conflict",
    );
  }
});

test("fails closed on malformed, oversized, rejected, and failed Firestore calls", async () => {
  const failingFetchers = [
    async () => new Response("private-error", { status: 403 }),
    async () =>
      new Response("[]", {
        status: 200,
        headers: { "Content-Length": String(64 * 1024 + 1) },
      }),
    async () => {
      throw new DOMException("private-timeout-detail", "TimeoutError");
    },
  ] as Array<typeof fetch>;
  for (const fetcher of failingFetchers) {
    const repository = createMiningRepository(env, { fetcher });
    await assert.rejects(
      repository.getProfile("firebase-uid", "firebase-token"),
      FirestoreFailure,
    );
  }

  const rejectedPatch = createMiningRepository(env, {
    getAccessToken: async () => "google-token",
    fetcher: async () =>
      Response.json(
        { error: { status: "PERMISSION_DENIED", message: "private" } },
        { status: 400 },
      ),
  });
  await assert.rejects(
    rejectedPatch.updateMining(
      "profile-1",
      {
        lastRockDate: "2026-08-18",
        materials: { dust: 1, slime: 0, gum: 0, metal: 0, ice: 0 },
      },
      "2026-08-18T10:00:00Z",
    ),
    FirestoreFailure,
  );
});
