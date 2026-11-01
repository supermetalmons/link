import { createEmptyRatingPayload } from "../src/profileCanonical/contracts.ts";
import { env } from "cloudflare:workers";
import type { D1Migration } from "cloudflare:test";
import { beforeAll, beforeEach, expect, it } from "vitest";
import { createProfileLinkCatchupStore } from "../src/profileLinkCatchupD1.ts";
import { projectionRecoveryPages } from "../src/projectionRecoveryPages.ts";
import { scanDueRatingEventProgress } from "../src/ratingProjectionD1.ts";
import { applyRetiredProfileMigrations } from "./profileTestMigrations.ts";

const testEnv = env as Env & { TEST_PROFILE_D1_MIGRATIONS: D1Migration[] };
const db = testEnv.PROFILE_DB;
const MAX_D1_VALUE_BYTES = 2_000_000;

function checkValueSize(value: unknown): void {
  if (typeof value === "string") {
    if (new TextEncoder().encode(value).byteLength > MAX_D1_VALUE_BYTES)
      throw new Error("d1-value-size-limit");
  } else if (ArrayBuffer.isView(value)) {
    if (value.byteLength > MAX_D1_VALUE_BYTES)
      throw new Error("d1-value-size-limit");
  } else if (value instanceof ArrayBuffer) {
    if (value.byteLength > MAX_D1_VALUE_BYTES)
      throw new Error("d1-value-size-limit");
  } else if (Array.isArray(value)) {
    if (value.length && typeof value[0] === "number") {
      if (value.length > MAX_D1_VALUE_BYTES)
        throw new Error("d1-value-size-limit");
    } else {
      value.forEach(checkValueSize);
    }
  } else if (value && typeof value === "object") {
    Object.values(value).forEach(checkValueSize);
  }
}

