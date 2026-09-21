import { MAX_PROFILE_MERGE_TARGET_HOPS } from "../../../../runtime/profileMergeTargets.js";
import { type MiningMaterialName } from "@mons/shared/mining";
import { type CompletePlayerProfile } from "@mons/shared/profiles";
import { type AuthMethodKey } from "@mons/shared/auth";

export const CANONICAL_PROFILE_REDIRECT_LIMIT = 4;

export const CANONICAL_PROFILE_INTERNAL_REDIRECT_LIMIT =
  MAX_PROFILE_MERGE_TARGET_HOPS;

export const CANONICAL_PROFILE_LEADERBOARD_LIMIT = 99;

export type JsonObject = Record<string, unknown>;

export type D1Value = ArrayBuffer | null | number | string;

export type CanonicalSortKey = "rating" | "mp" | "nonce" | MiningMaterialName;

export type CanonicalProfileState = "active" | "retiring";

export type CanonicalControlState = "frozen" | "active";

export type CanonicalControlSnapshot = {
  state: CanonicalControlState;
};

export class CanonicalProfileConflict extends Error {
  constructor(options?: ErrorOptions) {
    super("canonical-profile-conflict", options);
  }
}

export class CanonicalProfileCorruption extends Error {
  constructor(options?: ErrorOptions) {
    super("canonical-profile-corruption", options);
  }
}

export type CanonicalProfileValue = {
  createdAtMs: number;
  emojiPresent: boolean;
  gameplayEmoji: string | number;
  legacyFields: JsonObject;
  mergedAtMs: number | null;
  mergedIntoProfileId: string | null;
  profile: CompletePlayerProfile;
  sortPresence: Record<CanonicalSortKey, boolean>;
  sortValues: Record<CanonicalSortKey, number | null>;
  state: CanonicalProfileState;
  updatedAtMs: number;
  usernameKey: string | null;
  winPresent: boolean;
};

export type CanonicalProfileSnapshot = CanonicalProfileValue & {
  profileId: string;
  revision: number;
};

export type CanonicalPublicProfileSnapshot = {
  emojiPresent: boolean;
  gameplayEmoji: string | number;
  mergedIntoProfileId: string | null;
  profile: CompletePlayerProfile;
  profileId: string;
  sortPresence: Record<CanonicalSortKey, boolean>;
  sortValues: Record<CanonicalSortKey, number | null>;
  state: CanonicalProfileState;
  usernameKey: string | null;
  winPresent: boolean;
};

export type CanonicalLoginOwnerSnapshot = {
  createdAtMs: number;
  loginUid: string;
  profileId: string;
  revision: number;
  updatedAtMs: number;
};

export type CanonicalAuthMethodValue = {
  appleEmailMasked: string | null;
  consentAtMs: number | null;
  consentSource: "settings" | "signin" | null;
  createdAtMs: number;
  linkedAtMs: number | null;
  method: AuthMethodKey;
  normalizedValue: string;
  profileId: string;
  rawValue: string;
  updatedAtMs: number;
  xUsername: string | null;
};

export type CanonicalAuthMethodSnapshot = CanonicalAuthMethodValue & {
  revision: number;
};

export type CanonicalMergeTarget = {
  mergedAtMs: number;
  opId: string | null;
  sourceProfileId: string;
  targetProfileId: string;
};

export type CanonicalMergeTargetValue = CanonicalMergeTarget & {
  sourceLegacyFields: JsonObject;
};

export type CanonicalAuthOperationValue = {
  errorCode: string | null;
  errorMessage: string | null;
  kind: "unlink" | "verify";
  loginUid: string;
  meta: JsonObject | null;
  method: AuthMethodKey;
  operationId: string;
  result: JsonObject | null;
  startedAtMs: number;
  status: "failed" | "started" | "success";
  updatedAtMs: number;
};

export type CanonicalAuthOperationSnapshot = CanonicalAuthOperationValue & {
  revision: number;
};

export type CanonicalCooldownValue = {
  cooldownMs: number;
  method: AuthMethodKey;
  profileId: string;
  retryAtMs: number;
  scope: string;
  startedAtMs: number;
  unlinkedByUid: string;
  updatedAtMs: number;
};

export type CanonicalCooldownSnapshot = CanonicalCooldownValue & {
  normalizedValue?: string;
  revision: number;
};

export type CanonicalAuthRecoveryValue = {
  createdAtMs: number;
  lastEnqueuedAtMs: number;
  loginUids: string[];
  phaseStartedAtMs: number;
  prizeCursor: string | null;
  profileId: string;
  sourcePhase: "finalize" | "games" | "prizes";
  sourceProfileIds: string[];
  updatedAtMs: number;
};

