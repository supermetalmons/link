import assert from "node:assert/strict";
import test from "node:test";
import type { GameplayRepository } from "../src/gameplayRepository.ts";
import {
  createRatingRepository,
  decodeFirestoreFields,
  encodeFirestoreFields,
  ratingProfileFromDocument,
  ratingUpdateFromDocument,
} from "../src/gameplayRepository.ts";
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

const firestoreRoot = "projects/mons-link/databases/(default)/documents";
const operationName = `${firestoreRoot}/ratingUpdates/auto_aaaaaaaaaaa__auto_aaaaaaaaaaa`;

function gameplayRepository(): GameplayRepository {
  return {
    applyWagerTransferOnce: async () => "applied",
    deleteNavigationGame: async () => "deleted",
    findProfileId: async () => null,
    getGameplayProfile: async () => null,
    getMiningMaterials: async () => ({
      dust: 0,
      slime: 0,
      gum: 0,
      metal: 0,
      ice: 0,
    }),
    getMiningSnapshot: async () => null,
    getNavigationGame: async () => null,
    getRtdbPath: async () => null,
    patchRtdbRoot: async () => undefined,
    transactRtdbPath: async () => ({ committed: false, value: null }),
  };
}

function document(name: string, fields: Record<string, unknown>) {
  return {
    name,
    fields: encodeFirestoreFields(fields),
    updateTime: "2026-08-21T00:00:00Z",
  };
}

function profileDocument(uid: string, profileId: string) {
  return document(`${firestoreRoot}/users/${profileId}`, {
    aura: "legacy-aura",
    custom: { aura: "custom-aura", emoji: 7 },
    eth: "0xabc",
    feb2026UniqueOpponents: ["old-opponent"],
    nonce: 4,
    rating: 1500,
    sol: "solana",
    totalManaPoints: uid === "player" ? 10 : 20,
    username: uid === "player" ? "Alice" : "Bob",
  });
}

function operationDocument(fields: Record<string, unknown> = {}) {
  return document(operationName, {
    inviteId: "auto_aaaaaaaaaaa",
    leaseExpiresAtMs: 30_000,
    matchId: "auto_aaaaaaaaaaa",
    opponentId: "opponent",
    opponentProfileId: "profile-opponent",
    ownerToken: "owner-token",
    playerId: "player",
    playerProfileId: "profile-player",
    shouldUpdateFebruaryChallenge: false,
    startedAtMs: 1_000,
    status: "processing",
    ...fields,
  });
}

test("encodes and decodes bounded Firestore rating values", () => {
  const value = {
    text: "rating",
    count: 4,
    ratio: 1.5,
    enabled: true,
    absent: null,
    items: ["a", "b"],
    nested: { score: 9 },
  };
  assert.deepEqual(decodeFirestoreFields(encodeFirestoreFields(value)), value);
  assert.deepEqual(
    ratingProfileFromDocument(profileDocument("player", "profile-player")),
    {
      aura: "custom-aura",
      emoji: 7,
      eth: "0xabc",
      feb2026UniqueOpponents: ["old-opponent"],
      nonce: 4,
      profileId: "profile-player",
      rating: 1500,
      sol: "solana",
      totalManaPoints: 10,
      username: "Alice",
    },
  );
  assert.equal(
    ratingUpdateFromDocument(operationDocument()).status,
    "processing",
  );
});

