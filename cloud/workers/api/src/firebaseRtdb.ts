import { cancelResponseBody, readBoundedJsonValue } from "./boundedStreams.ts";
import { createGoogleAccessToken } from "./googleAuth.ts";
import { validateTelegramTransactionDecision } from "./telegramTransaction.ts";
import { notifyInviteSourceChanged } from "./inviteWagersNotifications.ts";
import { isCanonicalFirebaseUid, isSafeFirebaseKey } from "./firebaseKeys.ts";
import { notifyMatchSyncChanged } from "./matchSyncNotifications.ts";
import {
  isReadMatchSnapshotRequest,
  MAX_GAME_SESSION_GAME_VARIANT_BYTES,
  type ReadMatchSnapshotRequest,
} from "@mons/shared/game-sessions";
import {
  isMatchFenWithinLimit,
  isMatchHistoryWithinLimits,
} from "@mons/shared/match-protocol";

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

export class FirebaseRtdbPermissionDenied extends FirebaseRtdbFailure {
  constructor() {
    super();
    this.message = "firebase-rtdb-permission-denied";
  }
}

export type FirebaseRtdbCredentials = {
  email: string;
  privateKeyPem: string;
};

type FirebaseRtdbLocation = { FIREBASE_RTDB_URL: string };

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
    beforeWrite?: (attempt: {
      current: unknown;
      proposed: unknown;
      etag: string;
    }) => Promise<void>,
  ) => Promise<FirebaseRtdbTransactionResult>;
};

function databaseRoot(env: FirebaseRtdbLocation): string {
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

export async function readPublicFirebaseMatch(
  env: FirebaseRtdbLocation,
  request: ReadMatchSnapshotRequest,
  {
    fetcher = fetch,
    signal,
    timeoutMs = RTDB_TIMEOUT_MS,
  }: {
    fetcher?: typeof fetch;
    signal?: AbortSignal;
    timeoutMs?: number;
  } = {},
): Promise<unknown> {
  if (!isReadMatchSnapshotRequest(request)) {
    throw new TypeError("invalid-match-snapshot-request");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("invalid-match-snapshot-timeout");
  }
  const url = databaseUrl(
    databaseRoot(env),
    `players/${request.playerId}/matches/${request.matchId}`,
  );
  const timeoutSignal = AbortSignal.timeout(
    Math.min(timeoutMs, RTDB_TIMEOUT_MS),
  );
  const requestSignal = signal
    ? AbortSignal.any([signal, timeoutSignal])
    : timeoutSignal;
  try {
    requestSignal.throwIfAborted();
    const response = await fetcher(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      cache: "no-store",
      redirect: "manual",
      signal: requestSignal,
    });
    if (!response.ok) {
      await cancelResponseBody(response);
      throw new FirebaseRtdbFailure();
    }
    const value = await readBoundedJsonValue(
      response,
      MAX_RTDB_BODY_BYTES,
      () => new FirebaseRtdbFailure(),
    );
    requestSignal.throwIfAborted();
    return value;
  } catch {
    throw new FirebaseRtdbFailure();
  }
}

