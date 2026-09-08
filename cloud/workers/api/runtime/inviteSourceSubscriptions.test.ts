import { env } from "cloudflare:workers";
import {
  applyD1Migrations,
  evictDurableObject,
  type D1Migration,
} from "cloudflare:test";
import { beforeAll, expect, it } from "vitest";
import { INVITE_METADATA_SOCKET_PROTOCOL } from "@mons/shared/invite-metadata";
import { createInviteSourceD1Store } from "../src/inviteSourceD1.ts";
import { applyRetiredProfileMigrations } from "./profileTestMigrations.ts";

const testEnv = env as Env & {
  TEST_D1_MIGRATIONS: D1Migration[];
  TEST_PROFILE_D1_MIGRATIONS: D1Migration[];
};

beforeAll(async () => {
  await applyD1Migrations(env.PROFILE_GAMES_DB, testEnv.TEST_D1_MIGRATIONS);
  await applyRetiredProfileMigrations(
    env.PROFILE_DB,
    testEnv.TEST_PROFILE_D1_MIGRATIONS,
    "a".repeat(64),
  );
  await env.PROFILE_GAMES_DB.batch([
    env.PROFILE_GAMES_DB.prepare(
      "UPDATE automatch_runtime_control SET backend = 'd1', state = 'active' WHERE singleton = 1",
    ),
    env.PROFILE_GAMES_DB
      .prepare(`UPDATE invite_source_control SET backend = 'd1', state = 'active',
      epoch = 1, verified_at_ms = 1, activated_at_ms = 1 WHERE singleton = 1`),
  ]);
});

it("delivers and recovers metadata from canonical D1 through the default room source", async () => {
  const inviteId = `source-${crypto.randomUUID()}`;
  const source = createInviteSourceD1Store(env.PROFILE_GAMES_DB);
  await env.PROFILE_GAMES_DB.batch(
    source.buildCommitStatements(
      await source.preparePatch(
        {
          [`invites/${inviteId}`]: {
            hostId: "host-login",
            guestId: "guest-login",
            hostColor: "white",
            password: "private-seed",
          },
        },
        1,
      ),
      1,
    ),
  );
  const room = env.INVITE_REACTIONS.getByName(inviteId);
  const first = await room.readMetadata(inviteId);
  expect(first.status).toBe("ok");
  if (first.status !== "ok") throw new Error("metadata-missing");
  expect(first.passwordProtected).toBe(true);
  expect(first.snapshot).not.toHaveProperty("password");
  const response = await room.fetch(
    new Request("https://room.internal/metadata/socket", {
      headers: {
        Upgrade: "websocket",
        "Sec-WebSocket-Protocol": INVITE_METADATA_SOCKET_PROTOCOL,
        "X-Mons-Metadata-Invite": encodeURIComponent(inviteId),
        "X-Mons-Metadata-Role": "spectator",
        "X-Mons-Metadata-IP": "192.0.2.1",
        "X-Mons-Metadata-Revision": String(first.snapshot.revision),
        "X-Mons-Metadata-Protected": "1",
        "X-Mons-Metadata-Authenticated": "0",
      },
    }),
  );
  expect(response.status).toBe(101);
  const socket = response.webSocket!;
  const messages: string[] = [];
  const pending: ((value: string) => void)[] = [];
  socket.addEventListener("message", (event) => {
    const reader = pending.shift();
    if (reader) reader(String(event.data));
    else messages.push(String(event.data));
  });
  socket.accept();
  const read = () =>
    messages.length
      ? Promise.resolve(messages.shift()!)
      : new Promise<string>((resolve) => pending.push(resolve));
  try {
    const initial = JSON.parse(await read());
    expect(initial.snapshot.hostRematches).toBe("");
    const wagers = await room.readWagers(inviteId);
    if (wagers.status !== "ok") throw new Error("wagers-unavailable");
    await env.PROFILE_GAMES_DB.batch(
      source.buildCommitStatements(
        await source.preparePatch(
          {
            [`invites/${inviteId}/hostRematches`]: "1",
          },
          2,
        ),
        2,
      ),
    );
    await room.notifyMetadataChanged(inviteId);
    const changed = JSON.parse(await read());
    expect(changed.snapshot.hostRematches).toBe("1");
    expect(changed.snapshot.revision).toBeGreaterThan(
      initial.snapshot.revision,
    );
    const nextWagers = await room.readWagers(inviteId);
    if (nextWagers.status !== "ok") throw new Error("wagers-unavailable");
    expect(nextWagers.snapshot).toEqual(wagers.snapshot);
    await evictDurableObject(room);
    const recovered = await room.readMetadata(inviteId);
    expect(recovered).toMatchObject({
      status: "ok",
      snapshot: { hostRematches: "1", revision: changed.snapshot.revision },
    });
  } finally {
    if (socket.readyState !== WebSocket.CLOSED) {
      const closed = new Promise<void>((resolve) =>
        socket.addEventListener("close", () => resolve(), { once: true }),
      );
      socket.close(1000, "Test complete");
      await closed;
    }
  }
});
