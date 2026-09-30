import { uniqueStoredLoginUids } from "../authPolicy.ts";
import { isSafeRecordKey } from "../recordKeys.ts";
import {
  commitCanonicalPlan,
  readCanonicalAuthRecoveryJob,
  type CanonicalAuthRecoverySnapshot,
  type CanonicalAuthRecoveryValue,
} from "../profileCanonicalD1.ts";

export const AUTH_RECOVERY_QUEUE_NAME = "mons-link-auth-recovery";
export const RETRY_DELAY_SECONDS = 60;

export type AuthRecoveryTask = {
  kind: "auth-profile-recovery";
  profileId: string;
};

export type AuthRecoveryPhase = "prizes" | "games" | "finalize";
export type AuthRecoveryOutcome = "done" | "continued" | "deferred";
export type AuthRecoveryMutation =
  "missing" | "unchanged" | "updated" | "deleted";

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

export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function exactDocumentId(value: unknown): string {
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

export type CanonicalRecoveryJob = AuthRecoveryJob & { revision: number };

export function canonicalRecoveryJob(
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

export function canonicalRecoveryValue(
  job: AuthRecoveryJob,
): CanonicalAuthRecoveryValue {
  return job;
}

export async function mutateCanonicalRecoveryJob(
  db: D1Database,
  profileId: string,
  update: (job: CanonicalRecoveryJob) => AuthRecoveryJob | null | undefined,
): Promise<AuthRecoveryMutation> {
  const recovery = await readCanonicalAuthRecoveryJob(db, profileId);
  if (!recovery) return "missing";
  const job = canonicalRecoveryJob(recovery);
  const next = update(job);
  if (next === undefined) return "unchanged";
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
  return next === null ? "deleted" : "updated";
}

export async function removeCanonicalAuthRecoveryLoginUid(
  db: D1Database,
  profileId: string,
  uid: string,
  now: () => number = Date.now,
): Promise<boolean> {
  const result = await mutateCanonicalRecoveryJob(db, profileId, (job) => {
    const loginUids = job.loginUids.filter((candidate) => candidate !== uid);
    return loginUids.length === job.loginUids.length
      ? undefined
      : { ...job, loginUids, updatedAtMs: now() };
  });
  return result === "updated";
}
