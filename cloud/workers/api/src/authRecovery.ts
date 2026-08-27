import { isSafeFirestoreDocIdSegment } from "@mons/shared/usernames";
import {
  getEventPrizeDefinition,
  isEventPrizeId,
  isEventPrizeStandard,
} from "@mons/shared/event-prizes";
import {
  MAX_PROFILE_MERGE_TARGET_HOPS,
  PROFILE_MERGE_TARGETS_COLLECTION,
} from "../../../functions/profileMergeTargets.js";
import {
  type AuthFirestoreClient,
  type AuthFirestoreDocument,
  type AuthFirestoreWrite,
  AuthFirestoreConflict,
  authDeleteWrite,
  authDocumentName,
  authUpdateWrite,
  createAuthFirestoreClient,
} from "./authFirestore.ts";
import {
  type FirebaseAuthAdminClient,
  createFirebaseAuthAdminClient,
} from "./firebaseAuthAdmin.ts";
import {
  type FirebaseRtdbClient,
  createFirebaseRtdbClient,
} from "./firebaseRtdb.ts";
import { isCanonicalFirebaseUid, isSafeFirebaseKey } from "./firebaseKeys.ts";
import { createGoogleAccessToken } from "./googleAuth.ts";
import {
  cleanString,
  finiteNumber,
  uniqueStoredFirebaseUids,
} from "./authPolicy.ts";
import {
  buildProfileLinkProfileGameProjectionOutbox,
  getProfileLinkProfileGameProjectionOutboxPath,
  parseProfileLinkProfileGameProjectionOutbox,
} from "./profileGameProjectionOutbox.ts";
import type { ProfileLinkProfileGameProjectionTask } from "./profileGameProjectionTasks.ts";
import {
  commitProfileGameProjectionWrites,
  getProfileGameProjection,
  listProfileGameProjectionPage,
} from "./profileGamesD1.ts";
import {
  canonicalEventPrizeWithdrawalStorageMode,
  createD1EventPrizeWithdrawalStore,
  readEventPrizeWithdrawalStorageControl,
} from "./eventPrizeWithdrawalD1.ts";

export const AUTH_RECOVERY_QUEUE_NAME = "mons-link-auth-recovery";
export const AUTH_RECOVERY_JOBS_COLLECTION = "authRecoveryJobs";
export const MERGE_GAME_FINALIZE_DELAY_MS = 60 * 1_000;
export const MERGE_PRIZE_RECOVERY_PAGE_SIZE = 20;
const RETRY_DELAY_SECONDS = 60;
const STALE_ENQUEUE_MS = 2 * 60 * 60 * 1_000;
const CLAIM_PAGE_SIZE = 20;

export type AuthRecoveryTask = {
  kind: "auth-profile-recovery";
  profileId: string;
};

export type AuthRecoveryPhase = "prizes" | "games" | "finalize";

export type AuthRecoveryJob = {
  profileId: string;
  loginUids: string[];
  sourceProfileIds: string[];
  sourcePhase: AuthRecoveryPhase;
  prizeCursor: string | null;
  phaseStartedAtMs: number;
  lastEnqueuedAtMs: number;
  createdAtMs: number;
  updatedAtMs: number;
};

type AuthRecoveryDependencies = {
  authClient?: FirebaseAuthAdminClient;
  buildPrizeCopy?: typeof buildPrizeCopy;
  d1?: D1Database;
  firestore?: AuthFirestoreClient;
  logger?: Pick<Console, "error" | "info">;
  now?: () => number;
  rtdb?: FirebaseRtdbClient;
  signal?: AbortSignal;
  withdrawalDb?: D1Database;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function exactDocumentId(value: unknown): string {
  if (typeof value !== "string" || value.trim() !== value) {
    return "";
  }
  return isSafeFirestoreDocIdSegment(value) && isSafeFirebaseKey(value)
    ? value
    : "";
}

function uniqueDocumentIds(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const result: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const id = exactDocumentId(item);
    if (!id) {
      return null;
    }
    if (!seen.has(id)) {
      seen.add(id);
      result.push(id);
    }
  }
  return result;
}

