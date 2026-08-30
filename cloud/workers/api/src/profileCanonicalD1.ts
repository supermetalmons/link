import { AUTH_METHODS, type AuthMethodKey } from "@mons/shared/auth";
import { MATERIAL_KEYS, type MiningMaterialName } from "@mons/shared/mining";
import {
  getProfileFallbackEmojiId,
  isPlayerProfile,
  type CompletePlayerProfile,
  type LeaderboardReadType,
} from "@mons/shared/profiles";
import { buildUsernameLookupKey } from "@mons/shared/usernames";
import { MAX_PROFILE_MERGE_TARGET_HOPS } from "../../../functions/profileMergeTargets.js";

export const CANONICAL_PROFILE_REDIRECT_LIMIT = 4;
export const CANONICAL_PROFILE_INTERNAL_REDIRECT_LIMIT =
  MAX_PROFILE_MERGE_TARGET_HOPS;
export const CANONICAL_PROFILE_LEADERBOARD_LIMIT = 99;

type JsonObject = Record<string, unknown>;
type D1Value = ArrayBuffer | null | number | string;
const UTF8_ENCODER = new TextEncoder();

export type CanonicalSortKey = "rating" | "mp" | "nonce" | MiningMaterialName;

const CANONICAL_SORT_KEYS = [
  "rating",
  "mp",
  "nonce",
  ...MATERIAL_KEYS,
] as const satisfies readonly CanonicalSortKey[];

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

