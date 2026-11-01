import { createEmptyRatingPayload } from "../src/profileCanonical/contracts.ts";
import { materializeProfileFixture as materializeCanonicalProfile } from "../test/profileDataBoundaryFixture.ts";
import { env } from "cloudflare:workers";
import type { D1Migration } from "cloudflare:test";
import { beforeAll, beforeEach, expect, it } from "vitest";
import { commitCanonicalPlan } from "../src/profileCanonicalD1.ts";
import {
  inspectCanonicalAuthRecoverySweepRow,
  listCanonicalAuthRecoverySweepRows,
  readCanonicalAuthRecoveryQuarantineEntry,
} from "../src/profileCanonical/recovery.ts";
import { createProfileLinkCatchupStore } from "../src/profileLinkCatchupD1.ts";
import {
  scanDueRatingEventProgress,
  scanDueRatingProfileGameProjections,
  scanDueRatingTelegramProjections,
} from "../src/ratingProjectionD1.ts";
import {
  parseRecoveryObservation,
  recoveryObservationGuard,
} from "../src/recoveryObservation.ts";
import { applyRetiredProfileMigrations } from "./profileTestMigrations.ts";

const testEnv = env as Env & { TEST_PROFILE_D1_MIGRATIONS: D1Migration[] };
const db = testEnv.PROFILE_DB;
const profileLinks = createProfileLinkCatchupStore(db);
const lanes = [
  "auth",
  "profile-link",
  "event-progress",
  "profile-game",
  "telegram",
] as const;
type Lane = (typeof lanes)[number];
const ratingScans = {
  "event-progress": scanDueRatingEventProgress,
  "profile-game": scanDueRatingProfileGameProjections,
  telegram: scanDueRatingTelegramProjections,
};

function source(lane: Lane) {
  if (lane === "auth") {
    return {
      table: "profile_auth_recovery_jobs_canonical",
      key: "profile_id",
      quarantine: "profile_auth_recovery_quarantine_canonical",
    };
  }
  return lane === "profile-link"
    ? {
        table: "profile_link_catchup_jobs_canonical",
        key: "login_uid",
        quarantine: "profile_link_catchup_quarantine_canonical",
      }
    : {
        table: "rating_updates_canonical",
        key: "operation_id",
        quarantine: "rating_projection_recovery_quarantine_canonical",
      };
}

async function seed(lane: Lane, key: string, revision: "1" | "1.5" | "9e999") {
  if (lane === "auth") {
    await db
      .prepare(
        `INSERT INTO profile_auth_recovery_jobs_canonical (
         profile_id, login_uids_json, source_profile_ids_json, source_phase,
         prize_cursor, phase_started_at_ms, last_enqueued_at_ms,
         created_at_ms, updated_at_ms, revision
       ) VALUES (?, '[]', '[]', 'finalize', NULL, 100, 0, 100, 100, ${revision})`,
      )
      .bind(key)
      .run();
    return;
  }
  if (lane === "profile-link") {
    await db
      .prepare(
        `INSERT INTO profile_link_catchup_jobs_canonical (
         login_uid, request_id, profile_id, cleanup_profile_ids_json, match_cursor,
         source_updated_at_ms, last_queued_at_ms, revision
       ) VALUES (?, 'request', 'profile', '[]', 'saved-cursor', 100, 0, ${revision})`,
      )
      .bind(key)
      .run();
    return;
  }
  await db
    .prepare(
      `INSERT INTO rating_updates_canonical (
       schema_version, operation_id, payload_json, status, invite_id, match_id, player_id,
       opponent_id, owner_uid, owner_token, started_at_ms, updated_at_ms,
       lease_expires_at_ms, completed_at_ms, telegram_projection_state,
       telegram_projection_updated_at_ms, telegram_projection_version,
       profile_game_projection_state, profile_game_projection_updated_at_ms,
       profile_game_projection_version, event_progress_state,
       event_progress_updated_at_ms, event_progress_version, revision
     ) VALUES (1, ?, ?, 'done', ?,
       'match', 'player', 'opponent', 'owner', 'token', 100, 100, 100, 100,
       'pending', 0, 1, 'pending', 0, 1, 'pending', 0, 1, ${revision})`,
    )
    .bind(
      `${key}__match`,
      JSON.stringify({
        ...createEmptyRatingPayload(),
        eventId: "event",
        eventOwned: true,
        isEventMatch: true,
      }),
      key,
    )
    .run();
}

