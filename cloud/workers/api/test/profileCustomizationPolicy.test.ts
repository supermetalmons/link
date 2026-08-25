import assert from "node:assert/strict";
import test from "node:test";
import { AuthApiFailure } from "../src/authErrors.ts";
import {
  authorizeProfileCustomization,
  inventoryRequirement,
} from "../src/profileCustomizationPolicy.ts";
import type { ProfileCustomizationProfile } from "../src/profileCustomizationRepository.ts";
import { TELEGRAM_TEST_ENV } from "./testEnv.ts";

const profile: ProfileCustomizationProfile = {
  documentName: "profile-document",
  eth: "",
  sol: "11111111111111111111111111111111",
};

test("maps protected customizations to their inventory requirements", () => {
  assert.deepEqual(
    inventoryRequirement(
      {
        field: "emojiAndAura",
        value: { emoji: 1009, aura: "rainbow" },
      },
      profile,
    ),
    { collection: "swagpack_avatars", id: 9, count: 3 },
  );
  assert.deepEqual(
    inventoryRequirement({ field: "cardBackgroundId", value: 100 }, profile),
    { collection: "specials", id: 1, count: 1 },
  );
  assert.deepEqual(
    inventoryRequirement({ field: "profileMons", value: "0,0,5,0,0" }, profile),
    { collection: "specials", id: 0, count: 1 },
  );
  assert.deepEqual(
    inventoryRequirement(
      {
        field: "cardStickers",
        value: '{"big-mon-top-right":"gate"}',
      },
      profile,
    ),
    { collection: "specials", id: 2, count: 1 },
  );
});

test("authorizes owned inventory customizations and rejects missing ownership", async () => {
  const request = {
    field: "emojiAndAura",
    value: { emoji: 1009, aura: "rainbow" },
  } as const;
  await authorizeProfileCustomization(
    request,
    profile,
    TELEGRAM_TEST_ENV as Env,
    {
      fetchInventory: async () => ({
        ok: true,
        specials: [],
        swagpack_avatars: [{ id: 9, count: 3 }],
        swagpack_reactions: [],
      }),
    },
  );
  await assert.rejects(
    authorizeProfileCustomization(request, profile, TELEGRAM_TEST_ENV as Env, {
      fetchInventory: async () => ({
        ok: true,
        specials: [],
        swagpack_avatars: [{ id: 9, count: 2 }],
        swagpack_reactions: [],
      }),
    }),
    (error) =>
      error instanceof AuthApiFailure &&
      error.status === 403 &&
      error.message === "profile-customization-not-owned",
  );
});

test("skips inventory reads for regular customizations", async () => {
  let reads = 0;
  await authorizeProfileCustomization(
    { field: "cardBackgroundId", value: 3 },
    profile,
    TELEGRAM_TEST_ENV as Env,
    {
      fetchInventory: async () => {
        reads++;
        return {
          ok: true,
          specials: [],
          swagpack_avatars: [],
          swagpack_reactions: [],
        };
      },
    },
  );
  assert.equal(reads, 0);
});

test("passes the operation signal to inventory authorization", async () => {
  const controller = new AbortController();
  let receivedSignal: AbortSignal | undefined;
  await authorizeProfileCustomization(
    {
      field: "emojiAndAura",
      value: { emoji: 1009, aura: "" },
    },
    profile,
    TELEGRAM_TEST_ENV as Env,
    {
      fetchInventory: async (_profile, signal) => {
        receivedSignal = signal;
        return {
          ok: true,
          specials: [],
          swagpack_avatars: [{ id: 9, count: 1 }],
          swagpack_reactions: [],
        };
      },
      signal: controller.signal,
    },
  );
  assert.equal(receivedSignal, controller.signal);
});
