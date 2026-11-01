SELECT CASE WHEN EXISTS (
  SELECT 1 FROM application_data_control
  WHERE singleton = 1 AND generation = 3 AND data_epoch = 1 AND phase = 'active'
) THEN 1 ELSE json('canonical-source-cleanup-control-mismatch') END;

SELECT CASE WHEN (
  SELECT COUNT(*) FROM sqlite_schema WHERE type = 'table' AND name IN (
    'telegram_delivery_control',
    'telegram_event_prize_announcements',
    'telegram_messages'
  )
) = 3 THEN 1 ELSE json('canonical-source-cleanup-schema-mismatch') END;

DROP TABLE telegram_delivery_control;
DROP TABLE telegram_event_prize_announcements;
DROP TABLE telegram_messages;
