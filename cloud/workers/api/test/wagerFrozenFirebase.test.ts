import assert from "node:assert/strict";
import test from "node:test";
import { createWagerFrozenFirebaseStore } from "./wagerFrozenFirebaseFixture.ts";
import { createEmptyMaterials } from "@mons/shared/mining";

function store(value: unknown) {
  return createWagerFrozenFirebaseStore({
    getPath: async () => value,
    transactPath: async () => {
      throw new Error("unexpected-write");
    },
  });
}

test("bridge balance reads accept missing and sparse valid counts", async () => {
  for (const source of [
    null,
    undefined,
    {},
    { frozen: null },
    { frozen: {} },
  ]) {
    assert.deepEqual(await store(source).readBalance("host"), {
      frozen: createEmptyMaterials(),
      revision: 0,
    });
  }
  assert.deepEqual(await store({ frozen: { dust: 3 } }).readBalance("host"), {
    frozen: { ...createEmptyMaterials(), dust: 3 },
    revision: 0,
  });
});

test("bridge balance reads never turn malformed source counts into zeros", async () => {
  for (const source of [
    false,
    "mining",
    [],
    { frozen: false },
    { frozen: [] },
    { frozen: { unknown: 1 } },
    { frozen: { dust: "3" } },
    { frozen: { dust: -1 } },
    { frozen: { dust: 1.5 } },
    { frozen: { dust: Number.NaN } },
    { frozen: { dust: Number.MAX_SAFE_INTEGER + 1 } },
  ]) {
    await assert.rejects(
      store(source).readBalance("host"),
      /wager-operation-unavailable/,
    );
  }
});

test("bridge preserves transport failures and validates UID keys", async () => {
  const value = createWagerFrozenFirebaseStore({
    getPath: async () => {
      throw new Error("source-unavailable");
    },
    transactPath: async () => {
      throw new Error("unexpected-write");
    },
  });
  await assert.rejects(value.readBalance("host"), /source-unavailable/);
  await assert.rejects(
    value.readBalance("other/host"),
    /invalid-wager-frozen-key/,
  );
});
