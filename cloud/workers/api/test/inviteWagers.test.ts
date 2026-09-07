import assert from "node:assert/strict";
import { test } from "node:test";
import {
  INVITE_WAGERS_MAX_MESSAGE_BYTES,
  isInviteWagersSnapshot,
} from "@mons/shared/invite-wagers";
import { normalizeInviteMetadata } from "../src/inviteMetadata.ts";
import { normalizeInviteWagers } from "../src/inviteWagers.ts";

const inviteId = "wagers-invite";
const invite = {
  hostId: "host-login",
  hostColor: "white",
  guestId: "guest-login",
};
const proposal = { material: "dust", count: 2 };
const agreement = {
  material: "dust",
  count: 2,
  proposerId: invite.hostId,
  accepterId: invite.guestId,
};
const resolution = {
  material: "dust",
  count: 2,
  winnerId: invite.hostId,
  loserId: invite.guestId,
};

async function success(value: unknown) {
  const result = await normalizeInviteWagers(inviteId, value);
  assert.ok(result.status === "ok");
  return result;
}

function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .reverse()
      .map(([key, entry]) => [key, reverseKeys(entry)]),
  );
}

test("wager normalization exposes only explicitly allowed fields at each level", async () => {
  const value = {
    ...invite,
    password: "private-password",
    automatchOperationIds: { [invite.hostId]: crypto.randomUUID() },
    matchesWagerResolutions: { "match-1": true },
    wagers: {
      "match-1": {
        proposals: {
          [invite.hostId]: {
            ...proposal,
            createdAt: 10,
            operationId: "private-proposal-operation",
            reservationOperationId: "private-reservation-operation",
            credentials: { token: "private-token" },
          },
        },
        proposedBy: { [invite.hostId]: true, [invite.guestId]: false },
        agreed: {
          ...agreement,
          total: 4,
          acceptedAt: 20,
          operationId: "private-agreement-operation",
        },
        resolved: {
          ...resolution,
          total: 4,
          resolvedAt: 30,
          optimistic: true,
          retryToken: "private-retry-token",
        },
        agreementOperation: { operationId: "private-lineage" },
        proposalRemovalOperations: { operation: "private-removal" },
        settlement: { state: "completed", operationId: "private-settlement" },
        unknown: "private-unknown",
      },
    },
  };
  const original = structuredClone(value);
  const result = await success(value);
  assert.deepEqual(result.snapshot, {
    inviteId,
    revision: 0,
    wagers: {
      "match-1": {
        proposals: { [invite.hostId]: { ...proposal, createdAt: 10 } },
        proposedBy: { [invite.guestId]: false, [invite.hostId]: true },
        agreed: { ...agreement, total: 4, acceptedAt: 20 },
        resolved: { ...resolution, total: 4, resolvedAt: 30 },
      },
    },
  });
  assert.ok(isInviteWagersSnapshot(result.snapshot));
  assert.equal(result.metadata.passwordProtected, true);
  assert.equal(JSON.stringify(result.snapshot).includes("private"), false);
  assert.equal(JSON.stringify(result.snapshot).includes("optimistic"), false);
  assert.match(result.fingerprint, /^[a-f0-9]{64}$/);
  assert.deepEqual(value, original);
});

test("wager normalization preserves missing optional fields without inventing values", async () => {
  const wagers = {
    "match-1": {
      proposals: { [invite.hostId]: proposal },
      agreed: agreement,
      resolved: resolution,
    },
    "match-2": { proposedBy: { [invite.hostId]: false } },
    "match-3": { settlement: { state: "pending" } },
  };
  const result = await success({ ...invite, wagers });
  assert.deepEqual(result.snapshot.wagers, { ...wagers, "match-3": {} });
});

test("missing invites remain missing and absent or null wagers produce empty snapshots", async () => {
  for (const value of [null, undefined]) {
    assert.deepEqual(await normalizeInviteWagers(inviteId, value), {
      status: "missing",
    });
  }
  const results = await Promise.all(
    [invite, { ...invite, wagers: null }, { ...invite, wagers: {} }].map(
      success,
    ),
  );
  for (const result of results) {
    assert.deepEqual(result.snapshot, { inviteId, revision: 0, wagers: {} });
    assert.equal(result.fingerprint, results[0].fingerprint);
  }
});

test("malformed invite roots and access metadata never normalize to empty success", async () => {
  for (const value of [
    [],
    false,
    "invite",
    {},
    { ...invite, hostId: "invalid/uid" },
    { ...invite, guestId: invite.hostId },
    { ...invite, guestId: 1 },
    { ...invite, hostColor: "red" },
  ]) {
    assert.deepEqual(await normalizeInviteWagers(inviteId, value), {
      status: "invalid",
    });
  }
  const metadata = normalizeInviteMetadata(inviteId, invite);
  assert.deepEqual(
    await normalizeInviteWagers(
      inviteId,
      { ...invite, hostId: "different-host" },
      metadata,
    ),
    { status: "invalid" },
  );
  assert.deepEqual(
    await normalizeInviteWagers(
      inviteId,
      { ...invite, password: "private-password" },
      metadata,
    ),
    { status: "invalid" },
  );
});

