import { isSafeFirestoreDocIdSegment } from "@mons/shared/usernames";
import {
  MAX_PROFILE_MERGE_TARGET_HOPS,
  PROFILE_MERGE_TARGETS_COLLECTION,
} from "../../../functions/profileMergeTargets.js";
import { createAuthIdentityService } from "./authIdentity.ts";
import {
  type AuthFirestoreClient,
  type AuthFirestoreDocument,
  authDeleteWrite,
  authDocumentName,
  authFieldFilter,
  authUpdateWrite,
  createAuthFirestoreClient,
} from "./authFirestore.ts";
import {
  enqueueAuthRecovery as enqueueProfileRecovery,
  parseAuthRecoveryTask,
} from "./authRecoveryTask.ts";
import {
  cleanString,
  PENDING_CLAIM_SYNC_FIELD_PATHS,
  PENDING_MERGE_GAME_COPY_FIELD_PATHS,
  uniqueStoredFirebaseUids,
} from "./authPolicy.ts";

const RETRY_DELAY_SECONDS = 60;
const LEGACY_CLAIM_BACKLOG_SWEEP_LIMIT = 10;
const LEGACY_GAME_BACKLOG_SWEEP_LIMIT = 10;
const AUTH_RECOVERY_SWEEP_CURSORS_COLLECTION = "authRecoverySweepCursors";

type AuthRecoverySweepDependencies = {
  enqueue?: (profileId: string) => Promise<void>;
  firestore?: Pick<AuthFirestoreClient, "query" | "runTransaction">;
  logger?: Pick<Console, "error">;
  now?: () => number;
};

type MaterializedClaimBacklog = {
  backlogName: string | null;
  profileId: string;
};

type MaterializedGameBacklog = {
  backlogName: string | null;
  backlogOpId: string;
  backlogTargetProfileId: string;
  profileId: string;
  sourceProfileId: string;
};

function validDocumentId(value: unknown): string {
  const id = cleanString(value);
  return isSafeFirestoreDocIdSegment(id) ? id : "";
}

async function readRotatingPendingBacklogPage({
  collectionId,
  fieldPaths,
  firestore,
  limit,
}: {
  collectionId: string;
  fieldPaths: string[];
  firestore: Pick<AuthFirestoreClient, "query" | "runTransaction">;
  limit: number;
}): Promise<AuthFirestoreDocument[]> {
  const cursorName = authDocumentName(
    AUTH_RECOVERY_SWEEP_CURSORS_COLLECTION,
    collectionId,
  );
  const afterDocumentId = await firestore.runTransaction(
    async (transaction) => {
      const cursor = (await transaction.batchGet([cursorName])).get(cursorName);
      return {
        result: validDocumentId(cursor?.fields.afterDocumentId),
        writes: [],
      };
    },
  );
  const candidates = await firestore.query(
    collectionId,
    authFieldFilter("status", "EQUAL", "pending"),
    limit,
    fieldPaths,
    afterDocumentId,
  );
  const nextAfterDocumentId = candidates.at(-1)?.id || "";
  if (nextAfterDocumentId !== afterDocumentId) {
    await firestore.runTransaction(async (transaction) => {
      const cursor = (await transaction.batchGet([cursorName])).get(cursorName);
      if (validDocumentId(cursor?.fields.afterDocumentId) !== afterDocumentId) {
        return { result: undefined, writes: [] };
      }
      return {
        result: undefined,
        writes: [
          authUpdateWrite(
            cursorName,
            { afterDocumentId: nextAfterDocumentId },
            ["afterDocumentId"],
          ),
        ],
      };
    });
  }
  return candidates;
}

