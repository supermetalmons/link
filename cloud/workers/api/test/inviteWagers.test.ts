import assert from "node:assert/strict";
import { test } from "node:test";
import { isInviteWagersSnapshot } from "@mons/shared/invite-wagers";
import { createEmptyWager, type WagerRecord } from "../src/wagerModel.ts";
import { normalizeInviteMetadata } from "../src/inviteMetadata.ts";
import { normalizeInviteWagers } from "../src/inviteWagers.ts";
import { composeInviteWagerSource } from "../src/inviteWagerSource.ts";
import { inviteDocumentFixture } from "./inviteDocumentFixture.ts";
import {
  agreedWagerFixture,
  settledWagerFixture,
} from "./wagerRecordFixture.ts";

const inviteId = "wagers-invite";
const invite = inviteDocumentFixture({ hostId: "host", guestId: "guest" });
const proposal = {
  material: "dust" as const,
  count: 2,
  createdAt: 10,
  operationId: "a".repeat(64),
  reservationOperationId: "b".repeat(64),
};
const proposed: WagerRecord = {
  ...createEmptyWager(),
  proposals: { host: proposal },
};
const source = (wagers: unknown = { match: proposed }) => ({
  invite,
  wagers,
  resolutionMarkers: {},
});
async function success(value: unknown) {
  const result = await normalizeInviteWagers(inviteId, value);
  assert.equal(result.status, "ok");
  if (result.status !== "ok") throw new Error("expected-valid-wager");
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

test("canonical wager projection exposes public fields and preserves private reservation evidence", async () => {
  const input = source({
    proposed,
    agreed: agreedWagerFixture(),
    settled: settledWagerFixture(),
  });
  const original = structuredClone(input);
  const result = await success(input);
  assert.ok(isInviteWagersSnapshot(result.snapshot));
  assert.deepEqual(result.snapshot.wagers.proposed, {
    schemaVersion: 1,
    state: "proposed",
    proposals: { host: { material: "dust", count: 2, createdAt: 10 } },
    proposedBy: {},
    agreed: null,
    resolved: null,
    blocked: null,
  });
  assert.equal(result.snapshot.wagers.agreed?.state, "agreed");
  assert.equal(result.snapshot.wagers.settled?.state, "settled");
  assert.equal(result.metadata.passwordProtected, false);
  assert.equal(JSON.stringify(result.snapshot).includes("Operation"), false);
  assert.equal(JSON.stringify(result.snapshot).includes("reservation"), false);
  assert.match(result.fingerprint, /^[a-f0-9]{64}$/);
  assert.deepEqual(input, original);
});

test("only a missing source is missing and an explicit empty wager map remains empty", async () => {
  for (const value of [null, undefined])
    assert.deepEqual(await normalizeInviteWagers(inviteId, value), {
      status: "missing",
    });
  const result = await success(source({}));
  assert.deepEqual(result.snapshot, { inviteId, revision: 0, wagers: {} });
  for (const value of [
    invite,
    { ...invite, wagers: {} },
    source(null),
    { ...source(), wagers: undefined },
  ])
    assert.deepEqual(await normalizeInviteWagers(inviteId, value), {
      status: "invalid",
    });
});

test("source roots and canonical invite metadata reject unknown or malformed fields", async () => {
  for (const value of [
    [],
    false,
    "invite",
    {},
    { ...source(), extra: true },
    ...[
      { hostId: "invalid/uid" },
      { guestId: "host" },
      { guestId: 1 },
      { hostColor: "red" },
      { password: "private" },
      { unknown: true },
    ].map((change) => ({ ...source(), invite: { ...invite, ...change } })),
    { ...source(), resolutionMarkers: { match: "true" } },
    { ...source(), resolutionMarkers: { "bad/key": true } },
  ])
    assert.deepEqual(await normalizeInviteWagers(inviteId, value), {
      status: "invalid",
    });
});

test("cached access metadata must match the canonical source identity and password policy", async () => {
  const metadata = normalizeInviteMetadata(inviteId, invite);
  for (const changed of [
    inviteDocumentFixture({ ...invite, hostId: "different-host" }),
    inviteDocumentFixture({
      ...invite,
      kind: "automatch",
      password: "private",
    }),
    inviteDocumentFixture({ ...invite, guestId: null }),
  ])
    assert.deepEqual(
      await normalizeInviteWagers(
        inviteId,
        { ...source(), invite: changed },
        metadata,
      ),
      { status: "invalid" },
    );
  const privateSource = {
    ...source(),
    invite: inviteDocumentFixture({
      ...invite,
      kind: "automatch",
      password: "private",
    }),
  };
  assert.equal((await success(privateSource)).metadata.passwordProtected, true);
});

test("malformed maps and any invalid wager invalidate the whole projection", async () => {
  const malformed = [
    null,
    [],
    1,
    {},
    { ...proposed, state: "agreed" },
    { ...proposed, extra: "unknown" },
    { ...proposed, proposals: null },
    { ...proposed, proposedBy: { host: "true" } },
    ...[
      { count: 0 },
      { material: "unknown" },
      { createdAt: "10" },
      { reservationOperationId: "private-id" },
      { credentials: { token: "secret" } },
    ].map((change) => ({
      ...proposed,
      proposals: { host: { ...proposal, ...change } },
    })),
    { ...settledWagerFixture(), resolved: null },
    {
      ...settledWagerFixture(),
      resolved: { ...settledWagerFixture().resolved, resolvedAt: -1 },
    },
  ];
  for (const wagers of [
    false,
    1,
    "wagers",
    [],
    { "invalid/match": proposed },
    ...malformed.map((value) => ({ valid: proposed, invalid: value })),
  ])
    assert.deepEqual(await normalizeInviteWagers(inviteId, source(wagers)), {
      status: "invalid",
    });
});

test("private operation changes alter fingerprints while preserving public snapshots", async () => {
  const before = await success(source());
  const after = await success(
    source({
      match: {
        ...proposed,
        proposals: {
          host: { ...proposal, reservationOperationId: "c".repeat(64) },
        },
      },
    }),
  );
  assert.deepEqual(before.snapshot, after.snapshot);
  assert.notEqual(before.fingerprint, after.fingerprint);
});

test("key order cannot change source fingerprints or serialized public snapshots", async () => {
  const input = source({
    "match-2": proposed,
    "match-1": agreedWagerFixture(),
  });
  const before = await success(input);
  const after = await success(reverseKeys(input));
  assert.equal(JSON.stringify(before.snapshot), JSON.stringify(after.snapshot));
  assert.equal(before.fingerprint, after.fingerprint);
});

test("oversized, deeply nested, cyclic, non-finite, and unsupported private values fail closed", async () => {
  let nested: unknown = "leaf";
  for (let i = 0; i < 70; i++) nested = { next: nested };
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  for (const hidden of [
    "x".repeat(1024 * 1024),
    "🦊".repeat(300_000),
    nested,
    cycle,
    NaN,
    Infinity,
    1n,
    () => null,
    undefined,
  ])
    assert.deepEqual(
      await normalizeInviteWagers(
        inviteId,
        source({ match: { ...proposed, hidden } }),
      ),
      { status: "invalid" },
    );
});

test("composition retains typed wagers and resolution markers without flattening invite fields", () => {
  const composed = composeInviteWagerSource(invite, [
    {
      inviteId,
      matchId: "match",
      wager: proposed,
      resolutionMarker: true,
      revision: 1,
    },
  ]);
  assert.deepEqual(composed, {
    invite,
    wagers: { match: proposed },
    resolutionMarkers: { match: true },
  });
  assert.deepEqual(composeInviteWagerSource(invite, []), source({}));
  assert.equal(composeInviteWagerSource(null, []), null);
});
