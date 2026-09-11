"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  matchDiscoverySortKey,
  resolveMatchDiscoveryInvite,
} = require("../runtime/shared/login-match-discovery");

test("discovery sort keys preserve JavaScript ordering for numeric and Unicode IDs", () => {
  const ids = ["a10", "a2", "2", "10", "a", "a😀", "a\ue000", " A ", "é"];
  assert.deepEqual(
    [...ids].sort((left, right) => {
      const a = matchDiscoverySortKey(left);
      const b = matchDiscoverySortKey(right);
      return a < b ? -1 : a > b ? 1 : 0;
    }),
    [...ids].sort(),
  );
});

test("discovery resolution preserves exact-invite precedence and legacy trimming", async () => {
  const reads = [];
  assert.deepEqual(
    await resolveMatchDiscoveryInvite(" invite12 ", (id) => {
      reads.push(id);
      return true;
    }),
    { inviteId: "invite12", resolution: "resolved" },
  );
  assert.deepEqual(reads, ["invite12"]);
});

test("discovery resolves only one existing canonical rematch prefix", async () => {
  assert.deepEqual(
    await resolveMatchDiscoveryInvite("invite12", (id) => id === "invite"),
    { inviteId: "invite", resolution: "resolved" },
  );
  assert.deepEqual(
    await resolveMatchDiscoveryInvite("invite12", (id) =>
      ["invite1", "invite"].includes(id),
    ),
    { inviteId: null, resolution: "ambiguous" },
  );
  assert.deepEqual(await resolveMatchDiscoveryInvite("invite0", () => false), {
    inviteId: null,
    resolution: "missing",
  });
});

test("discovery resolution propagates source failures instead of recording missing", async () => {
  await assert.rejects(
    resolveMatchDiscoveryInvite("invite1", async () => {
      throw new Error("source-unavailable");
    }),
    /source-unavailable/,
  );
});
