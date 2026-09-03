import { env } from "cloudflare:workers";
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import type { CompletePlayerProfile } from "@mons/shared/profiles";
import {
  commitCanonicalPlan,
  materializeCanonicalProfile,
  readCanonicalProfile,
  readCanonicalProfileAggregate,
} from "../src/profileCanonicalD1.ts";
import {
  createEventProfileGameProjectionRuntime,
  createProfileGameProjectionRuntime,
  readProjectionOwnershipSnapshot,
} from "../src/profileGameProjectionRepository.ts";
import { createProfileLinkProjectionRuntime } from "../src/profileLinkProfileGameProjection.ts";
import { getProfileGameProjection } from "../src/profileGamesD1.ts";
import { createGameplayRepository } from "../src/gameplayRepository.ts";
import { resolveInviteRole } from "../src/gameSessionMutations.ts";
import type { FirebaseRtdbClient } from "../src/firebaseRtdb.ts";
import { applyRetiredProfileMigrations } from "./profileTestMigrations.ts";

const testEnv = env as Env & {
  TEST_D1_MIGRATIONS: D1Migration[];
  TEST_PROFILE_D1_MIGRATIONS: D1Migration[];
};

function profile(id: string): CompletePlayerProfile {
  return {
    id,
    completedProblemIds: [],
    emoji: 2,
    eth: null,
    isTutorialCompleted: true,
    mining: {
      lastRockDate: "2026-08-30",
      materials: { dust: 1, gum: 1, ice: 1, metal: 1, slime: 1 },
    },
    nonce: 1,
    rating: 1500,
    sol: null,
    totalManaPoints: 1,
    username: `${id}Name`,
    win: true,
  };
}

async function insertProfileOwner(profileId: string, loginUid: string) {
  const value = materializeCanonicalProfile({
    createdAtMs: 1,
    profile: profile(profileId),
    updatedAtMs: 1,
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
          createdAtMs: 1,
          loginUid,
          profileId,
          updatedAtMs: 1,
        },
      },
    ],
  });
}

async function insertAdditionalLoginOwner(profileId: string, loginUid: string) {
  const profileSnapshot = await readCanonicalProfile(
    testEnv.PROFILE_DB,
    profileId,
  );
  if (!profileSnapshot) throw new Error("missing-canonical-profile");
  await commitCanonicalPlan(testEnv.PROFILE_DB, {
    expectations: [
      {
        kind: "profile-revision",
        profileId,
        revision: profileSnapshot.revision,
      },
      { kind: "login-owner-absent", loginUid },
    ],
    mutations: [
      {
        kind: "insert-login-owner",
        value: {
          createdAtMs: 2,
          loginUid,
          profileId,
          updatedAtMs: 2,
        },
      },
    ],
  });
}

async function insertDeletedMergeSource(
  sourceProfileId: string,
  targetProfileId: string,
  mergedAtMs: number,
) {
  await commitCanonicalPlan(testEnv.PROFILE_DB, {
    expectations: [{ kind: "profile-absent", profileId: sourceProfileId }],
    mutations: [
      {
        kind: "insert-active-profile",
        value: materializeCanonicalProfile({
          createdAtMs: 1,
          profile: profile(sourceProfileId),
          updatedAtMs: 1,
        }),
      },
    ],
  });
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
          ...source,
          mergedAtMs,
          mergedIntoProfileId: targetProfileId,
          state: "retiring",
          updatedAtMs: mergedAtMs,
        }),
        redirect: {
          mergedAtMs,
          opId: `projection-budget-${sourceProfileId}`,
          sourceLegacyFields: source.legacyFields,
          sourceProfileId,
          targetProfileId,
        },
      },
    ],
  });
  const retired = await readCanonicalProfile(
    testEnv.PROFILE_DB,
    sourceProfileId,
  );
  if (!retired) throw new Error("missing-retired-profile");
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

