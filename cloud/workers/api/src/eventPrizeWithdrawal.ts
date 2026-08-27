import {
  getEventPrizeDefinition,
  isEventPrizeStandard,
  isEventPrizeWithdrawalCompletedResponse,
  isEventPrizeWithdrawalRequest,
  isEventPrizeWithdrawalStatusRequest,
  type EventPrizeEventId,
  type EventPrizeId,
  type EventPrizeWithdrawalCompletedResponse,
  type EventPrizeWithdrawalProcessingResponse,
} from "@mons/shared/event-prizes";
import { resolveProfileMergeTargetPath } from "../../../functions/profileMergeTargets.js";
import {
  EVENT_PRIZE_ADMIN_WALLET,
  getEventPrizeWithdrawalPath,
  isCompletedEventPrizeWithdrawal,
  isMatchingProfileEventPrizeAssignment,
  isWithdrawalRecordForPrize,
  isWithdrawalRecordOwnedByRequest,
  normalizeSolanaAddress,
} from "../../../functions/eventPrizeWithdrawalState.js";
import { EventPrizeWithdrawalError } from "../../../functions/eventPrizes/errors.js";
import { attemptCompletedWithdrawalProjectionReconciliation } from "../../../functions/eventPrizes/projectionReconciliation.js";
import { createEventPrizeUmi as createConfiguredEventPrizeUmi } from "../../../functions/eventPrizes/solana.js";
import {
  handleWithdrawEventPrize,
  validatePrizeAssignment,
} from "../../../functions/eventPrizes/withdrawalOrchestrator.js";
import {
  acquireWithdrawalClaim,
  releaseProcessingClaim,
} from "../../../functions/eventPrizes/withdrawalRepository.js";
import {
  AuthApiFailure,
  authErrorResponse,
  type AuthErrorCode,
} from "./authErrors.ts";
import {
  authDocumentName,
  authFieldFilter,
  createAuthFirestoreClient,
  type AuthFirestoreClient,
} from "./authFirestore.ts";
import {
  authJsonResponse,
  authPreflightResponse,
  getAuthCorsHeaders,
} from "./authHttp.ts";
import {
  verifyFirebaseRequest,
  type FirebaseIdentity,
  type WorkerExecutionContext,
} from "./firebaseAuth.ts";
import {
  createGameplayRepository,
  type GameplayRepository,
} from "./gameplayRepository.ts";
import { readBoundedJson } from "./http.ts";
import {
  canonicalEventPrizeWithdrawalStorageMode,
  createD1EventPrizeWithdrawalStore,
  listEventPrizeWithdrawalShadowRepairs,
  parseEventPrizeWithdrawalPath,
  readEventPrizeWithdrawalStorageControl,
  readEventPrizeWithdrawalStorageMode,
  type EventPrizeWithdrawalStore,
} from "./eventPrizeWithdrawalD1.ts";

export const EVENT_PRIZE_WITHDRAWAL_PATH = "/events/prizes/withdrawals";
export const EVENT_PRIZE_WITHDRAWAL_STATUS_PATH =
  "/events/prizes/withdrawals/status";

export type EventPrizeWithdrawalWorkflowParams = {
  schemaVersion: 1;
  kind: "withdrawal";
  eventId: EventPrizeEventId;
  operationId: string;
  prizeId: EventPrizeId;
  profileId: string;
  recipientAddress: string;
  requesterUid: string;
};

export type EventPrizeWithdrawalPreflightParams = {
  schemaVersion: 1;
  kind: "preflight";
};

export type EventPrizeWithdrawalWorkflowInput =
  EventPrizeWithdrawalWorkflowParams | EventPrizeWithdrawalPreflightParams;

export type EventPrizeWithdrawalWorkflowFailure = {
  ok: false;
  status: "failed";
  error:
    | "failed-precondition"
    | "invalid-argument"
    | "not-found"
    | "permission-denied";
  message: string;
};

export type EventPrizeWithdrawalWorkflowOutput =
  | EventPrizeWithdrawalCompletedResponse
  | EventPrizeWithdrawalWorkflowFailure
  | { ok: true; status: "ready" };

type RtdbReference = {
  once(event: "value"): Promise<{ exists(): boolean; val(): unknown }>;
  transaction(
    updater: (current: unknown) => unknown,
    onComplete?: unknown,
    applyLocally?: boolean,
  ): Promise<{
    committed: boolean;
    snapshot: { exists(): boolean; val(): unknown };
  }>;
};

