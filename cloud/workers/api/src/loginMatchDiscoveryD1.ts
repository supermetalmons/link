import {
  matchDiscoverySortKey,
  type MatchDiscoveryEntry,
  type MatchDiscoveryPage,
  type MatchDiscoveryResolution,
} from "../../../functions/shared/login-match-discovery.js";
import { isCanonicalFirebaseUid, isSafeFirebaseKey } from "./firebaseKeys.ts";

const CAPTURE_BATCH_SIZE = 40;
const MAX_PAGE_SIZE = 20;

export type LoginMatchDiscoveryInput = {
  loginUid: string;
  matchId: string;
  inviteId: string | null;
  resolution: MatchDiscoveryResolution;
  provenance: "capture" | "backfill";
};

export type LoginMatchDiscoveryPage = MatchDiscoveryPage;

type DiscoveryRow = {
  match_id: string;
  match_sort_key: string;
  invite_id: string | null;
  resolution: MatchDiscoveryResolution;
};

function assertInput(row: LoginMatchDiscoveryInput): void {
  if (
    !isCanonicalFirebaseUid(row.loginUid) ||
    !isSafeFirebaseKey(row.matchId) ||
    !["resolved", "missing", "ambiguous"].includes(row.resolution) ||
    !["capture", "backfill"].includes(row.provenance) ||
    (row.resolution === "resolved"
      ? !isSafeFirebaseKey(row.inviteId)
      : row.inviteId !== null)
  ) {
    throw new TypeError("invalid-login-match-discovery-row");
  }
}

export function buildLoginMatchDiscoveryStatements(
  db: D1Database,
  rows: readonly LoginMatchDiscoveryInput[],
  nowMs: number,
): D1PreparedStatement[] {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new TypeError("invalid-login-match-discovery-timestamp");
  }
  return rows.flatMap((row) => {
    assertInput(row);
    return [
      db
        .prepare(
          `INSERT INTO login_match_discovery_guards (singleton)
           SELECT 0 WHERE EXISTS (
             SELECT 1 FROM login_match_discovery
             WHERE login_uid = ? AND match_id = ? AND NOT (
               (resolution = ? AND invite_id IS ?)
               OR (? = 'capture' AND resolution != 'resolved')
               OR (? = 'backfill' AND provenance = 'capture' AND ? != 'resolved')
             )
           )`,
        )
        .bind(
          row.loginUid,
          row.matchId,
          row.resolution,
          row.inviteId,
          row.provenance,
          row.provenance,
          row.resolution,
        ),
      db
        .prepare(
          `INSERT INTO login_match_discovery (
             login_uid, match_id, match_sort_key, invite_id,
             resolution, provenance, indexed_at_ms
           ) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (login_uid, match_id) DO UPDATE SET
             invite_id = CASE WHEN login_match_discovery.resolution = 'resolved'
               THEN login_match_discovery.invite_id ELSE excluded.invite_id END,
             resolution = CASE WHEN login_match_discovery.resolution = 'resolved'
               THEN login_match_discovery.resolution ELSE excluded.resolution END,
             provenance = CASE WHEN excluded.provenance = 'capture'
               THEN 'capture' ELSE login_match_discovery.provenance END
           WHERE (excluded.resolution = 'resolved' AND login_match_discovery.resolution != 'resolved')
             OR (excluded.provenance = 'capture' AND login_match_discovery.provenance != 'capture')`,
        )
        .bind(
          row.loginUid,
          row.matchId,
          matchDiscoverySortKey(row.matchId),
          row.inviteId,
          row.resolution,
          row.provenance,
          nowMs,
        ),
    ];
  });
}

export async function captureLoginMatchDiscovery(
  db: D1Database,
  rows: readonly { loginUid: string; matchId: string; inviteId: string }[],
  nowMs = Date.now(),
): Promise<void> {
  for (let offset = 0; offset < rows.length; offset += CAPTURE_BATCH_SIZE) {
    await db.batch(
      buildLoginMatchDiscoveryStatements(
        db,
        rows.slice(offset, offset + CAPTURE_BATCH_SIZE).map((row) => ({
          ...row,
          resolution: "resolved",
          provenance: "capture",
        })),
        nowMs,
      ),
    );
  }
}

export async function readLoginMatchDiscoveryBackend(
  db: D1Database,
): Promise<"rtdb" | "d1"> {
  const backend = await db
    .withSession("first-primary")
    .prepare(
      "SELECT discovery_backend FROM login_match_discovery_control WHERE singleton = 1",
    )
    .first<string>("discovery_backend");
  if (backend !== "rtdb" && backend !== "d1") {
    throw new Error("login-match-discovery-control-unavailable");
  }
  return backend;
}

export async function listLoginMatchDiscoveryPage(
  db: D1Database,
  loginUid: string,
  afterMatchId: string | null,
  limit: number,
): Promise<LoginMatchDiscoveryPage> {
  if (
    !isCanonicalFirebaseUid(loginUid) ||
    (afterMatchId !== null && !isSafeFirebaseKey(afterMatchId)) ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > MAX_PAGE_SIZE
  ) {
    throw new TypeError("invalid-login-match-discovery-page");
  }
  const result = await db
    .withSession("first-primary")
    .prepare(
      `SELECT match_id, match_sort_key, invite_id, resolution
       FROM login_match_discovery
       WHERE login_uid = ? AND match_sort_key > ?
       ORDER BY match_sort_key LIMIT ?`,
    )
    .bind(
      loginUid,
      afterMatchId === null ? "" : matchDiscoverySortKey(afterMatchId),
      limit + 1,
    )
    .all<DiscoveryRow>();
  if (!result.success || result.results.length > limit + 1) {
    throw new Error("login-match-discovery-unavailable");
  }
  let previous = afterMatchId ?? "";
  const entries: MatchDiscoveryEntry[] = result.results.map((row) => {
    assertInput({
      loginUid,
      matchId: row.match_id,
      inviteId: row.invite_id,
      resolution: row.resolution,
      provenance: "backfill",
    });
    if (
      row.match_sort_key !== matchDiscoverySortKey(row.match_id) ||
      row.match_id <= previous
    ) {
      throw new Error("login-match-discovery-corrupt-page");
    }
    previous = row.match_id;
    return {
      matchId: row.match_id,
      inviteId: row.invite_id,
      resolution: row.resolution,
    };
  });
  return { entries: entries.slice(0, limit), hasMore: entries.length > limit };
}
