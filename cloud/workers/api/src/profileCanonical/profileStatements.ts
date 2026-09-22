import type {
  CanonicalProfileValue,
  CanonicalProfileSnapshot,
  CanonicalMergeTargetValue,
  CanonicalMutation,
} from "./types.ts";
import { profileWriteRow } from "./profiles.ts";
import { guardStatement } from "./guards.ts";
import { canonicalRowMutationStatement } from "./rowStatements.ts";

type ProfileMutation = Extract<
  CanonicalMutation,
  {
    kind:
      | "insert-active-profile"
      | "update-active-profile"
      | "patch-active-profile"
      | "retire-profile-with-redirect"
      | "delete-retired-profile"
      | "insert-login-owner"
      | "update-login-owner"
      | "move-login-owner-set"
      | "delete-login-owner";
  }
>;

type LoginOwnerMutation = Extract<
  ProfileMutation,
  {
    kind:
      | "insert-login-owner"
      | "update-login-owner"
      | "move-login-owner-set"
      | "delete-login-owner";
  }
>;

function profileMutationStatement(
  db: D1Database,
  value: CanonicalProfileValue,
  insert: boolean,
  current?: CanonicalProfileSnapshot,
): D1PreparedStatement {
  return canonicalRowMutationStatement(
    db,
    "profile_records",
    "profile_id",
    profileWriteRow(value),
    insert,
    current ? profileWriteRow(current) : undefined,
  );
}

function mergeTargetMutationStatement(
  db: D1Database,
  value: CanonicalMergeTargetValue,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO profile_merge_targets (
         source_profile_id, target_profile_id, merged_at_ms, op_id,
         source_legacy_fields_json
       ) VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(
      value.sourceProfileId,
      value.targetProfileId,
      value.mergedAtMs,
      value.opId,
      JSON.stringify(value.sourceLegacyFields),
    );
}

function loginOwnerMutationStatement(
  db: D1Database,
  mutation: LoginOwnerMutation,
): D1PreparedStatement {
  switch (mutation.kind) {
    case "insert-login-owner":
      return db
        .prepare(
          `INSERT INTO profile_login_owners (
             login_uid, profile_id, revision, created_at_ms, updated_at_ms
           ) VALUES (?, ?, 1, ?, ?)`,
        )
        .bind(
          mutation.value.loginUid,
          mutation.value.profileId,
          mutation.value.createdAtMs,
          mutation.value.updatedAtMs,
        );
    case "update-login-owner":
      return db
        .prepare(
          `UPDATE profile_login_owners SET
             profile_id = ?, updated_at_ms = ?, revision = revision + 1
           WHERE login_uid = ?`,
        )
        .bind(
          mutation.value.profileId,
          mutation.value.updatedAtMs,
          mutation.value.loginUid,
        );
    case "move-login-owner-set":
      return db
        .prepare(
          `UPDATE profile_login_owners SET
             profile_id = ?, updated_at_ms = ?, revision = revision + 1
           WHERE profile_id = ?`,
        )
        .bind(
          mutation.targetProfileId,
          mutation.updatedAtMs,
          mutation.sourceProfileId,
        );
    case "delete-login-owner":
      return db
        .prepare("DELETE FROM profile_login_owners WHERE login_uid = ?")
        .bind(mutation.loginUid);
  }
}