type EventPrizeRuntimeDependencies = {
  admin: {
    database(): {
      ref(path?: string): RtdbReference & {
        update(updates: Record<string, unknown>): Promise<void>;
      };
    };
  };
  createEventPrizeUmi(standard: "compressed" | "core"): unknown;
  now(): number;
  readWithdrawal(
    eventId: string,
    prizeId: string,
  ): Promise<Record<string, unknown> | null>;
  readProfileByLoginUid(uid: string): Promise<{ id: string } | null>;
  removeMatchingProfileEventPrizeAssignment(input: {
    targetRef: RtdbReference;
    eventId: string;
    prizeId: string;
  }): Promise<boolean>;
  resolveCanonicalProfileId(profileId: string): Promise<string>;
  resolveCanonicalProfilePath(profileId: string): Promise<string[]>;
};

type EventPrizeGameplayRepository = Pick<
  GameplayRepository,
  "getRtdbPath" | "patchRtdbRoot" | "transactRtdbPath"
>;

type RouteDependencies = {
  firestore?: AuthFirestoreClient;
  now?: () => number;
  repository?: EventPrizeGameplayRepository;
  verifyIdentity?: (
    request: Request,
    ctx: WorkerExecutionContext,
  ) => Promise<FirebaseIdentity>;
  workflow?: Workflow<EventPrizeWithdrawalWorkflowInput>;
};

type PendingWithdrawalAdmission = {
  leaseId: string;
  params: EventPrizeWithdrawalWorkflowParams;
  releaseLeaseOnFailure: boolean;
};

function toRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function snapshot(value: unknown): { exists(): boolean; val(): unknown } {
  return {
    exists: () => value !== null && value !== undefined,
    val: () => value,
  };
}

function prefixUpdates(
  path: string,
  updates: Record<string, unknown>,
): Record<string, unknown> {
  if (!path) return updates;
  return Object.fromEntries(
    Object.entries(updates).map(([key, value]) => [`${path}/${key}`, value]),
  );
}

function createRtdbReference(
  repository: Pick<
    GameplayRepository,
    "getRtdbPath" | "patchRtdbRoot" | "transactRtdbPath"
  >,
  path: string,
): RtdbReference & {
  update(updates: Record<string, unknown>): Promise<void>;
} {
  return {
    async once(event) {
      if (event !== "value") throw new TypeError("unsupported-rtdb-event");
      return snapshot(await repository.getRtdbPath(path));
    },
    async transaction(updater) {
      const result = await repository.transactRtdbPath(path, (current) => {
        const value = updater(current);
        return value === undefined ? { commit: false } : { value };
      });
      return { committed: result.committed, snapshot: snapshot(result.value) };
    },
    async update(updates) {
      await repository.patchRtdbRoot(prefixUpdates(path, updates));
    },
  };
}

function createFirebaseEventPrizeWithdrawalStore(
  repository: EventPrizeGameplayRepository,
): EventPrizeWithdrawalStore {
  return {
    acknowledgeShadowPaths: async () => undefined,
    async get(eventId, prizeId) {
      return toRecord(
        await repository.getRtdbPath(
          getEventPrizeWithdrawalPath(eventId, prizeId),
        ),
      );
    },
    reference(eventId, prizeId) {
      return createRtdbReference(
        repository,
        getEventPrizeWithdrawalPath(eventId, prizeId),
      );
    },
    replacePaths: (updates) => repository.patchRtdbRoot(updates),
  };
}

