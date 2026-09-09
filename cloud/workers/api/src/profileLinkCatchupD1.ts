import { isCanonicalFirebaseUid, isSafeFirebaseKey } from "./firebaseKeys.ts";
import {
  CanonicalProfileConflict,
  CanonicalProfileCorruption,
} from "./profileCanonicalD1.ts";

const ACTIVE_CONTROL = `EXISTS (
  SELECT 1 FROM profile_canonical_control
  WHERE singleton = 1 AND state = 'active'
)`;

export type ProfileLinkCatchupJob = {
  loginUid: string;
  requestId: string;
  profileId: string;
  cleanupProfileIds: string[];
  matchCursor: string | null;
  sourceUpdatedAtMs: number;
  lastQueuedAtMs: number;
  revision: number;
};

export type ProfileLinkCatchupStore = {
  read(loginUid: string): Promise<ProfileLinkCatchupJob | null>;
  readForOwner(
    loginUid: string,
    profileId: string,
  ): Promise<ProfileLinkCatchupJob | null>;
  listDue(dueBeforeMs: number, limit: number): Promise<ProfileLinkCatchupJob[]>;
  claimDispatch(
    loginUid: string,
    requestId: string,
    expectedLastQueuedAtMs: number,
    nowMs: number,
  ): Promise<boolean>;
  advance(
    loginUid: string,
    requestId: string,
    expectedCursor: string | null,
    nextCursor: string,
    nowMs: number,
  ): Promise<boolean>;
  settle(
    loginUid: string,
    requestId: string,
    expectedCursor: string | null,
  ): Promise<boolean>;
  settleMissing(
    loginUid: string,
    requestId: string,
    expectedCursor: string | null,
  ): Promise<boolean>;
};

type JobRow = {
  login_uid: string;
  request_id: string;
  profile_id: string;
  cleanup_profile_ids_json: string;
  match_cursor: string | null;
  source_updated_at_ms: number;
  last_queued_at_ms: number;
  revision: number;
};

