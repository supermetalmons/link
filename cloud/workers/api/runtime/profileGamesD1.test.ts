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
