import {
  mapProfileGameProjection,
  type NavigationGamesCursor,
  type NavigationItem,
  type ReadNavigationGamesResponse,
} from "@mons/shared/navigation";

type ProjectionWrite = {
  type: "create" | "delete" | "merge" | "update";
  profileId: string;
  projectionId: string;
  data?: Record<string, unknown>;
  requireAbsent?: boolean;
  updateTime?: string;
};

type ProjectionRow = {
  entity_type: string;
  list_sort_at_ms: number;
  payload_json: string;
  profile_id: string;
  projection_id: string;
  sort_bucket: number;
  status: string;
  updated_at_ms: number;
  version: number;
};

const PROJECTION_VALUES_SQL = `
  INSERT INTO profile_game_projections (
    profile_id,
    projection_id,
    entity_type,
    status,
    sort_bucket,
    list_sort_at_ms,
    updated_at_ms,
    version,
    payload_json
  ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
  ON CONFLICT (profile_id, projection_id) DO UPDATE SET
    entity_type = excluded.entity_type,
    status = excluded.status,
    sort_bucket = excluded.sort_bucket,
    list_sort_at_ms = excluded.list_sort_at_ms,
    updated_at_ms = excluded.updated_at_ms,
    version = profile_game_projections.version + 1,
    payload_json = excluded.payload_json
`;

const UPSERT_MERGE_PROJECTION_SQL = `${PROJECTION_VALUES_SQL}
  WHERE excluded.updated_at_ms >= profile_game_projections.updated_at_ms
`;

const ASSERT_CREATE_ABSENT_SQL = `
  INSERT INTO profile_game_projection_write_guards (singleton)
  SELECT 0
  WHERE EXISTS (
    SELECT 1
    FROM profile_game_projections
    WHERE profile_id = ? AND projection_id = ?
  )
`;

const ASSERT_UPDATE_VERSION_SQL = `
  INSERT INTO profile_game_projection_write_guards (singleton)
  SELECT 0
  WHERE NOT EXISTS (
    SELECT 1
    FROM profile_game_projections
    WHERE profile_id = ? AND projection_id = ?
      AND version = ?
      AND updated_at_ms <= ?
  )
`;

const ASSERT_UPDATE_LIST_SORT_SQL = `
  INSERT INTO profile_game_projection_write_guards (singleton)
  SELECT 0
  WHERE NOT EXISTS (
    SELECT 1
    FROM profile_game_projections
    WHERE profile_id = ? AND projection_id = ?
      AND list_sort_at_ms = ?
      AND updated_at_ms <= ?
  )
`;

const ASSERT_DELETE_VERSION_SQL = `
  INSERT INTO profile_game_projection_write_guards (singleton)
  SELECT 0
  WHERE NOT EXISTS (
    SELECT 1
    FROM profile_game_projections
    WHERE profile_id = ? AND projection_id = ? AND version = ?
  )
`;

const DELETE_PROJECTION_SQL = `
  DELETE FROM profile_game_projections
  WHERE profile_id = ? AND projection_id = ?
`;

function toRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function projectionTimestampMillis(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.floor(value)
    : 0;
}

function normalizeProjectionJson(value: unknown, depth = 0): unknown {
  if (depth > 32) throw new TypeError("projection-value-too-deep");
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new TypeError("invalid-projection-number");
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeProjectionJson(entry, depth + 1));
  }
  const record = toRecord(value);
  if (!record) throw new TypeError("invalid-projection-value");
  return Object.fromEntries(
    Object.entries(record)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, normalizeProjectionJson(entry, depth + 1)]),
  );
}

