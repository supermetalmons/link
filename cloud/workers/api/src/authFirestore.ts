import { cancelResponseBody } from "./boundedStreams.ts";
import { createGoogleAccessToken } from "./googleAuth.ts";
import { secureAlphanumericId } from "./authRandom.ts";
import {
  createFirestoreRestCodec,
  createFirestoreRestTransport,
  toFirestoreRecord,
} from "./firestoreRest.ts";

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
    fieldPaths?: string[],
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

const codec = createFirestoreRestCodec(() => new AuthFirestoreFailure());
const toRecord = toFirestoreRecord;

export function encodeFields(
  fields: Record<string, unknown>,
): Record<string, FirestoreValue> {
  return codec.encodeFields(fields);
}

function parseDocument(value: unknown): AuthFirestoreDocument {
  const document = codec.parseDocument(value);
  const name = document.name;
  const id = name.split("/").pop() || "";
  if (!id) {
    throw new AuthFirestoreFailure();
  }
  return {
    name,
    id,
    rawFields: document.fields as Record<string, FirestoreValue>,
    fields: codec.decodeFields(document.fields),
    updateTime: document.updateTime || "",
  };
}

function parseQuery(value: unknown): AuthFirestoreDocument[] {
  return codec.parseDocuments(value).map(parseDocument);
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
      value: encodeFields({ value }).value,
    },
  };
}

export function createAuthFirestoreClient(
  env: Env,
  {
    accessTokenProvider,
    fetcher = fetch,
    getAccessToken = createGoogleAccessToken,
    maxTransactionAttempts = MAX_TRANSACTION_ATTEMPTS,
    now = Date.now,
    profileProjectionCommitted,
    signal,
    timeoutMs = FIRESTORE_TIMEOUT_MS,
  }: {
    accessTokenProvider?: () => Promise<string>;
    fetcher?: typeof fetch;
    getAccessToken?: typeof createGoogleAccessToken;
    maxTransactionAttempts?: number;
    now?: () => number;
    profileProjectionCommitted?: (profileId: string) => Promise<void> | void;
    signal?: AbortSignal;
    timeoutMs?: number;
  } = {},
): AuthFirestoreClient {
  const transport = createFirestoreRestTransport({
    createFailure: () => new AuthFirestoreFailure(),
    documentsRoot: AUTH_FIRESTORE_DOCUMENTS_ROOT,
    fetcher,
    getAccessToken:
      accessTokenProvider ||
      (() =>
        getAccessToken(env, {
          credentials: {
            email: env.FIREBASE_IDENTITY_SERVICE_ACCOUNT_EMAIL,
            privateKeyPem: env.FIREBASE_IDENTITY_SERVICE_ACCOUNT_PRIVATE_KEY,
          },
          fetcher,
          now,
          signal,
          timeoutMs,
        })),
    maxBodyBytes: MAX_FIRESTORE_METADATA_BODY_BYTES,
    signal,
    timeoutMs,
  });
  const { post, readJson, request } = transport;
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
  const commit = async (
    writes: AuthFirestoreWrite[],
    transaction?: string,
  ): Promise<"committed" | "conflict"> => transport.commit(writes, transaction);
  const attempts = Math.max(1, Math.floor(maxTransactionAttempts));
  const userDocumentPrefix = `${AUTH_FIRESTORE_DATABASE_ROOT}/documents/users/`;
  const profileIdForWrite = (write: AuthFirestoreWrite): string | null => {
    const name = "update" in write ? write.update.name : write.delete;
    if (!name.startsWith(userDocumentPrefix)) {
      return null;
    }
    const profileId = name.slice(userDocumentPrefix.length);
    return profileId && !profileId.includes("/") ? profileId : null;
  };
  const notifyProfileProjections = async (
    profileIds: Iterable<string>,
  ): Promise<void> => {
    if (!profileProjectionCommitted) {
      return;
    }
    for (const profileId of new Set(profileIds)) {
      try {
        await profileProjectionCommitted(profileId);
      } catch {
        console.error(
          JSON.stringify({ event: "profile_read_projection_enqueue_failed" }),
        );
      }
    }
  };

  return {
    batchGet: (names) => batchGet(names),
    async commitWrites(writes) {
      for (let index = 0; index < writes.length; index += 400) {
        const chunk = writes.slice(index, index + 400);
        const result = await commit(chunk);
        if (result !== "committed") {
          throw new AuthFirestoreConflict();
        }
        await notifyProfileProjections(
          chunk.flatMap((write) => {
            const profileId = profileIdForWrite(write);
            return profileId ? [profileId] : [];
          }),
        );
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
    async listPage(parent, collectionId, pageToken = "", fieldPaths = []) {
      const base = parent
        ? `${AUTH_FIRESTORE_DOCUMENTS_ROOT}/${parent}/${collectionId}`
        : `${AUTH_FIRESTORE_DOCUMENTS_ROOT}/${collectionId}`;
      const url = new URL(base);
      url.searchParams.set("pageSize", "100");
      if (pageToken) {
        url.searchParams.set("pageToken", pageToken);
      }
      for (const fieldPath of fieldPaths) {
        url.searchParams.append("mask.fieldPaths", fieldPath);
      }
      const body = toRecord(
        await readJson(
          await request(url.toString()),
          fieldPaths.length
            ? MAX_FIRESTORE_METADATA_BODY_BYTES
            : MAX_FIRESTORE_BATCH_BODY_BYTES,
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
        const id = await transport.beginTransaction(retryTransaction);
        try {
          const operation = await work({
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
            await transport.rollback(id);
            return operation.result;
          }
          const outcome = await commit(operation.writes, id);
          if (outcome === "committed") {
            await notifyProfileProjections(
              operation.writes.flatMap((write) => {
                const profileId = profileIdForWrite(write);
                return profileId ? [profileId] : [];
              }),
            );
            return operation.result;
          }
          retryTransaction = id;
        } catch (error) {
          await transport.rollback(id);
          throw error;
        }
      }
      throw new AuthFirestoreFailure();
    },
  };
}
