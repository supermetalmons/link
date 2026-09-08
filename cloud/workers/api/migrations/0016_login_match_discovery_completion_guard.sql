CREATE TRIGGER login_match_discovery_completion_guard
BEFORE UPDATE OF status ON game_session_transitions
WHEN NEW.status = 'completed'
  AND OLD.status != 'completed'
  AND (SELECT capture_enforced FROM login_match_discovery_control WHERE singleton = 1) = 1
  AND EXISTS (
    SELECT 1
    FROM (
      SELECT json_extract(value, '$.path') AS path
      FROM json_each(NEW.payload_json, '$.creations')
    ) AS creation
    WHERE NOT EXISTS (
      SELECT 1 FROM login_match_discovery AS discovery
      WHERE discovery.login_uid = substr(creation.path, 9, instr(substr(creation.path, 9), '/') - 1)
        AND discovery.match_id = substr(creation.path, instr(creation.path, '/matches/') + 9)
        AND discovery.invite_id = NEW.invite_id
        AND discovery.resolution = 'resolved'
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'login-match-discovery-capture-required');
END;