test("malformed wager maps and known public fields invalidate the whole source", async () => {
  const malformedStates = [
    null,
    [],
    1,
    { proposals: null },
    { proposals: [] },
    { proposals: { [invite.hostId]: null } },
    { proposals: { [invite.hostId]: { ...proposal, count: 0 } } },
    { proposals: { [invite.hostId]: { ...proposal, material: "unknown" } } },
    { proposals: { [invite.hostId]: { ...proposal, createdAt: "10" } } },
    { proposals: { "invalid/uid": proposal } },
    { proposedBy: null },
    { proposedBy: { [invite.hostId]: "true" } },
    { agreed: null },
    { agreed: { ...agreement, proposerId: invite.guestId } },
    { agreed: { ...agreement, total: -1 } },
    { agreed: { ...agreement, acceptedAt: null } },
    { resolved: null },
    { resolved: { ...resolution, loserId: "invalid/uid" } },
    { resolved: { ...resolution, resolvedAt: -1 } },
  ];
  for (const wagers of [
    false,
    1,
    "wagers",
    [],
    { "invalid/match": {} },
    ...malformedStates.map((state) => ({
      "valid-match": {},
      "bad-match": state,
    })),
  ]) {
    assert.deepEqual(
      await normalizeInviteWagers(inviteId, { ...invite, wagers }),
      {
        status: "invalid",
      },
    );
  }
});

test("private-only source changes advance fingerprints while preserving public snapshots", async () => {
  const before = await success({
    ...invite,
    wagers: {
      match: {
        proposals: { [invite.hostId]: proposal },
        settlement: { state: "pending" },
      },
    },
  });
  const after = await success({
    ...invite,
    wagers: {
      match: {
        proposals: { [invite.hostId]: proposal },
        settlement: { state: "completed" },
      },
    },
  });
  assert.deepEqual(before.snapshot, after.snapshot);
  assert.notEqual(before.fingerprint, after.fingerprint);
});

test("key order cannot change source fingerprints or serialized public snapshots", async () => {
  const value = {
    ...invite,
    wagers: {
      "match-2": {
        agreed: { ...agreement, total: 4 },
        settlement: {
          releases: [{ uid: invite.hostId, amount: 2 }],
          state: "pending",
        },
      },
      "match-1": {
        proposals: {
          [invite.hostId]: proposal,
          [invite.guestId]: { ...proposal, createdAt: 10 },
        },
        proposedBy: { [invite.hostId]: true, [invite.guestId]: false },
      },
    },
  };
  const before = await success(value);
  const after = await success(reverseKeys(value));
  assert.equal(before.fingerprint, after.fingerprint);
  assert.equal(JSON.stringify(before.snapshot), JSON.stringify(after.snapshot));
});

test("fingerprints include participant access and password presence without password contents", async () => {
  const initial = await success(invite);
  for (const value of [
    { ...invite, hostId: "new-host" },
    { ...invite, guestId: "new-guest" },
    { ...invite, guestId: null },
    { ...invite, password: "first-password" },
  ]) {
    const changed = await success(value);
    assert.deepEqual(initial.snapshot, changed.snapshot);
    assert.notEqual(initial.fingerprint, changed.fingerprint);
  }
  const firstPassword = await success({
    ...invite,
    password: "first-password",
  });
  const changedPassword = await success({
    ...invite,
    password: "second-password",
  });
  assert.equal(firstPassword.fingerprint, changedPassword.fingerprint);
  const unrelated = await success({
    ...invite,
    hostRematches: "1;2",
    privateToken: "ignored",
  });
  assert.equal(initial.fingerprint, unrelated.fingerprint);
});

test("source normalization enforces UTF-8 size bounds even for stripped private metadata", async () => {
  const valid = await success({
    ...invite,
    wagers: { match: { settlement: { hidden: "x".repeat(512 * 1024) } } },
  });
  assert.deepEqual(valid.snapshot.wagers, { match: {} });
  for (const hidden of ["x".repeat(1024 * 1024), "😀".repeat(256 * 1024)]) {
    assert.deepEqual(
      await normalizeInviteWagers(inviteId, {
        ...invite,
        wagers: { match: { settlement: { hidden } } },
      }),
      { status: "invalid" },
    );
  }
  assert.ok(
    new TextEncoder().encode(
      JSON.stringify({
        schemaVersion: 1,
        type: "snapshot",
        snapshot: valid.snapshot,
      }),
    ).byteLength <= INVITE_WAGERS_MAX_MESSAGE_BYTES,
  );
});

test("non-JSON and deeply nested private sources fail without publishing partial data", async () => {
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  let deep: unknown = {};
  for (let index = 0; index < 70; index++) deep = { next: deep };
  for (const hidden of [
    cycle,
    deep,
    NaN,
    Infinity,
    1n,
    undefined,
    new Date(0),
  ]) {
    assert.deepEqual(
      await normalizeInviteWagers(inviteId, {
        ...invite,
        wagers: { match: { settlement: { hidden } } },
      }),
      { status: "invalid" },
    );
  }
});
