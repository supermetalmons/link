import { env } from "cloudflare:workers";
import type { D1Migration } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { createDefaultProfileAppearance } from "@mons/shared/appearance";
import { createStoredPlayerProfile } from "../src/profileCanonical/contracts.ts";
import { applyRetiredProfileMigrations } from "./profileTestMigrations.ts";
import {
  CanonicalProfileConflict,
  commitCanonicalPlan,
  materializeCanonicalProfile,
  readCanonicalProfile,
  readCanonicalProfileOwnershipSnapshot,
  readCanonicalAuthOperation,
} from "../src/profileCanonicalD1.ts";
import {
  buildMutableProfileMutation,
  readMutableProfileMutationByLogin,
} from "../src/profileMutableD1.ts";
import { createCanonicalIdentityProfiles } from "../src/authIdentityCanonical/profiles.ts";
import { createCanonicalGameplayRepository } from "../src/gameplayCanonicalRepository.ts";
import { createRatingOperations } from "../src/ratingCanonical/operations.ts";
import {
  startedAuthOperation,
  successfulAuthOperation,
} from "../src/authIdentityCanonical/operationRecords.ts";
import { createCanonicalAuthOperations } from "../src/authIdentityCanonical/operations.ts";

const testEnv = env as Env & { TEST_PROFILE_D1_MIGRATIONS: D1Migration[] };
const db = testEnv.PROFILE_DB;
const options = {
  now: () => 1000,
  maxAttempts: 3,
  createFailure: (operation: string, detail?: ErrorOptions) =>
    new Error(operation, detail),
};

async function createProfile(dust = 10) {
  const profileId = `profile-${crypto.randomUUID()}`,
    loginUid = crypto.randomUUID();
  const profile = createStoredPlayerProfile(
    profileId,
    createDefaultProfileAppearance(0),
    {
      nonce: 0,
      mining: {
        lastRockDate: null,
        materials: { dust, slime: 0, gum: 0, metal: 0, ice: 0 },
      },
    },
  );
  await commitCanonicalPlan(db, {
    expectations: [
      { kind: "profile-absent", profileId },
      { kind: "login-owner-absent", loginUid },
    ],
    mutations: [
      {
        kind: "insert-active-profile",
        value: materializeCanonicalProfile({
          profile,
          createdAtMs: 10,
          updatedAtMs: 10,
        }),
      },
      {
        kind: "insert-login-owner",
        value: { loginUid, profileId, createdAtMs: 10, updatedAtMs: 10 },
      },
    ],
  });
  return { profileId, loginUid };
}

