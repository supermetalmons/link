import { STATE_FAILURE_MESSAGES } from "./stateCompatibility.ts";
import {
  getEventPrizeDefinition,
  isEventPrizeAssignmentWireRecord,
  isEventPrizeStandard,
} from "@mons/shared/event-prizes";
import { createEventLockManagerCore } from "../../../runtime/events/lockManagerCore.js";
import { MAX_PROFILE_MERGE_TARGET_HOPS } from "../../../runtime/profileMergeTargets.js";
import {
  createD1AuthRecoveryPrizeStore,
  type AuthRecoveryPrizeStore,
} from "./eventRepository.ts";
import { isCanonicalLoginUid, isSafeRecordKey } from "./recordKeys.ts";
import { cleanString, uniqueStoredLoginUids } from "./authPolicy.ts";
import {
  createProfileLinkCatchupStore,
  type ProfileLinkCatchupStore,
} from "./profileLinkCatchupD1.ts";
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
  CanonicalProfileCorruption,
  commitCanonicalPlan,
  parseCanonicalAuthRecoveryRow,
  readCanonicalAuthRecoveryJob,
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
const LOGIN_RECOVERY_PAGE_SIZE = 20;
const AUTH_RECOVERY_EVENT_PRIZE_OWNER_UID = "auth-recovery-worker";
const AUTH_RECOVERY_PRIZE_OPERATION_TIMEOUT_MS = 20_000;

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
  catchupStore?: ProfileLinkCatchupStore;
  buildPrizeCopy?: typeof buildPrizeCopy;
  d1?: D1Database;
  logger?: Pick<Console, "error" | "info">;
  now?: () => number;
  profileDb?: D1Database;
  prizeOperationTimeoutMs?: number;
  prizeStore?: AuthRecoveryPrizeStore;
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
  return isSafeRecordKey(value) ? value : "";
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
    loginUids: uniqueStoredLoginUids(loginUids),
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

export async function dispatchProfileLinkCatchupForOwner(
  uid: string,
  profileId: string,
  dependencies: {
    catchupStore: Pick<ProfileLinkCatchupStore, "readForOwner">;
    enqueueProfileLinkProjection?: (
      task: ProfileLinkProfileGameProjectionTask,
    ) => Promise<unknown>;
    logger?: Pick<Console, "error">;
  },
): Promise<void> {
  if (!isCanonicalLoginUid(uid)) {
    throw new TypeError(STATE_FAILURE_MESSAGES.invalidLoginUid);
  }
  const catchup = await dependencies.catchupStore.readForOwner(uid, profileId);
  if (catchup && dependencies.enqueueProfileLinkProjection) {
    try {
      await dependencies.enqueueProfileLinkProjection({
        kind: "profile-link-profile-game-projection",
        loginUid: uid,
        requestId: catchup.requestId,
      });
    } catch {
      (dependencies.logger || console).error(
        JSON.stringify({
          event: "profile_link_profile_game_projection_enqueue_failed",
          loginUid: uid,
        }),
      );
    }
  }
}

function timestampMillis(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.floor(value)
    : 0;
}

