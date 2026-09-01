import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import {
  commitProfileGameProjectionWrites,
  deleteD1NavigationGame,
  encodeProfileGameProjection,
  getProfileGameProjection,
  readProfileGamesPage,
} from "../src/profileGamesD1.ts";
import {
  HistoricalMatchConflict,
  readHistoricalMatchSnapshot,
  writeHistoricalMatchSnapshot,
} from "../src/historicalMatchesD1.ts";

const testEnv = env as Env & { TEST_D1_MIGRATIONS: D1Migration[] };

function gameData(
  inviteId: string,
  listSortAt: number,
  status: "active" | "waiting" = "waiting",
) {
  return {
    entityType: "game",
    inviteId,
    kind: "direct",
    status,
    sortBucket: status === "active" ? 40 : 30,
    listSortAt,
    updatedAt: listSortAt,
    hostLoginId: "host",
    guestLoginId: status === "active" ? "guest" : null,
    opponentProfileId: status === "active" ? "guest-profile" : null,
    opponentName: status === "active" ? "Guest" : null,
    opponentEmoji: status === "active" ? 7 : null,
    automatchStateHint: null,
    isPendingAutomatch: false,
  };
}

function historicalPair(matchId = "invite-1") {
  const match = {
    version: 2,
    color: "white" as const,
    emojiId: 1,
    aura: "",
    gameVariant: "Classic",
    fen: "fen",
    status: "surrendered",
    flatMovesString: "move",
    timer: "",
  };
  return {
    matchId,
    hostPlayerId: "host",
    guestPlayerId: "guest",
    hostMatch: match,
    guestMatch: { ...match, color: "black" as const, emojiId: 2 },
  };
}

