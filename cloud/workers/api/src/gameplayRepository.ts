import {
  MATERIAL_KEYS,
  normalizeMaterials,
  normalizeMiningSnapshot,
  type MiningMaterialName,
  type MiningMaterials,
  type MiningSnapshot,
} from "@mons/shared/mining";
import {
  PROFILE_MERGE_TARGETS_COLLECTION,
  resolveProfileMergeTargetPath,
} from "../../../functions/profileMergeTargets.js";
import { cancelResponseBody, readBoundedJsonValue } from "./boundedStreams.ts";
import {
  createFirebaseRtdbClient,
  type FirebaseRtdbClient,
  type FirebaseRtdbQuery,
  type FirebaseRtdbTransactionResult,
} from "./firebaseRtdb.ts";
import { isSafeFirestoreDocumentId } from "./firebaseKeys.ts";
import { createGoogleAccessToken } from "./googleAuth.ts";
import {
  createFirestoreRestCodec,
  createFirestoreRestTransport,
  isFirestorePreconditionConflict,
  toFirestoreRecord,
  type FirestoreRestDocument,
} from "./firestoreRest.ts";

const FIRESTORE_PROJECT_ID = "mons-link";
const FIRESTORE_DATABASE_ID = "(default)";
const FIRESTORE_DATABASE_NAME = `projects/${FIRESTORE_PROJECT_ID}/databases/${FIRESTORE_DATABASE_ID}`;
const FIRESTORE_DOCUMENT_NAME_ROOT = `${FIRESTORE_DATABASE_NAME}/documents`;
const FIRESTORE_DOCUMENTS_ROOT = `https://firestore.googleapis.com/v1/${FIRESTORE_DOCUMENT_NAME_ROOT}`;
const FIRESTORE_TIMEOUT_MS = 5_000;
const MAX_FIRESTORE_BODY_BYTES = 64 * 1024;
const MAX_RATING_FIRESTORE_BODY_BYTES = 256 * 1024;
const MAX_RATING_TRANSACTION_ATTEMPTS = 5;
const MAX_WAGER_TRANSFER_TRANSACTION_ATTEMPTS = 5;

type FirestoreDocument = FirestoreRestDocument;

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

export type GameplayProfile = {
  aura: string;
  emoji: number | string;
  eth: string;
  profileId: string;
  rating: number;
  sol: string;
  username: string;
};

export type RatingProfile = GameplayProfile & {
  feb2026UniqueOpponents: string[];
  nonce: number;
  totalManaPoints: number;
};

export type RatingUpdateData = {
  completedAtMs?: number;
  eventId?: string;
  eventOwned?: boolean;
  inviteId: string;
  isEventMatch?: boolean;
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
  telegramDeliveryVersion?: number | null;
  telegramProjectionReason?: string;
  telegramProjectionState?: string;
  telegramProjectionUpdatedAtMs?: number;
  telegramProjectionVersion?: number;
  updateRatingMessage?: string;
};

