import { admittedApplicationRoom } from "./applicationRoomFixture.ts";

export function eventApplicationEnvironment(env: Env): Env {
  return new Proxy(env, {
    get(target, property) {
      if (property !== "INVITE_REACTIONS")
        return Reflect.get(target, property, target);
      return new Proxy(target.INVITE_REACTIONS, {
        get(namespace, member) {
          if (member !== "getByName")
            return Reflect.get(namespace, member, namespace);
          return (name: string) =>
            admittedApplicationRoom(namespace.getByName(name));
        },
      });
    },
  });
}

export async function activateEventApplicationFixture(
  db: D1Database,
): Promise<void> {
  await db
    .prepare(
      "UPDATE application_data_control SET data_epoch = 1, phase = 'active', migration_id = NULL WHERE singleton = 1",
    )
    .run();
}
