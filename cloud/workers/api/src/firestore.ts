import { cancelResponseBody, readBoundedJsonValue } from "./boundedStreams.ts";
import { createGoogleAccessToken } from "./googleAuth.ts";

const FIRESTORE_PROJECT_ID = "mons-link";
const FIRESTORE_DATABASE_ID = "(default)";
const X_FLOW_COLLECTION = "xAuthRedirectFlows";
const FIRESTORE_TIMEOUT_MS = 5_000;
const MAX_FIRESTORE_BODY_BYTES = 64 * 1024;

type FirestoreScalar = string | number | null;

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
  return `https://firestore.googleapis.com/v1/projects/${FIRESTORE_PROJECT_ID}/databases/${FIRESTORE_DATABASE_ID}/documents/${X_FLOW_COLLECTION}/${encodeURIComponent(flowId)}`;
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
  const accessToken = getAccessToken(env, { fetcher, now, timeoutMs });

  const authorizedFetch = async (
    input: string,
    init: RequestInit = {},
  ): Promise<Response> => {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${await accessToken}`);
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
      const fields = Object.fromEntries(
        names.map((name) => [name, encodeFirestoreValue(updates[name])]),
      );
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
