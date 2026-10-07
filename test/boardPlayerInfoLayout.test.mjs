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

const {
  emptyTextMeasurement,
  getBoardPlayerInfoLayout,
  getWagerSlotLayoutForName,
  mergePlayerInfoMeasurements,
  playerInfoSlotHasNameReaction,
  playerInfoSlotHasVisibleName,
} = await import("../src/ui/boardPlayerInfoLayout.ts");

const slot = (overrides = {}) => ({
  visible: true,
  nameVisible: true,
  scoreText: "12",
  nameText: "Moss",
  nameReactionText: "",
  timerText: "00:42",
  timerVisible: false,
  timerColor: "green",
  endOfGameMarker: "none",
  profileMetadataIsOpponent: false,
  ...overrides,
});

const state = (overrides = {}) => ({
  player: slot(),
  opponent: slot({ scoreText: "8", nameText: "Luna" }),
  topControlSlot: "opponent",
  botStrengthControlVisible: false,
  botStrengthControlMode: "normal",
  wagerLayoutRevision: 0,
  ...overrides,
});

const measurements = (overrides = {}) => ({
  playerScore: emptyTextMeasurement,
  opponentScore: emptyTextMeasurement,
  playerTimer: emptyTextMeasurement,
  opponentTimer: emptyTextMeasurement,
  playerName: emptyTextMeasurement,
  opponentName: emptyTextMeasurement,
  ...overrides,
});

const layout = ({
  overlayState = state(),
  measured = measurements(),
  size = null,
  narrow = false,
  pangchiu = false,
} = {}) =>
  getBoardPlayerInfoLayout(
    overlayState,
    measured,
    { victory: "victory.webp", resign: "resign.webp" },
    size,
    narrow,
    pangchiu,
  );

const coordinates = (value) => [
  value.scoreX,
  value.scoreY,
  value.timerX,
  value.timerY,
  value.nameX,
  value.nameY,
  value.scoreFontSize,
  value.nameFontSize,
];

test("unmeasured and small boards retain the original player-info geometry", () => {
  for (const width of [null, 0, 320, 420]) {
    const result = layout({
      size: width === null ? null : { width, height: 410 },
    });
    assert.deepEqual(
      coordinates(result.player),
      [0.94017, 12.72721, 1.4374500000000001, 12.72721, 1.55, 12.66505, 50, 32],
    );
    assert.deepEqual(
      coordinates(result.opponent),
      [
        0.94017, 0.6324789999999999, 1.4374500000000001, 0.6324789999999999,
        1.55, 0.5703189999999999, 50, 32,
      ],
    );
    assert.deepEqual(result.inviteBotButtonLayout, {
      x: 1.1201699999999999,
      y: 0.0925989999999999,
      width: 2.49,
      height: 0.68376,
      fontSizePx: 34,
      horizontalPaddingPx: 31,
    });
  }
});

test("narrow and large picture boards preserve their offsets and scaling", () => {
  const narrow = layout({ size: { width: 390, height: 500 }, narrow: true });
  assert.deepEqual(
    coordinates(narrow.player),
    [1.15017, 12.72721, 1.64745, 12.72721, 1.76, 12.66505, 50, 32],
  );
  assert.deepEqual(
    coordinates(narrow.opponent),
    [
      1.15017, 0.6324789999999999, 1.64745, 0.6324789999999999, 1.76,
      0.5703189999999999, 50, 32,
    ],
  );
  assert.equal(narrow.inviteBotButtonLayout.x, 1.3301699999999999);

  const wide = layout({ size: { width: 840, height: 1000 }, pangchiu: true });
  assert.deepEqual(
    coordinates(wide.player),
    [
      0.470085, 13.033605, 0.7187250000000001, 13.033605, 0.825, 13.002525, 25,
      16,
    ],
  );
  assert.deepEqual(
    coordinates(wide.opponent),
    [
      0.470085, 0.8162394999999999, 0.7187250000000001, 0.8162394999999999,
      0.825, 0.7851594999999999, 25, 16,
    ],
  );
  assert.deepEqual(wide.inviteBotButtonLayout, {
    x: 0.5600849999999999,
    y: 0.5462994999999999,
    width: 1.235,
    height: 0.34188,
    fontSizePx: 17,
    horizontalPaddingPx: 15,
  });
});

const terminalState = () =>
  state({
    player: slot({ timerVisible: true, endOfGameMarker: "victory" }),
    opponent: slot({ timerVisible: true, endOfGameMarker: "resign" }),
  });

const terminalMeasurements = () =>
  measurements({
    playerScore: { width: 1.4, bounds: { y: 12.1, height: 0.6 } },
    opponentScore: { width: 1.1, bounds: null },
    playerTimer: { width: 1.8, bounds: null },
    opponentTimer: { width: 1.2, bounds: null },
  });

test("timers and result markers preserve measured and fallback placement", () => {
  const result = layout({
    overlayState: terminalState(),
    measured: terminalMeasurements(),
  });
  assert.equal(result.player.nameX, 3.37745);
  assert.equal(result.opponent.nameX, 3.04);
  assert.deepEqual(result.player.endOfGameIcon, {
    visible: true,
    href: "victory.webp",
    x: 2.4001699999999997,
    y: 12.135,
    size: 0.53,
  });
  assert.deepEqual(result.opponent.endOfGameIcon, {
    visible: true,
    href: "resign.webp",
    x: 2.10017,
    y: 0.20847899999999986,
    size: 0.53,
  });
});