type CanonicalOwnershipResolutionRow = {
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

type CanonicalOwnershipProfileRow = PublicProfileRow & {
  revision: number;
};

type CanonicalOwnershipOwnerRow = {
  owner_created_at_ms: number | null;
  owner_login_uid: string | null;
  owner_profile_id: string | null;
  owner_revision: number | null;
  owner_updated_at_ms: number | null;
};

type PublicProfileRow = {
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

type ProfileRow = PublicProfileRow & {
  created_at_ms: number;
  legacy_fields_json: string;
  merged_at_ms: number | null;
  revision: number;
  updated_at_ms: number;
};

const CANONICAL_PUBLIC_PROFILE_COLUMNS = `
  profile_id, state, payload_json, gameplay_emoji_json, username_key,
  merged_into_profile_id, rating_sort, mana_points_sort, nonce_sort,
  dust_sort, slime_sort, gum_sort, metal_sort, ice_sort,
  rating_sort_present, mana_points_sort_present, nonce_sort_present,
  dust_sort_present, slime_sort_present, gum_sort_present,
  metal_sort_present, ice_sort_present, win_present, emoji_present
`;

const CANONICAL_OWNERSHIP_PROFILE_COLUMNS = [
  ...CANONICAL_PUBLIC_PROFILE_COLUMNS.split(",").map(
    (column) => `profile.${column.trim()}`,
  ),
  "profile.revision",
].join(", ");

type CanonicalControlRow = {
  state: string;
};

type LoginOwnerRow = {
  created_at_ms: number;
  login_uid: string;
  profile_id: string;
  revision: number;
  updated_at_ms: number;
};

type AuthMethodRow = {
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

type MergeTargetRow = {
  merged_at_ms: number;
  op_id: string | null;
  source_profile_id: string;
  target_profile_id: string;
};

type RecoveryRow = {
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

type AuthOperationRow = {
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

type RatingRow = {
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

type WagerRow = {
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

function record(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function parseObjectJson(value: unknown): JsonObject {
  if (typeof value !== "string") {
    throw new CanonicalProfileCorruption();
  }
  try {
    const parsed = record(JSON.parse(value) as unknown);
    if (parsed) return parsed;
  } catch {}
  throw new CanonicalProfileCorruption();
}

function parseNullableObjectJson(value: unknown): JsonObject | null {
  return value === null ? null : parseObjectJson(value);
}

function parseStringArrayJson(value: unknown): string[] {
  if (typeof value !== "string") {
    throw new CanonicalProfileCorruption();
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      Array.isArray(parsed) &&
      parsed.every((entry) => typeof entry === "string" && entry !== "") &&
      new Set(parsed).size === parsed.length
    ) {
      return parsed;
    }
  } catch {}
  throw new CanonicalProfileCorruption();
}

function safeInteger(value: unknown, minimum = 0): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) {
    throw new CanonicalProfileCorruption();
  }
  return Number(value);
}

function nullableSafeInteger(value: unknown, minimum = 0): number | null {
  return value === null ? null : safeInteger(value, minimum);
}

function nonempty(value: unknown): string {
  if (typeof value !== "string" || value === "") {
    throw new CanonicalProfileCorruption();
  }
  return value;
}

function nullableString(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string") throw new CanonicalProfileCorruption();
  return value;
}

function authMethod(value: unknown): AuthMethodKey {
  if (
    typeof value !== "string" ||
    !(AUTH_METHODS as readonly string[]).includes(value)
  ) {
    throw new CanonicalProfileCorruption();
  }
  return value as AuthMethodKey;
}

function nullableFiniteNumber(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new CanonicalProfileCorruption();
  }
  return value;
}

function flag(value: unknown): boolean {
  if (value !== 0 && value !== 1) throw new CanonicalProfileCorruption();
  return value === 1;
}

function projectionState(value: unknown): CanonicalProjectionState | null {
  if (value === null) return null;
  if (value !== "pending" && value !== "done" && value !== "dead") {
    throw new CanonicalProfileCorruption();
  }
  return value;
}

function gameplayEmoji(value: unknown): string | number {
  if (typeof value !== "string") throw new CanonicalProfileCorruption();
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      typeof parsed === "string" ||
      (typeof parsed === "number" && Number.isFinite(parsed))
    ) {
      return parsed;
    }
  } catch {}
  throw new CanonicalProfileCorruption();
}

function canonicalPublicMaterialization(value: {
  emojiPresent: boolean;
  profile: CompletePlayerProfile;
  sortPresence: Record<CanonicalSortKey, boolean>;
  sortValues: Record<CanonicalSortKey, number | null>;
  winPresent: boolean;
}): { matchesInput: boolean; profile: CompletePlayerProfile } {
  const rawSortValue = (key: CanonicalSortKey): number | null | undefined =>
    value.sortPresence[key] ? value.sortValues[key] : undefined;
  const materials = { ...value.profile.mining.materials };
  for (const material of MATERIAL_KEYS) {
    materials[material] = rawSortValue(material) ?? 0;
  }
  const profile: CompletePlayerProfile = {
    ...value.profile,
    emoji: value.emojiPresent
      ? value.profile.emoji
      : getProfileFallbackEmojiId(value.profile.id),
    nonce: rawSortValue("nonce") ?? -1,
    rating: rawSortValue("rating") || 1500,
    totalManaPoints: rawSortValue("mp") ?? 0,
    win: value.winPresent ? value.profile.win : true,
    mining: { ...value.profile.mining, materials },
  };
  return {
    profile,
    matchesInput:
      value.profile.nonce === profile.nonce &&
      value.profile.rating === profile.rating &&
      value.profile.totalManaPoints === profile.totalManaPoints &&
      value.profile.win === profile.win &&
      value.profile.emoji === profile.emoji &&
      MATERIAL_KEYS.every(
        (material) =>
          value.profile.mining.materials[material] === materials[material],
      ),
  };
}

export function parseCanonicalControlRow(
  value: unknown,
): CanonicalControlSnapshot {
  const row = record(value) as CanonicalControlRow | null;
  if (!row) throw new CanonicalProfileCorruption();
  const state = row.state;
  if (state !== "active" && state !== "frozen") {
    throw new CanonicalProfileCorruption();
  }
  return { state };
}

export function parseCanonicalPublicProfileRow(
  value: unknown,
): CanonicalPublicProfileSnapshot {
  const row = record(value) as PublicProfileRow | null;
  if (!row) throw new CanonicalProfileCorruption();
  const payload = parseObjectJson(row.payload_json);
  const profileId = nonempty(row.profile_id);
  if (!isPlayerProfile(payload) || payload.id !== profileId) {
    throw new CanonicalProfileCorruption();
  }
  const state = row.state;
  if (state !== "active" && state !== "retiring") {
    throw new CanonicalProfileCorruption();
  }
  const usernameKey = nullableString(row.username_key);
  const expectedUsernameKey = payload.username
    ? buildUsernameLookupKey(payload.username)
    : null;
  if (usernameKey !== expectedUsernameKey) {
    throw new CanonicalProfileCorruption();
  }
  const mergedIntoProfileId = nullableString(row.merged_into_profile_id);
  if (
    (state === "active" && mergedIntoProfileId !== null) ||
    (state === "retiring" && !mergedIntoProfileId)
  ) {
    throw new CanonicalProfileCorruption();
  }
  const sortPresence = {
    rating: flag(row.rating_sort_present),
    mp: flag(row.mana_points_sort_present),
    nonce: flag(row.nonce_sort_present),
    dust: flag(row.dust_sort_present),
    slime: flag(row.slime_sort_present),
    gum: flag(row.gum_sort_present),
    metal: flag(row.metal_sort_present),
    ice: flag(row.ice_sort_present),
  } satisfies Record<CanonicalSortKey, boolean>;
  const sortValues = {
    rating: nullableFiniteNumber(row.rating_sort),
    mp: nullableFiniteNumber(row.mana_points_sort),
    nonce: nullableFiniteNumber(row.nonce_sort),
    dust: nullableFiniteNumber(row.dust_sort),
    slime: nullableFiniteNumber(row.slime_sort),
    gum: nullableFiniteNumber(row.gum_sort),
    metal: nullableFiniteNumber(row.metal_sort),
    ice: nullableFiniteNumber(row.ice_sort),
  } satisfies Record<CanonicalSortKey, number | null>;
  for (const key of Object.keys(sortPresence) as CanonicalSortKey[]) {
    if (!sortPresence[key] && sortValues[key] !== null) {
      throw new CanonicalProfileCorruption();
    }
  }
  const parsedGameplayEmoji = gameplayEmoji(row.gameplay_emoji_json);
  const winPresent = flag(row.win_present);
  const emojiPresent = flag(row.emoji_present);
  if (
    !canonicalPublicMaterialization({
      emojiPresent,
      profile: payload,
      sortPresence,
      sortValues,
      winPresent,
    }).matchesInput ||
    (emojiPresent && payload.emoji !== parsedGameplayEmoji)
  ) {
    throw new CanonicalProfileCorruption();
  }
  return {
    profileId,
    profile: payload,
    gameplayEmoji: parsedGameplayEmoji,
    state,
    usernameKey,
    mergedIntoProfileId,
    sortPresence,
    sortValues,
    winPresent,
    emojiPresent,
  };
}

export function parseCanonicalProfileRow(
  value: unknown,
): CanonicalProfileSnapshot {
  const row = record(value) as ProfileRow | null;
  if (!row) throw new CanonicalProfileCorruption();
  return {
    ...parseCanonicalPublicProfileRow(row),
    revision: safeInteger(row.revision, 1),
    legacyFields: parseObjectJson(row.legacy_fields_json),
    createdAtMs: safeInteger(row.created_at_ms),
    updatedAtMs: safeInteger(row.updated_at_ms),
    mergedAtMs: nullableSafeInteger(row.merged_at_ms),
  };
}

export function parseCanonicalLoginOwnerRow(
  value: unknown,
): CanonicalLoginOwnerSnapshot {
  const row = record(value) as LoginOwnerRow | null;
  if (!row) throw new CanonicalProfileCorruption();
  return {
    loginUid: nonempty(row.login_uid),
    profileId: nonempty(row.profile_id),
    revision: safeInteger(row.revision, 1),
    createdAtMs: safeInteger(row.created_at_ms),
    updatedAtMs: safeInteger(row.updated_at_ms),
  };
}

export function parseCanonicalAuthMethodRow(
  value: unknown,
): CanonicalAuthMethodSnapshot {
  const row = record(value) as AuthMethodRow | null;
  if (!row) throw new CanonicalProfileCorruption();
  const method = authMethod(row.method);
  if (
    (method !== "apple" && row.apple_email_masked !== null) ||
    (method !== "x" && row.x_username !== null)
  ) {
    throw new CanonicalProfileCorruption();
  }
  const consentSource = row.consent_source;
  if (
    consentSource !== null &&
    consentSource !== "signin" &&
    consentSource !== "settings"
  ) {
    throw new CanonicalProfileCorruption();
  }
  return {
    method,
    normalizedValue: nonempty(row.normalized_value),
    profileId: nonempty(row.profile_id),
    rawValue: nonempty(row.raw_value),
    appleEmailMasked: nullableString(row.apple_email_masked),
    xUsername: nullableString(row.x_username),
    linkedAtMs: nullableSafeInteger(row.linked_at_ms),
    consentAtMs: nullableSafeInteger(row.consent_at_ms),
    consentSource,
    revision: safeInteger(row.revision, 1),
    createdAtMs: safeInteger(row.created_at_ms),
    updatedAtMs: safeInteger(row.updated_at_ms),
  };
}

export function parseCanonicalMergeTargetRow(
  value: unknown,
): CanonicalMergeTarget {
  const row = record(value) as MergeTargetRow | null;
  if (!row) throw new CanonicalProfileCorruption();
  const sourceProfileId = nonempty(row.source_profile_id);
  const targetProfileId = nonempty(row.target_profile_id);
  if (sourceProfileId === targetProfileId) {
    throw new CanonicalProfileCorruption();
  }
  return {
    sourceProfileId,
    targetProfileId,
    mergedAtMs: safeInteger(row.merged_at_ms),
    opId: nullableString(row.op_id),
  };
}

export function parseCanonicalAuthOperationRow(
  value: unknown,
): CanonicalAuthOperationSnapshot {
  const row = record(value) as AuthOperationRow | null;
  if (!row) throw new CanonicalProfileCorruption();
  if (
    (row.kind !== "unlink" && row.kind !== "verify") ||
    (row.status !== "started" &&
      row.status !== "failed" &&
      row.status !== "success")
  ) {
    throw new CanonicalProfileCorruption();
  }
  return {
    operationId: nonempty(row.operation_id),
    kind: row.kind,
    method: authMethod(row.method),
    loginUid: nonempty(row.login_uid),
    status: row.status,
    meta: parseNullableObjectJson(row.meta_json),
    result: parseNullableObjectJson(row.result_json),
    errorCode: nullableString(row.error_code),
    errorMessage: nullableString(row.error_message),
    startedAtMs: safeInteger(row.started_at_ms),
    updatedAtMs: safeInteger(row.updated_at_ms),
    revision: safeInteger(row.revision, 1),
  };
}

export function parseCanonicalAuthRecoveryRow(
  value: unknown,
): CanonicalAuthRecoverySnapshot {
  const row = record(value) as RecoveryRow | null;
  if (!row) throw new CanonicalProfileCorruption();
  if (
    row.source_phase !== "prizes" &&
    row.source_phase !== "games" &&
    row.source_phase !== "finalize"
  ) {
    throw new CanonicalProfileCorruption();
  }
  return {
    profileId: nonempty(row.profile_id),
    loginUids: parseStringArrayJson(row.login_uids_json),
    sourceProfileIds: parseStringArrayJson(row.source_profile_ids_json),
    sourcePhase: row.source_phase,
    prizeCursor: nullableString(row.prize_cursor),
    phaseStartedAtMs: safeInteger(row.phase_started_at_ms),
    lastEnqueuedAtMs: safeInteger(row.last_enqueued_at_ms),
    createdAtMs: safeInteger(row.created_at_ms),
    updatedAtMs: safeInteger(row.updated_at_ms),
    revision: safeInteger(row.revision, 1),
  };
}

export function parseCanonicalRatingUpdateRow(
  value: unknown,
): CanonicalRatingUpdateSnapshot {
  const row = record(value) as RatingRow | null;
  if (row?.status !== "processing" && row?.status !== "done") {
    throw new CanonicalProfileCorruption();
  }
  return {
    operationId: nonempty(row.operation_id),
    payload: parseObjectJson(row.payload_json),
    status: row.status,
    inviteId: nonempty(row.invite_id),
    matchId: nonempty(row.match_id),
    playerId: nonempty(row.player_id),
    opponentId: nonempty(row.opponent_id),
    playerProfileId: nullableString(row.player_profile_id),
    opponentProfileId: nullableString(row.opponent_profile_id),
    ownerUid: nonempty(row.owner_uid),
    ownerToken: nonempty(row.owner_token),
    startedAtMs: safeInteger(row.started_at_ms),
    updatedAtMs: safeInteger(row.updated_at_ms),
    leaseExpiresAtMs: safeInteger(row.lease_expires_at_ms),
    completedAtMs: nullableSafeInteger(row.completed_at_ms),
    telegramProjectionState: projectionState(row.telegram_projection_state),
    telegramProjectionUpdatedAtMs: nullableSafeInteger(
      row.telegram_projection_updated_at_ms,
    ),
    telegramProjectionVersion: nullableSafeInteger(
      row.telegram_projection_version,
    ),
    profileGameProjectionState: projectionState(
      row.profile_game_projection_state,
    ),
    profileGameProjectionUpdatedAtMs: nullableSafeInteger(
      row.profile_game_projection_updated_at_ms,
    ),
    profileGameProjectionVersion: nullableSafeInteger(
      row.profile_game_projection_version,
    ),
    eventProgressState: projectionState(row.event_progress_state),
    eventProgressUpdatedAtMs: nullableSafeInteger(
      row.event_progress_updated_at_ms,
    ),
    eventProgressVersion: nullableSafeInteger(row.event_progress_version),
    revision: safeInteger(row.revision, 1),
  };
}

export function parseCanonicalWagerSettlementRow(
  value: unknown,
): CanonicalWagerSettlement {
  const row = record(value) as WagerRow | null;
  if (
    !row ||
    !(MATERIAL_KEYS as readonly string[]).includes(row.material) ||
    (row.outcome !== "applied" && row.outcome !== "insufficient-materials") ||
    row.revision !== 1
  ) {
    throw new CanonicalProfileCorruption();
  }
  return {
    operationId: nonempty(row.operation_id),
    fingerprint: nonempty(row.fingerprint),
    winnerProfileId: nonempty(row.winner_profile_id),
    loserProfileId: nonempty(row.loser_profile_id),
    material: row.material as MiningMaterialName,
    count: safeInteger(row.count, 1),
    appliedAtMs: safeInteger(row.applied_at_ms),
    outcome: row.outcome,
    revision: 1,
  };
}

function assertCanonicalProfileValue(value: CanonicalProfileValue): void {
  if (
    !isPlayerProfile(value.profile) ||
    !value.profile.id ||
    value.profile.id.includes("/") ||
    (value.state === "active" && value.mergedIntoProfileId !== null) ||
    (value.state === "retiring" && !value.mergedIntoProfileId) ||
    value.mergedIntoProfileId === value.profile.id ||
    !Number.isSafeInteger(value.createdAtMs) ||
    value.createdAtMs < 0 ||
    !Number.isSafeInteger(value.updatedAtMs) ||
    value.updatedAtMs < value.createdAtMs ||
    (value.mergedAtMs !== null &&
      (!Number.isSafeInteger(value.mergedAtMs) || value.mergedAtMs < 0)) ||
    !record(value.legacyFields) ||
    (typeof value.gameplayEmoji !== "string" &&
      (typeof value.gameplayEmoji !== "number" ||
        !Number.isFinite(value.gameplayEmoji))) ||
    typeof value.winPresent !== "boolean" ||
    typeof value.emojiPresent !== "boolean"
  ) {
    throw new TypeError("invalid-canonical-profile");
  }
  const expectedUsernameKey = value.profile.username
    ? buildUsernameLookupKey(value.profile.username)
    : null;
  if (value.usernameKey !== expectedUsernameKey) {
    throw new TypeError("invalid-canonical-username-key");
  }
  for (const key of CANONICAL_SORT_KEYS) {
    const sortValue = value.sortValues[key];
    if (
      typeof value.sortPresence[key] !== "boolean" ||
      (sortValue !== null && !Number.isFinite(sortValue)) ||
      (!value.sortPresence[key] && sortValue !== null)
    ) {
      throw new TypeError("invalid-canonical-sort");
    }
  }
  if (
    !canonicalPublicMaterialization(value).matchesInput ||
    (value.emojiPresent && value.profile.emoji !== value.gameplayEmoji)
  ) {
    throw new TypeError("invalid-canonical-public-profile");
  }
}

export function materializeCanonicalProfile(input: {
  createdAtMs: number;
  emojiPresent?: boolean;
  gameplayEmoji?: string | number;
  legacyFields?: JsonObject;
  mergedAtMs?: number | null;
  mergedIntoProfileId?: string | null;
  profile: CompletePlayerProfile;
  sortPresence?: Partial<Record<CanonicalSortKey, boolean>>;
  sortValues?: Partial<Record<CanonicalSortKey, number | null>>;
  state?: CanonicalProfileState;
  updatedAtMs: number;
  winPresent?: boolean;
}): CanonicalProfileValue {
  const derivedSortValues: Record<CanonicalSortKey, number | null> = {
    rating: input.profile.rating,
    mp: input.profile.totalManaPoints,
    nonce: input.profile.nonce,
    ...Object.fromEntries(
      MATERIAL_KEYS.map((key) => [key, input.profile.mining.materials[key]]),
    ),
  } as Record<CanonicalSortKey, number | null>;
  const sortPresence = Object.fromEntries(
    CANONICAL_SORT_KEYS.map((key) => [key, input.sortPresence?.[key] ?? true]),
  ) as Record<CanonicalSortKey, boolean>;
  const sortValues = Object.fromEntries(
    CANONICAL_SORT_KEYS.map((key) => {
      const suppliedValue = input.sortValues?.[key];
      return [
        key,
        sortPresence[key]
          ? suppliedValue === undefined
            ? derivedSortValues[key]
            : suppliedValue
          : null,
      ];
    }),
  ) as Record<CanonicalSortKey, number | null>;
  const winPresent = input.winPresent ?? true;
  const emojiPresent = input.emojiPresent ?? true;
  const profile = canonicalPublicMaterialization({
    emojiPresent,
    profile: input.profile,
    sortPresence,
    sortValues,
    winPresent,
  }).profile;
  const value: CanonicalProfileValue = {
    profile,
    gameplayEmoji: input.gameplayEmoji ?? (emojiPresent ? profile.emoji : ""),
    state: input.state || "active",
    usernameKey: profile.username
      ? buildUsernameLookupKey(profile.username)
      : null,
    mergedIntoProfileId: input.mergedIntoProfileId || null,
    legacyFields: input.legacyFields || {},
    createdAtMs: input.createdAtMs,
    updatedAtMs: input.updatedAtMs,
    mergedAtMs: input.mergedAtMs ?? null,
    sortPresence,
    sortValues,
    winPresent,
    emojiPresent,
  };
  assertCanonicalProfileValue(value);
  return value;
}

function profileValues(value: CanonicalProfileValue): D1Value[] {
  assertCanonicalProfileValue(value);
  return [
    value.profile.id,
    value.state,
    JSON.stringify(value.profile),
    JSON.stringify(value.gameplayEmoji),
    value.usernameKey,
    value.mergedIntoProfileId,
    JSON.stringify(value.legacyFields),
    value.createdAtMs,
    value.updatedAtMs,
    value.mergedAtMs,
    value.sortValues.rating,
    value.sortValues.mp,
    value.sortValues.nonce,
    value.sortValues.dust,
    value.sortValues.slime,
    value.sortValues.gum,
    value.sortValues.metal,
    value.sortValues.ice,
    Number(value.sortPresence.rating),
    Number(value.sortPresence.mp),
    Number(value.sortPresence.nonce),
    Number(value.sortPresence.dust),
    Number(value.sortPresence.slime),
    Number(value.sortPresence.gum),
    Number(value.sortPresence.metal),
    Number(value.sortPresence.ice),
    Number(value.winPresent),
    Number(value.emojiPresent),
  ];
}

export async function readCanonicalControl(
  db: D1Database,
): Promise<CanonicalControlSnapshot> {
  const row = await db
    .prepare(
      `SELECT state FROM profile_canonical_control
       WHERE singleton = 1`,
    )
    .first<CanonicalControlRow>();
  return parseCanonicalControlRow(row);
}

export async function readCanonicalProfile(
  db: D1Database,
  profileId: string,
): Promise<CanonicalProfileSnapshot | null> {
  const row = await db
    .prepare("SELECT * FROM profile_records WHERE profile_id = ?")
    .bind(profileId)
    .first<ProfileRow>();
  return row ? parseCanonicalProfileRow(row) : null;
}

export async function readCanonicalLoginOwner(
  db: D1Database,
  loginUid: string,
): Promise<CanonicalLoginOwnerSnapshot | null> {
  const row = await db
    .prepare("SELECT * FROM profile_login_owners WHERE login_uid = ?")
    .bind(loginUid)
    .first<LoginOwnerRow>();
  return row ? parseCanonicalLoginOwnerRow(row) : null;
}

export async function readCanonicalAuthMethod(
  db: D1Database,
  method: AuthMethodKey,
  normalizedValue: string,
): Promise<CanonicalAuthMethodSnapshot | null> {
  const row = await db
    .prepare(
      `SELECT * FROM profile_auth_methods
       WHERE method = ? AND normalized_value = ?`,
    )
    .bind(method, normalizedValue)
    .first<AuthMethodRow>();
  return row ? parseCanonicalAuthMethodRow(row) : null;
}

export async function readCanonicalMergeTarget(
  db: D1Database,
  sourceProfileId: string,
): Promise<CanonicalMergeTarget | null> {
  const row = await db
    .prepare(
      `SELECT source_profile_id, target_profile_id, merged_at_ms, op_id
       FROM profile_merge_targets WHERE source_profile_id = ?`,
    )
    .bind(sourceProfileId)
    .first<MergeTargetRow>();
  return row ? parseCanonicalMergeTargetRow(row) : null;
}

async function resolveCanonicalProfileUsing<
  T extends Pick<
    CanonicalPublicProfileSnapshot,
    "mergedIntoProfileId" | "state"
  >,
>(
  db: D1Database,
  profileId: string,
  redirectLimit: number,
  onRedirectFailure: "null" | "throw",
  columns: "*" | string,
  parseProfile: (value: unknown) => T,
): Promise<T | null> {
  const visited = new Set<string>();
  let currentProfileId = profileId;
  for (let hop = 0; hop <= redirectLimit; hop++) {
    if (visited.has(currentProfileId)) {
      if (onRedirectFailure === "null") return null;
      throw new CanonicalProfileCorruption();
    }
    visited.add(currentProfileId);
    const results = await db.batch([
      db
        .prepare(`SELECT ${columns} FROM profile_records WHERE profile_id = ?`)
        .bind(currentProfileId),
      db
        .prepare(
          `SELECT source_profile_id, target_profile_id, merged_at_ms, op_id
           FROM profile_merge_targets WHERE source_profile_id = ?`,
        )
        .bind(currentProfileId),
    ]);
    const profileRow = results[0].results[0];
    const mergeRow = results[1].results[0] as MergeTargetRow | undefined;
    const profile = profileRow ? parseProfile(profileRow) : null;
    const mergeTarget = mergeRow
      ? parseCanonicalMergeTargetRow(mergeRow)
      : null;
    if (!mergeTarget) {
      if (profile?.state === "retiring") {
        throw new CanonicalProfileCorruption();
      }
      return profile;
    }
    if (profile?.state === "active") {
      throw new CanonicalProfileCorruption();
    }
    if (
      profile?.mergedIntoProfileId &&
      profile.mergedIntoProfileId !== mergeTarget.targetProfileId
    ) {
      throw new CanonicalProfileCorruption();
    }
    currentProfileId = mergeTarget.targetProfileId;
  }
  if (onRedirectFailure === "null") return null;
  throw new CanonicalProfileCorruption();
}

export function resolveCanonicalProfile(
  db: D1Database,
  profileId: string,
  redirectLimit = CANONICAL_PROFILE_INTERNAL_REDIRECT_LIMIT,
  onRedirectFailure: "null" | "throw" = "throw",
): Promise<CanonicalProfileSnapshot | null> {
  return resolveCanonicalProfileUsing(
    db,
    profileId,
    redirectLimit,
    onRedirectFailure,
    "*",
    parseCanonicalProfileRow,
  );
}

export function resolveCanonicalPublicProfile(
  db: D1Database,
  profileId: string,
  redirectLimit = CANONICAL_PROFILE_INTERNAL_REDIRECT_LIMIT,
  onRedirectFailure: "null" | "throw" = "throw",
): Promise<CanonicalPublicProfileSnapshot | null> {
  return resolveCanonicalProfileUsing(
    db,
    profileId,
    redirectLimit,
    onRedirectFailure,
    CANONICAL_PUBLIC_PROFILE_COLUMNS,
    parseCanonicalPublicProfileRow,
  );
}

export async function readCanonicalProfileByLogin(
  db: D1Database,
  loginUid: string,
): Promise<CanonicalProfileSnapshot | null> {
  const owner = await readCanonicalLoginOwner(db, loginUid);
  return owner ? resolveCanonicalProfile(db, owner.profileId) : null;
}

export async function readCanonicalPublicProfileByLogin(
  db: D1Database,
  loginUid: string,
): Promise<CanonicalPublicProfileSnapshot | null> {
  const owner = await readCanonicalLoginOwner(db, loginUid);
  return owner ? resolveCanonicalPublicProfile(db, owner.profileId) : null;
}

function leaderboardColumns(type: LeaderboardReadType): {
  present: string;
  value: string;
} {
  switch (type) {
    case "rating":
      return { present: "rating_sort_present", value: "rating_sort" };
    case "mp":
      return {
        present: "mana_points_sort_present",
        value: "mana_points_sort",
      };
    case "dust":
    case "slime":
    case "gum":
    case "metal":
    case "ice":
      return { present: `${type}_sort_present`, value: `${type}_sort` };
  }
}

function withoutTutorialState(
  profile: CompletePlayerProfile,
): CompletePlayerProfile {
  const {
    completedProblemIds: _completedProblemIds,
    isTutorialCompleted: _isTutorialCompleted,
    ...publicProfile
  } = profile;
  return publicProfile;
}

export async function readCanonicalLeaderboard(
  db: D1Database,
  type: LeaderboardReadType,
  limit = CANONICAL_PROFILE_LEADERBOARD_LIMIT,
): Promise<CompletePlayerProfile[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new TypeError("invalid-canonical-leaderboard-limit");
  }
  const columns = leaderboardColumns(type);
  const rows = await db
    .prepare(
      `SELECT ${CANONICAL_PUBLIC_PROFILE_COLUMNS}
       FROM profile_records
       WHERE state = 'active' AND ${columns.present} = 1
       ORDER BY ${columns.value} DESC, profile_id DESC
       LIMIT ?`,
    )
    .bind(limit)
    .all<PublicProfileRow>();
  return rows.results.map((row) =>
    withoutTutorialState(parseCanonicalPublicProfileRow(row).profile),
  );
}

export async function readCanonicalProfileAggregate(
  db: D1Database,
  profileId: string,
): Promise<CanonicalProfileAggregateSnapshot> {
  const results = await db.batch([
    db
      .prepare("SELECT * FROM profile_records WHERE profile_id = ?")
      .bind(profileId),
    db
      .prepare(
        `SELECT * FROM profile_login_owners
         WHERE profile_id = ? ORDER BY login_uid ASC`,
      )
      .bind(profileId),
    db
      .prepare(
        `SELECT * FROM profile_auth_methods
         WHERE profile_id = ? ORDER BY method ASC`,
      )
      .bind(profileId),
    db
      .prepare(
        `SELECT opponent_profile_id FROM profile_february_opponents
         WHERE profile_id = ? ORDER BY opponent_profile_id ASC`,
      )
      .bind(profileId),
    db
      .prepare(
        `SELECT source_profile_id, target_profile_id, merged_at_ms, op_id
         FROM profile_merge_targets WHERE source_profile_id = ?`,
      )
      .bind(profileId),
    db
      .prepare("SELECT * FROM profile_auth_recovery_jobs WHERE profile_id = ?")
      .bind(profileId),
  ]);
  const profileRow = results[0].results[0] as ProfileRow | undefined;
  const mergeRow = results[4].results[0] as MergeTargetRow | undefined;
  const recoveryRow = results[5].results[0] as RecoveryRow | undefined;
  return {
    profile: profileRow ? parseCanonicalProfileRow(profileRow) : null,
    loginOwners: (results[1].results as LoginOwnerRow[]).map(
      parseCanonicalLoginOwnerRow,
    ),
    authMethods: (results[2].results as AuthMethodRow[]).map(
      parseCanonicalAuthMethodRow,
    ),
    februaryOpponentProfileIds: results[3].results.map((entry) =>
      nonempty(record(entry)?.opponent_profile_id),
    ),
    mergeTarget: mergeRow ? parseCanonicalMergeTargetRow(mergeRow) : null,
    recovery: recoveryRow ? parseCanonicalAuthRecoveryRow(recoveryRow) : null,
  };
}

function canonicalAggregateFingerprint(
  aggregate: CanonicalProfileAggregateSnapshot,
): string {
  return JSON.stringify({
    profile: aggregate.profile
      ? [
          aggregate.profile.profileId,
          aggregate.profile.revision,
          aggregate.profile.state,
          aggregate.profile.mergedIntoProfileId,
        ]
      : null,
    loginOwners: aggregate.loginOwners.map((owner) => [
      owner.loginUid,
      owner.profileId,
      owner.revision,
      owner.createdAtMs,
      owner.updatedAtMs,
    ]),
    authMethods: aggregate.authMethods.map((method) => [
      method.method,
      method.normalizedValue,
      method.profileId,
      method.revision,
    ]),
    februaryOpponentProfileIds: aggregate.februaryOpponentProfileIds,
    mergeTarget: aggregate.mergeTarget
      ? [
          aggregate.mergeTarget.sourceProfileId,
          aggregate.mergeTarget.targetProfileId,
          aggregate.mergeTarget.mergedAtMs,
        ]
      : null,
    recovery: aggregate.recovery
      ? [aggregate.recovery.profileId, aggregate.recovery.revision]
      : null,
  });
}

function assertCanonicalAggregateTopology(
  profileId: string,
  aggregate: CanonicalProfileAggregateSnapshot,
): void {
  const profile = aggregate.profile;
  if (!profile) {
    if (
      aggregate.loginOwners.length !== 0 ||
      aggregate.authMethods.length !== 0 ||
      aggregate.februaryOpponentProfileIds.length !== 0 ||
      aggregate.recovery !== null
    ) {
      throw new CanonicalProfileCorruption();
    }
    return;
  }
  if (profile.profileId !== profileId) {
    throw new CanonicalProfileCorruption();
  }
  if (profile.state === "active") {
    if (
      profile.mergedIntoProfileId !== null ||
      aggregate.mergeTarget !== null
    ) {
      throw new CanonicalProfileCorruption();
    }
    return;
  }
  if (
    !aggregate.mergeTarget ||
    aggregate.mergeTarget.sourceProfileId !== profileId ||
    aggregate.mergeTarget.targetProfileId !== profile.mergedIntoProfileId
  ) {
    throw new CanonicalProfileCorruption();
  }
}

function stableObservationLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 2 || value > 8) {
    throw new TypeError("invalid-canonical-stable-read-limit");
  }
  return value;
}

