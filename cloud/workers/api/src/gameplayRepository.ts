import {
  MATERIAL_KEYS,
  normalizeMaterials,
  normalizeMiningSnapshot,
  type MiningMaterialName,
  type MiningMaterials,
  type MiningSnapshot,
} from "@mons/shared/mining";
import { cancelResponseBody, readBoundedJsonValue } from "./boundedStreams.ts";
import {
  createFirebaseRtdbClient,
  type FirebaseRtdbClient,
  type FirebaseRtdbQuery,
  type FirebaseRtdbTransactionResult,
} from "./firebaseRtdb.ts";
import { createGoogleAccessToken } from "./googleAuth.ts";

const FIRESTORE_PROJECT_ID = "mons-link";
const FIRESTORE_DATABASE_ID = "(default)";
const FIRESTORE_DATABASE_NAME = `projects/${FIRESTORE_PROJECT_ID}/databases/${FIRESTORE_DATABASE_ID}`;
const FIRESTORE_DOCUMENT_NAME_ROOT = `${FIRESTORE_DATABASE_NAME}/documents`;
const FIRESTORE_DOCUMENTS_ROOT = `https://firestore.googleapis.com/v1/${FIRESTORE_DOCUMENT_NAME_ROOT}`;
const FIRESTORE_TIMEOUT_MS = 5_000;
const MAX_FIRESTORE_BODY_BYTES = 64 * 1024;
const MAX_RATING_FIRESTORE_BODY_BYTES = 256 * 1024;
const MAX_RATING_TRANSACTION_ATTEMPTS = 5;

type FirestoreDocument = {
  fields: Record<string, unknown>;
  name: string;
};

export type NavigationGameDocument = {
  status: string | null;
  updateTime: string;
};

export type NavigationGameDeleteResult = "conflict" | "deleted" | "missing";

export type WagerTransferInput = {
  appliedAtMs: number;
  count: number;
  fingerprint: string;
  loserProfileId: string;
  material: MiningMaterialName;
  operationId: string;
  winnerProfileId: string;
};

export type AutomatchProfile = {
  aura: string;
  emoji: number | string;
  eth: string;
  profileId: string;
  rating: number;
  sol: string;
  username: string;
};

export type RatingProfile = AutomatchProfile & {
  feb2026UniqueOpponents: string[];
  nonce: number;
  totalManaPoints: number;
};

export type RatingUpdateData = {
  inviteId: string;
  leaseExpiresAtMs: number;
  matchId: string;
  opponentId: string;
  opponentProfileId: string;
  ownerToken: string;
  playerId: string;
  playerProfileId: string;
  shouldUpdateFebruaryChallenge: boolean;
  startedAtMs: number;
  status: string;
};

export type RatingLeaseInput = {
  inviteId: string;
  matchId: string;
  opponentId: string;
  ownerToken: string;
  ownerUid: string;
  playerId: string;
  leaseMs: number;
};

export type RatingLeaseResult = {
  data: RatingUpdateData | null;
  status: "acquired" | "busy" | "done";
};

type RatingOperationIdentity = Pick<
  RatingLeaseInput,
  "inviteId" | "matchId" | "opponentId" | "playerId"
>;

export type RatingCommitPlan = {
  opponentUpdate: Record<string, unknown> | null;
  playerUpdate: Record<string, unknown> | null;
  repairData: RatingRepairData;
  ratingUpdate: Record<string, unknown>;
};

export type RatingRepairData = Pick<
  RatingUpdateData,
  "opponentProfileId" | "playerProfileId" | "shouldUpdateFebruaryChallenge"
>;

export type RatingFinalizeInput = {
  inviteId: string;
  matchId: string;
  opponentId: string;
  operationId: string;
  ownerToken: string;
  playerId: string;
};

export type RatingFinalizeResult =
  | { data: RatingUpdateData; status: "replayed" }
  | { data: RatingRepairData; status: "committed" }
  | { status: "lost" };

export type RatingRepository = Pick<
  GameplayRepository,
  "getRtdbPath" | "patchRtdbRoot"
> & {
  applyFebruaryChallengeReplay: (
    playerProfileId: string,
    opponentProfileId: string,
  ) => Promise<void>;
  finalizeRatingUpdate: (
    input: RatingFinalizeInput,
    buildPlan: (
      player: RatingProfile | null,
      opponent: RatingProfile | null,
    ) => RatingCommitPlan,
  ) => Promise<RatingFinalizeResult>;
  getRatingProfile: (uid: string) => Promise<RatingProfile | null>;
  readRatingUpdate: (operationId: string) => Promise<RatingUpdateData | null>;
  tryAcquireRatingLease: (
    input: RatingLeaseInput,
  ) => Promise<RatingLeaseResult>;
};