export function authRecoveryJobName(profileId: string): string {
  return authDocumentName(AUTH_RECOVERY_JOBS_COLLECTION, profileId);
}

export function parseAuthRecoveryTask(value: unknown): AuthRecoveryTask | null {
  const task = record(value);
  const profileId = exactDocumentId(task.profileId);
  return task.kind === "auth-profile-recovery" &&
    profileId &&
    Object.keys(task).length === 2
    ? { kind: "auth-profile-recovery", profileId }
    : null;
}

export function parseAuthRecoveryJob(
  document: AuthFirestoreDocument,
): AuthRecoveryJob | null {
  const fields = document.fields;
  const profileId = exactDocumentId(fields.profileId);
  const sourceProfileIds = uniqueDocumentIds(fields.sourceProfileIds);
  const sourcePhase = fields.sourcePhase;
  const prizeCursor = fields.prizeCursor;
  if (
    !profileId ||
    profileId !== document.id ||
    !sourceProfileIds ||
    !Array.isArray(fields.loginUids) ||
    !fields.loginUids.every((uid) => typeof uid === "string") ||
    !["prizes", "games", "finalize"].includes(String(sourcePhase)) ||
    (prizeCursor !== null && typeof prizeCursor !== "string")
  ) {
    return null;
  }
  return {
    profileId,
    loginUids: uniqueStoredFirebaseUids(fields.loginUids),
    sourceProfileIds,
    sourcePhase: sourcePhase as AuthRecoveryPhase,
    prizeCursor,
    phaseStartedAtMs: finiteNumber(fields.phaseStartedAtMs, 0),
    lastEnqueuedAtMs: finiteNumber(fields.lastEnqueuedAtMs, 0),
    createdAtMs: finiteNumber(fields.createdAtMs, 0),
    updatedAtMs: finiteNumber(fields.updatedAtMs, 0),
  };
}

export function newAuthRecoveryJob(
  profileId: string,
  loginUids: string[],
  sourceProfileIds: string[],
  nowMs: number,
): AuthRecoveryJob {
  return {
    profileId,
    loginUids: uniqueStoredFirebaseUids(loginUids),
    sourceProfileIds: Array.from(new Set(sourceProfileIds)),
    sourcePhase: sourceProfileIds.length > 0 ? "prizes" : "finalize",
    prizeCursor: null,
    phaseStartedAtMs: nowMs,
    lastEnqueuedAtMs: 0,
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
  };
}

export async function enqueueAuthRecovery(
  env: Env,
  profileId: string,
): Promise<void> {
  const canonicalProfileId = exactDocumentId(profileId);
  if (!canonicalProfileId) {
    throw new TypeError("invalid-profile-id");
  }
  await env.AUTH_RECOVERY_QUEUE.send(
    {
      kind: "auth-profile-recovery",
      profileId: canonicalProfileId,
    } satisfies AuthRecoveryTask,
    { delaySeconds: RETRY_DELAY_SECONDS },
  );
}

export async function markAuthRecoveryEnqueued(
  firestore: Pick<AuthFirestoreClient, "runTransaction">,
  profileId: string,
  nowMs: number,
): Promise<void> {
  const name = authRecoveryJobName(profileId);
  await firestore.runTransaction(async (transaction) => {
    const job = (await transaction.batchGet([name])).get(name);
    if (!job) {
      return { result: undefined, writes: [] };
    }
    return {
      result: undefined,
      writes: [
        authUpdateWrite(
          name,
          { lastEnqueuedAtMs: nowMs, updatedAtMs: nowMs },
          ["lastEnqueuedAtMs", "updatedAtMs"],
          job.updateTime ? { updateTime: job.updateTime } : true,
        ),
      ],
    };
  });
}

