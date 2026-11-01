export function applicationWriteFenceSql(table: string): string {
  if (!/^[a-z][a-z0-9_]*$/.test(table) || table.startsWith("application_"))
    throw new Error("invalid-application-business-table");
  return ["INSERT", "UPDATE", "DELETE"]
    .map(
      (
        operation,
      ) => `CREATE TRIGGER "${table}_application_${operation.toLowerCase()}" BEFORE ${operation} ON "${table}"
WHEN NOT EXISTS (
  SELECT 1 FROM application_write_context w
  JOIN application_data_control c ON c.singleton = 1
  WHERE w.singleton = 1 AND w.generation = c.generation AND w.data_epoch = c.data_epoch
  AND ((w.migration_id IS NULL AND c.phase IN ('active', 'closing'))
    OR (w.migration_id = c.migration_id AND c.phase IN ('closed', 'verifying')))
)
BEGIN SELECT RAISE(ABORT, 'application-write-fenced'); END;`,
    )
    .join("\n");
}
