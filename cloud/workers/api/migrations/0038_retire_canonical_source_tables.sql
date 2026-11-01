SELECT CASE WHEN EXISTS (
  SELECT 1 FROM application_data_control
  WHERE singleton = 1 AND generation = 3 AND data_epoch = 1 AND phase = 'active'
) THEN 1 ELSE json('canonical-source-cleanup-control-mismatch') END;

SELECT CASE WHEN (
  SELECT COUNT(*) FROM sqlite_schema WHERE type = 'table' AND name IN (
    'automatch_entries',
    'automatch_live_tickets',
    'automatch_pending_enqueues',
    'automatch_telegram_projection_outbox',
    'automatch_telegram_projection_outbox_recovery3',
    'automatch_telegram_sources',
    'game_session_mutation_receipts',
    'game_session_projection_outbox',
    'game_session_projection_outbox_recovery3',
    'game_session_transition_resources',
    'historical_match_pairs',
    'invite_sources',
    'login_match_discovery',
    'match_presentation_registrations',
    'match_presentation_source_exceptions',
    'match_state_legacy_claims',
    'match_state_legacy_records',
    'match_state_routes',
    'match_timer_starts',
    'profile_game_projections',
    'game_session_transitions'
  )
) = 21 THEN 1 ELSE json('canonical-source-cleanup-schema-mismatch') END;

DROP TRIGGER automatch_cancellation_source_guard;
CREATE TRIGGER automatch_cancellation_source_guard
BEFORE INSERT ON automatch_admission_cancellations
WHEN NOT EXISTS (
  SELECT 1 FROM automatch_admission_cancellations
  WHERE admission_table = NEW.admission_table AND admission_id = NEW.admission_id
)
BEGIN SELECT RAISE(ABORT, 'cancellation-source-generation-retired'); END;

DROP VIEW automatch_ready_tickets;
DROP VIEW automatch_expected_pending_enqueues;
DROP VIEW automatch_expected_live_tickets;

DROP TABLE automatch_entries;
DROP TABLE automatch_live_tickets;
DROP TABLE automatch_pending_enqueues;
DROP TABLE automatch_telegram_projection_outbox;
DROP TABLE automatch_telegram_projection_outbox_recovery3;
DROP TABLE automatch_telegram_sources;
DROP TABLE game_session_mutation_receipts;
DROP TABLE game_session_projection_outbox;
DROP TABLE game_session_projection_outbox_recovery3;
DROP TABLE game_session_transition_resources;
DROP TABLE historical_match_pairs;
DROP TABLE invite_sources;
DROP TABLE login_match_discovery;
DROP TABLE match_presentation_registrations;
DROP TABLE match_presentation_source_exceptions;
DROP TABLE match_state_legacy_claims;
DROP TABLE match_state_legacy_records;
DROP TABLE match_state_routes;
DROP TABLE match_timer_starts;
DROP TABLE profile_game_projections;
DROP TABLE game_session_transitions;
