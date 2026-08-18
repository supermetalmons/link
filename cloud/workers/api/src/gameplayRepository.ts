import { cancelResponseBody, readBoundedJsonValue } from "./boundedStreams.ts";
import {
  createFirebaseRtdbClient,
  type FirebaseRtdbClient,
  type FirebaseRtdbQuery,
} from "./firebaseRtdb.ts";
import { createGoogleAccessToken } from "./googleAuth.ts";

const FIRESTORE_PROJECT_ID = "mons-link";
const FIRESTORE_DATABASE_ID = "(default)";
const FIRESTORE_DOCUMENTS_ROOT = `https://firestore.googleapis.com/v1/projects/${FIRESTORE_PROJECT_ID}/databases/${FIRESTORE_DATABASE_ID}/documents`;
const FIRESTORE_TIMEOUT_MS = 5_000;
const MAX_FIRESTORE_BODY_BYTES = 64 * 1024;

export type NavigationGameDocument = {
  status: string | null;
  updateTime: string;
};

export type NavigationGameDeleteResult = "conflict" | "deleted" | "missing";

export type GameplayRepository = {
  deleteNavigationGame: (
    profileId: string,
    inviteId: string,
    updateTime: string,
  ) => Promise<NavigationGameDeleteResult>;
  findProfileId: (
    uid: string,
    firebaseIdToken: string,
  ) => Promise<string | null>;
  getNavigationGame: (
    profileId: string,
    inviteId: string,
    firebaseIdToken: string,
  ) => Promise<NavigationGameDocument | null>;
  getRtdbPath: (path: string, query?: FirebaseRtdbQuery) => Promise<unknown>;
  patchRtdbRoot: (updates: Record<string, unknown>) => Promise<void>;
};

type GameplayRepositoryDependencies = {
  fetcher?: typeof fetch;
  getAccessToken?: typeof createGoogleAccessToken;
  now?: () => number;
  rtdbClient?: FirebaseRtdbClient;
  timeoutMs?: number;
};

export class GameplayRepositoryFailure extends Error {
  constructor() {
    super("gameplay-repository-unavailable");
  }
}

function toRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isPreconditionConflict(value: unknown): boolean {
  const body = toRecord(value);
  const error = toRecord(body?.error);
  return error?.status === "ABORTED" || error?.status === "FAILED_PRECONDITION";
}

function documentPath(profileId: string, inviteId?: string): string {
  const profilePath = `users/${encodeURIComponent(profileId)}`;
  return inviteId === undefined
    ? profilePath
    : `${profilePath}/games/${encodeURIComponent(inviteId)}`;
}

function parseProfileQuery(value: unknown): string | null {
  if (!Array.isArray(value)) {
    throw new GameplayRepositoryFailure();
  }
  for (const entry of value) {
    const result = toRecord(entry);
    const document = toRecord(result?.document);
    if (!document) {
      continue;
    }
    const name = typeof document.name === "string" ? document.name.trim() : "";
    const profileId = name.split("/").pop()?.trim() || "";
    if (!profileId) {
      throw new GameplayRepositoryFailure();
    }
    return profileId;
  }
  return null;
}

function parseNavigationGame(value: unknown): NavigationGameDocument {
  const document = toRecord(value);
  const fields = toRecord(document?.fields);
  const statusValue = toRecord(fields?.status);
  const updateTime =
    typeof document?.updateTime === "string" ? document.updateTime.trim() : "";
  if (!fields || !updateTime) {
    throw new GameplayRepositoryFailure();
  }
  return {
    status:
      typeof statusValue?.stringValue === "string"
        ? statusValue.stringValue
        : null,
    updateTime,
  };
}

