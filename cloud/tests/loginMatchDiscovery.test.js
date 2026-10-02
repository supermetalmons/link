"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  matchDiscoverySortKey,
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
