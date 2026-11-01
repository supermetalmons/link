import { required } from "./fixtures/canonicalData.mjs";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { Color, Game } from "mons-rules";

/** @typedef {Omit<import("@mons/shared/game-sessions").HistoricalMatchPair, "hostMatch" | "guestMatch"> & {
 * model: Game; recordedMoves: number;
 * hostMatch: import("@mons/shared/game-sessions").GameSessionMatch;
 * guestMatch: import("@mons/shared/game-sessions").GameSessionMatch;
 * }} FixturePair */

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      context.parentURL?.endsWith(".ts") &&
      specifier.startsWith("./") &&
      !/\.[^/]+$/.test(specifier)
    ) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});

const { createRematchViewing } = await import("../src/game/rematchViewing.ts");

const online = { online: true, localPlayerUid: null };
/**
 * @template [T=FixturePair | null]
 * @returns {Pick<PromiseWithResolvers<T>, "promise" | "resolve">}
 */
const deferred = () => {
  /** @type {PromiseWithResolvers<T>} */
  const { promise, resolve } = Promise.withResolvers();
  return { promise, resolve };
};
const flush = () => new Promise((resolve) => setImmediate(resolve));
const game = (historyCount = 2, turnNumber = 1, fen = "game") => {
  /** @type {Pick<Game, "trackingEntries" | "turnNumber" | "scores" | "toFen">} */
  const view = {
    trackingEntries: Array.from({ length: historyCount }, () => ({
      fen,
      color: Color.White,
      events: [],
      eventsFen: "",
    })),
    turnNumber,
    scores: { [Color.White]: 3, [Color.Black]: 4 },
    toFen: () => fen,
  };
  return Object.defineProperties(new Game(), {
    trackingEntries: { value: view.trackingEntries },
    turnNumber: { value: view.turnNumber },
    scores: { value: view.scores },
    toFen: { value: view.toFen },
  });
};
/** @returns {FixturePair} */
const pair = (matchId = "a", model = game(), emojiId = 1) => ({
  matchId,
  model,
  recordedMoves: 2,
  hostPlayerId: "host",
  guestPlayerId: "guest",
  hostMatch: {
    schemaVersion: 1,
    version: 1,
    color: "white",
    emojiId,
    aura: emojiId === 1 ? "none" : "rainbow",
    gameVariant: "Classic",
    fen: "host-fen",
    status: "surrendered",
    flatMovesString: "move",
    timer: { state: "idle" },
  },
  guestMatch: {
    schemaVersion: 1,
    version: 1,
    color: "black",
    emojiId: 2,
    aura: "rainbow",
    gameVariant: "Classic",
    fen: "guest-fen",
    status: "active",
    flatMovesString: "move",
    timer: { state: "idle" },
  },
});

