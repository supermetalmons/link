import { env } from "cloudflare:workers";
import {
  applyD1Migrations,
  createExecutionContext,
  evictDurableObject,
  runInDurableObject,
  waitOnExecutionContext,
  type D1Migration,
} from "cloudflare:test";
import { afterEach, beforeAll, expect, it } from "vitest";
import { INVITE_METADATA_SOCKET_PROTOCOL } from "@mons/shared/invite-metadata";
import { INVITE_WAGERS_SOCKET_PROTOCOL } from "@mons/shared/invite-wagers";
import { createInviteSourceD1Store } from "../src/inviteSourceD1.ts";
import { handleInviteMetadataRoute } from "../src/inviteMetadataRoute.ts";
import { handleInviteWagersRoute } from "../src/inviteWagersRoute.ts";
import {
  WagerStateD1Failure,
  type WagerStateSnapshot,
} from "../src/wagerStateD1.ts";
import { applyRetiredProfileMigrations } from "./profileTestMigrations.ts";

const testEnv = env as Env & {
  TEST_D1_MIGRATIONS: D1Migration[];
  TEST_PROFILE_D1_MIGRATIONS: D1Migration[];
};
type Room = DurableObjectStub<
  import("../src/inviteReactions.ts").InviteReactions
>;
const sockets: WebSocket[] = [];
const rooms: Room[] = [];

