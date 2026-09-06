INSERT INTO event_transaction_guards (singleton)
SELECT 0 WHERE EXISTS (
  SELECT 1 FROM event_records
  WHERE json_type(record_json, '$.isSundayMons') IS NULL
    AND pending_transition_id IS NOT NULL
);

UPDATE event_records
SET record_json = json_set(
      record_json,
      '$.isSundayMons',
      json(CASE WHEN event_id IN (
        'NN3eRzoZo80',
        'FRkdorMWaYW',
        'VOxalSrexcA',
        'oXAceF6anag',
        'RpPjMNyrJJa',
        'z3oj52Iiime'
      ) THEN 'true' ELSE 'false' END)
    ),
    revision = revision + 1
WHERE json_type(record_json, '$.isSundayMons') IS NULL;
