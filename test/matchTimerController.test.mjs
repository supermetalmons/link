import { required } from "./fixtures/canonicalData.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import {
  MATCH_TIMER_DURATION_SECONDS,
  MATCH_TIMER_TERMINAL,
  formatMatchTimer,
} from "@mons/shared/timers";
import { createMatchTimerHarness } from "./fixtures/matchTimerHarness.mjs";

const timer = (turn = 4, deadline = 10_500) => formatMatchTimer(turn, deadline);

test("timer stashes follow the inactive color and never cross matches", () => {
  const h = createMatchTimerHarness();
  h.controller.seed("match", [
    { color: "white", timer: timer() },
    { color: "black", timer: timer(4, 20_000) },
  ]);
  assert.equal(h.controller.restore(), true);
  assert.deepEqual(h.events[0], ["countdown", "white", 9]);
  h.context.activeColor = "white";
  h.events.length = 0;
  assert.equal(h.controller.restore(), true);
  assert.deepEqual(h.events[0], ["countdown", "black", 19]);
  h.context.activeMatchId = "next";
  h.events.length = 0;
  assert.equal(h.controller.restore(), false);
  assert.deepEqual(h.events, []);
  h.controller.setStash("next", "white", timer());
  h.context.activeColor = "black";
  assert.equal(h.controller.restore(), true);
  h.context.activeColor = "white";
  assert.equal(h.controller.restore(), false);
});

test("pair hydration fills missing stashes without replacing newer snapshots", () => {
  const h = createMatchTimerHarness();
  h.controller.setStash("match", "white", timer(4, 30_000));
  h.controller.seed("match", [
    { color: "white", timer: timer() },
    null,
    { color: "black", timer: timer() },
  ]);
  h.controller.restore();
  assert.deepEqual(h.events[0], ["countdown", "white", 29]);
});

for (const mode of ["isReconnect", "isWatchOnly"]) {
  test(`${mode} waits for both stashes without displaying fallback controls`, () => {
    const h = createMatchTimerHarness({ [mode]: true });
    h.controller.update(true, { color: "white", timer: timer() }, "match");
    assert.equal(h.controller.waitsForStashes(), true);
    assert.equal(h.controller.restore(), false);
    assert.deepEqual(h.events, []);
    h.controller.update(
      true,
      { color: "black", timer: { state: "idle" } },
      "match",
    );
    assert.equal(h.controller.waitsForStashes(), false);
    assert.deepEqual(h.events[0], ["countdown", "white", 9]);
    assert.equal(h.timers.size, mode === "isWatchOnly" ? 0 : 1);
  });
}

test("historical and waiting views defer terminal delivery until active restoration", () => {
  const h = createMatchTimerHarness({ boardViewMode: "historicalView" });
  h.controller.update(
    true,
    { color: "white", timer: MATCH_TIMER_TERMINAL },
    "match",
  );
  assert.deepEqual(h.events, []);
  h.context.boardViewMode = "waitingLive";
  assert.equal(h.controller.restore(), false);
  assert.deepEqual(h.events, []);
  h.context.boardViewMode = "activeLive";
  assert.equal(h.controller.restore(), true);
  assert.deepEqual(h.events, [["terminal", true, "white"]]);
  h.events.length = 0;
  h.controller.restore();
  assert.deepEqual(h.events, [["terminal", false, "white"]]);
});

test("live snapshots update history in the background and restore the latest countdown", () => {
  const h = createMatchTimerHarness({ boardViewMode: "historicalView" });
  h.controller.update(false, { color: "white", timer: timer() }, "match");
  h.advance(2_000);
  h.controller.update(
    false,
    { color: "white", timer: timer(4, 20_000) },
    "match",
  );
  assert.deepEqual(h.events, []);
  h.context.boardViewMode = "activeLive";
  h.controller.restore();
  assert.deepEqual(h.events[0], ["countdown", "white", 17]);
});