export async function enqueuePersistedAuthRecovery(
  env: Env,
  firestore: Pick<AuthFirestoreClient, "runTransaction">,
  profileId: string,
  nowMs: number,
): Promise<void> {
  await enqueueAuthRecovery(env, profileId);
  await markAuthRecoveryEnqueued(firestore, profileId, nowMs);
}

export async function ensureFirebaseProfileClaim(
  uid: string,
  profileId: string,
  dependencies: {
    authClient: FirebaseAuthAdminClient;
    createRequestId?: () => string;
    enqueueProfileLinkProjection?: (
      task: ProfileLinkProfileGameProjectionTask,
    ) => Promise<unknown>;
    logger?: Pick<Console, "error">;
    now?: () => number;
    rtdb: Pick<FirebaseRtdbClient, "getPath" | "patchRoot">;
    signal?: AbortSignal;
  },
): Promise<void> {
  if (!isCanonicalFirebaseUid(uid)) {
    throw new TypeError("invalid-firebase-uid");
  }
  const outboxPath = getProfileLinkProfileGameProjectionOutboxPath(uid);
  const [user, profileLink, existingOutboxValue] = await Promise.all([
    dependencies.authClient.getUser(uid),
    dependencies.rtdb.getPath(
      `players/${uid}/profile`,
      undefined,
      dependencies.signal,
    ),
    dependencies.rtdb.getPath(outboxPath, undefined, dependencies.signal),
  ]);
  const writes: Promise<void>[] = [];
  if (cleanString(profileLink) !== profileId) {
    const nowMs = (dependencies.now || Date.now)();
    const requestId = dependencies.createRequestId
      ? dependencies.createRequestId()
      : crypto.randomUUID();
    const existingOutbox =
      parseProfileLinkProfileGameProjectionOutbox(existingOutboxValue);
    const previousProfileId = exactDocumentId(profileLink);
    const cleanupProfileIds = Array.from(
      new Set([
        ...(existingOutbox?.cleanupProfileIds || []),
        ...(previousProfileId && previousProfileId !== profileId
          ? [previousProfileId]
          : []),
      ]),
    );
    const task = {
      kind: "profile-link-profile-game-projection",
      loginUid: uid,
      requestId,
    } satisfies ProfileLinkProfileGameProjectionTask;
    writes.push(
      dependencies.rtdb
        .patchRoot(
          {
            [`players/${uid}/profile`]: profileId,
            [outboxPath]: buildProfileLinkProfileGameProjectionOutbox({
              cleanupProfileIds,
              lastQueuedAtMs: nowMs,
              profileId,
              requestId,
              sourceUpdatedAtMs: nowMs,
            }),
          },
          dependencies.signal,
        )
        .then(async () => {
          if (!dependencies.enqueueProfileLinkProjection) {
            return;
          }
          try {
            await dependencies.enqueueProfileLinkProjection(task);
          } catch {
            (dependencies.logger || console).error(
              JSON.stringify({
                event: "profile_link_profile_game_projection_enqueue_failed",
                loginUid: uid,
              }),
            );
          }
        }),
    );
  }
  if (cleanString(user.customClaims.profileId) !== profileId) {
    writes.push(
      dependencies.authClient.setCustomUserClaims(uid, {
        ...user.customClaims,
        profileId,
      }),
    );
  }
  const outcomes = await Promise.allSettled(writes);
  const failure = outcomes.find(
    (outcome): outcome is PromiseRejectedResult =>
      outcome.status === "rejected",
  );
  if (failure) {
    throw failure.reason;
  }
}

function timestampMillis(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.floor(value);
  }
  const timestamp = cleanString(record(value).__firestoreTimestamp);
  const parsed = timestamp ? Date.parse(timestamp) : NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

function mergeFreshness(fields: Record<string, unknown>): number {
  return Math.max(
    timestampMillis(fields.updatedAt),
    timestampMillis(fields.listSortAt),
  );
}

