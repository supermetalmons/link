export const CANONICAL_PROFILE_TOPOLOGY_VIOLATION_KINDS = [
  "retiring_profile_without_matching_redirect",
  "active_profile_with_redirect",
  "login_owner_without_active_profile",
  "auth_method_without_active_profile",
  "recovery_job_without_active_profile",
] as const;

export const CANONICAL_PROFILE_TOPOLOGY_VIOLATION_PREDICATE = `EXISTS (
  SELECT 1
  FROM json_each(?) AS affected
  LEFT JOIN profile_records AS profile
    ON profile.profile_id = affected.value
  LEFT JOIN profile_merge_targets AS mapping
    ON mapping.source_profile_id = affected.value
  WHERE (
    profile.state = 'retiring'
    AND mapping.target_profile_id IS NOT profile.merged_into_profile_id
  ) OR (
    profile.state = 'active' AND mapping.source_profile_id IS NOT NULL
  ) OR (
    (profile.profile_id IS NULL OR profile.state != 'active')
    AND (
      EXISTS (
        SELECT 1 FROM profile_login_owners AS owner
        WHERE owner.profile_id = affected.value
      ) OR EXISTS (
        SELECT 1 FROM profile_auth_methods AS method
        WHERE method.profile_id = affected.value
      ) OR EXISTS (
        SELECT 1 FROM profile_auth_recovery_jobs AS recovery
        WHERE recovery.profile_id = affected.value
      )
    )
  )
)`;

export const CANONICAL_PROFILE_TOPOLOGY_AUDIT_SQL = `SELECT
  (
    SELECT COUNT(*) FROM profile_records AS profile
    WHERE profile.state = 'retiring'
      AND NOT EXISTS (
        SELECT 1 FROM profile_merge_targets AS mapping
        WHERE mapping.source_profile_id = profile.profile_id
          AND mapping.target_profile_id = profile.merged_into_profile_id
      )
  ) AS retiring_profile_without_matching_redirect,
  (
    SELECT COUNT(*) FROM profile_records AS profile
    JOIN profile_merge_targets AS mapping
      ON mapping.source_profile_id = profile.profile_id
    WHERE profile.state = 'active'
  ) AS active_profile_with_redirect,
  (
    SELECT COUNT(*) FROM profile_login_owners AS owner
    LEFT JOIN profile_records AS profile
      ON profile.profile_id = owner.profile_id AND profile.state = 'active'
    WHERE profile.profile_id IS NULL
  ) AS login_owner_without_active_profile,
  (
    SELECT COUNT(*) FROM profile_auth_methods AS method
    LEFT JOIN profile_records AS profile
      ON profile.profile_id = method.profile_id AND profile.state = 'active'
    WHERE profile.profile_id IS NULL
  ) AS auth_method_without_active_profile,
  (
    SELECT COUNT(*) FROM profile_auth_recovery_jobs AS recovery
    LEFT JOIN profile_records AS profile
      ON profile.profile_id = recovery.profile_id AND profile.state = 'active'
    WHERE profile.profile_id IS NULL
  ) AS recovery_job_without_active_profile`;