test("cooldown preserves elapsed progress within a match and turn and resets across either boundary", () => {
  const h = createMatchTimerHarness();
  h.controller.restoreCooldown("match");
  assert.deepEqual(h.events.pop(), [
    "progress",
    0,
    MATCH_TIMER_DURATION_SECONDS,
    true,
  ]);
  h.advance(3_500);
  h.context.boardViewMode = "historicalView";
  h.context.boardViewMode = "activeLive";
  h.controller.restoreCooldown("match");
  assert.deepEqual(h.events.pop(), [
    "progress",
    3.5,
    MATCH_TIMER_DURATION_SECONDS,
    true,
  ]);
  h.context.turnNumber++;
  h.controller.restoreCooldown("match");
  assert.deepEqual(h.events.pop(), [
    "progress",
    0,
    MATCH_TIMER_DURATION_SECONDS,
    true,
  ]);
  h.advance(2_000);
  h.controller.restoreCooldown("next");
  assert.deepEqual(h.events.pop(), [
    "progress",
    0,
    MATCH_TIMER_DURATION_SECONDS,
    true,
  ]);
  h.advance(500_000);
  h.controller.restoreCooldown("next");
  assert.deepEqual(h.events.pop(), [
    "progress",
    MATCH_TIMER_DURATION_SECONDS,
    MATCH_TIMER_DURATION_SECONDS,
    true,
  ]);
  h.setNow(0);
  h.controller.restoreCooldown("next");
  assert.deepEqual(h.events.pop(), [
    "progress",
    0,
    MATCH_TIMER_DURATION_SECONDS,
    true,
  ]);
});

test("countdown rounds down, honors supplied duration, and enables a current victory claim", () => {
  const h = createMatchTimerHarness();
  assert.equal(
    h.controller.showCountdown(false, timer(), "white", 4_500),
    true,
  );
  assert.deepEqual(h.events, [
    ["countdown", "white", 4],
    [
      "progress",
      MATCH_TIMER_DURATION_SECONDS - 4,
      MATCH_TIMER_DURATION_SECONDS,
      false,
    ],
  ]);
  const pending = [...h.timers.values()][0];
  assert.equal(required(pending).delay, 4_000);
  h.advance(4_000);
  required(pending).run();
  assert.deepEqual(h.events.at(-1), ["claim"]);
  assert.equal(h.timers.size, 0);
  h.controller.showCountdown(false, timer(4, 1_000), "white");
  assert.deepEqual(h.events.at(-2), ["countdown", "white", 0]);
});

test("claim controls use context updated synchronously by countdown presentation", () => {
  for (const flag of /** @type {const} */ ([
    "isWatchOnly",
    "isPlayerSideTurn",
  ])) {
    for (const initiallyBlocked of [false, true]) {
      /** @type {ReturnType<typeof createMatchTimerHarness>} */
      let h;
      h = createMatchTimerHarness(
        { [flag]: initiallyBlocked },
        undefined,
        ([event]) => {
          if (event === "countdown") {
            h.context[flag] = !initiallyBlocked;
          }
        },
      );
      h.controller.showCountdown(false, timer(), "white");
      assert.equal(h.timers.size, initiallyBlocked ? 1 : 0);
      assert.equal(
        h.events.some(([event]) => event === "progress"),
        initiallyBlocked,
      );
    }
  }
});

for (const [
  name,
  invalidate,
] of /** @type {[string, (h: ReturnType<typeof createMatchTimerHarness>) => void][]} */ ([
  ["match", (h) => (h.context.activeMatchId = "next")],
  ["session", (h) => h.invalidateSession()],
  ["turn", (h) => h.context.turnNumber++],
  ["historical view", (h) => (h.context.boardViewMode = "historicalView")],
  ["waiting view", (h) => (h.context.boardViewMode = "waitingLive")],
  [
    "reconnect",
    (h) => Object.assign(h.context, { isReconnect: true, didConnect: false }),
  ],
  ["game over", (h) => (h.context.isGameOver = true)],
  ["spectator", (h) => (h.context.isWatchOnly = true)],
  ["player turn", (h) => (h.context.isPlayerSideTurn = true)],
])) {
  test(`a pending claim cannot affect a changed ${name}`, () => {
    const h = createMatchTimerHarness();
    h.controller.showCountdown(false, timer(), "white");
    const pending = [...h.timers.values()][0];
    h.events.length = 0;
    required(invalidate)(h);
    required(pending).run();
    assert.deepEqual(h.events, []);
  });
}