/** @param {{load?: (matchId: string) => Promise<FixturePair | null>; wait?: (delay: number) => Promise<void>}} [options] */
function harness({ load = async (matchId) => pair(matchId), wait } = {}) {
  let session = 1;
  let render = 1;
  let now = 1000;
  let nextTimerId = 0;
  /**
   * @type {string[]}
   */
  const reads = [];
  /**
   * @type {number[]}
   */
  const waits = [];
  /** @type {Map<number, {callback: () => void; delay: number}>} */
  const timers = new Map();
  const viewer = createRematchViewing({
    loadMatchPair: (matchId) => {
      reads.push(matchId);
      return load(matchId);
    },
    buildHistoricalGame: (_matchId, value) => {
      assert.ok("model" in value && value.model instanceof Game);
      return value.model;
    },
    countRecordedMoves: (_matchId, value) => {
      assert.ok(
        "recordedMoves" in value && typeof value.recordedMoves === "number",
      );
      return value.recordedMoves;
    },
    createSessionGuard: () => {
      const expected = session;
      return () => expected === session;
    },
    setTimeout: (callback, delay) => {
      const id = ++nextTimerId;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
    wait: async (delay) => {
      waits.push(delay);
      await wait?.(delay);
    },
    now: () => now,
  });
  const begin = () => {
    const expected = ++render;
    return viewer.beginSelection(() => expected === render);
  };
  const select = async (/** @type {string} */ matchId) => {
    const request = begin();
    const selection = await viewer.loadSelection(request, matchId, online);
    return selection && viewer.commitSelection(request, required(selection));
  };
  return {
    viewer,
    begin,
    select,
    reads,
    waits,
    timers,
    invalidateSession: () => session++,
    invalidateRender: () => render++,
    advance: (/** @type {number} */ ms) => (now += ms),
    runTimer: async () => {
      const [id, timer] = required(timers.entries().next().value);
      timers.delete(id);
      timer.callback();
      await flush();
    },
  };
}

test("selection loading leaves the displayed match unchanged until a guarded commit", async () => {
  const pending = deferred();
  const h = harness({ load: () => pending.promise });
  const request = h.begin();
  const loading = h.viewer.loadSelection(request, "a", online);
  assert.equal(h.viewer.getSelection(), null);
  const loaded = pair();
  pending.resolve(loaded);
  const selection = await loading;
  assert.equal(h.viewer.getSelection(), null);
  assert.equal(required(selection).game, loaded.model);
  assert.equal(h.viewer.commitSelection(request, required(selection)), true);
  assert.equal(h.viewer.getSelection(), selection);
  assert.equal(required(h.viewer.getCachedSelection("a")).pair, loaded);
  assert.deepEqual(h.viewer.getScore("a"), { white: 3, black: 4 });
  assert.deepEqual(h.reads, ["a"]);
});

test("a slower earlier navigation cannot load or commit over the latest selection", async () => {
  const pending = deferred();
  const h = harness({
    load: async (matchId) =>
      matchId === "a" ? pending.promise : pair(matchId),
  });
  const first = h.begin();
  const loading = h.viewer.loadSelection(first, "a", online);
  assert.equal(await h.select("b"), true);
  pending.resolve(pair("a"));
  assert.equal(await loading, null);
  assert.equal(
    h.viewer.commitSelection(first, {
      matchId: "a",
      pair: pair(),
      game: game(),
    }),
    false,
  );
  assert.equal(required(h.viewer.getSelection()).matchId, "b");
});

test("session, render, and explicit selection clearing reject a prepared commit", async (t) => {
  for (const invalidate of [
    (/** @type {ReturnType<typeof harness>} */ h) => h.invalidateSession(),
    (/** @type {ReturnType<typeof harness>} */ h) => h.invalidateRender(),
    (/** @type {ReturnType<typeof harness>} */ h) => h.viewer.clearSelection(),
  ]) {
    await t.test(invalidate.toString(), async () => {
      const h = harness();
      const request = h.begin();
      const prepared = await h.viewer.loadSelection(request, "a", online);
      invalidate(h);
      assert.equal(
        h.viewer.commitSelection(request, required(prepared)),
        false,
      );
      assert.equal(h.viewer.getSelection(), null);
    });
  }
});

test("failed navigation preserves the displayed selection and its archive refresh", async () => {
  /** @type {FixturePair | null} */
  let archived = null;
  const h = harness({
    load: async (matchId) => (matchId === "a" ? archived : null),
  });
  const provisional = pair();
  h.viewer.seedProvisional(provisional);
  assert.equal(await h.select("a"), true);
  const displayedGame = required(h.viewer.getSelection()).game;
  let refreshed = 0;
  h.viewer.refreshSelectedArchive(
    () => true,
    () => refreshed++,
    (error) => assert.fail(error instanceof Error ? error : String(error)),
  );
  assert.equal(await h.select("missing"), null);
  assert.equal(required(h.viewer.getSelection()).matchId, "a");
  archived = pair("a", game(), 9);
  await h.runTimer();
  assert.equal(refreshed, 1);
  assert.equal(
    required(required(h.viewer.getSelection()).pair.hostMatch).emojiId,
    9,
  );
  assert.equal(required(h.viewer.getSelection()).game, displayedGame);
});

test("successful replacement and returning to the same match invalidate old archive refreshes", async (t) => {
  for (const returnToSameMatch of [false, true]) {
    await t.test(String(returnToSameMatch), async () => {
      const archive = deferred();
      let archivePending = false;
      const h = harness({
        load: async (matchId) =>
          matchId === "a"
            ? archivePending
              ? archive.promise
              : null
            : pair(matchId),
      });
      h.viewer.seedProvisional(pair());
      await h.select("a");
      let refreshed = 0;
      h.viewer.refreshSelectedArchive(
        () => true,
        () => refreshed++,
        (error) => assert.fail(error instanceof Error ? error : String(error)),
      );
      archivePending = true;
      await h.runTimer();
      if (returnToSameMatch) {
        h.viewer.clearSelection();
        const request = h.begin();
        const cached = h.viewer.getCachedSelection("a");
        assert.equal(h.viewer.commitSelection(request, required(cached)), true);
      } else {
        await h.select("b");
      }
      archive.resolve(pair("a", game(), 9));
      await flush();
      assert.equal(refreshed, 0);
      assert.equal(
        required(h.viewer.getSelection()).matchId,
        returnToSameMatch ? "a" : "b",
      );
      assert.equal(
        required(required(h.viewer.getSelection()).pair.hostMatch).emojiId,
        1,
      );
    });
  }
});

test("equal short history refreshes actor cosmetics without replacing gameplay", async () => {
  const original = pair("a", game(1, 4), 1);
  /** @type {FixturePair} */
  const refreshed = {
    ...pair("a", game(1, 4), 9),
    hostPlayerId: "guest",
    guestPlayerId: "host",
    hostMatch: { ...original.guestMatch, emojiId: 8, aura: "none" },
    guestMatch: {
      ...original.hostMatch,
      emojiId: 7,
      aura: "rainbow",
      fen: "different-fen",
      status: "active",
    },
  };
  let reads = 0;
  const h = harness({
    load: async () => (++reads === 1 ? original : refreshed),
  });
  await h.select("a");
  const selected = h.viewer.getSelection();
  assert.equal(required(selected).game, original.model);
  assert.equal(required(required(selected).pair.hostMatch).emojiId, 7);
  assert.equal(required(required(selected).pair.guestMatch).emojiId, 8);
  assert.equal(required(required(selected).pair.hostMatch).aura, "rainbow");
  assert.equal(
    required(required(selected).pair.hostMatch).fen,
    original.hostMatch.fen,
  );
  assert.equal(
    required(required(selected).pair.hostMatch).status,
    "surrendered",
  );
  assert.deepEqual(h.waits, [250]);
});

test("short-history refresh prefers tracking length, then turn, then recorded moves", async (t) => {
  /** @type {Array<[Game, number]>} */
  const choices = [
    [game(2, 1), 2],
    [game(1, 5), 2],
    [game(1, 4), 3],
  ];
  for (const [model, recordedMoves] of choices) {
    await t.test(
      `${required(model).trackingEntries.length}/${required(model).turnNumber}/${recordedMoves}`,
      async () => {
        const original = pair("a", game(1, 4));
        const refreshed = { ...pair("a", model, 9), recordedMoves };
        let reads = 0;
        const h = harness({
          load: async () => (++reads === 1 ? original : refreshed),
        });
        await h.select("a");
        assert.equal(required(h.viewer.getSelection()).game, model);
        assert.equal(required(h.viewer.getSelection()).pair, refreshed);
      },
    );
  }
});

test("invalidation during the short-history wait prevents the forced archive read", async () => {
  /** @type {Pick<PromiseWithResolvers<void>, "promise" | "resolve">} */
  const pause = deferred();
  const h = harness({
    load: async () => pair("a", game(1)),
    wait: () => pause.promise,
  });
  const request = h.begin();
  const pending = h.viewer.loadSelection(request, "a", online);
  await flush();
  h.viewer.clearSelection();
  pause.resolve();
  assert.equal(await pending, null);
  assert.deepEqual(h.reads, ["a"]);
});

test("missing history retries once and respects the existing miss cooldown", async () => {
  const h = harness({ load: async () => null });
  assert.equal(await h.select("a"), null);
  assert.deepEqual(h.reads, ["a", "a"]);
  assert.equal(await h.select("a"), null);
  assert.deepEqual(h.reads, ["a", "a"]);
  h.advance(3000);
  assert.equal(await h.select("a"), null);
  assert.deepEqual(h.reads, ["a", "a", "a", "a"]);
});

test("reset rejects pending data and cancels archive timers without retaining selection or scores", async () => {
  const pending = deferred();
  const h = harness({ load: () => pending.promise });
  h.viewer.seedProvisional(pair());
  const request = h.begin();
  const cached = h.viewer.getCachedSelection("a");
  h.viewer.commitSelection(request, required(cached));
  h.viewer.refreshSelectedArchive(
    () => true,
    () => assert.fail("unexpected archive update"),
    (error) => assert.fail(error instanceof Error ? error : String(error)),
  );
  h.viewer.setScore("a", { white: 7, black: 2 });
  const loading = h.viewer.loadSelection(request, "a", online);
  h.viewer.reset();
  pending.resolve(pair());
  assert.equal(await loading, null);
  assert.equal(h.viewer.getSelection(), null);
  assert.equal(h.viewer.getCachedSelection("a"), null);
  assert.equal(h.viewer.getScore("a"), undefined);
  assert.equal(h.timers.size, 0);
});

test("local series snapshots preserve game, variant, scores, orientation, and resignation", async () => {
  const h = harness();
  h.viewer.ensureLocalSeries();
  const first = h.viewer.getLocalSeriesDescriptor();
  assert.equal(required(first).inviteId, "local-1");
  assert.equal(required(first).activeMatchId, "local-1");
  assert.equal(required(first).hasSeries, false);
  const firstGame = game(3, 8, "local-fen");
  h.viewer.advanceLocalSeries({
    gameVariant: "SwappedManaRows",
    gameModel: firstGame,
    boardFlipped: true,
    resignedColor: "black",
  });
  const descriptor = h.viewer.getLocalSeriesDescriptor();
  assert.equal(required(descriptor).activeMatchId, "local-11");
  assert.equal(required(descriptor).hasSeries, true);
  assert.deepEqual(
    required(descriptor).matches.map((match) => [
      match.index,
      match.isActiveMatch,
    ]),
    [
      [0, false],
      [1, true],
    ],
  );
  const snapshot = h.viewer.getLocalSnapshot("local-1");
  assert.equal(required(snapshot).gameModel, firstGame);
  assert.equal(required(snapshot).gameVariant, "SwappedManaRows");
  assert.equal(required(snapshot).boardFlipped, true);
  assert.equal(required(snapshot).resignedColor, "black");
  assert.deepEqual(h.viewer.getScore("local-1"), { white: 3, black: 4 });
  assert.equal(h.viewer.getScore("local-11"), undefined);
  const request = h.begin();
  const selected = await h.viewer.loadSelection(request, "local-1", {
    online: false,
    localPlayerUid: "signed-in",
  });
  assert.equal(required(selected).game, firstGame);
  assert.equal(required(selected).pair.hostPlayerId, "signed-in");
  assert.equal(
    required(required(selected).pair.hostMatch).gameVariant,
    "SwappedManaRows",
  );
  assert.equal(required(required(selected).pair.hostMatch).fen, "local-fen");
  assert.equal(required(required(selected).pair.hostMatch).color, "black");
  assert.equal(
    required(required(selected).pair.hostMatch).status,
    "surrendered",
  );
  assert.equal(h.viewer.commitSelection(request, required(selected)), true);
  assert.deepEqual(h.reads, []);
});

test("local reset preserves the monotonic series seed and clears old snapshots", () => {
  const h = harness();
  h.viewer.advanceLocalSeries({
    gameVariant: "SwappedManaRows",
    gameModel: game(),
    boardFlipped: false,
    resignedColor: null,
  });
  h.viewer.resetLocalSeries();
  assert.equal(h.viewer.getLocalSnapshot("local-1"), null);
  assert.equal(h.viewer.getLocalSeriesDescriptor(), null);
  h.viewer.ensureLocalSeries();
  assert.equal(
    required(h.viewer.getLocalSeriesDescriptor()).inviteId,
    "local-2",
  );
  h.viewer.reset();
  h.viewer.ensureLocalSeries();
  assert.equal(
    required(h.viewer.getLocalSeriesDescriptor()).inviteId,
    "local-3",
  );
});

test("score prefetch uses the shared history cache and publishes actual score changes", async () => {
  const h = harness();
  let changes = 0;
  assert.equal(
    await h.viewer.prefetchScores("live", ["a", "b"], () => changes++),
    true,
  );
  assert.equal(changes, 2);
  assert.deepEqual(h.viewer.getScore("b"), { white: 3, black: 4 });
  await h.select("a");
  assert.deepEqual(h.reads, ["a", "b"]);
});
