import { timerStartStoreFixture } from "../test/matchClaimFixture.ts";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { MatchStateStore } from "../src/matchStateStore.ts";

async function fixture(
  value: unknown,
  work: (
    store: MatchStateStore,
    storage: DurableObjectStorage,
    input: {
      inviteId: string;
      matchId: string;
      playerId: string;
      epoch: number;
    },
  ) => void | Promise<void>,
) {
  const inviteId = `codec-${crypto.randomUUID()}`;
  const room = env.INVITE_REACTIONS.getByName(inviteId);
  await runInDurableObject(room, async (_instance, ctx) => {
    const input = {
      inviteId,
      matchId: inviteId,
      playerId: "host-login",
      epoch: 1,
    };
    ctx.storage.sql.exec(
      "INSERT INTO match_state_source(singleton, invite_id, active_epoch) VALUES (1, ?, 1)",
      inviteId,
    );
    ctx.storage.sql.exec(
      "INSERT INTO match_state_records(match_id, player_id, value_json) VALUES (?, ?, ?)",
      inviteId,
      input.playerId,
      JSON.stringify(value),
    );
    const store = new MatchStateStore(ctx.storage, {
      timerStarts: timerStartStoreFixture({
        getOrAdvance: async () => {
          throw new Error("unexpected timer write");
        },
        deletePair: async () => {
          throw new Error("unexpected timer cleanup");
        },
      }),
      now: () => 1000,
    });
    try {
      await work(store, ctx.storage, input);
    } finally {
      await ctx.storage.deleteAlarm();
    }
  });
}

function revisions(storage: DurableObjectStorage) {
  return storage.sql
    .exec("SELECT match_id, revision FROM match_state_revisions")
    .toArray();
}

describe("retained canonical match compatibility", () => {
  it.each([null, false, 0, ""])(
    "retains falsy stored %j until creation replaces it",
    async (value) => {
      await fixture(value, (store, storage, input) => {
        expect(store.readRecord(input)).toEqual(value);
        expect(
          store.createRecords({
            ...input,
            records: [
              {
                matchId: input.matchId,
                playerId: input.playerId,
                marker: "new-creation",
                value: {},
              },
            ],
          }),
        ).toEqual({
          records: [
            {
              matchId: input.matchId,
              playerId: input.playerId,
              outcome: "created",
              value: { sessionCreation: "new-creation" },
            },
          ],
          changedMatchIds: [input.matchId],
        });
        expect(revisions(storage)).toEqual([
          { match_id: input.matchId, revision: 1 },
        ]);
      });
    },
  );

  it.each([true, 42, "retained", [], { fen: null }])(
    "does not overwrite truthy retained %j during creation",
    async (value) => {
      await fixture(value, (store, storage, input) => {
        expect(() =>
          store.createRecords({
            ...input,
            records: [
              {
                matchId: input.matchId,
                playerId: input.playerId,
                marker: "new-creation",
                value: {},
              },
            ],
          }),
        ).toThrow("match-creation-conflict");
        expect(store.readRecord(input)).toEqual(value);
        expect(revisions(storage)).toEqual([]);
      });
    },
  );

  it("creation replays malformed game fields without normalizing retained extensions", async () => {
    const value = {
      sessionCreation: "creation",
      fen: null,
      nested: { absent: null },
      history: [null, 1, null],
    };
    await fixture(value, (store, storage, input) => {
      expect(
        store.createRecords({
          ...input,
          records: [
            {
              matchId: input.matchId,
              playerId: input.playerId,
              marker: "creation",
              value: {},
            },
          ],
        }),
      ).toEqual({
        records: [
          {
            matchId: input.matchId,
            playerId: input.playerId,
            outcome: "already-created",
            value,
          },
        ],
        changedMatchIds: [],
      });
      expect(revisions(storage)).toEqual([]);
      expect(store.readRecord(input)).toEqual(value);
    });
  });

  it("duplicate and superseded moves retain minimal records without reading a corrupt fence", async () => {
    for (const flatMovesString of ["a", "a-b"]) {
      const value = {
        fen: flatMovesString === "a" ? "first" : "second",
        flatMovesString,
        extension: [1, null, true],
      };
      await fixture(value, (store, storage, input) => {
        storage.sql.exec(
          "INSERT INTO match_state_claims(match_id, value_json) VALUES (?, ?)",
          input.matchId,
          "broken-json",
        );
        const result = store.move({
          ...input,
          previousFlatMovesString: "",
          flatMovesString: "a",
          fen: "first",
          previousStates: [{ moveCount: 0, fen: "initial" }],
        });
        expect(result.outcome).toBe(
          flatMovesString === "a" ? "already-applied" : "superseded",
        );
        expect(store.readRecord(input)).toEqual(value);
        expect(revisions(storage)).toEqual([]);
      });
    }
  });

  it("surrender replay avoids FEN and fence validation while other records check the fence first", async () => {
    for (const status of ["surrendered", ""]) {
      const value = { status, fen: null, extension: { retained: true } };
      await fixture(value, (store, storage, input) => {
        storage.sql.exec(
          "INSERT INTO match_state_claims(match_id, value_json) VALUES (?, ?)",
          input.matchId,
          "broken-json",
        );
        if (status === "surrendered") {
          expect(store.surrender(input)).toEqual({
            ok: true,
            inviteId: input.inviteId,
            matchId: input.matchId,
            actorUid: input.playerId,
          });
        } else {
          expect(() => store.surrender(input)).toThrow(SyntaxError);
        }
        expect(store.readRecord(input)).toEqual(value);
        expect(revisions(storage)).toEqual([]);
      });
    }
  });

  it("missing creation payloads retain authority, target, marker and record validation order", async () => {
    await fixture(null, (store, storage, input) => {
      const creation = {
        matchId: input.matchId,
        playerId: input.playerId,
        marker: "creation",
        value: undefined,
      };
      expect(() =>
        store.createRecords({ ...input, epoch: 2, records: [creation] }),
      ).toThrow("match-state-authority-unavailable");
      expect(() =>
        store.createRecords({
          ...input,
          records: [
            { ...creation, matchId: "other-invite", marker: "invalid/key" },
          ],
        }),
      ).toThrow("match-state-invalid-target");
      expect(() =>
        store.createRecords({
          ...input,
          records: [{ ...creation, marker: "invalid/key" }],
        }),
      ).toThrow("match-state-invalid-key");
      expect(() =>
        store.createRecords({ ...input, records: [creation] }),
      ).toThrow("match-state-invalid-creation");
      expect(store.readRecord(input)).toBeNull();
      expect(revisions(storage)).toEqual([]);
    });
  });
});
