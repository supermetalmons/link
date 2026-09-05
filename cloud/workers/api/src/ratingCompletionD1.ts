import { AuthApiFailure } from "./authErrors.ts";

export async function readRatingCompletion(
  db: D1Database,
  inviteId: string,
  matchId: string,
): Promise<boolean> {
  try {
    const row = await db
      .prepare(
        `SELECT activated_at_ms,
          EXISTS (
            SELECT 1 FROM rating_updates
            WHERE operation_id = ? AND invite_id = ? AND match_id = ?
              AND status = 'done'
          ) OR EXISTS (
            SELECT 1 FROM legacy_rating_completions
            WHERE invite_id = ? AND match_id = ?
          ) AS completed
         FROM rating_completion_control WHERE singleton = 1`,
      )
      .bind(`${inviteId}__${matchId}`, inviteId, matchId, inviteId, matchId)
      .first<{ activated_at_ms: number | null; completed: number }>();
    if (
      !row ||
      !Number.isSafeInteger(row.activated_at_ms) ||
      Number(row.activated_at_ms) <= 0 ||
      (row.completed !== 0 && row.completed !== 1)
    ) {
      throw new Error("rating-completions-not-activated");
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