function validTimestamp(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function assertTimestamp(value: number): void {
  if (!validTimestamp(value)) {
    throw new TypeError("invalid-profile-link-catchup-timestamp");
  }
}

function parseJob(row: JobRow): ProfileLinkCatchupJob {
  let cleanupIds: unknown;
  try {
    cleanupIds = JSON.parse(row.cleanup_profile_ids_json) as unknown;
  } catch {
    throw new CanonicalProfileCorruption();
  }
  if (
    !isCanonicalFirebaseUid(row.login_uid) ||
    !isSafeFirebaseKey(row.request_id) ||
    !isSafeFirebaseKey(row.profile_id) ||
    !Array.isArray(cleanupIds) ||
    !cleanupIds.every(
      (value): value is string =>
        typeof value === "string" &&
        isSafeFirebaseKey(value) &&
        value !== row.profile_id,
    ) ||
    new Set(cleanupIds).size !== cleanupIds.length ||
    (row.match_cursor !== null && !isSafeFirebaseKey(row.match_cursor)) ||
    !validTimestamp(row.source_updated_at_ms) ||
    !validTimestamp(row.last_queued_at_ms) ||
    !Number.isSafeInteger(row.revision) ||
    row.revision < 1
  ) {
    throw new CanonicalProfileCorruption();
  }
  return {
    loginUid: row.login_uid,
    requestId: row.request_id,
    profileId: row.profile_id,
    cleanupProfileIds: cleanupIds,
    matchCursor: row.match_cursor,
    sourceUpdatedAtMs: row.source_updated_at_ms,
    lastQueuedAtMs: row.last_queued_at_ms,
    revision: row.revision,
  };
}

export function createProfileLinkCatchupStore(
  db: D1Database,
): ProfileLinkCatchupStore {
  const read = async (loginUid: string) => {
    const row = await db
      .prepare("SELECT * FROM profile_link_catchup_jobs WHERE login_uid = ?")
      .bind(loginUid)
      .first<JobRow>();
    return row ? parseJob(row) : null;
  };

  const settle = async (
    loginUid: string,
    requestId: string,
    expectedCursor: string | null,
    requireMissingOwner: boolean,
  ): Promise<boolean> => {
    const result = await db
      .prepare(
        `DELETE FROM profile_link_catchup_jobs
         WHERE login_uid = ? AND request_id = ? AND match_cursor IS ?
           AND ${ACTIVE_CONTROL}
           ${requireMissingOwner ? "AND NOT EXISTS (SELECT 1 FROM profile_login_owners WHERE login_uid = ?)" : ""}`,
      )
      .bind(
        loginUid,
        requestId,
        expectedCursor,
        ...(requireMissingOwner ? [loginUid] : []),
      )
      .run();
    return result.meta.changes === 1;
  };

  return {
    read,
    async readForOwner(loginUid, profileId) {
      if (!isCanonicalFirebaseUid(loginUid) || !isSafeFirebaseKey(profileId)) {
        throw new TypeError("invalid-profile-link-catchup-owner");
      }
      const session = db.withSession("first-primary");
      const [ownership, jobs] = await session.batch<
        { owner_valid: number } | JobRow
      >([
        session
          .prepare(
            `SELECT ${ACTIVE_CONTROL} AND EXISTS (
               SELECT 1 FROM profile_login_owners AS owner
               JOIN profile_records AS profile ON profile.profile_id = owner.profile_id
               WHERE owner.login_uid = ? AND owner.profile_id = ?
                 AND profile.state = 'active'
             ) AS owner_valid`,
          )
          .bind(loginUid, profileId),
        session
          .prepare(
            "SELECT * FROM profile_link_catchup_jobs WHERE login_uid = ?",
          )
          .bind(loginUid),
      ]);
      const owner = ownership.results[0];
      if (!owner || !("owner_valid" in owner) || owner.owner_valid !== 1) {
        throw new CanonicalProfileConflict();
      }
      const row = jobs.results[0];
      if (!row) return null;
      if (!("login_uid" in row)) throw new CanonicalProfileCorruption();
      const job = parseJob(row);
      if (job.loginUid !== loginUid || job.profileId !== profileId) {
        throw new CanonicalProfileCorruption();
      }
      return job;
    },
    async listDue(dueBeforeMs, limit) {
      assertTimestamp(dueBeforeMs);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
        throw new TypeError("invalid-profile-link-catchup-limit");
      }
      const result = await db
        .prepare(
          `SELECT * FROM profile_link_catchup_jobs
           WHERE last_queued_at_ms <= ?
           ORDER BY last_queued_at_ms, login_uid LIMIT ?`,
        )
        .bind(dueBeforeMs, limit)
        .all<JobRow>();
      return result.results.map(parseJob);
    },
    async claimDispatch(loginUid, requestId, expectedLastQueuedAtMs, nowMs) {
      assertTimestamp(expectedLastQueuedAtMs);
      assertTimestamp(nowMs);
      if (nowMs <= expectedLastQueuedAtMs) return false;
      const result = await db
        .prepare(
          `UPDATE profile_link_catchup_jobs
           SET last_queued_at_ms = ?, revision = revision + 1
           WHERE login_uid = ? AND request_id = ? AND last_queued_at_ms = ?
             AND ${ACTIVE_CONTROL}`,
        )
        .bind(nowMs, loginUid, requestId, expectedLastQueuedAtMs)
        .run();
      return result.meta.changes === 1;
    },
    async advance(loginUid, requestId, expectedCursor, nextCursor, nowMs) {
      assertTimestamp(nowMs);
      if (
        !isSafeFirebaseKey(nextCursor) ||
        (expectedCursor !== null && nextCursor <= expectedCursor)
      ) {
        throw new TypeError("invalid-profile-link-catchup-cursor");
      }
      const result = await db
        .prepare(
          `UPDATE profile_link_catchup_jobs
           SET match_cursor = ?, last_queued_at_ms = ?, revision = revision + 1
           WHERE login_uid = ? AND request_id = ? AND match_cursor IS ?
             AND ${ACTIVE_CONTROL}`,
        )
        .bind(nextCursor, nowMs, loginUid, requestId, expectedCursor)
        .run();
      return result.meta.changes === 1;
    },
    settle: (loginUid, requestId, expectedCursor) =>
      settle(loginUid, requestId, expectedCursor, false),
    settleMissing: (loginUid, requestId, expectedCursor) =>
      settle(loginUid, requestId, expectedCursor, true),
  };
}
