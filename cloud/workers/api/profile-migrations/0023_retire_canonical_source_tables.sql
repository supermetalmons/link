SELECT CASE WHEN EXISTS (
  SELECT 1 FROM application_data_control
  WHERE singleton = 1 AND generation = 3 AND data_epoch = 1 AND phase = 'active'
) AND EXISTS (
  SELECT 1 FROM wager_state_activation WHERE singleton = 1 AND activation_epoch = 1
) THEN 1 ELSE json('canonical-source-cleanup-control-mismatch') END;

SELECT CASE WHEN (
  SELECT COUNT(*) FROM sqlite_schema WHERE type = 'table' AND name IN (
    'invite_wager_states',
    'legacy_rating_completions',
    'profile_auth_methods',
    'profile_auth_operations',
    'profile_auth_recovery_quarantine',
    'profile_auth_recovery_quarantine_recovery3',
    'profile_february_opponents',
    'profile_link_catchup_quarantine',
    'profile_link_catchup_quarantine_recovery3',
    'profile_login_owners',
    'profile_merge_targets',
    'rating_projection_recovery_quarantine',
    'wager_frozen_operations',
    'wager_settlements',
    'profile_auth_recovery_jobs',
    'profile_auth_recovery_jobs_recovery3',
    'profile_link_catchup_jobs',
    'profile_link_catchup_jobs_recovery3',
    'rating_updates',
    'wager_frozen_balances',
    'profile_records'
  )
) = 21 THEN 1 ELSE json('canonical-source-cleanup-schema-mismatch') END;

DROP TRIGGER wager_state_activation_verified;
CREATE TRIGGER wager_state_activation_verified
BEFORE UPDATE ON wager_state_activation
WHEN OLD.activation_epoch != 1 OR NEW.activation_epoch != 1
BEGIN SELECT RAISE(ABORT, 'canonical-wager-state-activation-is-final'); END;

DROP TABLE invite_wager_states;
DROP TABLE legacy_rating_completions;
DROP TABLE profile_auth_methods;
DROP TABLE profile_auth_operations;
DROP TABLE profile_auth_recovery_quarantine;
DROP TABLE profile_auth_recovery_quarantine_recovery3;
DROP TABLE profile_february_opponents;
DROP TABLE profile_link_catchup_quarantine;
DROP TABLE profile_link_catchup_quarantine_recovery3;
DROP TABLE profile_login_owners;
DROP TABLE profile_merge_targets;
DROP TABLE rating_projection_recovery_quarantine;
DROP TABLE wager_frozen_operations;
DROP TABLE wager_settlements;
DROP TABLE profile_auth_recovery_jobs;
DROP TABLE profile_auth_recovery_jobs_recovery3;
DROP TABLE profile_link_catchup_jobs;
DROP TABLE profile_link_catchup_jobs_recovery3;
DROP TABLE rating_updates;
DROP TABLE wager_frozen_balances;
DROP TABLE profile_records;
