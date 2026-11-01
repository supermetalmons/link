export const MATCH_WRITER_TABLES = [
  "match_state_records_canonical",
  "match_state_claims_canonical",
  "match_state_revisions_canonical",
  "match_state_source_canonical",
  "match_state_timer_cohorts_canonical",
  "match_state_timer_starts_canonical",
  "match_state_effects_canonical",
  "match_state_event_receipts_canonical",
] as const;

export const MATCH_WRITER_SCHEMA = `
CREATE TABLE IF NOT EXISTS timer_handoff_control (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  revision INTEGER NOT NULL CHECK(revision >= 0),
  phase TEXT NOT NULL CHECK(phase IN ('open', 'draining', 'copying', 'copied', 'sealing-empty')),
  incarnation TEXT NOT NULL,
  handoff_id TEXT,
  invite_id TEXT,
  ownership_json TEXT CHECK(ownership_json IS NULL OR json_valid(ownership_json)),
  copy_receipt_json TEXT CHECK(copy_receipt_json IS NULL OR json_valid(copy_receipt_json)),
  acknowledgement_json TEXT CHECK(acknowledgement_json IS NULL OR json_valid(acknowledgement_json)),
  empty_seal_json TEXT CHECK(empty_seal_json IS NULL OR json_valid(empty_seal_json)),
  fresh_local_layout INTEGER NOT NULL DEFAULT 0 CHECK(fresh_local_layout IN (0, 1)),
  completed_writers INTEGER NOT NULL DEFAULT 0 CHECK(completed_writers >= 0),
  failed_writers INTEGER NOT NULL DEFAULT 0 CHECK(failed_writers >= 0)
) STRICT;
CREATE TABLE IF NOT EXISTS timer_handoff_writers (
  writer_id TEXT PRIMARY KEY NOT NULL,
  revision INTEGER NOT NULL CHECK(revision >= 0),
  incarnation TEXT NOT NULL,
  kind TEXT NOT NULL,
  mutation_id TEXT NOT NULL,
  input_digest TEXT NOT NULL CHECK(length(input_digest) = 64),
  input_json TEXT NOT NULL CHECK(json_valid(input_json)),
  match_ids_json TEXT NOT NULL CHECK(json_valid(match_ids_json))
) STRICT, WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS timer_handoff_writer_outcomes (
  writer_id TEXT PRIMARY KEY NOT NULL,
  mutation_id TEXT NOT NULL,
  input_digest TEXT NOT NULL CHECK(length(input_digest) = 64),
  revision INTEGER NOT NULL CHECK(revision >= 0),
  incarnation TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('committed', 'completed', 'failed')),
  business_outcome TEXT NOT NULL CHECK(business_outcome IN ('committed', 'unknown')),
  result_json TEXT NOT NULL CHECK(json_valid(result_json)),
  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json))
) STRICT, WITHOUT ROWID;
CREATE TRIGGER IF NOT EXISTS timer_handoff_writer_outcome_update_immutable
BEFORE UPDATE ON timer_handoff_writer_outcomes
BEGIN SELECT RAISE(ABORT, 'timer-writer-outcome-immutable'); END;
CREATE TRIGGER IF NOT EXISTS timer_handoff_writer_outcome_delete_immutable
BEFORE DELETE ON timer_handoff_writer_outcomes
BEGIN SELECT RAISE(ABORT, 'timer-writer-outcome-immutable'); END;
CREATE TABLE IF NOT EXISTS timer_handoff_writer_reconciliations (
  writer_id TEXT PRIMARY KEY NOT NULL,
  original_incarnation TEXT NOT NULL,
  reconciled_incarnation TEXT NOT NULL,
  outcome_status TEXT NOT NULL CHECK(outcome_status IN ('committed', 'completed', 'failed')),
  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json))
) STRICT, WITHOUT ROWID;
CREATE TRIGGER IF NOT EXISTS timer_handoff_writer_reconciliation_update_immutable
BEFORE UPDATE ON timer_handoff_writer_reconciliations
BEGIN SELECT RAISE(ABORT, 'timer-writer-reconciliation-immutable'); END;
CREATE TRIGGER IF NOT EXISTS timer_handoff_writer_reconciliation_delete_immutable
BEFORE DELETE ON timer_handoff_writer_reconciliations
BEGIN SELECT RAISE(ABORT, 'timer-writer-reconciliation-immutable'); END;
CREATE TABLE IF NOT EXISTS timer_handoff_write_context (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  writer_id TEXT,
  revision INTEGER NOT NULL,
  incarnation TEXT NOT NULL,
  handoff_id TEXT,
  mode TEXT NOT NULL CHECK(mode IN ('writer', 'copy'))
) STRICT;
CREATE TRIGGER IF NOT EXISTS timer_handoff_revision_monotonic
BEFORE UPDATE ON timer_handoff_control
WHEN NEW.revision < OLD.revision
BEGIN SELECT RAISE(ABORT, 'timer-handoff-revision-regression'); END;
`;

export function matchWriterGuardDrops(): string {
  return MATCH_WRITER_TABLES.flatMap((table) =>
    ["INSERT", "UPDATE", "DELETE"].map(
      (operation) =>
        `DROP TRIGGER IF EXISTS ${table}_timer_handoff_${operation.toLowerCase()};`,
    ),
  ).join("\n");
}

export function matchWriterWriteGuards(): string {
  return MATCH_WRITER_TABLES.flatMap((table) =>
    ["INSERT", "UPDATE", "DELETE"].map(
      (
        operation,
      ) => `CREATE TRIGGER IF NOT EXISTS ${table}_timer_handoff_${operation.toLowerCase()}
BEFORE ${operation} ON ${table}
WHEN NOT EXISTS (
  SELECT 1 FROM timer_handoff_write_context w
  JOIN timer_handoff_control c ON c.singleton = w.singleton
  JOIN timer_handoff_writers r ON r.writer_id = w.writer_id
  WHERE w.singleton = 1 AND w.mode = 'writer' AND c.phase = 'open'
    AND w.incarnation = c.incarnation AND r.incarnation = c.incarnation
    AND w.revision = c.revision AND r.revision = c.revision
)
BEGIN SELECT RAISE(ABORT, 'timer-handoff-writer-fenced'); END;`,
    ),
  ).join("\n");
}
