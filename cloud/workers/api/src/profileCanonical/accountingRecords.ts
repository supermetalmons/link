import { parseCanonicalRatingPayload } from "./contracts.ts";
import { MATERIAL_KEYS, type MiningMaterialName } from "@mons/shared/mining";
import {
  CanonicalProfileCorruption,
  type CanonicalProjectionState,
  type CanonicalRatingUpdateSnapshot,
  type RatingRow,
  type CanonicalWagerSettlement,
  type WagerRow,
  type CanonicalRatingUpdateValue,
  type CanonicalRatingProjectionKind,
  type CanonicalMutation,
  type D1Value,
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
  if (
    value !== "pending" &&
    value !== "done" &&
    value !== "dead" &&
    value !== "cancelled"
  ) {
    throw new CanonicalProfileCorruption();
  }
  return value;
}

export function parseCanonicalRatingUpdateRow(
  value: unknown,
): CanonicalRatingUpdateSnapshot {
  const row = record(value) as RatingRow | null;
  if (
    !row ||
    row.schema_version !== 1 ||
    (row.status !== "processing" &&
      row.status !== "done" &&
      row.status !== "blocked")
  ) {
    throw new CanonicalProfileCorruption();
  }
  const fields = {
    operationId: nonempty(row.operation_id),
    payload: parseCanonicalRatingPayload(parseObjectJson(row.payload_json)),
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
  if (
    fields.operationId !== `${fields.inviteId}__${fields.matchId}` ||
    fields.playerId === fields.opponentId ||
    fields.updatedAtMs < fields.startedAtMs
  )
    throw new CanonicalProfileCorruption();
  for (const [state, updated, version] of [
    [
      fields.profileGameProjectionState,
      fields.profileGameProjectionUpdatedAtMs,
      fields.profileGameProjectionVersion,
    ],
    [
      fields.telegramProjectionState,
      fields.telegramProjectionUpdatedAtMs,
      fields.telegramProjectionVersion,
    ],
    [
      fields.eventProgressState,
      fields.eventProgressUpdatedAtMs,
      fields.eventProgressVersion,
    ],
  ] as const) {
    if (
      state === null
        ? updated !== null || version !== null
        : updated === null || version !== 1
    )
      throw new CanonicalProfileCorruption();
  }
  if (row.status === "blocked") {
    const blockedAtMs = safeInteger(row.blocked_at_ms);
    if (
      row.completed_at_ms !== null ||
      row.block_reason !== "canonical-data-cutover" ||
      blockedAtMs < fields.startedAtMs ||
      blockedAtMs > fields.updatedAtMs ||
      [
        fields.profileGameProjectionState,
        fields.telegramProjectionState,
        fields.eventProgressState,
      ].some((state) => state === "pending")
    )
      throw new CanonicalProfileCorruption();
    return {
      ...fields,
      status: "blocked",
      completedAtMs: null,
      blockedAtMs,
      blockReason: "canonical-data-cutover",
    };
  }
  if (row.blocked_at_ms !== null || row.block_reason !== null)
    throw new CanonicalProfileCorruption();
  if (row.status === "processing") {
    if (
      row.completed_at_ms !== null ||
      [
        fields.profileGameProjectionState,
        fields.telegramProjectionState,
        fields.eventProgressState,
      ].some((state) => state !== null)
    )
      throw new CanonicalProfileCorruption();
    return {
      ...fields,
      status: "processing",
      completedAtMs: null,
      blockedAtMs: null,
      blockReason: null,
    };
  }
  const completedAtMs = safeInteger(row.completed_at_ms);
  if (completedAtMs < fields.startedAtMs || completedAtMs > fields.updatedAtMs)
    throw new CanonicalProfileCorruption();
  return {
    ...fields,
    status: "done",
    completedAtMs,
    blockedAtMs: null,
    blockReason: null,
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

function ratingValueColumns(
  value: CanonicalRatingUpdateValue,
): Omit<RatingRow, "revision" | "payload_json"> {
  return {
    schema_version: 1,
    blocked_at_ms: value.blockedAtMs,
    block_reason: value.blockReason,
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
  const { operation_id: _operationId, ...columns } = ratingValueColumns(value);
  const row = {
    operation_id: value.operationId,
    payload_json: JSON.stringify(value.payload),
    ...columns,
  };
  parseCanonicalRatingUpdateRow({ ...row, revision: 1 });
  return row;
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

export function buildCanonicalRatingProjectionMutation(
  snapshot: CanonicalRatingUpdateSnapshot,
  value: CanonicalRatingUpdateValue,
  projection: CanonicalRatingProjectionKind,
): Extract<
  CanonicalMutation,
  { kind: "update-rating-update" | "update-rating-projection" }
> {
  if (snapshot.operationId !== value.operationId)
    throw new TypeError("invalid-canonical-rating-projection");
  const { columns } = canonicalRatingProjectionFields(projection);
  const excluded = new Set<string>(columns);
  const previous = ratingValueColumns(snapshot),
    next = ratingValueColumns(value);
  const changedOutsideProjection = (
    Object.keys(previous) as Array<keyof typeof previous>
  ).some(
    (column) => !excluded.has(column) && previous[column] !== next[column],
  );
  return changedOutsideProjection
    ? { kind: "update-rating-update", value }
    : { kind: "update-rating-projection", projection, value };
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
  const { operation_id: _operationId, ...columns } = ratingProjectionColumns(
    value,
    projection,
  );
  return {
    operation_id: value.operationId,
    payload_json: JSON.stringify(value.payload),
    ...columns,
  };
}