async function readStableCanonicalSnapshot<T>(options: {
  fingerprint: (value: T) => string;
  maxObservations: number;
  read: () => Promise<T>;
  validate: (value: T) => void;
}): Promise<T> {
  let previousFingerprint: string | null = null;
  let consecutiveCorruption = 0;
  for (
    let observation = 0;
    observation < stableObservationLimit(options.maxObservations);
    observation += 1
  ) {
    let value: T;
    try {
      value = await options.read();
      consecutiveCorruption = 0;
    } catch (error) {
      if (!(error instanceof CanonicalProfileCorruption)) throw error;
      previousFingerprint = null;
      consecutiveCorruption += 1;
      if (consecutiveCorruption >= 2) throw error;
      continue;
    }
    const fingerprint = options.fingerprint(value);
    if (previousFingerprint === fingerprint) {
      options.validate(value);
      return value;
    }
    previousFingerprint = fingerprint;
  }
  throw new CanonicalProfileConflict();
}

export async function readStableCanonicalProfileAggregate(
  db: D1Database,
  profileId: string,
  maxObservations = 4,
): Promise<CanonicalProfileAggregateSnapshot> {
  return readStableCanonicalSnapshot({
    read: () => readCanonicalProfileAggregate(db, profileId),
    fingerprint: canonicalAggregateFingerprint,
    validate: (aggregate) =>
      assertCanonicalAggregateTopology(profileId, aggregate),
    maxObservations,
  });
}