async function materializeLegacyClaimBacklog(
  candidate: AuthFirestoreDocument,
  firestore: Pick<AuthFirestoreClient, "runTransaction">,
  now: () => number,
): Promise<MaterializedClaimBacklog | null> {
  return firestore.runTransaction(async (transaction) => {
    const backlog = (await transaction.batchGet([candidate.name])).get(
      candidate.name,
    );
    if (!backlog || cleanString(backlog.fields.status) !== "pending") {
      return { result: null, writes: [] };
    }
    const deleteBacklog = () =>
      authDeleteWrite(
        backlog.name,
        backlog.updateTime ? { updateTime: backlog.updateTime } : true,
      );
    const targetProfileId = validDocumentId(backlog.fields.targetProfileId);
    if (!targetProfileId) {
      return { result: null, writes: [deleteBacklog()] };
    }
    const targetName = authDocumentName("users", targetProfileId);
    const target = (await transaction.batchGet([targetName])).get(targetName);
    if (!target) {
      return { result: null, writes: [deleteBacklog()] };
    }
    const pendingOpId = cleanString(target.fields.pendingClaimSyncOpId);
    const ownedLogins = new Set(uniqueStoredFirebaseUids(target.fields.logins));
    const pendingLogins = uniqueStoredFirebaseUids(
      target.fields.pendingClaimSyncLogins,
      backlog.fields.failedLoginUids,
    ).filter((uid) => ownedLogins.has(uid));
    if (pendingLogins.length === 0) {
      return { result: null, writes: [deleteBacklog()] };
    }
    const markerOpId = pendingOpId || backlog.id;
    const targetWrite = authUpdateWrite(
      target.name,
      {
        pendingClaimSyncLogins: pendingLogins,
        pendingClaimSyncOpId: markerOpId,
        pendingClaimSyncUpdatedAtMs: now(),
      },
      [...PENDING_CLAIM_SYNC_FIELD_PATHS],
      target.updateTime ? { updateTime: target.updateTime } : true,
    );
    return {
      result: {
        backlogName: markerOpId === backlog.id ? backlog.name : null,
        profileId: targetProfileId,
      },
      writes: [
        targetWrite,
        ...(markerOpId === backlog.id ? [] : [deleteBacklog()]),
      ],
    };
  });
}

async function markClaimBacklogQueued(
  backlogName: string,
  firestore: Pick<AuthFirestoreClient, "runTransaction">,
  now: () => number,
): Promise<void> {
  await firestore.runTransaction(async (transaction) => {
    const backlog = (await transaction.batchGet([backlogName])).get(
      backlogName,
    );
    if (!backlog || cleanString(backlog.fields.status) !== "pending") {
      return { result: undefined, writes: [] };
    }
    return {
      result: undefined,
      writes: [
        authUpdateWrite(
          backlog.name,
          { status: "queued", updatedAtMs: now() },
          ["status", "updatedAtMs"],
          backlog.updateTime ? { updateTime: backlog.updateTime } : true,
        ),
      ],
    };
  });
}

