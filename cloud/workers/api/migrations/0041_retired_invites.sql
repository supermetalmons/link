CREATE TABLE retired_invites (
  invite_id TEXT PRIMARY KEY,
  object_id TEXT NOT NULL UNIQUE,
  source_scope_digest TEXT NOT NULL CHECK (source_scope_digest = '60a862c71e8f2fbdd57ec2a445a15121bac28f284ef8726d400afa9f76b86133'),
  CHECK ((invite_id = 'auto_UvYcAmAcgwV' AND object_id = '01cd35fa36329004a2d8112e4dccbb329b210ac0fea27bcf8b1c395872d5bc3f') OR (invite_id = 'auto_tye5L1mHNQJ' AND object_id = '53dd6640b8f9cc01837f6ae3de1b4c5622c275dfe960fa98bb70ce2c12e2fa37'))
) STRICT, WITHOUT ROWID;

CREATE TRIGGER retired_invites_require_active_control BEFORE INSERT ON retired_invites
WHEN NOT EXISTS (SELECT 1 FROM application_data_control WHERE singleton = 1 AND generation = 3 AND data_epoch = 1 AND phase = 'active')
BEGIN SELECT RAISE(ABORT, 'retired-invite-control-changed'); END;

CREATE TRIGGER retired_invites_require_absence BEFORE INSERT ON retired_invites
WHEN EXISTS (SELECT 1 FROM game_session_mutation_locks source WHERE source.lock_id = NEW.invite_id)
  OR EXISTS (SELECT 1 FROM game_session_transitions_canonical source WHERE source.invite_id = NEW.invite_id)
  OR EXISTS (SELECT 1 FROM game_session_transition_resources_canonical source WHERE source.resource_key = NEW.invite_id OR EXISTS (SELECT 1 FROM game_session_transitions_canonical t WHERE t.transition_id = source.transition_id AND t.invite_id = NEW.invite_id))
  OR EXISTS (SELECT 1 FROM invite_sources_canonical source WHERE source.invite_id = NEW.invite_id)
  OR EXISTS (SELECT 1 FROM automatch_entries_canonical source WHERE source.record_key = NEW.invite_id)
  OR EXISTS (SELECT 1 FROM automatch_live_tickets_canonical source WHERE source.invite_id = NEW.invite_id)
  OR EXISTS (SELECT 1 FROM automatch_pending_enqueues_canonical source WHERE source.invite_id = NEW.invite_id OR EXISTS (SELECT 1 FROM game_session_transitions_canonical t WHERE t.transition_id = source.transition_id AND t.invite_id = NEW.invite_id))
  OR EXISTS (SELECT 1 FROM automatch_telegram_sources_canonical source WHERE source.record_key = NEW.invite_id)
  OR EXISTS (SELECT 1 FROM automatch_telegram_projection_outbox_canonical source WHERE source.record_key = NEW.invite_id)
  OR EXISTS (SELECT 1 FROM game_session_projection_outbox_canonical source WHERE source.record_key = NEW.invite_id)
  OR EXISTS (SELECT 1 FROM game_session_mutation_receipts_canonical source WHERE json_extract(source.payload_json, '$.inviteId') = NEW.invite_id)
  OR EXISTS (SELECT 1 FROM profile_game_projection_locks source WHERE source.scope = 'invite' AND source.resource_id = NEW.invite_id)
  OR EXISTS (SELECT 1 FROM profile_game_projections_canonical source WHERE source.entity_type = 'game' AND source.projection_id = NEW.invite_id)
  OR EXISTS (SELECT 1 FROM historical_match_pairs_canonical source WHERE source.invite_id = NEW.invite_id OR (source.match_id = NEW.invite_id OR (substr(source.match_id, 1, length(NEW.invite_id)) = NEW.invite_id AND substr(source.match_id, length(NEW.invite_id) + 1) GLOB '[1-9]*' AND substr(source.match_id, length(NEW.invite_id) + 1) NOT GLOB '*[^0-9]*' AND (length(substr(source.match_id, length(NEW.invite_id) + 1)) < 16 OR (length(substr(source.match_id, length(NEW.invite_id) + 1)) = 16 AND substr(source.match_id, length(NEW.invite_id) + 1) <= '9007199254740991')))))
  OR EXISTS (SELECT 1 FROM login_match_discovery_canonical source WHERE source.invite_id = NEW.invite_id OR (source.match_id = NEW.invite_id OR (substr(source.match_id, 1, length(NEW.invite_id)) = NEW.invite_id AND substr(source.match_id, length(NEW.invite_id) + 1) GLOB '[1-9]*' AND substr(source.match_id, length(NEW.invite_id) + 1) NOT GLOB '*[^0-9]*' AND (length(substr(source.match_id, length(NEW.invite_id) + 1)) < 16 OR (length(substr(source.match_id, length(NEW.invite_id) + 1)) = 16 AND substr(source.match_id, length(NEW.invite_id) + 1) <= '9007199254740991')))))
  OR EXISTS (SELECT 1 FROM match_presentation_registrations_canonical source WHERE source.invite_id = NEW.invite_id OR (source.match_id = NEW.invite_id OR (substr(source.match_id, 1, length(NEW.invite_id)) = NEW.invite_id AND substr(source.match_id, length(NEW.invite_id) + 1) GLOB '[1-9]*' AND substr(source.match_id, length(NEW.invite_id) + 1) NOT GLOB '*[^0-9]*' AND (length(substr(source.match_id, length(NEW.invite_id) + 1)) < 16 OR (length(substr(source.match_id, length(NEW.invite_id) + 1)) = 16 AND substr(source.match_id, length(NEW.invite_id) + 1) <= '9007199254740991')))))
  OR EXISTS (SELECT 1 FROM match_state_routes_canonical source WHERE source.invite_id = NEW.invite_id OR (source.match_id = NEW.invite_id OR (substr(source.match_id, 1, length(NEW.invite_id)) = NEW.invite_id AND substr(source.match_id, length(NEW.invite_id) + 1) GLOB '[1-9]*' AND substr(source.match_id, length(NEW.invite_id) + 1) NOT GLOB '*[^0-9]*' AND (length(substr(source.match_id, length(NEW.invite_id) + 1)) < 16 OR (length(substr(source.match_id, length(NEW.invite_id) + 1)) = 16 AND substr(source.match_id, length(NEW.invite_id) + 1) <= '9007199254740991')))))