function canonicalOwnershipInputs(
  values: readonly string[],
  errorCode: string,
): string[] {
  if (values.some((value) => typeof value !== "string" || value === "")) {
    throw new TypeError(errorCode);
  }
  return [...new Set(values)];
}

function canonicalOwnershipResolutionStatement(
  db: D1Database,
  requestKeys: readonly string[],
  kind: "login" | "profile",
): D1PreparedStatement {
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
         LEFT JOIN profile_login_owners owner
           ON owner.login_uid = requested.request_key`
      : `SELECT
           request_index,
           request_key,
           request_key AS root_profile_id,
           NULL AS owner_revision,
           NULL AS owner_created_at_ms,
           NULL AS owner_updated_at_ms
         FROM requested`;
  return db
    .prepare(
      `WITH RECURSIVE
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
         JOIN profile_merge_targets target
           ON target.source_profile_id = chain.chain_profile_id
         WHERE chain.depth <= ?
       )
       SELECT
         roots.request_index,
         roots.request_key,
         roots.root_profile_id,
         roots.owner_revision,
         roots.owner_created_at_ms,
         roots.owner_updated_at_ms,
         chain.chain_profile_id,
         chain.depth,
         profile.revision AS profile_revision,
         profile.state AS profile_state,
         profile.merged_into_profile_id,
         target.target_profile_id AS merge_target_profile_id,
         target.merged_at_ms AS merge_target_merged_at_ms,
         target.op_id AS merge_target_op_id
       FROM roots
       LEFT JOIN chain
         ON chain.request_index = roots.request_index
       LEFT JOIN profile_records profile
         ON profile.profile_id = chain.chain_profile_id
       LEFT JOIN profile_merge_targets target
         ON target.source_profile_id = chain.chain_profile_id
       ORDER BY roots.request_index ASC, chain.depth ASC`,
    )
    .bind(
      JSON.stringify(requestKeys),
      CANONICAL_PROFILE_INTERNAL_REDIRECT_LIMIT,
    );
}

type ParsedCanonicalOwnershipResolution = Readonly<{
  owner: CanonicalLoginOwnerSnapshot | null;
  profileId: string;
}> | null;

function parseCanonicalOwnershipResolutions(
  rows: readonly CanonicalOwnershipResolutionRow[],
  requestKeys: readonly string[],
  kind: "login" | "profile",
): ParsedCanonicalOwnershipResolution[] {
  const grouped = requestKeys.map(
    () => [] as CanonicalOwnershipResolutionRow[],
  );
  for (const row of rows) {
    const requestIndex = safeInteger(row.request_index);
    if (
      requestIndex >= requestKeys.length ||
      row.request_key !== requestKeys[requestIndex]
    ) {
      throw new CanonicalProfileCorruption();
    }
    grouped[requestIndex].push(row);
  }
  return grouped.map((group, requestIndex) => {
    if (group.length === 0) throw new CanonicalProfileCorruption();
    const requestKey = requestKeys[requestIndex];
    const rootProfileId = nullableString(group[0].root_profile_id);
    if (!rootProfileId) {
      if (
        kind !== "login" ||
        group.length !== 1 ||
        group[0].owner_revision !== null ||
        group[0].owner_created_at_ms !== null ||
        group[0].owner_updated_at_ms !== null ||
        group[0].chain_profile_id !== null ||
        group[0].depth !== null
      ) {
        throw new CanonicalProfileCorruption();
      }
      return null;
    }
    const owner =
      kind === "login"
        ? parseCanonicalLoginOwnerRow({
            login_uid: requestKey,
            profile_id: rootProfileId,
            revision: group[0].owner_revision,
            created_at_ms: group[0].owner_created_at_ms,
            updated_at_ms: group[0].owner_updated_at_ms,
          })
        : null;
    if (
      kind === "profile" &&
      (group[0].owner_revision !== null ||
        group[0].owner_created_at_ms !== null ||
        group[0].owner_updated_at_ms !== null)
    ) {
      throw new CanonicalProfileCorruption();
    }
    const visited = new Set<string>();
    let canonicalProfileId: string | null = null;
    for (let index = 0; index < group.length; index += 1) {
      const row = group[index];
      if (
        row.request_key !== requestKey ||
        row.root_profile_id !== rootProfileId ||
        row.owner_revision !== group[0].owner_revision ||
        row.owner_created_at_ms !== group[0].owner_created_at_ms ||
        row.owner_updated_at_ms !== group[0].owner_updated_at_ms
      ) {
        throw new CanonicalProfileCorruption();
      }
      const depth = safeInteger(row.depth);
      const profileId = nonempty(row.chain_profile_id);
      if (
        depth !== index ||
        depth > CANONICAL_PROFILE_INTERNAL_REDIRECT_LIMIT ||
        visited.has(profileId)
      ) {
        throw new CanonicalProfileCorruption();
      }
      visited.add(profileId);
      const profileState = row.profile_state;
      const hasProfile = row.profile_revision !== null;
      if (hasProfile !== (profileState !== null)) {
        throw new CanonicalProfileCorruption();
      }
      const mergedIntoProfileId = nullableString(row.merged_into_profile_id);
      const mergeTargetProfileId = nullableString(row.merge_target_profile_id);
      if (!hasProfile) {
        if (mergedIntoProfileId !== null) {
          throw new CanonicalProfileCorruption();
        }
        if (!mergeTargetProfileId) {
          if (
            index === 0 &&
            kind === "profile" &&
            row.merge_target_merged_at_ms === null &&
            row.merge_target_op_id === null &&
            group.length === 1
          ) {
            return null;
          }
          throw new CanonicalProfileCorruption();
        }
        safeInteger(row.merge_target_merged_at_ms);
        nullableString(row.merge_target_op_id);
        if (
          index + 1 >= group.length ||
          group[index + 1].chain_profile_id !== mergeTargetProfileId
        ) {
          throw new CanonicalProfileCorruption();
        }
        continue;
      }
      if (profileState !== "active" && profileState !== "retiring") {
        throw new CanonicalProfileCorruption();
      }
      safeInteger(row.profile_revision, 1);
      if (mergeTargetProfileId) {
        safeInteger(row.merge_target_merged_at_ms);
        nullableString(row.merge_target_op_id);
        if (
          profileState !== "retiring" ||
          mergedIntoProfileId !== mergeTargetProfileId ||
          index + 1 >= group.length ||
          group[index + 1].chain_profile_id !== mergeTargetProfileId
        ) {
          throw new CanonicalProfileCorruption();
        }
        continue;
      }
      if (
        row.merge_target_merged_at_ms !== null ||
        row.merge_target_op_id !== null ||
        profileState !== "active" ||
        mergedIntoProfileId !== null ||
        index + 1 !== group.length
      ) {
        throw new CanonicalProfileCorruption();
      }
      canonicalProfileId = profileId;
    }
    if (!canonicalProfileId) throw new CanonicalProfileCorruption();
    return { owner, profileId: canonicalProfileId };
  });
}

function canonicalOwnershipTerminalsCte(): string {
  return `WITH RECURSIVE
          requested_login(request_key) AS (
            SELECT CAST(value AS TEXT) FROM json_each(?)
          ),
          requested_profile(request_key) AS (
            SELECT CAST(value AS TEXT) FROM json_each(?)
          ),
          roots(root_profile_id) AS (
            SELECT owner.profile_id
            FROM requested_login requested
            JOIN profile_login_owners owner
              ON owner.login_uid = requested.request_key
            UNION
            SELECT request_key FROM requested_profile
          ),
          chain(chain_profile_id, depth) AS (
            SELECT root_profile_id, 0 FROM roots
            UNION ALL
            SELECT target.target_profile_id, chain.depth + 1
            FROM chain
            JOIN profile_merge_targets target
              ON target.source_profile_id = chain.chain_profile_id
            WHERE chain.depth <= ?
          ),
          terminals(profile_id) AS (
            SELECT DISTINCT chain.chain_profile_id
            FROM chain
            LEFT JOIN profile_merge_targets target
              ON target.source_profile_id = chain.chain_profile_id
            WHERE target.source_profile_id IS NULL
          )`;
}

function bindCanonicalOwnershipTerminals(
  statement: D1PreparedStatement,
  loginUids: readonly string[],
  profileIds: readonly string[],
): D1PreparedStatement {
  return statement.bind(
    JSON.stringify(loginUids),
    JSON.stringify(profileIds),
    CANONICAL_PROFILE_INTERNAL_REDIRECT_LIMIT,
  );
}

function canonicalOwnershipProfilesStatement(
  db: D1Database,
  loginUids: readonly string[],
  profileIds: readonly string[],
): D1PreparedStatement {
  return bindCanonicalOwnershipTerminals(
    db.prepare(
      `${canonicalOwnershipTerminalsCte()}
       SELECT ${CANONICAL_OWNERSHIP_PROFILE_COLUMNS}
       FROM terminals
       JOIN profile_records profile ON profile.profile_id = terminals.profile_id
       ORDER BY profile.profile_id ASC`,
    ),
    loginUids,
    profileIds,
  );
}

function canonicalOwnershipOwnersStatement(
  db: D1Database,
  loginUids: readonly string[],
  profileIds: readonly string[],
): D1PreparedStatement {
  return bindCanonicalOwnershipTerminals(
    db.prepare(
      `${canonicalOwnershipTerminalsCte()}
       SELECT
         owner.login_uid AS owner_login_uid,
         owner.profile_id AS owner_profile_id,
         owner.revision AS owner_revision,
         owner.created_at_ms AS owner_created_at_ms,
         owner.updated_at_ms AS owner_updated_at_ms
       FROM terminals
       JOIN profile_login_owners owner
         ON owner.profile_id = terminals.profile_id
       ORDER BY owner.profile_id ASC, owner.login_uid ASC`,
    ),
    loginUids,
    profileIds,
  );
}

function parseCanonicalOwnershipProfiles(
  rows: readonly CanonicalOwnershipProfileRow[],
): Map<string, CanonicalProfileOwnershipProfileSnapshot> {
  const profileById = new Map<
    string,
    CanonicalProfileOwnershipProfileSnapshot
  >();
  for (const row of rows) {
    const profile = {
      ...parseCanonicalPublicProfileRow(row),
      revision: safeInteger(row.revision, 1),
    };
    if (
      profile.state !== "active" ||
      profile.mergedIntoProfileId !== null ||
      profileById.has(profile.profileId)
    ) {
      throw new CanonicalProfileCorruption();
    }
    profileById.set(profile.profileId, profile);
  }
  return profileById;
}

function parseCanonicalOwnershipOwners(
  rows: readonly CanonicalOwnershipOwnerRow[],
  profileById: ReadonlyMap<string, CanonicalProfileOwnershipProfileSnapshot>,
): {
  aggregateOwnerByUid: Map<string, CanonicalLoginOwnerSnapshot>;
  loginOwnersByProfileId: Map<string, readonly CanonicalLoginOwnerSnapshot[]>;
} {
  const mutableOwners = new Map<string, CanonicalLoginOwnerSnapshot[]>();
  for (const profileId of profileById.keys()) {
    mutableOwners.set(profileId, []);
  }
  const aggregateOwnerByUid = new Map<string, CanonicalLoginOwnerSnapshot>();
  for (const row of rows) {
    const owner = parseCanonicalLoginOwnerRow({
      login_uid: row.owner_login_uid,
      profile_id: row.owner_profile_id,
      revision: row.owner_revision,
      created_at_ms: row.owner_created_at_ms,
      updated_at_ms: row.owner_updated_at_ms,
    });
    const owners = mutableOwners.get(owner.profileId);
    if (!owners || aggregateOwnerByUid.has(owner.loginUid)) {
      throw new CanonicalProfileCorruption();
    }
    aggregateOwnerByUid.set(owner.loginUid, owner);
    owners.push(owner);
  }
  const loginOwnersByProfileId = new Map<
    string,
    readonly CanonicalLoginOwnerSnapshot[]
  >();
  for (const [profileId, owners] of mutableOwners) {
    loginOwnersByProfileId.set(profileId, Object.freeze(owners));
  }
  return { aggregateOwnerByUid, loginOwnersByProfileId };
}

export async function readCanonicalProfileOwnershipSnapshot(
  db: D1Database,
  query: CanonicalProfileOwnershipQuery,
): Promise<CanonicalProfileOwnershipSnapshot> {
  const loginUids = canonicalOwnershipInputs(
    query.loginUids,
    "invalid-canonical-login-ownership-input",
  );
  const profileIds = canonicalOwnershipInputs(
    query.profileIds,
    "invalid-canonical-profile-ownership-input",
  );
  if (loginUids.length === 0 && profileIds.length === 0) {
    return Object.freeze({
      canonicalProfileIdByProfileId: new Map(),
      loginOwnerByUid: new Map(),
      loginOwnersByProfileId: new Map(),
      profileById: new Map(),
    });
  }
  const results = await db.batch<
    | CanonicalOwnershipOwnerRow
    | CanonicalOwnershipProfileRow
    | CanonicalOwnershipResolutionRow
  >([
    canonicalOwnershipResolutionStatement(db, loginUids, "login"),
    canonicalOwnershipResolutionStatement(db, profileIds, "profile"),
    canonicalOwnershipProfilesStatement(db, loginUids, profileIds),
    canonicalOwnershipOwnersStatement(db, loginUids, profileIds),
  ]);
  const loginResolutions = parseCanonicalOwnershipResolutions(
    results[0].results as CanonicalOwnershipResolutionRow[],
    loginUids,
    "login",
  );
  const profileResolutions = parseCanonicalOwnershipResolutions(
    results[1].results as CanonicalOwnershipResolutionRow[],
    profileIds,
    "profile",
  );
  const profileById = parseCanonicalOwnershipProfiles(
    results[2].results as CanonicalOwnershipProfileRow[],
  );
  const { aggregateOwnerByUid, loginOwnersByProfileId } =
    parseCanonicalOwnershipOwners(
      results[3].results as CanonicalOwnershipOwnerRow[],
      profileById,
    );
  const canonicalProfileIds = new Set<string>();
  const loginOwnerByUid = new Map<
    string,
    Readonly<{ profileId: string; revision: number }> | null
  >();
  for (let index = 0; index < loginUids.length; index += 1) {
    const loginUid = loginUids[index];
    const resolution = loginResolutions[index];
    if (!resolution) {
      loginOwnerByUid.set(loginUid, null);
      continue;
    }
    const owner = resolution.owner;
    if (!owner || owner.profileId !== resolution.profileId) {
      throw new CanonicalProfileCorruption();
    }
    const aggregateOwner = aggregateOwnerByUid.get(loginUid);
    if (
      !aggregateOwner ||
      aggregateOwner.profileId !== resolution.profileId ||
      aggregateOwner.revision !== owner.revision
    ) {
      throw new CanonicalProfileCorruption();
    }
    canonicalProfileIds.add(resolution.profileId);
    loginOwnerByUid.set(
      loginUid,
      Object.freeze({
        profileId: resolution.profileId,
        revision: owner.revision,
      }),
    );
  }
  const canonicalProfileIdByProfileId = new Map<string, string | null>();
  for (let index = 0; index < profileIds.length; index += 1) {
    const profileId = profileIds[index];
    const resolution = profileResolutions[index];
    if (resolution?.owner) throw new CanonicalProfileCorruption();
    const canonicalProfileId = resolution?.profileId || null;
    canonicalProfileIdByProfileId.set(profileId, canonicalProfileId);
    if (canonicalProfileId) canonicalProfileIds.add(canonicalProfileId);
  }
  if (
    profileById.size !== canonicalProfileIds.size ||
    loginOwnersByProfileId.size !== canonicalProfileIds.size ||
    [...canonicalProfileIds].some(
      (profileId) =>
        !profileById.has(profileId) || !loginOwnersByProfileId.has(profileId),
    )
  ) {
    throw new CanonicalProfileCorruption();
  }
  return Object.freeze({
    canonicalProfileIdByProfileId,
    loginOwnerByUid,
    loginOwnersByProfileId,
    profileById,
  });
}

export async function readStableCanonicalProfileAggregateByLogin(
  db: D1Database,
  loginUid: string,
  maxObservations = 4,
): Promise<CanonicalResolvedProfileAggregateSnapshot | null> {
  return readStableCanonicalSnapshot({
    read: async () => {
      const owner = await readCanonicalLoginOwner(db, loginUid);
      if (!owner) return null;
      const profile = await resolveCanonicalProfile(db, owner.profileId);
      if (!profile) throw new CanonicalProfileCorruption();
      return {
        owner,
        aggregate: await readCanonicalProfileAggregate(db, profile.profileId),
      };
    },
    fingerprint: (value) =>
      value
        ? JSON.stringify([
            value.owner.loginUid,
            value.owner.profileId,
            value.owner.revision,
            canonicalAggregateFingerprint(value.aggregate),
          ])
        : "null",
    validate: (value) => {
      if (!value) return;
      const profile = value.aggregate.profile;
      if (
        !profile ||
        profile.state !== "active" ||
        value.owner.profileId !== profile.profileId
      ) {
        throw new CanonicalProfileCorruption();
      }
      assertCanonicalAggregateTopology(profile.profileId, value.aggregate);
    },
    maxObservations,
  });
}

export async function readCanonicalAuthOperation(
  db: D1Database,
  operationId: string,
): Promise<CanonicalAuthOperationSnapshot | null> {
  const row = await db
    .prepare("SELECT * FROM profile_auth_operations WHERE operation_id = ?")
    .bind(operationId)
    .first<AuthOperationRow>();
  return row ? parseCanonicalAuthOperationRow(row) : null;
}

export async function readCanonicalRatingUpdate(
  db: D1Database,
  operationId: string,
): Promise<CanonicalRatingUpdateSnapshot | null> {
  const row = await db
    .prepare("SELECT * FROM rating_updates WHERE operation_id = ?")
    .bind(operationId)
    .first<RatingRow>();
  return row ? parseCanonicalRatingUpdateRow(row) : null;
}

export async function readCanonicalWagerSettlement(
  db: D1Database,
  operationId: string,
  fingerprint?: string,
): Promise<CanonicalWagerSettlement | null> {
  const row = await db
    .prepare("SELECT * FROM wager_settlements WHERE operation_id = ?")
    .bind(operationId)
    .first<WagerRow>();
  if (!row) return null;
  const settlement = parseCanonicalWagerSettlementRow(row);
  if (fingerprint !== undefined && settlement.fingerprint !== fingerprint) {
    throw new CanonicalProfileConflict();
  }
  return settlement;
}

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

function guardStatement(
  db: D1Database,
  failurePredicate: string,
  values: D1Value[],
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO profile_transaction_guards (singleton)
       SELECT 0 WHERE ${failurePredicate}`,
    )
    .bind(...values);
}