export type CanonicalAuthRecoverySnapshot = CanonicalAuthRecoveryValue & {
  revision: number;
};

export type CanonicalProjectionState = "dead" | "done" | "pending";

export type CanonicalRatingUpdateValue = {
  completedAtMs: number | null;
  eventProgressState: CanonicalProjectionState | null;
  eventProgressUpdatedAtMs: number | null;
  eventProgressVersion: number | null;
  inviteId: string;
  leaseExpiresAtMs: number;
  matchId: string;
  operationId: string;
  opponentId: string;
  opponentProfileId: string | null;
  ownerToken: string;
  ownerUid: string;
  payload: JsonObject;
  playerId: string;
  playerProfileId: string | null;
  profileGameProjectionState: CanonicalProjectionState | null;
  profileGameProjectionUpdatedAtMs: number | null;
  profileGameProjectionVersion: number | null;
  startedAtMs: number;
  status: "done" | "processing";
  telegramProjectionState: CanonicalProjectionState | null;
  telegramProjectionUpdatedAtMs: number | null;
  telegramProjectionVersion: number | null;
  updatedAtMs: number;
};

export type CanonicalRatingUpdateSnapshot = CanonicalRatingUpdateValue & {
  revision: number;
};

export type CanonicalRatingProjectionKind =
  "event-progress" | "profile-game" | "telegram";

export type CanonicalWagerSettlement = {
  appliedAtMs: number;
  count: number;
  fingerprint: string;
  loserProfileId: string;
  material: MiningMaterialName;
  operationId: string;
  outcome: "applied" | "insufficient-materials";
  revision: 1;
  winnerProfileId: string;
};

export type CanonicalProfileAggregateSnapshot = {
  authMethods: CanonicalAuthMethodSnapshot[];
  februaryOpponentProfileIds: string[];
  loginOwners: CanonicalLoginOwnerSnapshot[];
  mergeTarget: CanonicalMergeTarget | null;
  profile: CanonicalProfileSnapshot | null;
  recovery: CanonicalAuthRecoverySnapshot | null;
};

export type CanonicalResolvedProfileAggregateSnapshot = {
  aggregate: CanonicalProfileAggregateSnapshot;
  owner: CanonicalLoginOwnerSnapshot;
};

export type CanonicalProfileOwnershipQuery = Readonly<{
  loginUids: readonly string[];
  profileIds: readonly string[];
}>;

export type CanonicalProfileOwnershipProfileSnapshot =
  CanonicalPublicProfileSnapshot & {
    revision: number;
  };

export type CanonicalProfileOwnershipSnapshot = Readonly<{
  canonicalProfileIdByProfileId: ReadonlyMap<string, string | null>;
  loginOwnerByUid: ReadonlyMap<
    string,
    Readonly<{
      profileId: string;
      revision: number;
    }> | null
  >;
  loginOwnersByProfileId: ReadonlyMap<
    string,
    readonly CanonicalLoginOwnerSnapshot[]
  >;
  profileById: ReadonlyMap<string, CanonicalProfileOwnershipProfileSnapshot>;
}>;

export type CanonicalOwnershipResolutionRow = {
  chain_profile_id: string | null;
  depth: number | null;
  merge_target_merged_at_ms: number | null;
  merge_target_op_id: string | null;
  merge_target_profile_id: string | null;
  merged_into_profile_id: string | null;
  owner_created_at_ms: number | null;
  owner_revision: number | null;
  owner_updated_at_ms: number | null;
  profile_revision: number | null;
  profile_state: string | null;
  request_index: number;
  request_key: string;
  root_profile_id: string | null;
};

export type CanonicalOwnershipProfileRow = PublicProfileRow & {
  revision: number;
};

export type CanonicalOwnershipOwnerRow = {
  owner_created_at_ms: number | null;
  owner_login_uid: string | null;
  owner_profile_id: string | null;
  owner_revision: number | null;
  owner_updated_at_ms: number | null;
};

export type PublicProfileRow = {
  dust_sort: number | null;
  dust_sort_present: number;
  emoji_present: number;
  gameplay_emoji_json: string;
  gum_sort: number | null;
  gum_sort_present: number;
  ice_sort: number | null;
  ice_sort_present: number;
  mana_points_sort: number | null;
  mana_points_sort_present: number;
  merged_into_profile_id: string | null;
  metal_sort: number | null;
  metal_sort_present: number;
  nonce_sort: number | null;
  nonce_sort_present: number;
  payload_json: string;
  profile_id: string;
  rating_sort: number | null;
  rating_sort_present: number;
  slime_sort: number | null;
  slime_sort_present: number;
  state: string;
  username_key: string | null;
  win_present: number;
};

