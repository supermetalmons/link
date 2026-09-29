import { createEventProgressOutboxWriter } from "../src/eventRepository.ts";
import { env } from "cloudflare:workers";
import type { D1Migration } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import {
  readRatingCompletion,
  readRatingLeaseSnapshot,
} from "../src/ratingCompletionD1.ts";
import { createGameplayRepository } from "../src/gameplayRepository.ts";
import { createRatingRepository } from "../src/ratingRepository.ts";
import { CanonicalProfileCorruption } from "../src/profileCanonical/types.ts";
import { applyRetiredProfileMigrations } from "./profileTestMigrations.ts";

const testEnv = env as Env & { TEST_PROFILE_D1_MIGRATIONS: D1Migration[] };

function ratingRepository(db = testEnv.PROFILE_DB, nowMs = 5) {
  return createRatingRepository(
    db,
    createGameplayRepository(testEnv),
    createEventProgressOutboxWriter(testEnv.EVENT_DB),
    { now: () => nowMs },
  );
}

function leaseRequest(inviteId: string, matchId: string) {
  return {
    inviteId,
    matchId,
    playerId: "player",
    opponentId: "opponent",
    ownerUid: "player",
    ownerToken: "new-owner",
    leaseMs: 30_000,
  };
}

function databaseReturningRow(row: unknown): D1Database {
  return {
    prepare: () => ({
      bind: () => ({ first: async () => row }),
    }),
  } as unknown as D1Database;
}

async function insertRating(
  inviteId: string,
  matchId: string,
  status: "processing" | "done",
  operationId = `${inviteId}__${matchId}`,
  db = testEnv.PROFILE_DB,
) {
  await db
    .prepare(
      `INSERT INTO rating_updates (
       operation_id, payload_json, status, invite_id, match_id,
       player_id, opponent_id, owner_uid, owner_token,
       started_at_ms, updated_at_ms, lease_expires_at_ms, completed_at_ms
     ) VALUES (?, '{}', ?, ?, ?, 'player', 'opponent', 'player', 'owner', 1, 2, 10, ?)`,
    )
    .bind(operationId, status, inviteId, matchId, status === "done" ? 2 : null)
    .run();
}

