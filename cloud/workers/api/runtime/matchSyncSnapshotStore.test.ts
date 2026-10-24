import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createMatchSyncSnapshotStore } from "../src/matchSyncSnapshotStore.ts";

type MatchSyncSnapshotStore = ReturnType<typeof createMatchSyncSnapshotStore>;

function fixture(work: (store: MatchSyncSnapshotStore) => void) {
  const room = env.INVITE_REACTIONS.getByName(
    `match-sync-storage-${crypto.randomUUID()}`,
  );
  return runInDurableObject(room, (_instance, state) => {
    work(createMatchSyncSnapshotStore(state.storage.sql));
  });
}

describe("match sync snapshot storage", () => {
  it("preserves snapshot bytes and existing deadlines when replacing revisions", async () => {
    await fixture((store) => {
      const matchId = "match-'😀";
      const first = '{ "unknown": null, "revision": 0 }';
      const next = '{ "revision": 7, "unknown": { "retained": true } }';
      expect(store.read(matchId)).toBeUndefined();
      store.write(matchId, first, 0);
      expect(store.read(matchId)).toEqual({
        match_id: matchId,
        snapshot_json: first,
        revision: 0,
        next_at_ms: null,
      });
      store.setDeadline(matchId, 100);
      store.write(matchId, next, 7);
      expect(store.read(matchId)).toEqual({
        match_id: matchId,
        snapshot_json: next,
        revision: 7,
        next_at_ms: 100,
      });
      store.clearDeadline(matchId);
      expect(store.read(matchId)).toEqual({
        match_id: matchId,
        snapshot_json: next,
        revision: 7,
        next_at_ms: null,
      });
    });
  });

  it("preserves earlier deadlines only when requested, including null schedules", async () => {
    await fixture((store) => {
      store.write("match", "{}", 1);
      store.setDeadline("match", 200, true);
      expect(store.nextDeadline()).toBe(200);
      store.setDeadline("match", 300, true);
      expect(store.nextDeadline()).toBe(200);
      store.setDeadline("match", 100, true);
      expect(store.nextDeadline()).toBe(100);
      store.setDeadline("match", 400);
      expect(store.nextDeadline()).toBe(400);
      store.setDeadline("match", 500, false);
      expect(store.nextDeadline()).toBe(500);
      store.clearDeadline("match");
      store.setDeadline("match", 600, true);
      expect(store.nextDeadline()).toBe(600);
    });
  });

  it("does not create absent matches or change another match's schedule", async () => {
    await fixture((store) => {
      store.setDeadline("absent", 100);
      store.setDeadline("absent", 50, true);
      store.clearDeadline("absent");
      expect(store.read("absent")).toBeUndefined();
      expect(store.listDue(100)).toEqual([]);
      expect(store.nextDeadline()).toBeNull();
      store.write("first", '{"first":true}', 2);
      store.write("second", '{"second":true}', 3);
      store.setDeadline("first", 100);
      store.setDeadline("second", 200);
      store.clearDeadline("first");
      expect(store.read("second")).toEqual({
        match_id: "second",
        snapshot_json: '{"second":true}',
        revision: 3,
        next_at_ms: 200,
      });
      expect(store.nextDeadline()).toBe(200);
    });
  });

  it("lists due deadlines inclusively in time order and excludes unscheduled matches", async () => {
    await fixture((store) => {
      expect(store.nextDeadline()).toBeNull();
      expect(store.listDue(100)).toEqual([]);
      for (const matchId of ["future", "tie-b", "early", "tie-a", "idle"])
        store.write(matchId, "{}", 1);
      store.setDeadline("future", 30);
      store.setDeadline("tie-b", 20);
      store.setDeadline("early", 10);
      store.setDeadline("tie-a", 20);
      expect(store.listDue(9)).toEqual([]);
      expect(store.listDue(10)).toEqual([{ match_id: "early" }]);
      const due = store.listDue(20);
      expect(due[0]).toEqual({ match_id: "early" });
      expect(new Set(due.slice(1).map(({ match_id }) => match_id))).toEqual(
        new Set(["tie-a", "tie-b"]),
      );
      expect(store.listDue(30).at(-1)).toEqual({ match_id: "future" });
      expect(store.nextDeadline()).toBe(10);
      store.clearDeadline("early");
      expect(store.nextDeadline()).toBe(20);
      for (const matchId of ["tie-a", "tie-b", "future"])
        store.clearDeadline(matchId);
      expect(store.listDue(100)).toEqual([]);
      expect(store.nextDeadline()).toBeNull();
    });
  });
});
