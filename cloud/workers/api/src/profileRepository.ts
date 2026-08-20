import { MATERIAL_KEYS, normalizeMiningSnapshot } from "@mons/shared/mining";
import {
  getProfileFallbackEmojiId,
  type CompletePlayerProfile,
  type LeaderboardReadType,
} from "@mons/shared/profiles";
import { cancelResponseBody, readBoundedJsonValue } from "./boundedStreams.ts";

const FIRESTORE_PROJECT_ID = "mons-link";
const FIRESTORE_DATABASE_ID = "(default)";
const FIRESTORE_DOCUMENTS_ROOT = `https://firestore.googleapis.com/v1/projects/${FIRESTORE_PROJECT_ID}/databases/${FIRESTORE_DATABASE_ID}/documents`;
const FIRESTORE_TIMEOUT_MS = 5_000;
const MAX_PROFILE_RESPONSE_BODY_BYTES = 4 * 1024 * 1024;
const PROFILE_MERGE_REDIRECT_LIMIT = 4;
const LEADERBOARD_ENTRY_LIMIT = 99;

const BASE_PROFILE_FIELDS = [
  "custom.aura",
  "custom.emoji",
  "eth",
  "feb2026UniqueOpponentsCount",
  "mining",
  "nonce",
  "rating",
  "sol",
  "totalManaPoints",
  "username",
  "win",
] as const;

const PROFILE_CARD_FIELDS = [
  "custom.cardBackgroundId",
  "custom.cardStickers",
  "custom.cardSubtitleId",
  "custom.profileCounter",
  "custom.profileMons",
] as const;

const LEADERBOARD_PROFILE_FIELDS = [
  ...BASE_PROFILE_FIELDS,
  ...PROFILE_CARD_FIELDS,
] as const;

const PROFILE_LOOKUP_FIELDS = [
  ...LEADERBOARD_PROFILE_FIELDS,
  "custom.completedProblems",
  "custom.tutorialCompleted",
  "mergedIntoProfileId",
] as const;

export class ProfileRepositoryFailure extends Error {
  constructor() {
    super("profile-repository-unavailable");
  }
}

export type ProfileRepository = {
  getProfileById: (
    profileId: string,
    firebaseIdToken: string,
  ) => Promise<CompletePlayerProfile | null>;
  getProfileByLoginId: (
    loginId: string,
    firebaseIdToken: string,
  ) => Promise<CompletePlayerProfile | null>;
  readLeaderboard: (
    type: LeaderboardReadType,
    firebaseIdToken: string,
  ) => Promise<CompletePlayerProfile[]>;
};

type ProfileRepositoryDependencies = {
  fetcher?: typeof fetch;
  timeoutMs?: number;
};

type ParsedProfileDocument = {
  mergedIntoProfileId: string | null;
  profile: CompletePlayerProfile;
};

function toRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(value: unknown): string | undefined {
  const encoded = toRecord(value);
  return typeof encoded?.stringValue === "string"
    ? encoded.stringValue
    : undefined;
}

function readNumber(value: unknown): number | undefined {
  const encoded = toRecord(value);
  const raw = encoded?.integerValue ?? encoded?.doubleValue;
  const parsed =
    typeof raw === "string" || typeof raw === "number" ? Number(raw) : NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  const encoded = toRecord(value);
  return typeof encoded?.booleanValue === "boolean"
    ? encoded.booleanValue
    : undefined;
}

function readMapFields(value: unknown): Record<string, unknown> {
  const encoded = toRecord(value);
  const mapValue = toRecord(encoded?.mapValue);
  return toRecord(mapValue?.fields) || {};
}

function readStringArray(value: unknown): string[] | undefined {
  const encoded = toRecord(value);
  const arrayValue = toRecord(encoded?.arrayValue);
  if (!arrayValue) {
    return undefined;
  }
  if (arrayValue.values === undefined) {
    return [];
  }
  if (!Array.isArray(arrayValue.values)) {
    return undefined;
  }
  const strings = arrayValue.values.map(readString);
  return strings.every((item): item is string => item !== undefined)
    ? strings
    : undefined;
}

