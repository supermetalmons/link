import { matchTestPort } from "../test/gameSessionTestPorts.ts";
import { env } from "cloudflare:workers";
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompletePlayerProfile } from "@mons/shared/profiles";
import type { StateRepository } from "../test/stateRepositoryTestTypes.ts";
import {
  canonicalProfileFields,
  createCanonicalGameplayRepository,
  createCanonicalRatingRepository,
} from "../src/gameplayCanonicalRepository.ts";
import { applyRetiredProfileMigrations } from "./profileTestMigrations.ts";
import {
  createGameplayRepository,
  createRatingRepository,
  GameplayRepositoryFailure,
} from "../src/gameplayRepository.ts";
import {
  commitCanonicalPlan,
  materializeCanonicalProfile,
  readCanonicalLoginOwner,
  readCanonicalProfile,
  readCanonicalWagerSettlement,
  CanonicalProfileConflict,
  CanonicalProfileCorruption,
  type CanonicalRatingUpdateValue,
} from "../src/profileCanonicalD1.ts";
import { ProfileWritesDisabledFailure } from "../src/authErrors.ts";
import { observeD1FailureDatabase } from "./d1FailureTestUtils.ts";
import { createProfileGameProjectionRuntime } from "../src/profileGameProjectionRepository.ts";
import { createMiningRepository } from "../src/miningRepository.ts";
import { getProfileGameProjection } from "../src/profileGamesD1.ts";
import { loadEndedMatchResults } from "../../../runtime/telegram/eventProjectionCore.js";

const testEnv = env as Env & {
  TEST_D1_MIGRATIONS: D1Migration[];
  TEST_PROFILE_D1_MIGRATIONS: D1Migration[];
};

