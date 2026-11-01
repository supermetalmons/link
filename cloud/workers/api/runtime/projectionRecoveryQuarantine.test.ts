import { env } from "cloudflare:workers";
import type { D1Migration } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createProfileLinkCatchupStore,
  type ProfileLinkCatchupInvalidEntry,
} from "../src/profileLinkCatchupD1.ts";
import {
  quarantineRatingRecoveryEntry,
  scanDueRatingEventProgress,
  scanDueRatingProfileGameProjections,
  scanDueRatingProfileGameProjectionsPage,
  scanDueRatingTelegramProjections,
  scanDueRatingTelegramProjectionsPage,
} from "../src/ratingProjectionD1.ts";
import { createRatingProjections } from "../src/ratingCanonical/projections.ts";
import type {
  InvalidRatingRecoveryEntry,
  RatingRecoveryProjectionKind,
} from "../src/ratingContracts.ts";
import { applyRetiredProfileMigrations } from "./profileTestMigrations.ts";
import { recoveryScanIdentityFixture } from "../test/recoveryScanPageFixture.ts";
import {
  canonicalRatingFixture,
  canonicalRatingInsert,
} from "./canonicalRatingFixture.ts";

const testEnv = env as Env & { TEST_PROFILE_D1_MIGRATIONS: D1Migration[] };
const db = testEnv.PROFILE_DB;
const profileLinks = createProfileLinkCatchupStore(db);
const ratingScans = {
  "event-progress": scanDueRatingEventProgress,
  "profile-game": scanDueRatingProfileGameProjections,
  telegram: scanDueRatingTelegramProjections,
} as const;
const projectionKinds: RatingRecoveryProjectionKind[] = [
  "event-progress",
  "profile-game",
  "telegram",
];
const prefixes = {
  "event-progress": "event_progress",
  "profile-game": "profile_game_projection",
  telegram: "telegram_projection",
} as const;
const unsafeRevision = "9223372036854775807";
async function seedProfileLink(loginUid = "login", cleanup = "[1]") {
  await db
    .prepare(
      "INSERT INTO profile_link_catchup_jobs_canonical (login_uid,request_id,profile_id,cleanup_profile_ids_json,match_cursor,source_updated_at_ms,last_queued_at_ms,revision) VALUES (?,'request','profile',?,'saved-cursor',100,0,1)",
    )
    .bind(loginUid, cleanup)
    .run();
}
async function seedRating(inviteId = "invite", unsafe = false) {
  const value = canonicalRatingFixture(inviteId);
  await canonicalRatingInsert(db, value).run();
  if (unsafe)
    await db
      .prepare(
        `UPDATE rating_updates_canonical SET revision = ${unsafeRevision} WHERE operation_id = ?`,
      )
      .bind(value.operationId)
      .run();
  return value.operationId;
}
async function invalidProfile(): Promise<ProfileLinkCatchupInvalidEntry> {
  const entry = (await profileLinks.scanDue(1000, 100)).find(
    (entry) => entry.kind === "invalid",
  );
  if (!entry || entry.kind !== "invalid")
    throw new Error("missing-invalid-profile");
  return entry;
}
async function invalidRating(
  kind: RatingRecoveryProjectionKind,
): Promise<InvalidRatingRecoveryEntry> {
  const entry = (await ratingScans[kind](db, 1000, 100)).find(
    (entry) => entry.kind === "invalid",
  );
  if (!entry || entry.kind !== "invalid")
    throw new Error("missing-invalid-rating");
  return entry;
}
async function readSources() {
  return (
    await db.batch([
      db.prepare(
        "SELECT hex(login_uid) AS identity,hex(request_id) AS request,hex(cleanup_profile_ids_json) AS cleanup,hex(match_cursor) AS cursor,CAST(revision AS TEXT) AS revision,last_queued_at_ms FROM profile_link_catchup_jobs_canonical ORDER BY login_uid",
      ),
      db.prepare(
        "SELECT operation_id,payload_json,CAST(revision AS TEXT) AS revision,event_progress_state,event_progress_updated_at_ms,profile_game_projection_state,profile_game_projection_updated_at_ms,telegram_projection_state,telegram_projection_updated_at_ms FROM rating_updates_canonical ORDER BY operation_id",
      ),
    ])
  ).map((result) => result.results);
}
function withScanRows(
  map: (
    rows: Record<string, unknown>[],
  ) => Record<string, unknown>[] | Promise<Record<string, unknown>[]>,
  queries: string[] = [],
): D1Database {
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(statement, {
      get(target, property) {
        if (property === "bind")
          return (...values: unknown[]) => wrap(target.bind(...values));
        if (property === "all")
          return async () => {
            const result = await target.all<Record<string, unknown>>();
            return { ...result, results: await map(result.results) };
          };
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  return new Proxy(db, {
    get(target, property) {
      if (property === "prepare")
        return (query: string) => {
          queries.push(query);
          return wrap(target.prepare(query));
        };
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
beforeAll(async () => {
  await applyRetiredProfileMigrations(
    db,
    testEnv.TEST_PROFILE_D1_MIGRATIONS,
    "a".repeat(64),
  );
});
beforeEach(async () => {
  await db.batch([
    db.prepare("DELETE FROM profile_link_catchup_jobs_canonical"),
    db.prepare("DELETE FROM rating_updates_canonical"),
    db.prepare(
      "UPDATE profile_canonical_control SET state = 'active' WHERE singleton = 1",
    ),
  ]);
});

describe("canonical recovery paging", () => {
  it("excludes visited profile identities before limiting and retains the indexed scan", async () => {
    for (let i = 0; i < 21; i++)
      await seedProfileLink(`login-${String(i).padStart(2, "0")}`, "[]");
    const first = await profileLinks.scanDuePage(1000, 10);
    const queries: string[] = [];
    const next = await createProfileLinkCatchupStore(
      withScanRows((rows) => rows, queries),
    ).scanDuePage(
      1000,
      10,
      first.scannedIdentities.filter((key): key is string => key !== null),
    );
    expect(first.entries).toHaveLength(10);
    expect(next.entries).toHaveLength(10);
    expect(next.entries[0]).toMatchObject({
      kind: "candidate",
      value: { loginUid: "login-10" },
    });
    const query = queries[0];
    if (!query) throw new Error("missing-scan-query");
    const plan = await db
      .prepare(`EXPLAIN QUERY PLAN ${query}`)
      .bind(1000, 10, ...first.scannedIdentities)
      .all<{ detail: string }>();
    expect(plan.results.map((row) => row.detail).join("\n")).toContain(
      "idx_profile_link_catchup_jobs_due_canonical",
    );
    expect(plan.results.map((row) => row.detail).join("\n")).not.toContain(
      "USE TEMP B-TREE FOR ORDER BY",
    );
  });
  it.each(["profile-game", "telegram"] as const)(
    "advances bounded %s rating pages without repeating visited identities",
    async (kind) => {
      for (let i = 0; i < 21; i++)
        await seedRating(`item-${String(i).padStart(2, "0")}`);
      const scan =
        kind === "profile-game"
          ? scanDueRatingProfileGameProjectionsPage
          : scanDueRatingTelegramProjectionsPage;
      const first = await scan(db, 1000, 10);
      const second = await scan(
        db,
        1000,
        10,
        first.scannedIdentities.filter((key): key is string => key !== null),
      );
      expect(first.entries).toHaveLength(10);
      expect(second.entries).toHaveLength(10);
      expect(second.entries[0]).toMatchObject({
        kind: "candidate",
        value: { operationId: "item-10__match" },
      });
      expect(
        new Set([...first.scannedIdentities, ...second.scannedIdentities]).size,
      ).toBe(20);
    },
  );
  it("retains scanned identities when a concurrent deletion removes every inspected row", async () => {
    for (let i = 0; i < 10; i++) await seedProfileLink(`bad-${i}`);
    await seedProfileLink("healthy", "[]");
    const observed = withScanRows(async (rows) => {
      await db
        .prepare(
          "DELETE FROM profile_link_catchup_jobs_canonical WHERE login_uid LIKE 'bad-%'",
        )
        .run();
      return rows;
    });
    const first = await createProfileLinkCatchupStore(observed).scanDuePage(
      1000,
      10,
    );
    expect(first.entries).toEqual([]);
    expect(first.scannedIdentities).toHaveLength(10);
    expect(
      (
        await profileLinks.scanDuePage(
          1000,
          10,
          first.scannedIdentities.filter((key): key is string => key !== null),
        )
      ).entries,
    ).toMatchObject([{ kind: "candidate", value: { loginUid: "healthy" } }]);
  });
  it("processes oversized identities once without retaining oversized continuation tokens", async () => {
    await seedProfileLink("healthy", "[]");
    await seedProfileLink("x".repeat(769), "[]");
    const first = await profileLinks.scanDuePage(1000, 10, [
      recoveryScanIdentityFixture("healthy")!,
    ]);
    expect(first.scannedIdentities).toEqual([null]);
    expect(first.entries).toMatchObject([
      { kind: "invalid", reason: "invalid-login-uid" },
    ]);
  });
});

describe("canonical schema rejection", () => {
  it.each(["1.5", "'invalid'", "x'ff'"])(
    "rejects a non-integer revision %s without altering jobs or outcomes",
    async (revision) => {
      await seedProfileLink("login", "[]");
      await seedRating();
      const before = await readSources();
      await expect(
        db
          .prepare(
            `UPDATE profile_link_catchup_jobs_canonical SET revision = ${revision}`,
          )
          .run(),
      ).rejects.toThrow();
      await expect(
        db
          .prepare(`UPDATE rating_updates_canonical SET revision = ${revision}`)
          .run(),
      ).rejects.toThrow();
      expect(await readSources()).toEqual(before);
    },
  );
  it("rejects BLOB keys and cursors instead of treating them as decoded strings", async () => {
    await seedProfileLink("login", "[]");
    await seedRating();
    const before = await readSources();
    await expect(
      db
        .prepare(
          "UPDATE profile_link_catchup_jobs_canonical SET login_uid = CAST(login_uid AS BLOB)",
        )
        .run(),
    ).rejects.toThrow();
    await expect(
      db
        .prepare(
          "UPDATE profile_link_catchup_jobs_canonical SET match_cursor = X'6162'",
        )
        .run(),
    ).rejects.toThrow();
    await expect(
      db
        .prepare(
          "UPDATE rating_updates_canonical SET operation_id = CAST(operation_id AS BLOB)",
        )
        .run(),
    ).rejects.toThrow();
    expect(await readSources()).toEqual(before);
  });
});

describe("profile-link quarantine isolation", () => {
  it("quarantines a bounded invalid page without changing its rows or starving healthy jobs", async () => {
    for (let i = 0; i < 10; i++) await seedProfileLink(`bad-${i}`);
    await seedProfileLink("healthy", "[]");
    const before = await readSources();
    const page = await profileLinks.scanDue(1000, 10);
    expect(page).toHaveLength(10);
    for (const entry of page) {
      expect(entry.kind).toBe("invalid");
      if (entry.kind === "invalid")
        expect(
          await profileLinks.quarantineInvalidEntry(entry, 2000),
        ).toMatchObject({ reason: "invalid-record", revisionHex: "31" });
    }
    expect(await readSources()).toEqual(before);
    expect(await profileLinks.scanDue(1000, 10)).toMatchObject([
      { kind: "candidate", value: { loginUid: "healthy" } },
    ]);
  });
  it("quarantines once per revision and cascades markers when a job is deleted", async () => {
    await seedProfileLink();
    const entry = await invalidProfile();
    expect(
      await profileLinks.quarantineInvalidEntry(entry, 2000),
    ).not.toBeNull();
    expect(await profileLinks.quarantineInvalidEntry(entry, 3000)).toBeNull();
    await db
      .prepare(
        "UPDATE profile_link_catchup_jobs_canonical SET cleanup_profile_ids_json = '[]'",
      )
      .run();
    expect(await profileLinks.scanDue(1000, 10)).toEqual([]);
    await db
      .prepare("UPDATE profile_link_catchup_jobs_canonical SET revision = 2")
      .run();
    expect(await profileLinks.scanDue(1000, 10)).toMatchObject([
      { kind: "candidate" },
    ]);
    await db.prepare("DELETE FROM profile_link_catchup_jobs_canonical").run();
    expect(
      (
        await db
          .prepare("SELECT * FROM profile_link_catchup_quarantine_canonical")
          .all()
      ).results,
    ).toEqual([]);
  });
  it.each(["same-revision", "new-revision", "recreated", "frozen"] as const)(
    "does not quarantine a %s change after observation",
    async (change) => {
      await seedProfileLink();
      const entry = await invalidProfile();
      if (change === "frozen")
        await db
          .prepare(
            "UPDATE profile_canonical_control SET state = 'frozen' WHERE singleton = 1",
          )
          .run();
      else if (change === "recreated") {
        await db
          .prepare("DELETE FROM profile_link_catchup_jobs_canonical")
          .run();
        await seedProfileLink("login", "[]");
      } else
        await db
          .prepare(
            `UPDATE profile_link_catchup_jobs_canonical SET cleanup_profile_ids_json = '[]'${change === "new-revision" ? ",revision = 2" : ""}`,
          )
          .run();
      const before = await readSources();
      expect(await profileLinks.quarantineInvalidEntry(entry, 2000)).toBeNull();
      expect(await readSources()).toEqual(before);
    },
  );
});

describe("rating quarantine isolation", () => {
  it.each(projectionKinds)(
    "quarantines unsafe %s revisions with their exact SQL token",
    async (kind) => {
      await seedRating("invite", true);
      const before = await readSources();
      const entry = await invalidRating(kind);
      expect(
        await quarantineRatingRecoveryEntry(db, entry, 2000),
      ).toMatchObject({
        projectionKind: kind,
        revisionHex: Buffer.from(unsafeRevision).toString("hex"),
      });
      expect(await quarantineRatingRecoveryEntry(db, entry, 3000)).toBeNull();
      expect(await ratingScans[kind](db, 1000, 10)).toEqual([]);
      expect(
        await db
          .prepare(
            "SELECT revision_token FROM rating_projection_recovery_quarantine_canonical",
          )
          .first("revision_token"),
      ).toBe(unsafeRevision);
      expect(await readSources()).toEqual(before);
    },
  );
  it.each(projectionKinds)(
    "keeps %s quarantine independent from other projection lanes",
    async (kind) => {
      for (let i = 0; i < 10; i++) await seedRating(`bad-${i}`, true);
      await seedRating("healthy");
      const before = await readSources();
      for (const entry of await ratingScans[kind](db, 1000, 10)) {
        if (entry.kind !== "invalid")
          throw new Error("expected-invalid-rating");
        await quarantineRatingRecoveryEntry(db, entry, 2000);
      }
      expect(await ratingScans[kind](db, 1000, 10)).toMatchObject([
        { kind: "candidate", value: { operationId: "healthy__match" } },
      ]);
      for (const other of projectionKinds.filter((other) => other !== kind))
        expect(await ratingScans[other](db, 1000, 10)).toHaveLength(10);
      expect(await readSources()).toEqual(before);
    },
  );
  it.each(
    projectionKinds.flatMap((kind) =>
      (["revised", "recreated", "completed", "claimed", "frozen"] as const).map(
        (change) => ({ kind, change }),
      ),
    ),
  )(
    "does not quarantine a $kind $change change after observation",
    async ({ kind, change }) => {
      await seedRating("invite", true);
      const entry = await invalidRating(kind);
      const prefix = prefixes[kind];
      if (change === "frozen")
        await db
          .prepare(
            "UPDATE profile_canonical_control SET state = 'frozen' WHERE singleton = 1",
          )
          .run();
      else if (change === "recreated") {
        await db.prepare("DELETE FROM rating_updates_canonical").run();
        await seedRating();
      } else
        await db
          .prepare(
            `UPDATE rating_updates_canonical SET ${change === "revised" ? "revision = 2" : change === "completed" ? `${prefix}_state = 'done'` : `${prefix}_updated_at_ms = 2000`}`,
          )
          .run();
      const before = await readSources();
      expect(await quarantineRatingRecoveryEntry(db, entry, 2000)).toBeNull();
      expect(await readSources()).toEqual(before);
    },
  );
  it("refreshes a repaired row before claiming and preserves its immutable identity", async () => {
    const id = await seedRating("invite", true);
    const observed = withScanRows(async (rows) => {
      await db
        .prepare("UPDATE rating_updates_canonical SET revision = 2")
        .run();
      return rows;
    });
    expect(await scanDueRatingEventProgress(observed, 1000, 10)).toMatchObject([
      {
        kind: "candidate",
        value: { operationId: id, revision: 2, eventId: "event" },
      },
    ]);
    expect(
      await createRatingProjections(db, 3).claimRatingEventProgress(
        id,
        2,
        2000,
      ),
    ).toBe(true);
    expect(
      (
        await db
          .prepare(
            "SELECT * FROM rating_projection_recovery_quarantine_canonical",
          )
          .all()
      ).results,
    ).toEqual([]);
  });
});

it("isolates per-row inspection errors and preserves transport failures without quarantine", async () => {
  await seedProfileLink("first", "[]");
  await seedProfileLink("second", "[]");
  await seedRating("first");
  await seedRating("second");
  const unreadable = withScanRows((rows) =>
    rows.map((row, index) =>
      index === 0 ? { ...row, recovery_key_bytes: null } : row,
    ),
  );
  expect(
    await createProfileLinkCatchupStore(unreadable).scanDue(1000, 10),
  ).toMatchObject([
    { kind: "failure" },
    { kind: "candidate", value: { loginUid: "second" } },
  ]);
  for (const scan of Object.values(ratingScans))
    expect(await scan(unreadable, 1000, 10)).toMatchObject([
      { kind: "failure" },
      { kind: "candidate", value: { operationId: "second__match" } },
    ]);
  const error = new Error("transport-unavailable");
  const failed = withScanRows(() => {
    throw error;
  });
  await expect(
    createProfileLinkCatchupStore(failed).scanDue(1000, 10),
  ).rejects.toBe(error);
  for (const scan of Object.values(ratingScans))
    await expect(scan(failed, 1000, 10)).rejects.toBe(error);
  expect(
    (
      await db
        .prepare("SELECT * FROM profile_link_catchup_quarantine_canonical")
        .all()
    ).results,
  ).toEqual([]);
  expect(
    (
      await db
        .prepare(
          "SELECT * FROM rating_projection_recovery_quarantine_canonical",
        )
        .all()
    ).results,
  ).toEqual([]);
});