BEGIN SELECT RAISE(ABORT, 'retired-invite-has-dependencies'); END;

CREATE TRIGGER game_session_mutation_locks_retired_invite_insert BEFORE INSERT ON game_session_mutation_locks
WHEN EXISTS (SELECT 1 FROM retired_invites retired WHERE NEW.lock_id = retired.invite_id)
BEGIN SELECT RAISE(ABORT, 'retired-invite-write'); END;

CREATE TRIGGER game_session_mutation_locks_retired_invite_update BEFORE UPDATE ON game_session_mutation_locks
WHEN EXISTS (SELECT 1 FROM retired_invites retired WHERE NEW.lock_id = retired.invite_id)
BEGIN SELECT RAISE(ABORT, 'retired-invite-write'); END;

CREATE TRIGGER game_session_transitions_canonical_retired_invite_insert BEFORE INSERT ON game_session_transitions_canonical
WHEN EXISTS (SELECT 1 FROM retired_invites retired WHERE NEW.invite_id = retired.invite_id)
BEGIN SELECT RAISE(ABORT, 'retired-invite-write'); END;

CREATE TRIGGER game_session_transitions_canonical_retired_invite_update BEFORE UPDATE ON game_session_transitions_canonical
WHEN EXISTS (SELECT 1 FROM retired_invites retired WHERE NEW.invite_id = retired.invite_id)
BEGIN SELECT RAISE(ABORT, 'retired-invite-write'); END;

CREATE TRIGGER game_session_transition_resources_canonical_retired_invite_insert BEFORE INSERT ON game_session_transition_resources_canonical
WHEN EXISTS (SELECT 1 FROM retired_invites retired WHERE NEW.resource_key = retired.invite_id OR EXISTS (SELECT 1 FROM game_session_transitions_canonical t WHERE t.transition_id = NEW.transition_id AND t.invite_id = retired.invite_id))
BEGIN SELECT RAISE(ABORT, 'retired-invite-write'); END;

