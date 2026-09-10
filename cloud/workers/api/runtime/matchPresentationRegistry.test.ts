import { env } from "cloudflare:workers";
import {
  applyD1Migrations,
  evictDurableObject,
  runInDurableObject,
  type D1Migration,
} from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  REACTION_SOCKET_PROTOCOL_V2,
  isInviteRoomMessage,
} from "@mons/shared/reactions";
import type { UpdateMatchPresentationRequest } from "@mons/shared/match-presentation";
import {
  buildMatchPresentationRegistrationStatements,
  freezeRegisteredMatchPresentations,
  listMatchPresentationRegistrations,
  matchPresentationSeedDigest,
  prepareCreatedMatchPresentations,
  readMatchPresentationControl,
  readRegisteredMatchPresentations,
  type MatchPresentationCreation,
  type MatchPresentationRegistration,
  type MatchPresentationSeedRegistration,
} from "../src/matchPresentationRegistry.ts";
import { resetMatchPresentationTestState } from "./matchPresentationTestFixture.ts";

const testEnv = env as Env & { TEST_D1_MIGRATIONS: D1Migration[] };
const db = env.PROFILE_GAMES_DB;
const hostUid = "registry-host";
const guestUid = "registry-guest";
const sockets: WebSocket[] = [];
const noFirebaseEnv = new Proxy(env, {
  get(target, property, receiver) {
    if (
      typeof property === "string" &&
      (property.includes("FIREBASE") || property.includes("SERVICE_ACCOUNT"))
    ) {
      throw new Error("unexpected-firebase-configuration");
    }
    return Reflect.get(target, property, receiver);
  },
});

function creation(
  inviteId: string,
  actorUid = hostUid,
  matchId = inviteId,
  emojiId = 1,
): MatchPresentationCreation {
  return {
    inviteId,
    matchId,
    actorUid,
    emojiId,
    aura: "",
    sourceId: `creation:${actorUid}:${matchId}`,
  };
}

function fixture() {
  const inviteId = `registry-${crypto.randomUUID()}`;
  return {
    inviteId,
    matchId: inviteId,
    room: env.INVITE_REACTIONS.getByName(inviteId),
  };
}

async function withLocalRoom(
  room: ReturnType<typeof fixture>["room"],
  run: (localEnv: Env) => Promise<void>,
): Promise<void> {
  await runInDurableObject(room, async (instance) => {
    const localEnv = new Proxy(noFirebaseEnv, {
      get(target, property, receiver) {
        return property === "INVITE_REACTIONS"
          ? { getByName: () => instance }
          : Reflect.get(target, property, receiver);
      },
    });
    await run(localEnv);
  });
}

async function seedRow(
  input: MatchPresentationCreation,
  provenance: MatchPresentationRegistration["provenance"] = "creation",
): Promise<MatchPresentationSeedRegistration> {
  return {
    ...input,
    provenance,
    seedDigest: await matchPresentationSeedDigest(input),
  };
}

async function commit(
  rows: readonly MatchPresentationRegistration[],
): Promise<void> {
  await db.batch(buildMatchPresentationRegistrationStatements(db, rows, 100));
}

function update(
  overrides: Partial<UpdateMatchPresentationRequest> = {},
): UpdateMatchPresentationRequest {
  return {
    operationId: crypto.randomUUID(),
    expectedRevision: 0,
    emojiId: 1000,
    aura: "rainbow",
    ...overrides,
  };
}

async function activateDurable(): Promise<void> {
  await db
    .prepare(
      `UPDATE match_presentation_control
     SET phase = 'durable', source_digest = ?, source_count = 0,
         verification_digest = ?, verified_at_ms = 2, activated_at_ms = 3
     WHERE singleton = 1`,
    )
    .bind("a".repeat(64), "b".repeat(64))
    .run();
}

function acceptSocket(response: Response) {
  expect(response.status).toBe(101);
  const socket = response.webSocket!;
  const messages: string[] = [];
  const readers: ((value: string) => void)[] = [];
  socket.addEventListener("message", (event) => {
    const value = String(event.data);
    const reader = readers.shift();
    if (reader) reader(value);
    else messages.push(value);
  });
  socket.accept();
  sockets.push(socket);
  return {
    read: () =>
      messages.length
        ? Promise.resolve(messages.shift()!)
        : new Promise<string>((resolve) => readers.push(resolve)),
  };
}