test("queries profiles with dedicated rating credentials", async () => {
  const credentials: Array<{ email: string; privateKeyPem: string }> = [];
  const calls: Array<{ input: string; init: RequestInit }> = [];
  const repository = createRatingRepository(env, gameplayRepository(), {
    getAccessToken: async (_env, options) => {
      assert.ok(options?.credentials);
      credentials.push(options.credentials);
      return "rating-access-token";
    },
    fetcher: async (input, init = {}) => {
      calls.push({ input: String(input), init });
      return new Response(
        JSON.stringify([
          { document: profileDocument("player", "profile-player") },
        ]),
        { status: 200 },
      );
    },
  });
  assert.equal(
    (await repository.getRatingProfile("player"))?.profileId,
    "profile-player",
  );
  assert.deepEqual(credentials, [
    {
      email: env.RATING_SERVICE_ACCOUNT_EMAIL,
      privateKeyPem: env.RATING_SERVICE_ACCOUNT_PRIVATE_KEY,
    },
  ]);
  assert.equal(
    new Headers(calls[0].init.headers).get("Authorization"),
    "Bearer rating-access-token",
  );
  const query = JSON.parse(String(calls[0].init.body));
  assert.equal(query.structuredQuery.where.fieldFilter.op, "ARRAY_CONTAINS");
  assert.deepEqual(
    query.structuredQuery.select.fields
      .map((field: { fieldPath: string }) => field.fieldPath)
      .filter((field: string) => field.startsWith("custom")),
    ["custom.aura", "custom.emoji"],
  );
});

test("masks February replay reads to the legacy challenge field", async () => {
  let sawMask = false;
  const repository = createRatingRepository(env, gameplayRepository(), {
    getAccessToken: async () => "token",
    fetcher: async (input, init = {}) => {
      const url = String(input);
      const body = init.body ? JSON.parse(String(init.body)) : {};
      if (url.endsWith(":beginTransaction")) {
        return Response.json({ transaction: "transaction-1" });
      }
      if (url.endsWith(":batchGet")) {
        assert.deepEqual(body.mask, {
          fieldPaths: ["feb2026UniqueOpponents"],
        });
        sawMask = true;
        return Response.json([
          {
            found: { name: `${firestoreRoot}/users/profile-player` },
          },
          {
            found: { name: `${firestoreRoot}/users/profile-opponent` },
          },
        ]);
      }
      if (url.endsWith(":commit")) {
        return Response.json({});
      }
      assert.fail(`unexpected request ${url}`);
    },
  });
  await repository.applyFebruaryChallengeReplay(
    "profile-player",
    "profile-opponent",
  );
  assert.equal(sawMask, true);
});

test("acquires the legacy-compatible lease in a Firestore transaction", async () => {
  const calls: Array<{ input: string; body: Record<string, unknown> }> = [];
  let currentTime = 1_000;
  const repository = createRatingRepository(env, gameplayRepository(), {
    getAccessToken: async () => "token",
    now: () => currentTime,
    fetcher: async (input, init = {}) => {
      const url = String(input);
      const body = init.body ? JSON.parse(String(init.body)) : {};
      calls.push({ input: url, body });
      if (url.endsWith(":beginTransaction")) {
        currentTime = 3_000;
        return Response.json({ transaction: "transaction-1" });
      }
      if (url.endsWith(":batchGet")) {
        currentTime = 5_000;
        return Response.json([{ missing: operationName }]);
      }
      if (url.endsWith(":commit")) {
        return Response.json({});
      }
      assert.fail(`unexpected request ${url}`);
    },
  });
  assert.deepEqual(
    await repository.tryAcquireRatingLease({
      inviteId: "auto_aaaaaaaaaaa",
      leaseMs: 30_000,
      matchId: "auto_aaaaaaaaaaa",
      opponentId: "opponent",
      ownerToken: "owner-token",
      ownerUid: "player",
      playerId: "player",
    }),
    { status: "acquired", data: null },
  );
  const commit = calls.find((call) => call.input.endsWith(":commit"));
  const writes = commit?.body.writes as Array<Record<string, unknown>>;
  const update = writes[0].update as Record<string, unknown>;
  assert.equal(update.name, operationName);
  assert.deepEqual(
    decodeFirestoreFields(update.fields as Record<string, unknown>),
    {
      inviteId: "auto_aaaaaaaaaaa",
      matchId: "auto_aaaaaaaaaaa",
      playerId: "player",
      opponentId: "opponent",
      ownerUid: "player",
      ownerToken: "owner-token",
      status: "processing",
      startedAtMs: 5_000,
      updatedAtMs: 5_000,
      leaseExpiresAtMs: 35_000,
    },
  );
});