CREATE TRIGGER game_session_transition_resources_canonical_retired_invite_update BEFORE UPDATE ON game_session_transition_resources_canonical
WHEN EXISTS (SELECT 1 FROM retired_invites retired WHERE NEW.resource_key = retired.invite_id OR EXISTS (SELECT 1 FROM game_session_transitions_canonical t WHERE t.transition_id = NEW.transition_id AND t.invite_id = retired.invite_id))
BEGIN SELECT RAISE(ABORT, 'retired-invite-write'); END;

CREATE TRIGGER invite_sources_canonical_retired_invite_insert BEFORE INSERT ON invite_sources_canonical
WHEN EXISTS (SELECT 1 FROM retired_invites retired WHERE NEW.invite_id = retired.invite_id)
BEGIN SELECT RAISE(ABORT, 'retired-invite-write'); END;

CREATE TRIGGER invite_sources_canonical_retired_invite_update BEFORE UPDATE ON invite_sources_canonical
WHEN EXISTS (SELECT 1 FROM retired_invites retired WHERE NEW.invite_id = retired.invite_id)
BEGIN SELECT RAISE(ABORT, 'retired-invite-write'); END;

CREATE TRIGGER automatch_entries_canonical_retired_invite_insert BEFORE INSERT ON automatch_entries_canonical
WHEN EXISTS (SELECT 1 FROM retired_invites retired WHERE NEW.record_key = retired.invite_id)
BEGIN SELECT RAISE(ABORT, 'retired-invite-write'); END;

CREATE TRIGGER automatch_entries_canonical_retired_invite_update BEFORE UPDATE ON automatch_entries_canonical
WHEN EXISTS (SELECT 1 FROM retired_invites retired WHERE NEW.record_key = retired.invite_id)
BEGIN SELECT RAISE(ABORT, 'retired-invite-write'); END;

CREATE TRIGGER automatch_live_tickets_canonical_retired_invite_insert BEFORE INSERT ON automatch_live_tickets_canonical
WHEN EXISTS (SELECT 1 FROM retired_invites retired WHERE NEW.invite_id = retired.invite_id)
BEGIN SELECT RAISE(ABORT, 'retired-invite-write'); END;

CREATE TRIGGER automatch_live_tickets_canonical_retired_invite_update BEFORE UPDATE ON automatch_live_tickets_canonical
WHEN EXISTS (SELECT 1 FROM retired_invites retired WHERE NEW.invite_id = retired.invite_id)
BEGIN SELECT RAISE(ABORT, 'retired-invite-write'); END;

CREATE TRIGGER automatch_pending_enqueues_canonical_retired_invite_insert BEFORE INSERT ON automatch_pending_enqueues_canonical
WHEN EXISTS (SELECT 1 FROM retired_invites retired WHERE NEW.invite_id = retired.invite_id OR EXISTS (SELECT 1 FROM game_session_transitions_canonical t WHERE t.transition_id = NEW.transition_id AND t.invite_id = retired.invite_id))
BEGIN SELECT RAISE(ABORT, 'retired-invite-write'); END;

CREATE TRIGGER automatch_pending_enqueues_canonical_retired_invite_update BEFORE UPDATE ON automatch_pending_enqueues_canonical
WHEN EXISTS (SELECT 1 FROM retired_invites retired WHERE NEW.invite_id = retired.invite_id OR EXISTS (SELECT 1 FROM game_session_transitions_canonical t WHERE t.transition_id = NEW.transition_id AND t.invite_id = retired.invite_id))
BEGIN SELECT RAISE(ABORT, 'retired-invite-write'); END;

CREATE TRIGGER automatch_telegram_sources_canonical_retired_invite_insert BEFORE INSERT ON automatch_telegram_sources_canonical
WHEN EXISTS (SELECT 1 FROM retired_invites retired WHERE NEW.record_key = retired.invite_id)
BEGIN SELECT RAISE(ABORT, 'retired-invite-write'); END;

CREATE TRIGGER automatch_telegram_sources_canonical_retired_invite_update BEFORE UPDATE ON automatch_telegram_sources_canonical
WHEN EXISTS (SELECT 1 FROM retired_invites retired WHERE NEW.record_key = retired.invite_id)
BEGIN SELECT RAISE(ABORT, 'retired-invite-write'); END;

