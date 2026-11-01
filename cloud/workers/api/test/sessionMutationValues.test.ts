import assert from "node:assert/strict";
import test from "node:test";
import { createAutomatchMutations } from "../src/automatchD1/mutations.ts";
import { decodeSnapshot, encodeValue } from "../src/automatchD1/codec.ts";
import type { AutomatchRoot } from "../src/automatchD1/types.ts";
import type { GameSessionChange } from "../src/gameSessionContracts.ts";
import { digest } from "../src/gameSessionCodec.ts";
import { buildAutomatchReceiptChanges } from "../src/automatch/receipts.ts";
import { requestAutomatchProfileProjection } from "../src/gameSessionProjectionChanges.ts";
import {
  buildPendingAutomatchTelegramSource,
  buildAutomatchTelegramProjectionChanges,
} from "../../../runtime/telegram/automatchSource.js";
import {
  SESSION_TIMESTAMP,
  sessionIncrement,
} from "../src/sessionValueOperations.ts";
import { canonicalAutomatchFixture } from "./automatchRecordFixture.ts";

function preparation(records: ReadonlyMap<string, unknown> = new Map()) {
  const read = async <Root extends AutomatchRoot>(root: Root, key: string) => {
    const value = records.get(`${root}/${key}`) ?? null;
    return decodeSnapshot(root, {
      record_key: key,
      payload_json: value === null ? null : JSON.stringify(value),
      revision: value === null ? 0 : 1,
    });
  };
  return createAutomatchMutations(
    {} as D1Database,
    {},
    {
      read,
      readMutationRecords: (requests) =>
        Promise.all(requests.map(({ root, key }) => read(root, key))),
    },
  );
}

function preCleanupResolution(
  value: unknown,
  current: unknown,
  nowMs: number,
): unknown {
  if (Array.isArray(value))
    return value.map((entry, index) =>
      preCleanupResolution(
        entry,
        Array.isArray(current) ? current[index] : null,
        nowMs,
      ),
    );
  if (value === null || typeof value !== "object") return value;
  const row = value as Record<string, unknown>;
  if (row[".sv"] === "timestamp") return nowMs;
  if (row[".sv"] !== undefined) {
    const marker = row[".sv"] as { increment: number };
    return (
      (typeof current === "number" && Number.isFinite(current) ? current : 0) +
      marker.increment
    );
  }
  const baseline =
    current !== null && typeof current === "object"
      ? (current as Record<string, unknown>)
      : {};
  return Object.fromEntries(
    Object.entries(row).map(([key, child]) => [
      key,
      preCleanupResolution(
        child,
        Object.hasOwn(baseline, key) ? baseline[key] : null,
        nowMs,
      ),
    ]),
  );
}