beforeAll(async () => {
  await applyD1Migrations(db, testEnv.TEST_D1_MIGRATIONS);
});

beforeEach(async () => {
  await resetMatchPresentationTestState(db, testEnv.TEST_D1_MIGRATIONS, true);
});

afterEach(async () => {
  await Promise.all(
    sockets.splice(0).map(async (socket) => {
      if (socket.readyState === WebSocket.CLOSED) return;
      await new Promise<void>((resolve) => {
        const onClose = () => resolve();
        socket.addEventListener("close", onClose, { once: true });
        socket.close(1000, "Test complete");
        if (socket.readyState === WebSocket.CLOSED) {
          socket.removeEventListener("close", onClose);
          resolve();
        }
      });
    }),
  );
});

describe("match presentation registration", () => {
  it("imports immutable seed proof without overwriting live operations or frozen appearance", async () => {
    const { inviteId, matchId, room } = fixture();
    const source = creation(inviteId);
    await room.ensurePresentations(matchId, {
      [hostUid]: { emojiId: source.emojiId, aura: source.aura },
    });
    const operation = update();
    const edited = await room.updatePresentation(hostUid, matchId, operation);
    const frozen = await room.freezePresentations(matchId, {
      [hostUid]: { emojiId: 1, aura: "" },
    });
    const nextOperation = update({
      expectedRevision: 1,
      emojiId: 1001,
      aura: "",
    });
    const current = await room.updatePresentation(
      hostUid,
      matchId,
      nextOperation,
    );
    const seed = await seedRow(
      { ...source, sourceId: "baseline:verified-page:1" },
      "backfill",
    );
    const registrations = await room.registerPresentationSeeds(inviteId, [
      seed,
    ]);
    await commit(registrations);

    expect(edited.presentation.revision).toBe(1);
    expect(current.presentation.revision).toBe(2);
    expect(
      await readRegisteredMatchPresentations(noFirebaseEnv, inviteId, matchId),
    ).toEqual({ matchId, players: { [hostUid]: current.presentation } });
    expect(await room.getFrozenPresentationSnapshot(matchId)).toEqual(frozen);
    expect(
      await room.updatePresentation(hostUid, matchId, nextOperation),
    ).toEqual({ ...current, status: "duplicate" });
    expect(
      await room.updatePresentation(hostUid, matchId, {
        ...nextOperation,
        aura: "rainbow",
      }),
    ).toMatchObject({ status: "conflict", presentation: current.presentation });
    expect(await room.getRegisteredPresentationSnapshot(matchId)).toMatchObject(
      { seedDigests: { [hostUid]: seed.seedDigest } },
    );
    expect(
      await listMatchPresentationRegistrations(db, inviteId, matchId),
    ).toEqual(registrations);
  });

  it("concurrent seed replay retains first provenance and survives eviction without resetting revision", async () => {
    const { inviteId, matchId, room } = fixture();
    const seed = await seedRow(creation(inviteId), "backfill");
    const first = await room.registerPresentationSeeds(inviteId, [seed]);
    const operation = update();
    const current = await room.updatePresentation(hostUid, matchId, operation);
    const replay = {
      ...seed,
      provenance: "creation" as const,
      sourceId: "new-capture-reference",
    };
    const copies = await Promise.all(
      Array.from({ length: 4 }, () =>
        room.registerPresentationSeeds(inviteId, [replay]),
      ),
    );
    for (const rows of copies) expect(rows).toEqual(first);
    await Promise.all(copies.map(commit));
    await evictDurableObject(room);

    expect(
      await readRegisteredMatchPresentations(noFirebaseEnv, inviteId, matchId),
    ).toEqual({ matchId, players: { [hostUid]: current.presentation } });
    expect(await room.updatePresentation(hostUid, matchId, operation)).toEqual({
      ...current,
      status: "duplicate",
    });
    expect(
      await listMatchPresentationRegistrations(db, inviteId, matchId),
    ).toEqual(first);
  });

  it("validates an entire seed batch before writing and rejects conflicting immutable seed digests", async () => {
    const { inviteId, matchId, room } = fixture();
    const host = await seedRow(creation(inviteId));
    const guest = await seedRow(creation(inviteId, guestUid, matchId, 2));
    await runInDurableObject(room, async (instance) => {
      await expect(
        instance.registerPresentationSeeds(inviteId, [
          host,
          { ...guest, seedDigest: "c".repeat(64) },
        ]),
      ).rejects.toThrow("invalid-presentation-seed-digest");
    });
    expect(await room.getPresentationSnapshot(matchId)).toEqual({
      matchId,
      players: {},
    });

    const first = await room.registerPresentationSeeds(inviteId, [host]);
    await commit(first);
    const changed = await seedRow({ ...creation(inviteId), emojiId: 3 });
    await runInDurableObject(room, async (instance) => {
      await expect(
        instance.registerPresentationSeeds(inviteId, [guest, changed]),
      ).rejects.toThrow("match-presentation-seed-conflict");
    });
    expect(
      Object.keys((await room.getPresentationSnapshot(matchId)).players),
    ).toEqual([hostUid]);
    await expect(
      commit([{ ...first[0], seedDigest: changed.seedDigest }]),
    ).rejects.toThrow();
    expect(
      await listMatchPresentationRegistrations(db, inviteId, matchId),
    ).toEqual(first);
    expect(
      (await readRegisteredMatchPresentations(noFirebaseEnv, inviteId, matchId))
        .players[hostUid].emojiId,
    ).toBe(1);
  });

  it("keeps seed preparation invisible until the actor registration commits", async () => {
    const { inviteId, matchId, room } = fixture();
    const rows = await prepareCreatedMatchPresentations(noFirebaseEnv, [
      creation(inviteId),
      creation(inviteId, guestUid, matchId, 2),
    ]);
    expect(
      Object.keys((await room.getPresentationSnapshot(matchId)).players),
    ).toHaveLength(2);
    expect(
      await readRegisteredMatchPresentations(noFirebaseEnv, inviteId, matchId),
    ).toEqual({ matchId, players: {} });

    await commit(rows.filter((row) => row.actorUid === hostUid));
    expect(
      Object.keys(
        (
          await readRegisteredMatchPresentations(
            noFirebaseEnv,
            inviteId,
            matchId,
          )
        ).players,
      ),
    ).toEqual([hostUid]);
    await commit(rows.filter((row) => row.actorUid === guestUid));
    expect(
      Object.keys(
        (
          await readRegisteredMatchPresentations(
            noFirebaseEnv,
            inviteId,
            matchId,
          )
        ).players,
      ).sort(),
    ).toEqual([guestUid, hostUid].sort());
  });

  it("ignores orphan legacy rows and preserves a partial pending rematch", async () => {
    const { inviteId, room } = fixture();
    const matchId = `${inviteId}1`;
    await room.ensurePresentations(matchId, {
      [guestUid]: { emojiId: 2, aura: "" },
    });
    const rows = await prepareCreatedMatchPresentations(noFirebaseEnv, [
      creation(inviteId, hostUid, matchId),
    ]);
    await commit(rows);
    await activateDurable();

    const result = await readRegisteredMatchPresentations(
      noFirebaseEnv,
      inviteId,
      matchId,
    );
    expect(Object.keys(result.players)).toEqual([hostUid]);
    expect(result.players[hostUid]).toMatchObject({
      matchId,
      actorUid: hostUid,
      emojiId: 1,
      revision: 0,
    });
    expect(
      Object.keys((await room.getPresentationSnapshot(matchId)).players),
    ).toHaveLength(2);
  });

  it("rejects a registered actor without current appearance or immutable DO proof without fallback", async () => {
    for (const table of ["match_presentations", "match_presentation_seeds"]) {
      const { inviteId, matchId, room } = fixture();
      const rows = await prepareCreatedMatchPresentations(noFirebaseEnv, [
        creation(inviteId),
      ]);
      await commit(rows);
      await room.updatePresentation(hostUid, matchId, update());
      await runInDurableObject(room, (_instance, state) => {
        state.storage.sql.exec(
          `DELETE FROM ${table} WHERE match_id = ? AND actor_uid = ?`,
          matchId,
          hostUid,
        );
      });

      await withLocalRoom(room, async (localEnv) => {
        await expect(
          readRegisteredMatchPresentations(localEnv, inviteId, matchId),
        ).rejects.toThrow("match-presentation-unavailable");
        await expect(
          freezeRegisteredMatchPresentations(localEnv, inviteId, matchId, [
            hostUid,
          ]),
        ).rejects.toThrow("match-presentation-unavailable");
      });
      expect(
        (await room.getFrozenPresentationSnapshot(matchId)).players,
      ).toEqual({});
    }
  });

  it("does not recreate missing current state when immutable seed evidence is replayed", async () => {
    const { inviteId, matchId, room } = fixture();
    const seed = await seedRow(creation(inviteId));
    await room.registerPresentationSeeds(inviteId, [seed]);
    await room.updatePresentation(hostUid, matchId, update());
    await runInDurableObject(room, (_instance, state) => {
      state.storage.sql.exec(
        "DELETE FROM match_presentations WHERE match_id = ?",
        matchId,
      );
    });

    await runInDurableObject(room, async (instance) => {
      await expect(
        instance.registerPresentationSeeds(inviteId, [seed]),
      ).rejects.toThrow("match-presentation-unavailable");
      await expect(
        instance.ensurePresentations(matchId, {
          [hostUid]: { emojiId: seed.emojiId, aura: seed.aura },
        }),
      ).rejects.toThrow("match-presentation-unavailable");
      await expect(
        instance.freezePresentations(matchId, {
          [hostUid]: { emojiId: seed.emojiId, aura: seed.aura },
        }),
      ).rejects.toThrow("match-presentation-unavailable");
    });
    expect((await room.getPresentationSnapshot(matchId)).players).toEqual({});
  });

  it("rejects mismatched D1 and DO seed evidence", async () => {
    const { inviteId, matchId } = fixture();
    const rows = await prepareCreatedMatchPresentations(noFirebaseEnv, [
      creation(inviteId),
    ]);
    const differentDigest = await matchPresentationSeedDigest({
      ...creation(inviteId),
      emojiId: 9,
    });
    await commit([{ ...rows[0], seedDigest: differentDigest }]);
    await expect(
      readRegisteredMatchPresentations(noFirebaseEnv, inviteId, matchId),
    ).rejects.toThrow("match-presentation-unavailable");
    await expect(
      freezeRegisteredMatchPresentations(noFirebaseEnv, inviteId, matchId, [
        hostUid,
      ]),
    ).rejects.toThrow("match-presentation-unavailable");
  });

  it("canonical sockets hide prepared orphan actors and receive later committed guest updates", async () => {
    const { inviteId, matchId, room } = fixture();
    const rows = await prepareCreatedMatchPresentations(noFirebaseEnv, [
      creation(inviteId),
      creation(inviteId, guestUid, matchId, 2),
    ]);
    await commit(rows.filter((row) => row.actorUid === hostUid));
    await activateDurable();
    const current = await readRegisteredMatchPresentations(
      noFirebaseEnv,
      inviteId,
      matchId,
    );
    const client = acceptSocket(
      await room.fetch("https://reactions.internal/socket", {
        headers: {
          Upgrade: "websocket",
          "X-Mons-Reaction-IP": "192.0.2.9",
          "Sec-WebSocket-Protocol": REACTION_SOCKET_PROTOCOL_V2,
          "X-Mons-Presentation-Match": encodeURIComponent(matchId),
          "X-Mons-Presentation-Canonical": "1",
          "X-Mons-Presentation-Actors": encodeURIComponent(
            JSON.stringify(Object.keys(current.players)),
          ),
        },
      }),
    );
    const initial = JSON.parse(await client.read()) as unknown;
    expect(isInviteRoomMessage(initial)).toBe(true);
    expect(initial).toMatchObject({
      schemaVersion: 2,
      type: "snapshot",
      presentation: current,
    });
    expect(
      Object.keys(
        (initial as { presentation: { players: Record<string, unknown> } })
          .presentation.players,
      ),
    ).toEqual([hostUid]);

    await commit(rows.filter((row) => row.actorUid === guestUid));
    const changed = await room.updatePresentation(
      guestUid,
      matchId,
      update({ emojiId: 8, aura: "" }),
    );
    expect(JSON.parse(await client.read())).toEqual({
      schemaVersion: 2,
      type: "presentation",
      presentation: changed.presentation,
    });
  });

  it("reuses frozen history without live registration or current appearance", async () => {
    const { inviteId, matchId, room } = fixture();
    const frozen = await room.freezePresentations(matchId, {
      [hostUid]: { emojiId: 7, aura: "rainbow" },
    });
    await runInDurableObject(room, (_instance, state) => {
      state.storage.sql.exec(
        "DELETE FROM match_presentations WHERE match_id = ?",
        matchId,
      );
    });
    await activateDurable();

    expect(
      await freezeRegisteredMatchPresentations(
        noFirebaseEnv,
        inviteId,
        matchId,
        [hostUid],
      ),
    ).toEqual(frozen);
    expect(
      await readRegisteredMatchPresentations(noFirebaseEnv, inviteId, matchId),
    ).toEqual({ matchId, players: {} });
    expect((await room.getPresentationSnapshot(matchId)).players).toEqual({});
  });

  it("freezes newly archived actors only after matching registration while preserving earlier freezes", async () => {
    const { inviteId, matchId, room } = fixture();
    const hostFrozen = await room.freezePresentations(matchId, {
      [hostUid]: { emojiId: 7, aura: "rainbow" },
    });
    const guestRows = await prepareCreatedMatchPresentations(noFirebaseEnv, [
      creation(inviteId, guestUid, matchId, 2),
    ]);
    await activateDurable();
    await expect(
      freezeRegisteredMatchPresentations(noFirebaseEnv, inviteId, matchId, [
        hostUid,
        guestUid,
      ]),
    ).rejects.toThrow("historical-match-presentation-unavailable");
    expect(await room.getFrozenPresentationSnapshot(matchId)).toEqual(
      hostFrozen,
    );

    await commit(guestRows);
    const firstGuest = await room.updatePresentation(
      guestUid,
      matchId,
      update({ emojiId: 8, aura: "" }),
    );
    const frozen = await freezeRegisteredMatchPresentations(
      noFirebaseEnv,
      inviteId,
      matchId,
      [hostUid, guestUid],
    );
    expect(frozen.players[hostUid]).toEqual(hostFrozen.players[hostUid]);
    expect(frozen.players[guestUid]).toEqual(firstGuest.presentation);
    await room.updatePresentation(
      guestUid,
      matchId,
      update({ expectedRevision: 1, emojiId: 9, aura: "" }),
    );
    expect(
      await freezeRegisteredMatchPresentations(
        noFirebaseEnv,
        inviteId,
        matchId,
        [hostUid, guestUid],
      ),
    ).toEqual(frozen);
  });

  it("keeps registration and activated authority proofs immutable", async () => {
    const { inviteId, matchId } = fixture();
    const rows = await prepareCreatedMatchPresentations(noFirebaseEnv, [
      creation(inviteId),
    ]);
    await commit(rows);
    await activateDurable();
    const activated = await readMatchPresentationControl(db);
    expect(activated).toMatchObject({
      phase: "durable",
      captureStartedAtMs: 1,
      sourceDigest: "a".repeat(64),
      verificationDigest: "b".repeat(64),
      activatedAtMs: 3,
    });

    for (const [column, value] of [
      ["phase", "capture"],
      ["candidate_version_id", "changed"],
      ["migration_id", "changed"],
      ["capture_started_at_ms", 99],
      ["source_digest", "c".repeat(64)],
      ["source_count", 1],
      ["verification_digest", "d".repeat(64)],
      ["verified_at_ms", 99],
      ["activated_at_ms", 99],
    ] as const) {
      await expect(
        db
          .prepare(
            `UPDATE match_presentation_control SET ${column} = ? WHERE singleton = 1`,
          )
          .bind(value)
          .run(),
      ).rejects.toThrow("match-presentation-authority-conflict");
    }
    await expect(
      db
        .prepare(
          "UPDATE match_presentation_registrations SET source_id = 'changed' WHERE invite_id = ?",
        )
        .bind(inviteId)
        .run(),
    ).rejects.toThrow("match-presentation-registration-immutable");
    await expect(
      db
        .prepare(
          "DELETE FROM match_presentation_registrations WHERE invite_id = ?",
        )
        .bind(inviteId)
        .run(),
    ).rejects.toThrow("match-presentation-registration-immutable");
    expect(
      await listMatchPresentationRegistrations(db, inviteId, matchId),
    ).toEqual(rows);
    expect(await readMatchPresentationControl(db)).toEqual(activated);
  });
});
