import { env } from "cloudflare:workers";
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { HistoricalMatchPair } from "@mons/shared/game-sessions";
import type { MatchPresentationSnapshot } from "@mons/shared/match-presentation";
import {
  archiveHistoricalMatchWithPresentation,
  type FreezeHistoricalMatchPresentations,
} from "../src/historicalMatchPresentation.ts";
import {
  HistoricalMatchConflict,
  readHistoricalMatchSnapshot,
  writeHistoricalMatchSnapshot,
} from "../src/historicalMatchesD1.ts";
import { createProfileGameProjectionRuntime } from "../src/profileGameProjectionRepository.ts";
import {
  buildMatchPresentationRegistrationStatements,
  prepareCreatedMatchPresentations,
} from "../src/matchPresentationRegistry.ts";
import { activateDurableMatchPresentationTestState } from "./matchPresentationTestFixture.ts";

const testEnv = env as Env & { TEST_D1_MIGRATIONS: D1Migration[] };
const inviteId = "presentation-history";

function pair(): HistoricalMatchPair {
  const match = {
    version: 2,
    emojiId: 1,
    aura: "",
    gameVariant: "Classic",
    fen: "final-fen",
    status: "surrendered",
    flatMovesString: "move",
    timer: "",
  };
  return {
    matchId: inviteId,
    hostPlayerId: "host",
    guestPlayerId: "guest",
    hostMatch: { ...match, color: "white" },
    guestMatch: { ...match, color: "black", emojiId: 2 },
  };
}

function archiveInput(source: "rating" | "transition" | "backfill" = "rating") {
  return {
    archivedAtMs: 2_000,
    finalizedAtMs: 1_000,
    inviteId,
    pair: pair(),
    source,
  };
}

function snapshot(matchId = inviteId): MatchPresentationSnapshot {
  return {
    matchId,
    players: {
      host: {
        matchId,
        actorUid: "host",
        emojiId: 12,
        aura: "rainbow",
        revision: 3,
      },
      guest: { matchId, actorUid: "guest", emojiId: 14, aura: "", revision: 2 },
    },
  };
}

async function stored() {
  const value = await readHistoricalMatchSnapshot(
    env.PROFILE_GAMES_DB,
    inviteId,
    inviteId,
  );
  expect(value).not.toBeNull();
  if (!value) throw new Error("missing-history");
  return value;
}

