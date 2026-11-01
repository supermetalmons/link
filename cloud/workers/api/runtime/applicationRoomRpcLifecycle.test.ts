import { evictDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import {
  canonicalRoomFixture,
  rawApplicationRoom,
} from "./applicationRoomFixture.ts";

it("reloads admitted room state after an object is evicted", async () => {
  const room = await canonicalRoomFixture(
    `rpc-lifetime-${crypto.randomUUID()}`,
  );
  const before = await room.getRegisteredPresentationSnapshot("match");
  expect(before).toMatchObject({ matchId: "match", players: {} });
  await evictDurableObject(rawApplicationRoom(room));
  const after = await room.getRegisteredPresentationSnapshot("match");
  expect(after).toEqual(before);
});
