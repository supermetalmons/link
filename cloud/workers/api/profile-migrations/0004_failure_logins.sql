ALTER TABLE profile_projection_failures
ADD COLUMN login_uids_json TEXT NOT NULL DEFAULT '[]' CHECK (
  json_valid(login_uids_json)
);