function createEventPrizeAdmin(
  repository: EventPrizeGameplayRepository,
  withdrawalStore: EventPrizeWithdrawalStore,
  usesD1: boolean,
): EventPrizeRuntimeDependencies["admin"] {
  const mirrorWithdrawalUpdates = async (
    updates: Record<string, unknown>,
  ): Promise<void> => {
    try {
      await repository.patchRtdbRoot(updates);
      await withdrawalStore.acknowledgeShadowPaths(updates);
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "event_prize_withdrawal_shadow_write_failed",
          errorType: cleanString(toRecord(error)?.name) || "Error",
        }),
      );
    }
  };
  return {
    database: () => ({
      ref: (path = "") => {
        const identity = parseEventPrizeWithdrawalPath(path);
        if (identity) {
          const withdrawalReference = withdrawalStore.reference(
            identity.eventId,
            identity.prizeId,
          );
          if (!usesD1) return withdrawalReference;
          return {
            once: (event) => withdrawalReference.once(event),
            async transaction(updater, onComplete, applyLocally) {
              const result = await withdrawalReference.transaction(
                updater,
                onComplete,
                applyLocally,
              );
              if (result.committed) {
                await mirrorWithdrawalUpdates({
                  [path]: result.snapshot.val(),
                });
              }
              return result;
            },
            async update(updates) {
              await withdrawalReference.update(updates);
              const current = await withdrawalReference.once("value");
              await mirrorWithdrawalUpdates({ [path]: current.val() });
            },
          };
        }
        const reference = createRtdbReference(repository, path);
        if (!usesD1 || path) return reference;
        return {
          ...reference,
          async update(updates) {
            const withdrawalUpdates: Record<string, unknown> = {};
            const firebaseUpdates: Record<string, unknown> = {};
            for (const [updatePath, value] of Object.entries(updates)) {
              if (parseEventPrizeWithdrawalPath(updatePath)) {
                withdrawalUpdates[updatePath] = value;
              } else {
                firebaseUpdates[updatePath] = value;
              }
            }
            if (
              Object.keys(withdrawalUpdates).length > 0 &&
              Object.keys(firebaseUpdates).length > 0
            ) {
              throw new TypeError("cross-storage-root-update");
            }
            if (Object.keys(withdrawalUpdates).length > 0) {
              await withdrawalStore.replacePaths(withdrawalUpdates);
              await mirrorWithdrawalUpdates(withdrawalUpdates);
              return;
            }
            await repository.patchRtdbRoot(firebaseUpdates);
          },
        };
      },
    }),
  };
}

export async function createEventPrizeRuntimeDependencies(
  env: Env,
  {
    firestore = createAuthFirestoreClient(env),
    now = Date.now,
    repository = createGameplayRepository(env),
  }: Pick<RouteDependencies, "firestore" | "now" | "repository"> = {},
): Promise<EventPrizeRuntimeDependencies> {
  const storageMode = await readEventPrizeWithdrawalStorageMode(
    env.EVENT_PRIZE_WITHDRAWALS_DB,
  );
  if (storageMode === "frozen") {
    throw new EventPrizeWithdrawalError(
      "unavailable",
      "Prize withdrawals are temporarily unavailable.",
    );
  }
  const withdrawalStore =
    storageMode === "d1"
      ? createD1EventPrizeWithdrawalStore(env.EVENT_PRIZE_WITHDRAWALS_DB, {
          now,
        })
      : createFirebaseEventPrizeWithdrawalStore(repository);
  const readProfileByLoginUid = async (uid: string) => {
    const profiles = await firestore.query(
      "users",
      authFieldFilter("logins", "ARRAY_CONTAINS", uid),
      2,
      ["mergedIntoProfileId"],
    );
    if (profiles.length > 1) {
      throw new EventPrizeWithdrawalError(
        "failed-precondition",
        "login-profile-conflict",
      );
    }
    return profiles[0] ? { id: profiles[0].id } : null;
  };
  const resolveCanonicalProfilePath = (profileId: string) =>
    resolveProfileMergeTargetPath({
      profileId,
      readMergeTarget: async (candidateProfileId: string) =>
        (
          await firestore.get(
            authDocumentName("profileMergeTargets", candidateProfileId),
          )
        )?.fields || null,
    });
  return {
    admin: createEventPrizeAdmin(
      repository,
      withdrawalStore,
      storageMode === "d1",
    ),
    createEventPrizeUmi: (standard) =>
      createConfiguredEventPrizeUmi(standard, {
        adminPrivateKey: env.EVENT_PRIZE_ADMIN_PRIVATE_KEY,
        heliusRpcApiKey: env.HELIUS_RPC_API_KEY,
      }),
    now,
    readWithdrawal: withdrawalStore.get,
    readProfileByLoginUid,
    async removeMatchingProfileEventPrizeAssignment({
      targetRef,
      eventId,
      prizeId,
    }) {
      const result = await targetRef.transaction((currentAssignment) =>
        isMatchingProfileEventPrizeAssignment(
          currentAssignment,
          eventId,
          prizeId,
        )
          ? null
          : (currentAssignment ?? null),
      );
      return result.committed && result.snapshot.val() === null;
    },
    async resolveCanonicalProfileId(profileId) {
      const path = await resolveCanonicalProfilePath(profileId);
      return path.at(-1) || "";
    },
    resolveCanonicalProfilePath,
  };
}

