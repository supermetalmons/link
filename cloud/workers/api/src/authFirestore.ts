import { cancelResponseBody, readBoundedJsonValue } from "./boundedStreams.ts";
import { createGoogleAccessToken } from "./googleAuth.ts";
import { secureAlphanumericId } from "./authRandom.ts";

const FIRESTORE_PROJECT_ID = "mons-link";
const FIRESTORE_DATABASE_ID = "(default)";
export const AUTH_FIRESTORE_DATABASE_ROOT = `projects/${FIRESTORE_PROJECT_ID}/databases/${FIRESTORE_DATABASE_ID}`;
export const AUTH_FIRESTORE_API_ROOT = `https://firestore.googleapis.com/v1/${AUTH_FIRESTORE_DATABASE_ROOT}`;
export const AUTH_FIRESTORE_DOCUMENTS_ROOT = `${AUTH_FIRESTORE_API_ROOT}/documents`;
const FIRESTORE_TIMEOUT_MS = 5_000;
const MAX_FIRESTORE_METADATA_BODY_BYTES = 1024 * 1024;
const MAX_FIRESTORE_DOCUMENT_BODY_BYTES = 8 * 1024 * 1024;
const MAX_FIRESTORE_QUERY_BODY_BYTES = 16 * 1024 * 1024;
const MAX_FIRESTORE_BATCH_BODY_BYTES = 32 * 1024 * 1024;
const MAX_TRANSACTION_ATTEMPTS = 5;

type FirestoreValue = Record<string, unknown>;
const PRESERVED_FIRESTORE_VALUE = Symbol("preservedFirestoreValue");

export type AuthFirestoreDocument = {
  fields: Record<string, unknown>;
  id: string;
  name: string;
  rawFields: Record<string, FirestoreValue>;
  updateTime: string;
};

type FirestorePrecondition = {
  exists?: boolean;
  updateTime?: string;
};

export type AuthFirestorePage = {
  documents: AuthFirestoreDocument[];
  nextPageToken: string;
};

export type AuthFirestoreWrite =
  | { delete: string; currentDocument?: FirestorePrecondition }
  | {
      update: { name: string; fields: Record<string, FirestoreValue> };
      updateMask: { fieldPaths: string[] };
      currentDocument?: FirestorePrecondition;
    };

export type AuthFirestoreTransaction = {
  id: string;
  batchGet: (
    names: string[],
  ) => Promise<Map<string, AuthFirestoreDocument | null>>;
  query: (
    collectionId: string,
    where: Record<string, unknown>,
    limit?: number,
    fieldPaths?: string[],
    startAfterDocumentId?: string,
  ) => Promise<AuthFirestoreDocument[]>;
};

export type AuthFirestoreClient = {
  batchGet: (
    names: string[],
  ) => Promise<Map<string, AuthFirestoreDocument | null>>;
  commitWrites: (writes: AuthFirestoreWrite[]) => Promise<void>;
  createDocumentId: () => string;
  get: (name: string) => Promise<AuthFirestoreDocument | null>;
  listPage: (
    parent: string,
    collectionId: string,
    pageToken?: string,
  ) => Promise<AuthFirestorePage>;
  query: (
    collectionId: string,
    where: Record<string, unknown>,
    limit?: number,
    fieldPaths?: string[],
    startAfterDocumentId?: string,
  ) => Promise<AuthFirestoreDocument[]>;
  runTransaction: <T>(
    work: (
      transaction: AuthFirestoreTransaction,
    ) => Promise<{ result: T; writes: AuthFirestoreWrite[] }>,
  ) => Promise<T>;
};

export class AuthFirestoreFailure extends Error {
  constructor() {
    super("auth-firestore-unavailable");
  }
}

export class AuthFirestoreConflict extends AuthFirestoreFailure {}

function toRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function preserveFirestoreValue<T extends Record<string, unknown>>(
  value: T,
): T {
  Object.defineProperty(value, PRESERVED_FIRESTORE_VALUE, { value: true });
  return value;
}

function isPreservedFirestoreValue(value: Record<string, unknown>): boolean {
  return Object.hasOwn(value, PRESERVED_FIRESTORE_VALUE);
}

