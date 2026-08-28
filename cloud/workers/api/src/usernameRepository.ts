import {
  USERNAME_LOOKUP_KEY_FIELD,
  buildUsernameLookupKey,
  getUsernameIndexDocIds,
} from "@mons/shared/usernames";
import { cancelResponseBody, readBoundedJsonValue } from "./boundedStreams.ts";
import { createGoogleAccessToken } from "./googleAuth.ts";

const FIRESTORE_PROJECT_ID = "mons-link";
const FIRESTORE_DATABASE_ID = "(default)";
const FIRESTORE_DATABASE_ROOT = `projects/${FIRESTORE_PROJECT_ID}/databases/${FIRESTORE_DATABASE_ID}`;
const FIRESTORE_API_ROOT = `https://firestore.googleapis.com/v1/${FIRESTORE_DATABASE_ROOT}`;
const FIRESTORE_DOCUMENTS_ROOT = `${FIRESTORE_API_ROOT}/documents`;
const FIRESTORE_TIMEOUT_MS = 5_000;
const MAX_FIRESTORE_BODY_BYTES = 256 * 1024;
const MAX_TRANSACTION_ATTEMPTS = 5;

type FirestoreDocument = {
  fields: Record<string, unknown>;
  name: string;
};

type FirestoreWrite =
  | {
      delete: string;
      currentDocument: { exists: true };
    }
  | {
      update: FirestoreDocument;
      updateMask: { fieldPaths: string[] };
      currentDocument?: { exists: true };
    };

export type UsernameEditOutcome =
  "cannot-clear" | "profile-not-found" | "taken" | "updated";

export type UsernameRepository = {
  editUsername: (uid: string, username: string) => Promise<UsernameEditOutcome>;
};

type UsernameRepositoryDependencies = {
  fetcher?: typeof fetch;
  getAccessToken?: typeof createGoogleAccessToken;
  maxTransactionAttempts?: number;
  now?: () => number;
  projectionCommitted?: (profileId: string) => Promise<void> | void;
  timeoutMs?: number;
};

export class UsernameRepositoryFailure extends Error {
  constructor() {
    super("username-repository-unavailable");
  }
}

function toRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(fields: Record<string, unknown>, name: string): string {
  const value = toRecord(fields[name]);
  return typeof value?.stringValue === "string" ? value.stringValue.trim() : "";
}

function documentId(document: FirestoreDocument): string {
  const prefix = `${FIRESTORE_DATABASE_ROOT}/documents/users/`;
  if (!document.name.startsWith(prefix)) {
    throw new UsernameRepositoryFailure();
  }
  const id = document.name.slice(prefix.length);
  if (!id || id.includes("/")) {
    throw new UsernameRepositoryFailure();
  }
  return id;
}

function documentName(collection: string, id: string): string {
  if (!id || id.includes("/")) {
    throw new UsernameRepositoryFailure();
  }
  return `${FIRESTORE_DATABASE_ROOT}/documents/${collection}/${id}`;
}

function parseDocument(value: unknown): FirestoreDocument {
  const record = toRecord(value);
  const fields = record?.fields === undefined ? {} : toRecord(record.fields);
  if (typeof record?.name !== "string" || fields === null) {
    throw new UsernameRepositoryFailure();
  }
  return { name: record.name, fields };
}

function parseQueryDocuments(value: unknown): FirestoreDocument[] {
  if (!Array.isArray(value)) {
    throw new UsernameRepositoryFailure();
  }
  const documents: FirestoreDocument[] = [];
  for (const entry of value) {
    const record = toRecord(entry);
    if (record?.document !== undefined) {
      documents.push(parseDocument(record.document));
    }
  }
  return documents;
}

function selectFields(fieldPaths: string[]): Array<{ fieldPath: string }> {
  return fieldPaths.map((fieldPath) => ({ fieldPath }));
}

function fieldFilter(
  fieldPath: string,
  op: string,
  value: Record<string, unknown>,
): Record<string, unknown> {
  return {
    fieldFilter: {
      field: { fieldPath },
      op,
      value,
    },
  };
}

function updateWrite(
  name: string,
  fields: Record<string, unknown>,
  fieldPaths: string[],
  requireExisting = false,
): FirestoreWrite {
  return {
    update: { name, fields },
    updateMask: { fieldPaths },
    ...(requireExisting ? { currentDocument: { exists: true as const } } : {}),
  };
}

