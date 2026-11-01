import assert from "node:assert/strict";
import test from "node:test";
import { buildFreshMatchRecord } from "@mons/shared/match-protocol";
import {
  matchDocumentFixture,
  publicMatchFixture,
} from "./matchRecordFixture.ts";
import {
  createMatchCreationInput,
  createRestoredMatchCreationInput,
  matchCreationWireValue,
  matchSurrenderHasFen,
  matchSurrenderState,
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
  inviteId: "invite",
  matchId: "invite",
  playerId: "host",
  previousFlatMovesString: "",
  flatMovesString: "a",
  fen: "first",
};

test("stored match reads preserve complete documents and distinguish missing rows", () => {
  assert.deepEqual(readStoredMatchJson(null, "durable"), { kind: "missing" });
  assert.equal(storedMatchValue(readStoredMatchJson(null, "archive")), null);
  const document = matchDocumentFixture({
    fen: "position",
    timer: "7;1000",
    sessionCreation: "creation",
  });
  for (const source of ["durable", "archive"] as const)
    assert.deepEqual(
      readStoredMatchJson({ value_json: JSON.stringify(document) }, source),
      { kind: "stored", source, value: document },
    );
  for (const value of [
    null,
    false,
    0,
    "",
    [],
    {},
    { fen: "position" },
    { ...document, extra: true },
  ]) {
    assert.throws(
      () =>
        readStoredMatchJson({ value_json: JSON.stringify(value) }, "durable"),
      /match-state-invalid-record/,
    );
    assert.equal(readMatchDocument(value), null);
  }
  assert.equal(readRetainedMatchValue(null), null);
  assert.throws(
    () => readRetainedMatchValue({ fen: "position" }),
    /match-state-invalid-record/,
  );
});

test("moves preserve identity and appearance while enforcing the declared variant", () => {
  const document = matchDocumentFixture({
    fen: "initial",
    sessionCreation: "creation",
  });
  const moved = writeMovedMatch(document, request);
  assert.deepEqual(moved, { ...document, fen: "first", flatMovesString: "a" });
  assert.notStrictEqual(moved, document);
  assert.throws(
    () => writeMovedMatch(document, { ...request, gameVariant: "different" }),
    /game-variant-conflict/,
  );
  assert.deepEqual(readMoveMatch({ fen: "initial" }), { kind: "invalid" });
  assert.deepEqual(readMoveMatch(null), { kind: "missing" });
});

test("duplicate and superseded moves remain idempotent with complete known state", () => {
  const document = matchDocumentFixture({
    fen: "second",
    flatMovesString: "a-b",
  });
  const duplicate = decideMatchStateMove(document, {
    ...request,
    fen: "second",
    flatMovesString: "a-b",
  });
  assert.equal(duplicate.outcome, "already-applied");
  assert.deepEqual(duplicate.value, document);
  const superseded = decideMatchStateMove(document, {
    ...request,
    previousStates: [{ moveCount: 0, fen: "initial" }],
  });
  assert.equal(superseded.outcome, "superseded");
  assert.deepEqual(superseded.value, document);
});

test("creation builders make internal evidence explicit and reject partial drafts", () => {
  const fresh = buildFreshMatchRecord({
    color: "white" as const,
    emojiId: 1,
    aura: "none" as const,
    seed: { gameVariant: "Classic", fen: "initial" },
  });
  assert.deepEqual(matchCreationWireValue(createMatchCreationInput(fresh)), {
    ...fresh,
    sessionCreation: null,
    reaction: null,
  });
  const restored = publicMatchFixture({
    status: "surrendered",
    flatMovesString: "a-b",
    timer: "gg",
  });
  assert.deepEqual(
    matchCreationWireValue(createRestoredMatchCreationInput(restored)),
    { ...restored, sessionCreation: null, reaction: null },
  );
  for (const value of [
    undefined,
    null,
    false,
    0,
    "",
    [],
    {},
    { ...fresh, aura: null },
  ])
    assert.throws(
      () => readMatchCreationInput(value),
      /match-state-invalid-creation/,
    );
});

test("normalization clones complete state and surrender reads do not reinterpret values", () => {
  const document = matchDocumentFixture({
    status: "surrendered",
    timer: "7;1000",
  });
  const normalized = normalizeNewMatchDocument(document);
  assert.deepEqual(normalized, document);
  assert.notStrictEqual(normalized.timer, document.timer);
  assert.deepEqual(matchSurrenderState(document), {
    exists: true,
    surrendered: true,
  });
  assert.deepEqual(matchSurrenderState(null), {
    exists: false,
    surrendered: false,
  });
  assert.equal(matchSurrenderHasFen(document), true);
});
