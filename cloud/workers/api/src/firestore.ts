import { cancelResponseBody, readBoundedJsonValue } from "./boundedStreams.ts";
import type { createGoogleAccessToken } from "./googleAuth.ts";
import {
  getLinkedAuthMethodsFromProfile,
  type LinkedAuthMethodsResponse,
} from "@mons/shared/auth";

const FIRESTORE_PROJECT_ID = "mons-link";
const FIRESTORE_DATABASE_ID = "(default)";
const FIRESTORE_DOCUMENTS_ROOT = `https://firestore.googleapis.com/v1/projects/${FIRESTORE_PROJECT_ID}/databases/${FIRESTORE_DATABASE_ID}/documents`;
const FIRESTORE_TIMEOUT_MS = 5_000;
const MAX_FIRESTORE_BODY_BYTES = 64 * 1024;

export type AuthRepository = {
  getLinkedAuthMethods: (
    uid: string,
    firebaseIdToken: string,
  ) => Promise<LinkedAuthMethodsResponse>;
  getProfileClaimSource: (
    uid: string,
    firebaseIdToken: string,
  ) => Promise<ProfileClaimSource>;
};

export type ProfileClaimSource = LinkedAuthMethodsResponse;

export class FirestoreFailure extends Error {
  constructor() {
    super("firestore-unavailable");
  }
}

export class LoginProfileConflict extends Error {
  constructor() {
    super("login-profile-conflict");
  }
}

function toRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readFirestoreString(
  fields: Record<string, unknown>,
  name: string,
): string {
  const value = toRecord(fields[name]);
  return typeof value?.stringValue === "string" ? value.stringValue : "";
}

type ProfileQueryResult = {
  fields: Record<string, unknown>;
  profileId: string;
};

function profilesFromRunQuery(value: unknown): ProfileQueryResult[] {
  if (!Array.isArray(value)) {
    throw new FirestoreFailure();
  }
  const profiles: ProfileQueryResult[] = [];
  for (const entry of value) {
    const result = toRecord(entry);
    const document = toRecord(result?.document);
    if (!document) {
      continue;
    }
    const name = typeof document.name === "string" ? document.name.trim() : "";
    const fields = toRecord(document.fields);
    const profileId = name.split("/").pop()?.trim() || "";
    if (!fields || !profileId) {
      throw new FirestoreFailure();
    }
    profiles.push({ fields, profileId });
  }
  return profiles;
}

function readProfileField(
  fields: Record<string, unknown>,
  name: string,
): string {
  return readFirestoreString(fields, name);
}

export function createAuthRepository(
  _env: Env,
  {
    fetcher = fetch,
    timeoutMs = FIRESTORE_TIMEOUT_MS,
  }: {
    fetcher?: typeof fetch;
    now?: () => number;
    timeoutMs?: number;
    getAccessToken?: typeof createGoogleAccessToken;
  } = {},
): AuthRepository {
  const queryLinkedProfile = async (
    uid: string,
    firebaseIdToken: string,
    limit: 1 | 2,
  ): Promise<ProfileQueryResult[]> => {
    let response: Response;
    try {
      response = await fetcher(`${FIRESTORE_DOCUMENTS_ROOT}:runQuery`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${firebaseIdToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          structuredQuery: {
            select: {
              fields: ["appleSub", "eth", "sol", "xUserId"].map(
                (fieldPath) => ({ fieldPath }),
              ),
            },
            from: [{ collectionId: "users" }],
            where: {
              fieldFilter: {
                field: { fieldPath: "logins" },
                op: "ARRAY_CONTAINS",
                value: { stringValue: uid },
              },
            },
            limit,
          },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new FirestoreFailure();
    }
    if (!response.ok) {
      await cancelResponseBody(response);
      throw new FirestoreFailure();
    }
    return profilesFromRunQuery(
      await readBoundedJsonValue(
        response,
        MAX_FIRESTORE_BODY_BYTES,
        () => new FirestoreFailure(),
      ),
    );
  };

  const linkedMethodsResponse = (
    profile: ProfileQueryResult | null,
  ): LinkedAuthMethodsResponse => {
    if (!profile) {
      const linkedMethods = {
        apple: false,
        eth: false,
        sol: false,
        x: false,
      };
      return {
        ok: true,
        profileId: null,
        linkedMethods,
        appleLinked: false,
      };
    }
    const linkedMethods = getLinkedAuthMethodsFromProfile({
      appleSub: readProfileField(profile.fields, "appleSub"),
      eth: readProfileField(profile.fields, "eth"),
      sol: readProfileField(profile.fields, "sol"),
      xUserId: readProfileField(profile.fields, "xUserId"),
    });
    return {
      ok: true,
      profileId: profile.profileId,
      linkedMethods,
      appleLinked: linkedMethods.apple,
    };
  };

  return {
    async getLinkedAuthMethods(uid, firebaseIdToken) {
      const profiles = await queryLinkedProfile(uid, firebaseIdToken, 1);
      return linkedMethodsResponse(profiles[0] || null);
    },

    async getProfileClaimSource(uid, firebaseIdToken) {
      const profiles = await queryLinkedProfile(uid, firebaseIdToken, 2);
      if (profiles.length > 1) {
        throw new LoginProfileConflict();
      }
      return linkedMethodsResponse(profiles[0] || null);
    },
  };
}