export type PendingRatingTelegramProjection = {
  operationId: string;
  updateTime: string;
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

export type RatingProjectionRepository = RatingRepository & {
  claimRatingTelegramProjection: (
    operationId: string,
    updateTime: string,
    claimedAtMs: number,
  ) => Promise<boolean>;
  listDueRatingTelegramProjections: (
    updatedBeforeMs: number,
    limit: number,
  ) => Promise<PendingRatingTelegramProjection[]>;
  markRatingTelegramProjection: (
    operationId: string,
    state: "dead" | "done",
    updatedAtMs: number,
    reason?: string,
  ) => Promise<void>;
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
  getGameplayProfile: (
    uid: string,
    firebaseIdToken: string,
    signal?: AbortSignal,
  ) => Promise<GameplayProfile | null>;
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

const toRecord = toFirestoreRecord;
const firestoreCodec = createFirestoreRestCodec(
  () => new GameplayRepositoryFailure(),
);
const isPreconditionConflict = isFirestorePreconditionConflict;

function parseFirestoreDocument(value: unknown): FirestoreDocument {
  return firestoreCodec.parseDocument(value);
}

function parseFirestoreDocuments(value: unknown): FirestoreDocument[] {
  return firestoreCodec.parseDocuments(value);
}

function decodeFirestoreFields(
  fields: Record<string, unknown>,
): Record<string, unknown> {
  return firestoreCodec.decodeFields(fields);
}

function encodeFirestoreFields(
  fields: Record<string, unknown>,
): Record<string, unknown> {
  return firestoreCodec.encodeFields(fields);
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

export function parseGameplayProfileQuery(
  value: unknown,
): GameplayProfile | null {
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
    completedAtMs: number(fields.completedAtMs),
    eventId: string(fields.eventId),
    eventOwned: fields.eventOwned === true,
    inviteId: string(fields.inviteId),
    isEventMatch: fields.isEventMatch === true,
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
    telegramDeliveryVersion:
      number(fields.telegramDeliveryVersion) > 0
        ? number(fields.telegramDeliveryVersion)
        : null,
    telegramProjectionReason: string(fields.telegramProjectionReason),
    telegramProjectionState: string(fields.telegramProjectionState),
    telegramProjectionUpdatedAtMs: number(fields.telegramProjectionUpdatedAtMs),
    telegramProjectionVersion: number(fields.telegramProjectionVersion),
    updateRatingMessage: string(fields.updateRatingMessage),
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
  const wagerTransport = createFirestoreRestTransport({
    createFailure: () => new GameplayRepositoryFailure(),
    documentsRoot: FIRESTORE_DOCUMENTS_ROOT,
    fetcher,
    getAccessToken: getFirestoreAccessToken,
    maxBodyBytes: MAX_FIRESTORE_BODY_BYTES,
    timeoutMs,
  });
  const batchGetWagerDocuments = async (
    transaction: string,
    names: string[],
  ): Promise<Map<string, FirestoreDocument | null>> => {
    const uniqueNames = Array.from(new Set(names));
    const response = await wagerTransport.post(
      `${FIRESTORE_DOCUMENTS_ROOT}:batchGet`,
      { documents: uniqueNames, transaction },
    );
    const body = await wagerTransport.readJson(response);
    if (!Array.isArray(body)) {
      throw new GameplayRepositoryFailure();
    }
    const documents = new Map<string, FirestoreDocument | null>();
    for (const entry of body) {
      const result = toRecord(entry);
      if (result?.found !== undefined) {
        const document = parseFirestoreDocument(result.found);
        documents.set(document.name, document);
      } else if (typeof result?.missing === "string") {
        documents.set(result.missing, null);
      }
    }
    if (uniqueNames.some((name) => !documents.has(name))) {
      throw new GameplayRepositoryFailure();
    }
    return documents;
  };
  const wagerLedgerName = (operationId: string) =>
    `${FIRESTORE_DOCUMENT_NAME_ROOT}/wagerSettlements/${encodeURIComponent(operationId)}`;
  const mergeTargetName = (profileId: string) =>
    `${FIRESTORE_DOCUMENT_NAME_ROOT}/${PROFILE_MERGE_TARGETS_COLLECTION}/${encodeURIComponent(profileId)}`;

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
      const ledgerName = wagerLedgerName(input.operationId);
      let retryTransaction: string | undefined;
      for (
        let attempt = 0;
        attempt < MAX_WAGER_TRANSFER_TRANSACTION_ATTEMPTS;
        attempt++
      ) {
        const transaction =
          await wagerTransport.beginTransaction(retryTransaction);
        try {
          const targetNames = [
            mergeTargetName(input.winnerProfileId),
            mergeTargetName(input.loserProfileId),
          ];
          const initialDocuments = await batchGetWagerDocuments(transaction, [
            ledgerName,
            ...targetNames,
          ]);
          const ledger = initialDocuments.get(ledgerName);
          if (ledger) {
            const fingerprint = readFirestoreString(ledger.fields.fingerprint);
            if (!fingerprint || fingerprint !== input.fingerprint) {
              throw new GameplayRepositoryFailure();
            }
            await wagerTransport.rollback(transaction);
            return "replayed";
          }
          const mergeTargets = new Map<string, FirestoreDocument | null>(
            targetNames.map((name) => [
              name,
              initialDocuments.get(name) || null,
            ]),
          );
          const readMergeTarget = async (profileId: string) => {
            const name = mergeTargetName(profileId);
            if (!mergeTargets.has(name)) {
              const document = (
                await batchGetWagerDocuments(transaction, [name])
              ).get(name);
              mergeTargets.set(name, document || null);
            }
            const document = mergeTargets.get(name);
            if (!document) {
              return null;
            }
            const targetProfileId = readFirestoreString(
              document.fields.targetProfileId,
            );
            if (!isSafeFirestoreDocumentId(targetProfileId)) {
              throw new GameplayRepositoryFailure();
            }
            return { targetProfileId };
          };
          const winnerProfilePath = await resolveProfileMergeTargetPath({
            profileId: input.winnerProfileId,
            readMergeTarget,
          });
          const loserProfilePath = await resolveProfileMergeTargetPath({
            profileId: input.loserProfileId,
            readMergeTarget,
          });
          const winnerProfileId = winnerProfilePath.at(-1);
          const loserProfileId = loserProfilePath.at(-1);
          if (!winnerProfileId || !loserProfileId) {
            throw new GameplayRepositoryFailure();
          }
          const writes: Array<Record<string, unknown>> = [
            {
              update: {
                name: ledgerName,
                fields: encodeWagerTransferLedger({
                  ...input,
                  winnerProfileId,
                  loserProfileId,
                }),
              },
              currentDocument: { exists: false },
            },
          ];
          if (winnerProfileId !== loserProfileId) {
            writes.push(
              {
                transform: {
                  document: `${FIRESTORE_DOCUMENT_NAME_ROOT}/${documentPath(winnerProfileId)}`,
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
                  document: `${FIRESTORE_DOCUMENT_NAME_ROOT}/${documentPath(loserProfileId)}`,
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
          const result = await wagerTransport.commit(writes, transaction);
          if (result === "committed") {
            return "applied";
          }
          retryTransaction = transaction;
        } catch (error) {
          await wagerTransport.rollback(transaction);
          if (await readWagerTransferLedger(input).catch(() => false)) {
            return "replayed";
          }
          throw error instanceof GameplayRepositoryFailure
            ? error
            : new GameplayRepositoryFailure();
        }
      }
      if (await readWagerTransferLedger(input)) {
        return "replayed";
      }
      throw new GameplayRepositoryFailure();
    },

    getRtdbPath: rtdbClient.getPath,
    patchRtdbRoot: rtdbClient.patchRoot,
    transactRtdbPath: rtdbClient.transactPath,

    async getGameplayProfile(uid, firebaseIdToken, signal) {
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
      return parseGameplayProfileQuery(
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
): RatingProjectionRepository {
  const attempts =
    Number.isInteger(maxTransactionAttempts) && maxTransactionAttempts > 0
      ? maxTransactionAttempts
      : MAX_RATING_TRANSACTION_ATTEMPTS;
  const transport = createFirestoreRestTransport({
    createFailure: () => new GameplayRepositoryFailure(),
    documentsRoot: FIRESTORE_DOCUMENTS_ROOT,
    fetcher,
    getAccessToken: () =>
      getAccessToken(env, {
        credentials: {
          email: env.RATING_SERVICE_ACCOUNT_EMAIL,
          privateKeyPem: env.RATING_SERVICE_ACCOUNT_PRIVATE_KEY,
        },
        fetcher,
        now,
        timeoutMs,
      }),
    maxBodyBytes: MAX_RATING_FIRESTORE_BODY_BYTES,
    timeoutMs,
  });
  const { post: postJson, readJson, request } = transport;
  const operationName = (operationId: string) =>
    `${FIRESTORE_DOCUMENT_NAME_ROOT}/ratingUpdates/${operationId}`;
  const profileName = (profileId: string) =>
    `${FIRESTORE_DOCUMENT_NAME_ROOT}/users/${profileId}`;
  const beginTransaction = transport.beginTransaction;
  const rollback = transport.rollback;
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
  ): Promise<"committed" | "conflict"> => transport.commit(writes, transaction);

  return {
    getRtdbPath: gameplayRepository.getRtdbPath,
    patchRtdbRoot: gameplayRepository.patchRtdbRoot,

    async claimRatingTelegramProjection(operationId, updateTime, claimedAtMs) {
      if (
        !operationId ||
        !updateTime ||
        !Number.isSafeInteger(claimedAtMs) ||
        claimedAtMs < 0
      ) {
        throw new GameplayRepositoryFailure();
      }
      const url = new URL(
        `${FIRESTORE_DOCUMENTS_ROOT}/ratingUpdates/${encodeURIComponent(operationId)}`,
      );
      url.searchParams.append(
        "updateMask.fieldPaths",
        "telegramProjectionUpdatedAtMs",
      );
      url.searchParams.set("currentDocument.updateTime", updateTime);
      const response = await request(url.toString(), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fields: encodeFirestoreFields({
            telegramProjectionUpdatedAtMs: claimedAtMs,
          }),
        }),
      });
      if (response.ok) {
        await cancelResponseBody(response);
        return true;
      }
      if (response.status === 409 || response.status === 412) {
        await cancelResponseBody(response);
        return false;
      }
      if (response.status === 400) {
        const body = await readBoundedJsonValue(
          response,
          MAX_RATING_FIRESTORE_BODY_BYTES,
          () => new GameplayRepositoryFailure(),
        );
        if (isPreconditionConflict(body)) {
          return false;
        }
        throw new GameplayRepositoryFailure();
      }
      await cancelResponseBody(response);
      throw new GameplayRepositoryFailure();
    },

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

    async listDueRatingTelegramProjections(updatedBeforeMs, limit) {
      if (
        !Number.isSafeInteger(updatedBeforeMs) ||
        updatedBeforeMs < 0 ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 100
      ) {
        throw new GameplayRepositoryFailure();
      }
      const response = await postJson(`${FIRESTORE_DOCUMENTS_ROOT}:runQuery`, {
        structuredQuery: {
          select: {
            fields: [{ fieldPath: "telegramProjectionUpdatedAtMs" }],
          },
          from: [{ collectionId: "ratingUpdates" }],
          where: {
            compositeFilter: {
              op: "AND",
              filters: [
                {
                  fieldFilter: {
                    field: { fieldPath: "telegramProjectionState" },
                    op: "EQUAL",
                    value: { stringValue: "pending" },
                  },
                },
                {
                  fieldFilter: {
                    field: { fieldPath: "telegramProjectionUpdatedAtMs" },
                    op: "LESS_THAN_OR_EQUAL",
                    value: { integerValue: String(updatedBeforeMs) },
                  },
                },
              ],
            },
          },
          orderBy: [
            {
              field: { fieldPath: "telegramProjectionUpdatedAtMs" },
              direction: "ASCENDING",
            },
          ],
          limit,
        },
      });
      return parseFirestoreDocuments(await readJson(response)).map(
        (document) => {
          const operationId = document.name.split("/").pop()?.trim() || "";
          if (!operationId) {
            throw new GameplayRepositoryFailure();
          }
          if (!document.updateTime) {
            throw new GameplayRepositoryFailure();
          }
          return {
            operationId,
            updateTime: document.updateTime,
          };
        },
      );
    },

    async markRatingTelegramProjection(
      operationId,
      state,
      updatedAtMs,
      reason,
    ) {
      if (
        !operationId ||
        (state !== "dead" && state !== "done") ||
        !Number.isSafeInteger(updatedAtMs) ||
        updatedAtMs < 0
      ) {
        throw new GameplayRepositoryFailure();
      }
      const fields = {
        telegramProjectionState: state,
        telegramProjectionUpdatedAtMs: updatedAtMs,
        telegramProjectionReason: reason?.trim() || null,
      };
      const url = new URL(
        `${FIRESTORE_DOCUMENTS_ROOT}/ratingUpdates/${encodeURIComponent(operationId)}`,
      );
      for (const fieldPath of Object.keys(fields)) {
        url.searchParams.append("updateMask.fieldPaths", fieldPath);
      }
      url.searchParams.set("currentDocument.exists", "true");
      const response = await request(url.toString(), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fields: encodeFirestoreFields(fields) }),
      });
      await cancelResponseBody(response);
      if (!response.ok) {
        throw new GameplayRepositoryFailure();
      }
    },

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