const stateValues = new Map<string, unknown>();
const state: StateRepository = {
  getPath: async (path) => stateValues.get(path) ?? null,
  patchRoot: async (updates) => {
    for (const [path, value] of Object.entries(updates)) {
      if (value === null) stateValues.delete(path);
      else stateValues.set(path, value);
    }
  },
  transactPath: async (path, update) => {
    const current = stateValues.get(path) ?? null;
    const result = update(current);
    const resultRecord =
      result && typeof result === "object" && !Array.isArray(result)
        ? (result as Record<string, unknown>)
        : {};
    if (Object.hasOwn(resultRecord, "value")) {
      stateValues.set(path, resultRecord.value);
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
  onPrepare?: (query: string) => void,
  onBind?: (query: string, values: unknown[]) => void,
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
          return (...values: unknown[]) => {
            onBind?.(query, values);
            return wrap(target.bind(...values), query);
          };
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
    prepare: (query) => {
      onPrepare?.(query);
      return wrap(database.prepare(query), query);
    },
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

type ObservedProfileWrite = { query: string; bindings: unknown[] };

async function readRawProfileRow(profileId: string) {
  const row = await testEnv.PROFILE_DB.prepare(
    "SELECT * FROM profile_records WHERE profile_id = ?",
  )
    .bind(profileId)
    .first<Record<string, unknown>>();
  if (!row) throw new Error("missing-raw-profile");
  return row;
}

async function seedRetainedProfileFields(profileIds: readonly string[]) {
  await testEnv.PROFILE_DB.batch(
    profileIds.map((profileId) =>
      testEnv.PROFILE_DB.prepare(
        "UPDATE profile_records SET legacy_fields_json = ? WHERE profile_id = ?",
      ).bind(JSON.stringify({ imported: "retained".repeat(512) }), profileId),
    ),
  );
  return Promise.all(profileIds.map(readRawProfileRow));
}

function expectNarrowProfileWrite(
  write: ObservedProfileWrite,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  changedColumns: readonly string[],
) {
  const assignments = write.query.match(/\bSET\b([\s\S]*?)\bWHERE\b/i)?.[1];
  expect(assignments).toBeDefined();
  expect(
    Array.from(
      assignments!.matchAll(/\b([a-z_]+)\s*=/g),
      ([, key]) => key,
    ).sort(),
  ).toEqual([...changedColumns, "revision"].sort());
  for (const [column, value] of Object.entries(before)) {
    if (column !== "revision" && !changedColumns.includes(column)) {
      expect(after[column], column).toEqual(value);
    }
  }
  expect(after.revision).toBe(Number(before.revision) + 1);
  const fullBindings = Object.entries(after)
    .filter(([column]) => column !== "revision")
    .map(([, value]) => value);
  const bytes = (values: unknown[]) =>
    new TextEncoder().encode(JSON.stringify(values)).byteLength;
  expect(bytes(write.bindings)).toBeLessThan(bytes(fullBindings) / 2);
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

async function insertProjectionRating(
  operationId: string,
  overrides: Partial<CanonicalRatingUpdateValue> = {},
) {
  const fields: Omit<CanonicalRatingUpdateValue, "operationId" | "payload"> = {
    status: "done",
    inviteId: "projection-invite",
    matchId: "projection-match",
    playerId: "projection-player",
    opponentId: "projection-opponent",
    playerProfileId: null,
    opponentProfileId: null,
    ownerUid: "projection-player",
    ownerToken: "projection-owner",
    startedAtMs: 1_000,
    updatedAtMs: 2_000,
    leaseExpiresAtMs: 2_000,
    completedAtMs: 2_000,
    eventProgressState: "pending",
    eventProgressUpdatedAtMs: 2_000,
    eventProgressVersion: 1,
    profileGameProjectionState: "pending",
    profileGameProjectionUpdatedAtMs: 2_000,
    profileGameProjectionVersion: 1,
    telegramProjectionState: "pending",
    telegramProjectionUpdatedAtMs: 2_000,
    telegramProjectionVersion: 1,
  };
  const value = {
    operationId,
    ...fields,
    payload: { ...fields, retained: [null, { nested: "retained" }] },
    ...overrides,
  };
  await commitCanonicalPlan(testEnv.PROFILE_DB, {
    expectations: [{ kind: "rating-update-absent", operationId }],
    mutations: [{ kind: "insert-rating-update", value }],
  });
  return value;
}

function projectionRatingRepository(db = testEnv.PROFILE_DB) {
  return createCanonicalRatingRepository(
    db,
    createGameplayRepository(testEnv, {
      stateClient: matchTestPort(state),
    }),
    {
      createFailure: () => new Error("rating-unavailable"),
      maxAttempts: 2,
      now: () => 3_000,
    },
  );
}

const ratingDiscoveryCases = [
  {
    list: "listDueRatingEventProgress",
    claim: "claimRatingEventProgress",
    field: "eventProgress",
    prefix: "event_progress",
  },
  {
    list: "listDueRatingProfileGameProjections",
    claim: "claimRatingProfileGameProjection",
    field: "profileGameProjection",
    prefix: "profile_game_projection",
  },
  {
    list: "listDueRatingTelegramProjections",
    claim: "claimRatingTelegramProjection",
    field: "telegramProjection",
    prefix: "telegram_projection",
  },
] as const;

function observeRatingDiscovery(db: D1Database) {
  const queries: string[] = [];
  const reads: Array<{
    query: string;
    bindings: unknown[];
    rows: Record<string, unknown>[];
    rowsWritten: number;
  }> = [];
  const wrap = (
    statement: D1PreparedStatement,
    query: string,
    bindings: unknown[] = [],
  ): D1PreparedStatement =>
    new Proxy(statement, {
      get(target, property) {
        if (property === "bind") {
          return (...values: unknown[]) =>
            wrap(target.bind(...values), query, values);
        }
        if (property === "all") {
          return async () => {
            const result = await target.all<Record<string, unknown>>();
            reads.push({
              query,
              bindings,
              rows: result.results,
              rowsWritten: result.meta.rows_written,
            });
            return result;
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  const database = new Proxy(db, {
    get(target, property) {
      if (property === "prepare") {
        return (query: string) => {
          queries.push(query);
          return wrap(target.prepare(query), query);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { database, queries, reads };
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

async function retireProfileInto(
  sourceProfileId: string,
  targetProfileId: string,
  mergedAtMs: number,
  opId: string,
) {
  const [source, target] = await Promise.all([
    readCanonicalProfile(testEnv.PROFILE_DB, sourceProfileId),
    readCanonicalProfile(testEnv.PROFILE_DB, targetProfileId),
  ]);
  if (!source || !target) throw new Error("missing-merge-profile");
  await commitCanonicalPlan(testEnv.PROFILE_DB, {
    expectations: [
      {
        kind: "profile-revision",
        profileId: sourceProfileId,
        revision: source.revision,
      },
      {
        kind: "profile-revision",
        profileId: targetProfileId,
        revision: target.revision,
      },
      { kind: "merge-target-absent", sourceProfileId },
    ],
    mutations: [
      {
        kind: "retire-profile-with-redirect",
        profile: materializeCanonicalProfile({
          profile: source.profile,
          createdAtMs: source.createdAtMs,
          updatedAtMs: mergedAtMs,
          state: "retiring",
          mergedAtMs,
          mergedIntoProfileId: targetProfileId,
          sortPresence: source.sortPresence,
          sortValues: source.sortValues,
          winPresent: source.winPresent,
          emojiPresent: source.emojiPresent,
          gameplayEmoji: source.gameplayEmoji,
        }),
        redirect: {
          sourceProfileId,
          targetProfileId,
          mergedAtMs,
          opId,
          sourceLegacyFields: source.legacyFields,
        },
      },
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
  it.each([
    "readProfileOwnershipSnapshot",
    "getMiningMaterials",
    "getMiningSnapshot",
    "applyWagerTransferOnce",
  ] as const)(
    "retains the %s read cause in one safe diagnostic",
    async (operation) => {
      const cause = new Error("private-profile-value", {
        cause: new Error("CHECK constraint failed: singleton = 1"),
      });
      const db = beforeMatchingBatch(
        testEnv.PROFILE_DB,
        () => false,
        async () => {},
        () => {
          throw cause;
        },
      );
      const repository = createGameplayRepository(
        { ...testEnv, PROFILE_DB: db },
        { stateClient: matchTestPort(state) },
      );
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const result =
          operation === "readProfileOwnershipSnapshot"
            ? repository.readProfileOwnershipSnapshot({
                loginUids: ["private-login"],
                profileIds: [],
              })
            : operation === "applyWagerTransferOnce"
              ? repository.applyWagerTransferOnce({
                  operationId: "private-operation",
                  fingerprint: "private-fingerprint",
                  winnerProfileId: "private-winner",
                  loserProfileId: "private-loser",
                  material: "dust",
                  count: 1,
                  appliedAtMs: 3_000,
                })
              : repository[operation]("private-profile");
        const failure = await result.catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(GameplayRepositoryFailure);
        expect(failure).toMatchObject({
          operation,
          message: "gameplay-repository-unavailable",
          cause,
        });
        expect((failure as Error).cause).toBe(cause);
        expect(log.mock.calls).toEqual([
          [
            JSON.stringify({
              event: "gameplay_repository_failure",
              operation,
              failureKind: "guard",
            }),
          ],
        ]);
      } finally {
        log.mockRestore();
      }
    },
  );

  it("retains wager write and reconciliation failures without duplicate diagnostics", async () => {
    await insertProfile("diagnostic-winner", null);
    await insertProfile("diagnostic-loser", null);
    const writeFailure = new Error("private-write-failure");
    const readFailure = new Error("private-reconciliation-failure");
    let writeFailed = false;
    const db = beforeMatchingBatch(
      testEnv.PROFILE_DB,
      () => true,
      async () => {
        writeFailed = true;
        throw writeFailure;
      },
      (query) => {
        if (writeFailed && query.includes("FROM wager_settlements")) {
          throw readFailure;
        }
      },
    );
    const repository = createGameplayRepository(
      { ...testEnv, PROFILE_DB: db },
      { stateClient: matchTestPort(state) },
    );
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const failure = await repository
        .applyWagerTransferOnce({
          operationId: "diagnostic-wager",
          fingerprint: "private-fingerprint",
          winnerProfileId: "diagnostic-winner",
          loserProfileId: "diagnostic-loser",
          material: "dust",
          count: 1,
          appliedAtMs: 3_000,
        })
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(GameplayRepositoryFailure);
      const cause = (failure as Error).cause;
      expect(cause).toBeInstanceOf(AggregateError);
      expect((cause as AggregateError).cause).toBe(writeFailure);
      expect((cause as AggregateError).errors).toEqual([
        writeFailure,
        readFailure,
      ]);
      expect(log.mock.calls).toEqual([
        [
          JSON.stringify({
            event: "gameplay_repository_failure",
            operation: "applyWagerTransferOnce",
            failureKind: "unknown",
          }),
        ],
      ]);
      expect(
        await readCanonicalWagerSettlement(
          testEnv.PROFILE_DB,
          "diagnostic-wager",
        ),
      ).toBeNull();
    } finally {
      log.mockRestore();
    }
  });

  it.each(["missing", "replayed"] as const)(
    "only logs a terminal wager failure when profiles are %s",
    async (outcome) => {
      if (outcome === "replayed") {
        await insertProfile("diagnostic-replay-winner", null);
        await insertProfile("diagnostic-replay-loser", null);
      }
      const repository = createGameplayRepository(
        { ...testEnv, PROFILE_DB: failAfterFirstWrite(testEnv.PROFILE_DB) },
        { stateClient: matchTestPort(state) },
      );
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const result = await repository
          .applyWagerTransferOnce({
            operationId: "diagnostic-replay-wager",
            fingerprint: "private-fingerprint",
            winnerProfileId: "diagnostic-replay-winner",
            loserProfileId: "diagnostic-replay-loser",
            material: "dust",
            count: 1,
            appliedAtMs: 3_000,
          })
          .catch((error: unknown) => error);
        if (outcome === "replayed") {
          expect(result).toBe("replayed");
          expect(log).not.toHaveBeenCalled();
        } else {
          expect(result).toBeInstanceOf(GameplayRepositoryFailure);
          expect(log).toHaveBeenCalledExactlyOnceWith(
            JSON.stringify({
              event: "gameplay_repository_failure",
              operation: "applyWagerTransferOnce",
              failureKind: "unknown",
            }),
          );
        }
      } finally {
        log.mockRestore();
      }
    },
  );

  it.each(["wager", "rating"] as const)(
    "retains the last %s conflict and logs only after retries exhaust",
    async (kind) => {
      await insertProfile("retry-winner", null);
      await insertProfile("retry-loser", null);
      const conflicts: CanonicalProfileConflict[] = [];
      const db = new Proxy(testEnv.PROFILE_DB, {
        get(target, property) {
          if (property === "batch") {
            return async () => {
              const conflict = new CanonicalProfileConflict({
                cause: new Error("private-conflict-value"),
              });
              conflicts.push(conflict);
              throw conflict;
            };
          }
          const member = Reflect.get(target, property, target);
          return typeof member === "function" ? member.bind(target) : member;
        },
      });
      const failureEnv = { ...testEnv, PROFILE_DB: db };
      const gameplay = createGameplayRepository(failureEnv, {
        stateClient: matchTestPort(state),
      });
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const result =
          kind === "wager"
            ? gameplay.applyWagerTransferOnce({
                operationId: "retry-wager",
                fingerprint: "private-fingerprint",
                winnerProfileId: "retry-winner",
                loserProfileId: "retry-loser",
                material: "dust",
                count: 1,
                appliedAtMs: 3_000,
              })
            : createRatingRepository(failureEnv, gameplay, {
                maxTransactionAttempts: 3,
                now: () => 3_000,
              }).tryAcquireRatingLease({
                inviteId: "retry-invite",
                matchId: "retry-match",
                playerId: "retry-player",
                opponentId: "retry-opponent",
                ownerUid: "retry-player",
                ownerToken: "private-owner-token",
                leaseMs: 30_000,
              });
        const failure = await result.catch((error: unknown) => error);
        expect(conflicts).toHaveLength(kind === "wager" ? 5 : 3);
        expect(failure).toBeInstanceOf(GameplayRepositoryFailure);
        expect((failure as Error).cause).toBe(conflicts.at(-1));
        expect(log.mock.calls).toEqual([
          [
            JSON.stringify({
              event: "gameplay_repository_failure",
              operation:
                kind === "wager"
                  ? "applyWagerTransferOnce"
                  : "tryAcquireRatingLease",
              failureKind: "unknown",
            }),
          ],
        ]);
      } finally {
        log.mockRestore();
      }
    },
  );

  it.each(["conflict", "unavailable"] as const)(
    "preserves rating %s semantics when reconciliation also fails",
    async (kind) => {
      const writeFailure =
        kind === "conflict"
          ? new CanonicalProfileConflict({
              cause: new Error("private-write-value"),
            })
          : new Error("private-write-value");
      const readFailure = new Error("private-reconciliation-value");
      let writeFailed = false;
      const db = beforeMatchingBatch(
        testEnv.PROFILE_DB,
        () => true,
        async () => {
          writeFailed = true;
          throw writeFailure;
        },
        (query) => {
          if (writeFailed && query.includes("FROM rating_updates")) {
            throw readFailure;
          }
        },
      );
      const failureEnv = { ...testEnv, PROFILE_DB: db };
      const gameplay = createGameplayRepository(failureEnv, {
        stateClient: matchTestPort(state),
      });
      const rating = createRatingRepository(failureEnv, gameplay);
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const failure = await rating
          .tryAcquireRatingLease({
            inviteId: "dual-failure-invite",
            matchId: "dual-failure-match",
            playerId: "dual-failure-player",
            opponentId: "dual-failure-opponent",
            ownerUid: "dual-failure-player",
            ownerToken: "private-owner-token",
            leaseMs: 30_000,
          })
          .catch((error: unknown) => error);
        if (kind === "unavailable") {
          expect(failure).toBe(writeFailure);
          expect(log).not.toHaveBeenCalled();
          return;
        }
        expect(failure).toBeInstanceOf(GameplayRepositoryFailure);
        const cause = (failure as Error).cause;
        expect(cause).toBeInstanceOf(AggregateError);
        expect((cause as AggregateError).cause).toBe(writeFailure);
        expect((cause as AggregateError).errors).toEqual([
          writeFailure,
          readFailure,
        ]);
        expect(log.mock.calls).toEqual([
          [
            JSON.stringify({
              event: "gameplay_repository_failure",
              operation: "tryAcquireRatingLease",
              failureKind: "unknown",
            }),
          ],
        ]);
      } finally {
        log.mockRestore();
      }
    },
  );

  it.each(["wager", "rating", "challenge"] as const)(
    "narrows %s profile writes without extra reads or changing retained fields",
    async (kind) => {
      const playerId = `narrow-${kind}-player`;
      const opponentId = `narrow-${kind}-opponent`;
      const playerLogin = `${playerId}-login`;
      const opponentLogin = `${opponentId}-login`;
      for (const [profileId, loginUid] of [
        [playerId, playerLogin],
        [opponentId, opponentLogin],
      ]) {
        await insertProfile(
          profileId,
          loginUid,
          {
            mining: {
              lastRockDate: "2026-08-28",
              materials: {
                dust: profileId === playerId ? 0 : 10,
                slime: 0,
                gum: 0,
                metal: 0,
                ice: 0,
              },
            },
          },
          {
            nonce: false,
            mp: false,
            dust: profileId !== playerId,
            slime: false,
            gum: false,
            metal: false,
            ice: false,
          },
          false,
          false,
          "",
        );
      }
      const before = await seedRetainedProfileFields([playerId, opponentId]);
      const gameplay = createGameplayRepository(testEnv, {
        stateClient: matchTestPort(state),
      });
      const identity = {
        inviteId: `narrow-${kind}-invite`,
        matchId: `narrow-${kind}-match`,
        playerId: playerLogin,
        opponentId: opponentLogin,
      };
      const operationId = `${identity.inviteId}__${identity.matchId}`;
      const options = {
        createFailure: () => new Error("narrow-profile-write-failed"),
        maxAttempts: 2,
        now: () => 2_000,
      };
      if (kind === "rating") {
        await createCanonicalRatingRepository(
          testEnv.PROFILE_DB,
          gameplay,
          options,
        ).tryAcquireRatingLease({
          ...identity,
          ownerUid: playerLogin,
          ownerToken: "narrow-owner",
          leaseMs: 30_000,
        });
      }
      const queries: string[] = [];
      const writes: ObservedProfileWrite[] = [];
      const db = beforeMatchingBatch(
        testEnv.PROFILE_DB,
        () => false,
        async () => {},
        (query) => queries.push(query),
        (query, bindings) => {
          if (/^\s*UPDATE profile_records\b/.test(query)) {
            writes.push({ query, bindings });
          }
        },
      );
      let expectedColumns: string[][];
      if (kind === "wager") {
        await expect(
          createCanonicalGameplayRepository(
            db,
            testEnv.PROFILE_GAMES_DB,
            options,
          ).applyWagerTransferOnce({
            operationId,
            fingerprint: "narrow-fingerprint",
            winnerProfileId: playerId,
            loserProfileId: opponentId,
            material: "dust",
            count: 10,
            appliedAtMs: 2_000,
          }),
        ).resolves.toBe("applied");
        expectedColumns = [
          ["payload_json", "dust_sort", "dust_sort_present", "updated_at_ms"],
          ["payload_json", "dust_sort", "updated_at_ms"],
        ];
        expect(
          await readCanonicalWagerSettlement(testEnv.PROFILE_DB, operationId),
        ).toMatchObject({ outcome: "applied", count: 10, revision: 1 });
      } else {
        const rating = createCanonicalRatingRepository(db, gameplay, options);
        if (kind === "rating") {
          await expect(
            rating.finalizeRatingUpdate(
              { ...identity, operationId, ownerToken: "narrow-owner" },
              () => ({
                playerUpdate: {
                  rating: 0,
                  nonce: 0,
                  totalManaPoints: 0,
                  win: false,
                },
                opponentUpdate: { rating: 1490, win: false },
                repairData: {
                  playerProfileId: playerId,
                  opponentProfileId: opponentId,
                  shouldUpdateFebruaryChallenge: false,
                },
                ratingUpdate: {
                  status: "done",
                  playerProfileId: playerId,
                  opponentProfileId: opponentId,
                  completedAtMs: 2_000,
                  updatedAtMs: 2_000,
                  leaseExpiresAtMs: 2_000,
                },
              }),
            ),
          ).resolves.toMatchObject({ status: "committed" });
          expectedColumns = [
            [
              "payload_json",
              "rating_sort",
              "mana_points_sort",
              "nonce_sort",
              "mana_points_sort_present",
              "nonce_sort_present",
              "win_present",
              "updated_at_ms",
            ],
            ["payload_json", "rating_sort", "win_present", "updated_at_ms"],
          ];
          expect(
            await testEnv.PROFILE_DB.prepare(
              "SELECT status, revision FROM rating_updates WHERE operation_id = ?",
            )
              .bind(operationId)
              .first(),
          ).toEqual({ status: "done", revision: 2 });
        } else {
          await rating.applyFebruaryChallengeReplay(playerId, opponentId);
          expectedColumns = [
            ["payload_json", "updated_at_ms"],
            ["payload_json", "updated_at_ms"],
          ];
          expect(
            await testEnv.PROFILE_DB.prepare(
              "SELECT COUNT(*) AS count FROM profile_february_opponents",
            ).first("count"),
          ).toBe(2);
        }
      }
      expect(
        queries.filter((query) => /^\s*(?:SELECT|WITH)\b/i.test(query)),
      ).toHaveLength({ wager: 3, rating: 5, challenge: 8 }[kind]);
      expect(writes).toHaveLength(2);
      for (const [index, profileId] of [playerId, opponentId].entries()) {
        const write = writes.find(
          ({ bindings }) => bindings.at(-1) === profileId,
        );
        expect(write).toBeDefined();
        const after = await readRawProfileRow(profileId);
        expectNarrowProfileWrite(
          write!,
          before[index],
          after,
          expectedColumns[index],
        );
        const payload = JSON.parse(String(after.payload_json));
        expect(payload.mining.materials.dust).toBe(
          kind === "wager" ? (index === 0 ? 10 : 0) : index === 0 ? 0 : 10,
        );
        if (kind === "rating") {
          expect(payload.win).toBe(false);
          if (index === 0) {
            expect(payload).toMatchObject({
              rating: 1500,
              nonce: 0,
              totalManaPoints: 0,
            });
            expect(after.rating_sort).toBe(0);
            expect(after.rating_sort_present).toBe(1);
          }
        }
      }
    },
  );

  beforeAll(async () => {
    await applyRetiredProfileMigrations(
      testEnv.PROFILE_DB,
      testEnv.TEST_PROFILE_D1_MIGRATIONS,
      "c".repeat(64),
    );
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
    const repository = createGameplayRepository(testEnv, {
      stateClient: matchTestPort(state),
    });
    const ownership = await repository.readProfileOwnershipSnapshot({
      loginUids: ["d1-game-login-winner", "d1-game-login-loser"],
      profileIds: ["d1-game-source"],
    });
    expect(ownership.profileById.get("d1-game-winner")?.profile.profileId).toBe(
      "d1-game-winner",
    );
    expect(
      ownership.loginOwnerByUid.get("d1-game-login-loser")?.profileId,
    ).toBe("d1-game-loser");
    expect(ownership.loginUidsByProfileId.get("d1-game-winner")).toEqual([
      "d1-game-login-winner",
    ]);
    expect(ownership.canonicalProfileIdByProfileId.get("d1-game-source")).toBe(
      "d1-game-winner",
    );

    const transfer = {
      operationId: "d1-game-wager",
      fingerprint: "d1-game-fingerprint",
      winnerProfileId: "d1-game-source",
      loserProfileId: "d1-game-loser",
      material: "dust" as const,
      count: 3,
      appliedAtMs: 500,
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
    expect(storedWinner?.sortValues).toMatchObject({
      dust: 3,
      slime: null,
      gum: null,
      metal: null,
      ice: null,
    });
    expect(storedWinner?.updatedAtMs).toBe(1_000);
    const storedLoser = await readCanonicalProfile(
      testEnv.PROFILE_DB,
      "d1-game-loser",
    );
    expect(storedLoser?.profile.mining.materials.dust).toBe(7);
    expect(storedLoser?.updatedAtMs).toBe(1_000);
  });

  it("records insufficient materials with the raw fingerprint", async () => {
    await insertProfile("d1-insufficient-winner", null, {
      mining: {
        lastRockDate: "2026-08-28",
        materials: { dust: 4, slime: 0, gum: 0, metal: 0, ice: 0 },
      },
    });
    await insertProfile("d1-insufficient-loser", null, {
      mining: {
        lastRockDate: "2026-08-28",
        materials: { dust: 2, slime: 0, gum: 0, metal: 0, ice: 0 },
      },
    });
    const repository = createGameplayRepository(
      { ...testEnv, PROFILE_DB: failAfterFirstWrite(testEnv.PROFILE_DB) },
      {
        stateClient: matchTestPort(state),
      },
    );
    const replayRepository = createGameplayRepository(testEnv, {
      stateClient: matchTestPort(state),
    });
    const transfer = {
      operationId: "d1-insufficient-wager",
      fingerprint: "d1-insufficient-fingerprint",
      winnerProfileId: "d1-insufficient-winner",
      loserProfileId: "d1-insufficient-loser",
      material: "dust" as const,
      count: 3,
      appliedAtMs: 3_000,
    };

    await expect(repository.applyWagerTransferOnce(transfer)).resolves.toBe(
      "insufficient-materials",
    );
    await expect(
      replayRepository.applyWagerTransferOnce(transfer),
    ).resolves.toBe("insufficient-materials");

    expect(
      await readCanonicalProfile(testEnv.PROFILE_DB, "d1-insufficient-winner"),
    ).toMatchObject({
      revision: 1,
      profile: { mining: { materials: { dust: 4 } } },
    });
    expect(
      await readCanonicalProfile(testEnv.PROFILE_DB, "d1-insufficient-loser"),
    ).toMatchObject({
      revision: 1,
      profile: { mining: { materials: { dust: 2 } } },
    });
    expect(
      await testEnv.PROFILE_DB.prepare(
        `SELECT fingerprint, outcome
         FROM wager_settlements WHERE operation_id = ?`,
      )
        .bind("d1-insufficient-wager")
        .first<{ fingerprint: string; outcome: string }>(),
    ).toEqual({
      fingerprint: "d1-insufficient-fingerprint",
      outcome: "insufficient-materials",
    });
    expect(
      await readCanonicalWagerSettlement(
        testEnv.PROFILE_DB,
        transfer.operationId,
        transfer.fingerprint,
      ),
    ).toMatchObject({
      fingerprint: transfer.fingerprint,
      outcome: "insufficient-materials",
    });
    await expect(
      replayRepository.applyWagerTransferOnce({
        ...transfer,
        fingerprint: "d1-insufficient-mismatch",
      }),
    ).rejects.toThrow("gameplay-repository-unavailable");
    await expect(
      readCanonicalWagerSettlement(
        testEnv.PROFILE_DB,
        transfer.operationId,
        "d1-insufficient-mismatch",
      ),
    ).rejects.toThrow();
  });

  it("keeps same-profile wager settlements net zero", async () => {
    await insertProfile("d1-same-profile", null, {
      mining: {
        lastRockDate: "2026-08-28",
        materials: { dust: 2, slime: 0, gum: 0, metal: 0, ice: 0 },
      },
    });
    const repository = createGameplayRepository(testEnv, {
      stateClient: matchTestPort(state),
    });
    const transfer = {
      operationId: "d1-same-profile-wager",
      fingerprint: "d1-same-profile-fingerprint",
      winnerProfileId: "d1-same-profile",
      loserProfileId: "d1-same-profile",
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
    expect(
      await readCanonicalProfile(testEnv.PROFILE_DB, "d1-same-profile"),
    ).toMatchObject({
      revision: 1,
      profile: { mining: { materials: { dust: 2 } } },
    });
  });

  it("preserves raw gameplay emoji and rating zero in ownership snapshots", async () => {
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
      stateClient: matchTestPort(state),
    });
    const rating = createRatingRepository(testEnv, gameplay);
    const gameplayOwnership = await gameplay.readProfileOwnershipSnapshot({
      loginUids: [loginUid],
      profileIds: [],
    });
    expect(gameplayOwnership.profileById.get(profileId)?.profile).toMatchObject(
      {
        emoji: "",
        rating: 0,
      },
    );
    const ratingOwnership = await rating.readProfileOwnershipSnapshot({
      loginUids: [loginUid],
      profileIds: [],
    });
    expect(ratingOwnership.profileById.get(profileId)?.profile).toMatchObject({
      emoji: "",
      rating: 0,
    });
    const miningOwnership = await createMiningRepository(
      testEnv,
    ).readProfileOwnershipSnapshot({
      loginUids: [loginUid],
      profileIds: [],
    });
    expect(miningOwnership).toEqual(gameplayOwnership);
    expect(ratingOwnership).toEqual(gameplayOwnership);
  });

  it.each([
    { name: "absent", ratingPresent: false, emoji: 0 },
    { name: "null", ratingPresent: true, emoji: "raw-emoji" },
  ])(
    "shares ownership mapping for merged and missing identities with $name ratings",
    async ({ ratingPresent, emoji }) => {
      const profileId = "d1-ownership-target";
      const sourceProfileId = "d1-ownership-source";
      const loginUids = ["d1-ownership-login-a", "d1-ownership-login-b"];
      const value = materializeCanonicalProfile({
        profile: profile(profileId, { username: null }),
        createdAtMs: 1_000,
        updatedAtMs: 1_000,
        emojiPresent: false,
        gameplayEmoji: emoji,
        sortPresence: { rating: ratingPresent },
        sortValues: { rating: null },
      });
      await commitCanonicalPlan(testEnv.PROFILE_DB, {
        expectations: [
          { kind: "profile-absent", profileId },
          ...loginUids.map((loginUid) => ({
            kind: "login-owner-absent" as const,
            loginUid,
          })),
        ],
        mutations: [
          { kind: "insert-active-profile", value },
          ...loginUids.map((loginUid) => ({
            kind: "insert-login-owner" as const,
            value: {
              loginUid,
              profileId,
              createdAtMs: 1_000,
              updatedAtMs: 1_000,
            },
          })),
        ],
      });
      await insertProfile(sourceProfileId, null);
      await retireProfileInto(
        sourceProfileId,
        profileId,
        2_000,
        "ownership-merge",
      );
      const query = {
        loginUids: [...loginUids, "missing-login"],
        profileIds: [sourceProfileId, profileId, "missing-profile"],
      };
      const gameplay = createGameplayRepository(testEnv, {
        stateClient: matchTestPort(state),
      });
      const mining = createMiningRepository(testEnv);
      const snapshots = await Promise.all([
        gameplay.readProfileOwnershipSnapshot(query),
        mining.readProfileOwnershipSnapshot(query),
      ]);
      expect(snapshots[0]).toEqual(snapshots[1]);
      for (const snapshot of snapshots) {
        expect(snapshot.canonicalProfileIdByProfileId).toEqual(
          new Map([
            [sourceProfileId, profileId],
            [profileId, profileId],
            ["missing-profile", null],
          ]),
        );
        expect(snapshot.loginOwnerByUid).toEqual(
          new Map([
            ...loginUids.map(
              (loginUid) => [loginUid, { profileId, revision: 1 }] as const,
            ),
            ["missing-login", null],
          ]),
        );
        expect(snapshot.loginUidsByProfileId).toEqual(
          new Map([[profileId, loginUids]]),
        );
        expect(snapshot.profileById).toEqual(
          new Map([
            [
              profileId,
              {
                profile: {
                  aura: "",
                  emoji,
                  eth: "",
                  profileId,
                  rating: 1500,
                  sol: "",
                  username: "",
                },
                revision: 1,
              },
            ],
          ]),
        );
        expect(Object.isFrozen(snapshot)).toBe(true);
        expect(
          Object.isFrozen(snapshot.loginUidsByProfileId.get(profileId)),
        ).toBe(true);
        expect(Object.isFrozen(snapshot.profileById.get(profileId))).toBe(true);
        expect(
          Object.isFrozen(snapshot.profileById.get(profileId)?.profile),
        ).toBe(true);
      }
    },
  );

  it("replays February opponents through deleted merge sources", async () => {
    const sourceProfileId = "d1-feb-source";
    const targetProfileId = "d1-feb-target";
    const opponentProfileId = "d1-feb-opponent";
    await insertProfile(sourceProfileId, null);
    await insertProfile(targetProfileId, "d1-feb-target-login");
    await insertProfile(opponentProfileId, "d1-feb-opponent-login");
    const source = await readCanonicalProfile(
      testEnv.PROFILE_DB,
      sourceProfileId,
    );
    const target = await readCanonicalProfile(
      testEnv.PROFILE_DB,
      targetProfileId,
    );
    if (!source || !target) throw new Error("missing-february-profiles");
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
        { kind: "merge-target-absent", sourceProfileId },
      ],
      mutations: [
        {
          kind: "retire-profile-with-redirect",
          profile: materializeCanonicalProfile({
            profile: source.profile,
            createdAtMs: source.createdAtMs,
            updatedAtMs: 2_000,
            state: "retiring",
            mergedAtMs: 2_000,
            mergedIntoProfileId: targetProfileId,
            sortPresence: source.sortPresence,
            sortValues: source.sortValues,
            winPresent: source.winPresent,
            emojiPresent: source.emojiPresent,
          }),
          redirect: {
            sourceProfileId,
            targetProfileId,
            mergedAtMs: 2_000,
            opId: "d1-feb-merge",
            sourceLegacyFields: source.legacyFields,
          },
        },
      ],
    });
    const retired = await readCanonicalProfile(
      testEnv.PROFILE_DB,
      sourceProfileId,
    );
    if (!retired) throw new Error("missing-retired-february-profile");
    await commitCanonicalPlan(testEnv.PROFILE_DB, {
      expectations: [
        {
          kind: "profile-revision",
          profileId: sourceProfileId,
          revision: retired.revision,
        },
        { kind: "merge-target", sourceProfileId, targetProfileId },
      ],
      mutations: [
        {
          kind: "delete-retired-profile",
          profileId: sourceProfileId,
          targetProfileId,
        },
      ],
    });
    const gameplay = createGameplayRepository(testEnv, {
      stateClient: matchTestPort(state),
    });
    const rating = createRatingRepository(testEnv, gameplay, {
      now: () => 3_000,
    });
    await expect(
      rating.applyFebruaryChallengeReplay(sourceProfileId, opponentProfileId),
    ).resolves.toBeUndefined();
    await expect(
      rating.applyFebruaryChallengeReplay(sourceProfileId, targetProfileId),
    ).resolves.toBeUndefined();
    expect(
      (await readCanonicalProfile(testEnv.PROFILE_DB, targetProfileId))?.profile
        .feb2026UniqueOpponentsCount,
    ).toBe(1);
    expect(
      (await readCanonicalProfile(testEnv.PROFILE_DB, opponentProfileId))
        ?.profile.feb2026UniqueOpponentsCount,
    ).toBe(1);
  });

  it("does not recount an opponent after that opponent merges", async () => {
    const playerProfileId = "d1-feb-existing-player";
    const sourceOpponentProfileId = "d1-feb-existing-source";
    const targetOpponentProfileId = "d1-feb-existing-target";
    await insertProfile(playerProfileId, "d1-feb-existing-player-login");
    await insertProfile(sourceOpponentProfileId, null);
    await insertProfile(targetOpponentProfileId, null);
    const gameplay = createGameplayRepository(testEnv, {
      stateClient: matchTestPort(state),
    });
    const rating = createRatingRepository(testEnv, gameplay, {
      now: () => 3_000,
    });

    await rating.applyFebruaryChallengeReplay(
      playerProfileId,
      sourceOpponentProfileId,
    );
    await retireProfileInto(
      sourceOpponentProfileId,
      targetOpponentProfileId,
      2_000,
      "d1-feb-existing-merge",
    );
    await rating.applyFebruaryChallengeReplay(
      playerProfileId,
      sourceOpponentProfileId,
    );

    expect(
      (await readCanonicalProfile(testEnv.PROFILE_DB, playerProfileId))?.profile
        .feb2026UniqueOpponentsCount,
    ).toBe(1);
    expect(
      (await readCanonicalProfile(testEnv.PROFILE_DB, targetOpponentProfileId))
        ?.profile.feb2026UniqueOpponentsCount,
    ).toBe(1);
  });

  it("fences an opponent merge during February replay", async () => {
    const playerProfileId = "d1-feb-fenced-player";
    const sourceOpponentProfileId = "d1-feb-fenced-source";
    const targetOpponentProfileId = "d1-feb-fenced-target";
    await insertProfile(playerProfileId, "d1-feb-fenced-player-login");
    await insertProfile(sourceOpponentProfileId, null);
    await insertProfile(targetOpponentProfileId, null);
    const gameplay = createGameplayRepository(testEnv, {
      stateClient: matchTestPort(state),
    });
    await createRatingRepository(testEnv, gameplay, {
      now: () => 2_000,
    }).applyFebruaryChallengeReplay(playerProfileId, sourceOpponentProfileId);
    const racedDb = beforeMatchingBatch(
      testEnv.PROFILE_DB,
      (queries) =>
        queries.some((query) =>
          query.includes("INSERT INTO profile_february_opponents"),
        ),
      () =>
        retireProfileInto(
          sourceOpponentProfileId,
          targetOpponentProfileId,
          3_000,
          "d1-feb-fenced-merge",
        ),
    );
    const rating = createCanonicalRatingRepository(racedDb, gameplay, {
      createFailure: () => new Error("rating-unavailable"),
      maxAttempts: 5,
      now: () => 4_000,
    });

    await rating.applyFebruaryChallengeReplay(
      playerProfileId,
      targetOpponentProfileId,
    );

    expect(
      (await readCanonicalProfile(testEnv.PROFILE_DB, playerProfileId))?.profile
        .feb2026UniqueOpponentsCount,
    ).toBe(1);
    expect(
      (await readCanonicalProfile(testEnv.PROFILE_DB, targetOpponentProfileId))
        ?.profile.feb2026UniqueOpponentsCount,
    ).toBe(1);
  });

  it.each(["retiring", "deleted"] as const)(
    "re-resolves February profiles left %s by a merge after ownership resolution",
    async (sourceState) => {
      const sourceProfileId = "d1-feb-race-source";
      const targetProfileId = "d1-feb-race-target";
      const opponentProfileId = "d1-feb-race-opponent";
      await insertProfile(sourceProfileId, "d1-feb-race-source-login");
      await insertProfile(targetProfileId, null);
      await insertProfile(opponentProfileId, "d1-feb-race-opponent-login");
      const racedDb = beforeMatchingBatch(
        testEnv.PROFILE_DB,
        (queries) =>
          queries.some((query) =>
            query.includes("canonical_orphaned_dependents"),
          ),
        async () => {
          const source = await readCanonicalProfile(
            testEnv.PROFILE_DB,
            sourceProfileId,
          );
          const target = await readCanonicalProfile(
            testEnv.PROFILE_DB,
            targetProfileId,
          );
          const owner = await readCanonicalLoginOwner(
            testEnv.PROFILE_DB,
            "d1-feb-race-source-login",
          );
          if (!source || !target || !owner) {
            throw new Error("missing-february-race-profiles");
          }
          await commitCanonicalPlan(testEnv.PROFILE_DB, {
            expectations: [
              {
                kind: "profile-revision",
                profileId: sourceProfileId,
                revision: source.revision,
              },
              {
                kind: "profile-revision",
                profileId: targetProfileId,
                revision: target.revision,
              },
              {
                kind: "login-owner-revision",
                loginUid: owner.loginUid,
                profileId: owner.profileId,
                revision: owner.revision,
              },
              { kind: "merge-target-absent", sourceProfileId },
            ],
            mutations: [
              {
                kind: "retire-profile-with-redirect",
                profile: materializeCanonicalProfile({
                  profile: source.profile,
                  createdAtMs: source.createdAtMs,
                  updatedAtMs: 2_000,
                  state: "retiring",
                  mergedAtMs: 2_000,
                  mergedIntoProfileId: targetProfileId,
                  sortPresence: source.sortPresence,
                  sortValues: source.sortValues,
                  winPresent: source.winPresent,
                  emojiPresent: source.emojiPresent,
                }),
                redirect: {
                  sourceProfileId,
                  targetProfileId,
                  mergedAtMs: 2_000,
                  opId: "d1-feb-race-merge",
                  sourceLegacyFields: source.legacyFields,
                },
              },
              {
                kind: "update-login-owner",
                value: {
                  loginUid: owner.loginUid,
                  profileId: targetProfileId,
                  createdAtMs: owner.createdAtMs,
                  updatedAtMs: 2_000,
                },
              },
            ],
          });
          if (sourceState === "deleted") {
            const retired = await readCanonicalProfile(
              testEnv.PROFILE_DB,
              sourceProfileId,
            );
            if (!retired)
              throw new Error("missing-retired-february-race-profile");
            await commitCanonicalPlan(testEnv.PROFILE_DB, {
              expectations: [
                {
                  kind: "profile-revision",
                  profileId: sourceProfileId,
                  revision: retired.revision,
                },
                { kind: "merge-target", sourceProfileId, targetProfileId },
              ],
              mutations: [
                {
                  kind: "delete-retired-profile",
                  profileId: sourceProfileId,
                  targetProfileId,
                },
              ],
            });
          }
        },
      );
      const gameplay = createGameplayRepository(testEnv, {
        stateClient: matchTestPort(state),
      });
      const rating = createCanonicalRatingRepository(racedDb, gameplay, {
        createFailure: () => new Error("rating-unavailable"),
        maxAttempts: 5,
        now: () => 3_000,
      });
      await expect(
        rating.applyFebruaryChallengeReplay(sourceProfileId, opponentProfileId),
      ).resolves.toBeUndefined();
      const remainingSource = await readCanonicalProfile(
        testEnv.PROFILE_DB,
        sourceProfileId,
      );
      if (sourceState === "deleted") {
        expect(remainingSource).toBeNull();
      } else {
        expect(remainingSource?.profile.feb2026UniqueOpponentsCount).toBe(0);
      }
      expect(
        (await readCanonicalProfile(testEnv.PROFILE_DB, targetProfileId))
          ?.profile.feb2026UniqueOpponentsCount,
      ).toBe(1);
      expect(
        (await readCanonicalProfile(testEnv.PROFILE_DB, opponentProfileId))
          ?.profile.feb2026UniqueOpponentsCount,
      ).toBe(1);
    },
  );

  it("propagates February snapshot read failures without applying counters", async () => {
    const playerProfileId = "d1-feb-failure-player";
    const opponentProfileId = "d1-feb-failure-opponent";
    await insertProfile(playerProfileId, null);
    await insertProfile(opponentProfileId, null);
    const failure = new Error("challenge-snapshot-unavailable");
    const failedDb = beforeMatchingBatch(
      testEnv.PROFILE_DB,
      (queries) =>
        queries.some((query) =>
          query.includes("canonical_orphaned_dependents"),
        ),
      async () => {
        throw failure;
      },
    );
    const gameplay = createGameplayRepository(testEnv, {
      stateClient: matchTestPort(state),
    });
    const rating = createCanonicalRatingRepository(failedDb, gameplay, {
      createFailure: () => new Error("rating-unavailable"),
      maxAttempts: 5,
      now: () => 3_000,
    });

    await expect(
      rating.applyFebruaryChallengeReplay(playerProfileId, opponentProfileId),
    ).rejects.toBe(failure);
    for (const profileId of [playerProfileId, opponentProfileId]) {
      expect(
        (await readCanonicalProfile(testEnv.PROFILE_DB, profileId))?.profile
          .feb2026UniqueOpponentsCount,
      ).toBe(0);
    }
    expect(
      await testEnv.PROFILE_DB.prepare(
        "SELECT COUNT(*) AS count FROM profile_february_opponents",
      ).first("count"),
    ).toBe(0);
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
      stateClient: matchTestPort(state),
    });
    let observeFinalization = false;
    const preparedQueries: string[] = [];
    const batchQueries: string[][] = [];
    const observedDb = beforeMatchingBatch(
      testEnv.PROFILE_DB,
      (queries) => {
        if (observeFinalization) batchQueries.push([...queries]);
        return false;
      },
      async () => {},
      (query) => {
        if (observeFinalization) preparedQueries.push(query);
      },
    );
    const rating = createRatingRepository(
      { ...testEnv, PROFILE_DB: observedDb },
      gameplay,
      {
        now: () => 2_000,
      },
    );
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

    observeFinalization = true;
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
    observeFinalization = false;
    const snapshotBatches = batchQueries.filter((queries) =>
      queries.every((query) => /^\s*SELECT\b/i.test(query)),
    );
    expect(snapshotBatches).toHaveLength(1);
    expect(snapshotBatches[0]).toHaveLength(4);
    expect(
      preparedQueries.filter(
        (query) =>
          /^\s*SELECT\b/i.test(query) && !query.includes("rating_updates"),
      ),
    ).toEqual(snapshotBatches[0]);
    expect(snapshotBatches[0].join("\n")).not.toMatch(
      /profile_auth_|profile_recovery_|profile_wallet_/,
    );
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

  it.each([
    {
      label: "numeric",
      player: 9,
      opponent: 0,
      expectedPlayer: 9,
      expectedOpponent: 0,
    },
    {
      label: "absent",
      player: undefined,
      opponent: undefined,
      expectedPlayer: undefined,
      expectedOpponent: undefined,
    },
    {
      label: "null",
      player: null,
      opponent: null,
      expectedPlayer: undefined,
      expectedOpponent: undefined,
    },
    {
      label: "strings",
      player: "9",
      opponent: "0",
      expectedPlayer: undefined,
      expectedOpponent: undefined,
    },
    {
      label: "missing-player",
      player: undefined,
      opponent: 0,
      expectedPlayer: undefined,
      expectedOpponent: 0,
    },
    {
      label: "missing-opponent",
      player: 9,
      opponent: undefined,
      expectedPlayer: 9,
      expectedOpponent: undefined,
    },
  ])(
    "loads $label event scores through the canonical rating repository",
    async ({ label, player, opponent, expectedPlayer, expectedOpponent }) => {
      const gameplay = createGameplayRepository(testEnv, {
        stateClient: matchTestPort(state),
      });
      const rating = createRatingRepository(testEnv, gameplay, {
        now: () => 2_000,
      });
      const inviteId = `d1-event-score-${label}`;
      const identity = {
        inviteId,
        matchId: inviteId,
        playerId: "d1-event-score-player",
        opponentId: "d1-event-score-opponent",
      };
      const operationId = `${inviteId}__${inviteId}`;
      const ownerToken = "d1-event-score-owner";
      await expect(
        rating.tryAcquireRatingLease({
          ...identity,
          ownerUid: identity.playerId,
          ownerToken,
          leaseMs: 30_000,
        }),
      ).resolves.toMatchObject({ status: "acquired" });
      await expect(
        rating.finalizeRatingUpdate(
          { ...identity, operationId, ownerToken },
          () => ({
            playerUpdate: null,
            opponentUpdate: null,
            repairData: {
              playerProfileId: "",
              opponentProfileId: "",
              shouldUpdateFebruaryChallenge: false,
            },
            ratingUpdate: {
              status: "done",
              completedAtMs: 2_000,
              updatedAtMs: 2_000,
              leaseExpiresAtMs: 2_000,
              playerManaPoints: typeof player === "number" ? player : undefined,
              opponentManaPoints:
                typeof opponent === "number" ? opponent : undefined,
            },
          }),
        ),
      ).resolves.toMatchObject({ status: "committed" });

      if (
        (player !== undefined && typeof player !== "number") ||
        (opponent !== undefined && typeof opponent !== "number")
      ) {
        const stored = await testEnv.PROFILE_DB.prepare(
          "SELECT payload_json FROM rating_updates WHERE operation_id = ?",
        )
          .bind(operationId)
          .first<{ payload_json: string }>();
        await testEnv.PROFILE_DB.prepare(
          "UPDATE rating_updates SET payload_json = ? WHERE operation_id = ?",
        )
          .bind(
            JSON.stringify({
              ...JSON.parse(stored!.payload_json),
              playerManaPoints: player,
              opponentManaPoints: opponent,
            }),
            operationId,
          )
          .run();
      }

      const update = await rating.readRatingUpdate(operationId);
      expect(update?.playerManaPoints).toBe(expectedPlayer);
      expect(update?.opponentManaPoints).toBe(expectedOpponent);
      expect(Object.hasOwn(update || {}, "playerManaPoints")).toBe(
        expectedPlayer !== undefined,
      );
      expect(Object.hasOwn(update || {}, "opponentManaPoints")).toBe(
        expectedOpponent !== undefined,
      );

      for (const playerIsHost of [true, false]) {
        const event = {
          rounds: {
            0: {
              matches: {
                "0_0": {
                  inviteId,
                  hostLoginUid: playerIsHost
                    ? identity.playerId
                    : identity.opponentId,
                  guestLoginUid: playerIsHost
                    ? identity.opponentId
                    : identity.playerId,
                },
              },
            },
          },
        };
        expect(await loadEndedMatchResults(event, rating)).toEqual({
          "round:0:0_0":
            expectedPlayer === undefined || expectedOpponent === undefined
              ? { status: "unavailable" }
              : {
                  status: "scored",
                  hostScore: playerIsHost ? expectedPlayer : expectedOpponent,
                  guestScore: playerIsHost ? expectedOpponent : expectedPlayer,
                },
        });
      }
    },
  );

  it.each(ratingDiscoveryCases)(
    "discovers only due $field metadata with indexed reads",
    async ({ list, field, prefix }) => {
      const archive = "retained-match-payload-".repeat(5_000);
      for (const [operationId, timestamp, state, version] of [
        ["tie-b", 2_000, "pending", 3],
        ["future", 2_001, "pending", 1],
        ["first", 1_500, "pending", null],
        ["tie-a", 2_000, "pending", 0],
        ["done", 1_000, "done", 1],
        ["dead", 1_000, "dead", 1],
        ["unmarked", 1_000, null, null],
        ["processing", 1_800, "pending", 1],
      ] as const) {
        await insertProjectionRating(operationId, {
          inviteId: " projection-invite ",
          matchId: " projection-match ",
          payload: { eventId: " \u2003projection-event\u00a0", archive },
          [`${field}State`]: state,
          [`${field}UpdatedAtMs`]: timestamp,
          [`${field}Version`]: version,
          ...(operationId === "processing"
            ? { status: "processing", completedAtMs: null }
            : {}),
        });
      }
      const observed = observeRatingDiscovery(testEnv.PROFILE_DB);
      const rating = projectionRatingRepository(observed.database);
      const expected = [
        ["first", 0],
        ["processing", 1],
        ["tie-a", 0],
        ["tie-b", 3],
      ].map(([operationId, version]) => ({
        operationId,
        updateTime: "1",
        ...(field === "telegramProjection"
          ? {}
          : {
              inviteId: " projection-invite ",
              matchId: " projection-match ",
              version,
            }),
        ...(field === "eventProgress" ? { eventId: "projection-event" } : {}),
      }));
      await expect(rating[list](2_000, 10)).resolves.toEqual(expected);
      expect(observed.queries).toHaveLength(1);
      expect(observed.reads).toHaveLength(1);
      const read = observed.reads[0];
      expect(read.rowsWritten).toBe(0);
      expect(read.rows).toHaveLength(4);
      for (const row of read.rows) {
        expect(row).not.toHaveProperty("payload_json");
        expect(row).not.toHaveProperty("owner_token");
      }
      expect(JSON.stringify(read.rows)).not.toContain(archive);
      expect(JSON.stringify(read.rows).length).toBeLessThan(2_000);
      const plan = await testEnv.PROFILE_DB.prepare(
        `EXPLAIN QUERY PLAN ${read.query}`,
      )
        .bind(...read.bindings)
        .all<{ detail: string }>();
      expect(plan.results.map((row) => row.detail).join("\n")).toContain(
        `USING INDEX idx_rating_updates_${prefix}`,
      );
      await expect(rating[list](2_000, 1)).resolves.toEqual(
        expected.slice(0, 1),
      );
      await expect(rating[list](1_999, 100)).resolves.toEqual(
        expected.slice(0, 2),
      );
      await expect(rating[list](0, 100)).resolves.toEqual([]);
    },
  );

  it("caps each rating discovery page at the maximum requested limit", async () => {
    for (let index = 0; index < 101; index++) {
      await insertProjectionRating(`limit-${String(index).padStart(3, "0")}`);
    }
    const rating = projectionRatingRepository();
    for (const { list } of ratingDiscoveryCases) {
      const page = await rating[list](2_000, 100);
      expect(page).toHaveLength(100);
      expect(page[0].operationId).toBe("limit-000");
      expect(page.at(-1)?.operationId).toBe("limit-099");
    }
  });

  it.each(ratingDiscoveryCases)(
    "rejects invalid $field discovery bounds before querying",
    async ({ list }) => {
      const observed = observeRatingDiscovery(testEnv.PROFILE_DB);
      const rating = projectionRatingRepository(observed.database);
      for (const [cutoff, limit] of [
        [-1, 10],
        [1.5, 10],
        [NaN, 10],
        [Number.MAX_SAFE_INTEGER + 1, 10],
        [2_000, 0],
        [2_000, 101],
        [2_000, 1.5],
        [2_000, Infinity],
      ]) {
        await expect(rating[list](cutoff, limit)).rejects.toThrow(
          "invalid-rating-projection-list",
        );
      }
      expect(observed.queries).toEqual([]);
    },
  );

  it("keeps JSON event ID string and last-duplicate-key semantics", async () => {
    const payloads = [
      "{}",
      '{"eventId":null}',
      '{"eventId":12}',
      '{"eventId":true}',
      '{"eventId":[]}',
      '{"eventId":{"nested":"value"}}',
      JSON.stringify({ eventId: " \t\n " }),
      JSON.stringify({ eventId: "\ufeff\u2003event-雪\u00a0" }),
      JSON.stringify({ eventId: "event-\ud83d\ude00" }),
      JSON.stringify({ eventId: "event\u0000suffix" }),
      '{"eventId":"first","eventId":" last "}',
      '{"eventId":"\\ud800","eventId":"last"}',
      '{"eventId":"first","event\\u0049d":"last"}',
      '{"eventId\\u0000suffix":"wrong"}',
      '{"eventId":"right","eventId\\u0000suffix":"wrong"}',
      '{"eventId\\u0000suffix":"wrong","eventId":"right"}',
      '{"eventId":"first","eventId":null}',
      '{"eventId":"first","eventId":12}',
      '{"eventId":"first","eventId":true}',
      '{"eventId":"first","eventId":[]}',
      '{"eventId":"first","eventId":{}}',
      '{"nested":{"eventId":"nested"},"eventId":"root"}',
    ];
    for (const [index, payload] of payloads.entries()) {
      const operationId = `event-id-${String(index).padStart(2, "0")}`;
      await insertProjectionRating(operationId);
      await testEnv.PROFILE_DB.prepare(
        "UPDATE rating_updates SET payload_json = ? WHERE operation_id = ?",
      )
        .bind(payload, operationId)
        .run();
    }
    const records =
      await projectionRatingRepository().listDueRatingEventProgress(2_000, 100);
    expect(records.map((record) => record.eventId)).toEqual(
      payloads.map((payload) => {
        const value = JSON.parse(payload).eventId;
        return typeof value === "string" ? value.trim() : "";
      }),
    );
  });

  it.each([
    '{"eventId":"\\ud800"}',
    '{"eventId":"\\udfff"}',
    '{"eventId":"first","eventId":"\\ud800"}',
  ])(
    "rejects invalid Unicode event IDs before claiming: %s",
    async (payload) => {
      const operationId = "invalid-unicode-event";
      await insertProjectionRating(operationId);
      await testEnv.PROFILE_DB.prepare(
        "UPDATE rating_updates SET payload_json = ? WHERE operation_id = ?",
      )
        .bind(payload, operationId)
        .run();
      const observed = observeD1FailureDatabase(testEnv.PROFILE_DB);
      await expect(
        projectionRatingRepository(
          observed.database,
        ).listDueRatingEventProgress(2_000, 100),
      ).rejects.toBeInstanceOf(CanonicalProfileCorruption);
      expect(observed.batches).toEqual([]);
      await expect(
        testEnv.PROFILE_DB.prepare(
          "SELECT revision FROM rating_updates WHERE operation_id = ?",
        )
          .bind(operationId)
          .first<number>("revision"),
      ).resolves.toBe(1);
    },
  );

  it.each(ratingDiscoveryCases)(
    "rejects malformed selected $field discovery metadata",
    async ({ list, prefix, field }) => {
      const operationId = "invalid-discovery-metadata";
      await insertProjectionRating(operationId);
      const columns = [
        "revision",
        ...(field === "telegramProjection" ? [] : [`${prefix}_version`]),
      ];
      for (const column of columns) {
        for (const value of [1.5, Number.MAX_SAFE_INTEGER + 1]) {
          await testEnv.PROFILE_DB.prepare(
            `UPDATE rating_updates SET ${column} = ? WHERE operation_id = ?`,
          )
            .bind(value, operationId)
            .run();
          await expect(
            projectionRatingRepository()[list](2_000, 10),
          ).rejects.toBeInstanceOf(CanonicalProfileCorruption);
        }
        await testEnv.PROFILE_DB.prepare(
          `UPDATE rating_updates SET ${column} = 1 WHERE operation_id = ?`,
        )
          .bind(operationId)
          .run();
      }
    },
  );

  it.each(ratingDiscoveryCases)(
    "validates unrelated corrupt rating fields before $field claims mutate",
    async ({ list, claim }) => {
      const operationId = "corrupt-rating-claim";
      await insertProjectionRating(operationId);
      await testEnv.PROFILE_DB.prepare(
        "UPDATE rating_updates SET lease_expires_at_ms = ? WHERE operation_id = ?",
      )
        .bind(Number.MAX_SAFE_INTEGER + 1, operationId)
        .run();
      const observed = observeD1FailureDatabase(testEnv.PROFILE_DB);
      const rating = projectionRatingRepository(observed.database);
      const records = await rating[list](2_000, 10);
      expect(records).toHaveLength(1);
      await expect(
        rating[claim](operationId, records[0].updateTime, 3_000),
      ).rejects.toBeInstanceOf(CanonicalProfileCorruption);
      expect(observed.batches).toEqual([]);
      await expect(
        testEnv.PROFILE_DB.prepare(
          "SELECT revision FROM rating_updates WHERE operation_id = ?",
        )
          .bind(operationId)
          .first<number>("revision"),
      ).resolves.toBe(1);
    },
  );

  it.each([
    {
      claim: "claimRatingEventProgress",
      mark: "markRatingEventProgress",
      prefix: "event_progress",
      field: "eventProgress",
    },
    {
      claim: "claimRatingProfileGameProjection",
      mark: "markRatingProfileGameProjection",
      prefix: "profile_game_projection",
      field: "profileGameProjection",
    },
    {
      claim: "claimRatingTelegramProjection",
      mark: "markRatingTelegramProjection",
      prefix: "telegram_projection",
      field: "telegramProjection",
    },
  ] as const)(
    "narrows $field writes while preserving the rating and other projections",
    async ({ claim, mark, prefix, field }) => {
      const operationId = `narrow-${prefix}`;
      const initial = await insertProjectionRating(operationId);
      const readRow = () =>
        testEnv.PROFILE_DB.prepare(
          "SELECT * FROM rating_updates WHERE operation_id = ?",
        )
          .bind(operationId)
          .first<Record<string, unknown>>();
      const original = await readRow();
      const queries: string[] = [];
      const db = beforeMatchingBatch(
        testEnv.PROFILE_DB,
        () => false,
        async () => {},
        (query) => queries.push(query),
      );
      const rating = projectionRatingRepository(db);
      await expect(rating[claim](operationId, "1", 3_000)).resolves.toBe(true);
      expect(await readRow()).toEqual({
        ...original,
        payload_json: JSON.stringify({
          ...initial.payload,
          [`${field}UpdatedAtMs`]: 3_000,
        }),
        [`${prefix}_updated_at_ms`]: 3_000,
        revision: 2,
      });
      await rating[mark](operationId, "dead", 4_000, "  failed delivery  ");
      expect(await readRow()).toEqual({
        ...original,
        payload_json: JSON.stringify({
          ...initial.payload,
          [`${field}State`]: "dead",
          [`${field}UpdatedAtMs`]: 4_000,
          [`${field}Reason`]: "failed delivery",
        }),
        [`${prefix}_state`]: "dead",
        [`${prefix}_updated_at_ms`]: 4_000,
        revision: 3,
      });
      await rating[mark](operationId, "done", 5_000, "  ");
      expect(await readRow()).toEqual({
        ...original,
        payload_json: JSON.stringify({
          ...initial.payload,
          [`${field}State`]: "done",
          [`${field}UpdatedAtMs`]: 5_000,
          [`${field}Reason`]: null,
        }),
        [`${prefix}_state`]: "done",
        [`${prefix}_updated_at_ms`]: 5_000,
        revision: 4,
      });
      const updates = queries.filter((query) =>
        /^\s*UPDATE rating_updates\b/.test(query),
      );
      expect(updates).toHaveLength(3);
      for (const update of updates) {
        const assignments = update.split("SET")[1].split("WHERE")[0];
        expect(
          assignments.split(",").map((value) => value.split("=")[0].trim()),
        ).toEqual([
          "payload_json",
          `${prefix}_state`,
          `${prefix}_updated_at_ms`,
          `${prefix}_version`,
          "revision",
        ]);
      }
      expect(
        queries.filter((query) =>
          /^\s*SELECT \* FROM rating_updates\b/.test(query),
        ),
      ).toHaveLength(3);
    },
  );

  it("keeps projection preflight misses and missing mark errors unchanged", async () => {
    const operationId = "projection-preflight";
    await insertProjectionRating(operationId);
    const observed = observeD1FailureDatabase(testEnv.PROFILE_DB);
    const rating = projectionRatingRepository(observed.database);
    for (const revision of ["", "0", "01", "1.5", "9007199254740992", "2"]) {
      await expect(
        rating.claimRatingEventProgress(operationId, revision, 3_000),
      ).resolves.toBe(false);
    }
    await expect(
      rating.claimRatingEventProgress("missing", "1", 3_000),
    ).resolves.toBe(false);
    await expect(
      rating.markRatingEventProgress("missing", "done", 3_000),
    ).rejects.toThrow("rating-operation-missing");
    expect(observed.batches).toHaveLength(0);
  });

  it.each(["claim", "mark"] as const)(
    "preserves global revision conflicts during projection %s",
    async (operation) => {
      const operationId = `projection-revision-${operation}`;
      await insertProjectionRating(operationId);
      const observed = observeD1FailureDatabase(testEnv.PROFILE_DB, {
        async beforeBatch(attempt) {
          if (attempt !== 1) return;
          await projectionRatingRepository().markRatingTelegramProjection(
            operationId,
            "done",
            2_500,
            "concurrent delivery",
          );
        },
      });
      const rating = projectionRatingRepository(observed.database);
      if (operation === "claim") {
        await expect(
          rating.claimRatingEventProgress(operationId, "1", 3_000),
        ).resolves.toBe(false);
      } else {
        await rating.markRatingEventProgress(operationId, "done", 3_000);
      }
      expect(observed.errors).toHaveLength(1);
      expect(observed.batches).toHaveLength(operation === "claim" ? 1 : 2);
      const row = await testEnv.PROFILE_DB.prepare(
        "SELECT payload_json, revision FROM rating_updates WHERE operation_id = ?",
      )
        .bind(operationId)
        .first<{ payload_json: string; revision: number }>();
      expect(row?.revision).toBe(operation === "claim" ? 2 : 3);
      expect(JSON.parse(row?.payload_json || "{}")).toMatchObject({
        eventProgressState: operation === "claim" ? "pending" : "done",
        eventProgressUpdatedAtMs: operation === "claim" ? 2_000 : 3_000,
        telegramProjectionState: "done",
        telegramProjectionUpdatedAtMs: 2_500,
        telegramProjectionReason: "concurrent delivery",
      });
    },
  );

  it("exhausts projection mark retries without hiding revision conflicts", async () => {
    const operationId = "projection-retry-limit";
    await insertProjectionRating(operationId);
    const observed = observeD1FailureDatabase(testEnv.PROFILE_DB, {
      async beforeBatch() {
        await testEnv.PROFILE_DB.prepare(
          "UPDATE rating_updates SET revision = revision + 1 WHERE operation_id = ?",
        )
          .bind(operationId)
          .run();
      },
    });
    await expect(
      projectionRatingRepository(observed.database).markRatingEventProgress(
        operationId,
        "done",
        3_000,
      ),
    ).rejects.toBeInstanceOf(CanonicalProfileConflict);
    expect(observed.batches).toHaveLength(2);
    expect(
      await projectionRatingRepository().readRatingUpdate(operationId),
    ).toMatchObject({ eventProgressState: "pending" });
  });

  it.each(["normalization", "invalid payload"] as const)(
    "preserves legacy projection %s through the full-write fallback",
    async (mode) => {
      const operationId = `projection-legacy-${mode}`;
      const initial = await insertProjectionRating(operationId);
      const payload = { ...initial.payload };
      delete payload.telegramProjectionState;
      if (mode === "invalid payload") delete payload.inviteId;
      await testEnv.PROFILE_DB.prepare(
        "UPDATE rating_updates SET payload_json = ? WHERE operation_id = ?",
      )
        .bind(JSON.stringify(payload), operationId)
        .run();
      const queries: string[] = [];
      const db = beforeMatchingBatch(
        testEnv.PROFILE_DB,
        () => false,
        async () => {},
        (query) => queries.push(query),
      );
      const result = projectionRatingRepository(db).markRatingEventProgress(
        operationId,
        "done",
        3_000,
      );
      if (mode === "invalid payload") {
        await expect(result).rejects.toBeInstanceOf(CanonicalProfileCorruption);
      } else {
        await result;
      }
      expect(
        queries.find((query) => /^\s*UPDATE rating_updates\b/.test(query)),
      ).toContain("invite_id = ?");
      const row = await testEnv.PROFILE_DB.prepare(
        "SELECT telegram_projection_state, event_progress_state, revision FROM rating_updates WHERE operation_id = ?",
      )
        .bind(operationId)
        .first();
      expect(row).toEqual(
        mode === "invalid payload"
          ? {
              telegram_projection_state: "pending",
              event_progress_state: "pending",
              revision: 1,
            }
          : {
              telegram_projection_state: null,
              event_progress_state: "done",
              revision: 2,
            },
      );
    },
  );

  it.each(["claim", "mark"] as const)(
    "retains frozen-control failures for projection %s",
    async (operation) => {
      const operationId = `projection-frozen-${operation}`;
      await insertProjectionRating(operationId);
      const observed = observeD1FailureDatabase(testEnv.PROFILE_DB, {
        async beforeBatch() {
          await testEnv.PROFILE_DB.prepare(
            "UPDATE profile_canonical_control SET state = 'frozen' WHERE singleton = 1",
          ).run();
        },
      });
      const rating = projectionRatingRepository(observed.database);
      try {
        await expect(
          operation === "claim"
            ? rating.claimRatingEventProgress(operationId, "1", 3_000)
            : rating.markRatingEventProgress(operationId, "done", 3_000),
        ).rejects.toBeInstanceOf(ProfileWritesDisabledFailure);
        expect(observed.batches).toHaveLength(1);
        expect(observed.sessions).toEqual(["first-primary"]);
        expect(await rating.readRatingUpdate(operationId)).toMatchObject({
          eventProgressState: "pending",
          eventProgressUpdatedAtMs: 2_000,
        });
      } finally {
        await testEnv.PROFILE_DB.prepare(
          "UPDATE profile_canonical_control SET state = 'active' WHERE singleton = 1",
        ).run();
      }
    },
  );

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
      stateClient: matchTestPort(state),
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

  it("rebuilds a rating plan after a profile edit and preserves sparse legacy fields", async () => {
    const profileId = "d1-edit-player";
    await insertProfile(
      profileId,
      "d1-edit-player-login",
      {},
      { nonce: false, mp: false, dust: false, slime: false },
      false,
      false,
      "",
    );
    await insertProfile("d1-edit-opponent", "d1-edit-opponent-login");
    const gameplay = createGameplayRepository(testEnv, {
      stateClient: matchTestPort(state),
    });
    const identity = {
      inviteId: "d1-edit-invite",
      matchId: "d1-edit-match",
      playerId: "d1-edit-player-login",
      opponentId: "d1-edit-opponent-login",
    };
    const operationId = `${identity.inviteId}__${identity.matchId}`;
    const baseRating = createRatingRepository(testEnv, gameplay, {
      now: () => 3_000,
    });
    await baseRating.tryAcquireRatingLease({
      ...identity,
      ownerUid: identity.playerId,
      ownerToken: "d1-edit-owner",
      leaseMs: 30_000,
    });
    const racedDb = beforeMatchingBatch(
      testEnv.PROFILE_DB,
      (queries) =>
        queries.some((query) => query.includes("UPDATE rating_updates")),
      async () => {
        const current = await readCanonicalProfile(
          testEnv.PROFILE_DB,
          profileId,
        );
        if (!current) throw new Error("missing-edited-profile");
        await commitCanonicalPlan(testEnv.PROFILE_DB, {
          expectations: [
            {
              kind: "profile-revision",
              profileId,
              revision: current.revision,
            },
          ],
          mutations: [
            {
              kind: "update-active-profile",
              value: materializeCanonicalProfile({
                ...current,
                profile: {
                  ...current.profile,
                  rating: 1700,
                  username: "EditedName",
                  completedProblemIds: ["edited-problem"],
                  mining: {
                    lastRockDate: "2026-08-29",
                    materials: {
                      dust: 0,
                      slime: 0,
                      gum: 33,
                      metal: 34,
                      ice: 35,
                    },
                  },
                },
                updatedAtMs: 2_500,
                legacyFields: { imported: { untouched: [1, "two", null] } },
                sortValues: {
                  ...current.sortValues,
                  rating: 1700,
                  gum: 33,
                  metal: 34,
                  ice: 35,
                },
              }),
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
    const seenRatings: number[] = [];
    await expect(
      rating.finalizeRatingUpdate(
        { ...identity, operationId, ownerToken: "d1-edit-owner" },
        (playerValue, opponentValue) => {
          if (!playerValue || !opponentValue)
            throw new Error("missing-rating-player");
          seenRatings.push(playerValue.rating);
          return {
            playerUpdate: { rating: playerValue.rating + 1 },
            opponentUpdate: null,
            repairData: {
              playerProfileId: playerValue.profileId,
              opponentProfileId: opponentValue.profileId,
              shouldUpdateFebruaryChallenge: false,
            },
            ratingUpdate: {
              status: "done",
              playerProfileId: playerValue.profileId,
              opponentProfileId: opponentValue.profileId,
              shouldUpdateFebruaryChallenge: false,
              completedAtMs: 3_000,
              updatedAtMs: 3_000,
              leaseExpiresAtMs: 3_000,
            },
          };
        },
      ),
    ).resolves.toMatchObject({ status: "committed" });
    expect(seenRatings).toEqual([1500, 1700]);
    expect(
      await readCanonicalProfile(testEnv.PROFILE_DB, profileId),
    ).toMatchObject({
      revision: 3,
      createdAtMs: 1_000,
      updatedAtMs: 3_000,
      profile: {
        rating: 1701,
        username: "EditedName",
        completedProblemIds: ["edited-problem"],
        mining: {
          lastRockDate: "2026-08-29",
          materials: { dust: 0, slime: 0, gum: 33, metal: 34, ice: 35 },
        },
      },
      sortPresence: {
        rating: true,
        nonce: false,
        mp: false,
        dust: false,
        slime: false,
      },
      sortValues: {
        rating: 1701,
        nonce: null,
        mp: null,
        dust: null,
        slime: null,
      },
      winPresent: false,
      emojiPresent: false,
      gameplayEmoji: "",
      legacyFields: { imported: { untouched: [1, "two", null] } },
    });
  });

  it("combines rating patches into one write when both logins share a profile", async () => {
    const profileId = "d1-shared-profile";
    const identity = {
      inviteId: "d1-shared-invite",
      matchId: "d1-shared-match",
      playerId: "d1-shared-player-login",
      opponentId: "d1-shared-opponent-login",
    };
    await insertProfile(profileId, identity.playerId);
    await commitCanonicalPlan(testEnv.PROFILE_DB, {
      expectations: [
        { kind: "login-owner-absent", loginUid: identity.opponentId },
      ],
      mutations: [
        {
          kind: "insert-login-owner",
          value: {
            loginUid: identity.opponentId,
            profileId,
            createdAtMs: 1_000,
            updatedAtMs: 1_000,
          },
        },
      ],
    });
    const gameplay = createGameplayRepository(testEnv, {
      stateClient: matchTestPort(state),
    });
    const baseRating = createRatingRepository(testEnv, gameplay, {
      now: () => 2_000,
    });
    await baseRating.tryAcquireRatingLease({
      ...identity,
      ownerUid: identity.playerId,
      ownerToken: "d1-shared-owner",
      leaseMs: 30_000,
    });
    const profileWrites: string[] = [];
    const observedDb = beforeMatchingBatch(
      testEnv.PROFILE_DB,
      (queries) => {
        profileWrites.push(
          ...queries.filter((query) =>
            /UPDATE profile_records\s+SET/.test(query),
          ),
        );
        return false;
      },
      async () => {},
    );
    const rating = createCanonicalRatingRepository(observedDb, gameplay, {
      createFailure: () => new Error("rating-unavailable"),
      maxAttempts: 5,
      now: () => 2_000,
    });
    let plans = 0;
    await expect(
      rating.finalizeRatingUpdate(
        {
          ...identity,
          operationId: `${identity.inviteId}__${identity.matchId}`,
          ownerToken: "d1-shared-owner",
        },
        (playerValue, opponentValue) => {
          plans++;
          expect(playerValue).toMatchObject({
            profileId,
            rating: 1500,
            nonce: 1,
            totalManaPoints: 5,
          });
          expect(opponentValue).toEqual(playerValue);
          return {
            playerUpdate: { rating: 1510, nonce: 2, totalManaPoints: 8 },
            opponentUpdate: { rating: 1490, win: false },
            repairData: {
              playerProfileId: profileId,
              opponentProfileId: profileId,
              shouldUpdateFebruaryChallenge: false,
            },
            ratingUpdate: {
              status: "done",
              playerProfileId: profileId,
              opponentProfileId: profileId,
              shouldUpdateFebruaryChallenge: false,
              completedAtMs: 2_000,
              updatedAtMs: 2_000,
              leaseExpiresAtMs: 2_000,
            },
          };
        },
      ),
    ).resolves.toMatchObject({ status: "committed" });
    expect(plans).toBe(1);
    expect(profileWrites).toHaveLength(1);
    expect(
      await readCanonicalProfile(testEnv.PROFILE_DB, profileId),
    ).toMatchObject({
      revision: 2,
      profile: { rating: 1490, nonce: 2, totalManaPoints: 8, win: false },
      sortValues: { rating: 1490, nonce: 2, mp: 8 },
    });
  });

  it("retries rating finalization when a missing login is created", async () => {
    await insertProfile("d1-created-opponent", "d1-created-opponent-login");
    const gameplay = createGameplayRepository(testEnv, {
      stateClient: matchTestPort(state),
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
      stateClient: matchTestPort(state),
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
      stateClient: matchTestPort(state),
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

  it("feeds profile projection from canonical D1", async () => {
    await insertProfile("d1-project-host", "d1-project-login-host", {
      username: "D1Host",
      emoji: 7,
    });
    await insertProfile("d1-project-guest", "d1-project-login-guest", {
      username: "D1Guest",
      emoji: 9,
    });
    stateValues.set("invites/auto_bbbbbbbbbbb", {
      hostId: "d1-project-login-host",
      guestId: "d1-project-login-guest",
    });
    stateValues.set("players/d1-project-login-host/profile", "d1-project-host");
    stateValues.set(
      "players/d1-project-login-guest/profile",
      "d1-project-guest",
    );
    const runtime = createProfileGameProjectionRuntime(testEnv, {
      profileDb: testEnv.PROFILE_DB,
      d1: testEnv.PROFILE_GAMES_DB,
      state: {
        readInviteMetadata: async (inviteId) =>
          (stateValues.get(`invites/${inviteId}`) ?? null) as Record<
            string,
            unknown
          > | null,
        readAutomatchEntry: async (inviteId) =>
          stateValues.get(`automatch/${inviteId}`) ?? null,
      },
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
  });
});