describe("canonical profile generation", () => {
  beforeAll(async () => {
    await applyRetiredProfileMigrations(
      db,
      testEnv.TEST_PROFILE_D1_MIGRATIONS,
      "c".repeat(64),
    );
  });

  it("creates exact profiles and guards ownership while mutable updates preserve revision conflicts", async () => {
    const identity = await createProfile();
    const snapshot = await readMutableProfileMutationByLogin(
      db,
      identity.loginUid,
    );
    expect(snapshot?.profile.profile.emoji).toBe(0);
    expect(snapshot?.profile.profile.aura).toBe("none");
    expect(snapshot?.profile).not.toHaveProperty("legacyFields");
    if (!snapshot) throw new Error("missing-profile");
    const mutation = buildMutableProfileMutation(
      snapshot.profile,
      { ...snapshot.profile.profile, cardBackgroundId: 0 },
      20,
    );
    const plan = {
      expectations: [
        {
          kind: "profile-revision" as const,
          profileId: identity.profileId,
          revision: snapshot.profile.revision,
        },
      ],
      mutations: [mutation],
    };
    await commitCanonicalPlan(db, plan);
    await expect(commitCanonicalPlan(db, plan)).rejects.toBeInstanceOf(
      CanonicalProfileConflict,
    );
    const ownership = await readCanonicalProfileOwnershipSnapshot(db, {
      loginUids: [identity.loginUid],
      profileIds: [identity.profileId],
    });
    expect(ownership.loginOwnerByUid.get(identity.loginUid)?.profileId).toBe(
      identity.profileId,
    );
    expect(
      ownership.profileById.get(identity.profileId)?.profile.cardBackgroundId,
    ).toBe(0);
    expect(
      await db
        .prepare(
          "SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'table' AND name = 'profile_records'",
        )
        .first(),
    ).toEqual({ count: 0 });
  });

  it("merges canonical ownership atomically and retains the redirect without a legacy payload bag", async () => {
    const target = await createProfile(7),
      source = await createProfile(3);
    const identities = createCanonicalIdentityProfiles({ db, now: () => 100 });
    expect(
      await identities.mergeIdentityProfiles(
        target.profileId,
        source.profileId,
        "merge-op",
      ),
    ).toBe(target.profileId);
    const merged = await readCanonicalProfile(db, target.profileId);
    expect(merged?.profile.mining.materials.dust).toBe(10);
    const owned = await identities.profileByLogin(source.loginUid);
    expect(owned?.profile.profileId).toBe(target.profileId);
    const redirect = await db
      .prepare(
        "SELECT * FROM profile_merge_targets_canonical WHERE source_profile_id = ?",
      )
      .bind(source.profileId)
      .first();
    expect(redirect).toMatchObject({
      source_profile_id: source.profileId,
      target_profile_id: target.profileId,
      op_id: "merge-op",
    });
    expect(redirect).not.toHaveProperty("source_legacy_fields_json");
    expect((await readCanonicalProfile(db, source.profileId))?.state).toBe(
      "retiring",
    );
  });

  it("applies a wager transfer once and retains exact immutable settlement evidence", async () => {
    const winner = await createProfile(3),
      loser = await createProfile(7);
    const repository = createCanonicalGameplayRepository(
      db,
      testEnv.PROFILE_GAMES_DB,
      options,
    );
    const input = {
      operationId: `settlement-${crypto.randomUUID()}`,
      fingerprint: '{"original": "fingerprint"}',
      winnerProfileId: winner.profileId,
      loserProfileId: loser.profileId,
      material: "dust" as const,
      count: 4,
      appliedAtMs: 100,
    };
    expect(await repository.applyWagerTransferOnce(input)).toBe("applied");
    expect(await repository.applyWagerTransferOnce(input)).toBe("replayed");
    expect(
      (await readCanonicalProfile(db, winner.profileId))?.profile.mining
        .materials.dust,
    ).toBe(7);
    expect(
      (await readCanonicalProfile(db, loser.profileId))?.profile.mining
        .materials.dust,
    ).toBe(3);
    const receipt = await db
      .prepare(
        "SELECT fingerprint FROM wager_settlements_canonical WHERE operation_id = ?",
      )
      .bind(input.operationId)
      .first();
    expect(receipt).toEqual({ fingerprint: input.fingerprint });
    await expect(
      repository.applyWagerTransferOnce({ ...input, fingerprint: "different" }),
    ).rejects.toThrow();
  });

  it("finalizes rating accounting once and prevents blocked migrated operations from reacquiring leases", async () => {
    const player = await createProfile(),
      opponent = await createProfile();
    const rating = createRatingOperations(db, options, 3);
    const inviteId = `invite-${crypto.randomUUID()}`,
      matchId = "match",
      operationId = `${inviteId}__${matchId}`;
    const lease = {
      inviteId,
      matchId,
      playerId: player.loginUid,
      opponentId: opponent.loginUid,
      ownerUid: player.loginUid,
      ownerToken: "owner-token",
      leaseMs: 100,
    };
    expect((await rating.tryAcquireRatingLease(lease)).status).toBe("acquired");
    const finalize = { ...lease, operationId };
    const build = () => ({
      playerUpdate: { totalManaPoints: 5 },
      opponentUpdate: { totalManaPoints: 2 },
      repairData: {
        playerProfileId: player.profileId,
        opponentProfileId: opponent.profileId,
        shouldUpdateFebruaryChallenge: false,
      },
      ratingUpdate: {
        status: "done" as const,
        completedAtMs: 1010,
        updatedAtMs: 1010,
        leaseExpiresAtMs: 1010,
        playerProfileId: player.profileId,
        opponentProfileId: opponent.profileId,
        result: "win" as const,
        canUpdateRatings: true,
        didApplyRatingDelta: false,
        playerManaPoints: 5,
        opponentManaPoints: 2,
      },
    });
    expect((await rating.finalizeRatingUpdate(finalize, build)).status).toBe(
      "committed",
    );
    expect((await rating.finalizeRatingUpdate(finalize, build)).status).toBe(
      "replayed",
    );
    expect(
      (await readCanonicalProfile(db, player.profileId))?.profile
        .totalManaPoints,
    ).toBe(5);
    const blockedInvite = `blocked-${crypto.randomUUID()}`;
    await rating.tryAcquireRatingLease({ ...lease, inviteId: blockedInvite });
    await db
      .prepare(
        "UPDATE rating_updates_canonical SET status='blocked', blocked_at_ms=1000, block_reason='canonical-data-cutover' WHERE operation_id=?",
      )
      .bind(`${blockedInvite}__${matchId}`)
      .run();
    expect(
      (
        await rating.tryAcquireRatingLease({
          ...lease,
          inviteId: blockedInvite,
        })
      ).status,
    ).toBe("blocked");
    expect(
      (
        await rating.finalizeRatingUpdate(
          {
            ...finalize,
            inviteId: blockedInvite,
            operationId: `${blockedInvite}__${matchId}`,
          },
          build,
        )
      ).status,
    ).toBe("lost");
  });

  it("stores minimal authentication receipts while live replay still checks current method ownership", async () => {
    const identity = await createProfile();
    const operationId = `auth-${crypto.randomUUID()}`;
    const start = startedAuthOperation({
      kind: "unlink",
      meta: null,
      operationId,
      loginUid: identity.loginUid,
      method: "eth",
      timestamp: 20,
    });
    await commitCanonicalPlan(db, {
      expectations: [{ kind: "auth-operation-absent", operationId }],
      mutations: [{ kind: "insert-auth-operation", value: start }],
    });
    const stored = await readCanonicalAuthOperation(db, operationId);
    if (!stored) throw new Error("missing-operation");
    const response = {
      ok: true as const,
      profileId: identity.profileId,
      linkedMethods: { apple: false, eth: false, sol: false, x: false },
      appleLinked: false,
    };
    await commitCanonicalPlan(db, {
      expectations: [
        {
          kind: "auth-operation-revision",
          operationId,
          revision: stored.revision,
        },
      ],
      mutations: [
        {
          kind: "update-auth-operation",
          value: successfulAuthOperation(stored, response, () => 30),
        },
      ],
    });
    const success = await readCanonicalAuthOperation(db, operationId);
    expect(success?.result).toEqual({
      schemaVersion: 1,
      kind: "unlink",
      profileId: identity.profileId,
    });
    const profiles = createCanonicalIdentityProfiles({ db, now: () => 30 });
    const operations = createCanonicalAuthOperations({
      db,
      now: () => 30,
      profileByLogin: profiles.profileByLogin,
    });
    expect(await operations.liveResponse(success!)).toEqual(response);
  });
});
