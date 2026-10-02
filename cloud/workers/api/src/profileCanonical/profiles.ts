import { MATERIAL_KEYS } from "@mons/shared/mining";
import {
  type CompletePlayerProfile,
  getProfileFallbackEmojiId,
  isPlayerProfile,
  type LeaderboardReadType,
} from "@mons/shared/profiles";
import { buildUsernameLookupKey } from "@mons/shared/usernames";
import { readD1FirstRow } from "../d1Reads.ts";
import { canonicalProfileRedirectCte } from "./redirectSql.ts";
import {
  type CanonicalSortKey,
  CanonicalProfileCorruption,
  type CanonicalControlSnapshot,
  type CanonicalControlRow,
  type CanonicalPublicProfileSnapshot,
  type PublicProfileRow,
  type CanonicalProfileSnapshot,
  type ProfileRow,
  type CanonicalMergeTarget,
  type MergeTargetRow,
  type CanonicalProfileValue,
  type JsonObject,
  type CanonicalProfileState,
  CANONICAL_PROFILE_INTERNAL_REDIRECT_LIMIT,
  CANONICAL_PROFILE_LEADERBOARD_LIMIT,
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
  profile_id, state, payload_json, gameplay_emoji_json, username_key,
  merged_into_profile_id, rating_sort, mana_points_sort, nonce_sort,
  dust_sort, slime_sort, gum_sort, metal_sort, ice_sort,
  rating_sort_present, mana_points_sort_present, nonce_sort_present,
  dust_sort_present, slime_sort_present, gum_sort_present,
  metal_sort_present, ice_sort_present, win_present, emoji_present
`;

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

export function profileWriteRow(
  value: CanonicalProfileValue,
): Omit<ProfileRow, "revision"> {
  assertCanonicalProfileValue(value);
  return {
    profile_id: value.profile.id,
    state: value.state,
    payload_json: JSON.stringify(value.profile),
    gameplay_emoji_json: JSON.stringify(value.gameplayEmoji),
    username_key: value.usernameKey,
    merged_into_profile_id: value.mergedIntoProfileId,
    legacy_fields_json: JSON.stringify(value.legacyFields),
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

export async function readCanonicalControl(
  db: D1Database,
): Promise<CanonicalControlSnapshot> {
  const row = await readD1FirstRow<CanonicalControlRow>(
    db.prepare(
      `SELECT state FROM profile_canonical_control
       WHERE singleton = 1`,
    ),
  );
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

async function resolveCanonicalProfileIteratively<
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
  if (!Number.isFinite(redirectLimit)) {
    return resolveCanonicalProfileIteratively(
      db,
      profileId,
      redirectLimit,
      onRedirectFailure,
      "*",
      parseCanonicalProfileRow,
    );
  }
  return resolveCanonicalProfileUsing(
    db,
    profileId,
    redirectLimit,
    onRedirectFailure,
    "*",
    parseCanonicalProfileRow,
  );
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
  columns: string,
  parseProfile: (value: unknown) => T,
): Promise<T | null> {
  if (!profileId.isWellFormed()) {
    return resolveCanonicalProfileIteratively(
      db,
      profileId,
      redirectLimit,
      onRedirectFailure,
      columns,
      parseProfile,
    );
  }
  if (!(redirectLimit >= 0)) {
    if (onRedirectFailure === "null") return null;
    throw new CanonicalProfileCorruption();
  }
  const { results } = await db
    .prepare(
      `${canonicalProfileRedirectCte("profile")}
       SELECT ${columns
         .split(",")
         .map((column) => `profile.${column.trim()}`)
         .join(", ")},
              chain.chain_profile_id, chain.depth AS chain_depth,
              target.source_profile_id AS redirect_source_profile_id,
              target.target_profile_id AS redirect_target_profile_id,
              target.merged_at_ms AS redirect_merged_at_ms,
              target.op_id AS redirect_op_id
       FROM chain
       LEFT JOIN profile_records profile
         ON profile.profile_id = chain.chain_profile_id
       LEFT JOIN profile_merge_targets target
         ON target.source_profile_id = chain.chain_profile_id
       ORDER BY chain.depth ASC`,
    )
    .bind(JSON.stringify([profileId]), Math.floor(redirectLimit))
    .all<Record<string, unknown>>();
  const visited = new Set<string>();
  let currentProfileId = profileId;
  for (let hop = 0; hop <= redirectLimit; hop++) {
    if (visited.has(currentProfileId)) {
      if (onRedirectFailure === "null") return null;
      throw new CanonicalProfileCorruption();
    }
    visited.add(currentProfileId);
    const row = results[hop];
    if (
      !row ||
      row.chain_depth !== hop ||
      row.chain_profile_id !== currentProfileId
    ) {
      throw new CanonicalProfileCorruption();
    }
    const profile = row.profile_id === null ? null : parseProfile(row);
    const mergeTarget =
      row.redirect_source_profile_id === null
        ? null
        : parseCanonicalMergeTargetRow({
            source_profile_id: row.redirect_source_profile_id,
            target_profile_id: row.redirect_target_profile_id,
            merged_at_ms: row.redirect_merged_at_ms,
            op_id: row.redirect_op_id,
          });
    if (!mergeTarget) {
      if (profile?.state === "retiring" || hop + 1 !== results.length) {
        throw new CanonicalProfileCorruption();
      }
      return profile;
    }
    if (
      profile?.state === "active" ||
      (profile?.mergedIntoProfileId &&
        profile.mergedIntoProfileId !== mergeTarget.targetProfileId)
    ) {
      throw new CanonicalProfileCorruption();
    }
    currentProfileId = mergeTarget.targetProfileId;
  }
  if (onRedirectFailure === "null") return null;
  throw new CanonicalProfileCorruption();
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
