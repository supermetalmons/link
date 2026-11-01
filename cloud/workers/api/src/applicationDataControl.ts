import {
  ApplicationDataUnavailable,
  isApplicationIdentifier,
  parseApplicationDataControl,
  type ApplicationDataControl,
  type ApplicationWriteContext,
} from "./applicationDataRecords.ts";
export { applicationWriteFenceSql } from "../../../runtime/application-fence.js";
export * from "./applicationDataRecords.ts";

export async function readApplicationDataControl(
  database: D1Database,
): Promise<ApplicationDataControl> {
  const rows = await database
    .withSession("first-primary")
    .prepare(
      "SELECT singleton, generation, data_epoch, phase, migration_id FROM application_data_control WHERE singleton = 1",
    )
    .all<unknown>();
  if (rows.results.length !== 1) throw new ApplicationDataUnavailable();
  return parseApplicationDataControl(rows.results[0]);
}

export function applicationWriteBatch(
  database: Pick<D1Database, "prepare">,
  context: ApplicationWriteContext,
  statements: readonly D1PreparedStatement[],
): D1PreparedStatement[] {
  if (
    !Number.isSafeInteger(context.generation) ||
    context.generation < 1 ||
    (context.dataEpoch !== 0 && context.dataEpoch !== 1) ||
    !isApplicationIdentifier(context.operationId) ||
    (context.kind === "migration" &&
      !isApplicationIdentifier(context.migrationId))
  )
    throw new ApplicationDataUnavailable();
  if (statements.length === 0) return [];
  return [
    database
      .prepare(
        "INSERT INTO application_write_context (singleton, generation, data_epoch, operation_id, migration_id) VALUES (1, ?, ?, ?, ?)",
      )
      .bind(
        context.generation,
        context.dataEpoch,
        context.operationId,
        context.kind === "migration" ? context.migrationId : null,
      ),
    ...statements,
    database
      .prepare(
        "DELETE FROM application_write_context WHERE singleton = 1 AND operation_id = ?",
      )
      .bind(context.operationId),
  ];
}