test("typed mutation preparation preserves pre-cleanup stored bytes and operation digests", async () => {
  const nowMs = 1_800_000_000_000;
  const oldTimestamp = { ".sv": "timestamp" };
  const entry = canonicalAutomatchFixture("automatch", { uid: "host" });
  assert.ok(entry);
  const receipt = buildAutomatchReceiptChanges(
    "host",
    { operationId: "operation", emojiId: 1, aura: "none" },
    {
      ok: true,
      inviteId: "invite",
      mode: "pending",
      matchedImmediately: false,
    },
    "projection",
    true,
  )[0]!;
  assert.equal(receipt.kind, "mutation-receipt");
  if (receipt.kind !== "mutation-receipt") throw new Error("receipt-required");
  const source = buildPendingAutomatchTelegramSource({
    inviteId: "invite",
    timestamp: SESSION_TIMESTAMP,
    waitingText: "Waiting",
    canceledText: "Canceled",
  });
  const profile = requestAutomatchProfileProjection({
    inviteId: "invite",
    requestId: "projection",
    timestamp: SESSION_TIMESTAMP,
  })[0]!;
  assert.equal(profile.kind, "profile-outbox");
  if (profile.kind !== "profile-outbox" || profile.value === null)
    throw new Error("profile-outbox-required");
  const telegram = buildAutomatchTelegramProjectionChanges({
    inviteId: "invite",
    requestId: "projection",
    timestamp: SESSION_TIMESTAMP,
  })[0]!;
  assert.equal(telegram.kind, "telegram-outbox");
  if (telegram.kind !== "telegram-outbox" || telegram.value === null)
    throw new Error("telegram-outbox-required");
  const changes: GameSessionChange[] = [
    {
      kind: "automatch-entry",
      inviteId: "invite",
      value: { ...entry, timestamp: SESSION_TIMESTAMP },
    },
    { kind: "telegram-source", inviteId: "invite", value: source },
    telegram,
    profile,
    receipt,
  ];
  const oldValues = new Map<string, unknown>([
    ["automatch", { ...entry, timestamp: oldTimestamp }],
    [
      "telegramAutomatches",
      { ...source, createdAtMs: oldTimestamp, updatedAtMs: oldTimestamp },
    ],
    [
      "telegramProjectionOutbox/automatch",
      { ...telegram.value, updatedAtMs: oldTimestamp },
    ],
    [
      "profileGameProjectionOutbox/automatch",
      {
        ...profile.value,
        sourceUpdatedAtMs: oldTimestamp,
        lastQueuedAtMs: oldTimestamp,
      },
    ],
    [
      "gameplayMutationReceipts",
      { ...receipt.value, completedAtMs: oldTimestamp },
    ],
    [
      "gameplayMutationReceiptExpirations",
      { ...receipt.expiration, completedAtMs: oldTimestamp },
    ],
  ]);
  const prepared = await preparation().prepareChanges(changes, nowMs);
  assert.equal(prepared.length, oldValues.size);
  const expected = prepared.map(({ current }) => ({
    current,
    value: preCleanupResolution(oldValues.get(current.root), null, nowMs),
  }));
  for (const [index, mutation] of prepared.entries())
    assert.equal(
      encodeValue(mutation.value),
      encodeValue(expected[index]!.value),
    );
  const identity = {
    transitionId: "transition",
    inviteId: "invite",
    createdAtMs: nowMs,
  };
  assert.equal(
    await digest({ ...identity, mutations: prepared }),
    await digest({ ...identity, mutations: expected }),
  );
  assert.equal(JSON.stringify(prepared).includes('".sv"'), false);
  assert.equal(JSON.stringify(prepared).includes('"kind":"timestamp"'), false);
  receipt.value.response.inviteId = "changed-after-preparation";
  assert.equal(
    encodeValue(prepared[4]!.value),
    encodeValue(expected[4]!.value),
  );
});

test("repeated counter operations retain snapshot baselines and retry preparation is identical", async () => {
  const source = canonicalAutomatchFixture("telegramAutomatches", {
    generation: 5,
  });
  const records = new Map([["telegramAutomatches/invite", source]]);
  const changes: GameSessionChange[] = [2, 4].map((delta) => ({
    kind: "telegram-source-merge",
    inviteId: "invite",
    value: {
      generation: sessionIncrement(delta),
      updatedAtMs: SESSION_TIMESTAMP,
    },
  }));
  const store = preparation(records);
  const first = await store.prepareChanges(changes, 123);
  const replay = await store.prepareChanges(changes, 123);
  assert.deepEqual(replay, first);
  assert.ok(source);
  const expected = { ...source, generation: 9, updatedAtMs: 123 };
  assert.equal(encodeValue(first[0]!.value), encodeValue(expected));
  assert.equal(await digest(first), await digest(replay));
  assert.deepEqual(source.generation, 5);
});

test("canonical writes reject retired markers and never evaluate operations in unrelated fields", async () => {
  const entry = canonicalAutomatchFixture("automatch", {});
  assert.ok(entry);
  const store = preparation();
  for (const value of [
    { ...entry, timestamp: { ".sv": "timestamp" } },
    { ...entry, timestamp: SESSION_TIMESTAMP, username: { kind: "timestamp" } },
  ])
    await assert.rejects(async () =>
      Reflect.apply(store.prepareChanges, store, [
        [{ kind: "automatch-entry", inviteId: "invite", value }],
        123,
      ]),
    );
});