CREATE TRIGGER automatch_telegram_projection_outbox_canonical_retired_invite_insert BEFORE INSERT ON automatch_telegram_projection_outbox_canonical
WHEN EXISTS (SELECT 1 FROM retired_invites retired WHERE NEW.record_key = retired.invite_id)
BEGIN SELECT RAISE(ABORT, 'retired-invite-write'); END;

CREATE TRIGGER automatch_telegram_projection_outbox_canonical_retired_invite_update BEFORE UPDATE ON automatch_telegram_projection_outbox_canonical
WHEN EXISTS (SELECT 1 FROM retired_invites retired WHERE NEW.record_key = retired.invite_id)
BEGIN SELECT RAISE(ABORT, 'retired-invite-write'); END;

CREATE TRIGGER game_session_projection_outbox_canonical_retired_invite_insert BEFORE INSERT ON game_session_projection_outbox_canonical
WHEN EXISTS (SELECT 1 FROM retired_invites retired WHERE NEW.record_key = retired.invite_id)
BEGIN SELECT RAISE(ABORT, 'retired-invite-write'); END;

CREATE TRIGGER game_session_projection_outbox_canonical_retired_invite_update BEFORE UPDATE ON game_session_projection_outbox_canonical
WHEN EXISTS (SELECT 1 FROM retired_invites retired WHERE NEW.record_key = retired.invite_id)
BEGIN SELECT RAISE(ABORT, 'retired-invite-write'); END;

CREATE TRIGGER game_session_mutation_receipts_canonical_retired_invite_insert BEFORE INSERT ON game_session_mutation_receipts_canonical
WHEN EXISTS (SELECT 1 FROM retired_invites retired WHERE json_extract(NEW.payload_json, '$.inviteId') = retired.invite_id)
BEGIN SELECT RAISE(ABORT, 'retired-invite-write'); END;

CREATE TRIGGER game_session_mutation_receipts_canonical_retired_invite_update BEFORE UPDATE ON game_session_mutation_receipts_canonical
WHEN EXISTS (SELECT 1 FROM retired_invites retired WHERE json_extract(NEW.payload_json, '$.inviteId') = retired.invite_id)
BEGIN SELECT RAISE(ABORT, 'retired-invite-write'); END;

CREATE TRIGGER profile_game_projection_locks_retired_invite_insert BEFORE INSERT ON profile_game_projection_locks
WHEN EXISTS (SELECT 1 FROM retired_invites retired WHERE NEW.scope = 'invite' AND NEW.resource_id = retired.invite_id)
BEGIN SELECT RAISE(ABORT, 'retired-invite-write'); END;

CREATE TRIGGER profile_game_projection_locks_retired_invite_update BEFORE UPDATE ON profile_game_projection_locks
WHEN EXISTS (SELECT 1 FROM retired_invites retired WHERE NEW.scope = 'invite' AND NEW.resource_id = retired.invite_id)
BEGIN SELECT RAISE(ABORT, 'retired-invite-write'); END;

CREATE TRIGGER profile_game_projections_canonical_retired_invite_insert BEFORE INSERT ON profile_game_projections_canonical
WHEN EXISTS (SELECT 1 FROM retired_invites retired WHERE NEW.entity_type = 'game' AND NEW.projection_id = retired.invite_id)
BEGIN SELECT RAISE(ABORT, 'retired-invite-write'); END;

CREATE TRIGGER profile_game_projections_canonical_retired_invite_update BEFORE UPDATE ON profile_game_projections_canonical
WHEN EXISTS (SELECT 1 FROM retired_invites retired WHERE NEW.entity_type = 'game' AND NEW.projection_id = retired.invite_id)
BEGIN SELECT RAISE(ABORT, 'retired-invite-write'); END;

CREATE TRIGGER historical_match_pairs_canonical_retired_invite_insert BEFORE INSERT ON historical_match_pairs_canonical
WHEN EXISTS (SELECT 1 FROM retired_invites retired WHERE NEW.invite_id = retired.invite_id OR (NEW.match_id = retired.invite_id OR (substr(NEW.match_id, 1, length(retired.invite_id)) = retired.invite_id AND substr(NEW.match_id, length(retired.invite_id) + 1) GLOB '[1-9]*' AND substr(NEW.match_id, length(retired.invite_id) + 1) NOT GLOB '*[^0-9]*' AND (length(substr(NEW.match_id, length(retired.invite_id) + 1)) < 16 OR (length(substr(NEW.match_id, length(retired.invite_id) + 1)) = 16 AND substr(NEW.match_id, length(retired.invite_id) + 1) <= '9007199254740991')))))
BEGIN SELECT RAISE(ABORT, 'retired-invite-write'); END;

