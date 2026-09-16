"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  SESSION_BOOTSTRAP_MAX_RESPONSE_BYTES,
  SESSION_BOOTSTRAP_REQUEST_TIMEOUT_MS,
  isSessionBootstrapTarget,
  isSessionBootstrapFailure,
  isSessionBootstrap,
  isSessionBootstrapResponse,
  isSessionIdentityBootstrap,
  SESSION_IDENTITY_BOOTSTRAP_MAX_RESPONSE_BYTES,
} = require("../runtime/shared/session-bootstrap");
const {
  GAME_BOOTSTRAP_MAX_RESPONSE_BYTES,
} = require("../runtime/shared/game-bootstrap");
const { isSessionTokenResponse } = require("../runtime/shared/session-auth");

const session = {
  ok: true,
  uid: "a".repeat(28),
  sessionId: "00000000-0000-4000-8000-000000000001",
  accessToken: "header.payload.signature",
  accessExpiresAtMs: 1700000300000,
};

function bootstrap(selection = "current") {
  const pending = selection === "current";
  return {
    inviteId: "invite",
    selection,
    result: {
      ok: true,
      schemaVersion: 1,
      metadata: {
        inviteId: "invite",
        revision: 2,
        hostId: session.uid,
        guestId: "guest",
        hostColor: "white",
        hostRematches: "1",
        guestRematches: "",
        automatchStateHint: null,
        eventId: null,
        eventOwned: false,
      },
      viewer: {
        role: "host",
        actorUid: session.uid,
        automatchOperationId: null,
      },
      match: {
        inviteId: "invite",
        matchId: pending ? "invite1" : "invite",
        revision: 1,
        hostPlayerId: session.uid,
        guestPlayerId: "guest",
        hostMatch: null,
        guestMatch: null,
      },
      hasPendingProposal: pending,
    },
  };
}

test("session bootstrap targets preserve exact invite and selection identity", () => {
  assert.equal(
    isSessionBootstrapTarget({ inviteId: "invite", selection: "current" }),
    true,
  );
  for (const value of [
    null,
    { inviteId: "invite" },
    { inviteId: " invite", selection: "current" },
    { inviteId: "invite/child", selection: "current" },
    { inviteId: "invite", selection: "latest" },
    { inviteId: "invite", selection: "approved", uid: session.uid },
  ])
    assert.equal(isSessionBootstrapTarget(value), false);
});

test("composed session responses keep legacy token validation strict", () => {
  for (const selection of ["current", "approved"]) {
    const value = { ...session, gameBootstrap: bootstrap(selection) };
    assert.equal(isSessionBootstrapResponse(value), true);
    assert.equal(isSessionTokenResponse(value), false);
    assert.equal(
      isSessionBootstrapResponse({ ...value, refreshSecret: "secret" }),
      false,
    );
    assert.equal(
      isSessionBootstrapResponse({ ...value, uid: "invalid" }),
      false,
    );
  }
  assert.equal(isSessionTokenResponse(session), true);
  assert.equal(isSessionBootstrapResponse(session), false);
  assert.equal(
    SESSION_BOOTSTRAP_MAX_RESPONSE_BYTES,
    GAME_BOOTSTRAP_MAX_RESPONSE_BYTES + 16_384,
  );
  assert.equal(SESSION_BOOTSTRAP_REQUEST_TIMEOUT_MS, 25_000);
});

test("identity seeds compose independently while preserving exact token and public profile schemas", () => {
  assert.equal(SESSION_IDENTITY_BOOTSTRAP_MAX_RESPONSE_BYTES, 65_536);
  for (const identityBootstrap of [
    { ok: true, profile: null },
    { ok: false, status: 409 },
    { ok: false, status: 503 },
  ]) {
    assert.equal(isSessionIdentityBootstrap(identityBootstrap), true);
    assert.equal(
      isSessionTokenResponse({ ...session, identityBootstrap }),
      false,
    );
    assert.equal(
      isSessionBootstrapResponse({
        ...session,
        gameBootstrap: bootstrap(),
        identityBootstrap,
      }),
      true,
    );
  }
  for (const identityBootstrap of [
    { ok: true },
    { ok: true, profile: { id: "incomplete" } },
    { ok: true, profile: null, appleSub: "private" },
    { ok: false, status: 401 },
    { ok: false, status: 503, message: "private" },
    undefined,
  ]) {
    assert.equal(isSessionIdentityBootstrap(identityBootstrap), false);
    assert.equal(
      isSessionBootstrapResponse({
        ...session,
        gameBootstrap: bootstrap(),
        identityBootstrap,
      }),
      false,
    );
  }
});

test("bootstrap validation rejects foreign data and an incorrect requested selection", () => {
  const value = bootstrap();
  assert.equal(isSessionBootstrap({ ...value, inviteId: "other" }), false);
  assert.equal(isSessionBootstrap({ ...value, selection: "approved" }), false);
  assert.equal(
    isSessionBootstrap({ ...bootstrap("approved"), selection: "current" }),
    false,
  );
  assert.equal(
    isSessionBootstrap({ ...value, result: { ...value.result, secret: true } }),
    false,
  );
});

test("game failures are bounded public data independent of successful authentication", () => {
  for (const status of [403, 404, 409, 429, 503]) {
    const result = { ok: false, status, retryAfterMs: 60_000 };
    assert.equal(isSessionBootstrapFailure(result), true);
    assert.equal(
      isSessionBootstrapResponse({
        ...session,
        gameBootstrap: { inviteId: "invite", selection: "current", result },
      }),
      true,
    );
  }
  for (const result of [
    { ok: false, status: 401 },
    { ok: false, status: 503, message: "secret" },
    { ok: false, status: 429, retryAfterMs: -1 },
    { ok: false, status: 429, retryAfterMs: Infinity },
    { ok: false, status: 429, retryAfterMs: 0.5 },
  ])
    assert.equal(isSessionBootstrapFailure(result), false);
});
