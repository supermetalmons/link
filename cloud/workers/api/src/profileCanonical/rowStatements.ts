import type { D1Value } from "./types.ts";

export function canonicalRowMutationStatement<
  Row extends Record<string, D1Value>,
>(
  db: D1Database,
  table: "profile_records" | "rating_updates",
  keyColumn: keyof Row & string,
  row: Row,
  insert: boolean,
  current?: Row,
): D1PreparedStatement {
  const fields = Object.entries(row);
  if (insert) {
    return db
      .prepare(
        `INSERT INTO ${table} (${fields.map(([column]) => column).join(", ")}, revision)
         VALUES (${fields.map(() => "?").join(", ")}, 1)`,
      )
      .bind(...fields.map(([, value]) => value));
  }
  const updates = fields.filter(
    ([column, value]) =>
      column !== keyColumn && (!current || current[column] !== value),
  );
  return db
    .prepare(
      `UPDATE ${table} SET
         ${[...updates.map(([column]) => `${column} = ?`), "revision = revision + 1"].join(", ")}
       WHERE ${keyColumn} = ?`,
    )
    .bind(...updates.map(([, value]) => value), row[keyColumn]);
}
