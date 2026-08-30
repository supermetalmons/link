import { AuthApiFailure } from "./authErrors.ts";

export type ProfileOwnershipQuery = Readonly<{
  loginUids: readonly string[];
  profileIds: readonly string[];
}>;

export type ProfileOwnershipLogin = Readonly<{
  profileId: string;
  revision: number;
}>;

export type ProfileOwnershipProfile = Readonly<{
  aura: string;
  emoji: number | string;
  eth: string;
  profileId: string;
  rating: number;
  sol: string;
  username: string;
}>;

export type ProfileOwnershipProfileSnapshot = Readonly<{
  profile: ProfileOwnershipProfile;
  revision: number;
}>;

export type ProfileOwnershipSnapshot = Readonly<{
  canonicalProfileIdByProfileId: ReadonlyMap<string, string | null>;
  loginOwnerByUid: ReadonlyMap<string, ProfileOwnershipLogin | null>;
  loginUidsByProfileId: ReadonlyMap<string, readonly string[]>;
  profileById: ReadonlyMap<string, ProfileOwnershipProfileSnapshot>;
}>;

export type ProfileOwnershipReader = {
  readProfileOwnershipSnapshot(
    query: ProfileOwnershipQuery,
  ): Promise<ProfileOwnershipSnapshot>;
};

export function profileOwnershipUnavailable(): AuthApiFailure {
  return new AuthApiFailure(
    503,
    "unavailable",
    "profile-ownership-unavailable",
  );
}

function identifiers(values: readonly string[]): string[] {
  if (values.some((value) => typeof value !== "string" || value === "")) {
    throw new TypeError("invalid-profile-ownership-query");
  }
  return [...new Set(values)];
}

function hasExactKeys<T>(
  values: ReadonlyMap<string, T>,
  keys: ReadonlySet<string>,
): boolean {
  return values.size === keys.size && [...keys].every((key) => values.has(key));
}

function isRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function isProfile(value: ProfileOwnershipProfile, profileId: string): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    value.profileId === profileId &&
    typeof value.aura === "string" &&
    (typeof value.emoji === "string" ||
      (typeof value.emoji === "number" && Number.isFinite(value.emoji))) &&
    typeof value.eth === "string" &&
    typeof value.rating === "number" &&
    Number.isFinite(value.rating) &&
    typeof value.sol === "string" &&
    typeof value.username === "string"
  );
}

function assertProfileOwnershipSnapshot(
  snapshot: ProfileOwnershipSnapshot,
  query: ProfileOwnershipQuery,
): void {
  if (
    !(snapshot?.loginOwnerByUid instanceof Map) ||
    !(snapshot.canonicalProfileIdByProfileId instanceof Map) ||
    !(snapshot.profileById instanceof Map) ||
    !(snapshot.loginUidsByProfileId instanceof Map)
  ) {
    throw new TypeError("invalid-profile-ownership-snapshot");
  }
  const loginUids = new Set(query.loginUids);
  const profileIds = new Set(query.profileIds);
  if (
    !hasExactKeys(snapshot.loginOwnerByUid, loginUids) ||
    !hasExactKeys(snapshot.canonicalProfileIdByProfileId, profileIds)
  ) {
    throw new TypeError("invalid-profile-ownership-snapshot");
  }
  const canonicalProfileIds = new Set<string>();
  for (const loginUid of loginUids) {
    const owner = snapshot.loginOwnerByUid.get(loginUid);
    if (owner === null) continue;
    if (
      !owner ||
      typeof owner.profileId !== "string" ||
      owner.profileId === "" ||
      !isRevision(owner.revision)
    ) {
      throw new TypeError("invalid-profile-ownership-snapshot");
    }
    canonicalProfileIds.add(owner.profileId);
  }
  for (const profileId of profileIds) {
    const canonicalProfileId =
      snapshot.canonicalProfileIdByProfileId.get(profileId);
    if (canonicalProfileId === null) continue;
    if (typeof canonicalProfileId !== "string" || canonicalProfileId === "") {
      throw new TypeError("invalid-profile-ownership-snapshot");
    }
    canonicalProfileIds.add(canonicalProfileId);
  }
  if (
    !hasExactKeys(snapshot.profileById, canonicalProfileIds) ||
    !hasExactKeys(snapshot.loginUidsByProfileId, canonicalProfileIds)
  ) {
    throw new TypeError("invalid-profile-ownership-snapshot");
  }
  const ownerProfileIdByUid = new Map<string, string>();
  for (const profileId of canonicalProfileIds) {
    const profile = snapshot.profileById.get(profileId);
    const ownedLoginUids = snapshot.loginUidsByProfileId.get(profileId);
    if (
      !profile ||
      !isRevision(profile.revision) ||
      !isProfile(profile.profile, profileId) ||
      !Array.isArray(ownedLoginUids) ||
      new Set(ownedLoginUids).size !== ownedLoginUids.length ||
      ownedLoginUids.some(
        (loginUid) =>
          typeof loginUid !== "string" ||
          loginUid === "" ||
          ownerProfileIdByUid.has(loginUid),
      )
    ) {
      throw new TypeError("invalid-profile-ownership-snapshot");
    }
    for (const loginUid of ownedLoginUids) {
      ownerProfileIdByUid.set(loginUid, profileId);
    }
  }
  for (const loginUid of loginUids) {
    const owner = snapshot.loginOwnerByUid.get(loginUid);
    if (owner && ownerProfileIdByUid.get(loginUid) !== owner.profileId) {
      throw new TypeError("invalid-profile-ownership-snapshot");
    }
  }
}