function isNonFiniteDouble(value: unknown): value is string {
  return value === "NaN" || value === "Infinity" || value === "-Infinity";
}

function decodeValue(value: unknown): unknown {
  const record = toRecord(value);
  if (!record) {
    throw new AuthFirestoreFailure();
  }
  if (Object.hasOwn(record, "nullValue")) {
    return null;
  }
  if (typeof record.booleanValue === "boolean") {
    return record.booleanValue;
  }
  if (
    typeof record.integerValue === "string" ||
    typeof record.integerValue === "number"
  ) {
    const raw = String(record.integerValue);
    let parsed: bigint;
    try {
      parsed = BigInt(raw);
    } catch {
      throw new AuthFirestoreFailure();
    }
    return parsed <= BigInt(Number.MAX_SAFE_INTEGER) &&
      parsed >= BigInt(Number.MIN_SAFE_INTEGER)
      ? Number(parsed)
      : preserveFirestoreValue({ __firestoreInteger: raw });
  }
  if (typeof record.doubleValue === "number") {
    return Number.isFinite(record.doubleValue)
      ? record.doubleValue
      : preserveFirestoreValue({
          __firestoreDouble: String(record.doubleValue),
        });
  }
  if (isNonFiniteDouble(record.doubleValue)) {
    return preserveFirestoreValue({
      __firestoreDouble: record.doubleValue,
    });
  }
  if (typeof record.stringValue === "string") {
    return record.stringValue;
  }
  if (typeof record.timestampValue === "string") {
    return preserveFirestoreValue({
      __firestoreTimestamp: record.timestampValue,
    });
  }
  if (typeof record.bytesValue === "string") {
    return preserveFirestoreValue({ __firestoreBytes: record.bytesValue });
  }
  if (typeof record.referenceValue === "string") {
    return preserveFirestoreValue({
      __firestoreReference: record.referenceValue,
    });
  }
  const geoPoint = toRecord(record.geoPointValue);
  if (
    geoPoint &&
    typeof geoPoint.latitude === "number" &&
    typeof geoPoint.longitude === "number"
  ) {
    return preserveFirestoreValue({
      __firestoreGeoPoint: {
        latitude: geoPoint.latitude,
        longitude: geoPoint.longitude,
      },
    });
  }
  const array = toRecord(record.arrayValue);
  if (array) {
    const values = array.values === undefined ? [] : array.values;
    if (!Array.isArray(values)) {
      throw new AuthFirestoreFailure();
    }
    return values.map(decodeValue);
  }
  const map = toRecord(record.mapValue);
  if (map) {
    const fields = map.fields === undefined ? {} : toRecord(map.fields);
    if (!fields) {
      throw new AuthFirestoreFailure();
    }
    return decodeFields(fields);
  }
  throw new AuthFirestoreFailure();
}

function decodeFields(
  fields: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [key, decodeValue(value)]),
  );
}

function encodeValue(value: unknown): FirestoreValue {
  if (value === null || value === undefined) {
    return { nullValue: null };
  }
  if (typeof value === "boolean") {
    return { booleanValue: value };
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new AuthFirestoreFailure();
    }
    return Number.isSafeInteger(value)
      ? { integerValue: String(value) }
      : { doubleValue: value };
  }
  if (typeof value === "string") {
    return { stringValue: value };
  }
  if (Array.isArray(value)) {
    return { arrayValue: { values: value.map(encodeValue) } };
  }
  const record = toRecord(value);
  if (!record) {
    throw new AuthFirestoreFailure();
  }
  if (isPreservedFirestoreValue(record)) {
    if (isNonFiniteDouble(record.__firestoreDouble)) {
      return { doubleValue: record.__firestoreDouble };
    }
    if (typeof record.__firestoreTimestamp === "string") {
      return { timestampValue: record.__firestoreTimestamp };
    }
    if (typeof record.__firestoreInteger === "string") {
      try {
        BigInt(record.__firestoreInteger);
      } catch {
        throw new AuthFirestoreFailure();
      }
      return { integerValue: record.__firestoreInteger };
    }
    if (typeof record.__firestoreBytes === "string") {
      return { bytesValue: record.__firestoreBytes };
    }
    if (typeof record.__firestoreReference === "string") {
      return { referenceValue: record.__firestoreReference };
    }
    const geoPoint = toRecord(record.__firestoreGeoPoint);
    if (
      geoPoint &&
      typeof geoPoint.latitude === "number" &&
      typeof geoPoint.longitude === "number"
    ) {
      return { geoPointValue: geoPoint };
    }
    throw new AuthFirestoreFailure();
  }
  return { mapValue: { fields: encodeFields(record) } };
}

