import assert from "node:assert/strict";
import test from "node:test";
import {
  eventBookmarkConstraint,
  MAX_EVENT_BOOKMARK_LENGTH,
  requireEventBookmarkEpoch,
  scopeEventBookmark,
} from "../src/eventBookmarks.ts";

const SOURCE = "00000000-0000-4000-8000-000000000001";
const DESTINATION = "00000000-0000-4000-8000-000000000002";
const NATIVE = "0000007b-0000b26e-00001538-0c3e87bb37b3db5cc52eedb93cd3b96b";

test("same-database bookmarks unwrap exactly while old native or foreign scopes restart on primary", () => {
  const scoped = scopeEventBookmark(NATIVE, DESTINATION);
  assert.equal(scoped, `mons-d1-v1:${DESTINATION}:${NATIVE}`);
  assert.equal(eventBookmarkConstraint(scoped, DESTINATION), NATIVE);
  assert.equal(eventBookmarkConstraint(` ${scoped} `, DESTINATION), NATIVE);
  assert.equal(eventBookmarkConstraint(NATIVE, DESTINATION), "first-primary");
  assert.equal(
    eventBookmarkConstraint(scopeEventBookmark(NATIVE, SOURCE), DESTINATION),
    "first-primary",
  );
});

test("missing, malformed and oversized headers cannot become native D1 constraints", () => {
  for (const header of [
    null,
    undefined,
    "",
    " ",
    `mons-d1-v2:${DESTINATION}:${NATIVE}`,
    `mons-d1-v1:invalid:${NATIVE}`,
    `mons-d1-v1:${DESTINATION}:`,
    `mons-d1-v1:${DESTINATION}:native token`,
    `mons-d1-v1:${DESTINATION}:native\nbookmark`,
    `mons-d1-v1:${DESTINATION}:native:bookmark`,
    `mons-d1-v1:${DESTINATION}:first-unconstrained`,
    `mons-d1-v1:${DESTINATION}:${"x".repeat(MAX_EVENT_BOOKMARK_LENGTH)}`,
  ])
    assert.equal(eventBookmarkConstraint(header, DESTINATION), "first-primary");
});

test("epoch configuration must be a UUID and never silently disables scoping", () => {
  for (const epoch of [
    null,
    undefined,
    "",
    "invalid",
    ` ${DESTINATION}`,
    `${DESTINATION}\n`,
    {},
  ]) {
    assert.throws(() => requireEventBookmarkEpoch(epoch), /epoch-unavailable/);
    assert.throws(
      () => eventBookmarkConstraint(null, epoch),
      /epoch-unavailable/,
    );
    assert.throws(() => scopeEventBookmark(NATIVE, epoch), /epoch-unavailable/);
  }
  const uppercase = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";
  assert.equal(requireEventBookmarkEpoch(uppercase), uppercase.toLowerCase());
});

test("responses never publish empty, invalid or oversized native bookmarks", () => {
  for (const native of [
    null,
    undefined,
    "",
    " ",
    "native\r\nbookmark",
    "native:bookmark",
    "first-primary",
    "x".repeat(MAX_EVENT_BOOKMARK_LENGTH),
  ])
    assert.throws(
      () => scopeEventBookmark(native, DESTINATION),
      /bookmark-unavailable/,
    );
  const maximum = "x".repeat(
    MAX_EVENT_BOOKMARK_LENGTH - `mons-d1-v1:${DESTINATION}:`.length,
  );
  const scoped = scopeEventBookmark(maximum, DESTINATION);
  assert.equal(scoped.length, MAX_EVENT_BOOKMARK_LENGTH);
  assert.equal(eventBookmarkConstraint(scoped, DESTINATION), maximum);
  assert.equal(
    eventBookmarkConstraint(`${scoped}x`, DESTINATION),
    "first-primary",
  );
});
