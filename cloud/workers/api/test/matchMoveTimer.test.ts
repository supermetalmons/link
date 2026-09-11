import assert from "node:assert/strict";
import test from "node:test";
import type {
  SubmitMoveRequest,
  SubmitMoveResponse,
} from "@mons/shared/game-sessions";
import { AuthApiFailure } from "../src/authErrors.ts";
import { StateRepositoryFailure } from "../src/stateRepositoryTypes.ts";
import { submitMove } from "../src/matchMove.ts";

const request: SubmitMoveRequest = {
  inviteId: "invite",
  matchId: "invite1",
  playerId: "actor",
  previousFlatMovesString: "first",
  flatMovesString: "first-second",
  fen: "second-fen",
  previousStates: [{ moveCount: 1, fen: "first-fen" }],
};

function harness({
  response = {
    ok: true,
    inviteId: request.inviteId,
    matchId: request.matchId,
    actorUid: request.playerId,
    outcome: "applied",
  } as SubmitMoveResponse,
  failure,
  onRead = () => {},
}: {
  response?: SubmitMoveResponse;
  failure?: Error;
  onRead?: () => void;
} = {}) {
  const steps: string[] = [];
  const calls: SubmitMoveRequest[] = [];
  const repository: Parameters<typeof submitMove>[2] = {
    async readInviteMetadata(inviteId, signal) {
      assert.equal(inviteId, "invite");
      assert.ok(signal);
      signal.throwIfAborted();
      steps.push("invite");
      onRead();
      return {
        hostId: "actor",
        guestId: "opponent",
        hostRematches: "1",
        guestRematches: "1",
      };
    },
    async readProfileOwnershipSnapshot() {
      throw new Error("unexpected-ownership-read");
    },
  };
  return {
    steps,
    calls,
    run: ({
      body = request,
      signal,
      assertMutationAllowed = async () => {
        steps.push("admission");
      },
    }: {
      body?: SubmitMoveRequest;
      signal?: AbortSignal;
      assertMutationAllowed?: () => Promise<void>;
    } = {}) =>
      submitMove({ uid: "actor" }, body, repository, {
        signal,
        assertMutationAllowed,
        async submitCanonical(input) {
          steps.push("canonical");
          calls.push(input);
          if (failure) throw failure;
          return response;
        },
      }),
  };
}

test("move delegates each outcome to the canonical match operation", async () => {
  for (const response of [
    {
      ok: true,
      inviteId: request.inviteId,
      matchId: request.matchId,
      actorUid: request.playerId,
      outcome: "applied",
    },
    {
      ok: true,
      inviteId: request.inviteId,
      matchId: request.matchId,
      actorUid: request.playerId,
      outcome: "already-applied",
    },
    {
      ok: true,
      inviteId: request.inviteId,
      matchId: request.matchId,
      actorUid: request.playerId,
      outcome: "superseded",
      fen: "third-fen",
      flatMovesString: "first-second-third",
    },
  ] satisfies SubmitMoveResponse[]) {
    const h = harness({ response });
    assert.equal(await h.run(), response);
    assert.deepEqual(h.steps, ["invite", "admission", "canonical"]);
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0], request);
  }
});

test("move preserves canonical timer outcomes and infrastructure uncertainty", async () => {
  for (const failure of [
    new AuthApiFailure(409, "failed-precondition", "match-move-finished"),
    new AuthApiFailure(409, "failed-precondition", "match-move-blocked"),
    new AuthApiFailure(409, "aborted", "move-chain-conflict"),
    new StateRepositoryFailure(),
  ]) {
    const h = harness({ failure });
    await assert.rejects(h.run(), (error) => error === failure);
    assert.deepEqual(h.steps, ["invite", "admission", "canonical"]);
    assert.equal(h.calls.length, 1);
  }
});

test("invalid move requests and unauthorized participants never dispatch", async () => {
  const invalid = harness();
  await assert.rejects(
    invalid.run({ body: { ...request, fen: "" } }),
    (error) => error instanceof AuthApiFailure && error.status === 400,
  );
  assert.deepEqual(invalid.steps, []);
  const unrelated = harness();
  await assert.rejects(
    unrelated.run({ body: { ...request, playerId: "outsider" } }),
    (error) => error instanceof AuthApiFailure && error.status === 403,
  );
  assert.deepEqual(unrelated.steps, ["invite"]);
  assert.deepEqual(unrelated.calls, []);
});

test("move observes cancellation before admission and preserves admission failures", async () => {
  const reason = new Error("request-cancelled");
  const controller = new AbortController();
  const cancelled = harness({ onRead: () => controller.abort(reason) });
  await assert.rejects(
    cancelled.run({ signal: controller.signal }),
    (error) => error === reason,
  );
  assert.deepEqual(cancelled.steps, ["invite"]);
  assert.deepEqual(cancelled.calls, []);
  const blocked = harness();
  const failure = new Error("writes-frozen");
  await assert.rejects(
    blocked.run({
      assertMutationAllowed: async () => {
        throw failure;
      },
    }),
    (error) => error === failure,
  );
  assert.deepEqual(blocked.steps, ["invite"]);
  assert.deepEqual(blocked.calls, []);
});
