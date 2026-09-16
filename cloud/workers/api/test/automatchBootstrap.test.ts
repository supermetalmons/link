import assert from "node:assert/strict";
import test from "node:test";
import type { ReadGameBootstrapResponse } from "@mons/shared/game-bootstrap";
import {
  isStartAutomatchResponse,
  type StartAutomatchResponse,
} from "@mons/shared/navigation";
import { enrichAutomatchResponse } from "../src/gameplayRoutes/automatch.ts";
import { readAuthenticatedGameBootstrap } from "../src/gameBootstrap.ts";
import { createGameplayRepository } from "../src/gameplayRepository.ts";
import { normalizeInviteMetadata } from "../src/inviteMetadata.ts";
import { TELEGRAM_TEST_ENV } from "./testEnv.ts";

const operationId = "00000000-0000-4000-8000-000000000001";
const inviteId = "auto_bootstrap";
const identity = { uid: "h".repeat(28) };
const env: Env = { ...TELEGRAM_TEST_ENV, AUTOMATCH_DELIVERY_MODE: "bootstrap" };
const repository = createGameplayRepository(env);
const response: Extract<StartAutomatchResponse, { mode: "matched" }> = {
  ok: true,
  inviteId,
  mode: "matched",
  matchedImmediately: true,
};

function bootstrap(revision = 1): ReadGameBootstrapResponse {
  const match = {
    version: 2,
    color: "white" as const,
    emojiId: 1,
    aura: "",
    gameVariant: "Classic",
    fen: "initial",
    status: "",
    flatMovesString: "",
    timer: "",
  };
  return {
    ok: true,
    schemaVersion: 1,
    metadata: {
      inviteId,
      revision,
      hostId: identity.uid,
      guestId: "g".repeat(28),
      hostColor: "white",
      hostRematches: "",
      guestRematches: "",
      automatchStateHint: "matched",
      eventId: null,
      eventOwned: false,
    },
    viewer: {
      role: "host",
      actorUid: identity.uid,
      automatchOperationId: operationId,
    },
    match: {
      inviteId,
      matchId: inviteId,
      revision,
      hostPlayerId: identity.uid,
      guestPlayerId: "g".repeat(28),
      hostMatch: match,
      guestMatch: { ...match, color: "black" },
    },
    hasPendingProposal: false,
  };
}

function context(
  query = "&bootstrap=1",
  environment = env,
  signal?: AbortSignal,
) {
  return {
    request: new Request(
      `https://api.mons.link/automatch/start?operationId=${operationId}${query}`,
      { signal },
    ),
    identity,
    repository,
    env: environment,
    operationId,
  };
}

test("only a matched opted-in bootstrap-mode response triggers enrichment", async () => {
  let reads = 0;
  const read = async () => {
    reads++;
    return bootstrap();
  };
  for (const query of [
    "",
    "&bootstrap=0",
    "&bootstrap=true",
    "&bootstrap=1&bootstrap=1",
  ])
    assert.deepEqual(
      await enrichAutomatchResponse(response, context(query), read),
      response,
    );
  assert.deepEqual(
    await enrichAutomatchResponse(
      response,
      context("&bootstrap=1", TELEGRAM_TEST_ENV),
      read,
    ),
    response,
  );
  for (const result of [
    { ok: false },
    { ok: true, inviteId, mode: "pending", matchedImmediately: false },
  ] satisfies StartAutomatchResponse[])
    assert.deepEqual(
      await enrichAutomatchResponse(result, context(), read),
      result,
    );
  assert.equal(reads, 0);
});

test("enrichment reuses the authorized bootstrap reader without changing stored response", async () => {
  const result = bootstrap();
  const source = {
    ...result.metadata,
    automatchOperationIds: { [identity.uid]: operationId },
  };
  const metadata = normalizeInviteMetadata(inviteId, source);
  assert.equal(metadata.status, "ok");
  if (metadata.status !== "ok") throw new Error("invalid-fixture");
  let reads = 0;
  const enriched = await enrichAutomatchResponse(
    response,
    context(),
    async (target, environment, dependencies) => {
      assert.deepEqual(target.identity, identity);
      assert.equal(target.selection, "current");
      assert.equal(dependencies?.repository, repository);
      return readAuthenticatedGameBootstrap(target, environment, {
        ...dependencies,
        readAdmission: async () => source,
        room: {
          readMetadata: async () => metadata,
          readMatches: async () => {
            reads++;
            return { status: "ok", metadata, snapshot: result.match };
          },
        },
      });
    },
  );
  assert.ok(enriched.ok && enriched.mode === "matched" && enriched.bootstrap);
  assert.equal(enriched.bootstrap.viewer.actorUid, identity.uid);
  assert.equal(reads, 1);
  assert.equal(isStartAutomatchResponse(response), true);
  assert.deepEqual(Object.keys(response), [
    "ok",
    "inviteId",
    "mode",
    "matchedImmediately",
  ]);
  assert.equal(isStartAutomatchResponse(enriched), false);
});

test("receipt replay enriches from current data instead of retaining an earlier pair", async () => {
  let revision = 0;
  const read = async () => bootstrap(++revision);
  for (const expected of [1, 2]) {
    const result = await enrichAutomatchResponse(response, context(), read);
    assert.ok(result.ok && result.mode === "matched" && result.bootstrap);
    assert.equal(result.bootstrap.match.revision, expected);
  }
  assert.equal(Object.hasOwn(response, "bootstrap"), false);
});

test("failed, foreign, incomplete, and wrong-operation enrichment preserves success", async () => {
  const foreign = bootstrap();
  foreign.metadata.inviteId = "another";
  const incomplete = bootstrap();
  incomplete.match.guestMatch = null;
  const wrongOperation = bootstrap();
  wrongOperation.viewer.automatchOperationId =
    "00000000-0000-4000-8000-000000000002";
  const spectator = bootstrap();
  spectator.viewer = {
    role: "watch",
    actorUid: null,
    automatchOperationId: operationId,
  };
  const failed = async (): Promise<ReadGameBootstrapResponse> => {
    throw new Error("read-unavailable");
  };
  for (const read of [
    failed,
    ...[foreign, incomplete, wrongOperation, spectator].map(
      (value) => async () => value,
    ),
  ])
    assert.deepEqual(
      await enrichAutomatchResponse(response, context(), read),
      response,
    );
});

test("optional bootstrap times out without changing committed success", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let signal: AbortSignal | undefined;
  const pending = enrichAutomatchResponse(
    response,
    context(),
    async (target) => {
      signal = target.signal;
      return new Promise(() => {});
    },
  );
  t.mock.timers.tick(1_000);
  assert.deepEqual(await pending, response);
  assert.equal(signal?.aborted, true);
});

test("an aborted caller cannot receive an optional seed", async () => {
  const controller = new AbortController();
  const result = await enrichAutomatchResponse(
    response,
    context("&bootstrap=1", env, controller.signal),
    async () => {
      controller.abort();
      return bootstrap();
    },
  );
  assert.deepEqual(result, response);
});