async function materializeLegacyGameBacklog(
  candidate: AuthFirestoreDocument,
  firestore: Pick<AuthFirestoreClient, "runTransaction">,
  now: () => number,
): Promise<MaterializedGameBacklog | null> {
  return firestore.runTransaction<MaterializedGameBacklog | null>(
    async (transaction) => {
      const backlog = (await transaction.batchGet([candidate.name])).get(
        candidate.name,
      );
      if (!backlog || cleanString(backlog.fields.status) !== "pending") {
        return { result: null, writes: [] };
      }
      const deleteBacklog = () =>
        authDeleteWrite(
          backlog.name,
          backlog.updateTime ? { updateTime: backlog.updateTime } : true,
        );
      const targetProfileId = validDocumentId(backlog.fields.targetProfileId);
      const sourceProfileId = validDocumentId(backlog.fields.sourceProfileId);
      const backlogOpId = cleanString(backlog.fields.opId);
      const markerOpId =
        validDocumentId(backlogOpId) || `legacy-game:${backlog.id}`;
      if (
        !targetProfileId ||
        !sourceProfileId ||
        targetProfileId === sourceProfileId ||
        !validDocumentId(markerOpId)
      ) {
        return { result: null, writes: [deleteBacklog()] };
      }
      const sourceName = authDocumentName("users", sourceProfileId);
      const mergeTargetName = authDocumentName(
        PROFILE_MERGE_TARGETS_COLLECTION,
        sourceProfileId,
      );
      const snapshots = await transaction.batchGet([
        sourceName,
        mergeTargetName,
      ]);
      const source = snapshots.get(sourceName);
      const mergeTarget = snapshots.get(mergeTargetName);
      if (
        cleanString(mergeTarget?.fields.targetProfileId) !== targetProfileId ||
        (source &&
          (cleanString(source.fields.mergedIntoProfileId) !== targetProfileId ||
            source.fields.mergeSourceRetainedForGameCopy !== true ||
            uniqueStoredFirebaseUids(source.fields.logins).length > 0))
      ) {
        return { result: null, writes: [deleteBacklog()] };
      }
      let resolvedTargetProfileId = targetProfileId;
      let target: AuthFirestoreDocument | null = null;
      const visitedProfileIds = new Set([sourceProfileId]);
      for (let depth = 0; depth <= MAX_PROFILE_MERGE_TARGET_HOPS; depth++) {
        if (visitedProfileIds.has(resolvedTargetProfileId)) {
          return { result: null, writes: [deleteBacklog()] };
        }
        visitedProfileIds.add(resolvedTargetProfileId);
        const resolvedTargetName = authDocumentName(
          "users",
          resolvedTargetProfileId,
        );
        const resolvedMergeTargetName = authDocumentName(
          PROFILE_MERGE_TARGETS_COLLECTION,
          resolvedTargetProfileId,
        );
        const resolvedSnapshots = await transaction.batchGet([
          resolvedTargetName,
          resolvedMergeTargetName,
        ]);
        const candidateTarget = resolvedSnapshots.get(resolvedTargetName);
        const nextTargetRaw = cleanString(
          resolvedSnapshots.get(resolvedMergeTargetName)?.fields
            .targetProfileId,
        );
        if (nextTargetRaw) {
          const nextTargetProfileId = validDocumentId(nextTargetRaw);
          if (
            !nextTargetProfileId ||
            (candidateTarget &&
              cleanString(candidateTarget.fields.mergedIntoProfileId) &&
              cleanString(candidateTarget.fields.mergedIntoProfileId) !==
                nextTargetProfileId)
          ) {
            return { result: null, writes: [deleteBacklog()] };
          }
          resolvedTargetProfileId = nextTargetProfileId;
          continue;
        }
        if (
          !candidateTarget ||
          cleanString(candidateTarget.fields.mergedIntoProfileId)
        ) {
          return { result: null, writes: [deleteBacklog()] };
        }
        target = candidateTarget;
        break;
      }
      if (!target) {
        return { result: null, writes: [] };
      }
      const activeSource = cleanString(
        target.fields.pendingMergeGameCopySourceProfileId,
      );
      const activeOp = cleanString(target.fields.pendingMergeGameCopyOpId);
      const sourceClaimCleanup = source
        ? [
            authUpdateWrite(
              source.name,
              {},
              [...PENDING_CLAIM_SYNC_FIELD_PATHS],
              source.updateTime ? { updateTime: source.updateTime } : true,
            ),
          ]
        : [];
      if (activeSource && activeSource !== sourceProfileId) {
        return {
          result: {
            backlogName: null,
            backlogOpId,
            backlogTargetProfileId: targetProfileId,
            profileId: resolvedTargetProfileId,
            sourceProfileId,
          },
          writes: sourceClaimCleanup,
        };
      }
      const reusableActiveOp = validDocumentId(activeOp);
      const writes =
        activeSource && reusableActiveOp
          ? sourceClaimCleanup
          : [
              ...sourceClaimCleanup,
              authUpdateWrite(
                target.name,
                {
                  pendingMergeGameCopySourceProfileId: sourceProfileId,
                  pendingMergeGameCopyOpId: reusableActiveOp || markerOpId,
                  pendingMergeGameCopyUpdatedAtMs: now(),
                },
                [...PENDING_MERGE_GAME_COPY_FIELD_PATHS],
                target.updateTime ? { updateTime: target.updateTime } : true,
              ),
            ];
      return {
        result: {
          backlogName: backlog.name,
          backlogOpId,
          backlogTargetProfileId: targetProfileId,
          profileId: resolvedTargetProfileId,
          sourceProfileId,
        },
        writes,
      };
    },
  );
}

async function deleteMaterializedGameBacklog(
  materialized: MaterializedGameBacklog,
  firestore: Pick<AuthFirestoreClient, "runTransaction">,
): Promise<void> {
  const backlogName = materialized.backlogName;
  if (!backlogName) {
    return;
  }
  await firestore.runTransaction(async (transaction) => {
    const backlog = (await transaction.batchGet([backlogName])).get(
      backlogName,
    );
    if (
      !backlog ||
      cleanString(backlog.fields.status) !== "pending" ||
      validDocumentId(backlog.fields.targetProfileId) !==
        materialized.backlogTargetProfileId ||
      validDocumentId(backlog.fields.sourceProfileId) !==
        materialized.sourceProfileId ||
      cleanString(backlog.fields.opId) !== materialized.backlogOpId
    ) {
      return { result: undefined, writes: [] };
    }
    return {
      result: undefined,
      writes: [
        authDeleteWrite(
          backlog.name,
          backlog.updateTime ? { updateTime: backlog.updateTime } : true,
        ),
      ],
    };
  });
}