export type GameplayRepository = {
  applyWagerTransferOnce: (
    input: WagerTransferInput,
  ) => Promise<"applied" | "replayed">;
  deleteNavigationGame: (
    profileId: string,
    inviteId: string,
    updateTime: string,
  ) => Promise<NavigationGameDeleteResult>;
  findProfileId: (
    uid: string,
    firebaseIdToken: string,
  ) => Promise<string | null>;
  getAutomatchProfile: (
    uid: string,
    firebaseIdToken: string,
    signal?: AbortSignal,
  ) => Promise<AutomatchProfile | null>;
  getNavigationGame: (
    profileId: string,
    inviteId: string,
    firebaseIdToken: string,
  ) => Promise<NavigationGameDocument | null>;
  getMiningMaterials: (
    profileId: string,
    firebaseIdToken: string,
  ) => Promise<MiningMaterials>;
  getMiningSnapshot: (profileId: string) => Promise<MiningSnapshot | null>;
  getRtdbPath: (
    path: string,
    query?: FirebaseRtdbQuery,
    signal?: AbortSignal,
  ) => Promise<unknown>;
  patchRtdbRoot: (
    updates: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<void>;
  transactRtdbPath: (
    path: string,
    updater: (current: unknown) => unknown,
    signal?: AbortSignal,
  ) => Promise<FirebaseRtdbTransactionResult>;
};

type GameplayRepositoryDependencies = {
  fetcher?: typeof fetch;
  getAccessToken?: typeof createGoogleAccessToken;
  now?: () => number;
  rtdbClient?: FirebaseRtdbClient;
  timeoutMs?: number;
};

type RatingRepositoryDependencies = {
  fetcher?: typeof fetch;
  getAccessToken?: typeof createGoogleAccessToken;
  maxTransactionAttempts?: number;
  now?: () => number;
  timeoutMs?: number;
};

export class GameplayRepositoryFailure extends Error {
  constructor() {
    super("gameplay-repository-unavailable");
  }
}

function toRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseFirestoreDocument(value: unknown): FirestoreDocument {
  const document = toRecord(value);
  const fields =
    document?.fields === undefined ? {} : toRecord(document.fields);
  if (typeof document?.name !== "string" || !fields) {
    throw new GameplayRepositoryFailure();
  }
  return { name: document.name, fields };
}

function parseFirestoreDocuments(value: unknown): FirestoreDocument[] {
  if (!Array.isArray(value)) {
    throw new GameplayRepositoryFailure();
  }
  const documents: FirestoreDocument[] = [];
  for (const entry of value) {
    const result = toRecord(entry);
    if (result?.document !== undefined) {
      documents.push(parseFirestoreDocument(result.document));
    }
  }
  return documents;
}

function decodeFirestoreValue(value: unknown): unknown {
  const encoded = toRecord(value);
  if (!encoded) {
    throw new GameplayRepositoryFailure();
  }
  if (typeof encoded.stringValue === "string") {
    return encoded.stringValue;
  }
  if (typeof encoded.booleanValue === "boolean") {
    return encoded.booleanValue;
  }
  if (encoded.nullValue !== undefined) {
    return null;
  }
  if (
    typeof encoded.integerValue === "string" ||
    typeof encoded.integerValue === "number"
  ) {
    const parsed = Number(encoded.integerValue);
    if (!Number.isFinite(parsed)) {
      throw new GameplayRepositoryFailure();
    }
    return parsed;
  }
  if (typeof encoded.doubleValue === "number") {
    return encoded.doubleValue;
  }
  const arrayValue = toRecord(encoded.arrayValue);
  if (arrayValue) {
    const values = arrayValue.values;
    if (values === undefined) {
      return [];
    }
    if (!Array.isArray(values)) {
      throw new GameplayRepositoryFailure();
    }
    return values.map(decodeFirestoreValue);
  }
  const mapValue = toRecord(encoded.mapValue);
  if (mapValue) {
    const fields =
      mapValue.fields === undefined ? {} : toRecord(mapValue.fields);
    if (!fields) {
      throw new GameplayRepositoryFailure();
    }
    return Object.fromEntries(
      Object.entries(fields).map(([key, entry]) => [
        key,
        decodeFirestoreValue(entry),
      ]),
    );
  }
  throw new GameplayRepositoryFailure();
}

function decodeFirestoreFields(
  fields: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [
      key,
      decodeFirestoreValue(value),
    ]),
  );
}

function encodeFirestoreValue(value: unknown): Record<string, unknown> {
  if (value === null) {
    return { nullValue: null };
  }
  if (typeof value === "string") {
    return { stringValue: value };
  }
  if (typeof value === "boolean") {
    return { booleanValue: value };
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return Number.isSafeInteger(value)
      ? { integerValue: String(value) }
      : { doubleValue: value };
  }
  if (Array.isArray(value)) {
    return {
      arrayValue: { values: value.map((entry) => encodeFirestoreValue(entry)) },
    };
  }
  const record = toRecord(value);
  if (record) {
    return {
      mapValue: {
        fields: Object.fromEntries(
          Object.entries(record).map(([key, entry]) => [
            key,
            encodeFirestoreValue(entry),
          ]),
        ),
      },
    };
  }
  throw new GameplayRepositoryFailure();
}

function encodeFirestoreFields(
  fields: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [
      key,
      encodeFirestoreValue(value),
    ]),
  );
}

function isPreconditionConflict(value: unknown): boolean {
  const body = toRecord(value);
  const error = toRecord(body?.error);
  return error?.status === "ABORTED" || error?.status === "FAILED_PRECONDITION";
}

