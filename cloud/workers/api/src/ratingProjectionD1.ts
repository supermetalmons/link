import {
  CanonicalProfileCorruption,
  type RatingRow,
} from "./profileCanonical/types.ts";
import {
  nonempty,
  nullableSafeInteger,
  safeInteger,
} from "./profileCanonical/validation.ts";
import type {
  InvalidRatingRecoveryEntry,
  RatingRecoveryProjectionKind,
  RatingRecoveryQuarantineResult,
  RatingRecoveryScanEntry,
  PendingRatingEventProgress,
  PendingRatingProfileGameProjection,
  PendingRatingTelegramProjection,
} from "./ratingContracts.ts";
import {
  parseRecoveryObservation,
  parseRecoveryKey,
  recoveryKeyHex,
  recoveryKeyMatches,
  recoveryObservationColumns,
  recoveryObservationGuard,
  type RecoveryKeyObservation,
  type RecoveryKeyRow,
} from "./recoveryObservation.ts";
import { buildRecoveryQuarantineWrite } from "./recoveryQuarantine.ts";
import {
  readRecoveryScanIdentities,
  recoveryScanExclusionSql,
  recoveryScanIdentitySql,
  type RecoveryScanPage,
} from "./recoveryScanPage.ts";

const EVENT_ID_BYTES_SQL = `(SELECT CASE WHEN type = 'text' THEN CAST(atom AS BLOB) ELSE NULL END
  FROM json_each(rating.payload_json)
  WHERE key = 'eventId'
  ORDER BY id DESC LIMIT 1)`;

const RECOVERY_LANES = {
  "event-progress": "event_progress",
  "profile-game": "profile_game_projection",
  telegram: "telegram_projection",
} as const;

function recoveryLane(projectionKind: RatingRecoveryProjectionKind) {
  if (!Object.hasOwn(RECOVERY_LANES, projectionKind)) {
    throw new TypeError("invalid-rating-recovery-projection");
  }
  const prefix = RECOVERY_LANES[projectionKind];
  const fieldNames = [
    "operation_id",
    "revision",
    ...(projectionKind === "telegram"
      ? []
      : ["invite_id", "match_id", "version"]),
    ...(projectionKind === "event-progress" ? ["event_id_bytes"] : []),
  ];
  return {
    prefix,
    sourceColumns: [
      "rating.operation_id",
      "rating.revision",
      `rating.${prefix}_state AS recovery_state`,
      `rating.${prefix}_updated_at_ms AS recovery_updated_at_ms`,
      ...(projectionKind === "telegram"
        ? []
        : [
            "rating.invite_id",
            "rating.match_id",
            `rating.${prefix}_version AS version`,
          ]),
      ...(projectionKind === "event-progress"
        ? [`${EVENT_ID_BYTES_SQL} AS event_id_bytes`]
        : []),
    ].join(", "),
    selectedColumns: fieldNames
      .map((column) => `observed.${column}`)
      .join(", "),
    observationFieldNames: [
      ...fieldNames,
      "recovery_state",
      "recovery_updated_at_ms",
    ],
    observationExpressions: [
      ...fieldNames,
      "recovery_state",
      "recovery_updated_at_ms",
    ].map((column) => `observed.${column}`),
  };
}

type RatingRecoveryRow = Pick<RatingRow, "operation_id" | "revision">;

type RatingGameRecoveryRow = RatingRecoveryRow &
  Pick<RatingRow, "invite_id" | "match_id"> & { version: number | null };

type RatingEventRecoveryRow = RatingGameRecoveryRow & {
  event_id_bytes: number[] | Uint8Array | null;
};

function parseRatingRecoveryRow(
  row: RatingRecoveryRow,
): PendingRatingTelegramProjection {
  return {
    operationId: nonempty(row.operation_id),
    revision: safeInteger(row.revision, 1),
  };
}

function parseRatingGameRecoveryRow(
  row: RatingGameRecoveryRow,
): PendingRatingProfileGameProjection {
  return {
    ...parseRatingRecoveryRow(row),
    inviteId: nonempty(row.invite_id),
    matchId: nonempty(row.match_id),
    version: nullableSafeInteger(row.version) ?? 0,
  };
}

