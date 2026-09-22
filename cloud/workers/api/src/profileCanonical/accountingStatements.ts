import type { CanonicalMutation } from "./types.ts";
import { ratingProjectionWriteRow, ratingWriteRow } from "./accounting.ts";
import { canonicalRowMutationStatement } from "./rowStatements.ts";

type AccountingMutation = Extract<
  CanonicalMutation,
  {
    kind:
      | "insert-february-opponent"
      | "delete-february-opponent"
      | "insert-rating-update"
      | "update-rating-update"
      | "update-rating-projection"
      | "delete-rating-update"
      | "insert-wager-settlement";
  }
>;

function accountingMutationStatement(
  db: D1Database,
  mutation: AccountingMutation,
): D1PreparedStatement {
  switch (mutation.kind) {
    case "insert-february-opponent":
      return db
        .prepare(
          `INSERT INTO profile_february_opponents (
             profile_id, opponent_profile_id, recorded_at_ms
           ) VALUES (?, ?, ?)`,
        )
        .bind(
          mutation.profileId,
          mutation.opponentProfileId,
          mutation.recordedAtMs,
        );
    case "delete-february-opponent":
      return db
        .prepare(
          `DELETE FROM profile_february_opponents
           WHERE profile_id = ? AND opponent_profile_id = ?`,
        )
        .bind(mutation.profileId, mutation.opponentProfileId);
    case "insert-rating-update":
    case "update-rating-update":
      return canonicalRowMutationStatement(
        db,
        "rating_updates",
        "operation_id",
        ratingWriteRow(mutation.value),
        mutation.kind === "insert-rating-update",
      );
    case "update-rating-projection":
      return canonicalRowMutationStatement(
        db,
        "rating_updates",
        "operation_id",
        ratingProjectionWriteRow(mutation.value, mutation.projection),
        false,
      );
    case "delete-rating-update":
      return db
        .prepare("DELETE FROM rating_updates WHERE operation_id = ?")
        .bind(mutation.operationId);
    case "insert-wager-settlement":
      return db
        .prepare(
          `INSERT INTO wager_settlements (
             operation_id, fingerprint, winner_profile_id, loser_profile_id,
             material, count, applied_at_ms, outcome, revision
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        )
        .bind(
          mutation.value.operationId,
          mutation.value.fingerprint,
          mutation.value.winnerProfileId,
          mutation.value.loserProfileId,
          mutation.value.material,
          mutation.value.count,
          mutation.value.appliedAtMs,
          mutation.value.outcome,
        );
  }
}

export function buildAccountingMutationStatements(
  db: D1Database,
  mutation: AccountingMutation,
): D1PreparedStatement[] {
  return [accountingMutationStatement(db, mutation)];
}