test("keeps Firestore transaction resource names unencoded", async () => {
  const inviteId = "auto_ä";
  const matchId = "match ä";
  const name = `${firestoreRoot}/ratingUpdates/${inviteId}__${matchId}`;
  const repository = createRatingRepository(env, gameplayRepository(), {
    getAccessToken: async () => "token",
    now: () => 5_000,
    fetcher: async (input, init = {}) => {
      const url = String(input);
      const body = init.body ? JSON.parse(String(init.body)) : {};
      if (url.endsWith(":beginTransaction")) {
        return Response.json({ transaction: "transaction-1" });
      }
      if (url.endsWith(":batchGet")) {
        assert.deepEqual(body.documents, [name]);
        return Response.json([{ missing: name }]);
      }
      if (url.endsWith(":commit")) {
        assert.equal(body.writes[0].update.name, name);
        return Response.json({});
      }
      assert.fail(`unexpected request ${url}`);
    },
  });
  const result = await repository.tryAcquireRatingLease({
    inviteId,
    leaseMs: 30_000,
    matchId,
    opponentId: "opponent",
    ownerToken: "owner-token",
    ownerUid: "player",
    playerId: "player",
  });
  assert.equal(result.status, "acquired");
});

test("reconciles an ambiguous lease commit from its owner record", async () => {
  let commitAttempts = 0;
  const repository = createRatingRepository(env, gameplayRepository(), {
    getAccessToken: async () => "token",
    now: () => 5_000,
    fetcher: async (input) => {
      const url = String(input);
      if (url.endsWith(":beginTransaction")) {
        return Response.json({ transaction: "transaction-1" });
      }
      if (url.endsWith(":batchGet")) {
        return Response.json([{ missing: operationName }]);
      }
      if (url.endsWith(":commit")) {
        commitAttempts++;
        throw new Error("ambiguous-commit");
      }
      if (url.endsWith(":rollback")) {
        return Response.json({});
      }
      if (url.endsWith("/ratingUpdates/auto_aaaaaaaaaaa__auto_aaaaaaaaaaa")) {
        return Response.json(operationDocument());
      }
      assert.fail(`unexpected request ${url}`);
    },
  });
  const result = await repository.tryAcquireRatingLease({
    inviteId: "auto_aaaaaaaaaaa",
    leaseMs: 30_000,
    matchId: "auto_aaaaaaaaaaa",
    opponentId: "opponent",
    ownerToken: "owner-token",
    ownerUid: "player",
    playerId: "player",
  });
  assert.equal(commitAttempts, 1);
  assert.equal(result.status, "acquired");
});

test("takes over an expired lease", async () => {
  const commits: Array<Record<string, unknown>> = [];
  const repository = createRatingRepository(env, gameplayRepository(), {
    getAccessToken: async () => "token",
    now: () => 5_000,
    fetcher: async (input, init = {}) => {
      const url = String(input);
      const body = init.body ? JSON.parse(String(init.body)) : {};
      if (url.endsWith(":beginTransaction")) {
        return Response.json({ transaction: "transaction-1" });
      }
      if (url.endsWith(":batchGet")) {
        return Response.json([
          {
            found: operationDocument({
              leaseExpiresAtMs: 4_000,
              ownerToken: "expired-owner",
            }),
          },
        ]);
      }
      if (url.endsWith(":commit")) {
        commits.push(body);
        return Response.json({});
      }
      assert.fail(`unexpected request ${url}`);
    },
  });
  assert.equal(
    (
      await repository.tryAcquireRatingLease({
        inviteId: "auto_aaaaaaaaaaa",
        leaseMs: 30_000,
        matchId: "auto_aaaaaaaaaaa",
        opponentId: "opponent",
        ownerToken: "owner-token",
        ownerUid: "player",
        playerId: "player",
      })
    ).status,
    "acquired",
  );
  assert.equal(commits.length, 1);
});

