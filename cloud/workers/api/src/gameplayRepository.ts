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

export type AutomatchProfile = {
  aura: string;
  emoji: number | string;
  eth: string;
  profileId: string;
  rating: number;
  sol: string;
  username: string;
};

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
  getAutomatchProfile: (
    uid: string,
    firebaseIdToken: string,
    signal?: AbortSignal,
  ) => Promise<AutomatchProfile | null>;
  getNavigationGame: (
    profileId: string,
    inviteId: string,
    firebaseIdToken: string,
  ) => Promise<NavigationGameDocument | null>;
  getRtdbPath: (
    path: string,
    query?: FirebaseRtdbQuery,
    signal?: AbortSignal,
  ) => Promise<unknown>;
  patchRtdbRoot: (
    updates: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<void>;
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

function readFirestoreString(value: unknown): string {
  const encoded = toRecord(value);
  return typeof encoded?.stringValue === "string" ? encoded.stringValue : "";
}

function readOptionalFirestoreString(value: unknown): string | undefined {
  const encoded = toRecord(value);
  return typeof encoded?.stringValue === "string"
    ? encoded.stringValue
    : undefined;
}

function readFirestoreNumber(value: unknown, fallback: number): number {
  const encoded = toRecord(value);
  const raw = encoded?.integerValue ?? encoded?.doubleValue;
  const parsed =
    typeof raw === "string" || typeof raw === "number" ? Number(raw) : NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readFirestoreEmoji(value: unknown): number | string {
  const encoded = toRecord(value);
  if (typeof encoded?.stringValue === "string") {
    return encoded.stringValue;
  }
  const parsed = readFirestoreNumber(value, NaN);
  return Number.isFinite(parsed) ? parsed : "";
}

export function parseAutomatchProfileQuery(
  value: unknown,
): AutomatchProfile | null {
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
    const fields = toRecord(document.fields) || {};
    const profileId = name.split("/").pop()?.trim() || "";
    if (!profileId) {
      throw new GameplayRepositoryFailure();
    }
    const custom = toRecord(toRecord(fields.custom)?.mapValue);
    const customFields = toRecord(custom?.fields) || {};
    const customEmoji = Object.hasOwn(customFields, "emoji")
      ? readFirestoreEmoji(customFields.emoji)
      : undefined;
    const customAura = readOptionalFirestoreString(customFields.aura);
    return {
      aura: customAura ?? readFirestoreString(fields.aura),
      emoji: customEmoji ?? readFirestoreEmoji(fields.emoji),
      eth: readFirestoreString(fields.eth),
      profileId,
      rating: readFirestoreNumber(fields.rating, 1500),
      sol: readFirestoreString(fields.sol),
      username: readFirestoreString(fields.username),
    };
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
    signal?: AbortSignal,
  ): Promise<Response> => {
    const requestSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
      : AbortSignal.timeout(timeoutMs);
    try {
      return await fetcher(input, {
        ...init,
        signal: requestSignal,
      });
    } catch {
      throw new GameplayRepositoryFailure();
    }
  };

  return {
    getRtdbPath: rtdbClient.getPath,
    patchRtdbRoot: rtdbClient.patchRoot,

    async getAutomatchProfile(uid, firebaseIdToken, signal) {
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
              select: {
                fields: [
                  { fieldPath: "aura" },
                  { fieldPath: "custom.aura" },
                  { fieldPath: "custom.emoji" },
                  { fieldPath: "emoji" },
                  { fieldPath: "eth" },
                  { fieldPath: "rating" },
                  { fieldPath: "sol" },
                  { fieldPath: "username" },
                ],
              },
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
        signal,
      );
      if (!response.ok) {
        await cancelResponseBody(response);
        throw new GameplayRepositoryFailure();
      }
      return parseAutomatchProfileQuery(
        await readBoundedJsonValue(
          response,
          MAX_FIRESTORE_BODY_BYTES,
          () => new GameplayRepositoryFailure(),
        ),
      );
    },

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
