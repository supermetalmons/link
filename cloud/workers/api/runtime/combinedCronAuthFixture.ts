import { createDefaultProfileAppearance } from "@mons/shared/appearance";
import { createStoredPlayerProfile } from "../src/profileCanonical/contracts.ts";
import { expect } from "vitest";
import {
  newAuthRecoveryJob,
  type AuthRecoveryTask,
} from "../src/authRecovery.ts";
import {
  createAuthStateRepository,
  type AuthIntentRecord,
  type XRedirectFlow,
} from "../src/authStateD1.ts";
import {
  commitCanonicalPlan,
  materializeCanonicalProfile,
  readCanonicalAuthRecoveryJob,
  readCanonicalLoginOwner,
  readCanonicalProfile,
  type CanonicalAuthRecoverySnapshot,
  type CanonicalLoginOwnerSnapshot,
  type CanonicalProfileSnapshot,
} from "../src/profileCanonicalD1.ts";

const authRecoverySweepSize = 10;

async function seedAuthState(db: D1Database, nowMs: number) {
  const repository = createAuthStateRepository(db);
  const records: Array<{
    expired: boolean;
    flowId: string;
    intentId: string;
    flow: XRedirectFlow | null;
    intent: AuthIntentRecord | null;
  }> = [];
  for (let index = 0; index <= authRecoverySweepSize; index++) {
    const suffix = String(index).padStart(3, "0");
    const intentId = `combined-cron-auth-intent-${suffix}`;
    const flowId = `combined-cron-auth-flow-${suffix}`;
    const uid = `combined-cron-auth-login-${suffix}`;
    const expired = index < authRecoverySweepSize;
    const createdAtMs = nowMs - 3 * 60 * 60 * 1_000;
    const expiresAtMs = expired
      ? nowMs - 2 * 60 * 60 * 1_000
      : nowMs + 5 * 60 * 1_000;
    expect(
      await repository.createAuthIntent({
        consumedAtMs: null,
        createdAtMs,
        expiresAtMs,
        intentId,
        method: "x",
        nonce: `nonce-${suffix}`,
        state: `state-${suffix}`,
        uid,
      }),
    ).toBe("created");
    expect(
      await repository.createXFlow({
        callbackUri: "https://api.mons.link/auth/x/callback",
        codeChallenge: `challenge-${suffix}`,
        codeVerifier: `verifier-${suffix}`,
        consentSource: "signin",
        createdAtMs,
        errorCode: null,
        expiresAtMs,
        flowId,
        intentId,
        method: "x",
        returnUrl: "https://mons.link/",
        status: "created",
        uid,
        updatedAtMs: createdAtMs,
        xUserId: null,
        xUsername: null,
      }),
    ).toBe("created");
    records.push({
      expired,
      flowId,
      intentId,
      flow: await repository.getXFlow(flowId),
      intent: await repository.getAuthIntent(intentId),
    });
  }
  return async () => {
    for (const record of records) {
      expect(await repository.getXFlow(record.flowId)).toEqual(
        record.expired ? null : record.flow,
      );
      expect(await repository.getAuthIntent(record.intentId)).toEqual(
        record.expired ? null : record.intent,
      );
    }
  };
}

export async function seedCombinedCronAuth(
  env: Pick<Env, "PROFILE_DB" | "AUTH_STATE_DB">,
  nowMs: number,
) {
  const jobs: Array<{
    profileId: string;
    loginUid: string;
    recovery: CanonicalAuthRecoverySnapshot;
    profile: CanonicalProfileSnapshot | null;
    owner: CanonicalLoginOwnerSnapshot | null;
  }> = [];
  for (let index = 0; index <= authRecoverySweepSize; index++) {
    const suffix = String(index).padStart(3, "0");
    const profileId = `combined-cron-auth-profile-${suffix}`;
    const loginUid = `combined-cron-auth-login-${suffix}`;
    const createdAtMs = nowMs - 3 * 60 * 60 * 1_000 + index;
    const recovery = {
      ...newAuthRecoveryJob(profileId, [loginUid], [], createdAtMs),
      lastEnqueuedAtMs: createdAtMs,
    };
    const profile = materializeCanonicalProfile({
      profile: createStoredPlayerProfile(
        profileId,
        createDefaultProfileAppearance(1),
        {
          nonce: index + 1,
          rating: 1500,
          totalManaPoints: index,
          win: false,
          username: `cronauth${suffix}`,
        },
      ),
      createdAtMs,
      updatedAtMs: createdAtMs,
    });
    await commitCanonicalPlan(env.PROFILE_DB, {
      expectations: [
        { kind: "profile-absent", profileId },
        { kind: "login-owner-absent", loginUid },
        { kind: "auth-recovery-absent", profileId },
      ],
      mutations: [
        { kind: "insert-active-profile", value: profile },
        {
          kind: "insert-login-owner",
          value: {
            loginUid,
            profileId,
            createdAtMs,
            updatedAtMs: createdAtMs,
          },
        },
        { kind: "insert-auth-recovery", value: recovery },
      ],
    });
    jobs.push({
      profileId,
      loginUid,
      recovery: { ...recovery, revision: 1 },
      profile: await readCanonicalProfile(env.PROFILE_DB, profileId),
      owner: await readCanonicalLoginOwner(env.PROFILE_DB, loginUid),
    });
  }
  const assertAuthState = await seedAuthState(env.AUTH_STATE_DB, nowMs);
  return {
    expectedTasks: jobs
      .slice(0, authRecoverySweepSize)
      .map(({ profileId }): AuthRecoveryTask => ({
        kind: "auth-profile-recovery",
        profileId,
      })),
    expectedDelaySeconds: 60,
    async assertAfterScheduled() {
      for (const [index, job] of jobs.entries()) {
        expect(
          await readCanonicalAuthRecoveryJob(env.PROFILE_DB, job.profileId),
          job.profileId,
        ).toEqual(
          index < authRecoverySweepSize
            ? {
                ...job.recovery,
                lastEnqueuedAtMs: nowMs,
                updatedAtMs: nowMs,
                revision: 2,
              }
            : job.recovery,
        );
        expect(
          await readCanonicalProfile(env.PROFILE_DB, job.profileId),
        ).toEqual(job.profile);
        expect(
          await readCanonicalLoginOwner(env.PROFILE_DB, job.loginUid),
        ).toEqual(job.owner);
        expect(
          await env.PROFILE_DB.prepare(
            "SELECT profile_id FROM profile_auth_recovery_quarantine_canonical WHERE profile_id = ?",
          )
            .bind(job.profileId)
            .first(),
        ).toBeNull();
      }
      await assertAuthState();
    },
  };
}
