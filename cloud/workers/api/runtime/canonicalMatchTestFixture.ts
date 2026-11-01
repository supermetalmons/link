import {
  activateCanonicalApplicationFixture,
  admittedApplicationRoom,
  rawApplicationRoom,
  runInAdmittedRoom,
} from "./applicationRoomFixture.ts";
import { evictDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { getMatchStateRpc } from "../src/matchStateRpc.ts";
import type { InviteReactions } from "../src/inviteReactions.ts";
import { MatchWriterStore } from "../src/matchWriterStore.ts";
import { matchWriterWriteGuards } from "../src/matchWriterSql.ts";
import { initializeApplicationObjectControl } from "../src/applicationObjectStorage.ts";
import type { MatchStateEventEffectsWireRequest } from "../src/matchStateWire.ts";
import { parseMatchStateEventEffects } from "../src/matchStateRequestCodec.ts";
import { currentApplicationAdmission } from "../src/applicationExecution.ts";
import {
  APPLICATION_ADMISSION_HEADER,
  APPLICATION_ROOM_RPC_ARITY,
} from "../src/applicationRoomRpc.ts";

type Room = DurableObjectStub<InviteReactions>;
export const evictCanonicalMatchRoom = (room: Room) =>
  evictDurableObject(rawApplicationRoom(room));
export const runCanonicalMatchAlarm = (room: Room) =>
  runDurableObjectAlarm(rawApplicationRoom(room));

export function admittedLocalMatchRoom(
  instance: InviteReactions,
): InviteReactions {
  return new Proxy(instance, {
    get(target, property) {
      const callback: unknown = Reflect.get(target, property, target);
      if (typeof callback !== "function") return callback;
      if (property === "fetch")
        return (request: Request) => {
          const admission = currentApplicationAdmission();
          if (!admission) throw new Error("fixture-admission-missing");
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
          const admission = currentApplicationAdmission();
          if (!admission) throw new Error("fixture-admission-missing");
          const parameters = [...args];
          const arity =
            APPLICATION_ROOM_RPC_ARITY[
              property as keyof typeof APPLICATION_ROOM_RPC_ARITY
            ];
          while (parameters.length < arity) parameters.push(undefined);
          return Reflect.apply(callback, target, [...parameters, admission]);
        };
      return callback.bind(target);
    },
  });
}

export function matchEventEffectsFixture(
  input: Pick<
    MatchStateEventEffectsWireRequest,
    "inviteId" | "epoch" | "operationId"
  > &
    Partial<
      Pick<
        MatchStateEventEffectsWireRequest,
        "creations" | "terminalTimers" | "claims"
      >
    >,
) {
  return parseMatchStateEventEffects({
    schemaVersion: 1,
    inviteId: input.inviteId,
    epoch: input.epoch,
    operationId: input.operationId,
    creations: input.creations ?? [],
    terminalTimers: input.terminalTimers ?? [],
    claims: input.claims ?? [],
  });
}

export function uncheckedMatchStorageFixture(
  storage: DurableObjectStorage,
  table: "records" | "claims",
): void {
  const name = `match_state_${table}_canonical`;
  storage.transactionSync(() => {
    storage.sql.exec(
      `CREATE TABLE copied_match_fixture AS SELECT * FROM ${name}`,
    );
    storage.sql.exec(`DROP TABLE ${name}`);
    storage.sql.exec(
      table === "records"
        ? `CREATE TABLE ${name}(match_id TEXT NOT NULL, player_id TEXT NOT NULL, value_json TEXT NOT NULL, PRIMARY KEY(match_id, player_id))`
        : `CREATE TABLE ${name}(match_id TEXT PRIMARY KEY, value_json TEXT NOT NULL)`,
    );
    const columns =
      table === "records"
        ? "match_id, player_id, value_json"
        : "match_id, value_json";
    storage.sql.exec(
      `INSERT INTO ${name} (${columns}) SELECT ${columns} FROM copied_match_fixture`,
    );
    storage.sql.exec("DROP TABLE copied_match_fixture");
    storage.sql.exec(matchWriterWriteGuards());
  });
}

export async function runInCanonicalMatchRoom<T>(
  room: Room,
  work: (
    instance: InviteReactions,
    state: DurableObjectState,
  ) => T | Promise<T>,
): Promise<T> {
  await activateCanonicalApplicationFixture();
  const response = await admittedApplicationRoom(room).fetch(
    "https://room.internal",
  );
  await response.arrayBuffer();
  if (response.status !== 426)
    throw new Error("fixture-room-initialization-failed");
  return runInAdmittedRoom(room, work);
}

export function runInCanonicalMatchWriterFixture<T>(
  room: Room,
  work: (
    instance: InviteReactions,
    state: DurableObjectState,
  ) => T | Promise<T>,
): Promise<T> {
  return runInCanonicalMatchRoom(room, async (instance, state) => {
    const handoff: unknown = Reflect.get(instance, "matchWriterStore");
    if (!(handoff instanceof MatchWriterStore))
      throw new Error("fixture-timer-writer-unavailable");
    const storage = handoff.guardStorage();
    const context = new Proxy(state, {
      get(target, property) {
        if (property === "storage") return storage;
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    let result: { value: T } | undefined;
    await handoff.runWriter(
      { kind: "alarm", request: { objectId: state.id.toString() } },
      async () => {
        storage.sql.exec(matchWriterWriteGuards());
        result = { value: await work(instance, context) };
      },
    );
    if (!result) throw new Error("fixture-timer-writer-incomplete");
    return result.value;
  });
}

export async function runInExistingCanonicalMatchWriterFixture<T>(
  room: Room,
  work: (
    instance: InviteReactions,
    state: DurableObjectState,
  ) => T | Promise<T>,
): Promise<T> {
  await activateCanonicalApplicationFixture();
  await runInAdmittedRoom(room, async (_instance, state) => {
    const admission = currentApplicationAdmission();
    if (!admission) throw new Error("fixture-admission-missing");
    await initializeApplicationObjectControl(state.storage, admission);
  });
  return runInCanonicalMatchWriterFixture(room, work);
}

export function canonicalMatchEnvironment(env: Env): Env {
  return new Proxy(env, {
    get(target, property) {
      if (property !== "INVITE_REACTIONS")
        return Reflect.get(target, property, target);
      return new Proxy(target.INVITE_REACTIONS, {
        get(namespace, member) {
          if (member === "getByName")
            return (name: string) =>
              admittedApplicationRoom(namespace.getByName(name));
          if (member === "get")
            return (...args: Parameters<typeof namespace.get>) =>
              admittedApplicationRoom(namespace.get(...args));
          const value: unknown = Reflect.get(namespace, member, namespace);
          return typeof value === "function" ? value.bind(namespace) : value;
        },
      });
    },
  });
}

export function canonicalMatchRpc(env: Env, inviteId: string) {
  const rpc = getMatchStateRpc(canonicalMatchEnvironment(env), inviteId);
  return new Proxy(rpc, {
    get(target, property) {
      const callback: unknown = Reflect.get(target, property, target);
      if (typeof callback !== "function") return callback;
      return async (...args: unknown[]) => {
        await activateCanonicalApplicationFixture();
        return Reflect.apply(callback, target, args);
      };
    },
  });
}