export function encodeProfileGameProjection(
  profileId: string,
  projectionId: string,
  data: Record<string, unknown>,
): ProjectionRow {
  const normalized = normalizeProjectionJson(data);
  const payload = toRecord(normalized);
  if (!profileId || !projectionId || !payload) {
    throw new TypeError("invalid-profile-game-projection");
  }
  const listSortAtMs = projectionTimestampMillis(payload.listSortAt);
  if (!Number.isSafeInteger(listSortAtMs) || listSortAtMs <= 0) {
    throw new TypeError("invalid-profile-game-projection-list-sort");
  }
  payload.listSortAt = listSortAtMs;
  for (const field of [
    "automatchCanceledAt",
    "createdAt",
    "endedAt",
    "lastEventAt",
    "startAt",
    "updatedAt",
  ]) {
    const value = payload[field];
    if (value === null || value === undefined) continue;
    const millis = projectionTimestampMillis(value);
    if (!Number.isSafeInteger(millis) || millis <= 0) {
      throw new TypeError("invalid-profile-game-projection-timestamp");
    }
    payload[field] = millis;
  }
  const item = mapProfileGameProjection(payload, projectionId);
  if (!item || item.id !== projectionId) {
    throw new TypeError("invalid-profile-game-projection-payload");
  }
  const updatedAtMs =
    projectionTimestampMillis(payload.updatedAt) ||
    projectionTimestampMillis(payload.lastEventAt) ||
    item.listSortAtMs;
  if (!Number.isSafeInteger(updatedAtMs) || updatedAtMs <= 0) {
    throw new TypeError("invalid-profile-game-projection-timestamp");
  }
  return {
    profile_id: profileId,
    projection_id: projectionId,
    entity_type: item.entityType,
    status: item.status,
    sort_bucket: item.sortBucket,
    list_sort_at_ms: listSortAtMs,
    updated_at_ms: updatedAtMs,
    version: 1,
    payload_json: JSON.stringify(payload),
  };
}

function upsertStatements(
  db: D1Database,
  row: ProjectionRow,
  type: Exclude<ProjectionWrite["type"], "delete">,
  expectedVersion: number | null,
  requireAbsent: boolean,
): D1PreparedStatement[] {
  const assertions: D1PreparedStatement[] = [];
  if (type === "create" && requireAbsent) {
    assertions.push(
      db
        .prepare(ASSERT_CREATE_ABSENT_SQL)
        .bind(row.profile_id, row.projection_id),
    );
  }
  if (type === "update") {
    assertions.push(
      expectedVersion === null
        ? db
            .prepare(ASSERT_UPDATE_LIST_SORT_SQL)
            .bind(
              row.profile_id,
              row.projection_id,
              row.list_sort_at_ms,
              row.updated_at_ms,
            )
        : db
            .prepare(ASSERT_UPDATE_VERSION_SQL)
            .bind(
              row.profile_id,
              row.projection_id,
              expectedVersion,
              row.updated_at_ms,
            ),
    );
  }
  const sql =
    type === "merge" ? UPSERT_MERGE_PROJECTION_SQL : PROJECTION_VALUES_SQL;
  const values = [
    row.profile_id,
    row.projection_id,
    row.entity_type,
    row.status,
    row.sort_bucket,
    row.list_sort_at_ms,
    row.updated_at_ms,
    row.payload_json,
  ];
  return [...assertions, db.prepare(sql).bind(...values)];
}

function deleteStatements(
  db: D1Database,
  profileId: string,
  projectionId: string,
  expectedVersion: number | null,
): D1PreparedStatement[] {
  if (expectedVersion !== null) {
    return [
      db
        .prepare(ASSERT_DELETE_VERSION_SQL)
        .bind(profileId, projectionId, expectedVersion),
      db.prepare(DELETE_PROJECTION_SQL).bind(profileId, projectionId),
    ];
  }
  return [db.prepare(DELETE_PROJECTION_SQL).bind(profileId, projectionId)];
}

function parseProjectionVersion(value: string | undefined): number | null {
  if (!value || !/^[1-9]\d*$/.test(value)) return null;
  const version = Number(value);
  return Number.isSafeInteger(version) ? version : null;
}

export async function commitProfileGameProjectionWrites(
  db: D1Database,
  writes: ProjectionWrite[],
): Promise<void> {
  if (writes.length === 0) return;
  const statements: D1PreparedStatement[] = [];
  writes.forEach((write) => {
    const expectedVersion = parseProjectionVersion(write.updateTime);
    if (write.type === "delete") {
      statements.push(
        ...deleteStatements(
          db,
          write.profileId,
          write.projectionId,
          expectedVersion,
        ),
      );
      return;
    }
    if (!write.data) throw new TypeError("projection-data-required");
    const row = encodeProfileGameProjection(
      write.profileId,
      write.projectionId,
      write.data,
    );
    statements.push(
      ...upsertStatements(
        db,
        row,
        write.type,
        expectedVersion,
        write.requireAbsent === true,
      ),
    );
  });
  await db.batch(statements);
}

function parseProjectionPayload(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") {
    throw new TypeError("invalid-profile-game-projection-json");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new TypeError("invalid-profile-game-projection-json");
  }
  const record = toRecord(parsed);
  if (!record) throw new TypeError("invalid-profile-game-projection-json");
  return record;
}

