import { env } from "cloudflare:workers";
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { beforeAll, expect, it } from "vitest";
import {
  buildActivationSql,
  buildClaimSql,
  buildImportBatches,
  buildVerificationSql,
  migrateProfileLinkCatchup,
  parseImport,
  parseProof,
  rebuildJobs,
  type Dependencies,
  type Import,
} from "../../../../scripts/migrate-profile-link-catchup.ts";
import {
  digest,
  QUEUE_NAMES,
} from "../../../../scripts/migrate-wager-reservations.ts";
import {
  commitCanonicalPlan,
  materializeCanonicalProfile,
} from "../src/profileCanonicalD1.ts";
import { createProfileLinkCatchupStore } from "../src/profileLinkCatchupD1.ts";
import { createProfileGameProjectionLockStore } from "../src/profileGameProjectionLocksD1.ts";
import {
  processProfileLinkProfileGameProjection,
  sweepProfileLinkProfileGameProjections,
} from "../src/profileGameProjection.ts";
import {
  parseProfileGameProjectionTask,
  type ProfileLinkProfileGameProjectionTask,
} from "../src/profileGameProjectionTasks.ts";
import { applyRetiredProfileMigrations } from "./profileTestMigrations.ts";

const testEnv = env as Env & {
  TEST_D1_MIGRATIONS: D1Migration[];
  TEST_PROFILE_D1_MIGRATIONS: D1Migration[];
  TEST_EVENT_RTDB_EMULATOR_HOST: string;
};
const FIRST = 1_000_000;
const FINAL = 2_000_000;
const SOURCE_ROOT = "profileGameProjectionOutbox/profile";
const profileId = "rehearsal-profile";

beforeAll(async () => {
  await applyRetiredProfileMigrations(
    testEnv.PROFILE_DB,
    testEnv.TEST_PROFILE_D1_MIGRATIONS,
    "f".repeat(64),
  );
  await applyD1Migrations(testEnv.PROFILE_GAMES_DB, testEnv.TEST_D1_MIGRATIONS);
});