CREATE TRIGGER historical_match_pairs_canonical_retired_invite_update BEFORE UPDATE ON historical_match_pairs_canonical
WHEN EXISTS (SELECT 1 FROM retired_invites retired WHERE NEW.invite_id = retired.invite_id OR (NEW.match_id = retired.invite_id OR (substr(NEW.match_id, 1, length(retired.invite_id)) = retired.invite_id AND substr(NEW.match_id, length(retired.invite_id) + 1) GLOB '[1-9]*' AND substr(NEW.match_id, length(retired.invite_id) + 1) NOT GLOB '*[^0-9]*' AND (length(substr(NEW.match_id, length(retired.invite_id) + 1)) < 16 OR (length(substr(NEW.match_id, length(retired.invite_id) + 1)) = 16 AND substr(NEW.match_id, length(retired.invite_id) + 1) <= '9007199254740991')))))
BEGIN SELECT RAISE(ABORT, 'retired-invite-write'); END;

CREATE TRIGGER login_match_discovery_canonical_retired_invite_insert BEFORE INSERT ON login_match_discovery_canonical
WHEN EXISTS (SELECT 1 FROM retired_invites retired WHERE NEW.invite_id = retired.invite_id OR (NEW.match_id = retired.invite_id OR (substr(NEW.match_id, 1, length(retired.invite_id)) = retired.invite_id AND substr(NEW.match_id, length(retired.invite_id) + 1) GLOB '[1-9]*' AND substr(NEW.match_id, length(retired.invite_id) + 1) NOT GLOB '*[^0-9]*' AND (length(substr(NEW.match_id, length(retired.invite_id) + 1)) < 16 OR (length(substr(NEW.match_id, length(retired.invite_id) + 1)) = 16 AND substr(NEW.match_id, length(retired.invite_id) + 1) <= '9007199254740991')))))
BEGIN SELECT RAISE(ABORT, 'retired-invite-write'); END;

CREATE TRIGGER login_match_discovery_canonical_retired_invite_update BEFORE UPDATE ON login_match_discovery_canonical
WHEN EXISTS (SELECT 1 FROM retired_invites retired WHERE NEW.invite_id = retired.invite_id OR (NEW.match_id = retired.invite_id OR (substr(NEW.match_id, 1, length(retired.invite_id)) = retired.invite_id AND substr(NEW.match_id, length(retired.invite_id) + 1) GLOB '[1-9]*' AND substr(NEW.match_id, length(retired.invite_id) + 1) NOT GLOB '*[^0-9]*' AND (length(substr(NEW.match_id, length(retired.invite_id) + 1)) < 16 OR (length(substr(NEW.match_id, length(retired.invite_id) + 1)) = 16 AND substr(NEW.match_id, length(retired.invite_id) + 1) <= '9007199254740991')))))
BEGIN SELECT RAISE(ABORT, 'retired-invite-write'); END;

CREATE TRIGGER match_presentation_registrations_canonical_retired_invite_insert BEFORE INSERT ON match_presentation_registrations_canonical
WHEN EXISTS (SELECT 1 FROM retired_invites retired WHERE NEW.invite_id = retired.invite_id OR (NEW.match_id = retired.invite_id OR (substr(NEW.match_id, 1, length(retired.invite_id)) = retired.invite_id AND substr(NEW.match_id, length(retired.invite_id) + 1) GLOB '[1-9]*' AND substr(NEW.match_id, length(retired.invite_id) + 1) NOT GLOB '*[^0-9]*' AND (length(substr(NEW.match_id, length(retired.invite_id) + 1)) < 16 OR (length(substr(NEW.match_id, length(retired.invite_id) + 1)) = 16 AND substr(NEW.match_id, length(retired.invite_id) + 1) <= '9007199254740991')))))
BEGIN SELECT RAISE(ABORT, 'retired-invite-write'); END;