export function createUsernameRepository(
  env: Env,
  {
    fetcher = fetch,
    getAccessToken = createGoogleAccessToken,
    maxTransactionAttempts = MAX_TRANSACTION_ATTEMPTS,
    now = Date.now,
    projectionCommitted,
    timeoutMs = FIRESTORE_TIMEOUT_MS,
  }: UsernameRepositoryDependencies = {},
): UsernameRepository {
  const attempts =
    Number.isInteger(maxTransactionAttempts) && maxTransactionAttempts > 0
      ? maxTransactionAttempts
      : MAX_TRANSACTION_ATTEMPTS;
  let accessToken: Promise<string> | null = null;
  const notifyProfileProjection = async (profileId: string): Promise<void> => {
    try {
      await projectionCommitted?.(profileId);
    } catch {
      console.error(
        JSON.stringify({ event: "profile_read_projection_enqueue_failed" }),
      );
    }
  };
  const token = () => {
    accessToken ||= getAccessToken(env, {
      credentials: {
        email: env.USERNAME_SERVICE_ACCOUNT_EMAIL,
        privateKeyPem: env.USERNAME_SERVICE_ACCOUNT_PRIVATE_KEY,
      },
      fetcher,
      now,
      timeoutMs,
    }).catch(() => {
      throw new UsernameRepositoryFailure();
    });
    return accessToken;
  };
  const request = async (
    input: string,
    init: RequestInit,
  ): Promise<Response> => {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${await token()}`);
    try {
      return await fetcher(input, {
        ...init,
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new UsernameRepositoryFailure();
    }
  };
  const readJson = async (response: Response): Promise<unknown> => {
    if (!response.ok) {
      await cancelResponseBody(response);
      throw new UsernameRepositoryFailure();
    }
    return readBoundedJsonValue(
      response,
      MAX_FIRESTORE_BODY_BYTES,
      () => new UsernameRepositoryFailure(),
    );
  };
  const postJson = (input: string, body: unknown) =>
    request(input, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  const beginTransaction = async (
    retryTransaction?: string,
  ): Promise<string> => {
    const response = await postJson(
      `${FIRESTORE_DOCUMENTS_ROOT}:beginTransaction`,
      {
        options: {
          readWrite: retryTransaction ? { retryTransaction } : {},
        },
      },
    );
    const body = toRecord(await readJson(response));
    const transaction =
      typeof body?.transaction === "string" ? body.transaction.trim() : "";
    if (!transaction) {
      throw new UsernameRepositoryFailure();
    }
    return transaction;
  };
  const rollback = async (transaction: string): Promise<void> => {
    try {
      const response = await postJson(`${FIRESTORE_DOCUMENTS_ROOT}:rollback`, {
        transaction,
      });
      await cancelResponseBody(response);
    } catch {}
  };
  const runQuery = async (
    transaction: string,
    where: Record<string, unknown>,
    fields: string[],
    limit: number,
  ): Promise<FirestoreDocument[]> => {
    const response = await postJson(`${FIRESTORE_DOCUMENTS_ROOT}:runQuery`, {
      structuredQuery: {
        select: { fields: selectFields(fields) },
        from: [{ collectionId: "users" }],
        where,
        limit,
      },
      transaction,
    });
    return parseQueryDocuments(await readJson(response));
  };
  const batchGet = async (
    transaction: string,
    names: string[],
    fields: string[],
  ): Promise<Map<string, FirestoreDocument | null>> => {
    const uniqueNames = Array.from(new Set(names));
    if (uniqueNames.length === 0) {
      return new Map();
    }
    const response = await postJson(`${FIRESTORE_DOCUMENTS_ROOT}:batchGet`, {
      documents: uniqueNames,
      mask: { fieldPaths: fields },
      transaction,
    });
    const body = await readJson(response);
    if (!Array.isArray(body)) {
      throw new UsernameRepositoryFailure();
    }
    const results = new Map<string, FirestoreDocument | null>();
    for (const entry of body) {
      const record = toRecord(entry);
      if (record?.found !== undefined) {
        const document = parseDocument(record.found);
        results.set(document.name, document);
      } else if (typeof record?.missing === "string") {
        results.set(record.missing, null);
      }
    }
    if (uniqueNames.some((name) => !results.has(name))) {
      throw new UsernameRepositoryFailure();
    }
    return results;
  };
  const finishWithoutWrites = async (
    transaction: string,
    outcome: UsernameEditOutcome,
  ): Promise<UsernameEditOutcome> => {
    await rollback(transaction);
    return outcome;
  };
  const commit = async (
    transaction: string,
    writes: FirestoreWrite[],
  ): Promise<"committed" | "conflict"> => {
    const response = await postJson(`${FIRESTORE_DOCUMENTS_ROOT}:commit`, {
      writes,
      transaction,
    });
    if (response.ok) {
      await cancelResponseBody(response);
      return "committed";
    }
    if (response.status === 409 || response.status === 412) {
      await cancelResponseBody(response);
      return "conflict";
    }
    await cancelResponseBody(response);
    throw new UsernameRepositoryFailure();
  };

  return {
    async editUsername(uid, username) {
      const resolvedUid = uid.trim();
      const resolvedUsername = username.trim();
      if (!resolvedUid) {
        throw new UsernameRepositoryFailure();
      }
      const updatedAtMs = now();
      let retryTransaction: string | undefined;

      for (let attempt = 0; attempt < attempts; attempt++) {
        const transaction = await beginTransaction(retryTransaction);
        try {
          const profiles = await runQuery(
            transaction,
            fieldFilter("logins", "ARRAY_CONTAINS", {
              stringValue: resolvedUid,
            }),
            [
              "appleSub",
              "eth",
              "sol",
              "username",
              USERNAME_LOOKUP_KEY_FIELD,
              "xUserId",
            ],
            1,
          );
          const profile = profiles[0];
          if (!profile) {
            return finishWithoutWrites(transaction, "profile-not-found");
          }
          const profileId = documentId(profile);
          const currentUsername = readString(profile.fields, "username");
          if (currentUsername === resolvedUsername) {
            return finishWithoutWrites(transaction, "updated");
          }

          if (!resolvedUsername) {
            const hasApple = readString(profile.fields, "appleSub") !== "";
            const hasX = readString(profile.fields, "xUserId") !== "";
            const hasEth = readString(profile.fields, "eth") !== "";
            const hasSol = readString(profile.fields, "sol") !== "";
            if ((hasApple || hasX) && !hasEth && !hasSol) {
              return finishWithoutWrites(transaction, "cannot-clear");
            }
            const indexNames = getUsernameIndexDocIds(currentUsername).map(
              (id) => documentName("usernameIndex", id),
            );
            const indexes = await batchGet(transaction, indexNames, [
              "profileId",
            ]);
            const writes: FirestoreWrite[] = [];
            for (const name of indexNames) {
              const index = indexes.get(name);
              if (
                index &&
                readString(index.fields, "profileId") === profileId
              ) {
                writes.push({
                  delete: name,
                  currentDocument: { exists: true },
                });
              }
            }
            writes.push(
              updateWrite(
                profile.name,
                { username: { stringValue: "" } },
                ["username", USERNAME_LOOKUP_KEY_FIELD],
                true,
              ),
            );
            const result = await commit(transaction, writes);
            if (result === "committed") {
              await notifyProfileProjection(profileId);
              return "updated";
            }
            if (attempt === attempts - 1) {
              throw new UsernameRepositoryFailure();
            }
            retryTransaction = transaction;
            continue;
          }

          const usernameKey = buildUsernameLookupKey(resolvedUsername);
          const canonicalName = documentName("usernameIndex", usernameKey);
          const legacyName =
            usernameKey === resolvedUsername
              ? null
              : documentName("usernameIndex", resolvedUsername);
          const candidateNames = [
            canonicalName,
            ...(legacyName ? [legacyName] : []),
          ];
          const candidateIndexes = await batchGet(transaction, candidateNames, [
            "profileId",
          ]);
          const indexedProfileIds = Array.from(
            new Set(
              candidateNames
                .map((name) => candidateIndexes.get(name))
                .filter(
                  (entry): entry is FirestoreDocument =>
                    entry !== null && entry !== undefined,
                )
                .map((entry) => readString(entry.fields, "profileId"))
                .filter((id) => id && id !== profileId),
            ),
          );
          const indexedProfileNames = indexedProfileIds.map((id) =>
            documentName("users", id),
          );
          const indexedProfiles = await batchGet(
            transaction,
            indexedProfileNames,
            ["username"],
          );
          const staleIndexNames = new Set<string>();
          let taken = false;
          for (const name of candidateNames) {
            const index = candidateIndexes.get(name);
            if (!index) {
              continue;
            }
            const indexedProfileId = readString(index.fields, "profileId");
            if (!indexedProfileId || indexedProfileId === profileId) {
              continue;
            }
            const indexedProfile = indexedProfiles.get(
              documentName("users", indexedProfileId),
            );
            if (!indexedProfile) {
              continue;
            }
            const indexedUsername = readString(
              indexedProfile.fields,
              "username",
            );
            if (buildUsernameLookupKey(indexedUsername) === usernameKey) {
              taken = true;
              break;
            }
            if (!indexedUsername) {
              staleIndexNames.add(name);
            }
          }

          const lookupMatches = taken
            ? []
            : await runQuery(
                transaction,
                fieldFilter(USERNAME_LOOKUP_KEY_FIELD, "EQUAL", {
                  stringValue: usernameKey,
                }),
                ["username"],
                2,
              );
          if (
            !taken &&
            lookupMatches.some(
              (document) =>
                documentId(document) !== profileId &&
                buildUsernameLookupKey(
                  readString(document.fields, "username"),
                ) === usernameKey,
            )
          ) {
            taken = true;
          }
          const exactMatches = taken
            ? []
            : await runQuery(
                transaction,
                fieldFilter("username", "EQUAL", {
                  stringValue: resolvedUsername,
                }),
                ["username"],
                2,
              );
          if (
            !taken &&
            exactMatches.some((document) => documentId(document) !== profileId)
          ) {
            taken = true;
          }
          if (!taken && usernameKey !== resolvedUsername) {
            const lowercaseMatches = await runQuery(
              transaction,
              fieldFilter("username", "EQUAL", { stringValue: usernameKey }),
              ["username"],
              2,
            );
            if (
              lowercaseMatches.some(
                (document) => documentId(document) !== profileId,
              )
            ) {
              taken = true;
            }
          }
          if (taken) {
            return finishWithoutWrites(transaction, "taken");
          }

          const currentUsernameKey = buildUsernameLookupKey(currentUsername);
          const deleteNames = new Set<string>(staleIndexNames);
          if (currentUsernameKey && currentUsernameKey !== usernameKey) {
            deleteNames.add(documentName("usernameIndex", currentUsernameKey));
          }
          if (
            currentUsername &&
            currentUsername !== currentUsernameKey &&
            currentUsername !== resolvedUsername
          ) {
            deleteNames.add(documentName("usernameIndex", currentUsername));
          }
          if (legacyName) {
            deleteNames.add(legacyName);
          }
          deleteNames.delete(canonicalName);
          const deleteIndexes = await batchGet(
            transaction,
            Array.from(deleteNames),
            ["profileId"],
          );
          const writes: FirestoreWrite[] = [];
          for (const name of deleteNames) {
            const index = deleteIndexes.get(name);
            if (
              index &&
              (staleIndexNames.has(name) ||
                readString(index.fields, "profileId") === profileId)
            ) {
              writes.push({
                delete: name,
                currentDocument: { exists: true },
              });
            }
          }
          writes.push(
            updateWrite(
              canonicalName,
              {
                lookupKey: { stringValue: usernameKey },
                profileId: { stringValue: profileId },
                updatedAtMs: { integerValue: String(updatedAtMs) },
                username: { stringValue: resolvedUsername },
              },
              ["lookupKey", "profileId", "updatedAtMs", "username"],
            ),
            updateWrite(
              profile.name,
              {
                username: { stringValue: resolvedUsername },
                [USERNAME_LOOKUP_KEY_FIELD]: { stringValue: usernameKey },
              },
              ["username", USERNAME_LOOKUP_KEY_FIELD],
              true,
            ),
          );
          const result = await commit(transaction, writes);
          if (result === "committed") {
            await notifyProfileProjection(profileId);
            return "updated";
          }
          if (attempt === attempts - 1) {
            throw new UsernameRepositoryFailure();
          }
          retryTransaction = transaction;
        } catch (error) {
          await rollback(transaction);
          if (error instanceof UsernameRepositoryFailure) {
            throw error;
          }
          throw new UsernameRepositoryFailure();
        }
      }
      throw new UsernameRepositoryFailure();
    },
  };
}

export {
  FIRESTORE_API_ROOT,
  FIRESTORE_DATABASE_ROOT,
  FIRESTORE_DOCUMENTS_ROOT,
  MAX_FIRESTORE_BODY_BYTES,
  MAX_TRANSACTION_ATTEMPTS,
};
