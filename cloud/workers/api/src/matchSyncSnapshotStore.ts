type StoredMatch = {
  match_id: string;
  snapshot_json: string;
  revision: number;
  next_at_ms: number | null;
};

export function createMatchSyncSnapshotStore(sql: Pick<SqlStorage, "exec">) {
  return {
    read(matchId: string): StoredMatch | undefined {
      return sql
        .exec<StoredMatch>(
          "SELECT * FROM match_sync_snapshots WHERE match_id = ?",
          matchId,
        )
        .toArray()[0];
    },
    write(matchId: string, snapshotJson: string, revision: number): void {
      sql.exec(
        "INSERT INTO match_sync_snapshots (match_id, snapshot_json, revision) VALUES (?, ?, ?) ON CONFLICT(match_id) DO UPDATE SET snapshot_json = excluded.snapshot_json, revision = excluded.revision",
        matchId,
        snapshotJson,
        revision,
      );
    },
    setDeadline(matchId: string, atMs: number, preserveEarlier = false): void {
      sql.exec(
        "UPDATE match_sync_snapshots SET next_at_ms = CASE WHEN ? AND next_at_ms IS NOT NULL THEN MIN(next_at_ms, ?) ELSE ? END WHERE match_id = ?",
        preserveEarlier ? 1 : 0,
        atMs,
        atMs,
        matchId,
      );
    },
    clearDeadline(matchId: string): void {
      sql.exec(
        "UPDATE match_sync_snapshots SET next_at_ms = NULL WHERE match_id = ?",
        matchId,
      );
    },
    listDue(nowMs: number): Array<{ match_id: string }> {
      return sql
        .exec<{ match_id: string }>(
          "SELECT match_id FROM match_sync_snapshots WHERE next_at_ms IS NOT NULL AND next_at_ms <= ? ORDER BY next_at_ms",
          nowMs,
        )
        .toArray();
    },
    nextDeadline(): number | null {
      return sql
        .exec<{ next_at_ms: number | null }>(
          "SELECT MIN(next_at_ms) AS next_at_ms FROM match_sync_snapshots",
        )
        .one().next_at_ms;
    },
  };
}