export type ProfileRow = PublicProfileRow & {
  created_at_ms: number;
  legacy_fields_json: string;
  merged_at_ms: number | null;
  revision: number;
  updated_at_ms: number;
};

export type CanonicalControlRow = {
  state: string;
};

export type LoginOwnerRow = {
  created_at_ms: number;
  login_uid: string;
  profile_id: string;
  revision: number;
  updated_at_ms: number;
};

export type AuthMethodRow = {
  apple_email_masked: string | null;
  consent_at_ms: number | null;
  consent_source: string | null;
  created_at_ms: number;
  linked_at_ms: number | null;
  method: string;
  normalized_value: string;
  profile_id: string;
  raw_value: string;
  revision: number;
  updated_at_ms: number;
  x_username: string | null;
};

export type MergeTargetRow = {
  merged_at_ms: number;
  op_id: string | null;
  source_profile_id: string;
  target_profile_id: string;
};

export type RecoveryRow = {
  created_at_ms: number;
  last_enqueued_at_ms: number;
  login_uids_json: string;
  phase_started_at_ms: number;
  prize_cursor: string | null;
  profile_id: string;
  revision: number;
  source_phase: string;
  source_profile_ids_json: string;
  updated_at_ms: number;
};

export type AuthOperationRow = {
  error_code: string | null;
  error_message: string | null;
  kind: string;
  login_uid: string;
  meta_json: string | null;
  method: string;
  operation_id: string;
  result_json: string | null;
  revision: number;
  started_at_ms: number;
  status: string;
  updated_at_ms: number;
};

export type RatingRow = {
  completed_at_ms: number | null;
  event_progress_state: string | null;
  event_progress_updated_at_ms: number | null;
  event_progress_version: number | null;
  invite_id: string;
  lease_expires_at_ms: number;
  match_id: string;
  operation_id: string;
  opponent_id: string;
  opponent_profile_id: string | null;
  owner_token: string;
  owner_uid: string;
  payload_json: string;
  player_id: string;
  player_profile_id: string | null;
  profile_game_projection_state: string | null;
  profile_game_projection_updated_at_ms: number | null;
  profile_game_projection_version: number | null;
  revision: number;
  started_at_ms: number;
  status: string;
  telegram_projection_state: string | null;
  telegram_projection_updated_at_ms: number | null;
  telegram_projection_version: number | null;
  updated_at_ms: number;
};

export type WagerRow = {
  applied_at_ms: number;
  count: number;
  fingerprint: string;
  loser_profile_id: string;
  material: string;
  operation_id: string;
  outcome: string;
  revision: number;
  winner_profile_id: string;
};

export type ParsedCanonicalOwnershipResolution = Readonly<{
  owner: CanonicalLoginOwnerSnapshot | null;
  profileId: string;
}> | null;

export type CanonicalExpectation =
  | { kind: "profile-absent"; profileId: string }
  | { kind: "profile-revision"; profileId: string; revision: number }
  | { kind: "username-absent"; usernameKey: string }
  | {
      kind: "username-owner";
      profileId: string;
      revision: number;
      usernameKey: string;
    }
  | { kind: "login-owner-absent"; loginUid: string }
  | {
      kind: "login-owner-revision";
      loginUid: string;
      profileId: string;
      revision: number;
    }
  | {
      kind: "login-owner-set";
      owners: readonly CanonicalLoginOwnerSnapshot[];
      profileId: string;
    }
  | {
      kind: "auth-method-absent";
      method: AuthMethodKey;
      normalizedValue: string;
    }
  | {
      kind: "auth-method-revision";
      method: AuthMethodKey;
      normalizedValue: string;
      profileId: string;
      revision: number;
    }
  | { kind: "merge-target-absent"; sourceProfileId: string }
  | {
      kind: "merge-target";
      sourceProfileId: string;
      targetProfileId: string;
    }
  | {
      kind: "february-opponent-absent";
      opponentProfileId: string;
      profileId: string;
    }
  | {
      kind: "canonical-february-opponent-absent";
      opponentProfileId: string;
      profileId: string;
    }
  | {
      kind: "february-opponent";
      opponentProfileId: string;
      profileId: string;
    }
  | { kind: "auth-operation-absent"; operationId: string }
  | {
      kind: "auth-operation-revision";
      operationId: string;
      revision: number;
    }
  | {
      kind: "method-revocation-absent";
      method: AuthMethodKey;
      normalizedValue: string;
    }
  | {
      kind: "method-revocation-revision";
      method: AuthMethodKey;
      normalizedValue: string;
      revision: number;
    }
  | {
      kind: "method-cooldown-absent";
      method: AuthMethodKey;
      profileId: string;
    }
  | {
      kind: "method-cooldown-revision";
      method: AuthMethodKey;
      profileId: string;
      revision: number;
    }
  | { kind: "auth-recovery-absent"; profileId: string }
  | {
      kind: "auth-recovery-revision";
      profileId: string;
      revision: number;
    }
  | { kind: "rating-update-absent"; operationId: string }
  | {
      kind: "rating-update-revision";
      operationId: string;
      revision: number;
    }
  | { kind: "wager-settlement-absent"; operationId: string }
  | {
      fingerprint: string;
      kind: "wager-settlement";
      operationId: string;
    };

