CREATE INDEX idx_x_redirect_flows_terminal_updated
ON x_redirect_flows (updated_at_ms)
WHERE status IN ('verified', 'completed', 'failed');

CREATE INDEX idx_x_redirect_flows_uncompacted_expires
ON x_redirect_flows (expires_at_ms)
WHERE status IN ('verified', 'completed', 'failed')
  AND (code_challenge <> 'retired' OR code_verifier <> 'retired');

CREATE INDEX idx_auth_intents_uncompacted_expires
ON auth_intents (expires_at_ms)
WHERE nonce <> 'retired' OR state <> 'retired';