function documentPath(profileId: string, inviteId?: string): string {
  const profilePath = `users/${encodeURIComponent(profileId)}`;
  return inviteId === undefined
    ? profilePath
    : `${profilePath}/games/${encodeURIComponent(inviteId)}`;
}

function parseProfileQuery(value: unknown): string | null {
  if (!Array.isArray(value)) {
    throw new GameplayRepositoryFailure();
  }
  for (const entry of value) {
    const result = toRecord(entry);
    const document = toRecord(result?.document);
    if (!document) {
      continue;
    }
    const name = typeof document.name === "string" ? document.name.trim() : "";
    const profileId = name.split("/").pop()?.trim() || "";
    if (!profileId) {
      throw new GameplayRepositoryFailure();
    }
    return profileId;
  }
  return null;
}

function readFirestoreString(value: unknown): string {
  const encoded = toRecord(value);
  return typeof encoded?.stringValue === "string" ? encoded.stringValue : "";
}

function readOptionalFirestoreString(value: unknown): string | undefined {
  const encoded = toRecord(value);
  return typeof encoded?.stringValue === "string"
    ? encoded.stringValue
    : undefined;
}

function readFirestoreNumber(value: unknown, fallback: number): number {
  const encoded = toRecord(value);
  const raw = encoded?.integerValue ?? encoded?.doubleValue;
  const parsed =
    typeof raw === "string" || typeof raw === "number" ? Number(raw) : NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readFirestoreEmoji(value: unknown): number | string {
  const encoded = toRecord(value);
  if (typeof encoded?.stringValue === "string") {
    return encoded.stringValue;
  }
  const parsed = readFirestoreNumber(value, NaN);
  return Number.isFinite(parsed) ? parsed : "";
}

export function parseAutomatchProfileQuery(
  value: unknown,
): AutomatchProfile | null {
  if (!Array.isArray(value)) {
    throw new GameplayRepositoryFailure();
  }
  for (const entry of value) {
    const result = toRecord(entry);
    const document = toRecord(result?.document);
    if (!document) {
      continue;
    }
    const name = typeof document.name === "string" ? document.name.trim() : "";
    const fields = toRecord(document.fields) || {};
    const profileId = name.split("/").pop()?.trim() || "";
    if (!profileId) {
      throw new GameplayRepositoryFailure();
    }
    const custom = toRecord(toRecord(fields.custom)?.mapValue);
    const customFields = toRecord(custom?.fields) || {};
    const customEmoji = Object.hasOwn(customFields, "emoji")
      ? readFirestoreEmoji(customFields.emoji)
      : undefined;
    const customAura = readOptionalFirestoreString(customFields.aura);
    return {
      aura: customAura ?? readFirestoreString(fields.aura),
      emoji: customEmoji ?? readFirestoreEmoji(fields.emoji),
      eth: readFirestoreString(fields.eth),
      profileId,
      rating: readFirestoreNumber(fields.rating, 1500),
      sol: readFirestoreString(fields.sol),
      username: readFirestoreString(fields.username),
    };
  }
  return null;
}

function parseNavigationGame(value: unknown): NavigationGameDocument {
  const document = toRecord(value);
  const fields = toRecord(document?.fields);
  const statusValue = toRecord(fields?.status);
  const updateTime =
    typeof document?.updateTime === "string" ? document.updateTime.trim() : "";
  if (!fields || !updateTime) {
    throw new GameplayRepositoryFailure();
  }
  return {
    status:
      typeof statusValue?.stringValue === "string"
        ? statusValue.stringValue
        : null,
    updateTime,
  };
}

function readFirestoreMapFields(value: unknown): Record<string, unknown> {
  const encoded = toRecord(value);
  const mapValue = toRecord(encoded?.mapValue);
  return toRecord(mapValue?.fields) || {};
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function ratingProfileFromDocument(document: FirestoreDocument): RatingProfile {
  const fields = decodeFirestoreFields(document.fields);
  const custom = toRecord(fields.custom) || {};
  const profileId = document.name.split("/").pop()?.trim() || "";
  if (!profileId) {
    throw new GameplayRepositoryFailure();
  }
  const number = (value: unknown, fallback: number) =>
    typeof value === "number" && Number.isFinite(value) ? value : fallback;
  const string = (value: unknown) => (typeof value === "string" ? value : "");
  const customEmoji = custom.emoji;
  return {
    aura: string(custom.aura) || string(fields.aura),
    emoji:
      typeof customEmoji === "string" || typeof customEmoji === "number"
        ? customEmoji
        : typeof fields.emoji === "string" || typeof fields.emoji === "number"
          ? fields.emoji
          : "",
    eth: string(fields.eth),
    feb2026UniqueOpponents: readStringArray(fields.feb2026UniqueOpponents),
    nonce: number(fields.nonce, fields.nonce === undefined ? -1 : 0),
    profileId,
    rating: number(fields.rating, 1500),
    sol: string(fields.sol),
    totalManaPoints: number(fields.totalManaPoints, 0),
    username: string(fields.username),
  };
}

function ratingUpdateFromDocument(
  document: FirestoreDocument,
): RatingUpdateData {
  const fields = decodeFirestoreFields(document.fields);
  const string = (value: unknown) =>
    typeof value === "string" ? value.trim() : "";
  const number = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) ? value : 0;
  return {
    inviteId: string(fields.inviteId),
    leaseExpiresAtMs: number(fields.leaseExpiresAtMs),
    matchId: string(fields.matchId),
    opponentId: string(fields.opponentId),
    opponentProfileId: string(fields.opponentProfileId),
    ownerToken: string(fields.ownerToken),
    playerId: string(fields.playerId),
    playerProfileId: string(fields.playerProfileId),
    shouldUpdateFebruaryChallenge:
      fields.shouldUpdateFebruaryChallenge === true,
    startedAtMs: number(fields.startedAtMs),
    status: string(fields.status),
  };
}

function isSameRatingOperation(
  data: RatingUpdateData | null,
  input: RatingOperationIdentity,
): data is RatingUpdateData {
  return (
    data !== null &&
    data.inviteId === input.inviteId &&
    data.matchId === input.matchId &&
    data.playerId === input.playerId &&
    data.opponentId === input.opponentId
  );
}

function readMiningSnapshotFields(
  fields: Record<string, unknown>,
): MiningSnapshot {
  const miningFields = readFirestoreMapFields(fields.mining);
  const materialFields = readFirestoreMapFields(miningFields.materials);
  const lastRockDate = toRecord(miningFields.lastRockDate);
  return normalizeMiningSnapshot({
    lastRockDate:
      typeof lastRockDate?.stringValue === "string"
        ? lastRockDate.stringValue
        : null,
    materials: Object.fromEntries(
      MATERIAL_KEYS.map((key) => [
        key,
        readFirestoreNumber(materialFields[key], 0),
      ]),
    ),
  });
}

export function parseMiningMaterialsDocument(value: unknown): MiningMaterials {
  const document = toRecord(value);
  if (!document) {
    throw new GameplayRepositoryFailure();
  }
  return readMiningSnapshotFields(toRecord(document.fields) || {}).materials;
}

export function parseMiningSnapshotDocument(value: unknown): MiningSnapshot {
  const document = toRecord(value);
  if (!document) {
    throw new GameplayRepositoryFailure();
  }
  return readMiningSnapshotFields(toRecord(document.fields) || {});
}

function encodeWagerTransferLedger(input: WagerTransferInput): unknown {
  return {
    appliedAtMs: { integerValue: String(input.appliedAtMs) },
    count: { integerValue: String(input.count) },
    fingerprint: { stringValue: input.fingerprint },
    loserProfileId: { stringValue: input.loserProfileId },
    material: { stringValue: input.material },
    operationId: { stringValue: input.operationId },
    winnerProfileId: { stringValue: input.winnerProfileId },
  };
}

export function createGameplayRepository(
  env: Env,
  {
    fetcher = fetch,
    getAccessToken = createGoogleAccessToken,
    now = Date.now,
    timeoutMs = FIRESTORE_TIMEOUT_MS,
    rtdbClient = createFirebaseRtdbClient(env, {
      credentials: {
        email: env.GAMEPLAY_SERVICE_ACCOUNT_EMAIL,
        privateKeyPem: env.GAMEPLAY_SERVICE_ACCOUNT_PRIVATE_KEY,
      },
      fetcher,
      now,
      timeoutMs,
    }),
  }: GameplayRepositoryDependencies = {},
): GameplayRepository {
  let serviceAccessToken: Promise<string> | null = null;
  let firestoreAccessToken: Promise<string> | null = null;
  const getServiceAccessToken = () => {
    serviceAccessToken ||= getAccessToken(env, {
      credentials: {
        email: env.GAMEPLAY_SERVICE_ACCOUNT_EMAIL,
        privateKeyPem: env.GAMEPLAY_SERVICE_ACCOUNT_PRIVATE_KEY,
      },
      fetcher,
      now,
      timeoutMs,
    }).catch(() => {
      throw new GameplayRepositoryFailure();
    });
    return serviceAccessToken;
  };
  const getFirestoreAccessToken = () => {
    firestoreAccessToken ||= getAccessToken(env, {
      fetcher,
      now,
      timeoutMs,
    }).catch(() => {
      throw new GameplayRepositoryFailure();
    });
    return firestoreAccessToken;
  };
  const fetchWithTimeout = async (
    input: string,
    init: RequestInit,
    signal?: AbortSignal,
  ): Promise<Response> => {
    const requestSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
      : AbortSignal.timeout(timeoutMs);
    try {
      return await fetcher(input, {
        ...init,
        signal: requestSignal,
      });
    } catch {
      throw new GameplayRepositoryFailure();
    }
  };
  const readWagerTransferLedger = async (
    input: WagerTransferInput,
  ): Promise<boolean> => {
    const response = await fetchWithTimeout(
      `${FIRESTORE_DOCUMENTS_ROOT}/wagerSettlements/${encodeURIComponent(input.operationId)}`,
      {
        headers: {
          Authorization: `Bearer ${await getFirestoreAccessToken()}`,
        },
      },
    );
    if (response.status === 404) {
      await cancelResponseBody(response);
      return false;
    }
    if (!response.ok) {
      await cancelResponseBody(response);
      throw new GameplayRepositoryFailure();
    }
    const document = toRecord(
      await readBoundedJsonValue(
        response,
        MAX_FIRESTORE_BODY_BYTES,
        () => new GameplayRepositoryFailure(),
      ),
    );
    const fields = toRecord(document?.fields);
    const fingerprint = readFirestoreString(fields?.fingerprint);
    if (!fingerprint || fingerprint !== input.fingerprint) {
      throw new GameplayRepositoryFailure();
    }
    return true;
  };

  return {
    async applyWagerTransferOnce(input) {
      if (
        !input.operationId ||
        !input.fingerprint ||
        !input.winnerProfileId ||
        !input.loserProfileId ||
        !MATERIAL_KEYS.includes(input.material) ||
        !Number.isSafeInteger(input.count) ||
        input.count <= 0 ||
        !Number.isSafeInteger(input.appliedAtMs) ||
        input.appliedAtMs < 0
      ) {
        throw new GameplayRepositoryFailure();
      }
      if (await readWagerTransferLedger(input)) {
        return "replayed";
      }
      const ledgerName = `${FIRESTORE_DOCUMENT_NAME_ROOT}/wagerSettlements/${encodeURIComponent(input.operationId)}`;
      const writes: Array<Record<string, unknown>> = [
        {
          update: {
            name: ledgerName,
            fields: encodeWagerTransferLedger(input),
          },
          currentDocument: { exists: false },
        },
      ];
      if (input.winnerProfileId !== input.loserProfileId) {
        writes.push(
          {
            transform: {
              document: `${FIRESTORE_DOCUMENT_NAME_ROOT}/${documentPath(input.winnerProfileId)}`,
              fieldTransforms: [
                {
                  fieldPath: `mining.materials.${input.material}`,
                  increment: { integerValue: String(input.count) },
                },
              ],
            },
            currentDocument: { exists: true },
          },
          {
            transform: {
              document: `${FIRESTORE_DOCUMENT_NAME_ROOT}/${documentPath(input.loserProfileId)}`,
              fieldTransforms: [
                {
                  fieldPath: `mining.materials.${input.material}`,
                  increment: { integerValue: String(-input.count) },
                },
              ],
            },
            currentDocument: { exists: true },
          },
        );
      }
      let response: Response;
      try {
        response = await fetchWithTimeout(
          `${FIRESTORE_DOCUMENTS_ROOT}:commit`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${await getFirestoreAccessToken()}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ writes }),
          },
        );
      } catch {
        if (await readWagerTransferLedger(input)) {
          return "replayed";
        }
        throw new GameplayRepositoryFailure();
      }
      if (response.ok) {
        await cancelResponseBody(response);
        return "applied";
      }
      await cancelResponseBody(response);
      if (await readWagerTransferLedger(input)) {
        return "replayed";
      }
      throw new GameplayRepositoryFailure();
    },

    getRtdbPath: rtdbClient.getPath,
    patchRtdbRoot: rtdbClient.patchRoot,
    transactRtdbPath: rtdbClient.transactPath,

    async getAutomatchProfile(uid, firebaseIdToken, signal) {
      const response = await fetchWithTimeout(
        `${FIRESTORE_DOCUMENTS_ROOT}:runQuery`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${firebaseIdToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            structuredQuery: {
              select: {
                fields: [
                  { fieldPath: "aura" },
                  { fieldPath: "custom.aura" },
                  { fieldPath: "custom.emoji" },
                  { fieldPath: "emoji" },
                  { fieldPath: "eth" },
                  { fieldPath: "rating" },
                  { fieldPath: "sol" },
                  { fieldPath: "username" },
                ],
              },
              from: [{ collectionId: "users" }],
              where: {
                fieldFilter: {
                  field: { fieldPath: "logins" },
                  op: "ARRAY_CONTAINS",
                  value: { stringValue: uid },
                },
              },
              limit: 1,
            },
          }),
        },
        signal,
      );
      if (!response.ok) {
        await cancelResponseBody(response);
        throw new GameplayRepositoryFailure();
      }
      return parseAutomatchProfileQuery(
        await readBoundedJsonValue(
          response,
          MAX_FIRESTORE_BODY_BYTES,
          () => new GameplayRepositoryFailure(),
        ),
      );
    },

    async findProfileId(uid, firebaseIdToken) {
      const response = await fetchWithTimeout(
        `${FIRESTORE_DOCUMENTS_ROOT}:runQuery`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${firebaseIdToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            structuredQuery: {
              select: { fields: [{ fieldPath: "logins" }] },
              from: [{ collectionId: "users" }],
              where: {
                fieldFilter: {
                  field: { fieldPath: "logins" },
                  op: "ARRAY_CONTAINS",
                  value: { stringValue: uid },
                },
              },
              limit: 1,
            },
          }),
        },
      );
      if (!response.ok) {
        await cancelResponseBody(response);
        throw new GameplayRepositoryFailure();
      }
      return parseProfileQuery(
        await readBoundedJsonValue(
          response,
          MAX_FIRESTORE_BODY_BYTES,
          () => new GameplayRepositoryFailure(),
        ),
      );
    },

    async getNavigationGame(profileId, inviteId, firebaseIdToken) {
      const response = await fetchWithTimeout(
        `${FIRESTORE_DOCUMENTS_ROOT}/${documentPath(profileId, inviteId)}`,
        { headers: { Authorization: `Bearer ${firebaseIdToken}` } },
      );
      if (response.status === 404) {
        await cancelResponseBody(response);
        return null;
      }
      if (!response.ok) {
        await cancelResponseBody(response);
        throw new GameplayRepositoryFailure();
      }
      return parseNavigationGame(
        await readBoundedJsonValue(
          response,
          MAX_FIRESTORE_BODY_BYTES,
          () => new GameplayRepositoryFailure(),
        ),
      );
    },

    async getMiningMaterials(profileId, firebaseIdToken) {
      const url = new URL(
        `${FIRESTORE_DOCUMENTS_ROOT}/${documentPath(profileId)}`,
      );
      url.searchParams.append("mask.fieldPaths", "mining.materials");
      const response = await fetchWithTimeout(url.toString(), {
        headers: { Authorization: `Bearer ${firebaseIdToken}` },
      });
      if (response.status === 404) {
        await cancelResponseBody(response);
        return normalizeMaterials();
      }
      if (!response.ok) {
        await cancelResponseBody(response);
        throw new GameplayRepositoryFailure();
      }
      return parseMiningMaterialsDocument(
        await readBoundedJsonValue(
          response,
          MAX_FIRESTORE_BODY_BYTES,
          () => new GameplayRepositoryFailure(),
        ),
      );
    },

    async getMiningSnapshot(profileId) {
      const url = new URL(
        `${FIRESTORE_DOCUMENTS_ROOT}/${documentPath(profileId)}`,
      );
      url.searchParams.append("mask.fieldPaths", "mining");
      const response = await fetchWithTimeout(url.toString(), {
        headers: {
          Authorization: `Bearer ${await getFirestoreAccessToken()}`,
        },
      });
      if (response.status === 404) {
        await cancelResponseBody(response);
        return null;
      }
      if (!response.ok) {
        await cancelResponseBody(response);
        throw new GameplayRepositoryFailure();
      }
      return parseMiningSnapshotDocument(
        await readBoundedJsonValue(
          response,
          MAX_FIRESTORE_BODY_BYTES,
          () => new GameplayRepositoryFailure(),
        ),
      );
    },

    async deleteNavigationGame(profileId, inviteId, updateTime) {
      const url = new URL(
        `${FIRESTORE_DOCUMENTS_ROOT}/${documentPath(profileId, inviteId)}`,
      );
      url.searchParams.set("currentDocument.updateTime", updateTime);
      const response = await fetchWithTimeout(url.toString(), {
        method: "DELETE",
        headers: { Authorization: `Bearer ${await getServiceAccessToken()}` },
      });
      if (response.ok) {
        await cancelResponseBody(response);
        return "deleted";
      }
      if (response.status === 404) {
        await cancelResponseBody(response);
        return "missing";
      }
      if (response.status === 409 || response.status === 412) {
        await cancelResponseBody(response);
        return "conflict";
      }
      if (response.status === 400) {
        const body = await readBoundedJsonValue(
          response,
          MAX_FIRESTORE_BODY_BYTES,
          () => new GameplayRepositoryFailure(),
        );
        if (isPreconditionConflict(body)) {
          return "conflict";
        }
        throw new GameplayRepositoryFailure();
      }
      await cancelResponseBody(response);
      throw new GameplayRepositoryFailure();
    },
  };
}