export async function repairEventPrizeWithdrawalShadows(
  env: Env,
  dependencies: { repository?: EventPrizeGameplayRepository } = {},
): Promise<number> {
  const control = await readEventPrizeWithdrawalStorageControl(
    env.EVENT_PRIZE_WITHDRAWALS_DB,
  );
  if (canonicalEventPrizeWithdrawalStorageMode(control) !== "d1") return 0;
  const repairs = await listEventPrizeWithdrawalShadowRepairs(
    env.EVENT_PRIZE_WITHDRAWALS_DB,
  );
  if (repairs.length === 0) return 0;
  const updates = Object.fromEntries(
    repairs.map((repair) => [repair.path, repair.value]),
  );
  const repository = dependencies.repository || createGameplayRepository(env);
  await repository.patchRtdbRoot(updates);
  await createD1EventPrizeWithdrawalStore(
    env.EVENT_PRIZE_WITHDRAWALS_DB,
  ).acknowledgeShadowPaths(updates);
  console.info(
    JSON.stringify({
      event: "event_prize_withdrawal_shadow_repair_completed",
      repaired: repairs.length,
    }),
  );
  return repairs.length;
}

function errorStatus(code: string): number {
  if (code === "invalid-argument") return 400;
  if (code === "unauthenticated") return 401;
  if (code === "permission-denied") return 403;
  if (code === "not-found") return 404;
  if (code === "aborted") return 409;
  if (code === "failed-precondition") return 412;
  if (code === "resource-exhausted") return 429;
  return 503;
}

function isMappedErrorCode(code: string): code is AuthErrorCode {
  return (
    code === "aborted" ||
    code === "failed-precondition" ||
    code === "invalid-argument" ||
    code === "not-found" ||
    code === "permission-denied" ||
    code === "resource-exhausted" ||
    code === "unauthenticated"
  );
}

export function toEventPrizeApiFailure(error: unknown): AuthApiFailure {
  if (error instanceof AuthApiFailure) return error;
  const record = toRecord(error);
  const code = cleanString(record?.code || record?.error);
  const message = cleanString(record?.message);
  if (isMappedErrorCode(code)) {
    return new AuthApiFailure(
      errorStatus(code),
      code,
      message || "Prize withdrawal is unavailable.",
    );
  }
  return new AuthApiFailure(
    503,
    "unavailable",
    "Prize withdrawal service is unavailable.",
  );
}

function buildCompletedResponse(
  operationId: string,
  withdrawal: Record<string, unknown>,
): EventPrizeWithdrawalCompletedResponse {
  const response = {
    ok: true,
    status: "completed" as const,
    operationId,
    eventId: cleanString(withdrawal.eventId),
    prizeId: cleanString(withdrawal.prizeId),
    assetAddress: cleanString(withdrawal.assetAddress),
    recipientAddress: cleanString(withdrawal.recipientAddress),
    transactionSignature: cleanString(withdrawal.transactionSignature),
  };
  if (!isEventPrizeWithdrawalCompletedResponse(response)) {
    throw new EventPrizeWithdrawalError(
      "internal",
      "Prize withdrawal result is unavailable.",
    );
  }
  if (response.recipientAddress === EVENT_PRIZE_ADMIN_WALLET) {
    throw new EventPrizeWithdrawalError(
      "permission-denied",
      "Prize withdrawal is unavailable.",
    );
  }
  return response;
}

function terminalWorkflowFailure(): AuthApiFailure {
  return new AuthApiFailure(
    503,
    "unavailable",
    "Prize withdrawal service is unavailable.",
    { terminal: true },
  );
}

