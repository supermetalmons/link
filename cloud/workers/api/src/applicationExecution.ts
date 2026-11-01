import { AsyncLocalStorage } from "node:async_hooks";
import {
  ApplicationAdmissionTasks,
  beginApplicationAdmission,
  blockApplicationAdmission,
  completeApplicationAdmission,
  type ApplicationAdmission,
  type ApplicationAdmissionKind,
} from "./applicationAdmissions.ts";
import {
  APPLICATION_DATABASE_BINDINGS,
  ApplicationDataUnavailable,
  type ApplicationDatabaseBinding,
} from "./applicationDataControl.ts";
import { fenceApplicationDatabase } from "./applicationD1.ts";
import { propagateApplicationRoomAdmission } from "./applicationRoomRpc.ts";

type BackgroundContext = Pick<ExecutionContext, "waitUntil">;
const operationScope = new AsyncLocalStorage<{
  admission: ApplicationAdmission;
  tasks: ApplicationAdmissionTasks;
  context: BackgroundContext | undefined;
}>();

function isDatabaseBinding(
  property: PropertyKey,
): property is ApplicationDatabaseBinding {
  return APPLICATION_DATABASE_BINDINGS.some((binding) => binding === property);
}

export function applicationExecutionEnv(
  env: Env,
  admission: ApplicationAdmission | (() => ApplicationAdmission),
): Env {
  const databases = new Map<ApplicationDatabaseBinding, D1Database>();
  let rooms: Env["INVITE_REACTIONS"] | undefined;
  return new Proxy(env, {
    get(target, property) {
      if (property === "INVITE_REACTIONS") {
        rooms ??= propagateApplicationRoomAdmission(
          target.INVITE_REACTIONS,
          () => (typeof admission === "function" ? admission() : admission),
        );
        return rooms;
      }
      if (!isDatabaseBinding(property)) {
        const value: unknown = Reflect.get(target, property, target);
        return value;
      }
      let database = databases.get(property);
      if (!database) {
        database = fenceApplicationDatabase(target[property], admission);
        databases.set(property, database);
      }
      return database;
    },
  });
}

function trackContext<T extends BackgroundContext>(
  ctx: T,
  tasks: ApplicationAdmissionTasks,
): T {
  return new Proxy(ctx, {
    get(target, property) {
      if (property === "waitUntil")
        return (promise: Promise<unknown>) =>
          target.waitUntil(tasks.track(promise));
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      return (...args: unknown[]): unknown => {
        const result: unknown = Reflect.apply(value, target, args);
        return result;
      };
    },
  });
}

export function currentApplicationAdmission():
  ApplicationAdmission | undefined {
  return operationScope.getStore()?.admission;
}

export function applicationWaitUntil(promise: Promise<unknown>): void {
  const scope = operationScope.getStore();
  if (!scope?.context) throw new ApplicationDataUnavailable();
  scope.context.waitUntil(scope.tasks.track(promise));
}

export function scopedApplicationEnv(env: Env): Env {
  return applicationExecutionEnv(env, () => {
    const admission = currentApplicationAdmission();
    if (!admission) throw new ApplicationDataUnavailable();
    return admission;
  });
}

export function applicationWorkflowStep<Step extends object>(
  step: Step,
  env: Env,
  dataEpoch: 0 | 1,
): Step {
  return new Proxy(step, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      if (property !== "do")
        return (...args: unknown[]): unknown => {
          const result: unknown = Reflect.apply(value, target, args);
          return result;
        };
      return (...args: unknown[]): unknown => {
        const callback = args.at(-1);
        if (typeof callback !== "function")
          throw new ApplicationDataUnavailable();
        const guarded = (...callbackArgs: unknown[]) =>
          runApplicationOperation(env, "workflow", dataEpoch, async () => {
            const result: unknown = Reflect.apply(
              callback,
              undefined,
              callbackArgs,
            );
            return await result;
          });
        const result: unknown = Reflect.apply(value, target, [
          ...args.slice(0, -1),
          guarded,
        ]);
        return result;
      };
    },
  });
}

export async function runApplicationOperation<
  T,
  Context extends BackgroundContext,
>(
  env: Env,
  kind: ApplicationAdmissionKind,
  dataEpoch: 0 | 1,
  work: (env: Env, context: Context | undefined) => Promise<T>,
  ctx?: Context,
  parent?: ApplicationAdmission,
): Promise<T> {
  const database = env.PROFILE_GAMES_DB;
  const admission = await beginApplicationAdmission(
    database,
    kind,
    dataEpoch,
    Date.now(),
    parent,
  );
  const tasks = new ApplicationAdmissionTasks(
    () => completeApplicationAdmission(database, admission),
    () => blockApplicationAdmission(database, admission, "operation-failed"),
  );
  let failed = true;
  return operationScope.run({ admission, tasks, context: ctx }, async () => {
    try {
      const result = await work(
        applicationExecutionEnv(env, admission),
        ctx ? trackContext(ctx, tasks) : undefined,
      );
      failed = false;
      return result;
    } finally {
      await tasks.finish(failed);
    }
  });
}