test("refreshes lease time after transaction conflicts", async () => {
  let transactionCount = 0;
  let commitCount = 0;
  const times = [5_000, 7_000];
  const repository = createRatingRepository(env, gameplayRepository(), {
    getAccessToken: async () => "token",
    now: () => times.shift() ?? 7_000,
    fetcher: async (input, init = {}) => {
      const url = String(input);
      const body = init.body ? JSON.parse(String(init.body)) : {};
      if (url.endsWith(":beginTransaction")) {
        transactionCount++;
        return Response.json({
          transaction: `transaction-${transactionCount}`,
        });
      }
      if (url.endsWith(":batchGet")) {
        return transactionCount === 1
          ? Response.json([{ missing: operationName }])
          : Response.json([
              {
                found: operationDocument({
                  leaseExpiresAtMs: 6_000,
                  ownerToken: "expired-owner",
                }),
              },
            ]);
      }
      if (url.endsWith(":commit")) {
        commitCount++;
        if (commitCount === 1) {
          return Response.json({}, { status: 409 });
        }
        const fields = body.writes[0].update.fields;
        assert.equal(decodeFirestoreFields(fields).updatedAtMs, 7_000);
        assert.equal(decodeFirestoreFields(fields).leaseExpiresAtMs, 37_000);
        return Response.json({});
      }
      assert.fail(`unexpected request ${url}`);
    },
  });
  const result = await repository.tryAcquireRatingLease({
    inviteId: "auto_aaaaaaaaaaa",
    leaseMs: 30_000,
    matchId: "auto_aaaaaaaaaaa",
    opponentId: "opponent",
    ownerToken: "owner-token",
    ownerUid: "player",
    playerId: "player",
  });
  assert.equal(result.status, "acquired");
  assert.equal(transactionCount, 2);
  assert.equal(commitCount, 2);
});

test("finalizes both profiles and the projector record atomically", async () => {
  const commits: Array<Record<string, unknown>> = [];
  const repository = createRatingRepository(env, gameplayRepository(), {
    getAccessToken: async () => "token",
    fetcher: async (input, init = {}) => {
      const url = String(input);
      const body = init.body ? JSON.parse(String(init.body)) : {};
      if (url.endsWith(":beginTransaction")) {
        return Response.json({ transaction: "transaction-1" });
      }
      if (url.endsWith(":batchGet")) {
        return Response.json([{ found: operationDocument() }]);
      }
      if (url.endsWith(":runQuery")) {
        const uid = body.structuredQuery.where.fieldFilter.value.stringValue;
        return Response.json([
          {
            document: profileDocument(
              uid,
              uid === "player" ? "profile-player" : "profile-opponent",
            ),
          },
        ]);
      }
      if (url.endsWith(":commit")) {
        commits.push(body);
        return Response.json({});
      }
      assert.fail(`unexpected request ${url}`);
    },
  });
  assert.deepEqual(
    await repository.finalizeRatingUpdate(
      {
        inviteId: "auto_aaaaaaaaaaa",
        matchId: "auto_aaaaaaaaaaa",
        operationId: "auto_aaaaaaaaaaa__auto_aaaaaaaaaaa",
        opponentId: "opponent",
        ownerToken: "owner-token",
        playerId: "player",
      },
      (player, opponent) => {
        assert.equal(player?.profileId, "profile-player");
        assert.equal(opponent?.profileId, "profile-opponent");
        return {
          playerUpdate: { rating: 1510, nonce: 5 },
          opponentUpdate: { rating: 1390, nonce: 5 },
          repairData: {
            playerProfileId: "profile-player",
            opponentProfileId: "profile-opponent",
            shouldUpdateFebruaryChallenge: false,
          },
          ratingUpdate: { status: "done", result: "win" },
        };
      },
    ),
    {
      status: "committed",
      data: {
        playerProfileId: "profile-player",
        opponentProfileId: "profile-opponent",
        shouldUpdateFebruaryChallenge: false,
      },
    },
  );
  const writes = commits[0].writes as Array<Record<string, unknown>>;
  assert.equal(writes.length, 3);
  const ratingWrite = writes[2].update as Record<string, unknown>;
  assert.equal(ratingWrite.name, operationName);
  assert.deepEqual(
    decodeFirestoreFields(ratingWrite.fields as Record<string, unknown>),
    { status: "done", result: "win" },
  );
});