CREATE TRIGGER match_presentation_registrations_canonical_retired_invite_update BEFORE UPDATE ON match_presentation_registrations_canonical
WHEN EXISTS (SELECT 1 FROM retired_invites retired WHERE NEW.invite_id = retired.invite_id OR (NEW.match_id = retired.invite_id OR (substr(NEW.match_id, 1, length(retired.invite_id)) = retired.invite_id AND substr(NEW.match_id, length(retired.invite_id) + 1) GLOB '[1-9]*' AND substr(NEW.match_id, length(retired.invite_id) + 1) NOT GLOB '*[^0-9]*' AND (length(substr(NEW.match_id, length(retired.invite_id) + 1)) < 16 OR (length(substr(NEW.match_id, length(retired.invite_id) + 1)) = 16 AND substr(NEW.match_id, length(retired.invite_id) + 1) <= '9007199254740991')))))
BEGIN SELECT RAISE(ABORT, 'retired-invite-write'); END;

CREATE TRIGGER match_state_routes_canonical_retired_invite_insert BEFORE INSERT ON match_state_routes_canonical
WHEN EXISTS (SELECT 1 FROM retired_invites retired WHERE NEW.invite_id = retired.invite_id OR (NEW.match_id = retired.invite_id OR (substr(NEW.match_id, 1, length(retired.invite_id)) = retired.invite_id AND substr(NEW.match_id, length(retired.invite_id) + 1) GLOB '[1-9]*' AND substr(NEW.match_id, length(retired.invite_id) + 1) NOT GLOB '*[^0-9]*' AND (length(substr(NEW.match_id, length(retired.invite_id) + 1)) < 16 OR (length(substr(NEW.match_id, length(retired.invite_id) + 1)) = 16 AND substr(NEW.match_id, length(retired.invite_id) + 1) <= '9007199254740991')))))
BEGIN SELECT RAISE(ABORT, 'retired-invite-write'); END;

CREATE TRIGGER match_state_routes_canonical_retired_invite_update BEFORE UPDATE ON match_state_routes_canonical
WHEN EXISTS (SELECT 1 FROM retired_invites retired WHERE NEW.invite_id = retired.invite_id OR (NEW.match_id = retired.invite_id OR (substr(NEW.match_id, 1, length(retired.invite_id)) = retired.invite_id AND substr(NEW.match_id, length(retired.invite_id) + 1) GLOB '[1-9]*' AND substr(NEW.match_id, length(retired.invite_id) + 1) NOT GLOB '*[^0-9]*' AND (length(substr(NEW.match_id, length(retired.invite_id) + 1)) < 16 OR (length(substr(NEW.match_id, length(retired.invite_id) + 1)) = 16 AND substr(NEW.match_id, length(retired.invite_id) + 1) <= '9007199254740991')))))
BEGIN SELECT RAISE(ABORT, 'retired-invite-write'); END;

INSERT INTO retired_invites (invite_id, object_id, source_scope_digest) VALUES ('auto_UvYcAmAcgwV', '01cd35fa36329004a2d8112e4dccbb329b210ac0fea27bcf8b1c395872d5bc3f', '60a862c71e8f2fbdd57ec2a445a15121bac28f284ef8726d400afa9f76b86133');

INSERT INTO retired_invites (invite_id, object_id, source_scope_digest) VALUES ('auto_tye5L1mHNQJ', '53dd6640b8f9cc01837f6ae3de1b4c5622c275dfe960fa98bb70ce2c12e2fa37', '60a862c71e8f2fbdd57ec2a445a15121bac28f284ef8726d400afa9f76b86133');

DROP TRIGGER retired_invites_require_absence;

DROP TRIGGER retired_invites_require_active_control;

CREATE TRIGGER retired_invites_immutable_insert BEFORE INSERT ON retired_invites
BEGIN SELECT RAISE(ABORT, 'retired-invite-immutable'); END;

CREATE TRIGGER retired_invites_immutable_update BEFORE UPDATE ON retired_invites
BEGIN SELECT RAISE(ABORT, 'retired-invite-immutable'); END;

CREATE TRIGGER retired_invites_immutable_delete BEFORE DELETE ON retired_invites
BEGIN SELECT RAISE(ABORT, 'retired-invite-immutable'); END;
