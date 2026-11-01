SELECT CASE WHEN EXISTS (
  SELECT 1 FROM application_data_control
  WHERE singleton = 1 AND generation = 3 AND data_epoch = 1 AND phase = 'active'
) THEN 1 ELSE json('canonical-source-cleanup-control-mismatch') END;

SELECT CASE WHEN (
  SELECT COUNT(*) FROM sqlite_schema WHERE type = 'table' AND name IN (
    'x_redirect_flows',
    'auth_intents'
  )
) = 2 THEN 1 ELSE json('canonical-source-cleanup-schema-mismatch') END;

DROP TABLE x_redirect_flows;
DROP TABLE auth_intents;