describe("D1 rating completion evidence", () => {
  beforeAll(async () => {
    await applyRetiredProfileMigrations(
      testEnv.PROFILE_DB,
      testEnv.TEST_PROFILE_D1_MIGRATIONS,
      "a".repeat(64),
      {
        legacyRatingCompletions: [
          { inviteId: "legacy-invite", matchId: "legacy-match" },
          { inviteId: "single-legacy", matchId: "match" },
          { inviteId: "single-legacy-processing", matchId: "match" },
          { inviteId: "legacy-mismatch", matchId: "match" },
        ],
      },
    );
  });

  it("uses permanent completion data without migration controls", async () => {
    expect(
      await testEnv.PROFILE_DB.prepare(
        "SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = 'rating_completion_control'",
      ).first("count"),
    ).toBe(0);
    expect(
      await readRatingCompletion(testEnv.PROFILE_DB, "missing", "missing"),
    ).toBe(false);
  });

  it("recognizes committed ratings, but not processing or absent ratings", async () => {
    await insertRating("done-invite", "done-match", "done");
    await insertRating("pending-invite", "pending-match", "processing");
    expect(
      await readRatingCompletion(
        testEnv.PROFILE_DB,
        "done-invite",
        "done-match",
      ),
    ).toBe(true);
    expect(
      await readRatingCompletion(
        testEnv.PROFILE_DB,
        "pending-invite",
        "pending-match",
      ),
    ).toBe(false);
    expect(
      await readRatingCompletion(
        testEnv.PROFILE_DB,
        "absent-invite",
        "absent-match",
      ),
    ).toBe(false);
  });

  it.each([
    { kind: "fresh", stored: null, expected: "acquired" },
    { kind: "done", stored: "done", expected: "done" },
    { kind: "busy", stored: "processing", expected: "busy" },
    { kind: "same-owner", stored: "processing", expected: "acquired" },
    { kind: "expired", stored: "processing", expected: "acquired" },
    { kind: "legacy", stored: null, expected: "done" },
    { kind: "legacy-processing", stored: "processing", expected: "done" },
  ] as const)(
    "reads one initial snapshot for a $kind rating lease",
    async ({ kind, stored, expected }) => {
      const inviteId = `single-${kind}`;
      if (stored) await insertRating(inviteId, "match", stored);
      const queries: string[] = [];
      let writeBatches = 0;
      const db = new Proxy(testEnv.PROFILE_DB, {
        get(target, property) {
          if (property === "prepare") {
            return (query: string) => {
              queries.push(query);
              return target.prepare(query);
            };
          }
          if (property === "batch") {
            return (statements: D1PreparedStatement[]) => {
              writeBatches++;
              return target.batch(statements);
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const request = leaseRequest(inviteId, "match");
      if (kind === "same-owner") request.ownerToken = "owner";
      const result = await ratingRepository(
        db,
        kind === "expired" ? 20 : 5,
      ).tryAcquireRatingLease(request);
      expect(result.status).toBe(expected);
      if (stored) expect(result.data?.status).toBe(stored);
      else expect(result.data).toBeNull();
      expect(
        queries.filter((query) => /^\s*SELECT\b/.test(query)),
      ).toHaveLength(1);
      expect(writeBatches).toBe(expected === "acquired" ? 1 : 0);
      const durable = await testEnv.PROFILE_DB.prepare(
        "SELECT status, owner_token, revision FROM rating_updates WHERE operation_id = ?",
      )
        .bind(`${inviteId}__match`)
        .first();
      if (expected === "acquired") {
        expect(durable).toEqual({
          status: "processing",
          owner_token: request.ownerToken,
          revision: stored ? 2 : 1,
        });
      } else if (stored) {
        expect(durable).toEqual({
          status: stored,
          owner_token: "owner",
          revision: 1,
        });
      } else expect(durable).toBeNull();
    },
  );

  it("rejects mismatched rating identity even when legacy completion exists", async () => {
    await insertRating(
      "actual-invite",
      "actual-match",
      "processing",
      "legacy-mismatch__match",
    );
    await expect(
      ratingRepository().tryAcquireRatingLease(
        leaseRequest("legacy-mismatch", "match"),
      ),
    ).rejects.toThrow("gameplay-repository-unavailable");
  });

  it("matches the operation, invite, and match together", async () => {
    await insertRating(
      "actual-invite",
      "actual-match",
      "done",
      "requested-invite__requested-match",
    );
    expect(
      await readRatingCompletion(
        testEnv.PROFILE_DB,
        "requested-invite",
        "requested-match",
      ),
    ).toBe(false);
    expect(
      await readRatingCompletion(
        testEnv.PROFILE_DB,
        "actual-invite",
        "actual-match",
      ),
    ).toBe(false);
    const rating = createRatingRepository(
      testEnv.PROFILE_DB,
      createGameplayRepository(testEnv),
      createEventProgressOutboxWriter(testEnv.EVENT_DB),
    );
    await expect(
      rating.tryAcquireRatingLease({
        inviteId: "requested-invite",
        matchId: "requested-match",
        playerId: "player",
        opponentId: "opponent",
        ownerUid: "player",
        ownerToken: "new-owner",
        leaseMs: 30_000,
      }),
    ).rejects.toThrow("gameplay-repository-unavailable");
  });

  it("preserves marker-only legacy matches without allowing a new rating lease", async () => {
    expect(
      await readRatingCompletion(
        testEnv.PROFILE_DB,
        "legacy-invite",
        "legacy-match",
      ),
    ).toBe(true);
    expect(
      await readRatingCompletion(
        testEnv.PROFILE_DB,
        "legacy-invite",
        "another-match",
      ),
    ).toBe(false);
    const gameplay = createGameplayRepository(testEnv);
    const rating = createRatingRepository(
      testEnv.PROFILE_DB,
      gameplay,
      createEventProgressOutboxWriter(testEnv.EVENT_DB),
    );
    await expect(
      rating.tryAcquireRatingLease({
        inviteId: "legacy-invite",
        matchId: "legacy-match",
        playerId: "player",
        opponentId: "opponent",
        ownerUid: "player",
        ownerToken: "new-owner",
        leaseMs: 30_000,
      }),
    ).resolves.toEqual({ status: "done", data: null });
    expect(
      await testEnv.PROFILE_DB.prepare(
        "SELECT COUNT(*) AS count FROM rating_updates WHERE invite_id = 'legacy-invite'",
      ).first("count"),
    ).toBe(0);
  });

  it("keeps historical completion records immutable after finalization", async () => {
    await testEnv.PROFILE_DB.prepare(
      "UPDATE profile_canonical_control SET state = 'frozen' WHERE singleton = 1",
    ).run();
    try {
      await expect(
        testEnv.PROFILE_DB.prepare(
          "DELETE FROM legacy_rating_completions WHERE invite_id = 'legacy-invite'",
        ).run(),
      ).rejects.toThrow();
      await expect(
        testEnv.PROFILE_DB.prepare(
          "INSERT INTO legacy_rating_completions (invite_id, match_id, imported_at_ms) VALUES ('extra', 'extra', 3)",
        ).run(),
      ).rejects.toThrow();
      await expect(
        testEnv.PROFILE_DB.prepare(
          "UPDATE legacy_rating_completions SET imported_at_ms = 3 WHERE invite_id = 'legacy-invite'",
        ).run(),
      ).rejects.toThrow();
    } finally {
      await testEnv.PROFILE_DB.prepare(
        "UPDATE profile_canonical_control SET state = 'active' WHERE singleton = 1",
      ).run();
    }
  });

  it("returns a sanitized unavailable failure when the database cannot be read", async () => {
    const failingDb = new Proxy(testEnv.PROFILE_DB, {
      get(target, property) {
        if (property === "prepare")
          return () => {
            throw new Error("private database details");
          };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await expect(
      readRatingCompletion(failingDb, "invite", "match"),
    ).rejects.toMatchObject({
      status: 503,
      message: "rating-completions-unavailable",
    });
    await expect(
      ratingRepository(failingDb).tryAcquireRatingLease(
        leaseRequest("invite", "match"),
      ),
    ).rejects.toMatchObject({
      status: 503,
      message: "rating-completions-unavailable",
    });
  });

  it.each([null, { operation_id: null, legacy_completed: 2 }])(
    "rejects malformed lease completion evidence without exposing details",
    async (row) => {
      await expect(
        readRatingLeaseSnapshot(databaseReturningRow(row), "invite", "match"),
      ).rejects.toMatchObject({
        status: 503,
        message: "rating-completions-unavailable",
      });
    },
  );

  it("preserves corruption failures when the stored rating cannot be decoded", async () => {
    await insertRating("corrupt-invite", "match", "processing");
    const row = await testEnv.PROFILE_DB.prepare(
      "SELECT * FROM rating_updates WHERE operation_id = 'corrupt-invite__match'",
    ).first<Record<string, unknown>>();
    const db = databaseReturningRow({
      ...row,
      payload_json: "[]",
      legacy_completed: 0,
    });
    await expect(
      ratingRepository(db).tryAcquireRatingLease(
        leaseRequest("corrupt-invite", "match"),
      ),
    ).rejects.toBeInstanceOf(CanonicalProfileCorruption);
  });
});
