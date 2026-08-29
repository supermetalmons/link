INSERT INTO profile_transaction_guards (singleton)
SELECT 0
WHERE NOT EXISTS (
  SELECT 1
  FROM profile_canonical_control
  WHERE singleton = 1
    AND state = 'frozen'
    AND typeof(import_digest) = 'text'
    AND length(import_digest) = 64
    AND import_digest NOT GLOB '*[^a-f0-9]*'
    AND typeof(import_plan_version) = 'integer'
    AND import_plan_version > 0
    AND import_plan_version <= 9007199254740991
    AND typeof(imported_at_ms) = 'integer'
    AND imported_at_ms >= 0
    AND imported_at_ms <= 9007199254740991
)
OR EXISTS (
  SELECT 1 FROM profile_projection_failures
)
OR EXISTS (
  SELECT profile_id FROM profiles WHERE is_deleted = 0
  EXCEPT
  SELECT profile_id FROM profile_records
)
OR EXISTS (
  SELECT profile_id FROM profile_records
  EXCEPT
  SELECT profile_id FROM profiles WHERE is_deleted = 0
)
OR EXISTS (
  SELECT login_uid, profile_id FROM profile_logins_v2
  EXCEPT
  SELECT login_uid, profile_id FROM profile_login_owners
)
OR EXISTS (
  SELECT login_uid, profile_id FROM profile_login_owners
  EXCEPT
  SELECT login_uid, profile_id FROM profile_logins_v2
);

DROP TABLE profile_logins_v2;
DROP TABLE profile_logins;
DROP TABLE profile_projection_failures;
DROP TABLE profiles;
