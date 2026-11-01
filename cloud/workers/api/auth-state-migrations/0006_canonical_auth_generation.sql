CREATE TABLE auth_intents_canonical (
  intent_id TEXT PRIMARY KEY NOT NULL CHECK (length(intent_id) > 0),
  data_epoch INTEGER NOT NULL DEFAULT 1 CHECK (data_epoch = 1),
  uid TEXT NOT NULL CHECK (length(uid) > 0),
  method TEXT NOT NULL CHECK (method IN ('apple', 'eth', 'sol', 'x')),
  nonce TEXT NOT NULL CHECK (length(nonce) > 0),
  state TEXT NOT NULL CHECK (length(state) > 0),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms > 0),
  expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms >= created_at_ms),
  consumed_at_ms INTEGER CHECK (consumed_at_ms IS NULL OR consumed_at_ms >= created_at_ms),
  consumed_by_op_id TEXT CHECK (consumed_by_op_id IS NULL OR length(consumed_by_op_id) > 0),
  cancelled_at_ms INTEGER CHECK (cancelled_at_ms IS NULL OR cancelled_at_ms >= created_at_ms),
  CHECK (consumed_by_op_id IS NULL OR consumed_at_ms IS NOT NULL),
  CHECK (cancelled_at_ms IS NULL OR (consumed_at_ms IS NULL AND consumed_by_op_id IS NULL))
) STRICT, WITHOUT ROWID;

CREATE INDEX idx_auth_intents_canonical_expires ON auth_intents_canonical (expires_at_ms);

CREATE TABLE x_redirect_flows_canonical (
  flow_id TEXT PRIMARY KEY NOT NULL CHECK (length(flow_id) > 0),
  data_epoch INTEGER NOT NULL DEFAULT 1 CHECK (data_epoch = 1),
  intent_id TEXT NOT NULL REFERENCES auth_intents_canonical(intent_id),
  uid TEXT NOT NULL CHECK (length(uid) > 0),
  method TEXT NOT NULL CHECK (method = 'x'),
  callback_uri TEXT NOT NULL CHECK (length(callback_uri) > 0),
  code_challenge TEXT NOT NULL CHECK (length(code_challenge) > 0),
  code_verifier TEXT NOT NULL CHECK (length(code_verifier) > 0),
  consent_source TEXT NOT NULL CHECK (consent_source IN ('signin', 'settings')),
  return_url TEXT NOT NULL CHECK (length(return_url) > 0),
  status TEXT NOT NULL CHECK (status IN ('created', 'processing', 'verified', 'completed', 'failed', 'cancelled')),
  error_code TEXT CHECK (error_code IS NULL OR length(error_code) > 0),
  x_user_id TEXT CHECK (x_user_id IS NULL OR length(x_user_id) > 0),
  x_username TEXT CHECK (x_username IS NULL OR length(x_username) > 0),
  result_profile_id TEXT CHECK (result_profile_id IS NULL OR length(result_profile_id) > 0),
  result_op_id TEXT CHECK (result_op_id IS NULL OR length(result_op_id) > 0),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms > 0),
  expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms >= created_at_ms),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  processing_started_at_ms INTEGER CHECK (processing_started_at_ms IS NULL OR processing_started_at_ms BETWEEN created_at_ms AND updated_at_ms),
  completed_at_ms INTEGER CHECK (completed_at_ms IS NULL OR completed_at_ms BETWEEN created_at_ms AND updated_at_ms),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  CHECK ((result_profile_id IS NULL) = (result_op_id IS NULL)),
  CHECK (x_username IS NULL OR x_user_id IS NOT NULL),
  CHECK ((status = 'processing') = (processing_started_at_ms IS NOT NULL)),
  CHECK ((status = 'completed') = (completed_at_ms IS NOT NULL)),
  CHECK ((status = 'completed') = (result_profile_id IS NOT NULL)),
  CHECK ((status IN ('failed', 'cancelled')) = (error_code IS NOT NULL)),
  CHECK (status <> 'cancelled' OR error_code = 'application-data-reset'),
  CHECK (status NOT IN ('created', 'processing') OR x_user_id IS NULL),
  CHECK (status NOT IN ('verified', 'completed') OR x_user_id IS NOT NULL)
) STRICT, WITHOUT ROWID;

CREATE INDEX idx_x_redirect_flows_canonical_expires ON x_redirect_flows_canonical (expires_at_ms);
CREATE INDEX idx_x_redirect_flows_canonical_intent ON x_redirect_flows_canonical (intent_id);
CREATE INDEX idx_x_redirect_flows_canonical_status_expires ON x_redirect_flows_canonical (status, expires_at_ms, flow_id);
CREATE INDEX idx_x_redirect_flows_canonical_status_updated ON x_redirect_flows_canonical (status, updated_at_ms, flow_id);

CREATE INDEX idx_x_redirect_flows_canonical_terminal_updated
ON x_redirect_flows_canonical (updated_at_ms)
WHERE status IN ('verified', 'completed', 'failed', 'cancelled');
CREATE INDEX idx_x_redirect_flows_canonical_uncompacted_expires
ON x_redirect_flows_canonical (expires_at_ms)
WHERE status IN ('verified', 'completed', 'failed', 'cancelled')
  AND (code_challenge <> 'retired' OR code_verifier <> 'retired');
CREATE INDEX idx_auth_intents_canonical_uncompacted_expires
ON auth_intents_canonical (expires_at_ms)
WHERE nonce <> 'retired' OR state <> 'retired';