function validateRevision(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError("invalid-canonical-revision");
  }
  return value;
}

function loginOwnerSetJson(
  profileId: string,
  owners: readonly CanonicalLoginOwnerSnapshot[],
): string {
  if (!profileId) throw new TypeError("invalid-canonical-login-owner-set");
  const sorted = [...owners].sort((left, right) => {
    const leftBytes = UTF8_ENCODER.encode(left.loginUid);
    const rightBytes = UTF8_ENCODER.encode(right.loginUid);
    const length = Math.min(leftBytes.length, rightBytes.length);
    for (let index = 0; index < length; index += 1) {
      const difference = leftBytes[index] - rightBytes[index];
      if (difference !== 0) return difference;
    }
    return leftBytes.length - rightBytes.length;
  });
  const seen = new Set<string>();
  for (const owner of sorted) {
    if (
      !owner.loginUid ||
      owner.profileId !== profileId ||
      seen.has(owner.loginUid) ||
      !Number.isSafeInteger(owner.createdAtMs) ||
      owner.createdAtMs < 0 ||
      !Number.isSafeInteger(owner.updatedAtMs) ||
      owner.updatedAtMs < owner.createdAtMs
    ) {
      throw new TypeError("invalid-canonical-login-owner-set");
    }
    validateRevision(owner.revision);
    seen.add(owner.loginUid);
  }
  return JSON.stringify(
    sorted.map((owner) => [
      owner.loginUid,
      owner.profileId,
      owner.revision,
      owner.createdAtMs,
      owner.updatedAtMs,
    ]),
  );
}

