ALTER TABLE profiles
ADD COLUMN projection_schema_version INTEGER NOT NULL DEFAULT 1 CHECK (
  projection_schema_version > 0
);

ALTER TABLE profiles
ADD COLUMN projection_schema_source_seconds INTEGER NOT NULL DEFAULT 0;

ALTER TABLE profiles
ADD COLUMN projection_schema_source_nanos INTEGER NOT NULL DEFAULT 0 CHECK (
  projection_schema_source_nanos >= 0
  AND projection_schema_source_nanos < 1000000000
);

ALTER TABLE profiles
ADD COLUMN rating_sort_present INTEGER NOT NULL DEFAULT 0 CHECK (
  rating_sort_present IN (0, 1)
);

ALTER TABLE profiles
ADD COLUMN mana_points_sort_present INTEGER NOT NULL DEFAULT 0 CHECK (
  mana_points_sort_present IN (0, 1)
);

ALTER TABLE profiles
ADD COLUMN dust_sort_present INTEGER NOT NULL DEFAULT 0 CHECK (
  dust_sort_present IN (0, 1)
);

ALTER TABLE profiles
ADD COLUMN slime_sort_present INTEGER NOT NULL DEFAULT 0 CHECK (
  slime_sort_present IN (0, 1)
);

ALTER TABLE profiles
ADD COLUMN gum_sort_present INTEGER NOT NULL DEFAULT 0 CHECK (
  gum_sort_present IN (0, 1)
);

ALTER TABLE profiles
ADD COLUMN metal_sort_present INTEGER NOT NULL DEFAULT 0 CHECK (
  metal_sort_present IN (0, 1)
);

ALTER TABLE profiles
ADD COLUMN ice_sort_present INTEGER NOT NULL DEFAULT 0 CHECK (
  ice_sort_present IN (0, 1)
);

UPDATE profiles SET
  projection_schema_source_seconds = source_update_seconds,
  projection_schema_source_nanos = source_update_nanos,
  rating_sort_present = rating_sort IS NOT NULL,
  mana_points_sort_present = mana_points_sort IS NOT NULL,
  dust_sort_present = dust_sort IS NOT NULL,
  slime_sort_present = slime_sort IS NOT NULL,
  gum_sort_present = gum_sort IS NOT NULL,
  metal_sort_present = metal_sort IS NOT NULL,
  ice_sort_present = ice_sort IS NOT NULL;

ALTER TABLE profile_projection_failures
ADD COLUMN projection_schema_version INTEGER NOT NULL DEFAULT 1 CHECK (
  projection_schema_version > 0
);

ALTER TABLE profile_projection_failures
ADD COLUMN projection_schema_source_seconds INTEGER NOT NULL DEFAULT 0;

ALTER TABLE profile_projection_failures
ADD COLUMN projection_schema_source_nanos INTEGER NOT NULL DEFAULT 0 CHECK (
  projection_schema_source_nanos >= 0
  AND projection_schema_source_nanos < 1000000000
);

UPDATE profile_projection_failures SET
  projection_schema_source_seconds = source_update_seconds,
  projection_schema_source_nanos = source_update_nanos;

CREATE TABLE profile_logins_v2 (
  login_uid TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  projection_schema_version INTEGER NOT NULL CHECK (
    projection_schema_version > 0
  ),
  PRIMARY KEY (login_uid, profile_id),
  FOREIGN KEY (profile_id) REFERENCES profiles(profile_id) ON DELETE CASCADE
) WITHOUT ROWID;

INSERT INTO profile_logins_v2 (
  login_uid,
  profile_id,
  projection_schema_version
)
SELECT profile_logins.login_uid, profile_logins.profile_id, 1
FROM profile_logins
INNER JOIN profiles ON profiles.profile_id = profile_logins.profile_id
WHERE profiles.is_deleted = 0;

CREATE INDEX idx_profile_logins_v2_profile
ON profile_logins_v2 (profile_id, login_uid);

DROP INDEX idx_profiles_rating;
DROP INDEX idx_profiles_mana_points;
DROP INDEX idx_profiles_dust;
DROP INDEX idx_profiles_slime;
DROP INDEX idx_profiles_gum;
DROP INDEX idx_profiles_metal;
DROP INDEX idx_profiles_ice;

CREATE INDEX idx_profiles_rating
ON profiles (
  is_deleted,
  rating_sort_present,
  rating_sort DESC,
  profile_id DESC
);

CREATE INDEX idx_profiles_mana_points
ON profiles (
  is_deleted,
  mana_points_sort_present,
  mana_points_sort DESC,
  profile_id DESC
);

CREATE INDEX idx_profiles_dust
ON profiles (
  is_deleted,
  dust_sort_present,
  dust_sort DESC,
  profile_id DESC
);

CREATE INDEX idx_profiles_slime
ON profiles (
  is_deleted,
  slime_sort_present,
  slime_sort DESC,
  profile_id DESC
);

CREATE INDEX idx_profiles_gum
ON profiles (
  is_deleted,
  gum_sort_present,
  gum_sort DESC,
  profile_id DESC
);

CREATE INDEX idx_profiles_metal
ON profiles (
  is_deleted,
  metal_sort_present,
  metal_sort DESC,
  profile_id DESC
);

CREATE INDEX idx_profiles_ice
ON profiles (
  is_deleted,
  ice_sort_present,
  ice_sort DESC,
  profile_id DESC
);

CREATE TRIGGER profiles_reject_equal_schema_overwrite
BEFORE UPDATE ON profiles
WHEN NEW.source_update_seconds = OLD.source_update_seconds
  AND NEW.source_update_nanos = OLD.source_update_nanos
  AND NEW.projection_schema_version <= OLD.projection_schema_version
  AND NOT (
    NEW.projection_schema_version = OLD.projection_schema_version
    AND NEW.projection_schema_source_seconds = NEW.source_update_seconds
    AND NEW.projection_schema_source_nanos = NEW.source_update_nanos
    AND (
      OLD.projection_schema_source_seconds != OLD.source_update_seconds
      OR OLD.projection_schema_source_nanos != OLD.source_update_nanos
    )
  )
  AND NOT (OLD.is_deleted = 0 AND NEW.is_deleted = 1)
BEGIN
  SELECT RAISE(IGNORE);
END;

CREATE TRIGGER profile_failures_reject_older_schema
BEFORE INSERT ON profile_projection_failures
WHEN EXISTS (
  SELECT 1
  FROM profiles
  WHERE profile_id = NEW.profile_id
    AND source_update_seconds = NEW.source_update_seconds
    AND source_update_nanos = NEW.source_update_nanos
    AND projection_schema_version > NEW.projection_schema_version
)
BEGIN
  SELECT RAISE(IGNORE);
END;

CREATE TRIGGER profiles_clear_v2_logins_after_tombstone
AFTER UPDATE OF is_deleted ON profiles
WHEN OLD.is_deleted = 0 AND NEW.is_deleted = 1
BEGIN
  DELETE FROM profile_logins_v2 WHERE profile_id = NEW.profile_id;
END;