async function insertMergedProfileOwner(
  sourceProfileId: string,
  targetProfileId: string,
  loginUid: string,
) {
  const source = materializeCanonicalProfile({
    createdAtMs: 1,
    profile: profile(sourceProfileId),
    updatedAtMs: 1,
  });
  const target = materializeCanonicalProfile({
    createdAtMs: 1,
    profile: profile(targetProfileId),
    updatedAtMs: 1,
  });
  await commitCanonicalPlan(testEnv.PROFILE_DB, {
    expectations: [
      { kind: "profile-absent", profileId: sourceProfileId },
      { kind: "profile-absent", profileId: targetProfileId },
      { kind: "login-owner-absent", loginUid },
    ],
    mutations: [
      { kind: "insert-active-profile", value: source },
      { kind: "insert-active-profile", value: target },
      {
        kind: "insert-login-owner",
        value: {
          createdAtMs: 1,
          loginUid,
          profileId: sourceProfileId,
          updatedAtMs: 1,
        },
      },
    ],
  });
  const [sourceAggregate, targetAggregate] = await Promise.all([
    readCanonicalProfileAggregate(testEnv.PROFILE_DB, sourceProfileId),
    readCanonicalProfileAggregate(testEnv.PROFILE_DB, targetProfileId),
  ]);
  await commitCanonicalPlan(testEnv.PROFILE_DB, {
    expectations: [
      {
        kind: "login-owner-set",
        owners: sourceAggregate.loginOwners,
        profileId: sourceProfileId,
      },
      {
        kind: "login-owner-set",
        owners: targetAggregate.loginOwners,
        profileId: targetProfileId,
      },
    ],
    mutations: [
      {
        kind: "move-login-owner-set",
        sourceProfileId,
        targetProfileId,
        updatedAtMs: 2,
      },
    ],
  });
  const [sourceSnapshot, targetSnapshot] = await Promise.all([
    readCanonicalProfile(testEnv.PROFILE_DB, sourceProfileId),
    readCanonicalProfile(testEnv.PROFILE_DB, targetProfileId),
  ]);
  if (!sourceSnapshot || !targetSnapshot) {
    throw new Error("missing-canonical-profile");
  }
  await commitCanonicalPlan(testEnv.PROFILE_DB, {
    expectations: [
      {
        kind: "profile-revision",
        profileId: sourceProfileId,
        revision: sourceSnapshot.revision,
      },
      {
        kind: "profile-revision",
        profileId: targetProfileId,
        revision: targetSnapshot.revision,
      },
      { kind: "merge-target-absent", sourceProfileId },
    ],
    mutations: [
      {
        kind: "retire-profile-with-redirect",
        profile: materializeCanonicalProfile({
          ...sourceSnapshot,
          mergedAtMs: 3,
          mergedIntoProfileId: targetProfileId,
          state: "retiring",
          updatedAtMs: 3,
        }),
        redirect: {
          mergedAtMs: 3,
          opId: "projection-ownership-merge",
          sourceLegacyFields: sourceSnapshot.legacyFields,
          sourceProfileId,
          targetProfileId,
        },
      },
    ],
  });
}

