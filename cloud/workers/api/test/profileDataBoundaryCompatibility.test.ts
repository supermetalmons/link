import { projectionDocumentFixture } from "./profileDataBoundaryFixture.ts";
import assert from "node:assert/strict";
import test from "node:test";
import {
  retainProfileGameProjection,
  copyProjectionOwner,
  projectionLastFingerprint,
  projectionTime,
} from "../../../runtime/profileGameProjectionRecords.js";
import { retainEventProjectionOutbox } from "../../../runtime/eventProjectionOutboxRecords.js";
import {
  parseVerifyOperationMetadata,
  parseAuthOperationReceipt,
  parseCanonicalRatingPayload,
  createEmptyRatingPayload,
} from "../src/profileCanonical/contracts.ts";

test("canonical projection reads preserve identity and copy only canonical fields", () => {
  const source = projectionDocumentFixture({
    inviteId: "invite",
    ownerProfileId: "owner",
    lastEventFingerprint: "exact",
    listSortAt: 12,
  });
  const document = retainProfileGameProjection(source);
  assert.equal(document, source);
  assert.equal(projectionLastFingerprint(document), "exact");
  assert.equal(projectionTime(document, "listSortAt"), 12);
  assert.deepEqual(copyProjectionOwner(document, "next-owner"), {
    ...source,
    ownerProfileId: "next-owner",
  });
  for (const raw of [
    { ...source, listSortAt: 12.9 },
    { ...source, nested: {} },
  ])
    assert.throws(() => retainProfileGameProjection(raw));
});

test("canonical event outboxes reject malformed values at the read boundary", () => {
  for (const value of [
    undefined,
    null,
    false,
    0,
    "legacy",
    [],
    { extra: true },
  ]) {
    assert.throws(() => retainEventProjectionOutbox("profile-game", value));
    assert.throws(() => retainEventProjectionOutbox("telegram", value));
  }
});

test("canonical profile operation payloads reject retained extension bags", () => {
  const source = { z: [null, false], a: { second: 2, first: 1 } };
  assert.throws(() => parseVerifyOperationMetadata(source));
  assert.throws(() => parseAuthOperationReceipt(source));
  assert.throws(() => parseCanonicalRatingPayload(source));
  assert.deepEqual(
    parseCanonicalRatingPayload(createEmptyRatingPayload()),
    createEmptyRatingPayload(),
  );
  assert.throws(() =>
    parseCanonicalRatingPayload({
      ...createEmptyRatingPayload(),
      historicalMatchArchiveVersion: null,
    }),
  );
});