export type CanonicalMethodRevocationValue = CanonicalCooldownValue & {
  normalizedValue: string;
};

export type CanonicalLoginOwnerValue = Omit<
  CanonicalLoginOwnerSnapshot,
  "revision"
>;

export type CanonicalMutation =
  | { kind: "insert-active-profile"; value: CanonicalProfileValue }
  | { kind: "update-active-profile"; value: CanonicalProfileValue }
  | {
      kind: "patch-active-profile";
      current: CanonicalProfileSnapshot;
      value: CanonicalProfileValue;
    }
  | {
      kind: "retire-profile-with-redirect";
      profile: CanonicalProfileValue;
      redirect: CanonicalMergeTargetValue;
    }
  | {
      kind: "delete-retired-profile";
      profileId: string;
      targetProfileId: string;
    }
  | { kind: "insert-login-owner"; value: CanonicalLoginOwnerValue }
  | { kind: "update-login-owner"; value: CanonicalLoginOwnerValue }
  | {
      kind: "move-login-owner-set";
      sourceProfileId: string;
      targetProfileId: string;
      updatedAtMs: number;
    }
  | { kind: "delete-login-owner"; loginUid: string }
  | { kind: "insert-auth-method"; value: CanonicalAuthMethodValue }
  | { kind: "update-auth-method"; value: CanonicalAuthMethodValue }
  | {
      kind: "delete-auth-method";
      method: AuthMethodKey;
      normalizedValue: string;
    }
  | {
      kind: "insert-february-opponent";
      opponentProfileId: string;
      profileId: string;
      recordedAtMs: number;
    }
  | {
      kind: "delete-february-opponent";
      opponentProfileId: string;
      profileId: string;
    }
  | { kind: "insert-auth-operation"; value: CanonicalAuthOperationValue }
  | { kind: "update-auth-operation"; value: CanonicalAuthOperationValue }
  | { kind: "delete-auth-operation"; operationId: string }
  | {
      kind: "insert-method-revocation";
      value: CanonicalMethodRevocationValue;
    }
  | {
      kind: "update-method-revocation";
      value: CanonicalMethodRevocationValue;
    }
  | {
      kind: "delete-method-revocation";
      method: AuthMethodKey;
      normalizedValue: string;
    }
  | { kind: "insert-method-cooldown"; value: CanonicalCooldownValue }
  | { kind: "update-method-cooldown"; value: CanonicalCooldownValue }
  | {
      kind: "delete-method-cooldown";
      method: AuthMethodKey;
      profileId: string;
    }
  | { kind: "insert-auth-recovery"; value: CanonicalAuthRecoveryValue }
  | { kind: "update-auth-recovery"; value: CanonicalAuthRecoveryValue }
  | { kind: "delete-auth-recovery"; profileId: string }
  | { kind: "insert-rating-update"; value: CanonicalRatingUpdateValue }
  | { kind: "update-rating-update"; value: CanonicalRatingUpdateValue }
  | {
      kind: "update-rating-projection";
      projection: CanonicalRatingProjectionKind;
      value: CanonicalRatingUpdateValue;
    }
  | { kind: "delete-rating-update"; operationId: string }
  | { kind: "insert-wager-settlement"; value: CanonicalWagerSettlement };

export type CanonicalCommitPlan = {
  expectations: readonly CanonicalExpectation[];
  mutations: readonly CanonicalMutation[];
};

type CanonicalLifecycleMutation = Extract<
  CanonicalMutation,
  {
    kind:
      | "insert-active-profile"
      | "update-active-profile"
      | "patch-active-profile"
      | "retire-profile-with-redirect"
      | "delete-retired-profile";
  }
>;

export type CanonicalSingleMutation = Exclude<
  CanonicalMutation,
  CanonicalLifecycleMutation
>;
