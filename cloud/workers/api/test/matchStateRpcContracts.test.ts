import { matchDocumentFixture } from "./matchRecordFixture.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { AuthApiFailure } from "../src/authErrors.ts";
import {
  decodeMatchStateCreateResult,
  decodeMatchStatePair,
  decodeMatchMoveResponse,
  decodeMatchSurrenderResponse,
  decodeRoutedMatchRecords,
  getMatchStateRpc,
  unwrapMatchStateRpc,
  type MatchStateRpc,
} from "../src/matchStateRpc.ts";

const pair = {
  inviteId: "invite-one",
  matchId: "invite-one",
  playerId: "host-login",
  opponentId: "guest-login",
  epoch: 1,
  revision: 0,
  claim: null,
};

test("match RPC facade accesses only invoked methods and preserves receiver and returned promise", async () => {
  const accesses: PropertyKey[] = [];
  const calls: unknown[][] = [];
  const result = Promise.resolve({ ok: true, value: null });
  const stub = new Proxy(
    {},
    {
      get(_target, key) {
        accesses.push(key);
        return function (this: object, ...args: unknown[]) {
          assert.strictEqual(this, stub);
          calls.push(args);
          return result;
        };
      },
    },
  );
  const rpc: MatchStateRpc = Reflect.apply(getMatchStateRpc, undefined, [
    {
      INVITE_REACTIONS: {
        getByName: (inviteId: string) => {
          assert.equal(inviteId, "invite-one");
          return stub;
        },
      },
    },
    "invite-one",
  ]);
  assert.deepEqual(accesses, []);
  const input = {
    inviteId: "invite-one",
    matchId: "invite-one",
    playerId: "host-login",
    epoch: 1,
  };
  assert.strictEqual(rpc.readCanonicalMatchRecord(input), result);
  assert.deepEqual(accesses, ["readCanonicalMatchRecord"]);
  assert.deepEqual(calls, [[input]]);
});

test("routed record decoding rejects every missing or sparse slot before returning a typed batch", () => {
  for (const value of [
    undefined,
    null,
    {},
    [],
    [null],
    [undefined],
    new Array(1),
  ]) {
    assert.throws(
      () => decodeRoutedMatchRecords(value, 1),
      /match-state-record-unavailable/,
    );
  }
  const retained = [
    matchDocumentFixture({ fen: "initial" }),
    matchDocumentFixture({ fen: "second" }),
  ];
  const decoded = decodeRoutedMatchRecords(retained, retained.length);
  assert.deepEqual(decoded, retained);
  retained.forEach((value, index) => assert.deepEqual(decoded[index], value));
});

test("creation result decoding rejects holes in records and changed IDs", () => {
  for (const value of [
    { records: new Array(1), changedMatchIds: [] },
    { records: [], changedMatchIds: new Array(1) },
    { records: [undefined], changedMatchIds: [] },
    {
      records: [
        {
          matchId: "invite-one",
          playerId: "host-login",
          outcome: "invented",
          value: {},
        },
      ],
      changedMatchIds: [],
    },
  ]) {
    assert.throws(
      () => decodeMatchStateCreateResult(value),
      /match-state-unavailable/,
    );
  }
});

test("pair and creation result decoders reject noncanonical imported values", () => {
  for (const value of [
    false,
    0,
    "legacy",
    [],
    { fen: "initial" },
    { sessionCreation: "marker", malformed: true },
  ]) {
    assert.throws(
      () =>
        decodeMatchStatePair({
          ...pair,
          playerMatch: value,
          opponentMatch: value,
        }),
      /invalid-record/,
    );
    assert.throws(
      () =>
        decodeMatchStateCreateResult({
          records: [
            {
              matchId: pair.matchId,
              playerId: pair.playerId,
              outcome: "already-created",
              value,
            },
          ],
          changedMatchIds: [],
        }),
      /invalid-record/,
    );
  }
  const value = matchDocumentFixture({ sessionCreation: "marker" });
  const decoded = decodeMatchStatePair({
    ...pair,
    playerMatch: value,
    opponentMatch: null,
  });
  assert.deepEqual(decoded.playerMatch, value);
  assert.equal(decoded.opponentMatch, null);
});

test("RPC errors retain their exact domain status, code and message without running the success decoder", () => {
  assert.throws(
    () =>
      unwrapMatchStateRpc(
        {
          ok: false,
          status: 409,
          code: "aborted",
          message: "move-chain-conflict",
        },
        () => assert.fail("success decoder must not run"),
      ),
    (error: unknown) =>
      error instanceof AuthApiFailure &&
      error.status === 409 &&
      error.code === "aborted" &&
      error.message === "move-chain-conflict",
  );
  for (const value of [
    null,
    {},
    { ok: false, status: 409, code: "invented", message: "bad" },
  ]) {
    assert.throws(
      () => unwrapMatchStateRpc(value, decodeMatchMoveResponse),
      /match-state-unavailable/,
    );
  }
});

test("method result decoders reject a success payload from another operation", () => {
  const response = {
    ok: true,
    inviteId: pair.inviteId,
    matchId: pair.matchId,
    actorUid: pair.playerId,
  };
  assert.deepEqual(
    unwrapMatchStateRpc(
      { ok: true, value: response },
      decodeMatchSurrenderResponse,
    ),
    response,
  );
  assert.throws(
    () =>
      unwrapMatchStateRpc(
        { ok: true, value: response },
        decodeMatchMoveResponse,
      ),
    /match-state-unavailable/,
  );
});
