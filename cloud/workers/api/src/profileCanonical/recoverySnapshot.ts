import { parseCanonicalProfileAggregateResults } from "./auth.ts";
import {
  parseCanonicalMergeTargetRow,
  readCanonicalMergeTarget,
} from "./profiles.ts";
import {
  CANONICAL_PROFILE_INTERNAL_REDIRECT_LIMIT,
  CanonicalProfileCorruption,
  type CanonicalMergeTarget,
  type CanonicalProfileAggregateSnapshot,
} from "./types.ts";
import { safeInteger } from "./validation.ts";

export type CanonicalRecoveryFinalizationSnapshot = {
  target: CanonicalProfileAggregateSnapshot;
  source: CanonicalProfileAggregateSnapshot;
  mergePath: readonly CanonicalMergeTarget[] | null;
};

const REQUESTED_PROFILES_SQL = `WITH requested(request_index, profile_id) AS (
  VALUES (0, ?), (1, ?)
)`;

function aggregateStatements(
  db: D1Database,
  targetProfileId: string,
  sourceProfileId: string,
): D1PreparedStatement[] {
  return [
    `SELECT requested.request_index AS recovery_request_index, value.*
     FROM requested JOIN profile_records value USING (profile_id)
     ORDER BY requested.request_index`,
    `SELECT requested.request_index AS recovery_request_index, value.*
     FROM requested JOIN profile_login_owners value USING (profile_id)
     ORDER BY requested.request_index, value.login_uid ASC`,
    `SELECT requested.request_index AS recovery_request_index, value.*
     FROM requested JOIN profile_auth_methods value USING (profile_id)
     ORDER BY requested.request_index, value.method ASC`,
    `SELECT requested.request_index AS recovery_request_index, value.opponent_profile_id
     FROM requested JOIN profile_february_opponents value USING (profile_id)
     ORDER BY requested.request_index, value.opponent_profile_id ASC`,
    `SELECT requested.request_index AS recovery_request_index,
            value.source_profile_id, value.target_profile_id, value.merged_at_ms, value.op_id
     FROM requested JOIN profile_merge_targets value
       ON value.source_profile_id = requested.profile_id
     ORDER BY requested.request_index`,
    `SELECT requested.request_index AS recovery_request_index, value.*
     FROM requested JOIN profile_auth_recovery_jobs value USING (profile_id)
     ORDER BY requested.request_index`,
  ].map((query) =>
    db
      .prepare(`${REQUESTED_PROFILES_SQL} ${query}`)
      .bind(targetProfileId, sourceProfileId),
  );
}

function mergePathStatement(
  db: D1Database,
  targetProfileId: string,
  sourceProfileId: string,
): D1PreparedStatement {
  return db
    .prepare(
      `WITH RECURSIVE chain(depth, source_profile_id, target_profile_id, merged_at_ms, op_id) AS (
         SELECT 0, source_profile_id, target_profile_id, merged_at_ms, op_id
         FROM profile_merge_targets WHERE source_profile_id = ?
         UNION ALL
         SELECT chain.depth + 1, target.source_profile_id, target.target_profile_id,
                target.merged_at_ms, target.op_id
         FROM chain JOIN profile_merge_targets target
           ON target.source_profile_id = chain.target_profile_id
         WHERE chain.depth < ? AND chain.target_profile_id != ?
       )
       SELECT *, hex(CAST(source_profile_id AS BLOB)) AS source_profile_id_hex,
              hex(CAST(target_profile_id AS BLOB)) AS target_profile_id_hex
       FROM chain ORDER BY depth`,
    )
    .bind(
      sourceProfileId,
      CANONICAL_PROFILE_INTERNAL_REDIRECT_LIMIT,
      targetProfileId,
    );
}

function utf8Hex(value: string): string {
  return Array.from(new TextEncoder().encode(value), (byte) =>
    byte.toString(16).padStart(2, "0"),
  )
    .join("")
    .toUpperCase();
}

async function readMergePathIteratively(
  db: D1Database,
  targetProfileId: string,
  sourceProfileId: string,
): Promise<CanonicalMergeTarget[] | null> {
  let currentProfileId = sourceProfileId;
  const visited = new Set([sourceProfileId]);
  const path: CanonicalMergeTarget[] = [];
  for (
    let depth = 0;
    depth <= CANONICAL_PROFILE_INTERNAL_REDIRECT_LIMIT;
    depth++
  ) {
    const mapping = await readCanonicalMergeTarget(db, currentProfileId);
    if (!mapping || visited.has(mapping.targetProfileId)) return null;
    path.push(mapping);
    if (mapping.targetProfileId === targetProfileId) return path;
    visited.add(mapping.targetProfileId);
    currentProfileId = mapping.targetProfileId;
  }
  return null;
}

function parseMergePath(
  rows: readonly Record<string, unknown>[],
  targetProfileId: string,
  sourceProfileId: string,
): CanonicalMergeTarget[] | null | "read-iteratively" {
  if (!sourceProfileId.isWellFormed() || !targetProfileId.isWellFormed())
    return "read-iteratively";
  const visited = new Set([sourceProfileId]);
  const path: CanonicalMergeTarget[] = [];
  for (
    let depth = 0;
    depth <= CANONICAL_PROFILE_INTERNAL_REDIRECT_LIMIT;
    depth++
  ) {
    const row = rows[depth];
    if (!row) return null;
    if (row.depth !== depth) throw new CanonicalProfileCorruption();
    const mapping = parseCanonicalMergeTargetRow(row);
    if (
      utf8Hex(mapping.sourceProfileId) !== row.source_profile_id_hex ||
      utf8Hex(mapping.targetProfileId) !== row.target_profile_id_hex
    ) {
      return "read-iteratively";
    }
    if (visited.has(mapping.targetProfileId)) return null;
    path.push(mapping);
    if (mapping.targetProfileId === targetProfileId) return path;
    visited.add(mapping.targetProfileId);
  }
  return null;
}

export async function readCanonicalRecoveryFinalizationSnapshot(
  db: D1Database,
  targetProfileId: string,
  sourceProfileId: string,
): Promise<CanonicalRecoveryFinalizationSnapshot> {
  const statements = aggregateStatements(db, targetProfileId, sourceProfileId);
  const results = await db.batch<Record<string, unknown>>([
    ...statements,
    mergePathStatement(db, targetProfileId, sourceProfileId),
  ]);
  if (
    results.length !== statements.length + 1 ||
    results.some((result) => !result.success)
  ) {
    throw new CanonicalProfileCorruption();
  }
  const groups = [targetProfileId, sourceProfileId].map(() =>
    statements.map(() => ({ results: [] as Record<string, unknown>[] })),
  );
  for (let table = 0; table < statements.length; table++) {
    const result = results[table];
    if (!result) throw new CanonicalProfileCorruption();
    for (const row of result.results) {
      const requestIndex = safeInteger(row.recovery_request_index);
      if (requestIndex > 1) throw new CanonicalProfileCorruption();
      groups[requestIndex][table].results.push(row);
    }
  }
  const [target, source] = groups.map(parseCanonicalProfileAggregateResults);
  if (!target.profile || !target.recovery) {
    return { target, source, mergePath: null };
  }
  const chain = results[statements.length];
  if (!chain) throw new CanonicalProfileCorruption();
  const mergePath = parseMergePath(
    chain.results,
    targetProfileId,
    sourceProfileId,
  );
  return {
    target,
    source,
    mergePath:
      mergePath === "read-iteratively"
        ? await readMergePathIteratively(db, targetProfileId, sourceProfileId)
        : mergePath,
  };
}
