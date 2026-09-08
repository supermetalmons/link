import assert from "node:assert/strict";
import test from "node:test";
import {
  isReadMatchSnapshotRequest,
  isReadMatchSnapshotResponse,
  MATCH_SNAPSHOT_PATH,
  MAX_GAME_SESSION_GAME_VARIANT_BYTES,
  MAX_GAME_SESSION_STATUS_BYTES,
  MAX_GAME_SESSION_TIMER_BYTES,
  normalizeMatchSnapshot,
} from "@mons/shared/game-sessions";
import {
  MAX_MATCH_FEN_BYTES,
  MAX_MATCH_HISTORY_BYTES,
  MAX_MATCH_HISTORY_ENTRIES,
} from "@mons/shared/match-protocol";
import { handleMatchSnapshotRoute } from "../src/matchSnapshotRoute.ts";
import { TELEGRAM_TEST_ENV } from "./testEnv.ts";

const target = { playerId: "player-1", matchId: "match-1" };
const match = {
  version: 2,
  color: "white",
  emojiId: 1,
  aura: "",
  gameVariant: "Classic",
  fen: "board-fen",
  status: "",
  flatMovesString: "move-1",
  timer: "12;1234567890",
};

function request(
  query = new URLSearchParams(target).toString(),
  method = "GET",
) {
  return new Request(`https://api.mons.link${MATCH_SNAPSHOT_PATH}?${query}`, {
    method,
  });
}

test("serves public, uncached match snapshots with only canonical fields", async () => {
  const sourceRequest = request();
  let reads = 0;
  const response = await handleMatchSnapshotRoute(
    sourceRequest,
    TELEGRAM_TEST_ENV,
    {
      readMatch: async (_env, input, { signal }) => {
        reads++;
        assert.deepEqual(input, target);
        assert.equal(signal, sourceRequest.signal);
        assert.equal(sourceRequest.headers.get("Authorization"), null);
        return {
          ...match,
          sessionCreation: { operationId: "internal" },
          reaction: {},
          secret: "omitted",
        };
      },
    },
  );
  assert.equal(reads, 1);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
  assert.deepEqual(await response.json(), { ok: true, ...target, match });
});

test("returns null only when the exact upstream record is missing", async () => {
  const response = await handleMatchSnapshotRoute(
    request(),
    TELEGRAM_TEST_ENV,
    {
      readMatch: async () => null,
    },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, ...target, match: null });
});

test("preserves legacy match defaults and numeric emoji strings", async () => {
  const legacy = { color: "black", fen: "legacy-fen", emojiId: "2" };
  const expected = {
    version: 2,
    color: "black",
    emojiId: 2,
    aura: "",
    gameVariant: "Classic",
    fen: "legacy-fen",
    status: "",
    flatMovesString: "",
    timer: "",
  };
  assert.deepEqual(normalizeMatchSnapshot(legacy), expected);
  const response = await handleMatchSnapshotRoute(
    request(),
    TELEGRAM_TEST_ENV,
    {
      readMatch: async () => legacy,
    },
  );
  assert.deepEqual(await response.json(), {
    ok: true,
    ...target,
    match: expected,
  });
});