function isEquivalentPrizeAssignment(
  value: unknown,
  expected: unknown,
): boolean {
  const current = record(value);
  const assignment = record(expected);
  return (
    cleanString(current.eventId) === cleanString(assignment.eventId) &&
    cleanString(current.profileId) === cleanString(assignment.profileId) &&
    finiteNumber(current.place, 0) === finiteNumber(assignment.place, -1) &&
    cleanString(current.prizeId) === cleanString(assignment.prizeId) &&
    finiteNumber(current.assignedAtMs, -1) ===
      finiteNumber(assignment.assignedAtMs, -2)
  );
}

function buildPrizeCopy(
  sourceProfileId: string,
  targetProfileId: string,
  eventId: string,
  value: unknown,
): Record<string, unknown> | null {
  const assignment = record(value);
  const normalizedEventId = cleanString(eventId);
  const prizeId = cleanString(assignment.prizeId);
  const place = finiteNumber(assignment.place, 0);
  const assignedAtMs = finiteNumber(assignment.assignedAtMs, NaN);
  if (
    cleanString(assignment.eventId) !== normalizedEventId ||
    cleanString(assignment.profileId) !== sourceProfileId ||
    ![1, 2, 3].includes(place) ||
    !isEventPrizeId(normalizedEventId, prizeId) ||
    !Number.isFinite(assignedAtMs)
  ) {
    return null;
  }
  return {
    eventId: normalizedEventId,
    profileId: targetProfileId,
    place,
    prizeId,
    assignedAtMs: Math.floor(assignedAtMs),
  };
}

function isCompletedPrizeWithdrawal(
  value: unknown,
  eventId: string,
  prizeId: string,
): boolean {
  const withdrawal = record(value);
  const definition = getEventPrizeDefinition(eventId, prizeId);
  const assetAddress = cleanString(definition?.assetAddress);
  const expectedStandard = cleanString(definition?.standard);
  const recordedStandard = cleanString(withdrawal.assetStandard);
  const standardMatches =
    (isEventPrizeStandard(recordedStandard) &&
      recordedStandard === expectedStandard) ||
    (!recordedStandard && expectedStandard === "core");
  return (
    Boolean(assetAddress) &&
    withdrawal.status === "completed" &&
    standardMatches &&
    cleanString(withdrawal.eventId) === eventId &&
    cleanString(withdrawal.prizeId) === prizeId &&
    cleanString(withdrawal.assetAddress) === assetAddress
  );
}

