import assert from "node:assert/strict";
import test from "node:test";
import { deriveBoardViewControls } from "../src/game/boardViewPolicy.ts";

const context = {
  mode: "activeLive",
  isOnlineGame: false,
  isWatchOnly: false,
  isGameWithBot: false,
  isGameOver: false,
  isWaitingForRematchResponse: false,
  isSeriesEnded: false,
};

const controls = (overrides) =>
  deriveBoardViewControls({ ...context, ...overrides });

test("live views preserve end controls and local reaction state", () => {
  for (const isGameWithBot of [false, true]) {
    assert.deepEqual(controls({ isGameWithBot, isSeriesEnded: true }), {
      endMatchVisible: null,
      endMatchConfirmed: null,
      voiceReactionVisible: null,
    });
  }
  for (const isWatchOnly of [false, true]) {
    assert.deepEqual(controls({ isOnlineGame: true, isWatchOnly }), {
      endMatchVisible: null,
      endMatchConfirmed: null,
      voiceReactionVisible: !isWatchOnly,
    });
  }
});

test("waiting keeps end available without changing confirmation", () => {
  for (const isOnlineGame of [false, true]) {
    for (const isWatchOnly of [false, true]) {
      assert.deepEqual(
        controls({
          mode: "waitingLive",
          isOnlineGame,
          isWatchOnly,
          isGameWithBot: true,
          isSeriesEnded: true,
        }),
        {
          endMatchVisible: true,
          endMatchConfirmed: null,
          voiceReactionVisible: isOnlineGame && !isWatchOnly,
        },
      );
    }
  }
});

test("historical participant controls follow terminal and pending state", () => {
  const historical = { mode: "historicalView", isOnlineGame: true };
  assert.deepEqual(controls(historical), {
    endMatchVisible: false,
    endMatchConfirmed: null,
    voiceReactionVisible: true,
  });
  for (const terminal of [
    { isGameOver: true },
    { isWaitingForRematchResponse: true },
  ]) {
    assert.deepEqual(controls({ ...historical, ...terminal }), {
      endMatchVisible: true,
      endMatchConfirmed: null,
      voiceReactionVisible: true,
    });
  }
  assert.deepEqual(controls({ ...historical, isSeriesEnded: true }), {
    endMatchVisible: true,
    endMatchConfirmed: true,
    voiceReactionVisible: true,
  });
});

test("historical spectators and local games do not inherit online end controls", () => {
  for (const role of [
    { isOnlineGame: true, isWatchOnly: true },
    { isOnlineGame: false, isWatchOnly: false },
  ]) {
    assert.deepEqual(
      controls({
        mode: "historicalView",
        ...role,
        isGameOver: true,
        isWaitingForRematchResponse: true,
        isSeriesEnded: true,
      }),
      {
        endMatchVisible: false,
        endMatchConfirmed: null,
        voiceReactionVisible: false,
      },
    );
  }
  assert.deepEqual(controls({ mode: "historicalView", isGameWithBot: true }), {
    endMatchVisible: false,
    endMatchConfirmed: null,
    voiceReactionVisible: true,
  });
});
