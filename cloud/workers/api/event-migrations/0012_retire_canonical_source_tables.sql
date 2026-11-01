SELECT CASE WHEN EXISTS (
  SELECT 1 FROM application_data_control
  WHERE singleton = 1 AND generation = 3 AND data_epoch = 1 AND phase = 'active'
) THEN 1 ELSE json('canonical-source-cleanup-control-mismatch') END;

SELECT CASE WHEN (
  SELECT COUNT(*) FROM sqlite_schema WHERE type = 'table' AND name IN (
    'event_prize_selections',
    'event_profile_game_projection_outboxes',
    'event_profile_game_projection_outboxes_recovery3',
    'event_progress_outboxes',
    'event_progress_outboxes_recovery3',
    'event_telegram_projection_outboxes',
    'event_telegram_projection_outboxes_recovery3',
    'event_telegram_projection_state',
    'event_transition_intents',
    'profile_event_prize_revisions',
    'profile_event_prizes',
    'event_records'
  )
) = 12 THEN 1 ELSE json('canonical-source-cleanup-schema-mismatch') END;

DROP TABLE event_prize_selections;
DROP TABLE event_profile_game_projection_outboxes;
DROP TABLE event_profile_game_projection_outboxes_recovery3;
DROP TABLE event_progress_outboxes;
DROP TABLE event_progress_outboxes_recovery3;
DROP TABLE event_telegram_projection_outboxes;
DROP TABLE event_telegram_projection_outboxes_recovery3;
DROP TABLE event_telegram_projection_state;
DROP TABLE event_transition_intents;
DROP TABLE profile_event_prize_revisions;
DROP TABLE profile_event_prizes;
DROP TABLE event_records;
