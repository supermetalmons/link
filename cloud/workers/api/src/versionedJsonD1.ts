const KEY_COLUMNS = {
  telegram_delivery_control: ["singleton"],
  telegram_messages: ["message_key"],
  event_prize_withdrawals: ["event_id", "prize_id"],
} as const;

type RowIdentity =
  | {
      table: "telegram_delivery_control" | "telegram_messages";
      key: readonly [string | number];
    }
  | {
      table: "event_prize_withdrawals";
      key: readonly [string, string];
    };

type JsonRow = {
  record_json: string;
  version: number;
};

export function createVersionedJsonRowStore(
  db: Pick<D1Database, "prepare">,
  { table, key }: RowIdentity,
) {
  const columns = KEY_COLUMNS[table];
  const predicate = columns.map((column) => `${column} = ?`).join(" AND ");
  return {
    read(): Promise<JsonRow | null> {
      return db
        .prepare(`SELECT record_json, version FROM ${table} WHERE ${predicate}`)
        .bind(...key)
        .first<JsonRow>();
    },
    async insertIfAbsent(
      recordJson: string,
      updatedAtMs: number,
    ): Promise<number> {
      const result = await db
        .prepare(
          `INSERT INTO ${table} (
             ${columns.join(", ")}, record_json, version, updated_at_ms
           ) VALUES (${columns.map(() => "?").join(", ")}, ?, 1, ?)
           ON CONFLICT (${columns.join(", ")}) DO NOTHING`,
        )
        .bind(...key, recordJson, updatedAtMs)
        .run();
      return result.meta.changes;
    },
    async updateIfVersion(
      version: number,
      recordJson: string,
      updatedAtMs: number,
    ): Promise<number> {
      const result = await db
        .prepare(
          `UPDATE ${table}
           SET record_json = ?, version = version + 1, updated_at_ms = ?
           WHERE ${predicate} AND version = ?`,
        )
        .bind(recordJson, updatedAtMs, ...key, version)
        .run();
      return result.meta.changes;
    },
    async deleteIfVersion(version: number): Promise<number> {
      const result = await db
        .prepare(`DELETE FROM ${table} WHERE ${predicate} AND version = ?`)
        .bind(...key, version)
        .run();
      return result.meta.changes;
    },
  };
}
