import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InviteChannelsRoom } from "../src/inviteChannelsRoom.ts";
import { matchPresentationSeedDigest } from "../src/matchPresentationRegistry.ts";

const invite = {
  hostId: "host-login",
  hostColor: "white",
  guestId: "guest-login",
};

function channels(instance: unknown): InviteChannelsRoom {
  return (instance as { inviteChannels: InviteChannelsRoom }).inviteChannels;
}

function fixture(named = true) {
  const inviteId = `identity-${crypto.randomUUID()}`;
  const room = named
    ? env.INVITE_REACTIONS.getByName(inviteId)
    : env.INVITE_REACTIONS.get(env.INVITE_REACTIONS.newUniqueId());
  return { inviteId, room };
}

afterEach(() => vi.restoreAllMocks());

describe("durable invite identity cache", () => {
  it("reuses a validated pin without SQL and still validates every target", async () => {
    const { room, inviteId } = fixture();
    await runInDurableObject(room, (instance, state) => {
      const target = channels(instance);
      target.pinInvite(inviteId);
      const exec = vi.spyOn(state.storage.sql, "exec");
      try {
        target.pinInvite(inviteId);
        target.pinInvite(inviteId);
        for (const invalid of ["", ` ${inviteId}`, `${inviteId}/invalid`])
          expect(() => target.pinInvite(invalid)).toThrow(
            "invalid-metadata-invite",
          );
        expect(() => target.pinInvite(`${inviteId}-other`)).toThrow(
          "invalid-metadata-invite",
        );
        expect(exec).not.toHaveBeenCalled();
      } finally {
        exec.mockRestore();
      }
    });
  });

  it("rejects a different identity in unnamed objects before and after eviction", async () => {
    const { room, inviteId } = fixture(false);
    const otherId = `${inviteId}-other`;
    await runInDurableObject(room, (instance) => {
      const target = channels(instance);
      target.pinInvite(inviteId);
      expect(() => target.pinInvite(otherId)).toThrow(
        "metadata-invite-conflict",
      );
    });
    await evictDurableObject(room);
    await runInDurableObject(room, (instance, state) => {
      const target = channels(instance);
      expect(() => target.pinInvite(otherId)).toThrow(
        "metadata-invite-conflict",
      );
      target.pinInvite(inviteId);
      expect(
        state.storage.sql
          .exec("SELECT invite_id FROM invite_metadata WHERE singleton = 1")
          .one(),
      ).toEqual({ invite_id: inviteId });
      const exec = vi.spyOn(state.storage.sql, "exec");
      try {
        target.pinInvite(inviteId);
        expect(exec).not.toHaveBeenCalled();
      } finally {
        exec.mockRestore();
      }
    });
  });

  it("retries initialization if the wagers row could not be created", async () => {
    const { room, inviteId } = fixture();
    await runInDurableObject(room, (instance, state) => {
      const target = channels(instance);
      state.storage.sql.exec(
        "CREATE TRIGGER fail_invite_wagers BEFORE INSERT ON invite_wagers BEGIN SELECT RAISE(ABORT, 'test-initialization-failed'); END",
      );
      expect(() => target.pinInvite(inviteId)).toThrow(
        "test-initialization-failed",
      );
      state.storage.sql.exec("DROP TRIGGER fail_invite_wagers");
      target.pinInvite(inviteId);
      expect(
        state.storage.sql
          .exec("SELECT invite_id FROM invite_wagers WHERE singleton = 1")
          .one(),
      ).toEqual({ invite_id: inviteId });
    });
  });

  it("keeps cached metadata reads free of initialization SQL while reading current revisions on refresh", async () => {
    const { room, inviteId } = fixture();
    await runInDurableObject(room, async (instance, state) => {
      let value = { ...invite, hostRematches: "" };
      const mutable = instance as unknown as {
        inviteReader: () => Promise<unknown>;
      };
      mutable.inviteReader = async () => value;
      const target = channels(instance);
      expect(await target.readMetadata(inviteId)).toMatchObject({
        status: "ok",
        snapshot: { revision: 1, hostRematches: "" },
      });
      const exec = vi.spyOn(state.storage.sql, "exec");
      try {
        expect(await target.readMetadata(inviteId, true)).toMatchObject({
          status: "ok",
          snapshot: { revision: 1 },
        });
        expect(exec).not.toHaveBeenCalled();
      } finally {
        exec.mockRestore();
      }
      for (const [hostRematches, revision] of [
        ["1", 2],
        ["1", 2],
        ["1;2", 3],
      ] as const) {
        value = { ...invite, hostRematches };
        expect(await target.readMetadata(inviteId)).toMatchObject({
          status: "ok",
          snapshot: { revision, hostRematches },
        });
      }
    });
  });

  it("does not cache identity initialization rolled back with a presentation seed conflict", async () => {
    const { room, inviteId } = fixture();
    const creation = {
      inviteId,
      matchId: inviteId,
      actorUid: "host-login",
      emojiId: 1,
      aura: "",
      provenance: "creation" as const,
      sourceId: `creation:${inviteId}`,
    };
    const changed = { ...creation, emojiId: 2 };
    const seeds = await Promise.all(
      [creation, changed].map(async (seed) => ({
        ...seed,
        seedDigest: await matchPresentationSeedDigest(seed),
      })),
    );
    await runInDurableObject(room, async (instance, state) => {
      await expect(
        instance.registerPresentationSeeds(inviteId, seeds),
      ).rejects.toThrow("match-presentation-seed-conflict");
      expect(
        state.storage.sql.exec("SELECT * FROM invite_metadata").toArray(),
      ).toEqual([]);
      expect(
        state.storage.sql.exec("SELECT * FROM invite_wagers").toArray(),
      ).toEqual([]);
      const mutable = instance as unknown as {
        inviteReader: () => Promise<unknown>;
      };
      mutable.inviteReader = async () => invite;
      expect(await instance.readMetadata(inviteId)).toMatchObject({
        status: "ok",
        snapshot: { revision: 1 },
      });
      expect(
        await instance.registerPresentationSeeds(inviteId, [seeds[0]]),
      ).toHaveLength(1);
    });
  });
});
