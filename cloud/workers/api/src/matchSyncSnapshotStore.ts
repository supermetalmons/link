import {
  socketMatchKeyBinding,
  type SocketMatchKey,
} from "./socketAttachmentRecords.ts";
import { isMatchSyncSnapshot } from "@mons/shared/match-sync";

type StoredMatch = {
  match_id: string;
  snapshot_json: string;
  revision: number;
  next_at_ms: number | null;
};

function validateSnapshot(
  matchId: string,
  json: string,
  revision: number,
): void {
  const value: unknown = JSON.parse(json);
  if (
    !isMatchSyncSnapshot(value) ||
    value.matchId !== matchId ||
    value.revision !== revision
  )
    throw new TypeError("invalid-stored-match-snapshot");
}

export function createMatchSyncSnapshotStore(sql: Pick<SqlStorage, "exec">) {
  return {
    read(matchId: string): StoredMatch | undefined {
      const row = sql
        .exec<StoredMatch & { schema_version: number }>(
          "SELECT * FROM match_sync_snapshots_canonical WHERE match_id = ?",
          matchId,
        )
        .toArray()[0];
      if (!row) return undefined;
      if (row.schema_version !== 1)
        throw new TypeError("invalid-stored-match-snapshot");
      validateSnapshot(row.match_id, row.snapshot_json, row.revision);
      return {
        match_id: row.match_id,
        snapshot_json: row.snapshot_json,
        revision: row.revision,
        next_at_ms: row.next_at_ms,
      };
    },
    write(matchId: string, snapshotJson: string, revision: number): void {
      validateSnapshot(matchId, snapshotJson, revision);
      sql.exec(
        "INSERT INTO match_sync_snapshots_canonical (match_id, snapshot_json, revision) VALUES (?, ?, ?) ON CONFLICT(match_id) DO UPDATE SET snapshot_json = excluded.snapshot_json, revision = excluded.revision",
        matchId,
        snapshotJson,
        revision,
      );
    },
    setDeadline(matchId: string, atMs: number, preserveEarlier = false): void {
      sql.exec(
        "UPDATE match_sync_snapshots_canonical SET next_at_ms = CASE WHEN ? AND next_at_ms IS NOT NULL THEN MIN(next_at_ms, ?) ELSE ? END WHERE match_id = ?",
        preserveEarlier ? 1 : 0,
        atMs,
        atMs,
        matchId,
      );
    },
    clearDeadline(matchId: SocketMatchKey): void {
      sql.exec(
        "UPDATE match_sync_snapshots_canonical SET next_at_ms = NULL WHERE match_id = ?",
        socketMatchKeyBinding(matchId),
      );
    },
    listDue(nowMs: number): Array<{ match_id: string }> {
      return sql
        .exec<{ match_id: string }>(
          "SELECT match_id FROM match_sync_snapshots_canonical WHERE next_at_ms IS NOT NULL AND next_at_ms <= ? ORDER BY next_at_ms",
          nowMs,
        )
        .toArray();
    },
    nextDeadline(): number | null {
      return sql
        .exec<{ next_at_ms: number | null }>(
          "SELECT MIN(next_at_ms) AS next_at_ms FROM match_sync_snapshots_canonical",
        )
        .one().next_at_ms;
    },
  };
}