export async function buildEventPrizeWithdrawalOperationId(
  eventId: string,
  prizeId: string,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${eventId}\n${prizeId}`),
  );
  return `epw_${Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")}`;
}

export async function parseEventPrizeWithdrawalWorkflowParams(
  value: unknown,
  instanceId: string,
): Promise<EventPrizeWithdrawalWorkflowParams | null> {
  const record = toRecord(value);
  const request = {
    eventId: record?.eventId,
    prizeId: record?.prizeId,
    solanaAddress: record?.recipientAddress,
  };
  if (
    !record ||
    Object.keys(record).length !== 8 ||
    record.schemaVersion !== 1 ||
    record.kind !== "withdrawal" ||
    !isEventPrizeWithdrawalRequest(request) ||
    cleanString(record.operationId) !== instanceId ||
    !cleanString(record.profileId) ||
    !cleanString(record.requesterUid)
  ) {
    return null;
  }
  const operationId = await buildEventPrizeWithdrawalOperationId(
    String(record.eventId),
    String(record.prizeId),
  );
  if (operationId !== instanceId) return null;
  return {
    schemaVersion: 1,
    kind: "withdrawal",
    eventId: request.eventId,
    operationId,
    prizeId: request.prizeId,
    profileId: cleanString(record.profileId),
    recipientAddress: request.solanaAddress,
    requesterUid: cleanString(record.requesterUid),
  };
}

async function ensureWorkflow(
  workflow: Workflow<EventPrizeWithdrawalWorkflowInput>,
  params: EventPrizeWithdrawalWorkflowParams,
): Promise<void> {
  let instance: WorkflowInstance | null = null;
  try {
    const instances = await workflow.createBatch([
      {
        id: params.operationId,
        params,
        retention: { successRetention: "1 day", errorRetention: "30 days" },
      },
    ]);
    instance = instances[0] || null;
  } catch (error) {
    try {
      instance = await workflow.get(params.operationId);
    } catch {
      throw error;
    }
  }
  instance ||= await workflow.get(params.operationId);
  const status = await instance.status();
  if (status.status === "errored" || status.status === "complete") {
    const output = toRecord(status.output);
    if (
      status.status === "complete" &&
      isEventPrizeWithdrawalCompletedResponse(output)
    ) {
      return;
    }
    await instance.delete();
    await workflow.createBatch([
      {
        id: params.operationId,
        params,
        retention: { successRetention: "1 day", errorRetention: "30 days" },
      },
    ]);
    return;
  }
  if (
    status.status === "terminated" ||
    status.status === "paused" ||
    status.status === "waitingForPause"
  ) {
    throw new EventPrizeWithdrawalError(
      "failed-precondition",
      "Prize withdrawal is paused by an operator.",
    );
  }
  if (status.status === "unknown") {
    throw new Error("event-prize-withdrawal-workflow-unknown");
  }
}

async function resolveOwnedWithdrawal(
  identity: FirebaseIdentity,
  eventId: string,
  prizeId: string,
  runtime: EventPrizeRuntimeDependencies,
): Promise<{
  canonicalRecordProfileId: string;
  profileId: string;
  withdrawal: Record<string, unknown> | null;
}> {
  const profile = await runtime.readProfileByLoginUid(identity.uid);
  const profileId = cleanString(profile?.id);
  if (!profileId) {
    throw new EventPrizeWithdrawalError("not-found", "profile-not-found");
  }
  const withdrawal = await runtime.readWithdrawal(eventId, prizeId);
  if (!withdrawal) {
    return { canonicalRecordProfileId: "", profileId, withdrawal: null };
  }
  const existingProfileId = cleanString(withdrawal.profileId);
  let canonicalRecordProfileId = existingProfileId;
  let owned = isWithdrawalRecordOwnedByRequest(
    withdrawal,
    profileId,
    identity.uid,
  );
  if (!owned && existingProfileId && existingProfileId !== profileId) {
    canonicalRecordProfileId =
      await runtime.resolveCanonicalProfileId(existingProfileId);
    owned = isWithdrawalRecordOwnedByRequest(
      withdrawal,
      profileId,
      identity.uid,
      canonicalRecordProfileId,
      existingProfileId,
    );
  }
  if (!owned) {
    throw new EventPrizeWithdrawalError(
      "permission-denied",
      "Prize withdrawal is unavailable.",
    );
  }
  return { canonicalRecordProfileId, profileId, withdrawal };
}

async function admitWithdrawal(
  identity: FirebaseIdentity,
  request: {
    eventId: EventPrizeEventId;
    prizeId: EventPrizeId;
    solanaAddress: string;
  },
  operationId: string,
  runtime: EventPrizeRuntimeDependencies,
  repository: EventPrizeGameplayRepository,
): Promise<EventPrizeWithdrawalCompletedResponse | PendingWithdrawalAdmission> {
  const prize = getEventPrizeDefinition(request.eventId, request.prizeId);
  const assetAddress = normalizeSolanaAddress(prize?.assetAddress);
  const collectionAddress = normalizeSolanaAddress(prize?.collectionAddress);
  if (
    !prize ||
    prize.claimAvailable !== true ||
    !isEventPrizeStandard(prize.standard) ||
    assetAddress !== cleanString(prize.assetAddress) ||
    collectionAddress !== cleanString(prize.collectionAddress)
  ) {
    throw new EventPrizeWithdrawalError(
      "invalid-argument",
      "Unsupported event prize.",
    );
  }
  const recipientAddress = normalizeSolanaAddress(request.solanaAddress);
  if (!recipientAddress) {
    throw new EventPrizeWithdrawalError(
      "invalid-argument",
      "A valid Solana address is required.",
    );
  }
  if (recipientAddress === EVENT_PRIZE_ADMIN_WALLET) {
    throw new EventPrizeWithdrawalError(
      "invalid-argument",
      "Choose a destination other than the prize wallet.",
    );
  }

  const { canonicalRecordProfileId, profileId, withdrawal } =
    await resolveOwnedWithdrawal(
      identity,
      request.eventId,
      request.prizeId,
      runtime,
    );
  if (
    withdrawal &&
    isCompletedEventPrizeWithdrawal(
      withdrawal,
      request.eventId,
      request.prizeId,
    )
  ) {
    const completed = buildCompletedResponse(operationId, withdrawal);
    await attemptCompletedWithdrawalProjectionReconciliation(
      {
        withdrawal,
        profileIds: [profileId],
        eventId: request.eventId,
        prizeId: request.prizeId,
      },
      runtime,
    );
    return completed;
  }

  const existingProfileId = cleanString(withdrawal?.profileId);
  const submittedRecordCanResume =
    withdrawal?.status === "submitted" &&
    isWithdrawalRecordForPrize(
      withdrawal,
      request.eventId,
      request.prizeId,
      assetAddress,
    ) &&
    Boolean(normalizeSolanaAddress(withdrawal.recipientAddress)) &&
    [1, 2, 3].includes(Number(withdrawal.place));
  let place = Number(withdrawal?.place);
  if (!submittedRecordCanResume) {
    const assignment = await repository.getRtdbPath(
      `profileEventPrizes/${profileId}/${request.eventId}`,
    );
    place = validatePrizeAssignment({
      assignment,
      eventId: request.eventId,
      prizeId: request.prizeId,
      profileId,
    });
  }
  const params: EventPrizeWithdrawalWorkflowParams = {
    schemaVersion: 1,
    kind: "withdrawal",
    eventId: request.eventId,
    operationId,
    prizeId: request.prizeId,
    profileId,
    recipientAddress,
    requesterUid: identity.uid,
  };
  const activeLeaseId = cleanString(withdrawal?.leaseId);
  const activeProcessingIntent =
    withdrawal?.status === "processing" &&
    Boolean(activeLeaseId) &&
    isWithdrawalRecordForPrize(
      withdrawal,
      request.eventId,
      request.prizeId,
      assetAddress,
    );
  if (activeProcessingIntent) {
    if (
      normalizeSolanaAddress(withdrawal.recipientAddress) !== recipientAddress
    ) {
      throw new EventPrizeWithdrawalError(
        "failed-precondition",
        "The pending withdrawal is locked to its original destination.",
      );
    }
    return {
      leaseId: activeLeaseId,
      params,
      releaseLeaseOnFailure: false,
    };
  }
  const claim = await acquireWithdrawalClaim({
    withdrawalRef: runtime.admin
      .database()
      .ref(getEventPrizeWithdrawalPath(request.eventId, request.prizeId)),
    eventId: request.eventId,
    prizeId: request.prizeId,
    assetAddress,
    profileId,
    place,
    recipientAddress,
    requesterUid: identity.uid,
    canonicalRecordProfileId,
    canonicalRecordSourceProfileId: existingProfileId,
  });
  if (claim.completed) {
    return buildCompletedResponse(operationId, claim.completed);
  }
  const leaseId = cleanString(claim.leaseId);
  if (!leaseId) throw new Error("event-prize-withdrawal-lease-missing");
  return {
    leaseId,
    params,
    releaseLeaseOnFailure: true,
  };
}

export async function resolveEventPrizeWithdrawalExecutionParams(
  params: EventPrizeWithdrawalWorkflowParams,
  runtime: Pick<EventPrizeRuntimeDependencies, "readWithdrawal">,
): Promise<EventPrizeWithdrawalWorkflowParams> {
  const withdrawal = await runtime.readWithdrawal(
    params.eventId,
    params.prizeId,
  );
  const prize = getEventPrizeDefinition(params.eventId, params.prizeId);
  const currentRecipientAddress = normalizeSolanaAddress(
    withdrawal?.recipientAddress,
  );
  const currentRequesterUid = cleanString(withdrawal?.requesterUid);
  return withdrawal?.status === "processing" &&
    prize &&
    isWithdrawalRecordForPrize(
      withdrawal,
      params.eventId,
      params.prizeId,
      prize.assetAddress,
    ) &&
    currentRecipientAddress &&
    currentRequesterUid
    ? {
        ...params,
        profileId: cleanString(withdrawal.profileId) || params.profileId,
        recipientAddress: currentRecipientAddress,
        requesterUid: currentRequesterUid,
      }
    : params;
}

export function createEventPrizeExecutionProfileReader(
  params: Pick<
    EventPrizeWithdrawalWorkflowParams,
    "profileId" | "requesterUid"
  >,
  runtime: Pick<
    EventPrizeRuntimeDependencies,
    "readProfileByLoginUid" | "resolveCanonicalProfileId"
  >,
): EventPrizeRuntimeDependencies["readProfileByLoginUid"] {
  return async (uid) => {
    if (uid !== params.requesterUid) {
      return runtime.readProfileByLoginUid(uid);
    }
    const profileId =
      cleanString(await runtime.resolveCanonicalProfileId(params.profileId)) ||
      params.profileId;
    return { id: profileId };
  };
}

export async function executeEventPrizeWithdrawal(
  env: Env,
  params: EventPrizeWithdrawalWorkflowParams,
  dependencies: Pick<
    RouteDependencies,
    "firestore" | "now" | "repository"
  > = {},
): Promise<EventPrizeWithdrawalCompletedResponse> {
  const repository = dependencies.repository || createGameplayRepository(env);
  const runtime = await createEventPrizeRuntimeDependencies(env, {
    ...dependencies,
    repository,
  });
  const executionParams = await resolveEventPrizeWithdrawalExecutionParams(
    params,
    runtime,
  );
  const executionRuntime: EventPrizeRuntimeDependencies = {
    ...runtime,
    readProfileByLoginUid: createEventPrizeExecutionProfileReader(
      executionParams,
      runtime,
    ),
  };
  const result = await handleWithdrawEventPrize(
    {
      auth: { uid: executionParams.requesterUid },
      data: {
        eventId: executionParams.eventId,
        prizeId: executionParams.prizeId,
        solanaAddress: executionParams.recipientAddress,
      },
    },
    executionRuntime,
  );
  const completed = toRecord(result);
  if (!completed) {
    throw new EventPrizeWithdrawalError(
      "internal",
      "Prize withdrawal result is unavailable.",
    );
  }
  return buildCompletedResponse(params.operationId, completed);
}

export async function handleEventPrizeWithdrawalRoute(
  request: Request,
  env: Env,
  ctx: WorkerExecutionContext,
  dependencies: RouteDependencies = {},
): Promise<Response> {
  let corsHeaders: Record<string, string> = { Vary: "Origin" };
  try {
    corsHeaders = getAuthCorsHeaders(request);
    if (request.method === "OPTIONS") return authPreflightResponse(corsHeaders);
    if (request.method !== "POST") {
      throw new AuthApiFailure(405, "method-not-allowed", "method-not-allowed");
    }
    const pathname = new URL(request.url).pathname;
    const identity = await (
      dependencies.verifyIdentity || verifyFirebaseRequest
    )(request, ctx);
    let body: unknown;
    try {
      body = await readBoundedJson(request);
    } catch {
      throw new AuthApiFailure(400, "invalid-argument", "invalid-request");
    }
    const repository = dependencies.repository || createGameplayRepository(env);
    const runtime = await createEventPrizeRuntimeDependencies(env, {
      firestore: dependencies.firestore,
      now: dependencies.now,
      repository,
    });
    const workflow =
      dependencies.workflow || env.EVENT_PRIZE_WITHDRAWAL_WORKFLOW;

    if (pathname === EVENT_PRIZE_WITHDRAWAL_PATH) {
      if (!isEventPrizeWithdrawalRequest(body)) {
        throw new AuthApiFailure(400, "invalid-argument", "invalid-request");
      }
      const operationId = await buildEventPrizeWithdrawalOperationId(
        body.eventId,
        body.prizeId,
      );
      const admission = await admitWithdrawal(
        identity,
        body,
        operationId,
        runtime,
        repository,
      );
      if ("status" in admission) {
        return authJsonResponse(admission, 200, corsHeaders);
      }
      try {
        await ensureWorkflow(workflow, admission.params);
      } catch (error) {
        if (admission.releaseLeaseOnFailure) {
          await releaseProcessingClaim({
            withdrawalRef: runtime.admin
              .database()
              .ref(getEventPrizeWithdrawalPath(body.eventId, body.prizeId)),
            leaseId: admission.leaseId,
          }).catch(() => undefined);
        }
        throw error;
      }
      const processing: EventPrizeWithdrawalProcessingResponse = {
        ok: true,
        status: "processing",
        operationId,
        eventId: body.eventId,
        prizeId: body.prizeId,
      };
      return authJsonResponse(processing, 202, corsHeaders);
    }

    if (pathname === EVENT_PRIZE_WITHDRAWAL_STATUS_PATH) {
      if (!isEventPrizeWithdrawalStatusRequest(body)) {
        throw new AuthApiFailure(400, "invalid-argument", "invalid-request");
      }
      const expectedOperationId = await buildEventPrizeWithdrawalOperationId(
        body.eventId,
        body.prizeId,
      );
      if (body.operationId !== expectedOperationId) {
        throw new AuthApiFailure(400, "invalid-argument", "invalid-request");
      }
      let owned = await resolveOwnedWithdrawal(
        identity,
        body.eventId,
        body.prizeId,
        runtime,
      );
      if (!owned.withdrawal) {
        const assignment = await repository.getRtdbPath(
          `profileEventPrizes/${owned.profileId}/${body.eventId}`,
        );
        validatePrizeAssignment({
          assignment,
          eventId: body.eventId,
          prizeId: body.prizeId,
          profileId: owned.profileId,
        });
      }
      if (
        owned.withdrawal &&
        isCompletedEventPrizeWithdrawal(
          owned.withdrawal,
          body.eventId,
          body.prizeId,
        )
      ) {
        return authJsonResponse(
          buildCompletedResponse(body.operationId, owned.withdrawal),
          200,
          corsHeaders,
        );
      }
      if (owned.withdrawal?.status === "blocked") {
        throw new AuthApiFailure(
          412,
          "failed-precondition",
          "This prize is unavailable for withdrawal.",
        );
      }
      let instance: WorkflowInstance;
      try {
        instance = await workflow.get(body.operationId);
      } catch {
        throw new AuthApiFailure(
          503,
          "unavailable",
          "Prize withdrawal service is unavailable.",
        );
      }
      const status = await instance.status();
      if (status.status === "complete") {
        const output = toRecord(status.output);
        if (output?.ok === false && output.status === "failed") {
          throw toEventPrizeApiFailure(output);
        }
        owned = await resolveOwnedWithdrawal(
          identity,
          body.eventId,
          body.prizeId,
          runtime,
        );
        if (
          owned.withdrawal &&
          isCompletedEventPrizeWithdrawal(
            owned.withdrawal,
            body.eventId,
            body.prizeId,
          )
        ) {
          return authJsonResponse(
            buildCompletedResponse(body.operationId, owned.withdrawal),
            200,
            corsHeaders,
          );
        }
        throw terminalWorkflowFailure();
      }
      if (status.status === "errored" || status.status === "terminated") {
        throw terminalWorkflowFailure();
      }
      if (status.status === "unknown") {
        throw new AuthApiFailure(
          503,
          "unavailable",
          "Prize withdrawal service is unavailable.",
        );
      }
      const processing: EventPrizeWithdrawalProcessingResponse = {
        ok: true,
        status: "processing",
        operationId: body.operationId,
        eventId: body.eventId,
        prizeId: body.prizeId,
      };
      return authJsonResponse(processing, 202, corsHeaders);
    }
    throw new AuthApiFailure(404, "not-found", "not-found");
  } catch (error) {
    const failure = toEventPrizeApiFailure(error);
    if (failure.status >= 500) {
      console.error(
        JSON.stringify({
          event: "event_prize_withdrawal_route_failure",
          kind: failure.code,
        }),
      );
    }
    return authErrorResponse(failure, corsHeaders);
  }
}
