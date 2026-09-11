CREATE TABLE match_state_control (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  backend TEXT NOT NULL DEFAULT 'rtdb' CHECK (backend IN ('rtdb', 'durable')),
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'draining', 'frozen')),
  epoch INTEGER NOT NULL DEFAULT 1 CHECK (epoch > 0),
  freeze_generation INTEGER NOT NULL DEFAULT 0 CHECK (freeze_generation >= 0),
  frozen_at_ms INTEGER CHECK (frozen_at_ms IS NULL OR frozen_at_ms >= 0),
  candidate_version_id TEXT,
  import_id TEXT,
  source_digest TEXT CHECK (source_digest IS NULL OR (length(source_digest) = 64 AND source_digest NOT GLOB '*[^a-f0-9]*')),
  source_record_count INTEGER CHECK (source_record_count IS NULL OR source_record_count >= 0),
  source_claim_count INTEGER CHECK (source_claim_count IS NULL OR source_claim_count >= 0),
  source_bundle_count INTEGER CHECK (source_bundle_count IS NULL OR source_bundle_count >= 0),
  fence_digest TEXT CHECK (fence_digest IS NULL OR (length(fence_digest) = 64 AND fence_digest NOT GLOB '*[^a-f0-9]*')),
  verified_digest TEXT CHECK (verified_digest IS NULL OR (length(verified_digest) = 64 AND verified_digest NOT GLOB '*[^a-f0-9]*')),
  verified_at_ms INTEGER,
  activated_at_ms INTEGER,
  updated_at_ms INTEGER NOT NULL DEFAULT 0,
  CHECK (backend = 'rtdb' OR (
    import_id IS NOT NULL AND candidate_version_id IS NOT NULL
    AND source_digest IS NOT NULL AND verified_digest IS source_digest
    AND fence_digest IS NOT NULL AND source_record_count IS NOT NULL
    AND source_claim_count IS NOT NULL AND source_bundle_count IS NOT NULL
    AND verified_at_ms IS NOT NULL AND activated_at_ms IS NOT NULL
  ))
);

INSERT INTO match_state_control (singleton) VALUES (1);

CREATE TRIGGER match_state_authority_one_way
BEFORE UPDATE OF backend, epoch ON match_state_control
WHEN (OLD.backend = 'durable' AND NEW.backend != 'durable') OR NEW.epoch < OLD.epoch
BEGIN
  SELECT RAISE(ABORT, 'match-state-authority-is-one-way');
END;

CREATE TABLE match_state_write_admissions (
  admission_id TEXT PRIMARY KEY NOT NULL,
  backend TEXT NOT NULL CHECK (backend IN ('rtdb', 'durable')),
  epoch INTEGER NOT NULL CHECK (epoch > 0),
  freeze_generation INTEGER NOT NULL CHECK (freeze_generation >= 0),
  kind TEXT NOT NULL CHECK (length(kind) BETWEEN 1 AND 120),
  resources_json TEXT NOT NULL CHECK (json_valid(resources_json) AND json_type(resources_json) = 'array'),
  transition_id TEXT,
  phase TEXT NOT NULL DEFAULT 'admitted' CHECK (phase IN ('admitted', 'uncertain')),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0)
) WITHOUT ROWID;

CREATE TABLE match_state_recovery_ids (
  transition_id TEXT PRIMARY KEY NOT NULL,
  freeze_generation INTEGER NOT NULL CHECK (freeze_generation >= 0)
) WITHOUT ROWID;

CREATE TABLE match_state_guards (
  singleton INTEGER PRIMARY KEY CONSTRAINT match_state_guard CHECK (singleton = 1)
);

CREATE TABLE match_state_routes (
  actor_uid TEXT NOT NULL CHECK (length(actor_uid) > 0 AND instr(actor_uid, '/') = 0),
  match_id TEXT NOT NULL CHECK (length(match_id) > 0 AND instr(match_id, '/') = 0),
  kind TEXT NOT NULL CHECK (kind IN ('durable', 'legacy')),
  invite_id TEXT,
  epoch INTEGER NOT NULL CHECK (epoch > 0),
  PRIMARY KEY (actor_uid, match_id),
  CHECK ((kind = 'durable' AND invite_id IS NOT NULL AND length(invite_id) > 0 AND instr(invite_id, '/') = 0)
    OR (kind = 'legacy' AND invite_id IS NULL))
) WITHOUT ROWID;

CREATE INDEX match_state_routes_invite ON match_state_routes (invite_id, match_id);

