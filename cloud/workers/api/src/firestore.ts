import { cancelResponseBody, readBoundedJsonValue } from "./boundedStreams.ts";
import { createGoogleAccessToken } from "./googleAuth.ts";
import {
  getLinkedAuthMethodsFromProfile,
  type AuthMethodKey,
  type LinkedAuthMethodsResponse,
} from "@mons/shared/auth";

const FIRESTORE_PROJECT_ID = "mons-link";
const FIRESTORE_DATABASE_ID = "(default)";
const FIRESTORE_DOCUMENTS_ROOT = `https://firestore.googleapis.com/v1/projects/${FIRESTORE_PROJECT_ID}/databases/${FIRESTORE_DATABASE_ID}/documents`;
const X_FLOW_COLLECTION = "xAuthRedirectFlows";
const AUTH_INTENT_COLLECTION = "authIntents";
const FIRESTORE_TIMEOUT_MS = 5_000;
const MAX_FIRESTORE_BODY_BYTES = 64 * 1024;

type FirestoreScalar = string | number | null;

export type AuthIntentRecord = {
  consumedAtMs: number;
  expiresAtMs: number;
  method: string;
  uid: string;
};

export type AuthIntentDocument = {
  consumedAtMs: null;
  createdAtMs: number;
  expiresAtMs: number;
  intentId: string;
  method: AuthMethodKey;
  nonce: string;
  state: string;
  uid: string;
};

export type XRedirectFlowDocument = {
  callbackUri: string;
  codeChallenge: string;
  codeVerifier: string;
  consentSource: string;
  createdAtMs: number;
  errorCode: null;
  expiresAtMs: number;
  flowId: string;
  intentId: string;
  method: "x";
  returnUrl: string;
  status: "created";
  uid: string;
  updatedAtMs: number;
  xUserId: null;
  xUsername: null;
};

export type AuthRepository = {
  createAuthIntent: (
    document: AuthIntentDocument,
  ) => Promise<"created" | "exists">;
  createXFlow: (
    document: XRedirectFlowDocument,
  ) => Promise<"created" | "exists">;
  getAuthIntent: (intentId: string) => Promise<AuthIntentRecord | null>;
  getLinkedAuthMethods: (
    uid: string,
    firebaseIdToken: string,
  ) => Promise<LinkedAuthMethodsResponse>;
  getProfileClaimSource: (
    uid: string,
    firebaseIdToken: string,
  ) => Promise<LinkedAuthMethodsResponse>;
};

export type XRedirectFlow = {
  returnUrl: string;
  consentSource: string;
  status: string;
  errorCode: string;
  expiresAtMs: number;
  createdAtMs: number;
  callbackUri: string;
  codeVerifier: string;
};

export type XFlowRepository = {
  getFlow: (flowId: string) => Promise<XRedirectFlow | null>;
  updateFlow: (
    flowId: string,
    updates: Record<string, FirestoreScalar>,
  ) => Promise<void>;
};

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

function readFirestoreInteger(
  fields: Record<string, unknown>,
  name: string,
): number {
  const value = toRecord(fields[name]);
  const raw = value?.integerValue;
  const parsed =
    typeof raw === "string" || typeof raw === "number" ? Number(raw) : 0;
  return Number.isSafeInteger(parsed) ? parsed : 0;
}

export function parseXRedirectFlowDocument(value: unknown): XRedirectFlow {
  const document = toRecord(value);
  const fields = toRecord(document?.fields);
  if (!fields) {
    throw new FirestoreFailure();
  }
  return {
    returnUrl: readFirestoreString(fields, "returnUrl"),
    consentSource: readFirestoreString(fields, "consentSource"),
    status: readFirestoreString(fields, "status"),
    errorCode: readFirestoreString(fields, "errorCode"),
    expiresAtMs: readFirestoreInteger(fields, "expiresAtMs"),
    createdAtMs: readFirestoreInteger(fields, "createdAtMs"),
    callbackUri: readFirestoreString(fields, "callbackUri"),
    codeVerifier: readFirestoreString(fields, "codeVerifier"),
  };
}

function encodeFirestoreValue(value: FirestoreScalar): Record<string, unknown> {
  if (value === null) {
    return { nullValue: null };
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new FirestoreFailure();
    }
    return { integerValue: String(value) };
  }
  return { stringValue: value };
}

function documentUrl(flowId: string): string {
  return `${FIRESTORE_DOCUMENTS_ROOT}/${X_FLOW_COLLECTION}/${encodeURIComponent(flowId)}`;
}

