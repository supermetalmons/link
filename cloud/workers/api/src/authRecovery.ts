import { isSafeFirestoreDocIdSegment } from "@mons/shared/usernames";
import {
  getEventPrizeDefinition,
  isEventPrizeId,
  isEventPrizeStandard,
} from "@mons/shared/event-prizes";
import { MAX_PROFILE_MERGE_TARGET_HOPS } from "../../../functions/profileMergeTargets.js";
import {
  type FirebaseAuthAdminClient,
  createFirebaseAuthAdminClient,
} from "./firebaseAuthAdmin.ts";
import {
  type FirebaseRtdbClient,
  createFirebaseRtdbClient,
} from "./firebaseRtdb.ts";
import { isCanonicalFirebaseUid, isSafeFirebaseKey } from "./firebaseKeys.ts";
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
  createD1EventPrizeWithdrawalStore,
  type EventPrizeWithdrawalStore,
} from "./eventPrizeWithdrawalD1.ts";
import {
  CanonicalProfileConflict,
  commitCanonicalPlan,
  parseCanonicalAuthRecoveryRow,
  readCanonicalMergeTarget,
  readCanonicalProfileAggregate,
  type CanonicalAuthRecoverySnapshot,
  type CanonicalAuthRecoveryValue,
} from "./profileCanonicalD1.ts";
import { PROFILE_BACKGROUND_SWEEP_LIMIT } from "./profileBackgroundLimits.ts";

export const AUTH_RECOVERY_QUEUE_NAME = "mons-link-auth-recovery";
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
  logger?: Pick<Console, "error" | "info">;
  now?: () => number;
  profileDb?: D1Database;
  rtdb?: FirebaseRtdbClient;
  signal?: AbortSignal;
  withdrawalDb?: D1Database;
  withdrawalStore?: Pick<EventPrizeWithdrawalStore, "get">;
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