export function buildCanonicalGuardStatements(
  db: D1Database,
  expectations: readonly CanonicalExpectation[],
): D1PreparedStatement[] {
  return expectations.map((expectation) => {
    switch (expectation.kind) {
      case "profile-absent":
        return guardStatement(
          db,
          "EXISTS (SELECT 1 FROM profile_records WHERE profile_id = ?)",
          [expectation.profileId],
        );
      case "profile-revision":
        return guardStatement(
          db,
          `NOT EXISTS (
             SELECT 1 FROM profile_records
             WHERE profile_id = ? AND revision = ?
           )`,
          [expectation.profileId, validateRevision(expectation.revision)],
        );
      case "username-absent":
        return guardStatement(
          db,
          "EXISTS (SELECT 1 FROM profile_records WHERE username_key = ?)",
          [expectation.usernameKey],
        );
      case "username-owner":
        return guardStatement(
          db,
          `NOT EXISTS (
             SELECT 1 FROM profile_records
             WHERE username_key = ? AND profile_id = ? AND revision = ?
           )`,
          [
            expectation.usernameKey,
            expectation.profileId,
            validateRevision(expectation.revision),
          ],
        );
      case "login-owner-absent":
        return guardStatement(
          db,
          "EXISTS (SELECT 1 FROM profile_login_owners WHERE login_uid = ?)",
          [expectation.loginUid],
        );
      case "login-owner-revision":
        return guardStatement(
          db,
          `NOT EXISTS (
             SELECT 1 FROM profile_login_owners
             WHERE login_uid = ? AND profile_id = ? AND revision = ?
           )`,
          [
            expectation.loginUid,
            expectation.profileId,
            validateRevision(expectation.revision),
          ],
        );
      case "login-owner-set":
        return guardStatement(
          db,
          `(
             SELECT json_group_array(
               json_array(
                 login_uid, profile_id, revision, created_at_ms, updated_at_ms
               )
             )
             FROM (
               SELECT login_uid, profile_id, revision, created_at_ms,
                      updated_at_ms
               FROM profile_login_owners
               WHERE profile_id = ?
               ORDER BY login_uid ASC
             )
           ) IS NOT json(?)`,
          [
            expectation.profileId,
            loginOwnerSetJson(expectation.profileId, expectation.owners),
          ],
        );
      case "auth-method-absent":
        return guardStatement(
          db,
          `EXISTS (
             SELECT 1 FROM profile_auth_methods
             WHERE method = ? AND normalized_value = ?
           )`,
          [expectation.method, expectation.normalizedValue],
        );
      case "auth-method-revision":
        return guardStatement(
          db,
          `NOT EXISTS (
             SELECT 1 FROM profile_auth_methods
             WHERE method = ? AND normalized_value = ?
               AND profile_id = ? AND revision = ?
           )`,
          [
            expectation.method,
            expectation.normalizedValue,
            expectation.profileId,
            validateRevision(expectation.revision),
          ],
        );
      case "merge-target-absent":
        return guardStatement(
          db,
          `EXISTS (
             SELECT 1 FROM profile_merge_targets
             WHERE source_profile_id = ?
           )`,
          [expectation.sourceProfileId],
        );
      case "merge-target":
        return guardStatement(
          db,
          `NOT EXISTS (
             SELECT 1 FROM profile_merge_targets
             WHERE source_profile_id = ? AND target_profile_id = ?
           )`,
          [expectation.sourceProfileId, expectation.targetProfileId],
        );
      case "february-opponent-absent":
        return guardStatement(
          db,
          `EXISTS (
             SELECT 1 FROM profile_february_opponents
             WHERE profile_id = ? AND opponent_profile_id = ?
           )`,
          [expectation.profileId, expectation.opponentProfileId],
        );
      case "canonical-february-opponent-absent":
        return guardStatement(
          db,
          `EXISTS (
             WITH RECURSIVE opponent_chain(current_profile_id, depth) AS (
               SELECT opponent_profile_id, 0
               FROM profile_february_opponents
               WHERE profile_id = ?
               UNION ALL
               SELECT mapping.target_profile_id, opponent_chain.depth + 1
               FROM opponent_chain
               JOIN profile_merge_targets AS mapping
                 ON mapping.source_profile_id = opponent_chain.current_profile_id
               WHERE opponent_chain.depth <= ?
             )
             SELECT 1
             FROM opponent_chain
             LEFT JOIN profile_merge_targets AS mapping
               ON mapping.source_profile_id = opponent_chain.current_profile_id
             WHERE opponent_chain.depth > ?
                OR (
                  mapping.source_profile_id IS NULL
                  AND opponent_chain.current_profile_id = ?
                )
           )`,
          [
            expectation.profileId,
            CANONICAL_PROFILE_INTERNAL_REDIRECT_LIMIT,
            CANONICAL_PROFILE_INTERNAL_REDIRECT_LIMIT,
            expectation.opponentProfileId,
          ],
        );
      case "february-opponent":
        return guardStatement(
          db,
          `NOT EXISTS (
             SELECT 1 FROM profile_february_opponents
             WHERE profile_id = ? AND opponent_profile_id = ?
           )`,
          [expectation.profileId, expectation.opponentProfileId],
        );
      case "auth-operation-absent":
        return guardStatement(
          db,
          `EXISTS (
             SELECT 1 FROM profile_auth_operations WHERE operation_id = ?
           )`,
          [expectation.operationId],
        );
      case "auth-operation-revision":
        return guardStatement(
          db,
          `NOT EXISTS (
             SELECT 1 FROM profile_auth_operations
             WHERE operation_id = ? AND revision = ?
           )`,
          [expectation.operationId, validateRevision(expectation.revision)],
        );
      case "method-revocation-absent":
        return guardStatement(
          db,
          `EXISTS (
             SELECT 1 FROM profile_auth_method_revocations
             WHERE method = ? AND normalized_value = ?
           )`,
          [expectation.method, expectation.normalizedValue],
        );
      case "method-revocation-revision":
        return guardStatement(
          db,
          `NOT EXISTS (
             SELECT 1 FROM profile_auth_method_revocations
             WHERE method = ? AND normalized_value = ? AND revision = ?
           )`,
          [
            expectation.method,
            expectation.normalizedValue,
            validateRevision(expectation.revision),
          ],
        );
      case "method-cooldown-absent":
        return guardStatement(
          db,
          `EXISTS (
             SELECT 1 FROM profile_auth_method_cooldowns
             WHERE profile_id = ? AND method = ?
           )`,
          [expectation.profileId, expectation.method],
        );
      case "method-cooldown-revision":
        return guardStatement(
          db,
          `NOT EXISTS (
             SELECT 1 FROM profile_auth_method_cooldowns
             WHERE profile_id = ? AND method = ? AND revision = ?
           )`,
          [
            expectation.profileId,
            expectation.method,
            validateRevision(expectation.revision),
          ],
        );
      case "auth-recovery-absent":
        return guardStatement(
          db,
          `EXISTS (
             SELECT 1 FROM profile_auth_recovery_jobs WHERE profile_id = ?
           )`,
          [expectation.profileId],
        );
      case "auth-recovery-revision":
        return guardStatement(
          db,
          `NOT EXISTS (
             SELECT 1 FROM profile_auth_recovery_jobs
             WHERE profile_id = ? AND revision = ?
           )`,
          [expectation.profileId, validateRevision(expectation.revision)],
        );
      case "rating-update-absent":
        return guardStatement(
          db,
          "EXISTS (SELECT 1 FROM rating_updates WHERE operation_id = ?)",
          [expectation.operationId],
        );
      case "rating-update-revision":
        return guardStatement(
          db,
          `NOT EXISTS (
             SELECT 1 FROM rating_updates
             WHERE operation_id = ? AND revision = ?
           )`,
          [expectation.operationId, validateRevision(expectation.revision)],
        );
      case "wager-settlement-absent":
        return guardStatement(
          db,
          "EXISTS (SELECT 1 FROM wager_settlements WHERE operation_id = ?)",
          [expectation.operationId],
        );
      case "wager-settlement":
        return guardStatement(
          db,
          `NOT EXISTS (
             SELECT 1 FROM wager_settlements
             WHERE operation_id = ? AND fingerprint = ?
           )`,
          [expectation.operationId, expectation.fingerprint],
        );
    }
  });
}

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
  | { kind: "delete-rating-update"; operationId: string }
  | { kind: "insert-wager-settlement"; value: CanonicalWagerSettlement };

export type CanonicalCommitPlan = {
  expectations: readonly CanonicalExpectation[];
  mutations: readonly CanonicalMutation[];
};

const PROFILE_COLUMNS = `
  profile_id, state, payload_json, gameplay_emoji_json, username_key,
  merged_into_profile_id, legacy_fields_json, created_at_ms, updated_at_ms,
  merged_at_ms, rating_sort,
  mana_points_sort, nonce_sort, dust_sort, slime_sort, gum_sort, metal_sort,
  ice_sort, rating_sort_present, mana_points_sort_present,
  nonce_sort_present, dust_sort_present, slime_sort_present, gum_sort_present,
  metal_sort_present, ice_sort_present, win_present, emoji_present
`;

function profileMutationStatement(
  db: D1Database,
  value: CanonicalProfileValue,
  insert: boolean,
): D1PreparedStatement {
  const values = profileValues(value);
  if (insert) {
    return db
      .prepare(
        `INSERT INTO profile_records (${PROFILE_COLUMNS}, revision)
         VALUES (${Array.from({ length: values.length }, () => "?").join(", ")}, 1)`,
      )
      .bind(...values);
  }
  const [profileId, ...updates] = values;
  return db
    .prepare(
      `UPDATE profile_records SET
         state = ?, payload_json = ?, gameplay_emoji_json = ?, username_key = ?,
         merged_into_profile_id = ?, legacy_fields_json = ?,
         created_at_ms = ?, updated_at_ms = ?, merged_at_ms = ?,
         rating_sort = ?, mana_points_sort = ?, nonce_sort = ?, dust_sort = ?,
         slime_sort = ?, gum_sort = ?, metal_sort = ?, ice_sort = ?,
         rating_sort_present = ?, mana_points_sort_present = ?,
         nonce_sort_present = ?, dust_sort_present = ?, slime_sort_present = ?,
         gum_sort_present = ?, metal_sort_present = ?, ice_sort_present = ?,
         win_present = ?, emoji_present = ?, revision = revision + 1
       WHERE profile_id = ?`,
    )
    .bind(...updates, profileId);
}

function authMethodParams(value: CanonicalAuthMethodValue): D1Value[] {
  if (
    !AUTH_METHODS.includes(value.method) ||
    !value.normalizedValue ||
    !value.profileId ||
    !value.rawValue
  ) {
    throw new TypeError("invalid-canonical-auth-method");
  }
  return [
    value.method,
    value.normalizedValue,
    value.profileId,
    value.rawValue,
    value.appleEmailMasked,
    value.xUsername,
    value.linkedAtMs,
    value.consentAtMs,
    value.consentSource,
    value.createdAtMs,
    value.updatedAtMs,
  ];
}

function authOperationParams(value: CanonicalAuthOperationValue): D1Value[] {
  return [
    value.operationId,
    value.kind,
    value.method,
    value.loginUid,
    value.status,
    value.meta === null ? null : JSON.stringify(value.meta),
    value.result === null ? null : JSON.stringify(value.result),
    value.errorCode,
    value.errorMessage,
    value.startedAtMs,
    value.updatedAtMs,
  ];
}

function cooldownParams(value: CanonicalCooldownValue): D1Value[] {
  return [
    value.profileId,
    value.method,
    value.scope,
    value.unlinkedByUid,
    value.cooldownMs,
    value.startedAtMs,
    value.retryAtMs,
    value.updatedAtMs,
  ];
}

function recoveryParams(value: CanonicalAuthRecoveryValue): D1Value[] {
  return [
    value.profileId,
    JSON.stringify(value.loginUids),
    JSON.stringify(value.sourceProfileIds),
    value.sourcePhase,
    value.prizeCursor,
    value.phaseStartedAtMs,
    value.lastEnqueuedAtMs,
    value.createdAtMs,
    value.updatedAtMs,
  ];
}

function ratingParams(value: CanonicalRatingUpdateValue): D1Value[] {
  return [
    value.operationId,
    JSON.stringify(value.payload),
    value.status,
    value.inviteId,
    value.matchId,
    value.playerId,
    value.opponentId,
    value.playerProfileId,
    value.opponentProfileId,
    value.ownerUid,
    value.ownerToken,
    value.startedAtMs,
    value.updatedAtMs,
    value.leaseExpiresAtMs,
    value.completedAtMs,
    value.telegramProjectionState,
    value.telegramProjectionUpdatedAtMs,
    value.telegramProjectionVersion,
    value.profileGameProjectionState,
    value.profileGameProjectionUpdatedAtMs,
    value.profileGameProjectionVersion,
    value.eventProgressState,
    value.eventProgressUpdatedAtMs,
    value.eventProgressVersion,
  ];
}

const RATING_COLUMNS = `
  operation_id, payload_json, status, invite_id, match_id, player_id,
  opponent_id, player_profile_id, opponent_profile_id, owner_uid, owner_token,
  started_at_ms, updated_at_ms, lease_expires_at_ms, completed_at_ms,
  telegram_projection_state, telegram_projection_updated_at_ms,
  telegram_projection_version, profile_game_projection_state,
  profile_game_projection_updated_at_ms, profile_game_projection_version,
  event_progress_state, event_progress_updated_at_ms, event_progress_version
`;