export function createFirebaseRtdbClient(
  env: Env,
  {
    scopedMatchSurrender,
    scopedMatchMove,
    credentials = scopedMatchSurrender !== undefined ||
    scopedMatchMove !== undefined
      ? {
          email: env.GAMEPLAY_SERVICE_ACCOUNT_EMAIL,
          privateKeyPem: env.GAMEPLAY_SERVICE_ACCOUNT_PRIVATE_KEY,
        }
      : {
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
    scopedMatchSurrender?: { playerId: string; matchId: string };
    scopedMatchMove?: { playerId: string; matchId: string };
    timeoutMs?: number;
  } = {},
): FirebaseRtdbClient {
  const root = databaseRoot(env);
  if (scopedMatchSurrender !== undefined && scopedMatchMove !== undefined) {
    throw new TypeError("conflicting-match-write-scopes");
  }
  const scope = scopedMatchSurrender ?? scopedMatchMove;
  const scopeKind = scopedMatchSurrender !== undefined ? "surrender" : "move";
  if (
    (scopedMatchSurrender !== undefined || scopedMatchMove !== undefined) &&
    (!scope ||
      !isCanonicalFirebaseUid(scope.playerId) ||
      !isSafeFirebaseKey(scope.matchId) ||
      scope.matchId !== scope.matchId.trim())
  ) {
    throw new TypeError(`invalid-match-${scopeKind}-scope`);
  }
  const scopedPath = scope
    ? `players/${scope.playerId}/matches/${scope.matchId}`
    : null;
  const authOverride = scope
    ? JSON.stringify({
        uid: scope.playerId,
        token: {
          [scopeKind === "surrender"
            ? "workerSurrenderMatchId"
            : "workerMoveMatchId"]: scope.matchId,
        },
      })
    : null;
  const assertPath = (path: string): void => {
    if (scopedPath !== null && path !== scopedPath) {
      throw new TypeError(`match-${scopeKind}-path-outside-scope`);
    }
  };
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
    if (authOverride !== null) {
      const url = new URL(input);
      url.searchParams.set("auth_variable_override", authOverride);
      input = url.toString();
    }
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
  const throwResponseFailure = async (response: Response): Promise<never> => {
    if (scopedPath !== null && [401, 403].includes(response.status)) {
      const value = await readBoundedJsonValue(
        response,
        MAX_RTDB_BODY_BYTES,
        () => new FirebaseRtdbFailure(),
      );
      if (
        value &&
        typeof value === "object" &&
        "error" in value &&
        typeof value.error === "string" &&
        /^permission denied\.?$/i.test(value.error.trim())
      ) {
        throw new FirebaseRtdbPermissionDenied();
      }
    } else {
      await cancelResponseBody(response);
    }
    throw new FirebaseRtdbFailure();
  };
  const readJson = async (response: Response): Promise<unknown> => {
    if (!response.ok) {
      return throwResponseFailure(response);
    }
    return readBoundedJsonValue(
      response,
      MAX_RTDB_BODY_BYTES,
      () => new FirebaseRtdbFailure(),
    );
  };
  return {
    async getPath(path, query, signal) {
      assertPath(path);
      return readJson(
        await authorizedFetch(queryDatabaseUrl(root, path, query), {}, signal),
      );
    },
    async patchRoot(updates, signal) {
      if (scopedPath !== null) {
        throw new TypeError(`match-${scopeKind}-multipath-write-forbidden`);
      }
      const url = new URL(databaseUrl(root, ""));
      url.searchParams.set("print", "silent");
      let committed = false;
      try {
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
        committed = true;
        await cancelResponseBody(response);
      } finally {
        await Promise.all([
          notifyInviteSourceChanged(env, updates, committed),
          notifyMatchSyncChanged(env, updates),
        ]);
      }
    },
    async transactPath(path, updater, signal, beforeWrite) {
      assertPath(path);
      const url = databaseUrl(root, path);
      for (let attempt = 0; attempt < maxTransactionAttempts; attempt += 1) {
        const readResponse = await authorizedFetch(
          url,
          { headers: { "X-Firebase-ETag": "true" } },
          signal,
        );
        if (!readResponse.ok) {
          return throwResponseFailure(readResponse);
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
        const decision = validateTelegramTransactionDecision(
          updater(scopedPath === null ? current : structuredClone(current)),
        );
        if (!decision.commit) {
          await notifyMatchSyncChanged(env, { [path]: current });
          return {
            committed: false,
            decision: decision.decision,
            value: current,
          };
        }
        const body = JSON.stringify(decision.value);
        if (
          scopedPath !== null &&
          scopeKind === "surrender" &&
          (!current ||
            typeof current !== "object" ||
            Array.isArray(current) ||
            body !== JSON.stringify({ ...current, status: "surrendered" }))
        ) {
          throw new TypeError("match-surrender-must-only-change-status");
        }
        if (scopedPath !== null && scopeKind === "move") {
          assertScopedMoveBody(current, decision.value, body);
        }
        await beforeWrite?.({ current, proposed: decision.value, etag });
        let committed = false;
        let conflict = false;
        try {
          const writeResponse = await authorizedFetch(
            url,
            {
              method: "PUT",
              headers: {
                "Content-Type": "application/json",
                "If-Match": etag,
              },
              body,
            },
            signal,
          );
          if (writeResponse.status === 412) {
            conflict = true;
            await cancelResponseBody(writeResponse);
            continue;
          }
          const value = await readJson(writeResponse);
          committed = true;
          return {
            committed: true,
            decision: decision.decision,
            value,
          };
        } finally {
          if (!conflict) {
            await Promise.all([
              notifyInviteSourceChanged(
                env,
                { [path]: decision.value },
                committed,
              ),
              notifyMatchSyncChanged(env, { [path]: decision.value }),
            ]);
          }
        }
      }
      throw new FirebaseRtdbFailure();
    },
  };
}

function assertScopedMoveBody(
  current: unknown,
  proposed: unknown,
  body: string,
): void {
  if (
    !current ||
    typeof current !== "object" ||
    Array.isArray(current) ||
    !proposed ||
    typeof proposed !== "object" ||
    Array.isArray(proposed)
  ) {
    throw new TypeError("match-move-must-only-change-move-fields");
  }
  const before = current as Record<string, unknown>;
  const after = proposed as Record<string, unknown>;
  const expected: Record<string, unknown> = { ...before };
  if (
    (before.gameVariant === undefined || before.gameVariant === "") &&
    typeof after.gameVariant === "string" &&
    after.gameVariant !== "" &&
    new TextEncoder().encode(after.gameVariant).byteLength <=
      MAX_GAME_SESSION_GAME_VARIANT_BYTES
  ) {
    expected.gameVariant = after.gameVariant;
  }
  expected.fen = after.fen;
  expected.flatMovesString = after.flatMovesString;
  if (
    typeof after.fen !== "string" ||
    !after.fen ||
    !isMatchFenWithinLimit(after.fen) ||
    !isMatchHistoryWithinLimits(after.flatMovesString) ||
    body !== JSON.stringify(expected)
  ) {
    throw new TypeError("match-move-must-only-change-move-fields");
  }
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
