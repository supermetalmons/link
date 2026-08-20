import assert from "node:assert/strict";
import test from "node:test";
import {
  createGameplayRepository,
  GameplayRepositoryFailure,
  MAX_FIRESTORE_BODY_BYTES,
  parseAutomatchProfileQuery,
  parseMiningMaterialsDocument,
  parseNavigationGame,
  parseProfileQuery,
} from "../src/gameplayRepository.ts";
import type { FirebaseRtdbClient } from "../src/firebaseRtdb.ts";
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

function gameDocument(status: unknown = "waiting") {
  return {
    name: "projects/mons-link/databases/(default)/documents/users/profile-1/games/invite-1",
    updateTime: "2026-08-18T12:00:00.000000Z",
    fields: {
      status:
        typeof status === "string"
          ? { stringValue: status }
          : { integerValue: "1" },
    },
  };
}

test("parses only the profile and navigation fields used by gameplay", () => {
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
  assert.deepEqual(parseNavigationGame(gameDocument()), {
    status: "waiting",
    updateTime: "2026-08-18T12:00:00.000000Z",
  });
  assert.deepEqual(parseNavigationGame(gameDocument(1)), {
    status: null,
    updateTime: "2026-08-18T12:00:00.000000Z",
  });
  assert.throws(() => parseProfileQuery({}), GameplayRepositoryFailure);
  assert.throws(
    () => parseNavigationGame({ fields: {} }),
    GameplayRepositoryFailure,
  );
  assert.deepEqual(
    parseAutomatchProfileQuery([
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
    parseAutomatchProfileQuery([
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
    parseAutomatchProfileQuery([
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
    parseAutomatchProfileQuery([
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
  assert.equal(parseAutomatchProfileQuery([{ readTime: "now" }]), null);
  assert.throws(
    () => parseAutomatchProfileQuery({}),
    GameplayRepositoryFailure,
  );
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
    await repository.getAutomatchProfile("firebase-uid", "firebase-token"),
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

test("reads with the Firebase token and conditionally deletes with gameplay credentials", async () => {
  const requests: Array<{ input: string; init: RequestInit }> = [];
  const credentials: Array<{ email: string; privateKeyPem: string }> = [];
  const repository = createGameplayRepository(env, {
    rtdbClient,
    getAccessToken: async (_env, options) => {
      if (!options?.credentials) {
        assert.fail("missing gameplay credentials");
      }
      credentials.push(options.credentials);
      return "gameplay-access-token";
    },
    fetcher: async (input, init = {}) => {
      const url = String(input);
      requests.push({ input: url, init });
      if (url.endsWith(":runQuery")) {
        return jsonResponse([
          {
            document: {
              name: "projects/mons-link/databases/(default)/documents/users/profile-1",
              fields: { logins: { arrayValue: {} } },
            },
          },
        ]);
      }
      if (init.method === "DELETE") {
        return jsonResponse({});
      }
      return jsonResponse(gameDocument());
    },
  });

  assert.equal(
    await repository.findProfileId("firebase-uid", "firebase-token"),
    "profile-1",
  );
  assert.deepEqual(
    await repository.getNavigationGame(
      "profile-1",
      "invite-1",
      "firebase-token",
    ),
    {
      status: "waiting",
      updateTime: "2026-08-18T12:00:00.000000Z",
    },
  );
  assert.equal(
    await repository.deleteNavigationGame(
      "profile-1",
      "invite-1",
      "2026-08-18T12:00:00.000000Z",
    ),
    "deleted",
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
  assert.equal(
    new Headers(requests[1].init.headers).get("Authorization"),
    "Bearer firebase-token",
  );
  const deleteUrl = new URL(requests[2].input);
  assert.equal(
    deleteUrl.searchParams.get("currentDocument.updateTime"),
    "2026-08-18T12:00:00.000000Z",
  );
  assert.equal(
    new Headers(requests[2].init.headers).get("Authorization"),
    "Bearer gameplay-access-token",
  );
  assert.deepEqual(credentials, [
    {
      email: env.GAMEPLAY_SERVICE_ACCOUNT_EMAIL,
      privateKeyPem: env.GAMEPLAY_SERVICE_ACCOUNT_PRIVATE_KEY,
    },
  ]);
});

test("classifies missing and conflicting conditional deletes", async () => {
  const responses = [
    jsonResponse({}, 404),
    jsonResponse({}, 412),
    jsonResponse({ error: { status: "FAILED_PRECONDITION" } }, 400),
  ];
  const repository = createGameplayRepository(env, {
    rtdbClient,
    getAccessToken: async () => "token",
    fetcher: async () => responses.shift() as Response,
  });
  assert.equal(
    await repository.deleteNavigationGame("profile", "invite", "one"),
    "missing",
  );
  assert.equal(
    await repository.deleteNavigationGame("profile", "invite", "two"),
    "conflict",
  );
  assert.equal(
    await repository.deleteNavigationGame("profile", "invite", "three"),
    "conflict",
  );
});

test("fails closed on malformed, oversized, rejected, and unavailable responses", async () => {
  const fetchers: Array<typeof fetch> = [
    async () => jsonResponse({}, 503),
    async () =>
      new Response("{}", {
        headers: { "Content-Length": String(MAX_FIRESTORE_BODY_BYTES + 1) },
      }),
    async () => jsonResponse({ fields: {} }),
    async () => {
      throw new Error("private-network-detail");
    },
  ];
  for (const fetcher of fetchers) {
    const repository = createGameplayRepository(env, {
      rtdbClient,
      fetcher,
    });
    await assert.rejects(
      () => repository.getNavigationGame("profile", "invite", "firebase-token"),
      (error: unknown) =>
        error instanceof GameplayRepositoryFailure &&
        !error.message.includes("private"),
    );
  }
});
