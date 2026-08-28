import {
  MATERIAL_KEYS,
  normalizeMiningSnapshot,
  type MiningMaterialName,
} from "@mons/shared/mining";
import {
  getProfileFallbackEmojiId,
  isPlayerProfile,
  type CompletePlayerProfile,
} from "@mons/shared/profiles";

export type FirestoreUpdateVersion = {
  nanos: number;
  seconds: number;
};

export class ProfileProjectionValidationError extends TypeError {}

export type ProfileProjection = {
  digest: string;
  logins: string[];
  mergedIntoProfileId: string | null;
  profile: CompletePlayerProfile;
  sortValues: Record<"rating" | "mp" | MiningMaterialName, number | null>;
  sourceVersion: FirestoreUpdateVersion;
};

type ProfileProjectionInput = {
  fields: Record<string, unknown>;
  profileId: string;
  updateTime: string;
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function boolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function sortNumber(
  fields: Record<string, unknown>,
  field: string,
): number | null {
  if (!Object.hasOwn(fields, field)) {
    return null;
  }
  const value = number(fields[field]);
  if (value === undefined) {
    throw new ProfileProjectionValidationError("invalid-profile-sort-field");
  }
  return value;
}

function stringArray(value: unknown): string[] | undefined {
  if (
    !Array.isArray(value) ||
    !value.every((entry) => typeof entry === "string")
  ) {
    return undefined;
  }
  return value;
}

function profileProjectionLogins(fields: Record<string, unknown>): string[] {
  if (!Object.hasOwn(fields, "logins")) {
    return [];
  }
  const logins = stringArray(fields.logins);
  if (!logins || logins.some((login) => !login)) {
    throw new ProfileProjectionValidationError("invalid-profile-logins");
  }
  return Array.from(new Set(logins)).sort();
}

function assignOptional<K extends keyof CompletePlayerProfile>(
  target: CompletePlayerProfile,
  key: K,
  value: CompletePlayerProfile[K] | undefined,
): void {
  if (value !== undefined) {
    target[key] = value;
  }
}

export function parseFirestoreUpdateTime(
  value: string,
): FirestoreUpdateVersion {
  const match = value.match(
    /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/,
  );
  if (!match) {
    throw new ProfileProjectionValidationError(
      "invalid-profile-source-update-time",
    );
  }
  const millis = Date.parse(`${match[1]}Z`);
  if (!Number.isFinite(millis)) {
    throw new ProfileProjectionValidationError(
      "invalid-profile-source-update-time",
    );
  }
  return {
    seconds: Math.floor(millis / 1_000),
    nanos: Number((match[2] || "").padEnd(9, "0")),
  };
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  const object = record(value);
  if (!object) {
    return value;
  }
  return Object.fromEntries(
    Object.keys(object)
      .sort()
      .map((key) => [key, canonicalize(object[key])]),
  );
}

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export async function profileProjectionDigest(input: {
  logins: string[];
  mergedIntoProfileId: string | null;
  profile: CompletePlayerProfile;
  sortValues: ProfileProjection["sortValues"];
}): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(canonicalize(input)));
  return hex(await crypto.subtle.digest("SHA-256", bytes));
}

export async function createProfileProjection({
  fields,
  profileId,
  updateTime,
}: ProfileProjectionInput): Promise<ProfileProjection> {
  if (!profileId || profileId.includes("/")) {
    throw new ProfileProjectionValidationError("invalid-profile-id");
  }
  const custom = record(fields.custom) || {};
  const mining = record(fields.mining) || {};
  const materials = record(mining.materials) || {};
  const emoji = string(custom.emoji) ?? number(custom.emoji);
  const normalizedMining = normalizeMiningSnapshot({
    lastRockDate: string(mining.lastRockDate) ?? null,
    materials: Object.fromEntries(
      MATERIAL_KEYS.map((key) => [key, number(materials[key]) ?? 0]),
    ),
  });
  const profile: CompletePlayerProfile = {
    id: profileId,
    nonce: number(fields.nonce) ?? -1,
    rating: number(fields.rating) || 1500,
    totalManaPoints: number(fields.totalManaPoints) ?? 0,
    win: boolean(fields.win) ?? true,
    emoji: emoji ?? getProfileFallbackEmojiId(profileId),
    username: string(fields.username) || null,
    eth: string(fields.eth) || null,
    sol: string(fields.sol) || null,
    feb2026UniqueOpponentsCount:
      number(fields.feb2026UniqueOpponentsCount) ?? 0,
    mining: normalizedMining,
  };
  assignOptional(profile, "aura", string(custom.aura));
  assignOptional(profile, "cardBackgroundId", number(custom.cardBackgroundId));
  assignOptional(profile, "cardSubtitleId", number(custom.cardSubtitleId));
  assignOptional(profile, "profileCounter", string(custom.profileCounter));
  assignOptional(profile, "profileMons", string(custom.profileMons));
  assignOptional(profile, "cardStickers", string(custom.cardStickers));
  assignOptional(
    profile,
    "completedProblemIds",
    stringArray(custom.completedProblems),
  );
  assignOptional(
    profile,
    "isTutorialCompleted",
    boolean(custom.tutorialCompleted),
  );
  if (!isPlayerProfile(profile)) {
    throw new ProfileProjectionValidationError("invalid-profile-projection");
  }
  const logins = profileProjectionLogins(fields);
  const mergedIntoProfileId =
    string(fields.mergedIntoProfileId)?.trim() || null;
  const sortValues: ProfileProjection["sortValues"] = {
    rating: sortNumber(fields, "rating"),
    mp: sortNumber(fields, "totalManaPoints"),
    ...Object.fromEntries(
      MATERIAL_KEYS.map((key) => [key, sortNumber(materials, key)]),
    ),
  } as ProfileProjection["sortValues"];
  const digestInput = { profile, logins, mergedIntoProfileId, sortValues };
  return {
    ...digestInput,
    digest: await profileProjectionDigest(digestInput),
    sourceVersion: parseFirestoreUpdateTime(updateTime),
  };
}

export function profileWithoutTutorialState(
  profile: CompletePlayerProfile,
): CompletePlayerProfile {
  const {
    completedProblemIds: _completed,
    isTutorialCompleted: _tutorial,
    ...rest
  } = profile;
  return rest;
}