export function encodeFields(
  fields: Record<string, unknown>,
): Record<string, FirestoreValue> {
  return Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [key, encodeValue(value)]),
  );
}

function parseDocument(value: unknown): AuthFirestoreDocument {
  const record = toRecord(value);
  const fields = record?.fields === undefined ? {} : toRecord(record.fields);
  const name = typeof record?.name === "string" ? record.name : "";
  const updateTime =
    typeof record?.updateTime === "string" ? record.updateTime : "";
  const id = name.split("/").pop() || "";
  if (!name || !id || !fields) {
    throw new AuthFirestoreFailure();
  }
  return {
    name,
    id,
    rawFields: fields as Record<string, FirestoreValue>,
    fields: decodeFields(fields),
    updateTime,
  };
}

function parseQuery(value: unknown): AuthFirestoreDocument[] {
  if (!Array.isArray(value)) {
    throw new AuthFirestoreFailure();
  }
  const documents: AuthFirestoreDocument[] = [];
  for (const entry of value) {
    const record = toRecord(entry);
    if (record?.document !== undefined) {
      documents.push(parseDocument(record.document));
    }
  }
  return documents;
}

function isPreconditionConflict(value: unknown): boolean {
  const body = toRecord(value);
  const error = toRecord(body?.error);
  return error?.status === "ABORTED" || error?.status === "FAILED_PRECONDITION";
}

export function authDocumentName(collection: string, id: string): string {
  if (!collection || !id || id.includes("/")) {
    throw new AuthFirestoreFailure();
  }
  return `${AUTH_FIRESTORE_DATABASE_ROOT}/documents/${collection}/${id}`;
}

export function authUpdateWrite(
  name: string,
  fields: Record<string, unknown>,
  fieldPaths = Object.keys(fields),
  precondition?: boolean | FirestorePrecondition,
): AuthFirestoreWrite {
  return {
    update: { name, fields: encodeFields(fields) },
    updateMask: { fieldPaths },
    ...(precondition === undefined
      ? {}
      : {
          currentDocument:
            typeof precondition === "boolean"
              ? { exists: precondition }
              : precondition,
        }),
  };
}

export function authDeleteWrite(
  name: string,
  precondition?: boolean | FirestorePrecondition,
): AuthFirestoreWrite {
  return {
    delete: name,
    ...(precondition === undefined
      ? {}
      : {
          currentDocument:
            typeof precondition === "boolean"
              ? { exists: precondition }
              : precondition,
        }),
  };
}

export function authFieldFilter(
  fieldPath: string,
  op: "ARRAY_CONTAINS" | "EQUAL",
  value: unknown,
): Record<string, unknown> {
  return {
    fieldFilter: {
      field: { fieldPath },
      op,
      value: encodeValue(value),
    },
  };
}