function mergeFreshness(fields: Record<string, unknown>): number {
  return Math.max(
    timestampMillis(fields.updatedAt),
    timestampMillis(fields.listSortAt),
  );
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const fields = value as Record<string, unknown>;
    return `{${Object.keys(fields)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(fields[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "";
}

function isSamePrizeAssignment(value: unknown, expected: unknown): boolean {
  const current = record(value);
  const assignment = record(expected);
  return (
    current.eventId === assignment.eventId &&
    current.profileId === assignment.profileId &&
    current.place === assignment.place &&
    current.prizeId === assignment.prizeId &&
    current.assignedAtMs === assignment.assignedAtMs
  );
}

function withTimeoutSignal(
  signal: AbortSignal | undefined,
  timeoutMs: number,
): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}

function buildPrizeCopy(
  sourceProfileId: string,
  targetProfileId: string,
  eventId: string,
  value: unknown,
): Record<string, unknown> | null {
  const normalizedEventId = cleanString(eventId);
  if (
    !isEventPrizeAssignmentWireRecord(value) ||
    value.eventId !== normalizedEventId ||
    value.profileId !== sourceProfileId
  ) {
    return null;
  }
  return {
    ...value,
    profileId: targetProfileId,
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
  const recovery = await readCanonicalAuthRecoveryJob(db, profileId);
  if (!recovery) return true;
  const job = canonicalRecoveryJob(recovery);
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

export async function removeCanonicalAuthRecoveryLoginUid(
  db: D1Database,
  profileId: string,
  uid: string,
  now: () => number = Date.now,
): Promise<void> {
  await mutateCanonicalRecoveryJob(db, profileId, (job) => {
    const loginUids = job.loginUids.filter((candidate) => candidate !== uid);
    return loginUids.length === job.loginUids.length
      ? undefined
      : { ...job, loginUids, updatedAtMs: now() };
  });
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
  const catchupStore =
    dependencies.catchupStore || createProfileLinkCatchupStore(db);
  const prizeStore =
    dependencies.prizeStore || createD1AuthRecoveryPrizeStore(env.EVENT_DB);
  const logger = dependencies.logger || console;
  const now = dependencies.now || Date.now;
  const prizeOperationTimeoutMs =
    Number.isSafeInteger(dependencies.prizeOperationTimeoutMs) &&
    Number(dependencies.prizeOperationTimeoutMs) > 0
      ? Math.min(
          Number(dependencies.prizeOperationTimeoutMs),
          AUTH_RECOVERY_PRIZE_OPERATION_TIMEOUT_MS,
        )
      : AUTH_RECOVERY_PRIZE_OPERATION_TIMEOUT_MS;
  const profileGamesDb = dependencies.d1 || env.PROFILE_GAMES_DB;
  const withdrawalDb =
    dependencies.withdrawalDb || env.EVENT_PRIZE_WITHDRAWALS_DB;
  const withdrawals =
    dependencies.withdrawalStore ||
    createD1EventPrizeWithdrawalStore(withdrawalDb, { now });

  const copyPrize = async (
    sourceProfileId: string,
    targetProfileId: string,
    eventId: string,
  ): Promise<void> => {
    const signal = withTimeoutSignal(
      dependencies.signal,
      prizeOperationTimeoutMs,
    );
    const prizeLockManager = createEventLockManagerCore({
      createLockId: () => crypto.randomUUID(),
      now,
      transactPath: (path, updater) =>
        prizeStore.transactPath(path, updater, signal),
      releaseTransactPath: (path, updater) =>
        prizeStore.transactPath(path, updater),
    });
    const lock = await prizeLockManager.acquireEventLock(
      eventId,
      AUTH_RECOVERY_EVENT_PRIZE_OWNER_UID,
    );
    if (!lock) throw new Error("auth-recovery-prize-lock-busy");
    const stopHeartbeat = prizeLockManager.startEventLockHeartbeat(lock);
    try {
      const sourceAssignment = await prizeStore.readProfileEventPrizeAssignment(
        sourceProfileId,
        eventId,
        signal,
      );
      const assignment = (dependencies.buildPrizeCopy || buildPrizeCopy)(
        sourceProfileId,
        targetProfileId,
        eventId,
        sourceAssignment,
      );
      if (!assignment) throw new Error("auth-recovery-prize-invalid");
      const prizeId = cleanString(assignment.prizeId);
      const targetPath = `profileEventPrizes/${targetProfileId}/${eventId}`;
      const lockGuard = prizeLockManager.getEventLockGuard(lock);
      const transactTarget = (updater: (current: unknown) => unknown) =>
        prizeStore.transactStoredProfileEventPrizeWithEventLease(
          targetPath,
          updater,
          lockGuard,
          signal,
        );
      const assertPrizeLockOwned = async (): Promise<void> => {
        if (!(await prizeLockManager.isEventLockStillOwned(lock))) {
          throw new Error("auth-recovery-prize-lock-lost");
        }
      };
      const removeIfCompleted = async (): Promise<boolean> => {
        if (!prizeId) return false;
        const withdrawal = await withdrawals.get(eventId, prizeId);
        if (!isCompletedPrizeWithdrawal(withdrawal, eventId, prizeId)) {
          return false;
        }
        await assertPrizeLockOwned();
        await transactTarget((current) =>
          cleanString(record(current).eventId) === eventId &&
          cleanString(record(current).prizeId) === prizeId
            ? { value: null }
            : { commit: false },
        );
        return true;
      };
      if (await removeIfCompleted()) return;
      await assertPrizeLockOwned();
      await transactTarget((current) => {
        if (current === null || current === undefined) {
          return { value: assignment };
        }
        if (canonicalJson(current) === canonicalJson(assignment)) {
          return { commit: false };
        }
        if (isSamePrizeAssignment(current, assignment)) {
          return { value: assignment };
        }
        throw new Error("auth-recovery-prize-conflict");
      });
      await removeIfCompleted();
    } finally {
      stopHeartbeat();
      await prizeLockManager.releaseEventLock(lock);
    }
  };

  const recoverLogins = async (job: CanonicalRecoveryJob): Promise<void> => {
    for (const uid of job.loginUids
      .filter(isCanonicalLoginUid)
      .slice(0, LOGIN_RECOVERY_PAGE_SIZE)) {
      try {
        await dispatchProfileLinkCatchupForOwner(uid, job.profileId, {
          catchupStore,
          enqueueProfileLinkProjection: (task) =>
            env.PROFILE_GAME_PROJECTION_QUEUE.send(task),
          logger,
        });
        await removeCanonicalAuthRecoveryLoginUid(db, job.profileId, uid, now);
      } catch {
        logger.error(JSON.stringify({ event: "auth_login_recovery_pending" }));
      }
    }
  };

  const copyPrizePage = async (
    sourceProfileId: string,
    targetProfileId: string,
    prizeCursor: string | null,
  ): Promise<{
    complete: boolean;
    copied: number;
    nextCursor: string | null;
  }> => {
    const cursor = prizeCursor || "";
    const source = record(
      await prizeStore.listProfileEventPrizeAssignments(
        sourceProfileId,
        {
          ...(cursor ? { startAt: cursor } : {}),
          limit: cursor
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
    for (const [eventId] of page) {
      await copyPrize(sourceProfileId, targetProfileId, eventId);
    }
    return {
      complete: remaining.length <= page.length,
      copied: page.length,
      nextCursor: page.at(-1)?.[0] || prizeCursor,
    };
  };

  const recoverPrizes = async (
    job: CanonicalRecoveryJob,
    sourceProfileId: string,
  ): Promise<void> => {
    const page = await copyPrizePage(
      sourceProfileId,
      job.profileId,
      job.prizeCursor,
    );
    await mutateCanonicalRecoveryJob(db, job.profileId, (live) =>
      live.sourceProfileIds[0] === sourceProfileId &&
      live.sourcePhase === "prizes" &&
      live.prizeCursor === job.prizeCursor
        ? {
            ...live,
            sourcePhase: page.complete ? "games" : "prizes",
            prizeCursor: page.nextCursor,
            phaseStartedAtMs: page.complete ? now() : live.phaseStartedAtMs,
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
            prizeCursor: null,
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
    const prizePage = await copyPrizePage(
      sourceProfileId,
      job.profileId,
      job.prizeCursor,
    );
    if (!prizePage.complete || prizePage.copied > 0) {
      await mutateCanonicalRecoveryJob(db, job.profileId, (live) =>
        live.sourceProfileIds[0] === sourceProfileId &&
        live.sourcePhase === "finalize" &&
        live.prizeCursor === job.prizeCursor
          ? {
              ...live,
              prizeCursor: prizePage.nextCursor,
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
    const recovery = await readCanonicalAuthRecoveryJob(db, profileId);
    if (!recovery) return true;
    let job = canonicalRecoveryJob(recovery);
    await recoverLogins(job);
    const refreshed = await readCanonicalAuthRecoveryJob(db, profileId);
    if (!refreshed) return true;
    job = canonicalRecoveryJob(refreshed);
    if (job.loginUids.some(isCanonicalLoginUid)) return false;
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
    return !(await readCanonicalAuthRecoveryJob(db, profileId));
  };

  return { recoverProfile };
}

export function createAuthRecoveryService(
  env: Env,
  dependencies: AuthRecoveryDependencies = {},
) {
  return createCanonicalAuthRecoveryService(env, dependencies);
}

const AUTH_RECOVERY_JOB_SNAPSHOT_SQL = `hex(json_array(${[
  "profile_id",
  "login_uids_json",
  "source_profile_ids_json",
  "source_phase",
  "prize_cursor",
  "phase_started_at_ms",
  "last_enqueued_at_ms",
  "created_at_ms",
  "updated_at_ms",
  "revision",
]
  .map(
    (column) =>
      `typeof(job.${column}), CASE WHEN typeof(job.${column}) = 'blob'
       THEN hex(job.${column}) ELSE job.${column} END`,
  )
  .join(", ")}))`;

type AuthRecoverySweepRow = {
  profile_id: unknown;
  sweep_profile_id_bytes: number[];
  sweep_profile_id_type: "text" | "blob";
  sweep_revision_hex: string;
  sweep_snapshot_token: string;
};

type AuthRecoveryQuarantineReason = "invalid-record" | "invalid-profile-id";

function authRecoveryQuarantineReason(
  row: AuthRecoverySweepRow,
  profileId: string,
): AuthRecoveryQuarantineReason | null {
  const encodedId = new TextEncoder().encode(profileId);
  if (
    !profileId ||
    row.sweep_profile_id_type !== "text" ||
    encodedId.length !== row.sweep_profile_id_bytes.length ||
    !encodedId.every(
      (byte, index) => byte === row.sweep_profile_id_bytes[index],
    )
  ) {
    return "invalid-profile-id";
  }
  try {
    parseCanonicalAuthRecoveryRow(row);
    return null;
  } catch (error) {
    if (error instanceof CanonicalProfileCorruption) return "invalid-record";
    throw error;
  }
}

async function quarantineAuthRecoveryJob(
  db: D1Database,
  row: AuthRecoverySweepRow,
  reason: AuthRecoveryQuarantineReason,
  nowMs: number,
): Promise<boolean> {
  const profileIdBytes = Uint8Array.from(row.sweep_profile_id_bytes);
  const result = await db
    .prepare(
      `INSERT INTO profile_auth_recovery_quarantine (
         profile_id, revision_token, reason, quarantined_at_ms
       )
       SELECT job.profile_id, CAST(job.revision AS TEXT), ?, ?
       FROM profile_auth_recovery_jobs AS job
       WHERE job.profile_id = CASE WHEN ? = 'blob' THEN ? ELSE CAST(? AS TEXT) END
         AND ${AUTH_RECOVERY_JOB_SNAPSHOT_SQL} = ?
         AND EXISTS (
           SELECT 1 FROM profile_canonical_control
           WHERE singleton = 1 AND state = 'active'
         )
       ON CONFLICT(profile_id) DO UPDATE SET
         revision_token = excluded.revision_token,
         reason = excluded.reason,
         quarantined_at_ms = excluded.quarantined_at_ms
       WHERE profile_auth_recovery_quarantine.revision_token != excluded.revision_token`,
    )
    .bind(
      reason,
      nowMs,
      row.sweep_profile_id_type,
      profileIdBytes,
      profileIdBytes,
      row.sweep_snapshot_token,
    )
    .run();
  return result.meta.changes === 1;
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
      `SELECT job.*, CAST(job.profile_id AS BLOB) AS sweep_profile_id_bytes,
              typeof(job.profile_id) AS sweep_profile_id_type,
              hex(CAST(job.revision AS TEXT)) AS sweep_revision_hex,
              ${AUTH_RECOVERY_JOB_SNAPSHOT_SQL} AS sweep_snapshot_token
       FROM profile_auth_recovery_jobs AS job
       WHERE job.last_enqueued_at_ms <= ?
         AND NOT EXISTS (
           SELECT 1 FROM profile_auth_recovery_quarantine AS quarantine
           WHERE quarantine.profile_id = job.profile_id
             AND quarantine.revision_token = CAST(job.revision AS TEXT)
         )
       ORDER BY job.last_enqueued_at_ms, job.profile_id
       LIMIT ?`,
    )
    .bind(threshold, PROFILE_BACKGROUND_SWEEP_LIMIT)
    .all<AuthRecoverySweepRow>();
  for (const row of page.results) {
    let quarantineReason: AuthRecoveryQuarantineReason | null = null;
    try {
      if (
        !Array.isArray(row.sweep_profile_id_bytes) ||
        (row.sweep_profile_id_type !== "text" &&
          row.sweep_profile_id_type !== "blob") ||
        typeof row.sweep_revision_hex !== "string" ||
        typeof row.sweep_snapshot_token !== "string"
      ) {
        throw new Error("auth-recovery-sweep-row-invalid");
      }
      const profileId = exactDocumentId(row.profile_id);
      quarantineReason = authRecoveryQuarantineReason(row, profileId);
      if (quarantineReason) {
        if (await quarantineAuthRecoveryJob(db, row, quarantineReason, now())) {
          logger.error(
            JSON.stringify({
              event: "auth_recovery_job_quarantined",
              profileIdHex: row.sweep_profile_id_bytes
                .map((byte) => byte.toString(16).padStart(2, "0"))
                .join(""),
              revisionHex: row.sweep_revision_hex,
              reason: quarantineReason,
            }),
          );
        }
        continue;
      }
      await enqueuePersistedCanonicalAuthRecovery(env, db, profileId, now());
      enqueued++;
    } catch (error) {
      firstFailure ||= error;
      logger.error(
        JSON.stringify({
          event: quarantineReason
            ? "auth_recovery_quarantine_failure"
            : "auth_recovery_enqueue_failure",
        }),
      );
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
