import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      context.parentURL?.endsWith(".ts") &&
      (specifier.startsWith("./") || specifier.startsWith("../")) &&
      !/\.[^/]+$/.test(specifier)
    ) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});

const { createMainGameLoadState } =
  await import("../src/game/mainGameLoadState.ts");
const {
  getWagerState,
  hasConfirmedWagerSnapshot,
  resetWagerStore,
  setCurrentWagerMatch,
  setWagerState,
  subscribeToWagerState,
  syncCurrentWagerMatchState,
} = await import("../src/game/wagerState.ts");

function createFrames() {
  let nextId = 0;
  /** @type {Map<number, FrameRequestCallback>} */
  const pending = new Map();
  /**
   * @type {string[]}
   */
  const marks = [];
  const state = createMainGameLoadState({
    requestFrame(callback) {
      pending.set(++nextId, callback);
      return nextId;
    },
    cancelFrame(id) {
      pending.delete(id);
    },
    mark(name) {
      marks.push(name);
    },
  });
  return {
    state,
    pending,
    marks,
    frame() {
      const callbacks = [...pending.values()];
      pending.clear();
      callbacks.forEach((callback) => callback(0));
    },
  };
}

test("route preparation cannot release optional work; game input does not wait for paint", () => {
  const h = createFrames();
  let optionalStarts = 0;
  h.state.onLoaded(() => {
    optionalStarts += 1;
  });
  h.state.markRoutePrepared();
  h.frame();
  h.frame();
  assert.equal(optionalStarts, 0);
  assert.equal(h.state.getSnapshot().contentReady, false);
  h.state.markContentReady(true);
  assert.equal(h.state.getSnapshot().canPlay, true);
  assert.equal(optionalStarts, 0);
  h.frame();
  assert.equal(optionalStarts, 0);
  h.frame();
  assert.equal(optionalStarts, 1);
  h.state.markContentReady(true);
  h.frame();
  assert.equal(optionalStarts, 1);
  assert.deepEqual(h.marks, [
    "main-game:route-prepared",
    "main-game:content-ready",
    "main-game:interaction-ready",
    "main-game:initial-view-ready",
  ]);
});

test("waiting, spectator, finished, and error views settle without reporting playable", () => {
  /** @type {Array<(state: ReturnType<typeof createMainGameLoadState>) => void>} */
  const resolvers = [
    (state) => state.markWaiting(),
    (state) => state.markContentReady(false),
    (state) => state.markError(),
  ];
  for (const resolve of resolvers) {
    const h = createFrames();
    resolve(h.state);
    h.frame();
    h.frame();
    assert.equal(h.state.isLoaded(), true);
    assert.equal(h.state.getSnapshot().canPlay, false);
  }
});

test("teardown cancels old frame callbacks while subscriptions follow the next game", () => {
  const h = createFrames();
  let starts = 0;
  const unsubscribe = h.state.onLoaded(() => {
    starts += 1;
  });
  h.state.markContentReady(true);
  h.frame();
  const staleFrame = [...h.pending.values()][0];
  assert.ok(staleFrame);
  h.state.reset();
  staleFrame(0);
  assert.equal(h.state.isLoaded(), false);
  assert.equal(h.pending.size, 0);
  h.state.markWaiting();
  h.frame();
  h.frame();
  assert.equal(starts, 1);
  unsubscribe();
  h.state.reset();
  h.state.markContentReady(true);
  h.frame();
  h.frame();
  assert.equal(starts, 1);
});

test("wager readiness distinguishes unknown from confirmed-empty and resets with the match", () => {
  resetWagerStore();
  /** @type {boolean[]} */
  const changes = [];
  const unsubscribe = subscribeToWagerState(() => {
    changes.push(hasConfirmedWagerSnapshot());
  });
  setCurrentWagerMatch("match-a");
  assert.equal(getWagerState(), null);
  assert.equal(hasConfirmedWagerSnapshot(), false);
  syncCurrentWagerMatchState("match-a", null, true);
  assert.equal(getWagerState(), null);
  assert.equal(hasConfirmedWagerSnapshot(), true);
  setWagerState("match-a", null);
  assert.equal(hasConfirmedWagerSnapshot(), true);
  syncCurrentWagerMatchState("match-a", null, false);
  setWagerState("match-a", { proposals: {} });
  assert.equal(hasConfirmedWagerSnapshot(), false);
  syncCurrentWagerMatchState("match-a", null, true);
  setCurrentWagerMatch("match-b");
  assert.equal(hasConfirmedWagerSnapshot(), false);
  resetWagerStore();
  assert.equal(hasConfirmedWagerSnapshot(), false);
  assert.ok(changes.includes(true));
  assert.equal(changes.at(-1), false);
  unsubscribe();
});
