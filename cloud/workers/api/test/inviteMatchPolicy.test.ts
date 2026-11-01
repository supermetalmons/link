import assert from "node:assert/strict";
import test from "node:test";
import {
  isRematchSeries,
  type RematchInviteData,
  type RematchSeries,
} from "@mons/shared/rematches";
import { registeredInviteMatchIndex } from "../src/inviteMatchPolicy.ts";

const series = (
  indices: number[] = [],
  state: RematchSeries["state"] = "open",
): RematchSeries => ({ state, indices });
const rematches = (host = series(), guest = series()): RematchInviteData => ({
  hostRematches: host,
  guestRematches: guest,
});

test("registration includes the base match and either player's historical or ended proposals", () => {
  const cases: Array<{
    rematches: RematchInviteData;
    matchId: string;
    expected: number | null;
  }> = [
    { rematches: rematches(), matchId: "invite", expected: 0 },
    {
      rematches: rematches(series([1, 2], "ended"), series([1])),
      matchId: "invite1",
      expected: 1,
    },
    {
      rematches: rematches(series([1, 2], "ended"), series([1])),
      matchId: "invite2",
      expected: 2,
    },
    {
      rematches: rematches(series([1]), series([1, 2], "ended")),
      matchId: "invite2",
      expected: 2,
    },
    {
      rematches: rematches(series([1, 3]), series([1])),
      matchId: "invite2",
      expected: null,
    },
    {
      rematches: rematches(series([1, 3]), series([1])),
      matchId: "invite3",
      expected: 3,
    },
    { rematches: rematches(series([1, 3])), matchId: "invite1", expected: 1 },
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
  ])
    assert.equal(
      registeredInviteMatchIndex(
        "invite",
        `invite${suffix}`,
        rematches(series([1])),
      ),
      null,
      suffix,
    );
  assert.equal(
    registeredInviteMatchIndex(
      "invite",
      `invite${Number.MAX_SAFE_INTEGER}`,
      rematches(series(), series([Number.MAX_SAFE_INTEGER])),
    ),
    Number.MAX_SAFE_INTEGER,
  );
});

test("registration rejects empty or foreign IDs without reinterpreting numeric invite suffixes", () => {
  for (const [inviteId, matchId] of [
    ["", ""],
    ["", "invite1"],
    ["invite", ""],
    ["invite", "other1"],
  ] as const)
    assert.equal(
      registeredInviteMatchIndex(inviteId, matchId, rematches(series([1]))),
      null,
    );
  assert.equal(
    registeredInviteMatchIndex("invite-10", "invite-10", rematches()),
    0,
  );
  assert.equal(
    registeredInviteMatchIndex(
      "invite-10",
      "invite-101",
      rematches(series([1])),
    ),
    1,
  );
});

test("canonical rematch boundaries reject obsolete token strings and malformed sequences", () => {
  for (const value of [
    null,
    false,
    [1],
    {},
    "1xx",
    "1x ",
    " 1;2;;bad;03;4x",
    series([3, 1, 3]),
    series([1, 1]),
    series([0]),
    series([1.5]),
    series([Number.MAX_SAFE_INTEGER + 1]),
  ])
    assert.equal(isRematchSeries(value), false);
  assert.equal(isRematchSeries(series([1, 3], "ended")), true);
});