type CanonicalLifecycleMutation = Extract<
  CanonicalMutation,
  {
    kind:
      | "insert-active-profile"
      | "update-active-profile"
      | "retire-profile-with-redirect"
      | "delete-retired-profile";
  }
>;
type CanonicalSingleMutation = Exclude<
  CanonicalMutation,
  CanonicalLifecycleMutation
>;

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

function mutationStatement(
  db: D1Database,
  mutation: CanonicalSingleMutation,
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
    case "insert-auth-method":
      return db
        .prepare(
          `INSERT INTO profile_auth_methods (
             method, normalized_value, profile_id, raw_value,
             apple_email_masked, x_username, linked_at_ms, consent_at_ms,
             consent_source, created_at_ms, updated_at_ms, revision
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        )
        .bind(...authMethodParams(mutation.value));
    case "update-auth-method": {
      const values = authMethodParams(mutation.value);
      const [method, normalizedValue, ...updates] = values;
      return db
        .prepare(
          `UPDATE profile_auth_methods SET
             profile_id = ?, raw_value = ?, apple_email_masked = ?,
             x_username = ?, linked_at_ms = ?, consent_at_ms = ?,
             consent_source = ?, created_at_ms = ?, updated_at_ms = ?,
             revision = revision + 1
           WHERE method = ? AND normalized_value = ?`,
        )
        .bind(...updates, method, normalizedValue);
    }
    case "delete-auth-method":
      return db
        .prepare(
          `DELETE FROM profile_auth_methods
           WHERE method = ? AND normalized_value = ?`,
        )
        .bind(mutation.method, mutation.normalizedValue);
    case "insert-february-opponent":
      return db
        .prepare(
          `INSERT INTO profile_february_opponents (
             profile_id, opponent_profile_id, recorded_at_ms
           ) VALUES (?, ?, ?)`,
        )
        .bind(
          mutation.profileId,
          mutation.opponentProfileId,
          mutation.recordedAtMs,
        );
    case "delete-february-opponent":
      return db
        .prepare(
          `DELETE FROM profile_february_opponents
           WHERE profile_id = ? AND opponent_profile_id = ?`,
        )
        .bind(mutation.profileId, mutation.opponentProfileId);
    case "insert-auth-operation":
      return db
        .prepare(
          `INSERT INTO profile_auth_operations (
             operation_id, kind, method, login_uid, status, meta_json,
             result_json, error_code, error_message, started_at_ms,
             updated_at_ms, revision
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        )
        .bind(...authOperationParams(mutation.value));
    case "update-auth-operation": {
      const [operationId, ...updates] = authOperationParams(mutation.value);
      return db
        .prepare(
          `UPDATE profile_auth_operations SET
             kind = ?, method = ?, login_uid = ?, status = ?, meta_json = ?,
             result_json = ?, error_code = ?, error_message = ?,
             started_at_ms = ?, updated_at_ms = ?, revision = revision + 1
           WHERE operation_id = ?`,
        )
        .bind(...updates, operationId);
    }
    case "delete-auth-operation":
      return db
        .prepare("DELETE FROM profile_auth_operations WHERE operation_id = ?")
        .bind(mutation.operationId);
    case "insert-method-revocation":
      return db
        .prepare(
          `INSERT INTO profile_auth_method_revocations (
             method, normalized_value, profile_id, scope, unlinked_by_uid,
             cooldown_ms, started_at_ms, retry_at_ms, updated_at_ms, revision
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        )
        .bind(
          mutation.value.method,
          mutation.value.normalizedValue,
          ...cooldownParams(mutation.value).filter((_, index) => index !== 1),
        );
    case "update-method-revocation":
      return db
        .prepare(
          `UPDATE profile_auth_method_revocations SET
             profile_id = ?, scope = ?, unlinked_by_uid = ?, cooldown_ms = ?,
             started_at_ms = ?, retry_at_ms = ?, updated_at_ms = ?,
             revision = revision + 1
           WHERE method = ? AND normalized_value = ?`,
        )
        .bind(
          mutation.value.profileId,
          mutation.value.scope,
          mutation.value.unlinkedByUid,
          mutation.value.cooldownMs,
          mutation.value.startedAtMs,
          mutation.value.retryAtMs,
          mutation.value.updatedAtMs,
          mutation.value.method,
          mutation.value.normalizedValue,
        );
    case "delete-method-revocation":
      return db
        .prepare(
          `DELETE FROM profile_auth_method_revocations
           WHERE method = ? AND normalized_value = ?`,
        )
        .bind(mutation.method, mutation.normalizedValue);
    case "insert-method-cooldown":
      return db
        .prepare(
          `INSERT INTO profile_auth_method_cooldowns (
             profile_id, method, scope, unlinked_by_uid, cooldown_ms,
             started_at_ms, retry_at_ms, updated_at_ms, revision
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        )
        .bind(...cooldownParams(mutation.value));
    case "update-method-cooldown": {
      const [profileId, method, ...updates] = cooldownParams(mutation.value);
      return db
        .prepare(
          `UPDATE profile_auth_method_cooldowns SET
             scope = ?, unlinked_by_uid = ?, cooldown_ms = ?,
             started_at_ms = ?, retry_at_ms = ?, updated_at_ms = ?,
             revision = revision + 1
           WHERE profile_id = ? AND method = ?`,
        )
        .bind(...updates, profileId, method);
    }
    case "delete-method-cooldown":
      return db
        .prepare(
          `DELETE FROM profile_auth_method_cooldowns
           WHERE profile_id = ? AND method = ?`,
        )
        .bind(mutation.profileId, mutation.method);
    case "insert-auth-recovery":
      return db
        .prepare(
          `INSERT INTO profile_auth_recovery_jobs (
             profile_id, login_uids_json, source_profile_ids_json,
             source_phase, prize_cursor, phase_started_at_ms,
             last_enqueued_at_ms, created_at_ms, updated_at_ms, revision
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        )
        .bind(...recoveryParams(mutation.value));
    case "update-auth-recovery": {
      const [profileId, ...updates] = recoveryParams(mutation.value);
      return db
        .prepare(
          `UPDATE profile_auth_recovery_jobs SET
             login_uids_json = ?, source_profile_ids_json = ?,
             source_phase = ?, prize_cursor = ?, phase_started_at_ms = ?,
             last_enqueued_at_ms = ?, created_at_ms = ?, updated_at_ms = ?,
             revision = revision + 1
           WHERE profile_id = ?`,
        )
        .bind(...updates, profileId);
    }
    case "delete-auth-recovery":
      return db
        .prepare("DELETE FROM profile_auth_recovery_jobs WHERE profile_id = ?")
        .bind(mutation.profileId);
    case "insert-rating-update":
      return db
        .prepare(
          `INSERT INTO rating_updates (${RATING_COLUMNS}, revision)
           VALUES (${Array.from({ length: 24 }, () => "?").join(", ")}, 1)`,
        )
        .bind(...ratingParams(mutation.value));
    case "update-rating-update": {
      const [operationId, ...updates] = ratingParams(mutation.value);
      return db
        .prepare(
          `UPDATE rating_updates SET
             payload_json = ?, status = ?, invite_id = ?, match_id = ?,
             player_id = ?, opponent_id = ?, player_profile_id = ?,
             opponent_profile_id = ?, owner_uid = ?, owner_token = ?,
             started_at_ms = ?, updated_at_ms = ?, lease_expires_at_ms = ?,
             completed_at_ms = ?, telegram_projection_state = ?,
             telegram_projection_updated_at_ms = ?,
             telegram_projection_version = ?,
             profile_game_projection_state = ?,
             profile_game_projection_updated_at_ms = ?,
             profile_game_projection_version = ?, event_progress_state = ?,
             event_progress_updated_at_ms = ?, event_progress_version = ?,
             revision = revision + 1
           WHERE operation_id = ?`,
        )
        .bind(...updates, operationId);
    }
    case "delete-rating-update":
      return db
        .prepare("DELETE FROM rating_updates WHERE operation_id = ?")
        .bind(mutation.operationId);
    case "insert-wager-settlement":
      return db
        .prepare(
          `INSERT INTO wager_settlements (
             operation_id, fingerprint, winner_profile_id, loser_profile_id,
             material, count, applied_at_ms, outcome, revision
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        )
        .bind(
          mutation.value.operationId,
          mutation.value.fingerprint,
          mutation.value.winnerProfileId,
          mutation.value.loserProfileId,
          mutation.value.material,
          mutation.value.count,
          mutation.value.appliedAtMs,
          mutation.value.outcome,
        );
  }
}

function mutationStatements(
  db: D1Database,
  mutation: CanonicalMutation,
): D1PreparedStatement[] {
  switch (mutation.kind) {
    case "insert-active-profile":
      return [profileMutationStatement(db, mutation.value, true)];
    case "update-active-profile":
      return [
        guardStatement(
          db,
          `NOT EXISTS (
             SELECT 1 FROM profile_records
             WHERE profile_id = ? AND state = 'active'
           )`,
          [mutation.value.profile.id],
        ),
        profileMutationStatement(db, mutation.value, false),
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
        ),
        db
          .prepare(
            `DELETE FROM profile_records
             WHERE profile_id = ? AND state = 'retiring'
               AND merged_into_profile_id = ?`,
          )
          .bind(mutation.profileId, mutation.targetProfileId),
      ];
    default:
      return [mutationStatement(db, mutation)];
  }
}

function isConstraintFailure(error: unknown): boolean {
  const message =
    error instanceof Error ? `${error.name}: ${error.message}` : "";
  return /constraint|profile_transaction_guards|immutable|permanent|profile merge|not active|cannot be deleted/i.test(
    message,
  );
}

function sameJsonObject(left: JsonObject, right: JsonObject): boolean {
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

function validateCanonicalCommitPlan(plan: CanonicalCommitPlan): void {
  const has = (
    predicate: (expectation: CanonicalExpectation) => boolean,
  ): boolean => plan.expectations.some(predicate);
  const requireExpectation = (covered: boolean): void => {
    if (!covered) throw new TypeError("unsafe-canonical-commit-plan");
  };
  const ownerMoveProfileIds = new Set<string>();
  for (const mutation of plan.mutations) {
    if (mutation.kind !== "move-login-owner-set") continue;
    if (
      ownerMoveProfileIds.has(mutation.sourceProfileId) ||
      ownerMoveProfileIds.has(mutation.targetProfileId)
    ) {
      throw new TypeError("unsafe-canonical-commit-plan");
    }
    ownerMoveProfileIds.add(mutation.sourceProfileId);
    ownerMoveProfileIds.add(mutation.targetProfileId);
  }
  if (
    plan.mutations.some((mutation) => {
      if (mutation.kind === "insert-login-owner") {
        return ownerMoveProfileIds.has(mutation.value.profileId);
      }
      if (
        mutation.kind !== "update-login-owner" &&
        mutation.kind !== "delete-login-owner"
      ) {
        return false;
      }
      const loginUid =
        mutation.kind === "update-login-owner"
          ? mutation.value.loginUid
          : mutation.loginUid;
      const current = plan.expectations.find(
        (expectation) =>
          expectation.kind === "login-owner-revision" &&
          expectation.loginUid === loginUid,
      );
      return (
        (mutation.kind === "update-login-owner" &&
          ownerMoveProfileIds.has(mutation.value.profileId)) ||
        (current?.kind === "login-owner-revision" &&
          ownerMoveProfileIds.has(current.profileId))
      );
    })
  ) {
    throw new TypeError("unsafe-canonical-commit-plan");
  }
  const lifecycleProfileIds = new Set<string>();
  const requireUniqueLifecycleProfile = (profileId: string): void => {
    if (!profileId || lifecycleProfileIds.has(profileId)) {
      throw new TypeError("unsafe-canonical-commit-plan");
    }
    lifecycleProfileIds.add(profileId);
  };
  for (const mutation of plan.mutations) {
    switch (mutation.kind) {
      case "insert-active-profile":
        requireUniqueLifecycleProfile(mutation.value.profile.id);
        requireExpectation(mutation.value.state === "active");
        requireExpectation(
          has(
            (expectation) =>
              expectation.kind === "profile-absent" &&
              expectation.profileId === mutation.value.profile.id,
          ),
        );
        break;
      case "update-active-profile":
        requireUniqueLifecycleProfile(mutation.value.profile.id);
        requireExpectation(mutation.value.state === "active");
        requireExpectation(
          has(
            (expectation) =>
              expectation.kind === "profile-revision" &&
              expectation.profileId === mutation.value.profile.id,
          ),
        );
        break;
      case "retire-profile-with-redirect": {
        const sourceProfileId = mutation.profile.profile.id;
        const targetProfileId = mutation.redirect.targetProfileId;
        requireUniqueLifecycleProfile(sourceProfileId);
        requireExpectation(
          mutation.profile.state === "retiring" &&
            mutation.profile.mergedIntoProfileId === targetProfileId &&
            mutation.profile.mergedAtMs !== null &&
            mutation.redirect.sourceProfileId === sourceProfileId &&
            mutation.redirect.mergedAtMs === mutation.profile.mergedAtMs &&
            sourceProfileId !== targetProfileId &&
            sameJsonObject(
              mutation.profile.legacyFields,
              mutation.redirect.sourceLegacyFields,
            ),
        );
        requireExpectation(
          has(
            (expectation) =>
              expectation.kind === "profile-revision" &&
              expectation.profileId === sourceProfileId,
          ),
        );
        requireExpectation(
          has(
            (expectation) =>
              expectation.kind === "profile-revision" &&
              expectation.profileId === targetProfileId,
          ),
        );
        requireExpectation(
          has(
            (expectation) =>
              expectation.kind === "merge-target-absent" &&
              expectation.sourceProfileId === sourceProfileId,
          ),
        );
        break;
      }
      case "delete-retired-profile":
        requireUniqueLifecycleProfile(mutation.profileId);
        requireExpectation(
          mutation.profileId !== "" &&
            mutation.targetProfileId !== "" &&
            mutation.profileId !== mutation.targetProfileId,
        );
        requireExpectation(
          has(
            (expectation) =>
              expectation.kind === "profile-revision" &&
              expectation.profileId === mutation.profileId,
          ),
        );
        requireExpectation(
          has(
            (expectation) =>
              expectation.kind === "merge-target" &&
              expectation.sourceProfileId === mutation.profileId &&
              expectation.targetProfileId === mutation.targetProfileId,
          ),
        );
        break;
      case "insert-login-owner":
        requireExpectation(
          has(
            (expectation) =>
              expectation.kind === "login-owner-absent" &&
              expectation.loginUid === mutation.value.loginUid,
          ),
        );
        break;
      case "update-login-owner":
      case "delete-login-owner": {
        const loginUid =
          mutation.kind === "update-login-owner"
            ? mutation.value.loginUid
            : mutation.loginUid;
        requireExpectation(
          has(
            (expectation) =>
              expectation.kind === "login-owner-revision" &&
              expectation.loginUid === loginUid,
          ),
        );
        break;
      }
      case "move-login-owner-set": {
        const sourceExpectation = plan.expectations.find(
          (candidate) =>
            candidate.kind === "login-owner-set" &&
            candidate.profileId === mutation.sourceProfileId,
        );
        const targetExpectation = plan.expectations.find(
          (candidate) =>
            candidate.kind === "login-owner-set" &&
            candidate.profileId === mutation.targetProfileId,
        );
        requireExpectation(
          sourceExpectation !== undefined && targetExpectation !== undefined,
        );
        if (
          !mutation.sourceProfileId ||
          !mutation.targetProfileId ||
          mutation.sourceProfileId === mutation.targetProfileId ||
          !Number.isSafeInteger(mutation.updatedAtMs) ||
          mutation.updatedAtMs < 0 ||
          (sourceExpectation?.kind === "login-owner-set" &&
            sourceExpectation.owners.some(
              (owner) => owner.createdAtMs > mutation.updatedAtMs,
            ))
        ) {
          throw new TypeError("invalid-canonical-login-owner-move");
        }
        break;
      }
      case "insert-auth-method":
        requireExpectation(
          has(
            (expectation) =>
              expectation.kind === "auth-method-absent" &&
              expectation.method === mutation.value.method &&
              expectation.normalizedValue === mutation.value.normalizedValue,
          ),
        );
        break;
      case "update-auth-method":
      case "delete-auth-method": {
        const method =
          mutation.kind === "update-auth-method"
            ? mutation.value.method
            : mutation.method;
        const normalizedValue =
          mutation.kind === "update-auth-method"
            ? mutation.value.normalizedValue
            : mutation.normalizedValue;
        requireExpectation(
          has(
            (expectation) =>
              expectation.kind === "auth-method-revision" &&
              expectation.method === method &&
              expectation.normalizedValue === normalizedValue,
          ),
        );
        break;
      }
      case "insert-february-opponent":
        requireExpectation(
          has(
            (expectation) =>
              expectation.kind === "february-opponent-absent" &&
              expectation.profileId === mutation.profileId &&
              expectation.opponentProfileId === mutation.opponentProfileId,
          ),
        );
        break;
      case "delete-february-opponent":
        requireExpectation(
          has(
            (expectation) =>
              expectation.kind === "february-opponent" &&
              expectation.profileId === mutation.profileId &&
              expectation.opponentProfileId === mutation.opponentProfileId,
          ),
        );
        break;
      case "insert-auth-operation":
        requireExpectation(
          has(
            (expectation) =>
              expectation.kind === "auth-operation-absent" &&
              expectation.operationId === mutation.value.operationId,
          ),
        );
        break;
      case "update-auth-operation":
      case "delete-auth-operation": {
        const operationId =
          mutation.kind === "update-auth-operation"
            ? mutation.value.operationId
            : mutation.operationId;
        requireExpectation(
          has(
            (expectation) =>
              expectation.kind === "auth-operation-revision" &&
              expectation.operationId === operationId,
          ),
        );
        break;
      }
      case "insert-method-revocation":
        requireExpectation(
          has(
            (expectation) =>
              expectation.kind === "method-revocation-absent" &&
              expectation.method === mutation.value.method &&
              expectation.normalizedValue === mutation.value.normalizedValue,
          ),
        );
        break;
      case "update-method-revocation":
      case "delete-method-revocation": {
        const method =
          mutation.kind === "update-method-revocation"
            ? mutation.value.method
            : mutation.method;
        const normalizedValue =
          mutation.kind === "update-method-revocation"
            ? mutation.value.normalizedValue
            : mutation.normalizedValue;
        requireExpectation(
          has(
            (expectation) =>
              expectation.kind === "method-revocation-revision" &&
              expectation.method === method &&
              expectation.normalizedValue === normalizedValue,
          ),
        );
        break;
      }
      case "insert-method-cooldown":
        requireExpectation(
          has(
            (expectation) =>
              expectation.kind === "method-cooldown-absent" &&
              expectation.profileId === mutation.value.profileId &&
              expectation.method === mutation.value.method,
          ),
        );
        break;
      case "update-method-cooldown":
      case "delete-method-cooldown": {
        const profileId =
          mutation.kind === "update-method-cooldown"
            ? mutation.value.profileId
            : mutation.profileId;
        const method =
          mutation.kind === "update-method-cooldown"
            ? mutation.value.method
            : mutation.method;
        requireExpectation(
          has(
            (expectation) =>
              expectation.kind === "method-cooldown-revision" &&
              expectation.profileId === profileId &&
              expectation.method === method,
          ),
        );
        break;
      }
      case "insert-auth-recovery":
        requireExpectation(
          has(
            (expectation) =>
              expectation.kind === "auth-recovery-absent" &&
              expectation.profileId === mutation.value.profileId,
          ),
        );
        break;
      case "update-auth-recovery":
      case "delete-auth-recovery": {
        const profileId =
          mutation.kind === "update-auth-recovery"
            ? mutation.value.profileId
            : mutation.profileId;
        requireExpectation(
          has(
            (expectation) =>
              expectation.kind === "auth-recovery-revision" &&
              expectation.profileId === profileId,
          ),
        );
        break;
      }
      case "insert-rating-update":
        requireExpectation(
          has(
            (expectation) =>
              expectation.kind === "rating-update-absent" &&
              expectation.operationId === mutation.value.operationId,
          ),
        );
        break;
      case "update-rating-update":
      case "delete-rating-update": {
        const operationId =
          mutation.kind === "update-rating-update"
            ? mutation.value.operationId
            : mutation.operationId;
        requireExpectation(
          has(
            (expectation) =>
              expectation.kind === "rating-update-revision" &&
              expectation.operationId === operationId,
          ),
        );
        break;
      }
      case "insert-wager-settlement":
        requireExpectation(
          has(
            (expectation) =>
              expectation.kind === "wager-settlement-absent" &&
              expectation.operationId === mutation.value.operationId,
          ),
        );
        break;
    }
  }
}

export function countCanonicalCommitStatements(
  plan: CanonicalCommitPlan,
): number {
  return plan.mutations.length === 0
    ? 0
    : 2 +
        plan.expectations.length +
        plan.mutations.reduce((count, mutation) => {
          switch (mutation.kind) {
            case "update-active-profile":
            case "delete-retired-profile":
              return count + 2;
            case "retire-profile-with-redirect":
              return count + 3;
            default:
              return count + 1;
          }
        }, 0);
}

function canonicalTopologyGuardStatement(db: D1Database): D1PreparedStatement {
  return guardStatement(
    db,
    `EXISTS (
       SELECT 1
       FROM profile_records AS profile
       WHERE profile.state = 'retiring'
         AND NOT EXISTS (
           SELECT 1
           FROM profile_merge_targets AS mapping
           WHERE mapping.source_profile_id = profile.profile_id
             AND mapping.target_profile_id = profile.merged_into_profile_id
         )
     )
     OR EXISTS (
       SELECT 1
       FROM profile_records AS profile
       JOIN profile_merge_targets AS mapping
         ON mapping.source_profile_id = profile.profile_id
       WHERE profile.state = 'active'
     )
     OR EXISTS (
       SELECT 1
       FROM profile_login_owners AS owner
       LEFT JOIN profile_records AS profile
         ON profile.profile_id = owner.profile_id
        AND profile.state = 'active'
       WHERE profile.profile_id IS NULL
     )
     OR EXISTS (
       SELECT 1
       FROM profile_auth_methods AS method
       LEFT JOIN profile_records AS profile
         ON profile.profile_id = method.profile_id
        AND profile.state = 'active'
       WHERE profile.profile_id IS NULL
     )
     OR EXISTS (
       SELECT 1
       FROM profile_auth_recovery_jobs AS recovery
       LEFT JOIN profile_records AS profile
         ON profile.profile_id = recovery.profile_id
        AND profile.state = 'active'
       WHERE profile.profile_id IS NULL
     )`,
    [],
  );
}

export async function commitCanonicalPlan(
  db: D1Database,
  plan: CanonicalCommitPlan,
): Promise<void> {
  validateCanonicalCommitPlan(plan);
  if (plan.mutations.length === 0) return;
  const statements = [
    guardStatement(
      db,
      `NOT EXISTS (
         SELECT 1 FROM profile_canonical_control
         WHERE singleton = 1 AND state = 'active'
       )`,
      [],
    ),
    ...buildCanonicalGuardStatements(db, plan.expectations),
    ...plan.mutations.flatMap((mutation) => mutationStatements(db, mutation)),
    canonicalTopologyGuardStatement(db),
  ];
  try {
    await db.batch(statements);
  } catch (error) {
    if (isConstraintFailure(error)) {
      throw new CanonicalProfileConflict({ cause: error });
    }
    throw error;
  }
}