export function createAuthRecoveryService(
  env: Env,
  dependencies: AuthRecoveryDependencies = {},
) {
  let accessToken: Promise<string> | null = null;
  const accessTokenProvider = () => {
    accessToken ||= createGoogleAccessToken(env, {
      credentials: {
        email: env.FIRESTORE_SERVICE_ACCOUNT_EMAIL,
        privateKeyPem: env.FIRESTORE_SERVICE_ACCOUNT_PRIVATE_KEY,
      },
    });
    return accessToken;
  };
  const firestore =
    dependencies.firestore ||
    createAuthFirestoreClient(env, {
      accessTokenProvider,
      signal: dependencies.signal,
    });
  const authClient =
    dependencies.authClient ||
    createFirebaseAuthAdminClient(env, { signal: dependencies.signal });
  const rtdb =
    dependencies.rtdb ||
    createFirebaseRtdbClient(env, {
      credentials: {
        email: env.FIRESTORE_SERVICE_ACCOUNT_EMAIL,
        privateKeyPem: env.FIRESTORE_SERVICE_ACCOUNT_PRIVATE_KEY,
      },
    });
  const logger = dependencies.logger || console;
  const now = dependencies.now || Date.now;
  const d1 = dependencies.d1 || env.PROFILE_GAMES_DB;
  const withdrawalDb =
    dependencies.withdrawalDb || env.EVENT_PRIZE_WITHDRAWALS_DB;
  let withdrawalMode: Promise<"d1" | "firebase"> | null = null;
  const getWithdrawalMode = () => {
    withdrawalMode ||= readEventPrizeWithdrawalStorageControl(withdrawalDb)
      .then(canonicalEventPrizeWithdrawalStorageMode)
      .catch((error) => {
        withdrawalMode = null;
        throw error;
      });
    return withdrawalMode;
  };
  const d1Withdrawals = createD1EventPrizeWithdrawalStore(withdrawalDb, {
    now,
  });
  const readWithdrawal = async (eventId: string, prizeId: string) =>
    (await getWithdrawalMode()) === "d1"
      ? d1Withdrawals.get(eventId, prizeId)
      : rtdb.getPath(
          `eventPrizeWithdrawals/${eventId}/${prizeId}`,
          undefined,
          dependencies.signal,
        );

  const mutateJob = async (
    profileId: string,
    update: (job: AuthRecoveryJob) => AuthRecoveryJob | null | undefined,
  ): Promise<boolean> => {
    const name = authRecoveryJobName(profileId);
    return firestore.runTransaction(async (transaction) => {
      const document = (await transaction.batchGet([name])).get(name);
      if (!document) {
        return { result: true, writes: [] };
      }
      const job = parseAuthRecoveryJob(document);
      if (!job) {
        return { result: false, writes: [] };
      }
      const next = update(job);
      if (next === undefined) {
        return { result: false, writes: [] };
      }
      return {
        result: next === null,
        writes: [
          next === null
            ? authDeleteWrite(
                name,
                document.updateTime
                  ? { updateTime: document.updateTime }
                  : true,
              )
            : authUpdateWrite(
                name,
                next,
                Object.keys(next),
                document.updateTime
                  ? { updateTime: document.updateTime }
                  : true,
              ),
        ],
      };
    });
  };

  const removeLoginUid = (profileId: string, uid: string) =>
    mutateJob(profileId, (job) => {
      const loginUids = job.loginUids.filter((candidate) => candidate !== uid);
      if (loginUids.length === job.loginUids.length) {
        return undefined;
      }
      return { ...job, loginUids, updatedAtMs: now() };
    });

  const copyPrize = async (
    sourceProfileId: string,
    targetProfileId: string,
    eventId: string,
    sourceAssignment: unknown,
  ): Promise<void> => {
    const assignment = (dependencies.buildPrizeCopy || buildPrizeCopy)(
      sourceProfileId,
      targetProfileId,
      eventId,
      sourceAssignment,
    );
    if (!assignment) {
      throw new Error("auth-recovery-prize-invalid");
    }
    const prizeId = cleanString(assignment.prizeId);
    const targetPath = `profileEventPrizes/${targetProfileId}/${eventId}`;
    const existingTarget = await rtdb.getPath(
      targetPath,
      undefined,
      dependencies.signal,
    );
    if (
      existingTarget !== null &&
      existingTarget !== undefined &&
      !isEquivalentPrizeAssignment(existingTarget, assignment)
    ) {
      throw new Error("auth-recovery-prize-conflict");
    }
    const removeIfCompleted = async (): Promise<boolean> => {
      if (!prizeId) {
        return false;
      }
      const withdrawal = await readWithdrawal(eventId, prizeId);
      if (!isCompletedPrizeWithdrawal(withdrawal, eventId, prizeId)) {
        return false;
      }
      await rtdb.transactPath(
        targetPath,
        (current) =>
          cleanString(record(current).eventId) === eventId &&
          cleanString(record(current).prizeId) === prizeId
            ? { value: null }
            : { commit: false },
        dependencies.signal,
      );
      return true;
    };
    if (await removeIfCompleted()) {
      return;
    }
    await rtdb.transactPath(
      targetPath,
      (current) => {
        if (current === null || current === undefined) {
          return { value: assignment };
        }
        if (isEquivalentPrizeAssignment(current, assignment)) {
          return { commit: false };
        }
        throw new Error("auth-recovery-prize-conflict");
      },
      dependencies.signal,
    );
    await removeIfCompleted();
  };

  const recoverClaims = async (job: AuthRecoveryJob): Promise<void> => {
    const validUids = job.loginUids
      .filter(isCanonicalFirebaseUid)
      .slice(0, CLAIM_PAGE_SIZE);
    for (const uid of validUids) {
      try {
        await ensureFirebaseProfileClaim(uid, job.profileId, {
          authClient,
          enqueueProfileLinkProjection: (task) =>
            env.PROFILE_GAME_PROJECTION_QUEUE.send(task),
          logger,
          now,
          rtdb,
          signal: dependencies.signal,
        });
        await removeLoginUid(job.profileId, uid);
      } catch {
        logger.error(JSON.stringify({ event: "auth_claim_recovery_pending" }));
      }
    }
  };

  const recoverPrizes = async (
    job: AuthRecoveryJob,
    sourceProfileId: string,
  ): Promise<void> => {
    const cursor = job.prizeCursor || "";
    const source = record(
      await rtdb.getPath(
        `profileEventPrizes/${sourceProfileId}`,
        {
          orderBy: "$key",
          ...(cursor ? { startAt: cursor } : {}),
          limitToFirst: cursor
            ? MERGE_PRIZE_RECOVERY_PAGE_SIZE + 2
            : MERGE_PRIZE_RECOVERY_PAGE_SIZE + 1,
        },
        dependencies.signal,
      ),
    );
    const remaining = Object.entries(source)
      .filter(([eventId]) => eventId > cursor)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    const page = remaining.slice(0, MERGE_PRIZE_RECOVERY_PAGE_SIZE);
    for (const [eventId, assignment] of page) {
      await copyPrize(sourceProfileId, job.profileId, eventId, assignment);
    }
    const complete = remaining.length <= page.length;
    const nextCursor = page.at(-1)?.[0] || job.prizeCursor;
    await mutateJob(job.profileId, (live) => {
      if (
        live.sourceProfileIds[0] !== sourceProfileId ||
        live.sourcePhase !== "prizes" ||
        live.prizeCursor !== job.prizeCursor
      ) {
        return undefined;
      }
      return {
        ...live,
        sourcePhase: complete ? "games" : "prizes",
        prizeCursor: nextCursor,
        phaseStartedAtMs: complete ? now() : live.phaseStartedAtMs,
        updatedAtMs: now(),
      };
    });
  };

  const recoverGames = async (
    job: AuthRecoveryJob,
    sourceProfileId: string,
  ): Promise<void> => {
    const d1SourcePage = await listProfileGameProjectionPage(
      d1,
      sourceProfileId,
    );
    if (d1SourcePage.length > 0) {
      const targets = await Promise.all(
        d1SourcePage.map((game) =>
          getProfileGameProjection(d1, job.profileId, game.projectionId),
        ),
      );
      const writes = d1SourcePage.flatMap((game, index) => {
        const current = targets[index];
        const copy =
          !current || mergeFreshness(game.data) >= mergeFreshness(current.data)
            ? [
                {
                  type: current ? ("update" as const) : ("create" as const),
                  profileId: job.profileId,
                  projectionId: game.projectionId,
                  data: { ...game.data, ownerProfileId: job.profileId },
                  ...(current
                    ? { updateTime: current.updateTime }
                    : { requireAbsent: true }),
                },
              ]
            : [];
        return [
          ...copy,
          {
            type: "delete" as const,
            profileId: sourceProfileId,
            projectionId: game.projectionId,
            updateTime: game.updateTime,
          },
        ];
      });
      await commitProfileGameProjectionWrites(d1, writes);
      await mutateJob(job.profileId, (live) =>
        live.sourceProfileIds[0] === sourceProfileId &&
        live.sourcePhase === "games"
          ? { ...live, phaseStartedAtMs: now(), updatedAtMs: now() }
          : undefined,
      );
      return;
    }
    if (now() - job.phaseStartedAtMs < MERGE_GAME_FINALIZE_DELAY_MS) {
      return;
    }
    await mutateJob(job.profileId, (live) =>
      live.sourceProfileIds[0] === sourceProfileId &&
      live.sourcePhase === "games"
        ? {
            ...live,
            sourcePhase: "finalize",
            phaseStartedAtMs: now(),
            updatedAtMs: now(),
          }
        : undefined,
    );
  };

  const finalizeSource = async (
    job: AuthRecoveryJob,
    sourceProfileId: string,
  ): Promise<void> => {
    if (
      (await listProfileGameProjectionPage(d1, sourceProfileId, 1)).length > 0
    ) {
      await mutateJob(job.profileId, (live) =>
        live.sourceProfileIds[0] === sourceProfileId &&
        live.sourcePhase === "finalize"
          ? {
              ...live,
              sourcePhase: "games",
              phaseStartedAtMs: now(),
              updatedAtMs: now(),
            }
          : undefined,
      );
      return;
    }
    const jobName = authRecoveryJobName(job.profileId);
    const targetName = authDocumentName("users", job.profileId);
    const sourceName = authDocumentName("users", sourceProfileId);
    const mergeTargetName = authDocumentName(
      PROFILE_MERGE_TARGETS_COLLECTION,
      sourceProfileId,
    );
    await firestore.runTransaction(async (transaction) => {
      const snapshots = await transaction.batchGet([
        jobName,
        targetName,
        sourceName,
        mergeTargetName,
      ]);
      const jobDocument = snapshots.get(jobName);
      if (!jobDocument) {
        return { result: undefined, writes: [] };
      }
      const live = parseAuthRecoveryJob(jobDocument);
      const target = snapshots.get(targetName);
      const source = snapshots.get(sourceName);
      const mergeTarget = snapshots.get(mergeTargetName);
      let currentMapping = mergeTarget;
      let firstTargetProfileId = "";
      let resolvesToTarget = false;
      const visited = new Set([sourceProfileId]);
      for (let depth = 0; depth <= MAX_PROFILE_MERGE_TARGET_HOPS; depth++) {
        const nextProfileId = exactDocumentId(
          currentMapping?.fields.targetProfileId,
        );
        if (!nextProfileId || visited.has(nextProfileId)) {
          break;
        }
        firstTargetProfileId ||= nextProfileId;
        if (nextProfileId === job.profileId) {
          resolvesToTarget = true;
          break;
        }
        visited.add(nextProfileId);
        const nextMappingName = authDocumentName(
          PROFILE_MERGE_TARGETS_COLLECTION,
          nextProfileId,
        );
        currentMapping = (await transaction.batchGet([nextMappingName])).get(
          nextMappingName,
        );
      }
      if (
        !live ||
        !target ||
        live.sourceProfileIds[0] !== sourceProfileId ||
        live.sourcePhase !== "finalize" ||
        !resolvesToTarget ||
        (source &&
          (exactDocumentId(source.fields.mergedIntoProfileId) !==
            firstTargetProfileId ||
            uniqueStoredFirebaseUids(source.fields.logins).length > 0))
      ) {
        return { result: undefined, writes: [] };
      }
      const writes: AuthFirestoreWrite[] = [];
      if (source) {
        writes.push(
          authDeleteWrite(
            sourceName,
            source.updateTime ? { updateTime: source.updateTime } : true,
          ),
        );
      }
      const sourceProfileIds = source
        ? live.sourceProfileIds
        : live.sourceProfileIds.slice(1);
      const updated: AuthRecoveryJob = {
        ...live,
        sourceProfileIds,
        sourcePhase: source
          ? "games"
          : sourceProfileIds.length > 0
            ? "prizes"
            : "finalize",
        prizeCursor: null,
        phaseStartedAtMs: now(),
        updatedAtMs: now(),
      };
      writes.push(
        authUpdateWrite(
          jobName,
          updated,
          Object.keys(updated),
          jobDocument.updateTime
            ? { updateTime: jobDocument.updateTime }
            : true,
        ),
      );
      return { result: undefined, writes };
    });
  };

  const recoverProfile = async (profileId: string): Promise<boolean> => {
    const name = authRecoveryJobName(profileId);
    const document = await firestore.get(name);
    if (!document) {
      return true;
    }
    let job = parseAuthRecoveryJob(document);
    if (!job) {
      logger.error(JSON.stringify({ event: "auth_recovery_job_invalid" }));
      return false;
    }
    await recoverClaims(job);
    const refreshed = await firestore.get(name);
    if (!refreshed) {
      return true;
    }
    job = parseAuthRecoveryJob(refreshed);
    if (!job) {
      return false;
    }
    if (job.loginUids.some(isCanonicalFirebaseUid)) {
      return false;
    }
    if (job.sourceProfileIds.length === 0) {
      if (job.loginUids.length === 0) {
        if (now() - job.updatedAtMs < MERGE_GAME_FINALIZE_DELAY_MS) {
          return false;
        }
        return mutateJob(profileId, (live) =>
          live.loginUids.length === 0 &&
          live.sourceProfileIds.length === 0 &&
          now() - live.updatedAtMs >= MERGE_GAME_FINALIZE_DELAY_MS
            ? null
            : undefined,
        );
      }
      logger.error(JSON.stringify({ event: "auth_recovery_uid_invalid" }));
      return false;
    }
    const sourceProfileId = job.sourceProfileIds[0];
    try {
      if (job.sourcePhase === "prizes") {
        await recoverPrizes(job, sourceProfileId);
      } else if (job.sourcePhase === "games") {
        await recoverGames(job, sourceProfileId);
      } else {
        await finalizeSource(job, sourceProfileId);
      }
    } catch (error) {
      if (!(error instanceof AuthFirestoreConflict)) {
        logger.error(
          JSON.stringify({
            event:
              error instanceof Error &&
              error.message === "auth-recovery-prize-conflict"
                ? "auth_recovery_prize_conflict"
                : "auth_recovery_pending",
          }),
        );
      }
    }
    return (await firestore.get(name)) === null;
  };

  return { recoverProfile, removeLoginUid };
}