export function createRatingRepository(
  env: Env,
  gameplayRepository: GameplayRepository,
  {
    fetcher = fetch,
    getAccessToken = createGoogleAccessToken,
    maxTransactionAttempts = MAX_RATING_TRANSACTION_ATTEMPTS,
    now = Date.now,
    timeoutMs = FIRESTORE_TIMEOUT_MS,
  }: RatingRepositoryDependencies = {},
): RatingRepository {
  const attempts =
    Number.isInteger(maxTransactionAttempts) && maxTransactionAttempts > 0
      ? maxTransactionAttempts
      : MAX_RATING_TRANSACTION_ATTEMPTS;
  let accessToken: Promise<string> | null = null;
  const token = () => {
    accessToken ||= getAccessToken(env, {
      credentials: {
        email: env.RATING_SERVICE_ACCOUNT_EMAIL,
        privateKeyPem: env.RATING_SERVICE_ACCOUNT_PRIVATE_KEY,
      },
      fetcher,
      now,
      timeoutMs,
    }).catch(() => {
      throw new GameplayRepositoryFailure();
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
      throw new GameplayRepositoryFailure();
    }
  };
  const readJson = async (response: Response): Promise<unknown> => {
    if (!response.ok) {
      await cancelResponseBody(response);
      throw new GameplayRepositoryFailure();
    }
    return readBoundedJsonValue(
      response,
      MAX_RATING_FIRESTORE_BODY_BYTES,
      () => new GameplayRepositoryFailure(),
    );
  };
  const postJson = (input: string, body: unknown) =>
    request(input, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  const operationName = (operationId: string) =>
    `${FIRESTORE_DOCUMENT_NAME_ROOT}/ratingUpdates/${operationId}`;
  const profileName = (profileId: string) =>
    `${FIRESTORE_DOCUMENT_NAME_ROOT}/users/${profileId}`;
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
      throw new GameplayRepositoryFailure();
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
  const batchGet = async (
    transaction: string,
    names: string[],
    fieldPaths?: string[],
  ): Promise<Map<string, FirestoreDocument | null>> => {
    const uniqueNames = Array.from(new Set(names));
    const response = await postJson(`${FIRESTORE_DOCUMENTS_ROOT}:batchGet`, {
      documents: uniqueNames,
      ...(fieldPaths ? { mask: { fieldPaths } } : {}),
      transaction,
    });
    const body = await readJson(response);
    if (!Array.isArray(body)) {
      throw new GameplayRepositoryFailure();
    }
    const results = new Map<string, FirestoreDocument | null>();
    for (const entry of body) {
      const record = toRecord(entry);
      if (record?.found !== undefined) {
        const document = parseFirestoreDocument(record.found);
        results.set(document.name, document);
      } else if (typeof record?.missing === "string") {
        results.set(record.missing, null);
      }
    }
    if (uniqueNames.some((name) => !results.has(name))) {
      throw new GameplayRepositoryFailure();
    }
    return results;
  };
  const queryProfile = async (
    uid: string,
    transaction?: string,
  ): Promise<RatingProfile | null> => {
    const response = await postJson(`${FIRESTORE_DOCUMENTS_ROOT}:runQuery`, {
      structuredQuery: {
        select: {
          fields: [
            "aura",
            "custom.aura",
            "custom.emoji",
            "emoji",
            "eth",
            "feb2026UniqueOpponents",
            "nonce",
            "rating",
            "sol",
            "totalManaPoints",
            "username",
          ].map((fieldPath) => ({ fieldPath })),
        },
        from: [{ collectionId: "users" }],
        where: {
          fieldFilter: {
            field: { fieldPath: "logins" },
            op: "ARRAY_CONTAINS",
            value: { stringValue: uid },
          },
        },
        limit: 1,
      },
      ...(transaction ? { transaction } : {}),
    });
    const documents = parseFirestoreDocuments(await readJson(response));
    return documents[0] ? ratingProfileFromDocument(documents[0]) : null;
  };
  const readOperation = async (
    operationId: string,
  ): Promise<RatingUpdateData | null> => {
    const response = await request(
      `${FIRESTORE_DOCUMENTS_ROOT}/ratingUpdates/${encodeURIComponent(operationId)}`,
      {},
    );
    if (response.status === 404) {
      await cancelResponseBody(response);
      return null;
    }
    return ratingUpdateFromDocument(
      parseFirestoreDocument(await readJson(response)),
    );
  };
  const updateWrite = (
    name: string,
    fields: Record<string, unknown>,
    requireExisting = false,
  ) => ({
    update: { name, fields: encodeFirestoreFields(fields) },
    updateMask: { fieldPaths: Object.keys(fields) },
    ...(requireExisting ? { currentDocument: { exists: true } } : {}),
  });
  const commit = async (
    transaction: string,
    writes: Array<Record<string, unknown>>,
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
    if (response.status === 400) {
      const body = await readBoundedJsonValue(
        response,
        MAX_RATING_FIRESTORE_BODY_BYTES,
        () => new GameplayRepositoryFailure(),
      );
      if (isPreconditionConflict(body)) {
        return "conflict";
      }
      throw new GameplayRepositoryFailure();
    }
    await cancelResponseBody(response);
    throw new GameplayRepositoryFailure();
  };

  return {
    getRtdbPath: gameplayRepository.getRtdbPath,
    patchRtdbRoot: gameplayRepository.patchRtdbRoot,

    async applyFebruaryChallengeReplay(playerProfileId, opponentProfileId) {
      if (
        !playerProfileId ||
        !opponentProfileId ||
        playerProfileId === opponentProfileId
      ) {
        return;
      }
      let retryTransaction: string | undefined;
      for (let attempt = 0; attempt < attempts; attempt++) {
        const transaction = await beginTransaction(retryTransaction);
        const playerDocumentName = profileName(playerProfileId);
        const opponentDocumentName = profileName(opponentProfileId);
        try {
          const documents = await batchGet(
            transaction,
            [playerDocumentName, opponentDocumentName],
            ["feb2026UniqueOpponents"],
          );
          const writes: Array<Record<string, unknown>> = [];
          for (const [name, otherProfileId] of [
            [playerDocumentName, opponentProfileId],
            [opponentDocumentName, playerProfileId],
          ] as const) {
            const document = documents.get(name);
            if (!document) {
              continue;
            }
            const fields = decodeFirestoreFields(document.fields);
            const opponents = readStringArray(fields.feb2026UniqueOpponents);
            if (opponents.includes(otherProfileId)) {
              continue;
            }
            const updatedOpponents = [...opponents, otherProfileId];
            writes.push(
              updateWrite(
                name,
                {
                  feb2026UniqueOpponents: updatedOpponents,
                  feb2026UniqueOpponentsCount: updatedOpponents.length,
                },
                true,
              ),
            );
          }
          if (writes.length === 0) {
            await rollback(transaction);
            return;
          }
          const result = await commit(transaction, writes);
          if (result === "committed") {
            return;
          }
          retryTransaction = transaction;
        } catch (error) {
          await rollback(transaction);
          throw error;
        }
      }
      throw new GameplayRepositoryFailure();
    },

    async finalizeRatingUpdate(input, buildPlan) {
      let retryTransaction: string | undefined;
      for (let attempt = 0; attempt < attempts; attempt++) {
        const transaction = await beginTransaction(retryTransaction);
        try {
          const name = operationName(input.operationId);
          const operationDocument = (await batchGet(transaction, [name])).get(
            name,
          );
          if (!operationDocument) {
            await rollback(transaction);
            return { status: "lost" };
          }
          const operation = ratingUpdateFromDocument(operationDocument);
          if (operation.status === "done") {
            await rollback(transaction);
            return { status: "replayed", data: operation };
          }
          if (
            operation.status !== "processing" ||
            operation.ownerToken !== input.ownerToken ||
            !isSameRatingOperation(operation, input)
          ) {
            await rollback(transaction);
            return { status: "lost" };
          }
          const player = await queryProfile(input.playerId, transaction);
          const opponent = await queryProfile(input.opponentId, transaction);
          const plan = buildPlan(player, opponent);
          const writes: Array<Record<string, unknown>> = [];
          if (player && plan.playerUpdate) {
            writes.push(
              updateWrite(
                profileName(player.profileId),
                plan.playerUpdate,
                true,
              ),
            );
          }
          if (opponent && plan.opponentUpdate) {
            writes.push(
              updateWrite(
                profileName(opponent.profileId),
                plan.opponentUpdate,
                true,
              ),
            );
          }
          writes.push(updateWrite(name, plan.ratingUpdate, true));
          const result = await commit(transaction, writes);
          if (result === "committed") {
            return { status: "committed", data: plan.repairData };
          }
          retryTransaction = transaction;
        } catch (error) {
          await rollback(transaction);
          const replay = await readOperation(input.operationId).catch(
            () => null,
          );
          if (
            replay?.status === "done" &&
            isSameRatingOperation(replay, input)
          ) {
            return { status: "replayed", data: replay };
          }
          throw error;
        }
      }
      throw new GameplayRepositoryFailure();
    },

    getRatingProfile: queryProfile,
    readRatingUpdate: readOperation,

    async tryAcquireRatingLease(input) {
      let retryTransaction: string | undefined;
      for (let attempt = 0; attempt < attempts; attempt++) {
        const transaction = await beginTransaction(retryTransaction);
        const name = operationName(`${input.inviteId}__${input.matchId}`);
        try {
          const document = (await batchGet(transaction, [name])).get(name);
          const data = document ? ratingUpdateFromDocument(document) : null;
          if (data?.status === "done") {
            await rollback(transaction);
            return { status: "done", data };
          }
          const attemptNowMs = now();
          if (
            data?.status === "processing" &&
            data.leaseExpiresAtMs > attemptNowMs &&
            data.ownerToken &&
            data.ownerToken !== input.ownerToken
          ) {
            await rollback(transaction);
            return { status: "busy", data };
          }
          const result = await commit(transaction, [
            updateWrite(name, {
              inviteId: input.inviteId,
              matchId: input.matchId,
              playerId: input.playerId,
              opponentId: input.opponentId,
              ownerUid: input.ownerUid,
              ownerToken: input.ownerToken,
              status: "processing",
              startedAtMs: data?.startedAtMs || attemptNowMs,
              updatedAtMs: attemptNowMs,
              leaseExpiresAtMs: attemptNowMs + input.leaseMs,
            }),
          ]);
          if (result === "committed") {
            return { status: "acquired", data };
          }
          retryTransaction = transaction;
        } catch (error) {
          await rollback(transaction);
          const replay = await readOperation(
            `${input.inviteId}__${input.matchId}`,
          ).catch(() => null);
          if (isSameRatingOperation(replay, input)) {
            if (replay.status === "done") {
              return { status: "done", data: replay };
            }
            if (
              replay.status === "processing" &&
              replay.ownerToken === input.ownerToken
            ) {
              return { status: "acquired", data: replay };
            }
          }
          throw error;
        }
      }
      throw new GameplayRepositoryFailure();
    },
  };
}

export {
  FIRESTORE_TIMEOUT_MS,
  MAX_FIRESTORE_BODY_BYTES,
  MAX_RATING_FIRESTORE_BODY_BYTES,
  MAX_RATING_TRANSACTION_ATTEMPTS,
  decodeFirestoreFields,
  documentPath,
  encodeFirestoreFields,
  isPreconditionConflict,
  parseNavigationGame,
  parseProfileQuery,
  ratingProfileFromDocument,
  ratingUpdateFromDocument,
};
