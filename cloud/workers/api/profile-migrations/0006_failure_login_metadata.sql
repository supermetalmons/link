ALTER TABLE profile_projection_failures
ADD COLUMN login_uids_source_seconds INTEGER NOT NULL DEFAULT -1;

ALTER TABLE profile_projection_failures
ADD COLUMN login_uids_source_nanos INTEGER NOT NULL DEFAULT 0 CHECK (
  login_uids_source_nanos >= 0
  AND login_uids_source_nanos < 1000000000
);

ALTER TABLE profile_projection_failures
ADD COLUMN login_uids_complete INTEGER NOT NULL DEFAULT 0 CHECK (
  login_uids_complete IN (0, 1)
);
