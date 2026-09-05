import { env } from "cloudflare:workers";
import type { D1Migration } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { readRatingCompletion } from "../src/ratingCompletionD1.ts";
import {
  createGameplayRepository,
  createRatingRepository,
} from "../src/gameplayRepository.ts";
import { applyRetiredProfileMigrations } from "./profileTestMigrations.ts";

const testEnv = env as Env & { TEST_PROFILE_D1_MIGRATIONS: D1Migration[] };

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
      { activateRatingCompletions: false },
    );
    await applyRetiredProfileMigrations(
      testEnv.PROFILE_GAMES_DB,
      testEnv.TEST_PROFILE_D1_MIGRATIONS,
      "b".repeat(64),
      { activateRatingCompletions: false },
    );
    await testEnv.PROFILE_DB.prepare(
      "UPDATE profile_canonical_control SET state = 'frozen' WHERE singleton = 1",
    ).run();
    await testEnv.PROFILE_DB.prepare(
      "UPDATE rating_completion_control SET source_digest = ?, source_count = 1 WHERE singleton = 1",
    )
      .bind("c".repeat(64))
      .run();
    await testEnv.PROFILE_DB.prepare(
      "INSERT INTO legacy_rating_completions (invite_id, match_id, imported_at_ms) VALUES ('legacy-invite', 'legacy-match', 1)",
    ).run();
    await testEnv.PROFILE_DB.prepare(
      "UPDATE rating_completion_control SET activated_at_ms = 2 WHERE singleton = 1",
    ).run();
    await testEnv.PROFILE_DB.prepare(
      "UPDATE profile_canonical_control SET state = 'active' WHERE singleton = 1",
    ).run();
  });

  it("refuses completion checks before the legacy import is activated", async () => {
    await insertRating(
      "unactivated",
      "unactivated",
      "done",
      undefined,
      testEnv.PROFILE_GAMES_DB,
    );
    await expect(
      readRatingCompletion(
        testEnv.PROFILE_GAMES_DB,
        "unactivated",
        "unactivated",
      ),
    ).rejects.toMatchObject({
      status: 503,
      message: "rating-completions-unavailable",
    });
    await expect(
      readRatingCompletion(testEnv.PROFILE_GAMES_DB, "missing", "missing"),
    ).rejects.toMatchObject({ status: 503 });
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
      testEnv,
      createGameplayRepository(testEnv),
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
    const rating = createRatingRepository(testEnv, gameplay);
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

  it("blocks legacy evidence edits and imports after activation", async () => {
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
          "UPDATE rating_completion_control SET activated_at_ms = NULL WHERE singleton = 1",
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
  });
});
