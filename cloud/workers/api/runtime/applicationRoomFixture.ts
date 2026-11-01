import { applyRetiredProfileMigrations } from "./profileTestMigrations.ts";
import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  runInDurableObject,
  waitOnExecutionContext,
  type D1Migration,
} from "cloudflare:test";
import {
  applyCanonicalTestMigrations,
  activateCanonicalTestControl,
} from "./canonicalTestMigrations.ts";
import {
  APPLICATION_ADMISSION_HEADER,
  APPLICATION_ROOM_RPC_ARITY,
  readApplicationAdmissionHeader,
  readApplicationRpcAdmission,
} from "../src/applicationRoomRpc.ts";
import {
  currentApplicationAdmission,
  runApplicationOperation,
} from "../src/applicationExecution.ts";
import type { InviteReactions } from "../src/inviteReactions.ts";
import type { EventUpdates } from "../src/eventUpdates.ts";

type Room = DurableObjectStub<InviteReactions>;
type ApplicationRoom = Room | DurableObjectStub<EventUpdates>;
const rawRooms = new WeakMap<object, object>();
const MIGRATIONS = {
  PROFILE_GAMES_DB: "TEST_D1_MIGRATIONS",
  PROFILE_DB: "TEST_PROFILE_D1_MIGRATIONS",
} as const;

export async function activateCanonicalApplicationFixture(): Promise<void> {
  const fixture = env as Env &
    Record<(typeof MIGRATIONS)[keyof typeof MIGRATIONS], D1Migration[]>;
  await Promise.all(
    Object.entries(MIGRATIONS).map(async ([binding, migrations]) => {
      const database = fixture[binding as keyof typeof MIGRATIONS];
      const steps = fixture[migrations];
      if (binding === "PROFILE_DB") {
        const table = await database
          .prepare(
            "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'd1_migrations'",
          )
          .first();
        const applied = table
          ? await database
              .prepare("SELECT name FROM d1_migrations WHERE name = ?")
              .bind(steps.at(-1)!.name)
              .first()
          : null;
        if (!applied)
          await applyRetiredProfileMigrations(database, steps, "a".repeat(64));
      } else await applyCanonicalTestMigrations(database, steps);
      await activateCanonicalTestControl(database);
    }),
  );
}

export function rawApplicationRoom<T extends object>(room: T): T {
  return (rawRooms.get(room) ?? room) as T;
}

export function admittedApplicationRoom<T extends ApplicationRoom>(
  room: T,
  binding: "INVITE_REACTIONS" | "EVENT_UPDATES" = "INVITE_REACTIONS",
): T {
  if (rawRooms.has(room)) return room;
  const wrapped = new Proxy(room, {
    get(target, property) {
      if (
        property !== "fetch" &&
        (typeof property !== "string" ||
          !Object.hasOwn(APPLICATION_ROOM_RPC_ARITY, property))
      ) {
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" && property !== "constructor"
          ? value.bind(target)
          : value;
      }
      return async (...args: unknown[]) => {
        if (
          property === "fetch" &&
          args[0] instanceof Request &&
          args[1] === undefined &&
          args[0].headers.has(APPLICATION_ADMISSION_HEADER)
        ) {
          readApplicationAdmissionHeader(args[0]);
          return target.fetch(args[0]);
        }
        if (
          typeof property === "string" &&
          Object.hasOwn(APPLICATION_ROOM_RPC_ARITY, property) &&
          args.length ===
            APPLICATION_ROOM_RPC_ARITY[
              property as keyof typeof APPLICATION_ROOM_RPC_ARITY
            ] +
              1
        ) {
          readApplicationRpcAdmission(args.at(-1));
          const callback: unknown = Reflect.get(target, property, target);
          if (typeof callback !== "function")
            throw new Error("fixture-rpc-missing");
          return Reflect.apply(callback, target, args);
        }
        const context = createExecutionContext();
        try {
          return await runApplicationOperation(
            env,
            "http",
            1,
            async (admittedEnv) => {
              const admitted = admittedEnv[binding].get(target.id);
              const callback: unknown = Reflect.get(
                admitted,
                property,
                admitted,
              );
              if (typeof callback !== "function")
                throw new Error("fixture-rpc-missing");
              const result: unknown = Reflect.apply(callback, admitted, args);
              return await result;
            },
            context,
          );
        } finally {
          await waitOnExecutionContext(context);
        }
      };
    },
  });
  rawRooms.set(wrapped, room);
  return wrapped;
}

export async function canonicalRoomFixture(name: string): Promise<Room> {
  await activateCanonicalApplicationFixture();
  const room = admittedApplicationRoom(env.INVITE_REACTIONS.getByName(name));
  const response = await room.fetch("https://room.internal");
  await response.arrayBuffer();
  if (response.status !== 426)
    throw new Error("fixture-room-initialization-failed");
  return room;
}

async function runInAdmittedTypedRoom<
  Instance extends InviteReactions | EventUpdates,
  T,
>(
  room: DurableObjectStub<Instance>,
  callback: (instance: Instance, state: DurableObjectState) => T | Promise<T>,
): Promise<T> {
  const context = createExecutionContext();
  try {
    return await runApplicationOperation(
      env,
      "http",
      1,
      async () => {
        const admission = currentApplicationAdmission();
        if (!admission) throw new Error("fixture-admission-missing");
        return runInDurableObject<Instance, T>(
          rawApplicationRoom(room),
          (instance, state) => {
            const admitted = new Proxy(instance, {
              get(target, property) {
                const value: unknown = Reflect.get(target, property, target);
                if (typeof value !== "function") return value;
                if (property === "fetch")
                  return (request: Request) => {
                    const input = new Request(request);
                    input.headers.set(
                      APPLICATION_ADMISSION_HEADER,
                      JSON.stringify(admission),
                    );
                    return target.fetch(input);
                  };
                if (
                  typeof property === "string" &&
                  Object.hasOwn(APPLICATION_ROOM_RPC_ARITY, property)
                )
                  return (...args: unknown[]) => {
                    const parameters = [...args];
                    const arity =
                      APPLICATION_ROOM_RPC_ARITY[
                        property as keyof typeof APPLICATION_ROOM_RPC_ARITY
                      ];
                    while (parameters.length < arity)
                      parameters.push(undefined);
                    const result: unknown = Reflect.apply(value, target, [
                      ...parameters,
                      admission,
                    ]);
                    return result;
                  };
                return value.bind(target);
              },
            });
            return runApplicationOperation(
              env,
              "rpc",
              1,
              async () => callback(admitted, state),
              state,
              admission,
            );
          },
        );
      },
      context,
    );
  } finally {
    await waitOnExecutionContext(context);
  }
}

export function runInAdmittedRoom<T>(
  room: Room,
  callback: (
    instance: InviteReactions,
    state: DurableObjectState,
  ) => T | Promise<T>,
): Promise<T> {
  return runInAdmittedTypedRoom<InviteReactions, T>(room, callback);
}

export function runInAdmittedEventRoom<T>(
  room: DurableObjectStub<EventUpdates>,
  callback: (
    instance: EventUpdates,
    state: DurableObjectState,
  ) => T | Promise<T>,
): Promise<T> {
  return runInAdmittedTypedRoom<EventUpdates, T>(room, callback);
}
