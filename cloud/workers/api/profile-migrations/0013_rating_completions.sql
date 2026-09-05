CREATE TABLE legacy_rating_completions (
  invite_id TEXT NOT NULL CHECK (invite_id != ''),
  match_id TEXT NOT NULL CHECK (match_id != ''),
  imported_at_ms INTEGER NOT NULL CHECK (imported_at_ms >= 0),
  PRIMARY KEY (invite_id, match_id)
) WITHOUT ROWID;

CREATE TABLE rating_completion_control (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  activated_at_ms INTEGER CHECK (activated_at_ms >= 0),
  source_digest TEXT CHECK (
    length(source_digest) = 64 AND source_digest NOT GLOB '*[^a-f0-9]*'
  ),
  source_count INTEGER CHECK (source_count >= 0),
  CHECK ((source_digest IS NULL) = (source_count IS NULL)),
  CHECK (activated_at_ms IS NULL OR source_digest IS NOT NULL)
);

INSERT INTO rating_completion_control (singleton) VALUES (1);

CREATE TRIGGER legacy_rating_completions_insert_frozen
BEFORE INSERT ON legacy_rating_completions
WHEN COALESCE((SELECT state FROM profile_canonical_control WHERE singleton = 1), '') != 'frozen'
BEGIN
  SELECT RAISE(ABORT, 'rating-completion-import-requires-freeze');
END;

CREATE TRIGGER legacy_rating_completions_insert_unactivated
BEFORE INSERT ON legacy_rating_completions
WHEN NOT EXISTS (
  SELECT 1 FROM rating_completion_control
  WHERE singleton = 1 AND activated_at_ms IS NULL AND source_digest IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'rating-completion-import-unavailable');
END;

CREATE TRIGGER legacy_rating_completions_immutable_update
BEFORE UPDATE ON legacy_rating_completions
BEGIN
  SELECT RAISE(ABORT, 'rating-completion-evidence-immutable');
END;

CREATE TRIGGER legacy_rating_completions_immutable_delete
BEFORE DELETE ON legacy_rating_completions
BEGIN
  SELECT RAISE(ABORT, 'rating-completion-evidence-immutable');
END;

CREATE TRIGGER rating_completion_control_frozen
BEFORE UPDATE ON rating_completion_control
WHEN COALESCE((SELECT state FROM profile_canonical_control WHERE singleton = 1), '') != 'frozen'
BEGIN
  SELECT RAISE(ABORT, 'rating-completion-import-requires-freeze');
END;

CREATE TRIGGER rating_completion_control_immutable
BEFORE UPDATE ON rating_completion_control
WHEN OLD.activated_at_ms IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'rating-completion-already-activated');
END;

CREATE TRIGGER rating_completion_control_source_immutable
BEFORE UPDATE ON rating_completion_control
WHEN OLD.source_digest IS NOT NULL AND (
  NEW.source_digest IS NOT OLD.source_digest OR NEW.source_count IS NOT OLD.source_count
)
BEGIN
  SELECT RAISE(ABORT, 'rating-completion-import-source-changed');
END;
