ALTER TABLE profiles
ADD COLUMN is_deleted INTEGER NOT NULL DEFAULT 0 CHECK (is_deleted IN (0, 1));

DROP INDEX idx_profiles_rating;
DROP INDEX idx_profiles_mana_points;
DROP INDEX idx_profiles_dust;
DROP INDEX idx_profiles_slime;
DROP INDEX idx_profiles_gum;
DROP INDEX idx_profiles_metal;
DROP INDEX idx_profiles_ice;

CREATE INDEX idx_profiles_rating
ON profiles (is_deleted, rating_sort DESC, profile_id DESC);

CREATE INDEX idx_profiles_mana_points
ON profiles (is_deleted, mana_points_sort DESC, profile_id DESC);

CREATE INDEX idx_profiles_dust
ON profiles (is_deleted, dust_sort DESC, profile_id DESC);

CREATE INDEX idx_profiles_slime
ON profiles (is_deleted, slime_sort DESC, profile_id DESC);

CREATE INDEX idx_profiles_gum
ON profiles (is_deleted, gum_sort DESC, profile_id DESC);

CREATE INDEX idx_profiles_metal
ON profiles (is_deleted, metal_sort DESC, profile_id DESC);

CREATE INDEX idx_profiles_ice
ON profiles (is_deleted, ice_sort DESC, profile_id DESC);