async function readHttpResponse(
  inviteId: string,
  channel: "metadata" | "wagers",
) {
  const ctx = createExecutionContext();
  const handler =
    channel === "metadata"
      ? handleInviteMetadataRoute
      : handleInviteWagersRoute;
  const response = await handler(
    new Request(`https://api.mons.link/invites/${inviteId}/${channel}`, {
      headers: { Origin: "https://mons.link", "CF-Connecting-IP": "192.0.2.1" },
    }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

async function readHttp(inviteId: string, channel: "metadata" | "wagers") {
  const response = await readHttpResponse(inviteId, channel);
  expect(response.status).toBe(200);
  return response.json() as Promise<{
    ok: true;
    snapshot: Record<string, unknown>;
  }>;
}

async function seedInvite() {
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
  const wager = {
    proposals: { "host-login": { material: "dust", count: 2, createdAt: 1 } },
  };
  await env.PROFILE_DB.prepare(
    `INSERT INTO invite_wager_states
     (invite_id, match_id, wager_json, resolution_marker, revision, updated_at_ms)
     VALUES (?, ?, ?, 0, 1, 1)`,
  )
    .bind(inviteId, inviteId, JSON.stringify(wager))
    .run();
  const room = env.INVITE_REACTIONS.getByName(inviteId);
  rooms.push(room);
  return { inviteId, source, room, wager };
}

async function trackReads(room: Room) {
  const reads = { metadata: 0, wagers: 0, failure: null as string | null };
  await runInDurableObject(room, (instance) => {
    const target = instance as unknown as {
      inviteReader: (inviteId: string) => Promise<unknown>;
      wagerReader: (inviteId: string) => Promise<WagerStateSnapshot[]>;
    };
    const inviteReader = target.inviteReader;
    const wagerReader = target.wagerReader;
    target.inviteReader = async (inviteId) => {
      reads.metadata++;
      return inviteReader(inviteId);
    };
    target.wagerReader = async (inviteId) => {
      reads.wagers++;
      if (reads.failure) throw new WagerStateD1Failure(reads.failure);
      return wagerReader(inviteId);
    };
  });
  return reads;
}

async function storedWagers(room: Room) {
  return runInDurableObject(room, (_instance, state) =>
    state.storage.sql
      .exec<{
        revision: number;
        snapshot_json: string;
        source_fingerprint: string;
      }>(
        "SELECT revision, snapshot_json, source_fingerprint FROM invite_wagers WHERE singleton = 1",
      )
      .one(),
  );
}

async function openSocket(
  room: Room,
  inviteId: string,
  channel: "metadata" | "wagers",
  revision: number,
) {
  const name = channel === "metadata" ? "Metadata" : "Wagers";
  const response = await room.fetch(
    new Request(`https://room.internal/${channel}/socket`, {
      headers: {
        Upgrade: "websocket",
        "Sec-WebSocket-Protocol":
          channel === "metadata"
            ? INVITE_METADATA_SOCKET_PROTOCOL
            : INVITE_WAGERS_SOCKET_PROTOCOL,
        [`X-Mons-${name}-Invite`]: encodeURIComponent(inviteId),
        [`X-Mons-${name}-Role`]: "spectator",
        [`X-Mons-${name}-IP`]: "192.0.2.1",
        [`X-Mons-${name}-Revision`]: String(revision),
        [`X-Mons-${name}-Protected`]: "1",
        [`X-Mons-${name}-Authenticated`]: "0",
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
  sockets.push(socket);
  return async () =>
    JSON.parse(
      await (messages.length
        ? Promise.resolve(messages.shift()!)
        : new Promise<string>((resolve) => pending.push(resolve))),
    );
}

afterEach(async () => {
  await Promise.all(
    rooms
      .splice(0)
      .map((room) =>
        runInDurableObject(room, (_instance, state) =>
          state.storage.deleteAlarm(),
        ),
      ),
  );
  await Promise.all(
    sockets.splice(0).map(async (socket) => {
      if (socket.readyState === WebSocket.CLOSED) return;
      const closed = new Promise<void>((resolve) =>
        socket.addEventListener("close", () => resolve(), { once: true }),
      );
      socket.close(1000, "Test complete");
      await closed;
    }),
  );
});

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

it("delivers HTTP and socket metadata and wagers from canonical D1 through eviction and reconnect", async () => {
  const { inviteId, source, room, wager } = await seedInvite();
  const first = await room.readMetadata(inviteId);
  expect(first.status).toBe("ok");
  if (first.status !== "ok") throw new Error("metadata-missing");
  expect(first.passwordProtected).toBe(true);
  expect(first.snapshot).not.toHaveProperty("password");
  expect((await readHttp(inviteId, "metadata")).snapshot).toEqual(
    first.snapshot,
  );
  const read = await openSocket(
    room,
    inviteId,
    "metadata",
    first.snapshot.revision,
  );
  const initial = await read();
  expect(initial.snapshot.hostRematches).toBe("");
  const wagers = await room.readWagers(inviteId);
  if (wagers.status !== "ok") throw new Error("wagers-unavailable");
  expect(wagers.snapshot.wagers).toEqual({ [inviteId]: wager });
  expect((await readHttp(inviteId, "wagers")).snapshot).toEqual(
    wagers.snapshot,
  );
  const readWagers = await openSocket(
    room,
    inviteId,
    "wagers",
    wagers.snapshot.revision,
  );
  expect((await readWagers()).snapshot).toEqual(wagers.snapshot);
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
  const changed = await read();
  expect(changed.snapshot.hostRematches).toBe("1");
  expect(changed.snapshot.revision).toBeGreaterThan(initial.snapshot.revision);
  const nextWagers = await room.readWagers(inviteId);
  if (nextWagers.status !== "ok") throw new Error("wagers-unavailable");
  expect(nextWagers.snapshot).toEqual(wagers.snapshot);
  const changedWager = {
    proposals: { "host-login": { material: "dust", count: 5, createdAt: 1 } },
  };
  await env.PROFILE_DB.prepare(
    "UPDATE invite_wager_states SET wager_json = ?, revision = 2 WHERE invite_id = ? AND match_id = ?",
  )
    .bind(JSON.stringify(changedWager), inviteId, inviteId)
    .run();
  await room.notifyWagersChanged(inviteId);
  const changedWagers = await readWagers();
  expect(changedWagers.snapshot.wagers).toEqual({ [inviteId]: changedWager });
  expect(changedWagers.snapshot.revision).toBeGreaterThan(
    wagers.snapshot.revision,
  );
  await evictDurableObject(room);
  const recovered = await room.readMetadata(inviteId);
  expect(recovered).toMatchObject({
    status: "ok",
    snapshot: { hostRematches: "1", revision: changed.snapshot.revision },
  });
  expect((await readHttp(inviteId, "metadata")).snapshot).toEqual(
    changed.snapshot,
  );
  expect((await readHttp(inviteId, "wagers")).snapshot).toEqual(
    changedWagers.snapshot,
  );
  const reconnectedMetadata = await openSocket(
    room,
    inviteId,
    "metadata",
    changed.snapshot.revision,
  );
  const reconnectedWagers = await openSocket(
    room,
    inviteId,
    "wagers",
    changedWagers.snapshot.revision,
  );
  expect((await reconnectedMetadata()).snapshot).toEqual(changed.snapshot);
  expect((await reconnectedWagers()).snapshot).toEqual(changedWagers.snapshot);
});

it("serves and refreshes metadata-only HTTP and sockets without querying wagers", async () => {
  const { inviteId, source, room } = await seedInvite();
  const reads = await trackReads(room);
  reads.failure = "wager-state-not-activated";
  const first = await room.readMetadata(inviteId);
  if (first.status !== "ok") throw new Error("metadata-unavailable");
  expect((await readHttp(inviteId, "metadata")).snapshot).toEqual(
    first.snapshot,
  );
  const read = await openSocket(
    room,
    inviteId,
    "metadata",
    first.snapshot.revision,
  );
  expect((await read()).snapshot).toEqual(first.snapshot);
  await env.PROFILE_GAMES_DB.batch(
    source.buildCommitStatements(
      await source.preparePatch(
        { [`invites/${inviteId}/hostRematches`]: "1" },
        2,
      ),
      2,
    ),
  );
  await room.notifyMetadataChanged(inviteId);
  const changed = await read();
  expect(changed.snapshot.hostRematches).toBe("1");
  expect(changed.snapshot.revision).toBeGreaterThan(first.snapshot.revision);
  expect((await readHttp(inviteId, "metadata")).snapshot).toEqual(
    changed.snapshot,
  );
  expect(reads.metadata).toBeGreaterThan(0);
  expect(reads.wagers).toBe(0);
});

it.each(["wager-state-not-activated", "wager-state-corrupt"])(
  "keeps mixed-room metadata healthy and preserves stored wagers when wager reads fail with %s",
  async (failure) => {
    const { inviteId, source, room, wager } = await seedInvite();
    const initial = await room.readWagers(inviteId);
    if (initial.status !== "ok") throw new Error("wagers-unavailable");
    expect(initial.snapshot.wagers).toEqual({ [inviteId]: wager });
    const readWagers = await openSocket(
      room,
      inviteId,
      "wagers",
      initial.snapshot.revision,
    );
    expect((await readWagers()).snapshot).toEqual(initial.snapshot);
    const retained = await storedWagers(room);
    const reads = await trackReads(room);
    reads.failure = failure;
    expect((await readHttp(inviteId, "metadata")).snapshot).toEqual(
      initial.metadata.snapshot,
    );
    const readMetadata = await openSocket(
      room,
      inviteId,
      "metadata",
      initial.metadata.snapshot.revision,
    );
    expect((await readMetadata()).snapshot).toEqual(initial.metadata.snapshot);
    await env.PROFILE_GAMES_DB.batch(
      source.buildCommitStatements(
        await source.preparePatch(
          { [`invites/${inviteId}/hostRematches`]: "1" },
          2,
        ),
        2,
      ),
    );
    const changed = await room.readMetadata(inviteId);
    if (changed.status !== "ok") throw new Error("metadata-unavailable");
    expect((await readMetadata()).snapshot).toEqual(changed.snapshot);
    expect(changed.snapshot.hostRematches).toBe("1");
    expect(changed.snapshot.revision).toBeGreaterThan(
      initial.metadata.snapshot.revision,
    );
    expect(reads.wagers).toBe(0);
    expect(await storedWagers(room)).toEqual(retained);
    expect(await room.readWagers(inviteId)).toEqual({ status: "invalid" });
    const failedHttp = await readHttpResponse(inviteId, "wagers");
    expect(failedHttp.status).toBe(503);
    expect(await failedHttp.json()).toMatchObject({
      ok: false,
      error: "unavailable",
    });
    expect(reads.wagers).toBeGreaterThan(0);
    expect(await storedWagers(room)).toEqual(retained);
    expect((await readHttp(inviteId, "metadata")).snapshot).toEqual(
      changed.snapshot,
    );
    reads.failure = null;
    const recovered = await room.readWagers(inviteId);
    expect(recovered).toMatchObject({
      status: "ok",
      snapshot: initial.snapshot,
      metadata: changed,
    });
    expect(await storedWagers(room)).toEqual(retained);
  },
);
