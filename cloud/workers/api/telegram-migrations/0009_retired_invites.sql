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
WHEN EXISTS (SELECT 1 FROM telegram_messages_canonical source WHERE source.message_key = 'automatch:' || NEW.invite_id)
BEGIN SELECT RAISE(ABORT, 'retired-invite-has-dependencies'); END;

CREATE TRIGGER telegram_messages_canonical_retired_invite_insert BEFORE INSERT ON telegram_messages_canonical
WHEN EXISTS (SELECT 1 FROM retired_invites retired WHERE NEW.message_key = 'automatch:' || retired.invite_id)
BEGIN SELECT RAISE(ABORT, 'retired-invite-write'); END;

CREATE TRIGGER telegram_messages_canonical_retired_invite_update BEFORE UPDATE ON telegram_messages_canonical
WHEN EXISTS (SELECT 1 FROM retired_invites retired WHERE NEW.message_key = 'automatch:' || retired.invite_id)
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