test("retries structured Firestore transaction conflicts", async () => {
  let transactionCount = 0;
  let commitCount = 0;
  const repository = createRatingRepository(env, gameplayRepository(), {
    getAccessToken: async () => "token",
    fetcher: async (input, init = {}) => {
      const url = String(input);
      const body = init.body ? JSON.parse(String(init.body)) : {};
      if (url.endsWith(":beginTransaction")) {
        transactionCount++;
        if (transactionCount === 2) {
          assert.equal(
            body.options.readWrite.retryTransaction,
            "transaction-1",
          );
        }
        return Response.json({
          transaction: `transaction-${transactionCount}`,
        });
      }
      if (url.endsWith(":batchGet")) {
        return Response.json([{ found: operationDocument() }]);
      }
      if (url.endsWith(":runQuery")) {
        const uid = body.structuredQuery.where.fieldFilter.value.stringValue;
        return Response.json([
          {
            document: profileDocument(
              uid,
              uid === "player" ? "profile-player" : "profile-opponent",
            ),
          },
        ]);
      }
      if (url.endsWith(":commit")) {
        commitCount++;
        return commitCount === 1
          ? Response.json(
              { error: { status: "FAILED_PRECONDITION" } },
              { status: 400 },
            )
          : Response.json({});
      }
      assert.fail(`unexpected request ${url}`);
    },
  });
  const result = await repository.finalizeRatingUpdate(
    {
      inviteId: "auto_aaaaaaaaaaa",
      matchId: "auto_aaaaaaaaaaa",
      operationId: "auto_aaaaaaaaaaa__auto_aaaaaaaaaaa",
      opponentId: "opponent",
      ownerToken: "owner-token",
      playerId: "player",
    },
    () => ({
      playerUpdate: null,
      opponentUpdate: null,
      repairData: {
        playerProfileId: "profile-player",
        opponentProfileId: "profile-opponent",
        shouldUpdateFebruaryChallenge: false,
      },
      ratingUpdate: { status: "done" },
    }),
  );
  assert.equal(result.status, "committed");
  assert.equal(transactionCount, 2);
  assert.equal(commitCount, 2);
});

test("reconciles an ambiguous final commit from the completed record", async () => {
  let commitAttempts = 0;
  const repository = createRatingRepository(env, gameplayRepository(), {
    getAccessToken: async () => "token",
    fetcher: async (input, init = {}) => {
      const url = String(input);
      const body = init.body ? JSON.parse(String(init.body)) : {};
      if (url.endsWith(":beginTransaction")) {
        return Response.json({ transaction: "transaction-1" });
      }
      if (url.endsWith(":batchGet")) {
        return Response.json([{ found: operationDocument() }]);
      }
      if (url.endsWith(":runQuery")) {
        const uid = body.structuredQuery.where.fieldFilter.value.stringValue;
        return Response.json([
          {
            document: profileDocument(
              uid,
              uid === "player" ? "profile-player" : "profile-opponent",
            ),
          },
        ]);
      }
      if (url.endsWith(":commit")) {
        commitAttempts++;
        throw new Error("ambiguous-commit");
      }
      if (url.endsWith(":rollback")) {
        return Response.json({});
      }
      if (url.endsWith("/ratingUpdates/auto_aaaaaaaaaaa__auto_aaaaaaaaaaa")) {
        return Response.json(operationDocument({ status: "done" }));
      }
      assert.fail(`unexpected request ${url}`);
    },
  });
  const result = await repository.finalizeRatingUpdate(
    {
      inviteId: "auto_aaaaaaaaaaa",
      matchId: "auto_aaaaaaaaaaa",
      operationId: "auto_aaaaaaaaaaa__auto_aaaaaaaaaaa",
      opponentId: "opponent",
      ownerToken: "owner-token",
      playerId: "player",
    },
    () => ({
      playerUpdate: null,
      opponentUpdate: null,
      repairData: {
        playerProfileId: "profile-player",
        opponentProfileId: "profile-opponent",
        shouldUpdateFebruaryChallenge: false,
      },
      ratingUpdate: { status: "done" },
    }),
  );
  assert.equal(commitAttempts, 1);
  assert.equal(result.status, "replayed");
});

