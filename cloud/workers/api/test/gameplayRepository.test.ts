import assert from "node:assert/strict";
import test from "node:test";
import {
  createGameplayRepository,
  GameplayRepositoryFailure,
  MAX_FIRESTORE_BODY_BYTES,
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