export function createAuthFirestoreClient(
  env: Env,
  {
    fetcher = fetch,
    getAccessToken = createGoogleAccessToken,
    maxTransactionAttempts = MAX_TRANSACTION_ATTEMPTS,
    now = Date.now,
    signal,
    timeoutMs = FIRESTORE_TIMEOUT_MS,
  }: {
    fetcher?: typeof fetch;
    getAccessToken?: typeof createGoogleAccessToken;
    maxTransactionAttempts?: number;
    now?: () => number;
    signal?: AbortSignal;
    timeoutMs?: number;
  } = {},
): AuthFirestoreClient {
  let accessToken: Promise<string> | null = null;
  const token = () => {
    accessToken ||= getAccessToken(env, {
      credentials: {
        email: env.FIRESTORE_SERVICE_ACCOUNT_EMAIL,
        privateKeyPem: env.FIRESTORE_SERVICE_ACCOUNT_PRIVATE_KEY,
      },
      fetcher,
      now,
      timeoutMs,
    }).catch(() => {
      throw new AuthFirestoreFailure();
    });
    return accessToken;
  };
  const request = async (
    input: string,
    init: RequestInit = {},
  ): Promise<Response> => {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${await token()}`);
    try {
      const requestSignal = signal
        ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
        : AbortSignal.timeout(timeoutMs);
      return await fetcher(input, {
        ...init,
        headers,
        signal: requestSignal,
      });
    } catch {
      throw new AuthFirestoreFailure();
    }
  };
  const readJson = async (
    response: Response,
    maxBytes: number,
  ): Promise<unknown> => {
    if (!response.ok) {
      await cancelResponseBody(response);
      throw new AuthFirestoreFailure();
    }
    return readBoundedJsonValue(
      response,
      maxBytes,
      () => new AuthFirestoreFailure(),
    );
  };
  const post = (input: string, body: unknown) =>
    request(input, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  const batchGet = async (
    names: string[],
    transaction?: string,
  ): Promise<Map<string, AuthFirestoreDocument | null>> => {
    const uniqueNames = Array.from(new Set(names));
    if (uniqueNames.length === 0) {
      return new Map();
    }
    const response = await post(`${AUTH_FIRESTORE_DOCUMENTS_ROOT}:batchGet`, {
      documents: uniqueNames,
      ...(transaction ? { transaction } : {}),
    });
    const body = await readJson(response, MAX_FIRESTORE_BATCH_BODY_BYTES);
    if (!Array.isArray(body)) {
      throw new AuthFirestoreFailure();
    }
    const result = new Map<string, AuthFirestoreDocument | null>();
    for (const entry of body) {
      const record = toRecord(entry);
      if (record?.found !== undefined) {
        const document = parseDocument(record.found);
        result.set(document.name, document);
      } else if (typeof record?.missing === "string") {
        result.set(record.missing, null);
      }
    }
    if (uniqueNames.some((name) => !result.has(name))) {
      throw new AuthFirestoreFailure();
    }
    return result;
  };
  const query = async (
    collectionId: string,
    where: Record<string, unknown>,
    limit = 100,
    transaction?: string,
    fieldPaths?: string[],
    startAfterDocumentId?: string,
  ): Promise<AuthFirestoreDocument[]> => {
    const orderByDocumentName = startAfterDocumentId !== undefined;
    const response = await post(`${AUTH_FIRESTORE_DOCUMENTS_ROOT}:runQuery`, {
      structuredQuery: {
        from: [{ collectionId }],
        where,
        limit,
        ...(orderByDocumentName
          ? {
              orderBy: [
                {
                  field: { fieldPath: "__name__" },
                  direction: "ASCENDING",
                },
              ],
            }
          : {}),
        ...(startAfterDocumentId
          ? {
              startAt: {
                values: [
                  {
                    referenceValue: authDocumentName(
                      collectionId,
                      startAfterDocumentId,
                    ),
                  },
                ],
                before: false,
              },
            }
          : {}),
        ...(fieldPaths?.length
          ? {
              select: {
                fields: fieldPaths.map((fieldPath) => ({ fieldPath })),
              },
            }
          : {}),
      },
      ...(transaction ? { transaction } : {}),
    });
    return parseQuery(
      await readJson(
        response,
        fieldPaths?.length
          ? MAX_FIRESTORE_METADATA_BODY_BYTES
          : MAX_FIRESTORE_QUERY_BODY_BYTES,
      ),
    );
  };
  const rollback = async (transaction: string): Promise<void> => {
    try {
      const response = await post(`${AUTH_FIRESTORE_DOCUMENTS_ROOT}:rollback`, {
        transaction,
      });
      await cancelResponseBody(response);
    } catch {}
  };
  const commit = async (
    writes: AuthFirestoreWrite[],
    transaction?: string,
  ): Promise<"committed" | "conflict"> => {
    const response = await post(`${AUTH_FIRESTORE_DOCUMENTS_ROOT}:commit`, {
      writes,
      ...(transaction ? { transaction } : {}),
    });
    if (response.ok) {
      await cancelResponseBody(response);
      return "committed";
    }
    if (response.status === 409 || response.status === 412) {
      await cancelResponseBody(response);
      return "conflict";
    }
    if (response.status === 400) {
      const body = await readBoundedJsonValue(
        response,
        MAX_FIRESTORE_METADATA_BODY_BYTES,
        () => new AuthFirestoreFailure(),
      );
      if (isPreconditionConflict(body)) {
        return "conflict";
      }
      throw new AuthFirestoreFailure();
    }
    await cancelResponseBody(response);
    throw new AuthFirestoreFailure();
  };
  const attempts = Math.max(1, Math.floor(maxTransactionAttempts));

  return {
    batchGet: (names) => batchGet(names),
    async commitWrites(writes) {
      for (let index = 0; index < writes.length; index += 400) {
        const result = await commit(writes.slice(index, index + 400));
        if (result !== "committed") {
          throw new AuthFirestoreConflict();
        }
      }
    },
    createDocumentId: secureAlphanumericId,
    async get(name) {
      const response = await request(
        `https://firestore.googleapis.com/v1/${name}`,
      );
      if (response.status === 404) {
        await cancelResponseBody(response);
        return null;
      }
      return parseDocument(
        await readJson(response, MAX_FIRESTORE_DOCUMENT_BODY_BYTES),
      );
    },
    async listPage(parent, collectionId, pageToken = "") {
      const base = parent
        ? `${AUTH_FIRESTORE_DOCUMENTS_ROOT}/${parent}/${collectionId}`
        : `${AUTH_FIRESTORE_DOCUMENTS_ROOT}/${collectionId}`;
      const url = new URL(base);
      url.searchParams.set("pageSize", "100");
      if (pageToken) {
        url.searchParams.set("pageToken", pageToken);
      }
      const body = toRecord(
        await readJson(
          await request(url.toString()),
          MAX_FIRESTORE_BATCH_BODY_BYTES,
        ),
      );
      const page = body?.documents === undefined ? [] : body.documents;
      if (!Array.isArray(page)) {
        throw new AuthFirestoreFailure();
      }
      return {
        documents: page.map(parseDocument),
        nextPageToken:
          typeof body?.nextPageToken === "string" ? body.nextPageToken : "",
      };
    },
    query: (collectionId, where, limit, fieldPaths, startAfterDocumentId) =>
      query(
        collectionId,
        where,
        limit,
        undefined,
        fieldPaths,
        startAfterDocumentId,
      ),
    async runTransaction(work) {
      let retryTransaction: string | undefined;
      for (let attempt = 0; attempt < attempts; attempt++) {
        const beginResponse = await post(
          `${AUTH_FIRESTORE_DOCUMENTS_ROOT}:beginTransaction`,
          {
            options: {
              readWrite: retryTransaction ? { retryTransaction } : {},
            },
          },
        );
        const beginBody = toRecord(
          await readJson(beginResponse, MAX_FIRESTORE_METADATA_BODY_BYTES),
        );
        const id =
          typeof beginBody?.transaction === "string"
            ? beginBody.transaction
            : "";
        if (!id) {
          throw new AuthFirestoreFailure();
        }
        try {
          const operation = await work({
            id,
            batchGet: (names) => batchGet(names, id),
            query: (
              collectionId,
              where,
              limit,
              fieldPaths,
              startAfterDocumentId,
            ) =>
              query(
                collectionId,
                where,
                limit,
                id,
                fieldPaths,
                startAfterDocumentId,
              ),
          });
          if (operation.writes.length === 0) {
            await rollback(id);
            return operation.result;
          }
          const outcome = await commit(operation.writes, id);
          if (outcome === "committed") {
            return operation.result;
          }
          retryTransaction = id;
        } catch (error) {
          await rollback(id);
          throw error;
        }
      }
      throw new AuthFirestoreFailure();
    },
  };
}
