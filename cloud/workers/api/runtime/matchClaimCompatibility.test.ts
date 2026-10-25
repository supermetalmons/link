import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { MatchStateStore } from "../src/matchStateStore.ts";
import { readRetainedTimerClaim } from "../src/matchClaimCodec.ts";
import { timerStartStoreFixture } from "../test/matchClaimFixture.ts";

const nowMs = 1000;

async function fixture(
  claimJson: string,
  work: (
    store: MatchStateStore,
    storage: DurableObjectStorage,
    input: {
      inviteId: string;
      matchId: string;
      playerId: string;
      opponentId: string;
      epoch: number;
    },
    clocks: number[],
  ) => void | Promise<void>,
  playerTimer = "7;1000",
) {
  const inviteId = `claim-codec-${crypto.randomUUID()}`;
  const room = env.INVITE_REACTIONS.getByName(inviteId);
  await runInDurableObject(room, async (_instance, state) => {
    const input = {
      inviteId,
      matchId: inviteId,
      playerId: "host-login",
      opponentId: "guest-login",
      epoch: 1,
    };
    const clocks: number[] = [];
    const store = new MatchStateStore(state.storage, {
      now: () => {
        clocks.push(nowMs);
        return nowMs;
      },
      resolveGame: () => ({
        activeColor: "black",
        historyValid: true,
        turnNumber: 7,
        winner: undefined,
      }),
      timerStarts: timerStartStoreFixture({
        getOrAdvance: async () => {
          throw new Error("unexpected timer start");
        },
        deletePair: async () => {},
      }),
    });
    store.createRecords({
      ...input,
      records: [
        {
          matchId: inviteId,
          playerId: input.playerId,
          marker: "host-created",
          value: { color: "white", fen: "initial", timer: playerTimer },
        },
        {
          matchId: inviteId,
          playerId: input.opponentId,
          marker: "guest-created",
          value: { color: "black", fen: "initial" },
        },
      ],
    });
    state.storage.sql.exec(
      "INSERT INTO match_state_claims(match_id, value_json) VALUES (?, ?)",
      inviteId,
      claimJson.replaceAll("$INVITE", inviteId),
    );
    try {
      await work(store, state.storage, input, clocks);
    } finally {
      await state.storage.deleteAlarm();
    }
  });
}

describe("retained timer claim compatibility", () => {
  for (const operation of ["move", "surrender"] as const) {
    it.each([
      ["null", true, 0],
      ["false", true, 0],
      ["0", true, 0],
      ['""', true, 0],
      ["{}", false, 0],
      ["[]", false, 0],
      ['{"status":"pending","expiresAtMs":"999"}', false, 0],
      ['{"status":"pending","expiresAtMs":1000}', true, 1],
      ['{"status":"pending","expiresAtMs":1001}', false, 1],
      ['{"status":"pending","expiresAtMs":1e400}', false, 1],
    ] as const)(
      `${operation} keeps raw fences and lazy clocks for %s`,
      async (claim, allowed, expectedClocks) => {
        await fixture(claim, (store, _storage, input, clocks) => {
          const request = {
            inviteId: input.inviteId,
            matchId: input.matchId,
            playerId: input.playerId,
            epoch: input.epoch,
          };
          const run = () =>
            operation === "move"
              ? store.move({
                  ...request,
                  previousFlatMovesString: "",
                  flatMovesString: "a",
                  fen: "first",
                })
              : store.surrender(request);
          if (allowed) expect(run()).toMatchObject({ ok: true });
          else expect(run).toThrow(`match-${operation}-blocked`);
          expect(clocks).toHaveLength(expectedClocks);
        });
      },
    );
  }

  it.each(['{"status":"pending","expiresAtMs":"999"}', "{}", "[]"])(
    "timer claims can replace retained fences that block ordinary mutations: %s",
    async (claim) => {
      await fixture(claim, async (store, _storage, input) => {
        await expect(store.claimTimer(input)).resolves.toEqual({ ok: true });
        expect(store.readPair(input).claim).toEqual({
          status: "claimed",
          playerId: input.playerId,
          opponentId: input.opponentId,
          inviteId: input.inviteId,
          timer: "7;1000",
          turnNumber: 7,
          claimedAtMs: nowMs,
          expiresAtMs: null,
        });
      });
    },
  );

  it("terminal replay keeps a valid prior timer but refreshes timestamps for different actors", async () => {
    await fixture(
      '{"status":"claimed","inviteId":"$INVITE","playerId":"retired-host","opponentId":"retired-guest","timer":"7;900","turnNumber":7,"claimedAtMs":900,"extension":{"retained":true}}',
      async (store, _storage, input) => {
        const before = store.readPair(input).revision;
        await expect(store.claimTimer(input)).resolves.toEqual({ ok: true });
        const pair = store.readPair(input);
        expect(pair.revision).toBe(before + 1);
        expect(pair.claim).toEqual({
          status: "claimed",
          playerId: input.playerId,
          opponentId: input.opponentId,
          inviteId: input.inviteId,
          timer: "7;900",
          turnNumber: 7,
          claimedAtMs: nowMs,
          expiresAtMs: null,
        });
      },
      "gg",
    );
  });

  it("event claims retain direct null failures and terminal-copy truthy scalar records", async () => {
    await fixture("null", (store, storage, input) => {
      const before = store.readPair(input);
      expect(() =>
        store.applyEventEffects({
          ...input,
          operationId: "invalid-claim",
          claims: [
            {
              matchId: input.matchId,
              playerId: input.playerId,
              opponentId: input.opponentId,
              claim: null,
            },
          ],
        }),
      ).toThrow(TypeError);
      expect(store.readPair(input)).toEqual(before);
      storage.sql.exec(
        "UPDATE match_state_records SET value_json = ? WHERE player_id = ?",
        '"retained"',
        input.playerId,
      );
      storage.sql.exec(
        "UPDATE match_state_records SET value_json = ? WHERE player_id = ?",
        "[]",
        input.opponentId,
      );
      const claim = {
        status: "claimed",
        inviteId: input.inviteId,
        playerId: input.playerId,
        opponentId: input.opponentId,
        timer: "gg",
        turnNumber: 7,
        claimedAtMs: nowMs,
        expiresAtMs: null,
        extension: { retained: true },
      };
      store.applyEventEffects({
        ...input,
        operationId: "retained-target",
        claims: [
          {
            matchId: input.matchId,
            playerId: input.playerId,
            opponentId: input.opponentId,
            claim,
          },
        ],
      });
      const pair = store.readPair(input);
      expect(pair.playerMatch).toEqual({ ...Object("retained"), timer: "gg" });
      expect(pair.opponentMatch).toEqual([]);
      expect(pair.claim).toEqual(readRetainedTimerClaim(claim));
    });
  });
});
