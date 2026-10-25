import assert from "node:assert/strict";
import test from "node:test";
import type { RematchInviteData } from "@mons/shared/rematches";
import { registeredInviteMatchIndex } from "../src/inviteMatchPolicy.ts";

test("registration includes the base match and either player's historical or ended proposals", () => {
  const cases: Array<{
    rematches: RematchInviteData;
    matchId: string;
    expected: number | null;
  }> = [
    { rematches: {}, matchId: "invite", expected: 0 },
    {
      rematches: { hostRematches: "1;2x", guestRematches: "1" },
      matchId: "invite1",
      expected: 1,
    },
    {
      rematches: { hostRematches: "1;2x", guestRematches: "1" },
      matchId: "invite2",
      expected: 2,
    },
    {
      rematches: { hostRematches: "1", guestRematches: "1;2x" },
      matchId: "invite2",
      expected: 2,
    },
    {
      rematches: { hostRematches: "1;3", guestRematches: "1" },
      matchId: "invite2",
      expected: null,
    },
    {
      rematches: { hostRematches: "1;3", guestRematches: "1" },
      matchId: "invite3",
      expected: 3,
    },
    {
      rematches: { hostRematches: "3;1;3", guestRematches: "" },
      matchId: "invite1",
      expected: 1,
    },
  ];
  for (const { rematches, matchId, expected } of cases) {
    const before = structuredClone(rematches);
    Object.freeze(rematches);
    assert.equal(
      registeredInviteMatchIndex("invite", matchId, rematches),
      expected,
      JSON.stringify({ rematches, matchId }),
    );
    assert.deepEqual(rematches, before);
  }
});

test("registration requires exact canonical suffixes within the safe integer range", () => {
  for (const suffix of [
    "0",
    "01",
    "-1",
    "+1",
    "1.0",
    "1e0",
    " 1",
    "1 ",
    String(Number.MAX_SAFE_INTEGER + 1),
  ]) {
    assert.equal(
      registeredInviteMatchIndex("invite", `invite${suffix}`, {
        hostRematches: suffix,
        guestRematches: suffix,
      }),
      null,
      suffix,
    );
  }
  const maximum = String(Number.MAX_SAFE_INTEGER);
  assert.equal(
    registeredInviteMatchIndex("invite", `invite${maximum}`, {
      guestRematches: maximum,
    }),
    Number.MAX_SAFE_INTEGER,
  );
});

test("registration rejects empty or foreign IDs without reinterpreting numeric invite suffixes", () => {
  for (const [inviteId, matchId] of [
    ["", ""],
    ["", "invite1"],
    ["invite", ""],
    ["invite", "other1"],
  ]) {
    assert.equal(
      registeredInviteMatchIndex(inviteId, matchId, {
        hostRematches: "1",
      }),
      null,
    );
  }
  assert.equal(registeredInviteMatchIndex("invite-10", "invite-10", {}), 0);
  assert.equal(
    registeredInviteMatchIndex("invite-10", "invite-101", {
      hostRematches: "1",
    }),
    1,
  );
});

test("registration tolerates malformed rematch tokens without trimming them", () => {
  const rematches = Object.freeze({
    hostRematches: " 1;2;;bad;03;4x",
    guestRematches: false,
  });
  for (const [index, expected] of [
    [1, null],
    [2, 2],
    [3, null],
    [4, 4],
  ]) {
    assert.equal(
      registeredInviteMatchIndex("invite", `invite${index}`, rematches),
      expected,
    );
  }
  for (const guestRematches of [null, false, [1], {}, "1xx", "1x "]) {
    assert.equal(
      registeredInviteMatchIndex("invite", "invite1", { guestRematches }),
      null,
    );
  }
});