describe("D1-authoritative profile game projection ownership", () => {
  beforeAll(async () => {
    await Promise.all([
      applyD1Migrations(testEnv.PROFILE_GAMES_DB, testEnv.TEST_D1_MIGRATIONS),
      applyRetiredProfileMigrations(
        testEnv.PROFILE_DB,
        testEnv.TEST_PROFILE_D1_MIGRATIONS,
        "b".repeat(64),
      ),
    ]);
  });

  it("projects a merged login from its active canonical D1 owner", async () => {
    const inviteId = "d1-owner-invite";
    const loginUid = "d1-owner-login";
    const profileId = "d1-owner-profile";
    await insertMergedProfileOwner("d1-owner-source", profileId, loginUid);
    const reads: string[] = [];
    const runtime = createProfileGameProjectionRuntime(testEnv, {
      logger: { error() {} },
      rtdb: {
        async getRtdbPath(path) {
          reads.push(path);
          if (/^players\/.+\/profile$/.test(path)) {
            throw new Error("unexpected-rtdb-profile-owner-read");
          }
          if (path === `invites/${inviteId}`) return { hostId: loginUid };
          if (path === `automatch/${inviteId}`) return null;
          return null;
        },
      },
      wait: async () => undefined,
    });

    const result = await runtime.recomputeInviteProjection(inviteId, "test", {
      eventTimestampMs: 100,
    });

    expect(result.ownerProfileIds).toEqual([profileId]);
    expect(reads.some((path) => /^players\/.+\/profile$/.test(path))).toBe(
      false,
    );
    await expect(
      getProfileGameProjection(testEnv.PROFILE_GAMES_DB, profileId, inviteId),
    ).resolves.toMatchObject({
      data: { hostProfileId: profileId, ownerProfileId: profileId },
    });
  });

  it("uses D1 ownership during profile-link catch-up", async () => {
    const inviteId = "d1-catchup-invite";
    const loginUid = "d1-catchup-login";
    const profileId = "d1-catchup-profile";
    await insertProfileOwner(profileId, loginUid);
    const reads: string[] = [];
    const recomputed: string[] = [];
    const runtime = createProfileLinkProjectionRuntime(testEnv, {
      logger: { error() {}, info() {} },
      projection: {
        async recomputeInviteProjection(recomputedInviteId, reason) {
          expect(reason).toBe("profile-link-catchup");
          recomputed.push(recomputedInviteId);
          return {
            inviteId: recomputedInviteId,
            ok: true,
            reason,
            skipped: 0,
            sourceCleanupSafe: true,
          };
        },
      },
      rtdb: {
        async getRtdbPath(path, query) {
          reads.push(path);
          if (/^players\/.+\/profile$/.test(path)) {
            throw new Error("unexpected-rtdb-profile-owner-read");
          }
          if (path === `players/${loginUid}/matches`) {
            expect(query).toEqual({ shallow: true });
            return { [inviteId]: true };
          }
          if (path === `invites/${inviteId}`) {
            expect(query).toEqual({ shallow: true });
            return true;
          }
          return null;
        },
      },
      async withInviteProjectionLock(_inviteId, work) {
        return work();
      },
    });

    const result = await runtime.process({
      cleanupProfileIds: [],
      loginUid,
      matchCursor: null,
      profileId,
      sourceUpdatedAtMs: 100,
    });

    expect(result?.profileId).toBe(profileId);
    expect(recomputed).toEqual([inviteId]);
    expect(reads.some((path) => /^players\/.+\/profile$/.test(path))).toBe(
      false,
    );
  });

  it("reads each projection login through one ownership snapshot", async () => {
    const profileId = "d1-budget-profile";
    const loginUids = Array.from(
      { length: 40 },
      (_, index) => `d1-budget-login-${index}`,
    );
    await insertProfileOwner(profileId, loginUids[0]);
    await Promise.all(
      loginUids
        .slice(1)
        .map((loginUid) => insertAdditionalLoginOwner(profileId, loginUid)),
    );
    let preparedReads = 0;
    const countingDb = new Proxy(testEnv.PROFILE_DB, {
      get(target, property) {
        if (property === "prepare") {
          return (query: string) => {
            preparedReads += 1;
            return target.prepare(query);
          };
        }
        const member = Reflect.get(target, property, target);
        return typeof member === "function" ? member.bind(target) : member;
      },
    });

    const ownership = await readProjectionOwnershipSnapshot(countingDb, {
      loginUids,
      profileIds: [],
    });

    expect(
      loginUids.every(
        (loginUid) => ownership.profileIdByLoginUid.get(loginUid) === profileId,
      ),
    ).toBe(true);
    expect(preparedReads).toBe(4);
  });

  it("keeps each cleanup catch-up below 1,000 statements", async () => {
    const hostProfileId = "d1-full-budget-host";
    const guestProfileId = "d1-full-budget-guest";
    const hostLoginUids = Array.from(
      { length: 20 },
      (_, index) => `d1-full-budget-host-${index}`,
    );
    const guestLoginUids = Array.from(
      { length: 20 },
      (_, index) => `d1-full-budget-guest-${index}`,
    );
    await Promise.all([
      insertProfileOwner(hostProfileId, hostLoginUids[0]),
      insertProfileOwner(guestProfileId, guestLoginUids[0]),
    ]);
    await Promise.all([
      ...hostLoginUids
        .slice(1)
        .map((loginUid) => insertAdditionalLoginOwner(hostProfileId, loginUid)),
      ...guestLoginUids
        .slice(1)
        .map((loginUid) =>
          insertAdditionalLoginOwner(guestProfileId, loginUid),
        ),
    ]);
    const cleanupSourceProfileIds = Array.from(
      { length: 4 },
      (_, index) => `d1-full-budget-cleanup-source-${index}`,
    );
    for (let index = 0; index < cleanupSourceProfileIds.length; index += 1) {
      await insertDeletedMergeSource(
        cleanupSourceProfileIds[index],
        hostProfileId,
        10 + index,
      );
    }
    let canonicalStatements = 0;
    let projectionStatements = 0;
    const countingProfileDb = new Proxy(testEnv.PROFILE_DB, {
      get(target, property) {
        if (property === "prepare") {
          return (query: string) => {
            canonicalStatements += 1;
            return target.prepare(query);
          };
        }
        const member = Reflect.get(target, property, target);
        return typeof member === "function" ? member.bind(target) : member;
      },
    });
    const countingProjectionDb = new Proxy(testEnv.PROFILE_GAMES_DB, {
      get(target, property) {
        if (property === "prepare") {
          return (query: string) => {
            projectionStatements += 1;
            return target.prepare(query);
          };
        }
        const member = Reflect.get(target, property, target);
        return typeof member === "function" ? member.bind(target) : member;
      },
    });
    const inviteIds = Array.from(
      { length: 20 },
      (_, index) => `d1-full-budget-invite-${index}`,
    );
    const sortedInviteIds = [...inviteIds].sort();
    await testEnv.PROFILE_GAMES_DB.batch(
      cleanupSourceProfileIds.flatMap((profileId) =>
        inviteIds.map((inviteId) =>
          testEnv.PROFILE_GAMES_DB.prepare(
            `INSERT INTO profile_game_projections (
               profile_id, projection_id, entity_type, status, sort_bucket,
               list_sort_at_ms, updated_at_ms, version, payload_json
             ) VALUES (?, ?, 'game', 'waiting', 1, 1, 1, 1, '{}')`,
          ).bind(profileId, inviteId),
        ),
      ),
    );
    const runtime = createProfileLinkProjectionRuntime(testEnv, {
      d1: countingProjectionDb,
      logger: { error() {}, info() {} },
      profileDb: countingProfileDb,
      rtdb: {
        async getRtdbPath(path, query) {
          if (path === `players/${hostLoginUids[0]}/matches`) {
            expect(query).toEqual({ shallow: true });
            return Object.fromEntries(
              [...inviteIds].reverse().map((inviteId) => [inviteId, true]),
            );
          }
          const inviteIndex = inviteIds.findIndex(
            (inviteId) => path === `invites/${inviteId}`,
          );
          if (inviteIndex >= 0) {
            return query?.shallow
              ? true
              : {
                  hostId: hostLoginUids[inviteIndex],
                  guestId: guestLoginUids[inviteIndex],
                };
          }
          if (inviteIds.some((inviteId) => path === `automatch/${inviteId}`)) {
            return null;
          }
          throw new Error(`unexpected-rtdb-read:${path}`);
        },
      },
      wait: async () => undefined,
      async withInviteProjectionLock(_inviteId, work) {
        return work();
      },
    });

    let matchCursor: string | null = null;
    for (let index = 0; index < inviteIds.length; index += 1) {
      canonicalStatements = 0;
      projectionStatements = 0;
      const result = await runtime.process({
        cleanupProfileIds: cleanupSourceProfileIds,
        loginUid: hostLoginUids[0],
        matchCursor,
        profileId: hostProfileId,
        sourceUpdatedAtMs: 100,
      });
      expect(result?.processed).toBe(1);
      expect(canonicalStatements + projectionStatements).toBeLessThan(1_000);
      matchCursor = result?.nextMatchCursor || null;
      expect(matchCursor).toBe(
        index + 1 < sortedInviteIds.length ? sortedInviteIds[index] : null,
      );
    }
    for (const profileId of cleanupSourceProfileIds) {
      for (const inviteId of inviteIds) {
        await expect(
          getProfileGameProjection(
            testEnv.PROFILE_GAMES_DB,
            profileId,
            inviteId,
          ),
        ).resolves.toBeNull();
      }
    }
  });

  it("authorizes an alternate invite login without an RTDB profile read", async () => {
    const profileId = "d1-role-profile";
    const hostUid = "d1-role-host";
    const alternateUid = "d1-role-alternate";
    const inviteId = "d1-role-invite";
    await insertProfileOwner(profileId, hostUid);
    await insertAdditionalLoginOwner(profileId, alternateUid);
    const reads: string[] = [];
    const rtdbClient: FirebaseRtdbClient = {
      async getPath(path) {
        reads.push(path);
        if (/^players\/.+\/profile$/.test(path)) {
          throw new Error("unexpected-rtdb-profile-owner-read");
        }
        if (path === `invites/${inviteId}`) {
          return { hostId: hostUid, guestId: null };
        }
        return null;
      },
      async patchRoot() {},
      async transactPath() {
        return { committed: false, value: null };
      },
    };
    const repository = createGameplayRepository(testEnv, { rtdbClient });

    await expect(
      resolveInviteRole({ uid: alternateUid }, { inviteId }, repository),
    ).resolves.toMatchObject({ actorUid: hostUid, role: "host" });
    expect(reads).toEqual([`invites/${inviteId}`]);
  });

  it("reserves a monotonic fence before committing an event projection", async () => {
    const eventId = "d1-fenced-event";
    const profileId = "d1-fenced-event-profile";
    const loginUid = "d1-fenced-event-login";
    await insertProfileOwner(profileId, loginUid);
    const runtime = createEventProfileGameProjectionRuntime(testEnv, {
      rtdb: {
        async getRtdbPath(path) {
          expect(path).toBe(`events/${eventId}`);
          return {
            eventId,
            status: "scheduled",
            startAtMs: 100,
            updatedAtMs: 100,
            participants: {
              [profileId]: { profileId, loginUid },
            },
          };
        },
      },
      wait: async () => undefined,
    });

    await expect(
      runtime.reconcileEventProjection(eventId),
    ).resolves.toMatchObject({ status: "projected", written: 1 });
    await expect(
      testEnv.PROFILE_GAMES_DB.prepare(
        `SELECT generation FROM event_profile_game_projection_fences
         WHERE event_id = ?`,
      )
        .bind(eventId)
        .first<number>("generation"),
    ).resolves.toBe(1);
  });
});
