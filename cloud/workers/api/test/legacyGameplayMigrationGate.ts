import { AsyncLocalStorage } from "node:async_hooks";
import { AuthApiFailure } from "../src/authErrors.ts";
import {
  acquireMatchStateAdmission,
  assertMatchStateAdmission,
  completeMatchStateAdmission,
  extendMatchStateAdmissionResources,
  markMatchStateAdmissionUncertain,
  type MatchStateAdmission,
  type MatchStateAdmissionInput,
} from "../src/matchStateD1.ts";

type Operation = {
  db: D1Database;
  admission: MatchStateAdmission;
  uncertain: boolean;
  pending: number;
  closing: boolean;
  release?: Promise<void>;
  resourcesUpdating?: Promise<void>;
};

const operations = new AsyncLocalStorage<Operation | undefined>();

async function releaseCompletedOperation(operation: Operation): Promise<void> {
  if (!operation.closing || operation.pending || operation.uncertain) return;
  operation.release ||= completeMatchStateAdmission(
    operation.db,
    operation.admission,
  );
  await operation.release;
}

export function currentMatchStateAdmission(): MatchStateAdmission | undefined {
  return operations.getStore()?.admission;
}

export async function withGameplayMigrationOperation<T>(
  db: D1Database,
  input: MatchStateAdmissionInput,
  work: (admission: MatchStateAdmission) => Promise<T>,
): Promise<T> {
  const existing = operations.getStore();
  if (existing) {
    if (existing.db !== db)
      throw new Error("match-state-admission-database-conflict");
    if (existing.closing) {
      return operations.run(undefined, () =>
        withGameplayMigrationOperation(db, input, work),
      );
    }
    existing.pending++;
    try {
      await assertMatchStateAdmission(db, existing.admission);
      return await work(existing.admission);
    } finally {
      existing.pending--;
      await releaseCompletedOperation(existing);
    }
  }
  const admission = await acquireMatchStateAdmission(db, input);
  const operation: Operation = {
    db,
    admission,
    uncertain: false,
    pending: 0,
    closing: false,
  };
  return operations.run(operation, async () => {
    try {
      return await work(admission);
    } finally {
      operation.closing = true;
      await releaseCompletedOperation(operation);
    }
  });
}

export async function withMatchStateWrite<T>(
  db: D1Database,
  input: MatchStateAdmissionInput,
  work: (admission: MatchStateAdmission) => Promise<T>,
): Promise<T> {
  return withGameplayMigrationOperation(db, input, async (admission) => {
    const current = operations.getStore();
    if (current) {
      current.resourcesUpdating = (
        current.resourcesUpdating || Promise.resolve()
      ).then(async () => {
        await extendMatchStateAdmissionResources(
          db,
          admission,
          input.resources,
        );
      });
      await current.resourcesUpdating;
    }
    await assertMatchStateAdmission(db, admission);
    try {
      return await work(admission);
    } catch (error) {
      if (!(error instanceof AuthApiFailure && error.status < 500)) {
        const operation = operations.getStore();
        if (operation) operation.uncertain = true;
        await markMatchStateAdmissionUncertain(db, admission);
      }
      throw error;
    }
  });
}

export async function assertGameplayMigrationOperation(
  db: D1Database,
): Promise<void> {
  const operation = operations.getStore();
  if (!operation || operation.db !== db)
    throw new AuthApiFailure(
      503,
      "unavailable",
      "match-state-admission-required",
    );
  await assertMatchStateAdmission(db, operation.admission);
}

export async function readCurrentMatchState<T>(
  env: Env,
  read: (
    control: import("../src/matchStateD1.ts").MatchStateControl,
  ) => Promise<T>,
): Promise<T> {
  const { readMatchStateControl } = await import("../src/matchStateD1.ts");
  for (let attempt = 0; attempt < 3; attempt++) {
    const control = await readMatchStateControl(env.PROFILE_GAMES_DB);
    let result: T;
    try {
      result = await read(control);
    } catch (error) {
      const latest = await readMatchStateControl(env.PROFILE_GAMES_DB);
      if (latest.backend !== control.backend || latest.epoch !== control.epoch)
        continue;
      throw error;
    }
    const latest = await readMatchStateControl(env.PROFILE_GAMES_DB);
    if (latest.backend === control.backend && latest.epoch === control.epoch)
      return result;
  }
  throw new Error("match-state-read-authority-changed");
}
