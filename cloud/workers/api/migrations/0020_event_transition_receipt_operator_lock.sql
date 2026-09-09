CREATE TABLE event_transition_receipt_operator_lock (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  owner_token TEXT NOT NULL CHECK (owner_token != ''),
  operation TEXT NOT NULL CHECK (operation IN ('freeze', 'export', 'import', 'verify', 'activate', 'resume', 'abort')),
  created_at_ms INTEGER NOT NULL CHECK (typeof(created_at_ms) = 'integer' AND created_at_ms BETWEEN 0 AND 9007199254740991)
);