export async function sweepLegacyAuthClaimBacklogs(
  env: Env,
  dependencies: AuthRecoverySweepDependencies = {},
): Promise<number> {
  const firestore = dependencies.firestore || createAuthFirestoreClient(env);
  const enqueue =
    dependencies.enqueue ||
    ((profileId: string) => enqueueProfileRecovery(env, profileId));
  const logger = dependencies.logger || console;
  const now = dependencies.now || Date.now;
  const candidates = await readRotatingPendingBacklogPage({
    collectionId: "authClaimSyncBacklog",
    fieldPaths: ["targetProfileId"],
    firestore,
    limit: LEGACY_CLAIM_BACKLOG_SWEEP_LIMIT,
  });
  const profileIds = new Set<string>();
  const backlogNamesByProfile = new Map<string, Set<string>>();
  let failure: unknown;
  for (const candidate of candidates) {
    try {
      const materialized = await materializeLegacyClaimBacklog(
        candidate,
        firestore,
        now,
      );
      if (materialized) {
        profileIds.add(materialized.profileId);
        if (materialized.backlogName) {
          const names = backlogNamesByProfile.get(materialized.profileId);
          if (names) {
            names.add(materialized.backlogName);
          } else {
            backlogNamesByProfile.set(
              materialized.profileId,
              new Set([materialized.backlogName]),
            );
          }
        }
      }
    } catch (error) {
      failure ||= error;
      logger.error(
        JSON.stringify({ event: "auth_legacy_claim_backlog_sweep_failed" }),
      );
    }
  }
  for (const profileId of profileIds) {
    await enqueue(profileId);
    for (const backlogName of backlogNamesByProfile.get(profileId) || []) {
      await markClaimBacklogQueued(backlogName, firestore, now);
    }
  }
  if (failure) {
    throw failure;
  }
  return profileIds.size;
}

export async function sweepLegacyAuthGameBacklogs(
  env: Env,
  dependencies: AuthRecoverySweepDependencies = {},
): Promise<number> {
  const firestore = dependencies.firestore || createAuthFirestoreClient(env);
  const enqueue =
    dependencies.enqueue ||
    ((profileId: string) => enqueueProfileRecovery(env, profileId));
  const logger = dependencies.logger || console;
  const now = dependencies.now || Date.now;
  const candidates = await readRotatingPendingBacklogPage({
    collectionId: "authMergeGameBacklog",
    fieldPaths: ["opId", "sourceProfileId", "targetProfileId"],
    firestore,
    limit: LEGACY_GAME_BACKLOG_SWEEP_LIMIT,
  });
  const backlogsByProfile = new Map<string, MaterializedGameBacklog[]>();
  let failure: unknown;
  for (const candidate of candidates) {
    try {
      const materialized = await materializeLegacyGameBacklog(
        candidate,
        firestore,
        now,
      );
      if (materialized) {
        const backlogs = backlogsByProfile.get(materialized.profileId);
        if (backlogs) {
          backlogs.push(materialized);
        } else {
          backlogsByProfile.set(materialized.profileId, [materialized]);
        }
      }
    } catch (error) {
      failure ||= error;
      logger.error(
        JSON.stringify({ event: "auth_legacy_game_backlog_sweep_failed" }),
      );
    }
  }
  for (const [profileId, backlogs] of backlogsByProfile) {
    await enqueue(profileId);
    for (const backlog of backlogs) {
      await deleteMaterializedGameBacklog(backlog, firestore);
    }
  }
  if (failure) {
    throw failure;
  }
  return backlogsByProfile.size;
}

export async function handleAuthRecoverySweep(
  _controller: ScheduledController,
  env: Env,
): Promise<void> {
  const [claimResult, gameResult] = await Promise.allSettled([
    sweepLegacyAuthClaimBacklogs(env),
    sweepLegacyAuthGameBacklogs(env),
  ]);
  if (claimResult.status === "rejected") {
    throw claimResult.reason;
  }
  if (gameResult.status === "rejected") {
    throw gameResult.reason;
  }
  console.info(
    JSON.stringify({
      event: "auth_recovery_sweep_completed",
      legacyClaimBacklogs: claimResult.value,
      legacyGameBacklogs: gameResult.value,
    }),
  );
}

export async function handleAuthRecoveryMessage(
  message: Message<unknown>,
  env: Env,
  recover = (profileId: string) =>
    createAuthIdentityService(env, {
      claimBacklogStatus: "queued",
    }).recoverPendingProfile(profileId),
): Promise<void> {
  const task = parseAuthRecoveryTask(message.body);
  if (!task) {
    message.ack();
    return;
  }
  try {
    if (await recover(task.profileId)) {
      message.ack();
    } else {
      message.retry({ delaySeconds: RETRY_DELAY_SECONDS });
    }
  } catch {
    message.retry({ delaySeconds: RETRY_DELAY_SECONDS });
  }
}

export async function handleAuthRecoveryQueue(
  batch: MessageBatch<unknown>,
  env: Env,
): Promise<void> {
  for (const message of batch.messages) {
    await handleAuthRecoveryMessage(message, env);
  }
}

export {
  AUTH_RECOVERY_DLQ_NAME,
  AUTH_RECOVERY_QUEUE_NAME,
  enqueueAuthRecovery,
  parseAuthRecoveryTask as parseTask,
  type AuthRecoveryTask,
} from "./authRecoveryTask.ts";