function parseRatingEventId(value: number[] | Uint8Array | null): string {
  if (value === null) return "";
  try {
    if (
      !(value instanceof Uint8Array) &&
      (!Array.isArray(value) ||
        !value.every(
          (byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255,
        ))
    ) {
      throw new CanonicalProfileCorruption();
    }
    return new TextDecoder("utf-8", { fatal: true })
      .decode(value instanceof Uint8Array ? value : Uint8Array.from(value))
      .trim();
  } catch {
    throw new CanonicalProfileCorruption();
  }
}

function inspectRatingRecoveryRow<Row extends RatingRecoveryRow, Value>(
  row: Row,
  key: RecoveryKeyObservation,
  parse: (row: Row) => Value,
):
  | { kind: "candidate"; value: Value }
  | { kind: "invalid"; reason: "invalid-operation-id" | "invalid-record" } {
  if (
    typeof row.operation_id !== "string" ||
    row.operation_id === "" ||
    !recoveryKeyMatches(key, row.operation_id)
  ) {
    return { kind: "invalid", reason: "invalid-operation-id" };
  }
  try {
    return { kind: "candidate", value: parse(row) };
  } catch (error) {
    if (!(error instanceof CanonicalProfileCorruption)) throw error;
    return { kind: "invalid", reason: "invalid-record" };
  }
}

async function inspectSweepRating<Row extends RatingRecoveryRow, Value>(
  db: D1Database,
  row: Row & RecoveryKeyRow,
  projectionKind: RatingRecoveryProjectionKind,
  updatedBeforeMs: number,
  parse: (row: Row) => Value,
): Promise<RatingRecoveryScanEntry<Value> | null> {
  try {
    const key = parseRecoveryKey(row);
    const inspected = inspectRatingRecoveryRow(row, key, parse);
    if (inspected.kind === "candidate") return inspected;
    const {
      prefix,
      sourceColumns,
      observationExpressions,
      observationFieldNames,
    } = recoveryLane(projectionKind);
    const fresh = await db
      .withSession("first-primary")
      .prepare(
        `WITH observed AS MATERIALIZED (
           SELECT ${sourceColumns}
           FROM rating_updates_canonical AS rating
           WHERE rating.operation_id = CASE WHEN ? = 'blob' THEN ? ELSE CAST(? AS TEXT) END
             AND rating.${prefix}_state = 'pending' AND rating.${prefix}_updated_at_ms <= ?
             AND NOT EXISTS (
               SELECT 1 FROM rating_projection_recovery_quarantine_canonical AS quarantine
               WHERE quarantine.operation_id = rating.operation_id
                 AND quarantine.projection_kind = '${projectionKind}'
                 AND quarantine.revision_token = CAST(rating.revision AS TEXT)
             )
         )
         SELECT ${recoveryObservationColumns(observationExpressions, 1)} FROM observed`,
      )
      .bind(key.keyType, key.keyBytes, key.keyBytes, updatedBeforeMs)
      .first<Record<string, unknown>>();
    if (!fresh) return null;
    const { observation, value } = parseRecoveryObservation(
      fresh,
      observationFieldNames,
      1,
    );
    const refreshed = inspectRatingRecoveryRow(
      value as Row,
      observation,
      parse,
    );
    return refreshed.kind === "candidate"
      ? refreshed
      : {
          ...refreshed,
          observation,
          projectionKind,
        };
  } catch (error) {
    return { kind: "failure", error };
  }
}

async function scanDueRatingsPage<Row extends RatingRecoveryRow, Value>(
  db: D1Database,
  projectionKind: RatingRecoveryProjectionKind,
  updatedBeforeMs: number,
  limit: number,
  parse: (row: Row) => Value,
  excludedIdentities: readonly string[] = [],
): Promise<RecoveryScanPage<RatingRecoveryScanEntry<Value>[]>> {
  if (
    !Number.isSafeInteger(updatedBeforeMs) ||
    updatedBeforeMs < 0 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100
  ) {
    throw new TypeError("invalid-rating-projection-list");
  }
  const { prefix, sourceColumns, selectedColumns } =
    recoveryLane(projectionKind);
  const exclusions = recoveryScanExclusionSql(
    "rating.operation_id",
    excludedIdentities,
    3,
  );
  const result = await db
    .prepare(
      `WITH observed AS MATERIALIZED (
         SELECT ${sourceColumns}
         FROM rating_updates_canonical AS rating
         WHERE rating.${prefix}_state = 'pending' AND rating.${prefix}_updated_at_ms <= ?1
           AND NOT EXISTS (
             SELECT 1 FROM rating_projection_recovery_quarantine_canonical AS quarantine
             WHERE quarantine.operation_id = rating.operation_id
               AND quarantine.projection_kind = '${projectionKind}'
               AND quarantine.revision_token = CAST(rating.revision AS TEXT)
           )${exclusions}
         ORDER BY rating.${prefix}_updated_at_ms ASC, rating.operation_id ASC
         LIMIT ?2
       )
       SELECT ${selectedColumns},
         CAST(observed.operation_id AS BLOB) AS recovery_key_bytes,
         typeof(observed.operation_id) AS recovery_key_type,
         ${recoveryScanIdentitySql("observed.operation_id")} AS recovery_scan_identity
       FROM observed
       ORDER BY observed.recovery_updated_at_ms ASC, observed.operation_id ASC`,
    )
    .bind(updatedBeforeMs, limit, ...excludedIdentities)
    .all<Row & RecoveryKeyRow & { recovery_scan_identity: string | null }>();
  const scannedIdentities = readRecoveryScanIdentities(result.results);
  const entries: RatingRecoveryScanEntry<Value>[] = [];
  for (const row of result.results) {
    const entry = await inspectSweepRating(
      db,
      row,
      projectionKind,
      updatedBeforeMs,
      parse,
    );
    if (entry) entries.push(entry);
  }
  return { entries, scannedIdentities };
}

export async function scanDueRatingEventProgress(
  db: D1Database,
  updatedBeforeMs: number,
  limit: number,
): Promise<RatingRecoveryScanEntry<PendingRatingEventProgress>[]> {
  return (
    await scanDueRatingsPage<
      RatingEventRecoveryRow,
      PendingRatingEventProgress
    >(db, "event-progress", updatedBeforeMs, limit, (row) => ({
      ...parseRatingGameRecoveryRow(row),
      eventId: parseRatingEventId(row.event_id_bytes),
    }))
  ).entries;
}

export async function scanDueRatingProfileGameProjections(
  db: D1Database,
  updatedBeforeMs: number,
  limit: number,
): Promise<RatingRecoveryScanEntry<PendingRatingProfileGameProjection>[]> {
  return (
    await scanDueRatingProfileGameProjectionsPage(db, updatedBeforeMs, limit)
  ).entries;
}

export function scanDueRatingProfileGameProjectionsPage(
  db: D1Database,
  updatedBeforeMs: number,
  limit: number,
  excludedIdentities: readonly string[] = [],
): Promise<
  RecoveryScanPage<
    RatingRecoveryScanEntry<PendingRatingProfileGameProjection>[]
  >
> {
  return scanDueRatingsPage(
    db,
    "profile-game",
    updatedBeforeMs,
    limit,
    parseRatingGameRecoveryRow,
    excludedIdentities,
  );
}

export async function scanDueRatingTelegramProjections(
  db: D1Database,
  updatedBeforeMs: number,
  limit: number,
): Promise<RatingRecoveryScanEntry<PendingRatingTelegramProjection>[]> {
  return (
    await scanDueRatingTelegramProjectionsPage(db, updatedBeforeMs, limit)
  ).entries;
}

export function scanDueRatingTelegramProjectionsPage(
  db: D1Database,
  updatedBeforeMs: number,
  limit: number,
  excludedIdentities: readonly string[] = [],
): Promise<
  RecoveryScanPage<RatingRecoveryScanEntry<PendingRatingTelegramProjection>[]>
> {
  return scanDueRatingsPage(
    db,
    "telegram",
    updatedBeforeMs,
    limit,
    parseRatingRecoveryRow,
    excludedIdentities,
  );
}

export async function quarantineRatingRecoveryEntry(
  db: D1Database,
  { observation, projectionKind, reason }: InvalidRatingRecoveryEntry,
  nowMs: number,
): Promise<RatingRecoveryQuarantineResult | null> {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new TypeError("invalid-rating-quarantine-timestamp");
  }
  const { prefix, sourceColumns, observationExpressions } =
    recoveryLane(projectionKind);
  const key = observation.keyBytes;
  const guard = recoveryObservationGuard(observationExpressions, observation);
  const statement = buildRecoveryQuarantineWrite({
    target: "rating",
    beforeInsert: {
      sql: `WITH observed AS MATERIALIZED (
         SELECT ${sourceColumns}
         FROM rating_updates_canonical AS rating
         WHERE rating.operation_id = CASE WHEN ? = 'blob' THEN ? ELSE CAST(? AS TEXT) END
           AND rating.${prefix}_state = 'pending'
           AND EXISTS (
             SELECT 1 FROM profile_canonical_control
             WHERE singleton = 1 AND state = 'active'
           )
       )`,
      bindings: [observation.keyType, key, key],
    },
    select: {
      sql: `SELECT observed.operation_id, ?, CAST(observed.revision AS TEXT), ?, ?
       FROM observed
       WHERE ${guard.sql}`,
      bindings: [projectionKind, reason, nowMs, ...guard.bindings],
    },
  });
  const result = await db
    .prepare(statement.sql)
    .bind(...statement.bindings)
    .run();
  return result.meta.changes === 1
    ? {
        operationIdHex: recoveryKeyHex(observation),
        revisionHex: observation.revisionHex,
        reason,
        projectionKind,
      }
    : null;
}