test("lists, claims, and completes pending event rating progress", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const repository = createRatingRepository(env, gameplayRepository(), {
    getAccessToken: async () => "token",
    fetcher: async (input, init = {}) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith(":runQuery")) {
        const body = JSON.parse(String(init.body));
        assert.deepEqual(body.structuredQuery.select, {
          fields: [
            { fieldPath: "eventProgressUpdatedAtMs" },
            { fieldPath: "eventProgressVersion" },
            { fieldPath: "eventId" },
            { fieldPath: "inviteId" },
            { fieldPath: "matchId" },
          ],
        });
        assert.deepEqual(body.structuredQuery.where, {
          compositeFilter: {
            op: "AND",
            filters: [
              {
                fieldFilter: {
                  field: { fieldPath: "eventProgressState" },
                  op: "EQUAL",
                  value: { stringValue: "pending" },
                },
              },
              {
                fieldFilter: {
                  field: { fieldPath: "eventProgressUpdatedAtMs" },
                  op: "LESS_THAN_OR_EQUAL",
                  value: { integerValue: "200" },
                },
              },
            ],
          },
        });
        assert.deepEqual(body.structuredQuery.orderBy, [
          {
            field: { fieldPath: "eventProgressUpdatedAtMs" },
            direction: "ASCENDING",
          },
        ]);
        assert.equal(body.structuredQuery.limit, 10);
        return Response.json([
          {
            document: document(operationName, {
              eventId: "event-1",
              eventProgressUpdatedAtMs: 200,
              eventProgressVersion: 1,
              inviteId: "auto_aaaaaaaaaaa",
              matchId: "auto_aaaaaaaaaaa",
            }),
          },
        ]);
      }
      if (url.includes("/ratingUpdates/auto_aaaaaaaaaaa__auto_aaaaaaaaaaa?")) {
        assert.equal(init.method, "PATCH");
        const parsed = new URL(url);
        if (parsed.searchParams.has("currentDocument.updateTime")) {
          assert.deepEqual(
            parsed.searchParams.getAll("updateMask.fieldPaths"),
            ["eventProgressUpdatedAtMs"],
          );
          assert.equal(
            parsed.searchParams.get("currentDocument.updateTime"),
            "2026-08-21T00:00:00Z",
          );
          assert.deepEqual(
            decodeFirestoreFields(JSON.parse(String(init.body)).fields),
            { eventProgressUpdatedAtMs: 250 },
          );
          return Response.json({});
        }
        assert.deepEqual(parsed.searchParams.getAll("updateMask.fieldPaths"), [
          "eventProgressState",
          "eventProgressUpdatedAtMs",
          "eventProgressReason",
        ]);
        assert.equal(parsed.searchParams.get("currentDocument.exists"), "true");
        assert.deepEqual(
          decodeFirestoreFields(JSON.parse(String(init.body)).fields),
          {
            eventProgressState: "done",
            eventProgressUpdatedAtMs: 300,
            eventProgressReason: null,
          },
        );
        return Response.json({});
      }
      assert.fail(`unexpected request ${url}`);
    },
  });
  const pending = await repository.listDueRatingEventProgress(200, 10);
  assert.deepEqual(pending, [
    {
      eventId: "event-1",
      inviteId: "auto_aaaaaaaaaaa",
      matchId: "auto_aaaaaaaaaaa",
      operationId: "auto_aaaaaaaaaaa__auto_aaaaaaaaaaa",
      updateTime: "2026-08-21T00:00:00Z",
      version: 1,
    },
  ]);
  assert.equal(
    await repository.claimRatingEventProgress(
      pending[0].operationId,
      pending[0].updateTime,
      250,
    ),
    true,
  );
  await repository.markRatingEventProgress(pending[0].operationId, "done", 300);
  assert.equal(calls.length, 3);
});