export async function sweepAuthRecoveryJobs(
  env: Env,
  dependencies: Pick<
    AuthRecoveryDependencies,
    "firestore" | "logger" | "now"
  > = {},
): Promise<number> {
  const firestore = dependencies.firestore || createAuthFirestoreClient(env);
  const logger = dependencies.logger || console;
  const now = dependencies.now || Date.now;
  let pageToken = "";
  let enqueued = 0;
  let firstFailure: unknown;
  do {
    const page = await firestore.listPage(
      "",
      AUTH_RECOVERY_JOBS_COLLECTION,
      pageToken,
    );
    for (const document of page.documents) {
      const job = parseAuthRecoveryJob(document);
      if (!job) {
        logger.error(JSON.stringify({ event: "auth_recovery_job_invalid" }));
        continue;
      }
      if (now() - job.lastEnqueuedAtMs < STALE_ENQUEUE_MS) {
        continue;
      }
      try {
        await enqueuePersistedAuthRecovery(
          env,
          firestore,
          job.profileId,
          now(),
        );
        enqueued++;
      } catch (error) {
        firstFailure ||= error;
        logger.error(
          JSON.stringify({ event: "auth_recovery_enqueue_failure" }),
        );
      }
    }
    pageToken = page.nextPageToken;
  } while (pageToken);
  if (firstFailure) {
    throw firstFailure;
  }
  return enqueued;
}

export async function handleAuthRecoverySweep(
  _controller: ScheduledController,
  env: Env,
): Promise<void> {
  const enqueued = await sweepAuthRecoveryJobs(env);
  console.info(
    JSON.stringify({ event: "auth_recovery_sweep_completed", enqueued }),
  );
}

export async function handleAuthRecoveryMessage(
  message: Message<unknown>,
  env: Env,
  recover = (profileId: string) =>
    createAuthRecoveryService(env).recoverProfile(profileId),
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

export { parseAuthRecoveryTask as parseTask };
