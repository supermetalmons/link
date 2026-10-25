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
  retainCanonicalProfileLegacy,
  retainCanonicalAuthMetadata,
  retainCanonicalAuthResult,
  retainCanonicalRatingPayload,
  sameCanonicalProfileLegacy,
} from "../src/profileCanonical/retainedRecords.ts";
import { ratingData, ratingValue } from "../src/ratingCanonical/codec.ts";
import { buildAccountingMutationStatements } from "../src/profileCanonical/accountingStatements.ts";

test("retained projection observations preserve identity and defer unrelated fields", () => {
  const reads: string[] = [];
  const nested = { retained: [null, false] };
  const source = {
    nested,
    get lastEventFingerprint() {
      reads.push("fingerprint");
      return "exact";
    },
    get listSortAt() {
      reads.push("timestamp");
      return 12.9;
    },
  };
  const document = retainProfileGameProjection(source);
  assert.equal(document, source);
  assert.deepEqual(reads, []);
  assert.equal(projectionLastFingerprint(document), "exact");
  assert.deepEqual(reads, ["fingerprint", "fingerprint"]);
  assert.equal(projectionTime(document, "listSortAt"), 12);
  const copy = copyProjectionOwner(document, "next-owner");
  assert.equal(Reflect.get(copy, "nested"), nested);
  assert.equal(
    JSON.stringify(copy),
    '{"nested":{"retained":[null,false]},"lastEventFingerprint":"exact","listSortAt":12.9,"ownerProfileId":"next-owner"}',
  );
});

test("retained event outboxes preserve malformed values for the original processing phase", () => {
  for (const value of [
    undefined,
    null,
    false,
    0,
    "legacy",
    [],
    { extra: true },
  ]) {
    assert.equal(retainEventProjectionOutbox("profile-game", value), value);
    assert.equal(retainEventProjectionOutbox("telegram", value), value);
  }
});

test("canonical retained documents preserve exact object evidence and archive presence", () => {
  const source = { z: [null, false], a: { second: 2, first: 1 } };
  for (const retain of [
    retainCanonicalProfileLegacy,
    retainCanonicalAuthMetadata,
    retainCanonicalAuthResult,
    retainCanonicalRatingPayload,
  ]) {
    assert.equal(retain(source), source);
    assert.equal(
      JSON.stringify(retain(source)),
      '{"z":[null,false],"a":{"second":2,"first":1}}',
    );
  }
  assert.equal(
    sameCanonicalProfileLegacy(
      retainCanonicalProfileLegacy({ a: 1, b: 2 }),
      retainCanonicalProfileLegacy({ b: 2, a: 1 }),
    ),
    false,
  );
  const cyclic: { self?: unknown } = {};
  cyclic.self = cyclic;
  assert.equal(
    sameCanonicalProfileLegacy(
      retainCanonicalProfileLegacy(cyclic),
      retainCanonicalProfileLegacy(cyclic),
    ),
    false,
  );
  const base = ratingValue(
    "invite__match",
    retainCanonicalRatingPayload({ status: "processing" }),
  );
  const absent = ratingData({ ...base, revision: 1 });
  const invalid = ratingData({
    ...base,
    payload: retainCanonicalRatingPayload({
      historicalMatchArchiveVersion: null,
    }),
    revision: 1,
  });
  assert.equal(Object.hasOwn(absent, "historicalMatchArchiveVersion"), false);
  assert.equal(invalid.historicalMatchArchiveVersion, -1);
});

test("rating projection SQL rereads mutation values for each JSON binding", () => {
  const base = ratingValue(
    "invite__match",
    retainCanonicalRatingPayload({
      status: "done",
      completedAtMs: 100,
      inviteId: "invite",
      matchId: "match",
      playerId: "player",
      opponentId: "opponent",
      telegramProjectionState: "done",
      telegramProjectionUpdatedAtMs: 100,
      telegramProjectionReason: null,
    }),
  );
  let reads = 0;
  const mutation = {
    kind: "patch-rating-projection" as const,
    projection: "telegram" as const,
    currentRevision: 1,
    get value() {
      reads++;
      return {
        ...base,
        payload: retainCanonicalRatingPayload({
          ...base.payload,
          telegramProjectionUpdatedAtMs: reads,
          telegramProjectionReason: `read-${reads}`,
        }),
      };
    },
  };
  const bindings: unknown[][] = [];
  const statement = {
    bind(...values: unknown[]) {
      bindings.push(values);
      return statement;
    },
  };
  const database = {
    prepare() {
      return statement;
    },
  } as unknown as D1Database;
  buildAccountingMutationStatements(database, mutation);
  assert.equal(reads, 4);
  assert.deepEqual(bindings, [
    ['"done"', "3", '"read-4"', "done", 100, null, "invite__match"],
  ]);
});