test("lists, claims, and completes pending profile game projections", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const repository = createRatingRepository(env, gameplayRepository(), {
    getAccessToken: async () => "token",
    fetcher: async (input, init = {}) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith(":runQuery")) {
        const body = JSON.parse(String(init.body));
        assert.deepEqual(body.structuredQuery.select, {
          fields: [
            { fieldPath: "profileGameProjectionUpdatedAtMs" },
            { fieldPath: "profileGameProjectionVersion" },
            { fieldPath: "inviteId" },
            { fieldPath: "matchId" },
          ],
        });
        assert.deepEqual(body.structuredQuery.where, {
          compositeFilter: {
            op: "AND",
            filters: [
              {
                fieldFilter: {
                  field: { fieldPath: "profileGameProjectionState" },
                  op: "EQUAL",
                  value: { stringValue: "pending" },
                },
              },
              {
                fieldFilter: {
                  field: { fieldPath: "profileGameProjectionUpdatedAtMs" },
                  op: "LESS_THAN_OR_EQUAL",
                  value: { integerValue: "200" },
                },
              },
            ],
          },
        });
        assert.deepEqual(body.structuredQuery.orderBy, [
          {
            field: { fieldPath: "profileGameProjectionUpdatedAtMs" },
            direction: "ASCENDING",
          },
        ]);
        return Response.json([
          {
            document: document(operationName, {
              inviteId: "auto_aaaaaaaaaaa",
              matchId: "auto_aaaaaaaaaaa",
              profileGameProjectionUpdatedAtMs: 200,
              profileGameProjectionVersion: 1,
            }),
          },
        ]);
      }
      if (url.includes("/ratingUpdates/auto_aaaaaaaaaaa__auto_aaaaaaaaaaa?")) {
        const parsed = new URL(url);
        if (parsed.searchParams.has("currentDocument.updateTime")) {
          assert.deepEqual(
            parsed.searchParams.getAll("updateMask.fieldPaths"),
            ["profileGameProjectionUpdatedAtMs"],
          );
          assert.deepEqual(
            decodeFirestoreFields(JSON.parse(String(init.body)).fields),
            { profileGameProjectionUpdatedAtMs: 250 },
          );
          return Response.json({});
        }
        assert.deepEqual(parsed.searchParams.getAll("updateMask.fieldPaths"), [
          "profileGameProjectionState",
          "profileGameProjectionUpdatedAtMs",
          "profileGameProjectionReason",
        ]);
        assert.deepEqual(
          decodeFirestoreFields(JSON.parse(String(init.body)).fields),
          {
            profileGameProjectionState: "done",
            profileGameProjectionUpdatedAtMs: 300,
            profileGameProjectionReason: null,
          },
        );
        return Response.json({});
      }
      assert.fail(`unexpected request ${url}`);
    },
  });
  const pending = await repository.listDueRatingProfileGameProjections(200, 10);
  assert.deepEqual(pending, [
    {
      inviteId: "auto_aaaaaaaaaaa",
      matchId: "auto_aaaaaaaaaaa",
      operationId: "auto_aaaaaaaaaaa__auto_aaaaaaaaaaa",
      updateTime: "2026-08-21T00:00:00Z",
      version: 1,
    },
  ]);
  assert.equal(
    await repository.claimRatingProfileGameProjection(
      pending[0].operationId,
      pending[0].updateTime,
      250,
    ),
    true,
  );
  await repository.markRatingProfileGameProjection(
    pending[0].operationId,
    "done",
    300,
  );
  assert.equal(calls.length, 3);
});