describe("profile game projection D1 repository", () => {
  beforeAll(async () => {
    await applyD1Migrations(
      testEnv.PROFILE_GAMES_DB,
      testEnv.TEST_D1_MIGRATIONS,
    );
  });

  beforeEach(async () => {
    await env.PROFILE_GAMES_DB.prepare(
      "DELETE FROM profile_game_projections",
    ).run();
    await env.PROFILE_GAMES_DB.prepare(
      "DELETE FROM historical_match_pairs",
    ).run();
  });

  it("stores immutable historical matches with rating precedence", async () => {
    const pair = historicalPair();
    const first = await writeHistoricalMatchSnapshot(env.PROFILE_GAMES_DB, {
      archivedAtMs: 2_000,
      finalizedAtMs: 1_000,
      inviteId: "invite-1",
      pair,
      source: "backfill",
    });
    expect(first.revision).toBe(1);
    const reordered = {
      guestMatch: pair.guestMatch
        ? {
            timer: pair.guestMatch.timer,
            flatMovesString: pair.guestMatch.flatMovesString,
            status: pair.guestMatch.status,
            fen: pair.guestMatch.fen,
            gameVariant: pair.guestMatch.gameVariant,
            aura: pair.guestMatch.aura,
            emojiId: pair.guestMatch.emojiId,
            color: pair.guestMatch.color,
            version: pair.guestMatch.version,
          }
        : null,
      hostMatch: pair.hostMatch
        ? {
            timer: pair.hostMatch.timer,
            flatMovesString: pair.hostMatch.flatMovesString,
            status: pair.hostMatch.status,
            fen: pair.hostMatch.fen,
            gameVariant: pair.hostMatch.gameVariant,
            aura: pair.hostMatch.aura,
            emojiId: pair.hostMatch.emojiId,
            color: pair.hostMatch.color,
            version: pair.hostMatch.version,
          }
        : null,
      guestPlayerId: pair.guestPlayerId,
      hostPlayerId: pair.hostPlayerId,
      matchId: pair.matchId,
    };
    const replay = await writeHistoricalMatchSnapshot(env.PROFILE_GAMES_DB, {
      archivedAtMs: 2_000,
      finalizedAtMs: 1_000,
      inviteId: "invite-1",
      pair: reordered,
      source: "backfill",
    });
    expect(replay.revision).toBe(1);
    const rated = {
      ...pair,
      hostMatch: { ...pair.hostMatch!, status: "rated" },
    };
    const upgraded = await writeHistoricalMatchSnapshot(env.PROFILE_GAMES_DB, {
      archivedAtMs: 3_000,
      finalizedAtMs: 1_500,
      inviteId: "invite-1",
      pair: rated,
      source: "rating",
    });
    expect(upgraded.source).toBe("rating");
    expect(upgraded.revision).toBe(2);
    expect(upgraded.pair.hostMatch?.status).toBe("rated");
    const preserved = await writeHistoricalMatchSnapshot(env.PROFILE_GAMES_DB, {
      archivedAtMs: 4_000,
      finalizedAtMs: 2_000,
      inviteId: "invite-1",
      pair,
      source: "transition",
    });
    expect(preserved.source).toBe("rating");
    expect(preserved.pair.hostMatch?.status).toBe("rated");
  });

  it("rejects conflicting same-priority historical snapshots", async () => {
    const pair = historicalPair();
    await writeHistoricalMatchSnapshot(env.PROFILE_GAMES_DB, {
      archivedAtMs: 1_000,
      finalizedAtMs: 1_000,
      inviteId: "invite-1",
      pair,
      source: "transition",
    });
    await expect(
      writeHistoricalMatchSnapshot(env.PROFILE_GAMES_DB, {
        archivedAtMs: 2_000,
        finalizedAtMs: 1_000,
        inviteId: "invite-1",
        pair: {
          ...pair,
          hostMatch: { ...pair.hostMatch!, status: "different" },
        },
        source: "transition",
      }),
    ).rejects.toBeInstanceOf(HistoricalMatchConflict);
    expect(
      (
        await readHistoricalMatchSnapshot(
          env.PROFILE_GAMES_DB,
          "invite-1",
          "invite-1",
        )
      )?.pair.hostMatch?.status,
    ).toBe("surrendered");
  });

  it("normalizes numeric timestamps and upserts projection payloads", async () => {
    const data = gameData("invite-1", 1_000);
    data.updatedAt = 2_000.75;
    const encoded = encodeProfileGameProjection("profile-1", "invite-1", data);
    expect(encoded.updated_at_ms).toBe(2_000);

    await commitProfileGameProjectionWrites(env.PROFILE_GAMES_DB, [
      {
        type: "merge",
        profileId: "profile-1",
        projectionId: "invite-1",
        data,
      },
    ]);
    const projection = await getProfileGameProjection(
      env.PROFILE_GAMES_DB,
      "profile-1",
      "invite-1",
    );
    expect(projection?.data.updatedAt).toBe(2_000);
    expect(projection?.updateTime).toBe("1");

    await commitProfileGameProjectionWrites(env.PROFILE_GAMES_DB, [
      {
        type: "update",
        profileId: "profile-1",
        projectionId: "invite-1",
        data: gameData("invite-1", 3_000, "active"),
        updateTime: projection?.updateTime,
      },
    ]);
    expect(
      (
        await getProfileGameProjection(
          env.PROFILE_GAMES_DB,
          "profile-1",
          "invite-1",
        )
      )?.updateTime,
    ).toBe("2");
  });

  it("rejects projections without a stable list timestamp", () => {
    expect(() =>
      encodeProfileGameProjection("profile-1", "invite-1", {
        ...gameData("invite-1", 1_000),
        listSortAt: null,
      }),
    ).toThrow("invalid-profile-game-projection-list-sort");
    expect(() =>
      encodeProfileGameProjection("profile-1", "invite-1", {
        ...gameData("invite-1", 1_000),
        listSortAt: { timestamp: 1_000 },
      }),
    ).toThrow("invalid-profile-game-projection-list-sort");
  });

  it("uses stable keyset pagination for equal timestamps", async () => {
    await commitProfileGameProjectionWrites(
      env.PROFILE_GAMES_DB,
      ["invite-c", "invite-a", "invite-b"].map((projectionId) => ({
        type: "merge" as const,
        profileId: "profile-1",
        projectionId,
        data: gameData(projectionId, 1_000),
      })),
    );
    const first = await readProfileGamesPage(
      env.PROFILE_GAMES_DB,
      "profile-1",
      2,
      null,
    );
    expect(first.items.map((item) => item.id)).toEqual([
      "invite-a",
      "invite-b",
    ]);
    expect(first.hasMore).toBe(true);
    const second = await readProfileGamesPage(
      env.PROFILE_GAMES_DB,
      "profile-1",
      2,
      first.nextCursor,
    );
    expect(second.items.map((item) => item.id)).toEqual(["invite-c"]);
    expect(second.hasMore).toBe(false);
  });

  it("does not overwrite a newer projection with a stale update", async () => {
    await commitProfileGameProjectionWrites(env.PROFILE_GAMES_DB, [
      {
        type: "merge",
        profileId: "profile-1",
        projectionId: "invite-1",
        data: gameData("invite-1", 1_000),
      },
    ]);
    const stale = await getProfileGameProjection(
      env.PROFILE_GAMES_DB,
      "profile-1",
      "invite-1",
    );
    await commitProfileGameProjectionWrites(env.PROFILE_GAMES_DB, [
      {
        type: "merge",
        profileId: "profile-1",
        projectionId: "invite-1",
        data: gameData("invite-1", 9_000),
      },
    ]);
    await commitProfileGameProjectionWrites(env.PROFILE_GAMES_DB, [
      {
        type: "merge",
        profileId: "profile-1",
        projectionId: "invite-1",
        data: gameData("invite-1", 5_000),
      },
    ]);
    await expect(
      commitProfileGameProjectionWrites(env.PROFILE_GAMES_DB, [
        {
          type: "update",
          profileId: "profile-1",
          projectionId: "invite-1",
          data: gameData("invite-1", 5_000),
          updateTime: stale?.updateTime,
        },
      ]),
    ).rejects.toThrow();
    expect(
      (
        await getProfileGameProjection(
          env.PROFILE_GAMES_DB,
          "profile-1",
          "invite-1",
        )
      )?.data.listSortAt,
    ).toBe(9_000);
  });

  it("does not delete a projection whose version changed after recovery read", async () => {
    await commitProfileGameProjectionWrites(env.PROFILE_GAMES_DB, [
      {
        type: "merge",
        profileId: "profile-1",
        projectionId: "invite-1",
        data: gameData("invite-1", 1_000),
      },
      {
        type: "merge",
        profileId: "profile-1",
        projectionId: "sibling",
        data: gameData("sibling", 1_000),
      },
    ]);
    const stale = await getProfileGameProjection(
      env.PROFILE_GAMES_DB,
      "profile-1",
      "invite-1",
    );
    await commitProfileGameProjectionWrites(env.PROFILE_GAMES_DB, [
      {
        type: "merge",
        profileId: "profile-1",
        projectionId: "invite-1",
        data: gameData("invite-1", 2_000),
      },
    ]);
    await expect(
      commitProfileGameProjectionWrites(env.PROFILE_GAMES_DB, [
        {
          type: "delete",
          profileId: "profile-1",
          projectionId: "sibling",
        },
        {
          type: "delete",
          profileId: "profile-1",
          projectionId: "invite-1",
          updateTime: stale?.updateTime,
        },
      ]),
    ).rejects.toThrow();
    expect(
      await getProfileGameProjection(
        env.PROFILE_GAMES_DB,
        "profile-1",
        "invite-1",
      ),
    ).not.toBeNull();
    expect(
      await getProfileGameProjection(
        env.PROFILE_GAMES_DB,
        "profile-1",
        "sibling",
      ),
    ).not.toBeNull();
  });

  it("keeps dual create retries convergent while supporting strict creates", async () => {
    await commitProfileGameProjectionWrites(env.PROFILE_GAMES_DB, [
      {
        type: "create",
        profileId: "profile-1",
        projectionId: "invite-1",
        data: gameData("invite-1", 1_000),
      },
    ]);
    await commitProfileGameProjectionWrites(env.PROFILE_GAMES_DB, [
      {
        type: "create",
        profileId: "profile-1",
        projectionId: "invite-1",
        data: gameData("invite-1", 2_000),
      },
    ]);
    expect(
      (
        await getProfileGameProjection(
          env.PROFILE_GAMES_DB,
          "profile-1",
          "invite-1",
        )
      )?.data.listSortAt,
    ).toBe(2_000);
    await expect(
      commitProfileGameProjectionWrites(env.PROFILE_GAMES_DB, [
        {
          type: "create",
          profileId: "profile-1",
          projectionId: "invite-1",
          data: gameData("invite-1", 3_000),
          requireAbsent: true,
        },
      ]),
    ).rejects.toThrow();
  });

  it("conditionally removes waiting games", async () => {
    await commitProfileGameProjectionWrites(env.PROFILE_GAMES_DB, [
      {
        type: "merge",
        profileId: "profile-1",
        projectionId: "waiting",
        data: gameData("waiting", 1_000),
      },
      {
        type: "merge",
        profileId: "profile-1",
        projectionId: "active",
        data: gameData("active", 2_000, "active"),
      },
    ]);
    expect(
      await deleteD1NavigationGame(env.PROFILE_GAMES_DB, "profile-1", "active"),
    ).toBe("missing");
    expect(
      await deleteD1NavigationGame(
        env.PROFILE_GAMES_DB,
        "profile-1",
        "waiting",
      ),
    ).toBe("deleted");
  });

  it("uses the covering pagination index", async () => {
    const result = await env.PROFILE_GAMES_DB.prepare(
      `EXPLAIN QUERY PLAN
       SELECT * FROM profile_game_projections
       WHERE profile_id = ?
       ORDER BY sort_bucket ASC, list_sort_at_ms DESC, projection_id ASC
       LIMIT ?`,
    )
      .bind("profile-1", 81)
      .all<{ detail: string }>();
    expect(result.results.map((entry) => entry.detail).join(" ")).toContain(
      "idx_profile_game_projections_page",
    );
  });
});