it.runIf(Boolean(testEnv.TEST_EVENT_RTDB_EMULATOR_HOST))(
  "rehearses profile-link import, interrupted recovery, and resumed D1 jobs against RTDB",
  async () => {
    expect(testEnv.TEST_EVENT_RTDB_EMULATOR_HOST).toMatch(
      /^(?:127\.0\.0\.1|localhost):\d+$/,
    );
    const namespace = `demo-mons-profile-link-${crypto.randomUUID()}`;
    const db = testEnv.PROFILE_DB;
    const jobs = createProfileLinkCatchupStore(db);
    const locks = createProfileGameProjectionLockStore(
      testEnv.PROFILE_GAMES_DB,
    );
    const rtdb = async (
      method: string,
      path: string,
      value?: unknown,
    ): Promise<unknown> => {
      const response = await fetch(
        `http://${testEnv.TEST_EVENT_RTDB_EMULATOR_HOST}/${path}.json?ns=${namespace}`,
        {
          method,
          headers: {
            Authorization: "Bearer owner",
            "Content-Type": "application/json",
          },
          body: value === undefined ? undefined : JSON.stringify(value),
        },
      );
      if (!response.ok) throw new Error(`RTDB emulator: ${response.status}`);
      return response.json();
    };
    const statements = (sql: string) =>
      sql
        .split(";")
        .map((statement) => statement.trim())
        .filter(Boolean);
    const executeSql = (sql: string) =>
      db.batch(statements(sql).map((statement) => db.prepare(statement)));
    const proof = async () =>
      parseProof(
        (await db
          .prepare(
            "SELECT * FROM profile_link_catchup_import WHERE singleton = 1",
          )
          .first<Record<string, unknown>>()) || undefined,
      );
    const logins = ["login-valid", "login-stale", "login-malformed"];
    const profile = materializeCanonicalProfile({
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
      createdAtMs: 100,
      updatedAtMs: 100,
    });
    await commitCanonicalPlan(db, {
      expectations: [
        { kind: "profile-absent", profileId },
        ...logins.map((loginUid) => ({
          kind: "login-owner-absent" as const,
          loginUid,
        })),
      ],
      mutations: [
        { kind: "insert-active-profile", value: profile },
        ...logins.map((loginUid) => ({
          kind: "insert-login-owner" as const,
          value: { loginUid, profileId, createdAtMs: 100, updatedAtMs: 100 },
        })),
      ],
    });
    const valid = {
      schemaVersion: 1,
      status: "pending",
      requestId: "legacy-valid-request",
      profileId,
      cleanupProfileIds: { "former-owner": true },
      matchCursor: "match-1",
      sourceUpdatedAtMs: 100,
      lastQueuedAtMs: 120,
    };
    const originalSource = {
      "login-valid": valid,
      "login-stale": {
        ...valid,
        requestId: "legacy-stale-request",
        profileId: "retired-owner",
      },
      "login-malformed": {
        profileId: "older-owner",
        cleanupProfileIds: { "salvaged-owner": true, ignored: false },
        matchCursor: "invalid/cursor",
      },
    };
    try {
      await rtdb("PATCH", "", {
        [SOURCE_ROOT]: originalSource,
        "players/login-valid/matches": {
          "match-1": { fen: "preserved-1" },
          "match-2": { fen: "preserved-2" },
          "match-3": { fen: "preserved-3" },
        },
        "invites/match-2": { hostId: "login-valid", guestId: "opponent" },
      });
      const retainedGameplay = await rtdb("GET", "players/login-valid/matches");
      await db
        .prepare(
          "UPDATE profile_canonical_control SET state = 'frozen' WHERE singleton = 1",
        )
        .run();
      await db.prepare("DELETE FROM profile_link_catchup_jobs").run();
      const source = (await rtdb("GET", SOURCE_ROOT)) as Record<
        string,
        unknown
      >;
      const ownersResult = await db
        .prepare(
          "SELECT login_uid, profile_id FROM profile_login_owners ORDER BY login_uid",
        )
        .all<{ login_uid: string; profile_id: string }>();
      const owners = Object.fromEntries(
        ownersResult.results.map((owner) => [
          owner.login_uid,
          owner.profile_id,
        ]),
      );
      const rebuilt = rebuildJobs(source, owners, FIRST);
      expect(rebuilt.rebuilt).toBe(2);
      expect(rebuilt.unresolved).toEqual([]);
      expect(
        rebuilt.jobs.find((job) => job.loginUid === "login-valid"),
      ).toMatchObject({
        requestId: valid.requestId,
        matchCursor: "match-1",
        sourceUpdatedAtMs: 100,
        lastQueuedAtMs: 120,
      });
      expect(
        rebuilt.jobs.find((job) => job.loginUid === "login-stale"),
      ).toMatchObject({
        cleanupProfileIds: ["former-owner", "retired-owner"],
        matchCursor: null,
      });
      expect(
        rebuilt.jobs.find((job) => job.loginUid === "login-malformed"),
      ).toMatchObject({
        cleanupProfileIds: ["older-owner", "salvaged-owner"],
        matchCursor: null,
      });
      const imported: Import = parseImport({
        schemaVersion: 1,
        project: "mons-link",
        exportedAtMs: FIRST,
        sourceDigest: digest(source),
        ownersDigest: digest(owners),
        evidence: {
          bridgeVersionId: "source-version",
          bridgeDeployedAtMs: 1_000,
          queuesPausedAtMs: Object.fromEntries(
            QUEUE_NAMES.map((name) => [name, 10_000]),
          ),
          legacyWritersDrained: true,
          recordedAtMs: 20_000,
        },
        source,
        owners,
        importAttemptId: "interrupted-attempt",
        finalExportedAtMs: FINAL,
        importDigest: digest(rebuilt.jobs),
        jobs: rebuilt.jobs,
      });
      await executeSql(buildClaimSql(imported, FINAL));
      const firstBatch = statements(
        buildImportBatches(imported.jobs, imported.importAttemptId)[0],
      );
      await executeSql(firstBatch.slice(0, 3).join(";"));
      expect(
        await db
          .prepare("SELECT COUNT(*) AS count FROM profile_link_catchup_jobs")
          .first("count"),
      ).toBe(1);
      expect((await proof()).verifiedAtMs).toBeNull();
      await expect(
        executeSql(
          buildActivationSql(imported, "candidate-version", FINAL + 1),
        ),
      ).rejects.toThrow();
      const retry = { ...imported, importAttemptId: "retry-attempt" };
      await executeSql(
        buildClaimSql(retry, FINAL + 10, imported.importAttemptId),
      );
      await expect(
        executeSql(
          buildImportBatches(imported.jobs, imported.importAttemptId)[0],
        ),
      ).rejects.toThrow();
      for (const batch of buildImportBatches(
        retry.jobs,
        retry.importAttemptId,
      )) {
        await executeSql(batch);
      }
      const readback = await Promise.all(
        retry.jobs.map((job) => jobs.read(job.loginUid)),
      );
      expect(digest(readback)).toBe(retry.importDigest);
      expect(digest(await rtdb("GET", SOURCE_ROOT))).toBe(retry.sourceDigest);
      await executeSql(buildVerificationSql(retry, FINAL + 20));
      expect((await proof()).verifiedAtMs).toBe(FINAL + 20);

      await rtdb("PATCH", `${SOURCE_ROOT}/login-valid`, {
        lastQueuedAtMs: 121,
      });
      const changedSource = await rtdb("GET", SOURCE_ROOT);
      const currentProof = await proof();
      const attemptedSql: string[] = [];
      const dependencies: Dependencies = {
        now: () => FINAL + 30,
        log() {},
        readJson: () => retry,
        readSource: () => changedSource,
        readOwners: () => owners,
        readJobs: () => retry.jobs,
        readProof: () => currentProof,
        inspect: () => ({
          canonicalState: "frozen",
          activeProjectionLeases: 0,
          deployment: {
            versionId: "candidate-version",
            deployedAtMs: FINAL + 25,
          },
        }),
        executeSql: (sql) => attemptedSql.push(sql),
        persistArtifacts: () => "unused",
      };
      expect(() =>
        migrateProfileLinkCatchup(
          {
            phase: "record-activation",
            project: "mons-link",
            importFile: "import.json",
            versionId: "candidate-version",
          },
          dependencies,
          {} as NodeJS.ProcessEnv,
        ),
      ).toThrow("Firebase profile-link source changed");
      expect(attemptedSql).toEqual([]);
      await rtdb("PUT", SOURCE_ROOT, originalSource);
      expect(digest(await rtdb("GET", SOURCE_ROOT))).toBe(retry.sourceDigest);
      await executeSql(
        buildActivationSql(retry, "candidate-version", FINAL + 40),
      );
      expect((await proof()).activatedVersionId).toBe("candidate-version");
      await expect(
        executeSql(
          buildClaimSql(
            { ...retry, importAttemptId: "forbidden-import" },
            FINAL + 50,
          ),
        ),
      ).rejects.toThrow();
      await db
        .prepare(
          "UPDATE profile_canonical_control SET state = 'active' WHERE singleton = 1",
        )
        .run();
      const queued: ProfileLinkProfileGameProjectionTask[] = [];
      const captureTask = (value: unknown) => {
        const task = parseProfileGameProjectionTask(value);
        if (task?.kind !== "profile-link-profile-game-projection") {
          throw new Error("unexpected-rehearsal-queue-task");
        }
        queued.push(task);
      };
      const queue: Queue = {
        async metrics() {
          return { backlogCount: queued.length, backlogBytes: 0 };
        },
        async send(body) {
          captureTask(body);
          return {
            metadata: {
              metrics: { backlogCount: queued.length, backlogBytes: 0 },
            },
          };
        },
        async sendBatch(messages) {
          for (const message of messages) captureTask(message.body);
          return {
            metadata: {
              metrics: { backlogCount: queued.length, backlogBytes: 0 },
            },
          };
        },
      };
      expect(
        await sweepProfileLinkProfileGameProjections(
          {
            ...testEnv,
            PROFILE_GAME_PROJECTION_QUEUE: queue,
          },
          { now: () => FINAL + 100, createProfileLinkJobs: () => jobs },
        ),
      ).toBe(3);
      expect(queued).toHaveLength(3);
      let staleProcessed = false;
      expect(
        await processProfileLinkProfileGameProjection(
          {
            kind: "profile-link-profile-game-projection",
            loginUid: "login-stale",
            requestId: "legacy-stale-request",
          },
          jobs,
          async () => {
            staleProcessed = true;
            return null;
          },
          locks,
        ),
      ).toBe("stale");
      expect(staleProcessed).toBe(false);
      const validTask = queued.find((task) => task.loginUid === "login-valid");
      if (!validTask) throw new Error("missing-valid-queued-job");
      expect(
        await processProfileLinkProfileGameProjection(
          validTask,
          jobs,
          async (input) => {
            expect(input.matchCursor).toBe("match-1");
            const matches = (await rtdb(
              "GET",
              `players/${input.loginUid}/matches`,
            )) as Record<string, unknown>;
            expect(
              Object.keys(matches).filter((id) => id > input.matchCursor!),
            ).toEqual(["match-2", "match-3"]);
            await input.withInviteProjectionLock("match-2", async () => {
              expect(await rtdb("GET", "invites/match-2")).toMatchObject({
                hostId: "login-valid",
              });
            });
            return { didHitInviteCap: true, nextMatchCursor: "match-2" };
          },
          locks,
          "first-page",
          () => FINAL + 110,
        ),
      ).toBe("continued");
      expect((await jobs.read("login-valid"))?.matchCursor).toBe("match-2");
      expect(
        await processProfileLinkProfileGameProjection(
          validTask,
          jobs,
          async (input) => {
            expect(input.matchCursor).toBe("match-2");
            return { didHitInviteCap: false, nextMatchCursor: null };
          },
          locks,
          "last-page",
          () => FINAL + 120,
        ),
      ).toBe("projected");
      expect(await jobs.read("login-valid")).toBeNull();
      expect(await rtdb("GET", "players/login-valid/matches")).toEqual(
        retainedGameplay,
      );
      expect(await rtdb("GET", SOURCE_ROOT)).toEqual(originalSource);
    } finally {
      await rtdb("DELETE", "");
    }
  },
);
