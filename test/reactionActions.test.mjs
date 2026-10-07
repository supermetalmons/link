import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { STICKER_ID_WHITELIST } from "@mons/shared/reactions";

const { outputText } = ts.transpileModule(
  readFileSync(
    new URL("../src/ui/controls/useReactionActions.ts", import.meta.url),
    "utf8",
  ),
  {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
    },
  },
);

function fixture({ isVisible = true, allowed = true } = {}) {
  const events = [];
  const timers = [];
  const state = {
    context: { isGameWithBot: false, puzzleMode: false },
    epoch: 0,
    flipped: false,
    sendError: null,
    entitlementError: null,
  };
  let now = 0;
  let nextReaction = 0;
  const modules = {
    react: { useCallback: (callback) => callback },
    "@mons/shared/reactions": { STICKER_ID_WHITELIST },
    "../../connection/connection": {
      connection: {
        createSessionGuard() {
          events.push(["guard"]);
          const epoch = state.epoch;
          return () => epoch === state.epoch;
        },
        sendVoiceReaction(reaction) {
          events.push(["send", reaction]);
          if (state.sendError) throw state.sendError;
        },
      },
    },
    "../../content/sounds": {
      newReactionOfKind(kind) {
        const reaction = { kind, uuid: ++nextReaction };
        events.push(["createVoice", reaction]);
        return reaction;
      },
      newStickerReaction(id) {
        const reaction = {
          kind: "sticker",
          variation: id,
          uuid: ++nextReaction,
        };
        events.push(["createSticker", reaction]);
        return reaction;
      },
      playReaction: (reaction) => events.push(["voice", reaction]),
      playSounds: (sounds) => events.push(["sounds", sounds]),
    },
    "../../game/gameControlsStore": {
      getGameControlsSnapshot: () => ({ context: state.context }),
    },
    "../../utils/gameModels": {
      Sound: { EmoteSent: "sent", EmoteReceived: "received" },
    },
    "./boardReactionPort": {
      isMetadataSideDisplayedAtOpponentSlot: (opponent) =>
        state.flipped ? !opponent : opponent,
      showVideoReaction: (opponent, id) =>
        events.push(["sticker", opponent, id]),
      showVoiceReactionText: (reaction, opponent) =>
        events.push(["text", reaction, opponent]),
    },
  };
  const exports = {};
  const math = Object.create(Math);
  math.random = () => {
    events.push(["random"]);
    return 0.5;
  };
  new Function("exports", "require", "Math", outputText)(
    exports,
    (specifier) => {
      assert.ok(Object.hasOwn(modules, specifier), specifier);
      return modules[specifier];
    },
    math,
  );
  const actions = exports.useReactionActions({
    isVisible,
    canSendSticker(id) {
      events.push(["entitlement", id]);
      if (state.entitlementError) throw state.entitlementError;
      return allowed;
    },
    dismissPicker: () => events.push(["dismiss"]),
    setDisabled: (disabled) => events.push(["disabled", disabled]),
    setMatchScopedTimeout(callback, delay) {
      events.push(["schedule", delay]);
      timers.push({ callback, at: now + delay });
      return timers.length;
    },
  });
  return {
    ...actions,
    state,
    events,
    advance(ms) {
      now += ms;
      for (const timer of timers) {
        if (!timer.fired && timer.at <= now) {
          timer.fired = true;
          timer.callback();
        }
      }
    },
  };
}

test("hidden reactions dismiss without reading sticker entitlements or presenting anything", () => {
  const h = fixture({ isVisible: false });
  h.handleStickerSelect(1);
  h.handleReactionSelect("yo");
  assert.deepEqual(h.events, [["dismiss"], ["dismiss"]]);
});

test("sticker entitlement rejection dismisses, while a synchronous entitlement error propagates", () => {
  const h = fixture({ allowed: false });
  h.handleStickerSelect(1);
  assert.deepEqual(h.events, [["entitlement", 1], ["dismiss"]]);
  h.events.length = 0;
  h.state.entitlementError = new Error("identity unavailable");
  assert.throws(() => h.handleStickerSelect(1), h.state.entitlementError);
  assert.deepEqual(h.events, [["entitlement", 1]]);
});

