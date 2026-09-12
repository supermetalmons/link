INSERT INTO profile_transaction_guards (singleton)
SELECT 0 WHERE NOT EXISTS (
  SELECT 1 FROM profile_canonical_control
  WHERE singleton = 1 AND state = 'frozen'
);

CREATE TABLE profile_auth_recovery_quarantine (
  profile_id TEXT PRIMARY KEY,
  revision_token TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('invalid-record', 'invalid-profile-id')),
  quarantined_at_ms INTEGER NOT NULL CHECK (
    typeof(quarantined_at_ms) = 'integer'
    AND quarantined_at_ms BETWEEN 0 AND 9007199254740991
  ),
  FOREIGN KEY (profile_id) REFERENCES profile_auth_recovery_jobs(profile_id)
    ON DELETE CASCADE
) WITHOUT ROWID;
