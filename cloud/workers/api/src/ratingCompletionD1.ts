import { AuthApiFailure } from "./authErrors.ts";
import { parseCanonicalRatingUpdateRow } from "./profileCanonical/accounting.ts";
import type { CanonicalRatingUpdateSnapshot } from "./profileCanonical/types.ts";

export async function readRatingCompletion(
  db: D1Database,
  inviteId: string,
  matchId: string,
): Promise<boolean> {
  try {
    const row = await db
      .prepare(
        `SELECT EXISTS (
            SELECT 1 FROM rating_updates
            WHERE operation_id = ? AND invite_id = ? AND match_id = ?
              AND status = 'done'
          ) OR EXISTS (
            SELECT 1 FROM legacy_rating_completions
            WHERE invite_id = ? AND match_id = ?
          ) AS completed`,
      )
      .bind(`${inviteId}__${matchId}`, inviteId, matchId, inviteId, matchId)
      .first<{ completed: number }>();
    if (!row || (row.completed !== 0 && row.completed !== 1)) {
      throw new Error("invalid-rating-completion");
    }
    return row.completed === 1;
  } catch {
    throw new AuthApiFailure(
      503,
      "unavailable",
      "rating-completions-unavailable",
    );
  }
}

export async function readRatingLeaseSnapshot(
  db: D1Database,
  inviteId: string,
  matchId: string,
): Promise<{
  snapshot: CanonicalRatingUpdateSnapshot | null;
  legacyCompleted: boolean;
}> {
  let row: Record<string, unknown> | null;
  try {
    row = await db
      .prepare(
        `SELECT rating.*, EXISTS (
           SELECT 1 FROM legacy_rating_completions
           WHERE invite_id = ? AND match_id = ?
         ) AS legacy_completed
         FROM (SELECT ? AS operation_id) requested
         LEFT JOIN rating_updates rating
           ON rating.operation_id = requested.operation_id`,
      )
      .bind(inviteId, matchId, `${inviteId}__${matchId}`)
      .first<Record<string, unknown>>();
    if (!row || (row.legacy_completed !== 0 && row.legacy_completed !== 1)) {
      throw new Error("invalid-rating-completion");
    }
  } catch {
    throw new AuthApiFailure(
      503,
      "unavailable",
      "rating-completions-unavailable",
    );
  }
  return {
    snapshot:
      row.operation_id === null ? null : parseCanonicalRatingUpdateRow(row),
    legacyCompleted: row.legacy_completed === 1,
  };
}
