import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import {
  commitProfileDeletion,
  commitProfileProjection,
  commitProfileProjectionFailure,
  createD1ProfileRepository,
  readProfileReconciliationState,
} from "../src/profileD1.ts";
import { createProfileProjection } from "../src/profileProjectionModel.ts";

const testEnv = env as Env & { TEST_PROFILE_D1_MIGRATIONS: D1Migration[] };
const SOURCE_SECONDS = 1_787_832_000;

function fields(overrides: Record<string, unknown> = {}) {
  return {
    logins: ["login-1"],
    nonce: 1,
    rating: 1500,
    totalManaPoints: 5,
    win: true,
    username: "mons",
    eth: "0xabc",
    sol: "sol",
    custom: {
      emoji: 2,
      completedProblems: ["one"],
      tutorialCompleted: true,
    },
    mining: {
      lastRockDate: "2026-08-27",
      materials: { dust: 1, slime: 2, gum: 3, metal: 4, ice: 5 },
    },
    ...overrides,
  };
}

async function projection(
  profileId: string,
  sourceFields: Record<string, unknown>,
  nanos: number,
) {
  return createProfileProjection({
    profileId,
    fields: sourceFields,
    updateTime: `2026-08-27T12:00:00.${String(nanos).padStart(9, "0")}Z`,
  });
}

