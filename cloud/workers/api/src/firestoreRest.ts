import { cancelResponseBody, readBoundedJsonValue } from "./boundedStreams.ts";

export type FirestoreRestDocument = {
  fields: Record<string, unknown>;
  name: string;
  updateTime?: string;
};

type FirestoreRestTransportOptions = {
  createFailure: () => Error;
  documentsRoot: string;
  fetcher: typeof fetch;
  getAccessToken: () => Promise<string>;
  maxBodyBytes: number;
  signal?: AbortSignal;
  timeoutMs: number;
};

const PRESERVED_FIRESTORE_VALUE = Symbol("preservedFirestoreValue");

export function firestoreTimestampFromMillis(millis: number): {
  __firestoreTimestamp: string;
} {
  if (!Number.isFinite(millis)) {
    throw new TypeError("invalid Firestore timestamp");
  }
  const value = {
    __firestoreTimestamp: new Date(
      Math.max(1, Math.floor(millis)),
    ).toISOString(),
  };
  Object.defineProperty(value, PRESERVED_FIRESTORE_VALUE, { value: true });
  return value;
}

export function toFirestoreRecord(
  value: unknown,
): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function createFirestoreRestCodec(createFailure: () => Error) {
  const fail = (): never => {
    throw createFailure();
  };
  const preserve = <T extends Record<string, unknown>>(value: T): T => {
    Object.defineProperty(value, PRESERVED_FIRESTORE_VALUE, { value: true });
    return value;
  };
  const isPreserved = (value: Record<string, unknown>): boolean =>
    Object.hasOwn(value, PRESERVED_FIRESTORE_VALUE);
  const isNonFiniteDouble = (value: unknown): value is string =>
    value === "NaN" || value === "Infinity" || value === "-Infinity";

  const decodeValue = (value: unknown): unknown => {
    const record = toFirestoreRecord(value);
    if (!record) {
      return fail();
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
        return fail();
      }
      return parsed <= BigInt(Number.MAX_SAFE_INTEGER) &&
        parsed >= BigInt(Number.MIN_SAFE_INTEGER)
        ? Number(parsed)
        : preserve({ __firestoreInteger: raw });
    }
    if (typeof record.doubleValue === "number") {
      return Number.isFinite(record.doubleValue)
        ? record.doubleValue
        : preserve({ __firestoreDouble: String(record.doubleValue) });
    }
    if (isNonFiniteDouble(record.doubleValue)) {
      return preserve({ __firestoreDouble: record.doubleValue });
    }
    if (typeof record.stringValue === "string") {
      return record.stringValue;
    }
    if (typeof record.timestampValue === "string") {
      return preserve({ __firestoreTimestamp: record.timestampValue });
    }
    if (typeof record.bytesValue === "string") {
      return preserve({ __firestoreBytes: record.bytesValue });
    }
    if (typeof record.referenceValue === "string") {
      return preserve({ __firestoreReference: record.referenceValue });
    }
    const geoPoint = toFirestoreRecord(record.geoPointValue);
    if (
      geoPoint &&
      typeof geoPoint.latitude === "number" &&
      typeof geoPoint.longitude === "number"
    ) {
      return preserve({
        __firestoreGeoPoint: {
          latitude: geoPoint.latitude,
          longitude: geoPoint.longitude,
        },
      });
    }
    const array = toFirestoreRecord(record.arrayValue);
    if (array) {
      const values = array.values === undefined ? [] : array.values;
      return Array.isArray(values) ? values.map(decodeValue) : fail();
    }
    const map = toFirestoreRecord(record.mapValue);
    if (map) {
      const fields =
        map.fields === undefined ? {} : toFirestoreRecord(map.fields);
      return fields ? decodeFields(fields) : fail();
    }
    return fail();
  };

  const decodeFields = (
    fields: Record<string, unknown>,
  ): Record<string, unknown> =>
    Object.fromEntries(
      Object.entries(fields).map(([key, value]) => [key, decodeValue(value)]),
    );

  const encodeValue = (value: unknown): Record<string, unknown> => {
    if (value === null || value === undefined) {
      return { nullValue: null };
    }
    if (typeof value === "boolean") {
      return { booleanValue: value };
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) {
        return fail();
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
    const record = toFirestoreRecord(value);
    if (!record) {
      return fail();
    }
    if (isPreserved(record)) {
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
          return fail();
        }
        return { integerValue: record.__firestoreInteger };
      }
      if (typeof record.__firestoreBytes === "string") {
        return { bytesValue: record.__firestoreBytes };
      }
      if (typeof record.__firestoreReference === "string") {
        return { referenceValue: record.__firestoreReference };
      }
      const geoPoint = toFirestoreRecord(record.__firestoreGeoPoint);
      if (
        geoPoint &&
        typeof geoPoint.latitude === "number" &&
        typeof geoPoint.longitude === "number"
      ) {
        return { geoPointValue: geoPoint };
      }
      return fail();
    }
    return { mapValue: { fields: encodeFields(record) } };
  };

  const encodeFields = (
    fields: Record<string, unknown>,
  ): Record<string, Record<string, unknown>> =>
    Object.fromEntries(
      Object.entries(fields).map(([key, value]) => [key, encodeValue(value)]),
    );

  const parseDocument = (value: unknown): FirestoreRestDocument => {
    const record = toFirestoreRecord(value);
    const fields =
      record?.fields === undefined ? {} : toFirestoreRecord(record.fields);
    const name = typeof record?.name === "string" ? record.name : "";
    const updateTime =
      typeof record?.updateTime === "string" && record.updateTime.trim()
        ? record.updateTime.trim()
        : undefined;
    if (!name || !fields) {
      return fail();
    }
    return { name, fields, ...(updateTime ? { updateTime } : {}) };
  };

  const parseDocuments = (value: unknown): FirestoreRestDocument[] => {
    if (!Array.isArray(value)) {
      return fail();
    }
    const documents: FirestoreRestDocument[] = [];
    for (const entry of value) {
      const record = toFirestoreRecord(entry);
      if (record?.document !== undefined) {
        documents.push(parseDocument(record.document));
      }
    }
    return documents;
  };

  return { decodeFields, encodeFields, parseDocument, parseDocuments };
}