export function parseAuthRecoveryTask(value: unknown): AuthRecoveryTask | null {
  const task = record(value);
  const profileId = exactDocumentId(task.profileId);
  return task.kind === "auth-profile-recovery" &&
    profileId &&
    Object.keys(task).length === 2
    ? { kind: "auth-profile-recovery", profileId }
    : null;
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

type CanonicalRecoveryJob = AuthRecoveryJob & { revision: number };

function canonicalRecoveryJob(
  snapshot: CanonicalAuthRecoverySnapshot,
): CanonicalRecoveryJob {
  return {
    profileId: snapshot.profileId,
    loginUids: snapshot.loginUids,
    sourceProfileIds: snapshot.sourceProfileIds,
    sourcePhase: snapshot.sourcePhase,
    prizeCursor: snapshot.prizeCursor,
    phaseStartedAtMs: snapshot.phaseStartedAtMs,
    lastEnqueuedAtMs: snapshot.lastEnqueuedAtMs,
    createdAtMs: snapshot.createdAtMs,
    updatedAtMs: snapshot.updatedAtMs,
    revision: snapshot.revision,
  };
}

function canonicalRecoveryValue(
  job: AuthRecoveryJob,
): CanonicalAuthRecoveryValue {
  return job;
}

async function mutateCanonicalRecoveryJob(
  db: D1Database,
  profileId: string,
  update: (job: CanonicalRecoveryJob) => AuthRecoveryJob | null | undefined,
): Promise<boolean> {
  const aggregate = await readCanonicalProfileAggregate(db, profileId);
  if (!aggregate.recovery) return true;
  const job = canonicalRecoveryJob(aggregate.recovery);
  const next = update(job);
  if (next === undefined) return false;
  await commitCanonicalPlan(db, {
    expectations: [
      {
        kind: "auth-recovery-revision",
        profileId,
        revision: job.revision,
      },
    ],
    mutations: [
      next === null
        ? { kind: "delete-auth-recovery", profileId }
        : {
            kind: "update-auth-recovery",
            value: canonicalRecoveryValue(next),
          },
    ],
  });
  return next === null;
}

export async function enqueuePersistedCanonicalAuthRecovery(
  env: Env,
  db: D1Database,
  profileId: string,
  nowMs: number,
): Promise<void> {
  await enqueueAuthRecovery(env, profileId);
  await mutateCanonicalRecoveryJob(db, profileId, (job) => ({
    ...job,
    lastEnqueuedAtMs: nowMs,
    updatedAtMs: nowMs,
  }));
}

function createCanonicalAuthRecoveryService(
  env: Env,
  dependencies: AuthRecoveryDependencies = {},
) {
  const db = dependencies.profileDb || env.PROFILE_DB;
  const authClient =
    dependencies.authClient ||
    createFirebaseAuthAdminClient(env, { signal: dependencies.signal });
  const rtdb =
    dependencies.rtdb ||
    createFirebaseRtdbClient(env, {
      credentials: {
        email: env.FIREBASE_IDENTITY_SERVICE_ACCOUNT_EMAIL,
        privateKeyPem: env.FIREBASE_IDENTITY_SERVICE_ACCOUNT_PRIVATE_KEY,
      },
    });
  const logger = dependencies.logger || console;
  const now = dependencies.now || Date.now;
  const profileGamesDb = dependencies.d1 || env.PROFILE_GAMES_DB;
  const withdrawalDb =
    dependencies.withdrawalDb || env.EVENT_PRIZE_WITHDRAWALS_DB;
  const withdrawals =
    dependencies.withdrawalStore ||
    createD1EventPrizeWithdrawalStore(withdrawalDb, { now });

  const removeLoginUid = (profileId: string, uid: string) =>
    mutateCanonicalRecoveryJob(db, profileId, (job) => {
      const loginUids = job.loginUids.filter((candidate) => candidate !== uid);
      return loginUids.length === job.loginUids.length
        ? undefined
        : { ...job, loginUids, updatedAtMs: now() };
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
    if (!assignment) throw new Error("auth-recovery-prize-invalid");
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
      if (!prizeId) return false;
      const withdrawal = await withdrawals.get(eventId, prizeId);
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
    if (await removeIfCompleted()) return;
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

  const recoverClaims = async (job: CanonicalRecoveryJob): Promise<void> => {
    for (const uid of job.loginUids
      .filter(isCanonicalFirebaseUid)
      .slice(0, CLAIM_PAGE_SIZE)) {
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
    job: CanonicalRecoveryJob,
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
    await mutateCanonicalRecoveryJob(db, job.profileId, (live) =>
      live.sourceProfileIds[0] === sourceProfileId &&
      live.sourcePhase === "prizes" &&
      live.prizeCursor === job.prizeCursor
        ? {
            ...live,
            sourcePhase: complete ? "games" : "prizes",
            prizeCursor: nextCursor,
            phaseStartedAtMs: complete ? now() : live.phaseStartedAtMs,
            updatedAtMs: now(),
          }
        : undefined,
    );
  };

  const recoverGames = async (
    job: CanonicalRecoveryJob,
    sourceProfileId: string,
  ): Promise<void> => {
    const sourcePage = await listProfileGameProjectionPage(
      profileGamesDb,
      sourceProfileId,
    );
    if (sourcePage.length > 0) {
      const targets = await Promise.all(
        sourcePage.map((game) =>
          getProfileGameProjection(
            profileGamesDb,
            job.profileId,
            game.projectionId,
          ),
        ),
      );
      const writes = sourcePage.flatMap((game, index) => {
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
      await commitProfileGameProjectionWrites(profileGamesDb, writes);
      await mutateCanonicalRecoveryJob(db, job.profileId, (live) =>
        live.sourceProfileIds[0] === sourceProfileId &&
        live.sourcePhase === "games"
          ? { ...live, phaseStartedAtMs: now(), updatedAtMs: now() }
          : undefined,
      );
      return;
    }
    if (now() - job.phaseStartedAtMs < MERGE_GAME_FINALIZE_DELAY_MS) return;
    await mutateCanonicalRecoveryJob(db, job.profileId, (live) =>
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
    job: CanonicalRecoveryJob,
    sourceProfileId: string,
  ): Promise<void> => {
    if (
      (await listProfileGameProjectionPage(profileGamesDb, sourceProfileId, 1))
        .length > 0
    ) {
      await mutateCanonicalRecoveryJob(db, job.profileId, (live) =>
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
    const target = await readCanonicalProfileAggregate(db, job.profileId);
    const source = await readCanonicalProfileAggregate(db, sourceProfileId);
    if (!target.profile || !target.recovery) return;
    const live = canonicalRecoveryJob(target.recovery);
    let currentProfileId = sourceProfileId;
    let firstTargetProfileId = "";
    let resolvesToTarget = false;
    const mergeExpectations: Array<{
      kind: "merge-target";
      sourceProfileId: string;
      targetProfileId: string;
    }> = [];
    const visited = new Set([sourceProfileId]);
    for (let depth = 0; depth <= MAX_PROFILE_MERGE_TARGET_HOPS; depth++) {
      const mapping = await readCanonicalMergeTarget(db, currentProfileId);
      if (!mapping || visited.has(mapping.targetProfileId)) break;
      mergeExpectations.push({
        kind: "merge-target",
        sourceProfileId: mapping.sourceProfileId,
        targetProfileId: mapping.targetProfileId,
      });
      firstTargetProfileId ||= mapping.targetProfileId;
      if (mapping.targetProfileId === job.profileId) {
        resolvesToTarget = true;
        break;
      }
      visited.add(mapping.targetProfileId);
      currentProfileId = mapping.targetProfileId;
    }
    if (
      live.sourceProfileIds[0] !== sourceProfileId ||
      live.sourcePhase !== "finalize" ||
      !resolvesToTarget ||
      (source.profile &&
        (source.profile.mergedIntoProfileId !== firstTargetProfileId ||
          source.loginOwners.length > 0))
    ) {
      return;
    }
    const sourceProfileIds = source.profile
      ? live.sourceProfileIds
      : live.sourceProfileIds.slice(1);
    const updated: AuthRecoveryJob = {
      ...live,
      sourceProfileIds,
      sourcePhase: source.profile
        ? "games"
        : sourceProfileIds.length > 0
          ? "prizes"
          : "finalize",
      prizeCursor: null,
      phaseStartedAtMs: now(),
      updatedAtMs: now(),
    };
    await commitCanonicalPlan(db, {
      expectations: [
        {
          kind: "profile-revision",
          profileId: target.profile.profileId,
          revision: target.profile.revision,
        },
        {
          kind: "auth-recovery-revision",
          profileId: live.profileId,
          revision: live.revision,
        },
        ...mergeExpectations,
        ...(source.profile
          ? ([
              {
                kind: "profile-revision",
                profileId: sourceProfileId,
                revision: source.profile.revision,
              },
            ] as const)
          : []),
      ],
      mutations: [
        ...(source.profile
          ? ([
              {
                kind: "delete-retired-profile",
                profileId: sourceProfileId,
                targetProfileId: firstTargetProfileId,
              },
            ] as const)
          : []),
        {
          kind: "update-auth-recovery",
          value: canonicalRecoveryValue(updated),
        },
      ],
    });
  };

  const recoverProfile = async (profileId: string): Promise<boolean> => {
    const aggregate = await readCanonicalProfileAggregate(db, profileId);
    if (!aggregate.recovery) return true;
    let job = canonicalRecoveryJob(aggregate.recovery);
    await recoverClaims(job);
    const refreshed = await readCanonicalProfileAggregate(db, profileId);
    if (!refreshed.recovery) return true;
    job = canonicalRecoveryJob(refreshed.recovery);
    if (job.loginUids.some(isCanonicalFirebaseUid)) return false;
    if (job.sourceProfileIds.length === 0) {
      if (job.loginUids.length !== 0) {
        logger.error(JSON.stringify({ event: "auth_recovery_uid_invalid" }));
        return false;
      }
      if (now() - job.updatedAtMs < MERGE_GAME_FINALIZE_DELAY_MS) return false;
      return mutateCanonicalRecoveryJob(db, profileId, (live) =>
        live.loginUids.length === 0 &&
        live.sourceProfileIds.length === 0 &&
        now() - live.updatedAtMs >= MERGE_GAME_FINALIZE_DELAY_MS
          ? null
          : undefined,
      );
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
      if (!(error instanceof CanonicalProfileConflict)) {
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
    return !(await readCanonicalProfileAggregate(db, profileId)).recovery;
  };

  return { recoverProfile, removeLoginUid };
}

export function createAuthRecoveryService(
  env: Env,
  dependencies: AuthRecoveryDependencies = {},
) {
  return createCanonicalAuthRecoveryService(env, dependencies);
}

async function sweepCanonicalAuthRecoveryJobs(
  env: Env,
  dependencies: Pick<
    AuthRecoveryDependencies,
    "logger" | "now" | "profileDb"
  > = {},
): Promise<number> {
  const db = dependencies.profileDb || env.PROFILE_DB;
  const logger = dependencies.logger || console;
  const now = dependencies.now || Date.now;
  const threshold = now() - STALE_ENQUEUE_MS;
  let enqueued = 0;
  let firstFailure: unknown;
  const page = await db
    .prepare(
      `SELECT * FROM profile_auth_recovery_jobs
       WHERE last_enqueued_at_ms <= ?
       ORDER BY last_enqueued_at_ms, profile_id
       LIMIT ?`,
    )
    .bind(threshold, PROFILE_BACKGROUND_SWEEP_LIMIT)
    .all();
  for (const row of page.results) {
    const rawProfileId = cleanString(record(row).profile_id);
    if (!rawProfileId) {
      throw new Error("auth-recovery-job-invalid");
    }
    let job: CanonicalAuthRecoverySnapshot;
    try {
      job = parseCanonicalAuthRecoveryRow(row);
    } catch {
      logger.error(JSON.stringify({ event: "auth_recovery_job_invalid" }));
      continue;
    }
    try {
      await enqueuePersistedCanonicalAuthRecovery(
        env,
        db,
        job.profileId,
        now(),
      );
      enqueued++;
    } catch (error) {
      firstFailure ||= error;
      logger.error(JSON.stringify({ event: "auth_recovery_enqueue_failure" }));
    }
  }
  if (firstFailure) throw firstFailure;
  return enqueued;
}

export async function sweepAuthRecoveryJobs(
  env: Env,
  dependencies: Pick<
    AuthRecoveryDependencies,
    "logger" | "now" | "profileDb"
  > = {},
): Promise<number> {
  return sweepCanonicalAuthRecoveryJobs(env, dependencies);
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
