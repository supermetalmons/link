export function canonicalProfileRedirectCte(kind: "login" | "profile"): string {
  const roots =
    kind === "login"
      ? `SELECT
           requested.request_index,
           requested.request_key,
           owner.profile_id AS root_profile_id,
           owner.revision AS owner_revision,
           owner.created_at_ms AS owner_created_at_ms,
           owner.updated_at_ms AS owner_updated_at_ms
         FROM requested
         LEFT JOIN profile_login_owners_canonical owner
           ON owner.login_uid = requested.request_key`
      : `SELECT
           request_index,
           request_key,
           request_key AS root_profile_id,
           NULL AS owner_revision,
           NULL AS owner_created_at_ms,
           NULL AS owner_updated_at_ms
         FROM requested`;
  return `WITH RECURSIVE
       requested(request_index, request_key) AS (
         SELECT CAST(key AS INTEGER), CAST(value AS TEXT)
         FROM json_each(?)
       ),
       roots AS (${roots}),
       chain(
         request_index,
         request_key,
         root_profile_id,
         chain_profile_id,
         depth
       ) AS (
         SELECT
           request_index,
           request_key,
           root_profile_id,
           root_profile_id,
           0
         FROM roots
         WHERE root_profile_id IS NOT NULL
         UNION ALL
         SELECT
           chain.request_index,
           chain.request_key,
           chain.root_profile_id,
           target.target_profile_id,
           chain.depth + 1
         FROM chain
         JOIN profile_merge_targets_canonical target
           ON target.source_profile_id = chain.chain_profile_id
         WHERE chain.depth < ?
       )`;
}