test("bot and reaction spacing follows the top control slot on either side", () => {
  const expected = {
    player: {
      names: [3.9932103359999997, 3.04],
      iconX: 3.224810336,
      botX: 2.47517,
      botY: 12.184389831999999,
    },
    opponent: {
      names: [3.37745, 3.693210336],
      iconX: 2.924810336,
      botX: 2.17517,
      botY: 0.08965883199999994,
    },
  };
  for (const side of ["player", "opponent"]) {
    const overlayState = terminalState();
    overlayState.topControlSlot = side;
    overlayState.botStrengthControlVisible = true;
    overlayState.botStrengthControlMode = "pro";
    overlayState[side].nameReactionText = "Wow!";
    const result = layout({ overlayState, measured: terminalMeasurements() });
    assert.deepEqual(
      [result.player.nameX, result.opponent.nameX],
      expected[side].names,
    );
    assert.equal(result[side].endOfGameIcon.x, expected[side].iconX);
    assert.deepEqual(result.botStrengthControlOverlay, {
      visible: true,
      mode: "pro",
      x: expected[side].botX,
      y: expected[side].botY,
      size: 0.689640336,
    });
  }
});

test("hidden result markers still reserve name space", () => {
  for (const overrides of [{ visible: false }, { scoreText: "" }]) {
    const result = layout({
      overlayState: state({
        player: slot({ endOfGameMarker: "victory", ...overrides }),
      }),
    });
    assert.equal(result.player.nameX, 2.09);
    assert.deepEqual(result.player.endOfGameIcon, {
      visible: false,
      href: "",
      x: 0,
      y: 0,
      size: 0.53,
    });
  }
});

test("normal and winner wagers retain their size and board-edge clamping", () => {
  const result = layout();
  const wager = (side, width) =>
    getWagerSlotLayoutForName(
      result[side],
      { width, bounds: null },
      null,
      true,
    );
  assert.deepEqual(wager("player", 2), {
    pile: {
      x: 3.6799999999999997,
      y: 12.0369232,
      w: 0.8391600000000001,
      h: 0.73038,
    },
    winner: {
      x: 3.6799999999999997,
      y: 11.827568537560001,
      w: 1.118852028,
      h: 0.973815654,
    },
  });
  assert.deepEqual(wager("player", 30), {
    pile: { x: 10.16084, y: 12.0369232, w: 0.8391600000000001, h: 0.73038 },
    winner: {
      x: 9.881147972,
      y: 11.827568537560001,
      w: 1.118852028,
      h: 0.973815654,
    },
  });
  assert.deepEqual(wager("opponent", 2), {
    pile: { x: 3.6799999999999997, y: 0, w: 0.8391600000000001, h: 0.73038 },
    winner: { x: 3.6799999999999997, y: 0, w: 1.118852028, h: 0.973815654 },
  });
  const size = { width: 840, height: 1000 };
  assert.deepEqual(
    getWagerSlotLayoutForName(
      layout({ size }).player,
      { width: 2, bounds: null },
      size,
      true,
    ),
    {
      pile: { x: 2.89, y: 12.0984616, w: 0.41958000000000006, h: 0.36519 },
      winner: { x: 2.89, y: 11.99378426878, w: 0.559426014, h: 0.486907827 },
    },
  );
});

test("name visibility keeps its existing semantics and shared hidden wager layout", () => {
  assert.equal(playerInfoSlotHasVisibleName(slot({ visible: false })), true);
  assert.equal(
    playerInfoSlotHasVisibleName(slot({ nameVisible: false })),
    false,
  );
  assert.equal(playerInfoSlotHasVisibleName(slot({ nameText: "" })), false);
  assert.equal(
    playerInfoSlotHasNameReaction(
      slot({ nameVisible: false, nameReactionText: "Wow!" }),
    ),
    true,
  );
  assert.equal(playerInfoSlotHasNameReaction(slot()), false);
  const result = layout();
  const first = getWagerSlotLayoutForName(
    result.player,
    emptyTextMeasurement,
    null,
    false,
  );
  const second = getWagerSlotLayoutForName(
    result.opponent,
    { width: 20, bounds: null },
    { width: 840, height: 1000 },
    false,
  );
  assert.equal(first, second);
  assert.equal(first.pile, first.winner);
  assert.deepEqual(first, {
    pile: { x: 0, y: 0, w: 0, h: 0 },
    winner: { x: 0, y: 0, w: 0, h: 0 },
  });
});

test("unchanged measurements preserve state identity and changed bounds update it", () => {
  const previous = terminalMeasurements();
  assert.equal(mergePlayerInfoMeasurements(previous, {}), previous);
  assert.equal(
    mergePlayerInfoMeasurements(previous, {
      playerScore: { width: 1.4, bounds: { y: 12.1, height: 0.6 } },
    }),
    previous,
  );
  const next = mergePlayerInfoMeasurements(previous, {
    playerScore: { width: 1.4, bounds: { y: 12.2, height: 0.6 } },
  });
  assert.notEqual(next, previous);
  assert.equal(next.playerScore.bounds.y, 12.2);
  assert.equal(previous.playerScore.bounds.y, 12.1);
  assert.equal(next.opponentScore, previous.opponentScore);
});
