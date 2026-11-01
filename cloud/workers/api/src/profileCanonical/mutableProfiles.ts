import {
  assertCanonicalProfileFields,
  CANONICAL_PUBLIC_PROFILE_COLUMNS,
  parseCanonicalProfileRow,
} from "./profiles.ts";
import {
  type CanonicalMutableProfileSnapshot,
  type CanonicalMutableProfileValue,
  type CanonicalProfileFieldsValue,
} from "./types.ts";

const MUTABLE_VALUE_FIELDS = new Set([
  "profile",
  "gameplayEmoji",
  "usernameKey",
  "updatedAtMs",
  "sortPresence",
  "sortValues",
  "winPresent",
  "emojiPresent",
]);

export function mutableProfileColumns(alias?: "profile"): string {
  const prefix = alias ? `${alias}.` : "";
  return [
    ...CANONICAL_PUBLIC_PROFILE_COLUMNS.split(",").map(
      (column) => `${prefix}${column.trim()}`,
    ),
    ...["revision", "created_at_ms", "updated_at_ms", "merged_at_ms"].map(
      (column) => `${prefix}${column}`,
    ),
  ].join(", ");
}

export function parseMutableProfileRow(
  value: unknown,
): CanonicalMutableProfileSnapshot {
  return parseCanonicalProfileRow(value);
}

export function mutableProfileValue(
  value: CanonicalProfileFieldsValue,
): CanonicalMutableProfileValue {
  return {
    profile: value.profile,
    gameplayEmoji: value.gameplayEmoji,
    usernameKey: value.usernameKey,
    updatedAtMs: value.updatedAtMs,
    sortPresence: value.sortPresence,
    sortValues: value.sortValues,
    winPresent: value.winPresent,
    emojiPresent: value.emojiPresent,
  };
}

export function assertMutableProfileValue(
  value: CanonicalMutableProfileValue,
): void {
  if (Object.keys(value).some((key) => !MUTABLE_VALUE_FIELDS.has(key))) {
    throw new TypeError("unsafe-canonical-profile-field-patch");
  }
}

export function mutableProfileWriteRow(value: CanonicalProfileFieldsValue) {
  assertCanonicalProfileFields(value);
  return {
    schema_version: 1,
    profile_id: value.profile.id,
    payload_json: JSON.stringify(value.profile),
    gameplay_emoji: value.gameplayEmoji,
    username_key: value.usernameKey,
    updated_at_ms: value.updatedAtMs,
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