function readEmoji(value: unknown): number | string | undefined {
  return readString(value) ?? readNumber(value);
}

function profileIdFromDocumentName(name: unknown): string {
  if (typeof name !== "string") {
    throw new ProfileRepositoryFailure();
  }
  const profileId = name.split("/").pop()?.trim() || "";
  if (!profileId) {
    throw new ProfileRepositoryFailure();
  }
  return profileId;
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

export function parseProfileDocument(
  value: unknown,
  includeTutorialState: boolean,
): ParsedProfileDocument {
  const document = toRecord(value);
  if (!document) {
    throw new ProfileRepositoryFailure();
  }
  const profileId = profileIdFromDocumentName(document.name);
  const fields = toRecord(document.fields) || {};
  const customFields = readMapFields(fields.custom);
  const miningFields = readMapFields(fields.mining);
  const materialFields = readMapFields(miningFields.materials);
  const materials = Object.fromEntries(
    MATERIAL_KEYS.map((key) => [key, readNumber(materialFields[key]) ?? 0]),
  );
  const profile: CompletePlayerProfile = {
    id: profileId,
    nonce: readNumber(fields.nonce) ?? -1,
    rating: readNumber(fields.rating) || 1500,
    totalManaPoints: readNumber(fields.totalManaPoints) ?? 0,
    win: readBoolean(fields.win) ?? true,
    emoji:
      readEmoji(customFields.emoji) ?? getProfileFallbackEmojiId(profileId),
    username: readString(fields.username) || null,
    eth: readString(fields.eth) || null,
    sol: readString(fields.sol) || null,
    feb2026UniqueOpponentsCount:
      readNumber(fields.feb2026UniqueOpponentsCount) ?? 0,
    mining: normalizeMiningSnapshot({
      lastRockDate: readString(miningFields.lastRockDate) ?? null,
      materials,
    }),
  };

  assignOptional(profile, "aura", readString(customFields.aura));
  assignOptional(
    profile,
    "cardBackgroundId",
    readNumber(customFields.cardBackgroundId),
  );
  assignOptional(
    profile,
    "cardSubtitleId",
    readNumber(customFields.cardSubtitleId),
  );
  assignOptional(
    profile,
    "profileCounter",
    readString(customFields.profileCounter),
  );
  assignOptional(profile, "profileMons", readString(customFields.profileMons));
  assignOptional(
    profile,
    "cardStickers",
    readString(customFields.cardStickers),
  );
  if (includeTutorialState) {
    assignOptional(
      profile,
      "completedProblemIds",
      readStringArray(customFields.completedProblems),
    );
    assignOptional(
      profile,
      "isTutorialCompleted",
      readBoolean(customFields.tutorialCompleted),
    );
  }

  return {
    mergedIntoProfileId: readString(fields.mergedIntoProfileId)?.trim() || null,
    profile,
  };
}

function parseQueryDocuments(
  value: unknown,
  includeTutorialState: boolean,
): CompletePlayerProfile[] {
  if (!Array.isArray(value)) {
    throw new ProfileRepositoryFailure();
  }
  const profiles: CompletePlayerProfile[] = [];
  for (const entry of value) {
    const result = toRecord(entry);
    if (!result?.document) {
      continue;
    }
    profiles.push(
      parseProfileDocument(result.document, includeTutorialState).profile,
    );
  }
  return profiles;
}

function selectFields(fields: readonly string[]): Array<{ fieldPath: string }> {
  return fields.map((fieldPath) => ({ fieldPath }));
}

function leaderboardOrderField(type: LeaderboardReadType): string {
  if (type === "rating") {
    return "rating";
  }
  if (type === "mp") {
    return "totalManaPoints";
  }
  return `mining.materials.${type}`;
}

export function createProfileRepository({
  fetcher = fetch,
  timeoutMs = FIRESTORE_TIMEOUT_MS,
}: ProfileRepositoryDependencies = {}): ProfileRepository {
  const authorizedFetch = async (
    input: string,
    firebaseIdToken: string,
    init: RequestInit = {},
  ): Promise<Response> => {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${firebaseIdToken}`);
    try {
      return await fetcher(input, {
        ...init,
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new ProfileRepositoryFailure();
    }
  };

  const readJson = async (response: Response): Promise<unknown> => {
    if (!response.ok) {
      await cancelResponseBody(response);
      throw new ProfileRepositoryFailure();
    }
    return readBoundedJsonValue(
      response,
      MAX_PROFILE_RESPONSE_BODY_BYTES,
      () => new ProfileRepositoryFailure(),
    );
  };

  const getDocument = async (
    profileId: string,
    firebaseIdToken: string,
  ): Promise<ParsedProfileDocument | null> => {
    const url = new URL(
      `${FIRESTORE_DOCUMENTS_ROOT}/users/${encodeURIComponent(profileId)}`,
    );
    for (const field of PROFILE_LOOKUP_FIELDS) {
      url.searchParams.append("mask.fieldPaths", field);
    }
    const response = await authorizedFetch(url.toString(), firebaseIdToken);
    if (response.status === 404) {
      await cancelResponseBody(response);
      return null;
    }
    return parseProfileDocument(await readJson(response), true);
  };

  return {
    async getProfileById(profileId, firebaseIdToken) {
      const visited = new Set<string>();
      let currentProfileId = profileId;
      for (let hop = 0; hop <= PROFILE_MERGE_REDIRECT_LIMIT; hop++) {
        if (visited.has(currentProfileId)) {
          return null;
        }
        visited.add(currentProfileId);
        const result = await getDocument(currentProfileId, firebaseIdToken);
        if (!result) {
          return null;
        }
        if (!result.mergedIntoProfileId) {
          return result.profile;
        }
        currentProfileId = result.mergedIntoProfileId;
      }
      return null;
    },

    async getProfileByLoginId(loginId, firebaseIdToken) {
      const response = await authorizedFetch(
        `${FIRESTORE_DOCUMENTS_ROOT}:runQuery`,
        firebaseIdToken,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            structuredQuery: {
              select: { fields: selectFields(PROFILE_LOOKUP_FIELDS) },
              from: [{ collectionId: "users" }],
              where: {
                fieldFilter: {
                  field: { fieldPath: "logins" },
                  op: "ARRAY_CONTAINS",
                  value: { stringValue: loginId },
                },
              },
              limit: 1,
            },
          }),
        },
      );
      return parseQueryDocuments(await readJson(response), true)[0] || null;
    },

    async readLeaderboard(type, firebaseIdToken) {
      const response = await authorizedFetch(
        `${FIRESTORE_DOCUMENTS_ROOT}:runQuery`,
        firebaseIdToken,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            structuredQuery: {
              select: { fields: selectFields(LEADERBOARD_PROFILE_FIELDS) },
              from: [{ collectionId: "users" }],
              orderBy: [
                {
                  field: { fieldPath: leaderboardOrderField(type) },
                  direction: "DESCENDING",
                },
              ],
              limit: LEADERBOARD_ENTRY_LIMIT,
            },
          }),
        },
      );
      return parseQueryDocuments(await readJson(response), false);
    },
  };
}

export {
  BASE_PROFILE_FIELDS,
  FIRESTORE_DOCUMENTS_ROOT,
  LEADERBOARD_PROFILE_FIELDS,
  LEADERBOARD_ENTRY_LIMIT,
  MAX_PROFILE_RESPONSE_BODY_BYTES,
  PROFILE_LOOKUP_FIELDS,
  PROFILE_CARD_FIELDS,
  PROFILE_MERGE_REDIRECT_LIMIT,
  leaderboardOrderField,
};
