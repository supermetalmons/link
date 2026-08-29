import { env } from "cloudflare:workers";
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { CompletePlayerProfile } from "@mons/shared/profiles";
import type { FirebaseRtdbClient } from "../src/firebaseRtdb.ts";
import {
  canonicalProfileFields,
  createCanonicalRatingRepository,
} from "../src/gameplayCanonicalRepository.ts";
import {
  createGameplayRepository,
  createRatingRepository,
} from "../src/gameplayRepository.ts";
import {
  commitCanonicalPlan,
  materializeCanonicalProfile,
  readCanonicalLoginOwner,
  readCanonicalProfile,
} from "../src/profileCanonicalD1.ts";
import { createProfileEventPrizeOwnerResolver } from "../src/profileEventPrizeOwner.ts";
import { createProfileGameProjectionRuntime } from "../src/profileGameProjectionRepository.ts";
import { getProfileGameProjection } from "../src/profileGamesD1.ts";

const testEnv = env as Env & {
  TEST_D1_MIGRATIONS: D1Migration[];
  TEST_PROFILE_D1_MIGRATIONS: D1Migration[];
};

const rtdbValues = new Map<string, unknown>();
const rtdb: FirebaseRtdbClient = {
  getPath: async (path) => rtdbValues.get(path) ?? null,
  patchRoot: async (updates) => {
    for (const [path, value] of Object.entries(updates)) {
      if (value === null) rtdbValues.delete(path);
      else rtdbValues.set(path, value);
    }
  },
  transactPath: async (path, update) => {
    const current = rtdbValues.get(path) ?? null;
    const result = update(current);
    const resultRecord =
      result && typeof result === "object" && !Array.isArray(result)
        ? (result as Record<string, unknown>)
        : {};
    if (Object.hasOwn(resultRecord, "value")) {
      rtdbValues.set(path, resultRecord.value);
      return { committed: true, value: resultRecord.value };
    }
    return {
      committed: false,
      value: current,
      ...(typeof resultRecord.decision === "string"
        ? { decision: resultRecord.decision }
        : {}),
    };
  },
};

function failAfterFirstWrite(database: D1Database): D1Database {
  let shouldFail = true;
  return {
    prepare: (query) => database.prepare(query),
    async batch<T = unknown>(statements: D1PreparedStatement[]) {
      const results = await database.batch<T>(statements);
      if (
        shouldFail &&
        results.some(
          (result) => result.meta.changed_db || result.meta.changes > 0,
        )
      ) {
        shouldFail = false;
        throw new Error("ambiguous-d1-response");
      }
      return results;
    },
    dump: () => database.dump(),
    exec: (query) => database.exec(query),
    withSession: (constraintOrBookmark) =>
      database.withSession(constraintOrBookmark),
  };
}

