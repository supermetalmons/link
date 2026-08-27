CREATE TABLE auth_intents (
  intent_id TEXT PRIMARY KEY,
  uid TEXT NOT NULL CHECK (length(uid) > 0),
  method TEXT NOT NULL CHECK (method IN ('apple', 'eth', 'sol', 'x')),
  nonce TEXT NOT NULL CHECK (length(nonce) > 0),
  state TEXT NOT NULL CHECK (length(state) > 0),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms > 0),
  expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms >= created_at_ms),
  consumed_at_ms INTEGER CHECK (consumed_at_ms IS NULL OR consumed_at_ms > 0),
  consumed_by_op_id TEXT,
  CHECK (consumed_by_op_id IS NULL OR length(consumed_by_op_id) > 0)
) WITHOUT ROWID;

CREATE INDEX idx_auth_intents_expires
ON auth_intents (expires_at_ms);

CREATE TABLE x_redirect_flows (
  flow_id TEXT PRIMARY KEY,
  intent_id TEXT NOT NULL REFERENCES auth_intents(intent_id),
  uid TEXT NOT NULL CHECK (length(uid) > 0),
  method TEXT NOT NULL CHECK (method = 'x'),
  callback_uri TEXT NOT NULL CHECK (length(callback_uri) > 0),
  code_challenge TEXT NOT NULL CHECK (length(code_challenge) > 0),
  code_verifier TEXT NOT NULL CHECK (length(code_verifier) > 0),
  consent_source TEXT NOT NULL CHECK (consent_source IN ('signin', 'settings')),
  return_url TEXT NOT NULL CHECK (length(return_url) > 0),
  status TEXT NOT NULL CHECK (status IN ('created', 'processing', 'verified', 'completed', 'failed')),
  error_code TEXT,
  x_user_id TEXT,
  x_username TEXT,
  result_profile_id TEXT,
  result_op_id TEXT,
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms > 0),
  expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms >= created_at_ms),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  processing_started_at_ms INTEGER CHECK (processing_started_at_ms IS NULL OR processing_started_at_ms > 0),
  completed_at_ms INTEGER CHECK (completed_at_ms IS NULL OR completed_at_ms > 0),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  CHECK ((result_profile_id IS NULL) = (result_op_id IS NULL)),
  CHECK (result_profile_id IS NULL OR length(result_profile_id) > 0),
  CHECK (result_op_id IS NULL OR length(result_op_id) > 0)
) WITHOUT ROWID;

CREATE INDEX idx_x_redirect_flows_expires
ON x_redirect_flows (expires_at_ms);
