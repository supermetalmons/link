import { env, runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import { formatMatchTimer } from "@mons/shared/timers";
import { ensureInviteRoomSchema } from "../src/inviteRoomSchema.ts";
import { initializeApplicationObjectControl } from "../src/applicationObjectStorage.ts";
import { MatchWriterStore } from "../src/matchWriterStore.ts";
import { MatchStateStore } from "../src/matchStateStore.ts";
import { matchDocumentFixture } from "../test/matchRecordFixture.ts";

const now = 2_000_000_000_000;
const retiredDeadline = 1_900_000_000_000;

async function fixture(
  work: (value: {
    store: MatchStateStore;
    storage: DurableObjectStorage;
    input: {
      inviteId: string;
      matchId: string;
      playerId: string;
      opponentId: string;
      epoch: number;
    };
  }) => Promise<void>,
  timer = { state: "idle" } as import("@mons/shared/timers").MatchTimer,
) {
  const inviteId = `timer-guard-${crypto.randomUUID()}`;
  await runInDurableObject(
    env.INVITE_REACTIONS.getByName(inviteId),
    async (_instance, ctx) => {
      await initializeApplicationObjectControl(ctx.storage, {
        kind: "business",
        generation: 3,
        dataEpoch: 1,
        operationId: "fixture",
      });
      ensureInviteRoomSchema(ctx.storage, { fresh: true });
      const writer = new MatchWriterStore(ctx.storage);
      writer.initializeFreshLocalLayout();
      const storage = writer.guardStorage();
      const input = {
        inviteId,
        matchId: inviteId,
        playerId: "host-login",
        opponentId: "guest-login",
        epoch: 1,
      };
      const store = new MatchStateStore(storage, {
        now: () => now,
        assertTimerWriter: () => writer.assertWriter(),
        retiredTimer: (identity) => identity.deadlineAtMs === retiredDeadline,
        resolveGame: () => ({
          activeColor: "black",
          turnNumber: 7,
          historyValid: true,
          winner: undefined,
        }),
      });
      await writer.runWriter(
        { kind: "start-timer", request: input },
        async () => {
          store.createRecords({
            ...input,
            records: [input.playerId, input.opponentId].map(
              (playerId, index) => ({
                matchId: input.matchId,
                playerId,
                marker: `${playerId}-created`,
                value: matchDocumentFixture({
                  color: index === 0 ? "white" : "black",
                  timer: index === 0 ? timer : { state: "idle" },
                }),
              }),
            ),
          });
          await work({ store, storage, input });
        },
      );
    },
  );
}

function snapshot(storage: DurableObjectStorage) {
  return Object.fromEntries(
    ["records", "revisions", "claims", "effects", "timer_starts"].map(
      (name) => [
        name,
        storage.sql
          .exec(`SELECT * FROM match_state_${name}_canonical`)
          .toArray(),
      ],
    ),
  );
}

it("rejects a retired visible timer without creating or rewriting local markers", async () => {
  await fixture(
    async ({ store, storage, input }) => {
      const before = snapshot(storage);
      await expect(store.startTimer(input)).rejects.toThrow(
        "match-timer-retired",
      );
      expect(snapshot(storage)).toEqual(before);
    },
    formatMatchTimer(7, retiredDeadline),
  );
});

it("preserves a retired local marker and idle match instead of recreating its deadline", async () => {
  await fixture(async ({ store, storage, input }) => {
    storage.sql.exec(
      "INSERT INTO match_state_timer_starts_canonical(match_id,player_id,opponent_id,deadline_at_ms,turn_number,updated_at_ms) VALUES (?, ?, ?, ?, 7, ?)",
      input.matchId,
      input.playerId,
      input.opponentId,
      retiredDeadline,
      retiredDeadline - 90_500,
    );
    const before = snapshot(storage);
    await expect(store.startTimer(input)).rejects.toThrow(
      "match-timer-retired",
    );
    expect(snapshot(storage)).toEqual(before);
  });
});

it("rejects a victory claim for a retired timer without producing an effect", async () => {
  await fixture(
    async ({ store, storage, input }) => {
      const before = snapshot(storage);
      await expect(store.claimTimer(input)).rejects.toThrow(
        "match-timer-retired",
      );
      expect(snapshot(storage)).toEqual(before);
      expect(await storage.getAlarm()).toBeNull();
    },
    formatMatchTimer(7, retiredDeadline),
  );
});

it("leaves retained markers untouched when the match is already terminal", async () => {
  await fixture(
    async ({ store, storage, input }) => {
      storage.sql.exec(
        "INSERT INTO match_state_timer_starts_canonical(match_id,player_id,opponent_id,deadline_at_ms,turn_number,updated_at_ms) VALUES (?, ?, ?, ?, 7, ?)",
        input.matchId,
        input.playerId,
        input.opponentId,
        retiredDeadline,
        retiredDeadline - 90_500,
      );
      const before = snapshot(storage);
      await expect(store.startTimer(input)).rejects.toThrow(
        "game is already over.",
      );
      expect(snapshot(storage)).toEqual(before);
    },
    { state: "finished" },
  );
});

it("still commits an ordinary expired timer claim once and preserves its local deadline", async () => {
  await fixture(
    async ({ store, storage, input }) => {
      await store.startTimer(input);
      const markers = storage.sql
        .exec("SELECT * FROM match_state_timer_starts_canonical")
        .toArray();
      await expect(store.claimTimer(input)).resolves.toEqual({ ok: true });
      const after = snapshot(storage);
      await expect(store.claimTimer(input)).resolves.toEqual({ ok: true });
      expect(snapshot(storage)).toEqual(after);
      expect(
        storage.sql
          .exec("SELECT * FROM match_state_timer_starts_canonical")
          .toArray(),
      ).toEqual(markers);
      await storage.deleteAlarm();
    },
    formatMatchTimer(7, now - 1),
  );
});
