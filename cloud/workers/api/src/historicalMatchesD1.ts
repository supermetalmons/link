import {
  isHistoricalMatchPair,
  isReadHistoricalMatchRequest,
  type HistoricalMatchPair,
} from "@mons/shared/game-sessions";
import {
  buildHistoricalMatchPair,
  type HistoricalMatchSource,
} from "./historicalMatches.ts";

const HISTORICAL_MATCH_SCHEMA_VERSION = 1;

type HistoricalMatchRow = {
  archived_at_ms: number;
  finalized_at_ms: number;
  invite_id: string;
  match_id: string;
  revision: number;
  schema_version: number;
  snapshot_json: string;
  source_kind: HistoricalMatchSource;
};

export type HistoricalMatchSnapshot = {
  archivedAtMs: number;
  finalizedAtMs: number;
  pair: HistoricalMatchPair;
  revision: number;
  source: HistoricalMatchSource;
};

export class HistoricalMatchConflict extends Error {
  constructor() {
    super("historical-match-conflict");
  }
}

export class HistoricalMatchCorruption extends Error {
  constructor() {
    super("historical-match-corrupt");
  }
}

function canonicalPair(pair: HistoricalMatchPair): HistoricalMatchPair | null {
  return buildHistoricalMatchPair({
    guestMatch: pair.guestMatch,
    guestPlayerId: pair.guestPlayerId,
    hostMatch: pair.hostMatch,
    hostPlayerId: pair.hostPlayerId,
    matchId: pair.matchId,
  });
}

function parseRow(row: HistoricalMatchRow): HistoricalMatchSnapshot {
  let pair: unknown;
  try {
    pair = JSON.parse(row.snapshot_json) as unknown;
  } catch {
    throw new HistoricalMatchCorruption();
  }
  if (
    row.schema_version !== HISTORICAL_MATCH_SCHEMA_VERSION ||
    !Number.isSafeInteger(row.revision) ||
    row.revision < 1 ||
    !Number.isSafeInteger(row.finalized_at_ms) ||
    row.finalized_at_ms < 0 ||
    !Number.isSafeInteger(row.archived_at_ms) ||
    row.archived_at_ms < row.finalized_at_ms ||
    !isHistoricalMatchPair(pair) ||
    pair.matchId !== row.match_id
  ) {
    throw new HistoricalMatchCorruption();
  }
  return {
    archivedAtMs: row.archived_at_ms,
    finalizedAtMs: row.finalized_at_ms,
    pair,
    revision: row.revision,
    source: row.source_kind,
  };
}

export async function readHistoricalMatchSnapshot(
  db: D1Database,
  inviteId: string,
  matchId: string,
): Promise<HistoricalMatchSnapshot | null> {
  const row = await db
    .prepare(
      `SELECT * FROM historical_match_pairs
       WHERE invite_id = ? AND match_id = ?`,
    )
    .bind(inviteId, matchId)
    .first<HistoricalMatchRow>();
  return row ? parseRow(row) : null;
}

export async function writeHistoricalMatchSnapshot(
  db: D1Database,
  input: {
    archivedAtMs: number;
    finalizedAtMs: number;
    inviteId: string;
    pair: HistoricalMatchPair;
    source: HistoricalMatchSource;
  },
): Promise<HistoricalMatchSnapshot> {
  const pair = canonicalPair(input.pair);
  if (
    !isHistoricalMatchPair(input.pair) ||
    !pair ||
    !isReadHistoricalMatchRequest({
      inviteId: input.inviteId,
      matchId: pair.matchId,
    }) ||
    !Number.isSafeInteger(input.finalizedAtMs) ||
    input.finalizedAtMs < 0 ||
    !Number.isSafeInteger(input.archivedAtMs) ||
    input.archivedAtMs < input.finalizedAtMs
  ) {
    throw new TypeError("invalid-historical-match-snapshot");
  }
  const snapshotJson = JSON.stringify(pair);
  await db
    .prepare(
      `INSERT INTO historical_match_pairs (
         invite_id, match_id, snapshot_json, source_kind, finalized_at_ms,
         archived_at_ms, schema_version, revision
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 1)
       ON CONFLICT (invite_id, match_id) DO UPDATE SET
         snapshot_json = excluded.snapshot_json,
         source_kind = excluded.source_kind,
         finalized_at_ms = excluded.finalized_at_ms,
         archived_at_ms = excluded.archived_at_ms,
         schema_version = excluded.schema_version,
         revision = historical_match_pairs.revision + 1
       WHERE excluded.source_kind = 'rating'
         AND historical_match_pairs.source_kind != 'rating'`,
    )
    .bind(
      input.inviteId,
      pair.matchId,
      snapshotJson,
      input.source,
      input.finalizedAtMs,
      input.archivedAtMs,
      HISTORICAL_MATCH_SCHEMA_VERSION,
    )
    .run();
  const stored = await readHistoricalMatchSnapshot(
    db,
    input.inviteId,
    pair.matchId,
  );
  if (!stored) throw new HistoricalMatchCorruption();
  if (stored.source === "rating" && input.source !== "rating") return stored;
  const storedPair = canonicalPair(stored.pair);
  if (!storedPair) throw new HistoricalMatchCorruption();
  if (JSON.stringify(storedPair) !== snapshotJson) {
    throw new HistoricalMatchConflict();
  }
  return stored;
}
