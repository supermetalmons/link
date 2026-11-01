import { env } from "cloudflare:workers";
import type { D1Migration } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createProfileLinkCatchupStore } from "../src/profileLinkCatchupD1.ts";
import { applyRetiredProfileMigrations } from "./profileTestMigrations.ts";

const testEnv = env as Env & { TEST_PROFILE_D1_MIGRATIONS: D1Migration[] };
const db = testEnv.PROFILE_DB;
const jobs = createProfileLinkCatchupStore(db);

async function expectRowsRemaining(count: number) {
  const results = await db.batch([
    db.prepare(
      "SELECT COUNT(*) AS count FROM profile_link_catchup_jobs_canonical",
    ),
    db.prepare(
      "SELECT COUNT(*) AS count FROM profile_link_catchup_quarantine_canonical",
    ),
  ]);
  expect(results.map((result) => result.results)).toEqual([
    [{ count }],
    [{ count }],
  ]);
}

beforeAll(async () => {
  await applyRetiredProfileMigrations(
    db,
    testEnv.TEST_PROFILE_D1_MIGRATIONS,
    "e".repeat(64),
  );
});

beforeEach(async () => {
  await db.batch([
    db.prepare("DELETE FROM profile_link_catchup_jobs_canonical"),
    db.prepare(
      "UPDATE profile_canonical_control SET state = 'active' WHERE singleton = 1",
    ),
    db.prepare(
      `INSERT INTO profile_link_catchup_jobs_canonical (
         login_uid, request_id, profile_id, cleanup_profile_ids_json, match_cursor,
         source_updated_at_ms, last_queued_at_ms, revision
       ) VALUES ('login', 'request', 'profile', '[1]', 'cursor', 100, 0, 1)`,
    ),
  ]);
  const [entry] = await jobs.scanDue(1_000, 10);
  if (!entry || entry.kind !== "invalid")
    throw new Error("invalid-profile-entry-missing");
  expect(await jobs.quarantineInvalidEntry(entry, 1_000)).not.toBeNull();
  await db
    .prepare(
      `UPDATE profile_link_catchup_jobs_canonical
       SET cleanup_profile_ids_json = '[]', revision = revision + 1`,
    )
    .run();
});

describe.each(["settle", "settleMissing"] as const)(
  "profile-link %s after quarantine repair",
  (method) => {
    it("returns success and removes the job and retained marker once", async () => {
      await expectRowsRemaining(1);
      expect(await jobs[method]("login", "request", "cursor")).toBe(true);
      await expectRowsRemaining(0);
      expect(await jobs[method]("login", "request", "cursor")).toBe(false);
    });

    it.each([
      ["stale-request", "cursor"],
      ["request", "stale-cursor"],
    ])(
      "preserves a job for stale request %s or cursor %s",
      async (request, cursor) => {
        expect(await jobs[method]("login", request, cursor)).toBe(false);
        await expectRowsRemaining(1);
      },
    );

    it("preserves the job and marker while writes are frozen", async () => {
      await db
        .prepare(
          "UPDATE profile_canonical_control SET state = 'frozen' WHERE singleton = 1",
        )
        .run();
      expect(await jobs[method]("login", "request", "cursor")).toBe(false);
      await expectRowsRemaining(1);
    });
  },
);
