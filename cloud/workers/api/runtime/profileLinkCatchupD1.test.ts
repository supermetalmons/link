import { env } from "cloudflare:workers";
import type { D1Migration } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import {
  CanonicalProfileConflict,
  CanonicalProfileCorruption,
  commitCanonicalPlan,
  countCanonicalCommitStatements,
  materializeCanonicalProfile,
  readCanonicalLoginOwner,
  readCanonicalProfileAggregate,
} from "../src/profileCanonicalD1.ts";
import { createProfileLinkCatchupStore } from "../src/profileLinkCatchupD1.ts";
import { applyRetiredProfileMigrations } from "./profileTestMigrations.ts";

const testEnv = env as Env & { TEST_PROFILE_D1_MIGRATIONS: D1Migration[] };
const db = testEnv.PROFILE_DB;
const store = createProfileLinkCatchupStore(db);

function uniqueId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

async function createProfile(loginUids: string[] = []) {
  const profileId = uniqueId("profile");
  const value = materializeCanonicalProfile({
    profile: {
      id: profileId,
      nonce: 0,
      rating: 1500,
      totalManaPoints: 0,
      win: false,
      emoji: 1,
      username: "",
      eth: null,
      sol: null,
      completedProblemIds: [],
      isTutorialCompleted: false,
      mining: {
        lastRockDate: "",
        materials: { dust: 0, slime: 0, gum: 0, metal: 0, ice: 0 },
      },
    },
    createdAtMs: 1_000,
    updatedAtMs: 1_000,
  });
  await commitCanonicalPlan(db, {
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
  return profileId;
}

async function moveOwner(loginUid: string, profileId: string) {
  const owner = await readCanonicalLoginOwner(db, loginUid);
  if (!owner) throw new Error("missing-test-owner");
  await commitCanonicalPlan(db, {
    expectations: [{ kind: "login-owner-revision", ...owner }],
    mutations: [
      {
        kind: "update-login-owner",
        value: { ...owner, profileId, updatedAtMs: 2_000 },
      },
    ],
  });
}

function beforeBatch(action: () => Promise<void>): D1Database {
  let fired = false;
  return new Proxy(db, {
    get(target, property) {
      if (property === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          if (!fired) {
            fired = true;
            await action();
          }
          return target.batch(statements);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

describe("profile-link catch-up D1", () => {
  beforeAll(async () => {
    await applyRetiredProfileMigrations(
      db,
      testEnv.TEST_PROFILE_D1_MIGRATIONS,
      "e".repeat(64),
    );
  });

  it("atomically schedules newly owned logins and preserves unchanged owner progress", async () => {
    const loginUid = uniqueId("login");
    const profileId = await createProfile([loginUid]);
    const initial = await store.read(loginUid);
    expect(initial).toMatchObject({
      loginUid,
      profileId,
      cleanupProfileIds: [],
      matchCursor: null,
      sourceUpdatedAtMs: 1_000,
      lastQueuedAtMs: 1_000,
    });
    if (!initial) throw new Error("missing-test-job");
    expect(
      await store.advance(loginUid, initial.requestId, null, "match-1", 1_100),
    ).toBe(true);
    const advanced = await store.read(loginUid);
    await moveOwner(loginUid, profileId);
    expect(await store.read(loginUid)).toEqual(advanced);
    expect(
      await store.mergeCleanup({
        loginUid,
        profileId,
        cleanupProfileIds: [profileId],
        requestId: uniqueId("ignored"),
        nowMs: 1_200,
      }),
    ).toEqual(advanced);
  });

  it("coalesces cleanup across ownership changes and fences stale pages", async () => {
    const loginUid = uniqueId("login");
    const originalProfileId = await createProfile([loginUid]);
    const nextProfileId = await createProfile();
    const finalProfileId = await createProfile();
    const original = await store.read(loginUid);
    if (!original) throw new Error("missing-test-job");
    await store.advance(loginUid, original.requestId, null, "match-5", 1_100);
    const repair = await store.mergeCleanup({
      loginUid,
      profileId: originalProfileId,
      cleanupProfileIds: ["historical-profile"],
      requestId: uniqueId("repair"),
      nowMs: 1_200,
    });
    expect(repair?.matchCursor).toBeNull();
    await moveOwner(loginUid, nextProfileId);
    const next = await store.read(loginUid);
    expect(next?.cleanupProfileIds).toEqual(
      [originalProfileId, "historical-profile"].sort(),
    );
    expect(next?.requestId).not.toBe(original.requestId);
    await moveOwner(loginUid, finalProfileId);
    const final = await store.read(loginUid);
    expect(final?.cleanupProfileIds).toEqual(
      [originalProfileId, nextProfileId, "historical-profile"].sort(),
    );
    expect(
      await store.advance(loginUid, original.requestId, null, "match-8", 2_100),
    ).toBe(false);
    expect(await store.settle(loginUid, original.requestId, null)).toBe(false);
    expect(await store.read(loginUid)).toEqual(final);
  });

  it("rolls back job production when its owner mutation fails", async () => {
    const loginUid = uniqueId("login");
    const profileId = await createProfile([loginUid]);
    const original = await store.read(loginUid);
    await expect(moveOwner(loginUid, "missing-profile")).rejects.toThrow();
    expect((await readCanonicalLoginOwner(db, loginUid))?.profileId).toBe(
      profileId,
    );
    expect(await store.read(loginUid)).toEqual(original);
  });

  it("uses a constant statement count for bulk owner transfers", async () => {
    const loginUids = Array.from({ length: 25 }, () => uniqueId("login"));
    const sourceProfileId = await createProfile(loginUids);
    const targetProfileId = await createProfile();
    const [source, target] = await Promise.all([
      readCanonicalProfileAggregate(db, sourceProfileId),
      readCanonicalProfileAggregate(db, targetProfileId),
    ]);
    const plan = {
      expectations: [
        {
          kind: "login-owner-set" as const,
          profileId: sourceProfileId,
          owners: source.loginOwners,
        },
        {
          kind: "login-owner-set" as const,
          profileId: targetProfileId,
          owners: target.loginOwners,
        },
      ],
      mutations: [
        {
          kind: "move-login-owner-set" as const,
          sourceProfileId,
          targetProfileId,
          updatedAtMs: 2_000,
        },
      ],
    };
    expect(countCanonicalCommitStatements(plan)).toBe(6);
    await commitCanonicalPlan(db, plan);
    const jobs = await Promise.all(
      loginUids.map((loginUid) => store.read(loginUid)),
    );
    expect(jobs.every((job) => job?.profileId === targetProfileId)).toBe(true);
    expect(
      jobs.every(
        (job) =>
          JSON.stringify(job?.cleanupProfileIds) ===
          JSON.stringify([sourceProfileId]),
      ),
    ).toBe(true);
  });

  it("rejects a repair whose owner changes before the guarded write", async () => {
    const loginUid = uniqueId("login");
    const profileId = await createProfile([loginUid]);
    const targetProfileId = await createProfile();
    const racingStore = createProfileLinkCatchupStore(
      beforeBatch(() => moveOwner(loginUid, targetProfileId)),
    );
    await expect(
      racingStore.mergeCleanup({
        loginUid,
        profileId,
        cleanupProfileIds: ["old-shadow"],
        requestId: uniqueId("repair"),
        nowMs: 3_000,
      }),
    ).rejects.toBeInstanceOf(CanonicalProfileConflict);
    expect(await store.read(loginUid)).toMatchObject({
      profileId: targetProfileId,
      cleanupProfileIds: [profileId],
    });
  });

  it("retains repairs that race another cleanup producer", async () => {
    const loginUid = uniqueId("login");
    const profileId = await createProfile([loginUid]);
    const racingStore = createProfileLinkCatchupStore(
      beforeBatch(async () => {
        await store.mergeCleanup({
          loginUid,
          profileId,
          cleanupProfileIds: ["first-shadow"],
          requestId: uniqueId("first"),
          nowMs: 2_000,
        });
      }),
    );
    const merged = await racingStore.mergeCleanup({
      loginUid,
      profileId,
      cleanupProfileIds: ["second-shadow"],
      requestId: uniqueId("second"),
      nowMs: 2_100,
    });
    expect(merged?.cleanupProfileIds).toEqual([
      "first-shadow",
      "second-shadow",
    ]);
  });

  it("guards dispatch, cursor progress, and settlement independently", async () => {
    const loginUid = uniqueId("login");
    await createProfile([loginUid]);
    const job = await store.read(loginUid);
    if (!job) throw new Error("missing-test-job");
    expect(
      await store.claimDispatch(loginUid, job.requestId, 1_000, 2_000),
    ).toBe(true);
    expect(
      await store.claimDispatch(loginUid, job.requestId, 1_000, 2_000),
    ).toBe(false);
    expect(
      await store.claimDispatch(loginUid, job.requestId, 2_000, 2_000),
    ).toBe(false);
    expect(
      await store.advance(loginUid, job.requestId, null, "match-1", 2_010),
    ).toBe(true);
    expect(
      await store.advance(loginUid, job.requestId, null, "match-2", 2_020),
    ).toBe(false);
    expect(await store.settle(loginUid, job.requestId, null)).toBe(false);
    expect(await store.settle(loginUid, job.requestId, "match-1")).toBe(true);
    expect(await store.read(loginUid)).toBeNull();
  });

  it("does not remove a missing-profile job after an owner is present", async () => {
    const loginUid = uniqueId("login");
    await createProfile([loginUid]);
    const job = await store.read(loginUid);
    if (!job) throw new Error("missing-test-job");
    expect(await store.settleMissing(loginUid, job.requestId, null)).toBe(
      false,
    );
    await db
      .prepare("DELETE FROM profile_login_owners WHERE login_uid = ?")
      .bind(loginUid)
      .run();
    expect(await store.settleMissing(loginUid, job.requestId, null)).toBe(true);
  });

  it("does not recreate completed jobs during an unchanged-owner sync", async () => {
    const loginUid = uniqueId("login");
    const profileId = await createProfile([loginUid]);
    const job = await store.read(loginUid);
    if (!job) throw new Error("missing-test-job");
    await store.settle(loginUid, job.requestId, null);
    expect(
      await store.mergeCleanup({
        loginUid,
        profileId,
        cleanupProfileIds: [profileId],
        requestId: uniqueId("noop"),
        nowMs: 3_000,
      }),
    ).toBeNull();
    const repaired = await store.mergeCleanup({
      loginUid,
      profileId,
      cleanupProfileIds: ["old-shadow"],
      requestId: uniqueId("repair"),
      nowMs: 3_010,
    });
    expect(repaired?.cleanupProfileIds).toEqual(["old-shadow"]);
  });

  it("keeps jobs during frozen writes and rejects malformed persisted records", async () => {
    const loginUid = uniqueId("login");
    const profileId = await createProfile([loginUid]);
    const job = await store.read(loginUid);
    if (!job) throw new Error("missing-test-job");
    await db
      .prepare(
        "UPDATE profile_canonical_control SET state = 'frozen' WHERE singleton = 1",
      )
      .run();
    try {
      expect(
        await store.claimDispatch(loginUid, job.requestId, 1_000, 4_000),
      ).toBe(false);
      expect(
        await store.advance(loginUid, job.requestId, null, "match-1", 4_000),
      ).toBe(false);
      expect(await store.settle(loginUid, job.requestId, null)).toBe(false);
      await expect(
        store.mergeCleanup({
          loginUid,
          profileId,
          cleanupProfileIds: ["old-shadow"],
          requestId: uniqueId("repair"),
          nowMs: 4_000,
        }),
      ).rejects.toBeInstanceOf(CanonicalProfileConflict);
      expect(await store.read(loginUid)).toEqual(job);
    } finally {
      await db
        .prepare(
          "UPDATE profile_canonical_control SET state = 'active' WHERE singleton = 1",
        )
        .run();
    }
    await db
      .prepare(
        "UPDATE profile_link_catchup_jobs SET cleanup_profile_ids_json = '[1]' WHERE login_uid = ?",
      )
      .bind(loginUid)
      .run();
    await expect(store.read(loginUid)).rejects.toBeInstanceOf(
      CanonicalProfileCorruption,
    );
  });
});
