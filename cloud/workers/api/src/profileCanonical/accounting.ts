import { MATERIAL_KEYS, type MiningMaterialName } from "@mons/shared/mining";
import { readD1FirstRow } from "../d1Reads.ts";
import {
  type CanonicalProjectionState,
  CanonicalProfileCorruption,
  type CanonicalRatingUpdateSnapshot,
  type RatingRow,
  type CanonicalWagerSettlement,
  type WagerRow,
  CanonicalProfileConflict,
  type CanonicalRatingUpdateValue,
  type CanonicalRatingProjectionKind,
  type CanonicalMutation,
  type D1Value,
  type JsonObject,
} from "./types.ts";
import {
  record,
  nonempty,
  parseObjectJson,
  nullableString,
  safeInteger,
  nullableSafeInteger,
} from "./validation.ts";

function projectionState(value: unknown): CanonicalProjectionState | null {
  if (value === null) return null;
  if (value !== "pending" && value !== "done" && value !== "dead") {
    throw new CanonicalProfileCorruption();
  }
  return value;
}

export function parseCanonicalRatingUpdateRow(
  value: unknown,
): CanonicalRatingUpdateSnapshot {
  const row = record(value) as RatingRow | null;
  if (row?.status !== "processing" && row?.status !== "done") {
    throw new CanonicalProfileCorruption();
  }
  return {
    operationId: nonempty(row.operation_id),
    payload: parseObjectJson(row.payload_json),
    status: row.status,
    inviteId: nonempty(row.invite_id),
    matchId: nonempty(row.match_id),
    playerId: nonempty(row.player_id),
    opponentId: nonempty(row.opponent_id),
    playerProfileId: nullableString(row.player_profile_id),
    opponentProfileId: nullableString(row.opponent_profile_id),
    ownerUid: nonempty(row.owner_uid),
    ownerToken: nonempty(row.owner_token),
    startedAtMs: safeInteger(row.started_at_ms),
    updatedAtMs: safeInteger(row.updated_at_ms),
    leaseExpiresAtMs: safeInteger(row.lease_expires_at_ms),
    completedAtMs: nullableSafeInteger(row.completed_at_ms),
    telegramProjectionState: projectionState(row.telegram_projection_state),
    telegramProjectionUpdatedAtMs: nullableSafeInteger(
      row.telegram_projection_updated_at_ms,
    ),
    telegramProjectionVersion: nullableSafeInteger(
      row.telegram_projection_version,
    ),
    profileGameProjectionState: projectionState(
      row.profile_game_projection_state,
    ),
    profileGameProjectionUpdatedAtMs: nullableSafeInteger(
      row.profile_game_projection_updated_at_ms,
    ),
    profileGameProjectionVersion: nullableSafeInteger(
      row.profile_game_projection_version,
    ),
    eventProgressState: projectionState(row.event_progress_state),
    eventProgressUpdatedAtMs: nullableSafeInteger(
      row.event_progress_updated_at_ms,
    ),
    eventProgressVersion: nullableSafeInteger(row.event_progress_version),
    revision: safeInteger(row.revision, 1),
  };
}

export function parseCanonicalWagerSettlementRow(
  value: unknown,
): CanonicalWagerSettlement {
  const row = record(value) as WagerRow | null;
  if (
    !row ||
    !(MATERIAL_KEYS as readonly string[]).includes(row.material) ||
    (row.outcome !== "applied" && row.outcome !== "insufficient-materials") ||
    row.revision !== 1
  ) {
    throw new CanonicalProfileCorruption();
  }
  return {
    operationId: nonempty(row.operation_id),
    fingerprint: nonempty(row.fingerprint),
    winnerProfileId: nonempty(row.winner_profile_id),
    loserProfileId: nonempty(row.loser_profile_id),
    material: row.material as MiningMaterialName,
    count: safeInteger(row.count, 1),
    appliedAtMs: safeInteger(row.applied_at_ms),
    outcome: row.outcome,
    revision: 1,
  };
}