function sizeCheckedDatabase(
  queries: string[] = [],
  afterRead: () => Promise<void> = async () => {},
): D1Database {
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(statement, {
      get(target, property) {
        if (property === "bind") {
          return (...values: unknown[]) => {
            values.forEach(checkValueSize);
            return wrap(target.bind(...values));
          };
        }
        if (property === "all") {
          return async () => {
            const result = await target.all();
            checkValueSize(result.results);
            await afterRead();
            return result;
          };
        }
        if (property === "first") {
          return async (column?: string) => {
            const result =
              column === undefined
                ? await target.first()
                : await target.first(column);
            checkValueSize(result);
            await afterRead();
            return result;
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  return new Proxy(db, {
    get(target, property) {
      if (property === "prepare") {
        return (query: string) => {
          queries.push(query);
          return wrap(target.prepare(query));
        };
      }
      if (property === "withSession") {
        return (constraint?: string) =>
          new Proxy(target.withSession(constraint), {
            get(session, member) {
              if (member === "prepare") {
                return (query: string) => {
                  queries.push(query);
                  return wrap(session.prepare(query));
                };
              }
              const value = Reflect.get(session, member, session);
              return typeof value === "function" ? value.bind(session) : value;
            },
          });
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function largeCleanupIds(): string[] {
  return Array.from(
    { length: 2_000 },
    (_, index) => String(index).padStart(5, "0") + "a".repeat(540),
  );
}

async function seedProfileLink(loginUid: string, cleanup: string) {
  await db
    .prepare(
      `INSERT INTO profile_link_catchup_jobs_canonical (
       login_uid, request_id, profile_id, cleanup_profile_ids_json, match_cursor,
       source_updated_at_ms, last_queued_at_ms, revision
     ) VALUES (?, 'request', 'profile', ?, NULL, 100, 0, 1)`,
    )
    .bind(loginUid, cleanup)
    .run();
}

async function seedRating(eventId: string) {
  await db
    .prepare(
      `INSERT INTO rating_updates_canonical (
       operation_id, payload_json, status, invite_id, match_id, player_id,
       opponent_id, owner_uid, owner_token, started_at_ms, updated_at_ms,
       lease_expires_at_ms, completed_at_ms, event_progress_state,
       event_progress_updated_at_ms, event_progress_version, revision
     ) VALUES ('invite__match', ?, 'done', 'invite', 'match', 'player', 'opponent',
       'owner', 'token', 100, 100, 100, 100, 'pending', 0, 1, 1)`,
    )
    .bind(
      JSON.stringify({
        ...createEmptyRatingPayload(),
        eventId,
        eventOwned: true,
        isEventMatch: true,
      }),
    )
    .run();
}

beforeAll(async () => {
  await applyRetiredProfileMigrations(
    db,
    testEnv.TEST_PROFILE_D1_MIGRATIONS,
    "f".repeat(64),
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

it("reads a large valid cleanup list and healthy neighbours in one size-safe scan", async () => {
  const ids = largeCleanupIds();
  const cleanup = JSON.stringify(ids);
  expect(cleanup.length).toBe(1_096_001);
  await seedProfileLink("large", cleanup);
  await seedProfileLink("healthy", "[]");
  const queries: string[] = [];
  const jobs = createProfileLinkCatchupStore(sizeCheckedDatabase(queries));
  const entries = await jobs.scanDue(1_000, 10);
  expect(queries).toHaveLength(1);
  expect(entries).toMatchObject([
    { kind: "candidate", value: { loginUid: "healthy" } },
    { kind: "candidate", value: { loginUid: "large", cleanupProfileIds: ids } },
  ]);
});

it("keeps large valid cleanup records in bounded pages during catch-up", async () => {
  const cleanup = JSON.stringify(largeCleanupIds());
  for (let index = 0; index < 21; index++) {
    await seedProfileLink(
      `login-${String(index).padStart(2, "0")}`,
      index === 0 || index === 10 ? cleanup : "[]",
    );
  }
  const queries: string[] = [];
  const jobs = createProfileLinkCatchupStore(sizeCheckedDatabase(queries));
  const pageSizes: number[] = [];
  const visited: string[] = [];
  for await (const { entries } of projectionRecoveryPages((excluded) =>
    jobs.scanDuePage(1_000, 10, excluded),
  )) {
    pageSizes.push(entries.length);
    for (const entry of entries) {
      expect(entry.kind).toBe("candidate");
      if (entry.kind !== "candidate") throw new Error("unexpected-invalid-job");
      visited.push(entry.value.loginUid);
      if (
        entry.value.loginUid === "login-00" ||
        entry.value.loginUid === "login-10"
      )
        expect(entry.value.cleanupProfileIds).toHaveLength(2_000);
    }
  }
  expect(queries).toHaveLength(2);
  expect(pageSizes).toEqual([10, 10]);
  expect(visited).toEqual(
    Array.from(
      { length: 20 },
      (_, index) => `login-${String(index).padStart(2, "0")}`,
    ),
  );
});

it("quarantines large malformed JSON without expanding or rewriting it", async () => {
  const cleanup = JSON.stringify([1, ...largeCleanupIds()]);
  await seedProfileLink("large", cleanup);
  await seedProfileLink("healthy", "[]");
  const jobs = createProfileLinkCatchupStore(sizeCheckedDatabase());
  const entries = await jobs.scanDue(1_000, 10);
  const invalid = entries.find((entry) => entry.kind === "invalid");
  if (!invalid || invalid.kind !== "invalid")
    throw new Error("expected-invalid");
  expect(await jobs.quarantineInvalidEntry(invalid, 2_000)).not.toBeNull();
  expect(await jobs.scanDue(1_000, 10)).toMatchObject([
    { kind: "candidate", value: { loginUid: "healthy" } },
  ]);
  expect(
    await db
      .prepare(
        "SELECT cleanup_profile_ids_json FROM profile_link_catchup_jobs_canonical WHERE login_uid = 'large'",
      )
      .first("cleanup_profile_ids_json"),
  ).toBe(cleanup);
});

it("preserves a large same-revision repair including changes at the end of the value", async () => {
  const ids = largeCleanupIds();
  await seedProfileLink("large", JSON.stringify([...ids, 1]));
  const jobs = createProfileLinkCatchupStore(sizeCheckedDatabase());
  const [entry] = await jobs.scanDue(1_000, 10);
  if (!entry || entry.kind !== "invalid") throw new Error("expected-invalid");
  const repaired = JSON.stringify([...ids, "repaired"]);
  await db
    .prepare(
      "UPDATE profile_link_catchup_jobs_canonical SET cleanup_profile_ids_json = ?",
    )
    .bind(repaired)
    .run();
  expect(await jobs.quarantineInvalidEntry(entry, 2_000)).toBeNull();
  expect(await jobs.scanDue(1_000, 10)).toMatchObject([{ kind: "candidate" }]);
});

it("rejects large BLOB cursors without rewriting the valid cleanup record", async () => {
  await seedProfileLink("large", "[]");
  await expect(
    db
      .prepare(
        "UPDATE profile_link_catchup_jobs_canonical SET match_cursor = ?",
      )
      .bind(new Uint8Array(550_000).fill(255))
      .run(),
  ).rejects.toThrow("BLOB");
  expect(
    await createProfileLinkCatchupStore(sizeCheckedDatabase()).scanDue(
      1_000,
      10,
    ),
  ).toMatchObject([
    { kind: "candidate", value: { loginUid: "large", matchCursor: null } },
  ]);
});

it("rejects adjacent REAL revisions without changing stored revision identity", async () => {
  await seedProfileLink("job", "[]");
  for (const revision of [1.0000000000000002, 1.0000000000000004])
    await expect(
      db
        .prepare("UPDATE profile_link_catchup_jobs_canonical SET revision = ?")
        .bind(revision)
        .run(),
    ).rejects.toThrow("INTEGER column");
  expect(
    await createProfileLinkCatchupStore(sizeCheckedDatabase()).scanDue(
      1_000,
      10,
    ),
  ).toMatchObject([{ kind: "candidate", value: { revision: 1 } }]);
});

it("reads large canonical rating event metadata without expansion and keeps outcomes immutable", async () => {
  const eventId = "e".repeat(600_000);
  await seedRating(eventId);
  const observed = sizeCheckedDatabase();
  expect(await scanDueRatingEventProgress(observed, 1_000, 10)).toMatchObject([
    { kind: "candidate", value: { eventId } },
  ]);
  await expect(
    db
      .prepare(
        "UPDATE rating_updates_canonical SET payload_json = json_set(payload_json, '$.eventId', ?) WHERE operation_id = 'invite__match'",
      )
      .bind(eventId.slice(0, -1) + "x")
      .run(),
  ).rejects.toThrow("immutable");
  expect(await scanDueRatingEventProgress(observed, 1_000, 10)).toMatchObject([
    { kind: "candidate", value: { eventId } },
  ]);
});

it.each(["repaired", "deleted", "rescheduled"] as const)(
  "rechecks a malformed job %s before its exact observation is captured",
  async (change) => {
    await seedProfileLink("first", "[1]");
    await seedProfileLink("healthy", "[]");
    let firstRead = true;
    const observed = sizeCheckedDatabase([], async () => {
      if (!firstRead) return;
      firstRead = false;
      const query = {
        repaired:
          "UPDATE profile_link_catchup_jobs_canonical SET cleanup_profile_ids_json = '[]' WHERE login_uid = 'first'",
        deleted:
          "DELETE FROM profile_link_catchup_jobs_canonical WHERE login_uid = 'first'",
        rescheduled:
          "UPDATE profile_link_catchup_jobs_canonical SET last_queued_at_ms = 2000 WHERE login_uid = 'first'",
      }[change];
      await db.prepare(query).run();
    });
    const entries = await createProfileLinkCatchupStore(observed).scanDue(
      1_000,
      10,
    );
    expect(entries).toMatchObject(
      change === "repaired"
        ? [
            { kind: "candidate", value: { loginUid: "first" } },
            { kind: "candidate", value: { loginUid: "healthy" } },
          ]
        : [{ kind: "candidate", value: { loginUid: "healthy" } }],
    );
    expect(
      (
        await db
          .prepare("SELECT * FROM profile_link_catchup_quarantine_canonical")
          .all()
      ).results,
    ).toEqual([]);
  },
);