function createAuthorizedFetch(
  fetcher: typeof fetch,
  getAccessToken: () => Promise<string>,
  timeoutMs: number,
) {
  return async (input: string, init: RequestInit = {}): Promise<Response> => {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${await getAccessToken()}`);
    try {
      return await fetcher(input, {
        ...init,
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new FirestoreFailure();
    }
  };
}

function encodeDocumentFields(
  fields: Record<string, FirestoreScalar>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(fields).map(([name, value]) => [
      name,
      encodeFirestoreValue(value),
    ]),
  );
}

export function createXFlowRepository(
  env: Env,
  {
    fetcher = fetch,
    now = Date.now,
    timeoutMs = FIRESTORE_TIMEOUT_MS,
    getAccessToken = createGoogleAccessToken,
  }: {
    fetcher?: typeof fetch;
    now?: () => number;
    timeoutMs?: number;
    getAccessToken?: typeof createGoogleAccessToken;
  } = {},
): XFlowRepository {
  let accessToken: Promise<string> | null = null;
  const authorizedFetch = createAuthorizedFetch(
    fetcher,
    () => {
      accessToken ||= getAccessToken(env, { fetcher, now, timeoutMs });
      return accessToken;
    },
    timeoutMs,
  );

  return {
    async getFlow(flowId) {
      const response = await authorizedFetch(documentUrl(flowId));
      if (response.status === 404) {
        await cancelResponseBody(response);
        return null;
      }
      if (!response.ok) {
        await cancelResponseBody(response);
        throw new FirestoreFailure();
      }
      return parseXRedirectFlowDocument(
        await readBoundedJsonValue(
          response,
          MAX_FIRESTORE_BODY_BYTES,
          () => new FirestoreFailure(),
        ),
      );
    },

    async updateFlow(flowId, updates) {
      const names = Object.keys(updates);
      if (names.length === 0) {
        throw new FirestoreFailure();
      }
      const url = new URL(documentUrl(flowId));
      for (const name of names) {
        url.searchParams.append("updateMask.fieldPaths", name);
      }
      url.searchParams.set("currentDocument.exists", "true");
      const fields = encodeDocumentFields(updates);
      const response = await authorizedFetch(url.toString(), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fields }),
      });
      await cancelResponseBody(response);
      if (!response.ok) {
        throw new FirestoreFailure();
      }
    },
  };
}

function parseAuthIntent(value: unknown): AuthIntentRecord {
  const document = toRecord(value);
  const fields = toRecord(document?.fields);
  if (!fields) {
    throw new FirestoreFailure();
  }
  return {
    consumedAtMs: readFirestoreInteger(fields, "consumedAtMs"),
    expiresAtMs: readFirestoreInteger(fields, "expiresAtMs"),
    method: readFirestoreString(fields, "method"),
    uid: readFirestoreString(fields, "uid"),
  };
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
  env: Env,
  {
    fetcher = fetch,
    now = Date.now,
    timeoutMs = FIRESTORE_TIMEOUT_MS,
    getAccessToken = createGoogleAccessToken,
  }: {
    fetcher?: typeof fetch;
    now?: () => number;
    timeoutMs?: number;
    getAccessToken?: typeof createGoogleAccessToken;
  } = {},
): AuthRepository {
  let accessToken: Promise<string> | null = null;
  const authorizedFetch = createAuthorizedFetch(
    fetcher,
    () => {
      accessToken ||= getAccessToken(env, { fetcher, now, timeoutMs });
      return accessToken;
    },
    timeoutMs,
  );

  const createDocument = async (
    collectionId: string,
    documentId: string,
    fields: Record<string, FirestoreScalar>,
  ): Promise<"created" | "exists"> => {
    const url = new URL(`${FIRESTORE_DOCUMENTS_ROOT}/${collectionId}`);
    url.searchParams.set("documentId", documentId);
    const response = await authorizedFetch(url.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fields: encodeDocumentFields(fields) }),
    });
    if (response.status === 409) {
      await cancelResponseBody(response);
      return "exists";
    }
    await cancelResponseBody(response);
    if (!response.ok) {
      throw new FirestoreFailure();
    }
    return "created";
  };

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
    createAuthIntent(document) {
      return createDocument(
        AUTH_INTENT_COLLECTION,
        document.intentId,
        document,
      );
    },

    createXFlow(document) {
      return createDocument(X_FLOW_COLLECTION, document.flowId, document);
    },

    async getAuthIntent(intentId) {
      const response = await authorizedFetch(
        `${FIRESTORE_DOCUMENTS_ROOT}/${AUTH_INTENT_COLLECTION}/${encodeURIComponent(intentId)}`,
      );
      if (response.status === 404) {
        await cancelResponseBody(response);
        return null;
      }
      if (!response.ok) {
        await cancelResponseBody(response);
        throw new FirestoreFailure();
      }
      return parseAuthIntent(
        await readBoundedJsonValue(
          response,
          MAX_FIRESTORE_BODY_BYTES,
          () => new FirestoreFailure(),
        ),
      );
    },

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