export async function requireProfileOwnershipSnapshot(
  reader: ProfileOwnershipReader,
  query: ProfileOwnershipQuery,
): Promise<ProfileOwnershipSnapshot> {
  try {
    const normalizedQuery = Object.freeze({
      loginUids: Object.freeze(identifiers(query.loginUids)),
      profileIds: Object.freeze(identifiers(query.profileIds)),
    });
    const snapshot = await reader.readProfileOwnershipSnapshot(normalizedQuery);
    assertProfileOwnershipSnapshot(snapshot, normalizedQuery);
    return snapshot;
  } catch {
    throw profileOwnershipUnavailable();
  }
}

export function getLoginProfileId(
  snapshot: ProfileOwnershipSnapshot,
  loginUid: string,
): string | null {
  if (!snapshot.loginOwnerByUid.has(loginUid)) {
    throw new TypeError("profile-ownership-login-not-requested");
  }
  return snapshot.loginOwnerByUid.get(loginUid)?.profileId || null;
}

export function getCanonicalProfileId(
  snapshot: ProfileOwnershipSnapshot,
  profileId: string,
): string | null {
  if (!snapshot.canonicalProfileIdByProfileId.has(profileId)) {
    throw new TypeError("profile-ownership-profile-not-requested");
  }
  return snapshot.canonicalProfileIdByProfileId.get(profileId) || null;
}

export function getOwnershipProfile(
  snapshot: ProfileOwnershipSnapshot,
  profileId: string,
): ProfileOwnershipProfileSnapshot | null {
  return snapshot.profileById.get(profileId) || null;
}

export function getProfileLoginUids(
  snapshot: ProfileOwnershipSnapshot,
  profileId: string,
): readonly string[] {
  return snapshot.loginUidsByProfileId.get(profileId) || [];
}

export function loginsShareProfile(
  snapshot: ProfileOwnershipSnapshot,
  firstUid: string,
  secondUid: string,
): boolean {
  if (firstUid === secondUid) return true;
  const firstProfileId = getLoginProfileId(snapshot, firstUid);
  return Boolean(
    firstProfileId && firstProfileId === getLoginProfileId(snapshot, secondUid),
  );
}

export function profilesShareCanonicalProfile(
  snapshot: ProfileOwnershipSnapshot,
  firstProfileId: string,
  secondProfileId: string,
): boolean {
  if (firstProfileId === secondProfileId) return true;
  const firstCanonicalProfileId = getCanonicalProfileId(
    snapshot,
    firstProfileId,
  );
  return Boolean(
    firstCanonicalProfileId &&
    firstCanonicalProfileId ===
      getCanonicalProfileId(snapshot, secondProfileId),
  );
}

export function loginOwnsProfile(
  snapshot: ProfileOwnershipSnapshot,
  loginUid: string,
  profileId: string,
): boolean {
  const loginProfileId = getLoginProfileId(snapshot, loginUid);
  return Boolean(
    loginProfileId &&
    loginProfileId === getCanonicalProfileId(snapshot, profileId),
  );
}