test("rejects malformed stored snapshots without disguising them as missing", async (t) => {
  t.mock.method(console, "error", () => undefined);
  const malformed = [
    undefined,
    false,
    [],
    {},
    { ...match, fen: "" },
    { ...match, fen: "x".repeat(MAX_MATCH_FEN_BYTES + 1) },
    { ...match, color: "red" },
    { ...match, version: "2" },
    { ...match, emojiId: "invalid" },
    { ...match, emojiId: null },
    { ...match, aura: "x".repeat(33) },
    {
      ...match,
      gameVariant: "x".repeat(MAX_GAME_SESSION_GAME_VARIANT_BYTES + 1),
    },
    { ...match, flatMovesString: "x".repeat(MAX_MATCH_HISTORY_BYTES + 1) },
    { ...match, flatMovesString: "-".repeat(MAX_MATCH_HISTORY_ENTRIES) },
    { ...match, flatMovesString: 12 },
    { ...match, status: "x".repeat(MAX_GAME_SESSION_STATUS_BYTES + 1) },
    { ...match, status: null },
    { ...match, timer: "x".repeat(MAX_GAME_SESSION_TIMER_BYTES + 1) },
    { ...match, timer: 12 },
  ];
  for (const stored of malformed) {
    assert.equal(normalizeMatchSnapshot(stored), null);
    const response = await handleMatchSnapshotRoute(
      request(),
      TELEGRAM_TEST_ENV,
      {
        readMatch: async () => stored,
      },
    );
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      ok: false,
      error: "unavailable",
      message: "match-snapshot-unavailable",
    });
  }
});

test("maps upstream failures to unavailable and forwards cancellation", async (t) => {
  t.mock.method(console, "error", () => undefined);
  const controller = new AbortController();
  const sourceRequest = new Request(request(), { signal: controller.signal });
  const response = handleMatchSnapshotRoute(sourceRequest, TELEGRAM_TEST_ENV, {
    readMatch: async (_env, _input, { signal }) => {
      controller.abort();
      assert.equal(signal.aborted, true);
      throw new Error("upstream-failure");
    },
  });
  assert.equal((await response).status, 503);
});

test("validates exact request keys and handles preflight and unsupported methods", async () => {
  let reads = 0;
  const dependencies = {
    readMatch: async () => {
      reads++;
      return match;
    },
  };
  for (const query of [
    "",
    "playerId=player-1",
    "playerId=player-1&matchId=",
    "playerId=player-1&matchId=match-1&extra=1",
    "playerId=player-1&matchId=match-1&matchId=match-2",
    "playerId=player-1&playerId=player-2",
    "playerId=%20player-1&matchId=match-1",
    "playerId=player-1&matchId=match-1%20",
    "playerId=player-1&matchId=..%2Fprofile",
    `playerId=${"x".repeat(129)}&matchId=match-1`,
  ]) {
    const response = await handleMatchSnapshotRoute(
      request(query),
      TELEGRAM_TEST_ENV,
      dependencies,
    );
    assert.equal(response.status, 400, query);
  }
  const preflight = await handleMatchSnapshotRoute(
    request("", "OPTIONS"),
    TELEGRAM_TEST_ENV,
    dependencies,
  );
  assert.equal(preflight.status, 204);
  assert.equal(
    preflight.headers.get("Access-Control-Allow-Methods"),
    "GET, OPTIONS",
  );
  const unsupported = await handleMatchSnapshotRoute(
    request("", "POST"),
    TELEGRAM_TEST_ENV,
    dependencies,
  );
  assert.equal(unsupported.status, 405);
  assert.equal(unsupported.headers.get("Allow"), "GET, OPTIONS");
  assert.equal(reads, 0);
});

test("shared snapshot contracts reject malformed identities and noncanonical responses", () => {
  assert.equal(isReadMatchSnapshotRequest(target), true);
  for (const input of [
    { ...target, extra: 1 },
    { ...target, playerId: "player/other" },
    { ...target, playerId: "\ud800" },
    { ...target, matchId: "\ud800" },
    { ...target, matchId: "match#1" },
  ])
    assert.equal(isReadMatchSnapshotRequest(input), false);
  const response = { ok: true, ...target, match };
  assert.equal(isReadMatchSnapshotResponse(response), true);
  assert.equal(isReadMatchSnapshotResponse({ ...response, match: null }), true);
  assert.equal(isReadMatchSnapshotResponse({ ...response, extra: 1 }), false);
  assert.equal(
    isReadMatchSnapshotResponse({
      ...response,
      match: { ...match, sessionCreation: {} },
    }),
    false,
  );
  assert.equal(
    isReadMatchSnapshotResponse({ ...response, match: { ...match, fen: "" } }),
    false,
  );
});