function beforeMatchingBatch(
  database: D1Database,
  matches: (queries: readonly string[]) => boolean,
  action: () => Promise<void>,
): D1Database {
  const nativeStatements = new WeakMap<object, D1PreparedStatement>();
  const statementQueries = new WeakMap<object, string>();
  let fired = false;
  const wrap = (
    statement: D1PreparedStatement,
    query: string,
  ): D1PreparedStatement => {
    const wrapped = new Proxy(statement, {
      get(target, property) {
        if (property === "bind") {
          return (...values: unknown[]) => wrap(target.bind(...values), query);
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    nativeStatements.set(wrapped, statement);
    statementQueries.set(wrapped, query);
    return wrapped;
  };
  return {
    prepare: (query) => wrap(database.prepare(query), query),
    async batch<T = unknown>(statements: D1PreparedStatement[]) {
      const queries = statements.map(
        (statement) => statementQueries.get(statement) || "",
      );
      if (!fired && matches(queries)) {
        fired = true;
        await action();
      }
      return database.batch<T>(
        statements.map(
          (statement) => nativeStatements.get(statement) || statement,
        ),
      );
    },
    dump: () => database.dump(),
    exec: (query) => database.exec(query),
    withSession: (constraintOrBookmark) =>
      database.withSession(constraintOrBookmark),
  };
}

function profile(
  id: string,
  overrides: Partial<CompletePlayerProfile> = {},
): CompletePlayerProfile {
  return {
    id,
    nonce: 1,
    rating: 1500,
    totalManaPoints: 5,
    win: true,
    emoji: 2,
    username: `${id}Name`,
    eth: null,
    sol: null,
    feb2026UniqueOpponentsCount: 0,
    mining: {
      lastRockDate: "2026-08-28",
      materials: { dust: 10, slime: 2, gum: 3, metal: 4, ice: 5 },
    },
    ...overrides,
  };
}

async function insertProfile(
  id: string,
  loginUid: string | null,
  overrides: Partial<CompletePlayerProfile> = {},
  sortPresence?: Parameters<
    typeof materializeCanonicalProfile
  >[0]["sortPresence"],
  winPresent = true,
  emojiPresent = true,
  gameplayEmoji?: string | number,
) {
  const completeProfile = profile(id, overrides);
  const value = materializeCanonicalProfile({
    profile: completeProfile,
    createdAtMs: 1_000,
    updatedAtMs: 1_000,
    sortPresence,
    winPresent,
    emojiPresent,
    gameplayEmoji: gameplayEmoji ?? completeProfile.emoji,
  });
  await commitCanonicalPlan(testEnv.PROFILE_DB, {
    expectations: [
      { kind: "profile-absent", profileId: id },
      ...(loginUid ? [{ kind: "login-owner-absent" as const, loginUid }] : []),
    ],
    mutations: [
      { kind: "insert-active-profile", value },
      ...(loginUid
        ? [
            {
              kind: "insert-login-owner" as const,
              value: {
                loginUid,
                profileId: id,
                createdAtMs: 1_000,
                updatedAtMs: 1_000,
              },
            },
          ]
        : []),
    ],
  });
}

async function resetCanonicalRows(db: D1Database): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM rating_updates"),
    db.prepare("DELETE FROM profile_auth_operations"),
    db.prepare("DELETE FROM profile_auth_method_revocations"),
    db.prepare("DELETE FROM profile_auth_method_cooldowns"),
    db.prepare("DROP TRIGGER profile_merge_targets_reject_delete"),
    db.prepare("DROP TRIGGER wager_settlements_reject_delete"),
    db.prepare("DROP TRIGGER profile_records_reject_active_delete"),
    db.prepare("DELETE FROM profile_merge_targets"),
    db.prepare("DELETE FROM wager_settlements"),
    db.prepare("DELETE FROM profile_records"),
    db.prepare(
      `CREATE TRIGGER profile_merge_targets_reject_delete
       BEFORE DELETE ON profile_merge_targets
       BEGIN
         SELECT RAISE(ABORT, 'profile merge mappings are permanent');
       END`,
    ),
    db.prepare(
      `CREATE TRIGGER wager_settlements_reject_delete
       BEFORE DELETE ON wager_settlements
       BEGIN
         SELECT RAISE(ABORT, 'wager settlements are permanent');
       END`,
    ),
    db.prepare(
      `CREATE TRIGGER profile_records_reject_active_delete
       BEFORE DELETE ON profile_records
       WHEN OLD.state = 'active'
       AND (
         SELECT state FROM profile_canonical_control WHERE singleton = 1
       ) != 'importing'
       BEGIN
         SELECT RAISE(ABORT, 'active profiles cannot be deleted');
       END`,
    ),
  ]);
}

describe("canonical gameplay repositories", () => {
  beforeAll(async () => {
    await applyD1Migrations(
      testEnv.PROFILE_DB,
      testEnv.TEST_PROFILE_D1_MIGRATIONS,
    );
    const importDigest = "c".repeat(64);
    await testEnv.PROFILE_DB.batch([
      testEnv.PROFILE_DB.prepare(
        `UPDATE profile_canonical_control
         SET state = 'importing'
         WHERE singleton = 1 AND state = 'firestore'`,
      ),
      testEnv.PROFILE_DB.prepare(
        `UPDATE profile_canonical_control
         SET import_digest = ?, import_plan_version = 1
         WHERE singleton = 1 AND state = 'importing'`,
      ).bind(importDigest),
      testEnv.PROFILE_DB.prepare(
        `UPDATE profile_canonical_control
         SET state = 'frozen', imported_at_ms = 1
         WHERE singleton = 1 AND state = 'importing'`,
      ),
      testEnv.PROFILE_DB.prepare(
        `UPDATE profile_canonical_control
         SET state = 'active'
         WHERE singleton = 1 AND state = 'frozen'`,
      ),
    ]);
    await applyD1Migrations(
      testEnv.PROFILE_GAMES_DB,
      testEnv.TEST_D1_MIGRATIONS,
    );
  });

  beforeEach(async () => {
    await resetCanonicalRows(testEnv.PROFILE_DB);
  });

  it("selects canonical gameplay reads and atomically settles wagers", async () => {
    await insertProfile(
      "d1-game-winner",
      "d1-game-login-winner",
      {
        mining: {
          lastRockDate: "2026-08-28",
          materials: { dust: 0, slime: 0, gum: 0, metal: 0, ice: 0 },
        },
      },
      {
        rating: true,
        mp: true,
        dust: false,
        slime: false,
        gum: false,
        metal: false,
        ice: false,
      },
    );
    await insertProfile(
      "d1-game-loser",
      "d1-game-login-loser",
      {},
      {
        rating: true,
        mp: true,
        dust: true,
        slime: false,
        gum: false,
        metal: false,
        ice: false,
      },
    );
    await insertProfile("d1-game-source", null, { username: null });
    await commitCanonicalPlan(testEnv.PROFILE_DB, {
      expectations: [
        {
          kind: "profile-revision",
          profileId: "d1-game-source",
          revision: 1,
        },
        {
          kind: "profile-revision",
          profileId: "d1-game-winner",
          revision: 1,
        },
        { kind: "merge-target-absent", sourceProfileId: "d1-game-source" },
      ],
      mutations: [
        {
          kind: "retire-profile-with-redirect",
          profile: materializeCanonicalProfile({
            profile: profile("d1-game-source", { username: null }),
            state: "retiring",
            mergedIntoProfileId: "d1-game-winner",
            mergedAtMs: 2_000,
            createdAtMs: 1_000,
            updatedAtMs: 2_000,
          }),
          redirect: {
            sourceProfileId: "d1-game-source",
            targetProfileId: "d1-game-winner",
            mergedAtMs: 2_000,
            opId: "d1-game-merge",
            sourceLegacyFields: {},
          },
        },
      ],
    });
    let projectionCallbacks = 0;
    const repository = createGameplayRepository(testEnv, {
      rtdbClient: rtdb,
      storageMode: "d1",
      projectionCommitted: () => {
        projectionCallbacks++;
      },
    });
    expect(
      (await repository.getGameplayProfile("d1-game-login-winner", "unused"))
        ?.profileId,
    ).toBe("d1-game-winner");
    expect(
      await repository.findProfileId("d1-game-login-loser", "unused"),
    ).toBe("d1-game-loser");

    const transfer = {
      operationId: "d1-game-wager",
      fingerprint: "d1-game-fingerprint",
      winnerProfileId: "d1-game-source",
      loserProfileId: "d1-game-loser",
      material: "dust" as const,
      count: 3,
      appliedAtMs: 3_000,
    };
    await expect(repository.applyWagerTransferOnce(transfer)).resolves.toBe(
      "applied",
    );
    await expect(repository.applyWagerTransferOnce(transfer)).resolves.toBe(
      "replayed",
    );
    await expect(
      repository.applyWagerTransferOnce({
        ...transfer,
        fingerprint: "d1-game-mismatch",
      }),
    ).rejects.toThrow("gameplay-repository-unavailable");
    const storedWinner = await readCanonicalProfile(
      testEnv.PROFILE_DB,
      "d1-game-winner",
    );
    expect(storedWinner?.profile.mining.materials.dust).toBe(3);
    expect(storedWinner?.sortPresence).toMatchObject({
      dust: true,
      slime: false,
      gum: false,
      metal: false,
      ice: false,
    });
    expect(
      (await readCanonicalProfile(testEnv.PROFILE_DB, "d1-game-loser"))?.profile
        .mining.materials.dust,
    ).toBe(7);
    expect(projectionCallbacks).toBe(0);
  });

  it("preserves raw gameplay emoji, rating zero, and null nonce semantics", async () => {
    const profileId = "d1-raw-gameplay-profile";
    const loginUid = "d1-raw-gameplay-login";
    const value = materializeCanonicalProfile({
      profile: profile(profileId, { emoji: 77, nonce: -1, rating: 1500 }),
      createdAtMs: 1_000,
      updatedAtMs: 1_000,
      emojiPresent: false,
      gameplayEmoji: "",
      sortPresence: { rating: true, nonce: true },
      sortValues: { rating: 0, nonce: null },
    });
    await commitCanonicalPlan(testEnv.PROFILE_DB, {
      expectations: [
        { kind: "profile-absent", profileId },
        { kind: "login-owner-absent", loginUid },
      ],
      mutations: [
        { kind: "insert-active-profile", value },
        {
          kind: "insert-login-owner",
          value: {
            loginUid,
            profileId,
            createdAtMs: 1_000,
            updatedAtMs: 1_000,
          },
        },
      ],
    });
    await expect(
      readCanonicalProfile(testEnv.PROFILE_DB, profileId),
    ).resolves.toMatchObject({
      profile: { rating: 1500 },
      sortValues: { rating: 0 },
    });
    const gameplay = createGameplayRepository(testEnv, {
      rtdbClient: rtdb,
      storageMode: "d1",
    });
    const rating = createRatingRepository(testEnv, gameplay, {
      storageMode: "d1",
    });
    await expect(
      gameplay.getGameplayProfile(loginUid, "unused"),
    ).resolves.toMatchObject({
      emoji: "",
      rating: 0,
    });
    await expect(rating.getRatingProfile(loginUid)).resolves.toMatchObject({
      emoji: "",
      nonce: 0,
      rating: 0,
    });
  });

  it("leases and atomically finalizes ratings with all pending projections", async () => {
    await insertProfile(
      "d1-rating-player",
      "d1-rating-login-player",
      {},
      { nonce: false },
      false,
    );
    await insertProfile(
      "d1-rating-opponent",
      "d1-rating-login-opponent",
      {},
      { nonce: false },
      false,
    );
    const gameplay = createGameplayRepository(testEnv, {
      rtdbClient: rtdb,
      storageMode: "d1",
    });
    const rating = createRatingRepository(testEnv, gameplay, {
      now: () => 2_000,
      storageMode: "d1",
    });
    const identity = {
      inviteId: "d1-rating-invite",
      matchId: "d1-rating-match",
      playerId: "d1-rating-login-player",
      opponentId: "d1-rating-login-opponent",
    };
    const operationId = `${identity.inviteId}__${identity.matchId}`;
    await expect(
      rating.tryAcquireRatingLease({
        ...identity,
        ownerUid: identity.playerId,
        ownerToken: "d1-owner",
        leaseMs: 30_000,
      }),
    ).resolves.toEqual({ status: "acquired", data: null });
    await expect(
      rating.tryAcquireRatingLease({
        ...identity,
        ownerUid: identity.playerId,
        ownerToken: "other-owner",
        leaseMs: 30_000,
      }),
    ).resolves.toMatchObject({ status: "busy" });

    await expect(
      rating.finalizeRatingUpdate(
        { ...identity, operationId, ownerToken: "d1-owner" },
        (playerValue, opponentValue) => ({
          playerUpdate: {
            rating: (playerValue?.rating || 0) + 10,
            nonce: (playerValue?.nonce || 0) + 1,
            totalManaPoints: (playerValue?.totalManaPoints || 0) + 4,
            win: true,
          },
          opponentUpdate: {
            rating: (opponentValue?.rating || 0) - 10,
            nonce: (opponentValue?.nonce || 0) + 1,
            totalManaPoints: (opponentValue?.totalManaPoints || 0) + 2,
            win: false,
          },
          repairData: {
            playerProfileId: playerValue?.profileId || "",
            opponentProfileId: opponentValue?.profileId || "",
            shouldUpdateFebruaryChallenge: true,
          },
          ratingUpdate: {
            status: "done",
            playerProfileId: playerValue?.profileId || "",
            opponentProfileId: opponentValue?.profileId || "",
            shouldUpdateFebruaryChallenge: true,
            completedAtMs: 2_000,
            updatedAtMs: 2_000,
            leaseExpiresAtMs: 2_000,
            telegramProjectionState: "pending",
            telegramProjectionUpdatedAtMs: 2_000,
            telegramProjectionVersion: 1,
            profileGameProjectionState: "pending",
            profileGameProjectionUpdatedAtMs: 2_000,
            profileGameProjectionVersion: 1,
            eventId: "event-1",
            eventProgressState: "pending",
            eventProgressUpdatedAtMs: 2_000,
            eventProgressVersion: 1,
          },
        }),
      ),
    ).resolves.toMatchObject({ status: "committed" });
    expect(
      await readCanonicalProfile(testEnv.PROFILE_DB, "d1-rating-player"),
    ).toMatchObject({
      profile: { rating: 1510, nonce: 0, totalManaPoints: 9, win: true },
      sortPresence: { nonce: true },
      sortValues: { nonce: 0 },
      winPresent: true,
    });
    expect(
      await readCanonicalProfile(testEnv.PROFILE_DB, "d1-rating-opponent"),
    ).toMatchObject({
      profile: { rating: 1490, nonce: 0, totalManaPoints: 7, win: false },
      sortPresence: { nonce: true },
      sortValues: { nonce: 0 },
      winPresent: true,
    });

    const eventDue = await rating.listDueRatingEventProgress(2_000, 10);
    expect(eventDue).toHaveLength(1);
    expect(
      await rating.claimRatingEventProgress(
        operationId,
        eventDue[0].updateTime,
        3_000,
      ),
    ).toBe(true);
    const gamesDue = await rating.listDueRatingProfileGameProjections(
      2_000,
      10,
    );
    expect(gamesDue).toHaveLength(1);
    expect(
      await rating.claimRatingProfileGameProjection(
        operationId,
        gamesDue[0].updateTime,
        3_000,
      ),
    ).toBe(true);
    const telegramDue = await rating.listDueRatingTelegramProjections(
      2_000,
      10,
    );
    expect(telegramDue).toHaveLength(1);
    expect(
      await rating.claimRatingTelegramProjection(
        operationId,
        telegramDue[0].updateTime,
        3_000,
      ),
    ).toBe(true);
    await rating.markRatingEventProgress(operationId, "done", 4_000);
    await rating.markRatingProfileGameProjection(operationId, "done", 4_000);
    await rating.markRatingTelegramProjection(operationId, "done", 4_000);
    expect(await rating.readRatingUpdate(operationId)).toMatchObject({
      status: "done",
      eventProgressState: "done",
      profileGameProjectionState: "done",
      telegramProjectionState: "done",
    });
  });

  it("preserves imported rating timestamp fallbacks during projection writes", async () => {
    const operationId = "d1-imported-rating-invite__d1-imported-rating-match";
    await commitCanonicalPlan(testEnv.PROFILE_DB, {
      expectations: [{ kind: "rating-update-absent", operationId }],
      mutations: [
        {
          kind: "insert-rating-update",
          value: {
            operationId,
            payload: {
              status: "processing",
              inviteId: "d1-imported-rating-invite",
              matchId: "d1-imported-rating-match",
              playerId: "d1-imported-rating-player",
              opponentId: "d1-imported-rating-opponent",
              ownerUid: "d1-imported-rating-player",
              ownerToken: "d1-imported-rating-owner",
              startedAtMs: 1_000,
              leaseExpiresAtMs: 5_000,
              eventProgressState: "pending",
              eventProgressUpdatedAtMs: 1_200,
              eventProgressVersion: 1,
            },
            status: "processing",
            inviteId: "d1-imported-rating-invite",
            matchId: "d1-imported-rating-match",
            playerId: "d1-imported-rating-player",
            opponentId: "d1-imported-rating-opponent",
            playerProfileId: null,
            opponentProfileId: null,
            ownerUid: "d1-imported-rating-player",
            ownerToken: "d1-imported-rating-owner",
            startedAtMs: 1_000,
            updatedAtMs: 1_500,
            leaseExpiresAtMs: 5_000,
            completedAtMs: null,
            telegramProjectionState: null,
            telegramProjectionUpdatedAtMs: null,
            telegramProjectionVersion: null,
            profileGameProjectionState: null,
            profileGameProjectionUpdatedAtMs: null,
            profileGameProjectionVersion: null,
            eventProgressState: "pending",
            eventProgressUpdatedAtMs: 1_200,
            eventProgressVersion: 1,
          },
        },
      ],
    });
    const gameplay = createGameplayRepository(testEnv, {
      rtdbClient: rtdb,
      storageMode: "d1",
    });
    const rating = createCanonicalRatingRepository(
      testEnv.PROFILE_DB,
      gameplay,
      {
        createFailure: () => new Error("rating-unavailable"),
        maxAttempts: 5,
        now: () => 2_000,
      },
    );
    const due = await rating.listDueRatingEventProgress(1_200, 100);
    const imported = due.find((entry) => entry.operationId === operationId);
    expect(imported).toBeDefined();
    expect(
      await rating.claimRatingEventProgress(
        operationId,
        imported?.updateTime || "",
        2_000,
      ),
    ).toBe(true);
    await rating.markRatingEventProgress(operationId, "done", 3_000);

    const row = await testEnv.PROFILE_DB.prepare(
      `SELECT payload_json, updated_at_ms, event_progress_state,
              event_progress_updated_at_ms
       FROM rating_updates WHERE operation_id = ?`,
    )
      .bind(operationId)
      .first<{
        event_progress_state: string;
        event_progress_updated_at_ms: number;
        payload_json: string;
        updated_at_ms: number;
      }>();
    expect(row).not.toBeNull();
    const payload = JSON.parse(row?.payload_json || "{}") as Record<
      string,
      unknown
    >;
    expect(payload.updatedAtMs).toBe(1_500);
    expect(row?.updated_at_ms).toBe(1_500);
    expect(payload.eventProgressState).toBe("done");
    expect(payload.eventProgressUpdatedAtMs).toBe(3_000);
    expect(row?.event_progress_state).toBe("done");
    expect(row?.event_progress_updated_at_ms).toBe(3_000);
  });

  it("retries rating finalization when a missing login is created", async () => {
    await insertProfile("d1-created-opponent", "d1-created-opponent-login");
    const gameplay = createGameplayRepository(testEnv, {
      rtdbClient: rtdb,
      storageMode: "d1",
    });
    const identity = {
      inviteId: "d1-created-invite",
      matchId: "d1-created-match",
      playerId: "d1-created-player-login",
      opponentId: "d1-created-opponent-login",
    };
    const operationId = `${identity.inviteId}__${identity.matchId}`;
    const baseRating = createCanonicalRatingRepository(
      testEnv.PROFILE_DB,
      gameplay,
      {
        createFailure: () => new Error("rating-unavailable"),
        maxAttempts: 5,
        now: () => 2_000,
      },
    );
    await baseRating.tryAcquireRatingLease({
      ...identity,
      ownerUid: identity.playerId,
      ownerToken: "d1-created-owner",
      leaseMs: 30_000,
    });
    const seenPlayerIds: Array<string | null> = [];
    const racedDb = beforeMatchingBatch(
      testEnv.PROFILE_DB,
      (queries) =>
        queries.some((query) => query.includes("UPDATE rating_updates")),
      async () => {
        await insertProfile("d1-created-player", "d1-created-player-login");
      },
    );
    const rating = createCanonicalRatingRepository(racedDb, gameplay, {
      createFailure: () => new Error("rating-unavailable"),
      maxAttempts: 5,
      now: () => 2_000,
    });
    await expect(
      rating.finalizeRatingUpdate(
        { ...identity, operationId, ownerToken: "d1-created-owner" },
        (playerValue, opponentValue) => {
          seenPlayerIds.push(playerValue?.profileId || null);
          return {
            playerUpdate: playerValue
              ? { rating: playerValue.rating + 1 }
              : null,
            opponentUpdate: null,
            repairData: {
              playerProfileId: playerValue?.profileId || "",
              opponentProfileId: opponentValue?.profileId || "",
              shouldUpdateFebruaryChallenge: false,
            },
            ratingUpdate: {
              status: "done",
              playerProfileId: playerValue?.profileId || "",
              opponentProfileId: opponentValue?.profileId || "",
              shouldUpdateFebruaryChallenge: false,
              completedAtMs: 2_000,
              updatedAtMs: 2_000,
              leaseExpiresAtMs: 2_000,
            },
          };
        },
      ),
    ).resolves.toMatchObject({ status: "committed" });
    expect(seenPlayerIds).toEqual([null, "d1-created-player"]);
    expect(
      (await readCanonicalProfile(testEnv.PROFILE_DB, "d1-created-player"))
        ?.profile.rating,
    ).toBe(1501);
    expect(await rating.readRatingUpdate(operationId)).toMatchObject({
      status: "done",
      playerProfileId: "d1-created-player",
    });
  });

  it("retries rating finalization when a login is merged", async () => {
    await insertProfile("d1-race-source", "d1-race-player-login");
    await insertProfile("d1-race-target", null, { rating: 1800 });
    await insertProfile("d1-race-opponent", "d1-race-opponent-login");
    const gameplay = createGameplayRepository(testEnv, {
      rtdbClient: rtdb,
      storageMode: "d1",
    });
    const identity = {
      inviteId: "d1-race-invite",
      matchId: "d1-race-match",
      playerId: "d1-race-player-login",
      opponentId: "d1-race-opponent-login",
    };
    const operationId = `${identity.inviteId}__${identity.matchId}`;
    const baseRating = createCanonicalRatingRepository(
      testEnv.PROFILE_DB,
      gameplay,
      {
        createFailure: () => new Error("rating-unavailable"),
        maxAttempts: 5,
        now: () => 3_000,
      },
    );
    await baseRating.tryAcquireRatingLease({
      ...identity,
      ownerUid: identity.playerId,
      ownerToken: "d1-race-owner",
      leaseMs: 30_000,
    });
    const racedDb = beforeMatchingBatch(
      testEnv.PROFILE_DB,
      (queries) =>
        queries.some((query) => query.includes("UPDATE rating_updates")),
      async () => {
        const source = await readCanonicalProfile(
          testEnv.PROFILE_DB,
          "d1-race-source",
        );
        const target = await readCanonicalProfile(
          testEnv.PROFILE_DB,
          "d1-race-target",
        );
        const owner = await readCanonicalLoginOwner(
          testEnv.PROFILE_DB,
          identity.playerId,
        );
        if (!source || !target || !owner) throw new Error("missing-race-state");
        await commitCanonicalPlan(testEnv.PROFILE_DB, {
          expectations: [
            {
              kind: "profile-revision",
              profileId: source.profileId,
              revision: source.revision,
            },
            {
              kind: "profile-revision",
              profileId: target.profileId,
              revision: target.revision,
            },
            {
              kind: "login-owner-revision",
              loginUid: owner.loginUid,
              profileId: owner.profileId,
              revision: owner.revision,
            },
            { kind: "merge-target-absent", sourceProfileId: source.profileId },
          ],
          mutations: [
            {
              kind: "retire-profile-with-redirect",
              profile: materializeCanonicalProfile({
                profile: source.profile,
                createdAtMs: source.createdAtMs,
                updatedAtMs: 3_000,
                legacyFields: source.legacyFields,
                state: "retiring",
                mergedAtMs: 3_000,
                mergedIntoProfileId: target.profileId,
                sortPresence: source.sortPresence,
                sortValues: source.sortValues,
                winPresent: source.winPresent,
                emojiPresent: source.emojiPresent,
              }),
              redirect: {
                sourceProfileId: source.profileId,
                targetProfileId: target.profileId,
                mergedAtMs: 3_000,
                opId: "d1-race-merge",
                sourceLegacyFields: source.legacyFields,
              },
            },
            {
              kind: "update-login-owner",
              value: {
                loginUid: owner.loginUid,
                profileId: target.profileId,
                createdAtMs: owner.createdAtMs,
                updatedAtMs: 3_000,
              },
            },
          ],
        });
      },
    );
    const rating = createCanonicalRatingRepository(racedDb, gameplay, {
      createFailure: () => new Error("rating-unavailable"),
      maxAttempts: 5,
      now: () => 3_000,
    });
    const seenPlayerIds: string[] = [];
    await expect(
      rating.finalizeRatingUpdate(
        { ...identity, operationId, ownerToken: "d1-race-owner" },
        (playerValue, opponentValue) => {
          if (playerValue) seenPlayerIds.push(playerValue.profileId);
          return {
            playerUpdate: playerValue
              ? { rating: playerValue.rating + 1 }
              : null,
            opponentUpdate: null,
            repairData: {
              playerProfileId: playerValue?.profileId || "",
              opponentProfileId: opponentValue?.profileId || "",
              shouldUpdateFebruaryChallenge: false,
            },
            ratingUpdate: {
              status: "done",
              playerProfileId: playerValue?.profileId || "",
              opponentProfileId: opponentValue?.profileId || "",
              shouldUpdateFebruaryChallenge: false,
              completedAtMs: 3_000,
              updatedAtMs: 3_000,
              leaseExpiresAtMs: 3_000,
            },
          };
        },
      ),
    ).resolves.toMatchObject({ status: "committed" });
    expect(seenPlayerIds).toEqual(["d1-race-source", "d1-race-target"]);
    expect(
      (await readCanonicalProfile(testEnv.PROFILE_DB, "d1-race-source"))
        ?.profile.rating,
    ).toBe(1500);
    expect(
      (await readCanonicalProfile(testEnv.PROFILE_DB, "d1-race-target"))
        ?.profile.rating,
    ).toBe(1801);
    expect(await rating.readRatingUpdate(operationId)).toMatchObject({
      status: "done",
      playerProfileId: "d1-race-target",
    });
  });

  it("uses modeled gameplay emoji without interpreting legacy fields", () => {
    const value = materializeCanonicalProfile({
      profile: profile("d1-legacy-emoji", { emoji: 13 }),
      createdAtMs: 1_000,
      updatedAtMs: 1_000,
      legacyFields: { emoji: 99 },
      emojiPresent: false,
      gameplayEmoji: 13,
    });
    const snapshot = { ...value, profileId: value.profile.id, revision: 1 };
    expect(canonicalProfileFields(snapshot)).toMatchObject({
      custom: {},
      emoji: 13,
    });
    const blockedByCustomNull = materializeCanonicalProfile({
      profile: profile("d1-null-custom-emoji", { emoji: 42 }),
      createdAtMs: 1_000,
      updatedAtMs: 1_000,
      legacyFields: { emoji: 13 },
      emojiPresent: false,
      gameplayEmoji: "",
    });
    const fields = canonicalProfileFields({
      ...blockedByCustomNull,
      profileId: blockedByCustomNull.profile.id,
      revision: 1,
    });
    expect(fields.custom).toEqual({});
    expect(Object.hasOwn(fields, "emoji")).toBe(false);
  });

  it("reconciles ambiguous rating lease and finalize responses", async () => {
    await insertProfile("d1-ambiguous-player", "d1-ambiguous-login-player");
    await insertProfile("d1-ambiguous-opponent", "d1-ambiguous-login-opponent");
    const gameplay = createGameplayRepository(testEnv, {
      rtdbClient: rtdb,
      storageMode: "d1",
    });
    const identity = {
      inviteId: "d1-ambiguous-invite",
      matchId: "d1-ambiguous-match",
      playerId: "d1-ambiguous-login-player",
      opponentId: "d1-ambiguous-login-opponent",
    };
    const operationId = `${identity.inviteId}__${identity.matchId}`;
    const ambiguousLease = createCanonicalRatingRepository(
      failAfterFirstWrite(testEnv.PROFILE_DB),
      gameplay,
      {
        createFailure: () => new Error("rating-unavailable"),
        maxAttempts: 5,
        now: () => 5_000,
      },
    );
    await expect(
      ambiguousLease.tryAcquireRatingLease({
        ...identity,
        ownerUid: identity.playerId,
        ownerToken: "ambiguous-owner",
        leaseMs: 30_000,
      }),
    ).resolves.toMatchObject({ status: "acquired" });

    const ambiguousFinalize = createCanonicalRatingRepository(
      failAfterFirstWrite(testEnv.PROFILE_DB),
      gameplay,
      {
        createFailure: () => new Error("rating-unavailable"),
        maxAttempts: 5,
        now: () => 6_000,
      },
    );
    await expect(
      ambiguousFinalize.finalizeRatingUpdate(
        { ...identity, operationId, ownerToken: "ambiguous-owner" },
        (playerValue, opponentValue) => ({
          playerUpdate: {
            rating: (playerValue?.rating || 0) + 1,
            nonce: (playerValue?.nonce || 0) + 1,
            totalManaPoints: playerValue?.totalManaPoints || 0,
            win: true,
          },
          opponentUpdate: {
            rating: (opponentValue?.rating || 0) - 1,
            nonce: (opponentValue?.nonce || 0) + 1,
            totalManaPoints: opponentValue?.totalManaPoints || 0,
            win: false,
          },
          repairData: {
            playerProfileId: playerValue?.profileId || "",
            opponentProfileId: opponentValue?.profileId || "",
            shouldUpdateFebruaryChallenge: false,
          },
          ratingUpdate: {
            status: "done",
            playerProfileId: playerValue?.profileId || "",
            opponentProfileId: opponentValue?.profileId || "",
            shouldUpdateFebruaryChallenge: false,
            completedAtMs: 6_000,
            updatedAtMs: 6_000,
            leaseExpiresAtMs: 6_000,
          },
        }),
      ),
    ).resolves.toMatchObject({ status: "replayed" });
    expect(
      (await readCanonicalProfile(testEnv.PROFILE_DB, "d1-ambiguous-player"))
        ?.profile.rating,
    ).toBe(1501);
    expect(
      (await readCanonicalProfile(testEnv.PROFILE_DB, "d1-ambiguous-opponent"))
        ?.profile.rating,
    ).toBe(1499);
  });

  it("feeds profile projection and prize-owner readers from canonical D1", async () => {
    await insertProfile("d1-project-host", "d1-project-login-host", {
      username: "D1Host",
      emoji: 7,
    });
    await insertProfile("d1-project-guest", "d1-project-login-guest", {
      username: "D1Guest",
      emoji: 9,
    });
    rtdbValues.set("invites/auto_bbbbbbbbbbb", {
      hostId: "d1-project-login-host",
      guestId: "d1-project-login-guest",
    });
    rtdbValues.set("players/d1-project-login-host/profile", "d1-project-host");
    rtdbValues.set(
      "players/d1-project-login-guest/profile",
      "d1-project-guest",
    );
    const runtime = createProfileGameProjectionRuntime(testEnv, {
      profileDb: testEnv.PROFILE_DB,
      d1: testEnv.PROFILE_GAMES_DB,
      rtdb: {
        getRtdbPath: async (path) => rtdbValues.get(path) ?? null,
      },
      storageMode: "d1",
      wait: async () => undefined,
    });
    await runtime.recomputeInviteProjection(
      "auto_bbbbbbbbbbb",
      "invite-created",
      { eventTimestampMs: 5_000 },
    );
    expect(
      await getProfileGameProjection(
        testEnv.PROFILE_GAMES_DB,
        "d1-project-host",
        "auto_bbbbbbbbbbb",
      ),
    ).not.toBeNull();

    rtdbValues.set("events/event-1/participants/d1-project-host", {
      loginUid: "d1-project-login-guest",
    });
    const resolveOwner = createProfileEventPrizeOwnerResolver(testEnv, {
      profileDb: testEnv.PROFILE_DB,
      rtdb: {
        getRtdbPath: async (path) => rtdbValues.get(path) ?? null,
      },
      storageMode: "d1",
    });
    await expect(
      resolveOwner({ eventId: "event-1", profileId: "d1-project-host" }),
    ).resolves.toBe("d1-project-guest");
  });
});
