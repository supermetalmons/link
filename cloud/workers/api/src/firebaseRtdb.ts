import { cancelResponseBody, readBoundedJsonValue } from "./boundedStreams.ts";
import { createGoogleAccessToken } from "./googleAuth.ts";
import { validateTelegramTransactionDecision } from "./telegramTransaction.ts";

const FIREBASE_DATABASE_SCOPE =
  "https://www.googleapis.com/auth/firebase.database";
const GOOGLE_USERINFO_EMAIL_SCOPE =
  "https://www.googleapis.com/auth/userinfo.email";
const RTDB_TIMEOUT_MS = 5_000;
const MAX_RTDB_BODY_BYTES = 1024 * 1024;
const MAX_TRANSACTION_ATTEMPTS = 25;

export const FIREBASE_RTDB_SERVER_TIMESTAMP = Object.freeze({
  ".sv": "timestamp",
});

export function firebaseRtdbIncrement(delta: number): Record<string, unknown> {
  if (!Number.isFinite(delta)) {
    throw new TypeError("RTDB increment must be finite");
  }
  return { ".sv": { increment: delta } };
}

export class FirebaseRtdbFailure extends Error {
  constructor() {
    super("firebase-rtdb-unavailable");
  }
}

export type FirebaseRtdbCredentials = {
  email: string;
  privateKeyPem: string;
};

export type FirebaseRtdbQuery = {
  endAt?: string | number | boolean | null;
  equalTo?: string | number | boolean | null;
  limitToFirst?: number;
  orderBy?: string;
  shallow?: boolean;
  startAt?: string | number | boolean | null;
};

export type FirebaseRtdbTransactionResult = {
  committed: boolean;
  decision?: string;
  value: unknown;
};

export type FirebaseRtdbClient = {
  getPath: (
    path: string,
    query?: FirebaseRtdbQuery,
    signal?: AbortSignal,
  ) => Promise<unknown>;
  patchRoot: (
    updates: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<void>;
  transactPath: (
    path: string,
    updater: (current: unknown) => unknown,
    signal?: AbortSignal,
  ) => Promise<FirebaseRtdbTransactionResult>;
};

function databaseRoot(env: Env): string {
  const raw = env.FIREBASE_RTDB_URL.trim().replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new FirebaseRtdbFailure();
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    (!url.hostname.endsWith(".firebaseio.com") &&
      !url.hostname.endsWith(".firebasedatabase.app"))
  ) {
    throw new FirebaseRtdbFailure();
  }
  return raw;
}

function databaseUrl(root: string, path: string): string {
  const encodedPath = path
    .split("/")
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return encodedPath ? `${root}/${encodedPath}.json` : `${root}/.json`;
}

function queryDatabaseUrl(
  root: string,
  path: string,
  query: FirebaseRtdbQuery = {},
): string {
  const url = new URL(databaseUrl(root, path));
  if (
    query.shallow === true &&
    (query.orderBy !== undefined ||
      query.equalTo !== undefined ||
      query.startAt !== undefined ||
      query.endAt !== undefined ||
      query.limitToFirst !== undefined)
  ) {
    throw new FirebaseRtdbFailure();
  }
  if (query.shallow === true) {
    url.searchParams.set("shallow", "true");
  }
  if (query.orderBy !== undefined) {
    url.searchParams.set("orderBy", JSON.stringify(query.orderBy));
  }
  if (query.equalTo !== undefined) {
    url.searchParams.set("equalTo", JSON.stringify(query.equalTo));
  }
  if (query.startAt !== undefined) {
    url.searchParams.set("startAt", JSON.stringify(query.startAt));
  }
  if (query.endAt !== undefined) {
    url.searchParams.set("endAt", JSON.stringify(query.endAt));
  }
  if (query.limitToFirst !== undefined) {
    if (!Number.isInteger(query.limitToFirst) || query.limitToFirst < 1) {
      throw new FirebaseRtdbFailure();
    }
    url.searchParams.set("limitToFirst", String(query.limitToFirst));
  }
  return url.toString();
}