test("lists and completes pending Telegram rating projections", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const repository = createRatingRepository(env, gameplayRepository(), {
    getAccessToken: async () => "token",
    fetcher: async (input, init = {}) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith(":runQuery")) {
        const body = JSON.parse(String(init.body));
        assert.deepEqual(body.structuredQuery.select, {
          fields: [{ fieldPath: "telegramProjectionUpdatedAtMs" }],
        });
        assert.deepEqual(body.structuredQuery.where, {
          compositeFilter: {
            op: "AND",
            filters: [
              {
                fieldFilter: {
                  field: { fieldPath: "telegramProjectionState" },
                  op: "EQUAL",
                  value: { stringValue: "pending" },
                },
              },
              {
                fieldFilter: {
                  field: { fieldPath: "telegramProjectionUpdatedAtMs" },
                  op: "LESS_THAN_OR_EQUAL",
                  value: { integerValue: "200" },
                },
              },
            ],
          },
        });
        assert.deepEqual(body.structuredQuery.orderBy, [
          {
            field: { fieldPath: "telegramProjectionUpdatedAtMs" },
            direction: "ASCENDING",
          },
        ]);
        assert.equal(body.structuredQuery.limit, 10);
        return Response.json([
          {
            document: document(operationName, {
              telegramProjectionUpdatedAtMs: 200,
            }),
          },
        ]);
      }
      if (url.includes("/ratingUpdates/auto_aaaaaaaaaaa__auto_aaaaaaaaaaa?")) {
        assert.equal(init.method, "PATCH");
        const parsed = new URL(url);
        if (parsed.searchParams.has("currentDocument.updateTime")) {
          assert.deepEqual(
            parsed.searchParams.getAll("updateMask.fieldPaths"),
            ["telegramProjectionUpdatedAtMs"],
          );
          assert.equal(
            parsed.searchParams.get("currentDocument.updateTime"),
            "2026-08-21T00:00:00Z",
          );
          assert.deepEqual(
            decodeFirestoreFields(JSON.parse(String(init.body)).fields),
            { telegramProjectionUpdatedAtMs: 250 },
          );
          return Response.json({});
        }
        assert.deepEqual(parsed.searchParams.getAll("updateMask.fieldPaths"), [
          "telegramProjectionState",
          "telegramProjectionUpdatedAtMs",
          "telegramProjectionReason",
        ]);
        assert.equal(parsed.searchParams.get("currentDocument.exists"), "true");
        assert.deepEqual(
          decodeFirestoreFields(JSON.parse(String(init.body)).fields),
          {
            telegramProjectionState: "done",
            telegramProjectionUpdatedAtMs: 300,
            telegramProjectionReason: null,
          },
        );
        return Response.json({});
      }
      assert.fail(`unexpected request ${url}`);
    },
  });
  const pending = await repository.listDueRatingTelegramProjections(200, 10);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].operationId, "auto_aaaaaaaaaaa__auto_aaaaaaaaaaa");
  assert.equal(pending[0].updateTime, "2026-08-21T00:00:00Z");
  assert.equal(
    await repository.claimRatingTelegramProjection(
      pending[0].operationId,
      pending[0].updateTime,
      250,
    ),
    true,
  );
  await repository.markRatingTelegramProjection(
    pending[0].operationId,
    "done",
    300,
  );
  assert.equal(calls.length, 3);
});