test("network stickers preserve presentation order and the 9999ms cooldown", () => {
  const h = fixture();
  h.state.flipped = true;
  h.handleStickerSelect(1);
  const reaction = { kind: "sticker", variation: 1, uuid: 1 };
  assert.deepEqual(h.events, [
    ["entitlement", 1],
    ["dismiss"],
    ["sticker", true, 1],
    ["sounds", ["sent"]],
    ["createSticker", reaction],
    ["send", reaction],
    ["disabled", true],
    ["schedule", 9999],
  ]);
  h.advance(9998);
  assert.deepEqual(h.events.at(-1), ["schedule", 9999]);
  h.advance(1);
  assert.deepEqual(h.events.at(-1), ["disabled", false]);
});

test("network voice reactions send the same object that was played locally", () => {
  const h = fixture();
  h.handleReactionSelect("yo");
  const reaction = { kind: "yo", uuid: 1 };
  assert.deepEqual(h.events, [
    ["dismiss"],
    ["createVoice", reaction],
    ["voice", reaction],
    ["text", "yo", false],
    ["send", reaction],
    ["disabled", true],
    ["schedule", 9999],
  ]);
  assert.equal(h.events[2][1], h.events[4][1]);
});

test("current puzzle mode keeps both reaction kinds local without generating a sticker payload", () => {
  const h = fixture();
  h.state.context.puzzleMode = true;
  h.handleStickerSelect(1);
  h.handleReactionSelect("yo");
  assert.deepEqual(h.events, [
    ["entitlement", 1],
    ["dismiss"],
    ["sticker", false, 1],
    ["sounds", ["sent"]],
    ["dismiss"],
    ["createVoice", { kind: "yo", uuid: 1 }],
    ["voice", { kind: "yo", uuid: 1 }],
    ["text", "yo", false],
  ]);
});

test("bot stickers choose a reply immediately and resolve its current display side after 5000ms", () => {
  const h = fixture();
  h.state.context = { isGameWithBot: true, puzzleMode: true };
  h.handleStickerSelect(1);
  assert.deepEqual(h.events, [
    ["entitlement", 1],
    ["dismiss"],
    ["sticker", false, 1],
    ["sounds", ["sent"]],
    ["guard"],
    ["random"],
    ["schedule", 5000],
  ]);
  h.events.length = 0;
  h.state.flipped = true;
  h.advance(4999);
  assert.deepEqual(h.events, []);
  h.advance(1);
  assert.deepEqual(h.events, [
    [
      "sticker",
      false,
      STICKER_ID_WHITELIST[Math.floor(STICKER_ID_WHITELIST.length / 2)],
    ],
    ["sounds", ["received"]],
  ]);
});

test("bot voice replies create their own variation before scheduling and play after 2000ms", () => {
  const h = fixture();
  h.state.context.isGameWithBot = true;
  h.handleReactionSelect("yo");
  assert.deepEqual(h.events, [
    ["dismiss"],
    ["createVoice", { kind: "yo", uuid: 1 }],
    ["voice", { kind: "yo", uuid: 1 }],
    ["text", "yo", false],
    ["guard"],
    ["createVoice", { kind: "yo", uuid: 2 }],
    ["schedule", 2000],
  ]);
  const reply = h.events[5][1];
  h.events.length = 0;
  h.advance(1999);
  assert.deepEqual(h.events, []);
  h.advance(1);
  assert.deepEqual(h.events, [
    ["voice", reply],
    ["text", "yo", true],
  ]);
  assert.equal(h.events[0][1], reply);
});

for (const kind of ["sticker", "voice"]) {
  test(`${kind} bot replies cannot reach a different session`, () => {
    const h = fixture();
    h.state.context.isGameWithBot = true;
    if (kind === "sticker") h.handleStickerSelect(1);
    else h.handleReactionSelect("yo");
    h.events.length = 0;
    h.state.epoch++;
    h.advance(5000);
    assert.deepEqual(h.events, []);
  });

  test(`${kind} synchronous send failures propagate without starting a cooldown`, () => {
    const h = fixture();
    h.state.sendError = new Error("send failed");
    assert.throws(
      () =>
        kind === "sticker"
          ? h.handleStickerSelect(1)
          : h.handleReactionSelect("yo"),
      h.state.sendError,
    );
    assert.equal(h.events.at(-1)[0], "send");
    h.events.length = 0;
    h.advance(9999);
    assert.deepEqual(h.events, []);
  });
}
