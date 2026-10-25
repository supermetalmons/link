import assert from "node:assert/strict";
import test from "node:test";
import {
  createMatchCreationInput,
  createRestoredMatchCreationInput,
  matchCreationWireValue,
  matchSurrenderHasFen,
  matchSurrenderState,
  matchWireValue,
  normalizeNewMatchDocument,
  readMatchCreationInput,
  readMatchDocument,
  readMoveMatch,
  readRetainedMatchValue,
  readStoredMatchJson,
  storedMatchValue,
  writeMovedMatch,
} from "../src/matchRecordCodec.ts";
import { decideMatchStateMove } from "../src/matchStateLogic.ts";

const request = {
  inviteId: "invite-one",
  matchId: "invite-one",
  playerId: "host-login",
  previousFlatMovesString: "",
  flatMovesString: "a",
  fen: "first",
};

test("stored match reads distinguish absent rows from retained JSON null and preserve provenance", () => {
  const missing = readStoredMatchJson(null, "durable");
  assert.deepEqual(missing, { kind: "missing" });
  assert.equal(storedMatchValue(missing), null);
  for (const source of ["durable", "legacy"] as const) {
    for (const value of [
      null,
      false,
      0,
      "",
      "legacy",
      [],
      { nested: [true, null] },
    ]) {
      const retained = readStoredMatchJson(
        { value_json: JSON.stringify(value) },
        source,
      );
      assert.deepEqual(retained, { kind: "stored", source, value });
      assert.deepEqual(storedMatchValue(retained), value);
    }
  }
  assert.equal(
    storedMatchValue(readStoredMatchJson({ value_json: "1e400" }, "legacy")),
    Infinity,
  );
  assert.throws(
    () => readStoredMatchJson({ value_json: "broken" }, "durable"),
    SyntaxError,
  );
});

test("retained match documents keep identity and expose opaque wire objects without normalizing children", () => {
  const source = { fen: "initial", nested: { retained: [1, null, true] } };
  const document = readRetainedMatchValue(source);
  assert.strictEqual(document, source);
  assert.strictEqual(matchWireValue(document), source);
  assert.deepEqual(Object.getOwnPropertySymbols(source), []);
  const array = [source, null];
  assert.strictEqual(readRetainedMatchValue(array), array);
  assert.equal(readMatchDocument(array), null);
});

test("move views accept minimal records while preserving absent and null history differences", () => {
  const minimal = { fen: "initial" };
  const read = readMoveMatch(minimal);
  assert.deepEqual(read, {
    kind: "playable",
    document: minimal,
    fen: "initial",
    flatMovesString: "",
  });
  assert.deepEqual(readMoveMatch({ ...minimal, flatMovesString: null }), {
    kind: "invalid",
  });
  assert.deepEqual(readMoveMatch(null), { kind: "missing" });
  assert.deepEqual(readMoveMatch(false), { kind: "invalid" });
});

test("moves retain nonempty and non-string stored variants and all unmodified siblings", () => {
  for (const gameVariant of [null, false, 0, [], {}, "Custom"]) {
    const extension = { retained: [true, null] };
    const source = { fen: "initial", gameVariant, extension };
    const next = writeMovedMatch(readMatchDocument(source)!, {
      ...request,
      gameVariant: "Classic",
    });
    assert.deepEqual(next, { ...source, fen: "first", flatMovesString: "a" });
    assert.notStrictEqual(next, source);
    assert.strictEqual(Reflect.get(next, "extension"), extension);
  }
  for (const source of [
    { fen: "initial" },
    { fen: "initial", gameVariant: "" },
  ]) {
    assert.deepEqual(
      writeMovedMatch(readMatchDocument(source)!, {
        ...request,
        gameVariant: "Classic",
      }),
      {
        ...source,
        gameVariant: "Classic",
        fen: "first",
        flatMovesString: "a",
      },
    );
  }
});

test("duplicate and superseded decisions retain source identity without requiring public snapshot fields", () => {
  const source = {
    fen: "second",
    flatMovesString: "a-b",
    extension: { retained: true },
  };
  const replay = decideMatchStateMove(source, {
    ...request,
    fen: "second",
    flatMovesString: "a-b",
  });
  assert.equal(replay.outcome, "already-applied");
  assert.strictEqual(replay.value, source);
  const late = decideMatchStateMove(source, {
    ...request,
    previousStates: [{ moveCount: 0, fen: "initial" }],
  });
  assert.equal(late.outcome, "superseded");
  assert.strictEqual(late.value, source);
});

test("surrender observations preserve raw truthiness and defer FEN access", () => {
  for (const value of [null, false, 0, ""]) {
    assert.deepEqual(matchSurrenderState(value), {
      exists: false,
      surrendered: false,
    });
  }
  for (const value of [true, 1, "legacy", []]) {
    assert.deepEqual(matchSurrenderState(readRetainedMatchValue(value)), {
      exists: true,
      surrendered: false,
    });
  }
  const source = {
    status: "surrendered",
    get fen(): never {
      throw new Error("FEN must not be read for surrender replay");
    },
  };
  assert.deepEqual(matchSurrenderState(readRetainedMatchValue(source)), {
    exists: true,
    surrendered: true,
  });
  assert.throws(
    () => matchSurrenderHasFen(readRetainedMatchValue(source)),
    /FEN must not be read/,
  );
});

test("creation compatibility retains missing, scalar and malformed draft inputs until the store validates them", () => {
  for (const value of [undefined, null, false, 0, "", "legacy", [], {}]) {
    const input = readMatchCreationInput(value);
    assert.strictEqual(matchCreationWireValue(input), value);
  }
  const draft = {
    missing: undefined,
    nonfinite: Infinity,
    nested: { retained: true },
  };
  assert.strictEqual(
    matchCreationWireValue(readMatchCreationInput(draft)),
    draft,
  );
});

test("fresh and restored creation constructors preserve their distinct accepted representations", () => {
  const fresh = {
    version: 2 as const,
    color: "white" as const,
    emojiId: 1,
    aura: null,
    gameVariant: "Classic",
    fen: "initial",
    status: "" as const,
    flatMovesString: "" as const,
    timer: "" as const,
  };
  assert.strictEqual(
    matchCreationWireValue(createMatchCreationInput(fresh)),
    fresh,
  );
  const restored = {
    ...fresh,
    aura: "",
    status: "surrendered",
    flatMovesString: "a-b",
    timer: "gg",
  };
  assert.strictEqual(
    matchCreationWireValue(createRestoredMatchCreationInput(restored)),
    restored,
  );
});

test("new creation normalization retains recursive deletion and numeric-array conversion", () => {
  const source = {
    sessionCreation: "marker",
    aura: null,
    omitted: undefined,
    empty: { omitted: null },
    dense: { "0": "zero", "1": "one" },
    sparse: [null, null, "value"],
    array: [null, { removed: null, retained: true }, null],
  };
  assert.deepEqual(normalizeNewMatchDocument(readMatchDocument(source)!), {
    sessionCreation: "marker",
    dense: ["zero", "one"],
    sparse: { "2": "value" },
    array: [null, { retained: true }],
  });
  assert.equal(Object.hasOwn(source, "omitted"), true);
  assert.deepEqual(source.array, [
    null,
    { removed: null, retained: true },
    null,
  ]);
});