function readCanonicalRatingUpdateRow(
  db: D1Database,
  operationId: string,
): Promise<RatingRow | null> {
  return readD1FirstRow<RatingRow>(
    db
      .prepare("SELECT * FROM rating_updates WHERE operation_id = ?")
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
  const row = await db
    .prepare("SELECT * FROM wager_settlements WHERE operation_id = ?")
    .bind(operationId)
    .first<WagerRow>();
  if (!row) return null;
  const settlement = parseCanonicalWagerSettlementRow(row);
  if (fingerprint !== undefined && settlement.fingerprint !== fingerprint) {
    throw new CanonicalProfileConflict();
  }
  return settlement;
}

function ratingValueColumns(
  value: CanonicalRatingUpdateValue,
): Omit<RatingRow, "revision" | "payload_json"> {
  return {
    operation_id: value.operationId,
    status: value.status,
    invite_id: value.inviteId,
    match_id: value.matchId,
    player_id: value.playerId,
    opponent_id: value.opponentId,
    player_profile_id: value.playerProfileId,
    opponent_profile_id: value.opponentProfileId,
    owner_uid: value.ownerUid,
    owner_token: value.ownerToken,
    started_at_ms: value.startedAtMs,
    updated_at_ms: value.updatedAtMs,
    lease_expires_at_ms: value.leaseExpiresAtMs,
    completed_at_ms: value.completedAtMs,
    telegram_projection_state: value.telegramProjectionState,
    telegram_projection_updated_at_ms: value.telegramProjectionUpdatedAtMs,
    telegram_projection_version: value.telegramProjectionVersion,
    profile_game_projection_state: value.profileGameProjectionState,
    profile_game_projection_updated_at_ms:
      value.profileGameProjectionUpdatedAtMs,
    profile_game_projection_version: value.profileGameProjectionVersion,
    event_progress_state: value.eventProgressState,
    event_progress_updated_at_ms: value.eventProgressUpdatedAtMs,
    event_progress_version: value.eventProgressVersion,
  };
}

export function ratingWriteRow(
  value: CanonicalRatingUpdateValue,
): Omit<RatingRow, "revision"> {
  const { operation_id, ...columns } = ratingValueColumns(value);
  return {
    operation_id,
    payload_json: JSON.stringify(value.payload),
    ...columns,
  };
}

const RATING_PROJECTION_FIELDS = {
  "event-progress": {
    state: "eventProgressState",
    updated: "eventProgressUpdatedAtMs",
    reason: "eventProgressReason",
    columns: [
      "event_progress_state",
      "event_progress_updated_at_ms",
      "event_progress_version",
    ],
  },
  "profile-game": {
    state: "profileGameProjectionState",
    updated: "profileGameProjectionUpdatedAtMs",
    reason: "profileGameProjectionReason",
    columns: [
      "profile_game_projection_state",
      "profile_game_projection_updated_at_ms",
      "profile_game_projection_version",
    ],
  },
  telegram: {
    state: "telegramProjectionState",
    updated: "telegramProjectionUpdatedAtMs",
    reason: "telegramProjectionReason",
    columns: [
      "telegram_projection_state",
      "telegram_projection_updated_at_ms",
      "telegram_projection_version",
    ],
  },
} as const;

export function canonicalRatingProjectionFields(
  projection: CanonicalRatingProjectionKind,
) {
  if (!Object.hasOwn(RATING_PROJECTION_FIELDS, projection)) {
    throw new TypeError("invalid-canonical-rating-projection");
  }
  return RATING_PROJECTION_FIELDS[projection];
}

function isPlainPayload(value: JsonObject): boolean {
  const prototype: unknown = Object.getPrototypeOf(value);
  return (
    (prototype === Object.prototype || prototype === null) &&
    Object.entries(Object.getOwnPropertyDescriptors(value)).every(
      ([key, descriptor]) =>
        Object.hasOwn(descriptor, "value") &&
        (key !== "toJSON" || typeof descriptor.value !== "function"),
    )
  );
}

function canPatchRatingProjectionPayload(
  current: JsonObject,
  next: JsonObject,
  projection: CanonicalRatingProjectionKind,
  sourcePayloadJson: string,
): boolean {
  if (!isPlainPayload(current) || !isPlainPayload(next)) return false;
  const { state, updated, reason } =
    canonicalRatingProjectionFields(projection);
  const fields = new Set<string>([state, updated, reason]);
  const currentKeys = Object.keys(current);
  const nextKeys = Object.keys(next);
  if (
    currentKeys.length !== nextKeys.length ||
    currentKeys.some(
      (key, index) =>
        key.includes("\u0000") ||
        key !== nextKeys[index] ||
        (!fields.has(key) && current[key] !== next[key]),
    )
  ) {
    return false;
  }
  for (const payload of [current, next]) {
    if (
      !Object.hasOwn(payload, state) ||
      !Object.hasOwn(payload, updated) ||
      !Object.hasOwn(payload, reason) ||
      (payload[state] !== null &&
        payload[state] !== "pending" &&
        payload[state] !== "done" &&
        payload[state] !== "dead") ||
      !Number.isSafeInteger(payload[updated]) ||
      Number(payload[updated]) < 0 ||
      (payload[reason] !== null && typeof payload[reason] !== "string")
    ) {
      return false;
    }
  }
  return sourcePayloadJson === JSON.stringify(current);
}

export function buildCanonicalRatingProjectionMutation(
  snapshot: CanonicalRatingUpdateSnapshot,
  value: CanonicalRatingUpdateValue,
  projection: CanonicalRatingProjectionKind,
  sourcePayloadJson?: string,
): Extract<
  CanonicalMutation,
  {
    kind:
      | "update-rating-update"
      | "update-rating-projection"
      | "patch-rating-projection";
  }
> {
  if (snapshot.operationId !== value.operationId) {
    throw new TypeError("invalid-canonical-rating-projection");
  }
  const { columns } = canonicalRatingProjectionFields(projection);
  const excluded = new Set<string>(columns);
  const previous = ratingValueColumns(snapshot);
  const next = ratingValueColumns(value);
  const changedOutsideProjection = (
    Object.keys(previous) as Array<keyof typeof previous>
  ).some(
    (column) => !excluded.has(column) && previous[column] !== next[column],
  );
  if (changedOutsideProjection) return { kind: "update-rating-update", value };
  if (
    sourcePayloadJson !== undefined &&
    canPatchRatingProjectionPayload(
      snapshot.payload,
      value.payload,
      projection,
      sourcePayloadJson,
    )
  ) {
    return {
      kind: "patch-rating-projection",
      currentRevision: snapshot.revision,
      projection,
      value,
    };
  }
  return { kind: "update-rating-projection", projection, value };
}

export function ratingProjectionColumns(
  value: CanonicalRatingUpdateValue,
  projection: CanonicalRatingProjectionKind,
): Record<string, D1Value> {
  const { columns } = canonicalRatingProjectionFields(projection);
  const row = ratingValueColumns(value);
  return {
    operation_id: row.operation_id,
    ...Object.fromEntries(columns.map((column) => [column, row[column]])),
  };
}

export function ratingProjectionWriteRow(
  value: CanonicalRatingUpdateValue,
  projection: CanonicalRatingProjectionKind,
): Record<string, D1Value> {
  const { operation_id, ...columns } = ratingProjectionColumns(
    value,
    projection,
  );
  return {
    operation_id,
    payload_json: JSON.stringify(value.payload),
    ...columns,
  };
}