describe("profile D1 read model", () => {
  beforeAll(async () => {
    await applyD1Migrations(
      testEnv.PROFILE_DB,
      testEnv.TEST_PROFILE_D1_MIGRATIONS,
    );
  });

  beforeEach(async () => {
    await testEnv.PROFILE_DB.batch([
      testEnv.PROFILE_DB.prepare("DELETE FROM profile_projection_failures"),
      testEnv.PROFILE_DB.prepare("DELETE FROM profile_logins"),
      testEnv.PROFILE_DB.prepare("DELETE FROM profiles"),
    ]);
  });

  it("projects profiles, replaces login mappings, and rejects stale writes", async () => {
    await commitProfileProjection(
      testEnv.PROFILE_DB,
      await projection("profile-1", fields(), 200),
      1_000,
    );
    await commitProfileProjection(
      testEnv.PROFILE_DB,
      await projection(
        "profile-1",
        fields({ logins: ["login-2"], username: "new" }),
        300,
      ),
      2_000,
    );
    await commitProfileProjection(
      testEnv.PROFILE_DB,
      await projection(
        "profile-1",
        fields({ logins: ["stale"], username: "stale" }),
        100,
      ),
      3_000,
    );
    const repository = createD1ProfileRepository(testEnv.PROFILE_DB);
    expect(
      (await repository.getProfileById("profile-1", "token"))?.username,
    ).toBe("new");
    expect(await repository.getProfileByLoginId("login-1", "token")).toBeNull();
    expect((await repository.getProfileByLoginId("login-2", "token"))?.id).toBe(
      "profile-1",
    );
    expect(await repository.getProfileByLoginId("stale", "token")).toBeNull();
  });

  it("replaces large login sets in one projection batch", async () => {
    const logins = Array.from({ length: 366 }, (_, index) => `login-${index}`);
    await commitProfileProjection(
      testEnv.PROFILE_DB,
      await projection("profile-many", fields({ logins }), 200),
      1_000,
    );
    const count = await testEnv.PROFILE_DB.prepare(
      "SELECT COUNT(*) AS count FROM profile_logins WHERE profile_id = ?",
    )
      .bind("profile-many")
      .first<{ count: number }>();
    expect(count?.count).toBe(366);
  });

  it("prevents equal-version resurrection and permits a newer recreation", async () => {
    const sourceVersion = { seconds: SOURCE_SECONDS, nanos: 100 };
    await commitProfileProjection(
      testEnv.PROFILE_DB,
      await projection("profile-deleted", fields(), 100),
      1_000,
    );
    await commitProfileDeletion(
      testEnv.PROFILE_DB,
      "profile-deleted",
      sourceVersion,
      2_000,
    );
    await commitProfileProjection(
      testEnv.PROFILE_DB,
      await projection(
        "profile-deleted",
        fields({ logins: ["equal"], username: "equal" }),
        100,
      ),
      3_000,
    );
    const repository = createD1ProfileRepository(testEnv.PROFILE_DB);
    expect(
      await repository.getProfileById("profile-deleted", "token"),
    ).toBeNull();
    expect(await repository.getProfileByLoginId("equal", "token")).toBeNull();

    await commitProfileProjection(
      testEnv.PROFILE_DB,
      await projection(
        "profile-deleted",
        fields({ logins: ["new"], username: "new" }),
        200,
      ),
      4_000,
    );
    expect(
      (await repository.getProfileById("profile-deleted", "token"))?.username,
    ).toBe("new");
    expect((await repository.getProfileByLoginId("new", "token"))?.id).toBe(
      "profile-deleted",
    );
  });

  it("applies deletion only to the observed profile version", async () => {
    await commitProfileProjection(
      testEnv.PROFILE_DB,
      await projection("profile-current", fields(), 200),
      1_000,
    );
    await commitProfileDeletion(
      testEnv.PROFILE_DB,
      "profile-current",
      { seconds: SOURCE_SECONDS, nanos: 100 },
      2_000,
      { seconds: SOURCE_SECONDS, nanos: 100 },
    );
    expect(
      (
        await createD1ProfileRepository(testEnv.PROFILE_DB).getProfileById(
          "profile-current",
          "token",
        )
      )?.id,
    ).toBe("profile-current");
  });

  it("uses one global failure gate and fences stale failures", async () => {
    await commitProfileProjection(
      testEnv.PROFILE_DB,
      await projection("profile-invalid", fields(), 100),
      1_000,
    );
    await commitProfileProjection(
      testEnv.PROFILE_DB,
      await projection(
        "profile-healthy",
        fields({ logins: ["login-healthy"], username: "healthy" }),
        200,
      ),
      1_000,
    );
    await commitProfileProjectionFailure(
      testEnv.PROFILE_DB,
      "profile-invalid",
      { seconds: SOURCE_SECONDS, nanos: 200 },
      2_000,
    );
    await commitProfileProjectionFailure(
      testEnv.PROFILE_DB,
      "profile-healthy",
      { seconds: SOURCE_SECONDS, nanos: 100 },
      2_000,
    );
    const repository = createD1ProfileRepository(testEnv.PROFILE_DB);
    await expect(
      repository.getProfileById("profile-healthy", "token"),
    ).rejects.toThrow("profile-repository-unavailable");
    await expect(
      repository.getProfileByLoginId("login-healthy", "token"),
    ).rejects.toThrow("profile-repository-unavailable");
    await expect(repository.readLeaderboard("rating", "token")).rejects.toThrow(
      "profile-repository-unavailable",
    );

    await commitProfileProjection(
      testEnv.PROFILE_DB,
      await projection(
        "profile-invalid",
        fields({ username: "repaired" }),
        200,
      ),
      3_000,
    );
    expect(
      (await repository.getProfileById("profile-healthy", "token"))?.username,
    ).toBe("healthy");
    const states = await readProfileReconciliationState(testEnv.PROFILE_DB);
    expect(states.get("profile-healthy")?.failureVersion).toBeNull();
  });

  it("clears a failure fence after confirmed deletion", async () => {
    const sourceVersion = { seconds: SOURCE_SECONDS, nanos: 200 };
    await commitProfileProjectionFailure(
      testEnv.PROFILE_DB,
      "profile-invalid",
      sourceVersion,
      1_000,
    );
    await commitProfileDeletion(
      testEnv.PROFILE_DB,
      "profile-invalid",
      sourceVersion,
      2_000,
      null,
    );
    const repository = createD1ProfileRepository(testEnv.PROFILE_DB);
    expect(
      await repository.getProfileById("profile-invalid", "token"),
    ).toBeNull();
    expect(
      (await readProfileReconciliationState(testEnv.PROFILE_DB)).get(
        "profile-invalid",
      )?.failureVersion,
    ).toBeNull();
  });

  it("retains a failure fence when deletion loses its CAS race", async () => {
    const failureVersion = { seconds: SOURCE_SECONDS, nanos: 200 };
    await commitProfileProjectionFailure(
      testEnv.PROFILE_DB,
      "profile-race",
      failureVersion,
      1_000,
    );
    await commitProfileProjection(
      testEnv.PROFILE_DB,
      await projection("profile-race", fields(), 100),
      2_000,
    );
    await commitProfileDeletion(
      testEnv.PROFILE_DB,
      "profile-race",
      failureVersion,
      3_000,
      null,
    );

    const state = (
      await readProfileReconciliationState(testEnv.PROFILE_DB)
    ).get("profile-race");
    expect(state?.profile).toEqual({
      isDeleted: false,
      sourceVersion: { seconds: SOURCE_SECONDS, nanos: 100 },
    });
    expect(state?.failureVersion).toEqual(failureVersion);
    await expect(
      createD1ProfileRepository(testEnv.PROFILE_DB).getProfileById(
        "profile-race",
        "token",
      ),
    ).rejects.toThrow("profile-repository-unavailable");
  });

  it("does not reopen a failure fence after an equal-version tombstone", async () => {
    const sourceVersion = { seconds: SOURCE_SECONDS, nanos: 100 };
    await commitProfileProjection(
      testEnv.PROFILE_DB,
      await projection("profile-deleted", fields(), 100),
      1_000,
    );
    await commitProfileDeletion(
      testEnv.PROFILE_DB,
      "profile-deleted",
      sourceVersion,
      2_000,
    );
    await commitProfileProjectionFailure(
      testEnv.PROFILE_DB,
      "profile-deleted",
      sourceVersion,
      3_000,
    );

    const state = (
      await readProfileReconciliationState(testEnv.PROFILE_DB)
    ).get("profile-deleted");
    expect(state?.profile).toEqual({ isDeleted: true, sourceVersion });
    expect(state?.failureVersion).toBeNull();
    expect(
      await createD1ProfileRepository(testEnv.PROFILE_DB).getProfileById(
        "profile-deleted",
        "token",
      ),
    ).toBeNull();
  });

  it("preserves leaderboard ordering and omits tutorial state", async () => {
    await commitProfileProjection(
      testEnv.PROFILE_DB,
      await projection("profile-a", fields({ rating: 1600 }), 100),
      1_000,
    );
    await commitProfileProjection(
      testEnv.PROFILE_DB,
      await projection("profile-z", fields({ rating: 1600 }), 100),
      1_000,
    );
    const missingRating: Record<string, unknown> = fields();
    delete missingRating.rating;
    await commitProfileProjection(
      testEnv.PROFILE_DB,
      await projection("profile-missing", missingRating, 100),
      1_000,
    );
    const leaderboard = await createD1ProfileRepository(
      testEnv.PROFILE_DB,
    ).readLeaderboard("rating", "token");
    expect(leaderboard.map((profile) => profile.id)).toEqual([
      "profile-z",
      "profile-a",
    ]);
    expect(leaderboard[0].completedProblemIds).toBeUndefined();
    expect(leaderboard[0].isTutorialCompleted).toBeUndefined();
  });

  it("maps and limits all seven leaderboards", async () => {
    for (let index = 0; index < 105; index++) {
      await commitProfileProjection(
        testEnv.PROFILE_DB,
        await projection(
          `profile-${String(index).padStart(3, "0")}`,
          fields({
            rating: index,
            totalManaPoints: index,
            mining: {
              materials: {
                dust: index,
                slime: index,
                gum: index,
                metal: index,
                ice: index,
              },
            },
          }),
          100,
        ),
        1_000,
      );
    }
    const repository = createD1ProfileRepository(testEnv.PROFILE_DB);
    const expected = Array.from(
      { length: 99 },
      (_, index) => `profile-${String(104 - index).padStart(3, "0")}`,
    );
    for (const type of [
      "rating",
      "mp",
      "dust",
      "slime",
      "gum",
      "metal",
      "ice",
    ] as const) {
      const leaderboard = await repository.readLeaderboard(type, "token");
      expect(leaderboard.map((profile) => profile.id)).toEqual(expected);
    }
  });

  it("follows redirects and resolves duplicate logins by profile ID", async () => {
    await commitProfileProjection(
      testEnv.PROFILE_DB,
      await projection(
        "source",
        fields({ logins: ["shared"], mergedIntoProfileId: "target" }),
        100,
      ),
      1_000,
    );
    await commitProfileProjection(
      testEnv.PROFILE_DB,
      await projection("target", fields({ logins: [] }), 100),
      1_000,
    );
    await commitProfileProjection(
      testEnv.PROFILE_DB,
      await projection("z-profile", fields({ logins: ["shared"] }), 100),
      1_000,
    );
    const repository = createD1ProfileRepository(testEnv.PROFILE_DB);
    expect((await repository.getProfileById("source", "token"))?.id).toBe(
      "target",
    );
    expect((await repository.getProfileByLoginId("shared", "token"))?.id).toBe(
      "target",
    );
  });
});