test("malformed and wrong-turn payloads hide controls instead of starting fallback cooldown", () => {
  for (const payload of ["malformed", "4;not-a-time", timer(3)]) {
    const h = createMatchTimerHarness();
    h.controller.showCountdown(false, timer(), "white");
    h.events.length = 0;
    Reflect.apply(h.controller.update, h.controller, [
      false,
      { color: "white", timer: payload },
      "match",
    ]);
    assert.deepEqual(h.events, [["hideButtons"], ["hideCountdown"]]);
    assert.equal(h.timers.size, 0);
  }
});

test("empty stashes choose cooldown only for a live opponent turn without a terminal result", () => {
  const h = createMatchTimerHarness();
  h.controller.update(
    false,
    { color: "white", timer: { state: "idle" } },
    "match",
  );
  assert.deepEqual(h.events, [
    ["progress", 0, MATCH_TIMER_DURATION_SECONDS, true],
  ]);
  for (const flag of [
    "isGameOver",
    "hasWinner",
    "hasTimerWinner",
    "isPlayerSideTurn",
  ]) {
    const hidden = createMatchTimerHarness({ [flag]: true });
    hidden.controller.update(
      false,
      { color: "white", timer: { state: "idle" } },
      "match",
    );
    assert.deepEqual(hidden.events, [["hideButtons"], ["hideCountdown"]]);
  }
  const spectator = createMatchTimerHarness({ isWatchOnly: true });
  spectator.controller.seed("match", [
    { color: "white", timer: { state: "idle" } },
    { color: "black", timer: { state: "idle" } },
  ]);
  spectator.controller.update(
    false,
    { color: "white", timer: { state: "idle" } },
    "match",
  );
  assert.deepEqual(spectator.events, [["hideButtons"], ["hideCountdown"]]);
});

test("match selection respects active match, retained invite membership, and local fallback", () => {
  const h = createMatchTimerHarness({
    activeMatchId: null,
    fallbackMatchId: "local",
  });
  assert.equal(h.controller.getMatchId(), null);
  assert.equal(h.controller.getMatchId("preferred"), "preferred");
  h.controller.setStash("old", "white", timer());
  assert.equal(h.controller.getMatchId(), "old");
  h.allowMatches("other");
  assert.equal(h.controller.getMatchId(), null);
  h.context.activeMatchId = "active";
  assert.equal(h.controller.getMatchId(), "active");
  h.context.activeMatchId = null;
  h.context.isOnlineGame = false;
  assert.equal(h.controller.getMatchId(), "old");
  h.controller.reset(null);
  assert.equal(h.controller.getMatchId(), "local");
});

test("reset clears stashes, deferred resolution, cooldown and claim work without late effects", () => {
  const h = createMatchTimerHarness();
  h.controller.showCountdown(false, timer(), "white");
  const pending = [...h.timers.values()][0];
  h.context.boardViewMode = "historicalView";
  h.controller.update(
    true,
    { color: "white", timer: MATCH_TIMER_TERMINAL },
    "match",
  );
  h.controller.startCooldown("match");
  h.advance(2_000);
  h.controller.reset(null);
  assert.equal(h.timers.size, 0);
  h.events.length = 0;
  required(pending).run();
  h.context.boardViewMode = "activeLive";
  assert.equal(h.controller.restore(), false);
  assert.deepEqual(h.events, []);
  h.controller.restoreCooldown("match");
  assert.deepEqual(h.events.pop(), [
    "progress",
    0,
    MATCH_TIMER_DURATION_SECONDS,
    true,
  ]);
  h.controller.setStash("match", "white", MATCH_TIMER_TERMINAL);
  h.controller.restore();
  assert.deepEqual(h.events.pop(), ["terminal", false, "white"]);
});

test("replaced and canceled claim callbacks cannot clear or enable a newer claim", () => {
  const h = createMatchTimerHarness();
  h.controller.showCountdown(false, timer(), "white");
  const old = [...h.timers.values()][0];
  h.controller.showCountdown(false, timer(4, 15_000), "white");
  const current = [...h.timers.values()][0];
  h.events.length = 0;
  required(old).run();
  assert.deepEqual(h.events, []);
  assert.equal(h.timers.size, 1);
  h.controller.cancelVictoryClaim();
  assert.equal(h.timers.size, 0);
  required(current).run();
  assert.deepEqual(h.events, []);
});
