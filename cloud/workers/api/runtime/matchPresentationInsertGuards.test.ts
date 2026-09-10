import { env } from "cloudflare:workers";
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { beforeAll, beforeEach, expect, it } from "vitest";
import {
  buildMatchPresentationRegistrationStatements,
  type MatchPresentationRegistration,
} from "../src/matchPresentationRegistry.ts";
import { resetMatchPresentationTestState } from "./matchPresentationTestFixture.ts";

const testEnv = env as Env & { TEST_D1_MIGRATIONS: D1Migration[] };
const db = env.PROFILE_GAMES_DB;
const original: MatchPresentationRegistration = {
  inviteId: "invite",
  matchId: "invite",
  actorUid: "actor",
  seedDigest: "a".repeat(64),
  provenance: "creation",
  sourceId: "original-creation",
};

beforeAll(() => applyD1Migrations(db, testEnv.TEST_D1_MIGRATIONS));
beforeEach(() =>
  resetMatchPresentationTestState(db, testEnv.TEST_D1_MIGRATIONS, true),
);

function replace(row: MatchPresentationRegistration, nowMs = 20) {
  return db
    .prepare(
      `INSERT OR REPLACE INTO match_presentation_registrations
       (invite_id, match_id, actor_uid, seed_digest, provenance, source_id, registered_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      row.inviteId,
      row.matchId,
      row.actorUid,
      row.seedDigest,
      row.provenance,
      row.sourceId,
      nowMs,
    )
    .run();
}

it("blocks replacement of durable authority with local D1 recursive triggers disabled", async () => {
  await db.prepare("PRAGMA recursive_triggers = OFF").run();
  await db
    .prepare(
      `UPDATE match_presentation_control SET phase = 'durable',
       source_digest = ?, source_count = 0, verification_digest = ?,
       verified_at_ms = 2, activated_at_ms = 3 WHERE singleton = 1`,
    )
    .bind("b".repeat(64), "c".repeat(64))
    .run();
  const stored = await db
    .prepare("SELECT * FROM match_presentation_control")
    .first();
  await expect(
    db
      .prepare(
        "INSERT OR REPLACE INTO match_presentation_control (singleton, phase) VALUES (1, 'legacy')",
      )
      .run(),
  ).rejects.toThrow("match-presentation-authority-conflict");
  expect(
    await db.prepare("SELECT * FROM match_presentation_control").first(),
  ).toEqual(stored);
});

it("preserves initial provenance, source and time across creation, import and replacement retries", async () => {
  await db.batch(
    buildMatchPresentationRegistrationStatements(db, [original], 10),
  );
  const stored = await db
    .prepare("SELECT * FROM match_presentation_registrations")
    .first();
  const retry = {
    ...original,
    provenance: "backfill" as const,
    sourceId: "later-import",
  };
  await db.batch(buildMatchPresentationRegistrationStatements(db, [retry], 20));
  await replace(retry, 30);
  expect(
    await db.prepare("SELECT * FROM match_presentation_registrations").first(),
  ).toEqual(stored);
  const next = { ...original, actorUid: "new-actor", sourceId: "new-creation" };
  await db.batch(buildMatchPresentationRegistrationStatements(db, [next], 40));
  expect(
    await db
      .prepare("SELECT COUNT(*) AS count FROM match_presentation_registrations")
      .first("count"),
  ).toBe(2);
});

it("rejects conflicting invite or seed replacement without changing the original registration", async () => {
  await db.batch(
    buildMatchPresentationRegistrationStatements(db, [original], 10),
  );
  const stored = await db
    .prepare("SELECT * FROM match_presentation_registrations")
    .first();
  for (const conflict of [
    { ...original, inviteId: "different-invite" },
    { ...original, seedDigest: "d".repeat(64) },
  ]) {
    await expect(replace(conflict)).rejects.toThrow(
      "match-presentation-registration-immutable",
    );
    expect(
      await db
        .prepare("SELECT * FROM match_presentation_registrations")
        .first(),
    ).toEqual(stored);
  }
});

it("rejects exception actors regardless of which insertion guard runs first", async () => {
  await db
    .prepare(
      "UPDATE match_presentation_control SET source_digest = ? WHERE singleton = 1",
    )
    .bind("b".repeat(64))
    .run();
  await db
    .prepare(
      `INSERT INTO match_presentation_source_exceptions
     (migration_id, invite_id, match_id, actor_uid, disposition, seed_digest,
      source_digest, source_json, evidence_json, canonical_actor_uid,
      canonical_seed_digest, manifest_digest, imported_at_ms)
     VALUES ('00000000-0000-4000-8000-000000000002', 'invite', 'invite', 'actor',
       'archive', ?, ?, '{}', '{}', NULL, NULL, ?, 10)`,
    )
    .bind(original.seedDigest, "c".repeat(64), "b".repeat(64))
    .run();
  const exceptions = testEnv.TEST_D1_MIGRATIONS.find((migration) =>
    migration.name.includes("0022_match_presentation_source_exceptions"),
  );
  const guard = exceptions?.queries.find((query) =>
    query.includes(
      "CREATE TRIGGER match_presentation_registration_exception_guard",
    ),
  );
  if (!guard) throw new Error("missing-source-exception-test-guard");
  for (const reorder of [false, true]) {
    if (reorder) {
      await db
        .prepare("DROP TRIGGER match_presentation_registration_exception_guard")
        .run();
      await db.prepare(guard).run();
    }
    await expect(replace(original)).rejects.toThrow(
      "match-presentation-exception-live-actor",
    );
    await expect(
      db.batch(
        buildMatchPresentationRegistrationStatements(db, [original], 20),
      ),
    ).rejects.toThrow("match-presentation-exception-live-actor");
  }
  expect(
    await db
      .prepare("SELECT COUNT(*) AS count FROM match_presentation_registrations")
      .first("count"),
  ).toBe(0);
});
