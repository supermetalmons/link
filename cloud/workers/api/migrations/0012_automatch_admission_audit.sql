ALTER TABLE automatch_write_admissions
ADD COLUMN phase TEXT NOT NULL DEFAULT 'uncertain'
CHECK (phase IN ('prepared', 'dispatching', 'uncertain', 'completed'));

ALTER TABLE automatch_write_admissions
ADD COLUMN proof_json TEXT CHECK (proof_json IS NULL OR json_valid(proof_json));

ALTER TABLE automatch_write_admissions
ADD COLUMN audit_revision INTEGER NOT NULL DEFAULT 0
CHECK (typeof(audit_revision) = 'integer' AND audit_revision BETWEEN 0 AND 9007199254740991);

ALTER TABLE automatch_write_admissions
ADD COLUMN updated_at_ms INTEGER NOT NULL DEFAULT 0 CHECK (updated_at_ms >= 0);

ALTER TABLE automatch_write_admissions
ADD COLUMN completed_at_ms INTEGER CHECK (completed_at_ms IS NULL OR completed_at_ms >= 0);
