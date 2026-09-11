const assert = require("node:assert/strict");
const test = require("node:test");
const {
  isPublicMatchWagerState,
  isInviteWagersSnapshot,
  isReadInviteWagersResponse,
  isInviteWagersMessage,
} = require("../runtime/shared/invite-wagers");
const {
  isInviteMetadataMessage,
} = require("../runtime/shared/invite-metadata");
const { isInviteRoomMessage } = require("../runtime/shared/reactions");

const wager = {
  proposals: { host: { material: "dust", count: 2, createdAt: 1 } },
  proposedBy: { host: true, guest: false },
  agreed: {
    material: "dust",
    count: 2,
    total: 4,
    proposerId: "host",
    accepterId: "guest",
    acceptedAt: 2,
  },
  resolved: {
    material: "dust",
    count: 2,
    total: 4,
    winnerId: "host",
    loserId: "guest",
    resolvedAt: 3,
  },
};
const snapshot = {
  inviteId: "invite-one",
  revision: 1,
  wagers: { "invite-one": wager },
};

test("wager snapshots retain the full public state and legacy optional fields", () => {
  assert.equal(isInviteWagersSnapshot(snapshot), true);
  assert.equal(isInviteWagersSnapshot({ ...snapshot, wagers: {} }), true);
  assert.equal(isPublicMatchWagerState({}), true);
  const legacy = structuredClone(wager);
  delete legacy.proposals.host.createdAt;
  delete legacy.agreed.total;
  delete legacy.agreed.acceptedAt;
  delete legacy.resolved.total;
  delete legacy.resolved.resolvedAt;
  assert.equal(isPublicMatchWagerState(legacy), true);
  assert.equal(
    isInviteWagersSnapshot({
      ...snapshot,
      wagers: { "invite-one": {}, "invite-one1": legacy },
    }),
    true,
  );
});

test("wager wire validators reject private bookkeeping and client optimistic state", () => {
  for (const field of [
    "settlement",
    "agreementOperation",
    "proposalRemovalOperations",
    "operationId",
  ]) {
    assert.equal(isPublicMatchWagerState({ ...wager, [field]: {} }), false);
  }
  assert.equal(
    isPublicMatchWagerState({
      ...wager,
      proposals: {
        host: { ...wager.proposals.host, reservationOperationId: "private" },
      },
    }),
    false,
  );
  assert.equal(
    isPublicMatchWagerState({
      ...wager,
      resolved: { ...wager.resolved, optimistic: true },
    }),
    false,
  );
  assert.equal(
    isReadInviteWagersResponse({ ok: true, snapshot, password: "private" }),
    false,
  );
});

test("wager wire validators reject malformed fields instead of accepting empty state", () => {
  for (const update of [
    { proposals: null },
    { proposals: [] },
    { proposals: { host: { material: "other", count: 2 } } },
    { proposals: { host: { material: "dust", count: 0 } } },
    { proposals: { host: { material: "dust", count: 1.5 } } },
    { proposals: { host: { material: "dust", count: 2, createdAt: -1 } } },
    { proposedBy: { host: "true" } },
    { proposedBy: { host: true, guest: true, outsider: true } },
    { agreed: { ...wager.agreed, acceptedAt: Infinity } },
    { agreed: { ...wager.agreed, accepterId: "host" } },
    { resolved: { ...wager.resolved, loserId: "" } },
    { resolved: { ...wager.resolved, total: -1 } },
  ])
    assert.equal(isPublicMatchWagerState({ ...wager, ...update }), false);
  for (const update of [
    { inviteId: "invite/one" },
    { inviteId: " invite-one" },
    { revision: -1 },
    { revision: Number.MAX_SAFE_INTEGER + 1 },
    { wagers: null },
    { wagers: [] },
    { wagers: { "invalid/match": wager } },
  ])
    assert.equal(isInviteWagersSnapshot({ ...snapshot, ...update }), false);
});

test("wager HTTP and socket contracts are isolated from other invite protocols", () => {
  const response = { ok: true, snapshot };
  const message = { schemaVersion: 1, type: "snapshot", snapshot };
  assert.equal(isReadInviteWagersResponse(response), true);
  assert.equal(isInviteWagersMessage(message), true);
  assert.equal(isInviteWagersMessage({ ...message, schemaVersion: 2 }), false);
  assert.equal(isInviteWagersMessage({ ...message, type: "reaction" }), false);
  assert.equal(isInviteWagersMessage({ ...message, viewer: {} }), false);
  assert.equal(isInviteMetadataMessage(message), false);
  assert.equal(isInviteRoomMessage(message), false);
});
