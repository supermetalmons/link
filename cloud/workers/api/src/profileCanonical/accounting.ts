import {
  parseCanonicalRatingUpdateRow,
  parseCanonicalWagerSettlementRow,
} from "./accountingRecords.ts";
import { readD1FirstRow } from "../d1Reads.ts";
import {
  CanonicalProfileConflict,
  type RatingRow,
  type WagerRow,
  type CanonicalRatingUpdateSnapshot,
  type CanonicalWagerSettlement,
} from "./types.ts";
export {
  parseCanonicalRatingUpdateRow,
  parseCanonicalWagerSettlementRow,
  ratingWriteRow,
  canonicalRatingProjectionFields,
  buildCanonicalRatingProjectionMutation,
  ratingProjectionWriteRow,
} from "./accountingRecords.ts";

function readCanonicalRatingUpdateRow(
  db: D1Database,
  operationId: string,
): Promise<RatingRow | null> {
  return readD1FirstRow<RatingRow>(
    db
      .prepare("SELECT * FROM rating_updates_canonical WHERE operation_id = ?")
      .bind(operationId),
  );
}

export async function readCanonicalRatingUpdate(
  db: D1Database,
  operationId: string,
): Promise<CanonicalRatingUpdateSnapshot | null> {
  const row = await readCanonicalRatingUpdateRow(db, operationId);
  return row ? parseCanonicalRatingUpdateRow(row) : null;
}

const RATING_UPDATE_READ_BATCH_SIZE = 100;

export async function readCanonicalRatingUpdates(
  db: D1Database,
  operationIds: readonly string[],
): Promise<Array<CanonicalRatingUpdateSnapshot | null>> {
  const uniqueIds = [...new Set(operationIds)];
  const snapshots = new Map<string, CanonicalRatingUpdateSnapshot>();
  for (
    let offset = 0;
    offset < uniqueIds.length;
    offset += RATING_UPDATE_READ_BATCH_SIZE
  ) {
    const ids = uniqueIds.slice(offset, offset + RATING_UPDATE_READ_BATCH_SIZE);
    const rows = await db
      .prepare(
        `SELECT * FROM rating_updates_canonical
         WHERE operation_id IN (${ids.map(() => "?").join(", ")})`,
      )
      .bind(...ids)
      .all<RatingRow>();
    for (const row of rows.results) {
      const snapshot = parseCanonicalRatingUpdateRow(row);
      snapshots.set(snapshot.operationId, snapshot);
    }
  }
  return operationIds.map((operationId) => snapshots.get(operationId) ?? null);
}

export async function readCanonicalRatingProjectionSnapshot(
  db: D1Database,
  operationId: string,
): Promise<{
  snapshot: CanonicalRatingUpdateSnapshot;
  payloadJson: string;
} | null> {
  const row = await readCanonicalRatingUpdateRow(db, operationId);
  return row
    ? {
        snapshot: parseCanonicalRatingUpdateRow(row),
        payloadJson: row.payload_json,
      }
    : null;
}

export async function readCanonicalWagerSettlement(
  db: D1Database,
  operationId: string,
  fingerprint?: string,
): Promise<CanonicalWagerSettlement | null> {
  const row = await readD1FirstRow<WagerRow>(
    db
      .prepare(
        "SELECT * FROM wager_settlements_canonical WHERE operation_id = ?",
      )
      .bind(operationId),
  );
  if (!row) return null;
  const settlement = parseCanonicalWagerSettlementRow(row);
  if (fingerprint !== undefined && settlement.fingerprint !== fingerprint) {
    throw new CanonicalProfileConflict();
  }
  return settlement;
}
