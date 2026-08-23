import { cancelResponseBody, readBoundedJsonValue } from "./boundedStreams.ts";
import { createGoogleAccessToken } from "./googleAuth.ts";

const FIREBASE_PROJECT_ID = "mons-link";
const FIREBASE_AUTH_ROOT = `https://identitytoolkit.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}`;
const FIREBASE_AUTH_TIMEOUT_MS = 5_000;
const MAX_FIREBASE_AUTH_BODY_BYTES = 64 * 1024;
const MAX_CUSTOM_CLAIMS_BYTES = 1_000;

export const IDENTITY_TOOLKIT_SCOPE =
  "https://www.googleapis.com/auth/identitytoolkit";

export type FirebaseAuthUser = {
  customClaims: Record<string, unknown>;
  uid: string;
};

export type FirebaseAuthAdminClient = {
  getUser: (uid: string) => Promise<FirebaseAuthUser>;
  setCustomUserClaims: (
    uid: string,
    customClaims: Record<string, unknown>,
  ) => Promise<void>;
};

export class FirebaseAuthAdminFailure extends Error {
  constructor() {
    super("firebase-auth-admin-unavailable");
  }
}

function toRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseCustomClaims(value: unknown): Record<string, unknown> {
  if (value === undefined || value === "") {
    return {};
  }
  if (typeof value !== "string") {
    throw new FirebaseAuthAdminFailure();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new FirebaseAuthAdminFailure();
  }
  const claims = toRecord(parsed);
  if (!claims) {
    throw new FirebaseAuthAdminFailure();
  }
  return claims;
}

function parseUser(value: unknown, uid: string): FirebaseAuthUser {
  const payload = toRecord(value);
  if (!Array.isArray(payload?.users) || payload.users.length !== 1) {
    throw new FirebaseAuthAdminFailure();
  }
  const user = toRecord(payload.users[0]);
  if (user?.localId !== uid) {
    throw new FirebaseAuthAdminFailure();
  }
  return {
    uid,
    customClaims: parseCustomClaims(user.customAttributes),
  };
}

function encodeCustomClaims(customClaims: Record<string, unknown>): string {
  let encoded: string;
  try {
    encoded = JSON.stringify(customClaims);
  } catch {
    throw new FirebaseAuthAdminFailure();
  }
  if (new TextEncoder().encode(encoded).byteLength > MAX_CUSTOM_CLAIMS_BYTES) {
    throw new FirebaseAuthAdminFailure();
  }
  return encoded;
}

export function createFirebaseAuthAdminClient(
  env: Env,
  {
    fetcher = fetch,
    getAccessToken = createGoogleAccessToken,
    now = Date.now,
    signal,
    timeoutMs = FIREBASE_AUTH_TIMEOUT_MS,
  }: {
    fetcher?: typeof fetch;
    getAccessToken?: typeof createGoogleAccessToken;
    now?: () => number;
    signal?: AbortSignal;
    timeoutMs?: number;
  } = {},
): FirebaseAuthAdminClient {
  let accessToken: Promise<string> | null = null;
  const authorizedFetch = async (
    path: string,
    body: Record<string, unknown>,
  ): Promise<Response> => {
    try {
      accessToken ||= getAccessToken(env, {
        credentials: {
          email: env.FIRESTORE_SERVICE_ACCOUNT_EMAIL,
          privateKeyPem: env.FIRESTORE_SERVICE_ACCOUNT_PRIVATE_KEY,
        },
        fetcher,
        now,
        scopes: [IDENTITY_TOOLKIT_SCOPE],
        timeoutMs,
      });
      const headers = new Headers({
        Authorization: `Bearer ${await accessToken}`,
        "Content-Type": "application/json",
      });
      const requestSignal = signal
        ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
        : AbortSignal.timeout(timeoutMs);
      return await fetcher(`${FIREBASE_AUTH_ROOT}${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: requestSignal,
      });
    } catch {
      throw new FirebaseAuthAdminFailure();
    }
  };

  return {
    async getUser(uid) {
      const response = await authorizedFetch("/accounts:lookup", {
        localId: [uid],
      });
      if (!response.ok) {
        await cancelResponseBody(response);
        throw new FirebaseAuthAdminFailure();
      }
      return parseUser(
        await readBoundedJsonValue(
          response,
          MAX_FIREBASE_AUTH_BODY_BYTES,
          () => new FirebaseAuthAdminFailure(),
        ),
        uid,
      );
    },

    async setCustomUserClaims(uid, customClaims) {
      const response = await authorizedFetch("/accounts:update", {
        localId: uid,
        customAttributes: encodeCustomClaims(customClaims),
      });
      if (!response.ok) {
        await cancelResponseBody(response);
        throw new FirebaseAuthAdminFailure();
      }
      const payload = toRecord(
        await readBoundedJsonValue(
          response,
          MAX_FIREBASE_AUTH_BODY_BYTES,
          () => new FirebaseAuthAdminFailure(),
        ),
      );
      if (payload?.localId !== uid) {
        throw new FirebaseAuthAdminFailure();
      }
    },
  };
}

export {
  FIREBASE_AUTH_ROOT,
  FIREBASE_AUTH_TIMEOUT_MS,
  MAX_CUSTOM_CLAIMS_BYTES,
  MAX_FIREBASE_AUTH_BODY_BYTES,
  encodeCustomClaims,
  parseUser,
};
