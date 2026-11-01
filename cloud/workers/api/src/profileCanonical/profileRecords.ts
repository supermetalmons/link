import {
  parseStoredPlayerProfile,
  parseStoredGameplayEmoji,
  type StoredPlayerProfile,
} from "./contracts.ts";
import { isEmojiId, type EmojiId } from "@mons/shared/appearance";
import { MATERIAL_KEYS } from "@mons/shared/mining";
import { getProfileFallbackEmojiId } from "@mons/shared/profiles";
import { buildUsernameLookupKey } from "@mons/shared/usernames";
import {
  CanonicalProfileCorruption,
  type CanonicalSortKey,
  type CanonicalControlSnapshot,
  type CanonicalControlRow,
  type CanonicalPublicProfileSnapshot,
  type PublicProfileRow,
  type CanonicalProfileSnapshot,
  type ProfileRow,
  type CanonicalMergeTarget,
  type MergeTargetRow,
  type CanonicalProfileValue,
  type CanonicalProfileFieldsValue,
  type CanonicalProfileState,
} from "./types.ts";
import {
  record,
  parseObjectJson,
  nonempty,
  nullableString,
  flag,
  nullableFiniteNumber,
  safeInteger,
  nullableSafeInteger,
} from "./validation.ts";

const CANONICAL_SORT_KEYS = [
  "rating",
  "mp",
  "nonce",
  ...MATERIAL_KEYS,
] as const satisfies readonly CanonicalSortKey[];

export const CANONICAL_PUBLIC_PROFILE_COLUMNS = `
  schema_version, profile_id, state, payload_json, gameplay_emoji, username_key,
  merged_into_profile_id, rating_sort, mana_points_sort, nonce_sort,
  dust_sort, slime_sort, gum_sort, metal_sort, ice_sort,
  rating_sort_present, mana_points_sort_present, nonce_sort_present,
  dust_sort_present, slime_sort_present, gum_sort_present,
  metal_sort_present, ice_sort_present, win_present, emoji_present
`;

function canonicalPublicMaterialization(value: {
  emojiPresent: boolean;
  profile: StoredPlayerProfile;
  sortPresence: Record<CanonicalSortKey, boolean>;
  sortValues: Record<CanonicalSortKey, number | null>;
  winPresent: boolean;
}): { matchesInput: boolean; profile: StoredPlayerProfile } {
  const rawSortValue = (key: CanonicalSortKey): number | null | undefined =>
    value.sortPresence[key] ? value.sortValues[key] : undefined;
  const materials = { ...value.profile.mining.materials };
  for (const material of MATERIAL_KEYS) {
    materials[material] = rawSortValue(material) ?? 0;
  }
  const profile: StoredPlayerProfile = {
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
  if (row.schema_version !== 1) throw new CanonicalProfileCorruption();
  const payload = parseStoredPlayerProfile(parseObjectJson(row.payload_json));
  const profileId = nonempty(row.profile_id);
  if (payload.id !== profileId) {
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
    (state === "retiring" && !mergedIntoProfileId) ||
    mergedIntoProfileId === profileId
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
  const parsedGameplayEmoji = parseStoredGameplayEmoji(row.gameplay_emoji);
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
  const snapshot: CanonicalProfileSnapshot = {
    ...parseCanonicalPublicProfileRow(row),
    revision: safeInteger(row.revision, 1),
    createdAtMs: safeInteger(row.created_at_ms),
    updatedAtMs: safeInteger(row.updated_at_ms),
    mergedAtMs: nullableSafeInteger(row.merged_at_ms),
  };
  if (
    snapshot.updatedAtMs < snapshot.createdAtMs ||
    (snapshot.state === "retiring" && snapshot.mergedAtMs === null)
  )
    throw new CanonicalProfileCorruption();
  return snapshot;
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

function assertProfileFields(value: CanonicalProfileFieldsValue): void {
  parseStoredPlayerProfile(value.profile);
  if (
    (value.state !== "active" && value.state !== "retiring") ||
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
    !isEmojiId(value.gameplayEmoji) ||
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

function assertCanonicalProfileValue(value: CanonicalProfileValue): void {
  assertProfileFields(value);
}

export function assertCanonicalProfileFields(
  value: CanonicalProfileFieldsValue,
): void {
  assertProfileFields(value);
}

type ProfileMaterializationInput = {
  createdAtMs: number;
  emojiPresent?: boolean;
  gameplayEmoji?: EmojiId;
  mergedAtMs?: number | null;
  mergedIntoProfileId?: string | null;
  profile: StoredPlayerProfile;
  sortPresence?: Partial<Record<CanonicalSortKey, boolean>>;
  sortValues?: Partial<Record<CanonicalSortKey, number | null>>;
  state?: CanonicalProfileState;
  updatedAtMs: number;
  winPresent?: boolean;
};

function materializeProfileFields(
  input: ProfileMaterializationInput,
): CanonicalProfileFieldsValue {
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
  return {
    profile,
    gameplayEmoji: input.gameplayEmoji ?? profile.emoji,
    state: input.state || "active",
    usernameKey: profile.username
      ? buildUsernameLookupKey(profile.username)
      : null,
    mergedIntoProfileId: input.mergedIntoProfileId || null,
    createdAtMs: input.createdAtMs,
    updatedAtMs: input.updatedAtMs,
    mergedAtMs: input.mergedAtMs ?? null,
    sortPresence,
    sortValues,
    winPresent,
    emojiPresent,
  };
}

export function materializeCanonicalProfileFields(
  input: ProfileMaterializationInput,
): CanonicalProfileFieldsValue {
  const value = materializeProfileFields(input);
  assertCanonicalProfileFields(value);
  return value;
}

export function materializeCanonicalProfile(
  input: ProfileMaterializationInput,
): CanonicalProfileValue {
  const value = materializeProfileFields(input);
  assertCanonicalProfileValue(value);
  return value;
}

export function profileWriteRow(
  value: CanonicalProfileValue,
): Omit<ProfileRow, "revision"> {
  assertCanonicalProfileValue(value);
  return {
    schema_version: 1,
    profile_id: value.profile.id,
    state: value.state,
    payload_json: JSON.stringify(value.profile),
    gameplay_emoji: value.gameplayEmoji,
    username_key: value.usernameKey,
    merged_into_profile_id: value.mergedIntoProfileId,
    created_at_ms: value.createdAtMs,
    updated_at_ms: value.updatedAtMs,
    merged_at_ms: value.mergedAtMs,
    rating_sort: value.sortValues.rating,
    mana_points_sort: value.sortValues.mp,
    nonce_sort: value.sortValues.nonce,
    dust_sort: value.sortValues.dust,
    slime_sort: value.sortValues.slime,
    gum_sort: value.sortValues.gum,
    metal_sort: value.sortValues.metal,
    ice_sort: value.sortValues.ice,
    rating_sort_present: Number(value.sortPresence.rating),
    mana_points_sort_present: Number(value.sortPresence.mp),
    nonce_sort_present: Number(value.sortPresence.nonce),
    dust_sort_present: Number(value.sortPresence.dust),
    slime_sort_present: Number(value.sortPresence.slime),
    gum_sort_present: Number(value.sortPresence.gum),
    metal_sort_present: Number(value.sortPresence.metal),
    ice_sort_present: Number(value.sortPresence.ice),
    win_present: Number(value.winPresent),
    emoji_present: Number(value.emojiPresent),
  };
}
