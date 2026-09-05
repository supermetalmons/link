import { AuthApiFailure } from "./authErrors.ts";

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