export async function getProfileGameProjection(
  db: D1Database,
  profileId: string,
  projectionId: string,
): Promise<{ data: Record<string, unknown>; updateTime: string } | null> {
  const row = await db
    .prepare(
      `SELECT payload_json, version
       FROM profile_game_projections
       WHERE profile_id = ? AND projection_id = ?`,
    )
    .bind(profileId, projectionId)
    .first<{ payload_json: string; version: number }>();
  return row
    ? {
        data: parseProjectionPayload(row.payload_json),
        updateTime: String(row.version),
      }
    : null;
}

export async function listProfileGameProjectionPage(
  db: D1Database,
  profileId: string,
  limit = 100,
): Promise<
  Array<{
    data: Record<string, unknown>;
    projectionId: string;
    updateTime: string;
  }>
> {
  const result = await db
    .prepare(
      `SELECT projection_id, payload_json, version
       FROM profile_game_projections
       WHERE profile_id = ?
       ORDER BY projection_id ASC
       LIMIT ?`,
    )
    .bind(profileId, limit)
    .all<{
      payload_json: string;
      projection_id: string;
      version: number;
    }>();
  return result.results.map((row) => ({
    data: parseProjectionPayload(row.payload_json),
    projectionId: row.projection_id,
    updateTime: String(row.version),
  }));
}

function parseProjectionRow(row: ProjectionRow): NavigationItem {
  const payload = parseProjectionPayload(row.payload_json);
  const item = mapProfileGameProjection(payload, row.projection_id);
  if (
    !item ||
    item.id !== row.projection_id ||
    item.entityType !== row.entity_type ||
    item.status !== row.status ||
    item.sortBucket !== row.sort_bucket ||
    item.listSortAtMs !== row.list_sort_at_ms
  ) {
    throw new TypeError("invalid-profile-game-projection-row");
  }
  return item;
}

export async function readProfileGamesPage(
  db: D1Database,
  profileId: string,
  limit: number,
  cursor: NavigationGamesCursor | null,
): Promise<ReadNavigationGamesResponse> {
  const pageLimit = limit + 1;
  const statement = cursor
    ? db
        .prepare(
          `SELECT *
           FROM profile_game_projections
           WHERE profile_id = ?
             AND (
               sort_bucket > ?
               OR (sort_bucket = ? AND list_sort_at_ms < ?)
               OR (
                 sort_bucket = ?
                 AND list_sort_at_ms = ?
                 AND projection_id > ?
               )
             )
           ORDER BY sort_bucket ASC, list_sort_at_ms DESC, projection_id ASC
           LIMIT ?`,
        )
        .bind(
          profileId,
          cursor.sortBucket,
          cursor.sortBucket,
          cursor.listSortAtMs,
          cursor.sortBucket,
          cursor.listSortAtMs,
          cursor.id,
          pageLimit,
        )
    : db
        .prepare(
          `SELECT *
           FROM profile_game_projections
           WHERE profile_id = ?
           ORDER BY sort_bucket ASC, list_sort_at_ms DESC, projection_id ASC
           LIMIT ?`,
        )
        .bind(profileId, pageLimit);
  const result = await statement.all<ProjectionRow>();
  const visibleRows = result.results.slice(0, limit);
  const items = visibleRows.map(parseProjectionRow);
  const last = visibleRows.at(-1);
  return {
    ok: true,
    items,
    nextCursor: last
      ? {
          sortBucket: last.sort_bucket,
          listSortAtMs: last.list_sort_at_ms,
          id: last.projection_id,
        }
      : null,
    hasMore: result.results.length > limit,
  };
}

export async function getD1NavigationGame(
  db: D1Database,
  profileId: string,
  projectionId: string,
): Promise<{ status: string | null } | null> {
  const row = await db
    .prepare(
      `SELECT status
       FROM profile_game_projections
       WHERE profile_id = ? AND projection_id = ?`,
    )
    .bind(profileId, projectionId)
    .first<{ status: string }>();
  return row ? { status: row.status } : null;
}

export async function deleteD1NavigationGame(
  db: D1Database,
  profileId: string,
  projectionId: string,
): Promise<"deleted" | "missing"> {
  const result = await db
    .prepare(
      `DELETE FROM profile_game_projections
       WHERE profile_id = ? AND projection_id = ? AND status = 'waiting'`,
    )
    .bind(profileId, projectionId)
    .run();
  return result.meta.changes ? "deleted" : "missing";
}

export type { ProjectionRow, ProjectionWrite };
