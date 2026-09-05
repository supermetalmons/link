CREATE TABLE wager_frozen_balances (
  player_uid TEXT PRIMARY KEY CHECK (player_uid != '' AND instr(player_uid, '/') = 0),
  frozen_json TEXT NOT NULL CHECK (
    json_valid(frozen_json)
    AND json_type(frozen_json) = 'object'
    AND json_remove(frozen_json, '$.dust', '$.slime', '$.gum', '$.metal', '$.ice') = '{}'
    AND json_type(frozen_json, '$.dust') IS 'integer'
    AND json_type(frozen_json, '$.slime') IS 'integer'
    AND json_type(frozen_json, '$.gum') IS 'integer'
    AND json_type(frozen_json, '$.metal') IS 'integer'
    AND json_type(frozen_json, '$.ice') IS 'integer'
    AND json_extract(frozen_json, '$.dust') BETWEEN 0 AND 9007199254740991
    AND json_extract(frozen_json, '$.slime') BETWEEN 0 AND 9007199254740991
    AND json_extract(frozen_json, '$.gum') BETWEEN 0 AND 9007199254740991
    AND json_extract(frozen_json, '$.metal') BETWEEN 0 AND 9007199254740991
    AND json_extract(frozen_json, '$.ice') BETWEEN 0 AND 9007199254740991
  ),
  revision INTEGER NOT NULL CONSTRAINT wager_frozen_revision_guard CHECK (
    typeof(revision) IS 'integer' AND revision BETWEEN 1 AND 9007199254740991
  ),
  updated_at_ms INTEGER NOT NULL CHECK (
    typeof(updated_at_ms) IS 'integer' AND updated_at_ms BETWEEN 0 AND 9007199254740991
  )
) WITHOUT ROWID;

CREATE TABLE wager_frozen_operations (
  player_uid TEXT NOT NULL,
  operation_id TEXT NOT NULL CHECK (operation_id != '' AND instr(operation_id, '/') = 0),
  record_json TEXT NOT NULL CHECK (
    json_valid(record_json) AND json_type(record_json) = 'object'
  ),
  PRIMARY KEY (player_uid, operation_id),
  FOREIGN KEY (player_uid) REFERENCES wager_frozen_balances(player_uid)
) WITHOUT ROWID;
