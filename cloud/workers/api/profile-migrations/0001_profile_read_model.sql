CREATE TABLE profiles (
  profile_id TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  merged_into_profile_id TEXT,
  rating_sort REAL,
  mana_points_sort REAL,
  dust_sort REAL,
  slime_sort REAL,
  gum_sort REAL,
  metal_sort REAL,
  ice_sort REAL,
  source_update_seconds INTEGER NOT NULL,
  source_update_nanos INTEGER NOT NULL CHECK (
    source_update_nanos >= 0 AND source_update_nanos < 1000000000
  ),
  source_digest TEXT NOT NULL CHECK (
    length(source_digest) = 64 AND source_digest NOT GLOB '*[^0-9a-f]*'
  ),
  projected_at_ms INTEGER NOT NULL CHECK (projected_at_ms > 0)
) WITHOUT ROWID;

CREATE TABLE profile_logins (
  login_uid TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  PRIMARY KEY (login_uid, profile_id),
  FOREIGN KEY (profile_id) REFERENCES profiles(profile_id) ON DELETE CASCADE
) WITHOUT ROWID;

CREATE INDEX idx_profile_logins_profile
ON profile_logins (profile_id, login_uid);

CREATE INDEX idx_profiles_rating
ON profiles (rating_sort DESC, profile_id DESC);

CREATE INDEX idx_profiles_mana_points
ON profiles (mana_points_sort DESC, profile_id DESC);

CREATE INDEX idx_profiles_dust
ON profiles (dust_sort DESC, profile_id DESC);

CREATE INDEX idx_profiles_slime
ON profiles (slime_sort DESC, profile_id DESC);

CREATE INDEX idx_profiles_gum
ON profiles (gum_sort DESC, profile_id DESC);

CREATE INDEX idx_profiles_metal
ON profiles (metal_sort DESC, profile_id DESC);

CREATE INDEX idx_profiles_ice
ON profiles (ice_sort DESC, profile_id DESC);
