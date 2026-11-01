type StoredMetadataSnapshot = {
  snapshot_json: string | null;
  revision: number;
};

type StoredWagerSnapshot = StoredMetadataSnapshot & {
  source_fingerprint: string | null;
};

export function createInviteChannelSnapshotStore(
  sql: Pick<SqlStorage, "exec">,
) {
  return {
    readMetadata(): StoredMetadataSnapshot {
      return sql
        .exec<StoredMetadataSnapshot>(
          "SELECT * FROM invite_metadata_canonical WHERE singleton = 1",
        )
        .one();
    },
    writeMetadata(snapshotJson: string, revision: number): void {
      sql.exec(
        "UPDATE invite_metadata_canonical SET snapshot_json = ?, revision = ? WHERE singleton = 1",
        snapshotJson,
        revision,
      );
    },
    readWagers(): StoredWagerSnapshot {
      return sql
        .exec<StoredWagerSnapshot>(
          "SELECT * FROM invite_wagers_canonical WHERE singleton = 1",
        )
        .one();
    },
    writeWagers(
      snapshotJson: string,
      revision: number,
      fingerprint: string,
    ): void {
      sql.exec(
        "UPDATE invite_wagers_canonical SET snapshot_json = ?, revision = ?, source_fingerprint = ? WHERE singleton = 1",
        snapshotJson,
        revision,
        fingerprint,
      );
    },
  };
}