export function isFirestorePreconditionConflict(value: unknown): boolean {
  const body = toFirestoreRecord(value);
  const error = toFirestoreRecord(body?.error);
  return error?.status === "ABORTED" || error?.status === "FAILED_PRECONDITION";
}

export function createFirestoreRestTransport({
  createFailure,
  documentsRoot,
  fetcher,
  getAccessToken,
  maxBodyBytes,
  signal,
  timeoutMs,
}: FirestoreRestTransportOptions) {
  let accessToken: Promise<string> | null = null;
  const token = () => {
    accessToken ||= getAccessToken().catch(() => {
      throw createFailure();
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
      return await fetcher(input, { ...init, headers, signal: requestSignal });
    } catch {
      throw createFailure();
    }
  };
  const readJson = async (
    response: Response,
    limit = maxBodyBytes,
  ): Promise<unknown> => {
    if (!response.ok) {
      await cancelResponseBody(response);
      throw createFailure();
    }
    return readBoundedJsonValue(response, limit, createFailure);
  };
  const post = (input: string, body: unknown) =>
    request(input, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  const beginTransaction = async (retryTransaction?: string) => {
    const response = await post(`${documentsRoot}:beginTransaction`, {
      options: { readWrite: retryTransaction ? { retryTransaction } : {} },
    });
    const body = toFirestoreRecord(await readJson(response));
    const transaction =
      typeof body?.transaction === "string" ? body.transaction.trim() : "";
    if (!transaction) {
      throw createFailure();
    }
    return transaction;
  };
  const rollback = async (transaction: string): Promise<void> => {
    try {
      const response = await post(`${documentsRoot}:rollback`, { transaction });
      await cancelResponseBody(response);
    } catch {}
  };
  const commit = async (
    writes: unknown[],
    transaction?: string,
  ): Promise<"committed" | "conflict"> => {
    const response = await post(`${documentsRoot}:commit`, {
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
        maxBodyBytes,
        createFailure,
      );
      if (isFirestorePreconditionConflict(body)) {
        return "conflict";
      }
      throw createFailure();
    }
    await cancelResponseBody(response);
    throw createFailure();
  };
  return { beginTransaction, commit, post, readJson, request, rollback };
}
