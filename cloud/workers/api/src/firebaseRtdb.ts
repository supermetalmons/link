import { cancelResponseBody, readBoundedJsonValue } from "./boundedStreams.ts";
import { createGoogleAccessToken } from "./googleAuth.ts";
import {
  createTelegramRepository,
  type TelegramTransactionResult,
} from "../../../functions/telegram/repositoryCore.js";
import type { TelegramRepository } from "../../../functions/telegram/deliveryEngine.js";

const FIREBASE_DATABASE_SCOPE =
  "https://www.googleapis.com/auth/firebase.database";
const GOOGLE_USERINFO_EMAIL_SCOPE =
  "https://www.googleapis.com/auth/userinfo.email";
const RTDB_TIMEOUT_MS = 5_000;
const MAX_RTDB_BODY_BYTES = 1024 * 1024;
const MAX_TRANSACTION_ATTEMPTS = 25;

export class FirebaseRtdbFailure extends Error {
  constructor() {
    super("firebase-rtdb-unavailable");
  }
}

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
  if (!encodedPath) {
    throw new FirebaseRtdbFailure();
  }
  return `${root}/${encodedPath}.json`;
}

function validateDecisionOutput(output: unknown):
  | { commit: false; decision?: string }
  | {
      commit: true;
      value: unknown;
      decision?: string;
    } {
  if (!output || typeof output !== "object" || Array.isArray(output)) {
    throw new TypeError("RTDB transaction decision must return an object");
  }
  const candidate = output as {
    commit?: unknown;
    decision?: unknown;
    value?: unknown;
  };
  const hasValue = Object.hasOwn(output, "value");
  const decision =
    typeof candidate.decision === "string" ? candidate.decision : undefined;
  if (candidate.commit === false) {
    if (hasValue) {
      throw new TypeError("RTDB logical abort must not include value");
    }
    return { commit: false, decision };
  }
  if (Object.hasOwn(output, "commit")) {
    throw new TypeError("RTDB write decision must omit commit");
  }
  if (!hasValue || candidate.value === undefined) {
    throw new TypeError("RTDB write decision requires a defined value");
  }
  return { commit: true, value: candidate.value, decision };
}

export function createFirebaseRtdbRepository(
  env: Env,
  {
    fetcher = fetch,
    getAccessToken: getAccessTokenOverride,
    maxTransactionAttempts = MAX_TRANSACTION_ATTEMPTS,
    now = Date.now,
    timeoutMs = RTDB_TIMEOUT_MS,
  }: {
    fetcher?: typeof fetch;
    getAccessToken?: () => Promise<string>;
    maxTransactionAttempts?: number;
    now?: () => number;
    timeoutMs?: number;
  } = {},
): TelegramRepository {
  const root = databaseRoot(env);
  let accessToken: Promise<string> | null = null;
  const getAccessToken = () => {
    accessToken ||= getAccessTokenOverride
      ? getAccessTokenOverride()
      : createGoogleAccessToken(env, {
          credentials: {
            email: env.TELEGRAM_FIREBASE_SERVICE_ACCOUNT_EMAIL,
            privateKeyPem: env.TELEGRAM_FIREBASE_SERVICE_ACCOUNT_PRIVATE_KEY,
          },
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
  ): Promise<Response> => {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${await getAccessToken()}`);
    try {
      return await fetcher(input, {
        ...init,
        headers,
        signal: AbortSignal.timeout(timeoutMs),
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
  return createTelegramRepository({
    async getPath(path) {
      return readJson(await authorizedFetch(databaseUrl(root, path)));
    },
    async transactPath(path, updater): Promise<TelegramTransactionResult> {
      const url = databaseUrl(root, path);
      for (let attempt = 0; attempt < maxTransactionAttempts; attempt += 1) {
        const readResponse = await authorizedFetch(url, {
          headers: { "X-Firebase-ETag": "true" },
        });
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
        const decision = validateDecisionOutput(updater(current));
        if (!decision.commit) {
          return {
            committed: false,
            decision: decision.decision,
            value: current,
          };
        }
        const writeResponse = await authorizedFetch(url, {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            "If-Match": etag,
          },
          body: JSON.stringify(decision.value),
        });
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
  });
}

export {
  FIREBASE_DATABASE_SCOPE,
  GOOGLE_USERINFO_EMAIL_SCOPE,
  MAX_RTDB_BODY_BYTES,
  MAX_TRANSACTION_ATTEMPTS,
  RTDB_TIMEOUT_MS,
  databaseRoot,
  databaseUrl,
  validateDecisionOutput,
};