function profileLinkCatchupOwnerStatement(
  db: D1Database,
  source: { loginUid: string } | { profileId: string },
  profileId: string,
  nowMs: number,
  skipUnchangedOwner: boolean,
): D1PreparedStatement {
  const byLogin = "loginUid" in source;
  return db
    .prepare(
      `INSERT INTO profile_link_catchup_jobs (
         login_uid, request_id, profile_id, cleanup_profile_ids_json,
         match_cursor, source_updated_at_ms, last_queued_at_ms, revision
       )
       SELECT owner.login_uid, ?, ?,
         (
           SELECT json_group_array(profile_id) FROM (
             SELECT profile_id FROM (
               SELECT value AS profile_id
               FROM json_each(COALESCE(job.cleanup_profile_ids_json, '[]'))
               UNION SELECT job.profile_id WHERE job.profile_id IS NOT NULL
               UNION SELECT owner.profile_id
             ) WHERE profile_id != ? ORDER BY profile_id
           )
         ),
         NULL, MAX(?, COALESCE(job.source_updated_at_ms, 0)), ?,
         COALESCE(job.revision, 0) + 1
       FROM profile_login_owners AS owner
       LEFT JOIN profile_link_catchup_jobs AS job
         ON job.login_uid = owner.login_uid
       WHERE owner.${byLogin ? "login_uid" : "profile_id"} = ?
         ${skipUnchangedOwner ? "AND owner.profile_id != ?" : ""}
       ON CONFLICT (login_uid) DO UPDATE SET
         request_id = excluded.request_id,
         profile_id = excluded.profile_id,
         cleanup_profile_ids_json = excluded.cleanup_profile_ids_json,
         match_cursor = NULL,
         source_updated_at_ms = excluded.source_updated_at_ms,
         last_queued_at_ms = excluded.last_queued_at_ms,
         revision = excluded.revision`,
    )
    .bind(
      crypto.randomUUID(),
      profileId,
      profileId,
      nowMs,
      nowMs,
      byLogin ? source.loginUid : source.profileId,
      ...(skipUnchangedOwner ? [profileId] : []),
    );
}

export function buildProfileMutationStatements(
  db: D1Database,
  mutation: ProfileMutation,
): D1PreparedStatement[] {
  switch (mutation.kind) {
    case "insert-login-owner":
      return [
        loginOwnerMutationStatement(db, mutation),
        profileLinkCatchupOwnerStatement(
          db,
          { loginUid: mutation.value.loginUid },
          mutation.value.profileId,
          mutation.value.updatedAtMs,
          false,
        ),
      ];
    case "update-login-owner":
      return [
        profileLinkCatchupOwnerStatement(
          db,
          { loginUid: mutation.value.loginUid },
          mutation.value.profileId,
          mutation.value.updatedAtMs,
          true,
        ),
        loginOwnerMutationStatement(db, mutation),
      ];
    case "move-login-owner-set":
      return [
        profileLinkCatchupOwnerStatement(
          db,
          { profileId: mutation.sourceProfileId },
          mutation.targetProfileId,
          mutation.updatedAtMs,
          true,
        ),
        loginOwnerMutationStatement(db, mutation),
      ];
    case "insert-active-profile":
      return [profileMutationStatement(db, mutation.value, true)];
    case "update-active-profile":
    case "patch-active-profile":
      return [
        guardStatement(
          db,
          `NOT EXISTS (
             SELECT 1 FROM profile_records
             WHERE profile_id = ? AND state = 'active'
           )`,
          [mutation.value.profile.id],
          "invariant",
        ),
        profileMutationStatement(
          db,
          mutation.value,
          false,
          mutation.kind === "patch-active-profile"
            ? mutation.current
            : undefined,
        ),
      ];
    case "retire-profile-with-redirect":
      return [
        guardStatement(
          db,
          `NOT EXISTS (
             SELECT 1 FROM profile_records
             WHERE profile_id = ? AND state = 'active'
           )`,
          [mutation.profile.profile.id],
          "invariant",
        ),
        profileMutationStatement(db, mutation.profile, false),
        mergeTargetMutationStatement(db, mutation.redirect),
      ];
    case "delete-retired-profile":
      return [
        guardStatement(
          db,
          `NOT EXISTS (
             SELECT 1 FROM profile_records
             WHERE profile_id = ? AND state = 'retiring'
               AND merged_into_profile_id = ?
           )`,
          [mutation.profileId, mutation.targetProfileId],
          "invariant",
        ),
        db
          .prepare(
            `DELETE FROM profile_records
             WHERE profile_id = ? AND state = 'retiring'
               AND merged_into_profile_id = ?`,
          )
          .bind(mutation.profileId, mutation.targetProfileId),
      ];
    case "delete-login-owner":
      return [loginOwnerMutationStatement(db, mutation)];
  }
}