export function createGameplayRepository(
  env: Env,
  {
    fetcher = fetch,
    getAccessToken = createGoogleAccessToken,
    now = Date.now,
    timeoutMs = FIRESTORE_TIMEOUT_MS,
    rtdbClient = createFirebaseRtdbClient(env, {
      credentials: {
        email: env.GAMEPLAY_SERVICE_ACCOUNT_EMAIL,
        privateKeyPem: env.GAMEPLAY_SERVICE_ACCOUNT_PRIVATE_KEY,
      },
      fetcher,
      now,
      timeoutMs,
    }),
  }: GameplayRepositoryDependencies = {},
): GameplayRepository {
  let serviceAccessToken: Promise<string> | null = null;
  const getServiceAccessToken = () => {
    serviceAccessToken ||= getAccessToken(env, {
      credentials: {
        email: env.GAMEPLAY_SERVICE_ACCOUNT_EMAIL,
        privateKeyPem: env.GAMEPLAY_SERVICE_ACCOUNT_PRIVATE_KEY,
      },
      fetcher,
      now,
      timeoutMs,
    }).catch(() => {
      throw new GameplayRepositoryFailure();
    });
    return serviceAccessToken;
  };
  const fetchWithTimeout = async (
    input: string,
    init: RequestInit,
  ): Promise<Response> => {
    try {
      return await fetcher(input, {
        ...init,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new GameplayRepositoryFailure();
    }
  };

  return {
    getRtdbPath: rtdbClient.getPath,
    patchRtdbRoot: rtdbClient.patchRoot,

    async findProfileId(uid, firebaseIdToken) {
      const response = await fetchWithTimeout(
        `${FIRESTORE_DOCUMENTS_ROOT}:runQuery`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${firebaseIdToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            structuredQuery: {
              select: { fields: [{ fieldPath: "logins" }] },
              from: [{ collectionId: "users" }],
              where: {
                fieldFilter: {
                  field: { fieldPath: "logins" },
                  op: "ARRAY_CONTAINS",
                  value: { stringValue: uid },
                },
              },
              limit: 1,
            },
          }),
        },
      );
      if (!response.ok) {
        await cancelResponseBody(response);
        throw new GameplayRepositoryFailure();
      }
      return parseProfileQuery(
        await readBoundedJsonValue(
          response,
          MAX_FIRESTORE_BODY_BYTES,
          () => new GameplayRepositoryFailure(),
        ),
      );
    },

    async getNavigationGame(profileId, inviteId, firebaseIdToken) {
      const response = await fetchWithTimeout(
        `${FIRESTORE_DOCUMENTS_ROOT}/${documentPath(profileId, inviteId)}`,
        { headers: { Authorization: `Bearer ${firebaseIdToken}` } },
      );
      if (response.status === 404) {
        await cancelResponseBody(response);
        return null;
      }
      if (!response.ok) {
        await cancelResponseBody(response);
        throw new GameplayRepositoryFailure();
      }
      return parseNavigationGame(
        await readBoundedJsonValue(
          response,
          MAX_FIRESTORE_BODY_BYTES,
          () => new GameplayRepositoryFailure(),
        ),
      );
    },

    async deleteNavigationGame(profileId, inviteId, updateTime) {
      const url = new URL(
        `${FIRESTORE_DOCUMENTS_ROOT}/${documentPath(profileId, inviteId)}`,
      );
      url.searchParams.set("currentDocument.updateTime", updateTime);
      const response = await fetchWithTimeout(url.toString(), {
        method: "DELETE",
        headers: { Authorization: `Bearer ${await getServiceAccessToken()}` },
      });
      if (response.ok) {
        await cancelResponseBody(response);
        return "deleted";
      }
      if (response.status === 404) {
        await cancelResponseBody(response);
        return "missing";
      }
      if (response.status === 409 || response.status === 412) {
        await cancelResponseBody(response);
        return "conflict";
      }
      if (response.status === 400) {
        const body = await readBoundedJsonValue(
          response,
          MAX_FIRESTORE_BODY_BYTES,
          () => new GameplayRepositoryFailure(),
        );
        if (isPreconditionConflict(body)) {
          return "conflict";
        }
        throw new GameplayRepositoryFailure();
      }
      await cancelResponseBody(response);
      throw new GameplayRepositoryFailure();
    },
  };
}

export {
  FIRESTORE_TIMEOUT_MS,
  MAX_FIRESTORE_BODY_BYTES,
  documentPath,
  isPreconditionConflict,
  parseNavigationGame,
  parseProfileQuery,
};