CREATE TRIGGER match_state_route_conflict
BEFORE INSERT ON match_state_routes
WHEN EXISTS (SELECT 1 FROM match_state_routes WHERE actor_uid = NEW.actor_uid AND match_id = NEW.match_id
  AND (kind IS NOT NEW.kind OR invite_id IS NOT NEW.invite_id OR epoch IS NOT NEW.epoch))
BEGIN
  SELECT RAISE(ABORT, 'match-state-route-conflict');
END;

CREATE TRIGGER match_state_routes_immutable
BEFORE UPDATE ON match_state_routes
BEGIN
  SELECT RAISE(ABORT, 'match-state-route-is-immutable');
END;

CREATE TABLE match_state_legacy_records (
  actor_uid TEXT NOT NULL,
  match_id TEXT NOT NULL,
  record_json TEXT NOT NULL CHECK (json_valid(record_json)),
  source_digest TEXT NOT NULL CHECK (length(source_digest) = 64 AND source_digest NOT GLOB '*[^a-f0-9]*'),
  import_id TEXT NOT NULL,
  disposition TEXT NOT NULL CHECK (disposition IN ('missing-invite', 'ambiguous-invite', 'nonparticipant', 'malformed')),
  PRIMARY KEY (actor_uid, match_id)
) WITHOUT ROWID;

CREATE TABLE match_state_legacy_claims (
  match_id TEXT PRIMARY KEY NOT NULL,
  record_json TEXT NOT NULL CHECK (json_valid(record_json)),
  source_digest TEXT NOT NULL CHECK (length(source_digest) = 64 AND source_digest NOT GLOB '*[^a-f0-9]*'),
  import_id TEXT NOT NULL,
  disposition TEXT NOT NULL
) WITHOUT ROWID;

CREATE TRIGGER match_state_legacy_record_conflict
BEFORE INSERT ON match_state_legacy_records
WHEN EXISTS (SELECT 1 FROM match_state_legacy_records WHERE actor_uid = NEW.actor_uid AND match_id = NEW.match_id
  AND (record_json IS NOT NEW.record_json OR source_digest IS NOT NEW.source_digest OR import_id IS NOT NEW.import_id OR disposition IS NOT NEW.disposition))
BEGIN
  SELECT RAISE(ABORT, 'match-state-legacy-conflict');
END;

CREATE TRIGGER match_state_legacy_records_immutable
BEFORE UPDATE ON match_state_legacy_records
BEGIN
  SELECT RAISE(ABORT, 'match-state-legacy-is-immutable');
END;

CREATE TRIGGER match_state_legacy_claim_conflict
BEFORE INSERT ON match_state_legacy_claims
WHEN EXISTS (SELECT 1 FROM match_state_legacy_claims WHERE match_id = NEW.match_id
  AND (record_json IS NOT NEW.record_json OR source_digest IS NOT NEW.source_digest OR import_id IS NOT NEW.import_id OR disposition IS NOT NEW.disposition))
BEGIN
  SELECT RAISE(ABORT, 'match-state-legacy-claim-conflict');
END;

CREATE TRIGGER match_state_legacy_claims_immutable
BEFORE UPDATE ON match_state_legacy_claims
BEGIN
  SELECT RAISE(ABORT, 'match-state-legacy-claim-is-immutable');
END;

CREATE TABLE match_state_import_receipts (
  import_id TEXT NOT NULL,
  invite_id TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  digest TEXT NOT NULL CHECK (length(digest) = 64 AND digest NOT GLOB '*[^a-f0-9]*'),
  record_count INTEGER NOT NULL CHECK (record_count >= 0),
  claim_count INTEGER NOT NULL CHECK (claim_count >= 0),
  phase TEXT NOT NULL CHECK (phase IN ('staged', 'verified', 'active')),
  PRIMARY KEY (import_id, invite_id)
) WITHOUT ROWID;

CREATE TRIGGER match_state_import_receipt_conflict
BEFORE INSERT ON match_state_import_receipts
WHEN EXISTS (SELECT 1 FROM match_state_import_receipts WHERE import_id = NEW.import_id AND invite_id = NEW.invite_id
  AND (epoch IS NOT NEW.epoch OR digest IS NOT NEW.digest OR record_count IS NOT NEW.record_count OR claim_count IS NOT NEW.claim_count))
BEGIN
  SELECT RAISE(ABORT, 'match-state-import-receipt-conflict');
END;

CREATE TABLE match_state_operator_lock (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  owner_token TEXT NOT NULL,
  import_id TEXT NOT NULL,
  phase TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL
);

CREATE TABLE match_state_reconciliation_receipts (
  admission_id TEXT PRIMARY KEY NOT NULL,
  admission_digest TEXT NOT NULL,
  evidence_digest TEXT NOT NULL,
  reconciled_at_ms INTEGER NOT NULL
) WITHOUT ROWID;