async function scan(lane: Lane, limit = 1) {
  if (lane === "auth") {
    const rows = await listCanonicalAuthRecoverySweepRows(db, 1_000, limit);
    return Promise.all(
      rows.map(async (row) => {
        const inspected = inspectCanonicalAuthRecoverySweepRow(row);
        if (!inspected.quarantineReason) {
          return {
            kind: "candidate" as const,
            value: {
              profileId: inspected.profileId,
              revision: row.revision,
            },
          };
        }
        const entry = await readCanonicalAuthRecoveryQuarantineEntry(
          db,
          inspected.key,
          1_000,
        );
        if (!entry) throw new Error("invalid-auth-entry-missing");
        return { kind: "invalid" as const, source: "auth" as const, ...entry };
      }),
    );
  }
  return lane === "profile-link"
    ? profileLinks.scanDue(1_000, limit)
    : ratingScans[lane](db, 1_000, limit);
}

async function readSources(lane: Lane) {
  const { table, key } = source(lane);
  return (
    await db
      .prepare(
        `SELECT *, typeof(revision) AS revision_type, hex(CAST(revision AS TEXT)) AS revision_hex
     FROM ${table} ORDER BY ${key}`,
      )
      .all()
  ).results;
}

beforeAll(async () => {
  await applyRetiredProfileMigrations(
    db,
    testEnv.TEST_PROFILE_D1_MIGRATIONS,
    "b".repeat(64),
  );
  for (const profileId of ["bad", "healthy"]) {
    const value = materializeCanonicalProfile({
      profile: {
        id: profileId,
        nonce: 1,
        rating: 1500,
        totalManaPoints: 0,
        win: false,
        emoji: 1,
        username: null,
        eth: null,
        sol: null,
        completedProblemIds: [],
        isTutorialCompleted: false,
        mining: {
          lastRockDate: null,
          materials: { dust: 0, slime: 0, gum: 0, metal: 0, ice: 0 },
        },
      },
      createdAtMs: 100,
      updatedAtMs: 100,
    });
    await commitCanonicalPlan(db, {
      expectations: [{ kind: "profile-absent", profileId }],
      mutations: [{ kind: "insert-active-profile", value }],
    });
  }
});

beforeEach(async () => {
  await db.batch([
    db.prepare("DELETE FROM profile_auth_recovery_jobs_canonical"),
    db.prepare("DELETE FROM profile_link_catchup_jobs_canonical"),
    db.prepare("DELETE FROM rating_updates_canonical"),
    db.prepare(
      "UPDATE profile_canonical_control SET state = 'active' WHERE singleton = 1",
    ),
  ]);
});

it.each(lanes)(
  "rejects an infinite %s revision without blocking a healthy neighbour",
  async (lane) => {
    await expect(seed(lane, "bad", "9e999")).rejects.toThrow("INTEGER column");
    await seed(lane, "healthy", "1");
    expect(await scan(lane)).toMatchObject([{ kind: "candidate" }]);
    const { quarantine: table } = source(lane);
    expect((await db.prepare(`SELECT * FROM ${table}`).all()).results).toEqual(
      [],
    );
  },
);

it.each(
  lanes.flatMap((lane) => [
    { lane, from: "1.5" as const, to: "9e999" as const },
    { lane, from: "9e999" as const, to: "1.5" as const },
  ]),
)(
  "preserves a valid $lane record when revisions $from and $to are rejected",
  async ({ lane, from, to }) => {
    await seed(lane, "bad", "1");
    const before = await readSources(lane);
    const { table, key, quarantine: quarantineTable } = source(lane);
    const identity =
      lane === "auth" || lane === "profile-link" ? "bad" : "bad__match";
    for (const revision of [from, to])
      await expect(
        db
          .prepare(
            `UPDATE ${table} SET revision = ${revision} WHERE ${key} = ?`,
          )
          .bind(identity)
          .run(),
      ).rejects.toThrow("INTEGER column");
    expect(await readSources(lane)).toEqual(before);
    expect(
      (await db.prepare(`SELECT * FROM ${quarantineTable}`).all()).results,
    ).toEqual([]);
    expect(await scan(lane)).toMatchObject([{ kind: "candidate" }]);
  },
);

it.each(["Inf", "-Inf"])(
  "keeps the serialized %s REAL invalid without binding a nonfinite number",
  (encoded) => {
    const keyBytes = Array.from(new TextEncoder().encode("key"));
    const raw = Array.from(new TextEncoder().encode(encoded));
    const { observation, value } = parseRecoveryObservation(
      {
        recovery_type_0: "text",
        recovery_bytes_0: keyBytes,
        recovery_real_0: null,
        recovery_type_1: "real",
        recovery_bytes_1: raw,
        recovery_real_1: null,
        recovery_revision_bytes: raw,
      },
      ["key", "revision"],
      1,
    );
    expect(value.revision).toBe(encoded === "Inf" ? Infinity : -Infinity);
    const guard = recoveryObservationGuard(["key", "revision"], observation);
    expect(guard.sql).toContain("CAST(revision AS BLOB) IS ?");
    expect(
      guard.bindings
        .filter((binding) => typeof binding === "number")
        .every(Number.isFinite),
    ).toBe(true);
    expect(guard.bindings.at(-1)).toEqual(Uint8Array.from(raw));
  },
);