describe("historical match presentation", () => {
  beforeAll(async () => {
    await applyD1Migrations(
      testEnv.PROFILE_GAMES_DB,
      testEnv.TEST_D1_MIGRATIONS,
    );
    await activateDurableMatchPresentationTestState(testEnv.PROFILE_GAMES_DB);
  });

  beforeEach(async () => {
    await env.PROFILE_GAMES_DB.prepare(
      "DELETE FROM historical_match_pairs",
    ).run();
  });

  it("freezes current presentation in the common archive runtime without changing gameplay", async () => {
    const freeze = vi.fn(async () => snapshot());
    const runtime = createProfileGameProjectionRuntime(env, {
      readPresentationControl: async () => ({ phase: "durable" }),
      freezeRegisteredPresentations: freeze,
      now: () => 2_000,
      state: {
        readInviteMetadata: async () => {
          throw new Error("unexpected-invite-metadata-read");
        },
        getStatePath: async () => {
          throw new Error("unexpected-source-read");
        },
      },
    });
    if (!runtime.archiveHistoricalMatch)
      throw new Error("missing-archive-runtime");
    await runtime.archiveHistoricalMatch(archiveInput());
    expect(freeze).toHaveBeenCalledExactlyOnceWith(env, inviteId, inviteId, [
      "host",
      "guest",
    ]);
    const value = await stored();
    expect(value.pair.hostMatch).toEqual({
      ...pair().hostMatch,
      emojiId: 12,
      aura: "rainbow",
    });
    expect(value.pair.guestMatch).toEqual({
      ...pair().guestMatch,
      emojiId: 14,
    });
    expect(value.source).toBe("rating");
    expect(value.archivedAtMs).toBe(2_000);
  });

  it("replays archived rating presentation without depending on the DO", async () => {
    await archiveHistoricalMatchWithPresentation(
      env.PROFILE_GAMES_DB,
      archiveInput(),
      async () => snapshot(),
    );
    const unavailable = vi.fn<FreezeHistoricalMatchPresentations>(async () => {
      throw new Error("do-unavailable");
    });
    await archiveHistoricalMatchWithPresentation(
      env.PROFILE_GAMES_DB,
      archiveInput(),
      unavailable,
    );
    expect(unavailable).not.toHaveBeenCalled();
    expect((await stored()).revision).toBe(1);
    expect((await stored()).pair.hostMatch?.emojiId).toBe(12);
  });

  it("durable archives freeze registered actors without passing Firebase appearance seeds", async () => {
    const canonicalFreeze = vi.fn(async () => snapshot());
    const runtime = createProfileGameProjectionRuntime(env, {
      readPresentationControl: async () => ({ phase: "durable" }),
      freezeRegisteredPresentations: canonicalFreeze,
      now: () => 2_000,
      state: {
        readInviteMetadata: async () => {
          throw new Error("unexpected-invite-metadata-read");
        },
        getStatePath: async () => {
          throw new Error("unexpected-source-read");
        },
      },
    });
    await runtime.archiveHistoricalMatch!(archiveInput());
    expect(canonicalFreeze).toHaveBeenCalledExactlyOnceWith(
      env,
      inviteId,
      inviteId,
      ["host", "guest"],
    );
    expect((await stored()).pair.hostMatch?.emojiId).toBe(12);
    expect((await stored()).pair.guestMatch?.emojiId).toBe(14);

    const replay = createProfileGameProjectionRuntime(env, {
      readPresentationControl: async () => {
        throw new Error("unnecessary-authority-read");
      },
      freezeRegisteredPresentations: async () => {
        throw new Error("unnecessary-do-read");
      },
      state: {
        readInviteMetadata: async () => {
          throw new Error("unexpected-invite-metadata-read");
        },
        getStatePath: async () => {
          throw new Error("unexpected-source-read");
        },
      },
    });
    await replay.archiveHistoricalMatch!(archiveInput());
    expect((await stored()).revision).toBe(1);
  });

  it("missing durable appearance leaves archival retryable without legacy seed initialization", async () => {
    const runtime = createProfileGameProjectionRuntime(env, {
      readPresentationControl: async () => ({ phase: "durable" }),
      freezeRegisteredPresentations: async () => {
        throw new Error("registered-presentation-missing");
      },
      state: {
        readInviteMetadata: async () => {
          throw new Error("unexpected-invite-metadata-read");
        },
        getStatePath: async () => {
          throw new Error("unexpected-source-read");
        },
      },
    });
    await expect(
      runtime.archiveHistoricalMatch!(archiveInput()),
    ).rejects.toThrow("registered-presentation-missing");
    expect(
      await readHistoricalMatchSnapshot(
        env.PROFILE_GAMES_DB,
        inviteId,
        inviteId,
      ),
    ).toBeNull();
  });

  it("rejects retired appearance authorities without freezing or writing history", async () => {
    for (const phase of ["legacy", "capture"] as const) {
      const freeze = vi.fn(async () => snapshot());
      const runtime = createProfileGameProjectionRuntime(env, {
        readPresentationControl: async () => ({ phase }),
        freezeRegisteredPresentations: freeze,
        state: {
          readInviteMetadata: async () => {
            throw new Error("unexpected-invite-metadata-read");
          },
          getStatePath: async () => {
            throw new Error("unexpected-source-read");
          },
        },
      });
      await expect(
        runtime.archiveHistoricalMatch!(archiveInput()),
      ).rejects.toThrow("match-presentation-authority-not-active");
      expect(freeze).not.toHaveBeenCalled();
      expect(
        await readHistoricalMatchSnapshot(
          env.PROFILE_GAMES_DB,
          inviteId,
          inviteId,
        ),
      ).toBeNull();
    }
  });

  it("leaves history retryable when the DO is unavailable", async () => {
    const unavailable = vi.fn<FreezeHistoricalMatchPresentations>(async () => {
      throw new Error("do-unavailable");
    });
    await expect(
      archiveHistoricalMatchWithPresentation(
        env.PROFILE_GAMES_DB,
        archiveInput(),
        unavailable,
      ),
    ).rejects.toThrow("do-unavailable");
    expect(
      await readHistoricalMatchSnapshot(
        env.PROFILE_GAMES_DB,
        inviteId,
        inviteId,
      ),
    ).toBeNull();
    await archiveHistoricalMatchWithPresentation(
      env.PROFILE_GAMES_DB,
      archiveInput(),
      async () => snapshot(),
    );
    expect((await stored()).pair.hostMatch?.emojiId).toBe(12);
  });

  it("retains the first DO freeze after a failed D1 write while live presentation remains mutable", async () => {
    const input = archiveInput();
    input.inviteId = "presentation-archive-retry";
    input.pair.matchId = input.inviteId;
    const room = env.INVITE_REACTIONS.getByName(input.inviteId);
    const registrations = await prepareCreatedMatchPresentations(
      env,
      ["host", "guest"].map((actorUid) => ({
        inviteId: input.inviteId,
        matchId: input.pair.matchId,
        actorUid,
        emojiId: actorUid === "host" ? 1 : 2,
        aura: "",
        sourceId: "test:history-creation",
      })),
    );
    await env.PROFILE_GAMES_DB.batch(
      buildMatchPresentationRegistrationStatements(
        env.PROFILE_GAMES_DB,
        registrations,
        1,
      ),
    );
    await room.updatePresentation("host", input.pair.matchId, {
      operationId: crypto.randomUUID(),
      expectedRevision: 0,
      emojiId: 1012,
      aura: "rainbow",
    });
    const runtime = createProfileGameProjectionRuntime(env, {
      state: {
        readInviteMetadata: async () => {
          throw new Error("unexpected-invite-metadata-read");
        },
        getStatePath: async () => {
          throw new Error("unexpected-source-read");
        },
      },
    });
    if (!runtime.archiveHistoricalMatch)
      throw new Error("missing-archive-runtime");
    await env.PROFILE_GAMES_DB.exec(
      "CREATE TRIGGER fail_presentation_archive BEFORE INSERT ON historical_match_pairs BEGIN SELECT RAISE(ABORT, 'archive-write-failed'); END",
    );
    try {
      await expect(runtime.archiveHistoricalMatch(input)).rejects.toThrow(
        "archive-write-failed",
      );
    } finally {
      await env.PROFILE_GAMES_DB.exec("DROP TRIGGER fail_presentation_archive");
    }
    const changed = await room.updatePresentation("host", input.pair.matchId, {
      operationId: crypto.randomUUID(),
      expectedRevision: 1,
      emojiId: 21,
      aura: "",
    });
    expect(changed.status).toBe("updated");
    await runtime.archiveHistoricalMatch(input);
    const archived = await readHistoricalMatchSnapshot(
      env.PROFILE_GAMES_DB,
      input.inviteId,
      input.pair.matchId,
    );
    expect(archived?.pair.hostMatch?.emojiId).toBe(1012);
    expect(archived?.pair.hostMatch?.aura).toBe("rainbow");
    expect(
      (await room.getPresentationSnapshot(input.pair.matchId)).players.host
        .emojiId,
    ).toBe(21);
  });

  it("promotes transition gameplay to rating while preserving the existing actors' cosmetics", async () => {
    const transition = archiveInput("transition");
    transition.pair = {
      ...transition.pair,
      hostMatch: {
        ...pair().hostMatch!,
        emojiId: 21,
        aura: "rainbow",
        fen: "transition-fen",
      },
      guestMatch: { ...pair().guestMatch!, emojiId: 22 },
    };
    await writeHistoricalMatchSnapshot(env.PROFILE_GAMES_DB, transition);
    const unavailable = vi.fn<FreezeHistoricalMatchPresentations>(async () => {
      throw new Error("do-unavailable");
    });
    await archiveHistoricalMatchWithPresentation(
      env.PROFILE_GAMES_DB,
      archiveInput(),
      unavailable,
    );
    const value = await stored();
    expect(unavailable).not.toHaveBeenCalled();
    expect(value.source).toBe("rating");
    expect(value.revision).toBe(2);
    expect(value.pair.hostMatch).toEqual({
      ...pair().hostMatch,
      emojiId: 21,
      aura: "rainbow",
    });
    expect(value.pair.guestMatch).toEqual({
      ...pair().guestMatch,
      emojiId: 22,
    });
  });

  it("looks up archived cosmetics by actor when the incoming pair changes sides", async () => {
    await writeHistoricalMatchSnapshot(
      env.PROFILE_GAMES_DB,
      archiveInput("transition"),
    );
    const incoming = archiveInput();
    const initial = pair();
    incoming.pair = {
      ...initial,
      hostPlayerId: "guest",
      guestPlayerId: "host",
      hostMatch: { ...initial.hostMatch!, emojiId: 99 },
      guestMatch: { ...initial.guestMatch!, emojiId: 98 },
    };
    await archiveHistoricalMatchWithPresentation(
      env.PROFILE_GAMES_DB,
      incoming,
      async () => {
        throw new Error("unexpected-do");
      },
    );
    expect((await stored()).pair.hostMatch?.emojiId).toBe(2);
    expect((await stored()).pair.guestMatch?.emojiId).toBe(1);
  });

  it("freezes only newly archived actors during rating promotion", async () => {
    const initial = archiveInput("backfill");
    initial.pair.guestMatch = null;
    await writeHistoricalMatchSnapshot(env.PROFILE_GAMES_DB, initial);
    const freeze = vi.fn(async () => snapshot());
    await archiveHistoricalMatchWithPresentation(
      env.PROFILE_GAMES_DB,
      archiveInput(),
      freeze,
    );
    expect(freeze).toHaveBeenCalledExactlyOnceWith(inviteId, inviteId, {
      guest: { emojiId: 2, aura: "" },
    });
    expect((await stored()).pair.hostMatch?.emojiId).toBe(1);
    expect((await stored()).pair.guestMatch?.emojiId).toBe(14);
  });

  it.each(["transition", "rating"] as const)(
    "keeps legacy cosmetics if an old job archives during freeze before a %s write",
    async (source) => {
      const legacy = archiveInput("transition");
      legacy.pair.hostMatch!.emojiId = 31;
      legacy.pair.guestMatch!.emojiId = 32;
      const freeze = vi.fn<FreezeHistoricalMatchPresentations>(async () => {
        await writeHistoricalMatchSnapshot(env.PROFILE_GAMES_DB, legacy);
        return snapshot();
      });
      await archiveHistoricalMatchWithPresentation(
        env.PROFILE_GAMES_DB,
        archiveInput(source),
        freeze,
      );
      expect(freeze).toHaveBeenCalledTimes(1);
      const value = await stored();
      expect(value.pair.hostMatch?.emojiId).toBe(31);
      expect(value.pair.guestMatch?.emojiId).toBe(32);
      expect(value.source).toBe(source);
      expect(value.revision).toBe(source === "rating" ? 2 : 1);
    },
  );

  it("does not hide an unrelated gameplay conflict during the cutover retry", async () => {
    const legacy = archiveInput("transition");
    legacy.pair.hostMatch!.fen = "different-game-state";
    const freeze = vi.fn<FreezeHistoricalMatchPresentations>(async () => {
      await writeHistoricalMatchSnapshot(env.PROFILE_GAMES_DB, legacy);
      return snapshot();
    });
    await expect(
      archiveHistoricalMatchWithPresentation(
        env.PROFILE_GAMES_DB,
        archiveInput("transition"),
        freeze,
      ),
    ).rejects.toBeInstanceOf(HistoricalMatchConflict);
    expect(freeze).toHaveBeenCalledTimes(1);
    expect((await stored()).pair.hostMatch?.fen).toBe("different-game-state");
  });

  it("requires frozen presentation for every requested actor", async () => {
    await expect(
      archiveHistoricalMatchWithPresentation(
        env.PROFILE_GAMES_DB,
        archiveInput(),
        async () => ({ matchId: inviteId, players: {} }),
      ),
    ).rejects.toThrow("historical-match-presentation-unavailable");
    expect(
      await readHistoricalMatchSnapshot(
        env.PROFILE_GAMES_DB,
        inviteId,
        inviteId,
      ),
    ).toBeNull();
  });
});