export function createFirebaseRtdbClient(
  env: Env,
  {
    credentials = {
      email: env.TELEGRAM_FIREBASE_SERVICE_ACCOUNT_EMAIL,
      privateKeyPem: env.TELEGRAM_FIREBASE_SERVICE_ACCOUNT_PRIVATE_KEY,
    },
    fetcher = fetch,
    getAccessToken: getAccessTokenOverride,
    maxTransactionAttempts = MAX_TRANSACTION_ATTEMPTS,
    now = Date.now,
    timeoutMs = RTDB_TIMEOUT_MS,
  }: {
    credentials?: FirebaseRtdbCredentials;
    fetcher?: typeof fetch;
    getAccessToken?: () => Promise<string>;
    maxTransactionAttempts?: number;
    now?: () => number;
    timeoutMs?: number;
  } = {},
): FirebaseRtdbClient {
  const root = databaseRoot(env);
  let accessToken: Promise<string> | null = null;
  const getAccessToken = () => {
    accessToken ||= getAccessTokenOverride
      ? getAccessTokenOverride()
      : createGoogleAccessToken(env, {
          credentials,
          fetcher,
          now,
          scopes: [FIREBASE_DATABASE_SCOPE, GOOGLE_USERINFO_EMAIL_SCOPE],
          timeoutMs,
        });
    return accessToken;
  };
  const authorizedFetch = async (
    input: string,
    init: RequestInit = {},
    signal?: AbortSignal,
  ): Promise<Response> => {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${await getAccessToken()}`);
    const requestSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
      : AbortSignal.timeout(timeoutMs);
    try {
      return await fetcher(input, {
        ...init,
        headers,
        signal: requestSignal,
      });
    } catch {
      throw new FirebaseRtdbFailure();
    }
  };
  const readJson = async (response: Response): Promise<unknown> => {
    if (!response.ok) {
      await cancelResponseBody(response);
      throw new FirebaseRtdbFailure();
    }
    return readBoundedJsonValue(
      response,
      MAX_RTDB_BODY_BYTES,
      () => new FirebaseRtdbFailure(),
    );
  };
  return {
    async getPath(path, query, signal) {
      return readJson(
        await authorizedFetch(queryDatabaseUrl(root, path, query), {}, signal),
      );
    },
    async patchRoot(updates, signal) {
      const url = new URL(databaseUrl(root, ""));
      url.searchParams.set("print", "silent");
      const response = await authorizedFetch(
        url.toString(),
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(updates),
        },
        signal,
      );
      if (!response.ok) {
        await cancelResponseBody(response);
        throw new FirebaseRtdbFailure();
      }
      await cancelResponseBody(response);
    },
    async transactPath(path, updater, signal) {
      const url = databaseUrl(root, path);
      for (let attempt = 0; attempt < maxTransactionAttempts; attempt += 1) {
        const readResponse = await authorizedFetch(
          url,
          { headers: { "X-Firebase-ETag": "true" } },
          signal,
        );
        if (!readResponse.ok) {
          await cancelResponseBody(readResponse);
          throw new FirebaseRtdbFailure();
        }
        const etag = readResponse.headers.get("ETag");
        if (!etag) {
          await cancelResponseBody(readResponse);
          throw new FirebaseRtdbFailure();
        }
        const current = await readBoundedJsonValue(
          readResponse,
          MAX_RTDB_BODY_BYTES,
          () => new FirebaseRtdbFailure(),
        );
        const decision = validateTelegramTransactionDecision(updater(current));
        if (!decision.commit) {
          return {
            committed: false,
            decision: decision.decision,
            value: current,
          };
        }
        const writeResponse = await authorizedFetch(
          url,
          {
            method: "PUT",
            headers: {
              "Content-Type": "application/json",
              "If-Match": etag,
            },
            body: JSON.stringify(decision.value),
          },
          signal,
        );
        if (writeResponse.status === 412) {
          await cancelResponseBody(writeResponse);
          continue;
        }
        return {
          committed: true,
          decision: decision.decision,
          value: await readJson(writeResponse),
        };
      }
      throw new FirebaseRtdbFailure();
    },
  };
}

export {
  FIREBASE_DATABASE_SCOPE,
  GOOGLE_USERINFO_EMAIL_SCOPE,
  MAX_RTDB_BODY_BYTES,
  MAX_TRANSACTION_ATTEMPTS,
  RTDB_TIMEOUT_MS,
  databaseRoot,
  databaseUrl,
  queryDatabaseUrl,
};

export { validateTelegramTransactionDecision as validateDecisionOutput };
