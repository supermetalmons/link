import { AUTH_METHODS, type AuthMethodKey } from "@mons/shared/auth";
import {
  cleanString,
  throwMethodCooldown,
  throwProfileMethodCooldown,
} from "../authPolicy.ts";
import { PROFILE_BACKGROUND_SWEEP_LIMIT } from "../profileBackgroundLimits.ts";
import {
  CanonicalProfileCorruption,
  commitCanonicalPlan,
  type CanonicalExpectation,
  type CanonicalMutation,
} from "../profileCanonicalD1.ts";
import { record } from "./policy.ts";

type CanonicalCooldownRow = {
  revision: number;
  retry_at_ms: number;
};

type CooldownPlan = {
  expectations: CanonicalExpectation[];
  mutations: CanonicalMutation[];
};

export async function cooldownPlan(
  db: D1Database,
  profileId: string | null,
  method: AuthMethodKey,
  normalizedValue: string,
  nowMs: number,
): Promise<CooldownPlan> {
  const results = await db.batch([
    db
      .prepare(
        `SELECT revision, retry_at_ms FROM profile_auth_method_revocations
         WHERE method = ? AND normalized_value = ?`,
      )
      .bind(method, normalizedValue),
    ...(profileId
      ? [
          db
            .prepare(
              `SELECT revision, retry_at_ms FROM profile_auth_method_cooldowns
               WHERE profile_id = ? AND method = ?`,
            )
            .bind(profileId, method),
        ]
      : []),
  ]);
  const expectations: CanonicalExpectation[] = [];
  const mutations: CanonicalMutation[] = [];
  const revocation = results[0]!.results[0] as CanonicalCooldownRow | undefined;
  if (revocation) {
    if (
      !Number.isSafeInteger(revocation.revision) ||
      !Number.isSafeInteger(revocation.retry_at_ms)
    ) {
      throw new CanonicalProfileCorruption();
    }
    if (revocation.retry_at_ms > nowMs) {
      throwMethodCooldown(method, revocation.retry_at_ms);
    }
    expectations.push({
      kind: "method-revocation-revision",
      method,
      normalizedValue,
      revision: revocation.revision,
    });
    mutations.push({
      kind: "delete-method-revocation",
      method,
      normalizedValue,
    });
  } else {
    expectations.push({
      kind: "method-revocation-absent",
      method,
      normalizedValue,
    });
  }
  const profileCooldown = results[1]?.results[0] as
    CanonicalCooldownRow | undefined;
  if (profileId && profileCooldown) {
    if (
      !Number.isSafeInteger(profileCooldown.revision) ||
      !Number.isSafeInteger(profileCooldown.retry_at_ms)
    ) {
      throw new CanonicalProfileCorruption();
    }
    if (profileCooldown.retry_at_ms > nowMs) {
      throwProfileMethodCooldown(
        method,
        profileId,
        profileCooldown.retry_at_ms,
      );
    }
    expectations.push({
      kind: "method-cooldown-revision",
      method,
      profileId,
      revision: profileCooldown.revision,
    });
    mutations.push({ kind: "delete-method-cooldown", method, profileId });
  } else if (profileId) {
    expectations.push({ kind: "method-cooldown-absent", method, profileId });
  }
  return { expectations, mutations };
}

export async function sweepExpiredCanonicalAuthCooldowns(
  db: D1Database,
  nowMs: number,
  limit = PROFILE_BACKGROUND_SWEEP_LIMIT,
): Promise<{ cooldowns: number; revocations: number }> {
  if (
    !Number.isSafeInteger(nowMs) ||
    nowMs < 0 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 500
  ) {
    throw new TypeError("invalid-auth-cooldown-sweep");
  }
  const [revocations, cooldowns] = await db.batch([
    db
      .prepare(
        `SELECT method, normalized_value, revision
         FROM profile_auth_method_revocations
         WHERE retry_at_ms <= ? ORDER BY retry_at_ms, method, normalized_value
         LIMIT ?`,
      )
      .bind(nowMs, limit),
    db
      .prepare(
        `SELECT profile_id, method, revision
         FROM profile_auth_method_cooldowns
         WHERE retry_at_ms <= ? ORDER BY retry_at_ms, profile_id, method
         LIMIT ?`,
      )
      .bind(nowMs, limit),
  ]);
  const expectations: CanonicalExpectation[] = [];
  const mutations: CanonicalMutation[] = [];
  for (const value of revocations!.results) {
    const row = record(value);
    const method = row.method;
    const normalizedValue = cleanString(row.normalized_value);
    const revision = Number(row.revision);
    if (
      !AUTH_METHODS.includes(method as AuthMethodKey) ||
      !normalizedValue ||
      !Number.isSafeInteger(revision)
    ) {
      throw new CanonicalProfileCorruption();
    }
    expectations.push({
      kind: "method-revocation-revision",
      method: method as AuthMethodKey,
      normalizedValue,
      revision,
    });
    mutations.push({
      kind: "delete-method-revocation",
      method: method as AuthMethodKey,
      normalizedValue,
    });
  }
  for (const value of cooldowns!.results) {
    const row = record(value);
    const method = row.method;
    const profileId = cleanString(row.profile_id);
    const revision = Number(row.revision);
    if (
      !AUTH_METHODS.includes(method as AuthMethodKey) ||
      !profileId ||
      !Number.isSafeInteger(revision)
    ) {
      throw new CanonicalProfileCorruption();
    }
    expectations.push({
      kind: "method-cooldown-revision",
      method: method as AuthMethodKey,
      profileId,
      revision,
    });
    mutations.push({
      kind: "delete-method-cooldown",
      method: method as AuthMethodKey,
      profileId,
    });
  }
  await commitCanonicalPlan(db, { expectations, mutations });
  return {
    revocations: revocations!.results.length,
    cooldowns: cooldowns!.results.length,
  };
}
